import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { me, testConfig } from "../test/fixtures.js";
import { billingOverview, staffBootstrap, staffMe } from "../test/fixtures-billing.js";
import { installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * A module that is on but outside the workspace's plan (A-3, ADR-0063) is read-only for staff:
 * every admin page of it says so above the module's own content, with the way to Billing for
 * those who can see billing. Investors keep reading and see nothing different.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({
  investorModules: {
    updates: () => Promise.resolve({ default: () => <h1>Updates for investors</h1> }),
  },
  adminModules: {
    updates: () => Promise.resolve({ default: () => <h1>Updates admin</h1> }),
  },
}));

const BILLING_CONFIG = testConfig({ billing: true });

function updates(readOnly: boolean): FundRoomSchemas["ModuleDescriptor"] {
  return {
    id: "updates",
    version: "1.0.0",
    enabled: true,
    hidden: false,
    readOnly,
    flags: {},
    slots: {
      "investor.nav": [{ id: "updates", label: "Updates", to: "/updates", order: 10 }],
      "admin.nav": [{ id: "updates-admin", label: "Updates", to: "/admin/updates", order: 10 }],
    },
  };
}

function handlers(readOnly: boolean, permissions = ["billing.read"]) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      staffBootstrap({ permissions, modules: [updates(readOnly)] }),
    ],
  });
}

const BODY =
  "This module is read-only on your current plan. Investors can still see what is published.";

describe("read-only module banner", () => {
  it("says so above an admin page, with the way to billing", async () => {
    handlers(true);
    const r = await renderApp("/admin/updates", BILLING_CONFIG);
    expect(
      await screen.findByRole("heading", { name: "Updates admin" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const banner = screen.getByText(BODY).closest("[data-slot=alert]") as HTMLElement;
    expect(within(banner).getByText("Read-only on your plan")).toBeInTheDocument();
    expect(
      within(banner).getByText(/An owner can change the plan in Billing\./u),
    ).toBeInTheDocument();
    const link = within(banner).getByRole("link", { name: "Go to billing" });
    expect(link).toHaveAttribute("href", "/admin/billing");
    // Persistently underlined: inside body text, colour alone is not enough.
    expect(link).toHaveClass("underline");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("leaves the billing link out for staff who cannot see billing", async () => {
    handlers(true, []);
    await renderApp("/admin/updates", BILLING_CONFIG);
    expect(await screen.findByText(BODY, {}, { timeout: 5000 })).toBeInTheDocument();
    // They cannot see Billing (nor whether the host bills by hand): ask an owner (RR3 RL1).
    expect(screen.getByText("Ask an owner about changing the plan.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Go to billing" })).toBeNull();
  }, 20_000);

  // R3 L5: an install without billing has no Billing page to send anyone to.
  it("points at the host, not Billing, on an install that does not bill", async () => {
    handlers(true);
    const r = await renderApp("/admin/updates", testConfig({ billing: false }));
    const banner = (await screen.findByText(BODY, {}, { timeout: 5000 })).closest(
      "[data-slot=alert]",
    ) as HTMLElement;
    expect(within(banner).getByText("To change the plan, contact your host.")).toBeInTheDocument();
    expect(within(banner).queryByText(/Billing/u)).toBeNull();
    expect(within(banner).queryByRole("link")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows nothing when the module is on the plan", async () => {
    handlers(false);
    await renderApp("/admin/updates", BILLING_CONFIG);
    expect(
      await screen.findByRole("heading", { name: "Updates admin" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(BODY)).toBeNull();
  }, 20_000);

  it("changes nothing for investors", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, staffBootstrap({ modules: [updates(true)] })],
    });
    const r = await renderApp("/updates", BILLING_CONFIG);
    expect(
      await screen.findByRole("heading", { name: "Updates for investors" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(BODY)).toBeNull();
    expect(screen.queryByText("Read-only on your plan")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  // RR3 RL1: a workspace billed by hand changes plan through the host, as Billing itself says.
  it("points at the host when the workspace is billed by hand", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap({ permissions: ["billing.read"], modules: [updates(true)] }),
      ],
      "GET /api/v1/billing": () => [200, billingOverview({ driver: "manual", canManage: false })],
    });
    await renderApp("/admin/updates", BILLING_CONFIG);
    const banner = (await screen.findByText(BODY, {}, { timeout: 5000 })).closest(
      "[data-slot=alert]",
    ) as HTMLElement;
    expect(
      await within(banner).findByText(
        "Plan and payment changes for this workspace go through your host. Contact them to make a change.",
      ),
    ).toBeInTheDocument();
    expect(within(banner).queryByText("An owner can change the plan in Billing.")).toBeNull();
  }, 20_000);
});
