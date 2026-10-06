"""The read side, over HTTP."""

import base64
import hashlib
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from reposhape import web_bundle
from reposhape.api import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(read_only=False))


@pytest.fixture
def public(client: TestClient, analysed: str) -> TestClient:
    """The read-only server, over the same cache the operator app just wrote."""
    return TestClient(create_app(read_only=True))


@pytest.fixture
def analysed(client: TestClient, sample_repo: Path) -> str:
    response = client.post("/api/analyze", json={"repo_path": str(sample_repo)})
    assert response.status_code == 200
    return response.json()["key"]


def test_analyze_then_list(client: TestClient, sample_repo: Path, analysed: str):
    rows = client.get("/api/repos").json()
    assert [row["repo_path"] for row in rows] == [str(sample_repo.resolve())]
    assert rows[0]["exists"] is True


def test_a_second_analyze_is_served_from_cache(client: TestClient, sample_repo: Path):
    first = client.post("/api/analyze", json={"repo_path": str(sample_repo)}).json()
    second = client.post("/api/analyze", json={"repo_path": str(sample_repo)}).json()
    assert first["from_cache"] is False
    assert second["from_cache"] is True
    assert (
        client.post("/api/analyze", json={"repo_path": str(sample_repo), "refresh": True}).json()[
            "from_cache"
        ]
        is False
    )


def test_graph_excludes_at_file_depth_and_reclusters(client: TestClient, analysed: str):
    whole = client.get(f"/api/graph/{analysed}").json()
    filtered = client.get(
        f"/api/graph/{analysed}", params={"exclude": ["web/src/lib/helper.ts"]}
    ).json()
    assert filtered["stats"]["visible_files"] == whole["stats"]["visible_files"] - 1
    assert all(node["path"] != "web/src/lib/helper.ts" for node in filtered["nodes"])


def test_file_contents_are_read_now_not_embedded(
    client: TestClient, sample_repo: Path, analysed: str
):
    before = client.get(f"/api/file/{analysed}", params={"path": "web/src/lib/helper.ts"}).json()
    assert "helper" in before["text"]

    (sample_repo / "web" / "src" / "lib" / "helper.ts").write_text(
        "export const helper = () => 99;\n"
    )
    after = client.get(f"/api/file/{analysed}", params={"path": "web/src/lib/helper.ts"}).json()
    assert "99" in after["text"], "contents must come from disk, not from the artifact"


def test_a_path_outside_the_analysis_is_refused(client: TestClient, analysed: str):
    """Membership in the analysis is the traversal guard."""
    for path in ("../../../etc/passwd", "/etc/passwd", "web/src/main.css"):
        assert client.get(f"/api/file/{analysed}", params={"path": path}).status_code == 404


def test_an_unknown_key_is_a_404(client: TestClient):
    assert client.get("/api/graph/not-a-real-key").status_code == 404
    assert client.get("/api/analysis/not-a-real-key").status_code == 404


def test_analyzing_a_missing_directory_is_a_400(client: TestClient, tmp_path: Path):
    response = client.post("/api/analyze", json={"repo_path": str(tmp_path / "nope")})
    assert response.status_code == 400


def test_folders_lists_directories_and_marks_what_is_analysed(
    client: TestClient, sample_repo: Path, analysed: str
):
    parent = sample_repo.parent.resolve()
    listed = client.get("/api/folders", params={"path": f"{parent}/"}).json()
    rows = {row["name"]: row for row in listed["entries"]}
    assert rows[sample_repo.name]["analysis_key"] == analysed
    assert listed["target"]["path"] == str(parent)


def test_browsing_a_path_that_cannot_exist_is_a_404(client: TestClient, tmp_path: Path):
    assert client.get("/api/folders", params={"path": f"{tmp_path}/nope/deeper"}).status_code == 404


