import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { analyticsEmailEngagement, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

const POST_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const SEND_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f02";
const VERSION_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f03";
const BOARD_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f04";
const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f05";
const INVESTOR_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f06";
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
const staffBootstrap = () =>
  bootstrap({
    permissions: ["updates.read", "updates.manage", "updates.send", "updates.settings"],
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

function send(over: Partial<FundRoomSchemas["UpdateSend"]> = {}): FundRoomSchemas["UpdateSend"] {
  return {
    id: SEND_ID,
    kind: "live",
    status: "finished",
    total: 3,
    sent: 2,
    failed: 0,
    skipped: 1,
    delivered: 1,
    bounced: 1,
    complained: 0,
    error: null,
    versionId: VERSION_ID,
    requestedBy: OWNER_ID,
    startedAt: NOW,
    finishedAt: NOW,
    createdAt: NOW,
    ...over,
  };
}

function post(over: Partial<FundRoomSchemas["UpdatePost"]> = {}): FundRoomSchemas["UpdatePost"] {
  return {
    id: POST_ID,
    slug: "september-2026-update",
    title: "September 2026 update",
    state: "draft",
    audience: { kind: "all" },
    templateKey: "yc",
    scheduledFor: null,
    sentAt: null,
    publishedVersionNo: null,
    savedAt: NOW,
    authorMembershipId: OWNER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    lastSend: null,
    ...over,
  };
}

function detail(
  over: Partial<FundRoomSchemas["UpdatePostDetail"]> = {},
): FundRoomSchemas["UpdatePostDetail"] {
  return {
    post: post(),
    doc: {
      sections: [
        {
          key: "recap",
          title: "TL;DR",
          blocks: [
            {
              id: "recap-text",
              type: "rich_text",
              schemaVersion: 1,
              data: { format: "markdown", text: "We closed **three** customers." },
            },
          ],
        },
        {
          key: "board",
          title: "Board only",
          blocks: [
            {
              id: "board-text",
              type: "rich_text",
              schemaVersion: 1,
              data: { format: "markdown", text: "Confidential." },
            },
          ],
        },
      ],
    },
    visibility: {
      recap: { mode: "authenticated" },
      board: { mode: "groups", groupIds: [BOARD_ID] },
    },
    groups: [{ id: BOARD_ID, name: "Board" }],
    versions: [],
    ...over,
  };
}

function archivePage(): FundRoomSchemas["UpdateArchivePage"] {
  return {
    post: {
      id: POST_ID,
      slug: "september-2026-update",
      title: "September 2026 update",
      sentAt: NOW,
      versionNo: 1,
    },
    version: { id: VERSION_ID, versionNo: 1, createdAt: NOW },
    sections: [
      {
        key: "recap",
        title: "TL;DR",
        blocks: [
          {
            id: "recap-text",
            type: "rich_text",
            schemaVersion: 1,
            data: {
              format: "markdown",
              text: "We closed **three** customers. <script>alert(1)</script>",
            },
          },
          // The archive uses the same BlockView as the overview page, so a disclaimer on an
          // update renders there with the version the reader was shown (E1.6).
          {
            id: "legal",
            type: "disclaimer",
            schemaVersion: 1,
            data: {
              slug: "offering-disclaimer",
              hydrated: {
                slug: "offering-disclaimer",
                title: "Offering disclaimer",
                versionNo: 3,
                body: "This is not an offer of securities.",
                effectiveAt: NOW,
              },
            },
          },
        ],
      },
    ],
    viewer: "external",
  };
}

describe("investor updates", () => {
  it("lists the archive, toggles email preference and opens an update", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, me({ membership: membership({ id: INVESTOR_ID }) })],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/updates/archive": () => [
        200,
        {
          posts: [
            {
              id: POST_ID,
              slug: "september-2026-update",
              title: "September 2026 update",
              sentAt: NOW,
              versionNo: 1,
            },
          ],
          subscribed: true,
        },
      ],
      "PUT /api/v1/updates/subscription": () => [200, { subscribed: false }],
      "GET /api/v1/updates/archive/{slug}": () => [200, archivePage()],
      "GET /api/v1/updates/posts/{id}/replies": () => [
        200,
        {
          threads: [
            {
              membershipId: INVESTOR_ID,
              displayName: "Ada",
              replies: [
                {
                  id: "r1",
                  authorMembershipId: INVESTOR_ID,
                  authorName: "Ada",
                  authorKind: "external",
                  body: "Congrats!",
                  createdAt: NOW,
                },
                {
                  id: "r2",
                  authorMembershipId: OWNER_ID,
                  authorName: "Grace",
                  authorKind: "staff",
                  body: "Thank you",
                  createdAt: NOW,
                },
              ],
            },
          ],
        },
      ],
      "POST /api/v1/updates/posts/{id}/replies": () => [
        201,
        {
          id: "r3",
          authorMembershipId: INVESTOR_ID,
          authorName: "Ada",
          authorKind: "external",
          body: "Happy to intro",
          createdAt: NOW,
        },
      ],
    });
    const r = await renderApp("/updates");
    expect(await screen.findByRole("link", { name: "September 2026 update" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: /Send me investor updates by email/u }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "PUT" && c.path === "/api/v1/updates/subscription"),
      ).toBe(true),
    );
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ subscribed: false });
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("link", { name: "September 2026 update" }));
    expect(
      await screen.findByRole("heading", { name: "September 2026 update" }),
    ).toBeInTheDocument();
    expect(screen.getByText("three")).toBeInTheDocument();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/u)).toBeInTheDocument();
    expect(screen.getByText("Offering disclaimer · v3")).toBeInTheDocument();
    expect(r.container.querySelector("script")).toBeNull();
    expect(await screen.findByText("Congrats!")).toBeInTheDocument();
    expect(screen.getByText("Thank you")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Your reply"), "Happy to intro");
    await user.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.method === "POST" && c.path === `/api/v1/updates/posts/${POST_ID}/replies`,
        )?.body,
      ).toEqual({ body: "Happy to intro" }),
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("redeems an unsubscribe token without a session", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [401, { error: { code: "unauthenticated", message: "no" } }],
      "POST /api/v1/updates/unsubscribe": () => [
        200,
        { ok: true, email: "a***@investor.test", alreadyUnsubscribed: false },
      ],
    });
    const r = await renderApp("/unsubscribe?token=abc.def");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "a***@investor.test will no longer receive investor updates by email.",
    );
    expect(calls.find((c) => c.method === "POST")?.path).toBe("/api/v1/updates/unsubscribe");
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("updates admin", () => {
  it("lists updates with state and delivery, and creates one from a template", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap()],
      "GET /api/v1/updates/posts": () => [
        200,
        {
          posts: [
            post({ state: "sent", sentAt: NOW, publishedVersionNo: 1, lastSend: send() }),
            post({
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f09",
              title: "Draft note",
              slug: "draft-note",
            }),
          ],
        },
      ],
      "GET /api/v1/updates/templates": () => [
        200,
        {
          templates: [
            { key: "yc", name: "YC monthly update", description: "Recap…", doc: { sections: [] } },
            { key: "blank", name: "Blank", description: "Empty", doc: { sections: [] } },
          ],
        },
      ],
      "POST /api/v1/updates/posts": () => [
        201,
        detail({ post: post({ id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f10", title: "October" }) }),
      ],
      "GET /api/v1/updates/posts/{id}": () => [
        200,
        detail({ post: post({ id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f10", title: "October" }) }),
      ],
      "GET /api/v1/updates/posts/{id}/sends": () => [200, { sends: [] }],
      "GET /api/v1/updates/posts/{id}/replies": () => [200, { threads: [] }],
    });
    const r = await renderApp("/admin/updates");
    expect(
      await screen.findByRole("link", { name: "September 2026 update" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 of 3 delivered")).toBeInTheDocument();
    expect(screen.getByText("Sent")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New update" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Title/u), "October");
    await user.click(await within(dialog).findByLabelText(/Blank/u));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/updates/posts")?.body,
      ).toEqual({ title: "October", template: "blank" }),
    );
    expect(await screen.findByRole("heading", { name: "October" })).toBeInTheDocument();
  }, 20_000);

  it("edits a draft (autosave with baseSavedAt), shows section audiences, sends after confirming, lists recipients", async () => {
    let saved = 0;
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap()],
      "GET /api/v1/updates/posts": () => [200, { posts: [post()] }],
      "GET /api/v1/updates/posts/{id}": () => [200, detail()],
      "PUT /api/v1/updates/posts/{id}/draft": () => {
        saved += 1;
        return [
          200,
          detail({
            post: post({ savedAt: "2026-09-12T10:05:00.000Z", title: "September 2026 update!" }),
          }),
        ];
      },
      "POST /api/v1/updates/posts/{id}/send": () => [
        202,
        detail({
          post: post({
            state: "sending",
            publishedVersionNo: 1,
            lastSend: send({ status: "running", sent: 0, skipped: 0 }),
          }),
        }),
      ],
      "GET /api/v1/updates/posts/{id}/sends": () => [200, { sends: [send()] }],
      "GET /api/v1/updates/sends/{sendId}/recipients": () => [
        200,
        {
          send: send(),
          recipients: [
            {
              id: "x1",
              membershipId: INVESTOR_ID,
              email: "ada@investor.test",
              status: "sent",
              error: null,
              sentAt: NOW,
              lastEventAt: NOW,
            },
            {
              id: "x2",
              membershipId: null,
              email: "quiet@investor.test",
              status: "skipped",
              error: "unsubscribed",
              sentAt: null,
              lastEventAt: null,
            },
            {
              id: "x3",
              membershipId: null,
              email: "gone@investor.test",
              status: "skipped",
              error: "suppressed",
              sentAt: null,
              lastEventAt: null,
            },
            {
              id: "x4",
              membershipId: null,
              email: "grace@investor.test",
              status: "delivered",
              error: null,
              sentAt: NOW,
              lastEventAt: NOW,
            },
          ],
        },
      ],
      "GET /api/v1/updates/posts/{id}/replies": () => [
        200,
        {
          threads: [
            {
              membershipId: INVESTOR_ID,
              displayName: "Ada",
              replies: [
                {
                  id: "r1",
                  authorMembershipId: INVESTOR_ID,
                  authorName: "Ada",
                  authorKind: "external",
                  body: "Congrats!",
                  createdAt: NOW,
                },
              ],
            },
          ],
        },
      ],
    });
    const r = await renderApp(`/admin/updates/${POST_ID}`);
    expect(
      await screen.findByRole("heading", { name: "September 2026 update" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // Section rules render as radios; the board section targets the Board group.
    const board = r.container.querySelector('[data-section="board"]');
    expect(board).not.toBeNull();
    expect(
      within(board as HTMLElement).getByRole("radio", { name: "Only these groups" }),
    ).toBeChecked();
    expect(within(board as HTMLElement).getByRole("checkbox", { name: "Board" })).toBeChecked();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^Title/u), "!");
    await waitFor(() => expect(saved).toBe(1), { timeout: 4000 });
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toMatchObject({
      title: "September 2026 update!",
      baseSavedAt: NOW,
      audience: { kind: "all" },
    });
    expect(await screen.findByText(/Draft saved/u)).toBeInTheDocument();

    // Markdown source mode of the first text block edits the same document.
    await user.click(screen.getAllByRole("button", { name: "Markdown" })[0] as HTMLElement);
    const source = screen.getAllByRole("textbox", { name: "Text" })[0] as HTMLTextAreaElement;
    expect(source.value).toBe("We closed **three** customers.");

    await user.click(screen.getByRole("button", { name: "Send now" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Every investor who has not opted out");
    await user.click(within(dialog).getByRole("button", { name: "Send now" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "POST" && c.path === `/api/v1/updates/posts/${POST_ID}/send`,
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Sending in progress")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Recipients" }));
    const table = await screen.findByRole("table", { name: "Recipients" });
    expect(within(table).getByText("ada@investor.test")).toBeInTheDocument();
    expect(within(table).getByText("unsubscribed")).toBeInTheDocument();
    // A suppressed address is explained, not shown as a raw error code.
    expect(
      within(table).getByText("Suppressed (bounced or complained earlier)"),
    ).toBeInTheDocument();
    expect(within(table).queryByText("suppressed")).toBeNull();
    expect(within(table).getByText("Delivered")).toBeInTheDocument();
    // What the ESP reported after the hand-off.
    expect(screen.getByText("1 delivered · 1 bounced · 0 complained")).toBeInTheDocument();
    expect(screen.getByText("Congrats!")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows a sent update's opens and clicks from analytics, human and automated apart", async () => {
    const sentPost = post({ state: "sent", sentAt: NOW, publishedVersionNo: 1, lastSend: send() });
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap()],
      "GET /api/v1/updates/posts": () => [200, { posts: [sentPost] }],
      "GET /api/v1/updates/posts/{id}": () => [200, detail({ post: sentPost })],
      "GET /api/v1/updates/posts/{id}/sends": () => [200, { sends: [send()] }],
      "GET /api/v1/updates/posts/{id}/replies": () => [200, { threads: [] }],
      "GET /api/v1/analytics/posts/{id}/email": () => [200, analyticsEmailEngagement()],
    });
    const r = await renderApp(`/admin/updates/${POST_ID}`);
    expect(await screen.findByText("Opens and clicks", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(calls.some((c) => c.path === `/api/v1/analytics/posts/${POST_ID}/email`)).toBe(true);
    // Human and automated opens are labelled apart, each with its own number.
    expect(screen.getByText("Opened by a person").nextElementSibling).toHaveTextContent("5");
    expect(screen.getByText("Automated opens").nextElementSibling).toHaveTextContent("6");
    const links = screen.getByRole("table", { name: "Clicks by link" });
    expect(within(links).getByText("https://acme.test/deck")).toBeInTheDocument();
    expect(within(links).getByText("Unknown link")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("hides the opens-and-clicks card when analytics is not available", async () => {
    const sentPost = post({ state: "sent", sentAt: NOW, publishedVersionNo: 1, lastSend: send() });
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap()],
      "GET /api/v1/updates/posts/{id}": () => [200, detail({ post: sentPost })],
      "GET /api/v1/updates/posts/{id}/sends": () => [200, { sends: [send()] }],
      "GET /api/v1/updates/posts/{id}/replies": () => [200, { threads: [] }],
      // No analytics handler: the mock answers 404, as a disabled module does.
    });
    await renderApp(`/admin/updates/${POST_ID}`);
    expect(
      await screen.findByRole("heading", { name: "September 2026 update" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.path === `/api/v1/analytics/posts/${POST_ID}/email`)).toBe(true),
    );
    expect(screen.queryByText("Opens and clicks")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  }, 20_000);

  it("shows sender settings and the sending domain records with verification", async () => {
    const domain: FundRoomSchemas["SendingDomain"] = {
      id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f20",
      domain: "mail.acme.test",
      selector: "sh202609abcd",
      status: "pending",
      records: [
        {
          kind: "dkim",
          type: "TXT",
          name: "sh202609abcd._domainkey.mail.acme.test",
          value: "v=DKIM1; k=rsa; p=AAAA",
          required: true,
        },
        {
          kind: "spf",
          type: "TXT",
          name: "mail.acme.test",
          value: "v=spf1 include:<your SMTP provider> ~all",
          required: false,
        },
        {
          kind: "dmarc",
          type: "TXT",
          name: "_dmarc.mail.acme.test",
          value: "v=DMARC1; p=none; rua=mailto:dmarc@mail.acme.test",
          required: false,
        },
      ],
      checks: {},
      lastCheckedAt: null,
      lastError: null,
      verifiedAt: null,
      createdAt: NOW,
    };
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap()],
      "GET /api/v1/updates/settings": () => [
        200,
        {
          fromName: null,
          fromLocalPart: "updates",
          replyTo: null,
          postalAddress: null,
          footerNote: null,
        },
      ],
      "PATCH /api/v1/updates/settings": () => [
        200,
        {
          fromName: "Acme IR",
          fromLocalPart: "updates",
          replyTo: null,
          postalAddress: null,
          footerNote: null,
        },
      ],
      "GET /api/v1/updates/sending-domain": () => [200, { domain }],
      "POST /api/v1/updates/sending-domain/verify": () => [
        200,
        {
          ...domain,
          status: "verified",
          verifiedAt: NOW,
          lastCheckedAt: NOW,
          checks: {
            dkim: { ok: true, found: "v=DKIM1; k=rsa; p=AAAA" },
            spf: { ok: false, found: null },
            dmarc: { ok: true, found: "v=DMARC1; p=none" },
          },
        },
      ],
    });
    const r = await renderApp("/admin/updates/settings");
    expect(
      await screen.findByRole("heading", { name: "Update email settings" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const records = await screen.findByRole("table", { name: "DNS records" });
    expect(within(records).getByText("sh202609abcd._domainkey.mail.acme.test")).toBeInTheDocument();
    expect(within(records).getAllByText("Not checked")).toHaveLength(3);
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Sender name/u), "Acme IR");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
        fromName: "Acme IR",
        fromLocalPart: "updates",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Verify now" }));
    expect((await screen.findAllByText("Verified")).length).toBeGreaterThan(0);
    expect(
      within(screen.getByRole("table", { name: "DNS records" })).getAllByText("Found"),
    ).toHaveLength(2);
    expect(
      within(screen.getByRole("table", { name: "DNS records" })).getByText("Missing"),
    ).toBeInTheDocument();
  }, 20_000);
});
