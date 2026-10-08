import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/settings/danger` (E2.7): transfer ownership, revoke every session, delete the
 * workspace — owner only, each behind a typed confirmation of the slug (`acme`) and step-up.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f07";
const LIN_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e31";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

function staff(id: string, name: string): FundRoomSchemas["Person"] {
  return {
    membershipId: id,
    userId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c10",
    kind: "staff",
    role: id === OWNER_ID ? "owner" : "admin",
    status: "active",
    displayName: name,
    email: null,
    groups: [],
    profile: {},
    source: "invite",
    principalMembershipId: null,
    delegateScope: null,
    principal: null,
    expiresAt: null,
    lastSeenAt: null,
    activatedAt: null,
    createdAt: "2026-09-11T10:00:00.000Z",
    relationship: {
      establishedAt: null,
      source: null,
      note: null,
      firstExposureAt: null,
      warning: null,
    },
  };
}

function handlers(
  over: Record<string, Handler> = {},
  permissions = ["access.read", "access.transfer", "access.delete_workspace"],
) {
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
    "GET /api/v1/access/people": () => [
      200,
      { items: [staff(OWNER_ID, "Grace Hopper"), staff(LIN_ID, "Lin Wei")], nextCursor: null },
    ],
    ...over,
  });
}

async function openDanger() {
  const r = await renderApp("/admin/settings/danger");
  expect(
    await screen.findByRole("heading", { name: "Danger zone", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

async function confirmWith(dialog: HTMLElement, phrase: string, button: string) {
  const user = userEvent.setup();
  const confirm = within(dialog).getByRole("button", { name: button });
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByRole("textbox", { name: "Type acme to confirm" }), phrase);
  return confirm;
}

describe("danger zone", () => {
  it("transfers ownership to a chosen staff member after typing the slug", async () => {
    const { calls } = handlers({
      "POST /api/v1/access/ownership/transfer": () => [200, { ok: true }],
    });
    const r = await openDanger();
    const user = userEvent.setup();
    const select = await screen.findByRole("combobox", { name: "New owner" });
    // The caller is not offered as a target.
    expect(within(select).queryByRole("option", { name: "Grace Hopper" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Transfer ownership" });
    expect(trigger).toBeDisabled();
    await expectNoA11yViolations(r.container);

    await user.selectOptions(select, LIN_ID);
    await user.click(screen.getByRole("checkbox", { name: "Keep me as an owner too" }));
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Make Lin Wei the owner?" });
    const confirm = await confirmWith(dialog, "acm", "Transfer ownership");
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByRole("textbox"), "e");
    expect(confirm).toBeEnabled();
    await expectNoA11yViolations(dialog);
    await user.click(confirm);
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/access/ownership/transfer")?.body).toEqual({
        toMembershipId: LIN_ID,
        confirm: "acme",
        keepOwner: true,
      }),
    );
    expect(await screen.findByText("Lin Wei is now an owner.")).toBeInTheDocument();
  }, 20_000);

  it("revokes every session, including staff when asked", async () => {
    const { calls } = handlers({
      "POST /api/v1/access/sessions/revoke-all": () => [200, { revoked: 7 }],
    });
    await openDanger();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("checkbox", {
        name: "Also sign out staff (your own session stays signed in)",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Sign everyone out" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign everyone out?" });
    expect(within(dialog).getByText(/except yours/u)).toBeInTheDocument();
    const confirm = await confirmWith(dialog, "acme", "Sign everyone out");
    await user.click(confirm);
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/access/sessions/revoke-all")?.body).toEqual({
        confirm: "acme",
        includeStaff: true,
      }),
    );
    expect(await screen.findByText("7 sessions signed out.")).toBeInTheDocument();
  }, 20_000);

  it("sends a stale owner to step-up from a danger action", async () => {
    handlers({
      "POST /api/v1/access/sessions/revoke-all": () =>
        apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openDanger();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign everyone out" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await confirmWith(dialog, "acme", "Sign everyone out"));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Fsettings%2Fdanger");
  }, 20_000);

  it("explains a legal hold and a confirmation mismatch", async () => {
    let reason = "legal_hold";
    handlers({
      "DELETE /api/v1/workspace": () =>
        reason === "legal_hold"
          ? apiError(409, "conflict", { reason: "legal_hold" })
          : apiError(400, "validation_failed", { reason: "confirmation_mismatch" }),
    });
    const r = await openDanger();
    expect(screen.getByText(/fundroom workspace restore acme/u)).toBeInTheDocument();
    expect(screen.getByText(/kept for 30 days/u)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    let dialog = await screen.findByRole("dialog", { name: "Delete acme?" });
    await user.click(await confirmWith(dialog, "acme", "Delete workspace"));
    expect(
      await screen.findByText(/under legal hold, so it cannot be deleted/u),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    reason = "mismatch";
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    dialog = await screen.findByRole("dialog", { name: "Delete acme?" });
    await user.click(await confirmWith(dialog, "acme", "Delete workspace"));
    expect(await screen.findByText(/did not match the workspace slug/u)).toBeInTheDocument();
  }, 20_000);

  it("explains that the only workspace of the instance cannot be deleted here", async () => {
    handlers({
      "DELETE /api/v1/workspace": () => apiError(409, "conflict", { reason: "last_workspace" }),
    });
    const r = await openDanger();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete acme?" });
    await user.click(await confirmWith(dialog, "acme", "Delete workspace"));
    expect(
      await screen.findByText(/only workspace on this server, so it cannot be deleted here/u),
    ).toBeInTheDocument();
    expect(pathOf(r.router)).toContain("/admin/settings/danger");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("deletes the workspace and leaves for the sign-in page", async () => {
    const { calls } = handlers({
      "DELETE /api/v1/workspace": () => [202, { purgeAfter: "2026-10-22T10:00:00.000Z" }],
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
    });
    // The first /me must succeed to get into the admin tree; later ones see the revoked session.
    let meCalls = 0;
    const fetchMock = vi.mocked(globalThis.fetch);
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/v1/me" && meCalls++ === 0)
        return new Response(JSON.stringify(staffMe()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      return original ? original(input, init) : new Response(null, { status: 404 });
    });
    const r = await openDanger();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete acme?" });
    await user.click(await confirmWith(dialog, "acme", "Delete workspace"));
    await waitFor(() => expect(pathOf(r.router)).toMatch(/^\/login/u));
    expect(
      calls.find((c) => c.method === "DELETE" && c.path === "/api/v1/workspace")?.body,
    ).toEqual({ confirm: "acme" });
    expect(await screen.findByText(/Workspace deleted/u)).toBeInTheDocument();
  }, 20_000);

  it("refuses non-owners", async () => {
    const { calls } = handlers({}, ["access.read", "access.manage"]);
    await renderApp("/admin/settings/danger");
    expect(
      await screen.findByText(
        "Only the workspace owner can use the danger zone.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/access/people")).toBe(false);
  }, 20_000);
});
