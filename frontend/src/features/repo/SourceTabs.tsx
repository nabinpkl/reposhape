"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import { cn } from "@/lib/class-names";
import type { AnalysisSource, RepoSummary, SourceOption } from "@/generated/contracts";

/**
 * Which extractor's graph you are looking at.
 *
 * The tabs exist to keep one claim testable. This tool was built instead of
 * reusing graphify, and the only way to judge that is the same repo through the
 * same clustering and the same renderer, with the extractor as the one thing
 * that changed. The `graphify page` renderer tab beside these is the other
 * half: graphify's output through graphify's own page, framed verbatim, so
 * that what differs there is the rendering rather than the data.
 *
 * A tab whose source cannot be built here is shown disabled with the reason on
 * hover, rather than hidden. Hiding it would make a repo with no graphify output
 * look like a repo where the comparison was never possible.
 */
export function SourceTabs({
  active,
  onPick,
}: {
  active: RepoSummary;
  onPick: (summary: RepoSummary) => void;
}) {
  const queryClient = useQueryClient();

  const sources = useQuery({
    queryKey: ["sources", active.key],
    queryFn: () => api.sources(active.key),
  });

  const build = useMutation({
    mutationFn: (source: AnalysisSource) => api.analyze(active.repo_path, source),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
      onPick(response.summary);
    },
  });

  const options = sources.data;
  if (!options) return null;

  return (
    <div className="flex shrink-0 items-center gap-px rounded border border-line-strong p-px">
      {options.map((option) => (
        <Tab
          key={option.source}
          option={option}
          selected={option.source === active.source}
          pending={build.isPending && build.variables === option.source}
          onSelect={() => {
            if (option.source === active.source) return;
            // A source already built is a cache key we can switch to without
            // touching the network; one that is not gets built on the spot.
            const existing = option.key;
            if (existing) {
              const row = queryClient
                .getQueryData<RepoSummary[]>(["repos"])
                ?.find((candidate) => candidate.key === existing);
              if (row) {
                onPick(row);
                return;
              }
            }
            build.mutate(option.source);
          }}
        />
      ))}
      {build.error ? (
        <span className="px-2 text-[11px] text-danger" title={String(build.error)}>
          {(build.error as Error).message}
        </span>
      ) : null}
    </div>
  );
}

function Tab({
  option,
  selected,
  pending,
  onSelect,
}: {
  option: SourceOption;
  selected: boolean;
  pending: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!option.ready || pending}
      title={option.reason ?? undefined}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11.5px] whitespace-nowrap transition-colors",
        selected ? "bg-line text-fg" : "text-muted hover:bg-line/60 hover:text-fg",
        !option.ready && "cursor-not-allowed text-faint hover:bg-transparent hover:text-faint",
      )}
    >
      {pending ? <Loader2 className="size-3 animate-spin" /> : null}
      {option.label}
    </button>
  );
}
