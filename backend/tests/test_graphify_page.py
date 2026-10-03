"""graphify's own page: status, serving, and the pipeline behind it."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from reposhape import graphify_page
from reposhape.api import app
from reposhape.graphify_page import GraphifyPageError


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_status_without_any_graphify_output_says_what_builds_it(tmp_path: Path):
    ready, reason = graphify_page.status_of(tmp_path)
    assert ready is False
    assert reason is not None
    assert "reposhape graphify-page" in reason
    assert "graph.json" in reason


def test_status_with_extraction_but_no_page_names_the_page(tmp_path: Path):
    out = tmp_path / "graphify-out"
    out.mkdir()
    (out / "graph.json").write_text("{}", encoding="utf-8")
    ready, reason = graphify_page.status_of(tmp_path)
    assert ready is False
    assert reason is not None
    assert "graph.html" in reason


def test_status_ready_when_the_page_exists(tmp_path: Path):
    out = tmp_path / "graphify-out"
    out.mkdir()
    (out / "graph.html").write_text("<html></html>", encoding="utf-8")
    ready, reason = graphify_page.status_of(tmp_path)
    assert (ready, reason) == (True, None)


def test_ensure_without_the_binary_says_so(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(graphify_page, "binary", lambda: None)
    with pytest.raises(GraphifyPageError, match="not on PATH"):
        graphify_page.ensure(tmp_path)


def test_ensure_with_a_page_already_there_runs_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    out = tmp_path / "graphify-out"
    out.mkdir()
    page = out / "graph.html"
    page.write_text("<html></html>", encoding="utf-8")

    def fail(_argv: list[str], _repo: Path) -> None:
        raise AssertionError("no pipeline run needed")

    monkeypatch.setattr(graphify_page, "run", fail)
    assert graphify_page.ensure(tmp_path) == page


def _analysed_with_page(client: TestClient, repo: Path) -> str:
    repo.mkdir(parents=True, exist_ok=True)
    (repo / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
    response = client.post("/api/analyze", json={"repo_path": str(repo)})
    assert response.status_code == 200
    out = repo / "graphify-out"
    out.mkdir(exist_ok=True)
    (out / "graph.html").write_text("<html>graphify</html>", encoding="utf-8")
    return response.json()["key"]


def test_status_endpoint_reports_readiness(client: TestClient, tmp_path: Path):
    key = _analysed_with_page(client, tmp_path / "repo")
    body = client.get(f"/api/graphify-status/{key}").json()
    assert body == {"ready": True, "reason": None}


def test_page_endpoint_serves_the_file_verbatim(client: TestClient, tmp_path: Path):
    key = _analysed_with_page(client, tmp_path / "repo")
    response = client.get(f"/api/graphify-page/{key}")
    assert response.status_code == 200
    assert "graphify" in response.text
    assert "text/html" in response.headers["content-type"]


def test_page_endpoint_without_a_page_is_a_404_that_names_the_fix(
    client: TestClient, tmp_path: Path
):
    repo = tmp_path / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    (repo / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
    key = client.post("/api/analyze", json={"repo_path": str(repo)}).json()["key"]
    response = client.get(f"/api/graphify-page/{key}")
    assert response.status_code == 404
    assert "reposhape graphify-page" in response.json()["detail"]


def _git_repo(path: Path) -> Path:
    import subprocess

    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    return path


def test_extract_keeps_graphify_output_out_of_git_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    import subprocess

    repo = _git_repo(tmp_path / "repo")
    calls: list[list[str]] = []

    def fake_run(argv: list[str], repo_arg: Path, *, timeout: float = 600) -> None:
        calls.append(argv)
        out = repo_arg / "graphify-out"
        out.mkdir(exist_ok=True)
        (out / "graph.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(graphify_page, "binary", lambda: "/usr/bin/graphify")
    monkeypatch.setattr(graphify_page, "run", fake_run)

    assert graphify_page.extract(repo) == repo / "graphify-out" / "graph.json"
    graphify_page.extract(repo)

    assert calls == [["/usr/bin/graphify", "update", str(repo)]] * 2
    exclude = (repo / ".git" / "info" / "exclude").read_text(encoding="utf-8")
    assert exclude.splitlines().count("/graphify-out/") == 1
    status = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain"], capture_output=True, text=True
    )
    assert status.stdout == ""


def test_extract_that_writes_no_artifact_fails_loud(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(graphify_page, "binary", lambda: "/usr/bin/graphify")
    monkeypatch.setattr(graphify_page, "run", lambda *_a, **_k: None)
    with pytest.raises(GraphifyPageError, match="wrote no"):
        graphify_page.extract(tmp_path)


def test_read_only_status_names_no_host_path(tmp_path: Path):
    from reposhape.api import create_app

    repo = tmp_path / "repo"
    key = _analysed_with_page(TestClient(create_app(read_only=False)), repo)
    (repo / "graphify-out" / "graph.html").unlink()
    public = TestClient(create_app(read_only=True))
    body = public.get(f"/api/graphify-status/{key}").json()
    assert body["ready"] is False
    assert str(tmp_path) not in body["reason"]
    missing = public.get(f"/api/graphify-page/{key}")
    assert missing.status_code == 404
    assert str(tmp_path) not in missing.text
