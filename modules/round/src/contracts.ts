import { EmailSchema, TimestampSchema, trimmedText, UuidSchema } from "@fundroom/contracts";
import { ROUND_CLOSING_PREFILL_SOURCES } from "@fundroom/domain";
import {
  ACCREDITATION_PATHS,
  COMMITMENT_STATUSES,
  INSTRUMENT_KINDS,
  ROUND_STAGES,
} from "@fundroom/round-terms";
import { z } from "@hono/zod-openapi";
import { CLOSING_STAGES } from "./closing/rules.js";
import {
  INTEREST_STATUSES,
  INTEREST_SUBJECTS,
  ROUND_STATUSES,
  SIGNATURE_REQUEST_STATUSES,
  VERIFICATION_METHODS,
  VERIFICATION_STATUSES,
} from "./model.js";

/*
 * Route schemas for `/api/v1/round/*` (E2.5 §P). Part of the OpenAPI document the SDK is
 * generated from, so every `.openapi("…")` name is stable API. The frozen component names are:
 *
 *   RoundTerms, RoundSafeTerms, RoundNoteTerms, RoundPricedTerms, RoundTermsRevision,
 *   RoundTermsList, Round, RoundList, RoundDetail, RoundAllocation, RoundAllocationPercent,
 *   RoundAllocationCommitment, RoundAllocationView, RoundProgress, RoundProgressPercent,
 *   RoundCounters, RoundDisclaimer, RoundEligibility, RoundThreshold, RoundCalculation,
 *   RoundCalculatorDefaults, InvestorRound, InterestSubmission, InterestSubmissionRow,
 *   InterestSubmissionList, MyInterestList, InterestBody, InterestDecision,
 *   RoundAccreditationAnswers, AcceptInterestBody, DeclineInterestBody, RoundCommitment,
 *   RoundCommitmentList, CreateCommitmentBody, PatchCommitmentBody, RoundVerification,
 *   RoundVerificationRow, RoundVerificationList, RoundVerificationRequires,
 *   DecideVerificationBody, RoundClosingTask, RoundClosingTaskInput, RoundClosingTaskList,
 *   PutClosingTasksBody, CreateRoundBody, PatchRoundBody, PutRoundTermsBody, RoundSettings,
 *   RoundSettingsPatchBody.
 *
 * E3.5 closing workflow (ADR-0053): RoundClosingSettings, RoundSignatureRequest,
 *   RoundSignatureRequestBody, RoundSignatureSigner, RoundSignatureVoidBody,
 *   RoundClosingChecklist, RoundClosingStageTotal, RoundClosingSummary, RoundClosingInvestor,
 *   RoundClosingCommitment, RoundClosing, InvestorClosingCommitment, InvestorRoundClosing,
 *   InvestorClosingRound.
 *
 * E3.7 accreditation vendors (ADR-0055): RoundReverificationSettings, MyVerification,
 *   MyVerificationHandoff, MyVerificationResponse, StartVerificationBody, VerificationCheckQueued.
 *
 * Two house rules are load-bearing here:
 *
 *  - **Every amount is a decimal string**, never a JSON number. `numeric(20, 6)` does not
 *    survive a round trip through a double, and a valuation cap is exactly where somebody
 *    would notice. Every object carrying an amount carries its `currency` beside it, so a
 *    figure never travels without the unit it is in.
 *  - **Never `.nullable()` on a named schema.** `X.nullable()` marks the *component* nullable,
 *    so the generated type becomes `X | null` at every use site including the ones that cannot
 *    be null. `z.union([X, z.null()])` keeps the component alone.
 */

/** Plain decimal text, the spelling `pg` emits for a `numeric` and `formatFixed` produces. */
export const DecimalSchema = z
  .string()
  .regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u, "a plain decimal number")
  .max(32)
  .openapi({ example: "250000.00", description: "Decimal as text; never a JSON number" });

/** A positive amount of money on the way *in*: the same spelling, refused at or below zero. */
const PositiveDecimal = DecimalSchema.refine(
  (v) => /[1-9]/u.test(v) && !v.startsWith("-"),
  "must be greater than zero",
);

export const CurrencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/u)
  .openapi({ example: "USD", description: "ISO 4217, uppercase" });

