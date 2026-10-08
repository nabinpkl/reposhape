"""The terminal half of the cache's write side."""

import importlib.metadata
import json
import shutil
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

from reposhape import cache
from reposhape.analysis import analyze
from reposhape.cli import app
from reposhape.graphing import build_view

runner = CliRunner()


def test_forget_removes_the_analysis_and_prints_what_went(sample_repo: Path):
    cache.write(analyze(sample_repo))

    result = runner.invoke(app, ["forget", str(sample_repo)])

    assert result.exit_code == 0, result.output
    assert result.stdout.split() == ["forgot", cache.repo_key(sample_repo)]
    assert cache.summaries() == []


def test_forget_works_on_a_repo_that_is_gone_from_disk(sample_repo: Path):
    """The deleted checkout is exactly the one whose rows are left behind."""
    cache.write(analyze(sample_repo))
    shutil.rmtree(sample_repo)
    result = runner.invoke(app, ["forget", str(sample_repo)])
    assert result.exit_code == 0, result.output
    assert cache.summaries() == []


def test_forgetting_what_was_never_cached_fails_loudly(tmp_path: Path):
    result = runner.invoke(app, ["forget", str(tmp_path / "never")])
    assert result.exit_code == 1
    assert "no cached analysis" in result.stderr


def test_clone_puts_a_checkout_under_the_clone_root_and_analyses_it(
    origin_repo: Path, isolated_clones: Path
):
    result = runner.invoke(app, ["clone", f"file://{origin_repo}"])

    assert result.exit_code == 0, result.output
    cloned = Path(result.stdout.strip())
    assert cloned.is_relative_to(isolated_clones.resolve())
    assert (cloned / "web" / "src" / "main.ts").is_file()
    assert [row.repo_path for row in cache.summaries()] == [str(cloned)]


def test_clone_reports_a_url_git_cannot_fetch(tmp_path: Path):
    result = runner.invoke(app, ["clone", f"file://{tmp_path}/nope"])
    assert result.exit_code == 1
    assert "error:" in result.stderr


def test_analyze_repo_points_a_url_at_clone(tmp_path: Path):
    result = runner.invoke(app, ["analyze-repo", "https://github.com/owner/repo"])
    assert result.exit_code == 1
    assert "reposhape clone" in result.stderr


def test_cloning_a_repo_that_is_already_here_picks_up_new_commits(origin_repo: Path, commit_to):
    """Asking for a URL is asking for that repository now."""
    first = runner.invoke(app, ["clone", f"file://{origin_repo}"])
    assert first.exit_code == 0, first.output
    cloned = Path(first.stdout.strip())

    commit_to(origin_repo, "web/src/added.ts", "export const added = 1;\n")
    second = runner.invoke(app, ["clone", f"file://{origin_repo}"])

    assert second.exit_code == 0, second.output
    assert "fetched: now at" in second.stderr
    assert (cloned / "web" / "src" / "added.ts").is_file()


def test_up_refuses_to_start_without_a_browser_client(
    sample_repo: Path, tmp_path: Path, monkeypatch
):
    """An API with no page in front of it is not the tool; say how to build one."""
    from reposhape import web_bundle

    monkeypatch.setattr(web_bundle, "BUNDLE_DIR", tmp_path / "no-bundle")
    result = runner.invoke(app, ["up", str(sample_repo), "--no-open"])
    assert result.exit_code == 1
    assert "just web-export" in result.output


def _with_a_page_and_a_server(monkeypatch, tmp_path: Path) -> list[tuple[str, int]]:
    """A built page, and a stand-in for the background server; returns what it was asked for.

    The server itself is exercised with real processes in test_daemon.py. Here
    the question is only what `reposhape up` does around it.
    """
    from reposhape import daemon, web_bundle

    bundle = tmp_path / "web"
    bundle.mkdir()
    (bundle / "index.html").write_text("<p>page</p>")
    monkeypatch.setattr(web_bundle, "BUNDLE_DIR", bundle)
    monkeypatch.setattr(web_bundle, "staleness", lambda: None)
    asked: list[tuple[str, int]] = []

    def ensure(host: str, port: int) -> str:
        asked.append((host, port))
        return f"http://{host}:{port}"

    monkeypatch.setattr(daemon, "ensure", ensure)
    return asked


