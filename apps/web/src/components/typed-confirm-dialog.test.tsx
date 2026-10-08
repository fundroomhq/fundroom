import { Button } from "@fundroomhq/ui";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppUiLabels } from "../app.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { TypedConfirmDialog } from "./typed-confirm-dialog.js";

/*
 * The typed confirmation behind every E2.7 danger-zone action: the confirm button waits for the
 * exact phrase (no trimming, no case folding — the server compares the slug byte for byte),
 * the field is named by the phrase, and reopening asks again.
 */
function renderDialog(onConfirm = vi.fn()) {
  render(
    <TypedConfirmDialog
      trigger={<Button type="button">Delete workspace</Button>}
      title="Delete acme?"
      description="Everyone loses access now."
      phrase="acme"
      confirmLabel="Delete"
      pending={false}
      onConfirm={onConfirm}
    >
      <p>Extra context</p>
    </TypedConfirmDialog>,
    { wrapper: AppUiLabels },
  );
  return onConfirm;
}

describe("TypedConfirmDialog", () => {
  it("keeps confirm disabled until the phrase matches exactly", async () => {
    const onConfirm = renderDialog();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete acme?" });
    expect(within(dialog).getByText("Extra context")).toBeInTheDocument();
    const input = within(dialog).getByRole("textbox", { name: "Type acme to confirm" });
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();

    await user.type(input, "ACME");
    expect(confirm).toBeDisabled();
    await user.clear(input);
    await user.type(input, "acme ");
    expect(confirm).toBeDisabled();
    // Enter on a mismatch does nothing either.
    await user.type(input, "{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "acme");
    expect(confirm).toBeEnabled();
    await expectNoA11yViolations(dialog);
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears the typed phrase when closed, so reopening asks again", async () => {
    const onConfirm = renderDialog();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    let dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "acme");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("textbox")).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeDisabled();
    // Enter submits once it matches.
    await user.type(within(dialog).getByRole("textbox"), "acme{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
