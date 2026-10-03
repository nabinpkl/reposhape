"""Runtime links: modules that reach each other with no import between them.

An import graph is blind to three couplings that the curated repos lean on
(ADR-0009, measured 2026-09-29):

* **event**: two files meet on a name written literally at both ends. hermes'
  core fires `invoke_hook("pre_llm_call")` and plugins `register_hook(
  "pre_llm_call", fn)`; opencode's schema defines `session.status` and the
  app switches on `case "session.status"` after it arrives over SSE.
* **process**: one file starts another as a program, `spawn(python, ["-m",
  "tui_gateway.entry"])`. The module name is literal, so it resolves exactly
  like an import would.
* **loader**: a file reaches a directory of files by globbing it. Nothing in
  the source names the files, so these come from a rules file an operator
  writes (`link_rules_dir/<repo name>.toml`), never from a guess.

Every link is found by syntax, never inferred: the same no-model rule as the
rest of the extractor. A name that cannot be read literally (`emit(name)`) is
counted, not dropped, and a rule that matches nothing is a problem reported
with the analysis, the way an unresolved import is.

This module reads files and rules and pairs what it finds. Resolving a
process link's module name is `resolution`'s job, passed in as a callable.
"""

from __future__ import annotations

import re
import tomllib
from collections import defaultdict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path, PurePosixPath
from typing import Literal

from tree_sitter import Node, Parser, QueryCursor

from reposhape.models import Language as SourceLanguage
from reposhape.models import LinkStats, RuntimeLink
from reposhape.parsing import (
    VUE_SCRIPT_BLOCK,
    node_text,
    python_language,
    query_for,
    script_grammar,
)

Role = Literal["send", "receive"]

# Callees whose first argument names an event. Built in because each is the
# conventional spelling across ecosystems: Node's EventEmitter and most buses
# (`emit`/`on`), pub-sub (`publish`/`subscribe`), and the hook registries
# hermes-style plugin systems use. A rules file adds names for its own repo.
SEND_CALLS = frozenset({"emit", "publish", "invoke_hook", "run_hook"})
RECEIVE_CALLS = frozenset(
    {"on", "once", "subscribe", "addListener", "add_listener", "register_hook", "addEventListener"}
)

# A key that is one lowercase word is almost always a stream or DOM event
# (`error`, `data`, `close`, `exit`, `message`), emitted and handled by a
# library rather than by two modules of this repo: pairing them links every
# child_process caller to every socket handler. They are counted and dropped.
# Real channel names in the curated repos all carry a separator or a capital.
_CHANNEL_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_.:/\-]{2,79}$")
_GENERIC_KEY = re.compile(r"^[a-z]+$")

# The first argument of a call, and which callee it went to. `.` anchors the
# argument to the first position.
_TS_CALLS = """
(call_expression
  function: [(identifier) @fn (member_expression property: (property_identifier) @fn)]
  arguments: (arguments . (_) @arg)) @call
"""
# Receivers that are not calls: `case "session.status":` and
# `event.type === "session.status"` (or the `!==` guard form). Both are how a consumer of a
# discriminated event union reads it once it has crossed a wire.
_TS_READS = """
(switch_case value: (string (string_fragment) @key)) @read
((binary_expression
   left: (member_expression property: (property_identifier) @_prop)
   operator: ["===" "==" "!==" "!="]
   right: (string (string_fragment) @key)) @read
 (#eq? @_prop "type"))
"""
# Declarations: `X.define({ type: "session.status", ... })`, opencode's shape
# for an event whose publishers use the typed object rather than the string.
_TS_DEFINES = """
((call_expression
   function: (member_expression property: (property_identifier) @_fn)
   arguments: (arguments (object (pair
     key: (property_identifier) @_k
     value: (string (string_fragment) @key))))) @define
 (#eq? @_fn "define")
 (#eq? @_k "type"))
"""
# `["-m", "package.module"]` in any array: the argv of a Python program started
# by module. Adjacent strings, `-m` first.
_TS_ARGV = """
(array (string (string_fragment) @flag) . (string (string_fragment) @module))
"""

_PY_CALLS = """
(call
  function: [(identifier) @fn (attribute attribute: (identifier) @fn)]
  arguments: (argument_list . (_) @arg)) @call
"""
_PY_ARGV = """
(list (string) @flag . (string) @module)
"""


