"""The extractor. Every case here is one that was wrong at some point."""

from reposhape.models import Language
from reposhape.parsing import parse_imports


def specs(path: str, language: Language, source: str) -> list[str]:
    return [raw.specifier for raw in parse_imports(path, language, source.encode())]


def test_captures_every_typescript_import_form():
    source = """
    import a from "./a";
    import { b } from "@/lib/b";
    import "./side-effect";
    export { d } from "../d";
    export * from "./e";
    const f = require("./f");
    const g = await import("./g");
    """
    assert set(specs("x.ts", "typescript", source)) == {
        "./a",
        "@/lib/b",
        "./side-effect",
        "../d",
        "./e",
        "./f",
        "./g",
    }


def test_a_plain_call_with_a_string_is_not_an_import():
    """The #eq? predicate on `require` is what makes this true.

    Without it every single-string call expression in the file matches, and the
    graph fills with edges to files nobody imported.
    """
    assert specs("x.ts", "typescript", 'foo("./not-an-import");') == []
    assert specs("x.ts", "typescript", 'describe("./looks-like-a-path", () => {});') == []


def test_type_only_imports_are_flagged_but_still_extracted():
    found = parse_imports(
        "x.ts",
        "typescript",
        b'import type { A } from "./a";\nimport { B } from "./b";\n',
    )
    by_spec = {raw.specifier: raw.type_only for raw in found}
    assert by_spec == {"./a": True, "./b": False}


def test_inline_type_specifier_is_not_a_type_only_statement():
    """`import { type A, B }` still creates a runtime edge through B."""
    found = parse_imports("x.ts", "typescript", b'import { type A, B } from "./a";')
    assert [raw.type_only for raw in found] == [False]


def test_tsx_parses_jsx_where_the_plain_grammar_would_not():
    source = 'import { C } from "./c";\nexport const V = () => <C attr="x" />;\n'
    assert specs("view.tsx", "typescript", source) == ["./c"]


def test_python_relative_import_of_a_sibling_names_the_sibling():
    """`from . import sibling` depends on sibling.py, not on the package.

    Capturing module_name alone records `.` and loses the edge entirely, which
    is why the Python path walks fields instead of using a query pattern.
    """
    assert specs("pkg/mod.py", "python", "from . import sibling\n") == [".sibling"]
    assert specs("pkg/mod.py", "python", "from .. import a, b\n") == ["..a", "..b"]


def test_python_import_forms():
    source = "import os\nimport os.path as p\nfrom .rel.mod import thing\nfrom pkg.sub import a\n"
    assert specs("m.py", "python", source) == ["os", "os.path", ".rel.mod", "pkg.sub"]


def test_python_wildcard_relative_import_falls_back_to_the_package():
    assert specs("pkg/m.py", "python", "from . import *\n") == ["."]


VUE_COMPONENT = """<template>
  <script-artifact-view :artifact="artifact" />
  <Card />
</template>

<script lang="ts">
import { defineComponent } from "vue";
import type { Shape } from "./shape";
</script>

<script setup lang="ts">
import Card from "@/components/Card.vue";
const Lazy = defineAsyncComponent(() => import("./Lazy.vue"));
</script>

<style>
@import "./theme.css";
</style>
"""


def test_vue_reads_both_script_blocks_and_nothing_else():
    """The template's `<script-artifact-view>` is a component, not a block, and
    the style's `@import` is not a module import."""
    assert specs("Panel.vue", "vue", VUE_COMPONENT) == [
        "vue",
        "./shape",
        "@/components/Card.vue",
        "./Lazy.vue",
    ]


def test_vue_lines_point_into_the_component_not_the_block():
    found = parse_imports("Panel.vue", "vue", VUE_COMPONENT.encode())
    lines = {raw.specifier: raw.line for raw in found}
    assert lines == {"vue": 7, "./shape": 8, "@/components/Card.vue": 12, "./Lazy.vue": 13}
    assert [raw.type_only for raw in found] == [False, True, False, False]


def test_vue_tsx_block_parses_jsx():
    source = (
        '<script setup lang="tsx">\nimport { C } from "./c";\nconst v = <C a="x" />;\n</script>\n'
    )
    assert specs("View.vue", "vue", source) == ["./c"]


def test_vue_with_no_script_has_no_imports():
    assert specs("Static.vue", "vue", "<template><p>hi</p></template>\n") == []
