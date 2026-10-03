# Technical shape, v0

The stack is ADR-0003's. Deviating from it needs a reason written down, not a
preference.

Measurements below name **the monorepo**: the private TypeScript and Python
repo, about 1,260 files, that this tool was first pointed at. The public repos
measured (langchain, hermes-agent, opencode) are named.

## Stack

| Layer | Choice | Verified |
| --- | --- | --- |
| Backend | FastAPI, Python 3.14, uv, ruff, ty, pytest | uv 0.12.1, cpython 3.14.6 present |
| Parsing | `tree-sitter` 0.26.0 + `tree-sitter-typescript` + `tree-sitter-python`; Vue SFC scripts through the TS grammar | probed live, see below |
| Graph | `networkx` Louvain | already proven in the tool being replaced |
| CLI | `typer` | |
| Frontend | Next 16.3.6 / React 19, pnpm 11.15.1, node 24; shipped as a static export (ADR-0008) | 16.2.12 could not build, see ADR-0008 |
| UI | shadcn new-york, neutral base, Tailwind v4, lucide | |
| Server state | TanStack Query v5 | |
| View state | zustand v5 | |
| Rendering | `sigma` 3.0.3 + `graphology` 0.26.0 + `@react-sigma/core` 5.0.6 | npm registry, checked 2026-09-11 |
| Layout | `graphology-layout-forceatlas2` 0.10.1 | last published 2022-10-17, see ADR-0003 |
| Code pane | `shiki` | 4.4.2 |

## The tree-sitter API, as measured

Probed against `tree-sitter` 0.26.0 rather than taken from docs. The 0.24+ API
is `Query(LANG, source)` plus `QueryCursor(q).matches(node)`; the older
`query.captures()` shape is gone.

```python
from tree_sitter import Language, Parser, Query, QueryCursor
import tree_sitter_typescript as tsts

TS = Language(tsts.language_typescript())   # also .language_tsx()
cursor = QueryCursor(Query(TS, QUERY_SRC))
for _, caps in cursor.matches(Parser(TS).parse(src).root_node):
    ...
```

Use `matches()`, not `captures()`. `captures()` returns a flat dict per capture
name, which loses the pairing between a `require` identifier and its string
argument. `matches()` keeps each match's captures together.

One query covers all five TS import forms, verified to capture exactly these
and to reject `foo("./not-an-import")`:

```scheme
(import_statement source: (string (string_fragment) @spec)) @stmt
(export_statement source: (string (string_fragment) @spec)) @stmt
(call_expression function: (import)
  arguments: (arguments (string (string_fragment) @spec))) @stmt
((call_expression function: (identifier) @_f
   arguments: (arguments (string (string_fragment) @spec))) @stmt
 (#eq? @_f "require"))
```

Python, verified to yield `os`, `os.path`, `.`, `.rel.mod`, `pkg.sub`:

```scheme
(import_statement name: [(dotted_name) @mod (aliased_import name:(dotted_name) @mod)])
(import_from_statement module_name: [(dotted_name) @mod (relative_import) @mod])
```

## Shape: the CLI emits, the server reads

`reposhape analyze-repo <repo>` writes the artifact. Everything else reads it. There is
one analysis path, `analysis.analyze`, called by both the CLI and
`POST /api/analyze`, so the two cannot produce different JSON.

```
reposhape up [repo|url] [--source] [--refresh] [--port]             start the server if needed, open the page
reposhape status                                                    is the background server running, and where
reposhape down                                                      stop the background server
reposhape clone <url> [--quiet]                                     clone, keep, and analyse
reposhape analyze-repo <repo> [--source] [--out FILE|-] [--quiet]   write the artifact
reposhape view <repo> [--include-tests] [--top N]                   clustered summary, no browser
reposhape repos                                                     what has been analysed
reposhape forget <repo>                                             take it out of the cache, every source
reposhape serve [--host] [--port] [--reload]                        the server in the foreground, no analysis
```

