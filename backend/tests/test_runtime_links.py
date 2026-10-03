"""Runtime links: the couplings the curated repos showed an import graph misses."""

from pathlib import Path

import pytest

from reposhape.analysis import analyze
from reposhape.runtime_links import LinkRules, load_rules, scan_file


def _keys(path: str, language, text: str, rules: LinkRules | None = None):
    found = scan_file(path, language, text.encode(), rules or LinkRules())
    return [(use.key, use.role, use.line) for use in found.uses], found


def test_hook_names_are_read_from_both_ends_through_a_private_alias():
    """hermes' shape: `invoke_hook as _invoke_hook`, the name on its own line."""
    uses, _ = _keys(
        "agent/loop.py",
        "python",
        "from x import invoke_hook as _invoke_hook\n_invoke_hook(\n    'pre_llm_call',\n    a=1)\n",
    )
    assert uses == [("pre_llm_call", "send", 3)]
    uses, _ = _keys("plugins/p.py", "python", 'ctx.register_hook("pre_llm_call", on_call)\n')
    assert uses == [("pre_llm_call", "receive", 1)]


def test_a_name_that_is_not_literal_is_counted_not_dropped():
    uses, found = _keys("a.py", "python", 'invoke_hook(name)\nemit(f"x_{y}")\n')
    assert uses == []
    assert found.dynamic == 2


def test_one_word_lowercase_names_are_stream_events_and_are_dropped():
    """`proc.on("exit")` would otherwise link every child process to every socket."""
    uses, found = _keys("a.ts", "typescript", 'proc.on("exit", f)\nbus.emit("session.idle")\n')
    assert uses == [("session.idle", "send", 2)]
    assert found.generic == 1


def test_typescript_reads_and_defines():
    """opencode's shape: the schema defines, the client switches on the string."""
    uses, _ = _keys(
        "schema/event.ts",
        "typescript",
        'export const S = Event.define({ type: "session.status", schema: {} })\n',
    )
    assert uses == [("session.status", "send", 1)]
    uses, _ = _keys(
        "app/reducer.ts",
        "typescript",
        'switch (e.type) {\n  case "session.status": break\n}\n'
        'if (e.type !== "session.idle") {}\n'
        'const mime = blob.type || "image/png"\n',
    )
    assert uses == [("session.status", "receive", 2), ("session.idle", "receive", 4)]


def test_a_python_module_started_as_a_program_is_read_from_its_argv():
    _, found = _keys(
        "ui/client.ts", "typescript", "spawn(python, ['-m', 'gateway.entry'], { cwd })\n"
    )
    assert found.modules == [(1, "gateway.entry")]
    _, found = _keys("run.py", "python", 'subprocess.run([sys.executable, "-m", "pkg.main"])\n')
    assert found.modules == [(1, "pkg.main")]


def _write(root: Path, relative: str, text: str = "") -> None:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


@pytest.fixture
def hooked_repo(tmp_path: Path) -> Path:
    root = tmp_path / "hooked"
    _write(
        root, "core/loop.py", 'from core.hooks import invoke_hook\ninvoke_hook("pre_llm_call")\n'
    )
    _write(root, "core/hooks.py", "def invoke_hook(name): ...\n")
    _write(
        root,
        "plugins/audit/__init__.py",
        'def register(ctx):\n    ctx.register_hook("pre_llm_call", f)\n',
    )
    _write(root, "gateway/entry.py", "")
    _write(root, "gateway/__init__.py", "")
    _write(root, "ui/client.ts", "spawn('python', ['-m', 'gateway.entry'])\n")
    _write(root, "tools/registry.py", "def discover_builtin_tools():\n    ...\n")
    _write(root, "tools/web.py", "registry.register('web')\n")
    _write(root, "tools/files.py", "")
    return root


def test_analysis_pairs_ends_and_resolves_programs(hooked_repo: Path):
    analysis = analyze(hooked_repo)
    links = {(link.kind, link.key, link.source, link.target) for link in analysis.links}
    assert ("event", "pre_llm_call", "core/loop.py", "plugins/audit/__init__.py") in links
    assert ("process", "gateway.entry", "ui/client.ts", "gateway/entry.py") in links
    assert not any(kind == "loader" for kind, *_ in links)
    assert analysis.link_stats is not None
    assert analysis.link_stats.keys_paired == 1


def test_a_rules_file_adds_loader_links_and_reports_what_it_could_not_match(
    hooked_repo: Path, isolated_link_rules: Path
):
    _write(
        isolated_link_rules,
        "hooked.toml",
        '[[loader]]\nloader = "tools/registry.py"\nanchor = "def discover_builtin_tools"\n'
        'files = ["tools/*.py"]\nexclude = ["tools/files.py"]\n\n'
        '[[loader]]\nloader = "tools/registry.py"\nfiles = ["skills/**/*.py"]\n\n'
        '[[loader]]\nloader = "gone.py"\nfiles = ["tools/*.py"]\n',
    )
    analysis = analyze(hooked_repo)
    loaders = [link for link in analysis.links if link.kind == "loader"]
    assert [(link.source, link.source_line, link.target) for link in loaders] == [
        ("tools/registry.py", 1, "tools/web.py")
    ]
    assert analysis.link_stats is not None
    assert analysis.link_stats.problems == [
        "loader tools/registry.py: skills/**/*.py matches no file",
        "loader gone.py is not a scanned file",
    ]


def test_an_unreadable_rules_file_is_a_problem_not_a_crash(tmp_path: Path):
    path = tmp_path / "bad.toml"
    path.write_text("[[loader]\n")
    rules = load_rules(path)
    assert rules.loaders == ()
    assert rules.problems and rules.problems[0].startswith("bad.toml: unreadable")


def test_the_view_carries_visible_links_and_the_file_route_carries_all(hooked_repo: Path):
    from fastapi.testclient import TestClient

    from reposhape.api import create_app

    client = TestClient(create_app(read_only=False))
    key = client.post("/api/analyze", json={"repo_path": str(hooked_repo)}).json()["key"]

    view = client.get(f"/api/graph/{key}").json()
    assert view["stats"]["visible_links"] == view["stats"]["total_links"] == 2

    hidden = client.get(f"/api/graph/{key}", params={"exclude": ["plugins"]}).json()
    assert hidden["stats"]["visible_links"] == 1

    # The pane asks about a file whose other end the filter hides; it still gets the link.
    public = TestClient(create_app(read_only=True))
    links = public.get(f"/api/links/{key}", params={"path": "core/loop.py"}).json()
    assert [(link["key"], link["target"]) for link in links] == [
        ("pre_llm_call", "plugins/audit/__init__.py")
    ]
    assert public.get(f"/api/links/{key}", params={"path": "../x"}).status_code == 404


def test_the_file_route_leaves_test_ends_out_unless_asked(hooked_repo: Path):
    from fastapi.testclient import TestClient

    from reposhape.api import create_app

    _write(hooked_repo, "tests/test_hooks.py", 'invoke_hook("pre_llm_call")\n')
    client = TestClient(create_app(read_only=False))
    key = client.post("/api/analyze", json={"repo_path": str(hooked_repo)}).json()["key"]
    path = {"path": "plugins/audit/__init__.py"}
    sources = lambda **extra: [  # noqa: E731 - two calls
        link["source"] for link in client.get(f"/api/links/{key}", params=path | extra).json()
    ]
    assert sources() == ["core/loop.py"]
    assert sources(include_tests=True) == ["core/loop.py", "tests/test_hooks.py"]
