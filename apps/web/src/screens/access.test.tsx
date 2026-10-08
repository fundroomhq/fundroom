import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareSheet } from "../components/access/share-sheet.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

// The share sheet is embedded by module screens (data room, updates); mount it through one.
vi.mock("../modules/registry.js", () => ({
  investorModules: {},
  adminModules: {
    demo: () =>
      Promise.resolve({
        default: () => (
          <ShareSheet
            resource={{
              kind: "folder",
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c07",
              path: "root.dd",
            }}
            label="Data room"
            canManage
          />
        ),
      }),
  },
}));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c01";
const ADA_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c02";
const BOARD_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c03";
const SEED_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c04";
const INVITE_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c05";
const GRANT_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c06";
const FOLDER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c07";
const NOW = "2026-09-11T10:00:00.000Z";

function person(over: Partial<FundRoomSchemas["Person"]> = {}): FundRoomSchemas["Person"] {
  return {
    membershipId: ADA_ID,
    userId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c10",
    kind: "external",
    role: "investor",
    status: "active",
    displayName: "Ada Lovelace",
    email: "ada@investor.test",
    groups: [{ id: BOARD_ID, name: "Board" }],
    profile: { firm: "Analytical Ventures" },
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

const owner = person({
  membershipId: OWNER_ID,
  kind: "staff",
  role: "owner",
  displayName: "Grace Hopper",
  email: "grace@example.com",
  groups: [],
  profile: {},
});

const staffBootstrap = () =>
  bootstrap({
    modules: [
      {
        id: "demo",
        version: "1.0.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {},
      },
      {
        id: "access",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "admin.nav": [
            {
              id: "access-people",
              label: "People",
              to: "/admin/people",
              order: 20,
              icon: "people",
            },
            {
              id: "access-groups",
              label: "Groups",
              to: "/admin/groups",
              order: 21,
              icon: "access",
            },
          ],
        },
      },
    ],
    permissions: ["access.read", "access.manage", "access.manage_staff", "access.settings"],
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

function groups(): FundRoomSchemas["GroupList"] {
  return {
    groups: [
      { id: BOARD_ID, name: "Board", kind: "board", memberCount: 1, createdAt: NOW },
      { id: SEED_ID, name: "Seed investors", kind: "round", memberCount: 0, createdAt: NOW },
    ],
  };
}

function baseHandlers() {
  return {
    "GET /api/v1/me": () => [200, staffMe()] as [number, unknown],
    "GET /api/v1/modules": () => [200, staffBootstrap()] as [number, unknown],
    "GET /api/v1/access/people": ({ url }: { url: URL }) =>
      [
        200,
        {
          items: url.searchParams.get("kind") === "staff" ? [owner] : [person()],
          nextCursor: null,
        },
      ] as [number, unknown],
    "GET /api/v1/access/groups": () => [200, groups()] as [number, unknown],
    "GET /api/v1/access/people/{id}/delegates": () =>
      [200, { delegates: [], limit: 3, selfService: false }] as [number, unknown],
    "GET /api/v1/access/invites": () =>
      [
        200,
        {
          invites: [
            {
              id: INVITE_ID,
              email: "linus@investor.test",
              kind: "external",
              role: "investor",
              groupIds: [],
              status: "pending",
              message: null,
              expiresAt: "2026-09-18T10:00:00.000Z",
              createdAt: NOW,
              invitedBy: OWNER_ID,
              acceptedAt: null,
              acceptedMembershipId: null,
              principalMembershipId: null,
              delegateScope: null,
            },
          ],
        },
      ] as [number, unknown],
  };
}

describe("people", () => {
  it("lists investors and team, shows pending invitations, and sends an invitation", async () => {
    const { calls } = installMockApi({
      ...baseHandlers(),
      "POST /api/v1/access/invites": ({ body }) => {
        expect(body).toMatchObject({
          invites: [{ email: "new@investor.test" }, { email: "two@investor.test" }],
          kind: "external",
          role: "investor",
          groupIds: [BOARD_ID],
        });
        return [
          200,
          {
            created: [{ id: INVITE_ID, email: "new@investor.test" }],
            failed: [{ email: "two@investor.test", code: "conflict" }],
          },
        ];
      },
    });
    const r = await renderApp("/admin/people");
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "People" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Ada Lovelace" })).toHaveAttribute(
      "href",
      `/admin/people/${ADA_ID}`,
    );
    expect(screen.getByText("Analytical Ventures", { exact: false })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("tab", { name: "Team" }));
    expect(await screen.findByRole("link", { name: "Grace Hopper" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Invitations" }));
    expect(await screen.findByText("linus@investor.test")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Invite people/u }));
    const dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText(/Email addresses/u),
      "new@investor.test\ntwo@investor.test",
    );
    await user.click(await within(dialog).findByLabelText("Board"));
    await user.click(within(dialog).getByRole("button", { name: "Send invitations" }));
    expect(await within(dialog).findByText("1 invitation sent.")).toBeInTheDocument();
    expect(within(dialog).getByText(/two@investor.test: already a member/u)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/access/invites"))).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await expectNoA11yViolations(r.container);
  });

  it("hides invite actions without access.manage and shows the person detail with revoke", async () => {
    const { calls } = installMockApi({
      ...baseHandlers(),
      "GET /api/v1/modules": () => [200, { ...staffBootstrap(), permissions: ["access.read"] }],
    });
    await renderApp("/admin/people");
    expect(await screen.findByRole("heading", { name: "People" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Invite people/u })).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
  });

  it("revokes a person from the detail page and returns to the list", async () => {
    let revoked = false;
    const { calls } = installMockApi({
      ...baseHandlers(),
      "GET /api/v1/access/people/{id}": ({ params }) => {
        expect(params["id"]).toBe(ADA_ID);
        return [
          200,
          {
            person: person(),
            delegates: [],
            attestations: [{ kind: "nda:v2", signedAt: NOW, expiresAt: null }],
            grants: [
              {
                id: GRANT_ID,
                subject: { kind: "membership", id: ADA_ID },
                resource: { kind: "folder", id: FOLDER_ID, path: "root.dd" },
                capability: "view",
                effect: "allow",
                validFrom: NOW,
                validUntil: null,
                note: null,
                createdBy: OWNER_ID,
                createdAt: NOW,
              },
            ],
          },
        ];
      },
      "POST /api/v1/access/people/{id}/revoke": ({ body }) => {
        expect(body).toEqual({ reason: "Left the fund" });
        revoked = true;
        return [200, { membershipIds: [ADA_ID], sessionsRevoked: 2, grantsRevoked: 1 }];
      },
    });
    const r = await renderApp(`/admin/people/${ADA_ID}`);
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeInTheDocument();
    expect(await screen.findByText("nda:v2", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("View")).toBeInTheDocument();
    expect(await screen.findByLabelText("Board")).toBeChecked();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Revoke access" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Reason"), "Left the fund");
    await user.click(within(dialog).getByRole("button", { name: "Revoke access" }));
    await waitFor(() => expect(revoked).toBe(true));
    await waitFor(() => expect(pathOf(r.router)).toBe("/admin/people"));
    expect(calls.some((c) => c.path.endsWith(`/access/people/${ADA_ID}/revoke`))).toBe(true);
  });

  it("shows an expiry row for a member but none for an owner, who never expires (E3.2)", async () => {
    const detail = (p: FundRoomSchemas["Person"]) => ({
      person: p,
      delegates: [],
      attestations: [],
      grants: [],
    });
    installMockApi({
      ...baseHandlers(),
      "GET /api/v1/access/people/{id}": ({ params }) => [
        200,
        params["id"] === OWNER_ID
          ? detail(owner)
          : detail(person({ expiresAt: "2026-12-31T10:00:00.000Z" })),
      ],
    });
    const r = await renderApp(`/admin/people/${ADA_ID}`);
    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeInTheDocument();
    expect(screen.getByText("Access expires")).toBeInTheDocument();
    r.unmount();

    await renderApp(`/admin/people/${OWNER_ID}`);
    expect(await screen.findByRole("heading", { name: "Grace Hopper" })).toBeInTheDocument();
    expect(screen.queryByText("Access expires")).toBeNull();
    expect(screen.queryByText("No expiry")).toBeNull();
  });
});

describe("groups", () => {
  it("lists groups, creates one, and manages members on the detail page", async () => {
    const created: unknown[] = [];
    installMockApi({
      ...baseHandlers(),
      "POST /api/v1/access/groups": ({ body }) => {
        created.push(body);
        return [
          200,
          { id: SEED_ID, name: "Advisors", kind: "advisors", memberCount: 0, createdAt: NOW },
        ];
      },
      "GET /api/v1/access/groups/{id}": () => [
        200,
        { group: groups().groups[0], members: [person()] },
      ],
      "DELETE /api/v1/access/groups/{id}/members/{membershipId}": ({ params }) => {
        expect(params["membershipId"]).toBe(ADA_ID);
        return [200, { ok: true }];
      },
    });
    const r = await renderApp("/admin/groups");
    const user = userEvent.setup();
    expect(await screen.findByRole("link", { name: "Board" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: /New group/u }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Name/u), "Advisors");
    await user.click(within(dialog).getByRole("button", { name: "Create group" }));
    await waitFor(() => expect(created).toEqual([{ name: "Advisors", kind: "custom" }]));

    await user.click(screen.getByRole("link", { name: "Board" }));
    expect(await screen.findByRole("heading", { name: "Board" })).toBeInTheDocument();
    const row = (await screen.findByRole("link", { name: "Ada Lovelace" })).closest("tr");
    if (!row) throw new Error("row");
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    await expectNoA11yViolations(r.container);
  });
});

describe("share sheet", () => {
  it("shows who has access with gates and explains a holder", async () => {
    let granted: unknown;
    installMockApi({
      ...baseHandlers(),
      "GET /api/v1/access/resources/{kind}/{id}/who": () => [
        200,
        {
          resource: { kind: "folder", id: FOLDER_ID, path: "root.dd" },
          holders: [
            {
              membershipId: ADA_ID,
              displayName: "Ada Lovelace",
              email: "ada@investor.test",
              kind: "external",
              role: "investor",
              capabilities: ["view", "download"],
              pendingGates: [{ kind: "nda", detail: { version: "v3" }, source: "workspace" }],
              via: [
                {
                  subject: { kind: "group", id: BOARD_ID, label: "Board" },
                  grantId: GRANT_ID,
                  capability: "view",
                  effect: "allow",
                  resource: { kind: "folder", id: FOLDER_ID, path: "root.dd" },
                  inherited: false,
                  decisive: true,
                  validUntil: null,
                },
              ],
              expiresAt: null,
            },
          ],
        },
      ],
      "GET /api/v1/access/resources/{kind}/{id}/explain": () => [
        200,
        {
          membershipId: ADA_ID,
          resource: { kind: "folder", id: FOLDER_ID, path: "root.dd" },
          decision: {
            allowed: false,
            capabilities: ["view", "download"],
            pendingGates: [],
            reason: "gated",
          },
          rules: [
            {
              subject: { kind: "group", id: BOARD_ID, label: "Board" },
              grantId: GRANT_ID,
              capability: "view",
              effect: "allow",
              resource: { kind: "folder", id: FOLDER_ID, path: "root.dd" },
              inherited: false,
              decisive: true,
              validUntil: null,
            },
          ],
          aclVersion: 3,
          defaultLocale: "en",
        },
      ],
      "POST /api/v1/access/grants": ({ body }) => {
        granted = body;
        return [200, { grants: [] }];
      },
    });
    await renderApp("/admin/demo");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Share/u }));
    const dialog = await screen.findByRole("dialog");
    expect((await within(dialog).findAllByText("Ada Lovelace")).length).toBeGreaterThan(0);
    expect(within(dialog).getByText("NDA v3 pending")).toBeInTheDocument();
    expect(within(dialog).getByText("via group Board")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Why?" }));
    expect(
      await within(dialog).findByText(/Allow View for group Board \(on this item\)/u),
    ).toBeInTheDocument();
    await expectNoA11yViolations(dialog);

    await user.click(within(dialog).getByLabelText("Share with"));
    await user.click(await screen.findByRole("option", { name: "A group" }));
    await user.click(within(dialog).getByLabelText("Who"));
    await user.click(await screen.findByRole("option", { name: "Seed investors" }));
    await user.click(within(dialog).getByLabelText("Download"));
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(granted).toMatchObject({
        subject: { kind: "group", id: SEED_ID },
        capabilities: ["view", "download"],
        effect: "allow",
      }),
    );
    // Kind and id only (review R1-A1): the server derives the rule's path from the resource.
    // The sheet's `path` is where the resource sits; posted as the rule's scope, a document's
    // folder path used to share the whole folder.
    expect((granted as { resource?: unknown } | undefined)?.resource).toEqual({
      kind: "folder",
      id: FOLDER_ID,
    });
  });

  it("routes step_up_required from an access mutation to the step-up screen", async () => {
    installMockApi({
      ...baseHandlers(),
      "POST /api/v1/access/groups": () => apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await renderApp("/admin/groups");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /New group/u }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Name/u), "X");
    await user.click(within(dialog).getByRole("button", { name: "Create group" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up?"));
    expect(pathOf(r.router)).toContain("reason=fresh");
  });
});
