"""graphify's renderer over file-level data.

The `graphify page` tab is graphify's `graph.html` served verbatim: 29,402
symbol nodes, community names like `Equatable`, `D`, `evaluate`. That answers
"how does graphify render", not "how does our file graph look in its
renderer". This module is the second half: a graph synthesized from a cached
analysis -- one node per FILE, one edge per import, our Louvain partition and
labels -- handed to graphify's own `export html`, so the drawing is graphify's
code while everything in it is files.

No graphify code is imported and no graphify command is run beyond its own
`export html` over a synthesized `graph.json`: the node-link schema plus a
per-node `community` attribute is the whole contract, and it is also what
`export html` falls back to when its analysis sidecar is absent.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from reposhape import graphing
from reposhape.configuration import settings
from reposhape.graphify_page import GraphifyPageError, binary, run
from reposhape.models import Analysis


class GraphifyFilesError(Exception):
    """The file-level page cannot be produced here. Says what is missing."""


_STATS_RE = re.compile(r'<div id="stats">.*?</div>')


def workdir(key: str) -> Path:
    """The synthesized graph and graphify's page beside it, under our cache."""
    if "/" in key or "\\" in key or key.startswith("."):
        raise GraphifyFilesError(f"not a cache key: {key!r}")
    return settings.cache_root / f"{key}-graphify-files"


def _synth(analysis: Analysis, root: Path) -> None:
    """A graph.json in graphify's node-link schema, but file-level throughout.

    Node ids ARE repo-relative paths, each carrying its own file as
    `source_file`; edges carry `relation: imports` at `EXTRACTED` confidence,
    restoring `_src`/`_tgt` the way graphify's own builder stashes them.
    Communities come from the shared `partition`, so this page and our tabs
    draw the same communities under the same labels.
    """
    keep = {node.path: node for node in analysis.files}
    edges = [edge for edge in analysis.edges if edge.source in keep and edge.target in keep]
    ordered, labels = graphing.partition(keep, edges)
    community_of = {path: index for index, members in enumerate(ordered) for path in members}
    by_path = {node.path: node for node in analysis.files}

    nodes = [
        {
            "id": path,
            "label": path,
            "source_file": path,
            "file_type": by_path[path].language if path in by_path else "",
            "community": community_of.get(path, 0),
        }
        for path in sorted(keep)
    ]
    links = [
        {
            "source": edge.source,
            "target": edge.target,
            "relation": "imports",
            "confidence": "EXTRACTED",
            "_src": edge.source,
            "_tgt": edge.target,
        }
        for edge in edges
    ]
    root.mkdir(parents=True, exist_ok=True)
    (root / "graph.json").write_text(
        json.dumps({"directed": True, "nodes": nodes, "links": links}),
        encoding="utf-8",
    )
    (root / "labels.json").write_text(
        json.dumps({str(index): label for index, label in enumerate(labels)}),
        encoding="utf-8",
    )


def page_path(key: str) -> Path:
    return workdir(key) / "graph.html"


def _embedded(page: str, name: str) -> tuple[Any, int, int]:
    """A `const NAME = [...]` payload and its span, parsed not regexed.

    The payloads are JSON the exporter wrote inline; decoding from the marker
    cannot mismatch on a `];` inside a string the way a non-greedy regex can.
    Returns the value and the (start, end) of the JSON itself, semicolon
    excluded so reassembly keeps the page's own punctuation.
    """
    marker = f"const {name} = "
    start = page.index(marker) + len(marker)
    value, end = json.JSONDecoder().raw_decode(page[start:])
    return value, start, start + end


def filtered_html(
    key: str,
    analysis: Analysis,
    *,
    excluded: frozenset[str] = frozenset(),
    include_tests: bool = False,
    include_type_only: bool = True,
    excluded_extensions: frozenset[str] = frozenset(),
) -> str:
    """The cached page with the shape applied: the same predicate as our tabs.

    The page is graphify's export over the FULL analysis, so filtering happens
    here, on its embedded data, instead of re-running the exporter per shape.
    Communities stay as exported -- the full-graph partition -- and only
    membership is filtered, so colors match the unfiltered page. The keep set
    comes from `build_view` itself rather than a second predicate, so the two
    can never disagree about what a shape means. Legend counts and the stats
    line are recomputed for what is left.
    """
    page = ensure(key, analysis).read_text(encoding="utf-8")
    view = graphing.build_view(
        analysis,
        excluded=excluded,
        include_tests=include_tests,
        include_type_only=include_type_only,
        excluded_extensions=excluded_extensions,
    )
    keep = {node.path for node in view.nodes}
    kept_pairs = {(edge.source, edge.target) for edge in view.edges}

    nodes, node_start, node_end = _embedded(page, "RAW_NODES")
    edges, edge_start, edge_end = _embedded(page, "RAW_EDGES")
    legend, legend_start, legend_end = _embedded(page, "LEGEND")

    kept_nodes = [node for node in nodes if node["id"] in keep]
    kept_edges = [edge for edge in edges if (edge["from"], edge["to"]) in kept_pairs]
    counts: dict[int, int] = {}
    for node in kept_nodes:
        counts[node["community"]] = counts.get(node["community"], 0) + 1
    kept_legend = [
        {**entry, "count": counts[entry["cid"]]}
        for entry in legend
        if counts.get(entry["cid"], 0) > 0
    ]

    page = (
        page[:node_start]
        + json.dumps(kept_nodes)
        + page[node_end:edge_start]
        + json.dumps(kept_edges)
        + page[edge_end:legend_start]
        + json.dumps(kept_legend)
        + page[legend_end:]
    )
    stats = (
        f"{len(kept_nodes)} nodes &middot; {len(kept_edges)} edges "
        f"&middot; {len(counts)} communities"
    )
    page, found = _STATS_RE.subn(f'<div id="stats">{stats}</div>', page, count=1)
    assert found == 1, "the exported page lost its stats line"
    return page


def analysis_path_for(analysis: Analysis) -> Path:
    from reposhape import cache

    return cache.analysis_path(analysis.repo_path, analysis.source)


def ensure(key: str, analysis: Analysis) -> Path:
    """Build the file-level page through graphify's own exporter, unless fresh.

    Fresh means the page is newer than the analysis artifact it was drawn
    from; anything else rebuilds, because the analysis is the only input and
    its mtime is the only clock.
    """
    root = workdir(key)
    target = root / "graph.html"
    try:
        source_mtime = analysis_path_for(analysis).stat().st_mtime
    except OSError:
        source_mtime = float("inf")
    if target.is_file() and target.stat().st_mtime >= source_mtime:
        return target

    exe = binary()
    if exe is None:
        raise GraphifyFilesError(
            "the `graphify` binary is not on PATH, so its renderer cannot run here."
        )
    _synth(analysis, root)
    try:
        run(
            [
                exe,
                "export",
                "html",
                "--graph",
                str(root / "graph.json"),
                "--labels",
                str(root / "labels.json"),
            ],
            Path(analysis.repo_path),
        )
    except GraphifyPageError as error:
        raise GraphifyFilesError(str(error)) from error
    if not target.is_file():
        raise GraphifyFilesError("graphify ran but wrote no graph.html for the file-level graph.")
    return target
