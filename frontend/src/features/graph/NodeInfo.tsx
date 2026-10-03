"use client";

import { ArrowDownLeft, ArrowUpRight, FileText } from "lucide-react";

import { useFilters } from "@/features/filters/filterStore";
import { cn } from "@/lib/class-names";
import type { GraphView } from "@/generated/contracts";

/** What the focused file imports, and what imports it. */
export function NodeInfo({
  view,
  onOpenFile,
}: {
  view: GraphView;
  onOpenFile: (path: string) => void;
}) {
  const focusedPath = useFilters((state) => state.focusedPath);
  const setFocus = useFilters((state) => state.setFocus);

  if (!focusedPath) {
    return (
      <p className="px-3 pb-3 text-[12px] text-faint italic">
        Click a node to isolate it and open the file.
      </p>
    );
  }

  const node = view.nodes.find((candidate) => candidate.path === focusedPath);
  const colorOf = new Map(view.clusters.map((cluster) => [cluster.id, cluster.color]));
  const imports = view.edges.filter((edge) => edge.source === focusedPath);
  const importedBy = view.edges.filter((edge) => edge.target === focusedPath);

  return (
    <div className="px-3 pb-3">
      <p className="break-all text-[12px] font-medium text-fg">{focusedPath}</p>
      <p className="mt-0.5 text-[11px] text-faint">
        {node ? `${node.lines.toLocaleString()} lines · ${node.language}` : "not in view"}
      </p>

      <button
        type="button"
        onClick={() => onOpenFile(focusedPath)}
        className="mt-2 flex w-full items-center gap-1.5 rounded border border-line-strong px-2 py-1 text-[11.5px] text-fg/90 hover:bg-line"
      >
        <FileText className="size-3.5" />
        Open file
      </button>

      <Neighbours
        title="Imports"
        icon={<ArrowUpRight className="size-3" />}
        paths={imports.map((edge) => edge.target)}
        colorOf={colorOf}
        view={view}
        onPick={setFocus}
      />
      <Neighbours
        title="Imported by"
        icon={<ArrowDownLeft className="size-3" />}
        paths={importedBy.map((edge) => edge.source)}
        colorOf={colorOf}
        view={view}
        onPick={setFocus}
      />
    </div>
  );
}

function Neighbours({
  title,
  icon,
  paths,
  colorOf,
  view,
  onPick,
}: {
  title: string;
  icon: React.ReactNode;
  paths: string[];
  colorOf: Map<number, string>;
  view: GraphView;
  onPick: (path: string) => void;
}) {
  if (paths.length === 0) return null;
  const clusterOf = new Map(view.nodes.map((node) => [node.path, node.cluster]));

  return (
    <div className="mt-3">
      <p className="mb-1 flex items-center gap-1 text-[10.5px] tracking-[0.06em] text-muted uppercase">
        {icon}
        {title} ({paths.length})
      </p>
      {paths.map((path) => (
        <button
          key={path}
          type="button"
          onClick={() => onPick(path)}
          title={path}
          className={cn(
            "block w-full truncate border-l-[3px] py-[3px] pl-2 text-left text-[11.5px]",
            "text-fg/80 hover:bg-line/60 hover:text-fg",
          )}
          style={{ borderLeftColor: colorOf.get(clusterOf.get(path) ?? -1) ?? "#3a3a5e" }}
        >
          {path.split("/").slice(-2).join("/")}
        </button>
      ))}
    </div>
  );
}
