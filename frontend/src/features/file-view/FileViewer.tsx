"use client";

import { useQuery } from "@tanstack/react-query";
import { Ban, ExternalLink, Eye, EyeOff, RotateCcw, X } from "lucide-react";

import { useFilters } from "@/features/filters/filterStore";
import { ScrollPane } from "@/features/shell/AppShell";
import { CodeBlock } from "@/features/file-view/CodeBlock";
import { LicenseNotice } from "@/features/file-view/LicenseNotice";
import { RuntimeLinks } from "@/features/file-view/RuntimeLinks";
import { api } from "@/lib/api";
import { cn } from "@/lib/class-names";

/**
 * The file viewer is its own pane, beside the graph.
 *
 * The POC put file contents into the 300px sidebar and hid the cluster legend
 * while they were showing, so reading a file meant losing the thing you were
 * reading it to understand, in a column too narrow for code. Here the graph
 * stays visible and navigable while a file is open, which is the whole point of
 * opening it from a graph.
 *
 * Contents are fetched per request, never embedded. That is what keeps the page
 * at kilobytes instead of the POC's 11.9MB, and it is why an edit on disk shows
 * up on the next click rather than at the next full regeneration.
 */
export function FileViewer({
  analysisKey,
  path,
  onClose,
  onOpenFile,
}: {
  analysisKey: string;
  path: string;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["file", analysisKey, path],
    queryFn: () => api.file(analysisKey, path),
  });

  // Dim is view-only (repaint, no re-cluster); hide is shape (the file leaves
  // the response and the server re-clusters). See filterStore for the split.
  const isDimmed = useFilters((state) => state.dimmed.has(path));
  const setDimmed = useFilters((state) => state.setDimmed);
  const isExcluded = useFilters((state) => state.excluded.has(path));
  const setExcluded = useFilters((state) => state.setExcluded);
  const setFocus = useFilters((state) => state.setFocus);

  const segments = path.split("/");
  const name = segments.at(-1) ?? path;

  const onToggleDim = () => setDimmed(path, !isDimmed);
  const onToggleHide = () => {
    setExcluded(path, !isExcluded);
    // A hidden node is gone from the next fetch; drop the focus that points
    // at it now rather than leaving the reducer aimed at nothing. The file
    // stays open so the panel itself is the way back.
    if (!isExcluded) setFocus(null);
  };

  return (
    <>
      <header className="flex shrink-0 items-start justify-between gap-2 border-b border-line px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate font-medium text-fg" title={path}>
            {name}
          </div>
          <div className="mt-0.5 break-all text-[11px] text-muted">{path}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close file"
          className="shrink-0 rounded p-1 text-muted transition-colors hover:bg-line hover:text-fg"
        >
          <X className="size-4" />
        </button>
      </header>

      <LicenseNotice analysisKey={analysisKey} path={path} />
      <RuntimeLinks analysisKey={analysisKey} path={path} onOpenFile={onOpenFile} />

      {data ? (
        <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5 text-[11px] text-faint">
          <span>{data.lines.toLocaleString()} lines</span>
          <span>{(data.bytes / 1024).toFixed(1)} KB</span>
          {data.truncated ? (
            <span className="flex items-center gap-1 text-amber-400">
              <ExternalLink className="size-3" />
              truncated for display
            </span>
          ) : null}
        </div>
      ) : null}

      <ScrollPane className="bg-canvas">
        {isLoading ? <Placeholder>Loading…</Placeholder> : null}
        {error ? (
          <Placeholder tone="error">{(error as Error).message}</Placeholder>
        ) : null}
      <div className="flex shrink-0 gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={onToggleDim}
          title={
            isDimmed
              ? "Bring the node and its edges back to full brightness"
              : "Dim the node and its edges without re-clustering"
          }
          className="flex flex-1 items-center justify-center gap-1.5 rounded border border-line-strong px-2 py-1 text-[11.5px] text-fg/90 hover:bg-line"
        >
          {isDimmed ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          {isDimmed ? "Undim" : "Dim from graph"}
        </button>
        <button
          type="button"
          onClick={onToggleHide}
          title={
            isExcluded
              ? "Bring the file back and re-cluster"
              : "Remove the file from the graph and re-cluster"
          }
          className="flex flex-1 items-center justify-center gap-1.5 rounded border border-line-strong px-2 py-1 text-[11.5px] text-fg/90 hover:bg-line"
        >
          {isExcluded ? <RotateCcw className="size-3.5" /> : <Ban className="size-3.5" />}
          {isExcluded ? "Unhide" : "Hide from graph"}
        </button>
      </div>

      {data ? <CodeBlock path={data.path} text={data.text} /> : null}
      </ScrollPane>
    </>
  );
}

function Placeholder({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <p className={cn("p-3 text-[12px]", tone === "error" ? "text-danger" : "text-faint")}>
      {children}
    </p>
  );
}
