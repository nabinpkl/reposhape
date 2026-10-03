import type { QueryClient } from "@tanstack/react-query";

/**
 * What a re-analysis makes stale.
 *
 * An artifact is keyed by repo and source, so re-running one writes over the
 * same key and nothing in the query cache has a reason to refetch: the graph on
 * screen stays the one from before. Measured 2026-09-16 on a cloned repo whose
 * upstream had moved. The fetch landed, the checkout had the new file, the
 * stored analysis had four files, and the canvas kept showing three.
 *
 * Every per-analysis query is keyed `[name, analysisKey, ...]` -- graph, paths,
 * file, sources, both graphify statuses -- which is the same shape the forget
 * path already predicates on.
 */
export async function invalidateAnalysis(client: QueryClient, key: string): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["repos"] }),
    client.invalidateQueries({ predicate: (query) => query.queryKey[1] === key }),
  ]);
}
