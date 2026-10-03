# ADR-0004: graphify's own page is framed, not cloned

## Decision

The rendering comparison is a fourth view that frames graphify's `graph.html`
byte for byte in an iframe, served by `GET /api/graphify-page`. The page is
built by the `graphify` binary on the machine (`reposhape graphify-page` drives
`graphify update` from scratch, `graphify export html` when the extraction
already exists). No graphify code is imported, vendored, or reimplemented.

## Why not a clone

Cloning graphify's repo into this one would freeze a copy of its renderer at
today's commit and silently drift from every upstream fix to it. The installed
binary is the same code and the same dependency by construction: whatever
graphify renders anywhere is what the tab shows here.

## What the two halves say

- The extractor tabs (`ours`, `graphify imports`, `graphify all edges`) share
  one renderer and one clustering, so a difference in the picture is a
  difference in the extractor.
- The `graphify page` tab shares nothing: graphify's data through graphify's
  vis-network page, so a difference there is the rendering.

## Consequences

- The tab needs `graphify-out/graph.html` in the target repo. Without it the
  tab is visible but disabled, with the `reposhape graphify-page` command as its
  reason -- the same rule missing extractors already follow.
- Our filters, focus and file pane do not apply inside the frame; the sidebar
  says so while the tab is active. The page carries its own sidebar, legend
  and physics.
- `proxy.ts` serves `SAMEORIGIN` framing for `/api/graphify-page/*` only. The
  blanket `DENY` stands everywhere else.