def test_up_without_a_repo_opens_the_picker_and_analyses_nothing(monkeypatch, tmp_path: Path):
    asked = _with_a_page_and_a_server(monkeypatch, tmp_path)
    result = runner.invoke(app, ["up", "--no-open"])
    assert result.exit_code == 0, result.output
    assert asked == [("127.0.0.1", 7420)]
    assert "open  http://127.0.0.1:7420/\n" in result.stdout
    assert "repo  " not in result.stdout
    assert cache.summaries() == []


def test_up_with_a_repo_analyses_it_and_opens_its_graph(
    sample_repo: Path, monkeypatch, tmp_path: Path
):
    _with_a_page_and_a_server(monkeypatch, tmp_path)
    result = runner.invoke(app, ["up", str(sample_repo), "--no-open", "--port", "7999"])
    assert result.exit_code == 0, result.output
    key = cache.repo_key(sample_repo.resolve())
    assert f"open  http://127.0.0.1:7999/?repo={key}" in result.stdout
    assert [row.repo_path for row in cache.summaries()] == [str(sample_repo.resolve())]


def test_status_and_down_say_when_nothing_is_running():
    assert runner.invoke(app, ["status"]).stdout == "stopped\n"
    assert runner.invoke(app, ["down"]).stdout == "no server was running\n"


def test_version_prints_the_installed_version():
    result = runner.invoke(app, ["--version"])
    assert result.exit_code == 0, result.output
    assert result.stdout.strip() == f"reposhape {importlib.metadata.version('reposhape')}"


def test_windows_is_refused_by_name_before_any_command_runs(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(sys, "platform", "win32")
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 1
    assert "Windows is not supported" in result.stderr


def test_view_from_an_artifact_prints_the_default_view_as_json(sample_repo: Path, tmp_path: Path):
    """The page's first load, clusters and all, from a file the cache never saw."""
    artifact = tmp_path / "shape.json"
    written = runner.invoke(app, ["analyze-repo", str(sample_repo), "--out", str(artifact)])
    assert written.exit_code == 0, written.output

    result = runner.invoke(app, ["view", "--from", str(artifact), "--json"])

    assert result.exit_code == 0, result.output
    expected = build_view(cache.read(artifact)).model_dump(mode="json")
    assert json.loads(result.stdout) == expected
    assert expected["clusters"]
    assert cache.summaries() == []


def test_view_from_an_artifact_prints_the_summary_without_json(sample_repo: Path, tmp_path: Path):
    artifact = tmp_path / "shape.json"
    cache.write_json_to(analyze(sample_repo), artifact)

    result = runner.invoke(app, ["view", "--from", str(artifact)])

    assert result.exit_code == 0, result.output
    assert " clusters\n" in result.stdout.splitlines(keepends=True)[0]


@pytest.mark.parametrize("args", [[], ["somewhere", "--from", "shape.json"]])
def test_view_takes_a_repo_or_an_artifact_and_exactly_one(args: list[str]):
    result = runner.invoke(app, ["view", *args])
    assert result.exit_code == 1
    assert "--from" in result.stderr


def test_view_from_a_missing_or_unreadable_artifact_fails_loudly(tmp_path: Path):
    missing = runner.invoke(app, ["view", "--from", str(tmp_path / "nope.json"), "--json"])
    assert missing.exit_code == 1
    assert "error:" in missing.stderr and missing.stdout == ""

    garbage = tmp_path / "garbage.json"
    garbage.write_text("{}", encoding="utf-8")
    unreadable = runner.invoke(app, ["view", "--from", str(garbage), "--json"])
    assert unreadable.exit_code == 1
    assert "error:" in unreadable.stderr and unreadable.stdout == ""
