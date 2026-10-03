"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CornerLeftUp, Folder, FolderPlus, GitBranch, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";

import { invalidateAnalysis } from "@/features/repo/analysisCache";
import { api } from "@/lib/api";
import { cn } from "@/lib/class-names";
import type { FolderEntry, RepoSummary } from "@/generated/contracts";

/** Long enough that a held-down key is one request, short enough to feel live. */
const DEBOUNCE_MS = 120;

/** `git@github.com:owner/repo.git`, the form every host prints beside the https one. */
const SCP_LIKE = /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/).+$/;

/**
 * Is this text a URL rather than a path?
 *
 * Only decides which half of this dialog to show. The server's `cloning.parse`
 * is the authority on what will actually be cloned, so this stays loose on
 * purpose: being wrong here shows the wrong hint, never the wrong clone.
 */
function looksRemote(text: string): boolean {
  const candidate = text.trim();
  if (!candidate || /^[/.~]/.test(candidate)) return false;
  return candidate.includes("://") || SCP_LIKE.test(candidate);
}

/**
 * Picking a repo to graph: a folder on this machine, or a git URL to clone.
 *
 * The browser cannot hand the server a filesystem path -- `webkitdirectory`
 * gives relative names and `showDirectoryPicker` gives a handle -- so the
 * chooser runs on the server and this is its surface. Typing and clicking are
 * one mechanism: `/api/folders` completes a half-typed path against its parent
 * exactly as a shell does, so the list below is always "what could this text
 * become next".
 *
 * One field takes both, because a shell prompt takes both and the first
 * character already says which it is. Text that reads as a URL switches the
 * primary action to Clone and stops the folder listing, since there is no
 * directory to complete against.
 *
 * Adding and analysing are the same act. The picker's list is the cache
 * (`/api/repos` globs the artifacts), so there is no registry of folders that
 * have not been analysed, and nothing to keep in step with one.
 */
