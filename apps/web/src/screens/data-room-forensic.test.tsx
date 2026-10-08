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
  json,
  withPlanEntitlements,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * Forensic watermarking in the data-room admin (E3.13, ADR-0061): the per-document protection
 * switch and the settings default, and — for `data-room.forensics` only — the recipients list
 * and the "Trace a leak" dialog (image + page + version, verdict table, every refusal explained).
 */
afterEach(() => vi.unstubAllGlobals());

const ROOT = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01";
const DOC = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e04";
const V1 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e05";
const V2 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e06";
const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c01";
const ADA = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c02";
const ALAN = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c03";
const NOW = "2026-09-12T10:00:00.000Z";

const granted: FundRoomSchemas["AccessDecision"] = {
  allowed: true,
  capabilities: ["view", "download", "edit"],
  pendingGates: [],
  reason: "granted",
};

function document(
  over: Partial<FundRoomSchemas["DataRoomDocument"]> = {},
): FundRoomSchemas["DataRoomDocument"] {
  return {
    id: DOC,
    folderId: ROOT,
    title: "Pitch deck",
    index: "3",
    sortOrder: 1,
    protection: { download: false, watermark: true, print: false, forensic: true },
    legalHold: false,
    currentVersionId: V2,
    contentType: "application/pdf",
    sizeBytes: 123_456,
    pageCount: 12,
    renderStatus: "ready",
    scanStatus: "clean",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    purgeAfter: null,
    ...over,
  };
}

function version(id: string, versionNo: number, pageCount: number, isCurrent: boolean) {
  return {
    id,
    versionNo,
    fileName: `deck-v${versionNo}.pdf`,
    contentType: "application/pdf",
    sizeBytes: 123_456,
    pageCount,
    renderStatus: "ready",
    renderDetail: null,
    changeNote: null,
    uploadedBy: OWNER_ID,
    createdAt: NOW,
    isCurrent,
  } satisfies FundRoomSchemas["DataRoomVersion"];
}

function detail(
  over: Partial<FundRoomSchemas["DataRoomDocumentDetail"]> = {},
): FundRoomSchemas["DataRoomDocumentDetail"] {
  return {
    document: document(),
    folder: { id: ROOT, name: "Data room", path: "r" },
    currentVersion: version(V2, 2, 12, true),
    scan: { status: "clean", engine: "clamd", detail: null, scannedAt: NOW },
    versions: [version(V2, 2, 12, true), version(V1, 1, 8, false)],
    access: granted,
    availability: { viewable: true, download: "original", reason: "ready" },
    legalHold: null,
    ...over,
  };
}

function recipient(
  membershipId: string,
  displayName: string,
  email: string | null,
  versionId = V2,
  versionNo = 2,
): FundRoomSchemas["ForensicRecipient"] {
  return {
    membershipId,
    displayName,
    email,
    versionId,
    versionNo,
    firstServedAt: "2026-09-10T09:00:00.000Z",
    lastServedAt: "2026-09-11T15:30:00.000Z",
    trace: membershipId === ADA ? "MFRGGZDF" : "KRUGKIDR",
    servedUnderViewAs: false,
    viewAsMembershipId: null,
  };
}

function detection(
  over: Partial<FundRoomSchemas["ForensicDetectionResult"]> = {},
): FundRoomSchemas["ForensicDetectionResult"] {
  return {
    documentId: DOC,
    versionId: V1,
    page: 3,
    alignment: { scale: 0.62, dx: 4, dy: -2, quality: 0.91 },
    candidatesTested: 14,
    keysMissing: 0,
    noMatchCount: 12,
    // What the server says it used (forensicThresholds(N)); the screen must not assume 6/4.
    thresholds: { match: 6.21, inconclusive: 4.08 },
    tamperSuspected: false,
    results: [
      {
        membershipId: ADA,
        displayName: "Ada Lovelace",
        email: "ada@example.test",
        z: 9.84,
        verdict: "match",
        servedUnderViewAs: false,
        viewAsMembershipId: null,
        firstServedAt: "2026-09-10T09:00:00.000Z",
        lastServedAt: "2026-09-11T15:30:00.000Z",
      },
      {
        membershipId: ALAN,
        displayName: "Alan Turing",
        email: null,
        z: 4.31,
        verdict: "inconclusive",
        servedUnderViewAs: true,
        viewAsMembershipId: ADA,
        firstServedAt: "2026-09-10T11:00:00.000Z",
        lastServedAt: "2026-09-10T11:00:00.000Z",
      },
    ],
    ...over,
  };
}

