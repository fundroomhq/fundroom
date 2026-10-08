import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  analyticsHeatmap,
  analyticsHotList,
  analyticsNotice,
  analyticsOverview,
  analyticsSettings,
  analyticsTimelineItem,
  analyticsViewer,
  type Handler,
  installMockApi,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f05";
const MEMBER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01";
const DOC_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01";
const VERSION_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d02";
const ROOT_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d03";
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

const staffBootstrap = (permissions = ["analytics.read", "analytics.settings"]) =>
  bootstrap({
    modules: [
      {
        id: "analytics",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "admin.nav": [
            { id: "analytics", label: "Engagement", to: "/admin/analytics", order: 40 },
          ],
        },
      },
    ],
    permissions,
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

/*
 * The engagement screens resolve document titles from the data room's tree (analytics stores
 * resource ids, not names), so the mock has to serve one for the rows to read as anything but
 * a short id. The "no tree" case is covered separately below.
 */
const DOC_TITLE = "Series A deck";

function dataRoomTree(): FundRoomSchemas["DataRoomTree"] {
  const granted: FundRoomSchemas["AccessDecision"] = {
    allowed: true,
    capabilities: ["view", "download"],
    pendingGates: [],
    reason: "granted",
  };
  return {
    rootId: ROOT_ID,
    folders: [],
    documents: [
      {
        ...({
          id: DOC_ID,
          title: DOC_TITLE,
          folderId: ROOT_ID,
          index: "1",
          sortOrder: 1,
          contentType: "application/pdf",
          currentVersionId: VERSION_ID,
          createdAt: NOW,
          updatedAt: NOW,
          deletedAt: null,
          legalHold: false,
          pageCount: 12,
          protection: { download: true, print: true, watermark: true, forensic: false },
          purgeAfter: null,
          renderStatus: "ready",
          scanStatus: "clean",
          sizeBytes: 123_456,
        } satisfies FundRoomSchemas["DataRoomDocument"]),
        access: granted,
      },
    ],
  };
}

function adminHandlers(over: Record<string, Handler> = {}, permissions?: string[]) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions)],
    "GET /api/v1/analytics/overview": () => [200, analyticsOverview()],
    "GET /api/v1/analytics/settings": () => [200, analyticsSettings()],
    "GET /api/v1/data-room/tree": () => [200, dataRoomTree()],
    ...over,
  });
}