export function AddRepo({ onPick }: { onPick: (summary: RepoSummary) => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  // Cloning and analysing are one click and two requests, and the slow one is
  // the clone. Saying which is running is the difference between a spinner and
  // a progress report.
  const [stage, setStage] = useState<"idle" | "cloning" | "analysing">("idle");

  const remote = looksRemote(path);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(path), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [path]);

  const listing = useQuery({
    queryKey: ["folders", query],
    queryFn: () => api.folders(query),
    enabled: open && !remote,
    placeholderData: keepPreviousData,
    retry: false,
  });

  // Where a clone lands. Asked for only while a URL is being typed, because
  // that is the only moment the answer matters.
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, enabled: open && remote });

  const analyze = useMutation({
    mutationFn: (repoPath: string) => api.analyze(repoPath, "imports", false),
    onSuccess: async (response) => {
      await invalidateAnalysis(queryClient, response.key);
      onPick(response.summary);
      setOpen(false);
    },
  });

  const cloneAndAnalyze = useMutation({
    mutationFn: async (url: string) => {
      setStage("cloning");
      const cloned = await api.clone(url);
      setStage("analysing");
      // A checkout that was already here is refreshed, because asking for a URL
      // is asking for that repository now rather than as it was downloaded.
      return api.analyze(cloned.path, "imports", cloned.already_present);
    },
    onSuccess: async (response) => {
      await invalidateAnalysis(queryClient, response.key);
      onPick(response.summary);
      setOpen(false);
    },
    onSettled: () => setStage("idle"),
  });

  const busy = analyze.isPending || cloneAndAnalyze.isPending;

  // A failed listing keeps its previous rows in react-query's cache, and rows
  // from the last directory under an error about this one is the worst of both.
  const found = listing.error || remote ? null : (listing.data ?? null);
  const entries = found?.entries ?? [];
  const up = found?.up ?? null;
  // An empty field has named nothing, so there is nothing to analyse yet. The
  // listing still answers with a target for it, the home directory, and taking
  // that as chosen puts "Analyse <username>" on the primary button and walks the
  // whole home directory as one repo on the next Enter.
  const target = path.trim() ? (found?.target ?? null) : null;

  const enter = (folder: string) => {
    setPath(`${folder}/`);
    setHighlight(-1);
    analyze.reset();
    cloneAndAnalyze.reset();
  };

  const submit = () => {
    if (busy) return;
    if (remote) cloneAndAnalyze.mutate(path.trim());
    else if (target) analyze.mutate(target.path);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!remote && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = highlight + step;
      setHighlight(next < -1 ? entries.length - 1 : next >= entries.length ? -1 : next);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // Enter descends while a row is picked out, because that is the move you
      // are making when you are still looking. With no row picked it commits,
      // which is what Enter means everywhere else in a field. A URL has no rows
      // to descend into, so it always commits.
      const chosen = remote ? undefined : entries[highlight];
      if (chosen) enter(chosen.path);
      else submit();
    }
  };

  const failure = (cloneAndAnalyze.error ?? analyze.error) as Error | null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          // Opened empty, every time. A path put there for you is a claim about
          // what you came here to do, and it covers the placeholder, which is
          // the only thing saying a git URL belongs in this field too. An empty
          // field still lists somewhere to start from, the home directory, so
          // browsing costs nothing. `query` is cleared with it, or the debounce
          // leaves the previous directory's rows on screen for a beat.
          setPath("");
          setQuery("");
          setHighlight(-1);
          analyze.reset();
          cloneAndAnalyze.reset();
        }
      }}
    >
      <Dialog.Trigger
        title="Add a folder, or clone a git URL"
        className={cn(
          "flex shrink-0 items-center gap-1 rounded border border-line-strong px-2 py-1",
          "text-[12px] text-muted transition-colors",
          "hover:bg-line hover:text-fg active:bg-line-strong",
          "data-[state=open]:bg-line data-[state=open]:text-fg",
        )}
      >
        <FolderPlus className="size-3.5" />
        Add repo
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[min(560px,calc(100vw-2rem))]",
            "-translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-lg border border-line",
            "bg-panel p-3 shadow-2xl",
          )}
        >
          <Dialog.Title className="text-[12px] font-semibold tracking-wide text-fg">
            Add a repo
          </Dialog.Title>

          <input
            value={path}
            autoFocus
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls="folder-list"
            aria-activedescendant={highlight >= 0 ? `folder-${highlight}` : undefined}
            placeholder="~/projects/ or https://github.com/owner/repo"
            onChange={(event) => {
              setPath(event.target.value);
              setHighlight(-1);
            }}
            onKeyDown={onKeyDown}
            className={cn(
              "w-full rounded border border-line-strong bg-canvas px-2 py-1.5",
              "font-mono text-[12px] text-fg outline-none placeholder:text-faint",
              "focus:border-accent",
            )}
          />

          {remote ? (
            // Where the clone goes, said while it can still be reconsidered: it
            // is a checkout that outlives everything else here, and nothing in
            // this tool ever deletes one.
            <div className="flex flex-col gap-1 rounded border border-line px-2 py-1.5">
              <p className="flex items-center gap-1.5 text-[11px] text-fg">
                <GitBranch className="size-3 shrink-0 text-accent" />
                Clones into{" "}
                <span className="truncate font-mono">{health.data?.clone_root ?? "…"}</span>
              </p>
              <p className="text-[11px] text-muted">
                Kept, not temporary. Forgetting the repo clears its analysis and leaves the
                checkout.
              </p>
            </div>
          ) : (
            <ul id="folder-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto">
              {up ? (
                <li
                  role="option"
                  aria-selected={false}
                  onClick={() => enter(up)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded px-2 py-1",
                    "text-[12px] text-muted hover:bg-line hover:text-fg",
                  )}
                >
                  <CornerLeftUp className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate font-mono">{up}</span>
                </li>
              ) : null}

              {entries.map((entry, index) => (
                <Row
                  key={entry.path}
                  entry={entry}
                  index={index}
                  active={index === highlight}
                  onEnter={() => enter(entry.path)}
                />
              ))}

              {listing.isSuccess && entries.length === 0 ? (
                <li className="px-2 py-1 text-[12px] text-faint">No folders here.</li>
              ) : null}
            </ul>
          )}

          {found?.truncated ? (
            <p className="text-[11px] text-faint">
              Only the first folders are listed. Type more of the name to narrow it.
            </p>
          ) : null}

          {target && !target.is_git ? (
            // Said because it cannot be seen and it changes what the click
            // costs: `~/projects` is a perfectly good target and analysing it
            // walks forty repositories as one.
            <p className="text-[11px] text-muted">
              No <span className="font-mono">.git</span> in{" "}
              <span className="font-mono">{target.name}</span>, so everything under it is walked as
              one repo.
            </p>
          ) : null}

          {listing.error && !remote ? (
            <p className="text-[11px] text-danger">{(listing.error as Error).message}</p>
          ) : null}
          {failure ? <p className="text-[11px] text-danger">{failure.message}</p> : null}

          <div className="flex items-center justify-end gap-2 border-t border-line pt-2">
            <Dialog.Close
              className={cn(
                "rounded px-2 py-1 text-[12px] text-muted transition-colors",
                "hover:bg-line hover:text-fg active:bg-line-strong",
              )}
            >
              Cancel
            </Dialog.Close>
            <button
              type="button"
              onClick={submit}
              disabled={(!remote && !target) || busy}
              className={cn(
                "flex items-center gap-1.5 rounded bg-accent px-2.5 py-1 text-[12px] text-white",
                "transition-opacity hover:opacity-90 active:opacity-80",
                "disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {remote ? (
                stage === "cloning" ? (
                  "Cloning…"
                ) : stage === "analysing" ? (
                  "Analysing…"
                ) : (
                  "Clone"
                )
              ) : (
                <>
                  {target?.analysis_key ? "Open" : "Analyse"}
                  {target ? <span className="font-mono">{target.name}</span> : null}
                </>
              )}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * One folder. Kept separate for the ref: an arrow key moves a highlight the
 * mouse never touched, so the row has to scroll itself into view.
 */
function Row({
  entry,
  index,
  active,
  onEnter,
}: {
  entry: FolderEntry;
  index: number;
  active: boolean;
  onEnter: () => void;
}) {
  const node = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) node.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <li
      ref={node}
      id={`folder-${index}`}
      role="option"
      aria-selected={active}
      onClick={onEnter}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[12px]",
        active ? "bg-line text-fg" : "text-fg hover:bg-line",
      )}
    >
      <Folder className="size-3.5 shrink-0 text-faint" />
      <span className="truncate font-mono">{entry.name}</span>
      {entry.is_git ? <GitBranch className="size-3 shrink-0 text-accent" /> : null}
      {entry.analysis_key ? (
        <span className="ml-auto shrink-0 text-[11px] text-muted">analysed</span>
      ) : null}
    </li>
  );
}
