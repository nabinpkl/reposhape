# Working in this repo

`PRD.md` is what and why. `SPEC.md` is how v0 is built. `docs/adr/` holds
decisions that lock something in. This file is repo conventions only. Read
`PRD.md` and `SPEC.md` once before project work; they are short on purpose.
Notes about one machine or one deployment go in `CLAUDE.local.md`, which is
gitignored, never here.

## Declarations

- **Type: daily tool.** Done is someone opening this to answer a question about
  a repo's layout, and the answer changing a decision. A clean tree, a green
  gate, and a finished feature list are all not done.
- **Read path before storage.** The cache stores analyses. Its read moment is
  the repo picker showing previously analysed repos with their commit and age,
  so a stored analysis resurfaces without being searched for. Build that with
  the cache, not after it.

## Conventions

- **The stack is settled (ADR-0003).** Same layout, same gate shape. A
  deviation needs a written reason, not a preference.
- **Absolute imports.** `@/x` is the frontend's own src. No `../..` in either
  tree. A relative import breaks when either end moves.
- **Generated files are never hand-edited.** `frontend/src/generated/*` comes
  from Pydantic DTOs via `tools/export_contracts.py`; `just check` fails on a
  byte difference.
- **Fail loud.** An unresolved import specifier is recorded with its reason and
  surfaced in the UI as a count. It is never silently dropped. An edge that
  quietly does not exist is indistinguishable from a parser that quietly broke,
  and that absence is the expensive kind of bug.
- **Iteration over compatibility.** Until v0 ships, breaking changes are free.
  No migration shims, no v1-vs-v2 toggles, no fallback paths. Removed means
  deleted.
- **No hardcoded paths.** Repo roots, ports, and cache locations go through
  config. The target repo is always a parameter, never a constant: this tool is
  measured on particular repos but is not about any of them.
- **Verify on the real surface.** Done means the page was opened and clicked,
  not that the code reads correctly. A screenshot or a driven browser session,
  not a passing unit test alone.
- **Every route picks a side.** `reads` answers from the cache and from files
  in an analysed repo; `operator` acts on the host. A read-only server does not
  register `operator` (ADR-0008), and `tests/test_api.py` pins the public route
  set, so a new route fails the gate until its side is chosen on purpose.
- **The server checks who is asking, not only where it listens.** A browser
  does not treat loopback as a boundary: any page the owner has open can send
  requests to 127.0.0.1, and a page whose name is re-pointed at 127.0.0.1 (DNS
  rebinding) can read the answers. So `api.py` refuses a Host that is not in
  `allowed_hosts` and an `/api` request whose `Sec-Fetch-Site` is `cross-site`
  or `same-site`, and `tests/test_api.py` sends both and expects refusals. A
  new way of reaching the server (a tailnet name, a LAN address) is a new
  `allowed_hosts` entry, never a removed check.
- **A repo is someone else's content (ADR-0014).** A cloned repo can commit a
  symlink to `~/.ssh/id_rsa` or a `graphify-out/graph.html` full of script.
  Every read of repo content passes `scanning.inside_repo` first, at scan time
  and again at request time; the framed page is sandboxed by header; and the
  page's CSP allows only scripts this origin shipped. A new read of a repo
  file goes through the same check, and `tests/test_api.py` plants a symlink
  for each route that reads one.
- **Commit at arc boundaries** with `just check` green, and say why in the
  message rather than what.

## Releasing (ADR-0012)

Bump `version` in `backend/pyproject.toml`, commit, tag `vX.Y.Z`, push the
tag; `.github/workflows/release.yml` builds, smoke-tests, attests and
uploads through trusted publishing. A manual run of that workflow is a dry
run that builds and smoke-tests without uploading. Nothing is ever uploaded from a laptop, and no
PyPI token exists to leak. `just package-smoke` is the local rehearsal: it
builds `dist/` and installs each distribution the way a user would, on the
newest dependencies and on pyproject's floors.

## TLS errors behind an intercepting proxy

If `HTTP_PROXY` / `HTTPS_PROXY` point at an intercepting proxy, Node fails
with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` while `curl` succeeds, because Node
uses its own CA list rather than the system's. Trust the proxy's CA with
`NODE_EXTRA_CA_CERTS=<its CA file>`; never `strict-ssl=false` or
`NODE_TLS_REJECT_UNAUTHORIZED=0`, which fetch executable code over a channel
nothing authenticates.

## Only the LLM-free half of graphify may be run here

The symbol graph tab (`graphify_page.py`) shows graphify's own extraction of a
repo. A graph whose nodes, edges or cluster names came out of a model is not an
extraction, it is an answer, and two runs of it disagree. This tool is also a
local daily tool with no API budget and no key it is entitled to spend, so an
LLM call here is a cost nobody asked for.

Verified against graphify 0.9.57's own source, not its help text:

- **`graphify update` is LLM-free.** It routes through `watch._rebuild_code`,
  which clusters with networkx and names each community after its highest-degree
  hub (`cluster.label_communities_by_hub`). `watch.py` does not import
  `graphify.llm` at all.
- **`graphify export html` and the other exporters are LLM-free**, as are
  `path`, `query`, `affected`, `god-nodes`, `diagnose` and `tree`. They read
  `graph.json` and write a file.
- **`graphify label` always calls a model.** So does `graphify cluster-only`
  unless `--no-label` is passed, and `graphify extract`, whose whole point is
  semantic extraction, unless `--code-only` is passed. `--dedup-llm` is the
  fourth door.

`graphify update` prints two nudges toward exactly those commands when it
finishes: a line telling you to run `graphify label` to refresh names with the
LLM when the community set moved, and a tip to set `GEMINI_API_KEY` for
semantic extraction.
They are advice from a tool that does not know what it is being used for here.
Do not follow them.

The enforcement point is `graphify_page`: `extract` runs `graphify update`,
and `ensure` runs that when there is no `graph.json` and `graphify export html`
when there is, and nothing else. The release image installs graphify without
its extras, so the model SDKs its LLM paths need are not installed there
(`ops/graphify/requirements.in`). `graphify.py` runs no graphify command at
all: it reads the artifact, and its only subprocess is `git`. Keep both that
way. If a comparison
ever genuinely needs graphify's semantic edges, that is an ADR and a stated
cost, not a flag added in passing.

## Deferred, one line each

Swift (`import <Module>` names a module, not a file, and resolves per build
target) · Rust and Go parsers · co-change coupling from git history, the axis
CodeScene answers and no static graph can · shortest path between two files ·
import-cycle and layering-violation detection · watch mode with incremental
re-parse of changed files only · saved views and persisted filter sets ·
symbol-level edges.
