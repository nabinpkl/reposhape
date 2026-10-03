"""Getting a repository that is not on this machine yet, so a URL can be graphed.

Every other way into this tool needs a path: `reposhape up <repo>` and the folder
picker both name a directory that already exists. A git URL names one that does
not, so something has to put it on disk first, and **where it lands is the whole
decision here**.

A clone is not a cache. Everything under `cache_root` is regenerated from a repo
in seconds, which is why `reposhape forget` may delete it; a clone IS the repo, and the
cheapest thing about it is the analysis. So clones live under their own durable
root (`~/.local/share/reposhape/clones`, `REPOSHAPE_CLONE_ROOT` to move it),
laid out `<host>/<owner>/<name>` the way `ghq` and `go get` lay theirs out, so
the directory is browsable and two `foo` repositories from two hosts are two
directories. Nothing here ever deletes a checkout. See ADR-0007.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from reposhape.configuration import settings

# `git clone` accepts more than these, and the extras are the problem:
# `ext::sh -c <anything>` is a transport that runs a command, so an allowlist is
# the difference between "fetch a repo" and "run this". `file` is here because
# cloning a local checkout is a real use (a snapshot the original's working tree
# cannot move under) and because it is what makes this path testable offline.
ALLOWED_SCHEMES = frozenset({"https", "http", "ssh", "git", "file"})

# `<helper>::<address>` hands the whole address to `git-remote-<helper>`, and
# `ext::sh -c <anything>` is the helper that runs a command. It is not a scheme,
# so the allowlist above never sees it: it has to be refused by name, before the
# string can reach `git clone`.
TRANSPORT_HELPER = re.compile(r"^[A-Za-z0-9][\w+.\-]*::")

# `git@github.com:owner/repo.git`, the form every host prints beside the https
# one. No scheme, so `urlsplit` reads the whole thing as a path. The lookahead
# is what keeps `https://` and `ext::` out of this branch: all three are a name,
# a colon, and a tail, and only this one's tail is a path.
SCP_LIKE = re.compile(r"^(?:[\w.\-]+@)?(?P<host>[\w.\-]+):(?!/{2}|:)(?P<path>.+)$")


class CloneError(Exception):
    """Cloning did not happen. The message is shown to whoever asked."""


class UnsupportedUrlError(CloneError):
    """Not a git URL this will clone. A typed path, or a transport we refuse."""


@dataclass(frozen=True)
class RemoteRepo:
    """A parsed git URL, and the directory name it earns."""

    url: str
    host: str
    segments: tuple[str, ...]

    @property
    def name(self) -> str:
        return self.segments[-1]


@dataclass(frozen=True)
class CloneResult:
    path: Path
    already_present: bool


# What a refresh did to a checkout. `left_alone` and `failed` both mean the
# working tree is unchanged, and they are separate because one is a decision
# and the other is a problem.
UpdateOutcome = Literal["updated", "current", "left_alone", "failed"]


@dataclass(frozen=True)
class UpdateResult:
    outcome: UpdateOutcome
    detail: str | None = None
    sha: str | None = None


def looks_remote(text: str) -> bool:
    """Is this a URL rather than a path? Used to route, never to trust.

    `parse` is the authority on what will actually be cloned; this only decides
    which of the two things the caller was asking for.
    """
    candidate = text.strip()
    if not candidate or candidate.startswith(("/", ".", "~")):
        return False
    return "://" in candidate or SCP_LIKE.match(candidate) is not None


def _segments(raw_path: str) -> tuple[str, ...]:
    """Path components of the URL, `.git` dropped, nothing that climbs."""
    parts = [part for part in raw_path.split("/") if part and part not in (".", "..")]
    if parts and parts[-1].endswith(".git"):
        parts[-1] = parts[-1][: -len(".git")]
    return tuple(part for part in parts if part)


def parse(url: str) -> RemoteRepo:
    """A git URL to the repo it names, or an error saying why it is not one."""
    candidate = url.strip()
    if not candidate:
        raise UnsupportedUrlError("no URL given")

    if TRANSPORT_HELPER.match(candidate):
        raise UnsupportedUrlError(
            f"{candidate!r} names a git transport helper. `ext::` runs a command instead "
            "of fetching a repository, so the <helper>::<address> form is never cloned."
        )

    scp = SCP_LIKE.match(candidate)
    if scp is not None:
        host, raw_path = scp.group("host"), scp.group("path")
    else:
        split = urlsplit(candidate)
        if not split.scheme:
            raise UnsupportedUrlError(
                f"{candidate!r} is not a git URL. Use https://, ssh://, git://, "
                "or the git@host:owner/repo form; a folder on this machine is "
                "added by path instead."
            )
        if split.scheme not in ALLOWED_SCHEMES:
            raise UnsupportedUrlError(
                f"{split.scheme}:// is not cloned here. Allowed: "
                f"{', '.join(sorted(ALLOWED_SCHEMES))}."
            )
        # `file:///path` has no host, and every clone still needs one directory
        # to sit under. Everything local shares `local/`.
        host = split.hostname or "local"
        raw_path = split.path

    segments = _segments(raw_path)
    if not segments:
        raise UnsupportedUrlError(f"{candidate!r} names a host but no repository")
    return RemoteRepo(url=candidate, host=host.lower(), segments=segments)


def clone_root() -> Path:
    return settings.clone_root.expanduser().resolve()


def destination(remote: RemoteRepo) -> Path:
    """Where this repo's checkout belongs. Absolute, and under the clone root.

    The confinement check is the guard on a URL path that climbs: `_segments`
    already drops `..`, and this is what makes that a property of the answer
    rather than of the filter.
    """
    root = clone_root()
    target = Path(os.path.normpath(root.joinpath(*remote.host.split("/"), *remote.segments)))
    if not target.is_relative_to(root):
        raise UnsupportedUrlError(f"{remote.url!r} would clone outside {root}")
    return target


def _git_env() -> dict[str, str]:
    """Git, with every way of asking a human a question taken away.

    Nobody is watching this process: a private repo with no usable credential
    would otherwise sit on `Username for 'https://github.com':` until the
    timeout, and an unknown SSH host key would do the same. Credential helpers
    are deliberately left alone, so a repo the owner can already pull still
    clones.
    """
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes"
    for asker in ("GIT_ASKPASS", "SSH_ASKPASS"):
        env.pop(asker, None)
    return env


def clone(url: str) -> CloneResult:
    """Put `url` on disk under the clone root, or report what stopped it.

    A checkout that is already there is reused as it stands. Cloning never
    fetches and never resets; asking for a repo as it is NOW is a refresh, and
    `update` below is what does that.

    Shallow (`--depth 1 --single-branch`), because what is analysed is the
    working tree and history is not read. `git fetch --unshallow` in the clone
    is the way back if it is ever wanted.
    """
    remote = parse(url)
    target = destination(remote)

    if (target / ".git").exists():
        return CloneResult(path=target, already_present=True)
    if target.exists() and any(target.iterdir()):
        raise CloneError(f"{target} already exists and is not a git checkout")

    target.parent.mkdir(parents=True, exist_ok=True)
    # Cloned beside the destination and moved, so an interrupted clone cannot be
    # found later and mistaken for a complete one. Same discipline as
    # `cache.write`, and the reason the failure path can delete this directory:
    # it is an absolute path this call created moments ago.
    staging = target.parent / f".partial-{target.name}-{os.getpid()}"
    shutil.rmtree(staging, ignore_errors=True)

    command = ["git", "clone", "--depth", "1", "--single-branch", "--", remote.url, str(staging)]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=settings.clone_timeout_s,
            check=False,
            env=_git_env(),
        )
    except subprocess.TimeoutExpired as error:
        shutil.rmtree(staging, ignore_errors=True)
        raise CloneError(
            f"git clone took longer than {settings.clone_timeout_s}s and was stopped"
        ) from error
    except OSError as error:
        shutil.rmtree(staging, ignore_errors=True)
        raise CloneError(f"could not run git: {error}") from error

    if completed.returncode != 0:
        shutil.rmtree(staging, ignore_errors=True)
        # git's own last line names the cause (no such repo, auth, DNS) far
        # better than anything this could write about it.
        detail = (completed.stderr or completed.stdout).strip().splitlines()
        raise CloneError(detail[-1] if detail else f"git clone failed ({completed.returncode})")

    staging.replace(target)
    return CloneResult(path=target, already_present=False)


def owns(path: Path | str) -> bool:
    """Is this a checkout this tool made?

    The whole safety argument for `update` rests on this answer. Every other
    repository graphed here belongs to the owner, is on whatever branch they
    left it on, and is none of this tool's business to move.
    """
    resolved = Path(path).expanduser().resolve()
    return resolved.is_relative_to(clone_root()) and (resolved / ".git").is_dir()


def _run(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=settings.clone_timeout_s,
        check=False,
        env=_git_env(),
    )


def _last_line(completed: subprocess.CompletedProcess[str]) -> str:
    lines = (completed.stderr or completed.stdout).strip().splitlines()
    return lines[-1] if lines else f"git exited {completed.returncode}"


def update(path: Path | str) -> UpdateResult | None:
    """Bring a checkout this tool made up to its remote, before re-analysing it.

    Refresh means "as it is now", and for a clone, now is upstream rather than
    whatever was downloaded once. Without this, the refresh button on a cloned
    repo re-reads a working tree that cannot have changed, which is a button
    that looks like it did something.

    **None means this is not a checkout this tool made**, which is true of most
    repositories here and is not a fact worth reporting: the owner's own repos
    are not this tool's to move.

    Three things must hold before anything is written, because `reset --hard`
    is the one operation here that can destroy work:

    - the checkout is under the clone root, so this tool made it;
    - HEAD is on a branch, so nobody has pinned it to a tag or a commit;
    - no TRACKED file is modified. Untracked files are deliberately not a
      blocker, because `.reposhapeignore` is one: this tool tells you to drop
      that file into the repo being analysed, and `reset --hard` leaves
      untracked files alone, so nothing of the owner's is at risk from them.

    Anything else is reported and skipped. A fetch that fails is not allowed to
    fail the analysis: being offline is a reason to graph what is on disk, not
    a reason to refuse.
    """
    if not owns(path):
        return None
    repo = Path(path).expanduser().resolve()

    try:
        branch = _run(repo, "rev-parse", "--abbrev-ref", "HEAD")
        if branch.returncode != 0:
            return UpdateResult("failed", detail=_last_line(branch))
        on = branch.stdout.strip()
        if on == "HEAD":
            return UpdateResult("left_alone", detail="this checkout is not on a branch")

        dirty = _run(repo, "status", "--porcelain", "--untracked-files=no")
        if dirty.returncode != 0:
            return UpdateResult("failed", detail=_last_line(dirty))
        if dirty.stdout.strip():
            return UpdateResult("left_alone", detail="this checkout has local changes")

        before = _run(repo, "rev-parse", "HEAD").stdout.strip()
        # `--depth 1` keeps it shallow: a fetch without it deepens the history
        # of a repo whose history is never read.
        fetched = _run(repo, "fetch", "--depth", "1", "origin", on)
        if fetched.returncode != 0:
            return UpdateResult("failed", detail=_last_line(fetched))

        after = _run(repo, "rev-parse", "FETCH_HEAD").stdout.strip()
        if not after:
            return UpdateResult("failed", detail="the remote answered with no commit")
        if after == before:
            return UpdateResult("current", sha=before)

        # Reached only on a clean tracked tree, in a directory this tool
        # created. `reset` rather than `merge --ff-only` because upstream is
        # free to have rewritten what a one-commit clone is holding.
        reset = _run(repo, "reset", "--hard", "FETCH_HEAD")
        if reset.returncode != 0:
            return UpdateResult("failed", detail=_last_line(reset))
        return UpdateResult("updated", sha=after)
    except subprocess.TimeoutExpired:
        return UpdateResult("failed", detail=f"git took longer than {settings.clone_timeout_s}s")
    except OSError as error:
        return UpdateResult("failed", detail=f"could not run git: {error}")
