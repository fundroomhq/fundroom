import type { Allocation, NoteTerms, PricedTerms, SafeTerms } from "@fundroom/round-terms";
import type {
  ClosingTask,
  Commitment,
  CurrentRoundView,
  EligibilityView,
  InterestSubmission,
  Round,
  RoundDetail,
  RoundSettings,
  TermsRevision,
  Verification,
  VerificationRow,
} from "../lib/round-queries.js";

/*
 * Round fixtures (E2.5). They live here rather than in `mock-api.ts` because the round
 * payload types are hand-written in `lib/round-queries.ts` until the SDK is regenerated, and
 * `mock-api.ts` is typed against `FundRoomSchemas` throughout.
 *
 * Two properties of the real responses are reproduced on purpose:
 *
 *  - **every amount is a decimal string.** `numeric(20, 6)` does not survive a round trip
 *    through a double (contract §5), so a fixture with `1000000` instead of
 *    `"1000000.000000"` would let a regression straight through.
 *  - **the allocation buckets are consistent.** `allocationFixture` derives `committed`,
 *    `total`, `remaining` and the percentages from the four bucket figures, the way the
 *    server's `allocation()` does, so a test cannot accidentally assert against a tracker
 *    whose parts do not add up.
 */

const NOW_ISO = "2026-09-12T10:00:00.000Z";

export const ROUND_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5701";
export const TERMS_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5702";
export const SUBMISSION_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5703";
export const VERIFICATION_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5704";
export const COMMITMENT_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5705";
export const INVESTOR_MEMBERSHIP_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5706";

export function safeTerms(over: Partial<SafeTerms> = {}): SafeTerms {
  return {
    kind: "safe",
    variant: "post_money",
    valuationCap: "8000000",
    discountPercent: "20",
    mfn: true,
    proRata: true,
    ...over,
  };
}

export function noteTerms(over: Partial<NoteTerms> = {}): NoteTerms {
  return {
    kind: "note",
    valuationCap: "8000000",
    discountPercent: "20",
    interestRatePercent: "5",
    maturityMonths: 24,
    mfn: false,
    proRata: true,
    ...over,
  };
}

export function pricedTerms(over: Partial<PricedTerms> = {}): PricedTerms {
  return {
    kind: "priced",
    preMoneyValuation: "12000000",
    pricePerShare: "2.50",
    liquidationPreferenceMultiple: "1",
    participating: false,
    proRata: true,
    optionPoolPercent: "10",
    ...over,
  };
}

export function roundFixture(over: Partial<Round> = {}): Round {
  return {
    id: ROUND_ID,
    name: "Seed 2026",
    stage: "seed",
    instrumentKind: "safe",
    status: "open",
    targetAmount: "2000000.000000",
    currency: "USD",
    minimumInvestment: "25000.000000",
    opensAt: null,
    closesAt: null,
    openedAt: NOW_ISO,
    closedAt: null,
    showProgress: true,
    summary: "## Use of funds\n\nEighteen months of runway and two engineers.",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...over,
  };
}

export function termsRevision(over: Partial<TermsRevision> = {}): TermsRevision {
  return {
    id: TERMS_ID,
    roundId: ROUND_ID,
    revision: 1,
    terms: safeTerms(),
    termsSchemaVersion: 1,
    asOf: NOW_ISO,
    disclaimerStamp: "offering-disclaimer:v2",
    supersededBy: null,
    createdAt: NOW_ISO,
    createdBy: {
      membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6d",
      displayName: "Ada Lovelace",
    },
    ...over,
  };
}

const money = (value: number): string => value.toFixed(6);
const pct = (part: number, target: number): string =>
  (target === 0 ? 0 : Math.min(100, (part / target) * 100)).toFixed(2);

/** Buckets that add up, the way the server's `allocation()` produces them. */
export function allocationFixture(
  over: { target?: number; soft?: number; verbal?: number; signed?: number; wired?: number } = {},
): Allocation {
  const target = over.target ?? 2_000_000;
  const soft = over.soft ?? 300_000;
  const verbal = over.verbal ?? 200_000;
  const signed = over.signed ?? 400_000;
  const wired = over.wired ?? 100_000;
  const committed = verbal + signed + wired;
  const total = soft + committed;
  return {
    target: money(target),
    soft: money(soft),
    verbal: money(verbal),
    signed: money(signed),
    wired: money(wired),
    committed: money(committed),
    total: money(total),
    remaining: money(Math.max(0, target - total)),
    percent: {
      soft: pct(soft, target),
      committed: pct(committed, target),
      wired: pct(wired, target),
    },
  };
}

export function interestSubmission(over: Partial<InterestSubmission> = {}): InterestSubmission {
  return {
    id: SUBMISSION_ID,
    roundId: ROUND_ID,
    membershipId: INVESTOR_MEMBERSHIP_ID,
    member: { membershipId: INVESTOR_MEMBERSHIP_ID, displayName: "Ada Lovelace" },
    amount: "50000.000000",
    currency: "USD",
    subject: "individual",
    entityName: null,
    note: null,
    accreditationPath: "self_attested",
    nonAccredited: false,
    accreditationStamp: "accreditation:v1",
    disclaimerStamp: "offering-disclaimer:v2",
    offeringStatus: "506b",
    status: "submitted",
    verificationId: null,
    commitmentId: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...over,
  };
}

