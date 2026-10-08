import type { FundRoomSchemas } from "@fundroom/sdk";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/settings/export` (E2.8): what the export contains, requesting one (step-up), the list
 * with polling while an export is prepared, download (preflight — row state and session
 * freshness — then a browser-streamed `<a download>`; step-up, 409/410), delete, and the signing
 * key with the verify command.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f07";
const READY_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01";
const RUNNING_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d02";
const SHA = "ab".repeat(32);
const PUBLIC_KEY = "0vN6m1a6Xx2A0h8d7hZf6k0cQ2c9C6r3oS4r0VbqM9w=";

function exportRow(
  over: Partial<FundRoomSchemas["WorkspaceExport"]> = {},
): FundRoomSchemas["WorkspaceExport"] {
  return {
    id: READY_ID,
    status: "ready",
    options: { includeRawAnalytics: false },
    sizeBytes: 5_242_880,
    sha256: SHA,
    error: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    completedAt: "2026-09-20T10:05:00.000Z",
    // Relative to the real clock: the screen compares it with Date.now() to offer the download.
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    downloadedAt: null,
    ...over,
  };
}

/** `authTime` defaults to "just now": the download preflight checks freshness against it. */
const ownerMe = (authTime = new Date().toISOString()) =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      authTime,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

function handlers(over: Record<string, Handler> = {}, permissions = ["portability.export"]) {
  return installMockApi({
    "GET /api/v1/me": () => [200, ownerMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        modules: [
          {
            id: "portability",
            version: "0.1.0",
            enabled: true,
            hidden: false,
            readOnly: false,
            flags: {},
            slots: {
              "admin.settings": [
                {
                  id: "workspace-export",
                  label: "Export workspace",
                  to: "/admin/settings/export",
                  order: 80,
                  icon: "export",
                },
              ],
            },
          },
        ],
        permissions,
        membership: { id: OWNER_ID, kind: "staff", role: "owner" },
      }),
    ],
    "GET /api/v1/portability/exports": () => [200, { items: [exportRow()] }],
    "GET /api/v1/portability/exports/{id}": () => [200, exportRow()],
    "GET /api/v1/portability/export-key": () => [
      200,
      { keys: [{ keyId: "v1", alg: "Ed25519", publicKey: PUBLIC_KEY }] },
    ],
    ...over,
  });
}

async function openExport() {
  const r = await renderApp("/admin/settings/export");
  expect(
    await screen.findByRole("heading", { name: "Export workspace", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

/** Records (instead of following) every anchor click: the download is a browser navigation. */
function captureClicks() {
  const clicked: HTMLAnchorElement[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function mocked(
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  const createObjectURL = vi.fn(() => "blob:1");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  return {
    clicked,
    createObjectURL,
    undo: () => {
      click.mockRestore();
      Reflect.deleteProperty(URL, "createObjectURL");
    },
  };
}

const DOWNLOAD_PATH = `/api/v1/portability/exports/${READY_ID}/download`;
const MINUTE = 60_000;

describe("workspace export admin", () => {
  it("is reachable from the settings hub", async () => {
    handlers();
    const r = await renderApp("/admin/settings");
    const link = await screen.findByRole("link", { name: "Export workspace" }, { timeout: 5000 });
    expect(link).toHaveAttribute("href", "/admin/settings/export");
    await userEvent.setup().click(link);
    await waitFor(() => expect(pathOf(r.router)).toBe("/admin/settings/export"));
  }, 20_000);

  it("explains the contents, lists exports and shows the signing key", async () => {
    handlers();
    const r = await openExport();
    expect(screen.getByText("Handle the file like the originals")).toBeInTheDocument();
    expect(
      screen.getByText(/contains every document and record in plaintext/u),
    ).toBeInTheDocument();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Ready")).toBeInTheDocument();
    expect(within(table).getByText("5.0 MB")).toBeInTheDocument();
    expect(within(table).getByText(SHA)).toBeInTheDocument();
    expect(await screen.findByText(PUBLIC_KEY)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy public key v1" })).toBeInTheDocument();
    expect(
      screen.getByText(
        `fundroom workspace verify-export workspace-export.zip --public-key ${PUBLIC_KEY}`,
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("requests an export with raw analytics and polls until it is ready", async () => {
    let state: "none" | "queued" | "ready" = "none";
    let listCalls = 0;
    const { calls } = handlers({
      "GET /api/v1/portability/exports": () => {
        listCalls += 1;
        if (state === "none") return [200, { items: [] }];
        if (state === "queued") {
          // The second poll finds it done.
          if (listCalls >= 3) state = "ready";
          return [
            200,
            {
              items: [
                exportRow({
                  id: RUNNING_ID,
                  status: "running",
                  sha256: null,
                  sizeBytes: null,
                  expiresAt: null,
                  completedAt: null,
                }),
              ],
            },
          ];
        }
        return [200, { items: [exportRow({ id: RUNNING_ID })] }];
      },
      "POST /api/v1/portability/exports": () => {
        state = "queued";
        return [
          202,
          exportRow({
            id: RUNNING_ID,
            status: "queued",
            options: { includeRawAnalytics: true },
            sha256: null,
            sizeBytes: null,
            expiresAt: null,
            completedAt: null,
          }),
        ];
      },
    });
    const r = await openExport();
    expect(await screen.findByText("No exports yet.")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "Include raw analytics" }));
    await user.click(screen.getByRole("button", { name: "Start export" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/portability/exports")?.body,
      ).toEqual({ includeRawAnalytics: true }),
    );
    expect(await screen.findByText("Preparing")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    // Polling (every 3 s while queued/running) picks up the finished export.
    expect(await screen.findByText("Ready", {}, { timeout: 8000 })).toBeInTheDocument();
    const settled = listCalls;
    await act(() => new Promise((resolve) => setTimeout(resolve, 3500)));
    expect(listCalls).toBe(settled); // no more polling once nothing is in flight
  }, 30_000);

  it("surfaces 409 export_running on request", async () => {
    handlers({ "POST /api/v1/portability/exports": () => apiError(409, "export_running") });
    await openExport();
    await userEvent.setup().click(screen.getByRole("button", { name: "Start export" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Export already in progress");
  }, 20_000);

  it("sends a stale owner to step-up when requesting", async () => {
    handlers({
      "POST /api/v1/portability/exports": () =>
        apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openExport();
    await userEvent.setup().click(screen.getByRole("button", { name: "Start export" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Fsettings%2Fexport");
  }, 20_000);

  it("hands a ready export to the browser's download manager instead of buffering it", async () => {
    const clicks = captureClicks();
    try {
      const { calls } = handlers({
        "GET /api/v1/portability/exports/{id}/download": () => {
          throw new Error("the zip must not be fetched into the page");
        },
      });
      await openExport();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: /^Download the export from/u }));
      await waitFor(() => expect(clicks.clicked).toHaveLength(1));
      const anchor = clicks.clicked[0];
      expect(new URL(anchor?.href ?? "").pathname).toBe(DOWNLOAD_PATH);
      expect(anchor?.download).toBe("acme-export-2026-09-20.zip");
      // Streamed by the browser: never fetched (buffered) by the page, never a blob URL.
      expect(calls.some((c) => c.path === DOWNLOAD_PATH)).toBe(false);
      expect(clicks.createObjectURL).not.toHaveBeenCalled();
      // The preflight read the row and the session first.
      expect(calls.some((c) => c.path === `/api/v1/portability/exports/${READY_ID}`)).toBe(true);
      expect(await screen.findByText("SHA-256 of acme-export-2026-09-20.zip")).toBeInTheDocument();
      expect(screen.getAllByText(SHA).length).toBeGreaterThan(1);
      expect(
        screen.getByText(/compare this with the SHA-256 of the saved file/u),
      ).toBeInTheDocument();
    } finally {
      clicks.undo();
    }
  }, 20_000);

  it.each([
    ["an expired export (410)", exportRow({ status: "expired" }), "Export expired"],
    [
      "a ready export past its expiry (410)",
      exportRow({ expiresAt: "2026-01-01T00:00:00.000Z" }),
      "Export expired",
    ],
    ["an export being prepared (409)", exportRow({ status: "running" }), "Export not ready yet"],
    ["a failed export (409)", exportRow({ status: "failed" }), "Export not ready yet"],
  ])(
    "refuses %s before navigating",
    async (_label, row, title) => {
      const clicks = captureClicks();
      try {
        const { calls } = handlers({ "GET /api/v1/portability/exports/{id}": () => [200, row] });
        await openExport();
        await userEvent
          .setup()
          .click(await screen.findByRole("button", { name: /^Download the export from/u }));
        expect(await screen.findByRole("alert")).toHaveTextContent(title);
        expect(clicks.clicked).toHaveLength(0);
        expect(calls.some((c) => c.path === DOWNLOAD_PATH)).toBe(false);
      } finally {
        clicks.undo();
      }
    },
    20_000,
  );

  it("surfaces a refusal of the preflight read", async () => {
    const clicks = captureClicks();
    try {
      handlers({ "GET /api/v1/portability/exports/{id}": () => apiError(410, "export_expired") });
      await openExport();
      await userEvent
        .setup()
        .click(await screen.findByRole("button", { name: /^Download the export from/u }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Export expired");
      expect(clicks.clicked).toHaveLength(0);
    } finally {
      clicks.undo();
    }
  }, 20_000);

  it.each<[string, () => [number, unknown, Record<string, string>?]]>([
    ["an old sign-in", () => [200, ownerMe(new Date(Date.now() - 11 * MINUTE).toISOString())]],
    // Fresh by this browser's clock, stale by the server's: the server's `Date` decides.
    [
      "a sign-in the server's clock says is stale",
      () => [
        200,
        ownerMe(new Date(Date.now() - 5 * MINUTE).toISOString()),
        { date: new Date(Date.now() + 6 * MINUTE).toUTCString() },
      ],
    ],
  ])(
    "sends %s to step-up before downloading",
    async (_label, respond) => {
      const clicks = captureClicks();
      try {
        let stale = false;
        const { calls } = handlers({
          // The session goes stale once the page is up: the preflight's read sees it.
          "GET /api/v1/me": () => (stale ? respond() : [200, ownerMe()]),
        });
        const r = await openExport();
        stale = true;
        await userEvent
          .setup()
          .click(await screen.findByRole("button", { name: /^Download the export from/u }));
        await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
        expect(pathOf(r.router)).toContain("reason=fresh");
        expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Fsettings%2Fexport");
        expect(clicks.clicked).toHaveLength(0);
        expect(calls.some((c) => c.path === DOWNLOAD_PATH)).toBe(false);
      } finally {
        clicks.undo();
      }
    },
    20_000,
  );

  it("deletes an export after confirming", async () => {
    let deleted = false;
    const { calls } = handlers({
      "GET /api/v1/portability/exports": () => [200, { items: deleted ? [] : [exportRow()] }],
      "DELETE /api/v1/portability/exports/{id}": () => {
        deleted = true;
        return new Response(null, { status: 204 });
      },
    });
    await openExport();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Delete the export from/u }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this export?" });
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "DELETE" && c.path === `/api/v1/portability/exports/${READY_ID}`,
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("No exports yet.")).toBeInTheDocument();
  }, 20_000);

  it("refuses the screen without portability.export", async () => {
    const { calls } = handlers({}, []);
    await renderApp("/admin/settings/export");
    expect(
      await screen.findByText(
        "Only the workspace owner can export the workspace.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/api/v1/portability/"))).toBe(false);
  }, 20_000);
});
