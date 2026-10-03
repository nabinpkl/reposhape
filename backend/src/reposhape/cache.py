"""Where analyses live between a CLI run and a browser opening the page.

The cache is also the repo picker's data source, which is the point: a stored
analysis has to resurface without being searched for, or storing it was
collecting rather than remembering (AGENTS.md "Read path before storage").
"""

from __future__ import annotations

import hashlib
import json
import shutil
from contextlib import suppress
from pathlib import Path
from typing import get_args

from reposhape import graphify_files
from reposhape.configuration import settings
from reposhape.models import SCHEMA_VERSION, Analysis, AnalysisSource, RepoSummary


def repo_key(repo_path: Path | str, source: AnalysisSource = "imports") -> str:
    """Stable per-repo-per-source artifact name: readable stem plus a digest.

    The digest is what keeps two checkouts of the same project apart; the stem
    is what makes the cache directory browsable by a human. The source suffix is
    what lets this tool's graph of a repo and an imported one sit side by side
    without either overwriting the other.
    """
    resolved = Path(repo_path).expanduser().resolve()
    digest = hashlib.sha256(str(resolved).encode()).hexdigest()[:12]
    suffix = "" if source == "imports" else f"-{source}"
    return f"{resolved.name}-{digest}{suffix}"


def analysis_path(repo_path: Path | str, source: AnalysisSource = "imports") -> Path:
    return settings.cache_root / f"{repo_key(repo_path, source)}.json"


def write(analysis: Analysis, destination: Path | None = None) -> Path:
    target = destination or analysis_path(analysis.repo_path, analysis.source)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Written beside the target and moved, so a reader never sees half a file.
    staging = target.with_suffix(".json.partial")
    staging.write_text(analysis.model_dump_json(indent=None), encoding="utf-8")
    staging.replace(target)
    return target


class StaleArtifactError(Exception):
    """A cached analysis this build cannot read. Re-run, do not migrate."""


def read(path: Path) -> Analysis:
    """Parse an artifact, saying plainly when it is from an older schema.

    A stale artifact and a missing one are different facts and the caller's
    answer differs: one needs `analyze-repo`, the other means the cache never
    had it. Returning None for both makes a schema bump look like an empty
    cache, which is the absence that sends you looking in the wrong place.
    """
    raw = path.read_text(encoding="utf-8")
    try:
        return Analysis.model_validate_json(raw)
    except ValueError as error:
        version = None
        with suppress(ValueError, KeyError, TypeError):
            version = json.loads(raw).get("schema_version")
        if version != SCHEMA_VERSION:
            raise StaleArtifactError(
                f"{path.name} is schema {version}, this build reads {SCHEMA_VERSION}. "
                "Re-run the analysis; artifacts are regenerated, never migrated."
            ) from error
        raise


def load(repo_path: Path | str, source: AnalysisSource = "imports") -> Analysis | None:
    target = analysis_path(repo_path, source)
    if not target.is_file():
        return None
    try:
        return read(target)
    except OSError:
        return None


def summaries() -> list[RepoSummary]:
    root = settings.cache_root
    if not root.is_dir():
        return []
    rows: list[RepoSummary] = []
    for entry in sorted(root.glob("*.json")):
        try:
            analysis = read(entry)
        except OSError, ValueError:
            continue
        rows.append(
            RepoSummary(
                key=entry.stem,
                source=analysis.source,
                repo_path=analysis.repo_path,
                repo_name=analysis.repo_name,
                git_sha=analysis.git_sha,
                dirty=analysis.dirty,
                generated_at=analysis.generated_at,
                files=len(analysis.files),
                edges=len(analysis.edges),
                exists=Path(analysis.repo_path).is_dir(),
            )
        )
    rows.sort(key=lambda row: row.generated_at, reverse=True)
    return rows


def find(key: str) -> Analysis | None:
    """Look up by cache key, refusing anything that escapes the cache root."""
    if "/" in key or "\\" in key or key.startswith("."):
        return None
    target = settings.cache_root / f"{key}.json"
    if not target.is_file():
        return None
    try:
        return read(target)
    except OSError:
        return None


def version_of(key: str) -> int | None:
    """The artifact's modification time, without reading it. None when there is none.

    What a memo of anything derived from an artifact keys on: a re-analysis
    replaces the file by rename, so the version moves exactly when the content
    can have.
    """
    if "/" in key or "\\" in key or key.startswith("."):
        return None
    try:
        return (settings.cache_root / f"{key}.json").stat().st_mtime_ns
    except OSError:
        return None


def key_for(repo_path: Path | str) -> str | None:
    """Any cached key for this repository, whichever source it was built from.

    Resolved without touching the repository, so a path that is gone from disk
    still finds its artifacts: that is the repo most worth forgetting.
    """
    for source in get_args(AnalysisSource):
        if analysis_path(repo_path, source).is_file():
            return repo_key(repo_path, source)
    return None


def forget(key: str) -> list[str]:
    """Take a repository out of the cache: every source's artifact, and the pages drawn from each.

    Scoped to the repository rather than to the key, because the picker names
    repositories and shows one while ANY of its rows exist. Forgetting only the
    `imports` artifact would leave `graphify-imports` behind, and the repo would
    be back in the picker on the next read.

    A stale artifact cannot say which repository it belongs to, so it goes
    alone. Everything removed is a cache and regenerates on the next analysis;
    nothing in the analysed repo itself is touched. Returns the keys removed,
    and an empty list means there was nothing under that key.
    """
    if "/" in key or "\\" in key or key.startswith("."):
        return []
    if not settings.cache_root.is_absolute():
        raise ValueError(f"cache_root must be absolute to delete under it: {settings.cache_root}")
    target = settings.cache_root / f"{key}.json"
    if not target.is_file():
        return []

    try:
        repo_path = read(target).repo_path
    except StaleArtifactError, OSError, ValueError:
        keys = [key]
    else:
        siblings = [repo_key(repo_path, source) for source in get_args(AnalysisSource)]
        keys = list(dict.fromkeys([key, *siblings]))

    removed: list[str] = []
    for each in keys:
        artifact = settings.cache_root / f"{each}.json"
        pages = graphify_files.workdir(each)
        if not artifact.is_file() and not pages.is_dir():
            continue
        artifact.unlink(missing_ok=True)
        if pages.is_dir():
            shutil.rmtree(pages)
        removed.append(each)
    return removed


def write_json_to(analysis: Analysis, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(analysis.model_dump(mode="json"), indent=2), encoding="utf-8")
