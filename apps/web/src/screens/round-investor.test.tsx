import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANUAL_PENDING_POLL_MS,
  type MyVerification,
  STARTING_POLL_MAX_MS,
  STARTING_POLL_MS,
  STARTING_WINDOW_MS,
  STUCK_START_AFTER_MS,
  VENDOR_PENDING_POLL_MS,
  verificationPollInterval,
} from "../lib/round-verification-queries.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me } from "../test/fixtures.js";
import {
  currentRound,
  eligibilityView,
  interestSubmission,
  noteTerms,
  pricedTerms,
  roundFixture,
  SUBMISSION_ID,
  VERIFICATION_ID,
} from "../test/fixtures-round.js";
import {
  evidenceUploadResult,
  myVerification,
  parallelWidget,
  verifyInvestorInvite,
} from "../test/fixtures-round-verification.js";
import { apiError, type Handler, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * `/round` (E2.5 §W), from the investor's side.
 *
 * The properties worth a test are the ones a redesign would quietly break:
 *
 *  - **the browser never decides the accreditation path.** Every prompt on the form — the
 *    questionnaire, the written representations, the verification notice — is rendered from
 *    `GET /round/current/eligibility`, so a test that changes only the server's answer must
 *    change the whole form.
 *  - **"none of these apply" is an answer.** Under Rule 506(b) a non-accredited but
 *    sophisticated purchaser is allowed; ticking it clears the categories and asks for the
 *    sophistication statement instead of disqualifying anybody.
 *  - **nothing here offers to sell anything.** The words "indicate interest" and "not an offer
 *    to sell securities" are on the page, and no payment instruction is.
 *  - **the estimate is labelled by the term that produced it** — "at the cap", "with the
 *    discount" — never as a best and worst case, which would be a prediction.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", async () => ({
  investorModules: { round: () => import("../modules/round/investor.js") },
  adminModules: {},
}));

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

function handlers(over: Record<string, Handler> = {}): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, me()],
    "GET /api/v1/modules": () => [200, investorBootstrap()],
    "GET /api/v1/round/current": () => [200, currentRound()],
    "GET /api/v1/round/current/eligibility": () => [200, eligibilityView()],
    "GET /api/v1/round/current/verification": () => [200, { verification: null }],
    ...over,
  });
}

