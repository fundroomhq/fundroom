import { MenuIcon } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn.js";
import { Button } from "./button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog.js";
import { useUiLabel } from "./ui-labels.js";
import { VisuallyHidden } from "./visually-hidden.js";

export interface AppShellProps {
  sidebar?: React.ReactNode;
  header?: React.ReactNode;
  /**
   * A persistent, full-width strip above the header and sidebar (e.g. "viewing as someone
   * else"). Rendered as a live `role="status"` region on the warning palette, which is paired
   * for contrast in both themes. Omit it and nothing is rendered.
   */
  banner?: React.ReactNode;
  children: React.ReactNode;
  skipToContentLabel: string;
  /** Accessible name of the small-screen menu button; defaults to `UiLabelsProvider`'s `menu`. */
  menuLabel?: string;
  mainId?: string;
  /** `min-h-dvh` on the shell; turn off inside iframes (design/08 §4). */
  fullHeight?: boolean;
  className?: string;
}

/**
 * Two-column shell: sidebar (hidden under `md`, then offered in a drawer from the header's
 * menu button), header, and `<main>` reachable through a skip link. Nothing here is
 * `position: fixed` and nothing uses `100vh`, so it also works inside an embed iframe.
 */
export function AppShell({
  sidebar,
  header,
  banner,
  children,
  skipToContentLabel,
  menuLabel: menuLabelProp,
  mainId = "main",
  fullHeight = true,
  className,
}: AppShellProps) {
  const [open, setOpen] = React.useState(false);
  const menuLabel = useUiLabel("menu", menuLabelProp);
  const shell = (
    <div
      data-slot="app-shell"
      className={cn(
        "relative flex w-full bg-background text-foreground",
        banner ? "flex-1" : fullHeight && "min-h-dvh",
        className,
      )}
    >
      <a
        href={`#${mainId}`}
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {skipToContentLabel}
      </a>
      {sidebar ? (
        <>
          <div data-slot="app-shell-sidebar-column" className="hidden w-60 shrink-0 md:block">
            {sidebar}
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent
              className="top-0 left-0 h-full w-60 max-w-[80%] translate-x-0 rounded-none p-0 sm:max-w-xs"
              closeLabel={menuLabel}
              onClick={(e) => {
                // Close the drawer when a link inside it is activated.
                if ((e.target as HTMLElement).closest("a")) setOpen(false);
              }}
            >
              <VisuallyHidden>
                <DialogTitle>{menuLabel}</DialogTitle>
                <DialogDescription>{skipToContentLabel}</DialogDescription>
              </VisuallyHidden>
              {sidebar}
            </DialogContent>
          </Dialog>
        </>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        {header || sidebar ? (
          <AppShellHeader>
            {sidebar ? (
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label={menuLabel}
                onClick={() => setOpen(true)}
              >
                <MenuIcon aria-hidden="true" />
              </Button>
            ) : null}
            {header}
          </AppShellHeader>
        ) : null}
        <main id={mainId} tabIndex={-1} className="flex-1 p-4 outline-none md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
  if (!banner) return shell;
  return (
    <div
      data-slot="app-shell-frame"
      className={cn("flex w-full flex-col bg-background", fullHeight && "min-h-dvh")}
    >
      <div
        data-slot="app-shell-banner"
        role="status"
        className="w-full border-b border-warning bg-warning px-4 py-2 text-sm font-medium text-warning-foreground md:px-8"
      >
        {banner}
      </div>
      {shell}
    </div>
  );
}

export function AppShellSidebar({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="app-shell-sidebar"
      className={cn(
        "flex h-full min-h-full flex-col gap-4 border-r bg-sidebar p-4 text-sidebar-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function AppShellHeader({ className, children, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="app-shell-header"
      className={cn("flex h-14 items-center gap-2 border-b px-4 md:px-8", className)}
      {...props}
    >
      {children}
    </header>
  );
}

export interface NavListItem {
  id: string;
  label: string;
  to: string;
  icon?: React.ReactNode;
  active?: boolean;
}

export interface NavListProps {
  items: readonly NavListItem[];
  /** Render the link element (e.g. TanStack `Link`) with the supplied class and aria-current. */
  render: (
    item: NavListItem,
    props: { className: string; "aria-current"?: "page" },
  ) => React.ReactNode;
  ariaLabel: string;
  className?: string;
}

const NAV_LINK_CLASS =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0";

export function NavList({ items, render, ariaLabel, className }: NavListProps) {
  return (
    <nav aria-label={ariaLabel} data-slot="nav-list" className={className}>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.id}>
            {render(item, {
              className: NAV_LINK_CLASS,
              ...(item.active ? { "aria-current": "page" as const } : {}),
            })}
          </li>
        ))}
      </ul>
    </nav>
  );
}
