import { FundRoomApiError, type FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError } from "../lib/api.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  analyticsNotice,
  apiError,
  type Handler,
  installMockApi,
  memberSession,
  viewAsState,
  W2_ADA_ID,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * "View as investor" (E2.7): starting it from a person's page (reason → POST → portal home),
 * the persistent read-only banner in the portal and the admin tree, "Exit view", and the
 * portal's own restraint while viewing — no dwell beacons, no "viewed" stamps, no downloads.
 * The server refuses all of those with `view_as_read_only` anyway; the client must not even ask.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const DOC = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02";
const ROOT = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e00";
const VERSION = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e04";
const NOW = "2026-09-12T10:00:00.000Z";

const staffSession = () =>
  session({
    population: "staff",
    authLevel: 2,
    user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
  });

const staffMe = () =>
  me({
    session: staffSession(),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

/** What `/me` answers while viewing: the staff session, the investor's membership. */
const viewingMe = () =>
  me({
    session: staffSession(),
    membership: membership({ id: W2_ADA_ID, kind: "external", role: "investor" }),
    viewAs: viewAsState(),
  });

const dataRoomModule = {
  id: "data-room",
  version: "0.1.0",
  enabled: true,
  hidden: false,
  readOnly: false,
  flags: {},
  slots: { "investor.nav": [{ id: "dr", label: "Data room", to: "/data-room", order: 20 }] },
};

const staffBootstrap = () =>
  bootstrap({
    modules: [],
    permissions: ["access.read", "access.manage", "access.manage_staff"],
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

const viewingBootstrap = () =>
  bootstrap({
    modules: [dataRoomModule],
    permissions: ["data-room.read"],
    membership: { id: W2_ADA_ID, kind: "external", role: "investor" },
    viewAs: viewAsState(),
  });

function person(): FundRoomSchemas["Person"] {
  return {
    membershipId: W2_ADA_ID,
    userId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e03",
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
  };
}

function docDetail(): FundRoomSchemas["DataRoomDocumentDetail"] {
  return {
    document: {
      id: DOC,
      folderId: ROOT,
      title: "Pitch deck",
      index: "1",
      sortOrder: 0,
      protection: { download: true, watermark: true, print: false, forensic: false },
      legalHold: false,
      currentVersionId: VERSION,
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
    folder: { id: ROOT, name: "Data room", path: "r" },
    currentVersion: {
      id: VERSION,
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
    access: {
      allowed: true,
      reason: "granted",
      capabilities: ["view", "download"],
      pendingGates: [],
    },
    // The investor may download: only the view-as must hide the button.
    availability: { viewable: true, download: "watermarked", reason: "ready" },
    legalHold: null,
  };
}

/** One mutable world: `viewing` flips when the POST/DELETE succeed, like the server's session. */
/** The view-as strip (`role="status"`); other status regions (loading states) come and go. */
async function findBanner(): Promise<HTMLElement> {
  const text = await screen.findByText(/^Viewing as /u, {}, { timeout: 5000 });
  const banner = text.closest<HTMLElement>('[role="status"]');
  if (banner === null) throw new Error("the view-as text is not inside a status region");
  return banner;
}

function handlers(initiallyViewing: boolean, over: Record<string, Handler> = {}) {
  const state = { viewing: initiallyViewing };
  const api = installMockApi({
    "GET /api/v1/me": () => [200, state.viewing ? viewingMe() : staffMe()],
    "GET /api/v1/modules": () => [200, state.viewing ? viewingBootstrap() : staffBootstrap()],
    "GET /api/v1/access/groups": () => [200, { groups: [] }],
    "GET /api/v1/access/people/{id}": () => [
      200,
      { person: person(), delegates: [], attestations: [], grants: [] },
    ],
    "GET /api/v1/access/people/{id}/sessions": () => [200, { sessions: [memberSession()] }],
    "POST /api/v1/access/people/{id}/view-as": () => {
      state.viewing = true;
      return [200, { viewAs: viewAsState() }];
    },
    "DELETE /api/v1/me/view-as": () => {
      state.viewing = false;
      return new Response(null, { status: 204 });
    },
    "GET /api/v1/data-room/documents/{id}": () => [200, docDetail()],
    "GET /api/v1/analytics/notice": () => [200, analyticsNotice()],
    // Present so that a regression would be *recorded*, not 404'd into silence.
    "POST /api/v1/data-room/documents/{id}/viewed": () => [200, { recorded: true }],
    "POST /api/v1/analytics/heartbeat": () => [200, { accepted: true }],
    "POST /api/v1/analytics/close": () => [200, { flushed: 1 }],
    ...over,
  });
  return { ...api, state };
}

describe("view as investor", () => {
  it("starts from the person page with a reason and lands on the portal under the banner", async () => {
    const { calls } = handlers(false);
    const r = await renderApp(`/admin/people/${W2_ADA_ID}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "View as investor" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog", { name: "View the portal as Ada Lovelace?" });
    const start = within(dialog).getByRole("button", { name: "Start viewing" });
    // The reason is required (3..500 characters).
    expect(start).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Reason"), "Checking the data room");
    await user.click(start);
    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.method === "POST" && c.path === `/api/v1/access/people/${W2_ADA_ID}/view-as`,
        )?.body,
      ).toEqual({ reason: "Checking the data room" }),
    );
    await waitFor(() => expect(pathOf(r.router)).toBe("/"));
    const banner = await findBanner();
    expect(banner).toHaveTextContent(
      "Viewing as Ada Lovelace — read-only. Downloads are off and nothing you do is recorded as them.",
    );
    expect(within(banner).getByRole("button", { name: "Exit view" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("sends a stale session through step-up before starting", async () => {
    handlers(false, {
      "POST /api/v1/access/people/{id}/view-as": () =>
        apiError(401, "step_up_required", { reason: "fresh" }),
    });
    const r = await renderApp(`/admin/people/${W2_ADA_ID}`);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "View as investor" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Reason"), "Support ticket 42");
    await user.click(within(dialog).getByRole("button", { name: "Start viewing" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
  }, 20_000);

  it("exits the view back to the person's admin page", async () => {
    const { calls, state } = handlers(true);
    const r = await renderApp("/");
    const banner = await findBanner();
    expect(banner).toHaveTextContent("Viewing as Ada Lovelace");
    const user = userEvent.setup();
    await user.click(within(banner).getByRole("button", { name: "Exit view" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/v1/me/view-as")).toBe(
        true,
      ),
    );
    expect(state.viewing).toBe(false);
    await waitFor(() => expect(pathOf(r.router)).toBe(`/admin/people/${W2_ADA_ID}`));
    expect(
      await screen.findByRole("heading", { name: "Ada Lovelace", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Viewing as/u)).toBeNull();
  }, 20_000);

  it("shows the banner and a notice, not not-found, in the admin tree while viewing", async () => {
    handlers(true);
    const r = await renderApp("/admin");
    expect(
      await screen.findByRole(
        "heading",
        { name: "You are viewing as an investor" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(await findBanner()).toHaveTextContent("Viewing as Ada Lovelace");
    expect(screen.getByRole("link", { name: "Go to the portal" })).toHaveAttribute("href", "/");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("sends no beacon, no viewed stamp and no other POST, and hides the download", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = handlers(true);
    const r = await renderApp(`/data-room/documents/${DOC}`);
    expect(
      await screen.findByRole("heading", { name: /Pitch deck/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(await findBanner()).toHaveTextContent("Viewing as Ada Lovelace");
    // The investor could download it; the staff member viewing as them cannot.
    expect(screen.queryByRole("link", { name: /Download/u })).toBeNull();
    // Well past several beat intervals.
    await vi.advanceTimersByTimeAsync(16_000);
    r.unmount();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.filter((c) => c.method !== "GET" && c.method !== "HEAD")).toEqual([]);
  }, 20_000);

  it("still downloads and beats for the investor themselves (control)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [
        200,
        me({ membership: membership({ id: W2_ADA_ID, kind: "external", role: "investor" }) }),
      ],
      "GET /api/v1/modules": () => [
        200,
        bootstrap({
          modules: [dataRoomModule],
          membership: { id: W2_ADA_ID, kind: "external", role: "investor" },
        }),
      ],
      "GET /api/v1/data-room/documents/{id}": () => [200, docDetail()],
      "GET /api/v1/analytics/notice": () => [200, analyticsNotice()],
      "POST /api/v1/data-room/documents/{id}/viewed": () => [200, { recorded: true }],
      "POST /api/v1/analytics/heartbeat": () => [200, { accepted: true }],
      "POST /api/v1/analytics/close": () => [200, { flushed: 1 }],
    });
    await renderApp(`/data-room/documents/${DOC}`);
    expect(
      await screen.findByRole("heading", { name: /Pitch deck/u }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download/u })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(5_100);
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/v1/analytics/heartbeat")).toBe(true),
    );
    expect(calls.some((c) => c.path.endsWith("/viewed"))).toBe(true);
    expect(screen.queryByText(/^Viewing as /u)).toBeNull();
  }, 20_000);

  it("explains a view_as_read_only refusal in plain words", () => {
    const d = describeError(
      new FundRoomApiError(
        403,
        { error: { code: "view_as_read_only", message: "view_as_read_only" } },
        "req-1",
      ),
    );
    expect(d.title).toBe("Read-only view");
    expect(d.body).toMatch(/viewing the portal as an investor/u);
  });
});