def test_forgetting_a_repo_takes_it_out_of_the_picker(
    client: TestClient, analysed: str, isolated_cache: Path
):
    assert client.delete(f"/api/repos/{analysed}").json() == [analysed]
    assert client.get("/api/repos").json() == []
    assert not (isolated_cache / f"{analysed}.json").exists()
    assert client.delete(f"/api/repos/{analysed}").status_code == 404


def test_a_stale_artifact_can_still_be_forgotten(client: TestClient, isolated_cache: Path):
    """The picker cannot read it, which is exactly when it needs to go."""
    isolated_cache.mkdir(parents=True, exist_ok=True)
    (isolated_cache / "old-0123456789ab.json").write_text('{"schema_version": 1}')
    assert client.delete("/api/repos/old-0123456789ab").json() == ["old-0123456789ab"]


def test_a_stale_artifact_is_left_out_of_the_picker_rather_than_breaking_it(
    client: TestClient, analysed: str, isolated_cache: Path
):
    """One old file must not take every other repo off the list with it."""
    (isolated_cache / "old-0123456789ab.json").write_text('{"schema_version": 1}')
    response = client.get("/api/repos")
    assert response.status_code == 200
    assert [row["key"] for row in response.json()] == [analysed]


def test_forget_refuses_a_key_that_escapes_the_cache(isolated_cache: Path, tmp_path: Path):
    from reposhape import cache

    outside = tmp_path / "victim.json"
    outside.write_text("{}")
    assert cache.forget("../victim") == []
    assert cache.forget(".hidden") == []
    assert outside.exists()


def test_health_names_the_two_roots_separately(client: TestClient):
    """Analyses and checkouts do not share a root, and the API says both."""
    body = client.get("/api/health").json()
    assert body["read_only"] is False
    assert body["cache_root"] != body["clone_root"]


def test_cloning_then_analysing_is_two_calls(client: TestClient, origin_repo: Path):
    cloned = client.post("/api/clone", json={"url": f"file://{origin_repo}"})
    assert cloned.status_code == 200, cloned.text
    path = cloned.json()["path"]
    assert cloned.json()["already_present"] is False
    assert Path(path, "web", "src", "main.ts").is_file()

    analysed = client.post("/api/analyze", json={"repo_path": path})
    assert analysed.status_code == 200
    assert analysed.json()["summary"]["repo_path"] == path

    again = client.post("/api/clone", json={"url": f"file://{origin_repo}"})
    assert again.json() == {"path": path, "already_present": True}


def test_a_url_this_will_not_clone_is_a_400(client: TestClient):
    for url in ("ext::sh -c ls", "~/projects/thing", ""):
        response = client.post("/api/clone", json={"url": url})
        assert response.status_code == 400, url


def test_a_clone_git_refuses_is_a_502(client: TestClient, tmp_path: Path):
    """The URL was well formed and the fetch failed. Different fact, different code."""
    response = client.post("/api/clone", json={"url": f"file://{tmp_path}/nope"})
    assert response.status_code == 502
    assert response.json()["detail"]


def test_refreshing_a_clone_fetches_it_first(client: TestClient, origin_repo: Path, commit_to):
    path = client.post("/api/clone", json={"url": f"file://{origin_repo}"}).json()["path"]
    first = client.post("/api/analyze", json={"repo_path": path}).json()
    assert first["update"] is None, "an ordinary analysis never fetches"

    commit_to(origin_repo, "web/src/added.ts", "export const added = 1;\n")
    again = client.post("/api/analyze", json={"repo_path": path, "refresh": True}).json()

    assert again["update"]["outcome"] == "updated"
    assert again["summary"]["files"] == first["summary"]["files"] + 1


def test_refreshing_a_repo_this_tool_did_not_clone_reports_no_update(
    client: TestClient, sample_repo: Path
):
    body = client.post("/api/analyze", json={"repo_path": str(sample_repo), "refresh": True}).json()
    assert body["update"] is None


