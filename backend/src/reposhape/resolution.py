"""Turning a specifier into a repo-relative file path, or an explicit refusal.

Two traps, both measured in a real monorepo before any of this was written (SPEC
"TS resolution, and the two traps already found"):

1. A repo can hold several independent tsconfigs. That one has three, and
   `@/*` means `./src/*` relative to each one's own directory while `@repo/*`
   walks a different number of `../` in each. Resolving against a merged alias
   map picks the wrong file and looks like it worked, so every lookup uses the
   nearest enclosing tsconfig. TypeScript 7 removed `baseUrl`, and these configs
   are written without it, so the config's own directory is the only base.

2. tsconfig.json is JSONC. All three of that repo's carry `//` comments, and
   `json.loads` raises on them. Comments are stripped before parsing.

A third, found in the curated repos: a monorepo's packages import each other
by package name (`@opencode-ai/core/provider`), which no tsconfig maps. Without
the workspace's own declarations those read as npm dependencies, so every edge
between packages vanished into the external count. Workspace packages are
resolved through their `package.json` `exports`, as Node would.

Anything that does not land on a repo-local file returns an UnresolvedReason
rather than None, because "it was an npm package" and "the alias was wrong" are
different facts and only one of them is a bug.
"""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from reposhape.models import ResolutionOutcome
from reposhape.scanning import inside_repo

# Probed in order. `.d.ts` is deliberately absent: a declaration file is a type
# surface, not a module another file's runtime reaches.
TYPESCRIPT_EXTENSIONS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs")
INDEX_BASENAMES = tuple(f"index{extension}" for extension in TYPESCRIPT_EXTENSIONS)

# NodeNext writes `./a.js` meaning `./a.ts`. Mapping the emitted extension back
# to its sources is what makes an ESM-correct codebase resolve at all.
EMITTED_TO_SOURCE = {
    ".js": (".ts", ".tsx", ".js", ".jsx"),
    ".jsx": (".tsx", ".jsx"),
    ".mjs": (".mts", ".mjs"),
    ".cjs": (".cts", ".cjs"),
}

# Importable, real, and not code. Recognised up front because the extension
# probe would otherwise append `.ts` to `./styles.css` and report a missing file.
ASSET_EXTENSIONS = (
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".json",
    ".proto",
    ".svg",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".woff",
    ".woff2",
    ".wasm",
    ".txt",
    ".md",
    ".html",
    ".glsl",
    ".frag",
    ".vert",
    ".mp3",
    ".wav",
    ".ogg",
    ".mp4",
    ".webm",
)


def is_asset_specifier(specifier: str) -> bool:
    return specifier.endswith(ASSET_EXTENSIONS)


_LINE_COMMENT = re.compile(r"//[^\n]*")
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_TRAILING_COMMA = re.compile(r",(\s*[}\]])")


def strip_jsonc(text: str) -> str:
    """Remove comments and trailing commas, leaving string contents alone.

    Done by scanning rather than by regex over the whole document: a comment
    marker inside a string literal is ordinary text, and a path like
    "https://x" contains one.
    """
    out: list[str] = []
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char == '"':
            end = index + 1
            while end < length:
                if text[end] == "\\":
                    end += 2
                    continue
                if text[end] == '"':
                    end += 1
                    break
                end += 1
            out.append(text[index:end])
            index = end
            continue
        if char == "/" and index + 1 < length:
            following = text[index + 1]
            if following == "/":
                end = text.find("\n", index)
                index = length if end == -1 else end
                continue
            if following == "*":
                end = text.find("*/", index + 2)
                index = length if end == -1 else end + 2
                continue
        out.append(char)
        index += 1
    return _TRAILING_COMMA.sub(r"\1", "".join(out))


@dataclass(slots=True)
class TsConfig:
    directory: Path
    paths: dict[str, list[str]] = field(default_factory=dict)