`--out -` writes JSON to stdout and progress to stderr, so it pipes into jq.

### `reposhape up` is the daily command

`reposhape up` with no argument makes sure the server is running and opens the page on
the repo picker, where a folder on this machine or a git URL is added. `reposhape up .`,
a path, or a URL analyses that repo first, on this terminal with its progress,
and opens the page on its graph. Either way `reposhape up` then returns: the server
runs in the background and outlives the terminal (ADR-0010, `daemon.py`), and
`reposhape down` stops it. The server answers the page and `/api` from the same
origin: the page is the frontend's static export, built into the package by
`just web-export` (`web_bundle.py`). The pieces above are what it is made of,
not a sequence anyone should have to type. `launching.py` and `daemon.py` hold
it.

`reposhape up` refuses to start without the bundle, naming `just web-export`, and in a
checkout warns when the bundle is older than `frontend/src`: a stale page with
nothing saying so reads as a frontend edit that did not work.

A path argument resolves through `git rev-parse --show-toplevel`, so running it in `backend/` graphs the project rather than
`backend/`. Graphing a subdirectory is not an error anything reports: it just
produces a graph whose cross-directory edges are all unresolved.

**The URL carries the repo**: `http://127.0.0.1:7420/?repo=<cache key>`. The
browser reads that parameter through `useSyncExternalStore` (server snapshot
null, client snapshot the real value, so no hydration mismatch) and the picker
writes its choice back with `replaceState`, so a reload returns to the same
graph and the tab is worth bookmarking.

**The server is found through a registration, and the registration is
checked.** It writes `server.json` under `state_root` once it is listening.
`reposhape up` reuses it only when `/api/health` at the registered URL answers with
the registered pid, *this* cache root, and this build; a server running another
build (a reinstall, an edited checkout, a new `just web-export`) is stopped and
replaced. `reposhape down` signals the pid only after the same check, because a stale
registration's pid can belong to anything by then.

**The port is fixed (7420) and probed.** Fixed because the URL is bookmarked
and the theme is stored per origin. A port answering our health with this cache
root but no registration (`reposhape serve` run by hand) is used as it is. Anything
else fails loudly naming `--port`. Sliding silently to another port was
rejected: the URL printed then and the URL printed last time would be
different pages with nothing saying so.

**There used to be a second process.** Until ADR-0008 `reposhape up` ran `next dev` as
a child in its own session, killed by process group because `pnpm` spawns
`next` and killing `pnpm` alone left node holding the port. The static export
removed the child, the second port and the Node requirement together.

**Settings come from the environment, never from a `.env` in the working
directory.** `reposhape` is run inside other people's repositories by design, and the
first run inside the monorepo loaded that repo's `.env`, failed validation on
seventeen unrelated keys, and printed an API key into the traceback.

## Comparing against graphify, in the same window

`PRD.md` claims this tool is built instead of reusing graphify. A screenshot of
graphify's own page cannot test that claim, because its layout, palette, edge
styling and filters all differ from ours: a difference in the picture would say
nothing about the extractor. So graphify's artifact is read directly and put
through **this** clustering and **this** renderer, and the browser carries a tab
strip to switch between them.

That same strip carries the map: the identical `GraphView`, drawn as files
packed into the circles of their folders with the edges dropped, on one 2D
canvas rather than through sigma. `docs/graph-rendering.md` records why it is
not sigma and what a dot's area is allowed to mean.

`graphify.py` reads `<repo>/graphify-out/graph.json` and nothing else. No
graphify code is imported and no graphify command is run. Two things about its
shape drive the mapping:

- **Its nodes are symbols**, 29,402 of them for the monorepo, each carrying a
  `source_file`. Projecting onto files is what makes the two comparable; the
  38,662 symbol-to-symbol edges inside a single file collapse to nothing, which
  is the right answer for a file-level graph. 3,996 symbols carry no
  `source_file` at all and are counted in `files_skipped` rather than dropped.