describe("engagement admin", () => {
  it("shows totals, top documents and recent activity, and drills into who viewed and per-page dwell", async () => {
    const { calls } = adminHandlers({
      "GET /api/v1/analytics/document/{id}/viewers": () => [
        200,
        { mode: "engagement", viewers: [analyticsViewer()] },
      ],
      "GET /api/v1/analytics/document/{id}/viewers/{membershipId}/pages": () => [
        200,
        { pages: [{ pageNo: 1, durationMs: 65_000, views: 3 }] },
      ],
    });
    const r = await renderApp("/admin/analytics");
    expect(
      await screen.findByRole("heading", { name: "Engagement" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // totals
    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("1h 2m")).toBeInTheDocument(); // 3 725 000 ms
    expect(screen.getByText("Read a page")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ada Lovelace" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    // the title comes from the data-room tree, and both tables link to the same document
    const top = within(screen.getByRole("region", { name: "Top documents" }));
    expect(
      within(screen.getByRole("region", { name: "Recent activity" })).getByRole("link", {
        name: DOC_TITLE,
      }),
    ).toBeInTheDocument();
    await user.click(top.getByRole("link", { name: DOC_TITLE }));
    expect(await screen.findByRole("heading", { name: "Who viewed" })).toBeInTheDocument();
    expect(screen.getByText("3m 5s")).toBeInTheDocument(); // 185 000 ms
    expect(screen.getByText("7")).toBeInTheDocument(); // furthest page
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("link", { name: "Ada Lovelace" }));
    expect(await screen.findByRole("heading", { name: "Time per page" })).toBeInTheDocument();
    expect(screen.getByText("1m 5s")).toBeInTheDocument();
    expect(
      calls.some(
        (c) =>
          c.path === `/api/v1/analytics/document/${DOC_ID}/viewers/${MEMBER_ID}/pages` &&
          c.method === "GET",
      ),
    ).toBe(true);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("falls back to the short resource id when the data room is unreadable", async () => {
    // An admin without `data-room.read`, or a document since deleted: the engagement row must
    // still render rather than disappear with the title it cannot resolve.
    adminHandlers({
      "GET /api/v1/data-room/tree": () => [403, { error: { code: "forbidden", message: "no" } }],
    });
    await renderApp("/admin/analytics");
    expect(
      await screen.findByRole("heading", { name: "Engagement" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const top = within(await screen.findByRole("region", { name: "Top documents" }));
    expect(top.getByRole("link", { name: `Document ${DOC_ID.slice(0, 8)}` })).toBeInTheDocument();
    expect(top.queryByRole("link", { name: DOC_TITLE })).not.toBeInTheDocument();
  }, 20_000);

  it("pages a contact timeline with a keyset cursor and offers DSAR erasure", async () => {
    const cursors: (string | null)[] = [];
    const { calls } = adminHandlers({
      "GET /api/v1/analytics/members/{membershipId}/timeline": ({ url }) => {
        const before = url.searchParams.get("before");
        cursors.push(before);
        return before === null
          ? [
              200,
              { items: [analyticsTimelineItem({ type: "document_downloaded" })], nextBefore: NOW },
            ]
          : [
              200,
              {
                items: [
                  analyticsTimelineItem({
                    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c03",
                    type: "page_viewed",
                    pageNo: 4,
                    durationMs: 12_000,
                  }),
                ],
                nextBefore: null,
              },
            ];
      },
      "POST /api/v1/analytics/members/{membershipId}/anonymise": () => [
        200,
        { ok: true, deleted: { events: 3, pageOpens: 1, viewSessions: 1, viewerRollups: 1 } },
      ],
    });
    const r = await renderApp(`/admin/analytics/members/${MEMBER_ID}`);
    expect(
      await screen.findByRole("heading", { name: "Contact timeline" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Downloaded a document")).toBeInTheDocument();
    expect(screen.queryByText("Read a page")).toBeNull();
    expect(cursors).toEqual([null]);
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Read a page")).toBeInTheDocument();
    // The second page is fetched with the cursor the first page handed back, not an offset.
    expect(cursors).toEqual([null, NOW]);
    // Both pages stay on screen, and there is nothing left to load.
    expect(screen.getByText("Downloaded a document")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Erase activity" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Erase activity" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" && c.path === `/api/v1/analytics/members/${MEMBER_ID}/anonymise`,
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("saves the tracking mode and retention", async () => {
    const { calls } = adminHandlers({
      "PATCH /api/v1/analytics/settings": ({ body }) => [
        200,
        { ...analyticsSettings(), ...(body as object) },
      ],
    });
    const r = await renderApp("/admin/analytics/settings");
    expect(
      await screen.findByRole("heading", { name: "Engagement settings" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: /Essential/u }));
    const retention = screen.getByLabelText(/Keep activity for/u);
    await user.clear(retention);
    await user.type(retention, "12");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/analytics/settings")?.body,
      ).toEqual({
        mode: "essential",
        retentionMonths: 12,
        hotListWindowDays: 14,
        hotLeadThreshold: 60,
      }),
    );
    // Retention is paused under legal hold, and the screen says so where retention is set.
    expect(screen.getByText(/under legal hold/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("saves the hot-list window and turns hot-lead alerts off with null", async () => {
    const { calls } = adminHandlers({
      "PATCH /api/v1/analytics/settings": ({ body }) => [
        200,
        { ...analyticsSettings(), ...(body as object) },
      ],
    });
    await renderApp("/admin/analytics/settings");
    const user = userEvent.setup();
    const windowDays = await screen.findByLabelText(/Hot-list window/u, {}, { timeout: 5000 });
    await user.clear(windowDays);
    await user.type(windowDays, "30");
    const threshold = screen.getByLabelText(/Hot-lead threshold/u);
    expect(threshold).toHaveValue(60);
    await user.click(screen.getByRole("checkbox", { name: /Alert the team/u }));
    expect(threshold).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/analytics/settings")?.body,
      ).toMatchObject({ hotListWindowDays: 30, hotLeadThreshold: null }),
    );
  }, 20_000);

  it("opens the page heatmap from who viewed, with numbers per page and not colour alone", async () => {
    const { calls } = adminHandlers({
      "GET /api/v1/analytics/document/{id}/viewers": () => [
        200,
        { mode: "engagement", viewers: [analyticsViewer()] },
      ],
      "GET /api/v1/analytics/document/{id}/heatmap": () => [200, analyticsHeatmap()],
    });
    const r = await renderApp(`/admin/analytics/r/document/${DOC_ID}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "Page heatmap" }, { timeout: 5000 }));
    expect(await screen.findByRole("heading", { name: "Page heatmap" })).toBeInTheDocument();
    expect(calls.some((c) => c.path === `/api/v1/analytics/document/${DOC_ID}/heatmap`)).toBe(true);
    const table = await screen.findByRole("table", { name: "Time per page, all readers" });
    const rows = within(table).getAllByRole("row");
    // header + three pages, in page order
    expect(rows).toHaveLength(4);
    const page3 = rows[3] as HTMLElement;
    expect(within(page3).getByText("5m 0s")).toBeInTheDocument(); // total dwell
    expect(within(page3).getByText("1m 0s")).toBeInTheDocument(); // average per reader
    // The page readers spent longest on is named in words as well as by bar length.
    expect(within(page3).getByText("Most read")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByText("Most read")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains an empty heatmap", async () => {
    adminHandlers({
      "GET /api/v1/analytics/document/{id}/heatmap": () => [
        200,
        analyticsHeatmap({ mode: "essential", versions: [] }),
      ],
    });
    await renderApp(`/admin/analytics/r/document/${DOC_ID}/heatmap`);
    expect(
      await screen.findByText(
        /Page time is recorded only in engagement mode/u,
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  }, 20_000);

  it("ranks the hot list with a score breakdown, changes the window and exports CSV", async () => {
    const created: Blob[] = [];
    const clicked: HTMLAnchorElement[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: Blob) => {
        created.push(blob);
        return `blob:${created.length}`;
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function mocked(
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const daysAsked: (string | null)[] = [];
    const csvDays: (string | null)[] = [];
    adminHandlers({
      "GET /api/v1/analytics/hot-list": ({ url }) => {
        const days = url.searchParams.get("days");
        daysAsked.push(days);
        return [200, analyticsHotList({ days: days === null ? 14 : Number(days) })];
      },
      "GET /api/v1/analytics/hot-list.csv": ({ url }) => {
        csvDays.push(url.searchParams.get("days"));
        return new Response("\uFEFFrank,membership_id\r\n", {
          status: 200,
          headers: { "content-type": "text/csv; charset=utf-8" },
        });
      },
    });
    try {
      const r = await renderApp("/admin/analytics");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("link", { name: "Hot list" }, { timeout: 5000 }));
      expect(await screen.findByRole("heading", { name: "Hot list" })).toBeInTheDocument();
      // The workspace's own window is used until the operator picks another.
      expect(await screen.findByText(/Scored over the last 14 days/u)).toBeInTheDocument();
      expect(daysAsked).toEqual([null]);
      expect(screen.getByRole("link", { name: "Ada Lovelace" })).toBeInTheDocument();
      expect(screen.getByText("82")).toBeInTheDocument();
      expect(screen.getByText("9 views")).toBeInTheDocument();
      expect(screen.getByText("3 email opens")).toBeInTheDocument();
      expect(screen.getByText(/Not scored: 4 automated opens/u)).toBeInTheDocument();
      await expectNoA11yViolations(r.container);

      await user.selectOptions(screen.getByLabelText("Period"), "30");
      expect(await screen.findByText(/Scored over the last 30 days/u)).toBeInTheDocument();
      expect(daysAsked).toContain("30");

      await user.click(screen.getByRole("button", { name: "Export CSV" }));
      await waitFor(() => expect(clicked).toHaveLength(1));
      expect(clicked[0]?.download).toBe("hot-list.csv");
      expect(csvDays).toEqual(["30"]);
    } finally {
      click.mockRestore();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  }, 20_000);

  it("says the hot list needs engagement mode and consent when it is empty", async () => {
    adminHandlers({
      "GET /api/v1/analytics/hot-list": () => [
        200,
        analyticsHotList({ mode: "essential", threshold: null, entries: [] }),
      ],
    });
    const r = await renderApp("/admin/analytics/hot-list");
    expect(await screen.findByText("Nobody to rank", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/needs engagement mode/u)).toBeInTheDocument();
    expect(screen.getByText(/whose consent allows engagement analytics/u)).toBeInTheDocument();
    expect(screen.getByText(/Hot-lead alerts are off/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("sends the operator to step-up when the settings change needs a fresh session", async () => {
    adminHandlers({
      "PATCH /api/v1/analytics/settings": () => [
        401,
        {
          error: { code: "step_up_required", message: "fresh", requestId: "r1", reason: "fresh" },
        },
      ],
    });
    const r = await renderApp("/admin/analytics/settings");
    expect(
      await screen.findByRole("heading", { name: "Engagement settings" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
  }, 20_000);

  it("refuses the overview without analytics.read", async () => {
    adminHandlers({}, []);
    await renderApp("/admin/analytics");
    expect(
      await screen.findByText(
        "You do not have permission to see engagement data.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  }, 20_000);
});

// --- investor transparency notice -----------------------------------------------------------------

describe("investor transparency notice", () => {
  /** What the server's `tracksFor("engagement")` returns (E2.6). */
  const ENGAGEMENT_TRACKS = [
    "document_views",
    "downloads",
    "update_views",
    "page_dwell",
    "browser_family",
    "hashed_ip",
    "email_opens",
    "email_clicks",
    "engagement_score",
  ];

  it("lists what the workspace records on the member's settings page", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/analytics/notice": () => [
        200,
        analyticsNotice({
          tracks: ENGAGEMENT_TRACKS,
          emailTracking: { granted: null, active: true },
        }),
      ],
    });
    const r = await renderApp("/settings");
    expect(await screen.findByText("What this workspace records")).toBeInTheDocument();
    expect(screen.getByText("How long you spent on each page of a document")).toBeInTheDocument();
    expect(
      screen.getByText("A one-way hash of your IP address, never the address itself"),
    ).toBeInTheDocument();
    // Engagement mode also tracks email opens and clicks and scores engagement; every server
    // key has real copy (no raw key leaks through).
    expect(screen.getByText(/When you open an update email/u)).toBeInTheDocument();
    expect(screen.getByText("Which links in an update email you click")).toBeInTheDocument();
    expect(
      screen.getByText(/An engagement score built from the activity above/u),
    ).toBeInTheDocument();
    for (const key of ENGAGEMENT_TRACKS) expect(screen.queryByText(key)).toBeNull();
    expect(screen.getByText("Email open and click tracking is on for you.")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says when email opens and clicks are not recorded for this member", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/analytics/notice": () => [
        200,
        analyticsNotice({
          tracks: ENGAGEMENT_TRACKS,
          emailTracking: { granted: false, active: false },
        }),
      ],
    });
    await renderApp("/settings");
    expect(
      await screen.findByText("Email opens and clicks are not recorded for you."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Email open and click tracking is on for you.")).toBeNull();
  }, 20_000);

  it("does not mention email tracking outside engagement mode", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/analytics/notice": () => [
        200,
        analyticsNotice({ mode: "essential", tracks: ["document_views"] }),
      ],
    });
    await renderApp("/settings");
    expect(await screen.findByText("What this workspace records")).toBeInTheDocument();
    expect(screen.queryByText(/When you open an update email/u)).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /open update emails/u })).toBeNull();
  }, 20_000);

  it("lets a member withdraw email tracking separately from reading analytics", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/analytics/notice": () => [200, analyticsNotice()],
      "GET /api/v1/compliance/consent": () => [
        200,
        {
          consentMode: "notice_only",
          gpc: false,
          purposes: [
            {
              purpose: "analytics_engagement",
              granted: true,
              source: "settings",
              recordedAt: NOW,
              allowed: true,
            },
            {
              purpose: "email_tracking",
              granted: null,
              source: null,
              recordedAt: null,
              allowed: true,
            },
          ],
        },
      ],
      "PUT /api/v1/compliance/consent": () => [
        200,
        { consentMode: "notice_only", gpc: false, purposes: [] },
      ],
    });
    const r = await renderApp("/settings");
    const email = await screen.findByRole("checkbox", { name: /open update emails/u });
    // notice_only and never asked: tracked until told not to.
    expect(email).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /measure how I read/u })).toBeChecked();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(email);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path === "/api/v1/compliance/consent")?.body,
      ).toEqual({ purpose: "email_tracking", granted: false, source: "settings" }),
    );
    // Only the email purpose was written.
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  }, 20_000);

  it("says nothing is recorded when tracking is off", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/analytics/notice": () => [200, analyticsNotice({ mode: "off", tracks: [] })],
    });
    await renderApp("/settings");
    expect(
      await screen.findByText("Nothing about how you read documents or updates is recorded."),
    ).toBeInTheDocument();
  }, 20_000);
});

// --- the dwell heartbeat --------------------------------------------------------------------------

function docDetail(): FundRoomSchemas["DataRoomDocumentDetail"] {
  return {
    document: {
      id: DOC_ID,
      folderId: ROOT_ID,
      title: "Pitch deck",
      index: "1",
      sortOrder: 0,
      protection: { download: false, watermark: true, print: false, forensic: false },
      legalHold: false,
      currentVersionId: VERSION_ID,
      contentType: "application/pdf",
      sizeBytes: 1234,
      pageCount: 3,
      renderStatus: "ready",
      scanStatus: "clean",
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      purgeAfter: null,
    },
    folder: { id: ROOT_ID, name: "Data room", path: "r" },
    currentVersion: {
      id: VERSION_ID,
      versionNo: 1,
      fileName: "deck.pdf",
      contentType: "application/pdf",
      sizeBytes: 1234,
      pageCount: 3,
      renderStatus: "ready",
      renderDetail: null,
      changeNote: null,
      uploadedBy: null,
      createdAt: NOW,
      isCurrent: true,
    },
    scan: { status: "clean", engine: "noop", detail: null, scannedAt: NOW },
    versions: [],
    access: { allowed: true, reason: "granted", capabilities: ["view"], pendingGates: [] },
    availability: { viewable: true, download: null, reason: "ready" },
    legalHold: null,
  };
}

function dataRoomBootstrap() {
  return bootstrap({
    modules: [
      {
        id: "data-room",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "investor.nav": [{ id: "dr", label: "Data room", to: "/data-room", order: 20 }],
        },
      },
    ],
  });
}

function viewerHandlers(notice: FundRoomSchemas["AnalyticsNotice"]) {
  return installMockApi({
    "GET /api/v1/me": () => [200, me()],
    "GET /api/v1/modules": () => [200, dataRoomBootstrap()],
    "GET /api/v1/data-room/documents/{id}": () => [200, docDetail()],
    "POST /api/v1/data-room/documents/{id}/viewed": () => [200, { recorded: true }],
    "GET /api/v1/analytics/notice": () => [200, notice],
    "POST /api/v1/analytics/heartbeat": () => [200, { accepted: true }],
    "POST /api/v1/analytics/close": () => [200, { flushed: 1 }],
  });
}

describe("dwell heartbeat", () => {
  it("beats for the visible page, stops when the tab hides, and closes on unmount", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = viewerHandlers(analyticsNotice());
    const r = await renderApp(`/data-room/documents/${DOC_ID}`);
    expect(await screen.findByRole("heading", { name: /Pitch deck/u })).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/v1/analytics/notice")).toBe(true),
    );

    await vi.advanceTimersByTimeAsync(5_100);
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/v1/analytics/heartbeat")).toBe(true),
    );
    const beat = calls.find((c) => c.path === "/api/v1/analytics/heartbeat")?.body as {
      resourceId: string;
      page: number;
      ms: number;
      versionId?: string;
    };
    expect(beat.resourceId).toBe(DOC_ID);
    expect(beat.versionId).toBe(VERSION_ID);
    expect(beat.page).toBe(1);
    expect(beat.ms).toBeGreaterThan(0);
    expect(beat.ms).toBeLessThanOrEqual(15_000);

    // Tab hidden: the clock stops, so no further beats accumulate.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    const afterHide = calls.filter((c) => c.path === "/api/v1/analytics/heartbeat").length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.filter((c) => c.path === "/api/v1/analytics/heartbeat").length).toBe(afterHide);

    r.unmount();
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/v1/analytics/close")?.body).toEqual({
        resourceKind: "document",
        resourceId: DOC_ID,
      }),
    );
    // Nothing keeps beating after the viewer is gone.
    const afterUnmount = calls.filter((c) => c.path === "/api/v1/analytics/heartbeat").length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.filter((c) => c.path === "/api/v1/analytics/heartbeat").length).toBe(afterUnmount);
  }, 20_000);

  it("never beats when the workspace is not in engagement mode", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = viewerHandlers(
      analyticsNotice({ mode: "essential", tracks: ["document_views"] }),
    );
    const r = await renderApp(`/data-room/documents/${DOC_ID}`);
    expect(await screen.findByRole("heading", { name: /Pitch deck/u })).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/v1/analytics/notice")).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.some((c) => c.path === "/api/v1/analytics/heartbeat")).toBe(false);
    r.unmount();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.some((c) => c.path === "/api/v1/analytics/close")).toBe(false);
  }, 20_000);
});
