"use client";

import { useQuery } from "@tanstack/react-query";
import { Scale } from "lucide-react";

import { api } from "@/lib/api";

/**
 * The license governing the open file, carried with it.
 *
 * The page displays other people's code, and MIT -- what the hosted
 * deployment serves -- permits that on condition that the copyright and
 * permission notice go with it. The server resolves the NEAREST license above
 * the file, so a package or plugin with its own holder is credited as itself
 * rather than as the repo. The summary names the license and its holder;
 * opening it shows the notice whole, with the license file it came from,
 * and a NOTICE file beside that license when there is one (Apache-2.0).
 * Shown in personal use too: one line of true information is cheaper than a
 * branch between the two.
 */
export function LicenseNotice({ analysisKey, path }: { analysisKey: string; path: string }) {
  const { data } = useQuery({
    queryKey: ["license", analysisKey, path],
    queryFn: () => api.license(analysisKey, path),
    staleTime: Infinity,
  });
  if (!data) return null;

  if (data.path === null) {
    return (
      <p className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5 text-[11px] text-faint">
        <Scale className="size-3 shrink-0" />
        No license file between this file and the repo root
      </p>
    );
  }

  // A NOTICE often credits in prose ("includes work originally published by
  // ...") rather than in a Copyright line; point at it instead of saying none.
  const holder =
    data.copyright[0] ?? (data.notice_path ? "attribution in NOTICE" : "no copyright line found");
  return (
    <details className="group shrink-0 border-b border-line text-[11px]">
      <summary
        title="Show the license"
        className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 text-muted outline-none hover:bg-line/60 hover:text-fg focus-visible:bg-line [&::-webkit-details-marker]:hidden"
      >
        <Scale className="size-3 shrink-0" />
        <span className="shrink-0 font-medium text-fg/90">{data.name ?? data.path}</span>
        <span className="min-w-0 truncate" title={data.copyright.join("\n") || undefined}>
          {holder}
        </span>
        {data.notice_path ? (
          <span className="ml-auto shrink-0 rounded border border-line-strong px-1 text-[10px] text-muted">
            + NOTICE
          </span>
        ) : null}
      </summary>
      {/* One scroll region for both texts, so a long license cannot push the
          NOTICE out of reach below the code. */}
      <div className="max-h-72 overflow-auto border-t border-line bg-canvas">
        <LicenseText path={data.path} text={data.text} truncated={data.truncated} />
        {data.notice_path ? (
          // Apache-2.0 4(d): the NOTICE beside the license travels with the code.
          <LicenseText
            path={data.notice_path}
            text={data.notice_text}
            truncated={data.notice_truncated}
          />
        ) : null}
      </div>
    </details>
  );
}

function LicenseText({
  path,
  text,
  truncated,
}: {
  path: string;
  text: string;
  truncated: boolean;
}) {
  return (
    <>
      <p className="px-3 pt-1.5 font-mono text-[10.5px] break-all text-faint">{path}</p>
      <pre className="px-3 py-2 font-mono text-[10.5px] leading-[1.5] whitespace-pre-wrap text-muted">
        {text}
        {truncated ? "\n\n[truncated for display]" : ""}
      </pre>
    </>
  );
}
