import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { CodeBlock, splitLines } from "./CodeBlock";
import type { ColorScheme } from "./colors";
import type { FileContent } from "./fileContent";

export interface FilePaneProps {
  /** The file's path, slash-separated. Its last segment is the title. */
  path: string;
  /**
   * Where the content comes from. Called again when `path` or `load`
   * changes, so keep it stable (a `useCallback`) unless a change is meant.
   */
  load: (path: string) => Promise<FileContent>;
  /** Shows a close button when given. */
  onClose?: () => void;
  theme?: ColorScheme;
  /** Rows of your own between the meta line and the content. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * One file, beside the map: its name, where it lives, how big it is, and the
 * file itself as highlighted text, an image, or a line saying it is binary.
 */
export function FilePane({ path, load, onClose, theme = "dark", children, className, style }: FilePaneProps) {
  // Keyed by the path and loader it was read with, so a slow read of the
  // previous file can never paint over the one now open.
  const [read, setRead] = useState<
    | { path: string; load: FilePaneProps["load"]; content: FileContent }
    | { path: string; load: FilePaneProps["load"]; error: string }
    | null
  >(null);

  useEffect(() => {
    let live = true;
    let loaded: FileContent | null = null;
    load(path).then(
      (content) => {
        loaded = content;
        if (live) setRead({ path, load, content });
        else if (content.kind === "image") content.dispose?.();
      },
      (error: unknown) => {
        if (live) setRead({ path, load, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      live = false;
      if (loaded?.kind === "image") loaded.dispose?.();
    };
  }, [path, load]);

  const current = read?.path === path && read.load === load ? read : null;
  const content = current && "content" in current ? current.content : null;
  const name = path.split("/").at(-1) ?? path;

  return (
    <section className={["rs-viewer rs-pane", className].filter(Boolean).join(" ")} data-theme={theme} style={style}>
      <header className="rs-pane-header">
        <div className="rs-pane-heading">
          <div className="rs-pane-title" title={path}>
            {name}
          </div>
          <div className="rs-pane-path">{path}</div>
        </div>
        {onClose ? (
          <button type="button" onClick={onClose} aria-label="Close file" className="rs-icon-button">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              aria-hidden
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        ) : null}
      </header>

      {content ? (
        <div className="rs-pane-meta">
          {content.kind === "text" ? <span>{plural(splitLines(content.text).length, "line")}</span> : null}
          {content.size !== undefined ? <span>{formatBytes(content.size)}</span> : null}
          {content.kind === "text" && content.truncated ? (
            <span className="rs-warn">only the start is shown</span>
          ) : null}
        </div>
      ) : null}

      {children}

      <div className="rs-pane-body">
        {!current ? <p className="rs-placeholder">Loading…</p> : null}
        {current && "error" in current ? <p className="rs-placeholder rs-error">{current.error}</p> : null}
        {content?.kind === "binary" ? <p className="rs-placeholder">A binary file; nothing to show as text.</p> : null}
        {content?.kind === "image" ? <img src={content.src} alt={name} className="rs-image" /> : null}
        {content?.kind === "text" ? <CodeBlock path={path} text={content.text} theme={theme} /> : null}
      </div>
    </section>
  );
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
