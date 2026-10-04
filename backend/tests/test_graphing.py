"""Filtering, clustering, and labelling."""

from datetime import UTC, datetime

from reposhape.graphing import (
    build_view,
    cluster_label,
    collapse_edges,
    disambiguate,
    extension_of,
    path_is_excluded,
)
from reposhape.models import Analysis, AnalysisStats, FileNode, LinkStats


def test_excluding_a_directory_does_not_take_a_similarly_named_sibling():
    """`app/wire` must not swallow `app/wire-utils`."""
    excluded = {"app/wire"}
    assert path_is_excluded("app/wire/index.ts", excluded)
    assert path_is_excluded("app/wire", excluded)
    assert not path_is_excluded("app/wire-utils/index.ts", excluded)


def test_excluding_a_single_file_takes_only_that_file():
    excluded = {"app/wire/index.ts"}
    assert path_is_excluded("app/wire/index.ts", excluded)
    assert not path_is_excluded("app/wire/other.ts", excluded)


def test_extension_is_the_lowercase_suffix_without_the_dot():
    assert extension_of("src/a.TS") == "ts"
    assert extension_of("Sources/App.swift") == "swift"
    assert extension_of("Makefile") == ""


def test_excluding_an_extension_reclusters_without_it():
    analysis = _analysis(
        [("a.ts", False), ("b.py", False), ("c.ts", False)],
        [("a.ts", "b.py"), ("b.py", "c.ts")],
    )
    whole = build_view(analysis)
    without_ts = build_view(analysis, excluded_extensions=frozenset({"ts"}))
    assert {node.path for node in without_ts.nodes} == {"b.py"}
    assert without_ts.stats.visible_files == whole.stats.visible_files - 2


def test_cluster_label_is_the_shared_directory():
    assert cluster_label(["a/b/one.ts", "a/b/two.ts"]) == "a/b"
    assert cluster_label(["a/b/one.ts", "a/c/two.ts"]) == "a"


def test_cluster_label_says_so_when_members_span_the_tree():
    label = cluster_label(["a/b/one.ts", "x/y/two.ts", "a/b/three.ts"])
    assert label.startswith("a/b")
    assert "elsewhere" in label


def test_colliding_labels_get_different_segments():
    """Picking each cluster's modal segment independently reproduces the
    collision one level down, which is what `features/` did in the first
    version of this."""
    members = [
        ["src/features/a.ts", "src/features/b.ts"],
        ["src/app/c.ts", "src/app/d.ts"],
    ]
    resolved = disambiguate(["src", "src"], members)
    assert len(set(resolved)) == 2
    assert "features" in resolved[0]
    assert "app" in resolved[1]


def test_an_edge_is_type_only_only_when_every_statement_behind_it_was():
    assert collapse_edges([("a", "b", True), ("a", "b", True)])[0].type_only
    assert not collapse_edges([("a", "b", True), ("a", "b", False)])[0].type_only
    assert collapse_edges([("a", "b", True), ("a", "b", False)])[0].weight == 2


def _analysis(files: list[tuple[str, bool]], edges: list[tuple[str, str]]) -> Analysis:
    return Analysis(
        repo_path="/tmp/x",
        repo_name="x",
        generated_at=datetime.now(UTC),
        files=[
            FileNode(path=path, language="typescript", is_test=is_test, lines=1, bytes=1)
            for path, is_test in files
        ],
        edges=collapse_edges([(source, target, False) for source, target in edges]),
        unresolved=[],
        stats=AnalysisStats(
            files_scanned=len(files),
            files_parsed=len(files),
            files_skipped=0,
            statements_found=len(edges),
            edges=len(edges),
            unresolved=0,
            assets=0,
            duration_ms=0,
        ),
        link_stats=LinkStats(
            links=0,
            keys_paired=0,
            keys_unpaired=0,
            dynamic_names=0,
            generic_names=0,
            unresolved_modules=0,
            problems=[],
        ),
    )


def test_tests_are_kept_in_the_artifact_and_filtered_at_view_time():
    """Toggling include_tests must never need a re-analysis."""
    analysis = _analysis([("a.ts", False), ("a.test.ts", True)], [("a.test.ts", "a.ts")])
    assert len(analysis.files) == 2
    assert build_view(analysis).stats.visible_files == 1
    assert build_view(analysis, include_tests=True).stats.visible_files == 2


def test_excluding_a_file_repartitions_what_remains():
    """The reason clustering runs per request rather than once (ADR-0002)."""
    files = [(f"{group}/{n}.ts", False) for group in ("left", "right") for n in range(4)]
    edges = [
        (f"{g}/{i}.ts", f"{g}/{j}.ts")
        for g in ("left", "right")
        for i in range(4)
        for j in range(4)
        if i != j
    ]
    edges.append(("left/0.ts", "bridge.ts"))
    edges.append(("right/0.ts", "bridge.ts"))
    files.append(("bridge.ts", False))
    analysis = _analysis(files, edges)

    whole = build_view(analysis)
    without_bridge = build_view(analysis, excluded=frozenset({"bridge.ts"}))

    assert without_bridge.stats.visible_files == whole.stats.visible_files - 1
    assert all(node.path != "bridge.ts" for node in without_bridge.nodes)
    assert all("bridge.ts" not in (e.source, e.target) for e in without_bridge.edges)


def test_files_with_no_imports_land_in_their_own_cluster():
    analysis = _analysis(
        [("a.ts", False), ("b.ts", False), ("lonely.ts", False)], [("a.ts", "b.ts")]
    )
    view = build_view(analysis)
    lonely = next(node for node in view.nodes if node.path == "lonely.ts")
    cluster = next(c for c in view.clusters if c.id == lonely.cluster)
    assert "no imports" in cluster.label
