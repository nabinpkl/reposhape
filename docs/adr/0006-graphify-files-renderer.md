# ADR-0006: file-level data through graphify's renderer

## Decision

A third renderer, `graphify files`, draws the pane's current analysis with
graphify's own vis-network page: one node per file, one edge per import, our
Louvain partition and labels, no symbols anywhere. The page builds on demand
through the installed `graphify export html` over a synthesized node-link
`graph.json` in our cache, and rebuilds whenever the analysis artifact is
newer than the page.

## Why

The matrix had a hole. The extractor tabs share our renderer over different
edges, and the `graphify page` tab shares nothing: 29,402 symbols under names
like `Equatable`. There was no way to see file-level data in graphify's
renderer, so "ours looks different" could always be answered with "different
renderer" and never settled.

## What it is not

- Not a dependency: the `graphifyy` package would drag two dozen
  tree-sitter grammars into the backend for one exporter function. The binary
  on PATH is the whole interface, and readiness is its presence.
- Not a clone: no graphify source is vendored. The contract is its node-link
  schema plus the per-node `community` attribute, which is also what
  `export html` falls back to when its own analysis sidecar is absent.
- Not filtered: like the verbatim page, it draws the whole analysis. Shape
  cuts live in our renderer; this one shows what the extractor saw.

## Consequences

- `partition` moved into `graphing.py` so the JSON view and this page draw
  the same communities under the same labels. Same seed, same ordering.
- The page is keyed per analysis, so every source has its own file-level
  graphify drawing: ours edges or graphify edges, same renderer.
