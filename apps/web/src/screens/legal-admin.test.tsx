import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { esignConnection } from "../test/fixtures-esign.js";
import {
  apiError,
  complianceSettings,
  dataRequest,
  erasureRequest,
  type Handler,
  installMockApi,
  legalDocument,
  legalVersion,
  offeringState,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const ADA_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f02";
const DOC_ID = legalDocument().id;
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

const staffBootstrap = (
  permissions = ["compliance.read", "compliance.manage", "compliance.offering", "access.manage"],
) =>
  bootstrap({
    modules: [],
    permissions,
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

function handlers(over: Record<string, Handler> = {}, permissions?: string[]) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions)],
    "GET /api/v1/compliance/offering": () => [200, offeringState()],
    "GET /api/v1/compliance/settings": () => [200, complianceSettings()],
    "GET /api/v1/compliance/documents": () => [200, { documents: [legalDocument()] }],
    "GET /api/v1/compliance/templates": () => [
      200,
      {
        templates: [
          {
            id: "privacy-notice",
            title: "Privacy notice",
            version: 1,
            audience: "investor",
            jurisdiction: ["us"],
            mergeFields: ["company.name"],
            requiresAcceptance: true,
            bodySha256: "b".repeat(64),
          },
        ],
      },
    ],
    ...over,
  });
}

