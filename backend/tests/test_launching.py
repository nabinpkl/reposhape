"""The parts of `reposhape up` that decide things, without starting any servers."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from reposhape import launching
from reposhape.configuration import settings


def test_a_subdirectory_resolves_to_the_repo_it_is_in(tmp_path: Path):
    """`reposhape up` run from `backend/` should graph the project, not `backend/`.

    Graphing the subdirectory silently produces a graph whose cross-directory
    edges are all unresolved, which reads as a broken parser.
    """
    root = tmp_path / "project"
    (root / "sub" / "deeper").mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(root)], check=True)

    assert launching.repo_root_of(root / "sub" / "deeper") == root.resolve()


def test_a_directory_outside_git_is_its_own_root(tmp_path: Path):
    loose = tmp_path / "loose"
    loose.mkdir()
    assert launching.repo_root_of(loose) == loose.resolve()


class _Response:
    def __init__(self, payload: object, status: int = 200):
        self.status = status
        self._body = json.dumps(payload).encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *_: object) -> None:
        return None


def _answer_with(monkeypatch: pytest.MonkeyPatch, payload: object, status: int = 200) -> None:
    monkeypatch.setattr(
        launching._direct, "open", lambda *_, **__: _Response(payload, status), raising=False
    )


def test_an_api_is_adopted_only_when_it_reads_this_cache(monkeypatch: pytest.MonkeyPatch):
    """The port answering is not evidence that it is answering for us.

    A second checkout of this project would also answer /api/health, and
    adopting it would serve repos this run never analysed, from a cache this
    run cannot write.
    """
    _answer_with(monkeypatch, {"status": "ok", "cache_root": str(settings.cache_root)})
    assert launching.our_api_at("http://127.0.0.1:7420") is not None

    _answer_with(monkeypatch, {"status": "ok", "cache_root": "/somewhere/else"})
    assert launching.our_api_at("http://127.0.0.1:7420") is None


def test_a_stranger_on_the_port_is_not_adopted(monkeypatch: pytest.MonkeyPatch):
    _answer_with(monkeypatch, {"hello": "i am something else"})
    assert launching.our_api_at("http://127.0.0.1:7420") is None

    _answer_with(monkeypatch, {"status": "ok", "cache_root": str(settings.cache_root)}, status=503)
    assert launching.our_api_at("http://127.0.0.1:7420") is None


def test_the_url_carries_the_repo(tmp_path: Path):
    from reposhape import cache

    key = cache.repo_key(tmp_path)
    assert launching.graph_url("http://localhost:3000", key) == f"http://localhost:3000/?repo={key}"
