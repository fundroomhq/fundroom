import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  MemberClosingCommitment,
  MemberClosingView,
} from "../lib/round-closing-member-queries.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me } from "../test/fixtures.js";
import { currentRound, eligibilityView } from "../test/fixtures-round.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * The investor's closing checklist on `/round` (E3.5 §6).
 *
 * The stages and the flags come from `GET /round/current/closing`; the screen decides nothing.
 * What must hold: an open request says "check your email" (round envelopes are emailed, never
 * signed in the portal), the signed copy downloads from the member's own e-sign route, a
 * delegate sees the same stages with neither action, and an investor without a commitment sees
 * no checklist at all.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

vi.mock("../modules/registry.js", async () => ({
  investorModules: { round: () => import("../modules/round/investor.js") },
  adminModules: {},
}));

const COMMITMENT_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const REQUEST_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f02";
const ENVELOPE_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f03";

const investorBootstrap = () =>
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
        slots: { "investor.nav": [{ id: "round", label: "Round", to: "/round", order: 40 }] },
      },
    ],
    permissions: [],
  });

type Checklist = MemberClosingCommitment["checklist"];

function checklistOf(over: Partial<Checklist> = {}): Checklist {
  return {
    documentsSent: true,
    documentsSentAt: "2026-09-20T10:00:00.000Z",
    signed: false,
    signedAt: null,
    wired: false,
    wiredAt: null,
    confirmed: false,
    confirmedAt: null,
    stage: "documents_sent",
    ...over,
  };
}

function commitment(over: Partial<MemberClosingCommitment> = {}): MemberClosingCommitment {
  return {
    commitmentId: COMMITMENT_ID,
    amount: "250000",
    currency: "USD",
    status: "verbal",
    checklist: checklistOf(),
    signatureRequest: {
      id: REQUEST_ID,
      status: "sent",
      sentAt: "2026-09-20T10:00:00.000Z",
      completedAt: null,
    },
    canSign: true,
    signedDocumentAvailable: false,
    envelopeId: ENVELOPE_ID,
    ...over,
  };
}

function closing(commitments: MemberClosingCommitment[], readOnly = false): MemberClosingView {
  return {
    round: { id: "round-1", name: "Seed", status: "open", currency: "USD" },
    commitments,
    readOnly,
  };
}

function handlers(closingHandler: Handler, over: Record<string, Handler> = {}) {
  return installMockApi({
    "GET /api/v1/me": () => [200, me()],
    "GET /api/v1/modules": () => [200, investorBootstrap()],
    "GET /api/v1/round/current": () => [200, currentRound()],
    "GET /api/v1/round/current/eligibility": () => [200, eligibilityView()],
    "GET /api/v1/round/current/closing": closingHandler,
    ...over,
  });
}

