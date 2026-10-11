"use client";

import { Search } from "lucide-react";

import { useFilters } from "@/features/filters/filterStore";

/** The search box: every path containing the text stays lit, the rest dim. */
export function HighlightSearch() {
  const search = useFilters((state) => state.search);
  const setSearch = useFilters((state) => state.setSearch);
  return (
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
  );
}
