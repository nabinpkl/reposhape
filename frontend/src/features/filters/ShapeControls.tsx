"use client";

import { RotateCcw } from "lucide-react";

import { TriCheckbox } from "@/components/ui/checkbox";
import { useFilters } from "@/features/filters/filterStore";
import type { ViewStats } from "@/generated/contracts";

/**
 * What is currently being filtered, and how to undo it.
 *
 * The POC gave no answer to "why is this graph smaller than it was", because
 * exclusions lived only as scroll position in a long tree. This states the
 * active shape in one line and clears it in one click.
 */
export function ShapeControls({ stats }: { stats: ViewStats }) {
  const excluded = useFilters((state) => state.excluded);
  const includeTests = useFilters((state) => state.includeTests);
  const includeTypeOnly = useFilters((state) => state.includeTypeOnly);
  const setIncludeTests = useFilters((state) => state.setIncludeTests);
  const setIncludeTypeOnly = useFilters((state) => state.setIncludeTypeOnly);
  const clearExcluded = useFilters((state) => state.clearExcluded);
  const dimmed = useFilters((state) => state.dimmed);
  const clearDimmed = useFilters((state) => state.clearDimmed);
  const showLinks = useFilters((state) => state.showLinks);
  const setShowLinks = useFilters((state) => state.setShowLinks);

  const hidden = stats.total_files - stats.visible_files;

  return (
    <div className="shrink-0 space-y-2 border-b border-line px-3 pb-3">
      <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg/85">
        <TriCheckbox
          state={includeTests ? "on" : "off"}
          onChange={setIncludeTests}
          label="Include test files"
        />
        Include tests
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg/85">
        <TriCheckbox
          state={includeTypeOnly ? "on" : "off"}
          onChange={setIncludeTypeOnly}
          label="Include type-only imports"
        />
        Include type-only imports
      </label>
      <label
        className={
          stats.visible_links > 0
            ? "flex cursor-pointer items-center gap-2 text-[12px] text-fg/85"
            : "flex cursor-not-allowed items-center gap-2 text-[12px] text-faint"
        }
        title="Couplings with no import between them: shared event names, programs started with -m, and loader rules (ADR-0009)"
      >
        <TriCheckbox
          state={showLinks && stats.visible_links > 0 ? "on" : "off"}
          onChange={setShowLinks}
          disabled={stats.visible_links === 0}
          label="Show runtime links"
        />
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span
            aria-hidden
            className="w-4 shrink-0 border-t-2 border-dashed border-runtime-link"
          />
          Runtime links
        </span>
        <span className="text-[11px] text-faint tabular-nums">
          {stats.visible_links.toLocaleString()}
        </span>
      </label>

      <div className="flex items-center justify-between pt-1 text-[11px] text-faint">
        <span>
          {hidden > 0 ? `${hidden.toLocaleString()} of ${stats.total_files.toLocaleString()} hidden` : "nothing hidden"}
          {dimmed.size > 0 ? ` · ${dimmed.size} dimmed` : null}
        </span>
        <span className="flex items-center gap-1">
          {dimmed.size > 0 ? (
            <button
              type="button"
              onClick={clearDimmed}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-line hover:text-fg"
            >
              <RotateCcw className="size-3" />
              undim {dimmed.size}
            </button>
          ) : null}
          {excluded.size > 0 ? (
            <button
              type="button"
              onClick={clearExcluded}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted hover:bg-line hover:text-fg"
            >
              <RotateCcw className="size-3" />
              clear {excluded.size}
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}
