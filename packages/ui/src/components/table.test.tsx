import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { render, screen } from "../test/render.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.js";

/*
 * jsdom has no layout: every box is 0×0 and Tailwind classes compute to nothing. To reproduce
 * the real-browser case (axe `scrollable-region-focusable` on /settings/security, E3.2) the
 * container is given the overflow style Tailwind would, and a scrollWidth wider than its box.
 *
 * axe itself cannot judge that rule here: under jsdom `scrollable-region-focusable` always comes
 * back "incomplete" (an internal error, with or without the fix), never pass or fail — the same
 * blind spot as colour contrast. So these tests assert the rule's condition directly (the
 * overflowing container is in the tab order, and named when a name is available), and axe checks
 * that what was added is itself valid ARIA. The Playwright axe run is the real-browser guard.
 */
function fakeLayout(overflowing: boolean) {
  const style = document.createElement("style");
  style.textContent = "[data-slot=table-container] { overflow-x: auto; }";
  document.head.append(style);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(overflowing ? 900 : 300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
  return () => style.remove();
}

function Sessions(props: React.ComponentProps<typeof Table>) {
  return (
    <Table {...props}>
      <TableHeader>
        <TableRow>
          <TableHead>Device</TableHead>
          <TableHead>Last seen</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Firefox on macOS</TableCell>
          <TableCell>2 minutes ago</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

describe("Table", () => {
  let cleanup: () => void = () => undefined;
  beforeEach(() => {
    cleanup = () => undefined;
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("makes an overflowing table's scroll region keyboard-reachable and named", async () => {
    cleanup = fakeLayout(true);
    const { container } = render(<Sessions aria-label="Sessions" />);
    const region = await screen.findByRole("region", { name: "Sessions" });
    expect(region).toHaveAttribute("data-slot", "table-container");
    expect(region).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("table", { name: "Sessions" })).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("takes the region's name from scrollLabel or the table's aria-labelledby", async () => {
    cleanup = fakeLayout(true);
    const { container } = render(
      <div>
        <h2 id="devices-heading">Devices</h2>
        <Sessions aria-labelledby="devices-heading" />
        <Sessions scrollLabel="Other sessions" />
      </div>,
    );
    expect(await screen.findByRole("region", { name: "Devices" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("region", { name: "Other sessions" })).toHaveAttribute("tabindex", "0");
    await expectNoA11yViolations(container);
  });

  it("stays focusable (without a nameless region role) when nothing names it", async () => {
    cleanup = fakeLayout(true);
    const { container } = render(<Sessions />);
    const wrapper = container.querySelector("[data-slot=table-container]");
    await vi.waitFor(() => expect(wrapper).toHaveAttribute("tabindex", "0"));
    expect(wrapper).not.toHaveAttribute("role");
    await expectNoA11yViolations(container);
  });

  it("adds no tab stop or landmark when the table fits", async () => {
    cleanup = fakeLayout(false);
    const { container } = render(<Sessions aria-label="Sessions" />);
    const wrapper = container.querySelector("[data-slot=table-container]");
    expect(wrapper).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("region")).toBeNull();
    await expectNoA11yViolations(container);
  });
});
