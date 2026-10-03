"""Turning a git URL into a durable checkout.

Every clone here goes over `file://` to a repo the test made, so the suite
needs no network and touches no real remote. The `isolated_clones` fixture
points `clone_root` at tmp_path, so nothing lands in `~/.local/share`.
"""

from pathlib import Path

import pytest

from reposhape import cloning
from reposhape.cloning import CloneError, UnsupportedUrlError


@pytest.mark.parametrize(
    ("url", "host", "segments"),
    [
        ("https://github.com/owner/repo.git", "github.com", ("owner", "repo")),
        ("https://github.com/owner/repo", "github.com", ("owner", "repo")),
        ("git@github.com:owner/repo.git", "github.com", ("owner", "repo")),
        ("ssh://git@gitlab.com/group/sub/proj.git", "gitlab.com", ("group", "sub", "proj")),
        ("git://example.org/thing", "example.org", ("thing",)),
        ("https://GitHub.com/Owner/Repo/", "github.com", ("Owner", "Repo")),
        ("file:///srv/git/thing.git", "local", ("srv", "git", "thing")),
    ],
)
def test_a_url_names_a_host_and_a_repo(url: str, host: str, segments: tuple[str, ...]):
    remote = cloning.parse(url)
    assert (remote.host, remote.segments) == (host, segments)
    assert remote.name == segments[-1]


def test_the_destination_is_host_then_owner_then_name(isolated_clones: Path):
    target = cloning.destination(cloning.parse("git@github.com:owner/repo.git"))
    assert target == isolated_clones.resolve() / "github.com" / "owner" / "repo"


def test_two_hosts_with_one_repo_name_are_two_directories():
    first = cloning.destination(cloning.parse("https://github.com/o/repo"))
    second = cloning.destination(cloning.parse("https://gitlab.com/o/repo"))
    assert first != second


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "~/projects/thing",
        "/Users/someone/thing",
        "./thing",
        "ext::sh -c 'touch /tmp/pwned'",
        "https://github.com",
    ],
)
def test_what_will_not_be_cloned_says_so(url: str):
    """A transport that runs a command is the reason this is an allowlist."""
    with pytest.raises(UnsupportedUrlError):
        cloning.parse(url)


def test_a_transport_helper_url_never_reaches_git(tmp_path: Path):
    """`ext::<command>` is a transport that RUNS the command.

    Caught by `parse`, so the string never becomes an argument to `git clone`.
    The marker file is the assertion: refusing it after git has run is not
    refusing it.
    """
    marker = tmp_path / "pwned"
    with pytest.raises(UnsupportedUrlError):
        cloning.clone(f"ext::sh -c 'touch {marker}'")
    assert not marker.exists()


def test_a_url_cannot_climb_out_of_the_clone_root(isolated_clones: Path):
    target = cloning.destination(cloning.parse("https://host/../../../etc/passwd"))
    assert target.is_relative_to(isolated_clones.resolve())


def test_looks_remote_routes_urls_and_leaves_paths_alone():
    assert cloning.looks_remote("https://github.com/o/r")
    assert cloning.looks_remote("git@github.com:o/r.git")
    assert not cloning.looks_remote("~/projects/thing")
    assert not cloning.looks_remote("/Users/someone/thing")
    assert not cloning.looks_remote("")


def test_a_clone_lands_under_the_clone_root_with_its_files(
    origin_repo: Path, isolated_clones: Path
):
    result = cloning.clone(f"file://{origin_repo}")

    assert result.already_present is False
    assert result.path.is_relative_to(isolated_clones.resolve())
    assert (result.path / ".git").is_dir()
    assert (result.path / "web" / "src" / "main.ts").is_file()


def test_a_second_clone_reuses_the_checkout_and_does_not_reset_it(origin_repo: Path):
    first = cloning.clone(f"file://{origin_repo}")
    edited = first.path / "web" / "src" / "main.ts"
    edited.write_text("// a working tree this tool does not own\n")

    second = cloning.clone(f"file://{origin_repo}")

    assert (second.path, second.already_present) == (first.path, True)
    assert edited.read_text().startswith("// a working tree")


def test_a_clone_that_fails_leaves_nothing_behind(isolated_clones: Path, tmp_path: Path):
    with pytest.raises(CloneError):
        cloning.clone(f"file://{tmp_path}/no-such-repo")

    partials = list(isolated_clones.rglob(".partial-*")) if isolated_clones.exists() else []
    assert partials == [], "an interrupted clone must not be findable as a complete one"


