import { describe, expect, it } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { render, screen } from "../test/render.js";
import { AppShell, AppShellSidebar, NavList } from "./app-shell.js";

describe("AppShell", () => {
  it("skip link targets main; NavList marks the active item", async () => {
    const { container } = render(
      <AppShell
        skipToContentLabel="Skip to content"
        menuLabel="Menu"
        sidebar={
          <AppShellSidebar>
            <NavList
              ariaLabel="Primary"
              items={[
                { id: "home", label: "Home", to: "/", active: true },
                { id: "docs", label: "Data room", to: "/data-room" },
              ]}
              render={(item, props) => (
                <a href={item.to} {...props}>
                  {item.label}
                </a>
              )}
            />
          </AppShellSidebar>
        }
        header={<span>Acme</span>}
      >
        <p>content</p>
      </AppShell>,
    );
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", "#main");
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main");
    expect(main).toHaveAttribute("tabindex", "-1");
    const home = screen.getByRole("link", { name: "Home" });
    expect(home).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Data room" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Menu" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("fullHeight can be turned off for iframes", () => {
    const { container } = render(
      <AppShell skipToContentLabel="Skip" fullHeight={false}>
        x
      </AppShell>,
    );
    expect(container.querySelector('[data-slot="app-shell"]')?.className).not.toContain(
      "min-h-dvh",
    );
  });

  it("renders a persistent status banner above the header only when given", async () => {
    const { container, rerender } = render(
      <AppShell
        skipToContentLabel="Skip"
        header={<span>Header</span>}
        banner={
          <>
            Viewing as Ada <button type="button">Exit view</button>
          </>
        }
      >
        <p>content</p>
      </AppShell>,
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Viewing as Ada");
    expect(screen.getByRole("button", { name: "Exit view" })).toBeInTheDocument();
    // Above the header in document order, and outside <main>.
    const header = container.querySelector('[data-slot="app-shell-header"]');
    expect(header).not.toBeNull();
    expect(
      banner.compareDocumentPosition(header as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("main")).not.toContainElement(banner);
    expect(container.querySelector('[data-slot="app-shell-frame"]')?.className).toContain(
      "min-h-dvh",
    );
    await expectNoA11yViolations(container);

    rerender(
      <AppShell skipToContentLabel="Skip" header={<span>Header</span>}>
        <p>content</p>
      </AppShell>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelector('[data-slot="app-shell-frame"]')).toBeNull();
  });
});
