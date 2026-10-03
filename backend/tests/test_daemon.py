"""The background server, with real processes: started, found again, replaced, stopped.

Every test runs against a state root and a port of its own (conftest isolates
the roots), so none of them can find or stop the owner's real server.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest

from reposhape import daemon, launching, web_bundle
from reposhape.configuration import settings
from reposhape.launching import LaunchError

HOST = "127.0.0.1"


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind((HOST, 0))
        return probe.getsockname()[1]


@pytest.fixture
def port() -> Iterator[int]:
    chosen = _free_port()
    yield chosen
    # Whatever a test left running is stopped, so a failure cannot leak a
    # server into the next test or past the run.
    try:
        daemon.stop()
    except LaunchError:
        registration = daemon.read()
        if registration is not None:
            os.kill(registration.pid, signal.SIGKILL)


def _registration_for(pid: int, port: int) -> daemon.Registration:
    return daemon.Registration(
        id=uuid.uuid4().hex,
        build=daemon.build_id(),
        url=f"http://{HOST}:{port}",
        pid=pid,
        cache_root=str(settings.cache_root),
        started_at=datetime.now(UTC),
    )


def test_ensure_starts_a_server_and_a_second_call_finds_the_same_one(port: int):
    url = daemon.ensure(HOST, port)
    first = daemon.read()
    assert first is not None
    assert url == first.url == f"http://{HOST}:{port}"
    health = launching.our_api_at(url)
    assert health is not None and health["pid"] == first.pid

    assert daemon.ensure(HOST, port) == url
    second = daemon.read()
    assert second is not None and second.pid == first.pid


def test_the_server_is_outside_the_terminals_session(port: int):
    """The point of the whole module: closing the pane must not take the page away.

    A terminal's hangup goes to the processes of its session. The server leads
    a session of its own, so it is not among them.
    """
    daemon.ensure(HOST, port)
    registration = daemon.read()
    assert registration is not None
    assert os.getsid(registration.pid) == registration.pid
    assert os.getsid(registration.pid) != os.getsid(0)


def test_a_server_running_another_build_is_replaced(port: int, monkeypatch: pytest.MonkeyPatch):
    daemon.ensure(HOST, port)
    old = daemon.read()
    assert old is not None

    monkeypatch.setattr(daemon, "build_id", lambda: "a-newer-install")
    assert daemon.ensure(HOST, port) == old.url
    new = daemon.read()
    assert new is not None and new.pid != old.pid
    assert not daemon._alive(old.pid)


def test_stop_ends_the_server_and_clears_its_registration(port: int):
    daemon.ensure(HOST, port)
    running = daemon.read()
    assert running is not None

    stopped = daemon.stop()
    assert stopped is not None and stopped.pid == running.pid
    assert not daemon._alive(running.pid)
    assert daemon.read() is None
    assert launching.our_api_at(running.url) is None
    assert daemon.stop() is None


def test_a_registration_left_by_a_dead_server_is_cleared(port: int):
    finished = subprocess.Popen(["true"])
    finished.wait()
    daemon._write(_registration_for(finished.pid, port))

    assert daemon.status() is None
    assert daemon.read() is None


def test_a_pid_the_server_does_not_answer_for_is_never_signalled(port: int):
    """A registration can outlive its process, and its pid can be reused by anything."""
    stranger = subprocess.Popen(["sleep", "30"])
    try:
        daemon._write(_registration_for(stranger.pid, port))
        assert daemon.stop() is None
        assert stranger.poll() is None
    finally:
        stranger.kill()
        stranger.wait()


def test_a_server_leaves_when_the_registration_names_another(port: int):
    """Two servers started in a race end as one, not as two that each think they are it."""
    daemon.ensure(HOST, port)
    running = daemon.read()
    assert running is not None

    daemon._write(running.model_copy(update={"id": uuid.uuid4().hex}))
    assert launching.wait_for(lambda: not daemon._alive(running.pid), daemon.WATCH_INTERVAL_S * 4)


def test_a_stranger_on_the_port_is_refused_loudly(port: int):
    with socket.socket() as squatter:
        squatter.bind((HOST, port))
        squatter.listen()
        with pytest.raises(LaunchError, match="not a reposhape server"):
            daemon.ensure(HOST, port)


def test_a_server_that_dies_on_startup_says_why(
    port: int, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """Its output goes to a log rather than nowhere, and the failure quotes it."""
    broken = tmp_path / "python"
    broken.write_text("#!/bin/sh\necho 'cannot import the app: boom' >&2\nexit 3\n")
    broken.chmod(0o755)
    monkeypatch.setattr(daemon.sys, "executable", str(broken))

    with pytest.raises(LaunchError, match="did not come up") as raised:
        daemon.ensure(HOST, port)
    assert "cannot import the app: boom" in str(raised.value)
    assert str(daemon.log_path()) in str(raised.value)
    assert daemon.read() is None


def test_the_build_moves_when_the_page_does(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """`just web-export` changes no version, and a server started before it is stale."""
    monkeypatch.setattr(web_bundle, "BUNDLE_DIR", tmp_path)
    (tmp_path / "index.html").write_text("<p>yesterday</p>")
    before = daemon.build_id()
    assert before == daemon.build_id()
    (tmp_path / "index.html").write_text("<p>today</p>")
    assert daemon.build_id() != before
