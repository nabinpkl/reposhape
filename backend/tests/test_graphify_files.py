"""graphify's renderer over file-level data."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from reposhape import graphify_files
from reposhape.api import app
from reposhape.graphify_files import GraphifyFilesError


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def analysed(client: TestClient, sample_repo: Path) -> str:
    (sample_repo / "extra.py").write_text("import os\n", encoding="utf-8")
    response = client.post("/api/analyze", json={"repo_path": str(sample_repo)})
    assert response.status_code == 200
    return response.json()["key"]


def test_synth_is_file_nodes_with_import_links_and_communities(tmp_path: Path, analysed: str):
    from reposhape import cache

    analysis = cache.find(analysed)
    assert analysis is not None
    root = tmp_path / "synth"
    graphify_files._synth(analysis, root)

    raw = json.loads((root / "graph.json").read_text(encoding="utf-8"))
    assert {node["id"] for node in raw["nodes"]} == {node.path for node in analysis.files}
    # Every node carries its own file: no symbols, no package names.
    assert all(node["source_file"] == node["id"] for node in raw["nodes"])
    assert all(link["relation"] == "imports" for link in raw["links"])
    assert all(link["_src"] == link["source"] for link in raw["links"])
    assert {node["id"] for node in raw["nodes"] if "community" in node} == {
        node.path for node in analysis.files
    }

    labels = json.loads((root / "labels.json").read_text(encoding="utf-8"))
    assert set(labels) == {str(i) for i in range(len(labels))}


def test_a_bad_key_is_rejected(tmp_path: Path):
    with pytest.raises(GraphifyFilesError, match="not a cache key"):
        graphify_files.workdir("../escape")


def test_files_status_reports_the_binary(client: TestClient, analysed: str):
    body = client.get(f"/api/graphify-files-status/{analysed}").json()
    # The binary exists wherever this suite runs; the shape is the assertion.
    assert set(body) == {"ready", "reason"}
    assert body["ready"] is True


def test_files_page_builds_through_graphifys_exporter(client: TestClient, analysed: str):
    response = client.get(f"/api/graphify-files/{analysed}")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    # graphify's own renderer, not ours: vis-network with its physics block.
    assert "vis-network" in response.text
    assert "forceAtlas2Based" in response.text
    # File-level throughout: repo paths in, no symbol ids.
    assert "web/src/main.ts" in response.text


def test_second_serve_reuses_the_built_page(client: TestClient, analysed: str):
    first = client.get(f"/api/graphify-files/{analysed}")
    assert first.status_code == 200
    from reposhape import cache

    analysis = cache.find(analysed)
    assert analysis is not None
    page = graphify_files.page_path(analysed)
    assert graphify_files.ensure(analysed, analysis) == page


def test_unknown_key_is_a_404(client: TestClient):
    assert client.get("/api/graphify-files/not-a-real-key").status_code == 404


def _embedded_ids(body: str) -> tuple[set[str], list[tuple[str, str]]]:
    """The page's own data, as its renderer receives it."""
    nodes_raw, _, _ = _payload(body, "RAW_NODES")
    edges_raw, _, _ = _payload(body, "RAW_EDGES")
    return (
        {node["id"] for node in nodes_raw},
        [(edge["from"], edge["to"]) for edge in edges_raw],
    )


def _payload(body: str, name: str):
    marker = f"const {name} = "
    start = body.index(marker) + len(marker)
    value, end = json.JSONDecoder().raw_decode(body[start:])
    return value, start, start + end


def _stats(body: str) -> str:
    marker = '<div id="stats">'
    start = body.index(marker) + len(marker)
    return body[start : body.index("</div>", start)]


def test_default_shape_hides_tests_like_ours(client: TestClient, analysed: str):
    body = client.get(f"/api/graphify-files/{analysed}").text
    ids, pairs = _embedded_ids(body)
    assert "web/src/main.test.ts" not in ids
    assert "web/src/main.ts" in ids
    nodes_n, edges_n, communities_n = (
        int(part.split(" ")[0]) for part in _stats(body).split(" &middot; ")
    )
    assert (nodes_n, edges_n) == (len(ids), len(pairs))
    assert communities_n >= 1


def test_include_tests_shows_the_test_file(client: TestClient, analysed: str):
    body = client.get(f"/api/graphify-files/{analysed}?include_tests=true").text
    ids, _ = _embedded_ids(body)
    assert "web/src/main.test.ts" in ids


def test_excluding_type_only_drops_the_type_edge(client: TestClient, analysed: str):
    full = client.get(f"/api/graphify-files/{analysed}").text
    _, full_pairs = _embedded_ids(full)
    assert ("web/src/main.ts", "web/src/shape.ts") in full_pairs

    body = client.get(f"/api/graphify-files/{analysed}?include_type_only=false").text
    _, pairs = _embedded_ids(body)
    assert ("web/src/main.ts", "web/src/shape.ts") not in pairs
    # The value import on the same file survives: only the type edge goes.
    assert ("web/src/main.ts", "web/src/lib/helper.ts") in pairs


def test_exclude_path_and_extension_trim_nodes_and_edges(client: TestClient, analysed: str):
    body = client.get(f"/api/graphify-files/{analysed}?exclude=web/src").text
    ids, pairs = _embedded_ids(body)
    assert ids and all(not path.startswith("web/src/") for path in ids)
    assert all(
        not source.startswith("web/src/") and not target.startswith("web/src/")
        for source, target in pairs
    )

    body = client.get(f"/api/graphify-files/{analysed}?exclude_ext=ts").text
    ids, _ = _embedded_ids(body)
    assert ids and all(not path.endswith(".ts") for path in ids)
    assert "service/app.py" in ids
