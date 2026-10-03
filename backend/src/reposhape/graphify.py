"""Read graphify's own graph and project it onto files, for comparison.

This exists to keep one claim honest. `PRD.md` says this tool is being built
instead of reusing graphify, and the only way to judge that is to put both
graphs on the same screen, through the same clustering and the same renderer,
so that a difference in the picture is a difference in the extractor rather
than a difference in the drawing.

Two things about graphify's artifact shape the mapping:

* **Its nodes are symbols, not files.** 29,402 of them for one 1,260-file repo, each
  carrying a `source_file`. Projecting onto files is what makes the two
  comparable at all; the 38,662 calls between symbols inside one file collapse
  to nothing, which is the right answer for a file-level graph.
* **Its edges carry a `relation`**, and only some of them are imports. Taking
  all 16 relations answers a different question from ours (what refers to what,
  including calls, inheritance and prose citations), so both projections are
  offered and named separately rather than blended into one number.

A third thing scopes it: **the projection keeps only files our own extractor
also sees** (`scope`, the file set of the `imports` analysis). graphify
records Swift, Rust, shell and Markdown that this tool deliberately does not
parse, so an unscoped projection compares different node sets as well as
different edges, and no filter count can be honest for both panes at once.
Scoped, both tabs draw identical nodes and the picture differs only in edges,
which is the claim under test. Swift's `import Module` names a module rather
than a file and resolves per build target (PRD non-goals); when that changes,
the scope grows with it.

It reads the artifact and nothing else: no graphify code is imported, no
graphify command is run.
"""

from __future__ import annotations

import json
import subprocess
import time
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

from reposhape.models import (
    SOURCE_LABELS,
    Analysis,
    AnalysisSource,
    AnalysisStats,
    FileNode,
    ImportEdge,
    Language,
)
from reposhape.scanning import is_test_path, language_of

ARTIFACT = Path("graphify-out") / "graph.json"

# graphify's relations that mean "this file pulls in that file". The rest --
# calls, references, contains, method, implements, case_of, inherits,
# indirect_call, uses, rationale_for, defines, cites -- are real edges about
# other questions, and are kept for the `graphify-all` projection.
IMPORT_RELATIONS = frozenset({"imports", "imports_from", "dynamic_import", "re_exports"})


class GraphifyArtifactError(Exception):
    """No usable graphify output for this repo. Says which file is missing."""


def ensure_scope(repo: Path) -> frozenset[str]:
    """The file set the comparison shares: the repo's own `imports` analysis.

    Built and cached on demand, so asking for a graphify tab never answers
    with a scope that does not exist yet. Lazy imports, because this module
    is also imported by the analysis it scopes.
    """
    from reposhape import analysis, cache
    from reposhape.cache import StaleArtifactError

    try:
        existing = cache.load(repo, "imports")
    except StaleArtifactError:
        existing = None
    if existing is None:
        result = analysis.analyze(repo)
        cache.write(result)
        return frozenset(node.path for node in result.files)
    return frozenset(node.path for node in existing.files)


def artifact_path(repo: Path) -> Path:
    return repo / ARTIFACT


def has_artifact(repo: Path) -> bool:
    return artifact_path(repo).is_file()


def _language(path: str) -> Language:
    return language_of(path) or "other"


def _git(root: Path, *args: str) -> str | None:
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
    return completed.stdout if completed.returncode == 0 else None


def load(repo: Path, source: AnalysisSource, scope: frozenset[str] | None = None) -> Analysis:
    """Project graphify's symbol graph onto files.

    `source` picks the relation set. Anything other than the two graphify
    sources is a programming error here, not a user-facing one. `scope` is
    the file set both tabs of the comparison share, usually the paths of the
    repo's own `imports` analysis (see `ensure_scope`); without it the
    projection keeps every file graphify saw, including languages this tool
    does not parse, and the two tabs stop drawing the same nodes.
    """
    if source not in ("graphify-imports", "graphify-all"):
        raise ValueError(f"{source!r} is not a graphify projection")

    started = time.perf_counter()
    path = artifact_path(repo)
    if not path.is_file():
        raise GraphifyArtifactError(
            f"no {ARTIFACT} in {repo}. Run graphify in that repo first, or pick a different source."
        )
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as error:
        raise GraphifyArtifactError(f"{path} is not readable JSON: {error}") from error

    symbols = raw.get("nodes")
    links = raw.get("links")
    if not isinstance(symbols, list) or not isinstance(links, list):
        raise GraphifyArtifactError(f"{path} has no `nodes` and `links` arrays")

    # A symbol with no source_file cannot be placed on a file graph. One repo
    # had 3,996 of them, mostly synthesised nodes, and they are counted rather
    # than dropped quietly.
    file_of: dict[str, str] = {}
    placeless = 0
    for symbol in symbols:
        identifier = symbol.get("id")
        origin = symbol.get("source_file")
        if not identifier:
            continue
        if origin:
            file_of[identifier] = origin
        else:
            placeless += 1

    wanted = IMPORT_RELATIONS if source == "graphify-imports" else None
    weights: Counter[tuple[str, str]] = Counter()
    considered = 0
    for link in links:
        relation = link.get("relation")
        if wanted is not None and relation not in wanted:
            continue
        considered += 1
        origin = file_of.get(link.get("source", ""))
        destination = file_of.get(link.get("target", ""))
        if origin is None or destination is None:
            continue
        if origin == destination:
            continue
        if scope is not None and (origin not in scope or destination not in scope):
            continue
        weights[(origin, destination)] += 1

    # The shared universe, not just the files an edge touches. Without a
    # scope that is every file graphify saw; with one it is every scoped
    # file, edge or no edge, so both tabs of the comparison draw identical
    # nodes and differ only in edges. A scoped file graphify never saw is an
    # isolate, which is the honest drawing of "no edge here".
    paths = set(scope) if scope is not None else {end for edge in weights for end in edge}
    files = [
        FileNode(
            path=path_name,
            language=_language(path_name),
            is_test=is_test_path(path_name),
            lines=0,
            bytes=0,
        )
        for path_name in sorted(paths)
    ]
    edges = [
        ImportEdge(source=origin, target=destination, weight=weight, type_only=False)
        for (origin, destination), weight in sorted(weights.items())
    ]

    head = _git(repo, "rev-parse", "HEAD")
    status = _git(repo, "status", "--porcelain")
    duration_ms = int((time.perf_counter() - started) * 1000)

    return Analysis(
        source=source,
        repo_path=str(repo.resolve()),
        repo_name=f"{repo.resolve().name} ({SOURCE_LABELS[source]})",
        git_sha=head.strip() if head else None,
        dirty=bool(status and status.strip()),
        generated_at=datetime.now(UTC),
        files=files,
        edges=edges,
        # graphify's artifact records neither. Reporting zero is honest here
        # because the question was never asked, and the UI reads these as
        # counts rather than as claims of correctness.
        unresolved=[],
        external={},
        assets={},
        stats=AnalysisStats(
            files_scanned=len(paths),
            files_parsed=len(paths),
            files_skipped=placeless,
            statements_found=considered,
            edges=len(edges),
            unresolved=0,
            assets=0,
            duration_ms=duration_ms,
        ),
    )
