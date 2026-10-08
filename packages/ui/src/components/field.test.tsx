import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { render, screen } from "../test/render.js";
import { Field, fieldAria } from "./field.js";
import { Input } from "./input.js";

describe("Field", () => {
  it("associates label, description and error with the control", async () => {
    const { container } = render(
      <Field id="email" label="Email" description="Work address" error="Required" required>
        <Input id="email" {...fieldAria("email", { description: true, error: true })} />
      </Field>,
    );
    const input = screen.getByLabelText(/Email/u);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", "email-error email-description");
    expect(screen.getByRole("alert")).toHaveTextContent("Required");
    expect(screen.getByText("Work address")).toHaveAttribute("id", "email-description");
    await expectNoA11yViolations(container);
  });

  it("fieldAria is empty when nothing is present", () => {
    expect(fieldAria("x", {})).toEqual({});
    expect(fieldAria("x", { description: true })).toEqual({ "aria-describedby": "x-description" });
  });
});
