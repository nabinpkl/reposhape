"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useCallback } from "react";

import { useGraphShape } from "@/features/filters/filterStore";
import { GraphifyFiles } from "@/features/graph/GraphifyFiles";
import { GraphifyPage } from "@/features/graph/GraphifyPage";
import { MapCanvas } from "@/features/map/MapCanvas";
import { RendererTabs, isFramed, type Renderer } from "@/features/repo/RendererTabs";
import { SourceTabs } from "@/features/repo/SourceTabs";
import { api } from "@/lib/api";
import type { RepoSummary } from "@/generated/contracts";

/**
 * The canvas never renders on the server. Same reason as the primary pane's
 * import in Workspace: sigma touches `WebGL2RenderingContext` at module
 * evaluation, so this stays out of any server render.
 */
const GraphCanvas = dynamic(
  () => import("@/features/graph/GraphCanvas").then((module) => module.GraphCanvas),
  { ssr: false },
);

/**
 * One half of the split view: its own extractor key and its own renderer, so
 * any two drawings of the repo can sit side by side -- ours against graphify's
 * page, or two extractors through the same renderer.
 *
 * Queries are keyed exactly like the primary pane's, so a pane showing what
 * the other already fetched is a cache hit, not a second clustering. The
 * sidebar filters stay global: one filter state feeds every ours-pane at
 * once, which is what makes the two halves comparable rather than merely
 * adjacent.
 */
export function ComparePane({
  paneKey,
  renderer,
  onKey,
  onRenderer,
  onOpenFile,
}: {
  paneKey: string | null;
  renderer: Renderer;
  onKey: (summary: RepoSummary) => void;
  onRenderer: (renderer: Renderer) => void;
  onOpenFile: (path: string, key: string) => void;
}) {
  const { shape, settling } = useGraphShape();
  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repos });
  const active = repos.data?.find((row) => row.key === paneKey) ?? null;

  // Stable per key: an inline arrow would remount the canvas every render.
  const onOpenPaneFile = useCallback(
    (path: string) => {
      if (paneKey) onOpenFile(path, paneKey);
    },
    [onOpenFile, paneKey],
  );

  const graph = useQuery({
    queryKey: ["graph", paneKey, shape],
    queryFn: () => api.graph(paneKey!, shape),
    // Every unframed renderer draws from this one view, so a pane showing the
    // map and a pane showing the graph share a fetch and a partition.
    enabled: paneKey !== null && !isFramed(renderer),
  });
  const view = graph.data;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-2 py-1">
        {active ? (
          <>
            <SourceTabs active={active} onPick={onKey} />
            <RendererTabs analysisKey={active.key} renderer={renderer} onRenderer={onRenderer} />
          </>
        ) : (
          <span className="px-1 text-[11.5px] text-faint italic">Pick a repo above.</span>
        )}
      </div>
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {renderer === "graphify" && paneKey ? (
          <GraphifyPage analysisKey={paneKey} />
        ) : renderer === "graphify-files" && paneKey ? (
          <GraphifyFiles analysisKey={paneKey} />
        ) : (
          <>
            {view && renderer === "ours" ? (
              <GraphCanvas view={view} onOpenFile={onOpenPaneFile} />
            ) : null}
            {view && renderer !== "ours" ? (
              <MapCanvas
                view={view}
                sizing={renderer === "map-lines" ? "lines" : "files"}
                edges={renderer === "map-edges"}
                onOpenFile={onOpenPaneFile}
              />
            ) : null}
            {graph.isFetching || settling ? <Overlay>Clustering…</Overlay> : null}
            {graph.error ? (
              <Overlay tone="error">{(graph.error as Error).message}</Overlay>
            ) : null}
            {!paneKey ? <Overlay>Pick a repo above to begin.</Overlay> : null}
          </>
        )}
      </div>
    </div>
  );
}

function Overlay({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <p
        className={
          tone === "error"
            ? "max-w-md rounded border border-danger/40 bg-panel px-3 py-2 text-[12px] text-danger"
            : "rounded bg-panel/90 px-3 py-1.5 text-[12px] text-muted"
        }
      >
        {children}
      </p>
    </div>
  );
}
