# ADR-0003: Stack, and two accepted dependency exceptions

- Status: accepted
- Date: 2026-09-11

## Context

An earlier project of the owner's already runs FastAPI + Python 3.14 + uv +
ruff + ty against Next 16 + React 19 + TanStack Query + zustand + shadcn
(new-york, neutral, Tailwind v4) + shiki, with Pydantic DTOs exported to
checked-in TS contracts. That is a working instance of the stack named in this
project's request.

## Decision

Use that stack. Render with `sigma` + `graphology` + `@react-sigma/core`,
layout with `graphology-layout-forceatlas2`.

## Rendering alternatives considered

- **reagraph**: React-first WebGL, simpler API, smaller ecosystem, no
  server-side-friendly graph model.
- **Cosmograph**: GPU simulation, built for millions of nodes. Over-specified
  for ~3k, and its React package is the thinner half of the offering.
- **vis-network**: what the prior tool used. Canvas, not WebGL, and visibly
  sluggish at this size.

sigma wins because `graphology` is a real graph data structure we can also run
BFS and neighbour queries against, not just a renderer's internal model, and
because a deferred feature (path between two files) needs exactly that.

## Maintenance check

Checked 2026-09-11 against the npm registry and the GitHub API, not against
memory or a docs page.

| Repo | Last push | Open issues | Signal |
| --- | --- | --- | --- |
| `graphology/graphology` | 2026-09-02 | 87 | Maintainer commits plus an outside PR merged after review feedback. Human. |
| `jacomyal/sigma.js` | 2026-08-20 | 15 | Human commits, 12.1k stars. |
| `sim51/react-sigma` | 2025-12-05 | 3 | Single human maintainer, small and triaged. 9 months quiet. |

This settles the claim ADR-0003 originally asserted without evidence: the
`graphology` monorepo does publish, and its stale-looking leaf packages are
leaves that need no changes, not abandonment.

**Pin `sigma` to 3.0.3, not v4.** `sigma@4.0.0-beta.5` shipped 2026-08-20 and
v4 is announced on the project's site, but `latest` is still 3.0.3 and
`@react-sigma/core` 5.0.6 targets sigma 3. Revisit when v4 is stable *and*
`@react-sigma` supports it; taking the beta now means owning the React binding
ourselves.

## Accepted exceptions

- **`graphology-layout-forceatlas2` 0.10.1, last published 2022-10-17.** Four
  years without a release. Accepted: ForceAtlas2 is a frozen algorithm from a
  2014 paper, and the package is a leaf of the `graphology` monorepo, which does
  publish. A leaf that needs no changes does not get republished. Revisit if
  sigma 4 changes the layout contract.
- **`graphology` 0.26.0, last published 2025-01-26.** Core data structure, low
  churn by design. Accepted.

Both are worth re-checking at the 20-hour checkpoint rather than assumed stable
forever. If either is the reason something is hard, that is the signal to move,
and it should be said rather than worked around.
