"""Where analyses live between a CLI run and a browser opening the page.

The cache is also the repo picker's data source, which is the point: a stored
analysis has to resurface without being searched for, or storing it was
collecting rather than remembering (AGENTS.md "Read path before storage").
"""

from __future__ import annotations

import hashlib
import json
from contextlib import suppress
from pathlib import Path

from reposhape.configuration import settings
from reposhape.models import SCHEMA_VERSION, Analysis, RepoSummary


def repo_key(repo_path: Path | str) -> str:
    """Stable per-repo artifact name: readable stem plus a digest.

    The digest is what keeps two checkouts of the same project apart; the stem
    is what makes the cache directory browsable by a human.
    """
    resolved = Path(repo_path).expanduser().resolve()
    digest = hashlib.sha256(str(resolved).encode()).hexdigest()[:12]
    return f"{resolved.name}-{digest}"


def analysis_path(repo_path: Path | str) -> Path:
    return settings.cache_root / f"{repo_key(repo_path)}.json"


def write(analysis: Analysis, destination: Path | None = None) -> Path:
    target = destination or analysis_path(analysis.repo_path)
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

    An older artifact that still fits the models is read as it is, whatever its
    `schema_version`: an upgrade must not cost a re-analysis it does not need.
    Only one that no longer validates is stale (models.SCHEMA_VERSION).
    """
    raw = path.read_text(encoding="utf-8")
    try:
        return Analysis.model_validate_json(raw)
    except ValueError as error:
        version = None
        with suppress(ValueError, KeyError, TypeError, AttributeError):
            version = json.loads(raw).get("schema_version")
        if version != SCHEMA_VERSION:
            raise StaleArtifactError(
                f"{path.name} is schema {version}, this build reads {SCHEMA_VERSION}. "
                "Re-run the analysis; artifacts are regenerated, never migrated."
            ) from error
        raise


def load(repo_path: Path | str) -> Analysis | None:
    target = analysis_path(repo_path)
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
        # A stale artifact is skipped rather than raised: one old file must not
        # take the whole picker down, and the next analysis of it replaces it.
        try:
            analysis = read(entry)
        except OSError, ValueError, StaleArtifactError:
            continue
        if not _named_for(entry.stem, analysis):
            continue
        rows.append(
            RepoSummary(
                key=entry.stem,
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
        analysis = read(target)
    except OSError:
        return None
    return analysis if _named_for(key, analysis) else None


def _named_for(key: str, analysis: Analysis) -> bool:
    """True when `key` is the one name this artifact's repo is cached under.

    One repo, one key. Anything else in the cache directory is not this build's
    artifact: chiefly the `-graphify-imports` and `-graphify-all` projections an
    older version kept beside each repo, which still validate and would
    otherwise list the repo two more times.
    """
    return key == repo_key(analysis.repo_path)


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
    """The cached key for this repository, or None when nothing is cached.

    Resolved without touching the repository, so a path that is gone from disk
    still finds its artifact: that is the repo most worth forgetting.
    """
    return repo_key(repo_path) if analysis_path(repo_path).is_file() else None


def forget(key: str) -> list[str]:
    """Take a repository out of the cache. Returns the keys removed.

    A list because it is what the browser moves off of, and an empty one means
    there was nothing under that key. A stale artifact goes too: the picker
    cannot read it, which is exactly when it needs to go. Only the cache is
    touched, never the analysed repo.
    """
    if "/" in key or "\\" in key or key.startswith("."):
        return []
    if not settings.cache_root.is_absolute():
        raise ValueError(f"cache_root must be absolute to delete under it: {settings.cache_root}")
    target = settings.cache_root / f"{key}.json"
    if not target.is_file():
        return []
    target.unlink()
    return [key]


def write_json_to(analysis: Analysis, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(analysis.model_dump(mode="json"), indent=2), encoding="utf-8")