def _read_tsconfig(root: Path, config_path: Path, seen: frozenset[Path] = frozenset()) -> dict:
    """Parse one tsconfig, following `extends` and letting the child win.

    An `extends` (or a symlinked tsconfig) that leaves the repo is not read:
    the repo is someone else's content, and its config does not get to name
    files on this machine (scanning.inside_repo).
    """
    if config_path in seen or not config_path.is_file() or not inside_repo(root, config_path):
        return {}
    try:
        raw = json.loads(strip_jsonc(config_path.read_text(encoding="utf-8", errors="replace")))
    except json.JSONDecodeError, OSError:
        return {}
    if not isinstance(raw, dict):
        return {}

    parent_name = raw.get("extends")
    if isinstance(parent_name, str):
        candidate = (config_path.parent / parent_name).resolve()
        if candidate.is_dir():
            candidate = candidate / "tsconfig.json"
        elif candidate.suffix != ".json":
            candidate = candidate.with_suffix(".json")
        inherited = _read_tsconfig(root, candidate, seen | {config_path})
        merged_options = {
            **inherited.get("compilerOptions", {}),
            **raw.get("compilerOptions", {}),
        }
        raw = {**inherited, **raw, "compilerOptions": merged_options}
    return raw


@dataclass(slots=True)
class WorkspacePackage:
    """One package a workspace declares, which a sibling imports by name."""

    directory: Path
    exports: object | None
    entries: tuple[str, ...]  # `main`, then `module`, when there are no `exports`


def _read_json_object(root: Path, path: Path) -> dict | None:
    if not inside_repo(root, path):
        return None
    try:
        raw = json.loads(strip_jsonc(path.read_text(encoding="utf-8", errors="replace")))
    except json.JSONDecodeError, OSError:
        return None
    return raw if isinstance(raw, dict) else None


def _pnpm_packages(root: Path, path: Path) -> list[str]:
    """The `packages:` list of a pnpm-workspace.yaml, without a YAML parser.

    The block is a flat list of glob strings under one top-level key, which is
    all a workspace file carries that resolution needs. Everything else in it
    (catalogs, overrides) is dependency policy and is not read.
    """
    if not inside_repo(root, path):
        return []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    globs: list[str] = []
    inside = False
    for line in lines:
        stripped = line.split("#", 1)[0].rstrip()
        if not stripped:
            continue
        if not line[0].isspace():
            inside = stripped == "packages:"
            continue
        if inside and stripped.lstrip().startswith("- "):
            globs.append(stripped.lstrip()[2:].strip().strip("'\""))
    return globs


def workspace_globs(root: Path) -> list[str]:
    """Package directory globs from `package.json` `workspaces` and pnpm's file.

    npm, yarn and bun write `workspaces` as a list or as `{packages: [...]}`;
    pnpm ignores that key and reads pnpm-workspace.yaml. Both are honoured,
    because a repo declares one or the other and nothing here knows which
    package manager it uses.
    """
    globs: list[str] = []
    manifest = _read_json_object(root, root / "package.json")
    declared = manifest.get("workspaces") if manifest is not None else None
    if isinstance(declared, dict):
        declared = declared.get("packages")
    if isinstance(declared, list):
        globs.extend(entry for entry in declared if isinstance(entry, str))
    globs.extend(_pnpm_packages(root, root / "pnpm-workspace.yaml"))
    return [entry.removeprefix("./").rstrip("/") for entry in globs]


def _in_workspace(relative: str, globs: list[str]) -> bool:
    path = PurePosixPath(relative)
    included = any(path.full_match(entry) for entry in globs if not entry.startswith("!"))
    excluded = any(path.full_match(entry[1:]) for entry in globs if entry.startswith("!"))
    return included and not excluded


