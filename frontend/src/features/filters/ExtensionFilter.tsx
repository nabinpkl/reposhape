"use client";

import { TriCheckbox } from "@/components/ui/checkbox";
import { useFilters } from "@/features/filters/filterStore";

/**
 * The extensions this tool reads. One checkbox each, checked means shown.
 *
 * Shape, not view: unchecking an extension drops those files before Louvain
 * runs, so the cluster count moves exactly the way a path exclusion moves it.
 * Anything outside this list (assets, configs, generated files) is never a
 * node in the first place and is unaffected by every box here.
 */
const EXTENSIONS = ["ts", "tsx", "js", "jsx", "vue", "py", "swift"] as const;

function extensionOf(path: string): string {
  const leaf = path.split("/").pop() ?? path;
  const dot = leaf.lastIndexOf(".");
  return dot >= 0 ? leaf.slice(dot + 1).toLowerCase() : "";
}

export function ExtensionFilter({ paths }: { paths: readonly string[] }) {
  const excludedExtensions = useFilters((state) => state.excludedExtensions);
  const setExcludedExtension = useFilters((state) => state.setExcludedExtension);

  const counts = new Map<string, number>();
  for (const path of paths) {
    const ext = extensionOf(path);
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }

  return (
    <div className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-1.5 px-3 pb-1">
      {EXTENSIONS.map((ext) => (
        <label
          key={ext}
          className="flex cursor-pointer items-center gap-2 text-[12px] text-fg/85"
        >
          <TriCheckbox
            state={excludedExtensions.has(ext) ? "off" : "on"}
            onChange={(checked) => setExcludedExtension(ext, !checked)}
            label={`Include .${ext} files`}
          />
          <span className="font-mono">.{ext}</span>
          <span className="ml-auto text-[10.5px] tabular-nums text-faint">
            {(counts.get(ext) ?? 0).toLocaleString()}
          </span>
        </label>
      ))}
    </div>
  );
}
