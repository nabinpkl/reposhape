"""Resolution, and the two traps measured in a real monorepo before it was written."""

import json
from pathlib import Path

import pytest

from reposhape.resolution import PythonResolver, TypescriptResolver, strip_jsonc


def test_strip_jsonc_removes_comments():
    assert json.loads(strip_jsonc('{"a": 1 /* note */, // trailing\n "b": 2}')) == {"a": 1, "b": 2}


def test_strip_jsonc_leaves_comment_markers_inside_strings_alone():
    """A URL contains `//`. Stripping it with a regex over the document eats it."""
    text = '{"url": "https://example.com/x", "b": 2}'
    assert json.loads(strip_jsonc(text))["url"] == "https://example.com/x"


def test_strip_jsonc_removes_trailing_commas():
    assert json.loads(strip_jsonc('{"a": [1, 2,], }')) == {"a": [1, 2]}


@pytest.fixture
def two_project_repo(tmp_path: Path) -> Path:
    """Two projects, each with its own `@/*`, which is a common monorepo shape."""
    for project in ("app", "service"):
        source = tmp_path / project / "src"
        source.mkdir(parents=True)
        (source / "target.ts").write_text("export const x = 1;\n")
        (tmp_path / project / "tsconfig.json").write_text(
            "{\n"
            "  // a comment, because every real tsconfig here has them\n"
            '  "compilerOptions": {\n'
            '    "paths": { "@/*": ["./src/*"], "@repo/*": ["../*"] },\n'
            "  },\n"
            "}\n"
        )
    (tmp_path / "shared").mkdir()
    (tmp_path / "shared" / "util.ts").write_text("export const u = 1;\n")
    return tmp_path


def _resolver(root: Path) -> TypescriptResolver:
    files = frozenset(p.relative_to(root).as_posix() for p in root.rglob("*.ts") if p.is_file())
    return TypescriptResolver(root, files)


def test_same_alias_resolves_to_a_different_file_per_project(two_project_repo: Path):
    """The trap: a merged alias map sends both `@/target` to the same file."""
    resolver = _resolver(two_project_repo)
    assert resolver.resolve("app/src/entry.ts", "@/target") == "app/src/target.ts"
    assert resolver.resolve("service/src/entry.ts", "@/target") == "service/src/target.ts"


def test_repo_alias_resolves_relative_to_its_own_tsconfig(two_project_repo: Path):
    resolver = _resolver(two_project_repo)
    assert resolver.resolve("app/src/entry.ts", "@repo/shared/util") == "shared/util.ts"


def test_a_tsconfig_extends_out_of_the_repo_is_not_read(tmp_path: Path):
    """The repo is someone else's; its config does not get to name host files."""
    root = tmp_path / "repo"
    (root / "src").mkdir(parents=True)
    (root / "src" / "thing.ts").write_text("")
    (tmp_path / "host.json").write_text('{"compilerOptions": {"paths": {"x/*": ["./src/*"]}}}')
    (root / "tsconfig.json").write_text('{"extends": "../host.json"}')
    resolver = TypescriptResolver(root, frozenset({"main.ts", "src/thing.ts"}))
    assert resolver.resolve("main.ts", "x/thing") == "external_package"

    (root / "base.json").write_text('{"compilerOptions": {"paths": {"x/*": ["./src/*"]}}}')
    (root / "tsconfig.json").write_text('{"extends": "./base.json"}')
    resolver = TypescriptResolver(root, frozenset({"main.ts", "src/thing.ts"}))
    assert resolver.resolve("main.ts", "x/thing") == "src/thing.ts"


def test_relative_import_probes_extensions_and_index(tmp_path: Path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "index.ts").write_text("")
    (tmp_path / "b.tsx").write_text("")
    resolver = TypescriptResolver(tmp_path, frozenset({"a/index.ts", "b.tsx", "main.ts"}))
    assert resolver.resolve("main.ts", "./a") == "a/index.ts"
    assert resolver.resolve("main.ts", "./b") == "b.tsx"


def test_emitted_js_extension_resolves_to_its_typescript_source(tmp_path: Path):
    """NodeNext writes `./a.js` meaning `./a.ts`."""
    resolver = TypescriptResolver(tmp_path, frozenset({"a.ts", "main.ts"}))
    assert resolver.resolve("main.ts", "./a.js") == "a.ts"


def test_a_package_is_external_and_a_missing_relative_file_is_not(tmp_path: Path):
    resolver = TypescriptResolver(tmp_path, frozenset({"main.ts"}))
    assert resolver.resolve("main.ts", "react") == "external_package"
    assert resolver.resolve("main.ts", "./gone") == "no_matching_file"


def test_stylesheets_and_json_are_assets_not_failures(tmp_path: Path):
    """17 of the first 18 'unresolved' imports in a real repo were these."""
    resolver = TypescriptResolver(tmp_path, frozenset({"main.ts"}))
    assert resolver.resolve("main.ts", "./styles.css") == "asset"
    assert resolver.resolve("main.ts", "@repo/wire/fixture.json") == "asset"
    python = PythonResolver(tmp_path, frozenset({"m.py"}))
    assert python.resolve("m.py", "./schema.proto") == "asset"


