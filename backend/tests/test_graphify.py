"""Projecting graphify's symbol graph onto files."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from reposhape import graphify
from reposhape.graphify import GraphifyArtifactError


def write_artifact(repo: Path, payload: dict[str, object]) -> None:
    target = graphify.artifact_path(repo)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload), encoding="utf-8")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    write_artifact(
        root,
        {
            "nodes": [
                {"id": "a1", "source_file": "src/a.ts"},
                {"id": "a2", "source_file": "src/a.ts"},
                {"id": "b1", "source_file": "src/b.ts"},
                {"id": "s1", "source_file": "Sources/App.swift"},
                {"id": "ghost"},  # graphify emits nodes with no file
            ],
            "links": [
                {"source": "a1", "target": "b1", "relation": "imports"},
                {"source": "a2", "target": "b1", "relation": "imports_from"},
                # Same file at both ends: nothing to draw on a file graph.
                {"source": "a1", "target": "a2", "relation": "calls"},
                {"source": "b1", "target": "s1", "relation": "calls"},
                {"source": "b1", "target": "ghost", "relation": "imports"},
            ],
        },
    )
    return root


def test_import_relations_only(repo: Path):
    analysis = graphify.load(repo, "graphify-imports")
    assert analysis.source == "graphify-imports"
    assert [(edge.source, edge.target, edge.weight) for edge in analysis.edges] == [
        ("src/a.ts", "src/b.ts", 2)
    ]
    # The two statements collapsed into one edge, and the call edge is absent.
    assert {node.path for node in analysis.files} == {"src/a.ts", "src/b.ts"}


def test_all_relations_is_a_different_graph(repo: Path):
    analysis = graphify.load(repo, "graphify-all")
    assert {(edge.source, edge.target) for edge in analysis.edges} == {
        ("src/a.ts", "src/b.ts"),
        ("src/b.ts", "Sources/App.swift"),
    }


def test_a_language_this_tool_cannot_parse_is_still_a_node(repo: Path):
    analysis = graphify.load(repo, "graphify-all")
    swift = next(node for node in analysis.files if node.path.endswith(".swift"))
    assert swift.language == "other"


def test_symbols_with_no_file_are_counted_not_dropped(repo: Path):
    analysis = graphify.load(repo, "graphify-all")
    assert analysis.stats.files_skipped == 1


def test_a_repo_without_graphify_output_says_so(tmp_path: Path):
    with pytest.raises(GraphifyArtifactError, match=r"graphify-out/graph\.json"):
        graphify.load(tmp_path, "graphify-imports")


def test_the_two_sources_cache_separately(repo: Path):
    from reposhape import cache

    ours = cache.repo_key(repo)
    theirs = cache.repo_key(repo, "graphify-imports")
    assert ours != theirs
    assert theirs.endswith("-graphify-imports")


def test_a_non_graphify_source_is_a_programming_error(repo: Path):
    with pytest.raises(ValueError, match="not a graphify projection"):
        graphify.load(repo, "imports")


def test_scope_keeps_only_files_both_sides_see(repo: Path):
    scoped = graphify.load(repo, "graphify-all", scope=frozenset({"src/a.ts", "src/b.ts"}))
    assert {node.path for node in scoped.files} == {"src/a.ts", "src/b.ts"}
    assert {(edge.source, edge.target) for edge in scoped.edges} == {("src/a.ts", "src/b.ts")}


def test_scope_drops_edges_into_unseen_files(repo: Path):
    scoped = graphify.load(repo, "graphify-all", scope=frozenset({"src/b.ts"}))
    assert {node.path for node in scoped.files} == {"src/b.ts"}
    assert scoped.edges == []


def test_without_scope_everything_graphify_saw_stays(repo: Path):
    analysis = graphify.load(repo, "graphify-all")
    assert any(node.path.endswith(".swift") for node in analysis.files)


def test_ensure_scope_builds_and_caches_the_own_analysis(tmp_path: Path):
    root = tmp_path / "project"
    (root / "src").mkdir(parents=True)
    (root / "src" / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
    scope = graphify.ensure_scope(root)
    assert scope == frozenset({"src/a.ts"})
    # Second call reads the cache rather than re-analysing.
    assert graphify.ensure_scope(root) == scope