def _split_package_specifier(specifier: str) -> tuple[str, str]:
    """`@scope/name/a/b` -> (`@scope/name`, `./a/b`); a bare name -> (name, `.`)."""
    parts = specifier.split("/")
    width = 2 if specifier.startswith("@") else 1
    name = "/".join(parts[:width])
    rest = "/".join(parts[width:])
    return name, f"./{rest}" if rest else "."


def _export_targets(value: object) -> list[str]:
    """Every path an `exports` value can name, in the order Node would try them.

    A conditions object (`import`, `bun`, `types`, `default`) is walked in key
    order, which is Node's own rule. Rather than pick one condition set, each
    target is offered in turn and the first that lands on a scanned source file
    wins: a `dist/` target fails the probe and the source one after it does not.
    """
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [target for item in value for target in _export_targets(item)]
    if isinstance(value, dict):
        return [target for item in value.values() for target in _export_targets(item)]
    return []


def _subpath_targets(exports: object, subpath: str) -> list[str] | None:
    """The `exports` targets for `subpath`, or None when no key admits it.

    Longest literal prefix wins among `*` patterns, as in Node.
    """
    if isinstance(exports, (str, list)) or (
        isinstance(exports, dict) and not any(key.startswith(".") for key in exports)
    ):
        exports = {".": exports}
    if not isinstance(exports, dict):
        return None
    if subpath in exports:
        return _export_targets(exports[subpath])
    best: tuple[int, list[str] | None] = (-1, None)
    for pattern, value in exports.items():
        if pattern.count("*") != 1:
            continue
        prefix, _, suffix = pattern.partition("*")
        if not subpath.startswith(prefix) or not subpath.endswith(suffix):
            continue
        if len(prefix) <= best[0]:
            continue
        captured = subpath[len(prefix) : len(subpath) - len(suffix) or None]
        best = (len(prefix), [t.replace("*", captured) for t in _export_targets(value)])
    return best[1]


