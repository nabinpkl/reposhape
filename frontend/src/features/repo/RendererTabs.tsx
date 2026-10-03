"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { cn } from "@/lib/class-names";

/**
 * Which drawing of the repo is on screen.
 *
 * `ours` is the sigma canvas over our clustering. `map`, `map-lines` and
 * `map-edges` are the same analysis with the files packed into their folders,
 * differing in what a dot's area means -- one file, or one file's length -- and
 * in whether the imports that leave a package are drawn over them. They are
 * separate tabs rather than one tab with toggles so the split view can hold any
 * pair of them, and the difference is read by looking rather than by
 * remembering. `graphify` is graphify's own vis-network page, framed verbatim;
 * `graphify-files` is that same renderer over file-level data, one node per
 * file and no symbols.
 */
export type Renderer = "ours" | "map" | "map-lines" | "map-edges" | "graphify" | "graphify-files";

/**
 * True for a renderer that frames somebody else's page.
 *
 * A framed pane carries its own sidebar and legend, so ours are hidden and the
 * graph is not fetched for it. Everything else draws from the `GraphView` this
 * app already has, which is what makes those tabs comparable rather than merely
 * adjacent.
 */
export function isFramed(renderer: Renderer): boolean {
  return renderer === "graphify" || renderer === "graphify-files";
}

/**
 * Ours versus theirs, as a drawing rather than as data.
 *
 * The source tabs switch which extractor's edges feed one renderer; this
 * switches the renderer itself. A repo with no graphify page keeps the tab
 * visible but disabled with the build command on hover, for the same reason a
 * missing extractor is shown rather than hidden.
 */
export function RendererTabs({
  analysisKey,
  renderer,
  onRenderer,
}: {
  analysisKey: string;
  renderer: Renderer;
  onRenderer: (renderer: Renderer) => void;
}) {
  const status = useQuery({
    queryKey: ["graphify-status", analysisKey],
    queryFn: () => api.graphifyStatus(analysisKey),
  });
  const ready = status.data?.ready ?? false;
  const filesStatus = useQuery({
    queryKey: ["graphify-files-status", analysisKey],
    queryFn: () => api.graphifyFilesStatus(analysisKey),
  });
  const filesReady = filesStatus.data?.ready ?? false;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-px rounded border border-line-strong p-px">
      <Tab id="ours" active={renderer} onPick={onRenderer}>
        ours
      </Tab>
      <Tab
        id="map"
        active={renderer}
        onPick={onRenderer}
        title="Files packed into their folders, one dot each, no edges."
      >
        map
      </Tab>
      <Tab
        id="map-lines"
        active={renderer}
        onPick={onRenderer}
        title="The same map with every dot sized by its file's line count."
      >
        map · lines
      </Tab>
      <Tab
        id="map-edges"
        active={renderer}
        onPick={onRenderer}
        title="The map, with the imports that leave their package drawn over it."
      >
        map · edges
      </Tab>
      <Tab
        id="graphify-files"
        active={renderer}
        onPick={onRenderer}
        disabled={!filesReady}
        title={filesStatus.data?.reason ?? undefined}
      >
        graphify files
      </Tab>
      <Tab
        id="graphify"
        active={renderer}
        onPick={onRenderer}
        disabled={!ready}
        title={status.data?.reason ?? undefined}
      >
        graphify page
      </Tab>
    </div>
  );
}

/** One tab. Five copies of the same className block is how they drift apart. */
function Tab({
  id,
  active,
  onPick,
  disabled = false,
  title,
  children,
}: {
  id: Renderer;
  active: Renderer;
  onPick: (renderer: Renderer) => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={() => onPick(id)}
      className={cn(
        "rounded-sm px-2 py-1 text-[11.5px] whitespace-nowrap transition-colors",
        active === id ? "bg-line text-fg" : "text-muted hover:bg-line/60 hover:text-fg",
        disabled && "cursor-not-allowed text-faint hover:bg-transparent hover:text-faint",
      )}
    >
      {children}
    </button>
  );
}
