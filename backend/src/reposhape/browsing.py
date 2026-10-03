"""Listing directories, so a repo can be picked in the browser instead of typed.

The browser cannot hand this process a filesystem path. `<input webkitdirectory>`
yields relative names, `showDirectoryPicker()` yields a handle, and neither is a
path anything here could open. So the folder chooser has to run on this side.

**Directories only.** Nothing here returns a file name, let alone a byte of
content. `GET /api/file`'s guard -- membership in an analysis's own file list --
is what keeps file reads inside an analysed repo, and this widens none of it.
Knowing where the repos are is a different disclosure from reading what is in
them, and only the first is needed to pick one.

Completion works the way a shell's does, out of one endpoint: a path ending in a
separator lists that directory, anything else lists its parent filtered by the
last segment. That is what makes typing `~/pro` and clicking through
`~/projects/` the same mechanism rather than two.
"""

from __future__ import annotations

import os
from pathlib import Path

from reposhape import cache
from reposhape.configuration import settings
from reposhape.models import FolderEntry, FolderListing
from reposhape.scanning import ALWAYS_SKIP_DIRS

# Past this a directory is not being read, it is being scrolled past. The
# listing says it was cut rather than quietly showing a prefix of itself.
MAX_ENTRIES = 400


class BrowseError(Exception):
    """A directory that cannot be listed. The message is shown to the reader."""


class NoSuchDirectoryError(BrowseError):
    """Nothing at that path, or it is a file. Ordinary while a path is half-typed."""


class UnreadableDirectoryError(BrowseError):
    """It is there and this process may not read it. Said out loud, not skipped."""


def _entry(path: Path) -> FolderEntry:
    """One row.

    `analysis_key` is what turns "analyse" into "open" for a folder already in
    the cache: the picker offers the same click for a repo it has seen and one
    it has not, and only the label differs.
    """
    return FolderEntry(
        path=str(path),
        name=path.name or str(path),
        is_git=(path / ".git").exists(),
        analysis_key=cache.repo_key(path) if cache.analysis_path(path).is_file() else None,
    )


def _split(raw: str) -> tuple[Path, str]:
    """The directory to list, and the prefix its children must start with.

    Split on the string rather than through `Path`, because `Path` normalises
    away exactly the character this has to see: `Path("~/work/.")` is `~/work`,
    so asking for the dot directories through pathlib silently asks for their
    parent instead.
    """
    text = os.path.expanduser(raw.strip())
    if not text:
        return settings.browse_start.expanduser(), ""
    head, separator, tail = text.rpartition(os.sep)
    if not separator:
        return Path(), text
    return Path(head or os.sep), tail


def _keep(name: str, prefix: str) -> bool:
    """Dot directories and build output stay hidden until they are asked for.

    Typing the leading dot is the ask. Nothing is unreachable, because the field
    takes a whole path and goes wherever it names.
    """
    if name in ALWAYS_SKIP_DIRS:
        return False
    if name.startswith(".") and not prefix.startswith("."):
        return False
    return name.casefold().startswith(prefix.casefold())


def listing(raw: str) -> FolderListing:
    """Child directories of whatever `raw` names, plus `raw` itself if it is one."""
    directory, prefix = _split(raw)
    directory = directory.expanduser().resolve()
    if not directory.is_dir():
        raise NoSuchDirectoryError(f"no such directory: {directory}")

    try:
        children = sorted(directory.iterdir(), key=lambda child: child.name.casefold())
    except OSError as error:
        raise UnreadableDirectoryError(
            f"cannot list {directory}: {error.strerror or error}"
        ) from error

    # `is_dir` last: it is a stat per child, and the name tests reject most of
    # them for free. It also swallows the OSError a broken symlink raises.
    matches = [child for child in children if _keep(child.name, prefix) and child.is_dir()]
    text = raw.strip()
    typed = Path(text).expanduser().resolve() if text else directory
    up = directory.parent
    return FolderListing(
        directory=str(directory),
        up=None if up == directory else str(up),
        prefix=prefix,
        entries=[_entry(child) for child in matches[:MAX_ENTRIES]],
        target=_entry(typed) if typed.is_dir() else None,
        truncated=len(matches) > MAX_ENTRIES,
    )
