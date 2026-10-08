import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { render, screen } from "../test/render.js";
import { Alert, AlertDescription, AlertTitle } from "./alert.js";
import { Badge } from "./badge.js";

describe("Alert", () => {
  it("destructive alerts are live regions; others are status", async () => {
    const { container } = render(
      <div>
        <Alert variant="destructive">
          <AlertTitle>Failed</AlertTitle>
          <AlertDescription>Try again.</AlertDescription>
        </Alert>
        <Alert variant="success">
          <AlertTitle>Saved</AlertTitle>
        </Alert>
        <Badge variant="warning">Pending</Badge>
      </div>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    await expectNoA11yViolations(container);
  });
});
