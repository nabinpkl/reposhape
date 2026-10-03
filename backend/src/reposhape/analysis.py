"""The one analysis path. The CLI calls it, the API calls it, nothing else exists.

Keeping a single orchestrator is what makes `reposhape analyze` and
`POST /api/analyze` produce byte-identical artifacts. A second implementation
behind the server would drift, and nothing would catch it.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from reposhape.configuration import settings
from reposhape.graphing import collapse_edges
from reposhape.models import (
    Analysis,
    AnalysisStats,
    FileNode,
    UnresolvedImport,
)
from reposhape.parsing import parse_imports
from reposhape.resolution import PythonResolver, TypescriptResolver
from reposhape.runtime_links import FileLinks, link, load_rules, scan_file
from reposhape.scanning import scan

ProgressCallback = Callable[[str, int, int], None]


def _noop_progress(stage: str, done: int, total: int) -> None:
    return None


def analyze(
    repo_path: Path | str,
    *,
    progress: ProgressCallback = _noop_progress,
) -> Analysis:
    """Scan, parse, resolve, and collapse into the artifact.

    Tests are parsed and kept in the artifact. They are filtered at view time
    instead, so toggling `include_tests` in the UI never needs a re-analysis.
    """
    started = time.perf_counter()
    root = Path(repo_path).expanduser().resolve()

    progress("scanning", 0, 0)
    scanned = scan(root)
    total = len(scanned.files)
    progress("scanning", total, total)

    known = frozenset(source.path for source in scanned.files)
    typescript = TypescriptResolver(root, known)
    python = PythonResolver(root, known)
    rules = load_rules(settings.link_rules_dir / f"{scanned.name}.toml")
    runtime: dict[str, FileLinks] = {}

    files: list[FileNode] = []
    pairs: list[tuple[str, str, bool]] = []
    unresolved: list[UnresolvedImport] = []
    external: dict[str, int] = {}
    assets: dict[str, int] = {}
    statements = 0
    parsed = 0
    skipped = 0

    for index, source in enumerate(scanned.files):
        absolute = root / source.path
        try:
            raw_bytes = absolute.read_bytes()
        except OSError:
            skipped += 1
            continue

        lines = raw_bytes.count(b"\n") + 1 if raw_bytes else 0
        files.append(
            FileNode(
                path=source.path,
                language=source.language,
                is_test=source.is_test,
                lines=lines,
                bytes=source.size,
            )
        )

        if source.size > settings.max_parse_bytes:
            # A minified bundle is one line of noise. Counted as a file so the
            # tree still shows it, never parsed.
            skipped += 1
            continue

        found = parse_imports(source.path, source.language, raw_bytes)
        runtime[source.path] = scan_file(source.path, source.language, raw_bytes, rules)
        parsed += 1
        statements += len(found)

        resolver = python if source.language == "python" else typescript
        for raw in found:
            outcome = resolver.resolve(source.path, raw.specifier)
            match outcome:
                case "external_package":
                    external[raw.specifier] = external.get(raw.specifier, 0) + 1
                case "asset":
                    assets[raw.specifier] = assets.get(raw.specifier, 0) + 1
                case "no_matching_file" | "outside_repo" | "unparsed_alias":
                    unresolved.append(
                        UnresolvedImport(
                            source=source.path,
                            specifier=raw.specifier,
                            reason=outcome,
                            line=raw.line,
                        )
                    )
                case _ if outcome != source.path:
                    pairs.append((source.path, outcome, raw.type_only))

        if total and index % 50 == 0:
            progress("parsing", index, total)

    progress("parsing", total, total)
    progress("resolving", total, total)

    edges = collapse_edges(pairs)

    def resolve_module(source_path: str, module: str) -> str | None:
        target = python.resolve(source_path, module)
        return target if target in known else None

    links, link_stats = link(root, runtime, rules, known, resolve_module)
    duration_ms = int((time.perf_counter() - started) * 1000)
    progress("done", total, total)

    return Analysis(
        repo_path=str(root),
        repo_name=scanned.name,
        git_sha=scanned.git_sha,
        dirty=scanned.dirty,
        generated_at=datetime.now(UTC),
        files=files,
        edges=edges,
        unresolved=unresolved,
        external=dict(sorted(external.items(), key=lambda item: -item[1])),
        assets=dict(sorted(assets.items(), key=lambda item: -item[1])),
        stats=AnalysisStats(
            files_scanned=scanned.considered,
            files_parsed=parsed,
            files_skipped=skipped,
            statements_found=statements,
            edges=len(edges),
            unresolved=len(unresolved),
            assets=sum(assets.values()),
            duration_ms=duration_ms,
        ),
        links=links,
        link_stats=link_stats,
    )
