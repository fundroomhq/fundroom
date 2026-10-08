import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateTime } from "../lib/format.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { accessSettings, apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * /admin/access-requests (E3.1): the status tabs over the keyset-paginated queue, the request
 * detail (reason, firm), approving (suggested groups preselected; Rule 506(b) requires the
 * relationship attestation and the server's 422 is shown inline), denying (internal note, the
 * neutral notice toggle), 409 `conflict` inline, and the read-only view without access.manage.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a01";
const BOARD_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a02";
const SEED_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a03";
const ADA_REQ = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a11";
const LINUS_REQ = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a12";
const MARGARET_REQ = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a13";
const DONE_REQ = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a14";
const INVITE_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a21";
const ARCHIVED_GROUP_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a04";
const NOW = "2026-09-20T10:00:00.000Z";

function accessRequest(
  over: Partial<FundRoomSchemas["AccessRequest"]> = {},
): FundRoomSchemas["AccessRequest"] {
  return {
    id: ADA_REQ,
    email: "ada@analytical.test",
    name: "Ada Lovelace",
    firm: "Analytical Ventures",
    reason: "We met at the demo day and would like to follow the round.",
    status: "pending",
    createdAt: NOW,
    verifiedAt: NOW,
    expiresAt: "2026-10-20T10:00:00.000Z",
    suggestedGroupIds: [BOARD_ID],
    autoApproved: false,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    relationship: null,
    inviteId: null,
    membershipId: null,
    ...over,
  };
}

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const ACCESS_MODULE = {
  id: "access",
  version: "0.1.0",
  enabled: true,
  hidden: false,
  readOnly: false,
  flags: {},
  slots: {
    "admin.nav": [
      {
        id: "access-requests",
        label: "Requests",
        to: "/admin/access-requests",
        order: 22,
        icon: "requests",
      },
    ],
  },
};

function handlers(
  over: Record<string, Handler> = {},
  {
    permissions = ["access.read", "access.manage"],
    offeringStatus = "none",
    enabled = true,
  }: {
    permissions?: string[];
    offeringStatus?: "none" | "506b" | "506c";
    enabled?: boolean;
  } = {},
) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        workspace: {
          id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6a99",
          slug: "acme",
          name: "Acme",
          offeringStatus,
          defaultLocale: "en",
        },
        modules: [ACCESS_MODULE],
        permissions,
        membership: { id: OWNER_ID, kind: "staff", role: "owner" },
      }),
    ],
    "GET /api/v1/access/settings": () => [
      200,
      accessSettings({
        requests: {
          enabled,
          autoApproveDomains: [],
          defaultGroupIds: [BOARD_ID],
          pendingExpiryDays: 30,
        },
      }),
    ],
    "GET /api/v1/access/groups": () => [
      200,
      {
        groups: [
          { id: BOARD_ID, name: "Board", kind: "board", memberCount: 1, createdAt: NOW },
          { id: SEED_ID, name: "Seed investors", kind: "round", memberCount: 0, createdAt: NOW },
        ],
      },
    ],
    "GET /api/v1/access/requests": listRequests,
    ...over,
  });
}

function listRequests({ url }: { url: URL }): [number, unknown] {
  const status = url.searchParams.get("status");
  if (status === "pending") {
    return url.searchParams.get("cursor") === "page-2"
      ? [
          200,
          {
            items: [
              accessRequest({
                id: MARGARET_REQ,
                name: "Margaret Hamilton",
                email: "margaret@apollo.test",
                firm: null,
                reason: null,
                suggestedGroupIds: [],
              }),
            ],
            nextCursor: null,
          },
        ]
      : [
          200,
          {
            items: [
              accessRequest(),
              accessRequest({
                id: LINUS_REQ,
                name: "Linus Pauling",
                email: "linus@chem.test",
                firm: "Chem Capital",
              }),
            ],
            nextCursor: "page-2",
          },
        ];
  }
  if (status === "approved") {
    return [
      200,
      {
        items: [
          accessRequest({
            id: DONE_REQ,
            name: "Grace Brewster",
            email: "grace.b@navy.test",
            status: "approved",
            decidedAt: "2026-09-21T09:00:00.000Z",
            decidedBy: { membershipId: OWNER_ID, displayName: "Grace Hopper" },
            decisionNote: "Known from the seed round.",
            relationship: {
              source: "prior_investor",
              establishedAt: "2025-01-15T00:00:00.000Z",
              note: null,
            },
            inviteId: INVITE_ID,
          }),
        ],
        nextCursor: null,
      },
    ];
  }
  return [200, { items: [], nextCursor: null }];
}