class TypescriptResolver:
    """Nearest-tsconfig resolution for one repo."""

    def __init__(self, root: Path, known_files: frozenset[str]) -> None:
        self._root = root
        self._files = known_files
        self._configs: dict[Path, TsConfig] = {}
        self._nearest: dict[Path, TsConfig | None] = {}
        self._packages: dict[str, WorkspacePackage] = {}
        # A name two workspace packages both claim. The install would refuse
        # it, so an import of it is reported unresolved rather than handed to
        # whichever directory sorted first.
        self._ambiguous: set[str] = set()
        self._discover()

    def _discover(self) -> None:
        globs = workspace_globs(self._root)
        manifests: set[Path] = set()
        for relative in self._files:
            directory = (self._root / relative).parent
            while True:
                if globs and (directory / "package.json").is_file():
                    manifests.add(directory)
                config_path = directory / "tsconfig.json"
                if directory not in self._configs and config_path.is_file():
                    options = _read_tsconfig(self._root, config_path).get("compilerOptions", {})
                    paths = options.get("paths") if isinstance(options, dict) else None
                    self._configs[directory] = TsConfig(
                        directory=directory,
                        paths=paths if isinstance(paths, dict) else {},
                    )
                if directory == self._root or directory.parent == directory:
                    break
                directory = directory.parent
        for directory in sorted(manifests):
            relative = self._repo_relative(directory)
            if relative is None or relative == "." or not _in_workspace(relative, globs):
                continue
            manifest = _read_json_object(self._root, directory / "package.json")
            if manifest is None:
                continue
            name = manifest.get("name")
            if not isinstance(name, str) or not name:
                continue
            if name in self._packages:
                self._ambiguous.add(name)
                continue
            entries = tuple(
                entry for key in ("main", "module") if isinstance(entry := manifest.get(key), str)
            )
            self._packages[name] = WorkspacePackage(directory, manifest.get("exports"), entries)

    def _resolve_workspace(self, specifier: str) -> str | ResolutionOutcome | None:
        """A sibling package imported by name, or None when the name is not one.

        A name the workspace declares that then lands on no file is
        `no_matching_file`, never `external_package`: that is the silent drop
        this exists to end. opencode lost about 4,100 import statements to it,
        every `@opencode-ai/*` import counted as an npm dependency.
        """
        name, subpath = _split_package_specifier(specifier)
        if name in self._ambiguous:
            return "no_matching_file"
        package = self._packages.get(name)
        if package is None:
            return None
        if package.exports is not None:
            candidates = _subpath_targets(package.exports, subpath) or []
        elif subpath == ".":
            candidates = [*package.entries, "."]
        else:
            candidates = [subpath]
        for candidate in candidates:
            if (hit := self._probe((package.directory / candidate).resolve())) is not None:
                return hit
        # `"./styles": "./src/styles/index.css"`: the name is code-shaped, the
        # file it exports is not.
        if any(is_asset_specifier(candidate) for candidate in candidates):
            return "asset"
        return "no_matching_file"

    def _config_for(self, source: Path) -> TsConfig | None:
        directory = source.parent
        if directory in self._nearest:
            return self._nearest[directory]
        walker = directory
        found: TsConfig | None = None
        while True:
            if walker in self._configs:
                found = self._configs[walker]
                break
            if walker == self._root or walker.parent == walker:
                break
            walker = walker.parent
        self._nearest[directory] = found
        return found

    def _repo_relative(self, absolute: Path) -> str | None:
        try:
            return absolute.resolve().relative_to(self._root).as_posix()
        except ValueError:
            return None

    def _existing(self, absolute: Path) -> str | None:
        relative = self._repo_relative(absolute)
        if relative is not None and relative in self._files:
            return relative
        return None

    def _probe(self, base: Path) -> str | None:
        """Try `base` as a file, then with each extension, then as a directory."""
        if (direct := self._existing(base)) is not None:
            return direct

        suffix = base.suffix
        if suffix in EMITTED_TO_SOURCE:
            stem = base.with_suffix("")
            for replacement in EMITTED_TO_SOURCE[suffix]:
                if (hit := self._existing(stem.with_suffix(replacement))) is not None:
                    return hit

        for extension in TYPESCRIPT_EXTENSIONS:
            if (hit := self._existing(Path(str(base) + extension))) is not None:
                return hit

        for basename in INDEX_BASENAMES:
            if (hit := self._existing(base / basename)) is not None:
                return hit
        return None

    def _apply_paths(self, config: TsConfig, specifier: str) -> str | None:
        """tsconfig `paths`, resolved against the config's own directory.

        Longest literal prefix wins, which is how TypeScript breaks ties
        between "@/*" and a more specific "@/lib/*".
        """
        best: tuple[int, str | None] = (-1, None)
        for pattern, targets in config.paths.items():
            if not isinstance(targets, list):
                continue
            if "*" in pattern:
                prefix, _, suffix = pattern.partition("*")
                if not specifier.startswith(prefix) or not specifier.endswith(suffix):
                    continue
                captured = specifier[len(prefix) : len(specifier) - len(suffix) or None]
                score = len(prefix)
            else:
                if specifier != pattern:
                    continue
                captured = ""
                score = len(pattern)
            if score <= best[0]:
                continue
            for target in targets:
                if not isinstance(target, str):
                    continue
                candidate = config.directory / target.replace("*", captured)
                if (hit := self._probe(candidate)) is not None:
                    best = (score, hit)
                    break
        return best[1]

    def resolve(self, source_relative: str, specifier: str) -> str | ResolutionOutcome:
        if is_asset_specifier(specifier):
            return "asset"
        source = self._root / source_relative

        if specifier.startswith("."):
            hit = self._probe((source.parent / specifier).resolve())
            if hit is not None:
                return hit
            if self._repo_relative((source.parent / specifier).resolve()) is None:
                return "outside_repo"
            return "no_matching_file"

        config = self._config_for(source)
        if config is not None and config.paths:
            if (hit := self._apply_paths(config, specifier)) is not None:
                return hit
            if specifier.startswith(("@/", "@repo/")):
                # An alias shaped like this repo's own conventions that did not
                # land is a resolution bug, not a dependency. Say so.
                return "unparsed_alias"

        if specifier.startswith("/"):
            return "outside_repo"
        if (workspace := self._resolve_workspace(specifier)) is not None:
            return workspace
        return "external_package"


