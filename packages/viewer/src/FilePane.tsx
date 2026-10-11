"use client";

import { ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";

import { CodeBlock } from "@/features/file-view/CodeBlock";
import { ScrollPane } from "@/features/shell/AppShell";
import { cn } from "@/lib/class-names";

/**
 * Text past this is cut for display. The pane is for reading a file, and half
 * a megabyte is already more than anyone scrolls; the whole file is still on
 * the reader's own disk.
 */
const MAX_TEXT_BYTES = 512 * 1024;

/**
 * How far in to look for a NUL byte, git's own test for "binary". A text file
 * has none, and almost every binary format has one in its first block.
 */
const SNIFF_BYTES = 8000;

type Contents =
  | { kind: "text"; text: string; lines: number; truncated: boolean }
  | { kind: "image"; url: string }
  | { kind: "binary" };

/**
 * One file of a picked folder, read in this tab. The same pane as a repo's
 * file, minus what only an analysis knows (license, runtime links, hiding it
 * from the clustering).
 */
export function LocalFilePane({
  path,
  file,
  onClose,
}: {
  path: string;
  file: File;
  onClose: () => void;
}) {
  // Keyed by the file it was read from, so a slow read of the previous file
  // can never paint over the one now open.
  const [read, setRead] = useState<{ file: File; contents: Contents } | { file: File; error: string } | null>(
    null,
  );

  useEffect(() => {
    let live = true;
    let url: string | null = null;
    const done = (value: { contents: Contents } | { error: string }) => {
      if (live) setRead({ file, ...value });
    };
    if (file.type.startsWith("image/")) {
      // An <img> never runs what it shows, an SVG's scripts included, so an
      // object URL is safe to hand it; the page's CSP allows `blob:` images.
      url = URL.createObjectURL(file);
      done({ contents: { kind: "image", url } });
    } else {
      file
        .slice(0, MAX_TEXT_BYTES)
        .arrayBuffer()
        .then((buffer) => {
          const bytes = new Uint8Array(buffer);
          if (bytes.subarray(0, SNIFF_BYTES).includes(0)) {
            done({ contents: { kind: "binary" } });
            return;
          }
          const text = new TextDecoder().decode(bytes);
          done({
            contents: {
              kind: "text",
              text,
              lines: text.split("\n").length,
              truncated: file.size > MAX_TEXT_BYTES,
            },
          });
        })
        .catch((error: unknown) => done({ error: String(error) }));
    }
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);

  const current = read?.file === file ? read : null;
  const contents = current && "contents" in current ? current.contents : null;
  const segments = path.split("/");
  const name = segments.at(-1) ?? path;

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
          className="shrink-0 rounded p-1 text-muted transition-colors hover:bg-line hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5 text-[11px] text-faint">
        {contents?.kind === "text" ? <span>{contents.lines.toLocaleString()} lines</span> : null}
        <span>{formatBytes(file.size)}</span>
        {contents?.kind === "text" && contents.truncated ? (
          <span className="flex items-center gap-1 text-amber-400">
            <ExternalLink className="size-3" />
            first {formatBytes(MAX_TEXT_BYTES)} shown
          </span>
        ) : null}
      </div>

      <ScrollPane className="bg-canvas">
        {!current ? <Placeholder>Reading…</Placeholder> : null}
        {current && "error" in current ? (
          <Placeholder tone="error">{current.error}</Placeholder>
        ) : null}
        {contents?.kind === "binary" ? <Placeholder>A binary file; nothing to show as text.</Placeholder> : null}
        {contents?.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local object URL, nothing for next/image to optimise
          <img src={contents.url} alt={name} className="mx-auto block max-w-full p-3" />
        ) : null}
        {contents?.kind === "text" ? <CodeBlock path={path} text={contents.text} /> : null}
      </ScrollPane>
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
