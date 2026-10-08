import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { esignConnection } from "../test/fixtures-esign.js";
import {
  closingTask,
  commitmentFixture,
  interestSubmission,
  ROUND_ID,
  roundDetail,
  roundFixture,
  roundSettingsFixture,
  termsRevision,
  VERIFICATION_ID,
  vendorVerificationRowFixture,
  verificationFixture,
  verificationRowFixture,
} from "../test/fixtures-round.js";
import {
  BOLT_COMMITMENT_ID,
  BOLT_REQUEST_ID,
  closingCommitment,
  GRACE_COMMITMENT_ID,
  roundClosing,
  signatureRequest,
} from "../test/fixtures-round-closing.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/round` (E2.5 §W). Four rules this screen exists to keep:
 *
 *  - **terms are superseded, never edited.** Saving writes a new revision and the history
 *    keeps the old one, so what was on the page when somebody subscribed stays provable.
 *  - **the >35 non-accredited count warns and never blocks.** Rule 506(b)'s limit is a legal
 *    judgement for the company and its counsel, not a form validation.
 *  - **"verified" without evidence is refused in the UI too.** The server refuses it; a dialog
 *    that let it be submitted would turn a rule into a surprise 409.
 *  - **accepting turns an indication into a soft commitment** — no payment instruction is sent
 *    by either decision.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", async () => ({
  investorModules: {},
  adminModules: { round: () => import("../modules/round/admin.js") },
}));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";

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
  permissions = ["round.read", "round.manage", "round.publish", "round.settings"],
) =>
  bootstrap({
    workspace: {
      id: "ws",
      slug: "acme",
      name: "Acme",
      offeringStatus: "506b",
      defaultLocale: "en",
    },
    modules: [
      {
        id: "round",
        version: "1.0.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "admin.nav": [
            { id: "round-admin", label: "Round", to: "/admin/round", order: 36, icon: "round" },
          ],
        },
      },
    ],
    permissions,
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
  });

function handlers(
  over: Record<string, Handler> = {},
  permissions?: string[],
): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions)],
    "GET /api/v1/access/groups": () => [200, { groups: [] }],
    "GET /api/v1/round/settings": () => [200, roundSettingsFixture()],
    "GET /api/v1/round/rounds": () => [200, { rounds: [roundFixture()] }],
    "GET /api/v1/round/rounds/{id}": () => [200, roundDetail()],
    "GET /api/v1/round/rounds/{id}/interest": () => [200, { submissions: [interestSubmission()] }],
    "GET /api/v1/round/rounds/{id}/commitments": () => [
      200,
      { commitments: [commitmentFixture()] },
    ],
    "GET /api/v1/round/rounds/{id}/closing-tasks": () => [200, { tasks: [closingTask()] }],
    "GET /api/v1/round/rounds/{id}/closing": () => [200, roundClosing()],
    "GET /api/v1/esign/connection": () => [200, { connection: esignConnection() }],
    "GET /api/v1/round/verifications": () => [200, { verifications: [verificationRowFixture()] }],
    ...over,
  });
}