- **Its edges carry a `relation`**, sixteen of them. Only `imports`,
  `imports_from`, `dynamic_import` and `re_exports` mean "this file pulls in
  that file", so `graphify-imports` takes those and `graphify-all` takes
  everything. Blending the two into one number would compare our import graph
  against a graph that is mostly calls and say nothing.

Measured on the monorepo, same repo, same commit, same clustering:

| source | files | edges | clusters | largest cluster |
| --- | --- | --- | --- | --- |
| ours | 989 of 1,262 | 2,686 | 21 | 141 |
| graphify imports | 1,132 of 1,606 | 2,948 | 27 | 485 |
| graphify all edges | 1,171 of 1,645 | 4,923 | 33 | 485 |

The row that matters is the last column. graphify's largest cluster is 485 files
labelled after one app directory `+274 elsewhere`: a third of the repo in one
partition spanning 274 directories, which is a cluster that cannot answer a
question about where a change belongs. Its file list also contains `react`,
`mermaid`, `shiki`, `node:fs` and `@xterm` as paths, because some of its symbols
record a package name where a file goes, so external packages are nodes in its
file graph. Ours covers fewer files (no Swift, Rust, shell or Markdown) and that
is the honest cost on the other side.

An analysis is keyed by repo **and** source, so the three sit in the cache side
by side and the URL (`?repo=<key>`) links to one specific comparison.

## Backend modules

`backend/src/reposhape/`, flat. One file per concern, no directories: these
are seventeen modules, and a directory per concept would be naming, not fan-out.

- `scanning.py` finds the repo's source files. Prefers `git ls-files`: it
  applies .gitignore for free, never descends into node_modules, and the same
  git call yields the commit sha. Walks as a fallback for a non-git directory.
  Applies `.reposhapeignore` (gitignore syntax, exclude-only) on top.
- `parsing.py` the tree-sitter queries. Yields
  `RawImport(specifier, kind, type_only, line)` and touches nothing else.
- `resolution.py` specifier to repo-relative path, or an explicit outcome.
- `graphing.py` file-level graph, Louvain, cluster labels, the view filter.
- `analysis.py` the one orchestrator.
- `cache.py` artifacts under `~/.cache/reposhape/<name>-<digest>.json`, one
  per repo, written to a staging file and moved so a reader never sees half of
  one. The digest keeps two checkouts of the same project apart; the name keeps
  the directory browsable.
- `graphify.py` reads graphify's own artifact and projects it onto files, so
  the two extractors can be compared through one renderer. See above.
- `launching.py` the probes behind `reposhape up`: whether a port is taken,
  whether what answers there is this app, and the URLs it prints. Every probe
  bypasses the machine's HTTP proxy, or a health check on 127.0.0.1 is answered
  by the proxy instead of by uvicorn.
- `web_bundle.py` where the browser client's static export lives in the
  package, and whether it is older than the frontend source.
- `licensing.py` the license nearest above a file: which one, and whose copyright.
- `runtime_links.py` couplings with no import between them (ADR-0009): event
  names written literally at both ends, `-m` modules started as programs, and
  loader rules from `<link_rules_dir>/<repo name>.toml`. Drawn over the graph,
  never clustered on.
- `api.py` FastAPI. `cli.py` typer. `models.py` the contract.
  `configuration.py` every environment-dependent value.

## TS resolution, and the two traps already found

The monorepo has **three independent tsconfigs**, each with its own `paths`:
`app/sidecar/`, `packages/panel/web/`, `packages/gestures/web/`.

1. **Resolve against the nearest enclosing tsconfig, not a global alias map.**
   `@/*` means `./src/*` relative to *that* tsconfig's directory, and
   `@repo/*` walks a different number of `../` in each one. A single merged
   map resolves the wrong file and looks like it worked. TypeScript 7 removed
   `baseUrl` and these configs are written without it, so the tsconfig's own
   directory is the only base.