def _declared_package_directories(tool: dict) -> set[str]:
    """Package roots the three build backends in use spell out, each relative
    to the `pyproject.toml` that declares them.

    hatchling names the packages and the root is their parent; setuptools and
    poetry name the root directly. Backends not listed here fall back to the
    default layout, which the caller already covers.
    """
    found: set[str] = set()

    hatch = tool.get("hatch")
    if isinstance(hatch, dict):
        build = hatch.get("build")
        targets = build.get("targets") if isinstance(build, dict) else None
        wheel = targets.get("wheel") if isinstance(targets, dict) else None
        packages = wheel.get("packages") if isinstance(wheel, dict) else None
        if isinstance(packages, list):
            for entry in packages:
                if isinstance(entry, str):
                    parent = PurePosixPath(entry).parent
                    found.add("" if parent == PurePosixPath(".") else parent.as_posix())

    setuptools = tool.get("setuptools")
    if isinstance(setuptools, dict):
        # `package-dir = {"" = "src"}` is the src layout. A non-empty key maps
        # one package name to one directory, which names the package rather
        # than a root, so only the empty key is a root.
        package_dir = setuptools.get("package-dir")
        if isinstance(package_dir, dict) and isinstance(package_dir.get(""), str):
            found.add(package_dir[""])
        packages = setuptools.get("packages")
        find = packages.get("find") if isinstance(packages, dict) else None
        where = find.get("where") if isinstance(find, dict) else None
        if isinstance(where, list):
            found.update(entry for entry in where if isinstance(entry, str))

    poetry = tool.get("poetry")
    if isinstance(poetry, dict):
        packages = poetry.get("packages")
        if isinstance(packages, list):
            for entry in packages:
                if isinstance(entry, dict) and isinstance(entry.get("from"), str):
                    found.add(entry["from"])

    return {root.strip("/") for root in found}


