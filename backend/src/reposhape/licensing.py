"""The license that governs a file: which one, and whose copyright.

The page shows other people's source. The licenses the hosted deployment
serves (ADR-0008: MIT only, for now) allow that on condition that the copyright
and permission notice accompany the copies, so the file pane carries the
notice beside every file it opens.

The notice is the NEAREST license above the file, not the repo root's: the
same nearest-config rule the TypeScript resolver applies to tsconfigs, and for
the same reason. Monorepos and plugin directories carry licenses of their own,
under other holders and sometimes other licenses; the audit in
`ops/deployments/curated-repos.txt` found a dozen such directories in two of
the three curated repos, each of which a root-only notice misattributed.
"""

from __future__ import annotations

import re
from pathlib import Path

from reposhape.configuration import settings
from reposhape.models import RepoLicense
from reposhape.scanning import inside_repo

# In the order they are preferred when a repo has more than one. `COPYING` is
# the GNU convention; `LICENCE` is the British spelling some repos use.
_STEMS = ("license", "licence", "copying")

# Apache-2.0 section 4(d): when the work carries a NOTICE file, redistributions
# carry its contents too. It sits beside the LICENSE it belongs to, so only
# that directory is looked in; a NOTICE elsewhere belongs to another license.
_NOTICE_STEMS = ("notice",)
_SUFFIXES = ("", ".md", ".txt", ".rst")

# Each license by wording its text always contains and no other license here
# does. Every phrase must be present. Deliberately short: an unrecognised text
# answers null and is shown whole, which is honest, where a guessed id is not.
_SIGNATURES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("MIT", ("permission is hereby granted, free of charge",)),
    ("Apache-2.0", ("apache license", "version 2.0")),
    ("ISC", ("permission to use, copy, modify, and/or distribute this software",)),
    ("BSD-3-Clause", ("redistribution and use in source and binary forms", "neither the name")),
    ("BSD-2-Clause", ("redistribution and use in source and binary forms",)),
    ("MPL-2.0", ("mozilla public license version 2.0",)),
    ("GPL-3.0", ("gnu general public license", "version 3")),
)

# A notice line, as opposed to license prose that mentions copyright. Three
# shapes: `Copyright` carrying a year, a `(c)` or a `©` ("Copyright (c) LangChain,
# Inc.", "Copyright 2020 Someone"); a line opening with `©`; or `(c)` followed by
# a year. Each exclusion is from Apache-2.0's own body: "copyright notice that is
# included in or attached to the work" names no holder, and clause 4 is lettered,
# so "(c) You must retain, in the Source form..." is a list item.
_NOTICE = re.compile(
    r"^\s*(copyright\b.*(\d{4}|\(c\)|©)|©|\(c\)\s*\d{4})",
    re.IGNORECASE,
)

# Apache-2.0's text ends with an appendix telling you how to apply it, which
# includes a template line, `Copyright [yyyy] [name of copyright owner]`. It is
# no one's copyright.
_TEMPLATE = re.compile(r"\[(yyyy|name of copyright owner)\]", re.IGNORECASE)

_MAX_COPYRIGHT_LINES = 5


def find(repo: Path, start: str | None = None) -> RepoLicense:
    """The license nearest above `start` (a repo-relative file), else the root's.

    Walks from the file's own directory up to the repo root and stops at the
    first license file. `start` is trusted to lie inside `repo`: the caller
    only passes paths the analysis already knows, which is the same membership
    guard `/api/file` relies on.
    """
    root = repo.resolve()
    directory = root / start if start is not None else root
    if start is not None:
        directory = directory.parent
    for candidate in [directory, *directory.parents]:
        path = _license_file(root, candidate)
        if path is not None:
            return _read(root, path)
        if candidate == root:
            break
    return RepoLicense(path=None, name=None, copyright=[], text="", truncated=False)


def _read(root: Path, path: Path) -> RepoLicense:
    text, truncated = _capped(path)
    notice = _named_file(root, path.parent, _NOTICE_STEMS)
    notice_text, notice_truncated = _capped(notice) if notice is not None else ("", False)
    return RepoLicense(
        path=path.relative_to(root).as_posix(),
        name=_identify(text),
        # An Apache-2.0 LICENSE is the stock text and names no one; the holder
        # is stated in the NOTICE, when anywhere.
        copyright=_copyright_lines(text) or _copyright_lines(notice_text),
        text=text,
        truncated=truncated,
        notice_path=notice.relative_to(root).as_posix() if notice is not None else None,
        notice_text=notice_text,
        notice_truncated=notice_truncated,
    )


def _capped(path: Path) -> tuple[str, bool]:
    raw = path.read_bytes()
    text = raw[: settings.max_file_view_bytes].decode("utf-8", errors="replace")
    return text, len(raw) > settings.max_file_view_bytes


def _license_file(root: Path, directory: Path) -> Path | None:
    return _named_file(root, directory, _STEMS)


def _named_file(root: Path, directory: Path, stems: tuple[str, ...]) -> Path | None:
    """The first of `stems` (with any of `_SUFFIXES`) in `directory`, case-insensitively.

    A `LICENSE` that is a symlink out of the repo is not one: it would serve
    whatever host file it names (scanning.inside_repo).
    """
    try:
        by_name = {
            child.name.lower(): child
            for child in directory.iterdir()
            if child.is_file() and inside_repo(root, child)
        }
    except OSError:
        return None
    for stem in stems:
        for suffix in _SUFFIXES:
            match = by_name.get(stem + suffix)
            if match is not None:
                return match
    return None


def _identify(text: str) -> str | None:
    folded = " ".join(text.lower().split())
    for name, phrases in _SIGNATURES:
        if all(phrase in folded for phrase in phrases):
            return name
    return None


def _copyright_lines(text: str) -> list[str]:
    lines = [
        line.strip()
        for line in text.splitlines()
        if _NOTICE.match(line) and not _TEMPLATE.search(line)
    ]
    return lines[:_MAX_COPYRIGHT_LINES]
