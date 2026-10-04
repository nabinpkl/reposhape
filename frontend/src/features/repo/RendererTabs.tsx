"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { cn } from "@/lib/class-names";

/**
 * Which drawing of the repo is on screen.
 *
 * One row, grouped by what the data is, so the group says it once and each tab
 * only has to say how it is drawn. Files and their imports are this tool's own
 * extraction; `import-graph` lays them out by force, and the three folder tabs
 * pack the same files into their folders, differing in what a dot's area means
 * and in whether the imports that leave a package are drawn over them. Symbols
 * are graphify's: `symbol-graph` frames graphify's own page verbatim, because
 * symbol-level extraction is a non-goal here (PRD.md).
 *
 * Separate tabs rather than one tab with toggles, so the split view can hold
 * any pair of them and a difference is read by looking, not by remembering.
 */
export type Renderer = "import-graph" | "folders" | "folders-size" | "folders-imports" | "symbol-graph";

/**
 * True for a renderer that frames somebody else's page.
 *
 * A framed pane carries its own sidebar and legend, so ours are hidden and the
 * graph is not fetched for it. Everything else draws from the `GraphView` this
 * app already has.
 */
export function isFramed(renderer: Renderer): boolean {
  return renderer === "symbol-graph";
}

const SYMBOL_GRAPH = "Every function, class and method, and the calls between them, drawn by graphify.";

/**
 * The tab row. The symbol graph is shown disabled, with what builds it on
 * hover, when graphify has not produced a page for this repo: hiding it would
 * leave a reader no way to learn the view exists.
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
  const reason = status.data?.reason;

  return (
    // Wraps by group rather than scrolling, so a narrow screen still shows what
    // the data is beside every tab that draws it.
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <Group label="Files">
        <Tab
          id="import-graph"
          active={renderer}
          onPick={onRenderer}
          title="Each file is a dot and each import a line, laid out by ForceAtlas2."
        >
          import graph
        </Tab>
        <Tab
          id="folders"
          active={renderer}
          onPick={onRenderer}
          title="Folders as nested circles, one dot per file."
        >
          folders
        </Tab>
        <Tab
          id="folders-size"
          active={renderer}
          onPick={onRenderer}
          title="Dot area is the file's line count."
        >
          folders · size
        </Tab>
        <Tab
          id="folders-imports"
          active={renderer}
          onPick={onRenderer}
          title="Imports that leave their package, drawn over the folders."
        >
          folders · imports
        </Tab>
      </Group>
      <Group label="Symbols">
        <Tab
          id="symbol-graph"
          active={renderer}
          onPick={onRenderer}
          disabled={!ready}
          title={ready || !reason ? SYMBOL_GRAPH : `${SYMBOL_GRAPH} ${reason}`}
        >
          symbol graph
        </Tab>
      </Group>
    </div>
  );
}

/** What the data is, said once for the tabs that draw it. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-[11px] text-muted">{label}</span>
      {/* Wraps onto a second line only where one line cannot fit: a phone, or
          one half of the split view. */}
      <div className="flex min-w-0 flex-wrap items-center gap-px rounded border border-line-strong p-px">
        {children}
      </div>
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
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-pressed={active === id}
      onClick={() => onPick(id)}
      className={cn(
        "rounded-sm px-2 py-1 text-[11.5px] whitespace-nowrap outline-none transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        active === id
          ? "bg-line text-fg"
          : "text-muted hover:bg-line/60 hover:text-fg active:bg-line",
        disabled && "cursor-not-allowed text-faint hover:bg-transparent hover:text-faint",
      )}
    >
      {children}
    </button>
  );
}
