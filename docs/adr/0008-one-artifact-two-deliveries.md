# ADR-0008: One artifact, delivered two ways: `reposhape up` and a read-only deployment

- Status: accepted; amended by ADR-0010 (the personal server runs in the background)
- Date: 2026-09-29

## Context

`PRD.md` lists deployment as a v0 non-goal. This reopens it, on purpose: the
tool is worth showing to people who are not going to install it, and the owner
decided to host it at a URL on a server of their own.

Two ways of using it now exist, and they differ in who owns the machine:

- **Personal.** Someone runs `reposhape up` in their own repo. Their disk, their
  repos, every feature: browse folders, clone, analyse, refresh, forget.
- **Hosted.** A visitor opens a URL on a machine they do not own. They must be
  able to read the repos an operator put there and do nothing else. On that
  server `GET /api/folders` would list its filesystem, `POST /api/clone` would
  fill its disk, `POST /api/analyze` would read any path on it, and
  `DELETE /api/repos/{key}` would change what every other visitor sees.

Two things stood in the way of either being shippable to anyone else:

1. `next build` failed on Next's own `/_global-error` prerender (the section
   that was in `AGENTS.md`), so there was no production frontend at all. `reposhape up`
   ran `next dev` from a `frontend/` beside the source, which needed Node, pnpm,
   a second port and the checkout itself.
2. Nothing in the API distinguished a route that reads from one that acts on
   the host.

Next 16.3.6 builds this app, the failure reproduced on 16.2.12 and not on
16.3.6. That removed the first obstacle.

## Decision

**The frontend ships as a static export inside the Python package.**
`just web-export` builds it with `output: "export"` and copies it to
`reposhape/web/`, which the wheel carries. FastAPI serves it beside `/api`
from one origin. `reposhape up` is one process on one port with no Node at run time,
and `uvx --from <path> reposhape up` works on a machine with no frontend toolchain.
`just web` stays as the hot-reloading dev server for frontend work, proxying
`/api` to `just serve`.

**The hosted deployment is the same artifact with one setting different.**
`REPOSHAPE_READ_ONLY=true` makes `create_app` skip the `operator` router:
folder browsing, clone, analyse and refresh, forget, and the graphify page
builder (it runs a program and writes files). The routes are not registered
rather than refused, so there is no per-route check to get wrong. `/api/health`
reports `read_only` and, in that mode, stops stating host paths; the page
hides the controls whose routes are gone; `/api/sources` offers only sources
already cached. The CLI ignores the setting, because using it already means a
shell on the host: curated repos are added by the operator with `reposhape clone`.

**The public surface is pinned by a test.** `tests/test_api.py` lists every
operation the read-only app serves and asserts equality. A new route fails it
until someone decides which side it belongs on, which is the divergence this
split can otherwise accumulate without anyone noticing.

**Graph views are memoised per artifact version and filter set.** Every
`/api/graph` request re-ran Louvain; a public page asks for the same few views
repeatedly. The memo keys on the artifact's mtime, so a re-analysis misses it.
It holds 16 views: one hermes-agent view is about 15 MB, and a 128-entry memo
pinned the 1 GB container at its limit when a reader changed filters quickly.

**Deployment**: the image is built on the host (arm64), `just release*`
recipes run over SSH, configuration lives in `ops/deployments/hosted.env`
(gitignored; `hosted.env.example` is the template), the container is published
on host loopback only and reached through Tailscale Serve. One container,
because there is no Next server to run. Clones and cache are named Docker
volumes, so a redeploy keeps both (ADR-0007: a clone is data).

## Consequences

- Going public is flipping nothing: the deployment runs read-only from its first
  day, so what is verified on the tailnet is what the public would get.
  Exposing it is a separate step (a tunnel), not a code change.
- Read-only stops host access and changes to what visitors see. It does not
  stop load. The memo absorbs repeated views, but every distinct filter set is
  a Louvain run, and nothing limits requests per visitor. A rate limit belongs
  in front of any public tunnel.
- The graphify comparison reaches the hosted page only as far as the operator
  built it. Since 2026-09-30 the image carries graphify (its own virtualenv,
  hash-locked, no LLM extras) and `just release-graphify` runs its LLM-free
  extraction on each curated repo in a one-off container and caches both
  projections, so the two graphify tabs are served like any cached analysis,
  and graphify's own page where graphify wrote one. The files-only rendering
  runs a program on request and stays personal-mode.
- A frontend change is not live in `reposhape up` until `just web-export` runs. `reposhape up`
  warns when the bundle is older than `frontend/src` in a checkout, because the
  failure otherwise reads as an edit that did nothing.
- `launching.py` lost its process-group management for the dev server, and
  `web_host`, `web_port`, `frontend_dir`, `package_manager` and the CORS
  middleware are gone: one origin needs none of them.
- The package is installable, not published: the `Private :: Do Not Upload`
  classifier stays, and there is no remote yet.