async function openList(): Promise<Awaited<ReturnType<typeof renderApp>>> {
  const r = await renderApp("/admin/round");
  expect(
    await screen.findByRole("heading", { name: "Round", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

async function openDetail(tab: string): Promise<Awaited<ReturnType<typeof renderApp>>> {
  const r = await renderApp(`/admin/round/rounds/${ROUND_ID}/${tab}`);
  expect(
    await screen.findByRole("heading", { name: "Seed 2026", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("round admin", () => {
  it("lists the rounds with stage, instrument, target and status in words", async () => {
    handlers({
      "GET /api/v1/round/rounds": () => [
        200,
        {
          rounds: [
            roundFixture(),
            roundFixture({
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c57ff",
              name: "Pre-seed 2025",
              stage: "pre_seed",
              instrumentKind: "note",
              status: "closed",
            }),
          ],
        },
      ],
    });
    const r = await openList();
    expect(await screen.findByText("Seed 2026", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("Pre-seed 2025")).toBeInTheDocument();
    expect(screen.getByText("Convertible note")).toBeInTheDocument();
    expect(screen.getAllByText("$2,000,000").length).toBe(2);
    // Status in words, never only a colour.
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("creates a round in planning, with the instrument and target it was given", async () => {
    const { calls } = handlers({
      "POST /api/v1/round/rounds": () => [201, { round: roundFixture({ status: "planning" }) }],
    });
    await openList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "New round" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/u), "Seed 2026");
    await user.selectOptions(within(dialog).getByLabelText("Instrument"), "note");
    await user.type(within(dialog).getByLabelText(/^Target amount/u), "2000000");
    await user.type(within(dialog).getByLabelText(/^Minimum investment/u), "25000");
    // The default currency comes from the module's own settings, not from a hard-coded USD.
    expect(within(dialog).getByLabelText(/^Currency/u)).toHaveValue("USD");
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Create round" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/round/rounds")?.body,
      ).toMatchObject({
        name: "Seed 2026",
        stage: "seed",
        instrumentKind: "note",
        targetAmount: "2000000",
        currency: "USD",
        minimumInvestment: "25000",
        showProgress: true,
      }),
    );
  }, 20_000);

  it("shows the allocation buckets and warns at the Rule 506(b) limit without blocking", async () => {
    handlers({
      "GET /api/v1/round/rounds/{id}": () => [
        200,
        roundDetail({
          counters: { submitted: 4, accepted: 40, nonAccreditedAccepted: 35, limit: 35 },
        }),
      ],
    });
    const r = await openDetail("overview");
    expect(await screen.findByText("Allocation", {}, { timeout: 5000 })).toBeInTheDocument();
    // Both views of one computation: the bar and the buckets beneath it.
    expect(screen.getAllByText("$300,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$700,000").length).toBeGreaterThan(0);
    // Soft-circled plus committed is $1,000,000, and so is what is left of the target — both
    // in the bar's own figures and again in the buckets table.
    expect(screen.getAllByText("$1,000,000").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("35.00%")).toBeInTheDocument();
    expect(screen.getByText("35 of 35")).toBeInTheDocument();
    expect(screen.getByText(/Rule 506\(b\) admits at most 35/u)).toBeVisible();
    // A prompt, not a block: nothing on the page has been disabled by it.
    expect(screen.getByText(/nothing has been refused/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("opens the round behind a confirmation", async () => {
    const { calls } = handlers({
      "GET /api/v1/round/rounds/{id}": () => [
        200,
        roundDetail({ round: roundFixture({ status: "planning", openedAt: null }) }),
      ],
      "POST /api/v1/round/rounds/{id}/open": () => [200, { round: roundFixture() }],
    });
    await openDetail("overview");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Open the round" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Only one round can be open at a time/u)).toBeVisible();
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Open the round" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "POST" && c.path === `/api/v1/round/rounds/${ROUND_ID}/open`,
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("saves terms as a new revision and keeps the old one in the history", async () => {
    const { calls } = handlers({
      "GET /api/v1/round/rounds/{id}": () => [
        200,
        roundDetail({
          history: [
            termsRevision({ revision: 2 }),
            termsRevision({
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c57aa",
              revision: 1,
              supersededBy: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5702",
            }),
          ],
        }),
      ],
      "PUT /api/v1/round/rounds/{id}/terms": () => [200, { terms: termsRevision({ revision: 3 }) }],
    });
    const r = await openDetail("terms");
    const user = userEvent.setup();
    // The history says which revision is live and which was superseded, in words.
    expect(await screen.findByText("Current", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("Superseded")).toBeInTheDocument();
    const cap = screen.getByLabelText("Valuation cap");
    await user.clear(cap);
    await user.type(cap, "10000000");
    await user.click(screen.getByRole("button", { name: "Save as a new revision" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path === `/api/v1/round/rounds/${ROUND_ID}/terms`)
          ?.body,
      ).toMatchObject({
        terms: {
          kind: "safe",
          variant: "post_money",
          valuationCap: "10000000",
          discountPercent: "20",
          mfn: true,
          proRata: true,
        },
      }),
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("accepts an indication of interest, with an allocation different from the one asked for", async () => {
    const { calls } = handlers({
      "POST /api/v1/round/interest/{id}/accept": () => [
        200,
        {
          submission: interestSubmission({ status: "accepted" }),
          commitment: commitmentFixture(),
          warnings: [],
        },
      ],
    });
    const r = await openDetail("interest");
    const user = userEvent.setup();
    expect(await screen.findByText("Ada Lovelace", {}, { timeout: 5000 })).toBeInTheDocument();
    // The path and the accreditation answer are on the row: they decide what may be accepted.
    expect(screen.getByText("You answer for yourself")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Accept" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/no payment instructions are sent/u)).toBeVisible();
    await user.type(within(dialog).getByLabelText(/Allocate a different amount/u), "40000");
    await user.click(within(dialog).getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path.endsWith("/accept"))?.body,
      ).toMatchObject({ amount: "40000" }),
    );
  }, 20_000);

  it("declines an indication of interest with a note", async () => {
    const { calls } = handlers({
      "POST /api/v1/round/interest/{id}/decline": () => [
        200,
        { submission: interestSubmission({ status: "declined" }), commitment: null, warnings: [] },
      ],
    });
    await openDetail("interest");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Decline" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Note"), "Round is full");
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Decline" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path.endsWith("/decline"))?.body,
      ).toMatchObject({ note: "Round is full" }),
    );
  }, 20_000);

  it("changes a commitment's status from the table", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/round/commitments/{id}": () => [
        200,
        { commitment: commitmentFixture({ status: "wired" }) },
      ],
    });
    const r = await openDetail("commitments");
    const user = userEvent.setup();
    const select = await screen.findByLabelText(
      "Status of Ada Lovelace's commitment",
      {},
      { timeout: 5000 },
    );
    await user.selectOptions(select, "wired");
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path.startsWith("/api/v1/round/commitments/"))
          ?.body,
      ).toMatchObject({ status: "wired" }),
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("adds a closing task and ticks one off", async () => {
    const { calls } = handlers({
      "PUT /api/v1/round/rounds/{id}/closing-tasks": () => [200, { tasks: [closingTask()] }],
    });
    // The tasks list moved into the Closing tab (E3.5); an old `/tasks` link lands there.
    const r = await openDetail("tasks");
    expect(await screen.findByRole("link", { name: "Closing" }, { timeout: 5000 })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const user = userEvent.setup();
    const done = await screen.findByRole(
      "checkbox",
      { name: "Send the SAFE to counsel" },
      { timeout: 5000 },
    );
    await user.click(done);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PUT" && c.path.endsWith("/closing-tasks"))?.body,
      ).toMatchObject({ tasks: [{ title: "Send the SAFE to counsel", done: true }] }),
    );
    await user.type(screen.getByLabelText("New task"), "Book the closing call");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "PUT" && c.path.endsWith("/closing-tasks")).length,
      ).toBe(2),
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("refuses to record 'verified' until the method and its evidence are there", async () => {
    const { calls } = handlers({
      // The server answers with the verification itself, flat.
      "POST /api/v1/round/verifications/{id}/decide": () => [
        200,
        verificationFixture({ status: "verified", method: "document_review" }),
      ],
    });
    const r = await renderApp("/admin/round/verifications");
    expect(
      await screen.findByRole("heading", { name: "Verifications", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    expect(await screen.findByText("Waiting", {}, { timeout: 5000 })).toBeInTheDocument();
    // Staff-only page, so the evidence is a plain link the browser downloads.
    const link = screen.getByRole("link", { name: "Download evidence" });
    expect(link.getAttribute("href")).toContain(
      `/api/v1/round/verifications/${VERIFICATION_ID}/evidence`,
    );
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Record a decision" }));
    const dialog = await screen.findByRole("dialog");
    // No method yet: the same refusal the server would make, made here first.
    expect(within(dialog).getByText(/Verified cannot be recorded until/u)).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Record decision" })).toBeDisabled();
    await user.selectOptions(
      within(dialog).getByLabelText("How you verified them"),
      "document_review",
    );
    expect(within(dialog).getByRole("button", { name: "Record decision" })).toBeEnabled();
    await user.click(within(dialog).getByRole("button", { name: "Record decision" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path.endsWith("/decide"))?.body,
      ).toMatchObject({ status: "verified", method: "document_review" }),
    );
  }, 20_000);

  it("saves the evidence retention window and the default currency", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/round/settings": () => [
        200,
        roundSettingsFixture({ evidenceRetentionDays: 30, defaultCurrency: "EUR" }),
      ],
    });
    const r = await renderApp("/admin/round/settings");
    expect(
      await screen.findByRole("heading", { name: "Round settings", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    const retention = await screen.findByLabelText(
      /^Delete evidence after/u,
      {},
      { timeout: 5000 },
    );
    await user.clear(retention);
    await user.type(retention, "30");
    const currency = screen.getByLabelText(/^Default currency/u);
    await user.clear(currency);
    await user.type(currency, "eur");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/round/settings")?.body,
      ).toMatchObject({ evidenceRetentionDays: 30, defaultCurrency: "EUR" }),
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("hides every mutation from a reader", async () => {
    handlers({}, ["round.read"]);
    const r = await openList();
    expect(await screen.findByText("Seed 2026", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New round" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("round admin: closing (E3.5)", () => {
  it("shows the checklist per commitment, the roll-up and the manual tasks", async () => {
    handlers();
    const r = await openDetail("closing");
    const table = await screen.findByRole(
      "table",
      { name: "Closing checklist" },
      { timeout: 5000 },
    );
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4);
    const summary = screen.getByRole("list", { name: "Closing summary" });
    const tiles = within(summary).getAllByRole("listitem");
    expect(tiles).toHaveLength(5);
    expect(tiles[3]).toHaveTextContent("Wired");
    expect(tiles[3]).toHaveTextContent("1");
    expect(tiles[3]).toHaveTextContent("$100,000");
    expect(screen.getByText("1 commitment ($10,000) was withdrawn.")).toBeVisible();

    const grace = within(table).getByRole("row", { name: /Grace Hopper/u });
    const steps = within(grace).getByRole("list", { name: "Closing steps for Grace Hopper" });
    expect(within(steps).getAllByText("done")).toHaveLength(3);
    expect(within(steps).getAllByText("not yet")).toHaveLength(1);
    // "Signed" twice: the checklist step and the agreement's own status.
    expect(within(grace).getAllByText("Signed")).toHaveLength(2);
    // Each row offers exactly what the server would accept.
    const ada = within(table).getByRole("row", { name: /Ada Lovelace/u });
    expect(within(ada).getByText("Not sent")).toBeVisible();
    expect(
      within(ada).getByRole("button", {
        name: "Send the subscription agreement to Ada Lovelace for signature",
      }),
    ).toBeVisible();
    expect(within(ada).queryByRole("button", { name: /Void|confirmed/u })).toBeNull();
    const bolt = within(table).getByRole("row", { name: /Bolt Ventures/u });
    expect(
      within(bolt).getByRole("button", { name: "Void Bolt Ventures's subscription agreement" }),
    ).toBeVisible();
    expect(within(bolt).queryByRole("button", { name: /Send/u })).toBeNull();
    expect(
      within(grace).getByRole("button", { name: "Mark Grace Hopper's commitment confirmed" }),
    ).toBeVisible();
    // The manual list stays alongside.
    expect(screen.getByRole("checkbox", { name: "Send the SAFE to counsel" })).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("sends the subscription agreement with a message", async () => {
    const { calls } = handlers({
      "POST /api/v1/round/commitments/{id}/signature-request": () => [
        201,
        {
          id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5730",
          roundId: ROUND_ID,
          commitmentId: "x",
          envelopeId: null,
          status: "pending",
          templateRef: "tmpl-101",
          sentAt: "2026-09-25T10:00:00.000Z",
          completedAt: null,
          terminalAt: null,
          signedDocumentId: null,
        },
      ],
    });
    await openDetail("closing");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Send the subscription agreement to Ada Lovelace for signature" },
        { timeout: 5000 },
      ),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Send Ada Lovelace the subscription agreement?",
    });
    expect(within(dialog).getByText(/\$50,000/u)).toBeVisible();
    // A member signs as themselves: no signer fields.
    expect(within(dialog).queryByLabelText("Signer email")).toBeNull();
    await user.type(within(dialog).getByLabelText("Message to the investor"), "Welcome aboard");
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Send agreement" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path.endsWith("/signature-request"))?.body,
      ).toEqual({ message: "Welcome aboard" }),
    );
    expect(await screen.findByText("Agreement sent to Ada Lovelace")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 20_000);

  it("names the missing template and links to the round settings", async () => {
    handlers({
      "POST /api/v1/round/commitments/{id}/signature-request": () =>
        apiError(409, "conflict", { reason: "subscription_template_missing" }),
    });
    await openDetail("closing");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Send the subscription agreement to Ada Lovelace for signature" },
        { timeout: 5000 },
      ),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Send agreement" }));
    expect(
      await within(dialog).findByText(
        "No subscription agreement template is set up for the round.",
      ),
    ).toBeVisible();
    const link = within(dialog).getByRole("link", {
      name: "Set up the template in round settings",
    });
    expect(link).toHaveAttribute("href", "/admin/round/settings");
    expect(link.className).toContain("underline");
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("says when no vendor is connected, and links to e-signature", async () => {
    handlers(
      {
        "GET /api/v1/esign/connection": () => [200, { connection: null }],
        "POST /api/v1/round/commitments/{id}/signature-request": () =>
          apiError(409, "esign_not_configured"),
      },
      ["round.read", "round.manage", "round.publish", "round.settings", "esign.read"],
    );
    const r = await openDetail("closing");
    expect(
      await screen.findByText("No e-signature vendor connected", {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Connect an e-signature vendor" })).toHaveAttribute(
      "href",
      "/admin/esign",
    );
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "Send the subscription agreement to Ada Lovelace for signature",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Send agreement" }));
    expect(await within(dialog).findByText("No e-signature vendor is connected.")).toBeVisible();
    expect(within(dialog).getByRole("link", { name: "Go to e-signature settings" })).toBeVisible();
  }, 20_000);

  it("asks who signs for a commitment with no member, and says when no address is on record", async () => {
    const { calls } = handlers({
      "GET /api/v1/round/rounds/{id}/closing": () => [
        200,
        roundClosing({
          commitments: [
            closingCommitment({
              commitmentId: BOLT_COMMITMENT_ID,
              investor: {
                membershipId: null,
                contactId: null,
                organizationId: null,
                name: "Bolt Ventures",
              },
            }),
          ],
        }),
      ],
      "POST /api/v1/round/commitments/{id}/signature-request": ({ body }) =>
        (body as { signer?: unknown }).signer === undefined
          ? apiError(422, "signer_email_missing")
          : [201, {}],
    });
    await openDetail("closing");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Send the subscription agreement to Bolt Ventures for signature" },
        { timeout: 5000 },
      ),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Signer name")).toHaveValue("Bolt Ventures");
    await user.click(within(dialog).getByRole("button", { name: "Send agreement" }));
    expect(
      await within(dialog).findByText(/There is no email address on record for this investor/u),
    ).toBeVisible();
    await user.type(within(dialog).getByLabelText("Signer email"), "cfo@bolt.test");
    await user.click(within(dialog).getByRole("button", { name: "Send agreement" }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "POST" && c.path.endsWith("/signature-request")).at(-1)
          ?.body,
      ).toEqual({ signer: { name: "Bolt Ventures", email: "cfo@bolt.test" } }),
    );
  }, 20_000);

  it("voids an agreement that is out for signature", async () => {
    const { calls } = handlers({
      "POST /api/v1/round/signature-requests/{id}/void": () => [200, {}],
    });
    await openDetail("closing");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Void Bolt Ventures's subscription agreement" },
        { timeout: 5000 },
      ),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Void Bolt Ventures's subscription agreement?",
    });
    await user.type(within(dialog).getByLabelText("Reason (optional)"), "Wrong amount");
    await user.click(within(dialog).getByRole("button", { name: "Void" }));
    await waitFor(() =>
      expect(
        calls.find(
          (c) =>
            c.method === "POST" &&
            c.path === `/api/v1/round/signature-requests/${BOLT_REQUEST_ID}/void`,
        )?.body,
      ).toEqual({ reason: "Wrong amount" }),
    );
  }, 20_000);

  it("voids, rather than resends, an agreement in error that the vendor still has", async () => {
    handlers({
      "GET /api/v1/round/rounds/{id}/closing": () => [
        200,
        roundClosing({
          commitments: [
            closingCommitment({
              commitmentId: BOLT_COMMITMENT_ID,
              investor: {
                membershipId: null,
                contactId: null,
                organizationId: null,
                name: "Bolt Ventures",
              },
              status: "verbal",
              signatureRequest: signatureRequest({ status: "error" }),
            }),
            closingCommitment({
              signatureRequest: signatureRequest({
                id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5729",
                commitmentId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5700",
                status: "error",
                envelopeId: null,
              }),
            }),
          ],
        }),
      ],
    });
    const r = await openDetail("closing");
    // The kernel's `error` is recoverable: Bolt's envelope may still be signed at the vendor.
    expect(
      await screen.findByRole(
        "button",
        { name: "Void Bolt Ventures's subscription agreement" },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Send the subscription agreement to Bolt Ventures for signature",
      }),
    ).toBeNull();
    expect(screen.getByText(/vendor still has this agreement/u)).toBeVisible();
    // Ada's request failed before reaching the vendor: over, and sent again from scratch.
    expect(
      screen.getByRole("button", {
        name: "Send the subscription agreement to Ada Lovelace for signature",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Void Ada Lovelace's subscription agreement" }),
    ).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("marks a wired commitment confirmed behind a confirmation", async () => {
    const { calls } = handlers({
      "POST /api/v1/round/commitments/{id}/confirm": () => [
        200,
        commitmentFixture({ id: GRACE_COMMITMENT_ID, status: "wired" }),
      ],
    });
    await openDetail("closing");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Mark Grace Hopper's commitment confirmed" },
        { timeout: 5000 },
      ),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Confirm Grace Hopper's commitment?",
    });
    expect(within(dialog).getByText(/The investor is emailed a confirmation/u)).toBeVisible();
    expect(calls.some((c) => c.path.endsWith("/confirm"))).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Mark confirmed" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" &&
            c.path === `/api/v1/round/commitments/${GRACE_COMMITMENT_ID}/confirm`,
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Grace Hopper's commitment is confirmed")).toBeInTheDocument();
  }, 20_000);

  it("sends a stale admin to step-up when sending for signature", async () => {
    handlers({
      "POST /api/v1/round/commitments/{id}/signature-request": () =>
        apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openDetail("closing");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Send the subscription agreement to Ada Lovelace for signature" },
        { timeout: 5000 },
      ),
    );
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Send agreement" }),
    );
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
  }, 20_000);

  it("shows a reader the checklist without any action", async () => {
    const { calls } = handlers({}, ["round.read"]);
    const r = await openDetail("closing");
    const table = await screen.findByRole(
      "table",
      { name: "Closing checklist" },
      { timeout: 5000 },
    );
    expect(within(table).queryByRole("button")).toBeNull();
    // A reader is not told to connect a vendor, and the connection is not even asked for.
    expect(calls.some((c) => c.path === "/api/v1/esign/connection")).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("saves the subscription template and the prefill mapping", async () => {
    const { calls } = handlers({
      "GET /api/v1/round/settings": () => [
        200,
        roundSettingsFixture({
          closing: {
            subscriptionTemplateRef: "tmpl-100",
            templateRole: "Signer",
            prefill: { InvestorName: "investor_name" },
          },
        }),
      ],
      "PATCH /api/v1/round/settings": () => [200, roundSettingsFixture()],
    });
    const r = await renderApp("/admin/round/settings");
    const user = userEvent.setup();
    const template = await screen.findByLabelText(
      "Subscription agreement template",
      {},
      { timeout: 5000 },
    );
    expect(template).toHaveValue("tmpl-100");
    await user.clear(template);
    await user.type(template, "tmpl-101");
    expect(screen.getByLabelText("Template field 1")).toHaveValue("InvestorName");
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.type(screen.getByLabelText("Template field 2"), "InvestorName");
    // Two rows for one field is refused before it reaches the server.
    expect(await screen.findByText("“InvestorName” is listed twice.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save closing settings" })).toBeDisabled();
    await user.clear(screen.getByLabelText("Template field 2"));
    await user.type(screen.getByLabelText("Template field 2"), "Amount");
    await user.selectOptions(screen.getByLabelText("Filled with (field 2)"), "amount");
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Save closing settings" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/round/settings")?.body,
      ).toEqual({
        closing: {
          subscriptionTemplateRef: "tmpl-101",
          templateRole: "Signer",
          prefill: { InvestorName: "investor_name", Amount: "amount" },
        },
      }),
    );
    // Removing every field and the template clears both.
    await user.click(screen.getByRole("button", { name: "Remove field 2" }));
    await user.click(screen.getByRole("button", { name: "Remove field 1" }));
    await user.clear(template);
    await user.click(screen.getByRole("button", { name: "Save closing settings" }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "PATCH" && c.path === "/api/v1/round/settings").at(-1)
          ?.body,
      ).toEqual({
        closing: { subscriptionTemplateRef: null, templateRole: "Signer", prefill: {} },
      }),
    );
  }, 20_000);

  it("saves the investor's role in the template, which cannot be empty", async () => {
    const { calls } = handlers({
      "GET /api/v1/round/settings": () => [200, roundSettingsFixture()],
      "PATCH /api/v1/round/settings": () => [200, roundSettingsFixture()],
    });
    const r = await renderApp("/admin/round/settings");
    const user = userEvent.setup();
    const role = await screen.findByLabelText(
      /Investor's role in the template/u,
      {},
      { timeout: 5000 },
    );
    expect(role).toHaveValue("Signer");
    expect(role).toBeRequired();
    expect(
      screen.getByText(/DocuSign and multi-role DocuSeal templates match the signer/u),
    ).toBeVisible();
    await user.clear(role);
    expect(screen.getByRole("button", { name: "Save closing settings" })).toBeDisabled();
    await user.type(role, "  Investor ");
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Save closing settings" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/round/settings")?.body,
      ).toEqual({
        closing: { subscriptionTemplateRef: null, templateRole: "Investor", prefill: {} },
      }),
    );
  }, 20_000);
});

describe("round admin: vendor verifications (E3.7)", () => {
  const RENEWAL_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a99";

  async function openQueue() {
    const r = await renderApp("/admin/round/verifications");
    expect(
      await screen.findByRole("heading", { name: "Verifications", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    return r;
  }

  it("shows each row's person, provider, vendor status and last check", async () => {
    handlers(
      {
        "GET /api/v1/round/verifications": () => [
          200,
          {
            verifications: [
              verificationRowFixture(),
              vendorVerificationRowFixture({
                id: RENEWAL_ID,
                displayName: "Grace Hopper",
                email: "grace@example.com",
                reverificationOf: VERIFICATION_ID,
              }),
              vendorVerificationRowFixture({
                id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a98",
                displayName: "Alan Turing",
                email: null,
                status: "verified",
                method: "third_party",
                decidedByProvider: "verifyinvestor",
                vendorStatus: "accredited",
                nextCheckAt: null,
              }),
              vendorVerificationRowFixture({
                id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a97",
                displayName: "Edsger Dijkstra",
                email: null,
                vendorError: "connection_changed",
                nextCheckAt: null,
              }),
            ],
          },
        ],
      },
      ["round.read", "round.manage", "accreditation.read"],
    );
    const r = await openQueue();
    const table = await screen.findByRole("table", {}, { timeout: 5000 });
    // The server's rows are flat: name and email straight off the row.
    const ada = within(table).getByRole("rowheader", { name: /Ada Lovelace/u });
    expect(ada).toHaveTextContent("ada@example.com");
    const grace = within(table).getByRole("rowheader", { name: /Grace Hopper/u })
      .parentElement as HTMLElement;
    expect(within(grace).getByText("VerifyInvestor.com")).toBeVisible();
    expect(within(grace).getByText("Vendor status: waiting_for_investor_acceptance")).toBeVisible();
    expect(within(grace).getByText("Renewal")).toBeVisible();
    expect(
      within(grace).getByRole("link", { name: "Renews an earlier verification" }),
    ).toHaveAttribute("href", `#verification-${VERIFICATION_ID}`);
    // Manual rows are never checked with a vendor.
    const adaRow = ada.parentElement as HTMLElement;
    expect(within(adaRow).getByText("Manual review")).toBeVisible();
    expect(within(adaRow).queryByRole("button", { name: /Check now/u })).toBeNull();
    // Decided by the vendor, not by a person.
    const alan = within(table).getByRole("rowheader", { name: /Alan Turing/u })
      .parentElement as HTMLElement;
    expect(within(alan).getByText("Verified by VerifyInvestor.com")).toBeVisible();
    expect(within(alan).queryByRole("button")).toBeNull();
    const edsger = within(table).getByRole("rowheader", { name: /Edsger Dijkstra/u })
      .parentElement as HTMLElement;
    expect(
      within(edsger).getByText("The vendor connection changed. Decide this one yourself."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Accreditation vendor" })).toHaveAttribute(
      "href",
      "/admin/accreditation",
    );
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("queues a vendor check, and says why when the row is no longer with the vendor", async () => {
    let answer: "queued" | "conflict" = "queued";
    const { calls } = handlers({
      "GET /api/v1/round/verifications": () => [
        200,
        { verifications: [vendorVerificationRowFixture()] },
      ],
      "POST /api/v1/round/verifications/{id}/check": () =>
        answer === "queued"
          ? [202, { queued: true }]
          : apiError(409, "conflict", { reason: "verification_not_vendor" }),
    });
    await openQueue();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole(
        "button",
        { name: "Check now with VerifyInvestor.com" },
        { timeout: 5000 },
      ),
    );
    expect(await screen.findByText("Check with VerifyInvestor.com queued")).toBeVisible();
    expect(
      calls.some(
        (c) =>
          c.method === "POST" && c.path === `/api/v1/round/verifications/${VERIFICATION_ID}/check`,
      ),
    ).toBe(true);
    answer = "conflict";
    await user.click(screen.getByRole("button", { name: "Check now with VerifyInvestor.com" }));
    expect(
      await screen.findByText(
        "This verification is no longer waiting on a vendor. The list has been refreshed.",
      ),
    ).toBeVisible();
  }, 20_000);

  it("still lets an admin decide a vendor row, as an override", async () => {
    const { calls } = handlers({
      "GET /api/v1/round/verifications": () => [
        200,
        { verifications: [vendorVerificationRowFixture()] },
      ],
      "POST /api/v1/round/verifications/{id}/decide": () => [
        200,
        vendorVerificationRowFixture({ status: "rejected" }),
      ],
    });
    await openQueue();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Record a decision" }, { timeout: 5000 }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("This verification is with VerifyInvestor.com")).toBeVisible();
    expect(
      within(dialog).getByText(/a later answer from VerifyInvestor\.com is ignored/u),
    ).toBeVisible();
    // A vendor row starts from "third party", which needs a note naming the source.
    expect(within(dialog).getByLabelText("How you verified them")).toHaveValue("third_party");
    await user.selectOptions(within(dialog).getByLabelText("Status"), "rejected");
    // The dialog's own content; outside it Radix hides the page (axe flags that, not us).
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Record decision" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path.endsWith("/decide"))?.body,
      ).toMatchObject({ status: "rejected", method: "third_party" }),
    );
  }, 20_000);

  it("explains an imported row and offers no vendor check for it", async () => {
    handlers({
      "GET /api/v1/round/verifications": () => [
        200,
        {
          verifications: [
            vendorVerificationRowFixture({ vendorError: "imported", nextCheckAt: null }),
          ],
        },
      ],
    });
    const r = await openQueue();
    expect(
      await screen.findByText(/Imported from another installation/u, {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Check now/u })).toBeNull();
    expect(screen.getByRole("button", { name: "Record a decision" })).toBeVisible();
    expect(screen.queryByText(/Vendor error:/u)).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says why an erased member cannot be marked verified", async () => {
    const { calls } = handlers({
      "GET /api/v1/round/verifications": () => [
        200,
        { verifications: [vendorVerificationRowFixture({ vendorError: "member_erased" })] },
      ],
      "POST /api/v1/round/verifications/{id}/decide": () =>
        apiError(409, "conflict", { reason: "member_erased" }),
    });
    await openQueue();
    expect(
      await screen.findByText(/The member's data was erased/u, {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Check now/u })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Record a decision" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Note/u), "VerifyInvestor.com");
    await user.click(within(dialog).getByRole("button", { name: "Record decision" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path.endsWith("/decide"))?.body,
      ).toMatchObject({ status: "verified", method: "third_party" }),
    );
    expect(await within(dialog).findByText("The member was erased")).toBeVisible();
    expect(within(dialog).getByText(/You can still reject the verification/u)).toBeVisible();
  }, 20_000);

  it("saves the re-verification reminder and auto-start, warning about vendor charges", async () => {
    const { calls } = handlers({
      "PATCH /api/v1/round/settings": () => [
        200,
        roundSettingsFixture({ reverification: { reminderDays: 30, autoStart: true } }),
      ],
    });
    const r = await renderApp("/admin/round/settings");
    const user = userEvent.setup();
    const days = await screen.findByLabelText(
      /^Remind investors this many days before expiry/u,
      {},
      { timeout: 5000 },
    );
    expect(days).toHaveValue(14);
    const autoStart = screen.getByRole("checkbox", {
      name: "Start the renewal with the vendor automatically",
    });
    expect(autoStart).not.toBeChecked();
    expect(autoStart).toHaveAccessibleDescription(/The vendor may charge for each one/u);
    const save = screen.getByRole("button", { name: "Save re-verification" });
    await user.clear(days);
    await user.type(days, "61");
    expect(save).toBeDisabled();
    await user.clear(days);
    await user.type(days, "30");
    await user.click(autoStart);
    await expectNoA11yViolations(r.container);
    await user.click(save);
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "PATCH" && c.path === "/api/v1/round/settings")?.body,
      ).toEqual({ reverification: { reminderDays: 30, autoStart: true } }),
    );
  }, 20_000);
});
