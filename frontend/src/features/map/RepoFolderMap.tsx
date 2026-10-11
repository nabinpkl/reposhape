"use client";

import { useTheme } from "next-themes";
import { useMemo } from "react";
import { FolderMap, type LinkSummary, type MapLabels } from "reposhape-viewer";

import { useFilters } from "@/features/filters/filterStore";
import { fromGraphView } from "@/features/map/fromGraphView";
import type { GraphView } from "@/generated/contracts";

/** What the map says about a repo's links: they are imports. */
const IMPORT_LABELS: MapLabels = {
  root: "repo root",
  linkOut: (count) => `${count.toLocaleString()} import${count === 1 ? "" : "s"}`,
  linkIn: (count) => `${count.toLocaleString()} importer${count === 1 ? "" : "s"}`,
};

/**
 * The viewer's folder map over a repo's view, wired to this app's filters and
 * theme. Its own component so a focus or search change re-renders the map and
 * not the workspace around it.
 */
export function RepoFolderMap({
  view,
  sizing,
  edges,
  onOpenFile,
  onDismiss,
  onSummary,
}: {
  view: GraphView;
  sizing: "files" | "size";
  /** Draw the imports that cross a package boundary. */
  edges: boolean;
  onOpenFile: (path: string) => void;
  onDismiss?: () => void;
  onSummary?: (summary: LinkSummary | null) => void;
}) {
  const data = useMemo(() => fromGraphView(view), [view]);
  const focusedPath = useFilters((state) => state.focusedPath);
  const setFocus = useFilters((state) => state.setFocus);
  const search = useFilters((state) => state.search);
  const dimmed = useFilters((state) => state.dimmed);
  const { resolvedTheme } = useTheme();
  return (
    <div className="absolute inset-0">
      <FolderMap
        data={data}
        sizing={sizing}
        links={edges}
        theme={resolvedTheme === "light" ? "light" : "dark"}
        selected={focusedPath}
        onSelect={setFocus}
        highlight={search}
        dimmed={dimmed}
        onOpenFile={onOpenFile}
        onDismiss={onDismiss}
        onLinkSummary={onSummary}
        labels={IMPORT_LABELS}
      />
    </div>
  );
}