async function openRound() {
  const r = await renderApp("/round");
  expect(
    await screen.findByRole("heading", { name: "Round", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

const checklist = () => screen.findByRole("region", { name: "Commitment of $250,000" });

describe("investor closing checklist", () => {
  it("says to check email while a signature request is open", async () => {
    handlers(() => [200, closing([commitment()])]);
    const r = await openRound();
    const card = await checklist();
    expect(within(card).getByText("Check your email to sign")).toBeInTheDocument();
    const steps = within(card).getByRole("list", { name: "Closing steps" });
    const items = within(steps).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^Documents sentDone /u),
      "SignedNot yet",
      "Funds receivedNot yet",
      "ConfirmedNot yet",
    ]);
    // Nothing to download before a signed copy exists; nothing to sign in the portal.
    expect(within(card).queryByRole("button")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("downloads the signed copy from the member's own e-sign route", async () => {
    const createObjectURL = vi.fn(() => "blob:signed");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function mocked(
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    onTestFinished(() => {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    });
    const { calls } = handlers(
      () => [
        200,
        closing([
          commitment({
            status: "signed",
            checklist: checklistOf({
              signed: true,
              signedAt: "2026-09-21T10:00:00.000Z",
              stage: "signed",
            }),
            canSign: false,
            signatureRequest: {
              id: REQUEST_ID,
              status: "completed",
              sentAt: "2026-09-20T10:00:00.000Z",
              completedAt: "2026-09-21T10:00:00.000Z",
            },
            signedDocumentAvailable: true,
          }),
        ]),
      ],
      {
        "GET /api/v1/esign/me/envelopes/{id}/signed.pdf": () =>
          new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" }), {
            status: 200,
            headers: { "content-type": "application/pdf" },
          }),
      },
    );
    const r = await openRound();
    const card = await checklist();
    expect(within(card).queryByText("Check your email to sign")).toBeNull();
    const button = within(card).getByRole("button", { name: "Download signed copy" });
    await expectNoA11yViolations(r.container);
    await userEvent.setup().click(button);
    await waitFor(() =>
      expect(
        calls.some((c) => c.path === `/api/v1/esign/me/envelopes/${ENVELOPE_ID}/signed.pdf`),
      ).toBe(true),
    );
    await waitFor(() => expect(clicked).toEqual(["subscription-agreement-signed.pdf"]));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("shows the confirmation once the company confirms", async () => {
    handlers(() => [
      200,
      closing([
        commitment({
          status: "wired",
          checklist: checklistOf({
            signed: true,
            signedAt: "2026-09-21T10:00:00.000Z",
            wired: true,
            wiredAt: "2026-09-22T10:00:00.000Z",
            confirmed: true,
            confirmedAt: "2026-09-23T10:00:00.000Z",
            stage: "confirmed",
          }),
          canSign: false,
          signatureRequest: null,
        }),
      ]),
    ]);
    await openRound();
    const card = await checklist();
    expect(within(card).getByText("Your investment is confirmed")).toBeInTheDocument();
    expect(within(card).queryByText("Not yet")).toBeNull();
  }, 20_000);

  it("gives a delegate the same stages with neither action", async () => {
    handlers(() => [
      200,
      closing([commitment({ canSign: false, signedDocumentAvailable: false })], true),
    ]);
    await openRound();
    const card = await checklist();
    expect(within(card).getByText("Waiting for the investor's signature")).toBeInTheDocument();
    expect(within(card).queryByText("Check your email to sign")).toBeNull();
    expect(within(card).queryByRole("button")).toBeNull();
  }, 20_000);

  it("says a voided request is no longer active", async () => {
    handlers(() => [
      200,
      closing([
        commitment({
          canSign: false,
          signatureRequest: {
            id: REQUEST_ID,
            status: "voided",
            sentAt: "2026-09-20T10:00:00.000Z",
            completedAt: null,
          },
        }),
      ]),
    ]);
    await openRound();
    const card = await checklist();
    expect(
      within(card).getByText("This signature request is no longer active"),
    ).toBeInTheDocument();
  }, 20_000);

  it.each([
    ["0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c57e1", "The signing service reported a problem"],
    [null, "This signature request is no longer active"],
  ])(
    "tells an error request the vendor holds (%s) apart from one that never reached it",
    async (envelopeId, title) => {
      handlers(() => [
        200,
        closing([
          commitment({
            canSign: false,
            envelopeId,
            signatureRequest: {
              id: REQUEST_ID,
              status: "error",
              sentAt: "2026-09-20T10:00:00.000Z",
              completedAt: null,
            },
          }),
        ]),
      ]);
      const r = await openRound();
      const card = await checklist();
      expect(within(card).getByText(title)).toBeInTheDocument();
      await expectNoA11yViolations(r.container);
    },
    20_000,
  );

  it("draws no checklist without a commitment", async () => {
    const { calls } = handlers(() => [200, closing([])]);
    await openRound();
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/v1/round/current/closing")).toBe(true),
    );
    expect(screen.queryByText("Closing")).toBeNull();
  }, 20_000);

  it("draws no checklist and no error when the member has no closing to show", async () => {
    const { calls } = handlers(() => apiError(404, "not_found"));
    await openRound();
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/v1/round/current/closing")).toBe(true),
    );
    expect(screen.queryByText("Closing")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  }, 20_000);
});
