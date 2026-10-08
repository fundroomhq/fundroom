import { FundRoomApiError } from "@fundroom/sdk";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError } from "../lib/api.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, testConfig } from "../test/fixtures.js";
import {
  billingOverview,
  staffBootstrap,
  staffMe,
  workspaceUsage,
} from "../test/fixtures-billing.js";
import { installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * A workspace that is not simply active (E3.10, ADR-0058 §5.1): suspended (billing, operator,
 * sanctions) or held for review. The server refuses everything but sign-in, the bootstrap and
 * billing, so the admin shell shrinks to billing for those who may open it and explains itself
 * to everyone else; investors get one "portal unavailable" screen whatever the reason.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const BILLING_CONFIG = testConfig({ billing: true });

describe("suspended or held workspace — admin", () => {
  it("gives an owner the reason and the way to billing, and nothing else", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap({ workspaceStatus: { status: "suspended", reason: "billing" } }),
      ],
    });
    const r = await renderApp("/admin/settings", BILLING_CONFIG);
    expect(
      await screen.findByRole(
        "heading",
        { name: "This workspace is unavailable" },
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    const strip = r.container.querySelector("[data-slot=app-shell-banner]") as HTMLElement;
    expect(strip).toHaveTextContent(/suspended because a payment is overdue/u);
    expect(within(strip).getByRole("link", { name: "Go to billing" })).toHaveClass("underline");
    // The nav is billing alone: every other admin API answers 423 now.
    const nav = screen.getByRole("navigation", { name: /admin/iu });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Billing"]);
    // The settings hub (which would 423) never rendered.
    expect(screen.queryByRole("link", { name: "Branding" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Go to billing" }).length).toBeGreaterThan(0);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("still serves the billing page itself to an owner", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap({ workspaceStatus: { status: "suspended", reason: "billing" } }),
      ],
      "GET /api/v1/billing": () => [200, billingOverview()],
      "GET /api/v1/usage": () => [200, workspaceUsage()],
    });
    const r = await renderApp("/admin/billing", BILLING_CONFIG);
    expect(
      await screen.findByRole("heading", { name: "Billing", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Your current plan", {}, { timeout: 5000 })).toBeInTheDocument();
    // Already there: the strip explains, without a link to the page it is on.
    const strip = r.container.querySelector("[data-slot=app-shell-banner]") as HTMLElement;
    expect(within(strip).queryByRole("link")).toBeNull();
    expect(screen.queryByText("This workspace is unavailable")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("tells staff without billing access only that the workspace is unavailable", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, staffMe("admin")],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap({
          permissions: [],
          role: "admin",
          workspaceStatus: { status: "suspended", reason: "operator" },
        }),
      ],
    });
    const r = await renderApp("/admin/billing", BILLING_CONFIG);
    expect(
      await screen.findByRole(
        "heading",
        { name: "This workspace is unavailable" },
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Your host has suspended this workspace/u).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByRole("link", { name: "Go to billing" })).toBeNull();
    expect(calls.some((c) => c.path === "/api/v1/billing")).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains a hold for review", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap({ workspaceStatus: { status: "pending_review", reason: null } }),
      ],
    });
    await renderApp("/admin", BILLING_CONFIG);
    expect(
      await screen.findByRole(
        "heading",
        { name: "This workspace is unavailable" },
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    // A-5 D7: hosted copy that is true of the guard — billing (and sign-in) still open, nothing
    // lost — and never names what the check is.
    expect(screen.getAllByText(/standard check on new workspaces/u).length).toBe(2);
    // On the banner and the panel alike, with the way to billing beside it.
    expect(screen.getAllByText(/set up billing in the meantime/u).length).toBe(2);
    expect(screen.queryByText(/sanction/iu)).toBeNull();
    // Nothing reopens by itself on screen: "once", not "as soon as".
    expect(screen.getAllByText(/opens once the check is done/u).length).toBe(2);
  }, 20_000);

  it("does not offer billing during the check to someone who cannot open it", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap({ workspaceStatus: { status: "pending_review", reason: null } }),
      ],
    });
    await renderApp("/admin", testConfig({ billing: false }));
    expect(
      (await screen.findAllByText(/standard check on new workspaces/u, {}, { timeout: 5000 }))
        .length,
    ).toBe(2);
    expect(screen.queryByText(/set up billing in the meantime/u)).toBeNull();
  }, 20_000);

  it("offers no billing link where the install does not bill", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap({ workspaceStatus: { status: "suspended", reason: "operator" } }),
      ],
    });
    await renderApp("/admin", testConfig({ billing: false }));
    expect(
      await screen.findByRole(
        "heading",
        { name: "This workspace is unavailable" },
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Go to billing" })).toBeNull();
  }, 20_000);
});