def test_a_fetch_that_fails_still_answers_with_an_analysis(client: TestClient, origin_repo: Path):
    """Offline is a reason to graph what is on disk, not a reason to refuse."""
    import shutil

    path = client.post("/api/clone", json={"url": f"file://{origin_repo}"}).json()["path"]
    shutil.rmtree(origin_repo)

    response = client.post("/api/analyze", json={"repo_path": path, "refresh": True})

    assert response.status_code == 200
    assert response.json()["update"]["outcome"] == "failed"
    assert response.json()["summary"]["files"] > 0


# The read-only server's whole surface, written out. A route added to the API
# lands on `reads` or `operator` by a decision, and this list is where that
# decision is checked: a new read route fails here until it is added, and a new
# write route that went on `reads` by accident fails here instead of reaching a
# public page. Only GETs, because nothing a visitor can do changes anything.
PUBLIC_ROUTES = {
    ("GET", "/api/health"),
    ("GET", "/api/repos"),
    ("GET", "/api/analysis/{key}"),
    ("GET", "/api/paths/{key}"),
    ("GET", "/api/graph/{key}"),
    ("GET", "/api/graphify-status/{key}"),
    ("GET", "/api/graphify-page/{key}"),
    ("GET", "/api/file/{key}"),
    ("GET", "/api/license/{key}"),
    ("GET", "/api/links/{key}"),
}


def _api_routes(read_only: bool) -> set[tuple[str, str]]:
    """Every operation the app serves, as its OpenAPI schema states them.

    Read from the schema rather than from `app.routes`, which nests included
    routers differently across FastAPI versions: the schema is the surface a
    client can actually call.
    """
    paths = create_app(read_only=read_only).openapi()["paths"]
    return {(method.upper(), path) for path, operations in paths.items() for method in operations}


def test_the_read_only_server_has_exactly_the_public_routes():
    assert _api_routes(read_only=True) == PUBLIC_ROUTES


def test_the_operator_routes_exist_only_on_the_personal_server():
    operator = _api_routes(read_only=False) - PUBLIC_ROUTES
    assert operator == {
        ("DELETE", "/api/repos/{key}"),
        ("GET", "/api/folders"),
        ("POST", "/api/clone"),
        ("POST", "/api/analyze"),
    }


def test_a_visitor_cannot_act_on_the_host(public: TestClient, analysed: str, sample_repo: Path):
    """Not refused but absent: each answers as a path that was never there."""
    attempts = [
        public.get("/api/folders", params={"path": "/"}),
        public.post("/api/clone", json={"url": "https://example.com/x.git"}),
        public.post("/api/analyze", json={"repo_path": str(sample_repo), "refresh": True}),
        public.delete(f"/api/repos/{analysed}"),
    ]
    assert all(response.status_code in (404, 405) for response in attempts), [
        (response.request.method, response.request.url.path, response.status_code)
        for response in attempts
    ]
    assert [row["key"] for row in public.get("/api/repos").json()] == [analysed]


def test_a_visitor_can_read_what_the_operator_analysed(public: TestClient, analysed: str):
    assert public.get(f"/api/graph/{analysed}").status_code == 200
    contents = public.get(f"/api/file/{analysed}", params={"path": "web/src/main.ts"})
    assert contents.status_code == 200
    assert "helper" in contents.json()["text"]


def test_the_read_only_server_says_so_and_names_no_host_paths(public: TestClient):
    assert public.get("/api/health").json() == {
        "status": "ok",
        "read_only": True,
        "cache_root": None,
        "clone_root": None,
        "pid": None,
        "build": None,
    }


def test_every_response_carries_the_security_headers(client: TestClient):
    response = client.get("/api/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-frame-options"] == "DENY"


