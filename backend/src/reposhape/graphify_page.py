"""graphify's own page, served verbatim.

The comparison tabs (`graphify-imports`, `graphify-all`) project graphify's
symbol graph onto files and draw it through our renderer, so a difference in
the picture is a difference in the extractor. This module is the other half of
that comparison: graphify's `graph.html` exactly as its own pipeline wrote it,
same code, same dependency, same vis-network renderer.

It reads the artifact and nothing else. No graphify code is imported; the page
is produced by the `graphify` binary on the machine (`reposhape graphify-page` drives
that pipeline), and served here byte for byte. If the page looks different
from our tabs, that difference is graphify's rendering, not ours.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

PAGE = Path("graphify-out") / "graph.html"
ARTIFACT = Path("graphify-out") / "graph.json"

# hermes-agent took 380 s on ten cores (240k symbols); the host has four.
EXTRACT_TIMEOUT_S = 3600


class GraphifyPageError(Exception):
    """The page cannot be produced here. Says what to run instead."""


def binary() -> str | None:
    """The graphify executable, or None when it is not installed."""
    return shutil.which("graphify")


def page_path(repo: Path) -> Path:
    return repo / PAGE


def has_page(repo: Path) -> bool:
    return page_path(repo).is_file()


def status_of(repo: Path) -> tuple[bool, str | None]:
    """Ready plus reason, for a tab that explains itself instead of failing."""
    if has_page(repo):
        return True, None
    if not (repo / ARTIFACT).is_file():
        return False, (f"no {ARTIFACT} in this repo. Run: reposhape graphify-page {repo}")
    return False, (f"no {PAGE} in this repo. Run: reposhape graphify-page {repo}")


def ensure(repo: Path, *, refresh: bool = False) -> Path:
    """Run graphify's own pipeline until its page exists. Returns the page.

    From scratch (`graph.json` missing) that is `graphify update`, which
    extracts, clusters and writes the page in one go. When the extraction
    already exists, `graphify export html` re-emits just the page from it, so
    a re-render never pays for a re-extract. `refresh` forces the page
    re-emit even when one is already there.
    """
    target = page_path(repo)
    if target.is_file() and not refresh:
        return target

    exe = binary()
    if exe is None:
        raise GraphifyPageError(
            "the `graphify` binary is not on PATH, so its page cannot be built here."
        )

    if not (repo / ARTIFACT).is_file():
        extract(repo)
    else:
        run(
            [exe, "export", "html", "--graph", str(repo / ARTIFACT)],
            repo,
        )

    if not target.is_file():
        raise GraphifyPageError(
            f"graphify ran but wrote no {PAGE}. "
            "It may have skipped the page for a graph past its node limit; "
            "run it by hand to see why."
        )
    return target


def extract(repo: Path) -> Path:
    """Run `graphify update` on a repo, from scratch or on top of its cache.

    The LLM-free half only (AGENTS.md): `update` extracts with tree-sitter,
    clusters with networkx and names clusters after their hubs. It writes the
    page too, unless the graph is past graphify's own node limit, as
    hermes-agent's is.

    `graphify-out/` goes into the checkout's local git exclude first. It is
    untracked output, and `git status` would otherwise report every graphed
    repo as dirty from then on.
    """
    exe = binary()
    if exe is None:
        raise GraphifyPageError("the `graphify` binary is not on PATH, so it cannot run here.")
    _exclude_output(repo)
    run([exe, "update", str(repo)], repo, timeout=EXTRACT_TIMEOUT_S)
    artifact = repo / ARTIFACT
    if not artifact.is_file():
        raise GraphifyPageError(f"graphify ran but wrote no {ARTIFACT}; run it by hand to see why.")
    return artifact


def _exclude_output(repo: Path) -> None:
    located = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--git-path", "info/exclude"],
        capture_output=True,
        text=True,
        check=False,
    )
    if located.returncode != 0:
        return  # not a git checkout, so there is no status to keep clean
    exclude = Path(located.stdout.strip())
    if not exclude.is_absolute():
        exclude = repo / exclude
    line = f"/{ARTIFACT.parent}/"
    existing = exclude.read_text(encoding="utf-8") if exclude.is_file() else ""
    if line in existing.splitlines():
        return
    exclude.parent.mkdir(parents=True, exist_ok=True)
    separator = "" if not existing or existing.endswith("\n") else "\n"
    exclude.write_text(f"{existing}{separator}{line}\n", encoding="utf-8")


def run(argv: list[str], repo: Path, *, timeout: float = 600) -> None:
    """Run the graphify binary for a repo, saying plainly when it fails."""
    try:
        completed = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except OSError as error:
        raise GraphifyPageError(f"could not start graphify: {error}") from error
    except subprocess.TimeoutExpired as error:
        raise GraphifyPageError(f"graphify did not finish on {repo}") from error
    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "").strip().splitlines()
        detail = tail[-1] if tail else f"exit {completed.returncode}"
        raise GraphifyPageError(f"graphify failed on {repo}: {detail}")
