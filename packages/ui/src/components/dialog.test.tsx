import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { render, screen, waitFor } from "../test/render.js";
import { Button } from "./button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.js";

describe("Dialog", () => {
  it("opens, traps focus, closes on Escape and passes axe", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke session</DialogTitle>
            <DialogDescription>This signs the device out.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke session" });
    expect(dialog).toHaveAccessibleDescription("This signs the device out.");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await expectNoA11yViolations(dialog);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  /*
   * The vertical offset is a custom property with the old literal as its fallback, so a
   * top-level app is unchanged and an embed can move the dialog into the part of a
   * loader-sized frame the reader can actually see (`--sh-dialog-top`, set by
   * `apps/web/src/embed/EmbedFrame.tsx`). Both halves of that are worth pinning here.
   */
  it("takes its offset from --sh-dialog-top, defaulting to the offset it has always had", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke session</DialogTitle>
            <DialogDescription>This signs the device out.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke session" });
    expect(dialog.className).toContain("top-[var(--sh-dialog-top,10vmin)]");
    // The property inherits to the portalled node, which is what lets `:root` publish it.
    document.documentElement.style.setProperty("--sh-dialog-top", "2548px");
    expect(getComputedStyle(dialog).getPropertyValue("--sh-dialog-top").trim()).toBe("2548px");
    document.documentElement.style.removeProperty("--sh-dialog-top");
  });

  it("still lets a caller override the offset through className", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        {/* The mobile nav drawer in `app-shell.tsx` does exactly this; a `style` on the
            component would have silently outranked it. */}
        <DialogContent className="top-0 left-0">
          <DialogTitle>Menu</DialogTitle>
          <DialogDescription>Navigation</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    expect(dialog.className).toContain("top-0");
    expect(dialog.className).not.toContain("top-[var(--sh-dialog-top,10vmin)]");
  });
});
