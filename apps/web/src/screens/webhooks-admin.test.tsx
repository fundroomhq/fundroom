import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi, withPlanEntitlements } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/webhooks` and `/admin/webhooks/$endpointId` (E3.4):
 *
 *  - the URL never comes back, so an endpoint is shown by host + hint;
 *  - the signing secret is on the wire once (create, rotate), pinned and copyable;
 *  - person-level topics say they depend on the member's tracking consent;
 *  - deliveries are browsable by status (the failed tab is the dead-letter list), openable and
 *    redeliverable; changing the URL is a step-up.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

type Endpoint = FundRoomSchemas["WebhookEndpoint"];
type Delivery = FundRoomSchemas["WebhookDelivery"];
type DeliveryDetail = FundRoomSchemas["WebhookDeliveryDetail"];

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const EP_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7a01";
const EP2_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7a02";
const DEL_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7b01";
const DEL2_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7b02";
const WS = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a01";
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSwAbCdEfGhIjK=";
const ROTATED_SECRET = "whsec_ZZKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSwAbCdEfGhIjK=";

function endpoint(over: Partial<Endpoint> = {}): Endpoint {
  return {
    id: EP_ID,
    description: "Zapier: new commitments",
    urlHost: "https://hooks.zapier.com",
    urlHint: "x9Qz",
    events: ["round.commitment_created", "update.published"],
    enabled: true,
    disabledReason: null,
    consecutiveFailures: 0,
    lastSuccessAt: "2026-09-20T10:00:00.000Z",
    lastFailureAt: null,
    secretRotating: false,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

const FAILING = endpoint({
  id: EP2_ID,
  description: null,
  urlHost: "https://example.org",
  urlHint: "hook",
  events: ["document.viewed"],
  enabled: false,
  disabledReason: "failing",
  consecutiveFailures: 20,
  lastSuccessAt: null,
  lastFailureAt: "2026-09-21T10:00:00.000Z",
});

function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: DEL_ID,
    endpointId: EP_ID,
    topic: "update.published",
    eventId: "4711",
    status: "succeeded",
    attempts: 1,
    nextAttemptAt: null,
    lastStatusCode: 200,
    lastError: null,
    lastDurationMs: 142,
    createdAt: "2026-09-20T10:00:00.000Z",
    deliveredAt: "2026-09-20T10:00:01.000Z",
    manual: false,
    ...over,
  };
}

const FAILED = delivery({
  id: DEL2_ID,
  topic: "round.commitment_created",
  eventId: "4712",
  status: "failed",
  attempts: 10,
  lastStatusCode: 503,
  lastError: "HTTP 503",
  deliveredAt: null,
});

function detail(over: Partial<DeliveryDetail> = {}): DeliveryDetail {
  return {
    ...FAILED,
    payload: {
      id: DEL2_ID,
      type: "round.commitment_created",
      timestamp: "2026-09-20T09:59:59.000Z",
      workspaceId: WS,
      data: { commitmentId: "c-42" },
      schemaVersion: 1,
    },
    lastResponseExcerpt: "Service temporarily unavailable",
    ...over,
  };
}

const TOPICS: FundRoomSchemas["WebhookTopics"] = {
  topics: [
    {
      topic: "round.commitment_created",
      moduleId: "round",
      description: "A commitment was recorded",
      personLevel: false,
    },
    {
      topic: "document.viewed",
      moduleId: "data-room",
      description: "A member opened a document",
      personLevel: true,
    },
    {
      topic: "update.published",
      moduleId: "updates",
      description: "An update was published",
      personLevel: false,
    },
  ],
};

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const ALL = ["webhooks.read", "webhooks.manage"];

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
    "GET /api/v1/webhooks/topics": () => [200, TOPICS],
    "GET /api/v1/webhooks/endpoints": () => [
      200,
      { items: [endpoint(), FAILING], nextCursor: null },
    ],
    "GET /api/v1/webhooks/endpoints/{id}": () => [
      200,
      endpoint({
        stats: { last24h: { pending: 1, sending: 0, succeeded: 12, failed: 1, cancelled: 0 } },
      }),
    ],
    "GET /api/v1/webhooks/deliveries": ({ url }) => {
      const status = url.searchParams.get("status");
      const items = [delivery(), FAILED].filter((d) => status === null || d.status === status);
      return [200, { items, nextCursor: null }];
    },
    "GET /api/v1/webhooks/deliveries/{id}": () => [200, detail()],
    ...over,
  });
}

async function openList() {
  const r = await renderApp("/admin/webhooks");
  expect(
    await screen.findByRole("heading", { name: "Webhooks", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

async function openEndpoint() {
  const r = await renderApp(`/admin/webhooks/${EP_ID}`);
  expect(
    await screen.findByRole(
      "heading",
      { name: "https://hooks.zapier.com/••••x9Qz", level: 1 },
      { timeout: 5000 },
    ),
  ).toBeInTheDocument();
  return r;
}

function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("webhooks admin: endpoints", () => {
  it("lists endpoints by host and hint, with why one is off", async () => {
    handlers();
    const r = await openList();
    const table = await screen.findByRole(
      "table",
      { name: "Webhook endpoints" },
      { timeout: 5000 },
    );
    const rows = within(table).getAllByRole("row");
    const first = rows[1] as HTMLElement;
    expect(
      within(first).getByRole("link", { name: "https://hooks.zapier.com/••••x9Qz" }),
    ).toHaveAttribute("href", `/admin/webhooks/${EP_ID}`);
    expect(within(first).getByText("2 events")).toBeInTheDocument();
    expect(within(first).getByText("On")).toBeInTheDocument();
    const second = rows[2] as HTMLElement;
    expect(within(second).getByText("1 event")).toBeInTheDocument();
    expect(within(second).getByText("Off: kept failing")).toBeInTheDocument();
    expect(within(second).getByText("20")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Webhooks" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("adds an endpoint and shows its signing secret once", async () => {
    const { calls } = handlers({
      "POST /api/v1/webhooks/endpoints": () => [201, { endpoint: endpoint(), secret: SECRET }],
    });
    const r = await openList();
    const user = userEvent.setup();
    const writeText = stubClipboard();
    await user.click(
      await screen.findByRole("button", { name: "New endpoint" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText(/URL/u),
      "https://hooks.zapier.com/hooks/catch/1/x9Qz",
    );
    const viewed = await within(dialog).findByRole("checkbox", { name: "document.viewed" });
    // Person-level topics carry the consent caveat.
    expect(viewed).toHaveAccessibleDescription(/tracking consent allows it/u);
    expect(
      within(dialog).getByRole("checkbox", { name: "update.published" }),
    ).not.toHaveAccessibleDescription(/tracking consent/u);
    await user.click(within(dialog).getByRole("checkbox", { name: "round.commitment_created" }));
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Add endpoint" }));

    expect(
      await screen.findByText(
        "Signing secret for https://hooks.zapier.com/••••x9Qz — copy it now",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    expect(screen.getByText(/This is the only time it is shown/u)).toBeVisible();
    expect(screen.getByRole("link", { name: "How to verify a delivery" })).toHaveAttribute(
      "href",
      "https://www.standardwebhooks.com/",
    );
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Copy secret" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
    expect(
      calls.find((c) => c.method === "POST" && c.path === "/api/v1/webhooks/endpoints")?.body,
    ).toEqual({
      url: "https://hooks.zapier.com/hooks/catch/1/x9Qz",
      events: ["round.commitment_created"],
    });
  }, 20_000);

  it("names the cap when the workspace has too many endpoints", async () => {
    handlers({
      "POST /api/v1/webhooks/endpoints": () =>
        apiError(409, "conflict", { reason: "too_many_endpoints" }),
    });
    await openList();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "New endpoint" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/URL/u), "https://example.org/hook");
    await user.click(await within(dialog).findByRole("checkbox", { name: "update.published" }));
    await user.click(within(dialog).getByRole("button", { name: "Add endpoint" }));
    expect(await within(dialog).findByText(/already has 20 endpoints/u)).toBeVisible();
  }, 20_000);

  it("hides the nav entry and refuses the screen without webhooks.read", async () => {
    const { calls } = handlers({}, []);
    const r = await renderApp("/admin/webhooks");
    expect(
      await screen.findByText(
        "Only workspace owners and admins can see webhooks.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Webhooks" })).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/api/v1/webhooks"))).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("hides every write from a reader", async () => {
    handlers({}, ["webhooks.read"]);
    const r = await openEndpoint();
    expect(await screen.findByText("12 delivered, 1 failed, 1 waiting")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send a test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rotate secret" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete endpoint" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change URL" })).toBeNull();
    await expectNoA11yViolations(r.container);
    await user().click(
      await screen.findByRole(
        "button",
        { name: /Details of round\.commitment_created/u },
        { timeout: 5000 },
      ),
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Service temporarily unavailable");
    expect(within(dialog).queryByRole("button", { name: "Send again" })).toBeNull();
  }, 20_000);
});

function user() {
  return userEvent.setup();
}

describe("webhooks admin: one endpoint", () => {
  it("filters deliveries by status and topic, and loads more", async () => {
    const { calls, fetchMock } = handlers({
      "GET /api/v1/webhooks/deliveries": ({ url }) => {
        const status = url.searchParams.get("status");
        if (url.searchParams.get("cursor") === "next-1") {
          return [
            200,
            {
              items: [delivery({ id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7b03", eventId: "4700" })],
              nextCursor: null,
            },
          ];
        }
        const items = [delivery(), FAILED].filter((d) => status === null || d.status === status);
        return [200, { items, nextCursor: status === null ? "next-1" : null }];
      },
    });
    const r = await openEndpoint();
    const u = user();
    const all = await screen.findByRole("table", { name: "All" }, { timeout: 5000 });
    expect(within(all).getAllByRole("row")).toHaveLength(3);
    await expectNoA11yViolations(r.container);

    await u.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/v1/webhooks/deliveries")).toBe(true),
    );
    await waitFor(() =>
      expect(within(screen.getByRole("table", { name: "All" })).getAllByRole("row")).toHaveLength(
        4,
      ),
    );

    await u.click(screen.getByRole("tab", { name: "Failed" }));
    const failed = await screen.findByRole("table", { name: "Failed" });
    expect(within(failed).getAllByRole("row")).toHaveLength(2);
    expect(within(failed).getByText("round.commitment_created")).toBeInTheDocument();

    await u.selectOptions(
      screen.getByRole("combobox", { name: "Event" }),
      "round.commitment_created",
    );
    const urls = () => fetchMock.mock.calls.map(([input, init]) => new Request(input, init).url);
    await waitFor(() =>
      expect(
        urls().some(
          (u) =>
            u.includes("status=failed") &&
            u.includes("topic=round.commitment_created") &&
            u.includes(`endpointId=${EP_ID}`),
        ),
      ).toBe(true),
    );
    expect(urls().some((u) => u.includes("cursor=next-1"))).toBe(true);
  }, 20_000);

  it("opens a delivery's details and sends it again", async () => {
    const { calls } = handlers({
      "POST /api/v1/webhooks/deliveries/{id}/redeliver": () => [
        202,
        { delivery: delivery({ id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c7b09", manual: true }) },
      ],
    });
    await openEndpoint();
    const u = user();
    await u.click(
      await screen.findByRole(
        "button",
        { name: /Details of round\.commitment_created/u },
        { timeout: 5000 },
      ),
    );
    const dialog = await screen.findByRole("dialog", { name: "Delivery details" });
    expect(await within(dialog).findByText("Service temporarily unavailable")).toBeVisible();
    expect(within(dialog).getByText("503")).toBeInTheDocument();
    expect(within(dialog).getByText("HTTP 503")).toBeInTheDocument();
    expect(within(dialog).getByText("142 ms")).toBeInTheDocument();
    expect(within(dialog).getByText(/"commitmentId": "c-42"/u)).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
    await u.click(within(dialog).getByRole("button", { name: "Send again" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" && c.path === `/api/v1/webhooks/deliveries/${DEL2_ID}/redeliver`,
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("rotates the signing secret with a grace window and shows the new one once", async () => {
    const { calls } = handlers({
      "POST /api/v1/webhooks/endpoints/{id}/rotate-secret": () => [
        200,
        { endpoint: endpoint({ secretRotating: true }), secret: ROTATED_SECRET },
      ],
    });
    await openEndpoint();
    const u = user();
    await u.click(await screen.findByRole("button", { name: "Rotate secret" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await u.selectOptions(
      within(dialog).getByRole("combobox", { name: /Keep signing with the old secret/u }),
      "72",
    );
    await expectNoA11yViolations(dialog);
    await u.click(within(dialog).getByRole("button", { name: "Rotate secret" }));
    expect(await screen.findByText("New signing secret — copy it now")).toBeInTheDocument();
    expect(screen.getByText(ROTATED_SECRET)).toBeInTheDocument();
    expect(
      calls.find((c) => c.path === `/api/v1/webhooks/endpoints/${EP_ID}/rotate-secret`)?.body,
    ).toEqual({ graceHours: 72 });
  }, 20_000);

  it("explains a rotation refused while the previous secret is still in its overlap", async () => {
    handlers({
      "GET /api/v1/webhooks/endpoints/{id}": () => [200, endpoint({ secretRotating: true })],
      "POST /api/v1/webhooks/endpoints/{id}/rotate-secret": () =>
        apiError(409, "conflict", { reason: "rotation_in_progress" }),
    });
    await openEndpoint();
    const u = user();
    await u.click(await screen.findByRole("button", { name: "Rotate secret" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await u.click(within(dialog).getByRole("button", { name: "Rotate secret" }));
    expect(
      await within(dialog).findByText(/rotate with no grace period to end it now/u),
    ).toBeVisible();
    expect(within(dialog).getByText("The secret was not rotated")).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("says why a redelivery was refused when the member withdrew tracking consent", async () => {
    handlers({
      "POST /api/v1/webhooks/deliveries/{id}/redeliver": () =>
        apiError(409, "conflict", { reason: "tracking_not_allowed" }),
    });
    await openEndpoint();
    const u = user();
    await u.click(
      await screen.findByRole(
        "button",
        { name: /Details of round\.commitment_created/u },
        { timeout: 5000 },
      ),
    );
    const dialog = await screen.findByRole("dialog", { name: "Delivery details" });
    await within(dialog).findByText("Service temporarily unavailable");
    await u.click(within(dialog).getByRole("button", { name: "Send again" }));
    expect(await within(dialog).findByText(/no longer allows tracking/u)).toBeVisible();
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("switches the endpoint off and sends a test", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/webhooks/endpoints/{id}": () => [
        200,
        endpoint({ enabled: false, disabledReason: "manual" }),
      ],
      "POST /api/v1/webhooks/endpoints/{id}/test": () => [
        202,
        { delivery: delivery({ topic: "webhook.ping", manual: true, status: "pending" }) },
      ],
    });
    await openEndpoint();
    const u = user();
    await u.click(await screen.findByRole("button", { name: "Send a test" }, { timeout: 5000 }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === `/api/v1/webhooks/endpoints/${EP_ID}/test`)).toBe(true),
    );
    await u.click(screen.getByRole("switch", { name: "Send deliveries to this endpoint" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false }),
    );
  }, 20_000);

  it("saves topics and description without the URL", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/webhooks/endpoints/{id}": () => [200, endpoint()],
    });
    await openEndpoint();
    const u = user();
    await u.click(
      await screen.findByRole("checkbox", { name: "document.viewed" }, { timeout: 5000 }),
    );
    await u.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        description: "Zapier: new commitments",
        events: ["round.commitment_created", "update.published", "document.viewed"],
      }),
    );
  }, 20_000);

  it("sends a stale admin to step-up when changing the URL", async () => {
    handlers({
      "PATCH /api/v1/webhooks/endpoints/{id}": () =>
        apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openEndpoint();
    const u = user();
    await u.click(await screen.findByRole("button", { name: "Change URL" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await u.type(within(dialog).getByLabelText(/URL/u), "https://example.org/new");
    await u.click(within(dialog).getByRole("button", { name: "Change URL" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
    expect(pathOf(r.router)).toContain(`returnTo=%2Fadmin%2Fwebhooks%2F${EP_ID}`);
  }, 20_000);

  it("deletes the endpoint only once its host is typed back", async () => {
    const { calls } = handlers({
      "DELETE /api/v1/webhooks/endpoints/{id}": () => [200, { ok: true }],
    });
    const r = await openEndpoint();
    const u = user();
    await u.click(
      await screen.findByRole("button", { name: "Delete endpoint" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Delete this endpoint?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete endpoint" });
    expect(confirm).toBeDisabled();
    await u.type(within(dialog).getByLabelText(/Type hooks\.zapier\.com/u), "hooks.zapier.com");
    await u.click(confirm);
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "DELETE" && c.path === `/api/v1/webhooks/endpoints/${EP_ID}`,
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(pathOf(r.router)).toBe("/admin/webhooks"));
  }, 20_000);

  // A-3 (ADR-0063): a plan without `webhooks` stops new endpoints and new destinations only.
  describe("on a plan without webhooks", () => {
    const NOTICE = "Your plan doesn't include Webhooks. What you've already set up keeps working.";

    it("greys out a new endpoint on the list", async () => {
      handlers();
      withPlanEntitlements({ features: [] });
      const r = await openList();
      expect(await screen.findByText(NOTICE, {}, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "New endpoint" })).toBeDisabled();
      await expectNoA11yViolations(r.container);
    }, 20_000);

    it("keeps an endpoint running and lets it be switched off, narrowed, tested, rotated and deleted", async () => {
      const { calls } = handlers({
        "PATCH /api/v1/webhooks/endpoints/{id}": () => [200, endpoint()],
      });
      withPlanEntitlements({ features: [] });
      const r = await openEndpoint();
      expect(await screen.findByText(NOTICE, {}, { timeout: 5000 })).toBeInTheDocument();
      expect(
        screen.getByRole("switch", { name: "Send deliveries to this endpoint" }),
      ).toBeEnabled();
      expect(screen.getByRole("button", { name: "Send a test" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Rotate secret" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Delete endpoint" })).toBeEnabled();
      // A new destination or a new topic would be adding something.
      expect(screen.getByRole("button", { name: "Change URL" })).toBeDisabled();
      expect(
        await screen.findByRole("checkbox", { name: "document.viewed" }, { timeout: 5000 }),
      ).toBeDisabled();
      // Its own topics can be dropped.
      const published = screen.getByRole("checkbox", { name: "update.published" });
      expect(published).toBeEnabled();
      await expectNoA11yViolations(r.container);
      await user().click(published);
      await user().click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
          description: "Zapier: new commitments",
          events: ["round.commitment_created"],
        }),
      );
    }, 20_000);

    it("warns that deleting the endpoint cannot be undone on this plan (RR3 RL4)", async () => {
      handlers();
      withPlanEntitlements({ features: [] });
      await openEndpoint();
      await user().click(
        await screen.findByRole("button", { name: "Delete endpoint" }, { timeout: 5000 }),
      );
      const dialog = await screen.findByRole("dialog", { name: "Delete this endpoint?" });
      expect(
        within(dialog).getByText(/Your plan doesn't include Webhooks, so you won't be able/u),
      ).toBeInTheDocument();
    }, 20_000);

    it("will not switch back on an endpoint an admin switched off", async () => {
      handlers({
        "GET /api/v1/webhooks/endpoints/{id}": () => [
          200,
          endpoint({ enabled: false, disabledReason: "manual" }),
        ],
      });
      withPlanEntitlements({ features: [] });
      await openEndpoint();
      expect(
        await screen.findByRole(
          "switch",
          { name: "Send deliveries to this endpoint" },
          { timeout: 5000 },
        ),
      ).toBeDisabled();
    }, 20_000);

    it("lets an endpoint the system paused be switched back on", async () => {
      const { calls } = handlers({
        "GET /api/v1/webhooks/endpoints/{id}": () => [
          200,
          endpoint({ enabled: false, disabledReason: "failing", consecutiveFailures: 20 }),
        ],
        "PATCH /api/v1/webhooks/endpoints/{id}": () => [200, endpoint()],
      });
      withPlanEntitlements({ features: [] });
      await openEndpoint();
      const toggle = await screen.findByRole(
        "switch",
        { name: "Send deliveries to this endpoint" },
        { timeout: 5000 },
      );
      expect(toggle).toBeEnabled();
      await user().click(toggle);
      await waitFor(() =>
        expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: true }),
      );
    }, 20_000);
  });
});
