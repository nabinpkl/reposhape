"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { FileViewer } from "@/features/file-view/FileViewer";
import { ClusterLegend } from "@/features/filters/ClusterLegend";
import { ExtensionFilter } from "@/features/filters/ExtensionFilter";
import { PathFilter } from "@/features/filters/PathFilter";
import { ShapeControls } from "@/features/filters/ShapeControls";
import { useFilters, useGraphShape } from "@/features/filters/filterStore";
import { GraphifyFiles } from "@/features/graph/GraphifyFiles";
import { GraphifyPage } from "@/features/graph/GraphifyPage";
import { NodeInfo } from "@/features/graph/NodeInfo";
import type { EdgeSummary } from "@/features/map/mapEdges";
import { MapCanvas } from "@/features/map/MapCanvas";
import { isFramed } from "@/features/repo/RendererTabs";
import { RepoBar, type Renderer } from "@/features/repo/RepoBar";
import { useReadOnly } from "@/features/repo/serverMode";
import { AppShell, PaneHeading, ScrollPane } from "@/features/shell/AppShell";
import { ComparePane } from "@/features/shell/ComparePane";
import { api } from "@/lib/api";
import type { RepoSummary } from "@/generated/contracts";

/**
 * The canvas never renders on the server.
 *
 * sigma touches `WebGL2RenderingContext` while its module is being evaluated,
 * not when a renderer is constructed, so merely importing it in a server render
 * throws `ReferenceError: WebGL2RenderingContext is not defined`. Marking the
 * route dynamic does not help: a dynamic route still runs on the server, it
 * just runs per request. `ssr: false` is what actually keeps the import in the
 * browser.
 */
const GraphCanvas = dynamic(
  () => import("@/features/graph/GraphCanvas").then((module) => module.GraphCanvas),
  { ssr: false },
);

/**
 * `?repo=<cache key>` is how the terminal hands over: `reposhape up` analyses the repo
 * you ran it in and prints a URL carrying that key, so the browser opens on the
 * graph rather than on a picker with one entry.
 *
 * Read through `useSyncExternalStore` because this component is server-rendered
 * and `window` does not exist for that pass. The server snapshot is null and the
 * client snapshot is the real parameter, which is exactly the split React
 * resolves without a hydration mismatch. Nothing subscribes: the address bar is
 * only ever written by this app, and a write is already accompanied by the state
 * change it describes.
 */
const NO_SUBSCRIPTION = () => () => {};

function useRequestedRepo(): string | null {
  return useSyncExternalStore(
    NO_SUBSCRIPTION,
    () => new URLSearchParams(window.location.search).get("repo"),
    () => null,
  );
}

