"""The folder picker's read path: directories only, shell-style completion."""

import os
from pathlib import Path

import pytest

from reposhape import browsing, cache
from reposhape.browsing import NoSuchDirectoryError, UnreadableDirectoryError
from reposhape.configuration import settings


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    root = tmp_path / "work"
    for name in ("projects", "projects-old", "Pictures", "node_modules", ".config"):
        (root / name).mkdir(parents=True)
    (root / "notes.md").write_text("not a directory\n")
    (root / "projects" / ".git").mkdir()
    return root.resolve()


def _names(path: str) -> list[str]:
    return [entry.name for entry in browsing.listing(path).entries]


def test_a_trailing_separator_lists_that_directory(tree: Path):
    assert _names(f"{tree}{os.sep}") == ["Pictures", "projects", "projects-old"]


def test_files_are_never_listed(tree: Path):
    assert "notes.md" not in _names(f"{tree}{os.sep}")


def test_no_separator_completes_against_the_parent(tree: Path):
    """Half a name is a prefix, not a missing directory."""
    listed = browsing.listing(str(tree / "pro"))
    assert listed.prefix == "pro"
    assert listed.directory == str(tree)
    assert [entry.name for entry in listed.entries] == ["projects", "projects-old"]


def test_completion_ignores_case(tree: Path):
    assert _names(str(tree / "pic")) == ["Pictures"]


def test_build_output_and_dot_directories_stay_hidden_until_asked_for(tree: Path):
    assert _names(f"{tree}{os.sep}") == ["Pictures", "projects", "projects-old"]
    # Built as a string: `Path(tree, ".")` normalises the dot away before the
    # request is made, which is the same trap `_split` avoids on the server.
    assert _names(f"{tree}{os.sep}.") == [".config"]


def test_a_git_directory_is_marked(tree: Path):
    entries = {entry.name: entry for entry in browsing.listing(f"{tree}{os.sep}").entries}
    assert entries["projects"].is_git is True
    assert entries["projects-old"].is_git is False


def test_an_analysed_folder_carries_its_key(sample_repo: Path):
    from reposhape.analysis import analyze

    cache.write(analyze(sample_repo))
    parent = sample_repo.parent.resolve()
    entries = {entry.name: entry for entry in browsing.listing(f"{parent}{os.sep}").entries}
    assert entries[sample_repo.name].analysis_key == cache.repo_key(sample_repo)


def test_the_typed_directory_is_the_target(tree: Path):
    listed = browsing.listing(str(tree / "projects"))
    assert listed.target is not None
    assert listed.target.path == str(tree / "projects")
    assert listed.target.is_git is True


def test_a_half_typed_name_has_no_target(tree: Path):
    assert browsing.listing(str(tree / "pro")).target is None


def test_a_parent_that_does_not_exist_is_not_an_empty_listing(tree: Path):
    with pytest.raises(NoSuchDirectoryError):
        browsing.listing(str(tree / "nowhere" / "deeper"))


def test_a_file_is_not_a_directory(tree: Path):
    with pytest.raises(NoSuchDirectoryError):
        browsing.listing(f"{tree / 'notes.md'}{os.sep}")


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads an unreadable directory anyway")
def test_an_unreadable_directory_says_so(tmp_path: Path):
    shut = tmp_path / "shut"
    shut.mkdir()
    shut.chmod(0o000)
    try:
        with pytest.raises(UnreadableDirectoryError):
            browsing.listing(f"{shut}{os.sep}")
    finally:
        shut.chmod(0o700)


def test_an_empty_path_opens_where_the_setting_says(tree: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(settings, "browse_start", tree)
    assert browsing.listing("").directory == str(tree)


def test_the_filesystem_root_has_nothing_above_it():
    assert browsing.listing(os.sep).up is None


def test_a_long_directory_is_cut_and_says_so(tmp_path: Path):
    many = tmp_path / "many"
    for index in range(browsing.MAX_ENTRIES + 1):
        (many / f"d{index:04d}").mkdir(parents=True)
    listed = browsing.listing(f"{many.resolve()}{os.sep}")
    assert len(listed.entries) == browsing.MAX_ENTRIES
    assert listed.truncated is True
