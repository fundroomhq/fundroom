import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { billingNavigation } from "../lib/billing-queries.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { testConfig } from "../test/fixtures.js";
import {
  billingOverview,
  billingPlan,
  billingSubscription,
  staffBootstrap,
  staffMe,
  workspaceUsage,
} from "../test/fixtures-billing.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/billing` (E3.10, ADR-0058). The plan and its state, the public plans with checkout,
 * the provider's portal, the manual driver's "ask your host", usage against the plan's limits,
 * and the round trip back from checkout. Checkout and portal leave the SPA for the provider's
 * page, so `billingNavigation.assign` stands in for the top-level navigation.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const BILLING_CONFIG = testConfig({ billing: true });

function handlers(
  over: Record<string, Handler> = {},
  opts: Parameters<typeof staffBootstrap>[0] = {},
): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe(opts.role)],
    "GET /api/v1/modules": () => [200, staffBootstrap(opts)],
    "GET /api/v1/billing": () => [200, billingOverview()],
    "GET /api/v1/usage": () => [200, workspaceUsage()],
    ...over,
  });
}

async function openBilling(path = "/admin/billing", config = BILLING_CONFIG) {
  const r = await renderApp(path, config);
  expect(
    await screen.findByRole("heading", { name: "Billing", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("billing admin", () => {
  it("shows the plan, the plans on offer and usage against the limits", async () => {
    handlers();
    const r = await openBilling();
    expect(await screen.findByText("Your current plan", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Renews on")).toBeInTheDocument();
    // The current plan offers no checkout; the other one does, named for screen readers.
    expect(screen.queryByRole("button", { name: "Choose the Starter plan" })).toBeNull();
    expect(screen.getByRole("button", { name: "Choose the Growth plan" })).toBeInTheDocument();
    expect(screen.getByText("Starts with a 14-day free trial.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Manage billing/u })).toBeInTheDocument();

    const table = await screen.findByRole("table", { name: "Usage" }, { timeout: 5000 });
    const row = (label: string) =>
      within(table).getByRole("rowheader", { name: label }).closest("tr") as HTMLElement;
    expect(within(row("Team seats")).getByText("2")).toBeInTheDocument();
    expect(within(row("Team seats")).getByText("3")).toBeInTheDocument();
    // 61 investors on a 50-seat plan: said in words, not only in a colour.
    expect(within(row("Investor seats")).getByText("Over the limit")).toBeInTheDocument();
    // Emails are a monthly figure: September's rows only (5 + 3 + 7), August's 100 left out.
    expect(within(row("Emails this month")).getByText("15")).toBeInTheDocument();
    expect(within(row("Emails this month")).getByText("Unlimited")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("starts checkout for the chosen plan and sends the top window to the provider", async () => {
    const assign = vi.spyOn(billingNavigation, "assign").mockImplementation(() => {});
    const { calls } = handlers({
      "POST /api/v1/billing/checkout": () => [200, { url: "https://checkout.stripe.test/c/1" }],
    });
    await openBilling();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Choose the Growth plan" }, { timeout: 5000 }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.stripe.test/c/1"));
    expect(calls.find((c) => c.path === "/api/v1/billing/checkout")?.body).toEqual({
      planId: "growth",
    });
  }, 20_000);

  it("sends a stale session through step-up and back to billing", async () => {
    const assign = vi.spyOn(billingNavigation, "assign").mockImplementation(() => {});
    handlers({
      "POST /api/v1/billing/checkout": () => apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openBilling();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Choose the Growth plan" }, { timeout: 5000 }),
    );
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up?"));
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Fbilling");
    expect(assign).not.toHaveBeenCalled();
  }, 20_000);

  it("opens the provider's billing portal", async () => {
    const assign = vi.spyOn(billingNavigation, "assign").mockImplementation(() => {});
    handlers({
      "POST /api/v1/billing/portal": () => [200, { url: "https://billing.stripe.test/p/1" }],
    });
    await openBilling();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /Manage billing/u }, { timeout: 5000 }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://billing.stripe.test/p/1"));
  }, 20_000);

  it("points a manually billed workspace at its host, with nothing to press", async () => {
    handlers({
      "GET /api/v1/billing": () => [200, billingOverview({ driver: "manual" })],
    });
    const r = await openBilling();
    expect(
      await screen.findByText(/Billing for this workspace is handled by your host/u, undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Choose/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Manage billing/u })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("lets finance read billing but leaves the buttons to an owner", async () => {
    handlers(
      { "GET /api/v1/billing": () => [200, billingOverview({ canManage: false })] },
      { permissions: ["billing.read"], role: "finance" },
    );
    await openBilling();
    expect(
      await screen.findByText(/Only a workspace owner can change the plan/u, undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Choose/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Manage billing/u })).toBeNull();
  }, 20_000);

  it("counts down the grace period of an overdue payment, on the page and in the shell", async () => {
    const graceUntil = new Date(Date.now() + 2.5 * 86_400_000).toISOString();
    handlers({
      "GET /api/v1/billing": () => [
        200,
        billingOverview({
          subscription: billingSubscription({ status: "past_due", graceUntil }),
        }),
      ],
    });
    const r = await openBilling();
    expect(
      await screen.findByText(
        "Payment overdue",
        { selector: "[data-slot=badge]" },
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    // Once in the shell's strip, once on the page.
    await waitFor(() => expect(screen.getAllByText(/within 3 days/u)).toHaveLength(2));
    const strip = r.container.querySelector("[data-slot=app-shell-banner]") as HTMLElement;
    const link = within(strip).getByRole("link", { name: "Go to billing" });
    expect(link).toHaveClass("underline");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("reads an unfinished checkout as pending, with the deadline, and lets the owner finish it", async () => {
    const assign = vi.spyOn(billingNavigation, "assign").mockImplementation(() => {});
    const { calls } = handlers({
      "GET /api/v1/billing": () => [
        200,
        billingOverview({
          subscription: billingSubscription({
            status: "incomplete",
            currentPeriodEnd: null,
            graceUntil: "2026-10-11T00:00:00.000Z",
          }),
        }),
      ],
      "POST /api/v1/billing/checkout": () => [200, { url: "https://checkout.example/s/1" }],
    });
    const r = await openBilling();
    expect(await screen.findByText("Checkout pending", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("Checkout not finished")).toBeInTheDocument();
    expect(screen.getByText(/must be paid for by/u)).toBeInTheDocument();
    expect(screen.queryByText("Incomplete")).toBeNull();
    // Not the current plan yet: choosing it again is how the owner finishes paying.
    await userEvent.setup().click(screen.getByRole("button", { name: "Choose the Starter plan" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/s/1"));
    expect(calls.find((c) => c.path === "/api/v1/billing/checkout")?.body).toEqual({
      planId: "starter",
    });
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says when the plan ends instead of renewing", async () => {
    handlers({
      "GET /api/v1/billing": () => [
        200,
        billingOverview({ subscription: billingSubscription({ cancelAtPeriodEnd: true }) }),
      ],
    });
    await openBilling();
    expect(
      await screen.findByText("Your plan is set to end", undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("Ends on")).toBeInTheDocument();
  }, 20_000);

  it("welcomes the owner back from checkout, and from a cancelled one", async () => {
    handlers();
    await openBilling("/admin/billing?checkout=success");
    expect(
      await screen.findByText(/your plan is being set up/u, undefined, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  it("says nothing was charged after a cancelled checkout", async () => {
    handlers();
    await openBilling("/admin/billing?checkout=cancel");
    expect(
      await screen.findByText("Nothing was charged and your plan has not changed.", undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
  }, 20_000);

  // A-5 D3: signup lands a founder whose plan is paid with no trial on `?plan=<id>`.
  it("asks the founder to finish subscribing to the plan they signed up for, without leaving", async () => {
    const assign = vi.spyOn(billingNavigation, "assign").mockImplementation(() => {});
    const { calls } = handlers({
      "GET /api/v1/billing": () => [
        200,
        billingOverview({
          subscription: billingSubscription({
            planId: "growth",
            planName: "Growth",
            status: "incomplete",
            currentPeriodEnd: null,
          }),
        }),
      ],
      "POST /api/v1/billing/checkout": () => [200, { url: "https://checkout.example/s/2" }],
    });
    const r = await openBilling("/admin/billing?plan=growth");
    expect(
      await screen.findByText("Finish subscribing to Growth", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Never a redirect on arrival: the owner presses the button.
    expect(assign).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path === "/api/v1/billing/checkout")).toBe(false);
    await expectNoA11yViolations(r.container);
    await userEvent.setup().click(screen.getByRole("button", { name: "Subscribe to Growth" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://checkout.example/s/2"));
    expect(calls.find((c) => c.path === "/api/v1/billing/checkout")?.body).toEqual({
      planId: "growth",
    });
  }, 20_000);

  it("offers no callout for a plan that is current, not on offer, or not the viewer's to buy", async () => {
    handlers();
    // Starter is the active plan already.
    const first = await openBilling("/admin/billing?plan=starter");
    await screen.findByText("Your current plan", {}, { timeout: 5000 });
    expect(screen.queryByText(/Finish subscribing/u)).toBeNull();
    first.unmount();

    handlers();
    const second = await openBilling("/admin/billing?plan=enterprise");
    await screen.findByText("Your current plan", {}, { timeout: 5000 });
    expect(screen.queryByText(/Finish subscribing/u)).toBeNull();
    second.unmount();

    handlers(
      { "GET /api/v1/billing": () => [200, billingOverview({ canManage: false })] },
      { permissions: ["billing.read"], role: "finance" },
    );
    await openBilling("/admin/billing?plan=growth");
    await screen.findByText(/Only a workspace owner can change the plan/u, {}, { timeout: 5000 });
    expect(screen.queryByText(/Finish subscribing/u)).toBeNull();
  }, 30_000);

  // A-5: the signup session is level 1 (an email code); billing needs an owner at level 2.
  it("sends a founder with no second factor to add one, and back to this plan afterwards", async () => {
    const levelOne = staffMe();
    levelOne.session.authLevel = 1;
    levelOne.session.user.mfaEnrolled = false;
    handlers({
      "GET /api/v1/me": () => [200, levelOne],
      "GET /api/v1/billing": () => apiError(403, "step_up_required", { reason: "level" }),
      "GET /api/v1/usage": () => apiError(403, "step_up_required", { reason: "level" }),
    });
    const r = await openBilling("/admin/billing?plan=growth");
    expect(
      await screen.findByText("Secure your account first", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Add a passkey or authenticator app" });
    const target = new URL(link.getAttribute("href") ?? "", "https://x.test");
    expect(target.pathname).toBe("/setup");
    expect(target.searchParams.get("step")).toBe("secure");
    expect(target.searchParams.get("returnTo")).toBe("/admin/billing?plan=growth");
    // One explanation, not an error card per read.
    expect(screen.queryByRole("alert")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("sends a founder who has a factor to confirm it via the security step, back to this plan", async () => {
    const levelOne = staffMe();
    levelOne.session.authLevel = 1;
    handlers({
      "GET /api/v1/me": () => [200, levelOne],
      "GET /api/v1/billing": () => apiError(403, "step_up_required", { reason: "level" }),
    });
    await openBilling("/admin/billing?plan=growth");
    const link = await screen.findByRole("link", { name: "Confirm it's you" }, { timeout: 5000 });
    const target = new URL(link.getAttribute("href") ?? "", "https://x.test");
    // The wizard's security step handles every case of getting to level 2 (round 3).
    expect(target.pathname).toBe("/setup");
    expect(target.searchParams.get("step")).toBe("secure");
    expect(target.searchParams.get("returnTo")).toBe("/admin/billing?plan=growth");
  }, 20_000);

  // H2: the shell's `/me` can predate a factor added a moment ago; the card reads it afresh.
  it("reads whether the founder has a factor afresh before choosing the way on", async () => {
    let calls = 0;
    handlers({
      "GET /api/v1/me": () => {
        calls += 1;
        const who = staffMe();
        who.session.authLevel = 1;
        // The shell's read is from before enrolment; every later one is after it.
        who.session.user.mfaEnrolled = calls > 1;
        return [200, who];
      },
      "GET /api/v1/billing": () => apiError(403, "step_up_required", { reason: "level" }),
    });
    await openBilling("/admin/billing?plan=growth");
    expect(
      await screen.findByRole("link", { name: "Confirm it's you" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Add a passkey or authenticator app" })).toBeNull();
  }, 20_000);

  it("sends a signed-out founder to sign in and back to the plan", async () => {
    handlers({ "GET /api/v1/me": () => apiError(401, "unauthenticated") });
    const r = await renderApp("/admin/billing?plan=growth", BILLING_CONFIG);
    await waitFor(() =>
      expect(pathOf(r.router)).toBe(
        `/login?returnTo=${encodeURIComponent("/admin/billing?plan=growth")}`,
      ),
    );
  }, 20_000);

  it("still reads the checkout return beside the plan callout", async () => {
    handlers();
    await openBilling("/admin/billing?plan=growth&checkout=cancel");
    expect(
      await screen.findByText("Nothing was charged and your plan has not changed.", undefined, {
        timeout: 5000,
      }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Finish subscribing to Growth")).toBeInTheDocument();
  }, 20_000);

  it("is not there on an install that does not bill, and never asks the API", async () => {
    const { calls } = handlers();
    await renderApp("/admin/billing", testConfig({ billing: false }));
    expect(
      await screen.findByRole(
        "heading",
        { name: /not found|doesn't exist|Nothing here/iu },
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/api/v1/billing"))).toBe(false);
    expect(calls.some((c) => c.path === "/api/v1/usage")).toBe(false);
  }, 20_000);

  it("lists billing in the settings hub only where the viewer may open it", async () => {
    handlers();
    await renderApp("/admin/settings", BILLING_CONFIG);
    expect(
      await screen.findByRole("link", { name: "Billing" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  it("hides the billing settings entry without billing.read or without billing", async () => {
    handlers({}, { permissions: [], role: "admin" });
    const r = await renderApp("/admin/settings", BILLING_CONFIG);
    expect(
      await screen.findByRole("link", { name: "Branding" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Billing" })).toBeNull();
    r.unmount();

    handlers();
    await renderApp("/admin/settings", testConfig({ billing: false }));
    expect(
      await screen.findByRole("link", { name: "Branding" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Billing" })).toBeNull();
  }, 20_000);

  // A-3 (ADR-0063): a plan also names the optional modules and the features it includes.
  it("lists each plan's modules and features, and the modules read-only on the current plan", async () => {
    const starterLimits = {
      ...billingPlan().limits,
      modules: ["data-room", "updates"],
      features: ["sso", "qa"] as ("sso" | "qa")[],
    };
    handlers(
      {
        "GET /api/v1/billing": () => [
          200,
          billingOverview({
            plans: [
              billingPlan({ limits: starterLimits }),
              billingPlan({ id: "growth", name: "Growth", limits: {}, trialDays: 0 }),
              billingPlan({
                id: "lite",
                name: "Lite",
                limits: { modules: [], features: [] },
                trialDays: 0,
              }),
            ],
          }),
        ],
        "GET /api/v1/usage": () => [
          200,
          workspaceUsage({ plan: { id: "starter", name: "Starter", limits: starterLimits } }),
        ],
      },
      {
        modules: [
          {
            id: "metrics",
            version: "0.1.0",
            enabled: true,
            hidden: false,
            readOnly: true,
            flags: {},
            slots: {},
          },
        ],
      },
    );
    const r = await openBilling();
    // The plan cards are the list items (the current plan's name also heads the overview card).
    const card = async (name: string) =>
      (await screen.findAllByText(name, { selector: "[data-slot=card-title]" }, { timeout: 5000 }))
        .map((title) => title.closest("li"))
        .find((li) => li !== null) as HTMLElement;
    const starter = await card("Starter");
    expect(within(starter).getByText("data-room and updates")).toBeInTheDocument();
    // Features in the product's display order, by name.
    expect(within(starter).getByText("Data-room Q&A and Single sign-on")).toBeInTheDocument();
    const growth = await card("Growth");
    expect(within(growth).getByText("All modules")).toBeInTheDocument();
    expect(within(growth).getByText("All features")).toBeInTheDocument();
    const lite = await card("Lite");
    // No optional modules still means the core ones (R3 L4); no features is none.
    expect(within(lite).getByText("Core modules only")).toBeInTheDocument();
    expect(within(lite).getByText("None")).toBeInTheDocument();

    // The usage card: the current plan's lists, and what is on but outside them.
    const table = await screen.findByRole("table", { name: "Usage" }, { timeout: 5000 });
    const usage = table.closest("[data-slot=card]") as HTMLElement;
    const term = (label: string) =>
      within(usage).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement;
    expect(term("Modules")).toHaveTextContent("data-room and updates");
    expect(term("Features")).toHaveTextContent("Data-room Q&A and Single sign-on");
    expect(term("Read-only on your plan")).toHaveTextContent(/^metrics/u);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("names no read-only modules when every enabled module is on the plan", async () => {
    handlers();
    await openBilling();
    await screen.findByRole("table", { name: "Usage" }, { timeout: 5000 });
    expect(screen.queryByText("Read-only on your plan")).toBeNull();
    // No lists on the plan: everything.
    expect(screen.getAllByText("All modules").length).toBeGreaterThan(0);
  }, 20_000);
});