export const RoundStageSchema = z.enum(ROUND_STAGES);
export const InstrumentKindSchema = z.enum(INSTRUMENT_KINDS);
export const RoundStatusSchema = z.enum(ROUND_STATUSES);
export const CommitmentStatusSchema = z.enum(COMMITMENT_STATUSES);
export const InterestStatusSchema = z.enum(INTEREST_STATUSES);
export const InterestSubjectSchema = z.enum(INTEREST_SUBJECTS);
export const AccreditationPathSchema = z.enum(ACCREDITATION_PATHS);
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export const VerificationMethodSchema = z.enum(VERIFICATION_METHODS);

const NullableString = z.union([z.string(), z.null()]);
const NullableDecimal = z.union([DecimalSchema, z.null()]);
const NullableTimestamp = z.union([TimestampSchema, z.null()]);
const NullableUuid = z.union([UuidSchema, z.null()]);

// --- terms ----------------------------------------------------------------------------------

/*
 * The three instrument shapes, restated in the OpenAPI flavour of zod.
 *
 * `@fundroom/round-terms` is deliberately **plain** zod so the investor's browser can run the
 * same calculator over the same objects without pulling Hono into its bundle, and the plan was
 * to name those schemas here with `.openapi()`. That does not survive the test runner: `.openapi`
 * is installed by `@hono/zod-openapi` onto `ZodType.prototype`, and Vitest's module graph loads
 * `zod` more than once (some workspace packages are externalised, some inlined), so a schema
 * built by the *other* copy has no such method and the module throws at import time. Restating
 * the shapes is the honest way out: the two are pinned against each other in `contracts.test.ts`
 * — same accepts, same rejects — and `@fundroom/round-terms`'s `parseTerms` remains the only
 * thing that decides what is stored, on every write path.
 */
const TermsDecimal = DecimalSchema;
const TermsPercent = DecimalSchema.refine((text) => {
  const value = Number.parseFloat(text);
  return Number.isFinite(value) && value >= 0 && value <= 100;
}, "must be a percentage between 0 and 100");

export const RoundSafeTermsSchema = z
  .object({
    kind: z.literal("safe"),
    variant: z.enum(["post_money", "pre_money"]),
    valuationCap: TermsDecimal.optional(),
    discountPercent: TermsPercent.optional(),
    mfn: z.boolean().default(false),
    proRata: z.boolean().default(false),
  })
  .strict()
  .openapi("RoundSafeTerms");

export const RoundNoteTermsSchema = z
  .object({
    kind: z.literal("note"),
    valuationCap: TermsDecimal.optional(),
    discountPercent: TermsPercent.optional(),
    interestRatePercent: TermsPercent,
    maturityMonths: z.number().int().min(1).max(120),
    mfn: z.boolean().default(false),
    proRata: z.boolean().default(false),
  })
  .strict()
  .openapi("RoundNoteTerms");

export const RoundPricedTermsSchema = z
  .object({
    kind: z.literal("priced"),
    preMoneyValuation: TermsDecimal,
    pricePerShare: TermsDecimal.optional(),
    liquidationPreferenceMultiple: TermsDecimal.default("1"),
    participating: z.boolean().default(false),
    proRata: z.boolean().default(false),
    optionPoolPercent: TermsPercent.optional(),
  })
  .strict()
  .openapi("RoundPricedTerms");

export const RoundTermsSchema = z
  .discriminatedUnion("kind", [RoundSafeTermsSchema, RoundNoteTermsSchema, RoundPricedTermsSchema])
  .openapi("RoundTerms");

export const RoundTermsRevisionSchema = z
  .object({
    id: UuidSchema,
    roundId: UuidSchema,
    revision: z.number().int().min(1),
    terms: RoundTermsSchema,
    /**
     * The round's currency, repeated here because every amount inside `terms` — a valuation
     * cap, a price per share, a pre-money — is in it, and a revision travels on its own into
     * the history list and into the `round_summary` block.
     */
    currency: CurrencySchema,
    schemaVersion: z.number().int().min(1),
    asOf: TimestampSchema,
    /** `<slug>:v<n>` of the disclaimer in force when this revision was written. */
    disclaimerStamp: NullableString,
    /** The revision that replaced this one; `null` on the live one. */
    supersededBy: NullableUuid,
    createdAt: TimestampSchema,
  })
  .openapi("RoundTermsRevision");

export const RoundTermsListSchema = z
  .object({ terms: z.array(RoundTermsRevisionSchema) })
  .openapi("RoundTermsList");

export const PutTermsBody = z
  .object({
    terms: RoundTermsSchema,
    /** The date the terms are *as of*; defaults to now. */
    asOf: TimestampSchema.optional(),
  })
  .openapi("PutRoundTermsBody");

