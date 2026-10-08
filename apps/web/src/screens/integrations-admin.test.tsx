import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oauthNavigation } from "../lib/integrations-queries.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  bookingLink,
  cfoLink,
  GROUP_BOARD_ID,
  groupList,
  integrationBooking,
  integrationConnection,
  integrationProviders,
  LINK_CEO_ID,
  LINK_CFO_ID,
  START_URL,
  WEBHOOK_SECRET,
  XERO_ORG_A,
  XERO_ORG_B,
} from "../test/fixtures-integrations.js";
import { apiError, type Handler, installMockApi, withPlanEntitlements } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/integrations` (E3.6). What the screen owes the admin:
 *
 *  - every provider the deployment knows, with its health (not connected / active / degraded /
 *    reconnect needed) or "not configured by your operator" and where the operator reads up;
 *  - OAuth connects by a top-level navigation to the server's single-use start URL, and the
 *    callback's `?integration=&result=&reason=` becomes an alert, then leaves the address bar;
 *  - secret providers get a generated form; a Stripe secret key is refused before it is sent;
 *  - the Cal.com webhook secret is shown once, with the URL and where to paste them;
 *  - Xero's organisation chooser, verify, rotate, and a typed-confirmed disconnect;
 *  - booking links (audience all / groups, enable, reorder, delete) and the bookings register;
 *  - readers see everything and change nothing; without `integrations.read` no nav, no page.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const ALL = ["integrations.read", "integrations.manage", "access.read"];

function handlers(over: Record<string, Handler> = {}, permissions: string[] = ALL) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        modules: [],
        permissions,
        membership: { id: OWNER_ID, kind: "staff", role: "owner" },
      }),
    ],
    "GET /api/v1/integrations/providers": () => [200, integrationProviders()],
    "GET /api/v1/integrations/connections": () => [200, { connections: [] }],
    "GET /api/v1/integrations/booking-links": () => [200, { links: [] }],
    "GET /api/v1/integrations/bookings": () => [200, { items: [], nextCursor: null }],
    "GET /api/v1/access/groups": () => [200, groupList()],
    ...over,
  });
}

const connections =
  (...list: ReturnType<typeof integrationConnection>[]): Handler =>
  () => [200, { connections: list }];

async function openScreen(path = "/admin/integrations") {
  const r = await renderApp(path);
  expect(
    await screen.findByRole("heading", { name: "Integrations", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

/** The provider's card: the `<li>` around its heading. */
async function card(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name, level: 3 }, { timeout: 5000 });
  return heading.closest("li") as HTMLElement;
}

function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("integrations admin: providers", () => {
  it("lists every provider, not connected, and says which the operator has not configured", async () => {
    handlers();
    const r = await openScreen();
    const qbo = await card("QuickBooks Online");
    expect(within(qbo).getByText("Not connected")).toBeInTheDocument();
    expect(within(qbo).getByText("KPI source")).toBeInTheDocument();
    expect(within(qbo).getByText("Never writes to your books.")).toBeVisible();
    expect(within(qbo).getByText(/Feeds KPIs: Revenue, Expenses, Net income, Cash/u)).toBeVisible();
    expect(
      within(qbo).getByRole("link", { name: "Intuit data processing agreement" }),
    ).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(qbo).getByRole("button", { name: "Connect QuickBooks Online" })).toBeEnabled();

    const slack = await card("Slack");
    expect(within(slack).getByText("Not configured")).toBeInTheDocument();
    expect(within(slack).getByText(/Not configured by your operator/u)).toBeVisible();
    const docs = within(slack).getByRole("link", { name: /How an operator sets this up/u });
    expect(docs).toHaveAttribute("href", expect.stringContaining("docs/integrations"));
    expect(docs).toHaveAttribute("target", "_blank");
    expect(within(slack).queryByRole("button", { name: /Connect/u })).toBeNull();
    // The nav carries the hub.
    expect(screen.getByRole("link", { name: "Integrations" })).toHaveAttribute(
      "href",
      "/admin/integrations",
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("connects an OAuth provider by navigating the window to the server's start URL", async () => {
    const assign = vi.spyOn(oauthNavigation, "assign").mockImplementation(() => {});
    const { calls } = handlers({
      "POST /api/v1/integrations/{provider}/oauth/begin": () => [
        200,
        { startUrl: START_URL, expiresAt: "2026-09-26T10:02:00.000Z" },
      ],
    });
    await openScreen();
    const user = userEvent.setup();
    const qbo = await card("QuickBooks Online");
    await user.click(within(qbo).getByRole("button", { name: "Connect QuickBooks Online" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(START_URL));
    const begin = calls.find((c) => c.path.endsWith("/oauth/begin"));
    expect(begin?.path).toBe("/api/v1/integrations/quickbooks/oauth/begin");
    expect(begin?.body).toEqual({ returnPath: "/admin/integrations" });
  }, 20_000);

  it("says so when the operator's OAuth app went away between load and click", async () => {
    const assign = vi.spyOn(oauthNavigation, "assign").mockImplementation(() => {});
    handlers({
      "POST /api/v1/integrations/{provider}/oauth/begin": () =>
        apiError(409, "integration_not_available"),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(within(await card("Xero")).getByRole("button", { name: "Connect Xero" }));
    expect(
      await screen.findByText("The operator has not set this provider up on this deployment."),
    ).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  }, 20_000);

  it("refuses a Stripe secret key before sending it, then connects with a restricted key", async () => {
    let connected = false;
    const { calls } = handlers({
      "GET /api/v1/integrations/connections": () => [
        200,
        { connections: connected ? [integrationConnection("stripe")] : [] },
      ],
      "POST /api/v1/integrations/{provider}/connect": () => {
        connected = true;
        return [200, { connection: integrationConnection("stripe") }];
      },
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const stripe = await card("Stripe");
    await user.click(within(stripe).getByRole("button", { name: "Connect Stripe" }));
    const key = within(stripe).getByLabelText(/Restricted API key/u);
    expect(key).toHaveAttribute("type", "password");
    await user.type(key, "sk_live_123");
    expect(within(stripe).getByText(/That is a secret key/u)).toBeVisible();
    expect(key).toHaveAttribute("aria-invalid", "true");
    const submit = within(stripe).getByRole("button", { name: "Verify and connect" });
    expect(submit).toBeDisabled();
    await expectNoA11yViolations(r.container);
    await user.clear(key);
    await user.type(key, "  rk_live_abc  ");
    await user.click(submit);
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/stripe/connect"))?.body).toEqual({
        credentials: { restrictedKey: "rk_live_abc" },
      }),
    );
    expect(calls.some((c) => JSON.stringify(c.body ?? "").includes("sk_live"))).toBe(false);
    expect(await within(stripe).findByText("Connected")).toBeInTheDocument();
  }, 20_000);

  it("names why the provider refused the key", async () => {
    handlers({
      "POST /api/v1/integrations/{provider}/connect": () =>
        apiError(422, "integration_credentials_rejected", { reason: "forbidden" }),
    });
    await openScreen();
    const user = userEvent.setup();
    const stripe = await card("Stripe");
    await user.click(within(stripe).getByRole("button", { name: "Connect Stripe" }));
    await user.type(within(stripe).getByLabelText(/Restricted API key/u), "rk_test_1");
    await user.click(within(stripe).getByRole("button", { name: "Verify and connect" }));
    const alert = await within(stripe).findByRole("alert");
    expect(within(alert).getByText("Could not connect")).toBeVisible();
    expect(within(alert).getByText(/lacks a permission we need/u)).toBeVisible();
  }, 20_000);

  it("connects Cal.com and shows the webhook secret once, with the URL and where to paste it", async () => {
    let connected = false;
    const calcom = integrationConnection("calcom");
    handlers({
      "GET /api/v1/integrations/connections": () => [
        200,
        { connections: connected ? [calcom] : [] },
      ],
      "POST /api/v1/integrations/{provider}/connect": () => {
        connected = true;
        return [200, { connection: calcom, webhookSecret: WEBHOOK_SECRET }];
      },
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const card1 = await card("Cal.com");
    await user.click(within(card1).getByRole("button", { name: "Connect Cal.com" }));
    expect(within(card1).getByText(/Cal.com needs no key/u)).toBeVisible();
    await user.click(within(card1).getByRole("button", { name: "Connect Cal.com" }));
    expect(
      await screen.findByText("Here is the webhook secret for Cal.com — copy it now"),
    ).toBeInTheDocument();
    expect(screen.getByText(WEBHOOK_SECRET)).toBeInTheDocument();
    expect(screen.getByText(/Settings → Developer → Webhooks/u)).toBeVisible();
    expect(screen.getAllByText(calcom.webhookUrl as string).length).toBeGreaterThan(0);
    // Never cached: only component state holds it.
    expect(
      JSON.stringify(
        r.queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(WEBHOOK_SECRET);
    const writeText = stubClipboard();
    await user.click(screen.getByRole("button", { name: "Copy webhook secret" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(WEBHOOK_SECRET));
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(screen.queryByText(WEBHOOK_SECRET)).toBeNull();
  }, 20_000);

  it("shows an active connection's account and health, verifies it and disconnects after typing", async () => {
    const { calls } = handlers({
      "GET /api/v1/integrations/connections": connections(integrationConnection("quickbooks")),
      "POST /api/v1/integrations/{provider}/verify": () => [
        200,
        integrationConnection("quickbooks"),
      ],
      "DELETE /api/v1/integrations/{provider}": () => [200, { ok: true }],
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const qbo = await card("QuickBooks Online");
    expect(await within(qbo).findByText("Connected")).toBeInTheDocument();
    expect(within(qbo).getByText("Acme Ltd (realm 1234)")).toBeVisible();
    expect(within(qbo).getByText("Last successful call")).toBeVisible();
    expect(within(qbo).queryByText("Last failure")).toBeNull();
    await expectNoA11yViolations(r.container);
    await user.click(within(qbo).getByRole("button", { name: "Verify now" }));
    expect(await screen.findByText("Connection works.")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/integrations/quickbooks/verify")).toBe(true);

    await user.click(within(qbo).getByRole("button", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect QuickBooks Online?" });
    expect(within(dialog).getByText(/KPIs bound to QuickBooks Online stop syncing/u)).toBeVisible();
    const confirm = within(dialog).getByRole("button", { name: "Disconnect" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Type quickbooks to confirm"), "quickbooks");
    await user.click(confirm);
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/integrations/quickbooks"),
      ).toBe(true),
    );
  }, 20_000);

  it("warns about a degraded connection and names the last failure", async () => {
    handlers({
      "GET /api/v1/integrations/connections": connections(
        integrationConnection("stripe", {
          status: "degraded",
          consecutiveFailures: 4,
          lastFailureAt: "2026-09-25T05:15:00.000Z",
          lastError: "rate_limited",
        }),
      ),
    });
    const r = await openScreen();
    const stripe = await card("Stripe");
    expect(await within(stripe).findByText("Degraded")).toBeInTheDocument();
    expect(within(stripe).getByText("Having trouble reaching the provider")).toBeVisible();
    expect(within(stripe).getByText(/The last 4 calls to the provider failed/u)).toBeVisible();
    expect(within(stripe).getByText("rate_limited")).toBeVisible();
    expect(within(stripe).getByRole("button", { name: "Replace key" })).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("asks to reconnect when the provider refused the token, and reconnects through OAuth", async () => {
    const assign = vi.spyOn(oauthNavigation, "assign").mockImplementation(() => {});
    const { calls } = handlers({
      "GET /api/v1/integrations/connections": connections(
        integrationConnection("quickbooks", { status: "reauth_required" }),
      ),
      "POST /api/v1/integrations/{provider}/oauth/begin": () => [
        200,
        { startUrl: START_URL, expiresAt: "2026-09-26T10:02:00.000Z" },
      ],
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const qbo = await card("QuickBooks Online");
    expect(await within(qbo).findByText("Reconnect needed", { selector: "span" })).toBeVisible();
    const alert = within(qbo).getByRole("alert");
    expect(within(alert).getByText(/no longer accepts our access/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
    await user.click(within(qbo).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(START_URL));
    expect(calls.some((c) => c.path === "/api/v1/integrations/quickbooks/oauth/begin")).toBe(true);
  }, 20_000);

  it("lets the admin choose which Xero organisation feeds the KPIs", async () => {
    const { calls } = handlers({
      "GET /api/v1/integrations/connections": connections(
        integrationConnection("xero", {
          accountLabel: null,
          externalAccountId: null,
          availableAccounts: [
            { id: XERO_ORG_A, name: "Acme Ltd" },
            { id: XERO_ORG_B, name: "Acme Holdings" },
          ],
        }),
      ),
      "PUT /api/v1/integrations/{provider}/account": () => [
        200,
        integrationConnection("xero", { externalAccountId: XERO_ORG_B }),
      ],
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const xero = await card("Xero");
    const group = await within(xero).findByRole("group", { name: "Organisation used for KPIs" });
    expect(within(group).getByText(/covers several organisations/u)).toBeVisible();
    const use = within(xero).getByRole("button", { name: "Use this organisation" });
    expect(use).toBeDisabled();
    await expectNoA11yViolations(r.container);
    await user.click(within(group).getByRole("radio", { name: "Acme Holdings" }));
    await user.click(use);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")).toMatchObject({
        path: "/api/v1/integrations/xero/account",
        body: { externalAccountId: XERO_ORG_B },
      }),
    );
    expect(await screen.findByText("Organisation saved.")).toBeInTheDocument();
  }, 20_000);

  it("rotates the Cal.com webhook secret and shows the new one once", async () => {
    const calcom = integrationConnection("calcom");
    handlers({
      "GET /api/v1/integrations/connections": connections(calcom),
      "POST /api/v1/integrations/{provider}/rotate-webhook-secret": () => [
        200,
        { connection: calcom, webhookSecret: WEBHOOK_SECRET },
      ],
    });
    await openScreen();
    const user = userEvent.setup();
    const card1 = await card("Cal.com");
    expect(within(card1).getByText(calcom.webhookUrl as string)).toBeVisible();
    expect(within(card1).getByText(/Paste this address into Cal.com/u)).toBeVisible();
    await user.click(within(card1).getByRole("button", { name: "Rotate webhook secret" }));
    const dialog = await screen.findByRole("dialog", { name: "Rotate the webhook secret?" });
    await user.click(within(dialog).getByRole("button", { name: "Rotate webhook secret" }));
    expect(
      await screen.findByText("Here is the new webhook secret for Cal.com — copy it now"),
    ).toBeInTheDocument();
    expect(screen.getByText(WEBHOOK_SECRET)).toBeInTheDocument();
  }, 20_000);

  it("Calendly's webhook is registered for it: no secret to paste after a rotation", async () => {
    const calendly = integrationConnection("calendly");
    handlers({
      "GET /api/v1/integrations/connections": connections(calendly),
      "POST /api/v1/integrations/{provider}/rotate-webhook-secret": () => [
        200,
        { connection: calendly, webhookSecret: WEBHOOK_SECRET },
      ],
    });
    await openScreen();
    const user = userEvent.setup();
    const card1 = await card("Calendly");
    expect(within(card1).getByText(/Registered with Calendly for you/u)).toBeVisible();
    await user.click(within(card1).getByRole("button", { name: "Rotate webhook secret" }));
    const dialog = await screen.findByRole("dialog", { name: "Rotate the webhook secret?" });
    expect(within(dialog).getByText(/registered with Calendly for you/u)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Rotate webhook secret" }));
    expect((await screen.findAllByText("Webhook secret rotated.")).length).toBeGreaterThan(0);
    expect(screen.queryByText(WEBHOOK_SECRET)).toBeNull();
  }, 20_000);
});

const TOKEN = "cGVuZGluZy10b2tlbi0zMi1ieXRlcy1sb25nLW9rYXk";
const PENDING_KEY = "seed-host.integrations.pending";

describe("integrations admin: webhook secret rotation refusals", () => {
  async function rotateCalendly(error: Response, status: "active" | "degraded" = "active") {
    let rotated = false;
    const { calls } = handlers({
      "GET /api/v1/integrations/connections": () => [
        200,
        {
          connections: [integrationConnection("calendly", rotated ? { status } : {})],
        },
      ],
      "POST /api/v1/integrations/{provider}/rotate-webhook-secret": () => {
        rotated = true;
        return error;
      },
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const card1 = await card("Calendly");
    await user.click(within(card1).getByRole("button", { name: "Rotate webhook secret" }));
    const dialog = await screen.findByRole("dialog", { name: "Rotate the webhook secret?" });
    await user.click(within(dialog).getByRole("button", { name: "Rotate webhook secret" }));
    const alert = await within(card1).findByRole("alert");
    return { r, card: card1, alert, calls };
  }

  it("says a rotation is already in progress", async () => {
    const { r, alert } = await rotateCalendly(
      apiError(409, "conflict", { reason: "rotation_in_progress" }),
    );
    expect(within(alert).getByText("The webhook secret was not rotated")).toBeVisible();
    expect(
      within(alert).getByText("A rotation is already in progress; try again in a minute."),
    ).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says the Calendly subscription was lost and how to fix it", async () => {
    const {
      r,
      alert,
      card: card1,
    } = await rotateCalendly(
      apiError(422, "integration_credentials_rejected", {
        reason: "subscribe_failed",
        subscriptionLost: true,
      }),
      "degraded",
    );
    expect(
      within(alert).getByText(
        /Calendly webhook subscription was lost.*Rotate the secret again or reconnect Calendly/u,
      ),
    ).toBeVisible();
    // The refusal degraded the connection; the card re-reads its health.
    expect(await within(card1).findByText("Degraded")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("a subscribe failure that kept the old subscription reads as a plain refusal", async () => {
    const { alert } = await rotateCalendly(
      apiError(422, "integration_credentials_rejected", { reason: "subscribe_failed" }),
    );
    expect(within(alert).getByText(/registering the booking webhook failed/u)).toBeVisible();
    expect(within(alert).queryByText(/subscription was lost/u)).toBeNull();
  }, 20_000);
});

/** The confirm card's own button (the provider card has a "Connect …" button too). */
async function confirmButton(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole(
    "heading",
    { name: `Connect ${name} to this workspace?` },
    { timeout: 5000 },
  );
  const confirmCard = heading.closest("[data-slot=card]") as HTMLElement;
  return within(confirmCard).getByRole("button", { name: `Connect ${name}` });
}

describe("integrations admin: OAuth return", () => {
  afterEach(() => sessionStorage.clear());

  const completeOk: Record<string, Handler> = {
    "POST /api/v1/integrations/{provider}/oauth/complete": () => [
      200,
      integrationConnection("quickbooks"),
    ],
  };

  it("strips the fragment at once and connects only after the admin confirms", async () => {
    const { calls } = handlers(completeOk);
    const r = await openScreen(
      `/admin/integrations?integration=quickbooks&result=pending#pending=${TOKEN}`,
    );
    const heading = await screen.findByRole("heading", {
      name: "Connect QuickBooks Online to this workspace?",
    });
    await waitFor(() => expect(pathOf(r.router)).toBe("/admin/integrations"));
    expect(r.router.state.location.hash).toBe("");
    // Nothing was connected by landing here, and no success is claimed yet.
    expect(calls.some((c) => c.path.endsWith("/oauth/complete"))).toBe(false);
    expect(screen.queryByText("QuickBooks Online connected")).toBeNull();
    expect(r.container.textContent).not.toContain(TOKEN);
    await expectNoA11yViolations(r.container);
    const confirmCard = heading.closest("[data-slot=card]") as HTMLElement;
    const user = userEvent.setup();
    await user.click(
      within(confirmCard).getByRole("button", { name: "Connect QuickBooks Online" }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/oauth/complete"))).toMatchObject({
        method: "POST",
        path: "/api/v1/integrations/quickbooks/oauth/complete",
        body: { pendingToken: TOKEN },
      }),
    );
    expect(await screen.findByText("QuickBooks Online connected")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Connect QuickBooks Online to this workspace?" }),
    ).toBeNull();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("cancel discards the grant without a request", async () => {
    const { calls } = handlers(completeOk);
    await openScreen(`/admin/integrations?integration=xero&result=pending#pending=${TOKEN}`);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Connect Xero to this workspace?" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Connect Xero to this workspace?" })).toBeNull();
    expect(calls.some((c) => c.path.endsWith("/oauth/complete"))).toBe(false);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  }, 20_000);

  it("keeps the grant across a step-up round trip, then clears it after use", async () => {
    let fresh = false;
    const { calls } = handlers({
      "POST /api/v1/integrations/{provider}/oauth/complete": () =>
        fresh
          ? [200, integrationConnection("quickbooks")]
          : apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openScreen(
      `/admin/integrations?integration=quickbooks&result=pending#pending=${TOKEN}`,
    );
    const user = userEvent.setup();
    await user.click(await confirmButton("QuickBooks Online"));
    await waitFor(() => expect(r.router.state.location.pathname).toBe("/auth/step-up"));
    expect(r.router.state.location.search).toMatchObject({ returnTo: "/admin/integrations" });
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "{}")).toMatchObject({
      provider: "quickbooks",
      token: TOKEN,
    });
    r.unmount();

    // Back from step-up on the clean URL: the parked grant asks again.
    fresh = true;
    await openScreen("/admin/integrations");
    await user.click(await confirmButton("QuickBooks Online"));
    expect(await screen.findByText("QuickBooks Online connected")).toBeVisible();
    expect(calls.filter((c) => c.path.endsWith("/oauth/complete"))).toHaveLength(2);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  }, 20_000);

  it("ignores a parked grant older than ten minutes", async () => {
    sessionStorage.setItem(
      PENDING_KEY,
      JSON.stringify({ provider: "quickbooks", token: TOKEN, savedAt: Date.now() - 11 * 60_000 }),
    );
    handlers();
    await openScreen("/admin/integrations");
    await screen.findByRole("heading", { name: "QuickBooks Online", level: 3 }, { timeout: 5000 });
    expect(screen.queryByRole("heading", { name: /to this workspace\?/u })).toBeNull();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
  }, 20_000);

  it("survives storage that throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    handlers(completeOk);
    await openScreen(`/admin/integrations?integration=quickbooks&result=pending#pending=${TOKEN}`);
    const user = userEvent.setup();
    await user.click(await confirmButton("QuickBooks Online"));
    expect(await screen.findByText("QuickBooks Online connected")).toBeVisible();
  }, 20_000);

  it("says the request expired or was used when the server refuses it", async () => {
    handlers({
      "POST /api/v1/integrations/{provider}/oauth/complete": () =>
        apiError(404, "integration_oauth_pending_invalid"),
    });
    const r = await openScreen(
      `/admin/integrations?integration=quickbooks&result=pending#pending=${TOKEN}`,
    );
    const user = userEvent.setup();
    await user.click(await confirmButton("QuickBooks Online"));
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("This connection request expired or was already used. Start again."),
    ).toBeVisible();
    expect(screen.queryByText("QuickBooks Online connected")).toBeNull();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it.each([
    ["no fragment", "/admin/integrations?integration=quickbooks&result=pending"],
    ["a malformed token", "/admin/integrations?integration=quickbooks&result=pending#pending=x"],
    ["an unknown provider", `/admin/integrations?integration=evil&result=pending#pending=${TOKEN}`],
  ])(
    "shows a generic error for result=pending with %s",
    async (_label, path) => {
      const { calls } = handlers(completeOk);
      const r = await openScreen(path);
      const alert = await screen.findByRole("alert");
      expect(within(alert).getByText(/Something went wrong while connecting/u)).toBeVisible();
      expect(screen.queryByRole("button", { name: /^Connect .* to this workspace/u })).toBeNull();
      expect(screen.queryByRole("heading", { name: /to this workspace\?/u })).toBeNull();
      expect(r.container.textContent).not.toContain("evil");
      expect(calls.some((c) => c.path.endsWith("/oauth/complete"))).toBe(false);
      await waitFor(() => expect(pathOf(r.router)).toBe("/admin/integrations"));
      expect(r.router.state.location.hash).toBe("");
      await expectNoA11yViolations(r.container);
    },
    20_000,
  );

  it("shows nothing for a crafted ?result=connected link", async () => {
    handlers();
    const r = await openScreen("/admin/integrations?integration=quickbooks&result=connected");
    await screen.findByRole("heading", { name: "QuickBooks Online", level: 3 }, { timeout: 5000 });
    expect(screen.queryByText("QuickBooks Online connected")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(pathOf(r.router)).toBe("/admin/integrations"));
  }, 20_000);

  it("a reader landing on a pending grant gets no confirm", async () => {
    const { calls } = handlers({}, ["integrations.read"]);
    await openScreen(`/admin/integrations?integration=quickbooks&result=pending#pending=${TOKEN}`);
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(screen.queryByRole("heading", { name: /to this workspace\?/u })).toBeNull();
    expect(calls.some((c) => c.path.endsWith("/oauth/complete"))).toBe(false);
  }, 20_000);

  it.each([
    ["denied", /Access was not approved/u],
    ["expired", /took too long or was already used/u],
    ["browser_mismatch", /in a different browser/u],
    ["exchange_failed", /did not complete the sign-in/u],
    ["verify_failed", /account could not be read/u],
    ["something_new", /Something went wrong while connecting/u],
  ])(
    "translates the error reason %s",
    async (reason, text) => {
      handlers();
      const r = await openScreen(
        `/admin/integrations?integration=xero&result=error&reason=${reason}`,
      );
      const alert = await screen.findByRole("alert");
      expect(within(alert).getByText("Could not connect Xero")).toBeVisible();
      expect(within(alert).getByText(text)).toBeVisible();
      await waitFor(() => expect(pathOf(r.router)).toBe("/admin/integrations"));
      await expectNoA11yViolations(r.container);
      const user = userEvent.setup();
      await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("alert")).toBeNull();
    },
    20_000,
  );

  it("never echoes an unknown provider name from the query", async () => {
    handlers();
    const r = await openScreen(
      "/admin/integrations?integration=%3Cscript%3Eevil&result=error&reason=expired",
    );
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Could not connect")).toBeVisible();
    expect(r.container.textContent).not.toContain("evil");
  }, 20_000);
});

