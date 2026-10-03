"""Extracting import specifiers with tree-sitter. This is the whole extractor.

Written against tree-sitter 0.26. The 0.24 release replaced `Query.captures()`
with `QueryCursor`, so this will not run on older versions; pyproject pins the
range.

`matches()` is used rather than `captures()` on purpose. `captures()` returns a
flat dict keyed by capture name, which loses the pairing between a `require`
identifier and the string argument beside it; `matches()` keeps each match's
captures together.

A parser here reads its own file and nothing else. Turning a specifier into a
path is `resolution`'s job, and keeping that split is what makes both testable
without a repo on disk.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from functools import cache

import tree_sitter_python as ts_python
import tree_sitter_typescript as ts_typescript
from tree_sitter import Language, Node, Parser, Query, QueryCursor

from reposhape.models import ImportKind
from reposhape.models import Language as SourceLanguage

# Captures every TS/JS import form that names a module:
#   import x from "m"          import "m"           import type {T} from "m"
#   export {x} from "m"        export * from "m"
#   import("m")                require("m")
#
# The #eq? predicate on the call form is load-bearing: without it every
# single-string call expression in the file, foo("./nope") included, is matched.
TYPESCRIPT_QUERY = """
(import_statement source: (string (string_fragment) @spec)) @stmt
(export_statement source: (string (string_fragment) @spec)) @stmt
(call_expression
  function: (import)
  arguments: (arguments (string (string_fragment) @spec))) @stmt
