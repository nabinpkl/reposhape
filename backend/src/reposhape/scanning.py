"""Finding the source files in a repo, and deciding what each one is.

`git ls-files` is preferred over walking: it applies .gitignore for free, it
never descends into node_modules, and the same git call gives us the commit sha
that keys the cache. The walk is the fallback for a non-git directory.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pathspec

from reposhape.models import Language

IGNORE_FILENAME = ".reposhapeignore"

# Directories never worth descending into on the walk fallback. git ls-files
# handles these through .gitignore, so this list only serves the non-git path.
ALWAYS_SKIP_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".next",
        ".turbo",
        ".build",
        "dist",
        "build",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
    }
)

EXTENSION_LANGUAGE: dict[str, Language] = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".vue": "vue",
    ".py": "python",
    ".pyi": "python",
}

# Ported verbatim in behaviour from an earlier script, graphify-import-graph.py,
# which was tuned against a real repo's actual mix rather than one ecosystem's
# naming style. Swift patterns are kept: Swift is not parsed yet, but a Swift
# test file should not be counted as production either.
TEST_FILE_RE = re.compile(
    r"(\.(test|spec)\.[a-z]+$)"  # foo.test.ts, foo.spec.tsx
    r"|(^test_[^/]*\.py$)"  # test_foo.py at the root
    r"|(/test_[^/]*\.py$)"  # test_foo.py anywhere
    r"|(_test\.py$)"  # foo_test.py
    r"|(Tests?\.swift$)"  # FooTests.swift
    r"|(/__tests__/)"  # __tests__/ dirs
    r"|(^__tests__/)"
    r"|(/Tests/)"  # Swift package Tests/ dirs
    r"|(^tests?/)"  # a top-level tests/ dir
    r"|(/tests?/)"
)


def is_test_path(relative_path: str) -> bool:
    return bool(TEST_FILE_RE.search(relative_path))


def language_of(relative_path: str) -> Language | None:
    suffix = Path(relative_path).suffix
    return EXTENSION_LANGUAGE.get(suffix)


@dataclass(frozen=True, slots=True)
class SourceFile:
    path: str
    language: Language
    is_test: bool
    size: int


@dataclass(frozen=True, slots=True)
class RepoScan:
    root: Path
    name: str
    git_sha: str | None
    dirty: bool
    files: list[SourceFile]
    considered: int


def _git(root: Path, *args: str) -> str | None:
    """Run a git command in `root`, or return None when git cannot answer.

    Anything git says it cannot do is a fallback signal, not a crash: a plain
    directory is a legitimate target.
    """
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except OSError, subprocess.TimeoutExpired:
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout


def _load_ignore_spec(root: Path) -> pathspec.PathSpec | None:
    ignore_file = root / IGNORE_FILENAME
    if not ignore_file.is_file():
        return None
    lines = ignore_file.read_text(encoding="utf-8", errors="replace").splitlines()
    return pathspec.PathSpec.from_lines("gitwildmatch", lines)


def _tracked_paths(root: Path) -> list[str] | None:
    listing = _git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    if listing is None:
        return None
    return [entry for entry in listing.split("\0") if entry]


def _walked_paths(root: Path) -> list[str]:
    found: list[str] = []
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = list(current.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_dir():
                if entry.name not in ALWAYS_SKIP_DIRS:
                    stack.append(entry)
                continue
            found.append(entry.relative_to(root).as_posix())
    return found


def scan(root: Path) -> RepoScan:
    """List the repo's own source files, with .gitignore and scope applied."""
    root = root.expanduser().resolve()
    if not root.is_dir():
        raise NotADirectoryError(f"not a directory: {root}")

    candidates = _tracked_paths(root)
    is_git = candidates is not None
    if candidates is None:
        candidates = _walked_paths(root)

    ignore_spec = _load_ignore_spec(root)
    files: list[SourceFile] = []
    for relative in candidates:
        language = language_of(relative)
        if language is None:
            continue
        if ignore_spec is not None and ignore_spec.match_file(relative):
            continue
        absolute = root / relative
        try:
            size = absolute.stat().st_size
        except OSError:
            # Listed by git but gone from disk, or unreadable. Skipping is
            # correct; it has no content to contribute an edge.
            continue
        files.append(
            SourceFile(
                path=relative,
                language=language,
                is_test=is_test_path(relative),
                size=size,
            )
        )

    files.sort(key=lambda f: f.path)

    git_sha = None
    dirty = False
    if is_git:
        head = _git(root, "rev-parse", "HEAD")
        git_sha = head.strip() if head else None
        status = _git(root, "status", "--porcelain")
        dirty = bool(status and status.strip())

    return RepoScan(
        root=root,
        name=root.name,
        git_sha=git_sha,
        dirty=dirty,
        files=files,
        considered=len(candidates),
    )
