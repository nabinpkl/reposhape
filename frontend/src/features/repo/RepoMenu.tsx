"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, Trash2 } from "lucide-react";
import { Popover } from "radix-ui";
import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { cn } from "@/lib/class-names";
import type { RepoSummary } from "@/generated/contracts";

/** How long an armed Forget waits for its second click before standing down. */
const FORGET_ARMED_MS = 3000;

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

function analysedAgo(generatedAt: string, now: number): string {
  const seconds = (new Date(generatedAt).getTime() - now) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

const nameOf = (repo: RepoSummary) => repo.repo_path.split("/").pop() ?? repo.repo_path;
const commitOf = (repo: RepoSummary) =>
  `${(repo.git_sha ?? "no-git").slice(0, 8)}${repo.dirty ? "+" : ""}`;

/**
 * Which repository, and the way out of the cache for any of them.
 *
 * It replaced a native `<select>`, which cannot hold a control per row: the
 * only repo that could be forgotten was the one on screen, so forgetting any
 * other meant loading its graph first. Each row here picks with its body and
 * forgets with its trailing button, and forgetting leaves the menu open so a
 * reader clearing out several does not reopen it each time.
 */
export function RepoMenu({
  rows,
  active,
  onPick,
  onForget,
}: {
  rows: RepoSummary[] | undefined;
  active: RepoSummary | null;
  onPick: (summary: RepoSummary) => void;
  /**
   * Every key removed, and the repo to show instead, or null when none is left.
   * Null on a read-only server, which has no route to forget with, so the rows
   * carry no trash button.
   */
  onForget: ((removed: string[], next: RepoSummary | null) => void) | null;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // Read once per opening rather than per render: ages hold still while the
  // menu is up, and render stays free of the clock.
  const [now, setNow] = useState(0);
  const [armed, setArmed] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);

  // Two clicks, not a dialog. What goes is a cache that regenerates in seconds,
  // so a dialog would be ceremony; one click on a trash icon beside every row
  // would be a mis-click waiting to happen.
  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), FORGET_ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const repos = rows ?? [];

  const forget = useMutation({
    mutationFn: (key: string) => api.forget(key),
    onSuccess: async (removed, key) => {
      setArmed(null);
      const gone = repos.find((row) => row.key === key)?.repo_path;
      // Newest first, but not onto a repo whose directory is gone: its graph
      // would draw from the artifact and every file in it would answer 410.
      const others = repos.filter((row) => row.repo_path !== gone);
      const next = others.find((row) => row.exists) ?? others[0] ?? null;
      // Move the view first, then drop the cache, so nothing still mounted on a
      // removed key refetches it into a 404.
      onForget?.(removed, next);
      queryClient.removeQueries({
        predicate: (query) => removed.includes(String(query.queryKey[1])),
      });
      await queryClient.invalidateQueries({ queryKey: ["repos"] });
    },
  });

  const pick = (repo: RepoSummary) => {
    onPick(repo);
    setOpen(false);
  };

  // Arrow keys move between rows whichever of a row's two buttons has focus;
  // Tab still walks every button in order.
  const onListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(list.current?.children ?? [])];
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.findIndex((item) => item.contains(document.activeElement));
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = at < 0 ? 0 : (at + step + items.length) % items.length;
    items[next]?.querySelector<HTMLButtonElement>("[data-pick]")?.focus();
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setNow(Date.now());
          setArmed(null);
          forget.reset();
        }
      }}
    >
      <Popover.Trigger
        disabled={repos.length === 0}
        className={cn(
          "flex min-w-0 max-w-[420px] flex-1 items-center gap-2 rounded border border-line-strong",
          "bg-canvas px-2 py-1 text-left text-[12px] text-fg outline-none transition-colors",
          "hover:border-accent/60 focus-visible:border-accent data-[state=open]:border-accent",
          "disabled:cursor-not-allowed disabled:hover:border-line-strong",
        )}
      >
        {active ? (
          <>
            <span className={cn("truncate", !active.exists && "text-muted")}>{nameOf(active)}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted">{commitOf(active)}</span>
          </>
        ) : (
          <span className="truncate text-faint">
            {repos.length ? "Pick a repo" : "No analyses yet"}
          </span>
        )}
        <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(event) => {
            // Land on the repo being read rather than the first row, so Enter
            // is a no-op and the arrows start from where the reader is.
            event.preventDefault();
            const current =
              list.current?.querySelector<HTMLButtonElement>('[aria-current="true"]') ??
              list.current?.querySelector<HTMLButtonElement>("[data-pick]");
            current?.focus();
          }}
          className={cn(
            "z-50 w-[var(--radix-popover-trigger-width)] min-w-[min(360px,calc(100vw-2rem))]",
            "rounded-lg border border-line bg-panel p-1 shadow-2xl",
          )}
        >
          <ul ref={list} onKeyDown={onListKeyDown} className="max-h-[60vh] overflow-y-auto">
            {repos.map((repo) => (
              <Row
                key={repo.repo_path}
                repo={repo}
                current={repo.repo_path === active?.repo_path}
                now={now}
                armed={armed === repo.repo_path}
                pending={forget.isPending && forget.variables === repo.key}
                onPick={() => pick(repo)}
                onArm={() => setArmed(repo.repo_path)}
                onDisarm={() => setArmed((path) => (path === repo.repo_path ? null : path))}
                onForget={onForget ? () => forget.mutate(repo.key) : null}
              />
            ))}
          </ul>
          {forget.error ? (
            <p className="px-2 py-1 text-[11px] text-danger">{(forget.error as Error).message}</p>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({
  repo,
  current,
  now,
  armed,
  pending,
  onPick,
  onArm,
  onDisarm,
  onForget,
}: {
  repo: RepoSummary;
  current: boolean;
  now: number;
  armed: boolean;
  pending: boolean;
  onPick: () => void;
  onArm: () => void;
  onDisarm: () => void;
  onForget: (() => void) | null;
}) {
  const name = nameOf(repo);
  return (
    <li className="group flex items-center gap-0.5">
      <button
        type="button"
        data-pick
        aria-current={current ? "true" : undefined}
        title={repo.repo_path}
        onClick={onPick}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-[12px]",
          "outline-none transition-colors hover:bg-line focus-visible:bg-line active:bg-line-strong",
        )}
      >
        <Check className={cn("size-3.5 shrink-0 text-accent", !current && "invisible")} />
        {/* A repo gone from disk stays pickable -- its graph is in the cache --
            but reads as lesser, because nothing in it can be opened. */}
        <span className={cn("truncate", repo.exists ? "text-fg" : "text-muted")}>{name}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">{commitOf(repo)}</span>
        <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted">
          {repo.exists ? `analysed ${analysedAgo(repo.generated_at, now)}` : "missing on disk"}
        </span>
      </button>
      {onForget ? (
        <button
          type="button"
          aria-label={armed ? `Confirm forgetting ${name}` : `Forget ${name}`}
          title={armed ? "Click again to forget" : "Forget this repo"}
          onClick={armed ? onForget : onArm}
          onBlur={onDisarm}
          disabled={pending}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded p-1.5 transition-colors",
            "disabled:cursor-not-allowed disabled:opacity-50",
            armed
              ? "bg-danger/15 text-danger hover:bg-danger/25 active:bg-danger/35"
              : "text-faint group-hover:text-muted hover:bg-line hover:text-fg active:bg-line-strong",
          )}
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          {armed ? <span className="pr-0.5 text-[11px]">Forget</span> : null}
        </button>
      ) : null}
    </li>
  );
}
