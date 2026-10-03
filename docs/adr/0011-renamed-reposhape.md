# ADR-0011: The tool is named reposhape, everywhere

- Status: accepted
- Date: 2026-10-03

## Context

The project was `import-graph` (repo, directories, image, volumes), `importgraph`
(Python package and distribution), and `ig` (the command). Publishing it to
PyPI forced the question: `importgraph` is taken there by an unrelated project,
and `import-graph` would be refused as too similar to it (Warehouse strips
separators and compares). The name also describes the method rather than what
a reader gets: a repo's shape, seen at a glance.

`reposhape` was free on PyPI, npm and Homebrew on 2026-10-03, matched no
existing project after Warehouse's ultranormalization, and tripped none of its
typo checks.

## Decision

**One name.** The repo directory, the Python package and distribution, the
command, the environment prefix (`REPOSHAPE_`), the XDG directories
(`~/.cache/reposhape`, `~/.local/share/reposhape/clones`,
`~/.config/reposhape/links`, `~/.local/state/reposhape`), the per-repo ignore
file (`.reposhapeignore`), the page title, the release image, its compose
project, volumes and host directory all say `reposhape`.

**`reposhape` is the only command.** `ig` and `importgraph` are gone rather than
kept as aliases: two names for one command is the toggle this project does not
keep before v0 ships.

**No compatibility path for the old names.** The settings do not read
`IMPORTGRAPH_*`, and nothing looks in the old directories. On the owner's
machine the directories were moved once, by hand, and the cached analyses of
cloned repos were rebuilt at their new paths, since a cache key is derived from
the repo's path.

## Consequences

- A repo with a `.importgraphignore` needs it renamed to `.reposhapeignore`.
  None of the owner's repos had one.
- The hosted deployment still runs the last `import-graph` release, under that
  compose project, image, volumes and `/opt/import-graph`. The next `just
  release` creates the `reposhape` ones beside them and re-clones the curated
  repos into the new volume. The old compose project holds host port 3005, so it
  has to be taken down first (`docker compose -p import-graph down` on the host),
  and its image and volumes removed once the new release verifies.
- The predecessor script, `graphify-import-graph.py`, keeps its name: it
  belongs to another repo.
