import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

from reposhape.configuration import settings


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """No test ever writes to the real cache under ~/.cache."""
    root = tmp_path / "cache"
    monkeypatch.setattr(settings, "cache_root", root)
    return root


@pytest.fixture(autouse=True)
def isolated_clones(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """No test ever clones into the real clone root under ~/.local/share."""
    root = tmp_path / "clones"
    monkeypatch.setattr(settings, "clone_root", root)
    return root


@pytest.fixture(autouse=True)
def isolated_link_rules(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """No test ever reads the operator's rules under ~/.config."""
    root = tmp_path / "link-rules"
    monkeypatch.setattr(settings, "link_rules_dir", root)
    return root


@pytest.fixture(autouse=True)
def isolated_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """No test ever registers with, or stops, the real background server."""
    root = tmp_path / "state"
    monkeypatch.setattr(settings, "state_root", root)
    return root


@pytest.fixture(autouse=True)
def test_client_host(monkeypatch: pytest.MonkeyPatch) -> None:
    """TestClient sends `Host: testserver`; the API admits it like any configured name."""
    monkeypatch.setattr(settings, "allowed_hosts", [*settings.allowed_hosts, "testserver"])


@pytest.fixture
def origin_repo(sample_repo: Path) -> Path:
    """`sample_repo` as a git repository, so cloning can be tested off the network.

    `file://` is a real transport rather than a test seam: git treats it as one,
    `--depth` works over it, and cloning a local checkout is a use of its own.
    """
    run = lambda *args: subprocess.run(  # noqa: E731 - one line, three calls
        ["git", "-C", str(sample_repo), *args], check=True, capture_output=True
    )
    run("init", "-b", "main")
    run("-c", "user.name=t", "-c", "user.email=t@t", "add", "-A")
    run(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "first",
    )
    return sample_repo


@pytest.fixture
def commit_to() -> Callable[[Path, str, str], None]:
    """Write a file into a git repo and commit it. An upstream that moved."""

    def commit(repo: Path, name: str, text: str) -> None:
        target = repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        identity = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True, capture_output=True)
        subprocess.run(
            ["git", "-C", str(repo), *identity, "commit", "-m", name],
            check=True,
            capture_output=True,
        )

    return commit


@pytest.fixture
def sample_repo(tmp_path: Path) -> Path:
    """A miniature repo with both languages and the shapes that matter."""
    root = tmp_path / "repo"
    (root / "web" / "src" / "lib").mkdir(parents=True)
    (root / "service").mkdir(parents=True)

    (root / "web" / "tsconfig.json").write_text(
        '{\n  // aliases, with a comment\n  "compilerOptions": {\n'
        '    "paths": { "@/*": ["./src/*"] },\n  },\n}\n'
    )
    (root / "web" / "src" / "main.ts").write_text(
        'import { helper } from "@/lib/helper";\n'
        'import type { Shape } from "./shape";\n'
        'import "./main.css";\n'
        'import React from "react";\n'
        "export const run = () => helper();\n"
    )
    (root / "web" / "src" / "lib" / "helper.ts").write_text("export const helper = () => 1;\n")
    (root / "web" / "src" / "shape.ts").write_text("export type Shape = { a: number };\n")
    (root / "web" / "src" / "main.css").write_text("body { margin: 0; }\n")
    (root / "web" / "src" / "main.test.ts").write_text('import { run } from "./main";\nrun();\n')

    (root / "service" / "__init__.py").write_text("")
    (root / "service" / "app.py").write_text("from . import util\nimport os\n")
    (root / "service" / "util.py").write_text("VALUE = 1\n")
    return root