export function Workspace() {
  const requestedRepo = useRequestedRepo();
  // `undefined` is "nothing picked this session, so follow the URL"; `null` is
  // "picked nothing", which is where forgetting the last repo leaves you. One
  // null for both let the forgotten key in the URL win again on the next render.
  const readOnly = useReadOnly();
  const [pickedKey, setPickedKey] = useState<string | null | undefined>(undefined);
  const [openFile, setOpenFile] = useState<{ key: string; path: string } | null>(null);
  const [renderer, setRenderer] = useState<Renderer>("ours");
  // Split view: the right pane follows the primary key until its own source is
  // picked, so opening split on a repo compares that repo with itself. A null
  // right key means "follow", never "empty".
  const [split, setSplit] = useState(false);
  const [rightKey, setRightKey] = useState<string | null>(null);
  const [rightRenderer, setRightRenderer] = useState<Renderer>("graphify");
  // Drawer state for the phone: below md the sidebar is off-canvas until
  // this opens it. Desktop never reads it; the grid cell is always there.
  const [sidebarOpen, setSidebarOpen] = useState(false);  // The inspector lives behind a header toggle: a permanent third column
  // steals a third of every canvas even when nothing is selected. An opened
  // file always brings it back, whatever the toggle says.
  const [asideOpen, setAsideOpen] = useState(false);
  // What the edges tab resolved "a package" to. It is derived from the packing
  // rather than from the view, so the canvas is the only thing that can know
  // it, and it is reported up because the question it answers -- what counts
  // as leaving a package -- belongs beside the other counts rather than in a
  // tooltip on one dot.
  const [edgeSummary, setEdgeSummary] = useState<EdgeSummary | null>(null);
  // The toggle owns visibility outright: opening a file raises the panel,
  // and lowering the toggle drops the file with it, so the button never
  // lies about what is on screen.
  const onAside = useCallback(
    (open: boolean) => {
      setAsideOpen(open);
      if (!open) setOpenFile(null);
    },
    [],
  );
  const asideVisible = asideOpen || openFile !== null;
  const { shape, settling } = useGraphShape();
  const clearView = useFilters((state) => state.clearView);
  // Dimmed paths belong to one repo's graph; a switch must not carry them
  // across. (clearView stays dim-agnostic on purpose: Escape must not undim
  // deliberate state.)
  const clearDimmed = useFilters((state) => state.clearDimmed);

  // A repo picked in this session wins over the one the URL arrived with, and
  // the picker writes its choice back to the URL, so the two never disagree for
  // longer than the click.
  const analysisKey = pickedKey === undefined ? requestedRepo : pickedKey;

  // The shape is the query key, so a filter change is a fetch plus a fresh
  // partition, and going back to a previous filter is a cache hit.
  // The filter tree describes the repository, so it is fetched once per repo and
  // never narrows with the view. Building it from `graph.nodes` instead made a
  // folder disappear from the tree the moment it was excluded, leaving no row to
  // click to bring it back.
  const paths = useQuery({
    queryKey: ["paths", analysisKey],
    queryFn: () => api.paths(analysisKey!),
    enabled: analysisKey !== null && !isFramed(renderer),
  });

  const graph = useQuery({
    queryKey: ["graph", analysisKey, shape],
    queryFn: () => api.graph(analysisKey!, shape),
    // The map draws from this same view, so switching to it is a repaint of
    // data already in the cache rather than a second fetch and partition.
    enabled: analysisKey !== null && !isFramed(renderer),
  });

  const writeUrl = useCallback((key: string) => {
    // Keep the address bar describing what is on screen, so the tab is worth
    // bookmarking and a reload comes back to the same repo. `replaceState`,
    // not `pushState`: picking a repo is not a navigation, and making Back
    // walk the picker would take a reader out of the page to leave it.
    const url = new URL(window.location.href);
    url.searchParams.set("repo", key);
    window.history.replaceState(null, "", url);
  }, []);

  const onPickRepo = useCallback(
    (summary: RepoSummary) => {
      setPickedKey(summary.key);
      setOpenFile(null);
      // A framed page belongs to the repo it was built for, so it cannot
      // survive the pick. Our own renderers can, and dropping a reader back
      // onto the graph every time they change repo would undo their choice.
      if (isFramed(renderer)) setRenderer("ours");
      setSidebarOpen(false);
      clearView();
      clearDimmed();
      writeUrl(summary.key);
    },
    [clearView, clearDimmed, renderer, writeUrl],
  );

  // Forgetting can take the repo on screen, the right pane's source, or the file
  // open in the inspector, and each has to let go of a key that now 404s. The
  // right pane falls back to following, which is what null means there.
  const onForget = useCallback(
    (removed: string[], next: RepoSummary | null) => {
      setRightKey((key) => (key !== null && removed.includes(key) ? null : key));
      setOpenFile((file) => (file && removed.includes(file.key) ? null : file));
      if (analysisKey === null || !removed.includes(analysisKey)) return;
      if (next) {
        onPickRepo(next);
        return;
      }
      setPickedKey(null);
      if (isFramed(renderer)) setRenderer("ours");
      clearView();
      clearDimmed();
      const url = new URL(window.location.href);
      url.searchParams.delete("repo");
      window.history.replaceState(null, "", url);
    },
    [analysisKey, clearView, clearDimmed, onPickRepo, renderer],
  );

  // A source switch inside a pane picks data, and data draws through one of
  // our renderers: leaving a pane on the graphify page would answer the click
  // with the same framed artifact, a silent no-op. The map and the graph both
  // redraw from the new source, so neither is disturbed.
  const onPickSource = useCallback(
    (summary: RepoSummary) => {
      setPickedKey(summary.key);
      if (isFramed(renderer)) setRenderer("ours");
      setOpenFile(null);
      clearView();
      clearDimmed();
      writeUrl(summary.key);
    },
    [clearView, clearDimmed, renderer, writeUrl],
  );

  const onPickRightSource = useCallback(
    (summary: RepoSummary) => {
      setRightKey(summary.key);
      if (isFramed(rightRenderer)) setRightRenderer("ours");
      setOpenFile(null);
      clearView();
      clearDimmed();
    },
    [clearView, clearDimmed, rightRenderer],
  );

  const onOpenFile = useCallback(
    (path: string, key: string) => setOpenFile({ key, path }),
    [],
  );

  const onDismissFile = useCallback(() => setOpenFile(null), []);

  // Stable per key: an inline arrow here would be a new identity every render
  // and remount the canvas (and its renderer) each time.
  const onOpenFilePrimary = useCallback(
    (path: string) => {
      if (analysisKey) onOpenFile(path, analysisKey);
    },
    [analysisKey, onOpenFile],
  );

  // Escape closes the file pane, then clears focus. One key, most recent thing
  // first, which is what a reader expects from a stack of transient state.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (sidebarOpen) setSidebarOpen(false);
      else if (openFile) setOpenFile(null);
      else clearView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFile, clearView, sidebarOpen]);

  const view = graph.data;
  // Either framed renderer hides the sidebar controls: both carry their own
  // sidebar and legend, so our filters, focus and file pane do not apply.
  const framed = isFramed(renderer) && analysisKey !== null;
  const rightPaneKey = rightKey ?? analysisKey;
  const asideContent = openFile ? (
    <FileViewer
      analysisKey={openFile.key}
      path={openFile.path}
      onClose={() => setOpenFile(null)}
      onOpenFile={(path) => {
        // The same as clicking its disc: focus it and open it.
        useFilters.getState().setFocus(path);
        onOpenFile(path, openFile.key);
      }}
    />
  ) : asideOpen && !isFramed(renderer) && view ? (
    <>
      <PaneHeading>Selected file</PaneHeading>
      <ScrollPane>
        <NodeInfo view={view} onOpenFile={(path) => onOpenFile(path, analysisKey!)} />
      </ScrollPane>
    </>
  ) : null;

  return (
    <AppShell
      sidebarOpen={sidebarOpen}
      onCloseSidebar={() => setSidebarOpen(false)}
      header={
        <RepoBar
          activeKey={analysisKey}
          onPick={onPickRepo}
          onForget={onForget}
          renderer={renderer}
          onRenderer={setRenderer}
          split={split}
          onSplit={setSplit}
          showTabs={!split}
          asideOpen={asideVisible}
          onAside={onAside}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
      }
      sidebar={
        framed ? (
          <>
            <PaneHeading>{renderer === "graphify" ? "graphify page" : "graphify files"}</PaneHeading>
            <p className="px-3 py-2 text-[12px] text-muted">
              {renderer === "graphify"
                ? "graphify's own rendering, framed verbatim. Our filters, focus and file pane do not apply here — the page carries its own sidebar and legend."
                : "graphify's renderer over this analysis: files only, no symbols. Drawn on demand through its own exporter, with our partition and labels."}
            </p>
          </>
        ) : (
          <>
          {view ? <ShapeControls stats={view.stats} /> : null}

          <PaneHeading>Filter by extension</PaneHeading>
          <ScrollPane className="border-b border-line">
            {paths.data ? (
              <ExtensionFilter paths={paths.data.paths} />
            ) : (
              <Empty>No graph loaded.</Empty>
            )}
          </ScrollPane>

          <PaneHeading>Filter by path</PaneHeading>
          <ScrollPane className="border-b border-line">
            {paths.data ? (
              <PathFilter paths={paths.data.paths} onOpenFile={(path) => onOpenFile(path, analysisKey!)} />
            ) : (
              <Empty>No graph loaded.</Empty>
            )}
          </ScrollPane>

          <PaneHeading>Clusters</PaneHeading>
          <ScrollPane>
            {view ? <ClusterLegend clusters={view.clusters} /> : null}
          </ScrollPane>

          {view ? <StatsFooter view={view} edges={edgeSummary} /> : null}
          </>
        )
      }
      main={
        split ? (
          <div className="absolute inset-0 flex flex-col md:flex-row">
            <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden border-b border-line md:border-r md:border-b-0">
              <ComparePane
                paneKey={analysisKey}
                renderer={renderer}
                onKey={onPickSource}
                onRenderer={setRenderer}
                onOpenFile={onOpenFile}
              />
            </div>
            <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
              <ComparePane
                paneKey={rightPaneKey}
                renderer={rightRenderer}
                onKey={onPickRightSource}
                onRenderer={setRightRenderer}
                onOpenFile={onOpenFile}
              />
            </div>
          </div>
        ) : renderer === "graphify" && analysisKey ? (
          <GraphifyPage analysisKey={analysisKey} />
        ) : renderer === "graphify-files" && analysisKey ? (
          <GraphifyFiles analysisKey={analysisKey} />
        ) : (
          <>
          {view && renderer === "ours" ? (
            <GraphCanvas view={view} onOpenFile={onOpenFilePrimary} />
          ) : null}
          {view && renderer !== "ours" ? (
            <MapCanvas
              view={view}
              sizing={renderer === "map-lines" ? "lines" : "files"}
              edges={renderer === "map-edges"}
              onOpenFile={onOpenFilePrimary}
              onDismiss={onDismissFile}
              onSummary={setEdgeSummary}
            />
          ) : null}
          {graph.isFetching || settling ? <Overlay>Clustering…</Overlay> : null}
          {graph.error ? (
            <Overlay tone="error">{(graph.error as Error).message}</Overlay>
          ) : null}
          {!analysisKey ? (
            <Overlay>
              {/* A visitor to a read-only server cannot analyse anything. */}
              {readOnly ? "Pick a repo to begin." : "Pick a repo, or analyse a path, to begin."}
            </Overlay>
          ) : null}
          </>
        )
      }
      aside={asideVisible && asideContent ? asideContent : undefined}
    />
  );
}

function StatsFooter({
  view,
  edges,
}: {
  view: { stats: { visible_files: number; total_files: number; visible_edges: number; clusters: number } };
  edges: EdgeSummary | null;
}) {
  const { stats } = view;
  return (
    <div className="shrink-0 border-t border-line px-3 py-2 text-[10.5px] tabular-nums text-faint">
      <p>
        {stats.visible_files.toLocaleString()} of {stats.total_files.toLocaleString()} files ·{" "}
        {stats.visible_edges.toLocaleString()} edges · {stats.clusters} clusters
      </p>
      {edges ? (
        <p className="mt-0.5">
          {edges.crossing.toLocaleString()} of them leave a package
          {stats.visible_edges > 0
            ? ` (${Math.round((edges.crossing / stats.visible_edges) * 100)}%)`
            : null}{" "}
          · {edges.packages.count.toLocaleString()} packages
          {edges.packages.inside ? ` under ${edges.packages.inside}/` : ", top level"}
        </p>
      ) : null}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2 text-[12px] text-faint italic">{children}</p>;
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
