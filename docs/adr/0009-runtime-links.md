# ADR-0009: Runtime links, found by syntax and drawn over the import graph

- Status: accepted
- Date: 2026-09-29

## Context

The graph answers "what imports what". The curated repos showed where that
stops being the architecture. In hermes-agent, 100 of 111 bundled plugin
`__init__.py` files and 22 of 47 self-registering tools had no inbound import
outside tests. They are loaded by walking a directory, and they couple to the
core through hook names (`invoke_hook("pre_llm_call")` against
`register_hook("pre_llm_call", fn)`). The Python TUI gateway and the TypeScript
desktop app and TUI share an event protocol (`_emit("message.complete")`
against `case 'message.complete'`) and a process boundary
(`spawn(python, ['-m', 'tui_gateway.entry'])`). In opencode, 82 event types
defined in `packages/schema` reach the app and TUI as strings over SSE. All of
this reads as unconnected, and "why aren't these connected" was the question
the tool exists to answer.

The rule from `AGENTS.md` still holds: nothing here calls a model. A link has
to be as reproducible as an import edge.

## Decision

**Three kinds of runtime link, each found by syntax.**

- `event`: a name written literally as the first argument of a sending call
  (`emit`, `publish`, `invoke_hook`, `run_hook`, or `X.define({type})`) and of
  a receiving one (`on`, `once`, `subscribe`, `addListener`, `add_listener`,
  `register_hook`, `addEventListener`, `case "x"`, `x.type === "x"`), in two
  different files. One link per (name, sender file, receiver file). A leading
  underscore on the callee is stripped (`invoke_hook as _invoke_hook`).
- `process`: `"-m", "pkg.module"` adjacent in an argv list or array, resolved
  with the Python resolver exactly as an import would be.
- `loader`: from a rules file the operator writes, `<repo name>.toml` in
  `REPOSHAPE_LINK_RULES_DIR` (default `~/.config/reposhape/links`). A rule
  names the loader file, an anchor line in it, globs for what it loads, and
  optionally text each loaded file must contain. Nothing in a directory walk
  names its targets, so these are written down from the loader's source, never
  guessed.

**What is dropped is counted.** A one-word lowercase name (`error`, `data`,
`exit`) is a library stream event and would link every stream user to every
other; these are dropped and counted as `generic_names`. A name that is not a
literal (`emit(name)`) is counted as `dynamic_names`. A name with only one end
in the repo is `keys_unpaired`. A rule that matches nothing, or names a file
that is not there, is a `problems` entry carried with the analysis.

**Clustering stays on imports.** Links are carried beside the edges
(`Analysis.links`, `GraphView.links`) and never enter the partition or the
layout. Feeding them in would pull every hook sender and handler into one
cluster and move the drawing every time a rules file changed.

**Shown two ways.** A dashed layer on the graph, off by default, for links
whose ends are both visible; and a "Reached without an import" section in the
file pane, served by `GET /api/links/{key}?path=` from the whole artifact,
because the other end is often a file the current filter hides.

Measured 2026-09-29 on the local clones: 20 of 20 sampled hermes event links
and 19 of 20 opencode ones were real. The miss was `block.type === "tool_use"`
in an Anthropic protocol adapter, a discriminated union read that shares a
name with an unrelated `emit("tool_use")`.

## Consequences

- Schema 4. Artifacts are regenerated, never migrated.
- The `x.type === "x"` receiver is the least precise rule: a `type` field
  compared to a string is also how any discriminated union is read. It pairs
  only when the same name is sent elsewhere, which is what keeps it usable.
- The rules file lives outside the repo, keyed by repo name, because the
  repos that need it most are clones the operator does not own. Two repos with
  the same name share a rules file.
- Receiving through a typed event object (`subscribe(Integration.Event.X)`)
  is already an import of the defining module, so it is not a runtime link.
- Not covered: HTTP routes between a client and a server (framework-specific
  route syntax), Vue component events, langchain's callback dispatch through a
  base class, and skill scripts run by path on a model's instruction.
- The pass costs about 5 s on hermes-agent's 10,045 files, most of it saved
  by a regex prefilter that is checked to lose no match on either repo.
