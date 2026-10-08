import * as React from "react";
import { cn } from "../lib/cn.js";

export interface TableProps extends React.ComponentProps<"table"> {
  /**
   * Accessible name for the horizontal scroll region the table sits in, used only while the
   * table is wider than its container. Defaults to the table's own `aria-label` /
   * `aria-labelledby`, so a labelled table needs nothing extra.
   */
  scrollLabel?: string | undefined;
}

/**
 * True while the element's content is wider than the element (it can scroll sideways).
 * Re-measured whenever the container or the table resizes — new rows, a narrower viewport.
 */
function useHorizontalOverflow(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [overflowing, setOverflowing] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [ref]);
  return overflowing;
}

/*
 * A table that overflows its container scrolls, and a scroll region must be reachable by
 * keyboard (WCAG 2.1.1; axe `scrollable-region-focusable`) — a table of plain text has nothing
 * focusable inside it to scroll with. So while (and only while) it overflows, the container
 * joins the tab order as a named region; a table that fits adds no stray tab stop.
 */
export function Table({ className, scrollLabel, ...props }: TableProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const overflowing = useHorizontalOverflow(ref);
  const label = scrollLabel ?? props["aria-label"];
  const labelledBy = label === undefined ? props["aria-labelledby"] : undefined;
  const named = label !== undefined || labelledBy !== undefined;
  return (
    <div
      ref={ref}
      data-slot="table-container"
      className="relative w-full overflow-x-auto rounded-sm focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50"
      {...(overflowing
        ? {
            tabIndex: 0,
            ...(named
              ? { role: "region", "aria-label": label, "aria-labelledby": labelledBy }
              : {}),
          }
        : {})}
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}
export function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}
export function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}
export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}
export function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}
export function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}
export function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
