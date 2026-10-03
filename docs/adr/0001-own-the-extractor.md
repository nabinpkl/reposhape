# ADR-0001: Own the extractor, drop graphify

- Status: accepted
- Date: 2026-09-11

## Context

`an earlier script, graphify-import-graph.py` reads graphify's `graph.json` and
keeps only edges whose relation is in
`{imports, imports_from, re_exports, dynamic_import}`, collapsed to file
granularity, with external targets dropped.

Measured on the monorepo (the private repo this tool was first built against, see SPEC.md): `graph.json` is 48MB and holds 29,402 nodes after
`.graphifyignore` scoping. The import-only projection that survives is 1,260
files and 2,923 edges. Everything else, the calls, references, conformances and
containment that make graphify worth running, is discarded, and it is exactly
that extra edge mass that produced the `Equatable` problem the projection exists
to avoid.

## Decision

Parse imports directly with tree-sitter. No graphify dependency.

## Consequences

- No external CLI, no 48MB intermediate, no LLM-capable pipeline sitting behind
  a tool that makes no LLM calls.
- Incremental re-parse becomes possible: tree-sitter is an incremental parser
  and a changed file is one re-parse, where graphify is a whole-repo rebuild.
- We own the edge semantics, including whether a type-only import counts as a
  dependency. graphify had no opinion we could set.
- Cost: an import-resolution rule set per language, which is the real work.
  Extraction is a tree-sitter query; resolution is aliases, extension probing,
  workspaces, and `extends` chains. Budget accordingly.
- graphify remains installed and useful for symbol-level questions. This does
  not replace it, it stops depending on it.
