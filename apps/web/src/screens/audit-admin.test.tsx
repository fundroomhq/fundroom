import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  apiError,
  auditEvent,
  auditExportKeys,
  type Handler,
  installMockApi,
  withPlanEntitlements,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/audit` (E2.7): filters, the cursor-paged event list with per-row JSON detail, chain
 * verification, the signed export (audit.export + step-up; a zip fetched as bytes) and the
 * public keys an export is checked against.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f07";
const ADA_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02";
const SECOND_EVENT = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e21";
const CP_NEW = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e31";
const CP_OLD = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e32";
const BATCH = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e33";
const CP_FAILED = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e34";

/** E3.13: one waiting checkpoint, one anchored by both drivers, one whose retries ran out. */
function anchorPage(): FundRoomSchemas["AuditAnchorPage"] {
  return {
    configured: ["rfc3161", "rekor"],
    planAllows: true,
    items: [
      {
        checkpointId: CP_NEW,
        seq: 42,
        createdAt: "2026-09-12T02:10:00.000Z",
        anchored: false,
        batchId: null,
        receipts: [],
        state: "pending",
      },
      {
        checkpointId: CP_FAILED,
        seq: 30,
        createdAt: "2026-08-30T02:10:00.000Z",
        anchored: false,
        batchId: BATCH,
        receipts: [],
        state: "failed",
      },
      {
        checkpointId: CP_OLD,
        seq: 41,
        createdAt: "2026-09-11T02:10:00.000Z",
        anchored: true,
        batchId: BATCH,
        state: "anchored",
        receipts: [
          {
            kind: "rfc3161",
            reference: "https://tsa.example.test serial 0x2a",
            anchoredAt: "2026-09-11T02:40:05.000Z",
          },
          {
            kind: "rekor",
            reference: "https://log2025-1.rekor.sigstore.dev log index 1234",
            anchoredAt: "2026-09-11T02:40:06.000Z",
          },
        ],
      },
    ],
    nextCursor: null,
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

function person(id: string, name: string): FundRoomSchemas["Person"] {
  return {
    membershipId: id,
    userId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c10",
    kind: "external",
    role: "investor",
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
  permissions = ["audit.read", "audit.export", "access.read"],
) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        modules: [
          {
            id: "audit",
            version: "0.1.0",
            enabled: true,
            hidden: false,
            readOnly: false,
            flags: {},
            slots: {
              "admin.nav": [{ id: "audit-log", label: "Audit log", to: "/admin/audit", order: 40 }],
            },
          },
        ],
        permissions,
        membership: { id: OWNER_ID, kind: "staff", role: "owner" },
      }),
    ],
    "GET /api/v1/access/people": () => [
      200,
      { items: [person(ADA_ID, "Ada Lovelace")], nextCursor: null },
    ],
    "GET /api/v1/audit/events": ({ url }) =>
      url.searchParams.get("cursor") === "c2"
        ? [
            200,
            {
              items: [
                auditEvent({
                  id: SECOND_EVENT,
                  seq: 41,
                  action: "access.revoked",
                  outcome: "denied",
                  actorKind: "system",
                  actorMembershipId: null,
                  actorName: null,
                }),
              ],
              nextCursor: null,
            },
          ]
        : [200, { items: [auditEvent()], nextCursor: "c2" }],
    "GET /api/v1/audit/export-key": () => [200, auditExportKeys()],
    "GET /api/v1/audit/anchors": () => [
      200,
      { configured: [], planAllows: true, items: [], nextCursor: null },
    ],
    ...over,
  });
}

async function openAudit() {
  const r = await renderApp("/admin/audit");
  expect(
    await screen.findByRole("heading", { name: "Audit log", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

function withObjectUrls() {
  const created: string[] = [];
  const clicked: HTMLAnchorElement[] = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      created.push(blob.type);
      return `blob:${created.length}`;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function mocked(
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  return {
    created,
    clicked,
    undo: () => {
      click.mockRestore();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    },
  };
}

describe("audit log admin", () => {
  it("lists events, pages with load more, and expands a row to its JSON", async () => {
    handlers();
    const r = await openAudit();
    expect(await screen.findByText("access.invited")).toBeInTheDocument();
    expect(screen.getAllByText("Grace Hopper").length).toBeGreaterThan(0);
    expect(screen.getByText("Ada Lovelace", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText("Succeeded", { selector: "[data-slot=badge]" })).toBeInTheDocument();
    // Public keys and the verify-export note.
    expect(
      await screen.findByText("0vN6m1a6Xx2A0h8d7hZf6k0cQ2c9C6r3oS4r0VbqM9w="),
    ).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText(/fundroom audit verify-export/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Details of event 42 (access.invited)" }));
    const detail = await screen.findByRole("region", {
      name: "Details of event 42 (access.invited)",
    });
    expect(within(detail).getByText(/"role": "investor"/u)).toBeInTheDocument();
    expect(within(detail).getByText("203.0.113.0/24")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("access.revoked")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("Denied", { selector: "[data-slot=badge]" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  }, 20_000);

  it("sends the filters as query parameters and rejects a malformed action", async () => {
    const { calls } = handlers();
    await openAudit();
    await screen.findByText("access.invited");
    const user = userEvent.setup();
    const action = screen.getByRole("textbox", { name: "Action" });
    await user.type(action, "Access!");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(await screen.findByText(/Use lowercase words separated by dots/u)).toBeInTheDocument();
    expect(action).toHaveAttribute("aria-invalid", "true");

    await user.clear(action);
    await user.type(action, "access.");
    await user.selectOptions(screen.getByRole("combobox", { name: "Done by" }), ADA_ID);
    await user.selectOptions(screen.getByRole("combobox", { name: "Outcome" }), "denied");
    await user.type(screen.getByRole("textbox", { name: "Resource kind" }), "membership");
    await user.type(screen.getByLabelText("From"), "2026-09-01");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => {
      const last = calls.filter((c) => c.path === "/api/v1/audit/events").length;
      expect(last).toBeGreaterThanOrEqual(2);
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    const urls = fetchMock.mock.calls
      .map(([input]) => new URL(input instanceof Request ? input.url : String(input)))
      .filter((u) => u.pathname === "/api/v1/audit/events");
    const filtered = urls.at(-1);
    expect(filtered?.searchParams.get("action")).toBe("access.");
    expect(filtered?.searchParams.get("actorMembershipId")).toBe(ADA_ID);
    expect(filtered?.searchParams.get("outcome")).toBe("denied");
    expect(filtered?.searchParams.get("resourceKind")).toBe("membership");
    expect(filtered?.searchParams.get("from")).toMatch(/^2026-0[89]-/u);
    expect(filtered?.searchParams.has("to")).toBe(false);
  }, 20_000);

  it("verifies the chain on demand and shows problems", async () => {
    const { calls } = handlers({
      "GET /api/v1/audit/verify": () => [
        200,
        {
          ok: false,
          headSeq: 42,
          checkedRows: 42,
          checkpoints: 1,
          problems: ["seq 17: hash mismatch"],
        },
      ],
    });
    const r = await openAudit();
    expect(calls.some((c) => c.path === "/api/v1/audit/verify")).toBe(false);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Verify chain" }));
    expect(await screen.findByText("The chain did not verify")).toBeInTheDocument();
    expect(
      screen.getByText("42 events and 1 checkpoints checked, up to event 42."),
    ).toBeInTheDocument();
    expect(screen.getByText("seq 17: hash mismatch")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("downloads a signed export for the chosen range", async () => {
    const urls = withObjectUrls();
    try {
      const { calls } = handlers({
        "POST /api/v1/audit/exports": () =>
          new Response(new Blob(["PK"], { type: "application/zip" }), {
            status: 200,
            headers: { "content-type": "application/zip", "x-content-sha256": "ab".repeat(32) },
          }),
      });
      await openAudit();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Export…" }));
      const dialog = await screen.findByRole("dialog", { name: "Export the audit log" });
      await user.type(within(dialog).getByLabelText("From"), "2026-09-01");
      await user.type(within(dialog).getByLabelText("To"), "2026-09-10");
      await expectNoA11yViolations(dialog);
      await user.click(within(dialog).getByRole("button", { name: "Download zip" }));
      await waitFor(() => expect(urls.clicked).toHaveLength(1));
      expect(urls.clicked[0]?.download).toMatch(/^audit-export-acme-\d{4}-\d{2}-\d{2}\.zip$/u);
      const post = calls.find((c) => c.method === "POST" && c.path === "/api/v1/audit/exports");
      const body = post?.body as { from?: string; to?: string };
      expect(body.from).toMatch(/^2026-0[89]-/u);
      expect(body.to).toMatch(/^2026-09-1/u);
      expect(await screen.findByText("ab".repeat(32))).toBeInTheDocument();
    } finally {
      urls.undo();
    }
  }, 20_000);

  it("sends a stale owner to step-up when exporting", async () => {
    handlers({
      "POST /api/v1/audit/exports": () => apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openAudit();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export…" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Download zip" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Faudit");
  }, 20_000);

  it.each([
    [
      "an export already running",
      () => apiError(409, "conflict", { reason: "export_running" }),
      "An export of this audit log is already being prepared. Wait for it to finish, then try again.",
    ],
    [
      "a range over the row cap",
      () => apiError(413, "payload_too_large", { rows: 60_000, maxRows: 50_000 }),
      "That range holds more than 50,000 events, too many for one export. Choose a shorter date range and export it in parts.",
    ],
  ])(
    "explains %s",
    async (_label, respond, message) => {
      handlers({ "POST /api/v1/audit/exports": respond });
      await openAudit();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Export…" }));
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Download zip" }));
      // The toast and its live-region announcement both carry it.
      expect((await screen.findAllByText(message)).length).toBeGreaterThan(0);
    },
    20_000,
  );

  it("hides export without audit.export and people pickers without access.read", async () => {
    handlers({}, ["audit.read"]);
    const r = await openAudit();
    await screen.findByText("access.invited");
    expect(screen.queryByRole("button", { name: "Export…" })).toBeNull();
    expect(
      screen.getByText("Only workspace owners and legal staff can export the audit log."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Done by" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains that external anchoring is off when no driver is configured", async () => {
    handlers();
    const r = await openAudit();
    expect(
      await screen.findByText("External anchoring is not set up on this server"),
    ).toBeInTheDocument();
    expect(screen.getByText(/AUDIT_ANCHOR_DRIVERS/u)).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Receipts" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  // A-3 (decision 20): every workspace is anchored whatever its plan; downloading a proof is
  // what the plan gates. The page lists everything as usual and says why proofs are greyed out.
  describe("on a plan without external audit anchoring", () => {
    const NOTICE =
      "Your audit log is still anchored. Downloading proofs needs a plan that includes External audit anchoring.";
    const proofButton = () =>
      screen.findByRole(
        "button",
        { name: "Download the anchor proof for the checkpoint up to event 41" },
        { timeout: 5000 },
      );

    it("lists drivers and receipts as usual and greys out proof downloads, saying why", async () => {
      const { calls } = handlers({
        "GET /api/v1/audit/anchors": () => [200, { ...anchorPage(), planAllows: false }],
      });
      const r = await openAudit();
      expect(await screen.findByText(NOTICE, {}, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.getByRole("list", { name: "Anchored with" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Receipts" })).toBeInTheDocument();
      expect(screen.queryByText("External anchoring is not set up on this server")).toBeNull();
      const button = await proofButton();
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(new RegExp(NOTICE.slice(0, 30), "u"));
      await userEvent.setup().click(button);
      expect(calls.some((c) => c.path.endsWith("/proof"))).toBe(false);
      await expectNoA11yViolations(r.container);
    }, 20_000);

    it("follows the server over the bootstrap", async () => {
      handlers({
        "GET /api/v1/audit/anchors": () => [200, { ...anchorPage(), planAllows: true }],
      });
      withPlanEntitlements({ features: [] });
      await openAudit();
      expect(await proofButton()).toBeEnabled();
      expect(screen.queryByText(NOTICE)).toBeNull();
    }, 20_000);

    it("offers proofs with no notice while the plan includes anchoring", async () => {
      handlers({
        "GET /api/v1/audit/anchors": () => [200, { ...anchorPage(), planAllows: true }],
      });
      await openAudit();
      expect(await proofButton()).toBeEnabled();
      expect(screen.queryByText(NOTICE)).toBeNull();
    }, 20_000);
  });

  it("lists checkpoints with their receipts and downloads a proof", async () => {
    const urls = withObjectUrls();
    try {
      const { calls } = handlers({
        "GET /api/v1/audit/anchors": () => [200, anchorPage()],
        "GET /api/v1/audit/anchors/{checkpointId}/proof": ({ params }) => [
          200,
          {
            checkpoint: {
              workspace_id: OWNER_ID,
              seq: 41,
              hash: "ab".repeat(32),
              event_id: SECOND_EVENT,
              head_occurred_at: "2026-09-11T01:00:00.000Z",
              previous_checkpoint_id: null,
            },
            leafHash: "cd".repeat(32),
            leafIndex: 3,
            path: ["ef".repeat(32)],
            treeSize: 5,
            root: "01".repeat(32),
            receipts: [],
            requested: params["checkpointId"],
          },
        ],
      });
      const r = await openAudit();
      const anchors = (
        await screen.findByText("External anchors", { selector: "[data-slot=card-title]" })
      ).closest("[data-slot=card]") as HTMLElement;
      const list = await within(anchors).findByRole("list", { name: "Anchored with" });
      expect(within(list).getByText("RFC 3161 time-stamp authority")).toBeInTheDocument();
      expect(within(list).getByText("Rekor transparency log")).toBeInTheDocument();
      expect(within(anchors).getByText("Up to event 41")).toBeInTheDocument();
      expect(within(anchors).getByText("Anchored")).toBeInTheDocument();
      // Never green unless a receipt exists.
      expect(
        within(anchors).getByText("Pending", { selector: "[data-slot=badge]" }),
      ).not.toHaveClass("bg-success");
      expect(within(anchors).getByText("Failed", { selector: "[data-slot=badge]" })).toHaveClass(
        "bg-destructive",
      );
      // Rekor proves presence only; the RFC 3161 time-stamp is the trusted time.
      expect(within(anchors).getByText(/proves presence, not time/u)).toBeInTheDocument();
      expect(within(anchors).getByText(/time-stamped/u)).toBeInTheDocument();
      expect(
        within(anchors).getByText("https://log2025-1.rekor.sigstore.dev log index 1234"),
      ).toBeInTheDocument();
      expect(within(anchors).getByText(/fundroom audit verify-anchor/u)).toBeInTheDocument();
      // Only an anchored checkpoint has a proof to hand out.
      expect(
        within(anchors).queryByRole("button", {
          name: "Download the anchor proof for the checkpoint up to event 42",
        }),
      ).toBeNull();
      await expectNoA11yViolations(r.container);

      const user = userEvent.setup();
      await user.click(
        within(anchors).getByRole("button", {
          name: "Download the anchor proof for the checkpoint up to event 41",
        }),
      );
      await waitFor(() => expect(urls.clicked).toHaveLength(1));
      expect(urls.clicked[0]?.download).toBe("audit-anchor-proof-41.json");
      expect(urls.created).toEqual(["application/json"]);
      expect(calls.some((c) => c.path === `/api/v1/audit/anchors/${CP_OLD}/proof`)).toBe(true);
    } finally {
      urls.undo();
    }
  }, 20_000);

  it("offers no proof download without audit.export", async () => {
    handlers({ "GET /api/v1/audit/anchors": () => [200, anchorPage()] }, ["audit.read"]);
    const r = await openAudit();
    expect(await screen.findByText("Up to event 41")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download the anchor proof/u })).toBeNull();
    expect(
      screen.getByText("Only workspace owners and legal staff can download anchor proofs."),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("adds the anchor summary to the chain verification", async () => {
    handlers({
      "GET /api/v1/audit/verify": () => [
        200,
        {
          ok: true,
          headSeq: 42,
          checkedRows: 42,
          checkpoints: 2,
          problems: [],
          anchors: {
            checked: 3,
            verified: 1,
            unverifiedOrigin: 1,
            failed: 0,
            missing: 0,
            presenceOnly: 1,
            late: 1,
          },
        },
      ],
    });
    const r = await openAudit();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Verify chain" }));
    const summary = await screen.findByRole("region", { name: "External anchors" });
    const row = (label: string) =>
      within(summary).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(row("Checkpoints checked")).toBe("3");
    expect(row("Verified with a trusted time")).toBe("1");
    expect(row("In a log, no trusted time")).toBe("1");
    expect(row("Anchored late (after 8 days)")).toBe("1");
    expect(row("Signer not pinned")).toBe("1");
    expect(row("Failed")).toBe("0");
    expect(
      within(summary).getByText(/signed by a service this server does not pin/u),
    ).toBeInTheDocument();
    expect(within(summary).getByText(/but not when they were written/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("refuses the screen without audit.read", async () => {
    const { calls } = handlers({}, []);
    await renderApp("/admin/audit");
    expect(
      await screen.findByText(
        "Only workspace owners, admins and legal staff can see the audit log.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/api/v1/audit/"))).toBe(false);
  }, 20_000);
});