2. **tsconfig.json is JSONC.** All three contain `//` comments. `json.load`
   raises on them. Strip comments or use a JSONC parser, and handle `extends`.

Beyond that: relative specifiers probe `.ts .tsx .js .mjs .cjs`, then
`index.*`. A bare specifier naming a workspace package (`package.json`
`workspaces`, list or `{packages}` form, or `pnpm-workspace.yaml`) resolves
through that package's `exports`, conditions tried in key order until one lands
on a scanned source file, else `main`/`module` and a subpath under its
directory. A workspace name that lands nowhere is `no_matching_file`, not
external: before this, opencode's ~4,100 `@opencode-ai/*` imports were all
counted as npm packages. Vite `resolve.alias` is not read yet. Anything still
unresolved is external.

Vue single-file components scan as `vue`. Their top-level `<script>` and
`<script setup>` blocks are cut out by a match anchored at the start of a line,
parsed with the TypeScript grammar (tsx for `lang="tsx"` or `"jsx"`), and their
line numbers shifted back into the `.vue`. Vite does not probe `.vue` on an
extensionless import by default, so resolution adds no probe either: a
component is imported by its full name and lands through the existing lookup.
A globally registered or auto-imported component (Nuxt,
unplugin-vue-components) has no import in the source and gets no edge.
Measured on `kuber-ide` 2026-09-15: 129 files, 176 edges and 11 unresolved
before; 198 files (69 `.vue`), 426 edges and 3 unresolved after, none of the
three a Vue import.

Python resolution: relative imports count leading dots against the importing
file's package; absolute dotted names resolve against a set of source roots.
That set is the repo root, every `src/` directory, every directory holding a
`pyproject.toml`, and whatever roots that file's `[tool.hatch]`,
`[tool.setuptools]` or `[tool.poetry]` table declares on top. Roots enclosing
the importing file are tried first, which is the same nearest-config rule the
TypeScript side uses and for the same reason: two packages in one tree can
both hold a `tests/unit.py`. A monorepo with no root package is the case that
forces all of this. langchain has 21 packages under `libs/`, and against the
repo root alone it resolved 0 of its 5,451 edges. Stdlib and site-packages are
external by definition.

## Wire

Pydantic DTOs are the source of truth for three things at once: what the CLI
writes, what the API answers, and what the browser types against.
`tools/export_contracts.py --check` regenerates `frontend/src/generated/contracts.ts`
and fails on any byte difference. Generated files are never hand-edited.

- `GET  /api/health` what this server is: `read_only`, and outside read-only mode
  the cache and clone roots. `reposhape up` identifies its own server by the cache root.
- `GET  /api/repos` cached analyses, newest first. The repo picker's read path.
- `DELETE /api/repos/{key}` forgets a repository: its artifact for every source and
  the graphify pages drawn from each, because the picker shows a repo while any of
  its rows remain. Only the cache is touched, never the analysed repo.
- `GET  /api/folders?path=` child directories, for picking a folder to analyse.
  The browser cannot hand the server a filesystem path -- `webkitdirectory` gives
  relative names, `showDirectoryPicker` gives a handle -- so the chooser runs here.
  Completion is a shell's: a path ending in a separator lists it, anything else
  lists its parent filtered by the last segment, so typing and clicking are one
  mechanism. **Directories only**: no file name and no file content leaves this
  endpoint, and `/api/file`'s membership guard is untouched.
- `POST /api/clone` `{url}` clones a remote repo into the durable clone root and
  answers `{path, already_present}`. 400 when the URL is one this will not clone,
  502 when git could not fetch it, with git's own last line as the detail.
