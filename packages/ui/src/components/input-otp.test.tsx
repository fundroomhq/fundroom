import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { render, screen } from "../test/render.js";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "./input-otp.js";

describe("InputOTP", () => {
  it("fills slots as the user types", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <InputOTP maxLength={4} aria-label="One-time code">
        <InputOTPGroup>
          {[0, 1, 2, 3].map((i) => (
            <InputOTPSlot key={i} index={i} />
          ))}
        </InputOTPGroup>
      </InputOTP>,
    );
    const input = screen.getByRole("textbox", { name: "One-time code" });
    await user.click(input);
    await user.keyboard("1234");
    const slots = container.querySelectorAll('[data-slot="input-otp-slot"]');
    expect(Array.from(slots).map((s) => s.textContent)).toEqual(["1", "2", "3", "4"]);
    await expectNoA11yViolations(container);
  });
});
