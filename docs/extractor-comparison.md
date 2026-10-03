# The two extractors, measured on langchain

`PRD.md` claims this tool is worth building instead of reusing graphify. Until
2026-09-14 that claim was verified only on the monorepo, the private repo it was written
in and tuned against. This is the first measurement on a repo neither tool had
seen: a shallow clone of `langchain-ai/langchain`, 2,581 parsed Python files
across 21 packages under `libs/`.

Both sides are scoped to the same file universe by ADR-0005, so the node sets
are identical and only the edges differ.

| | edges |
|---|---|
| ours (`imports`) | 5,451 |
| graphify projected onto files (`graphify-imports`) | 7,371 |
| graphify, all 13 relations (`graphify-all`) | 8,803 |

The overlap is the interesting part, not the totals. 5,377 edges are in both,
which is 98.6% of ours. 74 are only ours. 1,994 are only graphify's.

## Where graphify's extra 1,994 edges come from

**1,633 of them (82%) are one edge we already draw, followed one hop further.**
`from langchain_core.messages import AIMessage` is, to us, an edge to
`langchain_core/messages/__init__.py`, the file the importing file names. To
graphify it is an edge to `messages/ai.py`, where the symbol is defined. Both
statements are true and they answer different questions. A file-level import
graph is about what a file names; following the re-export is a symbol-level
answer, and symbol-level edges are a stated v0 non-goal.

**77 of them are stdlib collisions, and they invert the architecture.**
`libs/core/langchain_core/tracers/core.py` contains `import logging`. graphify
resolves that to `libs/langchain/langchain_classic/callbacks/tracers/logging.py`.
`import copy` in `langchain_core/output_parsers/openai_functions.py` becomes an
edge to `langchain_classic/tools/file_management/copy.py`; `import enum` in
`runnables/configurable.py` becomes one to `output_parsers/enum.py`. The
resulting graph has 77 edges from `langchain-core` into `langchain-classic`,
which is backwards: core is the base package and depends on none of them. We
draw 0, because a dotted name that does not land on a repo file is recorded as
an external package with its reason rather than matched by basename.

This is the hub-pollution problem named in `PRD.md`, seen from a different
side. It is not a clustering artifact that a filter could remove: it is a wrong
edge, and a reader using the picture to answer "what depends on core" is
answering it wrongly.

## Where our 74 extra edges come from

Two kinds, both real imports graphify's extraction missed:

- **Deferred imports inside function bodies.**
  `langchain_classic/embeddings/base.py` does `from langchain_openai import
  OpenAIEmbeddings` inside a method, which is how the optional-dependency
  pattern is written throughout langchain.
- **Small modules with nothing worth a symbol.** `from
  langchain_fireworks._version import __version__` is an ordinary import of a
  file holding one assignment.

## What this does not settle

The comparison is one repo, and a Python one. Nothing here is evidence about
TypeScript, where our resolver has a monorepo question of its own: a pnpm
workspace importing a sibling by package name resolves only through a
`paths` entry, and that has not been measured against a real workspace.
