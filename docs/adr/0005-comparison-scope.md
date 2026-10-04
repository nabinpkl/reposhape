# ADR-0005: the comparison shares one file universe

- Superseded by ADR-0013: the graphify projections are gone.

## Decision

The graphify projections (`graphify-imports`, `graphify-all`) keep only files
our own `imports` analysis also sees. `graphify.ensure_scope` builds that set
from the cached `imports` artifact, analysing first when there is none, and
every scoped file becomes a node, edge or no edge.

## Why

An unscoped projection compared different node sets as well as different
edges: 1,606 files to our 1,262, most of the gap Swift, Rust, shell and
Markdown this tool deliberately does not parse. No filter count could then be
honest for both panes at once -- the extension filter read `.swift 0` off our
paths while the graphify pane drew 740 Swift files -- and a cluster-size gap
could be read as an extractor finding when it was a universe finding.

Scoped, both tabs draw identical nodes and differ only in edges, which is the
claim under test. A scoped file graphify never saw is an isolate rather than
absent, so "no edge here" draws as no edge rather than as a missing file.

## Consequences

- Asking for a graphify tab builds the `imports` analysis first when nothing
  is cached (~2.5s on a 1,260-file repo). The repos picker gains that row as a side
  effect, which is true: it was built.
- A cached scoped projection goes stale with the `imports` analysis it was
  scoped from. Same staleness story as every cached artifact here: re-analyse,
  never migrate.
- Swift's `import Module` names a module rather than a file and resolves per
  build target, so Swift stays out of scope until that design exists (PRD
  non-goals). The `.swift` checkbox reads 0 everywhere until then, honestly.
