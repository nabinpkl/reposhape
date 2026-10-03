"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/class-names";

/**
 * System / dark / light, in the header.
 *
 * next-themes persists the pick in localStorage and resolves `system` through
 * matchMedia, so this is three setTheme calls and no state of its own. The
 * mounted guard is the standard one: the stored theme is known only in the
 * browser, and rendering the active state on the server would hydrate against
 * whatever the blocking script then sets. The placeholder holds the width so
 * the header does not shift a frame later.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // The stored theme is known only in the browser: the server snapshot is
  // unmounted and the client snapshot mounted, which is exactly the split
  // React resolves without a hydration mismatch (same shape as the repo-param
  // hook in Workspace). Nothing subscribes; next-themes writes the <html>
  // class alongside the state change this reads.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  if (!mounted) return <div className="h-[26px] w-[82px] shrink-0" aria-hidden />;

  const options = [
    { value: "system", title: "Follow the system", Icon: Monitor },
    { value: "dark", title: "Dark", Icon: Moon },
    { value: "light", title: "Light", Icon: Sun },
  ] as const;

  return (
    <div
      role="radiogroup"
      aria-label="Colour scheme"
      className="flex shrink-0 items-center gap-px rounded border border-line-strong p-px"
    >
      {options.map(({ value, title, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          title={title}
          aria-label={title}
          onClick={() => setTheme(value)}
          className={cn(
            "rounded-sm p-1 transition-colors hover:bg-line hover:text-fg",
            theme === value ? "bg-line text-fg" : "text-muted",
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
