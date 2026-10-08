import { render as rtlRender, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { render } from "../test/render.js";
import { Dialog, DialogContent, DialogTitle } from "./dialog.js";
import { Spinner } from "./spinner.js";
import { ErrorState, LoadingState } from "./states.js";
import { UiLabelsProvider } from "./ui-labels.js";

describe("UiLabelsProvider", () => {
  const french = {
    close: "Fermer",
    loading: "Chargement",
    requestId: "Identifiant",
    retry: "Réessayer",
    menu: "Menu",
    notifications: "Notifications",
  };

  it("supplies the words the design system needs, with no English of its own", () => {
    rtlRender(
      <UiLabelsProvider labels={french}>
        <Spinner />
        <ErrorState title="x" requestId="r-1" onRetry={() => {}} />
      </UiLabelsProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Chargement");
    expect(screen.getByText(/Identifiant/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeInTheDocument();
  });

  it("names a dialog's close button from the provider", async () => {
    rtlRender(
      <UiLabelsProvider labels={french}>
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>t</DialogTitle>
          </DialogContent>
        </Dialog>
      </UiLabelsProvider>,
    );
    expect(await screen.findByRole("button", { name: "Fermer" })).toBeInTheDocument();
  });

  it("lets a prop override the provider for one use", () => {
    render(<LoadingState label="Loading documents" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading documents");
  });

  it("throws, naming the label, when neither a prop nor a provider supplies it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => rtlRender(<Spinner />)).toThrow(/no "loading" label/u);
    // A prop alone is enough.
    expect(() => rtlRender(<Spinner label="Busy" />)).not.toThrow();
    spy.mockRestore();
  });
});
