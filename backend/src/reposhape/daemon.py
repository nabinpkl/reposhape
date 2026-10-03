"""The background server: one per machine and cache, outliving the terminal that started it.

`reposhape up` used to run the server on a thread of its own process, so closing the
terminal took the page away from every tab that had it open. Now `reposhape up` makes
sure a server is running and returns, the way opencode's CLI does: the server
is a separate process in its own session, found again through a registration
file under `state_root` (ADR-0010).

Three things here are less obvious than they look:

* **A registration is a claim, and claims are checked.** The file names a pid,
  and a pid outlives the process it named: after a crash or a reboot it can
  belong to anything. Nothing here signals a pid until the server at the
  registered URL answers `/api/health` with that same pid.
* **One registration, one server.** A server re-reads the file every few
  seconds and leaves if the file names another server, so two servers started
  in a race end as one rather than as two that each believe they are it.
* **The build is part of the identity.** A server started before a reinstall,
  or before an edit to this package in a checkout, is still serving the old
  code. `ensure` compares builds and replaces a stale server rather than
  handing its URL out.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.metadata
import os
import signal
import socket
import subprocess
import sys
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import uvicorn
from pydantic import BaseModel, ValidationError

from reposhape import launching, web_bundle
from reposhape.configuration import settings
from reposhape.launching import LaunchError

# How long a stopped server gets to finish its requests before it is killed.
STOP_TIMEOUT_S = 5.0

# How often a server checks that the registration still names it. Seconds of
# a duplicate server is harmless; the check is one small file read.
WATCH_INTERVAL_S = 2.0

# Lines of the server's log quoted when it fails to come up.
_LOG_TAIL_LINES = 20

_PACKAGE_DIR = Path(__file__).resolve().parent


class Registration(BaseModel):
    """What a running server says about itself, in `state_root/server.json`."""

    id: str
    build: str
    url: str
    pid: int
    cache_root: str
    started_at: datetime


def registration_path() -> Path:
    return settings.state_root / "server.json"


def log_path() -> Path:
    return settings.state_root / "server.log"


def build_id() -> str:
    """This install's code and page, as one string that changes when either does.

    The version alone does not move in a checkout, where the package is
    installed editable and edited in place, and `just web-export` replaces the
    page without touching it. So the version is joined to a digest of the
    package's own modules and the page's entry file.
    """
    digest = hashlib.sha256()
    for module in sorted(_PACKAGE_DIR.glob("*.py")):
        digest.update(module.name.encode())
        digest.update(module.read_bytes())
    page = web_bundle.BUNDLE_DIR / "index.html"
    if page.is_file():
        digest.update(page.read_bytes())
    return f"{importlib.metadata.version('reposhape')}+{digest.hexdigest()[:12]}"


def read() -> Registration | None:
    """The registration on disk, or None when there is none.

    A file that does not parse is treated as none: it is written by rename, so
    it is never half-written, and one in an older shape names a server this
    code could not have started.
    """
    try:
        return Registration.model_validate_json(registration_path().read_bytes())
    except FileNotFoundError:
        return None
    except ValidationError, ValueError:
        return None


def _write(registration: Registration) -> None:
    """Atomically, and readable only by this user: it names a process to signal."""
    settings.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = registration_path()
    temporary = target.with_name(f".{target.name}.{registration.id}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(registration.model_dump_json())
    temporary.replace(target)


def _remove_if(predicate: Callable[[Registration], bool]) -> None:
    """Remove the registration, but only if it still is the one `predicate` accepts."""
    current = read()
    if current is not None and predicate(current):
        registration_path().unlink(missing_ok=True)


def _answering(registration: Registration) -> dict[str, object] | None:
    """The server's health payload, if the registered URL answers as the registered process."""
    payload = launching.our_api_at(registration.url)
    if payload is None or payload.get("pid") != registration.pid:
        return None
    return payload


def _alive(pid: int) -> bool:
    """Whether `pid` is a live process, reaping it first when it is our own child.

    A child that exited stays a zombie until its parent waits on it, and a
    zombie still answers `kill(pid, 0)`. `reposhape up` never waits on the server it
    starts, but a test that starts one in-process would see every stopped
    server as still running.
    """
    with contextlib.suppress(ChildProcessError):
        finished, _ = os.waitpid(pid, os.WNOHANG)
        if finished == pid:
            return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def status() -> Registration | None:
    """The running server, or None. A registration nothing answers for is cleared."""
    registration = read()
    if registration is None:
        return None
    if _answering(registration) is None:
        _remove_if(lambda current: current.id == registration.id)
        return None
    return registration