async function open() {
  const r = await renderApp("/admin/access-requests");
  expect(
    await screen.findByRole("heading", { name: "Access requests", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

function invite(): FundRoomSchemas["Invite"] {
  return {
    id: INVITE_ID,
    email: "ada@analytical.test",
    kind: "external",
    role: "investor",
    groupIds: [BOARD_ID, SEED_ID],
    status: "pending",
    message: null,
    expiresAt: "2026-10-04T10:00:00.000Z",
    createdAt: NOW,
    invitedBy: OWNER_ID,
    acceptedAt: null,
    acceptedMembershipId: null,
    principalMembershipId: null,
    delegateScope: null,
  };
}

describe("access request queue", () => {
  it("lists pending requests, loads more, opens the detail and switches tabs", async () => {
    const cursors: (string | null)[] = [];
    handlers({
      "GET /api/v1/access/requests": (ctx) => {
        cursors.push(ctx.url.searchParams.get("cursor"));
        return listRequests(ctx);
      },
    });
    const r = await open();
    const user = userEvent.setup();
    expect(await screen.findByRole("tab", { name: "Pending", selected: true })).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Pending" });
    expect(within(table).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(table).getByText("Analytical Ventures")).toBeInTheDocument();
    expect(within(table).getByText("linus@chem.test")).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Expires" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await within(table).findByText("Margaret Hamilton")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Review the request from Ada Lovelace" }));
    const dialog = await screen.findByRole("dialog", { name: "Request from Ada Lovelace" });
    expect(
      within(dialog).getByText("We met at the demo day and would like to follow the round."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Analytical Ventures")).toBeInTheDocument();
    expect(await within(dialog).findByText("Board")).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("tab", { name: "Approved" }));
    const approved = await screen.findByRole("table", { name: "Approved" });
    expect(within(approved).getByText("Grace Brewster")).toBeInTheDocument();
    expect(within(approved).getByRole("columnheader", { name: "Decided" })).toBeInTheDocument();
    expect(within(approved).queryByRole("button", { name: /^Approve/u })).toBeNull();
    await user.click(
      within(approved).getByRole("button", { name: "Review the request from Grace Brewster" }),
    );
    const done = await screen.findByRole("dialog", { name: "Request from Grace Brewster" });
    expect(within(done).getByText("Known from the seed round.")).toBeInTheDocument();
    expect(within(done).getByText(/Existing investor, since/u)).toBeInTheDocument();
    expect(within(done).getByText(/by Grace Hopper/u)).toBeInTheDocument();
    expect(within(done).queryByRole("button", { name: "Approve" })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("tab", { name: "Expired" }));
    expect(await screen.findByText(/No requests have expired/u)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Denied" }));
    expect(await screen.findByText("No requests have been denied.")).toBeInTheDocument();
    // Load more handed the opaque cursor back.
    expect(cursors).toContain("page-2");
  }, 20_000);

  it("says when requests are turned off, with an underlined link to the settings", async () => {
    handlers(
      { "GET /api/v1/access/requests": () => [200, { items: [], nextCursor: null }] },
      {
        enabled: false,
      },
    );
    const r = await open();
    expect(await screen.findByText("Access requests are turned off")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open access settings" });
    expect(link).toHaveAttribute("href", "/admin/settings/access");
    expect(link.className).toMatch(/(^|\s)underline(\s|$)/u);
    expect(await screen.findByText(/No requests are waiting/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("approves with the suggested groups preselected", async () => {
    const { calls } = handlers({
      "POST /api/v1/access/requests/{id}/approve": ({ params }) => [
        200,
        {
          request: accessRequest({
            id: params["id"] ?? ADA_REQ,
            status: "approved",
            decidedAt: NOW,
          }),
          invite: invite(),
          mailSent: true,
        },
      ],
    });
    await open();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Approve the request from Ada Lovelace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Approve Ada Lovelace" });
    const board = await within(dialog).findByRole("checkbox", { name: "Board" });
    expect(board).toBeChecked();
    const seed = within(dialog).getByRole("checkbox", { name: "Seed investors" });
    expect(seed).not.toBeChecked();
    expect(within(dialog).getByText(/Optional\. If you know this person/u)).toBeInTheDocument();
    expect(
      within(dialog).getByText("For your team only. It is never sent to the requester."),
    ).toBeInTheDocument();
    await expectNoA11yViolations(dialog);

    await user.click(seed);
    await user.type(
      within(dialog).getByRole("spinbutton", { name: "Invitation expiry (days)" }),
      "21",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Message to the requester" }),
      "Welcome aboard.",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Internal note" }),
      "Met at demo day.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Approve and invite" }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/approve"))).toBe(true),
    );
    const post = calls.find((c) => c.method === "POST" && c.path.endsWith("/approve"));
    expect(post?.path).toBe(`/api/v1/access/requests/${ADA_REQ}/approve`);
    expect(post?.body).toEqual({
      groupIds: [BOARD_ID, SEED_ID],
      grants: [],
      expiresInDays: 21,
      message: "Welcome aboard.",
      note: "Met at demo day.",
    });
    expect(
      await screen.findByText("Approved. An invitation was sent to ada@analytical.test."),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }, 20_000);

  it("requires the relationship under Rule 506(b) and shows the server's refusal inline", async () => {
    let answer: "refuse" | "conflict" = "refuse";
    const { calls } = handlers(
      {
        "POST /api/v1/access/requests/{id}/approve": () =>
          answer === "refuse"
            ? apiError(422, "relationship_attestation_required")
            : apiError(409, "conflict"),
      },
      { offeringStatus: "506b" },
    );
    await open();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Approve the request from Ada Lovelace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Approve Ada Lovelace" });
    expect(
      within(dialog).getByText(/^Rule 506\(b\): confirm a pre-existing relationship/u),
    ).toBeInTheDocument();
    await expectNoA11yViolations(dialog);

    await user.click(within(dialog).getByRole("button", { name: "Approve and invite" }));
    expect(
      await within(dialog).findByText("Choose how the relationship began."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Enter the date the relationship began.")).toBeInTheDocument();
    const source = within(dialog).getByRole("combobox", { name: /How it began/u });
    expect(source).toHaveAttribute("aria-invalid", "true");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await expectNoA11yViolations(dialog);

    await user.selectOptions(source, "intro");
    const date = within(dialog).getByLabelText(/Established on/u);
    await user.type(date, "2025-03-01");
    await user.click(within(dialog).getByRole("button", { name: "Approve and invite" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      groupIds: [BOARD_ID],
      grants: [],
      relationship: { source: "intro", establishedAt: "2025-03-01T00:00:00.000Z" },
    });
    expect(
      await within(dialog).findByText(/an approval must confirm a pre-existing relationship/u),
    ).toBeInTheDocument();

    answer = "conflict";
    await user.click(within(dialog).getByRole("button", { name: "Approve and invite" }));
    expect(
      await within(dialog).findByText("This request can no longer be decided"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/an approval must confirm/u)).toBeNull();
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("denies with an internal note and without the notice when unticked", async () => {
    const { calls } = handlers({
      "POST /api/v1/access/requests/{id}/deny": ({ params }) => [
        200,
        {
          request: accessRequest({ id: params["id"] ?? ADA_REQ, status: "denied", decidedAt: NOW }),
        },
      ],
    });
    await open();
    const user = userEvent.setup();
    // From the detail, "Deny" switches the same dialog to the deny form.
    await user.click(
      await screen.findByRole("button", { name: "Review the request from Linus Pauling" }),
    );
    const detail = await screen.findByRole("dialog", { name: "Request from Linus Pauling" });
    await user.click(within(detail).getByRole("button", { name: "Deny" }));
    const dialog = await screen.findByRole("dialog", { name: "Deny Linus Pauling" });
    expect(
      within(dialog).getByText(/The note is never sent to the requester/u),
    ).toBeInTheDocument();
    const notify = within(dialog).getByRole("checkbox", {
      name: "Email the requester a neutral notice",
    });
    expect(notify).toBeChecked();
    await expectNoA11yViolations(dialog);

    await user.type(within(dialog).getByRole("textbox", { name: "Internal note" }), "Not a fit.");
    await user.click(notify);
    await user.click(within(dialog).getByRole("button", { name: "Deny request" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/api/v1/access/requests/${LINUS_REQ}/deny`);
    expect(post?.body).toEqual({ note: "Not a fit.", notifyRequester: false });
    expect(await screen.findByText("Request denied.")).toBeInTheDocument();
  }, 20_000);

  it("shows a conflict inline when the request was already decided", async () => {
    handlers({ "POST /api/v1/access/requests/{id}/deny": () => apiError(409, "conflict") });
    await open();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Deny the request from Ada Lovelace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Deny Ada Lovelace" });
    await user.click(within(dialog).getByRole("button", { name: "Deny request" }));
    expect(
      await within(dialog).findByText("This request can no longer be decided"),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  }, 20_000);

  it("is read-only without access.manage and refused without access.read", async () => {
    handlers({}, { permissions: ["access.read"] });
    const r = await open();
    expect(await screen.findByText(/You can review requests/u)).toBeInTheDocument();
    const table = await screen.findByRole("table", { name: "Pending" });
    expect(within(table).queryByRole("button", { name: /^Approve/u })).toBeNull();
    expect(within(table).queryByRole("button", { name: /^Deny/u })).toBeNull();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(
      within(table).getByRole("button", { name: "Review the request from Ada Lovelace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Request from Ada Lovelace" });
    expect(within(dialog).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Deny" })).toBeNull();
    r.unmount();

    const { calls } = handlers({}, { permissions: [] });
    await renderApp("/admin/access-requests");
    expect(
      await screen.findByText(
        "Only staff who can see people and access can see access requests.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/v1/access/requests")).toBe(false);
  }, 20_000);
  it("warns when the invitation mail failed, and reloads the queue after any answer", async () => {
    let answer: "mail_failed" | "invite_pending" | "conflict" = "invite_pending";
    const listed: number[] = [];
    let listCalls = 0;
    const { calls } = handlers({
      "GET /api/v1/access/requests": (ctx) => {
        if (ctx.url.searchParams.get("status") === "pending") listCalls++;
        return listRequests(ctx);
      },
      "POST /api/v1/access/requests/{id}/approve": () =>
        answer === "invite_pending"
          ? apiError(409, "conflict", { reason: "invite_pending" })
          : answer === "conflict"
            ? apiError(409, "conflict")
            : [
                200,
                {
                  request: accessRequest({ status: "approved", decidedAt: NOW }),
                  invite: invite(),
                  mailSent: false,
                },
              ],
    });
    await open();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Approve the request from Ada Lovelace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Approve Ada Lovelace" });
    await within(dialog).findByRole("checkbox", { name: "Board" });
    listed.push(listCalls);

    // A pending invitation for the address: said inline, in words the admin can act on.
    await user.click(within(dialog).getByRole("button", { name: "Approve and invite" }));
    expect(
      await within(dialog).findByText("An invitation is already waiting for this address"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("This request can no longer be decided")).toBeNull();
    await expectNoA11yViolations(dialog);
    // The refusal still reloads the queue.
    await waitFor(() => expect(listCalls).toBeGreaterThan(listed[0] ?? 0));
    listed.push(listCalls);

    answer = "conflict";
    await user.click(within(dialog).getByRole("button", { name: "Approve and invite" }));
    expect(
      await within(dialog).findByText("This request can no longer be decided"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/already waiting for this address/u)).toBeNull();
    await waitFor(() => expect(listCalls).toBeGreaterThan(listed[1] ?? 0));

    answer = "mail_failed";
    await user.click(within(dialog).getByRole("button", { name: "Approve and invite" }));
    expect(
      await screen.findByText(
        "Approved, but the invitation email could not be sent — resend it from People → Invites.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(3);
  }, 20_000);

  it("reloads the queue after a refused denial", async () => {
    let listCalls = 0;
    handlers({
      "GET /api/v1/access/requests": (ctx) => {
        if (ctx.url.searchParams.get("status") === "pending") listCalls++;
        return listRequests(ctx);
      },
      "POST /api/v1/access/requests/{id}/deny": () => apiError(409, "conflict"),
    });
    await open();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Deny the request from Ada Lovelace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Deny Ada Lovelace" });
    const before = listCalls;
    await user.click(within(dialog).getByRole("button", { name: "Deny request" }));
    expect(
      await within(dialog).findByText("This request can no longer be decided"),
    ).toBeInTheDocument();
    await waitFor(() => expect(listCalls).toBeGreaterThan(before));
  }, 20_000);

  it("keeps the explanation open when a refused request has left the queue", async () => {
    let decided = false;
    handlers({
      "GET /api/v1/access/requests": (ctx) =>
        decided && ctx.url.searchParams.get("status") === "pending"
          ? [200, { items: [], nextCursor: null }]
          : listRequests(ctx),
      "POST /api/v1/access/requests/{id}/deny": () => {
        decided = true;
        return apiError(409, "conflict");
      },
    });
    await open();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Deny the request from Ada Lovelace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Deny Ada Lovelace" });
    await user.click(within(dialog).getByRole("button", { name: "Deny request" }));
    // The reload empties the pending tab, but the dialog and its explanation stay.
    expect(await screen.findByText(/No requests are waiting/u)).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).getByText("This request can no longer be decided"),
    ).toBeInTheDocument();
  }, 20_000);

  it("offers and sends only suggested groups that still exist, once the groups have loaded", async () => {
    let releaseGroups: () => void = () => {};
    const groupsLoaded = new Promise<void>((resolve) => {
      releaseGroups = resolve;
    });
    const { calls } = handlers({
      "GET /api/v1/access/requests": (ctx) =>
        ctx.url.searchParams.get("status") === "pending"
          ? [
              200,
              {
                items: [accessRequest({ suggestedGroupIds: [BOARD_ID, ARCHIVED_GROUP_ID] })],
                nextCursor: null,
              },
            ]
          : listRequests(ctx),
      "GET /api/v1/access/groups": async () => {
        await groupsLoaded;
        return new Response(
          JSON.stringify({
            groups: [
              { id: BOARD_ID, name: "Board", kind: "board", memberCount: 1, createdAt: NOW },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      "POST /api/v1/access/requests/{id}/approve": () => [
        200,
        {
          request: accessRequest({ status: "approved", decidedAt: NOW }),
          invite: invite(),
          mailSent: true,
        },
      ],
    });
    await open();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Approve the request from Ada Lovelace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Approve Ada Lovelace" });
    // The groups are not known yet, so approving waits for them.
    const submit = within(dialog).getByRole("button", { name: "Approve and invite" });
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    releaseGroups();
    expect(await within(dialog).findByRole("checkbox", { name: "Board" })).toBeChecked();
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      groupIds: [BOARD_ID],
      grants: [],
    });
  }, 20_000);

  it("does not accept a relationship that begins in the future", async () => {
    handlers({}, { offeringStatus: "506b" });
    await open();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Approve the request from Ada Lovelace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Approve Ada Lovelace" });
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    expect(within(dialog).getByLabelText(/Established on/u)).toHaveAttribute("max", today);
  }, 20_000);

  it("dates an expired request by when it was closed, else by its expiry", async () => {
    const CLOSED_AT = "2026-09-22T08:30:00.000Z";
    const RAN_OUT = "2026-09-18T10:00:00.000Z";
    handlers({
      "GET /api/v1/access/requests": (ctx) =>
        ctx.url.searchParams.get("status") === "expired"
          ? [
              200,
              {
                items: [
                  accessRequest({
                    status: "expired",
                    expiresAt: "2026-10-20T10:00:00.000Z",
                    decidedAt: CLOSED_AT,
                  }),
                  accessRequest({
                    id: LINUS_REQ,
                    name: "Linus Pauling",
                    status: "expired",
                    expiresAt: RAN_OUT,
                  }),
                ],
                nextCursor: null,
              },
            ]
          : listRequests(ctx),
    });
    await open();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Expired" }));
    const table = await screen.findByRole("table", { name: "Expired" });
    expect(within(table).getByText(formatDateTime(CLOSED_AT))).toBeInTheDocument();
    expect(within(table).getByText(formatDateTime(RAN_OUT))).toBeInTheDocument();
    expect(within(table).queryByText(formatDateTime("2026-10-20T10:00:00.000Z"))).toBeNull();

    await user.click(
      within(table).getByRole("button", { name: "Review the request from Ada Lovelace" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Request from Ada Lovelace" });
    expect(within(dialog).getByText(formatDateTime(CLOSED_AT))).toBeInTheDocument();
    expect(within(dialog).queryByText(formatDateTime("2026-10-20T10:00:00.000Z"))).toBeNull();
  }, 20_000);

  it("moves focus to the new heading when the dialog switches from the detail", async () => {
    handlers();
    await open();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Review the request from Linus Pauling" }),
    );
    const detail = await screen.findByRole("dialog", { name: "Request from Linus Pauling" });
    await user.click(within(detail).getByRole("button", { name: "Deny" }));
    const heading = await screen.findByRole("heading", { name: "Deny Linus Pauling" });
    await waitFor(() => expect(heading).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Review the request from Ada Lovelace" }));
    const detail2 = await screen.findByRole("dialog", { name: "Request from Ada Lovelace" });
    await user.click(within(detail2).getByRole("button", { name: "Approve" }));
    const approveHeading = await screen.findByRole("heading", { name: "Approve Ada Lovelace" });
    await waitFor(() => expect(approveHeading).toHaveFocus());
  }, 20_000);
});
