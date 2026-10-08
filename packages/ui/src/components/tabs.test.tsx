import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { render, screen } from "../test/render.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";

describe("Tabs", () => {
  it("switches panels with arrow keys", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Tabs defaultValue="sessions">
        <TabsList aria-label="Security">
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="devices">Devices</TabsTrigger>
        </TabsList>
        <TabsContent value="sessions">Sessions panel</TabsContent>
        <TabsContent value="devices">Devices panel</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Sessions panel");
    screen.getByRole("tab", { name: "Sessions" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Devices" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Devices panel");
    await expectNoA11yViolations(container);
  });
});
