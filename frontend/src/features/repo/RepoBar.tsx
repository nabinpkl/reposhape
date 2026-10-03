"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Columns2, FolderGit2, Loader2, Menu, PanelRight, RefreshCw, Search } from "lucide-react";

import { useFilters } from "@/features/filters/filterStore";
import { AddRepo } from "@/features/repo/AddRepo";
import { invalidateAnalysis } from "@/features/repo/analysisCache";
import { RendererTabs, type Renderer } from "@/features/repo/RendererTabs";
import { RepoMenu } from "@/features/repo/RepoMenu";
import { useReadOnly } from "@/features/repo/serverMode";
import { SourceTabs } from "@/features/repo/SourceTabs";
import { ThemeToggle } from "@/features/theme/ThemeToggle";
import { api } from "@/lib/api";
import { cn } from "@/lib/class-names";
import type { UpdateReport } from "@/lib/api";
import type { AnalysisSource, RepoSummary } from "@/generated/contracts";

export type { Renderer };

/**
 * The header: which repo, plus search.
 *
 * The repo list is the cache's read path. A stored analysis has to resurface
 * without being searched for, or storing it was collecting rather than
 * remembering, so every analysed repo is one click away here with its commit
 * and its age.
 */
export function RepoBar({
  activeKey,
  onPick,
  onForget,
  renderer,
  onRenderer,
  split,
  onSplit,
  showTabs = true,
  asideOpen,
  onAside,
  onOpenSidebar,
}: {
  activeKey: string | null;
  onPick: (summary: RepoSummary) => void;
  /** Every key removed, and the repo to show instead, or null when none is left. */
  onForget: (removed: string[], next: RepoSummary | null) => void;
  renderer: Renderer;
  onRenderer: (renderer: Renderer) => void;
  split: boolean;
  onSplit: (split: boolean) => void;
  /** Hidden in split mode: each pane carries its own source and renderer tabs. */
  showTabs?: boolean;
  asideOpen: boolean;
  onAside: (open: boolean) => void;
  onOpenSidebar: () => void;
}) {
  const queryClient = useQueryClient();
  const search = useFilters((state) => state.search);
  const setSearch = useFilters((state) => state.setSearch);

  const repos = useQuery({ queryKey: ["repos"], queryFn: api.repos });
  const readOnly = useReadOnly();

  // What the last refresh did to the checkout. Only a repo this tool cloned
  // has one: a refresh fetches it first, and a fetch that was skipped or failed
  // is the thing that explains a graph which did not move.
  const [update, setUpdate] = useState<UpdateReport | null>(null);

  const analyze = useMutation({
    mutationFn: ({
      repoPath,
      source,
      refresh,
    }: {
      repoPath: string;
      source: AnalysisSource;
      refresh: boolean;
    }) => api.analyze(repoPath, source, refresh),
    onMutate: () => setUpdate(null),
    onSuccess: async (response) => {
      // The artifact was written over its own key, so the graph, the path tree
      // and any open file are all stale and none of them knows it.
      await invalidateAnalysis(queryClient, response.key);
      setUpdate(response.update);
      onPick(response.summary);
    },
  });

  const active = repos.data?.find((repo) => repo.key === activeKey) ?? null;

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-2">
      <button
        type="button"
        title="Filters"
        onClick={onOpenSidebar}
        className="shrink-0 rounded p-1 text-muted hover:bg-line hover:text-fg md:hidden"
      >
        <Menu className="size-4" />
      </button>

      <span className="hidden items-center gap-1.5 text-[12px] font-semibold tracking-wide text-fg min-[500px]:flex">
        <FolderGit2 className="size-4 text-accent" />
        reposhape
      </span>

      <div className="flex min-w-[120px] flex-1 items-center gap-2">
        <RepoMenu
          rows={repos.data}
          active={active}
          onPick={onPick}
          onForget={readOnly ? null : onForget}
        />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          title={split ? "Close the split view" : "Compare side by side"}
          onClick={() => onSplit(!split)}
          className={cn(
            "shrink-0 rounded p-1 hover:bg-line hover:text-fg",
            split ? "bg-line text-fg" : "text-muted",
          )}
        >
          <Columns2 className="size-3.5" />
        </button>

        <button
          type="button"
          title={asideOpen ? "Hide the inspector" : "Show the inspector"}
          onClick={() => onAside(!asideOpen)}
          className={cn(
            "shrink-0 rounded p-1 hover:bg-line hover:text-fg",
            asideOpen ? "bg-line text-fg" : "text-muted",
          )}
        >
          <PanelRight className="size-3.5" />
        </button>

        {update ? (
          <span
            title={update.detail ?? undefined}
            className={cn(
              // Wide enough for the longest sentence the server sends, so the
              // reason a fetch was skipped does not cut off mid-word.
              "max-w-[34ch] shrink-0 truncate text-[11px]",
              update.outcome === "failed" ? "text-danger" : "text-muted",
            )}
          >
            {updateLabel(update)}
          </span>
        ) : null}

        {active && !readOnly ? (
          <button
            type="button"
            title={
              active.repo_path.includes("/reposhape/clones/")
                ? "Fetch and re-analyse"
                : "Re-analyse from disk"
            }
            onClick={() =>
              analyze.mutate({ repoPath: active.repo_path, source: active.source, refresh: true })
            }
            disabled={analyze.isPending}
            className="shrink-0 rounded p-1 text-muted hover:bg-line hover:text-fg disabled:opacity-50"
          >
            {analyze.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
          </button>
        ) : null}

        <ThemeToggle />
      </div>

      <div className="flex w-full min-w-0 basis-full items-center gap-2 overflow-x-auto pb-0.5 md:w-auto md:basis-auto md:overflow-visible md:pb-0">
        {showTabs && active ? <SourceTabs active={active} onPick={onPick} /> : null}

        {showTabs && active ? (
          <RendererTabs
            analysisKey={active.key}
            renderer={renderer}
            onRenderer={onRenderer}
          />
        ) : null}

        {readOnly ? null : <AddRepo onPick={onPick} />}

        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-faint" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Highlight files…"
            spellCheck={false}
            className="w-40 rounded border border-line-strong bg-canvas py-1 pr-2 pl-7 text-[12px] text-fg outline-none placeholder:text-faint focus:border-accent md:w-52"
          />
        </div>
      </div>

      {analyze.error ? (
        <span className="max-w-xs truncate text-[11px] text-danger" title={String(analyze.error)}>
          {(analyze.error as Error).message}
        </span>
      ) : null}
    </header>
  );
}

/**
 * One line for what the fetch did. The sha is the evidence that it moved; the
 * server's own sentence is what a skipped or failed fetch has to say.
 */
function updateLabel(update: UpdateReport): string {
  switch (update.outcome) {
    case "updated":
      return `updated to ${(update.sha ?? "").slice(0, 8)}`;
    case "current":
      return "already current";
    default:
      return update.detail ?? "not fetched";
  }
}
