import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

/*
 * Delegates (E3.2): the investor's own settings page and the admin People detail. The server owns
 * every rule (policy, limit, who may add); these screens render its answer, send what the form says
 * and say why the form is closed when it is.
 */
const NOW = "2026-09-25T10:00:00.000Z";
const DAN = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01";
const INVITE = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d02";
const PAT = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d03";
const OWNER = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d04";

function list(
  over: Partial<FundRoomSchemas["DelegateList"]> = {},
): FundRoomSchemas["DelegateList"] {
  return {
    delegates: [
      {
        kind: "member",
        id: DAN,
        email: "dan@helper.test",
        displayName: "Dan Helper",
        scope: "data_room",
        status: "active",
        createdAt: NOW,
        expiresAt: null,
        lastSeenAt: NOW,
      },
      {
        kind: "invite",
        id: INVITE,
        email: "uma@helper.test",
        displayName: "",
        scope: "updates",
        status: "pending",
        createdAt: NOW,
        expiresAt: "2026-10-02T10:00:00.000Z",
        lastSeenAt: null,
      },
    ],
    limit: 3,
    selfService: true,
    ...over,
  };
}

function investorHandlers() {
  return {
    "GET /api/v1/me": () => [200, me()] as [number, unknown],
    "GET /api/v1/modules": () => [200, bootstrap()] as [number, unknown],
  };
}

