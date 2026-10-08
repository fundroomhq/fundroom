import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, testConfig } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

vi.mock("../modules/registry.js", () => ({
  investorModules: {
    updates: () =>
      Promise.resolve({
        default: ({ splat }: { splat: string }) => <h1>Updates module: {splat || "index"}</h1>,
      }),
  },
  adminModules: {},
}));

afterEach(() => vi.unstubAllGlobals());

describe("portal layout", () => {
  it("redirects a signed-out visitor to login with returnTo", async () => {
    installMockApi({ "GET /api/v1/me": () => apiError(401, "unauthenticated") });
    const r = await renderApp("/settings/security");
    await waitFor(() => expect(pathOf(r.router)).toBe("/login?returnTo=%2Fsettings%2Fsecurity"));
  });

  it("shows the no-access screen without revealing anything else", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me({ membership: null, workspaces: [] })],
      "GET /api/v1/modules": () => [
        200,
        bootstrap({ membership: null, permissions: [], modules: [] }),
      ],
    });
    const r = await renderApp("/");
    expect(await screen.findByText(/You don't have access here/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sign out/u })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    await expectNoA11yViolations(r.container);
  });

  it("builds the nav from investor.nav slots of enabled modules", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
    });
    const r = await renderApp("/");
    const nav = await screen.findByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: /Updates/u })).toHaveAttribute("href", "/updates");
    expect(within(nav).queryByRole("link", { name: /Data room/u })).toBeNull();
    expect(within(nav).getByRole("link", { name: /Home/u })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("heading", { name: /Welcome, Ada Lovelace/u })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  });

  it("signs out from the account menu", async () => {
    let signedIn = true;
    const { calls } = installMockApi({
      "GET /api/v1/me": () => (signedIn ? [200, me()] : apiError(401, "unauthenticated")),
      "GET /api/v1/modules": () => [200, bootstrap()],
      "POST /api/v1/auth/logout": () => {
        signedIn = false;
        return [200, { ok: true }];
      },
    });
    const r = await renderApp("/");
    // Anything the signed-in user had cached must be gone after sign-out, not merely stale (F-25).
    r.queryClient.setQueryData(["signed-in-sentinel"], { secret: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Account" }));
    await user.click(await screen.findByRole("menuitem", { name: /Sign out/u }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/auth/logout"))).toBe(true));
    await waitFor(() => expect(pathOf(r.router)).toContain("/login"));
    expect(r.queryClient.getQueryData(["signed-in-sentinel"])).toBeUndefined();
  });
});

describe("module catch-all", () => {
  const handlers = {
    "GET /api/v1/me": () => [200, me()] as [number, unknown],
    "GET /api/v1/modules": () => [200, bootstrap()] as [number, unknown],
  };
  it("renders a registered module bundle with the rest of the path", async () => {
    installMockApi(handlers);
    await renderApp("/updates/2026-q2");
    expect(
      await screen.findByRole("heading", { name: "Updates module: 2026-q2" }),
    ).toBeInTheDocument();
  });
  it("explains when a module is enabled but has no client bundle", async () => {
    installMockApi({
      ...handlers,
      "GET /api/v1/modules": () => [
        200,
        bootstrap({
          modules: [
            {
              id: "metrics",
              version: "1.0.0",
              enabled: true,
              hidden: false,
              readOnly: false,
              flags: {},
              slots: {},
            },
          ],
        }),
      ],
    });
    // `/kpis` is the metrics module's investor path (E-UP-18 D3), not its id.
    await renderApp("/kpis");
    expect(await screen.findByText(/Not available in this build/u)).toBeInTheDocument();
  });
  it("shows not-found for disabled or unknown modules", async () => {
    installMockApi(handlers);
    await renderApp("/data-room");
    expect(await screen.findByText(/Page not found/u)).toBeInTheDocument();
  });
});

describe("admin gate", () => {
  it("shows the not-found screen to non-staff", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
    });
    await renderApp("/admin");
    expect(await screen.findByText(/Page not found/u)).toBeInTheDocument();
    expect(screen.queryByText(/Overview/u)).toBeNull();
  });
  it("renders the overview for staff with admin.nav items", async () => {
    installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({ membership: { id: "x", kind: "staff", role: "owner", status: "active" } }),
      ],
      "GET /api/v1/modules": () => [
        200,
        bootstrap({
          membership: { id: "x", kind: "staff", role: "owner" },
          permissions: ["a", "b"],
        }),
      ],
    });
    const r = await renderApp("/admin", testConfig({ tree: "admin" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Admin" });
    expect(within(nav).getByRole("link", { name: /Updates/u })).toHaveAttribute(
      "href",
      "/admin/updates",
    );
    expect(screen.getByText("acme")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  });
});

describe("setup required", () => {
  it("renders the setup screen instead of routes", async () => {
    installMockApi({});
    await renderApp("/", testConfig({ setupRequired: true, workspace: null, basePath: "/p" }));
    expect(await screen.findByText(/Setup required/u)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open setup/u })).toHaveAttribute("href", "/p/setup");
  });
});