- `POST /api/analyze` `{repo_path, refresh}` runs or reuses an analysis.
- `GET  /api/analysis/{key}` the whole artifact, as the CLI wrote it.
- `GET  /api/graph/{key}?exclude=&include_tests=&include_type_only=`
  **filters first, then clusters.** `exclude` repeats, and each entry is a plain
  repo-relative path that works at any depth: `app/wire` takes its
  subtree, `app/wire/index.ts` takes one file. Memoised per artifact
  version (its mtime) and filter set, so a repeated view costs no Louvain run
  and a re-analysis misses the memo.
- `GET  /api/file/{key}?path=` contents read from disk at request time.
- `GET  /api/license/{key}?path=` the license governing a file: the nearest
  `LICENSE`, `LICENCE` or `COPYING` (any of `.md .txt .rst`) walking up from the
  file's directory to the repo root, read at request time. Its SPDX id when the
  text is recognised by its fixed wording, the copyright lines, and the text.
  `path` must be a file the analysis knows, the same guard as `/api/file`;
  without it, the root's. Nearest rather than root for the tsconfig reason: a
  monorepo package or plugin directory carries its own license under its own
  holder, and the audit in `ops/deployments/curated-repos.txt` found a dozen.
  A NOTICE file beside the chosen license comes with it (Apache-2.0 4(d)
  requires its contents to travel with the code), and when the license names no
  holder, as a stock Apache-2.0 text does not, the NOTICE's copyright lines are
  the holder.
- **Accepted**: `https://`, `http://`, `ssh://`, `git://`, `file://`, and the
  `git@host:owner/repo.git` form. An allowlist rather than a filter, because
  `git clone "ext::sh -c <anything>"` is a transport that runs a command.
  `file://` is in it because cloning a local checkout is a real use and it is
  what makes this path testable with no network.
- **Shallow**, `--depth 1 --single-branch`: the analysis reads the working tree
  and never the history. `git fetch --unshallow` is the way back, and is what
  deferred co-change coupling would need.
- **Cloned to a staging directory beside the target and moved**, the same
  discipline `cache.write` uses, so an interrupted clone cannot be found later
  and mistaken for a complete one.
- **Nothing can ask a human a question.** `GIT_TERMINAL_PROMPT=0` and
  `ssh -o BatchMode=yes`, with `GIT_ASKPASS` and `SSH_ASKPASS` dropped. Nobody
  is watching this process, so a private repo with no usable credential fails in
  a second instead of sitting on `Username for 'https://github.com':` until the
  timeout. Credential helpers are left alone, so a repo the owner can already
  pull still clones.
- **Cloning never fetches and never resets.** An existing checkout is reused as
  it stands and `already_present` says so.
- **Refreshing does fetch, and only a checkout this tool made.** Refresh means
  "as it is now", and for a clone, now is upstream: without this the refresh
  button re-reads a working tree nothing can have touched, which is a button
  that looks like it did something. `POST /api/analyze` with `refresh` and
  `reposhape up --refresh` do it; `reposhape clone` does it when the checkout was already
  there, because asking for a URL is asking for that repository now. Nothing
  else is ever fetched: every other repo here belongs to the owner and is not
  this tool's to move.
  Three conditions gate the `reset --hard`, which is the one operation here that
  can destroy work: under the clone root, HEAD on a branch, and no TRACKED file
  modified. **Untracked files are deliberately not a blocker**, because
  `.reposhapeignore` is one and this tool asks for it to be put there; `reset
  --hard` leaves untracked files alone. Anything else is reported and skipped,
  and a fetch that fails never fails the analysis, because being offline is a
  reason to graph what is on disk rather than to refuse. `AnalyzeResponse.update`
  carries `updated | current | left_alone | failed`, and the browser prints it
  beside the refresh button.

Downstream there is no clone-aware branch anywhere: the checkout is a directory
like any other, keyed in the cache by its path, listed by the folder picker,
re-analysed from its working tree.

## What the artifact records that does not become an edge