def test_the_page_runs_only_scripts_this_origin_shipped(client: TestClient):
    policy = client.get("/api/health").headers["content-security-policy"]
    directives = dict(part.split(" ", 1) for part in policy.split("; "))
    assert directives["script-src"].startswith("'self'")
    assert "'unsafe-inline'" not in directives["script-src"]
    assert "unsafe-eval" not in policy  # 'wasm-unsafe-eval' included
    assert directives["frame-ancestors"] == "'none'"
    assert directives["object-src"] == "'none'"


def test_inline_scripts_are_allowed_by_the_hash_of_the_bundle_itself(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Read from the pages being served, so the policy cannot describe other pages."""
    (tmp_path / "nested").mkdir()
    (tmp_path / "index.html").write_text(
        '<script src="/_next/a.js" async=""></script><script>self.__next_f.push([1])</script>'
    )
    (tmp_path / "nested" / "index.html").write_text("<script>self.__next_f.push([2])</script>")
    monkeypatch.setattr(web_bundle, "BUNDLE_DIR", tmp_path)

    def token(body: str) -> str:
        digest = hashlib.sha256(body.encode()).digest()
        return f"'sha256-{base64.b64encode(digest).decode()}'"

    assert web_bundle.inline_script_hashes() == sorted(
        [token("self.__next_f.push([1])"), token("self.__next_f.push([2])")]
    )
    policy = TestClient(create_app(read_only=True)).get("/api/health").headers
    assert token("self.__next_f.push([1])") in policy["content-security-policy"]


def _host_secret(tmp_path: Path) -> Path:
    """A file outside every repo, standing in for ~/.ssh/id_rsa."""
    secret = tmp_path / "outside" / "id_rsa"
    secret.parent.mkdir()
    secret.write_text("HOST-SECRET\n")
    return secret


def test_a_symlink_out_of_the_repo_is_never_scanned(
    client: TestClient, sample_repo: Path, tmp_path: Path
):
    """git lists a committed symlink like any file, and git checks it out as a link."""
    (sample_repo / "service" / "leak.py").symlink_to(_host_secret(tmp_path))
    subprocess.run(["git", "init", "-q", str(sample_repo)], check=True)
    key = client.post("/api/analyze", json={"repo_path": str(sample_repo)}).json()["key"]
    assert "service/leak.py" not in client.get(f"/api/paths/{key}").json()["paths"]
    response = client.get(f"/api/file/{key}", params={"path": "service/leak.py"})
    assert response.status_code == 404
    assert "HOST-SECRET" not in response.text


def test_a_symlink_a_pull_added_after_the_analysis_is_refused_when_read(
    public: TestClient, sample_repo: Path, analysed: str, tmp_path: Path
):
    known = sample_repo / "service" / "util.py"
    known.unlink()
    known.symlink_to(_host_secret(tmp_path))
    response = public.get(f"/api/file/{analysed}", params={"path": "service/util.py"})
    assert response.status_code == 404
    assert "HOST-SECRET" not in response.text


def test_a_license_that_links_out_of_the_repo_is_not_served(
    public: TestClient, sample_repo: Path, analysed: str, tmp_path: Path
):
    (sample_repo / "LICENSE").symlink_to(_host_secret(tmp_path))
    found = public.get(f"/api/license/{analysed}", params={"path": "service/util.py"}).json()
    assert found["path"] is None
    assert "HOST-SECRET" not in found["text"]


def test_a_symbol_graph_page_that_links_out_of_the_repo_is_not_served(
    public: TestClient, sample_repo: Path, analysed: str, tmp_path: Path
):
    (sample_repo / "graphify-out").mkdir()
    (sample_repo / "graphify-out" / "graph.html").symlink_to(_host_secret(tmp_path))
    assert public.get(f"/api/graphify-status/{analysed}").json()["ready"] is False
    response = public.get(f"/api/graphify-page/{analysed}")
    assert response.status_code == 404
    assert "HOST-SECRET" not in response.text


def test_a_symbol_graph_page_is_sandboxed_however_it_is_opened(
    public: TestClient, sample_repo: Path, analysed: str
):
    """A cloned repo can commit graphify-out/graph.html with any script in it."""
    (sample_repo / "graphify-out").mkdir()
    (sample_repo / "graphify-out" / "graph.html").write_text("<script>fetch('/api/repos')</script>")
    response = public.get(f"/api/graphify-page/{analysed}")
    assert response.status_code == 200
    assert response.headers["content-security-policy"] == "sandbox allow-scripts"
    assert response.headers["x-frame-options"] == "SAMEORIGIN"


def test_a_reanalysis_is_not_answered_from_the_old_partition(
    client: TestClient, sample_repo: Path, analysed: str
):
    """The graph is memoised per artifact version, so a refresh must miss it."""
    before = client.get(f"/api/graph/{analysed}").json()
    (sample_repo / "web" / "src" / "extra.ts").write_text('import { run } from "./main";\n')
    client.post("/api/analyze", json={"repo_path": str(sample_repo), "refresh": True})
    after = client.get(f"/api/graph/{analysed}").json()
    assert len(after["nodes"]) == len(before["nodes"]) + 1


def test_the_license_names_itself_and_its_holder(
    client: TestClient, sample_repo: Path, analysed: str
):
    (sample_repo / "LICENSE").write_text(
        "MIT License\n\nCopyright (c) 2024 Example Org\n\n"
        "Permission is hereby granted, free of charge, to any person obtaining a copy\n"
    )
    body = client.get(f"/api/license/{analysed}").json()
    assert body["path"] == "LICENSE"
    assert body["name"] == "MIT"
    assert body["copyright"] == ["Copyright (c) 2024 Example Org"]
    assert "free of charge" in body["text"]


def test_a_repo_without_a_license_says_so(public: TestClient, analysed: str):
    """Read on the public app too: the notice is part of what a visitor may see."""
    body = public.get(f"/api/license/{analysed}").json()
    assert body == {
        "path": None,
        "name": None,
        "copyright": [],
        "text": "",
        "truncated": False,
        "notice_path": None,
        "notice_text": "",
        "notice_truncated": False,
    }


def test_the_license_is_resolved_for_a_file_and_guarded_like_one(
    client: TestClient, sample_repo: Path, analysed: str
):
    (sample_repo / "LICENSE").write_text("Copyright (c) 2024 Root\n")
    (sample_repo / "service" / "LICENSE").write_text("Copyright (c) 2024 Service Team\n")
    near = client.get(f"/api/license/{analysed}", params={"path": "service/util.py"}).json()
    assert near["path"] == "service/LICENSE"
    assert near["copyright"] == ["Copyright (c) 2024 Service Team"]

    outside = client.get(f"/api/license/{analysed}", params={"path": "../../etc/passwd"})
    assert outside.status_code == 404


def test_a_rebound_host_is_refused_before_any_route(client: TestClient):
    """DNS rebinding: an attacker's name pointed at 127.0.0.1 still sends that name."""
    response = client.get("/api/folders", params={"path": "/"}, headers={"host": "evil.example"})
    assert response.status_code == 400
    assert client.get("/api/health", headers={"host": "localhost:7420"}).status_code == 200


@pytest.mark.parametrize("fetched_by", ["cross-site", "same-site"])
def test_another_sites_page_cannot_call_the_api(client: TestClient, fetched_by: str):
    """Same-site too: a page on another localhost port is not this page."""
    response = client.get("/api/health", headers={"sec-fetch-site": fetched_by})
    assert response.status_code == 403
    assert client.get("/api/health", headers={"sec-fetch-site": "same-origin"}).status_code == 200


def test_a_link_from_another_site_still_opens_the_page(client: TestClient):
    """Only /api is guarded by origin: a navigation is not a request on the owner's behalf."""
    response = client.get("/no-such-page", headers={"sec-fetch-site": "cross-site"})
    assert response.status_code != 403