def test_python_relative_depth(tmp_path: Path):
    files = frozenset({"pkg/sub/mod.py", "pkg/sibling.py", "pkg/sub/near.py", "top.py"})
    resolver = PythonResolver(tmp_path, files)
    assert resolver.resolve("pkg/sub/mod.py", ".near") == "pkg/sub/near.py"
    assert resolver.resolve("pkg/sub/mod.py", "..sibling") == "pkg/sibling.py"


def test_python_absolute_import_resolves_through_a_src_layout(tmp_path: Path):
    files = frozenset({"backend/src/app/thing.py", "backend/src/app/__init__.py"})
    resolver = PythonResolver(tmp_path, files)
    assert resolver.resolve("backend/src/app/other.py", "app.thing") == "backend/src/app/thing.py"


def test_python_stdlib_is_external(tmp_path: Path):
    resolver = PythonResolver(tmp_path, frozenset({"m.py"}))
    assert resolver.resolve("m.py", "os.path") == "external_package"


def _write(root: Path, relative: str, text: str = "") -> None:
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def test_python_monorepo_package_resolves_through_its_own_pyproject(tmp_path: Path):
    """langchain's shape: each package beside its pyproject, no `src/` anywhere."""
    _write(tmp_path, "libs/core/pyproject.toml", '[project]\nname = "langchain-core"\n')
    _write(
        tmp_path, "libs/partners/openai/pyproject.toml", '[project]\nname = "langchain-openai"\n'
    )
    files = frozenset(
        {
            "libs/core/langchain_core/messages.py",
            "libs/partners/openai/langchain_openai/chat.py",
        }
    )
    resolver = PythonResolver(tmp_path, files)
    assert (
        resolver.resolve("libs/partners/openai/langchain_openai/chat.py", "langchain_core.messages")
        == "libs/core/langchain_core/messages.py"
    )


def test_python_same_named_directory_in_another_package_is_not_the_match(tmp_path: Path):
    """Two projects, both with `tests/unit.py`. Each means its own."""
    _write(tmp_path, "libs/a/pyproject.toml", '[project]\nname = "a"\n')
    _write(tmp_path, "libs/b/pyproject.toml", '[project]\nname = "b"\n')
    files = frozenset({"libs/a/tests/unit.py", "libs/b/tests/unit.py", "libs/b/pkg/use.py"})
    resolver = PythonResolver(tmp_path, files)
    assert resolver.resolve("libs/b/pkg/use.py", "tests.unit") == "libs/b/tests/unit.py"


def test_python_hatch_packages_key_names_the_root_above_the_package(tmp_path: Path):
    _write(
        tmp_path,
        "project/pyproject.toml",
        '[tool.hatch.build.targets.wheel]\npackages = ["lib/thing"]\n',
    )
    files = frozenset({"project/lib/thing/mod.py", "project/other.py"})
    resolver = PythonResolver(tmp_path, files)
    assert resolver.resolve("project/other.py", "thing.mod") == "project/lib/thing/mod.py"


def test_python_setuptools_and_poetry_src_declarations_are_roots(tmp_path: Path):
    _write(tmp_path, "a/pyproject.toml", '[tool.setuptools]\npackage-dir = {"" = "lib"}\n')
    _write(
        tmp_path,
        "b/pyproject.toml",
        '[tool.poetry]\npackages = [{include = "pkg", from = "lib"}]\n',
    )
    files = frozenset({"a/lib/pkg/mod.py", "b/lib/pkg/other.py", "top.py"})
    resolver = PythonResolver(tmp_path, files)
    assert resolver.resolve("a/lib/pkg/other.py", "pkg.mod") == "a/lib/pkg/mod.py"
    assert resolver.resolve("b/lib/pkg/mod.py", "pkg.other") == "b/lib/pkg/other.py"


def test_python_unparseable_pyproject_still_leaves_its_directory_a_root(tmp_path: Path):
    """A broken manifest costs the non-default layouts, not the whole repo."""
    _write(tmp_path, "project/pyproject.toml", "this is not = = toml [\n")
    files = frozenset({"project/pkg/mod.py", "project/pkg/use.py"})
    resolver = PythonResolver(tmp_path, files)
    assert resolver.resolve("project/pkg/use.py", "pkg.mod") == "project/pkg/mod.py"


def test_python_import_of_a_package_not_in_the_repo_is_still_external(tmp_path: Path):
    _write(tmp_path, "libs/core/pyproject.toml", '[project]\nname = "core"\n')
    resolver = PythonResolver(tmp_path, frozenset({"libs/core/pkg/mod.py"}))
    assert resolver.resolve("libs/core/pkg/mod.py", "pydantic.fields") == "external_package"


