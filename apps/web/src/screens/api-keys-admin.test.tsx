import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session, testConfig } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi, withPlanEntitlements } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/api-keys` (E3.4). What the screen owes the admin:
 *
 *  - the token is on the wire once (create, rotate), so it is pinned and copyable, and nothing
 *    else on the screen ever shows it;
 *  - scopes the admin does not hold are visible but cannot be given;
 *  - every write needs a fresh session, which turns into a step-up and back;
 *  - without `api-keys.read` there is no nav entry, no request and a plain refusal.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

type ApiKey = FundRoomSchemas["ApiKey"];

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const LIVE_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a01";
const EXPIRED_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a02";
const REVOKED_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a03";
const NEW_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a04";
const TOKEN = "frk_8Zr2Qk9v_TdM1sXpLb0HgC3nWyRfE6uJaZoP4iKtQvA";
const ROTATED_TOKEN = "frk_Zz9yXw8v_UtS7rQpOn6mLk5jIh4gFe3dCb2aZ1yXwVu";

function apiKey(over: Partial<ApiKey> = {}): ApiKey {
  return {
    id: LIVE_ID,
    name: "Finance sync",
    prefix: "frk_8Zr2Qk9v",
    scopes: ["metrics.read", "metrics.write"],
    status: "live",
    createdAt: "2026-09-01T10:00:00.000Z",
    createdBy: { membershipId: OWNER_ID, displayName: "Grace Hopper" },
    expiresAt: null,
    revokedAt: null,
    revokedReason: null,
    replacedById: null,
    lastUsedAt: null,
    note: "Pushes monthly KPIs",
    ...over,
  };
}

const KEYS: ApiKey[] = [
  apiKey(),
  apiKey({
    id: EXPIRED_ID,
    name: "Old Zapier",
    prefix: "frk_OldZap12",
    scopes: ["crm.read"],
    status: "expired",
    expiresAt: "2026-09-10T00:00:00.000Z",
    lastUsedAt: "2026-09-09T12:00:00.000Z",
    note: null,
  }),
  apiKey({
    id: REVOKED_ID,
    name: "Departed contractor",
    prefix: "frk_Gone1234",
    scopes: ["audit.read"],
    status: "revoked",
    revokedAt: "2026-09-12T00:00:00.000Z",
    revokedReason: "creator_inactive",
    createdBy: { membershipId: OWNER_ID, displayName: null },
    note: null,
  }),
];

const SCOPES: FundRoomSchemas["ApiKeyScopes"] = {
  scopes: [
    { id: "metrics.read", description: "Read metric series and points", held: true },
    { id: "metrics.write", description: "Write metric points", held: true },
    { id: "crm.read", description: "Read CRM contacts", held: false },
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

const ALL = ["api-keys.read", "api-keys.manage"];

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
    "GET /api/v1/api-keys": () => [200, { items: KEYS, nextCursor: null }],
    "GET /api/v1/api-keys/scopes": () => [200, SCOPES],
    ...over,
  });
}

async function openScreen() {
  const r = await renderApp("/admin/api-keys");
  expect(
    await screen.findByRole("heading", { name: "API keys", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

/** jsdom has no clipboard at all, so `CopyButton` needs one before it can be clicked. */
function stubClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("API keys admin", () => {
  it("lists keys with status, prefix, scopes, creator and use — never a token", async () => {
    handlers();
    const r = await openScreen();
    const table = await screen.findByRole("table", { name: "API keys" }, { timeout: 5000 });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    const live = rows[1] as HTMLElement;
    expect(within(live).getByText("Finance sync")).toBeInTheDocument();
    expect(within(live).getByText("Live")).toBeInTheDocument();
    expect(within(live).getByText("frk_8Zr2Qk9v")).toBeInTheDocument();
    expect(within(live).getByText("metrics.write")).toBeInTheDocument();
    expect(within(live).getByText("Grace Hopper")).toBeInTheDocument();
    expect(within(live).getAllByText("Never")).toHaveLength(2);
    expect(within(rows[2] as HTMLElement).getByText("Expired")).toBeInTheDocument();
    const revoked = rows[3] as HTMLElement;
    expect(within(revoked).getByText("Revoked")).toBeInTheDocument();
    expect(within(revoked).getByText("Its creator no longer has access")).toBeInTheDocument();
    expect(within(revoked).getByText("Former member")).toBeInTheDocument();
    // A revoked key has nothing left to do.
    expect(within(revoked).queryByRole("button")).toBeNull();
    // An expired key can be revoked or renamed, but not rotated.
    expect(within(rows[2] as HTMLElement).queryByRole("button", { name: /Rotate/u })).toBeNull();
    expect(screen.getByRole("link", { name: "API keys" })).toBeInTheDocument();
    expect(r.container.textContent).not.toContain(TOKEN);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("creates a key and shows its token once, copyable", async () => {
    const { calls } = handlers({
      "POST /api/v1/api-keys": () => [
        201,
        { key: apiKey({ id: NEW_ID, name: "Zapier", scopes: ["metrics.read"] }), token: TOKEN },
      ],
    });
    const r = await openScreen();
    const user = userEvent.setup();
    const writeText = stubClipboard();
    await user.click(await screen.findByRole("button", { name: "New API key" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Name/u), "Zapier");
    const held = await within(dialog).findByRole("checkbox", { name: "metrics.read" });
    // A scope the admin lacks is offered for what it is, but cannot be ticked.
    const notHeld = within(dialog).getByRole("checkbox", { name: "crm.read" });
    expect(notHeld).toBeDisabled();
    expect(within(dialog).getByText(/You do not hold this permission/u)).toBeVisible();
    const submit = within(dialog).getByRole("button", { name: "Create key" });
    expect(submit).toBeDisabled();
    await user.click(held);
    await user.type(within(dialog).getByLabelText("Note"), "Catch hook");
    await expectNoA11yViolations(dialog);
    await user.click(submit);

    expect(
      await screen.findByText("Here is the key for Zapier — copy it now", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(TOKEN)).toBeInTheDocument();
    expect(screen.getByText(/This is the only time it is shown/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Copy key" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(TOKEN));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/v1/api-keys")?.body).toEqual({
      name: "Zapier",
      scopes: ["metrics.read"],
      note: "Catch hook",
    });

    await user.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(screen.queryByText(TOKEN)).toBeNull();
  }, 20_000);

  it("names the refusal when a scope is not held", async () => {
    handlers({
      "POST /api/v1/api-keys": () =>
        apiError(400, "validation_failed", { reason: "scope_not_held" }),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New API key" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Name/u), "Zapier");
    await user.click(await within(dialog).findByRole("checkbox", { name: "metrics.read" }));
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));
    expect(
      await within(dialog).findByText(/A key can only do what its creator can do/u),
    ).toBeVisible();
  }, 20_000);

  it("rotates a key with the chosen grace window and shows the new token once", async () => {
    const { calls } = handlers({
      "POST /api/v1/api-keys/{id}/rotate": () => [
        201,
        {
          key: apiKey({ id: NEW_ID }),
          token: ROTATED_TOKEN,
          previous: apiKey({ status: "revoked", revokedReason: "rotated" }),
        },
      ],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Rotate Finance sync" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    const grace = within(dialog).getByRole("combobox", { name: /Keep the old key working/u });
    expect(grace).toHaveValue("24");
    await user.selectOptions(grace, "0");
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Rotate key" }));
    expect(
      await screen.findByText("Here is the new key for Finance sync — copy it now"),
    ).toBeInTheDocument();
    expect(screen.getByText(ROTATED_TOKEN)).toBeInTheDocument();
    expect(calls.find((c) => c.path === `/api/v1/api-keys/${LIVE_ID}/rotate`)?.body).toEqual({
      graceHours: 0,
    });
  }, 20_000);

  it("revokes a key after confirmation", async () => {
    const { calls } = handlers({
      "POST /api/v1/api-keys/{id}/revoke": () => [
        200,
        { key: apiKey({ status: "revoked", revokedReason: "revoked" }) },
      ],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Revoke Finance sync" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Revoke Finance sync?" });
    expect(calls.some((c) => c.path.endsWith("/revoke"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.path === `/api/v1/api-keys/${LIVE_ID}/revoke`),
      ).toBe(true),
    );
  }, 20_000);

  it("renames a key and edits its note", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/api-keys/{id}": () => [200, { key: apiKey({ name: "KPI push" }) }],
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Edit Finance sync" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText(/Name/u);
    await user.clear(name);
    await user.type(name, "KPI push");
    await user.clear(within(dialog).getByLabelText("Note"));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        name: "KPI push",
        note: null,
      }),
    );
  }, 20_000);

  it("sends a stale admin to step-up when creating a key", async () => {
    handlers({
      "POST /api/v1/api-keys": () => apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New API key" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Name/u), "Zapier");
    await user.click(await within(dialog).findByRole("checkbox", { name: "metrics.read" }));
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Fapi-keys");
  }, 20_000);

  it("hides every write from a reader", async () => {
    handlers({}, ["api-keys.read"]);
    const r = await openScreen();
    expect(await screen.findByText("Finance sync", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New API key" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Rotate/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Revoke/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit/u })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("hides the nav entry and refuses the screen without api-keys.read", async () => {
    const { calls } = handlers({}, []);
    const r = await renderApp("/admin/api-keys");
    expect(
      await screen.findByText(
        "Only workspace owners and admins can see API keys.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "API keys" })).toBeNull();
    expect(calls.some((c) => c.path.startsWith("/api/v1/api-keys"))).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  // A-3 (ADR-0063): a plan without `api_keys` stops new keys, never the existing ones.
  it("says the plan leaves API keys out and greys out only the new-key button", async () => {
    handlers({}, [...ALL, "billing.read"]);
    withPlanEntitlements({ features: ["webhooks"] });
    const r = await renderApp("/admin/api-keys", testConfig({ billing: true }));
    const notice = (
      await screen.findByText(
        "Your plan doesn't include API keys. What you've already set up keeps working.",
        {},
        { timeout: 5000 },
      )
    ).closest("[data-slot=alert]") as HTMLElement;
    expect(within(notice).getByText("Not on your plan")).toBeInTheDocument();
    const link = within(notice).getByRole("link", { name: "Go to billing" });
    expect(link).toHaveAttribute("href", "/admin/billing");
    expect(link).toHaveClass("underline");
    expect(screen.getByRole("button", { name: "New API key" })).toBeDisabled();
    // What keeps an existing key safe stays available.
    expect(
      await screen.findByRole("button", { name: "Rotate Finance sync" }, { timeout: 5000 }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Revoke Finance sync" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Edit Finance sync" })).toBeEnabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows no notice while the plan includes API keys", async () => {
    handlers();
    withPlanEntitlements({ features: ["api_keys"] });
    await openScreen();
    expect(await screen.findByRole("button", { name: "New API key" })).toBeEnabled();
    expect(screen.queryByText("Not on your plan")).toBeNull();
  }, 20_000);

  it("explains a refusal that races a plan change, with no billing link for an admin", async () => {
    handlers({
      "POST /api/v1/api-keys": () =>
        apiError(402, "plan_limit", { limit: "feature", feature: "api_keys" }),
    });
    await openScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New API key" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Name/u), "Zapier");
    await user.click(await within(dialog).findByRole("checkbox", { name: "metrics.read" }));
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));
    const alert = await within(dialog).findByRole("alert");
    expect(within(alert).getByText("Your plan doesn't include API keys.")).toBeInTheDocument();
    // The default test install does not bill: the host changes the plan (R3 L5).
    expect(within(alert).getByText("To change the plan, contact your host.")).toBeInTheDocument();
    expect(within(alert).queryByRole("link", { name: "Go to billing" })).toBeNull();
  }, 20_000);
});
