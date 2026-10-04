# ADR-0013: one row of tabs, grouped by files and symbols

- Status: accepted
- Date: 2026-10-04
- Supersedes ADR-0005 and ADR-0006; amends ADR-0004.

## Context

The page had two rows of tabs. The left picked whose edges fed the drawing:
`ours`, `graphify imports` or `graphify all edges`, the last two being
graphify's symbol graph projected onto files. The right picked the drawing:
`ours`, `map`, `map · lines`, `map · edges`, `graphify files` and
`graphify page`. That is eighteen combinations, "ours" named two different
things, and "graphify" named four tabs meaning three different things to a
reader who had never heard of graphify.

The rows existed to test one claim in `PRD.md`: that this tool's import
extractor was worth building instead of reusing graphify. Holding the drawing
fixed and swapping the edges was how a difference in the picture could be
blamed on the extractor. The claim has been measured, twice:

| monorepo, same commit, same clustering | files | edges | clusters | largest cluster |
| --- | --- | --- | --- | --- |
| ours | 989 of 1,262 | 2,686 | 21 | 141 |
| graphify imports | 1,132 of 1,606 | 2,948 | 27 | 485 |
| graphify all edges | 1,171 of 1,645 | 4,923 | 33 | 485 |

graphify's largest cluster there was a third of the repo across 274
directories, and its file list held packages (`react`, `node:fs`) as paths.
On langchain, `docs/extractor-comparison.md` found 98.6% of our edges in
graphify's too, with graphify's extra edges mostly one re-export hop further,
which is a symbol-level answer. The projections have nothing left to say to a
reader, and only the comparison needed them.

## Decision

**One row, grouped by what the data is.** The group names the data once and
each tab says only how it is drawn:

- **Files**, this tool's extraction: `import graph` (sigma, ForceAtlas2),
  `folders`, `folders · size` (a dot's area is its line count) and
  `folders · imports` (the imports that leave their package, over the folders).
- **Symbols**: `symbol graph`, graphify's own page framed verbatim (ADR-0004).
  Symbols are a non-goal for this tool, so the one view of them is graphify's,
  disabled with the command that builds it where graphify has written no page.

Each tab's hover text adds only what its label cannot say, so no two repeat.
"map" became "folders" because the tab names what is on screen, and
"map · lines" became "folders · size" because in a graph "lines" reads as the
edges.

**The comparison is deleted end to end, not hidden.** The projections
(`graphify.py`), the `graphify files` renderer (`graphify_files.py`), the
`/api/sources` and `/api/graphify-files*` routes, `--source` on `up` and
`analyze-repo`, and `reposhape graphify-extract` are gone. An analysis no
longer carries a source: one repo, one artifact, one key. Schema 5.

## Consequences

- An existing cache keeps working without a re-analysis: a schema 4 artifact
  still validates (its `source` is ignored), and so does a schema 3 one, which
  shows with no runtime links as it did before. 0.1.2 treated every older
  version as stale and emptied the picker on upgrade; 0.1.3 reads anything
  that validates. The picker skips an artifact that does not, instead of
  failing on it.
- `-graphify-imports` and `-graphify-all` artifacts left in an existing cache
  still validate, so the cache uses an artifact only under the key its own repo
  path derives: one repo, one key. They are never listed or opened; they and
  the `-graphify-files` directories are inert, and deleting them, or all of
  `~/.cache/reposhape`, loses nothing.
- `reposhape graphify-page` takes a cloned repo's URL as well as a path, and
  `--refresh` re-extracts rather than re-drawing a page from an old extraction.
  `just release-graphify` uses it, and reports and skips a repo whose graph is
  past graphify's page limit.
- CI no longer installs graphify: no test runs the binary.
- The split view holds any two tabs of the one row; its second pane opens on
  `folders · imports`, which needs nothing beyond this tool.
