"""Every environment-dependent value. No literals for these anywhere else."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


def _default_cache_root() -> Path:
    """XDG when set, the macOS convention otherwise."""
    xdg = os.environ.get("XDG_CACHE_HOME")
    if xdg:
        return Path(xdg) / "reposhape"
    return Path.home() / ".cache" / "reposhape"


def _default_clone_root() -> Path:
    """Data, not cache. `XDG_DATA_HOME` when set, `~/.local/share` otherwise.

    A clone is deliberately not under `cache_root`. Everything in the cache is
    regenerated from a repo in seconds; a clone IS the repo, and losing one
    costs a download. Separate roots are what make "clear the cache" and
    `reposhape forget` unable to reach a checkout. See ADR-0007.
    """
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "reposhape" / "clones"
    return Path.home() / ".local" / "share" / "reposhape" / "clones"


def _default_state_root() -> Path:
    """`XDG_STATE_HOME` when set, `~/.local/state` otherwise."""
    xdg = os.environ.get("XDG_STATE_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "state"
    return base / "reposhape"


def _default_link_rules_dir() -> Path:
    """Configuration the operator writes, so the config home, not data or cache."""
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "reposhape" / "links"


class Settings(BaseSettings):
    """Environment only, and never a `.env` from the current directory.

    `reposhape` is run inside other people's repositories, which is the whole point of
    it, and a `.env` beside the code being graphed belongs to that project. The
    first run of `reposhape up` inside another project loaded its `.env`, failed
    validation on seventeen unrelated keys, and printed an API key into the
    traceback. A tool that visits repos does not read their secrets.
    """

    model_config = SettingsConfigDict(env_prefix="REPOSHAPE_")

    cache_root: Path = _default_cache_root()

    # Where `reposhape clone` and POST /api/clone put a checkout of a remote repo.
    # Durable by design: a graph of a cloned repo is only as reachable as the
    # clone, and a temp directory takes both away on the next reboot.
    clone_root: Path = _default_clone_root()

    # A cold clone of a large repository over a slow link. Generous, because the
    # alternative to waiting is a half-downloaded checkout, and bounded, because
    # a hung `git` with nobody to answer it would otherwise wait forever.
    clone_timeout_s: int = 600

    # Rules for runtime links no syntax states (ADR-0009): `<repo name>.toml`
    # here names the loaders that glob a directory of files. Outside the repo
    # on purpose, because the repos that need it most are other people's
    # clones, and a file written into a checkout is not the operator's to keep.
    link_rules_dir: Path = _default_link_rules_dir()
    host: str = "127.0.0.1"

    # The personal server's port. Fixed, not picked per run: the URL is
    # bookmarked and the page's theme is stored per origin, so a moving port
    # loses both. Not 8000, which half the Python servers on any machine
    # default to (oss-agent's dashboard holds it on this one).
    port: int = 7420

    # Where the background server registers itself (`daemon.py`): its pid,
    # URL and build, plus its log. State rather than cache or config, so
    # clearing caches never orphans a running server.
    state_root: Path = _default_state_root()

    # Host names a request may arrive under, without the port. Anything else is
    # refused before routing, which is what stops DNS rebinding (api.py). A
    # server reached under another name -- a tailnet front, a LAN address --
    # lists that name here; binding to it is not enough on its own. Comma
    # separated in the environment, because the deployment's env file is read
    # by a shell, by compose and by `docker run`, and they disagree on quotes.
    allowed_hosts: Annotated[list[str], NoDecode] = ["127.0.0.1", "localhost"]

    # The public deployment's switch, and the only difference between it and
    # `reposhape up` on someone's own machine. When set, the API never registers the
    # routes that act on the host -- browsing its folders, cloning, analysing
    # or refreshing a path, forgetting a repo -- so a visitor can read the
    # repos an operator put there and nothing else. Not registered rather than
    # refused: a route that does not exist has no check to get wrong. The CLI
    # is unaffected, because reaching it already means a shell on the host.
    read_only: bool = False

    # Where the folder picker opens when it has nowhere better to start. A
    # starting point, not a fence: it lists any directory this process can read,
    # because the repo worth graphing is routinely outside whatever root a
    # default could name.
    browse_start: Path = Path.home()

    # Files past this are scanned and counted but never parsed. Minified bundles
    # are the case that matters: one 619KB file in the first repo measured is a single line
    # and yields nothing but noise.
    max_parse_bytes: int = 1_000_000

    # Cap on what GET /api/file will return, so a generated file cannot wedge
    # the browser. The UI reports the truncation rather than hiding it.
    max_file_view_bytes: int = 400_000

    @field_validator("allowed_hosts", mode="before")
    @classmethod
    def _split_hosts(cls, value: object) -> object:
        if isinstance(value, str):
            return [name.strip() for name in value.split(",") if name.strip()]
        return value


settings = Settings()
