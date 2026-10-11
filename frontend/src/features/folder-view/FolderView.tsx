"use client";

import { FolderOpen, Loader2, Menu } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import { ClusterLegend } from "@/features/filters/ClusterLegend";
import { HighlightSearch } from "@/features/filters/HighlightSearch";
import { useFilters } from "@/features/filters/filterStore";
import { LocalFilePane } from "@/features/folder-view/LocalFilePane";
import { folderShape } from "@/features/folder-view/folderShape";
import {
  MAX_FILES,
  fromDirectoryEntry,
  fromFileList,
  type PickedFolder,
} from "@/features/folder-view/readFolder";
import { MapCanvas } from "@/features/map/MapCanvas";
import type { Sizing } from "@/features/map/mapLayout";
import { Group, Tab } from "@/features/repo/RendererTabs";
import { AppShell, PaneHeading, ScrollPane } from "@/features/shell/AppShell";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { cn } from "@/lib/class-names";

/**
 * Any folder on this machine as the folder map, with no server in the loop.
 *
 * The map draws folders and files; what reposhape adds for a repo (imports,
 * clusters, line counts) is extra colour on the same picture. A folder picked
 * here gets the picture with what every folder has: paths, sizes, and the kind
 * of file each one is. Nothing is uploaded and nothing is stored: reload and
 * the folder is gone, which is the honest scope of a page that never had it.
 */
export function FolderView() {
  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sizing, setSizing] = useState<Sizing>("files");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const clearView = useFilters((state) => state.clearView);
  const clearDimmed = useFilters((state) => state.clearDimmed);

  const shape = useMemo(() => (folder ? folderShape(folder) : null), [folder]);
  const folders = useMemo(() => {
    if (!folder) return 0;
    const seen = new Set<string>();
    for (const path of folder.files.keys()) {
      const segments = path.split("/");
      for (let depth = 1; depth < segments.length; depth += 1) seen.add(segments.slice(0, depth).join("/"));
    }
    return seen.size;
  }, [folder]);

  // React has no prop for it: `webkitdirectory` is what makes the picker
  // choose a folder rather than files.
  useEffect(() => {
    picker.current?.setAttribute("webkitdirectory", "");
  }, []);

  const show = useCallback(
    (picked: PickedFolder) => {
      if (picked.files.size === 0) {
        setProblem(`${picked.name || "That folder"} has no files to draw.`);
        return;
      }
      setProblem(null);
      setFolder(picked);
      setOpenPath(null);
      clearView();
      clearDimmed();
    },
    [clearView, clearDimmed],
  );

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const entry = event.dataTransfer.items[0]?.webkitGetAsEntry();
      if (!entry?.isDirectory) {
        setProblem("Drop a folder rather than a file: a map of one file is a dot.");
        return;
      }
      setReading(true);
      fromDirectoryEntry(entry as FileSystemDirectoryEntry)
        .then(show)
        .catch((error: unknown) => setProblem(`Could not read the folder: ${String(error)}`))
        .finally(() => setReading(false));
    },
    [show],
  );

  // Escape closes the file, then clears focus, as on a repo.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (sidebarOpen) setSidebarOpen(false);
      else if (openPath) setOpenPath(null);
      else clearView();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPath, clearView, sidebarOpen]);

  const openFile = openPath ? folder?.files.get(openPath) : undefined;

  return (
    <AppShell
      sidebarOpen={sidebarOpen}
      onCloseSidebar={() => setSidebarOpen(false)}
      header={
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-2">
          <button
            type="button"
            aria-label="Show the legend"
            onClick={() => setSidebarOpen(true)}
            className="shrink-0 rounded p-1 text-muted hover:bg-line hover:text-fg md:hidden"
          >
            <Menu className="size-4" />
          </button>
          <span className="hidden items-center gap-1.5 text-[12px] font-semibold tracking-wide text-fg min-[500px]:flex">
            <FolderOpen className="size-4 text-accent" />
            reposhape
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg" title={folder?.name}>
            {folder?.name ?? ""}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => picker.current?.click()}
              disabled={reading}
              className={cn(
                "flex items-center gap-1.5 rounded border border-line-strong px-2 py-1 text-[11.5px] text-fg",
                "outline-none transition-colors hover:bg-line active:bg-line",
                "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                "disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent",
              )}
            >
              {reading ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
              Open folder
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files) show(fromFileList(event.target.files));
                // Cleared, so picking the same folder again still fires.
                event.target.value = "";
              }}
            />
            <HighlightSearch />
            <ThemeToggle />
          </div>
          {folder ? (
            <div className="flex w-full min-w-0 basis-full flex-wrap items-center gap-2">
              <Group label="Files">
                <Tab id="files" active={sizing} onPick={setSizing} title="Folders as nested circles, one dot per file.">
                  folders
                </Tab>
                <Tab id="size" active={sizing} onPick={setSizing} title="Dot area is the file's size in bytes.">
                  folders · size
                </Tab>
              </Group>
            </div>
          ) : null}
        </header>
      }
      sidebar={
        <>
          <PaneHeading>Kinds of file</PaneHeading>
          <ScrollPane>
            {shape ? (
              <ClusterLegend clusters={shape.groups} noun="kinds" />
            ) : (
              <p className="px-3 py-2 text-[12px] text-faint italic">No folder open.</p>
            )}
          </ScrollPane>
          {folder ? (
            <div className="shrink-0 border-t border-line px-3 py-2 text-[10.5px] tabular-nums text-faint">
              <p>
                {folder.files.size.toLocaleString()} files · {folders.toLocaleString()} folders ·{" "}
                {shape?.groups.length ?? 0} kinds
              </p>
              {folder.truncated ? (
                <p className="mt-0.5">Only the first {MAX_FILES.toLocaleString()} files are drawn.</p>
              ) : null}
              {folder.skipped.length > 0 ? (
                <p className="mt-0.5">Left out: {folder.skipped.join(", ")}</p>
              ) : null}
            </div>
          ) : null}
        </>
      }
      main={
        <div
          className="absolute inset-0"
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            // Only leaving the pane counts, not moving between its children.
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={onDrop}
        >
          {shape ? (
            <MapCanvas
              shape={shape}
              sizing={sizing}
              edges={false}
              onOpenFile={setOpenPath}
              onDismiss={() => setOpenPath(null)}
            />
          ) : null}
          {!shape && !reading ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center p-4">
              <p className="max-w-sm text-center text-[13px] text-muted">
                Drop a folder here, or open one. It is read in this tab and never leaves it.
              </p>
            </div>
          ) : null}
          {reading ? <Overlay>Reading the folder…</Overlay> : null}
          {problem ? <Overlay tone="error">{problem}</Overlay> : null}
          {dragging ? (
            <div className="pointer-events-none absolute inset-2 rounded-lg border-2 border-dashed border-accent" />
          ) : null}
        </div>
      }
      aside={
        openPath && openFile ? (
          <LocalFilePane path={openPath} file={openFile} onClose={() => setOpenPath(null)} />
        ) : undefined
      }
    />
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
    <div className="pointer-events-none absolute inset-x-0 top-4 grid place-items-center px-4">
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
