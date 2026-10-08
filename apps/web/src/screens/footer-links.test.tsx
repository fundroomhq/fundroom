import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrap, me, testConfig } from "../test/fixtures.js";
import {
  billingOverview,
  staffBootstrap,
  staffMe,
  workspaceUsage,
} from "../test/fixtures-billing.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * A-5: the host's footer links (`TERMS_URL`, `PRIVACY_URL`, `SUPPORT_URL`, `STATUS_URL`) are for
 * the host's customers — admin, signup, setup, the operator console and the canonical host's
 * sign-in. Investors are the workspace's audience: the portal and a workspace host's sign-in
 * pages carry the accessibility statement only.
 */
vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

afterEach(() => vi.unstubAllGlobals());

const LINKS = {
  terms: "https://fundroom.test/terms",
  privacy: "https://fundroom.test/privacy",
  support: "mailto:help@fundroom.test",
  status: "https://status.fundroom.test/",
};

async function footerLinkNames(): Promise<string[]> {
  const footer = await screen.findByRole("navigation", { name: "Footer" }, { timeout: 5000 });
  return within(footer)
    .getAllByRole("link")
    .map((l) => l.textContent ?? "");
}

describe("footer links", () => {
  it("leaves the host's links out of the investor portal", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
    });
    await renderApp("/", testConfig({ links: LINKS }));
    expect(await footerLinkNames()).toEqual(["Accessibility"]);
  }, 20_000);

  it("shows them in the admin shell, in order, before the statement", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap()],
      "GET /api/v1/billing": () => [200, billingOverview()],
      "GET /api/v1/usage": () => [200, workspaceUsage()],
    });
    await renderApp("/admin/billing", testConfig({ billing: true, links: LINKS }));
    expect(await footerLinkNames()).toEqual([
      "Terms",
      "Privacy",
      "Support",
      "Status",
      "Accessibility",
    ]);
  }, 20_000);

  it("leaves them out of a workspace host's sign-in, and shows them on the canonical host's", async () => {
    installMockApi({ "GET /api/v1/me": () => apiError(401, "unauthenticated") });
    const workspace = await renderApp("/login", testConfig({ links: LINKS }));
    expect(await footerLinkNames()).toEqual(["Accessibility"]);
    workspace.unmount();

    installMockApi({ "GET /api/v1/me": () => apiError(401, "unauthenticated") });
    await renderApp("/login", testConfig({ workspace: null, links: LINKS }));
    expect(await footerLinkNames()).toEqual([
      "Terms",
      "Privacy",
      "Support",
      "Status",
      "Accessibility",
    ]);
  }, 20_000);
});