def _workspace_resolver(root: Path) -> TypescriptResolver:
    files = frozenset(
        p.relative_to(root).as_posix()
        for p in root.rglob("*")
        if p.is_file() and p.suffix in {".ts", ".tsx", ".js"}
    )
    return TypescriptResolver(root, files)


@pytest.fixture
def bun_workspace(tmp_path: Path) -> Path:
    """opencode's shape: `workspaces: {packages}`, packages exported by pattern."""
    _write(tmp_path, "package.json", json.dumps({"workspaces": {"packages": ["packages/*"]}}))
    _write(
        tmp_path,
        "packages/core/package.json",
        json.dumps(
            {
                "name": "@acme/core",
                "exports": {
                    "./session/runner": "./src/session/runner/index.ts",
                    "./*": "./src/*.ts",
                },
            }
        ),
    )
    _write(tmp_path, "packages/core/src/provider.ts")
    _write(tmp_path, "packages/core/src/session/runner/index.ts")
    _write(tmp_path, "packages/app/package.json", json.dumps({"name": "@acme/app"}))
    _write(tmp_path, "packages/app/src/main.ts")
    return tmp_path


def test_a_workspace_package_resolves_through_its_exports_map(bun_workspace: Path):
    """The drop this ends: every `@opencode-ai/*` import was counted as an npm package."""
    resolver = _workspace_resolver(bun_workspace)
    main = "packages/app/src/main.ts"
    assert resolver.resolve(main, "@acme/core/provider") == "packages/core/src/provider.ts"
    assert (
        resolver.resolve(main, "@acme/core/session/runner")
        == "packages/core/src/session/runner/index.ts"
    )


def test_a_declared_package_that_lands_nowhere_is_unresolved_not_external(bun_workspace: Path):
    resolver = _workspace_resolver(bun_workspace)
    main = "packages/app/src/main.ts"
    assert resolver.resolve(main, "@acme/core/gone") == "no_matching_file"
    # No "." key: Node refuses the bare name, so it is not quietly the package root.
    assert resolver.resolve(main, "@acme/core") == "no_matching_file"
    assert resolver.resolve(main, "@acme/other") == "external_package"


def test_conditions_are_tried_in_order_until_one_lands_on_source(tmp_path: Path):
    _write(tmp_path, "package.json", json.dumps({"workspaces": ["libs/*"]}))
    _write(
        tmp_path,
        "libs/sdk/package.json",
        json.dumps(
            {
                "name": "sdk",
                "exports": {
                    ".": {
                        "types": "./dist/index.d.ts",
                        "import": "./dist/index.js",
                        "bun": "./src/index.ts",
                    },
                    "./styles": "./src/styles.css",
                },
            }
        ),
    )
    _write(tmp_path, "libs/sdk/src/index.ts")
    _write(tmp_path, "app/main.ts")
    resolver = _workspace_resolver(tmp_path)
    assert resolver.resolve("app/main.ts", "sdk") == "libs/sdk/src/index.ts"
    assert resolver.resolve("app/main.ts", "sdk/styles") == "asset"


def test_pnpm_workspace_file_and_a_package_without_exports(tmp_path: Path):
    """A pnpm workspace's shape: pnpm reads its own file and ignores `workspaces`."""
    _write(
        tmp_path,
        "pnpm-workspace.yaml",
        "packages:\n  - frontend\n  # a comment\n  - 'tools/*'\n  - '!tools/fixture'\n"
        "catalog:\n  - not-a-glob\n",
    )
    _write(
        tmp_path, "tools/wire/package.json", json.dumps({"name": "wire", "main": "./lib/entry.ts"})
    )
    _write(tmp_path, "tools/wire/lib/entry.ts")
    _write(tmp_path, "tools/wire/lib/codec.ts")
    _write(tmp_path, "tools/fixture/package.json", json.dumps({"name": "fixture"}))
    _write(tmp_path, "tools/fixture/index.ts")
    _write(tmp_path, "frontend/main.ts")
    resolver = _workspace_resolver(tmp_path)
    assert resolver.resolve("frontend/main.ts", "wire") == "tools/wire/lib/entry.ts"
    assert resolver.resolve("frontend/main.ts", "wire/lib/codec") == "tools/wire/lib/codec.ts"
    assert resolver.resolve("frontend/main.ts", "fixture") == "external_package"


def test_a_name_two_workspace_packages_claim_is_unresolved(tmp_path: Path):
    _write(tmp_path, "package.json", json.dumps({"workspaces": ["a", "b"]}))
    for directory in ("a", "b"):
        _write(tmp_path, f"{directory}/package.json", json.dumps({"name": "twin"}))
        _write(tmp_path, f"{directory}/index.ts")
    _write(tmp_path, "main.ts")
    assert _workspace_resolver(tmp_path).resolve("main.ts", "twin") == "no_matching_file"


def test_emitted_jsx_extension_resolves_to_its_tsx_source(tmp_path: Path):
    resolver = TypescriptResolver(tmp_path, frozenset({"Invite.tsx", "main.ts"}))
    assert resolver.resolve("main.ts", "./Invite.jsx") == "Invite.tsx"
