"use client";

import { ChevronRight, FileCode } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { TriCheckbox } from "@/components/ui/checkbox";
import { useFilters } from "@/features/filters/filterStore";
import {
  buildPathTree,
  checkStateOf,
  descendantFiles,
  type PathNode,
} from "@/features/filters/pathTree";
import { cn } from "@/lib/class-names";

/**
 * Scope, at whatever depth you mean it.
 *
 * A folder row excludes its whole subtree as one entry; a file row excludes one
 * file. Check state is derived from the exclusion set on every render, so there
 * is no sync step and no way for a box to disagree with the graph. The POC kept
 * checkbox elements in parallel arrays and reconciled them by hand, which is the
 * drift this avoids.
 */
export function PathFilter({
  paths,
  onOpenFile,
}: {
  paths: readonly string[];
  onOpenFile: (path: string) => void;
}) {
  const tree = useMemo(() => buildPathTree(paths), [paths]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>());

  const toggleOpen = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="pb-2">
      {tree.map((node) => (
        <TreeRow
          key={node.path}
          node={node}
          depth={0}
          open={open}
          onToggleOpen={toggleOpen}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

const TreeRow = memo(function TreeRow({
  node,
  depth,
  open,
  onToggleOpen,
  onOpenFile,
}: {
  node: PathNode;
  depth: number;
  open: ReadonlySet<string>;
  onToggleOpen: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const excluded = useFilters((state) => state.excluded);
  const focusedPath = useFilters((state) => state.focusedPath);
  const setFocus = useFilters((state) => state.setFocus);
  const setExcluded = useFilters((state) => state.setExcluded);
  const setManyExcluded = useFilters((state) => state.setManyExcluded);

  const isFolder = node.children.length > 0;
  const expanded = open.has(node.path);
  const state = checkStateOf(node, excluded);

  const onChange = (next: boolean) => {
    if (isFolder) {
      // Excluding a folder is one entry, not one per file, so the wire stays
      // small and the intent survives: "not this subtree".
      setExcluded(node.path, !next);
      if (next) setManyExcluded(descendantFiles(node), false);
    } else {
      setExcluded(node.path, !next);
    }
  };

  return (
    <div>
      <div
        className={cn(
          "group flex min-w-0 cursor-pointer items-center gap-1.5 py-[3px] pr-2",
          "hover:bg-line/60",
          !isFolder && focusedPath === node.path && "bg-accent/25",
        )}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        // A folder toggles open. A file behaves the way a file does in every
        // other tree a reader has used: select on click, open on double-click.
        onClick={
          isFolder ? () => onToggleOpen(node.path) : () => setFocus(node.path)
        }
        onDoubleClick={isFolder ? undefined : () => onOpenFile(node.path)}
      >
        {isFolder ? (
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-faint transition-transform",
              expanded && "rotate-90",
            )}
          />
        ) : (
          <FileCode className="size-3 shrink-0 text-faint/70" />
        )}
        <TriCheckbox state={state} onChange={onChange} label={node.path} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[12px]",
            state === "off" ? "text-faint line-through" : "text-fg/90",
          )}
          title={node.path}
        >
          {node.name}
        </span>
        {isFolder ? (
          <span className="shrink-0 text-[10px] tabular-nums text-faint">{node.fileCount}</span>
        ) : null}
      </div>
      {isFolder && expanded
        ? node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              open={open}
              onToggleOpen={onToggleOpen}
              onOpenFile={onOpenFile}
            />
          ))
        : null}
    </div>
  );
});
