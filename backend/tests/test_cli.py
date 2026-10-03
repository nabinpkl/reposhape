"""The terminal half of the cache's write side."""

import importlib.metadata
import shutil
import sys
from pathlib import Path

import pytest
from typer.testing import CliRunner

from reposhape import cache
from reposhape.analysis import analyze
from reposhape.cli import app

runner = CliRunner()


def test_forget_removes_every_source_and_prints_what_went(sample_repo: Path):
    imports = analyze(sample_repo)
    cache.write(imports)
    cache.write(imports.model_copy(update={"source": "graphify-imports"}))

    result = runner.invoke(app, ["forget", str(sample_repo)])

    assert result.exit_code == 0, result.output
    assert sorted(result.stdout.split()) == sorted(
        [
            "forgot",
            cache.repo_key(sample_repo),
            "forgot",
            cache.repo_key(sample_repo, "graphify-imports"),
        ]
    )
    assert cache.summaries() == []


def test_forget_finds_a_repo_cached_only_under_another_source(sample_repo: Path):
    cache.write(analyze(sample_repo).model_copy(update={"source": "graphify-all"}))
    result = runner.invoke(app, ["forget", str(sample_repo)])
    assert result.exit_code == 0, result.output
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
    key = cache.repo_key(sample_repo.resolve(), "imports")
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
