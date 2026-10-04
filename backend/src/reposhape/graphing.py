"""Building the file-level graph and partitioning it.

Clustering behaviour is ported from an earlier script, graphify-import-graph.py:
Louvain over the undirected projection with `seed=42`, isolates each their own
community, labels from the longest common path prefix rather than from an LLM.
That version was read and judged against a real repo's structure, so keeping
it identical means the two stay comparable while the extractor changes
underneath.

The filter is applied before partitioning, not after. That is the whole reason
this runs per request (ADR-0002).
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping

import networkx as nx
from networkx.algorithms.community import louvain_communities

from reposhape.models import (
    Analysis,
    Cluster,
    GraphNode,
    GraphView,
    ImportEdge,
    ViewStats,
)

# Colour-blind-safe categorical ramp, carried over from the tool being replaced
# so a familiar graph keeps familiar colours.
PALETTE = (
    "#4E79A7",
    "#F28E2B",
    "#E15759",
    "#76B7B2",
    "#59A14F",
    "#EDC948",
    "#B07AA1",
    "#FF9DA7",
    "#9C755F",
    "#BAB0AC",
)

# Everything past the palette shares this. Position still separates those
# clusters on the canvas; colour no longer claims to.
OTHER_COLOR = "#5c5c72"
UNCLUSTERED_COLOR = "#3a3a4e"


def path_is_excluded(path: str, excluded: Iterable[str]) -> bool:
    """True when `path` is, or sits under, any excluded path.

    Exclusions are plain repo-relative paths and work at any depth: a directory
    like `app/wire` takes its whole subtree, a file like
    `app/wire/index.ts` takes only itself. A prefix match alone would let
    `app/wire-utils` be swallowed by `app/wire`, so a directory
    match requires the separator.
    """
    return any(path == entry or path.startswith(f"{entry.rstrip('/')}/") for entry in excluded)


def _directory_of(path: str) -> str:
    parent = path.rsplit("/", 1)[0] if "/" in path else ""
    return parent


def cluster_label(paths: Iterable[str]) -> str:
    """Name a cluster from where its files live. No LLM, by design.

    A shared directory prefix is the label when one exists. When it does not,
    that is real information rather than a gap: the cluster is held together by
    imports that cross the tree. Saying which directory dominates it, and how
    many members sit outside, describes that better than inventing a theme.
    """
    members = list(paths)
    if not members:
        return "(empty)"

    segment_lists = [_directory_of(path).split("/") for path in members]
    shared: list[str] = []
    for index in range(min(len(segments) for segments in segment_lists)):
        candidate = segment_lists[0][index]
        if all(segments[index] == candidate for segments in segment_lists):
            shared.append(candidate)
        else:
            break
    if shared and shared != [""]:
        return "/".join(shared)

    top_level = Counter("/".join(path.split("/")[:2]) for path in members)
    dominant, count = top_level.most_common(1)[0]
    return f"{dominant} +{len(members) - count} elsewhere"


def disambiguate(labels: list[str], members: list[list[str]]) -> list[str]:
    """Make colliding cluster labels distinguishable.

    Two communities under one directory are common and legitimate, but a legend
    listing `packages/panel/web/src` twice cannot be read. Each collision
    gets a deeper segment appended, and the segment is chosen greedily so that
    two siblings never take the same one: picking each cluster's most common
    next segment independently just reproduces the collision one level down,
    which is what `features/` did on the first attempt here.
    """
    groups: dict[str, list[int]] = {}
    for index, label in enumerate(labels):
        groups.setdefault(label, []).append(index)

    resolved = list(labels)
    for label, indices in groups.items():
        if len(indices) == 1:
            continue
        depth = len(label.split("/"))
        ranked: dict[int, list[tuple[str, int]]] = {}
        for index in indices:
            counts = Counter(
                parts[depth]
                for path in members[index]
                if len(parts := _directory_of(path).split("/")) > depth and parts[depth]
            )
            ranked[index] = counts.most_common()

        taken: set[str] = set()
        # Largest cluster first, so the biggest group keeps the most
        # representative segment rather than whichever one is left over.
        for index in sorted(indices, key=lambda i: -len(members[i])):
            choice = next((seg for seg, _ in ranked[index] if seg not in taken), None)
            if choice is None:
                resolved[index] = f"{label} ({len(members[index])} files)"
                continue
            taken.add(choice)
            # Parenthesised rather than appended as a path segment: a label of
            # `.../src/features` reads as a real directory and is then
            # indistinguishable from the cluster that genuinely is that
            # directory. The parens say "this is how we tell two apart".
            resolved[index] = f"{label} ({choice})"
    return resolved


def extension_of(path: str) -> str:
    """The file extension without the dot, lowercase. `a/b.C` is `c`."""
    leaf = path.rsplit("/", 1)[-1]
    return leaf.rsplit(".", 1)[-1].lower() if "." in leaf else ""


def partition(
    keep: Mapping[str, object], edges: list[ImportEdge]
) -> tuple[list[list[str]], list[str]]:
    """Louvain communities, largest first, with disambiguated labels.

    Seeded, so the same view always gets the same partition, ordering and
    labels. Files with no edge form one trailing group rather than scattering,
    because a clustering that is wrong would otherwise still draw as tidy
    separated balls, and every drawing needs every node placed somewhere.
    """
    graph: nx.Graph = nx.Graph()
    graph.add_nodes_from(keep)
    for edge in edges:
        weight = graph.get_edge_data(edge.source, edge.target, {}).get("weight", 0)
        graph.add_edge(edge.source, edge.target, weight=weight + edge.weight)

    connected = graph.subgraph([n for n, degree in graph.degree() if degree > 0])
    communities = (
        louvain_communities(connected, weight="weight", seed=42)
        if connected.number_of_nodes()
        else []
    )
    ordered = [sorted(members) for members in sorted(communities, key=len, reverse=True)]
    labels = disambiguate([cluster_label(members) for members in ordered], ordered)

    assigned = {member for members in ordered for member in members}
    isolated = sorted(path for path in keep if path not in assigned)
    if isolated:
        ordered.append(isolated)
        labels.append(f"(no imports, {len(isolated)} files)")
    return ordered, labels


def build_view(
    analysis: Analysis,
    *,
    excluded: frozenset[str] = frozenset(),
    include_tests: bool = False,
    include_type_only: bool = True,
    excluded_extensions: frozenset[str] = frozenset(),
) -> GraphView:
    """Filter, then partition, then describe."""
    keep = {
        node.path: node
        for node in analysis.files
        if (include_tests or not node.is_test)
        and not path_is_excluded(node.path, excluded)
        and extension_of(node.path) not in excluded_extensions
    }

    edges = [
        edge
        for edge in analysis.edges
        if edge.source in keep and edge.target in keep and (include_type_only or not edge.type_only)
    ]

    ordered, labels = partition(keep, edges)

    assignment: dict[str, int] = {}
    for index, members in enumerate(ordered):
        for member in members:
            assignment[member] = index
    clusters = [
        Cluster(
            id=index,
            label=label,
            color=PALETTE[index] if index < len(PALETTE) else OTHER_COLOR,
            size=len(members),
            distinct_color=index < len(PALETTE),
        )
        for index, (label, members) in enumerate(zip(labels, ordered, strict=True))
    ]
    if ordered and labels[-1].startswith("(no imports,"):
        clusters[-1] = clusters[-1].model_copy(
            update={"color": UNCLUSTERED_COLOR, "distinct_color": False}
        )

    in_degree: dict[str, int] = dict.fromkeys(keep, 0)
    out_degree: dict[str, int] = dict.fromkeys(keep, 0)
    for edge in edges:
        out_degree[edge.source] += 1
        in_degree[edge.target] += 1

    nodes = [
        GraphNode(
            path=path,
            language=node.language,
            cluster=assignment[path],
            in_degree=in_degree[path],
            out_degree=out_degree[path],
            lines=node.lines,
        )
        for path, node in keep.items()
    ]
    nodes.sort(key=lambda n: n.path)

    links = [link for link in analysis.links if link.source in keep and link.target in keep]

    return GraphView(
        nodes=nodes,
        edges=edges,
        clusters=clusters,
        links=links,
        stats=ViewStats(
            visible_files=len(nodes),
            total_files=len(analysis.files),
            visible_edges=len(edges),
            total_edges=len(analysis.edges),
            clusters=len(clusters),
            visible_links=len(links),
            total_links=len(analysis.links),
        ),
    )


def collapse_edges(pairs: Iterable[tuple[str, str, bool]]) -> list[ImportEdge]:
    """Statement-level imports to weighted file-level edges.

    An edge is type-only only when every statement behind it was.
    """
    weights: dict[tuple[str, str], int] = {}
    runtime: dict[tuple[str, str], bool] = {}
    for source, target, type_only in pairs:
        key = (source, target)
        weights[key] = weights.get(key, 0) + 1
        runtime[key] = runtime.get(key, False) or not type_only
    return [
        ImportEdge(
            source=source,
            target=target,
            weight=weight,
            type_only=not runtime[(source, target)],
        )
        for (source, target), weight in sorted(weights.items())
    ]
