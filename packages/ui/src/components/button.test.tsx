import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { render, screen } from "../test/render.js";
import { Button } from "./button.js";

describe("Button", () => {
  it("renders variants with data attributes and passes axe", async () => {
    const { container } = render(
      <div>
        <Button>Default</Button>
        <Button variant="destructive" size="sm">
          Delete
        </Button>
        <Button variant="outline" size="icon" aria-label="Settings">
          x
        </Button>
      </div>,
    );
    expect(screen.getByRole("button", { name: "Default" })).toHaveAttribute(
      "data-variant",
      "default",
    );
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute("data-size", "sm");
    expect(screen.getByRole("button", { name: "Default" })).toHaveAttribute("type", "button");
    await expectNoA11yViolations(container);
  });

  it("loading disables the control and announces busy", () => {
    render(<Button loading>Save</Button>);
    const btn = screen.getByRole("button", { name: /Save/u });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("asChild renders the child element with button classes", () => {
    render(
      <Button asChild>
        <a href="/x">Go</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Go" });
    expect(link).toHaveAttribute("data-slot", "button");
    expect(link.className).toContain("inline-flex");
  });
});