// --- the round ------------------------------------------------------------------------------

export const RoundSchema = z
  .object({
    id: UuidSchema,
    name: z.string(),
    stage: RoundStageSchema,
    instrumentKind: InstrumentKindSchema,
    status: RoundStatusSchema,
    targetAmount: DecimalSchema,
    currency: CurrencySchema,
    minimumInvestment: NullableDecimal,
    opensAt: NullableTimestamp,
    closesAt: NullableTimestamp,
    openedAt: NullableTimestamp,
    closedAt: NullableTimestamp,
    /** E2.5 D8: whether investors see the progress bar. Staff always see every bucket. */
    showProgress: z.boolean(),
    /** Use of funds and timeline, as Markdown. */
    summary: NullableString,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("Round");

export const RoundListSchema = z.object({ rounds: z.array(RoundSchema) }).openapi("RoundList");

export const RoundIdParams = z.object({ id: UuidSchema });

export const CreateRoundBody = z
  .object({
    name: trimmedText({ min: 1, max: 120 }),
    stage: RoundStageSchema,
    instrumentKind: InstrumentKindSchema,
    targetAmount: PositiveDecimal,
    currency: CurrencySchema,
    minimumInvestment: z.union([PositiveDecimal, z.null()]).optional(),
    opensAt: z.union([TimestampSchema, z.null()]).optional(),
    closesAt: z.union([TimestampSchema, z.null()]).optional(),
    showProgress: z.boolean().optional(),
    summary: z.union([z.string().max(4000), z.null()]).optional(),
  })
  .openapi("CreateRoundBody");

export const PatchRoundBody = CreateRoundBody.partial().openapi("PatchRoundBody");

// --- allocation -----------------------------------------------------------------------------

/**
 * The buckets, computed once by `allocation()` in `@fundroom/round-terms` and read by the
 * admin tracker, the investor progress bar and the CRM reconciliation panel (E2.5 D2). A second
 * roll-up anywhere would eventually disagree with this one in front of an investor.
 */
const allocationShape = {
  currency: CurrencySchema,
  target: DecimalSchema,
  soft: DecimalSchema,
  verbal: DecimalSchema,
  signed: DecimalSchema,
  wired: DecimalSchema,
  /** `verbal + signed + wired`. */
  committed: DecimalSchema,
  /** `soft + committed`; never capped, even when the round is oversubscribed. */
  total: DecimalSchema,
  /** `max(0, target - total)`. */
  remaining: DecimalSchema,
  /** Percentages of the target, two decimals, clamped to 100 so a bar cannot overflow. */
  percent: z
    .object({ soft: DecimalSchema, committed: DecimalSchema, wired: DecimalSchema })
    .openapi("RoundAllocationPercent"),
} as const;

export const RoundAllocationSchema = z.object(allocationShape).openapi("RoundAllocation");

/**
 * One commitment as the allocation view carries it.
 *
 * Deliberately the *linking* fields and the money, and nothing else: the CRM pipeline board
 * joins its items to commitments by id on the client (E2.5 D2 — `pipeline_item.amount` is a
 * forecast, the committed figure is this one), and it needs the four subject ids to do it.
 * Notes, provenance and `interestSubmissionId` stay on `GET /round/rounds/{id}/commitments`.
 */
export const RoundAllocationCommitmentSchema = z
  .object({
    id: UuidSchema,
    amount: DecimalSchema,
    currency: CurrencySchema,
    status: CommitmentStatusSchema,
    membershipId: NullableUuid,
    contactId: NullableUuid,
    organizationId: NullableUuid,
    displayName: NullableString,
  })
  .openapi("RoundAllocationCommitment");

/** What `GET /round/rounds/{id}/allocation` answers: the buckets and the rows behind them. */
export const RoundAllocationViewSchema = z
  .object({ ...allocationShape, commitments: z.array(RoundAllocationCommitmentSchema) })
  .openapi("RoundAllocationView");

/** What an investor sees when `showProgress` is on: the same buckets minus the four splits. */
export const RoundProgressSchema = z
  .object({
    currency: CurrencySchema,
    target: DecimalSchema,
    soft: DecimalSchema,
    committed: DecimalSchema,
    wired: DecimalSchema,
    total: DecimalSchema,
    remaining: DecimalSchema,
    percent: z
      .object({ soft: DecimalSchema, committed: DecimalSchema, wired: DecimalSchema })
      .openapi("RoundProgressPercent"),
  })
  .openapi("RoundProgress");

export const RoundCountersSchema = z
  .object({
    submitted: z.number().int().min(0),
    accepted: z.number().int().min(0),
    /** Accepted submissions whose questionnaire named no category (E2.5 D7). */
    nonAccreditedAccepted: z.number().int().min(0),
    /** Rule 506(b)'s 35; a warning threshold, never a block. */
    limit: z.number().int().min(0),
  })
  .openapi("RoundCounters");

export const RoundDetailSchema = z
  .object({
    round: RoundSchema,
    terms: z.union([RoundTermsRevisionSchema, z.null()]),
    history: z.array(RoundTermsRevisionSchema),
    allocation: RoundAllocationSchema,
    counters: RoundCountersSchema,
  })
  .openapi("RoundDetail");

// --- the investor view ----------------------------------------------------------------------

export const RoundDisclaimerSchema = z
  .object({
    stamp: z.string().openapi({ example: "offering-disclaimer:v3" }),
    slug: z.string(),
    title: z.string(),
    versionNo: z.number().int().min(1),
    /** Markdown, exactly as published. */
    body: z.string(),
    effectiveAt: TimestampSchema,
  })
  .openapi("RoundDisclaimer");

export const RoundCalculationSchema = z
  .object({
    kind: InstrumentKindSchema,
    currency: CurrencySchema,
    amount: DecimalSchema,
    ownershipPercentLow: NullableDecimal,
    ownershipPercentHigh: NullableDecimal,
    effectiveValuation: NullableDecimal,
    sharesEstimate: NullableDecimal,
    explanation: z.array(z.string()),
    assumptions: z.array(z.string()),
  })
  .openapi("RoundCalculation");

export const RoundEligibilitySchema = z
  .object({
    path: AccreditationPathSchema,
    /** Whether the questionnaire is shown; its answers are recorded on every path that shows it. */
    questionnaire: z.boolean(),
    thresholdMet: z.boolean(),
    threshold: z
      .union([
        z.object({ amount: DecimalSchema, currency: CurrencySchema }).openapi("RoundThreshold"),
        z.null(),
      ])
      .optional(),
    /** One sentence, plain English, legal-neutral. */
    reason: z.string(),
    /** Whether this member already holds a live `accredited` attestation. */
    accredited: z.boolean(),
    accreditedUntil: NullableTimestamp,
    /** The question set the answers would be recorded under. */
    questionnaireVersion: z.number().int().min(1),
    offeringStatus: z.string(),
    subject: InterestSubjectSchema,
    amount: DecimalSchema,
    currency: CurrencySchema,
  })
  .openapi("RoundEligibility");

/**
 * The investor's whole page in one response.
 *
 * `round` is `null` when the workspace has nothing open and nothing closed — a workspace with
 * the module switched on and no round yet, which the SPA renders as an empty state rather than
 * as an error.
 */
export const InvestorRoundSchema = z
  .object({
    round: z.union([RoundSchema, z.null()]),
    terms: z.union([RoundTermsRevisionSchema, z.null()]),
    disclaimer: z.union([RoundDisclaimerSchema, z.null()]),
    /** `null` when `showProgress` is off — the absence *is* the setting. */
    progress: z.union([RoundProgressSchema, z.null()]),
    /** What the SPA's calculator opens on: the minimum, or a tenth of the target. */
    calculatorDefaults: z
      .object({ amount: DecimalSchema, currency: CurrencySchema })
      .openapi("RoundCalculatorDefaults"),
    mySubmissions: z.array(z.lazy(() => InterestSubmissionSchema)),
    /** Absent when there is no open round to indicate interest in. */
    eligibilityHint: z.union([RoundEligibilitySchema, z.null()]).optional(),
  })
  .openapi("InvestorRound");

// --- interest -------------------------------------------------------------------------------

/**
 * Self-certification answers, structurally identical to `AccreditationAnswers` in
 * `@fundroom/contracts` — a separate component because the round module does not depend on the
 * compliance package and must not start to. `@fundroom/compliance` re-parses these with its own
 * `.strict()` schema, which is the list of record.
 */
export const RoundAccreditationAnswersSchema = z
  .object({
    categories: z.array(z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/u)).max(40),
    section: z.enum(["us", "uk", "eu", "ca"]).optional(),
    /** The free-text sophistication statement 506(b) asks of a non-accredited purchaser. */
    note: z.string().max(4000).optional(),
    questionnaireVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .openapi("RoundAccreditationAnswers");

export const InterestSubmissionSchema = z
  .object({
    id: UuidSchema,
    roundId: UuidSchema,
    membershipId: UuidSchema,
    amount: DecimalSchema,
    currency: CurrencySchema,
    subject: InterestSubjectSchema,
    entityName: NullableString,
    note: NullableString,
    /** The path `eligibility()` computed at submission, stored rather than recomputed. */
    accreditationPath: AccreditationPathSchema,
    nonAccredited: z.boolean(),
    accreditationStamp: NullableString,
    disclaimerStamp: NullableString,
    /** The workspace's offering status at the moment the form was submitted. */
    offeringStatus: z.string(),
    status: InterestStatusSchema,
    verificationId: NullableUuid,
    commitmentId: NullableUuid,
    decidedAt: NullableTimestamp,
    decisionNote: NullableString,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("InterestSubmission");

/** The staff queue adds the member's name and email; an investor's own list never carries them. */
export const InterestSubmissionRowSchema = InterestSubmissionSchema.extend({
  displayName: NullableString,
  email: NullableString,
}).openapi("InterestSubmissionRow");

export const InterestSubmissionListSchema = z
  .object({ submissions: z.array(InterestSubmissionRowSchema) })
  .openapi("InterestSubmissionList");

export const MyInterestListSchema = z
  .object({ submissions: z.array(InterestSubmissionSchema) })
  .openapi("MyInterestList");

export const InterestBody = z
  .object({
    amount: PositiveDecimal,
    subject: InterestSubjectSchema,
    entityName: trimmedText({ min: 1, max: 200 }).optional(),
    note: z.string().max(4000).optional(),
    /** Required when the computed eligibility asks for the questionnaire. */
    accreditation: RoundAccreditationAnswersSchema.optional(),
    /**
     * The investor ticked the electronic-records consent beside the accreditation document.
     * Refused without it on any path that records a click-wrap acceptance.
     */
    consent: z.boolean().optional(),
  })
  .openapi("InterestBody");

export const InterestDecisionSchema = z
  .object({
    submission: InterestSubmissionSchema,
    commitment: z.union([z.lazy(() => RoundCommitmentSchema), z.null()]),
    /** `["non_accredited_limit"]` once 35 non-accredited purchasers have been accepted. */
    warnings: z.array(z.string()),
  })
  .openapi("InterestDecision");

export const AcceptInterestBody = z
  .object({
    /** Overrides the amount the investor asked for — an allocation, not a negotiation. */
    amount: PositiveDecimal.optional(),
    note: z.string().max(2000).optional(),
  })
  .openapi("AcceptInterestBody");

export const DeclineInterestBody = z
  .object({ note: z.string().max(2000).optional() })
  .openapi("DeclineInterestBody");

// --- commitments ----------------------------------------------------------------------------

export const RoundCommitmentSchema = z
  .object({
    id: UuidSchema,
    roundId: UuidSchema,
    membershipId: NullableUuid,
    organizationId: NullableUuid,
    contactId: NullableUuid,
    displayName: NullableString,
    amount: DecimalSchema,
    currency: CurrencySchema,
    status: CommitmentStatusSchema,
    note: NullableString,
    interestSubmissionId: NullableUuid,
    wiredAt: NullableTimestamp,
    /** E3.5: the subscription agreement was signed (e-signature or recorded by hand). */
    signedAt: NullableTimestamp,
    /** E3.5: staff confirmed the wired money. */
    confirmedAt: NullableTimestamp,
    /** E3.5: the vaulted signed copy in the data room (staff-only, legal hold). */
    signedDocumentId: NullableUuid,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("RoundCommitment");

export const RoundCommitmentListSchema = z
  .object({ commitments: z.array(RoundCommitmentSchema), allocation: RoundAllocationSchema })
  .openapi("RoundCommitmentList");

export const CreateCommitmentBody = z
  .object({
    membershipId: UuidSchema.optional(),
    organizationId: UuidSchema.optional(),
    contactId: UuidSchema.optional(),
    displayName: trimmedText({ min: 1, max: 200 }).optional(),
    amount: PositiveDecimal,
    status: CommitmentStatusSchema.optional(),
    note: z.string().max(4000).optional(),
  })
  .openapi("CreateCommitmentBody");

export const PatchCommitmentBody = z
  .object({
    amount: PositiveDecimal.optional(),
    status: CommitmentStatusSchema.optional(),
    note: z.union([z.string().max(4000), z.null()]).optional(),
  })
  .openapi("PatchCommitmentBody");

// --- verifications --------------------------------------------------------------------------

export const RoundVerificationSchema = z
  .object({
    id: UuidSchema,
    membershipId: UuidSchema,
    interestSubmissionId: NullableUuid,
    provider: z.string(),
    method: z.union([VerificationMethodSchema, z.null()]),
    status: VerificationStatusSchema,
    /** Whether a file is on disk right now — never the key, and never the bytes. */
    hasEvidence: z.boolean(),
    evidenceContentType: NullableString,
    evidenceBytes: z.union([z.number().int().min(0), z.null()]),
    evidenceSha256: NullableString,
    evidenceUploadedAt: NullableTimestamp,
    evidencePurgedAt: NullableTimestamp,
    evidenceNote: NullableString,
    decidedAt: NullableTimestamp,
    decisionNote: NullableString,
    expiresAt: NullableTimestamp,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    /** What the provider needs arranged before it can produce a decision. */
    requires: z
      .object({ evidenceUpload: z.boolean(), adminDecision: z.boolean() })
      .openapi("RoundVerificationRequires"),
    // --- E3.7 vendor verification ---
    /** Human name of `provider` ("Manual review", "VerifyInvestor.com", "Parallel Markets"). */
    providerLabel: z.string(),
    /** The vendor's handle for the attempt; `null` for manual rows and before the vendor answered. */
    providerRef: NullableString,
    /** The last raw vendor status, verbatim (≤100). */
    vendorStatus: NullableString,
    /** Why the vendor side failed (start failed, connection changed, …); never a credential. */
    vendorError: NullableString,
    vendorCheckedAt: NullableTimestamp,
    /** The vendor driver that decided; `null` when a person did. */
    decidedByProvider: NullableString,
    /** The verification this one renews. */
    reverificationOf: NullableUuid,
    /** When the next vendor check is due; `null` = not polled. */
    nextCheckAt: NullableTimestamp,
  })
  .openapi("RoundVerification");

export const RoundVerificationRowSchema = RoundVerificationSchema.extend({
  displayName: NullableString,
  email: NullableString,
}).openapi("RoundVerificationRow");

export const RoundVerificationListSchema = z
  .object({ verifications: z.array(RoundVerificationRowSchema) })
  .openapi("RoundVerificationList");

export const VerificationQuery = z.object({ status: VerificationStatusSchema.optional() });

export const DecideVerificationBody = z
  .object({
    status: z.enum(["verified", "rejected"]),
    method: VerificationMethodSchema.optional(),
    note: z.string().max(2000).optional(),
    /** Overrides the default expiry (90 days for a letter, twelve months otherwise). */
    expiresAt: TimestampSchema.optional(),
  })
  .openapi("DecideVerificationBody");

// --- the investor's own verification (E3.7) ----------------------------------------------------

/**
 * How the investor continues a verification. A widget handoff never carries its SDK config here:
 * it points at the handoff page (`/api/v1/round/current/verification/handoff`), which renders it.
 */
export const MyVerificationHandoffSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("upload") }),
    z.object({ kind: z.literal("invite_sent") }),
    z.object({ kind: z.literal("redirect"), url: z.string() }),
    z.object({ kind: z.literal("widget"), url: z.string() }),
  ])
  .openapi("MyVerificationHandoff");

export const MyVerificationSchema = z
  .object({
    id: UuidSchema,
    status: VerificationStatusSchema,
    provider: z.string().openapi({ example: "verifyinvestor" }),
    providerLabel: z.string().openapi({ example: "VerifyInvestor.com" }),
    handoff: z.union([MyVerificationHandoffSchema, z.null()]),
    vendorStatus: NullableString,
    /**
     * Why the vendor side stopped, in the round's own words (never a vendor's message):
     * `connection_changed`, `polling_stopped`, `member_erased`, `member_inactive`, `imported`,
     * `renewal_not_recertified` (the vendor still answers with the accreditation being renewed),
     * `start_failed` (any other start failure) or `vendor_error` (anything else).
     */
    vendorError: NullableString,
    expiresAt: NullableTimestamp,
    decidedAt: NullableTimestamp,
    createdAt: TimestampSchema,
    /** Whether the investor may start a (re)verification now (none pending; none, or one near expiry). */
    canRenew: z.boolean(),
  })
  .openapi("MyVerification");

export const MyVerificationResponseSchema = z
  .object({ verification: z.union([MyVerificationSchema, z.null()]) })
  .openapi("MyVerificationResponse");

export const StartVerificationBody = z
  .object({ subject: InterestSubjectSchema })
  .openapi("StartVerificationBody");

export const VerificationCheckQueuedSchema = z
  .object({ queued: z.literal(true) })
  .openapi("VerificationCheckQueued");

// --- closing tasks --------------------------------------------------------------------------

export const RoundClosingTaskSchema = z
  .object({
    id: UuidSchema,
    title: z.string(),
    done: z.boolean(),
    doneAt: NullableTimestamp,
    position: z.number().int().min(0),
  })
  .openapi("RoundClosingTask");

export const RoundClosingTaskListSchema = z
  .object({ tasks: z.array(RoundClosingTaskSchema) })
  .openapi("RoundClosingTaskList");

export const PutClosingTasksBody = z
  .object({
    tasks: z
      .array(
        z
          .object({
            id: UuidSchema.optional(),
            title: trimmedText({ min: 1, max: 200 }),
            done: z.boolean().default(false),
          })
          .openapi("RoundClosingTaskInput"),
      )
      .max(100),
  })
  .openapi("PutClosingTasksBody");

// --- queries and settings ---------------------------------------------------------------------

export const InterestQuery = z.object({ status: InterestStatusSchema.optional() });

export const CalculateQuery = z.object({
  amount: DecimalSchema,
});

export const EligibilityQuery = z.object({
  subject: InterestSubjectSchema,
  amount: DecimalSchema,
});

/** Where a subscription-template field gets its value (mirrors `ROUND_CLOSING_PREFILL_SOURCES`). */
export const RoundClosingPrefillSourceSchema = z.enum(ROUND_CLOSING_PREFILL_SOURCES);

export const RoundClosingSettingsSchema = z
  .object({
    /** The vendor-side template the subscription agreement is generated from; `null` = not set up. */
    subscriptionTemplateRef: z.union([trimmedText({ min: 1, max: 200 }), z.null()]),
    /**
     * The template's signer role the investor fills (DocuSign, multi-role DocuSeal). Default
     * "Signer".
     */
    templateRole: trimmedText({ min: 1, max: 100 }),
    /** Vendor field name → the fact it is filled with. At most 50. */
    prefill: z.record(trimmedText({ min: 1, max: 100 }), RoundClosingPrefillSourceSchema),
  })
  .openapi("RoundClosingSettings");

/** Accreditation re-verification (E3.7): one reminder `reminderDays` before expiry; `autoStart` opens the vendor renewal then. */
export const RoundReverificationSettingsSchema = z
  .object({
    reminderDays: z.number().int().min(1).max(60),
    autoStart: z.boolean(),
  })
  .openapi("RoundReverificationSettings");

export const RoundSettingsSchema = z
  .object({
    evidenceRetentionDays: z.number().int().min(1).max(3650),
    defaultCurrency: CurrencySchema,
    closing: RoundClosingSettingsSchema,
    reverification: RoundReverificationSettingsSchema,
  })
  .openapi("RoundSettings");

export const RoundSettingsPatchBody = z
  .object({
    evidenceRetentionDays: z.number().int().min(1).max(3650).optional(),
    defaultCurrency: CurrencySchema.optional(),
    /** Merged field by field into the stored block; `prefill`, when sent, replaces the map. */
    closing: z
      .object({
        subscriptionTemplateRef: z.union([trimmedText({ min: 1, max: 200 }), z.null()]).optional(),
        templateRole: trimmedText({ min: 1, max: 100 }).optional(),
        prefill: z
          .record(trimmedText({ min: 1, max: 100 }), RoundClosingPrefillSourceSchema)
          .refine((m) => Object.keys(m).length <= 50, "at most 50 prefill fields")
          .optional(),
      })
      .strict()
      .optional(),
    /** Merged field by field into the stored block (E3.7). */
    reverification: z
      .object({
        reminderDays: z.number().int().min(1).max(60).optional(),
        autoStart: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .openapi("RoundSettingsPatchBody");

// --- closing workflow (E3.5) ------------------------------------------------------------------

export const SignatureRequestStatusSchema = z.enum(SIGNATURE_REQUEST_STATUSES);
export const ClosingStageSchema = z.enum(CLOSING_STAGES);

export const RoundSignatureRequestSchema = z
  .object({
    id: UuidSchema,
    roundId: UuidSchema,
    commitmentId: UuidSchema,
    /** The kernel e-sign envelope; `null` only while `pending` (or a claim that failed). */
    envelopeId: NullableUuid,
    status: SignatureRequestStatusSchema,
    templateRef: NullableString,
    sentAt: TimestampSchema,
    completedAt: NullableTimestamp,
    terminalAt: NullableTimestamp,
    signedDocumentId: NullableUuid,
  })
  .openapi("RoundSignatureRequest");

export const RoundSignatureRequestBody = z
  .object({
    /** Shown to the signer in the vendor's email. */
    message: trimmedText({ min: 1, max: 2000 }).optional(),
    /**
     * Who signs, for a commitment that names no member (a CRM contact or a name only). Ignored
     * when the commitment names a member: the member's own name and address are used.
     */
    signer: z
      .object({
        name: trimmedText({ min: 1, max: 200 }),
        email: EmailSchema,
      })
      .strict()
      .openapi("RoundSignatureSigner")
      .optional(),
  })
  .strict()
  .openapi("RoundSignatureRequestBody");

export const RoundSignatureVoidBody = z
  .object({ reason: trimmedText({ min: 1, max: 500 }).optional() })
  .strict()
  .openapi("RoundSignatureVoidBody");

export const RoundClosingChecklistSchema = z
  .object({
    documentsSent: z.boolean(),
    documentsSentAt: NullableTimestamp,
    signed: z.boolean(),
    signedAt: NullableTimestamp,
    wired: z.boolean(),
    wiredAt: NullableTimestamp,
    confirmed: z.boolean(),
    confirmedAt: NullableTimestamp,
    stage: ClosingStageSchema,
  })
  .openapi("RoundClosingChecklist");

const StageTotalSchema = z
  .object({ count: z.number().int().min(0), amount: DecimalSchema })
  .openapi("RoundClosingStageTotal");

export const RoundClosingSummarySchema = z
  .object({
    currency: CurrencySchema,
    not_started: StageTotalSchema,
    documents_sent: StageTotalSchema,
    signed: StageTotalSchema,
    wired: StageTotalSchema,
    confirmed: StageTotalSchema,
    withdrawn: StageTotalSchema,
  })
  .openapi("RoundClosingSummary");

export const RoundClosingCommitmentSchema = z
  .object({
    commitmentId: UuidSchema,
    investor: z
      .object({
        membershipId: NullableUuid,
        contactId: NullableUuid,
        organizationId: NullableUuid,
        /** The member's name, else the commitment's display name. */
        name: NullableString,
      })
      .openapi("RoundClosingInvestor"),
    amount: DecimalSchema,
    currency: CurrencySchema,
    status: CommitmentStatusSchema,
    checklist: RoundClosingChecklistSchema,
    signatureRequest: z.union([RoundSignatureRequestSchema, z.null()]),
    signedDocumentId: NullableUuid,
  })
  .openapi("RoundClosingCommitment");

export const RoundClosingSchema = z
  .object({
    roundId: UuidSchema,
    currency: CurrencySchema,
    summary: RoundClosingSummarySchema,
    commitments: z.array(RoundClosingCommitmentSchema),
    tasks: z.array(RoundClosingTaskSchema),
  })
  .openapi("RoundClosing");

export const InvestorClosingCommitmentSchema = z
  .object({
    commitmentId: UuidSchema,
    amount: DecimalSchema,
    currency: CurrencySchema,
    status: CommitmentStatusSchema,
    checklist: RoundClosingChecklistSchema,
    signatureRequest: z.union([
      z
        .object({
          id: UuidSchema,
          status: SignatureRequestStatusSchema,
          sentAt: TimestampSchema,
          completedAt: NullableTimestamp,
        })
        .openapi("InvestorSignatureRequest"),
      z.null(),
    ]),
    /** An agreement is waiting for this viewer's signature (the vendor emailed the link). */
    canSign: z.boolean(),
    /** The signed copy can be downloaded by this viewer from `/esign/me/envelopes/{envelopeId}/signed.pdf`. */
    signedDocumentAvailable: z.boolean(),
    envelopeId: NullableUuid,
  })
  .openapi("InvestorClosingCommitment");

export const InvestorRoundClosingSchema = z
  .object({
    round: z.union([
      z
        .object({
          id: UuidSchema,
          name: z.string(),
          status: RoundStatusSchema,
          currency: CurrencySchema,
        })
        .openapi("InvestorClosingRound"),
      z.null(),
    ]),
    commitments: z.array(InvestorClosingCommitmentSchema),
    /** A delegate sees their principal's card and can do nothing with it. */
    readOnly: z.boolean(),
  })
  .openapi("InvestorRoundClosing");