def stop() -> Registration | None:
    """Stop the registered server. Returns what was stopped, or None if nothing was running.

    The pid is signalled only after the server at the registered URL has
    answered with it, and SIGKILL only if it still does after
    `STOP_TIMEOUT_S`, because a registration can outlive its process and its
    pid can be reused by an unrelated one.
    """
    registration = status()
    if registration is None:
        return None
    os.kill(registration.pid, signal.SIGTERM)
    if not launching.wait_for(lambda: not _alive(registration.pid), STOP_TIMEOUT_S):
        if _answering(registration) is not None:
            os.kill(registration.pid, signal.SIGKILL)
        if not launching.wait_for(lambda: not _alive(registration.pid), STOP_TIMEOUT_S):
            raise LaunchError(f"the server (pid {registration.pid}) did not stop")
    _remove_if(lambda current: current.id == registration.id)
    return registration


def ensure(host: str, port: int) -> str:
    """The URL of a server running this build at `host:port`, starting one if needed."""
    origin = f"http://{host}:{port}"
    registration = read()
    if registration is not None:
        payload = _answering(registration)
        if payload is None:
            _remove_if(lambda current: current.id == registration.id)
        elif registration.url == origin and payload.get("build") == build_id():
            return origin
        else:
            # Another build, or another port than the one asked for: replaced,
            # because handing out its URL would serve code or a page this
            # install no longer has.
            stop()

    if launching.port_in_use(host, port):
        # A server nobody registered: `reposhape serve`, or `just serve` with reload,
        # run by hand. It reads this cache, so its URL is as good as ours, and
        # stopping a process this command did not start is not its call.
        if launching.our_api_at(origin) is not None:
            return origin
        raise LaunchError(
            f"port {port} is held by something that is not a reposhape server. "
            "Pass --port to use another."
        )
    return _start(host, port, origin)


def _settings_environment() -> dict[str, str]:
    """This process's settings, as the environment the server will read them from.

    The server must serve the cache and roots this CLI resolved, whatever
    mixture of defaults and environment produced them. Passing every setting
    explicitly is what makes that true rather than likely.
    """
    environment = dict(os.environ)
    for name, value in settings.model_dump().items():
        rendered = ",".join(value) if isinstance(value, list) else str(value)
        environment[f"REPOSHAPE_{name.upper()}"] = rendered
    return environment


def _start(host: str, port: int, origin: str) -> str:
    settings.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    log = log_path()
    with log.open("ab") as output:
        output.write(f"\n--- starting {origin} at {datetime.now(UTC).isoformat()}\n".encode())
        output.flush()
        # Its own session, so the terminal closing, or a Ctrl-C in it, never
        # reaches the server. Its working directory is the state root, so it
        # never holds open a directory the owner may delete, such as the repo
        # `reposhape up` was run in.
        process = subprocess.Popen(
            [
                sys.executable,
                *("-m", "reposhape", "serve", "--register"),
                *("--host", host, "--port", str(port)),
            ],
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            cwd=settings.state_root,
            env=_settings_environment(),
            start_new_session=True,
        )

    def registered_and_answering() -> bool:
        registration = read()
        return (
            registration is not None
            and registration.pid == process.pid
            and _answering(registration) is not None
        )

    if not launching.wait_for(
        registered_and_answering,
        launching.API_READY_TIMEOUT_S,
        still_alive=lambda: process.poll() is None,
    ):
        if process.poll() is None:
            process.kill()
            process.wait()
        raise LaunchError(
            f"the server did not come up on {origin}. Its log ({log}) ends:\n{_tail(log)}"
        )
    return origin


def _tail(path: Path) -> str:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError as error:
        return f"(could not read it: {error})"
    return "\n".join(lines[-_LOG_TAIL_LINES:])


class _RegisteredServer(uvicorn.Server):
    """uvicorn, registering itself once it is listening and leaving when replaced."""

    def __init__(self, config: uvicorn.Config, registration: Registration) -> None:
        super().__init__(config)
        self._registration = registration
        self._ticks_per_watch = max(1, int(WATCH_INTERVAL_S / 0.1))

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets)
        # Written only once the socket is bound, so a registration always
        # names a server that can answer. A failed bind leaves `started`
        # false and uvicorn exits.
        if self.started:
            _write(self._registration)

    async def on_tick(self, counter: int) -> bool:
        if counter % self._ticks_per_watch == 0 and self.started:
            current = read()
            if current is None or current.id != self._registration.id:
                self.should_exit = True
        return await super().on_tick(counter)

    async def shutdown(self, sockets: list[socket.socket] | None = None) -> None:
        _remove_if(lambda current: current.id == self._registration.id)
        await super().shutdown(sockets)


def serve_registered(host: str, port: int) -> None:
    """Run the server in the foreground as the registered one. What `reposhape up` spawns."""
    registration = Registration(
        id=uuid.uuid4().hex,
        build=build_id(),
        url=f"http://{host}:{port}",
        pid=os.getpid(),
        cache_root=str(settings.cache_root),
        started_at=datetime.now(UTC),
    )
    config = uvicorn.Config("reposhape.api:app", host=host, port=port, log_level="warning")
    _RegisteredServer(config, registration).run()