describe("offering mode", () => {
  it("renders the permits table from the API and takes the 506(c) confirm round trip", async () => {
    const patches: unknown[] = [];
    const { calls } = handlers({
      "PATCH /api/v1/compliance/offering": ({ body }) => {
        patches.push(body);
        const sent = body as { confirm?: string };
        // The server answers 409 until the caller echoes the status back in `confirm`.
        return sent.confirm === "506c"
          ? [
              200,
              {
                from: "506b",
                to: "506c",
                current: offeringState({ status: "506c" }).current,
                permits: offeringState({ status: "506c" }).permits,
                irrevocable: true,
              },
            ]
          : apiError(409, "conflict", {
              requiresConfirmation: true,
              from: "506b",
              to: "506c",
              confirm: "506c",
            });
      },
    });
    const r = await renderApp("/admin/legal");
    expect(
      await screen.findByRole("heading", { name: "Legal & offering" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    // The §11 table is data, not copy: the 506(c) row's accreditation cell comes from the API.
    const row = await screen.findByRole("row", { name: /Rule 506\(c\)/u }, { timeout: 5000 });
    expect(within(row).getAllByRole("cell")[4]).toHaveTextContent("Yes");
    expect(screen.getByText(/Private offering to people you already knew/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("New mode"), "506c");
    // Said before the click, not after it.
    expect(screen.getByText("Rule 506(c) cannot be undone")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change offering mode" }));

    expect(await screen.findByText("Confirm the switch to Rule 506(c)")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Yes, switch permanently" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[0]).toEqual({ status: "506c" });
    expect(patches[1]).toEqual({ status: "506c", confirm: "506c" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  }, 20_000);

  it("offers no way out of 506(c) once the workspace is on it", async () => {
    handlers({ "GET /api/v1/compliance/offering": () => [200, offeringState({ status: "506c" })] });
    const r = await renderApp("/admin/legal");
    expect(
      await screen.findByRole("heading", { name: "Legal & offering" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("This mode cannot be changed", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // No select, no options, no submit: a transition the server always refuses is never offered.
    expect(screen.queryByLabelText("New mode")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change offering mode" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Rule 506(b)" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("hides the change form without compliance.offering", async () => {
    handlers({}, ["compliance.read"]);
    await renderApp("/admin/legal");
    expect(
      await screen.findByRole("heading", { name: "Legal & offering" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change offering mode" })).toBeNull();
  }, 20_000);
});

describe("legal documents", () => {
  it("lists documents, publishes a version and shows who accepted which bytes", async () => {
    const { calls } = handlers({
      "GET /api/v1/compliance/documents/{id}": () => [
        200,
        { document: legalDocument(), current: legalVersion(), versions: [legalVersion()] },
      ],
      "POST /api/v1/compliance/documents/{id}/versions": () => [
        200,
        {
          published: true,
          document: legalDocument({ currentVersionNo: 2 }),
          version: legalVersion({ versionNo: 2, body: "# Privacy notice\n\nNew text." }),
        },
      ],
      "GET /api/v1/compliance/acceptances": () => [
        200,
        {
          items: [
            {
              membershipId: ADA_ID,
              displayName: "Ada Lovelace",
              email: "ada@investor.test",
              documentId: DOC_ID,
              slug: "privacy-notice",
              versionNo: 1,
              stamp: "privacy-notice:v1",
              acceptedAt: NOW,
              bodySha256: "a".repeat(64),
              evidenceRef: null,
            } satisfies FundRoomSchemas["AcceptanceEntry"],
          ],
          nextCursor: null,
        },
      ],
    });
    const user = userEvent.setup();
    const r = await renderApp("/admin/legal");
    expect(
      await screen.findByRole("heading", { name: "Legal & offering" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Legal documents" }));
    const link = await screen.findByRole("link", { name: "Privacy notice" });
    await expectNoA11yViolations(r.container);
    await user.click(link);

    expect(
      await screen.findByText("Publish a new version", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // The counsel framing sits on the screen where a legal text goes in front of investors.
    expect(screen.getByText("This is not legal advice")).toBeInTheDocument();
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const body = screen.getByLabelText("Text (Markdown)");
    await user.clear(body);
    await user.type(body, "New text.");
    await user.click(screen.getByRole("button", { name: "Publish version" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/versions"))?.body).toEqual({
        body: "New text.",
      }),
    );
  }, 20_000);

  it("creates a document from a template after previewing it", async () => {
    const { calls } = handlers({
      "GET /api/v1/compliance/templates/{templateId}": () => [
        200,
        {
          template: {
            id: "privacy-notice",
            title: "Privacy notice",
            version: 1,
            audience: "investor",
            jurisdiction: ["us"],
            mergeFields: [],
            requiresAcceptance: true,
            bodySha256: "b".repeat(64),
          },
          body: "# Privacy notice\n\nTemplate body.",
          preview: "# Privacy notice\n\nTemplate body.",
        },
      ],
      "POST /api/v1/compliance/documents": () => [
        200,
        { document: legalDocument(), current: null, versions: [] },
      ],
      "GET /api/v1/compliance/documents/{id}": () => [
        200,
        { document: legalDocument(), current: legalVersion(), versions: [legalVersion()] },
      ],
      "GET /api/v1/compliance/acceptances": () => [200, { items: [], nextCursor: null }],
    });
    const user = userEvent.setup();
    await renderApp("/admin/legal");
    expect(
      await screen.findByRole("heading", { name: "Legal & offering" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Legal documents" }));
    await user.selectOptions(await screen.findByLabelText("Start from"), "privacy-notice");
    await user.click(screen.getByRole("button", { name: "Show preview" }));
    expect(await screen.findByText("Template body.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create document" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/compliance/documents")?.body,
      ).toMatchObject({ slug: "privacy-notice", from: "privacy-notice" }),
    );
  }, 20_000);

  it("saves the workspace legal settings", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/compliance/settings": ({ body }) => [
        200,
        { ...complianceSettings(), ...(body as object) },
      ],
    });
    const user = userEvent.setup();
    await renderApp("/admin/legal");
    expect(
      await screen.findByRole("heading", { name: "Legal & offering" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.selectOptions(
      await screen.findByLabelText("Consent for optional tracking"),
      "opt_in",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/compliance/settings")?.body,
      ).toMatchObject({ consentMode: "opt_in", enforceAcceptance: true }),
    );
  }, 20_000);
});

describe("privacy region and legal hold", () => {
  async function openSettings(over: Record<string, Handler>) {
    const out = handlers(over);
    const user = userEvent.setup();
    const r = await renderApp("/admin/legal");
    expect(
      await screen.findByRole("heading", { name: "Legal & offering" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await screen.findByLabelText("Privacy region");
    return { ...out, user, r };
  }

  const patched = (calls: { method: string; path: string; body: unknown }[]) =>
    calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/compliance/settings")?.body;

  it("lets the server apply the region's suggested consent mode when the admin did not pick one", async () => {
    const { calls, user, r } = await openSettings({
      "PATCH /api/v1/compliance/settings": () => [
        200,
        complianceSettings({ privacyRegion: "eu", consentMode: "opt_in" }),
      ],
    });
    await expectNoA11yViolations(r.container);
    await user.selectOptions(screen.getByLabelText("Privacy region"), "eu");
    expect(
      screen.getByText(/consent mode changes to this region's suggested default/u),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patched(calls)).toBeDefined());
    const body = patched(calls) as Record<string, unknown>;
    expect(body).toMatchObject({ privacyRegion: "eu", legalHold: false });
    // Omitted on purpose: the server owns the region → mode table.
    expect(body).not.toHaveProperty("consentMode");
    // The saved answer is what the form shows afterwards.
    await waitFor(() =>
      expect(screen.getByLabelText("Consent for optional tracking")).toHaveValue("opt_in"),
    );
  }, 20_000);

  it("keeps the admin's mode when both change", async () => {
    const { calls, user } = await openSettings({
      "PATCH /api/v1/compliance/settings": ({ body }) => [
        200,
        { ...complianceSettings(), ...(body as object) },
      ],
    });
    await user.selectOptions(screen.getByLabelText("Privacy region"), "us");
    await user.selectOptions(screen.getByLabelText("Consent for optional tracking"), "opt_out");
    expect(screen.queryByText(/changes to this region's suggested default/u)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patched(calls)).toMatchObject({ privacyRegion: "us", consentMode: "opt_out" }),
    );
  }, 20_000);

  it("warns when the mode is weaker than the region suggests and applies the suggestion", async () => {
    const { calls, user, r } = await openSettings({
      "GET /api/v1/compliance/settings": () => [
        200,
        complianceSettings({
          privacyRegion: "eu",
          consentMode: "notice_only",
          suggestedConsentMode: "opt_in",
          consentModeWeakerThanRegion: true,
        }),
      ],
      "PATCH /api/v1/compliance/settings": ({ body }) => [
        200,
        { ...complianceSettings({ privacyRegion: "eu" }), ...(body as object) },
      ],
    });
    expect(screen.getByText("Weaker than the region's default")).toBeInTheDocument();
    expect(
      screen.getByText(/less protective than this region suggests \(Ask first/u),
    ).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Use suggestion" }));
    expect(screen.getByLabelText("Consent for optional tracking")).toHaveValue("opt_in");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(patched(calls)).toMatchObject({ privacyRegion: "eu", consentMode: "opt_in" }),
    );
  }, 20_000);

  it("turns legal hold on, with the consequences explained", async () => {
    const { calls, user } = await openSettings({
      "PATCH /api/v1/compliance/settings": ({ body }) => [
        200,
        { ...complianceSettings(), ...(body as object) },
      ],
    });
    expect(screen.getByText(/new erasure requests are refused/u)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Legal hold" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patched(calls)).toMatchObject({ legalHold: true }));
  }, 20_000);
});

describe("erasure requests (Data requests tab)", () => {
  const ADA = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01";
  const person = (over: Record<string, unknown> = {}) => ({
    membershipId: ADA,
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
    lastSeenAt: null,
    activatedAt: NOW,
    createdAt: NOW,
    ...over,
  });

  async function openErasure(over: Record<string, Handler>, permissions?: string[]) {
    const out = handlers(
      {
        "GET /api/v1/access/people": () => [200, { items: [person()], nextCursor: null }],
        ...over,
      },
      permissions,
    );
    const user = userEvent.setup();
    const r = await renderApp("/admin/legal");
    expect(
      await screen.findByRole("heading", { name: "Legal & offering" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Data requests" }));
    return { ...out, user, r };
  }

  async function recordFor(user: ReturnType<typeof userEvent.setup>) {
    const picker = await screen.findByLabelText("Person");
    await within(picker).findByRole("option", { name: /Ada Lovelace/u });
    await user.selectOptions(picker, ADA);
    await user.type(screen.getByLabelText("Note"), "Asked by email");
    await user.click(screen.getByRole("button", { name: "Record erasure request" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Erase Ada Lovelace's data?");
    await user.click(within(dialog).getByRole("button", { name: "Record erasure request" }));
  }

  it("lists erasure requests among data requests with due date, overdue badge and module progress, and cancels one", async () => {
    const { calls, user, r } = await openErasure({
      "GET /api/v1/compliance/data-requests": () => [
        200,
        {
          items: [
            dataRequest({
              id: erasureRequest().id,
              kind: "erasure",
              overdue: true,
              expectedModules: ["analytics", "updates"],
              pendingModules: ["updates"],
              steps: [{ module: "analytics", completedAt: NOW, counts: { events: 12 } }],
            }),
            dataRequest({
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a22",
              kind: "erasure",
              subjectName: "Grace Hopper",
              status: "completed",
              expectedModules: ["analytics", "updates"],
              completedAt: NOW,
            }),
          ],
          nextCursor: null,
        },
      ],
      "POST /api/v1/compliance/erasure-requests/{id}/cancel": () => [
        200,
        erasureRequest({ status: "cancelled", cancelledAt: NOW }),
      ],
    });
    const table = await screen.findByRole("table", { name: "Data requests" });
    const rows = within(table).getAllByRole("row");
    const open = rows[1] as HTMLElement;
    expect(within(open).getAllByRole("cell")[0]).toHaveTextContent("Ada Lovelace");
    expect(within(open).getByText("Erasure")).toBeInTheDocument();
    expect(within(open).getByText("Overdue")).toBeInTheDocument();
    const done = rows[2] as HTMLElement;
    expect(within(done).getByText("Completed")).toBeInTheDocument();
    expect(within(done).queryByText("Overdue")).toBeNull();
    await expectNoA11yViolations(r.container);

    await user.click(within(open).getByRole("button", { name: /Details/u }));
    expect(await screen.findByText("1 of 2 modules done")).toBeInTheDocument();
    expect(screen.getByText("Waiting for: updates")).toBeInTheDocument();
    expect(screen.getByText("events: 12")).toBeInTheDocument();
    // Erasure completes itself: no export, no manual completion.
    expect(screen.queryByRole("button", { name: "Mark complete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download export" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel request" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel request" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" &&
            c.path === `/api/v1/compliance/erasure-requests/${erasureRequest().id}/cancel`,
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("records a request for a picked member after confirming", async () => {
    const { calls, user, r } = await openErasure({
      "GET /api/v1/compliance/data-requests": () => [200, { items: [], nextCursor: null }],
      "POST /api/v1/compliance/erasure-requests": () => [201, erasureRequest()],
    });
    expect(await screen.findByText("No data requests match.")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    await recordFor(user);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/compliance/erasure-requests")
          ?.body,
      ).toEqual({ membershipId: ADA, note: "Asked by email" }),
    );
  }, 20_000);

  it("explains a refusal under legal hold", async () => {
    const { user, r } = await openErasure({
      "GET /api/v1/compliance/settings": () => [200, complianceSettings({ legalHold: true })],
      "GET /api/v1/compliance/data-requests": () => [200, { items: [], nextCursor: null }],
      "POST /api/v1/compliance/erasure-requests": () =>
        apiError(409, "conflict", { reason: "legal_hold" }),
    });
    // Said before the attempt, too.
    expect(await screen.findByText("Legal hold is on")).toBeInTheDocument();
    await recordFor(user);
    expect(await screen.findByText("Refused: legal hold")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains a refusal when the member already has an open request", async () => {
    const { user } = await openErasure({
      "GET /api/v1/compliance/data-requests": () => [200, { items: [], nextCursor: null }],
      "POST /api/v1/compliance/erasure-requests": () =>
        apiError(409, "conflict", {
          reason: "erasure_open",
          erasureRequestId: erasureRequest().id,
        }),
    });
    await recordFor(user);
    expect(await screen.findByText("Already requested")).toBeInTheDocument();
  }, 20_000);

  it("explains a refusal when the member is the workspace's last owner", async () => {
    const { user, r } = await openErasure({
      "GET /api/v1/compliance/data-requests": () => [200, { items: [], nextCursor: null }],
      "POST /api/v1/compliance/erasure-requests": () =>
        apiError(409, "conflict", { reason: "last_owner" }),
    });
    await recordFor(user);
    expect(await screen.findByText("Refused: last owner")).toBeInTheDocument();
    expect(screen.getByText(/Make someone else an owner first/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("sends the operator to step-up when the session is not fresh", async () => {
    const { user, r } = await openErasure({
      "GET /api/v1/compliance/data-requests": () => [200, { items: [], nextCursor: null }],
      "POST /api/v1/compliance/erasure-requests": () =>
        apiError(401, "step_up_required", { reason: "fresh" }),
    });
    await recordFor(user);
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
  }, 20_000);

  it("shows the list read-only without compliance.manage", async () => {
    await openErasure(
      {
        "GET /api/v1/compliance/data-requests": () => [
          200,
          { items: [dataRequest({ kind: "erasure" })], nextCursor: null },
        ],
      },
      ["compliance.read"],
    );
    expect(await screen.findByRole("table", { name: "Data requests" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /Details/u }));
    expect(await screen.findByText("Steps")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Cancel request/u })).toBeNull();
    expect(screen.queryByRole("button", { name: "Record erasure request" })).toBeNull();
  }, 20_000);
});

describe("relationship evidence", () => {
  function personDetail(
    warning: FundRoomSchemas["RelationshipWarning"] | null,
  ): FundRoomSchemas["PersonDetail"] {
    return {
      person: {
        membershipId: ADA_ID,
        userId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f03",
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
          firstExposureAt: NOW,
          warning,
        },
      },
      delegates: [],
      attestations: [],
      grants: [],
    };
  }

  it("prompts on a 506(b) relationship gap without refusing anything", async () => {
    const { calls } = handlers({
      "GET /api/v1/access/people/{id}": () => [
        200,
        personDetail({ code: "no_source", message: "no source recorded" }),
      ],
      "PATCH /api/v1/access/people/{id}": () => [200, personDetail(null).person],
      "GET /api/v1/access/groups": () => [200, { groups: [] }],
    });
    const user = userEvent.setup();
    const r = await renderApp(`/admin/people/${ADA_ID}`);
    expect(await screen.findByText("Worth a look", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(
      screen.getByText(/No source is recorded for how this relationship began/u),
    ).toBeInTheDocument();
    // The whole point of decision 11: it never refuses anything.
    expect(screen.getByText(/This is a prompt, not a block/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    // A native select, not Radix: an enum this short reads better as one and survives jsdom.
    const source = screen.getByLabelText("How it began");
    expect(source).not.toBeDisabled();
    await user.selectOptions(source, "intro");
    await user.click(screen.getAllByRole("button", { name: "Save" })[0] as HTMLElement);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path.includes("/access/people/"))?.body,
      ).toMatchObject({ relationship: { source: "intro" } }),
    );
  }, 20_000);
});

/*
 * The evidence half of E2.3: the register export counsel is handed, and one signature's
 * click-wrap certificate. Both are authenticated reads that answer with bytes, so neither may
 * be a plain link — a link navigation carries no request id, may carry no session cross-origin,
 * and replaces the page with a JSON error envelope when it is refused.
 */
describe("acceptance evidence", () => {
  const entry = (
    over: Partial<FundRoomSchemas["AcceptanceEntry"]> = {},
  ): FundRoomSchemas["AcceptanceEntry"] => ({
    membershipId: ADA_ID,
    displayName: "Ada Lovelace",
    email: "ada@investor.test",
    documentId: DOC_ID,
    slug: "privacy-notice",
    versionNo: 1,
    stamp: "privacy-notice:v1",
    acceptedAt: NOW,
    bodySha256: "a".repeat(64),
    evidenceRef: "ws/1/certificate/abc",
    ...over,
  });

  function withObjectUrls(): { created: string[]; clicked: HTMLAnchorElement[]; undo: () => void } {
    const created: string[] = [];
    const clicked: HTMLAnchorElement[] = [];
    // jsdom implements neither half of the object-URL pair, and `URL` must stay a constructor.
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

  async function openRegister(over: Record<string, Handler>): Promise<void> {
    handlers({
      "GET /api/v1/compliance/documents/{id}": () => [
        200,
        { document: legalDocument(), current: legalVersion(), versions: [legalVersion()] },
      ],
      ...over,
    });
    const user = userEvent.setup();
    await renderApp("/admin/legal");
    await screen.findByRole("heading", { name: "Legal & offering" }, { timeout: 5000 });
    await user.click(screen.getByRole("tab", { name: "Legal documents" }));
    await user.click(await screen.findByRole("link", { name: "Privacy notice" }));
    await screen.findByText("Who accepted", {}, { timeout: 5000 });
  }

  it("downloads one certificate as bytes, named after the stamp", async () => {
    const urls = withObjectUrls();
    await openRegister({
      "GET /api/v1/compliance/acceptances": () => [200, { items: [entry()], nextCursor: null }],
      "GET /api/v1/compliance/acceptances/{membershipId}/certificate": ({ url }) => {
        expect(url.searchParams.get("stamp")).toBe("privacy-notice:v1");
        expect(url.searchParams.get("format")).toBe("pdf");
        return new Response("%PDF-1.7", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Certificate/u }));
    await waitFor(() => expect(urls.clicked).toHaveLength(1));
    expect(urls.clicked[0]?.download).toBe("certificate-privacy-notice-v1.pdf");
    expect(urls.created).toEqual(["application/pdf"]);
    urls.undo();
  }, 20_000);

  it("offers no certificate for an acceptance that has no evidence stored", async () => {
    await openRegister({
      "GET /api/v1/compliance/acceptances": () => [
        200,
        { items: [entry({ evidenceRef: null })], nextCursor: null },
      ],
    });
    // A button that can only 404 is worse than a sentence saying there is nothing to fetch.
    expect(screen.queryByRole("button", { name: /Certificate \(PDF\)/u })).toBeNull();
    expect(screen.getByText("Not issued")).toBeInTheDocument();
  }, 20_000);

  it("exports the whole register for the document, filtered by it", async () => {
    const urls = withObjectUrls();
    await openRegister({
      "GET /api/v1/compliance/acceptances": () => [200, { items: [entry()], nextCursor: null }],
      "GET /api/v1/compliance/acceptances/export": ({ url }) => {
        expect(url.searchParams.get("documentId")).toBe(DOC_ID);
        expect(url.searchParams.get("format")).toBe("csv");
        return new Response("﻿who,when\r\n", {
          status: 200,
          headers: { "content-type": "text/csv; charset=utf-8" },
        });
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export the register (CSV)" }));
    await waitFor(() => expect(urls.clicked).toHaveLength(1));
    expect(urls.clicked[0]?.download).toBe("acceptance-register.csv");
    urls.undo();
  }, 20_000);
});

describe("acceptance ceremony (E3.5)", () => {
  const WITH_ESIGN = [
    "compliance.read",
    "compliance.manage",
    "compliance.offering",
    "access.manage",
    "esign.read",
  ];

  function openDocument(over: Record<string, Handler>, permissions = WITH_ESIGN) {
    const mock = handlers(
      {
        "GET /api/v1/compliance/documents/{id}": () => [
          200,
          {
            // Only an NDA can be signed electronically (B4).
            document: legalDocument({ kind: "nda" }),
            current: legalVersion(),
            versions: [legalVersion()],
          },
        ],
        "GET /api/v1/compliance/acceptances": () => [200, { items: [], nextCursor: null }],
        "GET /api/v1/esign/connection": () => [200, { connection: esignConnection() }],
        ...over,
      },
      permissions,
    );
    return mock;
  }

  async function renderDocument() {
    const r = await renderApp(`/admin/legal/${DOC_ID}`);
    expect(
      await screen.findByRole("heading", { name: "Privacy notice", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    return r;
  }

  it("offers e-signature only once a vendor is connected, and says click-wrap is not a signed NDA", async () => {
    const { calls } = openDocument({
      "GET /api/v1/esign/connection": () => [200, { connection: null }],
    });
    const r = await renderDocument();
    const group = await screen.findByRole(
      "group",
      { name: "How investors accept it" },
      { timeout: 5000 },
    );
    expect(within(group).getByRole("radio", { name: "Click-wrap" })).toBeChecked();
    const esign = within(group).getByRole("radio", { name: "E-signature" });
    await waitFor(() => expect(esign).toBeDisabled());
    const link = within(group).getByRole("link", { name: "Connect an e-signature vendor" });
    expect(link).toHaveAttribute("href", "/admin/esign");
    expect(link.className).toContain("underline");
    expect(within(group).getByText("Click-wrap is not a signed NDA")).toBeVisible();
    expect(calls.some((c) => c.path === "/api/v1/esign/connection")).toBe(true);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("switches a document to e-signature with the connected vendor", async () => {
    const { calls } = openDocument({
      "PATCH /api/v1/compliance/documents/{id}": () => [
        200,
        { document: legalDocument({ kind: "nda", ceremony: "esign" }) },
      ],
    });
    await renderDocument();
    const user = userEvent.setup();
    const group = await screen.findByRole(
      "group",
      { name: "How investors accept it" },
      { timeout: 5000 },
    );
    expect(
      await within(group).findByText(/Investors sign the document with Documenso/u),
    ).toBeVisible();
    await user.click(within(group).getByRole("radio", { name: "E-signature" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.method === "PATCH" && c.path.startsWith("/api/v1/compliance/documents/"),
        )?.body,
      ).toMatchObject({ ceremony: "esign" }),
    );
  }, 20_000);

  it("does not resend an unchanged ceremony", async () => {
    const { calls } = openDocument({
      "PATCH /api/v1/compliance/documents/{id}": () => [
        200,
        { document: legalDocument({ kind: "nda" }) },
      ],
    });
    await renderDocument();
    const user = userEvent.setup();
    await screen.findByRole("group", { name: "How investors accept it" }, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH")?.body as Record<string, unknown>;
    expect(patch).not.toHaveProperty("ceremony");
  }, 20_000);

  it("explains a refusal when the vendor went away in the meantime", async () => {
    openDocument({
      "PATCH /api/v1/compliance/documents/{id}": () => apiError(409, "esign_not_configured"),
    });
    const r = await renderDocument();
    const user = userEvent.setup();
    const group = await screen.findByRole(
      "group",
      { name: "How investors accept it" },
      { timeout: 5000 },
    );
    await user.click(within(group).getByRole("radio", { name: "E-signature" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The ceremony was not changed")).toBeVisible();
    expect(
      within(alert).getByRole("link", { name: "Connect an e-signature vendor" }),
    ).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("offers e-signature for NDAs only", async () => {
    openDocument({
      "GET /api/v1/compliance/documents/{id}": () => [
        200,
        { document: legalDocument(), current: legalVersion(), versions: [legalVersion()] },
      ],
    });
    const r = await renderDocument();
    const group = await screen.findByRole(
      "group",
      { name: "How investors accept it" },
      { timeout: 5000 },
    );
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: "E-signature" })).toBeDisabled(),
    );
    expect(within(group).getByText("E-signature is available for NDAs only.")).toBeVisible();
    // Changing the kind to NDA makes it available.
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Kind"), "nda");
    expect(within(group).getByRole("radio", { name: "E-signature" })).toBeEnabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it.each([
    [
      "esign_ceremony_unsupported",
      { reason: "not_nda_document", kind: "privacy_notice" },
      /Only an NDA can be signed electronically/u,
    ],
    [
      "esign_nda_text_unsupported",
      { reason: "unsupported_characters", field: "body", characters: ["Ж", "漢"] },
      /document's text contains characters the signing PDF cannot print faithfully \(Ж 漢\)/u,
    ],
  ])(
    "explains a 422 %s on the ceremony",
    async (code, extra, text) => {
      openDocument({
        "PATCH /api/v1/compliance/documents/{id}": () => apiError(422, code, extra),
      });
      const r = await renderDocument();
      const user = userEvent.setup();
      const group = await screen.findByRole(
        "group",
        { name: "How investors accept it" },
        { timeout: 5000 },
      );
      await user.click(within(group).getByRole("radio", { name: "E-signature" }));
      await user.click(screen.getByRole("button", { name: "Save" }));
      const alert = await screen.findByRole("alert");
      expect(within(alert).getByText("The ceremony was not changed")).toBeVisible();
      expect(within(alert).getByText(text)).toBeVisible();
      expect(within(alert).queryByRole("link")).toBeNull();
      await expectNoA11yViolations(r.container);
    },
    20_000,
  );

  it("explains a version the signing PDF cannot print", async () => {
    openDocument({
      "GET /api/v1/compliance/documents/{id}": () => [
        200,
        {
          document: legalDocument({ kind: "nda", ceremony: "esign" }),
          current: legalVersion(),
          versions: [legalVersion()],
        },
      ],
      "POST /api/v1/compliance/documents/{id}/versions": () =>
        apiError(422, "esign_nda_text_unsupported", {
          reason: "unsupported_characters",
          field: "title",
          characters: ["→"],
        }),
    });
    await renderDocument();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Publish/u }, { timeout: 5000 }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("This version was not published")).toBeVisible();
    expect(within(alert).getByText(/document's title contains characters .*\(→\)/u)).toBeVisible();
  }, 20_000);

  it("leaves e-signature selectable when the admin cannot read the connection", async () => {
    const { calls } = openDocument({}, [
      "compliance.read",
      "compliance.manage",
      "compliance.offering",
      "access.manage",
    ]);
    await renderDocument();
    const group = await screen.findByRole(
      "group",
      { name: "How investors accept it" },
      { timeout: 5000 },
    );
    expect(within(group).getByRole("radio", { name: "E-signature" })).toBeEnabled();
    expect(calls.some((c) => c.path === "/api/v1/esign/connection")).toBe(false);
  }, 20_000);

  it("shows a reader which ceremony the document uses", async () => {
    openDocument(
      {
        "GET /api/v1/compliance/documents/{id}": () => [
          200,
          {
            document: legalDocument({ ceremony: "esign" }),
            current: legalVersion(),
            versions: [legalVersion()],
          },
        ],
      },
      ["compliance.read"],
    );
    await renderDocument();
    expect(await screen.findByText("How investors accept it", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText("E-signature")).toBeVisible();
    expect(screen.queryByRole("radio")).toBeNull();
  }, 20_000);
});