class PythonResolver:
    """Relative imports by dot count, absolute ones against the repo's roots.

    A Python monorepo has no single import root. langchain holds 21 packages
    under `libs/`, each with its own `pyproject.toml` and its package directly
    beside it, so `from langchain_core.messages import x` means
    `libs/core/langchain_core/messages.py` and nothing under the repo root
    resolves at all. Measured 2026-09-14 before this existed: 2,581 files,
    **0 edges**, and every one of the 1,426 "external packages" was a sibling
    package in the same checkout. A root-only resolver does not under-report a
    monorepo, it reports nothing.

    So a `pyproject.toml` is read as what it is, a declaration of where that
    project's importable code starts. Its own directory always counts, because
    every build backend's default layout puts the package there or under
    `src/`; the `[tool.*]` tables are read on top for the layouts that say
    otherwise.
    """

    def __init__(self, root: Path, known_files: frozenset[str]) -> None:
        self._root = root
        self._files = known_files
        self._roots = self._source_roots()
        self._order: dict[str, tuple[str, ...]] = {}

    def _python_directories(self) -> set[str]:
        """Every directory holding or containing a scanned Python file.

        Derived from the scan rather than from a second walk of the disk, so
        `node_modules`, `.venv` and everything else the scanner already refuses
        stays refused here without naming any of it twice.
        """
        directories: set[str] = set()
        for relative in self._files:
            if not relative.endswith((".py", ".pyi")):
                continue
            parts = relative.split("/")[:-1]
            for index in range(len(parts) + 1):
                directories.add("/".join(parts[:index]))
        return directories

    def _source_roots(self) -> tuple[str, ...]:
        """Directories a top-level package could be imported from.

        The repo root always counts, and so does any `src/` directory: that
        layout is a convention rather than a declaration, and plenty of repos
        use it with no packaging metadata at all.
        """
        roots = {""}
        for directory in self._python_directories():
            if directory.endswith("/src") or directory == "src":
                roots.add(directory)
            if not (self._root / directory / "pyproject.toml").is_file():
                continue
            roots.add(directory)
            roots |= self._declared_roots(directory)
        return tuple(sorted(roots, key=len, reverse=True))

    def _declared_roots(self, directory: str) -> set[str]:
        """Roots the build backend names, repo-relative.

        A file that will not parse contributes nothing and is not an error:
        the directory it sits in is already a root by the rule above, which is
        also every backend's default, so an unreadable `pyproject.toml` costs
        the non-default layouts and nothing else. Each table is read only in
        the shape it is documented to have, because these files come from other
        people's repos and a string where a list belongs is their business.
        """
        manifest = self._root / directory / "pyproject.toml"
        if not inside_repo(self._root, manifest):
            return set()
        try:
            config = tomllib.loads(manifest.read_text("utf-8"))
        except OSError, UnicodeDecodeError, tomllib.TOMLDecodeError:
            return set()

        tool = config.get("tool")
        if not isinstance(tool, dict):
            return set()
        prefix = f"{directory}/" if directory else ""
        return {
            f"{prefix}{relative}".rstrip("/") for relative in _declared_package_directories(tool)
        }

    def _roots_for(self, source_relative: str) -> tuple[str, ...]:
        """Roots to try for a file, the ones enclosing it first.

        This is the Python half of the trap the TypeScript resolver's docstring
        opens with: several independent projects in one tree, and resolving
        against the merged set picks a file in the wrong one and looks like it
        worked. `libs/core/tests/unit_tests/foo.py` importing `tests.unit_tests`
        means its own package's tests, not the identically named directory
        under `libs/partners/openai`. Preferring the nearest enclosing root is
        also what the interpreter does, since each project is installed
        separately and only reaches the others by distribution name.
        """
        directory = source_relative.rsplit("/", 1)[0] if "/" in source_relative else ""
        cached = self._order.get(directory)
        if cached is not None:
            return cached
        enclosing = tuple(
            root
            for root in self._roots
            if root == "" or directory == root or directory.startswith(f"{root}/")
        )
        order = enclosing + tuple(root for root in self._roots if root not in set(enclosing))
        self._order[directory] = order
        return order

    def _module_file(self, as_path: str) -> str | None:
        """`as_path` is slash-separated and repo-relative, without extension."""
        as_path = as_path.strip("/")
        if not as_path:
            return None
        for candidate in (f"{as_path}.py", f"{as_path}/__init__.py", f"{as_path}.pyi"):
            if candidate in self._files:
                return candidate
        return None

    def resolve(self, source_relative: str, specifier: str) -> str | ResolutionOutcome:
        if is_asset_specifier(specifier):
            return "asset"
        if specifier.startswith("."):
            depth = len(specifier) - len(specifier.lstrip("."))
            tail = specifier[depth:]
            package = Path(source_relative).parent
            # One dot means the importing file's own package, so only the dots
            # beyond the first walk upward.
            for _ in range(depth - 1):
                package = package.parent
            if str(package).startswith(".."):
                return "outside_repo"
            base = package.as_posix()
            base = "" if base == "." else base
            as_path = f"{base}/{tail.replace('.', '/')}" if tail else base
            hit = self._module_file(as_path)
            return hit if hit is not None else "no_matching_file"

        as_path = specifier.replace(".", "/")
        for source_root in self._roots_for(source_relative):
            prefix = f"{source_root}/" if source_root else ""
            if (hit := self._module_file(f"{prefix}{as_path}")) is not None:
                return hit
        return "external_package"