describe("integrations admin: booking links and bookings", () => {
  it("lists the links with their audiences and adds one for chosen groups", async () => {
    const { calls } = handlers({
      "GET /api/v1/integrations/booking-links": () => [200, { links: [cfoLink(), bookingLink()] }],
      "POST /api/v1/integrations/booking-links": ({ body }) => [
        200,
        bookingLink({ ...(body as object), id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8b03" }),
      ],
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const list = await screen.findByRole("list", {
      name: "Booking links, in the order investors see them",
    });
    const items = within(list).getAllByRole("listitem");
    // Sorted by position, not by arrival.
    expect(within(items[0] as HTMLElement).getByText("Book a call with the CEO")).toBeVisible();
    expect(within(items[0] as HTMLElement).getByText(/Everyone/u)).toBeVisible();
    expect(
      await within(items[1] as HTMLElement).findByText(/Groups: Lead investors/u),
    ).toBeVisible();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Add booking link" }));
    const form = screen.getByRole("form", { name: "Add booking link" });
    await user.selectOptions(within(form).getByLabelText("Provider"), "calendly");
    expect(within(form).getByText("An https:// address on calendly.com.")).toBeVisible();
    await user.type(within(form).getByLabelText(/^Label/u), "Board office hours");
    const url = within(form).getByLabelText(/Booking page address/u);
    await user.type(url, "http://calendly.com/acme");
    expect(within(form).getByText("The address must start with https://.")).toBeVisible();
    const save = within(form).getByRole("button", { name: "Save link" });
    expect(save).toBeDisabled();
    await user.clear(url);
    await user.type(url, "https://calendly.com/acme/board");
    await user.click(within(form).getByRole("radio", { name: "Only members of chosen groups" }));
    expect(save).toBeDisabled();
    await user.click(within(form).getByRole("checkbox", { name: "Board" }));
    await expectNoA11yViolations(r.container);
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        provider: "calendly",
        position: 2,
        url: "https://calendly.com/acme/board",
        label: "Board office hours",
        description: null,
        audience: { kind: "groups", groupIds: [GROUP_BOARD_ID] },
        enabled: true,
      }),
    );
    expect(await screen.findByText("Booking link saved.")).toBeInTheDocument();
  }, 20_000);

  it("names a refused URL", async () => {
    handlers({
      "POST /api/v1/integrations/booking-links": () => apiError(422, "booking_link_invalid_url"),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Add booking link" }, { timeout: 5000 }),
    );
    const form = screen.getByRole("form", { name: "Add booking link" });
    await user.type(within(form).getByLabelText(/^Label/u), "Call");
    await user.type(within(form).getByLabelText(/Booking page address/u), "https://evil.test/x");
    await user.click(within(form).getByRole("button", { name: "Save link" }));
    expect(
      await within(form).findByText(/is not a booking page of the chosen provider/u),
    ).toBeVisible();
  }, 20_000);

  it("reorders, hides, edits and deletes links", async () => {
    const { calls } = handlers({
      "GET /api/v1/integrations/booking-links": () => [200, { links: [bookingLink(), cfoLink()] }],
      "PATCH /api/v1/integrations/booking-links/{id}": ({ params }) => [
        200,
        params["id"] === LINK_CEO_ID ? bookingLink() : cfoLink(),
      ],
      "DELETE /api/v1/integrations/booking-links/{id}": () => [200, { ok: true }],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Move “Diligence Q&A with the CFO” up" },
        { timeout: 5000 },
      ),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH").map((c) => [c.path, c.body])).toEqual([
        [`/api/v1/integrations/booking-links/${LINK_CFO_ID}`, { position: 0 }],
        [`/api/v1/integrations/booking-links/${LINK_CEO_ID}`, { position: 1 }],
      ]),
    );
    expect(
      screen.getByRole("button", { name: "Move “Book a call with the CEO” up" }),
    ).toBeDisabled();

    const switches = screen.getAllByRole("switch", { name: "Shown on the portal" });
    await user.click(switches[0] as HTMLElement);
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH").at(-1)).toEqual({
        method: "PATCH",
        path: `/api/v1/integrations/booking-links/${LINK_CEO_ID}`,
        body: { enabled: false },
      }),
    );

    // Edit keeps the provider and prefills the audience.
    await user.click(screen.getAllByRole("button", { name: "Edit" })[1] as HTMLElement);
    const form = screen.getByRole("form", { name: "Edit booking link" });
    expect(within(form).queryByLabelText("Provider")).toBeNull();
    expect(
      within(form).getByRole("radio", { name: "Only members of chosen groups" }),
    ).toBeChecked();
    expect(await within(form).findByRole("checkbox", { name: "Lead investors" })).toBeChecked();
    await user.click(within(form).getByRole("radio", { name: "Everyone" }));
    await user.click(within(form).getByRole("button", { name: "Save link" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({
        url: "https://calendly.com/acme-cfo/diligence",
        label: "Diligence Q&A with the CFO",
        description: null,
        audience: { kind: "all" },
        enabled: true,
      }),
    );

    await user.click(screen.getAllByRole("button", { name: "Delete link" })[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", {
      name: "Delete “Book a call with the CEO”?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete link" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "DELETE" && c.path === `/api/v1/integrations/booking-links/${LINK_CEO_ID}`,
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("stops at ten links", async () => {
    handlers({
      "GET /api/v1/integrations/booking-links": () => [
        200,
        {
          links: Array.from({ length: 10 }, (_, i) =>
            bookingLink({
              id: `0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c9${String(i).padStart(3, "0")}`,
              label: `Link ${i}`,
              position: i,
            }),
          ),
        },
      ],
    });
    await openScreen();
    expect(
      await screen.findByRole("button", { name: "Add booking link" }, { timeout: 5000 }),
    ).toBeDisabled();
    expect(screen.getByText(/at most 10 booking links/u)).toBeVisible();
  }, 20_000);

  it("shows the recorded meetings, newest first, with paging", async () => {
    const { calls } = handlers({
      "GET /api/v1/integrations/bookings": ({ url }) =>
        url.searchParams.get("cursor") === null
          ? [200, { items: [integrationBooking()], nextCursor: "c2" }]
          : [
              200,
              {
                items: [
                  integrationBooking({
                    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c8d02",
                    provider: "calendly",
                    status: "cancelled",
                    inviteeName: null,
                    inviteeEmail: "stranger@example.test",
                    eventName: null,
                    membershipId: null,
                  }),
                ],
                nextCursor: null,
              },
            ],
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const table = await screen.findByRole(
      "table",
      { name: "Recorded meetings" },
      { timeout: 5000 },
    );
    expect(within(table).getByText("Ada Lovelace")).toBeVisible();
    expect(within(table).getByText("ada@investor.test")).toBeVisible();
    expect(within(table).getByText("Investor call")).toBeVisible();
    expect(within(table).getByText("Booked")).toBeVisible();
    expect(within(table).getByText("Member")).toBeVisible();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await within(table).findByText("stranger@example.test")).toBeVisible();
    expect(within(table).getByText("Cancelled")).toBeVisible();
    expect(within(table).getByText("No match")).toBeVisible();
    expect(within(table).getByText("Untitled event")).toBeVisible();
    expect(calls.some((c) => c.path.endsWith("/integrations/bookings"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  }, 20_000);
});

describe("integrations admin: permissions and the hub", () => {
  it("links out to the other integrations the admin can open", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
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
          permissions: [
            ...ALL,
            "metrics.settings",
            "esign.read",
            "accreditation.read",
            "webhooks.read",
            "api-keys.read",
          ],
          membership: { id: OWNER_ID, kind: "staff", role: "owner" },
        }),
      ],
      "GET /api/v1/integrations/providers": () => [200, integrationProviders()],
      "GET /api/v1/integrations/connections": () => [200, { connections: [] }],
      "GET /api/v1/integrations/booking-links": () => [200, { links: [] }],
      "GET /api/v1/integrations/bookings": () => [200, { items: [], nextCursor: null }],
      "GET /api/v1/access/groups": () => [200, groupList()],
    });
    const r = await openScreen();
    const related = screen
      .getByRole("heading", { name: "More integrations" })
      .closest("section") as HTMLElement;
    expect(within(related).getByRole("link", { name: "Google Sheets" })).toHaveAttribute(
      "href",
      "/admin/metrics/sheets",
    );
    expect(within(related).getByRole("link", { name: "E-signature" })).toHaveAttribute(
      "href",
      "/admin/esign",
    );
    expect(within(related).getByRole("link", { name: "Accreditation" })).toHaveAttribute(
      "href",
      "/admin/accreditation",
    );
    expect(within(related).getByRole("link", { name: "Webhooks" })).toHaveAttribute(
      "href",
      "/admin/webhooks",
    );
    expect(within(related).getByRole("link", { name: "API keys" })).toHaveAttribute(
      "href",
      "/admin/api-keys",
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows a reader everything and lets them change nothing", async () => {
    const { calls } = handlers(
      {
        "GET /api/v1/integrations/connections": connections(
          integrationConnection("quickbooks"),
          integrationConnection("xero", {
            availableAccounts: [
              { id: XERO_ORG_A, name: "Acme Ltd" },
              { id: XERO_ORG_B, name: "Acme Holdings" },
            ],
            externalAccountId: XERO_ORG_A,
          }),
          integrationConnection("calcom"),
        ),
        "GET /api/v1/integrations/booking-links": () => [
          200,
          { links: [bookingLink(), cfoLink()] },
        ],
      },
      ["integrations.read"],
    );
    const r = await openScreen();
    expect(
      await screen.findByText("You can see the integrations but not change them."),
    ).toBeVisible();
    const qbo = await card("QuickBooks Online");
    expect(within(qbo).getByText("Acme Ltd (realm 1234)")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Connect|Disconnect|Verify now|Reconnect/u }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Rotate webhook secret" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use this organisation" })).toBeNull();
    expect(within(await card("Xero")).getByRole("radio", { name: "Acme Ltd" })).toBeDisabled();
    expect(
      within(await card("Stripe")).getByText(/An owner or admin can connect it/u),
    ).toBeVisible();
    expect(await screen.findByText("Book a call with the CEO")).toBeVisible();
    // No access.read: group names are not fetched, the count stands in.
    expect(screen.getByText(/Shown to: 1 group/u)).toBeVisible();
    expect(calls.some((c) => c.path === "/api/v1/access/groups")).toBe(false);
    expect(screen.queryByRole("button", { name: "Add booking link" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("hides the nav entry and refuses the screen without integrations.read", async () => {
    const { calls } = handlers({}, []);
    const r = await renderApp("/admin/integrations");
    expect(
      await screen.findByText(
        "You do not have permission to see integrations in this workspace.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Integrations" })).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/api/v1/integrations"))).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

// A-3 (ADR-0063): a plan without `integrations` keeps every connection syncing and maintainable
// (reconnect, replace credentials, choose the account, verify); it only stops connecting a
// provider the workspace has no connection for.
describe("integrations admin on a plan without integrations", () => {
  it("greys out connecting a new provider and leaves the connected ones maintainable", async () => {
    handlers({
      "GET /api/v1/integrations/connections": connections(
        integrationConnection("quickbooks"),
        integrationConnection("stripe"),
      ),
    });
    withPlanEntitlements({ features: [] });
    const r = await openScreen();
    expect(
      await screen.findByText(
        "Your plan doesn't include Integrations. What you've already set up keeps working.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    const xero = await card("Xero");
    expect(within(xero).getByRole("button", { name: "Connect Xero" })).toBeDisabled();
    const qbo = await card("QuickBooks Online");
    expect(await within(qbo).findByText("Connected")).toBeInTheDocument();
    expect(within(qbo).getByRole("button", { name: "Reconnect" })).toBeEnabled();
    expect(within(qbo).getByRole("button", { name: "Verify now" })).toBeEnabled();
    expect(within(qbo).getByRole("button", { name: "Disconnect" })).toBeEnabled();
    const stripe = await card("Stripe");
    expect(within(stripe).getByRole("button", { name: "Replace key" })).toBeEnabled();
    expect(within(stripe).queryByRole("button", { name: "Connect Stripe" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("lets a connected provider's account be chosen", async () => {
    handlers({
      "GET /api/v1/integrations/connections": connections(
        integrationConnection("xero", {
          accountLabel: null,
          externalAccountId: null,
          availableAccounts: [
            { id: XERO_ORG_A, name: "Acme Ltd" },
            { id: XERO_ORG_B, name: "Acme Holdings" },
          ],
        }),
      ),
    });
    withPlanEntitlements({ features: [] });
    await openScreen();
    const xero = await card("Xero");
    const user = userEvent.setup();
    await user.click(await within(xero).findByRole("radio", { name: "Acme Holdings" }));
    expect(within(xero).getByRole("button", { name: "Use this organisation" })).toBeEnabled();
  }, 20_000);
});
