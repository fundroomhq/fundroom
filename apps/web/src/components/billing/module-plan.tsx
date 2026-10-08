import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fundroomhq/ui";
import type { RefObject } from "react";
import type { ModuleEnablement } from "../../lib/branding-queries.js";
import { useBootstrap } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";

/*
 * Module switches under a plan (A-3, ADR-0063), shared by the modules page and the setup
 * wizard. A module the plan leaves out is either off and locked (`lockedReason: "plan"`: the
 * switch cannot turn it on) or on and read-only (staff can read it and switch it off, investors
 * are unaffected). Switching a read-only module off is the one move that cannot be undone
 * without a plan change, so it asks first.
 *
 * Deliberately no "available on Growth and up": the product does not know plan order or prices.
 */

/**
 * The badges for a module row: why it is locked, if it is, and — separately, since a read-only
 * module can also be locked because another module needs it — "Read-only on your plan".
 */
export function moduleBadges(module: ModuleEnablement): string[] {
  const badges: string[] = [];
  if (module.locked) {
    switch (module.lockedReason) {
      case "plan":
        badges.push(m.modules_locked_plan());
        break;
      case "dependency":
        badges.push(m.modules_locked_dependency());
        break;
      default:
        badges.push(m.modules_locked_required());
    }
  }
  if (module.readOnly) badges.push(m.modules_read_only_plan());
  return badges;
}

/**
 * A module switch that cannot be used right now (locked, not the viewer's to change, or saving)
 * stays focusable: `aria-disabled` rather than `disabled`, with the row's badges as its
 * description. Focus can then come back to it after "Turn off" — a browser drops focus from a
 * `disabled` control — and a screen reader announces "switch, off, unavailable" and why.
 */
export const UNAVAILABLE_SWITCH_CLASS = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

/** Locked because the plan leaves it out: the row offers the way to Billing. */
export function isPlanLocked(module: ModuleEnablement): boolean {
  return module.locked && module.lockedReason === "plan";
}

/** "Turn off {module}? You won't be able to turn it back on without changing plan." */
export function DisableReadOnlyModuleDialog({
  moduleId,
  open,
  onOpenChange,
  onConfirm,
  returnFocusTo,
}: {
  moduleId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /**
   * The switch that opened it (there is no trigger element to give focus back to). It must stay
   * focusable after a confirm — locked with `aria-disabled`, not `disabled` (see
   * `UNAVAILABLE_SWITCH_CLASS`) — so a screen reader announces its new state there.
   */
  returnFocusTo: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          returnFocusTo.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{m.modules_disable_read_only_title({ module: moduleId })}</DialogTitle>
          <DialogDescription>{m.modules_disable_read_only_body()}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {m.common_cancel()}
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button type="button" variant="destructive" onClick={onConfirm}>
              {m.modules_disable_read_only_confirm()}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Decision 14: a read-only module can delete but not restore (restoring waits for the plan to
 * include the module again; the bin keeps items until its purge). Its delete dialogs say so:
 * returns the description with that sentence added while `moduleId` is read-only.
 */
export function useReadOnlyRestoreWarning(moduleId: string): (description: string) => string {
  const bootstrap = useBootstrap();
  const readOnly = bootstrap.data?.modules.some((mod) => mod.id === moduleId && mod.readOnly);
  return (description) =>
    readOnly === true
      ? `${description} ${m.module_restore_warning({ module: moduleId })}`
      : description;
}
