import { useEffect, useMemo, useState, type CSSProperties } from "react";

import type { ColorScheme } from "./colors";
import type { FileContent } from "./fileContent";
import { FilePane } from "./FilePane";
import { FolderMap, type MapLabels } from "./FolderMap";
import { toShape, type FolderData } from "./shape";

type View = "files" | "size" | "links";

export interface FolderViewerProps {
  data: FolderData;
  /** Content for the file pane. Keep it stable (a `useCallback`). */
  loadFile: (path: string) => Promise<FileContent>;
  theme?: ColorScheme;
  /** The view it opens on. `size` needs sizes and `links` needs links in `data`. */
  initialView?: View;
  /** Files whose path contains this text stay lit; the rest dim. */
  highlight?: string;
  labels?: MapLabels;
  className?: string;
  /** The viewer fills its box: give it, or its parent, a size. */
  style?: CSSProperties;
}

/**
 * The folder map with its views and a file pane, as one component.
 *
 * `folders` draws one dot per file; `folders · size` sizes each dot by the
 * file's size, offered when the data has sizes; `folders · links` draws the
 * links over the folders, offered when it has links. Clicking a file selects
 * it and opens it in the pane; clicking empty ground or pressing Escape closes
 * it. Below 720px of its own width the pane sits under the map instead of
 * beside it.
 */
export function FolderViewer({
  data,
  loadFile,
  theme = "dark",
  initialView = "files",
  highlight,
  labels,
  className,
  style,
}: FolderViewerProps) {
  const shape = useMemo(() => toShape(data), [data]);
  const views = useMemo(() => {
    const offered: { id: View; label: string; title: string }[] = [
      { id: "files", label: "folders", title: "Folders as nested circles, one dot per file." },
    ];
    if (shape.hasSizes) {
      offered.push({
        id: "size",
        label: "folders · size",
        title: `Dot area is the file's size${data.sizeLabel ? ` in ${data.sizeLabel}` : ""}.`,
      });
    }
    if (shape.links.length > 0) {
      offered.push({ id: "links", label: "folders · links", title: "Links that leave their package, drawn over the folders." });
    }
    return offered;
  }, [shape, data.sizeLabel]);
  const [picked, setPicked] = useState<View>(initialView);
  const view = views.some((offered) => offered.id === picked) ? picked : "files";
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (open === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div
      className={["rs-viewer rs-folder-viewer", className].filter(Boolean).join(" ")}
      data-theme={theme}
      data-open={open !== null ? "" : undefined}
      style={style}
    >
      {views.length > 1 ? (
        <div className="rs-toolbar" role="group" aria-label="View">
          {views.map((offered) => (
            <button
              key={offered.id}
              type="button"
              className="rs-tab"
              aria-pressed={view === offered.id}
              title={offered.title}
              onClick={() => setPicked(offered.id)}
            >
              {offered.label}
            </button>
          ))}
        </div>
      ) : null}
      <div className="rs-stage">
        <div className="rs-map">
          <FolderMap
            data={data}
            sizing={view === "size" ? "size" : "files"}
            links={view === "links"}
            theme={theme}
            selected={open}
            onSelect={setOpen}
            highlight={highlight}
            labels={labels}
          />
        </div>
        {open !== null ? (
          <FilePane className="rs-aside" path={open} load={loadFile} onClose={() => setOpen(null)} theme={theme} />
        ) : null}
      </div>
    </div>
  );
}
