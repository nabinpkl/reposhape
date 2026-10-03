# reposhape

## What this is

A local web app that shows what a codebase actually looks like as a graph of its
own files importing each other, with vendored and generated code scoped out.

You point it at a repo. It parses every source file with tree-sitter, resolves
each import specifier to a real file in that repo, and serves the file-level
import graph: nodes are files, edges are imports, clusters are Louvain
communities over import edges only.

## Why it exists

The prior attempt, a script (`graphify-import-graph.py`) post-processing
graphify's output for one private TypeScript and Python monorepo, works and
proved the idea. Its limits are what this replaces:

1. **It is a post-processor on a tool that answers a different question.**
   graphify clusters over every edge type at once, so Swift's `Equatable`
   protocol, defined nowhere in the repo, bridged 246 unrelated types into one
   community. The fix was to throw away ~95% of graphify's 48MB output and keep
   only import edges. At that point the dependency is carrying nothing.
2. **File contents are embedded inline.** The generated HTML is 11.9MB because
   all 1,260 files are baked into a `<script>` tag. One 619KB file had to be
   skipped outright, and the embedded copies go stale the moment you edit.
3. **Clustering is frozen at generation time.** Excluding `app/wire` in
   the UI hides those nodes, but the clusters were computed with wire still in
   them. You are looking at a partition of a graph you are no longer viewing.
4. **Every change is a full regenerate.** No incremental re-parse, no watch.

A server fixes 2 and 3 for free and makes 4 possible. Owning the parser
removes 1.

## Gap claim

I am building this instead of reusing an existing tool because I ran the
existing tools and hit specific walls:

- **graphify 0.9.57** (used daily for a week, 2026-09): clusters on all edge
  types; `--exclude-hubs` is statistical, not a scope decision, and suppresses
  genuine architectural hubs as readily as stdlib protocols. `.graphifyignore`
  fixes scope but not the clustering axis.
- **Sourcetrail** (petermost fork, maintained through Dec 2025): the closest
  match for interactive symbol graphs. Covers C, C++, Java, Python. No
  TypeScript. Not a fit.
- **dependency-cruiser / madge**: mature and correct, JS/TS only. Would cover
  the TypeScript packages but not the Python tools beside them.
- **CodeScene**: paid, and answers the co-change question, not the import one.

Nothing covers TS plus Python in one graph with per-path scoping. That is the
gap, and it is verified by use rather than by reading feature matrices.

## Non-goals for v0

- Symbol-level edges. Files only. graphify already showed that symbol-level
  granularity is where the hub-pollution problem lives.
- Any LLM. Clusters are labeled by longest common path prefix. If a label reads
  badly, that is information about the cluster.
- Auth, multi-user, deployment, a database.
- Swift. Its `import <Module>` names a module, not a file, and resolution is
  per-build-target. That is a different design and it waits.

## v0 acceptance test

Point it at the monorepo (the private repo it was built against), and:

1. Analysis completes with visible progress and no manual pre-step.
2. The graph renders TS/JS plus Python files, tests excluded, vendored
   directories excluded, at interactive frame rates.
3. Unchecking `app/wire/index.ts` alone, at file depth rather than
   folder depth, re-runs clustering without it and the cluster count changes.
4. Clicking a file shows its current contents, read from disk at click time,
   with correct content for a file edited since the analysis ran.
5. Clicking a node isolates it plus its 1-hop neighbours, and that composes
   with the path filter rather than overriding it.

Done is the owner opening this instead of regenerating `IMPORT_GRAPH.html`.
A clean tree is not done.
