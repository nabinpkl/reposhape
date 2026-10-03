import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import type { GraphShape } from "@/lib/api";

/**
 * The one filter model.
 *
 * The prior POC had filtering scattered across a checkbox DOM tree, a
 * generation-time test flag, a focus mode and a search box, each keeping its
 * own state and composing by accident. The rule that made it behave was
 * "the path filter wins over focus", enforced by hand in one branch.
 *
 * Here that rule is structural rather than written down. Filters come in two
 * kinds and the kind decides where the state lives:
 *
 *   SHAPE  changes which files exist in the graph. It is sent to the server,
 *          which re-runs Louvain on what is left, so the cluster count moves.
 *          An excluded file is not in the response at all, which is why it
 *          cannot reappear inside a focused neighbourhood: there is nothing to
 *          reappear. No precedence rule needed.
 *
 *   VIEW   changes what is drawn from a graph that did not change. It never
 *          re-clusters and never touches the network.
 *
 *          `dimmed` is the view half of "not this file": the node and its edges
 *          draw toward the ground while everything stays clustered where it was.
 *          `excluded` is the shape half ("hide from graph"): the file leaves the
 *          response and the server re-clusters what is left.
 *
 * Shape is the TanStack Query key. View is read by sigma's reducers. Neither
 * copies the other, and no component holds a third copy.
 */

interface FilterState {
  // --- shape: server-side, re-clusters ---
  excluded: ReadonlySet<string>;
  includeTests: boolean;
  includeTypeOnly: boolean;
  excludedExtensions: ReadonlySet<string>;

  // --- view: client-side, draw-only ---
  focusedPath: string | null;
  search: string;
  dimmed: ReadonlySet<string>;
  /** Runtime links (ADR-0009) drawn over the graph. Draw-only: never re-clusters. */
  showLinks: boolean;

  setExcluded(path: string, excluded: boolean): void;
  setManyExcluded(paths: readonly string[], excluded: boolean): void;
  clearExcluded(): void;
  setIncludeTests(value: boolean): void;
  setIncludeTypeOnly(value: boolean): void;
  setExcludedExtension(ext: string, excluded: boolean): void;
  clearExcludedExtensions(): void;

  setFocus(path: string | null): void;
  setSearch(value: string): void;
  setDimmed(path: string, dimmed: boolean): void;
  clearDimmed(): void;
  clearView(): void;
  setShowLinks(value: boolean): void;
}

export const useFilters = create<FilterState>()((set) => ({
  excluded: new Set<string>(),
  includeTests: false,
  includeTypeOnly: true,
  excludedExtensions: new Set<string>(),
  focusedPath: null,
  search: "",
  dimmed: new Set<string>(),
  showLinks: false,

  setExcluded: (path, excluded) =>
    set((state) => {
      const next = new Set(state.excluded);
      if (excluded) next.add(path);
      else next.delete(path);
      return { excluded: next };
    }),

  setManyExcluded: (paths, excluded) =>
    set((state) => {
      const next = new Set(state.excluded);
      for (const path of paths) {
        if (excluded) next.add(path);
        else next.delete(path);
      }
      return { excluded: next };
    }),

  clearExcluded: () => set({ excluded: new Set<string>() }),
  setIncludeTests: (includeTests) => set({ includeTests }),
  setIncludeTypeOnly: (includeTypeOnly) => set({ includeTypeOnly }),

  setExcludedExtension: (ext, excluded) =>
    set((state) => {
      const next = new Set(state.excludedExtensions);
      if (excluded) next.add(ext);
      else next.delete(ext);
      return { excludedExtensions: next };
    }),

  clearExcludedExtensions: () => set({ excludedExtensions: new Set<string>() }),

  setFocus: (focusedPath) => set({ focusedPath }),
  setSearch: (search) => set({ search }),

  setDimmed: (path, dimmed) =>
    set((state) => {
      const next = new Set(state.dimmed);
      if (dimmed) next.add(path);
      else next.delete(path);
      return { dimmed: next };
    }),

  clearDimmed: () => set({ dimmed: new Set<string>() }),
  clearView: () => set({ focusedPath: null, search: "" }),
  setShowLinks: (showLinks) => set({ showLinks }),
}));

/**
 * The shape half, in the stable form a query key needs.
 *
 * Sorted because a Set's iteration order follows insertion, so unchecking A
 * then B and unchecking B then A describe the same graph and must produce the
 * same key. Without the sort they are two cache entries and two round trips for
 * one answer.
 *
 * Deliberately NOT a store selector. A selector that builds an object returns a
 * new reference on every call, and zustand v5 compares references, so React
 * would see the snapshot change on every render and loop. Callers select the
 * four stable values and memoise this on them; `useGraphShape` does exactly
 * that, settles it, and is what components should use.
 */
export function shapeFrom(
  excluded: ReadonlySet<string>,
  includeTests: boolean,
  includeTypeOnly: boolean,
  excludedExtensions: ReadonlySet<string>,
): GraphShape {
  return {
    excluded: [...excluded].sort(),
    includeTests,
    includeTypeOnly,
    excludedExtensions: [...excludedExtensions].sort(),
  };
}

/**
 * How long the filter has to hold still before the server is asked for it.
 *
 * Every distinct shape is a Louvain run on a one-worker server, and nothing
 * cancels one once it starts. Unchecking 74 paths one by one on the deployed
 * hermes-agent page queued 74 of them and the page sat on "Clustering..." for
 * over a minute. A reader clicking through checkboxes is well under this gap
 * between clicks, so a burst settles into one request; a single click costs
 * this much extra latency, which the clustering it waits for dwarfs.
 */
export const SHAPE_SETTLE_MS = 400;

/**
 * The shape the server should be asked for, and whether a newer one is waiting.
 *
 * `shape` follows the store only once the four inputs have held still for
 * `SHAPE_SETTLE_MS`; the checkboxes themselves read the store and move at once.
 * `settling` is true in between, so the canvas can say its view is about to
 * change rather than look finished. Every caller of this builds a request from
 * the shape, which is why the settling lives here and not at each of them.
 */
export function useGraphShape(): { shape: GraphShape; settling: boolean } {
  const excluded = useFilters((state) => state.excluded);
  const includeTests = useFilters((state) => state.includeTests);
  const includeTypeOnly = useFilters((state) => state.includeTypeOnly);
  const excludedExtensions = useFilters((state) => state.excludedExtensions);
  const live = useMemo(
    () => shapeFrom(excluded, includeTests, includeTypeOnly, excludedExtensions),
    [excluded, includeTests, includeTypeOnly, excludedExtensions],
  );
  const [settled, setSettled] = useState(live);
  useEffect(() => {
    if (settled === live) return;
    const timer = setTimeout(() => setSettled(live), SHAPE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [live, settled]);
  return { shape: settled, settling: settled !== live };
}
