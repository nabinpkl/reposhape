"""What `reposhape up` decides before it opens a URL: which repo, which port, whose server.

`reposhape up` exists because the tool is useless as several commands. The analysis
and the page over it are one act from the owner's side, and a daily tool that
asks for extra terminals is a tool that gets regenerated as a throwaway HTML
file instead. The server itself runs in the background (`daemon.py`); this
module holds the probes and the small decisions around it.

Two things here are less obvious than they look:

* **The port is probed, not assumed.** A port already answering our own
  `/api/health` is used rather than fought over. A port held by something else
  fails loudly and names the flag, because silently sliding to another port
  means the URL printed here and the URL the last run printed are different
  pages and nothing says so.
* **Every probe here bypasses the HTTP proxy.** A machine that exports
  `HTTP_PROXY` has `urllib` honour it for `http://` URLs, so a health check on
  127.0.0.1 would otherwise be answered by the proxy rather than by uvicorn.
"""

from __future__ import annotations

import json
import socket
import subprocess
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path

from reposhape.configuration import settings

# Requests to loopback must not go through the machine's proxy. An opener with
# an empty ProxyHandler is the only way to say that; `urlopen` uses the
# environment's.
_direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))

API_READY_TIMEOUT_S = 20.0


class LaunchError(Exception):
    """Something the owner has to fix before `reposhape up` can work."""


def _get(url: str, timeout: float) -> tuple[int, bytes] | None:
    try:
        with _direct.open(url, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, b""
    except urllib.error.URLError, OSError, TimeoutError:
        return None


def port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        return probe.connect_ex((host, port)) == 0


def our_api_at(origin: str, timeout: float = 1.0) -> dict[str, object] | None:
    """Identify a reposhape API by its health payload, not by its port.

    The cache root is in the answer on purpose: two checkouts of this project
    would both answer `/api/health`, and reusing one that reads a different
    cache would serve repos this run never analysed.
    """
    answer = _get(f"{origin}/api/health", timeout)
    if answer is None or answer[0] != 200:
        return None
    try:
        payload = json.loads(answer[1])
    except ValueError:
        return None
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        return None
    if payload.get("cache_root") != str(settings.cache_root):
        return None
    return payload


def wait_for(
    check: Callable[[], bool],
    timeout: float,
    still_alive: Callable[[], bool] = lambda: True,
) -> bool:
    """Poll until `check` passes, giving up early if the thing being waited on died."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not still_alive():
            return False
        if check():
            return True
        time.sleep(0.25)
    return False


def graph_url(origin: str, key: str) -> str:
    return f"{origin}/?repo={key}"


def picker_url(origin: str) -> str:
    """The page with no repo chosen, which opens on the picker."""
    return f"{origin}/"


def repo_root_of(path: Path) -> Path:
    """The git root containing `path`, or `path` itself when it is not a checkout.

    Running `reposhape up` from a subdirectory should graph the project, not the
    subdirectory: the former is what the owner means and the latter silently
    produces a graph with every cross-directory edge unresolved.
    """
    resolved = path.expanduser().resolve()
    result = subprocess.run(
        ["git", "-C", str(resolved), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return resolved
    return Path(result.stdout.strip())
