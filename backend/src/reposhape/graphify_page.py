"""The symbol graph: graphify's own page, served verbatim.

This tool extracts files and the imports between them. Symbols (functions,
classes, methods and the calls between them) are a stated non-goal (PRD.md),
and graphify already extracts them, so the `symbol graph` tab shows
graphify's `graph.html` exactly as its own pipeline wrote it.

No graphify code is imported. The page is produced by the `graphify` binary on
the machine (`reposhape graphify-page` drives that pipeline) and served byte
for byte, so whatever it shows is graphify's data and graphify's drawing.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from reposhape.scanning import inside_repo

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
    """A page is there, and it is the repo's own file rather than a symlink out of it."""
    page = page_path(repo)
    return page.is_file() and inside_repo(repo, page)


def status_of(repo: Path) -> tuple[bool, str | None]:
    """Ready plus reason, for a tab that explains itself instead of failing."""
    if has_page(repo):
        return True, None
    if not (repo / ARTIFACT).is_file():
        return False, (f"No {ARTIFACT} in this repo. Run: reposhape graphify-page {repo}")
    return False, (f"No {PAGE} in this repo. Run: reposhape graphify-page {repo}")


def ensure(repo: Path, *, refresh: bool = False) -> Path:
    """Run graphify's own pipeline until its page exists. Returns the page.

    From scratch (`graph.json` missing) that is `graphify update`, which
    extracts, clusters and writes the page in one go. When only the page is
    missing, `graphify export html` re-emits it from the extraction already
    there. `refresh` re-extracts, because a repo that moved has symbols the
    old extraction never saw, and a page re-drawn from it would still be stale.
    """
    target = page_path(repo)
    if has_page(repo) and not refresh:
        return target

    exe = binary()
    if exe is None:
        raise GraphifyPageError(
            "the `graphify` binary is not on PATH, so its page cannot be built here."
        )

    if refresh or not (repo / ARTIFACT).is_file():
        # graphify skips the page past its node limit, and an old page left
        # behind would then be served as if it described the new extraction.
        target.unlink(missing_ok=True)
        extract(repo)
    else:
        run(
            [exe, "export", "html", "--graph", str(repo / ARTIFACT)],
            repo,
        )

    if not has_page(repo):
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