const BASE_PERMISSIONS = [
  "data-room.read",
  "data-room.manage",
  "data-room.download",
  "data-room.settings",
];

const staffBootstrap = (permissions: string[]) =>
  bootstrap({
    modules: [
      {
        id: "data-room",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "admin.nav": [
            { id: "dr", label: "Data room", to: "/admin/data-room", order: 30, icon: "folder" },
          ],
        },
      },
    ],
    permissions,
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

function handlers(
  over: Record<string, Handler> = {},
  permissions = [...BASE_PERMISSIONS, "data-room.forensics"],
) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions)],
    "GET /api/v1/data-room/tree": () => [200, { rootId: ROOT, folders: [], documents: [] }],
    "GET /api/v1/data-room/documents/{id}": () => [200, detail()],
    "GET /api/v1/data-room/documents/{id}/forensic/recipients": ({ url }) =>
      url.searchParams.get("versionId") === V1
        ? [200, { items: [recipient(ALAN, "Alan Turing", null, V1, 1)], nextCursor: null }]
        : [
            200,
            {
              items: [
                recipient(ADA, "Ada Lovelace", "ada@example.test"),
                recipient(ALAN, "Alan Turing", null, V1, 1),
              ],
              nextCursor: null,
            },
          ],
    ...over,
  });
}

async function openDocument() {
  const r = await renderApp(`/admin/data-room/documents/${DOC}`);
  expect(await screen.findByText(/12 pages/u, {}, { timeout: 5000 })).toBeInTheDocument();
  return r;
}

async function openTrace() {
  const user = userEvent.setup({ applyAccept: false });
  await user.click(await screen.findByRole("button", { name: "Trace a leak…" }));
  const dialog = await screen.findByRole("dialog", { name: "Trace a leak of Pitch deck" });
  return { user, dialog };
}

