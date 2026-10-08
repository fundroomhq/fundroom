import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  apiError,
  type Handler,
  installMockApi,
  memberSession,
  W2_ADA_ID,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * The Sessions card on /admin/people/$membershipId (E2.7): this workspace's live sessions of one
 * member, revoking one or all of them (both `fresh` routes), the note that sessions used in other
 * workspaces are not shown, and no actions without `access.manage`.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const PHONE_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a82";
const NOW = "2026-09-12T10:00:00.000Z";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

function person(over: Partial<FundRoomSchemas["Person"]> = {}): FundRoomSchemas["Person"] {
  return {
    membershipId: W2_ADA_ID,
    userId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02",
    kind: "external",
    role: "investor",
    status: "active",
    displayName: "Ada Lovelace",
    email: "ada@investor.test",
    groups: [],
    profile: {},
    source: "invite",
    principalMembershipId: null,
    delegateScope: null,
    principal: null,
    expiresAt: null,
    lastSeenAt: NOW,
    activatedAt: NOW,
    createdAt: NOW,
    relationship: {
      establishedAt: null,
      source: null,
      note: null,
      firstExposureAt: null,
      warning: null,
    },
    ...over,
  };
}

function personHandlers(
  over: Record<string, Handler> = {},
  permissions = ["access.read", "access.manage", "access.manage_staff"],
  target: FundRoomSchemas["Person"] = person(),
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
    "GET /api/v1/access/groups": () => [200, { groups: [] }],
    "GET /api/v1/access/people/{id}": () => [
      200,
      { person: target, delegates: [], attestations: [], grants: [] },
    ],
    "GET /api/v1/access/people/{id}/sessions": () => [
      200,
      {
        sessions: [
          memberSession(),
          memberSession({ id: PHONE_ID, deviceName: "Ada's phone", device: "Safari on iOS" }),
        ],
      },
    ],
    ...over,
  });
}

async function openPerson() {
  const r = await renderApp(`/admin/people/${W2_ADA_ID}`);
  expect(
    await screen.findByRole("heading", { name: "Ada Lovelace", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("member sessions", () => {
  it("lists this workspace's sessions and explains what is not shown", async () => {
    personHandlers();
    const r = await openPerson();
    const table = await screen.findByRole("table", { name: "Sessions" });
    expect(within(table).getByText("Firefox on macOS", { selector: "td" })).toBeInTheDocument();
    expect(within(table).getByText("Ada's phone")).toBeInTheDocument();
    expect(within(table).getByText("Safari on iOS")).toBeInTheDocument();
    expect(within(table).getAllByText("203.0.113.7")).toHaveLength(2);
    expect(screen.getByText(/also signs the person out of any other workspace/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("signs one session out after confirming", async () => {
    const { calls } = personHandlers({
      "DELETE /api/v1/access/people/{id}/sessions/{sessionId}": () =>
        new Response(null, { status: 204 }),
    });
    await openPerson();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign out Ada's phone" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign out Ada's phone?" });
    await user.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "DELETE" &&
            c.path === `/api/v1/access/people/${W2_ADA_ID}/sessions/${PHONE_ID}`,
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Session signed out")).toBeInTheDocument();
  }, 20_000);

  it("signs the member out everywhere in this workspace", async () => {
    const { calls } = personHandlers({
      "POST /api/v1/access/people/{id}/sessions/revoke": () => [200, { revoked: 2 }],
    });
    await openPerson();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Sign out everywhere in this workspace" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Sign Ada Lovelace out everywhere in this workspace?");
    await user.click(
      within(dialog).getByRole("button", { name: "Sign out everywhere in this workspace" }),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" && c.path === `/api/v1/access/people/${W2_ADA_ID}/sessions/revoke`,
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("2 sessions signed out")).toBeInTheDocument();
  }, 20_000);

  it("sends a stale session through step-up", async () => {
    personHandlers({
      "DELETE /api/v1/access/people/{id}/sessions/{sessionId}": () =>
        apiError(401, "step_up_required", { reason: "fresh" }),
    });
    const r = await openPerson();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign out Ada's phone" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
  }, 20_000);

  it("shows the list without actions to someone without access.manage", async () => {
    personHandlers({}, ["access.read"]);
    await openPerson();
    expect(await screen.findByRole("table", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sign out/u })).toBeNull();
    expect(screen.queryByRole("button", { name: "View as investor" })).toBeNull();
  }, 20_000);

  it("offers no view-as for staff or inactive members", async () => {
    personHandlers({}, undefined, person({ status: "suspended" }));
    await openPerson();
    expect(await screen.findByRole("table", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View as investor" })).toBeNull();
  }, 20_000);
});