((call_expression
   function: (identifier) @_fn
   arguments: (arguments (string (string_fragment) @spec))) @stmt
 (#eq? @_fn "require"))
"""

# Python statements are matched whole and then walked by field, rather than
# captured by a query pattern. The reason is `from . import sibling`: its
# module_name is bare `.`, so a query that captures module_name alone records a
# dependency on the package and loses the edge to sibling.py entirely. Walking
# lets that case normalise to the specifier `.sibling`, which resolves like any
# other relative import.
PYTHON_QUERY = """
(import_statement) @stmt
(import_from_statement) @stmt
"""


# A single-file component's top-level blocks open at the start of a line; a
# `<script>` further in belongs to the template. `(?=[\s>])` rather than `\b`,
# because `\b` also matches before the hyphen in a component tag such as
# `<script-artifact-view>`, which is a real one in a real repo.
VUE_SCRIPT_BLOCK = re.compile(rb"^<script(?=[\s>])([^>]*)>(.*?)</script>", re.MULTILINE | re.DOTALL)
VUE_SCRIPT_LANG = re.compile(rb"""\blang\s*=\s*["']?(\w+)""")


@dataclass(frozen=True, slots=True)
class RawImport:
    """One import statement, before anything tries to resolve it."""

    specifier: str
    kind: ImportKind
    type_only: bool
    line: int


@cache
def _typescript_language() -> Language:
    return Language(ts_typescript.language_typescript())


@cache
def _tsx_language() -> Language:
    return Language(ts_typescript.language_tsx())


@cache
def python_language() -> Language:
    return Language(ts_python.language())


@cache
def query_for(language: Language, query_source: str) -> Query:
    return Query(language, query_source)


def node_text(source: bytes, node: Node) -> str:
    return source[node.start_byte : node.end_byte].decode("utf-8", errors="replace")


def script_grammar(jsx: bool) -> Language:
    # The tsx grammar is required wherever JSX may appear and is otherwise
    # interchangeable; the plain grammar rejects `<Foo />`.
    return _tsx_language() if jsx else _typescript_language()


def _typescript_kind(statement_text: str) -> ImportKind:
    if statement_text.startswith("import("):
        return "dynamic"
    if statement_text.startswith("require("):
        return "require"
    if statement_text.startswith("export"):
        return "export_from"
    return "static"


def _is_type_only(statement_text: str) -> bool:
    """`import type ...` / `export type ...`, which vanish at runtime.

    Inline specifier-level `import { type A, B }` is deliberately not treated as
    type-only: B still creates a runtime edge.
    """
    head = statement_text[:40]
    return head.startswith(("import type", "export type"))


def _parse_typescript(source: bytes, jsx: bool) -> list[RawImport]:
    language = script_grammar(jsx)
    tree = Parser(language).parse(source)
    cursor = QueryCursor(query_for(language, TYPESCRIPT_QUERY))

    found: list[RawImport] = []
    for _, captures in cursor.matches(tree.root_node):
        spec_nodes = captures.get("spec")
        stmt_nodes = captures.get("stmt")
        if not spec_nodes or not stmt_nodes:
            continue
        specifier = node_text(source, spec_nodes[0])
        if not specifier:
            continue
        statement = node_text(source, stmt_nodes[0])
        found.append(
            RawImport(
                specifier=specifier,
                kind=_typescript_kind(statement),
                type_only=_is_type_only(statement),
                line=spec_nodes[0].start_point[0] + 1,
            )
        )
    return found


def _parse_vue(source: bytes) -> list[RawImport]:
    """Imports from every top-level `<script>` block of a single-file component.

    `<script>` and `<script setup>` can both be present and both import. The
    template names components but cannot import them, so it adds nothing. A
    component registered globally or auto-imported (Nuxt,
    unplugin-vue-components) has no import anywhere in the source, and no edge
    is invented for it.

    Each block is parsed with the script grammar on its own, then its lines are
    shifted by where the block starts, so a line still points into the `.vue`.
    """
    found: list[RawImport] = []
    for block in VUE_SCRIPT_BLOCK.finditer(source):
        lang = VUE_SCRIPT_LANG.search(block.group(1))
        jsx = lang is not None and lang.group(1) in (b"tsx", b"jsx")
        offset = source.count(b"\n", 0, block.start(2))
        found.extend(
            replace(raw, line=raw.line + offset)
            for raw in _parse_typescript(block.group(2), jsx=jsx)
        )
    return found


def _dotted_names(node: Node, field: str, source: bytes) -> list[str]:
    """Text of every `field` child, unwrapping `x as y` to just `x`."""
    names: list[str] = []
    for child in node.children_by_field_name(field):
        if child.type == "aliased_import":
            inner = child.child_by_field_name("name")
            if inner is not None:
                names.append(node_text(source, inner))
        elif child.type == "dotted_name":
            names.append(node_text(source, child))
    return names


def _parse_python(source: bytes) -> list[RawImport]:
    language = python_language()
    tree = Parser(language).parse(source)
    cursor = QueryCursor(query_for(language, PYTHON_QUERY))

    found: list[RawImport] = []
    for _, captures in cursor.matches(tree.root_node):
        for statement in captures.get("stmt", []):
            line = statement.start_point[0] + 1
            if statement.type == "import_statement":
                for name in _dotted_names(statement, "name", source):
                    found.append(RawImport(name, "static", False, line))
                continue

            module_node = statement.child_by_field_name("module_name")
            if module_node is None:
                continue
            module = node_text(source, module_node)
            names = _dotted_names(statement, "name", source)
            if set(module) == {"."} and names:
                # `from . import sibling` depends on sibling, not on the package.
                # `from .. import a, b` likewise. Normalise to `.sibling` so
                # resolution sees one ordinary relative specifier.
                found.extend(RawImport(module + name, "from_import", False, line) for name in names)
            else:
                found.append(RawImport(module, "from_import", False, line))
    return found


def parse_imports(path: str, source_language: SourceLanguage, source: bytes) -> list[RawImport]:
    """Every module specifier named by `source`, in file order."""
    match source_language:
        case "python":
            found = _parse_python(source)
        case "vue":
            found = _parse_vue(source)
        case _:
            found = _parse_typescript(source, jsx=path.endswith((".tsx", ".jsx")))
    found.sort(key=lambda raw: raw.line)
    return found
