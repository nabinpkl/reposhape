"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/class-names";

/**
 * The layout, and the one scroll rule.
 *
 * The POC let the page itself scroll because a flex child had `overflow-y: auto`
 * with no bounded height, and the fix was a hardcoded 320px on one box. That
 * fixes one box and leaves the next one to rediscover it.
 *
 * The rule here, applied once: the shell owns the viewport and never scrolls.
 * Every region that scrolls does so through `ScrollPane`, which carries the
 * `min-h-0` that lets a flex or grid child shrink below its content. That
 * `min-h-0` is the whole bug: without it a child sizes to its content, the
 * overflow never triggers, and the page scrolls instead.
 *
 * Below md (phones) the three columns cannot sit side by side: the sidebar
 * becomes a drawer and the inspector a bottom sheet, both over the canvas,
 * while the desktop grid is untouched above the breakpoint.
 */
export function AppShell({
  sidebar,
  main,
  aside,
  header,
  sidebarOpen,
  onCloseSidebar,
}: {
  sidebar: ReactNode;
  main: ReactNode;
  aside?: ReactNode;
  header: ReactNode;
  sidebarOpen: boolean;
  onCloseSidebar: () => void;
}) {
  return (
    <div className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-canvas text-fg">
      {header}
      <div
        className={cn(
          "grid min-h-0 grid-cols-[minmax(0,1fr)] overflow-hidden",
          aside
            ? "md:grid-cols-[var(--sidebar-w)_minmax(0,1fr)_var(--aside-w)]"
            : "md:grid-cols-[var(--sidebar-w)_minmax(0,1fr)]",
        )}
      >
        <aside
          className={cn(
            "flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel",
            // Drawer below md: fixed, off-canvas until opened. Static grid
            // cell at md and up. One element, not two, so filter state,
            // queries and scroll position are never doubled.
            "fixed inset-y-0 left-0 z-50 w-[85vw] max-w-[320px] border-r border-line transition-transform duration-200",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
            "md:static md:z-auto md:w-auto md:max-w-none md:translate-x-0",
          )}
        >
          {sidebar}
        </aside>
        <main className="relative min-h-0 min-w-0 overflow-hidden">{main}</main>
        {aside ? (
          <section
            className={cn(
              "flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel",
              // Bottom sheet below md: the canvas keeps the top quarter, the
              // inspector takes up to three quarters. Plain grid cell above.
              "fixed inset-x-0 bottom-0 z-50 max-h-[75dvh] rounded-t-2xl border-t border-line",
              "md:static md:z-auto md:max-h-none md:rounded-none md:border-t-0 md:border-l md:border-line",
            )}
          >
            {aside}
          </section>
        ) : null}
      </div>
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close filters"
          onClick={onCloseSidebar}
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
        />
      ) : null}
    </div>
  );
}

/**
 * The only way anything scrolls in this app.
 *
 * `min-h-0` is not decoration: a flex/grid child defaults to `min-height: auto`,
 * sizes to its content, and its `overflow-y: auto` then never has anything to
 * do. Reach for a fixed pixel height instead and you have fixed one pane.
 */
export function ScrollPane({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto overflow-x-hidden", className)}>
      {children}
    </div>
  );
}

/** A sidebar section heading. One definition, so they cannot drift apart. */
export function PaneHeading({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2">
      <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
        {children}
      </h2>
      {actions}
    </div>
  );
}
