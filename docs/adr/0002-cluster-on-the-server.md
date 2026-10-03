# ADR-0002: Cluster on the server, after filtering

- Status: accepted
- Date: 2026-09-11

## Context

In the tool being replaced, Louvain runs once at generation time and the result
is baked into the HTML. The path filter then hides nodes in the browser. So
after excluding `app/wire`, you are looking at a partition that was
computed with wire still in it: the colours are a fact about a graph that is no
longer on screen.

The alternative is `graphology-communities-louvain` in the browser, re-running
on every filter change.

## Decision

Clustering runs server-side in `GET /api/graph`, after the filter is applied.
The filter set is part of the request and part of the TanStack Query key.

## Consequences

- One authoritative clustering implementation, in Python, ported from code that
  already works. Two implementations of Louvain would drift and nothing would
  catch it.
- One fewer JS dependency, and it happens to be the stalest candidate
  (`graphology-communities-louvain`, last published 2024-12-17).
- Filter changes cost a round trip. At 1,260 nodes Louvain is tens of
  milliseconds and the response is small, so the trip dominates and is still
  fast. Query caches by filter set, so revisiting a filter is instant.
- If a filter change ever feels slow enough to notice, measure the split between
  round trip and Louvain before moving the algorithm to the client. Moving it
  reintroduces the drift this avoids.

## Measured after building it

2026-09-11, on the monorepo (the private repo this tool was first built against, see SPEC.md): 986 files and 2,670 edges cluster into 21
communities. Excluding the single file `app/wire/index.ts` gives 25
communities over 985 files. The prior tool would have shown 21 with one node
hidden, and four of those communities only exist because the file that bridged
them is gone.

Round trip plus Louvain for that request is well under the 2.7s a cold analysis
takes, so the round-trip cost this ADR accepted is not the one a user notices.