describe("portal: my delegates", () => {
  it("lists delegates, adds one with a scope, and removes one after confirming", async () => {
    let added: unknown;
    let removed = "";
    installMockApi({
      ...investorHandlers(),
      "GET /api/v1/access/my/delegates": () => [200, list()],
      // F1: the self-service add answers the same `202 {status: "sent"}` for every address.
      "POST /api/v1/access/my/delegates": ({ body }) => {
        added = body;
        return [202, { status: "sent" }];
      },
      "DELETE /api/v1/access/my/delegates/{id}": ({ params }) => {
        removed = params["id"] ?? "";
        return [200, { ok: true }];
      },
    });
    const r = await renderApp("/settings/delegates");
    const user = userEvent.setup();
    expect(await screen.findByText("dan@helper.test", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Delegates" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("cell", { name: "Data room only" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "uma@helper.test" })).toBeInTheDocument();
    expect(screen.getByText("1 of 3 left.")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.type(screen.getByLabelText(/Email address/u), "al@helper.test");
    await user.click(screen.getByLabelText("Updates only"));
    await user.click(screen.getByRole("button", { name: "Invite delegate" }));
    await waitFor(() => expect(added).toEqual({ email: "al@helper.test", scope: "updates" }));
    // It does not claim an invitation went out: the address may already be a member.
    expect(
      await screen.findByText(/If al@helper\.test can be invited, an invitation is on its way/u),
    ).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /^Remove\s*Dan Helper$/u }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Remove Dan Helper?")).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removed).toBe(DAN));
  }, 20_000);

  it("says why the form is closed when the workspace does not allow delegates", async () => {
    installMockApi({
      ...investorHandlers(),
      "GET /api/v1/access/my/delegates": () => [200, list({ selfService: false })],
    });
    const r = await renderApp("/settings/delegates");
    expect(
      await screen.findByText(/does not let investors add delegates/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite delegate" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/u })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows the limit instead of the form when it is reached, and the server's refusal", async () => {
    installMockApi({
      ...investorHandlers(),
      "GET /api/v1/access/my/delegates": () => [200, list({ limit: 2 })],
    });
    await renderApp("/settings/delegates");
    expect(
      await screen.findByText(/The limit of 2 delegates is reached/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Email address/u)).toBeNull();
  }, 20_000);

  it("renders the server's refusal on add", async () => {
    installMockApi({
      ...investorHandlers(),
      "GET /api/v1/access/my/delegates": () => [200, list({ delegates: [] })],
      "POST /api/v1/access/my/delegates": () => apiError(409, "delegate_limit_reached"),
    });
    await renderApp("/settings/delegates");
    const user = userEvent.setup();
    expect(await screen.findByText("No delegates yet.", {}, { timeout: 5000 })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Email address/u), "x@helper.test");
    await user.click(screen.getByRole("button", { name: "Invite delegate" }));
    expect(await screen.findByText("No delegates left")).toBeInTheDocument();
  }, 20_000);

  it("staff and delegates see no Delegates tab", async () => {
    installMockApi({
      ...investorHandlers(),
      "GET /api/v1/modules": () => [
        200,
        bootstrap({ membership: { id: DAN, kind: "external", role: "delegate" } }),
      ],
    });
    await renderApp("/settings");
    expect(await screen.findByRole("link", { name: "Security" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Delegates" })).toBeNull();
  }, 20_000);
});

function person(over: Partial<FundRoomSchemas["Person"]> = {}): FundRoomSchemas["Person"] {
  return {
    membershipId: PAT,
    userId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d10",
    kind: "external",
    role: "investor",
    status: "active",
    displayName: "Pat Principal",
    email: "pat@fund.test",
    groups: [],
    profile: { firm: "Fund LP" },
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

const dan = person({
  membershipId: DAN,
  role: "delegate",
  displayName: "Dan Helper",
  email: "dan@helper.test",
  profile: {},
  principalMembershipId: PAT,
  delegateScope: "data_room",
  principal: { membershipId: PAT, displayName: "Pat Principal", firm: "Fund LP" },
});

function staffHandlers() {
  return {
    "GET /api/v1/me": () =>
      [
        200,
        me({
          session: session({
            population: "staff",
            authLevel: 2,
            user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
          }),
          membership: membership({ id: OWNER, kind: "staff", role: "owner" }),
        }),
      ] as [number, unknown],
    "GET /api/v1/modules": () =>
      [
        200,
        bootstrap({
          permissions: ["access.read", "access.manage", "access.manage_staff"],
          membership: { id: OWNER, kind: "staff", role: "owner" },
        }),
      ] as [number, unknown],
    "GET /api/v1/access/groups": () => [200, { groups: [] }] as [number, unknown],
    "GET /api/v1/access/people/{id}/sessions": () => [200, { sessions: [] }] as [number, unknown],
  };
}

describe("admin: People detail", () => {
  it("adds a delegate for an investor and lists theirs", async () => {
    let added: unknown;
    installMockApi({
      ...staffHandlers(),
      "GET /api/v1/access/people/{id}": () => [
        200,
        { person: person(), delegates: [dan], attestations: [], grants: [] },
      ],
      "GET /api/v1/access/people/{id}/delegates": () => [200, list({ selfService: false })],
      "POST /api/v1/access/people/{id}/delegates": ({ params, body }) => {
        expect(params["id"]).toBe(PAT);
        added = body;
        return [200, list()];
      },
    });
    const r = await renderApp(`/admin/people/${PAT}`);
    const user = userEvent.setup();
    expect(
      await screen.findByRole("heading", { name: "Pat Principal" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Admins act whatever the self-service policy says.
    const add = await screen.findByRole("button", { name: "Invite delegate" }, { timeout: 5000 });
    // The delegate under the principal reads "Dan Helper (for Fund LP — Pat Principal)".
    expect(
      screen.getByRole("link", { name: "Dan Helper (for Fund LP — Pat Principal)" }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    await user.type(screen.getByLabelText(/Email address/u), "al@helper.test");
    await user.type(screen.getByLabelText(/Name \(optional\)/u), "Al");
    await user.click(screen.getByLabelText("Everything"));
    await user.click(add);
    await waitFor(() =>
      expect(added).toEqual({ email: "al@helper.test", scope: "all", displayName: "Al" }),
    );
  }, 20_000);

  it("shows who a delegate acts for, and no delegates card of its own", async () => {
    installMockApi({
      ...staffHandlers(),
      "GET /api/v1/access/people/{id}": () => [
        200,
        { person: dan, delegates: [], attestations: [], grants: [] },
      ],
    });
    const r = await renderApp(`/admin/people/${DAN}`);
    expect(
      await screen.findByRole(
        "heading",
        { name: "Dan Helper (for Fund LP — Pat Principal)" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Acts for")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pat Principal (Fund LP)" })).toHaveAttribute(
      "href",
      `/admin/people/${PAT}`,
    );
    expect(screen.queryByRole("button", { name: "Invite delegate" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