Three outcomes are not failures and are counted separately, because an error
list that fills with `react` and `./styles.css` trains you to ignore it:

- `external` npm/PyPI/stdlib specifiers and their counts. The cheapest
  available answer to "what does this repo depend on".
- `assets` imported CSS, JSON, protos and images. Real dependencies, not code
  nodes.
- `unresolved` only `no_matching_file`, `outside_repo`, `unparsed_alias`. These
  mean something is wrong, and on the monorepo the list is one entry long: a
  genuinely deleted file that `app/sidecar/scripts/smoke-test.ts`
  still imports.

Runtime links (ADR-0009) are recorded beside the edges as `links`, with
`link_stats` counting what that pass dropped or could not read: one-word
stream names, non-literal names, names with one end only, `-m` modules outside
the repo, and rules that matched nothing.

## Frontend structure

`frontend/src/`

- `app/page.tsx` one route, exported as a static shell the client fills in.
  Nothing needs a Next server, which is what makes `output: "export"` possible.
- `features/repo/` repo picker, the folder chooser that adds one, source and
  renderer tabs. `serverMode.ts` reads `read_only` from `/api/health` and the
  picker, refresh and Add repo controls hide on a read-only server. Unknown
  counts as read-only, so a public page never flashes controls it then removes.
- `features/graph/` sigma canvas, ForceAtlas2 worker, focus and isolate.
- `features/filter-tree/` nested `<details>` path tree, tri-state checkboxes at
  every folder and every file.
- `features/file-view/` on-demand code pane with shiki highlighting.
- `lib/` api client, class-names.

### State ownership

- **TanStack Query** owns everything the server knows: the analysis, the graph
  for a given filter set, file contents. The excluded-path set is part of the
  query key, so re-clustering on filter change is a cache lookup on the way back.
- **zustand** owns view state only: focused node, excluded paths, pane sizes,
  whether the file pane is open.
- **URL** carries repo and selected node, so a link reproduces a view. Query
  params, `replaceState`.

The excluded-path set lives in zustand and *feeds* the query key. That is the
seam. It is not duplicated into Query state.

### Known frontend traps, carried forward

- The `</script` tag-injection bug that cost the prior tool an hour does not
  exist here: file content arrives over `fetch` as JSON, never inlined into a
  `<script>` tag. Do not reintroduce inlining as an optimisation.
- A flex child with `flex: 1` and no `min-width: 0` will not shrink below its
  content, so ellipsis never fires and the path tree pushes the sidebar wide.
  The scroll container needs a bounded height plus `min-height: 0`, or the page
  scrolls instead of the tree.

## Gates

`just check` = `check-backend` + `check-contracts` + `check-frontend`, and
`check-frontend` builds the static export, so the shipped bundle is verified
by the gate. `just up` is the daily command. `just web-export` rebuilds the
bundle `reposhape up` serves; `just web` is the hot-reloading dev server for frontend
work against `just serve`. `just analyze <repo>` plus `just view <repo>` do the
whole job without a browser. `just release` deploys (ADR-0008).
`just release-graphify` builds the graphify tabs for the curated repos on the
server: `reposhape graphify-extract <url>` per repo, which runs `graphify update` and
caches both projections. Measured 2026-09-30 on a laptop: hermes-agent 380 s
and 3.6 GB peak for 240k symbols, and graphify writes no page for it (its
community view is past graphify's 5,000-node limit); opencode 64 s and 1.9 GB;
langchain 42 s and 0.9 GB, both with a page.

## Measured on the monorepo, 2026-09-11

1,257 source files (915 TS, 278 JS, 64 Python), 4,997 import statements, 3,236
edges, 2.7s cold. 187 external packages, 1 unresolved. With tests excluded:
986 files, 2,670 edges, 21 clusters. Excluding the single file
`app/wire/index.ts` moves it to 25 clusters, which is ADR-0002 working:
the partition is of what you are looking at.