function png(name = "leak.png", type = "image/png", size?: number): File {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type });
  if (size !== undefined) Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("data room forensic watermarking", () => {
  it("toggles the forensic protection switch with its helper text", async () => {
    let current = detail({
      document: document({
        protection: { download: false, watermark: true, print: false, forensic: false },
      }),
    });
    const { calls } = handlers({
      "GET /api/v1/data-room/documents/{id}": () => [200, current],
      "PATCH /api/v1/data-room/documents/{id}": ({ body }) => {
        const protection = (body as { protection: { forensic: boolean } }).protection;
        current = detail({
          document: document({ protection: { ...current.document.protection, ...protection } }),
        });
        return [200, current];
      },
    });
    const r = await openDocument();
    const toggle = screen.getByRole("switch", { name: "Forensic watermark" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription(/invisible mark, unique to each viewer/u);
    expect(
      await screen.findByText(/Forensic watermarking is off for this document/u),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await userEvent.setup().click(toggle);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        protection: { forensic: true },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Forensic watermark" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
  }, 20_000);

  it("lists recipients with a marked copy and filters by version", async () => {
    const { calls } = handlers();
    const r = await openDocument();
    const section = await screen.findByRole("region", { name: "Recipients with a marked copy" });
    expect(await within(section).findByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(section).getByText("ada@example.test")).toBeInTheDocument();
    expect(within(section).getByRole("cell", { name: "v1" })).toBeInTheDocument();
    expect(within(section).getByText("MFRGGZDF")).toBeInTheDocument();
    expect(within(section).queryByText(/served under view-as/u)).toBeNull();
    await expectNoA11yViolations(r.container);

    await userEvent
      .setup()
      .selectOptions(within(section).getByRole("combobox", { name: "Version" }), V1);
    await waitFor(() => expect(within(section).queryByText("Ada Lovelace")).toBeNull());
    expect(within(section).getByText("Alan Turing")).toBeInTheDocument();
    const fetched = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : String(input)))
      .filter((u) => u.pathname.endsWith("/forensic/recipients"));
    expect(fetched.at(-1)?.searchParams.get("versionId")).toBe(V1);
    expect(calls.some((c) => c.path.endsWith("/forensic/recipients"))).toBe(true);
  }, 20_000);

  it("names the last investor a staff recipient viewed as, when people are readable", async () => {
    handlers(
      {
        "GET /api/v1/data-room/documents/{id}/forensic/recipients": () => [
          200,
          {
            items: [
              recipient(ADA, "Ada Lovelace", "ada@example.test"),
              {
                ...recipient(OWNER_ID, "Grace Hopper", "grace@example.test"),
                servedUnderViewAs: true,
                viewAsMembershipId: ADA,
              },
            ],
            nextCursor: null,
          },
        ],
        "GET /api/v1/access/people": () => [
          200,
          {
            items: [
              {
                membershipId: ADA,
                userId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c10",
                kind: "external",
                role: "investor",
                status: "active",
                displayName: "Ada Lovelace",
                email: "ada@example.test",
                groups: [],
                profile: {},
                source: "invite",
                principalMembershipId: null,
                delegateScope: null,
                principal: null,
                expiresAt: null,
                lastSeenAt: null,
                activatedAt: null,
                createdAt: NOW,
                relationship: {
                  establishedAt: null,
                  source: null,
                  note: null,
                  firstExposureAt: null,
                  warning: null,
                },
              },
            ],
            nextCursor: null,
          },
        ],
      },
      [...BASE_PERMISSIONS, "data-room.forensics", "access.read"],
    );
    const r = await openDocument();
    const section = await screen.findByRole("region", { name: "Recipients with a marked copy" });
    expect(
      await within(section).findByText("Also served under view-as (last as Ada Lovelace)"),
    ).toBeInTheDocument();
    expect(within(section).getAllByText(/served under view-as \(last/u)).toHaveLength(1);
    expect(
      within(section).getByText(/at least once while viewing the portal/u),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("hides tracing and recipients without data-room.forensics", async () => {
    const { calls } = handlers({}, BASE_PERMISSIONS);
    await openDocument();
    // The protection switch is still there for a manager; tracing is not.
    expect(screen.getByRole("switch", { name: "Forensic watermark" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Trace a leak…" })).toBeNull();
    expect(screen.queryByText("Forensic tracing")).toBeNull();
    expect(calls.some((c) => c.path.includes("/forensic/"))).toBe(false);
  }, 20_000);

  it("checks the image and page before sending anything", async () => {
    const { calls } = handlers();
    await openDocument();
    const { user, dialog } = await openTrace();
    await expectNoA11yViolations(dialog);

    await user.click(within(dialog).getByRole("button", { name: "Trace" }));
    expect(within(dialog).getByText("Choose the image to test.")).toBeInTheDocument();

    const input = within(dialog).getByLabelText(/^Leaked page image/u);
    await user.upload(input, png("leak.gif", "image/gif"));
    expect(within(dialog).getByText("That isn't a PNG, JPEG or WebP image.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");

    await user.upload(input, png("huge.png", "image/png", 16 * 1024 * 1024));
    expect(within(dialog).getByText("That image is larger than 15 MB.")).toBeInTheDocument();

    await user.upload(input, png());
    const page = within(dialog).getByRole("spinbutton", { name: /^Page number/u });
    await user.clear(page);
    await user.type(page, "13");
    await user.click(within(dialog).getByRole("button", { name: "Trace" }));
    expect(within(dialog).getByText("This version has only 12 pages.")).toBeInTheDocument();
    // The limit follows the chosen version: v1 has 8 pages.
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /^Version/u }), V1);
    await user.clear(page);
    await user.type(page, "9");
    await user.click(within(dialog).getByRole("button", { name: "Trace" }));
    expect(within(dialog).getByText("This version has only 8 pages.")).toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith("/forensic/detect"))).toBe(false);
  }, 20_000);

  it("traces a leaked page and explains the verdicts", async () => {
    const { calls } = handlers({
      "POST /api/v1/data-room/documents/{id}/forensic/detect": () => [200, detection()],
    });
    await openDocument();
    const { user, dialog } = await openTrace();
    // The reading guide is on screen before anything is sent.
    expect(
      within(dialog).getByText(/threshold that rises with the number of recipients tested/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/below about one in a million/u)).toBeInTheDocument();
    expect(within(dialog).queryByText(/one in a billion/u)).toBeNull();
    expect(
      within(dialog).getByText(/evidence of whose copy the image came from, not proof/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/is not stored/u)).toBeInTheDocument();

    await user.upload(within(dialog).getByLabelText(/^Leaked page image/u), png());
    const page = within(dialog).getByRole("spinbutton", { name: /^Page number/u });
    await user.clear(page);
    await user.type(page, "3");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: /^Version/u }), V1);
    await user.click(within(dialog).getByRole("button", { name: "Trace" }));

    const result = await within(dialog).findByRole("region", { name: "Result" });
    const rows = within(result).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Match")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("9.8")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Inconclusive")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("4.3")).toBeInTheDocument();
    expect(within(result).getByText("Page 3 of v1")).toBeInTheDocument();
    expect(within(result).getByText("14")).toBeInTheDocument();
    const dd = (label: string) =>
      within(result).getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
    expect(dd("Not matched")).toBe("12");
    // The thresholds the server used, not fixed numbers.
    expect(dd("Thresholds used")).toBe("match from 6.2, inconclusive from 4.1");
    expect(within(result).queryByRole("alert")).toBeNull();
    expect(within(result).getByText(/not as a conclusion/u)).toBeInTheDocument();
    // A mark served under view-as is the staff member's own copy, and says so.
    // No access.read: no name to show, and the copy never claims every copy was view-as.
    expect(
      within(rows[2] as HTMLElement).getByText("Also served under view-as"),
    ).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).queryByText(/served under view-as/u)).toBeNull();
    expect(
      within(result).getByText(/does not say whether a given copy, or the leaked one/u),
    ).toBeInTheDocument();
    await expectNoA11yViolations(dialog);

    const post = calls.find((c) => c.method === "POST" && c.path.endsWith("/forensic/detect"));
    expect(post?.path).toBe(`/api/v1/data-room/documents/${DOC}/forensic/detect`);
    const body = String(post?.body);
    expect(body).toMatch(/name="page"\r\n\r\n3\r\n/u);
    expect(body).toMatch(new RegExp(`name="versionId"\\r\\n\\r\\n${V1}\\r\\n`, "u"));
    expect(body).toMatch(/name="image"; filename="[^"]*"\r\nContent-Type: image\/png/u);
  }, 20_000);

  it("warns when the image looks tampered with", async () => {
    handlers({
      "POST /api/v1/data-room/documents/{id}/forensic/detect": () => [
        200,
        detection({ results: [], tamperSuspected: true }),
      ],
    });
    await openDocument();
    const { user, dialog } = await openTrace();
    await user.upload(within(dialog).getByLabelText(/^Leaked page image/u), png());
    await user.click(within(dialog).getByRole("button", { name: "Trace" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("This image may have been tampered with");
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("says when no recipient matched and when keys have been retired", async () => {
    const { calls } = handlers({
      "POST /api/v1/data-room/documents/{id}/forensic/detect": () => [
        200,
        detection({ versionId: V2, results: [], noMatchCount: 13, keysMissing: 1 }),
      ],
    });
    await openDocument();
    const { user, dialog } = await openTrace();
    await user.upload(within(dialog).getByLabelText(/^Leaked page image/u), png());
    await user.click(within(dialog).getByRole("button", { name: "Trace" }));
    expect(await within(dialog).findByText("No recipient's mark was found")).toBeInTheDocument();
    expect(within(dialog).getByText(/1 recipient couldn't be tested/u)).toBeInTheDocument();
    // Default version: nothing sent, the server picks the current one.
    const post = calls.find((c) => c.method === "POST");
    expect(String(post?.body)).not.toMatch(/name="versionId"/u);
    expect(String(post?.body)).toMatch(/name="page"\r\n\r\n1\r\n/u);
  }, 20_000);

  it.each([
    [
      "forensic_image_invalid",
      () => apiError(422, "forensic_image_invalid"),
      /Use a PNG, JPEG or WebP image of one page, at most 15 MB/u,
    ],
    [
      "forensic_no_marks",
      () => apiError(409, "forensic_no_marks"),
      /Nobody was served this version with a forensic watermark/u,
    ],
    [
      "forensic_alignment_failed",
      () => apiError(422, "forensic_alignment_failed"),
      /doesn't line up closely enough with the page you chose/u,
    ],
    [
      "forensic_too_many_candidates",
      () => apiError(422, "forensic_too_many_candidates"),
      /more recipients than one test can check/u,
    ],
    [
      "forensic_busy",
      () => apiError(503, "forensic_busy"),
      /already running as many leak traces as it can/u,
    ],
    [
      "forensic_rate_limited",
      () =>
        json(
          429,
          { error: { code: "forensic_rate_limited", message: "x", requestId: "r" } },
          { "retry-after": "1500" },
        ),
      /up to 10 images an hour\. Try again in 25 minutes\./u,
    ],
    [
      "not_found",
      () => apiError(404, "not_found"),
      /That page or version of this document doesn't exist/u,
    ],
    [
      "payload_too_large",
      () => apiError(413, "payload_too_large"),
      /Use a PNG, JPEG or WebP image of one page/u,
    ],
  ])(
    "explains %s",
    async (_code, respond, message) => {
      handlers({ "POST /api/v1/data-room/documents/{id}/forensic/detect": respond });
      await openDocument();
      const { user, dialog } = await openTrace();
      await user.upload(within(dialog).getByLabelText(/^Leaked page image/u), png());
      await user.click(within(dialog).getByRole("button", { name: "Trace" }));
      const alert = await within(dialog).findByRole("alert");
      expect(alert).toHaveTextContent(message);
      await expectNoA11yViolations(dialog);
    },
    20_000,
  );

  it("sends a stale session to step-up", async () => {
    handlers({
      "POST /api/v1/data-room/documents/{id}/forensic/detect": () =>
        apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openDocument();
    const { user, dialog } = await openTrace();
    await user.upload(within(dialog).getByLabelText(/^Leaked page image/u), png());
    await user.click(within(dialog).getByRole("button", { name: "Trace" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
  }, 20_000);

  it("saves the forensic default in data-room settings", async () => {
    let current = {
      watermarkByDefault: true,
      forensicByDefault: false,
      downloadByDefault: false,
      allowUnscanned: false,
      purgeAfterDays: 30,
      maxUploadBytes: null,
      scanner: "clamd",
      limits: { uploadMaxBytes: 2_147_483_648, renderMaxBytes: 104_857_600 },
      qa: null,
    };
    const { calls } = handlers({
      "GET /api/v1/data-room/settings": () => [200, current],
      "PATCH /api/v1/data-room/settings": ({ body }) => {
        current = { ...current, ...(body as object) };
        return [200, current];
      },
    });
    const r = await renderApp("/admin/data-room/settings");
    const toggle = await screen.findByRole(
      "switch",
      { name: "Forensic watermark on new documents by default" },
      { timeout: 5000 },
    );
    expect(toggle).toHaveAccessibleDescription(/New uploads start with the invisible/u);
    await expectNoA11yViolations(r.container);
    await userEvent.setup().click(toggle);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ forensicByDefault: true }),
    );
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  }, 20_000);
});

// A-3 (ADR-0063): forensic marking on a document under a plan without forensic watermarks.
describe("forensic switch on a plan without forensic watermarks", () => {
  it("will not switch a document's forensic marking on, and says why", async () => {
    handlers({
      "GET /api/v1/data-room/documents/{id}": () => [
        200,
        detail({
          document: document({
            protection: { download: false, watermark: true, print: false, forensic: false },
          }),
        }),
      ],
    });
    withPlanEntitlements({ features: [] });
    const r = await openDocument();
    const toggle = screen.getByRole("switch", { name: "Forensic watermark" });
    expect(toggle).toBeDisabled();
    const row = toggle.parentElement as HTMLElement;
    expect(within(row).getByText("Not on your plan")).toBeInTheDocument();
    // The other protections are not the plan's business.
    expect(screen.getByRole("switch", { name: "Watermark pages and downloads" })).toBeEnabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("lets marking that is already on be switched off", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/data-room/documents/{id}": () => [200, detail()],
    });
    withPlanEntitlements({ features: [] });
    await openDocument();
    const toggle = screen.getByRole("switch", { name: "Forensic watermark" });
    expect(toggle).toBeEnabled();
    await userEvent.setup().click(toggle);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
        protection: { forensic: false },
      }),
    );
  }, 20_000);
});

// Decision 14: a read-only data room can delete but not restore; its delete dialog says so.
describe("deleting a document in a read-only data room", () => {
  it("warns that it cannot be restored until the plan includes the module", async () => {
    const base = staffBootstrap([...BASE_PERMISSIONS, "data-room.forensics"]);
    handlers({
      "GET /api/v1/modules": () => [
        200,
        { ...base, modules: base.modules.map((mod) => ({ ...mod, readOnly: true })) },
      ],
    });
    await openDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Delete document" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete document" });
    expect(
      within(dialog).getByText(
        /The data-room module is read-only on your plan, so you won't be able to restore it until your plan includes the module\./u,
      ),
    ).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("says nothing of the kind when the module is on the plan", async () => {
    handlers();
    await openDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Delete document" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete document" });
    expect(within(dialog).queryByText(/read-only on your plan/u)).toBeNull();
  }, 20_000);
});