describe("suspended or held workspace — portal", () => {
  it("shows investors one 'portal unavailable' screen, whatever the reason", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [
        200,
        bootstrap({ workspaceStatus: { status: "suspended", reason: null } }),
      ],
    });
    const r = await renderApp("/");
    expect(
      await screen.findByRole(
        "heading",
        { name: "This portal is unavailable" },
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Go to admin" })).toBeNull();
    // No reason, no billing: investors are not told why.
    expect(screen.queryByText(/payment|billing|review/iu)).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("points staff who open the portal at the admin side", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [
        200,
        staffBootstrap({ workspaceStatus: { status: "suspended", reason: "billing" } }),
      ],
    });
    await renderApp("/");
    expect(
      await screen.findByRole("link", { name: "Go to admin" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);
});

describe("E3.10 error sentences", () => {
  const failure = (status: number, error: Record<string, unknown>) =>
    new FundRoomApiError(status, { error: { message: "x", ...error } as never }, undefined);

  it("names the plan limit that was hit and how much the plan allows", () => {
    // `details` are spread into the envelope beside the code…
    const many = describeError(failure(402, { code: "plan_limit", limit: "staffSeats", max: 3 }));
    expect(many.title).toBe("Your plan's limit is reached");
    expect(many.body).toMatch(/allows 3 team seats, and they are all taken/u);
    // …or nested under `details`; either is read, and one is singular.
    const one = describeError(
      failure(402, { code: "plan_limit", details: { limit: "customDomains", max: 1 } }),
    );
    expect(one.body).toMatch(/allows 1 custom domain, and it is in use/u);
    expect(describeError(failure(402, { code: "plan_limit" })).body).toMatch(/An owner can/u);
  });

  // A-3 (ADR-0063): a plan can leave out a module or a feature — "not on your plan".
  it("names the module or feature the plan does not include", () => {
    const mod = describeError(
      failure(402, { code: "plan_limit", limit: "module", module: "metrics" }),
    );
    // The title names it too: most module pages toast only the title (R3 L7).
    expect(mod.title).toBe("Not on your plan: metrics");
    expect(mod.body).toBe("Your plan doesn't include the metrics module.");
    const feature = describeError(
      failure(402, { code: "plan_limit", details: { limit: "feature", feature: "sso" } }),
    );
    expect(feature.title).toBe("Not on your plan: Single sign-on");
    expect(feature.body).toBe("Your plan doesn't include Single sign-on.");
    // An id this build does not know falls back to the general title and sentence.
    expect(
      describeError(failure(402, { code: "plan_limit", limit: "feature", feature: "teleport" }))
        .title,
    ).toBe("Not on your plan");
    expect(
      describeError(failure(402, { code: "plan_limit", limit: "feature", feature: "teleport" }))
        .body,
    ).toBe("Your plan doesn't include this.");
    // No quota wording, no "Billing": the alert adds who changes the plan (RR3 RL2).
  });

  it("has a sentence for an unavailable workspace, manual billing and a taken address", () => {
    expect(describeError(failure(423, { code: "workspace_unavailable" })).title).toBe(
      "This workspace is unavailable",
    );
    expect(describeError(failure(409, { code: "billing_manual" })).title).toBe(
      "Billing is handled by your host",
    );
    expect(describeError(failure(409, { code: "slug_taken" })).title).toBe("That address is taken");
  });
});