def test_a_non_checkout_sitting_in_the_way_is_reported(origin_repo: Path):
    target = cloning.destination(cloning.parse(f"file://{origin_repo}"))
    target.mkdir(parents=True)
    (target / "something.txt").write_text("not a checkout")

    with pytest.raises(CloneError, match="not a git checkout"):
        cloning.clone(f"file://{origin_repo}")


def test_nothing_here_deletes_a_checkout(origin_repo: Path, isolated_clones: Path):
    """ADR-0007: forget clears the cache, and the clone it read is still there."""
    from reposhape import cache
    from reposhape.analysis import analyze

    cloned = cloning.clone(f"file://{origin_repo}").path
    cache.write(analyze(cloned))
    key = cache.key_for(cloned)
    assert key is not None

    assert cache.forget(key) == [key]
    assert (cloned / ".git").is_dir()
    assert (cloned / "web" / "src" / "main.ts").is_file()


def _head(repo: Path) -> str:
    import subprocess

    return subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _commits(repo: Path) -> int:
    import subprocess

    return int(
        subprocess.run(
            ["git", "-C", str(repo), "rev-list", "--count", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    )


def test_a_refresh_brings_a_clone_up_to_its_remote(origin_repo: Path, commit_to):
    cloned = cloning.clone(f"file://{origin_repo}").path
    commit_to(origin_repo, "web/src/added.ts", "export const added = 1;\n")

    result = cloning.update(cloned)

    assert result is not None
    assert (result.outcome, result.sha) == ("updated", _head(origin_repo))
    assert (cloned / "web" / "src" / "added.ts").is_file()
    assert _commits(cloned) == 1, "an updated clone is still shallow"


def test_a_clone_already_at_its_remote_says_so(origin_repo: Path):
    cloned = cloning.clone(f"file://{origin_repo}").path
    result = cloning.update(cloned)
    assert result is not None
    assert result.outcome == "current"


def test_a_repo_this_tool_did_not_clone_is_never_fetched(origin_repo: Path):
    """The owner's own repositories are not this tool's to move."""
    assert cloning.owns(origin_repo) is False
    assert cloning.update(origin_repo) is None


def test_local_changes_stop_the_fetch_and_survive_it(origin_repo: Path, commit_to):
    cloned = cloning.clone(f"file://{origin_repo}").path
    edited = cloned / "web" / "src" / "main.ts"
    edited.write_text("// mine\n")
    commit_to(origin_repo, "web/src/added.ts", "export const added = 1;\n")

    result = cloning.update(cloned)

    assert result is not None
    assert result.outcome == "left_alone"
    assert edited.read_text() == "// mine\n"
    assert not (cloned / "web" / "src" / "added.ts").exists()


def test_an_untracked_file_does_not_stop_the_fetch(origin_repo: Path, commit_to):
    """`.reposhapeignore` is exactly this case: this tool asks for it to be there."""
    cloned = cloning.clone(f"file://{origin_repo}").path
    scope = cloned / ".reposhapeignore"
    scope.write_text("docs/\n")
    commit_to(origin_repo, "web/src/added.ts", "export const added = 1;\n")

    result = cloning.update(cloned)

    assert result is not None
    assert result.outcome == "updated"
    assert (cloned / "web" / "src" / "added.ts").is_file()
    assert scope.read_text() == "docs/\n", "a reset must not take the scope file with it"


def test_a_checkout_pinned_off_its_branch_is_left_alone(origin_repo: Path):
    import subprocess

    cloned = cloning.clone(f"file://{origin_repo}").path
    subprocess.run(
        ["git", "-C", str(cloned), "checkout", "--detach", "HEAD"],
        check=True,
        capture_output=True,
    )
    result = cloning.update(cloned)
    assert result is not None
    assert result.outcome == "left_alone"


def test_a_remote_that_has_gone_away_is_reported_rather_than_raised(origin_repo: Path):
    import shutil

    cloned = cloning.clone(f"file://{origin_repo}").path
    shutil.rmtree(origin_repo)

    result = cloning.update(cloned)

    assert result is not None
    assert result.outcome == "failed"
    assert result.detail
    assert (cloned / "web" / "src" / "main.ts").is_file(), "the checkout is still usable"