/** A verification as the staff routes return it (decide, upload answers): no member fields. */
export function verificationFixture(over: Partial<Verification> = {}): Verification {
  return {
    id: VERIFICATION_ID,
    membershipId: INVESTOR_MEMBERSHIP_ID,
    interestSubmissionId: SUBMISSION_ID,
    provider: "manual",
    providerLabel: "Manual review",
    providerRef: null,
    method: null,
    status: "pending",
    hasEvidence: true,
    evidenceContentType: "application/pdf",
    evidenceBytes: 51_200,
    evidenceSha256: null,
    evidenceNote: null,
    evidenceUploadedAt: NOW_ISO,
    evidencePurgedAt: null,
    decidedAt: null,
    decisionNote: null,
    expiresAt: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    requires: { evidenceUpload: true, adminDecision: true },
    vendorStatus: null,
    vendorError: null,
    vendorCheckedAt: null,
    decidedByProvider: null,
    reverificationOf: null,
    nextCheckAt: null,
    ...over,
  };
}

/**
 * A queue row (`GET /round/verifications`): the verification plus the member's name and email,
 * flat on the row — the server's `RoundVerificationRow`, not a nested `member`.
 */
export function verificationRowFixture(over: Partial<VerificationRow> = {}): VerificationRow {
  return {
    ...verificationFixture(),
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    ...over,
  };
}

/** A pending VerifyInvestor.com row the vendor is still working on. */
export function vendorVerificationRowFixture(over: Partial<VerificationRow> = {}): VerificationRow {
  return verificationRowFixture({
    provider: "verifyinvestor",
    providerLabel: "VerifyInvestor.com",
    providerRef: "vr:4711",
    hasEvidence: false,
    evidenceContentType: null,
    evidenceBytes: null,
    evidenceUploadedAt: null,
    requires: { evidenceUpload: false, adminDecision: false },
    vendorStatus: "waiting_for_investor_acceptance",
    vendorCheckedAt: NOW_ISO,
    nextCheckAt: NOW_ISO,
    ...over,
  });
}

export function commitmentFixture(over: Partial<Commitment> = {}): Commitment {
  return {
    id: COMMITMENT_ID,
    roundId: ROUND_ID,
    membershipId: INVESTOR_MEMBERSHIP_ID,
    member: { membershipId: INVESTOR_MEMBERSHIP_ID, displayName: "Ada Lovelace" },
    organizationId: null,
    contactId: null,
    displayName: null,
    amount: "50000.000000",
    status: "soft",
    note: null,
    interestSubmissionId: SUBMISSION_ID,
    signedDocumentId: null,
    wiredAt: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...over,
  };
}

export function closingTask(over: Partial<ClosingTask> = {}): ClosingTask {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5707",
    title: "Send the SAFE to counsel",
    done: false,
    doneAt: null,
    position: 0,
    ...over,
  };
}

export function roundDetail(over: Partial<RoundDetail> = {}): RoundDetail {
  return {
    round: roundFixture(),
    terms: termsRevision(),
    history: [termsRevision()],
    allocation: allocationFixture(),
    counters: { submitted: 3, accepted: 2, nonAccreditedAccepted: 1, limit: 35 },
    ...over,
  };
}

export function roundSettingsFixture(over: Partial<RoundSettings> = {}): RoundSettings {
  return {
    evidenceRetentionDays: 90,
    defaultCurrency: "USD",
    closing: { subscriptionTemplateRef: null, templateRole: "Signer", prefill: {} },
    reverification: { reminderDays: 14, autoStart: false },
    ...over,
  };
}

export function currentRound(over: Partial<CurrentRoundView> = {}): CurrentRoundView {
  return {
    round: roundFixture(),
    terms: safeTerms(),
    disclaimer: {
      stamp: "offering-disclaimer:v2",
      title: "Offering disclaimer",
      body: "Nothing on this page is an offer to sell securities.",
      versionNo: 2,
    },
    progress: allocationFixture(),
    submissions: [],
    accreditationDocument: {
      slug: "accreditation",
      title: "Accredited investor questionnaire",
      versionNo: 1,
      stamp: "accreditation:v1",
    },
    offeringStatus: "506b",
    ...over,
  };
}

/** The four US categories the questionnaire asks about, trimmed to what a screen test needs. */
export function eligibilityCategories() {
  return [
    {
      key: "income",
      label: "My income was over $200,000 in each of the last two years",
      section: "us" as const,
      subjects: ["individual" as const],
    },
    {
      key: "net_worth",
      label: "My net worth is over $1,000,000, not counting my home",
      section: "us" as const,
      subjects: ["individual" as const],
    },
    {
      key: "entity_assets",
      label: "The entity has over $5,000,000 in assets",
      section: "us" as const,
      subjects: ["entity" as const],
    },
    { key: "professional", label: "I hold a Series 7, 65 or 82 licence", section: "us" as const },
  ];
}

export function eligibilityView(over: Partial<EligibilityView> = {}): EligibilityView {
  return {
    path: "self_attested",
    questionnaire: true,
    thresholdMet: false,
    reason: "This offering is made privately, so you answer the accreditation questions yourself.",
    accredited: false,
    categories: eligibilityCategories(),
    questionnaireVersion: 1,
    ...over,
  };
}

/** §R's hydrated `round_summary` payload, as the content block renderer receives it. */
export function roundSummaryHydrated(over: Record<string, unknown> = {}): Record<string, unknown> {
  const round = roundFixture();
  return {
    round: {
      id: round.id,
      name: round.name,
      stage: round.stage,
      instrumentKind: round.instrumentKind,
      status: round.status,
      currency: round.currency,
      targetAmount: round.targetAmount,
      minimumInvestment: round.minimumInvestment,
    },
    terms: safeTerms(),
    progress: allocationFixture(),
    disclaimer: {
      stamp: "offering-disclaimer:v2",
      title: "Offering disclaimer",
      body: "Nothing on this page is an offer to sell securities.",
      versionNo: 2,
    },
    ...over,
  };
}