@dataclass(frozen=True, slots=True)
class ChannelUse:
    """One end of a would-be event link, before pairing."""

    path: str
    line: int
    key: str
    role: Role


@dataclass(slots=True)
class FileLinks:
    """What one file contributes: channel ends, program starts, unreadable names."""

    uses: list[ChannelUse] = field(default_factory=list)
    modules: list[tuple[int, str]] = field(default_factory=list)  # (line, module)
    dynamic: int = 0
    generic: int = 0


@dataclass(frozen=True, slots=True)
class LoaderRule:
    loader: str
    files: tuple[str, ...]
    exclude: tuple[str, ...]
    anchor: str | None
    contains: str | None  # only files whose text holds this, e.g. `registry.register(`


@dataclass(frozen=True, slots=True)
class LinkRules:
    """A repo's rules file, or the empty set when it has none."""

    send: frozenset[str] = SEND_CALLS
    receive: frozenset[str] = RECEIVE_CALLS
    loaders: tuple[LoaderRule, ...] = ()
    problems: tuple[str, ...] = ()


def _string_list(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        return (value,)
    if isinstance(value, list):
        return tuple(item for item in value if isinstance(item, str))
    return ()


def load_rules(path: Path) -> LinkRules:
    """Read `path`, or return the built-in rules when it does not exist.

    A file that exists and cannot be read is a problem carried into the
    analysis, not an exception: the import graph is still worth having, and
    the problem shows beside it.
    """
    if not path.is_file():
        return LinkRules()
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        return LinkRules(problems=(f"{path.name}: unreadable ({error})",))

    problems: list[str] = []
    events = raw.get("events", {})
    send = (
        SEND_CALLS | set(_string_list(events.get("send")))
        if isinstance(events, dict)
        else SEND_CALLS
    )
    receive = (
        RECEIVE_CALLS | set(_string_list(events.get("receive")))
        if isinstance(events, dict)
        else RECEIVE_CALLS
    )
    loaders: list[LoaderRule] = []
    for index, entry in enumerate(raw.get("loader", [])):
        loader = entry.get("loader") if isinstance(entry, dict) else None
        files = _string_list(entry.get("files")) if isinstance(entry, dict) else ()
        if not isinstance(loader, str) or not files:
            problems.append(f"{path.name}: loader rule {index + 1} needs `loader` and `files`")
            continue
        anchor = entry.get("anchor")
        contains = entry.get("contains")
        loaders.append(
            LoaderRule(
                loader=loader,
                files=files,
                exclude=_string_list(entry.get("exclude")),
                anchor=anchor if isinstance(anchor, str) else None,
                contains=contains if isinstance(contains, str) else None,
            )
        )
    return LinkRules(
        send=frozenset(send),
        receive=frozenset(receive),
        loaders=tuple(loaders),
        problems=tuple(problems),
    )


def _python_string(source: bytes, node: Node) -> str | None:
    """The value of a Python string literal, or None for an f-string or concatenation."""
    if node.type != "string":
        return None
    if any(child.type == "interpolation" for child in node.children):
        return None
    content = [child for child in node.children if child.type == "string_content"]
    return "".join(node_text(source, child) for child in content)


def _ts_string(source: bytes, node: Node) -> str | None:
    if node.type == "string":
        return "".join(
            node_text(source, child) for child in node.children if child.type == "string_fragment"
        )
    if node.type == "template_string" and not any(
        child.type == "template_substitution" for child in node.children
    ):
        return "".join(
            node_text(source, child) for child in node.children if child.type == "string_fragment"
        )
    return None


def _record_key(found: FileLinks, path: str, line: int, key: str, role: Role) -> None:
    if _GENERIC_KEY.match(key):
        found.generic += 1
    elif _CHANNEL_KEY.match(key):
        found.uses.append(ChannelUse(path, line, key, role))


def _calls_query(template: str, names: frozenset[str]) -> str:
    """`template` restricted to calls of `names`, so tree-sitter filters, not Python.

    Without the predicate the query yields every call in the file and each one
    crosses into Python to be rejected there; on hermes-agent that made this
    pass slower than import parsing itself.
    """
    alternatives = "|".join(sorted(re.escape(name) for name in names))
    return f'({template.strip()} (#match? @fn "^_*({alternatives})$"))'


def _role(callee: str, rules: LinkRules) -> Role:
    # `invoke_hook as _invoke_hook` is the private-alias convention; the name
    # after the underscore is the one the rules know.
    return "send" if callee.lstrip("_") in rules.send else "receive"


@cache
def _call_pattern(names: frozenset[str]) -> re.Pattern[bytes]:
    alternatives = b"|".join(sorted(re.escape(name.encode()) for name in names))
    return re.compile(rb"(?<![\w$])_*(?:" + alternatives + rb")\s*[(<]")


def _mentions(source: bytes, names: frozenset[str]) -> bool:
    """A regex over bytes before any parse: most files call none of these.

    Word-bounded, because `on(` alone is inside every `function(`.
    """
    return _call_pattern(names).search(source) is not None


_READS = re.compile(rb"case\s+[\"'`]|\.type\s*[!=]==?\s*[\"'`]")
_DEFINES = re.compile(rb"\.define\s*\(")
_ARGV = re.compile(rb"[\"'`]-m[\"'`]")


def _scan_typescript(
    path: str, source: bytes, jsx: bool, rules: LinkRules, found: FileLinks
) -> None:
    calls = _mentions(source, rules.send | rules.receive)
    reads = _READS.search(source) is not None
    defines = _DEFINES.search(source) is not None
    argv = _ARGV.search(source) is not None
    if not (calls or reads or defines or argv):
        return
    language = script_grammar(jsx)
    root = Parser(language).parse(source).root_node

    if calls:
        query = query_for(language, _calls_query(_TS_CALLS, rules.send | rules.receive))
        for _, captures in QueryCursor(query).matches(root):
            argument = captures["arg"][0]
            key = _ts_string(source, argument)
            if key is None:
                found.dynamic += 1
                continue
            role = _role(node_text(source, captures["fn"][0]), rules)
            _record_key(found, path, argument.start_point[0] + 1, key, role)

    if reads:
        for _, captures in QueryCursor(query_for(language, _TS_READS)).matches(root):
            node = captures["key"][0]
            _record_key(found, path, node.start_point[0] + 1, node_text(source, node), "receive")

    if defines:
        for _, captures in QueryCursor(query_for(language, _TS_DEFINES)).matches(root):
            node = captures["key"][0]
            _record_key(found, path, node.start_point[0] + 1, node_text(source, node), "send")

    if argv:
        for _, captures in QueryCursor(query_for(language, _TS_ARGV)).matches(root):
            if node_text(source, captures["flag"][0]) == "-m":
                module = captures["module"][0]
                found.modules.append((module.start_point[0] + 1, node_text(source, module)))


def _scan_python(path: str, source: bytes, rules: LinkRules, found: FileLinks) -> None:
    calls = _mentions(source, rules.send | rules.receive)
    argv = _ARGV.search(source) is not None
    if not (calls or argv):
        return
    language = python_language()
    root = Parser(language).parse(source).root_node

    if calls:
        query = query_for(language, _calls_query(_PY_CALLS, rules.send | rules.receive))
        for _, captures in QueryCursor(query).matches(root):
            argument = captures["arg"][0]
            key = _python_string(source, argument)
            if key is None:
                found.dynamic += 1
                continue
            role = _role(node_text(source, captures["fn"][0]), rules)
            _record_key(found, path, argument.start_point[0] + 1, key, role)

    if argv:
        for _, captures in QueryCursor(query_for(language, _PY_ARGV)).matches(root):
            if _python_string(source, captures["flag"][0]) == "-m":
                node = captures["module"][0]
                module = _python_string(source, node)
                if module:
                    found.modules.append((node.start_point[0] + 1, module))


def scan_file(path: str, language: SourceLanguage, source: bytes, rules: LinkRules) -> FileLinks:
    """Every channel end and program start written in one file."""
    found = FileLinks()
    match language:
        case "python":
            _scan_python(path, source, rules, found)
        case "vue":
            for block in VUE_SCRIPT_BLOCK.finditer(source):
                offset = source.count(b"\n", 0, block.start(2))
                inner = FileLinks()
                _scan_typescript(
                    path, block.group(2), b'lang="tsx"' in block.group(1), rules, inner
                )
                found.uses.extend(
                    ChannelUse(use.path, use.line + offset, use.key, use.role) for use in inner.uses
                )
                found.modules.extend((line + offset, module) for line, module in inner.modules)
                found.dynamic += inner.dynamic
                found.generic += inner.generic
        case "typescript" | "javascript":
            _scan_typescript(path, source, path.endswith((".tsx", ".jsx")), rules, found)
        case _:
            pass
    return found


def _event_links(uses: Iterable[ChannelUse]) -> tuple[list[RuntimeLink], int, int]:
    """Pair senders with receivers of the same key in other files.

    One link per (key, sender file, receiver file), at the first line of each
    end. Returns the links, how many keys paired, and how many did not: a key
    fired and never handled here (or the reverse) usually crosses to code
    outside the repo, which is worth a count and not a link.
    """
    by_key: dict[str, dict[Role, dict[str, int]]] = defaultdict(lambda: {"send": {}, "receive": {}})
    for use in uses:
        ends = by_key[use.key][use.role]
        ends.setdefault(use.path, use.line)

    links: list[RuntimeLink] = []
    paired = unpaired = 0
    for key in sorted(by_key):
        senders, receivers = by_key[key]["send"], by_key[key]["receive"]
        pairs = [(s, r) for s in senders for r in receivers if s != r]
        if not pairs:
            unpaired += 1
            continue
        paired += 1
        links.extend(
            RuntimeLink(
                kind="event",
                key=key,
                source=sender,
                source_line=senders[sender],
                target=receiver,
                target_line=receivers[receiver],
            )
            for sender, receiver in sorted(pairs)
        )
    return links, paired, unpaired


def _anchor_line(root: Path, loader: str, anchor: str | None) -> int | None:
    """The 1-based line holding `anchor` in the loader file; 1 without an anchor."""
    if anchor is None:
        return 1
    try:
        text = (root / loader).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for number, line in enumerate(text.splitlines(), start=1):
        if anchor in line:
            return number
    return None


def _holds(path: Path, text: str) -> bool:
    try:
        return text in path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False


def _loader_links(
    root: Path, rules: LinkRules, known: frozenset[str]
) -> tuple[list[RuntimeLink], list[str]]:
    links: list[RuntimeLink] = []
    problems: list[str] = []
    for rule in rules.loaders:
        if rule.loader not in known:
            problems.append(f"loader {rule.loader} is not a scanned file")
            continue
        line = _anchor_line(root, rule.loader, rule.anchor)
        if line is None:
            problems.append(f"loader {rule.loader}: anchor {rule.anchor!r} not found")
            continue
        matched = sorted(
            path
            for path in known
            if path != rule.loader
            and any(PurePosixPath(path).full_match(glob) for glob in rule.files)
            and not any(PurePosixPath(path).full_match(glob) for glob in rule.exclude)
            and (rule.contains is None or _holds(root / path, rule.contains))
        )
        if not matched:
            problems.append(f"loader {rule.loader}: {', '.join(rule.files)} matches no file")
            continue
        key = ", ".join(rule.files)
        links.extend(
            RuntimeLink(
                kind="loader",
                key=key,
                source=rule.loader,
                source_line=line,
                target=path,
                target_line=1,
            )
            for path in matched
        )
    return links, problems


def link(
    root: Path,
    scanned: dict[str, FileLinks],
    rules: LinkRules,
    known: frozenset[str],
    resolve_module: Callable[[str, str], str | None],
) -> tuple[list[RuntimeLink], LinkStats]:
    """Every runtime link in the repo, and the counts that say what was missed.

    `resolve_module(source, module)` maps a `-m` module name to a repo file,
    or None when it is not one of this repo's.
    """
    events, paired, unpaired = _event_links(use for found in scanned.values() for use in found.uses)

    processes: list[RuntimeLink] = []
    started: set[tuple[str, str, str]] = set()
    unresolved_modules = 0
    for path, found in sorted(scanned.items()):
        for line, module in found.modules:
            target = resolve_module(path, module)
            if target is None or target == path:
                unresolved_modules += 1
                continue
            # A launcher that starts the same module from four branches is one
            # link, at the first of them.
            if (path, module, target) in started:
                continue
            started.add((path, module, target))
            processes.append(
                RuntimeLink(
                    kind="process",
                    key=module,
                    source=path,
                    source_line=line,
                    target=target,
                    target_line=1,
                )
            )

    loaders, loader_problems = _loader_links(root, rules, known)
    links = events + processes + loaders
    return links, LinkStats(
        links=len(links),
        keys_paired=paired,
        keys_unpaired=unpaired,
        dynamic_names=sum(found.dynamic for found in scanned.values()),
        generic_names=sum(found.generic for found in scanned.values()),
        unresolved_modules=unresolved_modules,
        problems=[*rules.problems, *loader_problems],
    )
