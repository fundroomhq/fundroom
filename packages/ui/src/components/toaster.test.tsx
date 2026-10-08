import { describe, expect, it } from "vitest";
import { act, render, screen } from "../test/render.js";
import { ThemeProvider } from "../theme/theme-provider.js";
import { Toaster, toast } from "./toaster.js";

describe("Toaster", () => {
  it("renders a toast", async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <Toaster />
      </ThemeProvider>,
    );
    act(() => {
      toast.success("Saved");
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });
});
