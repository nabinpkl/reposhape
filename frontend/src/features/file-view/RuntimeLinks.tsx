"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { useFilters } from "@/features/filters/filterStore";
import type { RuntimeLink } from "@/generated/contracts";
import { api } from "@/lib/api";

const KIND_TITLE: Record<RuntimeLink["kind"], string> = {
  event: "The same event name is sent in one file and received in the other",
  process: "One file starts the other as a program (python -m)",
  loader: "A loader reaches this file by walking a directory (from the repo's link rules)",
};

/**
 * "Reached without an import": the answer to why this file looks unconnected.
 *
 * Every row is evidence, not a claim: the kind, the name both ends share, and
 * the line at each end, so the reader can open the other file and see it.
 * Read from the whole artifact, not the view, because the other end is often
 * a file the path filter hides (ADR-0009). Test files follow "Include tests". Nothing renders when there are
 * no links: absence is the ordinary case and the graph already shows it.
 */
export function RuntimeLinks({
  analysisKey,
  path,
  onOpenFile,
}: {
  analysisKey: string;
  path: string;
  onOpenFile: (path: string) => void;
}) {
  const includeTests = useFilters((state) => state.includeTests);
  const { data } = useQuery({
    queryKey: ["links", analysisKey, path, includeTests],
    queryFn: () => api.links(analysisKey, path, includeTests),
    staleTime: Infinity,
  });
  if (!data || data.length === 0) return null;

  return (
    <section className="shrink-0 border-b border-line text-[11px]">
      <h3 className="flex items-center gap-1.5 px-3 pt-1.5 pb-1 text-muted">
        <span aria-hidden className="w-4 border-t-2 border-dashed border-runtime-link" />
        Reached without an import
        <span className="ml-auto text-faint tabular-nums">{data.length}</span>
      </h3>
      <ul className="max-h-40 overflow-y-auto pb-1">
        {data.map((link) => {
          const outgoing = link.source === path;
          const other = outgoing ? link.target : link.source;
          const here = outgoing ? link.source_line : link.target_line;
          const there = outgoing ? link.target_line : link.source_line;
          const Arrow = outgoing ? ArrowRight : ArrowLeft;
          return (
            <li key={`${link.kind}:${link.key}:${link.source}:${link.target}`}>
              <button
                type="button"
                onClick={() => onOpenFile(other)}
                title={`${KIND_TITLE[link.kind]}\nline ${here} here, line ${there} in ${other}`}
                className="flex w-full min-w-0 items-center gap-1.5 px-3 py-0.5 text-left text-fg outline-none hover:bg-line/60 focus-visible:bg-line active:bg-line"
              >
                <span className="w-[46px] shrink-0 text-faint">{link.kind}</span>
                <span className="max-w-[40%] shrink-0 truncate font-mono text-[10.5px] text-runtime-link">
                  {link.key}
                </span>
                <Arrow className="size-3 shrink-0 text-faint" aria-label={outgoing ? "to" : "from"} />
                <span className="min-w-0 truncate">{other}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
