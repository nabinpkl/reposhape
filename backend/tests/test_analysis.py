"""End to end: a repo on disk becomes the artifact the server reads."""

from pathlib import Path

from reposhape import cache
from reposhape.analysis import analyze
from reposhape.graphing import build_view
from reposhape.models import Analysis


def test_analysis_of_a_mixed_repo(sample_repo: Path):
    result = analyze(sample_repo)
    paths = {node.path for node in result.files}
    assert "web/src/main.ts" in paths
    assert "service/app.py" in paths
    # A .css file is imported but is not a code node.
    assert "web/src/main.css" not in paths

    edges = {(edge.source, edge.target) for edge in result.edges}
    assert ("web/src/main.ts", "web/src/lib/helper.ts") in edges
    assert ("web/src/main.ts", "web/src/shape.ts") in edges
    assert ("service/app.py", "service/util.py") in edges
    assert ("web/src/main.test.ts", "web/src/main.ts") in edges


def test_packages_assets_and_failures_are_three_different_things(sample_repo: Path):
    result = analyze(sample_repo)
    assert result.external == {"react": 1, "os": 1}
    assert result.assets == {"./main.css": 1}
    assert result.unresolved == []


def test_the_type_only_edge_is_marked(sample_repo: Path):
    result = analyze(sample_repo)
    shape = next(e for e in result.edges if e.target == "web/src/shape.ts")
    helper = next(e for e in result.edges if e.target == "web/src/lib/helper.ts")
    assert shape.type_only
    assert not helper.type_only


def test_dropping_type_only_edges_removes_that_edge(sample_repo: Path):
    result = analyze(sample_repo)
    kept = build_view(result, include_type_only=False)
    assert all(edge.target != "web/src/shape.ts" for edge in kept.edges)


def test_the_artifact_survives_a_round_trip_through_disk(sample_repo: Path):
    written = cache.write(analyze(sample_repo))
    restored = cache.read(written)
    assert isinstance(restored, Analysis)
    assert restored.model_dump() == cache.read(written).model_dump()
    assert [row.repo_path for row in cache.summaries()] == [str(sample_repo.resolve())]


def test_a_repo_that_is_not_a_directory_fails_loudly(tmp_path: Path):
    missing = tmp_path / "nope"
    try:
        analyze(missing)
    except NotADirectoryError:
        return
    raise AssertionError("analysing a missing path should raise, not return an empty graph")


def test_a_stale_artifact_says_so_rather_than_reading_as_absent(sample_repo, tmp_path):
    """A schema bump and an empty cache are different facts.

    Returning None for both makes a bump look like "never analysed", which
    sends you to run an analysis that then appears not to have worked.
    """
    import json

    from reposhape.cache import StaleArtifactError, analysis_path

    cache.write(analyze(sample_repo))
    target = analysis_path(sample_repo)
    payload = json.loads(target.read_text())
    payload["schema_version"] = 0
    del payload["stats"]["edges"]
    target.write_text(json.dumps(payload))

    try:
        cache.load(sample_repo)
    except StaleArtifactError as error:
        assert "schema 0" in str(error)
        return
    raise AssertionError("a stale artifact must raise, not return None")


def test_an_older_artifact_is_stale_even_when_it_still_parses(sample_repo):
    """Unknown fields are ignored, so an old file can fit the current models.

    Without the version check a schema bump would retire nothing: the old
    artifact would keep being served as if this build had written it.
    """
    import json

    from reposhape.cache import StaleArtifactError, analysis_path

    cache.write(analyze(sample_repo))
    target = analysis_path(sample_repo)
    payload = json.loads(target.read_text())
    payload["schema_version"] = 4
    payload["source"] = "imports"
    target.write_text(json.dumps(payload))

    try:
        cache.load(sample_repo)
    except StaleArtifactError as error:
        assert "schema 4" in str(error)
        return
    raise AssertionError("an older schema_version must raise, whatever the shape")


def test_vue_components_are_nodes_and_edges_in_both_directions(tmp_path: Path):
    """A `.ts` importing a `.vue` was reported as a broken import before `.vue`
    was scanned, which is the wrong fact: the file was there."""
    root = tmp_path / "vue-app"
    (root / "src" / "components").mkdir(parents=True)
    (root / "tsconfig.json").write_text('{"compilerOptions": {"paths": {"@/*": ["./src/*"]}}}')
    (root / "src" / "main.ts").write_text('import App from "./App.vue";\n')
    (root / "src" / "App.vue").write_text(
        '<script setup lang="ts">\nimport Card from "@/components/Card.vue";\n'
        'import { format } from "./format";\n</script>\n'
    )
    (root / "src" / "components" / "Card.vue").write_text("<template><div /></template>\n")
    (root / "src" / "format.ts").write_text("export const format = String;\n")

    result = analyze(root)
    languages = {node.path: node.language for node in result.files}
    assert languages["src/App.vue"] == "vue"
    assert {(edge.source, edge.target) for edge in result.edges} == {
        ("src/main.ts", "src/App.vue"),
        ("src/App.vue", "src/components/Card.vue"),
        ("src/App.vue", "src/format.ts"),
    }
    assert result.unresolved == []
