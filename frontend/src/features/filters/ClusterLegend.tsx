"use client";

import { useState } from "react";

import { useFilters } from "@/features/filters/filterStore";
import { cn } from "@/lib/class-names";
import type { Cluster } from "@/generated/contracts";

/**
 * The legend says which rows colour can be trusted on.
 *
 * Ten swatches cannot label 168 clusters. The POC indexed the palette modulo its
 * length and ended up with four indistinguishable greys at four different sizes,
 * so colour looked like it identified a cluster and did not. The backend now
 * marks the ten largest as owning their colour; the rest are collapsed behind a
 * disclosure and share one tone, with the label doing the work instead.
 */
export function ClusterLegend({ clusters }: { clusters: readonly Cluster[] }) {
  const [showRest, setShowRest] = useState(false);
  const setSearch = useFilters((state) => state.setSearch);

  const distinct = clusters.filter((cluster) => cluster.distinct_color);
  const rest = clusters.filter((cluster) => !cluster.distinct_color);
  const restFiles = rest.reduce((total, cluster) => total + cluster.size, 0);

  return (
    <div className="px-1 pb-3">
      {distinct.map((cluster) => (
        <Row key={cluster.id} cluster={cluster} onPick={setSearch} />
      ))}

      {rest.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setShowRest((value) => !value)}
            className="mt-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] text-muted hover:bg-line/60"
          >
            <span className="size-2.5 shrink-0 rounded-full bg-faint" />
            <span className="flex-1">
              {rest.length} smaller clusters, {restFiles.toLocaleString()} files
            </span>
            <span className="text-faint">{showRest ? "hide" : "show"}</span>
          </button>
          {showRest
            ? rest.map((cluster) => <Row key={cluster.id} cluster={cluster} onPick={setSearch} />)
            : null}
        </>
      ) : null}
    </div>
  );
}

function Row({ cluster, onPick }: { cluster: Cluster; onPick: (value: string) => void }) {
  const label = cluster.label;
  // A label like `a/b (features)` carries a disambiguating segment in parens,
  // which is not part of any path and must not go into a search.
  const searchable = label.replace(/\s*\(.*\)$/, "");

  return (
    <button
      type="button"
      onClick={() => onPick(searchable)}
      title={label}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left",
        "hover:bg-line/60",
      )}
    >
      <span
        className="size-2.5 shrink-0 rounded-full"
        style={{ background: cluster.color }}
      />
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg/85">{label}</span>
      <span className="shrink-0 text-[10px] tabular-nums text-faint">{cluster.size}</span>
    </button>
  );
}
