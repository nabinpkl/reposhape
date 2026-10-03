"use client";

import { cn } from "@/lib/class-names";
import type { CheckState } from "@/features/filters/pathTree";

/**
 * A tri-state checkbox driven entirely by a prop.
 *
 * `indeterminate` is a DOM property with no HTML attribute, so React cannot set
 * it declaratively and it has to go on via a ref callback. Doing it in an
 * effect instead is how it ends up one render behind.
 */
export function TriCheckbox({
  state,
  onChange,
  label,
  disabled = false,
  className,
}: {
  state: CheckState;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={state === "on"}
      disabled={disabled}
      ref={(node) => {
        if (node) node.indeterminate = state === "partial";
      }}
      onChange={(event) => onChange(event.target.checked)}
      onClick={(event) => event.stopPropagation()}
      className={cn(
        "size-[13px] shrink-0 cursor-pointer appearance-none rounded-[3px]",
        "border-[1.5px] border-line-strong bg-canvas",
        "checked:border-accent checked:bg-accent",
        "indeterminate:border-accent indeterminate:bg-accent",
        "relative transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-40",
        "checked:after:absolute checked:after:left-[3px] checked:after:top-px",
        "checked:after:h-[6px] checked:after:w-[3px] checked:after:rotate-45",
        "checked:after:border-b-2 checked:after:border-r-2 checked:after:border-white checked:after:content-['']",
        "indeterminate:after:absolute indeterminate:after:left-[2px] indeterminate:after:top-[5px]",
        "indeterminate:after:h-[2px] indeterminate:after:w-[7px] indeterminate:after:bg-white",
        "indeterminate:after:content-['']",
        className,
      )}
    />
  );
}