async function openRound(): Promise<Awaited<ReturnType<typeof renderApp>>> {
  const r = await renderApp("/round");
  expect(
    await screen.findByRole("heading", { name: "Round", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("round investor surface", () => {
  it("is an ordinary empty page when there is no round to show", async () => {
    handlers({
      "GET /api/v1/round/current": () => [
        200,
        currentRound({ round: null, terms: null, progress: null, disclaimer: null }),
      ],
    });
    const r = await openRound();
    expect(await screen.findByText("No round to show", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains a SAFE in words and draws the bar with its figures in text", async () => {
    handlers();
    const r = await openRound();
    expect(await screen.findByText("Seed 2026", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("SAFE, post-money")).toBeInTheDocument();
    expect(screen.getByText("Valuation cap")).toBeInTheDocument();
    expect(screen.getByText("$8,000,000")).toBeInTheDocument();
    expect(screen.getByText("Discount")).toBeInTheDocument();
    // Every term is explained, not merely named: a cap table is not common knowledge.
    expect(screen.getByText(/highest valuation at which your money converts/u)).toBeVisible();
    expect(screen.getByText("Most favoured nation")).toBeInTheDocument();
    expect(screen.getByText("Pro-rata rights")).toBeInTheDocument();
    // The meter is a picture with a sentence for a name, and the figures are also in text.
    const bar = screen.getByRole("img");
    expect(bar.getAttribute("aria-label")).toContain("$700,000 committed");
    expect(bar.getAttribute("aria-label")).toContain("35.00% committed");
    expect(screen.getAllByText("$300,000").length).toBeGreaterThan(0);
    expect(r.container.querySelectorAll("[style]")).toHaveLength(0);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains a convertible note's interest and maturity", async () => {
    handlers({
      "GET /api/v1/round/current": () => [
        200,
        currentRound({
          round: roundFixture({ instrumentKind: "note" }),
          terms: noteTerms(),
        }),
      ],
    });
    const r = await openRound();
    expect(await screen.findByText("Interest rate", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("5%")).toBeInTheDocument();
    expect(screen.getByText("24 months")).toBeInTheDocument();
    expect(screen.getByText(/falls due if it has not converted/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains a priced round's pre-money, share price and liquidation preference", async () => {
    handlers({
      "GET /api/v1/round/current": () => [
        200,
        currentRound({
          round: roundFixture({ instrumentKind: "priced" }),
          terms: pricedTerms(),
        }),
      ],
    });
    const r = await openRound();
    expect(
      await screen.findByText("Pre-money valuation", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("$12,000,000")).toBeInTheDocument();
    expect(screen.getByText("Price per share")).toBeInTheDocument();
    expect(screen.getByText("$2.50")).toBeInTheDocument();
    expect(screen.getByText("Liquidation preference")).toBeInTheDocument();
    expect(screen.getByText("1× the amount invested")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("estimates ownership at the cap and with the discount, and lists what it assumed", async () => {
    handlers();
    const r = await openRound();
    const user = userEvent.setup();
    const amount = await screen.findByLabelText("If you invested", {}, { timeout: 5000 });
    expect(amount).toHaveAttribute("inputmode", "decimal");
    await user.type(amount, "100000");
    // Labelled by the term that produces the figure, never "best" and "worst" case.
    expect(await screen.findByText("At the cap", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText("With the discount")).toBeVisible();
    expect(screen.getByText("1.25%")).toBeVisible();
    expect(screen.getByText("1.56%")).toBeVisible();
    // The assumptions are not buried: an estimate that hides them is a claim.
    expect(screen.getByText("What this took for granted")).toBeVisible();
    expect(screen.getByText(/Percentages are rounded to two decimal places/u)).toBeVisible();
    expect(screen.getByText(/estimate, not advice/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("asks the questionnaire, and 'none of these apply' clears it and asks for a statement", async () => {
    handlers();
    await openRound();
    const user = userEvent.setup();
    const amount = await screen.findByLabelText(/^Amount/u, {}, { timeout: 5000 });
    await user.type(amount, "50000");
    const income = await screen.findByRole(
      "checkbox",
      { name: /income was over/u },
      { timeout: 5000 },
    );
    await user.click(income);
    expect(income).toBeChecked();
    // Entity-only categories are not offered to somebody investing as themselves.
    expect(screen.queryByRole("checkbox", { name: /entity has over/u })).toBeNull();

    const none = screen.getByRole("checkbox", { name: "None of these apply to me" });
    await user.click(none);
    expect(none).toBeChecked();
    expect(income).not.toBeChecked();
    // Not a disqualification: 506(b) admits sophisticated non-accredited purchasers, so the
    // form asks about experience instead of stopping.
    expect(
      await screen.findByLabelText(/investing experience/u, {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.getByText("Indicate interest")).toBeVisible();
    expect(screen.getByText("This is not an offer to sell securities.")).toBeVisible();
  }, 20_000);

  it("asks for the two written representations once the amount clears the threshold", async () => {
    handlers({
      "GET /api/v1/round/current/eligibility": () => [
        200,
        eligibilityView({
          path: "self_certified",
          thresholdMet: true,
          threshold: { amount: "200000", currency: "USD" },
          reason: "At this amount the company may rely on your written representations.",
        }),
      ],
    });
    const r = await openRound();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Amount/u, {}, { timeout: 5000 }), "250000");
    expect(
      await screen.findByText("Your written representations", {}, { timeout: 5000 }),
    ).toBeVisible();
    const accredited = screen.getByRole("checkbox", { name: /I am an accredited investor/u });
    const financed = screen.getByRole("checkbox", { name: /not borrowing from anyone else/u });
    const consent = screen.getByRole("checkbox", { name: /Accredited investor questionnaire/u });
    // Both representations are required: the safe harbour is the pair, not either one.
    await user.click(consent);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.click(accredited);
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.click(financed);
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("posts the amount, the answers and the consent exactly as the form shows them", async () => {
    const { calls } = handlers({
      "POST /api/v1/round/current/interest": () => [201, interestSubmission()],
    });
    await openRound();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Amount/u, {}, { timeout: 5000 }), "50000");
    await user.click(
      await screen.findByRole("checkbox", { name: /income was over/u }, { timeout: 5000 }),
    );
    await user.click(screen.getByRole("checkbox", { name: /Accredited investor questionnaire/u }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/round/current/interest")?.body,
      ).toMatchObject({
        amount: "50000",
        subject: "individual",
        consentToElectronicRecords: true,
        accreditation: { categories: ["income"], section: "us", questionnaireVersion: 1 },
      }),
    );
    // The consent version travels with the answers: "I agreed to some earlier draft" is what a
    // stamp exists to answer.
    expect(
      await screen.findByText("Submitted, awaiting review", {}, { timeout: 5000 }),
    ).toBeVisible();
  }, 20_000);

  it("offers an evidence upload when the company has to verify accreditation", async () => {
    let sent = false;
    handlers({
      // The interest POST opens a manual verification; the card then reads it.
      "GET /api/v1/round/current/verification": () => [
        200,
        { verification: sent ? myVerification() : null },
      ],
      "GET /api/v1/round/current/eligibility": () => [
        200,
        eligibilityView({
          path: "verification_required",
          reason: "The company has to verify your accreditation before it can accept.",
        }),
      ],
      "POST /api/v1/round/current/interest": () => {
        sent = true;
        return [
          201,
          interestSubmission({
            accreditationPath: "verification_required",
            verificationId: VERIFICATION_ID,
          }),
        ];
      },
    });
    const r = await openRound();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Amount/u, {}, { timeout: 5000 }), "50000");
    expect(await screen.findByText("Verification needed", {}, { timeout: 5000 })).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: /Accredited investor questionnaire/u }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await screen.findByText("Send supporting evidence", {}, { timeout: 5000 }),
    ).toBeVisible();
    const file = screen.getByLabelText("Evidence file");
    expect(file).toHaveAttribute("type", "file");
    expect(file).toHaveAttribute("accept", "application/pdf,image/png,image/jpeg");
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("lists this member's submissions with their state in words, and withdraws one", async () => {
    const { calls } = handlers({
      "GET /api/v1/round/current": () => [
        200,
        currentRound({ submissions: [interestSubmission()] }),
      ],
      "POST /api/v1/round/current/interest/{id}/withdraw": () => [
        200,
        interestSubmission({ status: "withdrawn" }),
      ],
    });
    const r = await openRound();
    const user = userEvent.setup();
    expect(await screen.findByText("Your submissions", {}, { timeout: 5000 })).toBeVisible();
    // Said in words, not only as a coloured pill.
    expect(screen.getByText("Awaiting review")).toBeVisible();
    expect(screen.getByText("$50,000")).toBeVisible();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    const dialog = await screen.findByRole("dialog");
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "POST" &&
            c.path === `/api/v1/round/current/interest/${SUBMISSION_ID}/withdraw`,
        ),
      ).toBe(true),
    );
  }, 20_000);

  it("keeps the copy neutral, with no US prompts, outside the United States", async () => {
    handlers({
      "GET /api/v1/round/current": () => [200, currentRound({ offeringStatus: "non_us" })],
      "GET /api/v1/round/current/eligibility": () => [
        200,
        eligibilityView({
          path: "none",
          questionnaire: false,
          categories: [],
          questionnaireVersion: null,
          reason: "No accreditation questions apply to this offering.",
        }),
      ],
    });
    const r = await openRound();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^Amount/u, {}, { timeout: 5000 }), "50000");
    expect(
      await screen.findByText("No accreditation questions", {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.queryByText("Which of these describe you?")).toBeNull();
    expect(screen.queryByText("Your written representations")).toBeNull();
    expect(r.container.textContent).not.toContain("Rule 506");
    expect(screen.getByText(/nothing here is directed at anyone/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

/*
 * The accreditation verification card (E3.7). Everything it shows comes from
 * `GET /round/current/verification`; the properties worth pinning are that a vendor row never
 * offers an evidence upload, that the vendor link is a plain top-level link, that a 409 shows
 * the pending row instead of an error, and that polling stops once there is nothing to wait for.
 */
describe("round investor verification card", () => {
  const verificationOnly = (v: MyVerification | null, over: Record<string, Handler> = {}) =>
    handlers({
      "GET /api/v1/round/current/verification": () => [200, { verification: v }],
      ...over,
    });

  const card = async () =>
    (await screen.findByText("Accreditation verification", {}, { timeout: 5000 })).closest(
      "[data-slot=card]",
    ) as HTMLElement;

  it("draws nothing for a 506(b) investor with no verification and no need for one", async () => {
    verificationOnly(null);
    await openRound();
    expect(await screen.findByText("Your submissions", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.queryByText("Accreditation verification")).toBeNull();
  }, 20_000);

  it("offers to start one under 506(c), as an individual or an entity, and posts the choice", async () => {
    let started = false;
    const { calls } = verificationOnly(null, {
      "GET /api/v1/round/current": () => [200, currentRound({ offeringStatus: "506c" })],
      "GET /api/v1/round/current/verification": () => [
        200,
        { verification: started ? verifyInvestorInvite() : null },
      ],
      "POST /api/v1/round/current/verification": () => {
        started = true;
        return [201, verifyInvestorInvite()];
      },
    });
    const r = await openRound();
    const user = userEvent.setup();
    const box = await card();
    expect(within(box).getByText(/not started a verification yet/u)).toBeVisible();
    const individual = within(box).getByRole("radio", { name: "Myself" });
    expect(individual).toBeChecked();
    await expectNoA11yViolations(r.container);
    await user.click(within(box).getByRole("radio", { name: "An entity" }));
    await user.click(within(box).getByRole("button", { name: "Start verification" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/round/current/verification")
          ?.body,
      ).toEqual({ subject: "entity" }),
    );
    expect(
      await screen.findByText(/VerifyInvestor\.com has emailed you a link/u, {}, { timeout: 5000 }),
    ).toBeVisible();
  }, 20_000);

  it("shows the pending row a 409 verification_pending carries instead of an error", async () => {
    verificationOnly(null, {
      "GET /api/v1/round/current": () => [200, currentRound({ offeringStatus: "506c" })],
      "POST /api/v1/round/current/verification": () =>
        apiError(409, "conflict", {
          reason: "verification_pending",
          verification: parallelWidget(),
        }),
    });
    await openRound();
    const user = userEvent.setup();
    const box = await card();
    await user.click(within(box).getByRole("button", { name: "Start verification" }));
    expect(
      await within(box).findByRole(
        "link",
        { name: "Continue with Parallel Markets" },
        { timeout: 5000 },
      ),
    ).toBeVisible();
    expect(within(box).queryByRole("alert")).toBeNull();
  }, 20_000);

  it("offers the evidence upload for a manual review, and reads the flat upload answer", async () => {
    const { calls } = verificationOnly(myVerification(), {
      "PUT /api/v1/round/verifications/{id}/evidence": () => [200, evidenceUploadResult()],
    });
    const r = await openRound();
    const user = userEvent.setup();
    const box = await card();
    expect(within(box).getByText("In progress")).toBeVisible();
    expect(within(box).getByText("Send supporting evidence")).toBeVisible();
    await expectNoA11yViolations(r.container);
    const file = new File(["%PDF-1.7"], "letter.pdf", { type: "application/pdf" });
    await user.upload(within(box).getByLabelText("Evidence file"), file);
    await user.click(within(box).getByRole("button", { name: "Upload" }));
    expect(await screen.findByText("Evidence uploaded", {}, { timeout: 5000 })).toBeVisible();
    expect(
      calls.some(
        (c) =>
          c.method === "PUT" &&
          c.path === `/api/v1/round/verifications/${VERIFICATION_ID}/evidence`,
      ),
    ).toBe(true);
  }, 20_000);

  it("tells the investor to look for the vendor's email, with no upload", async () => {
    verificationOnly(verifyInvestorInvite());
    const r = await openRound();
    const box = await card();
    expect(
      within(box).getByText(/VerifyInvestor\.com has emailed you a link to continue/u),
    ).toBeVisible();
    expect(within(box).queryByLabelText("Evidence file")).toBeNull();
    expect(within(box).queryByRole("button", { name: "Start verification" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("links to the vendor widget page as a plain top-level link, with no upload", async () => {
    verificationOnly(parallelWidget());
    const r = await openRound();
    const box = await card();
    const link = within(box).getByRole("link", { name: "Continue with Parallel Markets" });
    // The server's own handoff page (same origin as the API), not a vendor URL and not a frame.
    expect(link.getAttribute("href")).toMatch(/\/api\/v1\/round\/current\/verification\/handoff$/u);
    expect(link).not.toHaveAttribute("target");
    expect(within(box).queryByLabelText("Evidence file")).toBeNull();
    expect(r.container.querySelector("iframe")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says 'setting up' while the vendor start runs, then shows the handoff once it lands", async () => {
    let reads = 0;
    verificationOnly(null, {
      "GET /api/v1/round/current/verification": () => {
        reads += 1;
        return [
          200,
          {
            verification:
              reads === 1
                ? verifyInvestorInvite({
                    handoff: null,
                    vendorStatus: null,
                    createdAt: new Date().toISOString(),
                  })
                : verifyInvestorInvite(),
          },
        ];
      },
    });
    const r = await openRound();
    const box = await card();
    expect(within(box).getByRole("status")).toHaveTextContent(
      "Setting up your verification with VerifyInvestor.com",
    );
    await expectNoA11yViolations(r.container);
    // The first poll is five seconds after the first read.
    expect(
      await within(box).findByText(/has emailed you a link/u, {}, { timeout: 9000 }),
    ).toBeVisible();
    expect(reads).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("inside an embed frame, sends the investor to the portal's own address instead of the widget", async () => {
    // `window.top !== window.self`: the portal is someone else's iframe.
    vi.stubGlobal("self", {});
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    verificationOnly(parallelWidget());
    const r = await openRound();
    const user = userEvent.setup();
    const box = await card();
    expect(within(box).queryByRole("link", { name: /Continue with/u })).toBeNull();
    expect(within(box).getByText(/open the investor portal at its own address/u)).toBeVisible();
    const link = within(box).getByRole("link", { name: "Open the investor portal" });
    expect(link).toHaveAttribute("href", "https://investors.acme.test/round");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
    await expectNoA11yViolations(r.container);
    await user.click(link);
    expect(open).toHaveBeenCalledWith("https://investors.acme.test/round", "_blank", "noopener");
    open.mockRestore();
  }, 20_000);

  it("says a start stuck for 15 minutes is still being set up, without spinning", async () => {
    verificationOnly(
      verifyInvestorInvite({
        handoff: null,
        vendorStatus: null,
        createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      }),
    );
    const r = await openRound();
    const box = await card();
    expect(within(box).getByText(/still being set up\. Check back later/u)).toBeVisible();
    expect(within(box).queryByRole("status")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it.each(["member_inactive", "imported", "member_erased"])(
    "words a row round ended (%s) neutrally, with nothing to retry",
    async (vendorError) => {
      verificationOnly(
        verifyInvestorInvite({ handoff: null, vendorStatus: "start_failed", vendorError }),
      );
      const r = await openRound();
      const box = await card();
      expect(within(box).getByText(/can no longer continue/u)).toBeVisible();
      expect(within(box).queryByRole("button")).toBeNull();
      expect(within(box).queryByRole("link")).toBeNull();
      await expectNoA11yViolations(r.container);
    },
    20_000,
  );

  it("explains an unfinished renewal and still links the Parallel handoff, and keeps polling", async () => {
    const renewal = parallelWidget({ vendorError: "renewal_not_recertified" });
    verificationOnly(renewal);
    const r = await openRound();
    const box = await card();
    expect(
      within(box).getByText(/Parallel Markets still shows your previous accreditation/u),
    ).toBeVisible();
    expect(within(box).getByRole("link", { name: "Continue with Parallel Markets" })).toBeVisible();
    expect(within(box).queryByRole("button")).toBeNull();
    expect(verificationPollInterval(renewal, null, Date.now())).toBe(VENDOR_PENDING_POLL_MS);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains an unfinished renewal and points to the vendor's email for an invite", async () => {
    verificationOnly(verifyInvestorInvite({ vendorError: "renewal_not_recertified" }));
    const r = await openRound();
    const box = await card();
    expect(
      within(box).getByText(/VerifyInvestor\.com still shows your previous accreditation/u),
    ).toBeVisible();
    expect(within(box).getByText(/has emailed you a link to continue/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says plainly when a vendor start failed, and offers nothing to retry", async () => {
    verificationOnly(verifyInvestorInvite({ handoff: null, vendorStatus: "start_failed" }));
    const r = await openRound();
    const box = await card();
    expect(within(box).getByText(/could not be set up/u)).toBeVisible();
    expect(within(box).queryByRole("status")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows a verified row with its expiry, and Renew opens the start form", async () => {
    const { calls } = verificationOnly(
      verifyInvestorInvite({
        status: "verified",
        handoff: null,
        vendorStatus: "accredited",
        decidedAt: "2026-03-01T10:00:00.000Z",
        expiresAt: "2026-12-01T10:00:00.000Z",
        canRenew: true,
      }),
      {
        "POST /api/v1/round/current/verification": () => [201, verifyInvestorInvite()],
      },
    );
    const r = await openRound();
    const user = userEvent.setup();
    const box = await card();
    expect(within(box).getByText("Verified")).toBeVisible();
    expect(within(box).getByText(/valid until Dec 1, 2026/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
    await user.click(within(box).getByRole("button", { name: "Renew" }));
    expect(within(box).getByRole("radio", { name: "Myself" })).toBeChecked();
    await user.click(within(box).getByRole("button", { name: "Renew" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/round/current/verification")
          ?.body,
      ).toEqual({ subject: "individual" }),
    );
    expect(await within(box).findByText(/has emailed you a link/u)).toBeVisible();
  }, 20_000);

  it("keeps a verified row without renewal to its expiry and no button", async () => {
    verificationOnly(
      myVerification({
        status: "verified",
        handoff: null,
        expiresAt: "2026-12-01T10:00:00.000Z",
        canRenew: false,
      }),
    );
    await openRound();
    const box = await card();
    expect(within(box).getByText(/valid until/u)).toBeVisible();
    expect(within(box).queryByRole("button", { name: "Renew" })).toBeNull();
  }, 20_000);

  it("words a rejection neutrally and offers to start again", async () => {
    verificationOnly(myVerification({ status: "rejected", handoff: null, canRenew: true }));
    const r = await openRound();
    const box = await card();
    expect(within(box).getByText("Not confirmed")).toBeVisible();
    expect(within(box).getByText(/did not confirm your accreditation/u)).toBeVisible();
    expect(within(box).getByRole("button", { name: "Start again" })).toBeVisible();
    expect(within(box).getByText(/not legal or investment advice/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows an expired row, with Start again only when the server allows it", async () => {
    verificationOnly(myVerification({ status: "expired", handoff: null, canRenew: false }));
    const r = await openRound();
    const box = await card();
    expect(within(box).getByText(/has expired/u)).toBeVisible();
    expect(within(box).queryByRole("button", { name: "Start again" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("verificationPollInterval", () => {
  const now = 1_000_000;
  const starting = verifyInvestorInvite({
    handoff: null,
    vendorStatus: null,
    createdAt: new Date(now).toISOString(),
  });

  it("polls a starting vendor row every 5 s, backs off, and stops after two minutes", () => {
    expect(verificationPollInterval(starting, now, now)).toBe(STARTING_POLL_MS);
    expect(verificationPollInterval(starting, now, now + 29_000)).toBe(STARTING_POLL_MS);
    expect(verificationPollInterval(starting, now, now + 31_000)).toBe(7_500);
    expect(verificationPollInterval(starting, now, now + 119_000)).toBeLessThanOrEqual(
      STARTING_POLL_MAX_MS,
    );
    expect(verificationPollInterval(starting, now, now + STARTING_WINDOW_MS)).toBe(false);
  });

  it("polls other pending rows slowly and stops for anything decided, failed or absent", () => {
    expect(verificationPollInterval(verifyInvestorInvite(), null, now)).toBe(
      VENDOR_PENDING_POLL_MS,
    );
    expect(verificationPollInterval(parallelWidget(), null, now)).toBe(VENDOR_PENDING_POLL_MS);
    expect(verificationPollInterval(myVerification(), null, now)).toBe(MANUAL_PENDING_POLL_MS);
    expect(
      verificationPollInterval(
        verifyInvestorInvite({ handoff: null, vendorStatus: "start_failed" }),
        now,
        now,
      ),
    ).toBe(false);
    for (const status of ["verified", "rejected", "expired"] as const) {
      expect(verificationPollInterval(myVerification({ status }), null, now)).toBe(false);
    }
    expect(verificationPollInterval(null, null, now)).toBe(false);
  });

  it("slow-polls a start stuck for 15 minutes and stops for a row round has ended", () => {
    expect(verificationPollInterval(starting, now, now + STUCK_START_AFTER_MS)).toBe(
      VENDOR_PENDING_POLL_MS,
    );
    for (const vendorError of ["member_inactive", "imported", "member_erased"]) {
      const ended = { ...verifyInvestorInvite({ vendorStatus: "start_failed" }), vendorError };
      expect(verificationPollInterval(ended, null, now)).toBe(false);
      const endedAfterInvite = { ...verifyInvestorInvite(), vendorError };
      expect(verificationPollInterval(endedAfterInvite, null, now)).toBe(false);
    }
  });
});
