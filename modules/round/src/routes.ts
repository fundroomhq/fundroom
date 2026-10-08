import { randomBytes } from "node:crypto";
import {
  ApiError,
  type ApiErrorCode,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  requestIdOf,
  sessionOrApiKeySecurity,
  sessionSecurity,
  z,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import { lockWorkspaceFacts, updateWorkspaceSettingsBlock } from "@fundroom/db";
import { parseWorkspaceSettings, WorkspaceSettingsSchema } from "@fundroom/domain";
import { MembershipRepo } from "@fundroom/identity";
import type {
  ModuleEnv,
  ModuleRouter,
  ModuleServices,
  ResolvedDisclaimer,
} from "@fundroom/module-kit";
import { ACCREDITATION_HANDOFF_PATH } from "@fundroom/ports";
import { calculate, eligibility } from "@fundroom/round-terms";
import type { Context } from "hono";
import * as s from "./contracts.js";
import { refuseDelegateWrite, refuseNarrowDelegate } from "./delegation.js";
import { type Actor, RoundError, type RoundErrorCode } from "./errors.js";
import { EVIDENCE_CONTENT_TYPES } from "./model.js";
import { handleEvidenceUpload } from "./raw-routes.js";
import type {
  ClosingTaskRecord,
  CommitmentRecord,
  InterestRecord,
  RoundRecord,
  TermsRecord,
  VerificationRecord,
} from "./repos/round-repo.js";
import type { RoundAllocation } from "./service/allocation.js";
import { type CommitmentService, createCommitmentService } from "./service/commitments.js";
import { commitmentsCsv, csvFilename } from "./service/export.js";
import { createInterestService, type InterestService } from "./service/interest.js";
import { createRoundService, type RoundService } from "./service/rounds.js";
import { createTermsService, type TermsService } from "./service/terms.js";
import {
  createVendorVerificationService,
  type VendorVerificationService,
} from "./service/vendor.js";
import { handoffCsp, handoffPage, myHandoff } from "./service/vendor-rules.js";
import { createVerificationService, type VerificationService } from "./service/verification.js";

/*
 * `/api/v1/round/*` (E2.5 §P).
 *
 * Three audiences share one router and the split is deliberate:
 *
 *  - `/round/current*` is `member`, because what an investor may see is decided by the round's
 *    own status and by RLS, not by RBAC. An investor holds no permission at all (ADR-0014), so
 *    gating their own round page behind one would close it to everybody.
 *  - `/round/rounds*`, `/round/interest/*`, `/round/verifications*` are staff surfaces behind
 *    `round.read` / `round.manage`. `requirePermission` answers **404** for a non-staff caller,
 *    which is why an investor probing the admin tree learns nothing.
 *  - opening, closing and the commitments CSV are `round.publish` **+ step-up**: design/05 §122
 *    names "cap-table/round export" as the example of what step-up exists for, and opening a
 *    round is the moment a company starts offering securities.
 *
 * Handlers hold no logic beyond shaping the response: the services decide, the repos touch SQL.
 * Services are built on **first use** — `moduleServicesOf` is a Proxy of thunks and touching one
 * at registration time throws against the OpenAPI generation stub.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 413, 415, 429, 500, 503);
const TAGS = ["round"];

export const PERM_READ = "round.read";
export const PERM_MANAGE = "round.manage";
export const PERM_PUBLISH = "round.publish";
export const PERM_SETTINGS = "round.settings";

type Vars = ModuleEnv["Variables"];
export interface Signed {
  /** Absent when an API key made the request (E3.4): the key acts as its creator. */
  readonly session?: NonNullable<Vars["session"]> | undefined;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

export function signed(c: Context<ModuleEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if ((!session && !c.get("apiKey")) || !membership || !tenant || !workspace)
    throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

export const actorOf = (c: Context<ModuleEnv>, sg: Signed): Actor => ({
  membershipId: sg.membership.id,
  requestId: requestIdOf(c),
  sessionId: sg.session?.sessionId,
  apiKeyId: c.get("apiKey")?.id,
});

/**
 * `RoundErrorCode` is wider than the API vocabulary on purpose: "below the minimum" and "this
 * round is not open" are both 409s on the wire and completely different sentences on screen, so
 * the specific code travels on in `details.reason` and this table decides only the status.
 */
export const API_CODE: Readonly<Record<RoundErrorCode, ApiErrorCode>> = {
  not_found: "not_found",
  conflict: "conflict",
  validation_failed: "validation_failed",
  forbidden: "forbidden",
  rate_limited: "rate_limited",
  round_not_open: "conflict",
  round_already_open: "conflict",
  terms_missing: "conflict",
  below_minimum: "conflict",
  accreditation_required: "conflict",
  evidence_required: "validation_failed",
  unsupported_media_type: "unsupported_media_type",
  payload_too_large: "payload_too_large",
  scan_failed: "validation_failed",
  signature_request_open: "conflict",
  signature_request_pending: "conflict",
  envelope_not_open: "envelope_not_open",
  commitment_not_signable: "conflict",
  commitment_not_wired: "conflict",
  signer_email_missing: "signer_email_missing",
  esign_not_configured: "esign_not_configured",
  esign_template_unsupported: "esign_template_unsupported",
  subscription_template_missing: "conflict",
  verification_pending: "conflict",
  verification_not_vendor: "conflict",
  member_erased: "conflict",
};

export function rethrow(error: unknown): never {
  if (error instanceof RoundError) {
    throw new ApiError(API_CODE[error.code], error.message, {
      ...error.details,
      reason: error.code,
    });
  }
  throw error;
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function roundBody(r: RoundRecord) {
  return {
    id: r.id,
    name: r.name,
    stage: r.stage,
    instrumentKind: r.instrumentKind,
    status: r.status,
    targetAmount: r.targetAmount,
    currency: r.currency,
    minimumInvestment: r.minimumInvestment,
    opensAt: iso(r.opensAt),
    closesAt: iso(r.closesAt),
    openedAt: iso(r.openedAt),
    closedAt: iso(r.closedAt),
    showProgress: r.showProgress,
    summary: r.summary,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function termsBody(t: TermsRecord, currency: string) {
  return {
    id: t.id,
    roundId: t.roundId,
    revision: t.revision,
    terms: t.terms,
    // Repeated from the round: every amount inside `terms` is in this currency and a revision
    // travels on its own into the history list and into the `round_summary` block.
    currency,
    schemaVersion: t.termsSchemaVersion,
    asOf: t.asOf.toISOString(),
    disclaimerStamp: t.disclaimerStamp,
    supersededBy: t.supersededBy,
    createdAt: t.createdAt.toISOString(),
  };
}

const allocationBody = (a: RoundAllocation) => ({
  currency: a.currency,
  target: a.target,
  soft: a.soft,
  verbal: a.verbal,
  signed: a.signed,
  wired: a.wired,
  committed: a.committed,
  total: a.total,
  remaining: a.remaining,
  percent: { ...a.percent },
});

function submissionBody(x: InterestRecord) {
  return {
    id: x.id,
    roundId: x.roundId,
    membershipId: x.membershipId,
    amount: x.amount,
    currency: x.currency,
    subject: x.subject,
    entityName: x.entityName,
    note: x.note,
    accreditationPath: x.accreditationPath,
    nonAccredited: x.nonAccredited,
    accreditationStamp: x.accreditationStamp,
    disclaimerStamp: x.disclaimerStamp,
    offeringStatus: x.offeringStatus,
    status: x.status,
    verificationId: x.verificationId,
    commitmentId: x.commitmentId,
    decidedAt: iso(x.decidedAt),
    decisionNote: x.decisionNote,
    createdAt: x.createdAt.toISOString(),
    updatedAt: x.updatedAt.toISOString(),
  };
}

export const commitmentBody = (c: CommitmentRecord, currency: string) => ({
  id: c.id,
  roundId: c.roundId,
  membershipId: c.membershipId,
  organizationId: c.organizationId,
  contactId: c.contactId,
  displayName: c.displayName,
  amount: c.amount,
  currency,
  status: c.status,
  note: c.note,
  interestSubmissionId: c.interestSubmissionId,
  wiredAt: iso(c.wiredAt),
  signedAt: iso(c.signedAt),
  confirmedAt: iso(c.confirmedAt),
  signedDocumentId: c.signedDocumentId,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

/**
 * E3.7 FOUNDATION: what a verification's provider needs from the flow above — manual needs an
 * upload and a human, a vendor neither. (The round agent may replace this.)
 */
const providerLabelOf = (provider: string): string =>
  provider === "verifyinvestor"
    ? "VerifyInvestor.com"
    : provider === "parallel-markets"
      ? "Parallel Markets"
      : "Manual review";

const labelOf = providerLabelOf;

/** The `vendor_error` codes an investor may be shown as they are (the round's own vocabulary). */
const INVESTOR_VENDOR_ERRORS = new Set([
  "connection_changed",
  "polling_stopped",
  "member_erased",
  "member_inactive",
  "imported",
  "renewal_not_recertified",
]);

/**
 * `vendor_error` for the investor: the round's own codes, a failed start as `start_failed`, and
 * anything else (a port code such as `unauthorized`, which is the company's problem) as
 * `vendor_error`.
 */
function investorVendorError(v: VerificationRecord): string | null {
  if (v.vendorError === null) return null;
  if (INVESTOR_VENDOR_ERRORS.has(v.vendorError)) return v.vendorError;
  return v.vendorStatus === "start_failed" ? "start_failed" : "vendor_error";
}

/**
 * The investor's own view of a verification (E3.7): never the widget config, never the ref. A
 * widget handoff is the handoff page's path (`ACCREDITATION_HANDOFF_PATH`); the SPA prefixes its
 * own API base, as for every other call.
 */
function myVerificationBody(v: VerificationRecord, canRenew: boolean, handoffUrl: string) {
  return {
    id: v.id,
    status: v.status,
    provider: v.provider,
    providerLabel: labelOf(v.provider),
    handoff: myHandoff(v, handoffUrl),
    vendorStatus: v.vendorStatus,
    vendorError: investorVendorError(v),
    expiresAt: iso(v.expiresAt),
    decidedAt: iso(v.decidedAt),
    createdAt: v.createdAt.toISOString(),
    canRenew,
  };
}

const requiresOf = (provider: string) =>
  provider === "manual"
    ? { evidenceUpload: true, adminDecision: true }
    : { evidenceUpload: false, adminDecision: false };

function verificationBody(
  v: VerificationRecord,
  requires: { readonly evidenceUpload: boolean; readonly adminDecision: boolean },
) {
  return {
    id: v.id,
    membershipId: v.membershipId,
    interestSubmissionId: v.interestSubmissionId,
    provider: v.provider,
    method: v.method,
    status: v.status,
    // Whether there is a file, never the key that would let somebody ask for it directly.
    hasEvidence: v.evidenceKey !== null,
    evidenceContentType: v.evidenceContentType,
    evidenceBytes: v.evidenceBytes,
    evidenceSha256: v.evidenceSha256,
    evidenceUploadedAt: iso(v.evidenceUploadedAt),
    evidencePurgedAt: iso(v.evidencePurgedAt),
    evidenceNote: v.evidenceNote,
    decidedAt: iso(v.decidedAt),
    decisionNote: v.decisionNote,
    expiresAt: iso(v.expiresAt),
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
    requires: { ...requires },
    // E3.7
    providerLabel: providerLabelOf(v.provider),
    providerRef: v.providerRef,
    vendorStatus: v.vendorStatus,
    vendorError: v.vendorError,
    vendorCheckedAt: iso(v.vendorCheckedAt),
    decidedByProvider: v.decidedByProvider,
    reverificationOf: v.reverificationOf,
    nextCheckAt: iso(v.nextCheckAt),
  };
}

export const taskBody = (t: ClosingTaskRecord) => ({
  id: t.id,
  title: t.title,
  done: t.doneAt !== null,
  doneAt: iso(t.doneAt),
  position: t.position,
});

const disclaimerBody = (d: ResolvedDisclaimer) => ({
  stamp: `${d.slug}:v${d.versionNo}`,
  slug: d.slug,
  title: d.title,
  versionNo: d.versionNo,
  body: d.body,
  effectiveAt: d.effectiveAt.toISOString(),
});

/** The binary shape for the OpenAPI document (the SDK treats it as a blob). */
const evidenceResponse = (description: string) => ({
  description,
  content: {
    "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
  },
});

const csvResponse = (description: string) => ({
  description,
  content: { "text/csv": { schema: z.string() } },
});

export function registerRoundRoutes(api: ModuleRouter, services: ModuleServices): void {
  // Built on first use: nothing may be constructed at registration time.
  let rounds: RoundService | undefined;
  let terms: TermsService | undefined;
  let interest: InterestService | undefined;
  let commitments: CommitmentService | undefined;
  let verifications: VerificationService | undefined;
  const roundSvc = () => (rounds ??= createRoundService(services));
  const termsSvc = () => (terms ??= createTermsService(services));
  const interestSvc = () => (interest ??= createInterestService(services));
  const commitmentSvc = () => (commitments ??= createCommitmentService(services));
  const verificationSvc = () => (verifications ??= createVerificationService(services));
  let vendorVerifications: VendorVerificationService | undefined;
  const vendorSvc = () => (vendorVerifications ??= createVendorVerificationService(services));
  const perm = (p: string, fresh = false) => services.guards.requirePermission(p, { fresh });
  /** An `apiKey: true` matrix row (E3.4): a workspace API key holding `p` may call it too. */
  const keyPerm = (p: string) => services.guards.requirePermission(p, { apiKey: true });
  const member = () => services.guards.requireMember();

  // --- the investor's round page ----------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/current",
      tags: TAGS,
      summary: "The round an investor is being shown",
      description:
        "The open round, or the most recently closed one — a round that closed last week is still the thing an investor came to read about. `member`, not a permission: an external holds none. Viewing this stamps `first_exposure_at` the first time (506(b) relationship evidence) and records a throttled `round.terms_viewed` audit row naming the revision, the disclaimer stamp and the offering status. `progress` is `null` when the workspace has turned the investor progress bar off; staff always see it.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: { 200: jsonResponse(s.InvestorRoundSchema, "The round"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      refuseNarrowDelegate(sg.membership);
      const view = await roundSvc().investorView({
        ctx: sg.tenant,
        membershipId: sg.membership.id,
        isStaff: sg.membership.kind === "staff",
        offeringStatus: sg.workspace.offeringStatus,
        sessionId: sg.session?.sessionId,
        requestId: requestIdOf(c),
      });
      return c.json(
        {
          round: view.round === undefined ? null : roundBody(view.round),
          terms:
            view.terms === undefined || view.round === undefined
              ? null
              : termsBody(view.terms, view.round.currency),
          disclaimer: view.disclaimer === undefined ? null : disclaimerBody(view.disclaimer),
          progress: view.progress === undefined ? null : { ...view.progress },
          calculatorDefaults: { ...view.calculatorDefaults },
          mySubmissions: view.mySubmissions.map(submissionBody),
          eligibilityHint:
            view.eligibilityHint === undefined
              ? null
              : {
                  ...view.eligibilityHint,
                  threshold: view.eligibilityHint.threshold ?? null,
                  accreditedUntil: null,
                  questionnaireVersion: 1,
                  offeringStatus: sg.workspace.offeringStatus,
                  subject: "individual" as const,
                  amount: view.calculatorDefaults.amount,
                  currency: view.calculatorDefaults.currency,
                },
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/current/calculate",
      tags: TAGS,
      summary: "What an amount buys, on the current terms",
      description:
        "The same pure function the browser runs (`@fundroom/round-terms`), served so a client that would rather not compute can ask. It is **arithmetic, not advice**: every result carries the assumptions it made and the last one always says so.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { query: s.CalculateQuery },
      responses: { 200: jsonResponse(s.RoundCalculationSchema, "Estimate"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      refuseNarrowDelegate(sg.membership);
      const q = c.req.valid("query");
      const current = await roundSvc().currentTerms(sg.tenant);
      if (current === undefined) throw new ApiError("not_found", "no round to calculate against");
      const result = calculate({
        terms: current.terms,
        amount: q.amount,
        roundTarget: current.round.targetAmount,
      });
      return c.json(
        {
          kind: result.kind,
          currency: current.round.currency,
          amount: q.amount,
          ownershipPercentLow: result.ownershipPercentLow ?? null,
          ownershipPercentHigh: result.ownershipPercentHigh ?? null,
          effectiveValuation: result.effectiveValuation ?? null,
          sharesEstimate: result.sharesEstimate ?? null,
          explanation: [...result.explanation],
          assumptions: [...result.assumptions],
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/current/eligibility",
      tags: TAGS,
      summary: "Which accreditation path this amount takes",
      description:
        "Computed **server-side** from the offering status, the subject, the amount and the round's currency. The browser runs the same pure function so the form's copy can change as somebody types, but it never decides: the answer stored on a submission is this one. `accredited` says whether the kernel already holds a live `accredited` attestation for this member, in which case no verification is opened.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { query: s.EligibilityQuery },
      responses: { 200: jsonResponse(s.RoundEligibilitySchema, "Eligibility"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      refuseNarrowDelegate(sg.membership);
      const q = c.req.valid("query");
      const current = await roundSvc().currentTerms(sg.tenant);
      const currency = current?.round.currency ?? "USD";
      let decided: ReturnType<typeof eligibility>;
      try {
        decided = eligibility({
          offeringStatus: sg.workspace.offeringStatus,
          subject: q.subject,
          amount: q.amount,
          currency,
        });
      } catch {
        // Unreachable: `disabledWhen` answers 404 for `none` and `informational`.
        throw new ApiError("conflict", "this workspace is not offering securities");
      }
      const accreditation = await services.db.withTenant(sg.tenant, (tx) =>
        services.legal.accreditation(tx, sg.tenant, sg.membership.id),
      );
      return c.json(
        {
          path: decided.path,
          questionnaire: decided.questionnaire,
          thresholdMet: decided.thresholdMet,
          threshold: decided.threshold === undefined ? null : { ...decided.threshold },
          reason: decided.reason,
          accredited: accreditation.accredited,
          accreditedUntil: iso(accreditation.expiresAt),
          questionnaireVersion: 1,
          offeringStatus: sg.workspace.offeringStatus,
          subject: q.subject,
          amount: q.amount,
          currency,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/current/interest",
      tags: TAGS,
      summary: "Indicate interest in the open round",
      description:
        "Not an order and not a commitment: nothing here takes money, and there are no payment instructions until an admin accepts. Rate-limited to five an hour per member. When the computed path asks for the questionnaire and answers are sent, they are recorded through the kernel's acceptance service — the click-wrap row and the dated `accredited` row — and the stamp is stored on the submission. Under 506(c) below the minimum-investment safe harbour, a verification is opened unless the member is already accredited.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { body: jsonBody(s.InterestBody) },
      responses: { 201: jsonResponse(s.InterestSubmissionSchema, "Submitted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      refuseDelegateWrite(sg.membership);
      const body = c.req.valid("json");
      try {
        const result = await interestSvc().submit({
          ctx: sg.tenant,
          membershipId: sg.membership.id,
          offeringStatus: sg.workspace.offeringStatus,
          amount: body.amount,
          subject: body.subject,
          ...(body.entityName === undefined ? {} : { entityName: body.entityName }),
          ...(body.note === undefined ? {} : { note: body.note }),
          ...(body.accreditation === undefined ? {} : { accreditation: body.accreditation }),
          ...(body.consent === undefined ? {} : { consent: body.consent }),
          actor: actorOf(c, sg),
        });
        return c.json(submissionBody(result.submission), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/current/interest",
      tags: TAGS,
      summary: "My interest submissions",
      description:
        "Every submission this member has made, across every round — RLS is what limits it to their own, so a staff caller sees only their own too.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: { 200: jsonResponse(s.MyInterestListSchema, "Submissions"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      refuseNarrowDelegate(sg.membership);
      const mine = await interestSvc().mine(sg.tenant, sg.membership.id);
      return c.json({ submissions: mine.map(submissionBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/current/interest/{id}/withdraw",
      tags: TAGS,
      summary: "Withdraw my submission",
      description:
        "Only while it is still open. A withdrawn submission stays on the record with its stamps: what somebody said and then unsaid is a fact worth keeping.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(s.InterestSubmissionSchema, "Withdrawn"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      refuseDelegateWrite(sg.membership);
      try {
        const updated = await interestSvc().withdraw(
          sg.tenant,
          c.req.valid("param").id,
          sg.membership.id,
          actorOf(c, sg),
        );
        return c.json(submissionBody(updated), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  /*
   * The evidence upload is served by `src/raw-routes.ts`, which is mounted in front of the
   * OpenAPI app's 1 MiB JSON body limit — a scan of a brokerage statement is routinely larger.
   * It is declared here so the route is in the contract and in the authz matrix, and its handler
   * calls the same function, so the two cannot drift.
   */
  api.openapi(
    createRoute({
      method: "put",
      path: "/verifications/{id}/evidence",
      tags: TAGS,
      summary: "Upload my accreditation evidence",
      description:
        "Raw bytes, `Content-Type` one of `application/pdf`, `image/png`, `image/jpeg`, up to 10 MiB (or the deployment's upload limit, whichever is smaller). Owner only, and every other refusal is a 404 rather than a 403: an id belonging to somebody else must not be distinguishable from one that does not exist. The file is virus-scanned, then envelope-encrypted under the workspace key before it is written, and deleted by the nightly purge once the decision is old enough.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: {
        params: s.RoundIdParams,
        body: {
          required: true,
          description: "The evidence file, as raw bytes",
          content: Object.fromEntries(
            EVIDENCE_CONTENT_TYPES.map((type) => [
              type,
              { schema: z.string().openapi({ format: "binary" }) },
            ]),
          ),
        },
      },
      responses: {
        200: jsonResponse(s.RoundVerificationSchema.partial(), "Stored"),
        ...ERRORS,
      },
    }),
    // Not normally reached: the raw mount is routed first and wins. Delegating rather than
    // duplicating is what keeps the documented behaviour and the served behaviour identical.
    async (c) => (await handleEvidenceUpload(c, services)) as never,
  );

  // --- rounds -----------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/rounds",
      tags: TAGS,
      summary: "Every round this workspace has run",
      description: "Newest first. Rounds are history: nothing here is ever deleted once it opened.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_READ}+apikey`,
      middleware: [keyPerm(PERM_READ)] as const,
      responses: { 200: jsonResponse(s.RoundListSchema, "Rounds"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const list = await roundSvc().list(sg.tenant);
      return c.json({ rounds: list.map(roundBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/rounds",
      tags: TAGS,
      summary: "Plan a round",
      description:
        "Created in `planning`, which is invisible to investors: a draft target is not an offer. Write the terms, then open it.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.CreateRoundBody) },
      responses: { 201: jsonResponse(s.RoundSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const created = await roundSvc().create(
          sg.tenant,
          {
            name: body.name,
            stage: body.stage,
            instrumentKind: body.instrumentKind,
            targetAmount: body.targetAmount,
            currency: body.currency,
            ...(body.minimumInvestment === undefined
              ? {}
              : { minimumInvestment: body.minimumInvestment }),
            ...(body.opensAt === undefined
              ? {}
              : { opensAt: body.opensAt === null ? null : new Date(body.opensAt) }),
            ...(body.closesAt === undefined
              ? {}
              : { closesAt: body.closesAt === null ? null : new Date(body.closesAt) }),
            ...(body.showProgress === undefined ? {} : { showProgress: body.showProgress }),
            ...(body.summary === undefined ? {} : { summary: body.summary }),
          },
          actorOf(c, sg),
        );
        return c.json(roundBody(created), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/rounds/{id}",
      tags: TAGS,
      summary: "One round: terms, history, allocation and counters",
      description:
        "`counters.nonAccreditedAccepted` against `counters.limit` is Rule 506(b)'s 35 non-accredited purchasers — a warning the admin screen badges, never a block.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(s.RoundDetailSchema, "Round"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const detail = await roundSvc().get(sg.tenant, c.req.valid("param").id);
        return c.json(
          {
            round: roundBody(detail.round),
            terms:
              detail.terms === undefined ? null : termsBody(detail.terms, detail.round.currency),
            history: detail.history.map((t) => termsBody(t, detail.round.currency)),
            allocation: allocationBody(detail.allocation),
            counters: { ...detail.counters },
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/rounds/{id}",
      tags: TAGS,
      summary: "Change a round's name, target, minimum or window",
      description:
        "`status` is not patchable: opening and closing are their own routes because both publish an event and both need step-up.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.RoundIdParams, body: jsonBody(s.PatchRoundBody) },
      responses: { 200: jsonResponse(s.RoundSchema, "Round"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const updated = await roundSvc().patch(
          sg.tenant,
          c.req.valid("param").id,
          {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.stage === undefined ? {} : { stage: body.stage }),
            ...(body.instrumentKind === undefined ? {} : { instrumentKind: body.instrumentKind }),
            ...(body.targetAmount === undefined ? {} : { targetAmount: body.targetAmount }),
            ...(body.currency === undefined ? {} : { currency: body.currency }),
            ...(body.minimumInvestment === undefined
              ? {}
              : { minimumInvestment: body.minimumInvestment }),
            ...(body.opensAt === undefined
              ? {}
              : { opensAt: body.opensAt === null ? null : new Date(body.opensAt) }),
            ...(body.closesAt === undefined
              ? {}
              : { closesAt: body.closesAt === null ? null : new Date(body.closesAt) }),
            ...(body.showProgress === undefined ? {} : { showProgress: body.showProgress }),
            ...(body.summary === undefined ? {} : { summary: body.summary }),
          },
          actorOf(c, sg),
        );
        return c.json(roundBody(updated), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/rounds/{id}",
      tags: TAGS,
      summary: "Remove a planning round nobody has touched",
      description:
        "Refused once a round has been open, and refused while it has commitments or submissions: those are the record of an offering and have to survive. This exists for the round somebody created by mistake.",
      security: sessionSecurity,
      "x-requires": `${PERM_MANAGE}+fresh`,
      middleware: [perm(PERM_MANAGE, true)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await roundSvc().remove(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/rounds/{id}/open",
      tags: TAGS,
      summary: "Open the round for interest",
      description:
        "Refused without terms — an open round with nothing to read is an invitation to indicate interest in something undisclosed — and refused while another round is open. Step-up, because this is the moment the company starts offering securities.",
      security: sessionSecurity,
      "x-requires": `${PERM_PUBLISH}+fresh`,
      middleware: [perm(PERM_PUBLISH, true)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(s.RoundSchema, "Opened"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const opened = await roundSvc().open(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json(roundBody(opened), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/rounds/{id}/close",
      tags: TAGS,
      summary: "Close the round",
      description:
        "Terms and commitments stay readable as history; the investor page keeps showing the round until another one opens.",
      security: sessionSecurity,
      "x-requires": `${PERM_PUBLISH}+fresh`,
      middleware: [perm(PERM_PUBLISH, true)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(s.RoundSchema, "Closed"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const closed = await roundSvc().close(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json(roundBody(closed), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- terms ------------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "put",
      path: "/rounds/{id}/terms",
      tags: TAGS,
      summary: "Write a new terms revision",
      description:
        "Append-only: this inserts revision n + 1 and supersedes the previous one, stamped with the disclaimer version in force right now. The body is parsed against the round's own instrument, so a note body on a SAFE round is a field error rather than a row that disagrees with its own column.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.RoundIdParams, body: jsonBody(s.PutTermsBody) },
      responses: { 201: jsonResponse(s.RoundTermsRevisionSchema, "Written"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const written = await termsSvc().put(
          sg.tenant,
          c.req.valid("param").id,
          {
            terms: body.terms,
            ...(body.asOf === undefined ? {} : { asOf: new Date(body.asOf) }),
          },
          actorOf(c, sg),
        );
        const round = await roundSvc().get(sg.tenant, c.req.valid("param").id);
        return c.json(termsBody(written, round.round.currency), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/rounds/{id}/terms",
      tags: TAGS,
      summary: "Every terms revision, newest first",
      description:
        "The append-only change history of the terms. The live revision is the one whose `supersededBy` is `null`.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(s.RoundTermsListSchema, "History"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const id = c.req.valid("param").id;
        const detail = await roundSvc().get(sg.tenant, id);
        const history = await termsSvc().history(sg.tenant, id);
        return c.json({ terms: history.map((t) => termsBody(t, detail.round.currency)) }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- allocation, commitments and the export ---------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/rounds/{id}/allocation",
      tags: TAGS,
      summary: "How much of the round is spoken for",
      description:
        "The one roll-up: the admin tracker, the investor progress bar and the CRM reconciliation panel all read these buckets. Withdrawn commitments are excluded; `total` is never capped, so an oversubscribed round reads as one.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(s.RoundAllocationViewSchema, "Allocation"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        /*
         * The rows come back beside the buckets because the CRM pipeline board joins its items
         * to commitments **by id, on the client** (E2.5 D2): `pipeline_item.amount` is a
         * forecast and the committed figure is this one, so a board that could see the totals
         * but not the rows could not reconcile a single card. Only the linking fields and the
         * money travel — notes and provenance stay on `GET /round/rounds/{id}/commitments`.
         */
        const view = await commitmentSvc().list(sg.tenant, c.req.valid("param").id);
        return c.json(
          {
            ...allocationBody(view.allocation),
            commitments: view.commitments.map((x) => ({
              id: x.id,
              amount: x.amount,
              currency: view.round.currency,
              status: x.status,
              membershipId: x.membershipId,
              contactId: x.contactId,
              organizationId: x.organizationId,
              displayName: x.displayName,
            })),
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/rounds/{id}/export.csv",
      tags: TAGS,
      summary: "The commitments, as a CSV",
      description:
        "Columns `id,name,status,amount,currency,created_at,wired_at`, frozen. Withdrawn rows are included — the export is the record, not the tracker. Step-up and audited: The round export is the textbook case for step-up.",
      security: sessionSecurity,
      "x-requires": `${PERM_PUBLISH}+fresh`,
      middleware: [perm(PERM_PUBLISH, true)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: csvResponse("The commitments"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const id = c.req.valid("param").id;
      try {
        const view = await commitmentSvc().list(sg.tenant, id);
        const names = await services.db.withTenant(sg.tenant, (tx) =>
          new MembershipRepo(sg.tenant, tx).namesFor(
            view.commitments.flatMap((x) => (x.membershipId === null ? [] : [x.membershipId])),
          ),
        );
        const csv = commitmentsCsv(
          view.round,
          view.commitments,
          new Map([...names].map(([k, v]) => [k, v.displayName])),
        );
        await services.db.withTenant(sg.tenant, (tx) =>
          services.audit.record(tx, sg.tenant, {
            action: "round.commitments_exported",
            resourceKind: "round",
            resourceId: id,
            actorMembershipId: sg.membership.id,
            requestId: requestIdOf(c),
            sessionId: sg.session?.sessionId,
            meta: { rows: view.commitments.length, currency: view.round.currency },
          }),
        );
        return c.body(csv, 200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${csvFilename(view.round)}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        }) as never;
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/rounds/{id}/commitments",
      tags: TAGS,
      summary: "The commitments against a round",
      description:
        "Staff only — externals have no RLS path to this table at all, because what another investor put in is not their business.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_READ}+apikey`,
      middleware: [keyPerm(PERM_READ)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(s.RoundCommitmentListSchema, "Commitments"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const view = await commitmentSvc().list(sg.tenant, c.req.valid("param").id);
        return c.json(
          {
            commitments: view.commitments.map((x) => commitmentBody(x, view.round.currency)),
            allocation: allocationBody(view.allocation),
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/rounds/{id}/commitments",
      tags: TAGS,
      summary: "Record a commitment",
      description:
        "A commitment names a member, a CRM contact, an organisation or simply a name — the angel who signed on paper has no portal identity and still has to be counted.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.RoundIdParams, body: jsonBody(s.CreateCommitmentBody) },
      responses: { 201: jsonResponse(s.RoundCommitmentSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      const id = c.req.valid("param").id;
      try {
        const created = await commitmentSvc().create(sg.tenant, id, body, actorOf(c, sg));
        const view = await commitmentSvc().list(sg.tenant, id);
        return c.json(commitmentBody(created, view.round.currency), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/commitments/{id}",
      tags: TAGS,
      summary: "Move a commitment's amount, status or note",
      description:
        "`withdrawn` is a status like any other: the row stays for the audit trail and stops counting towards every bucket.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.RoundIdParams, body: jsonBody(s.PatchCommitmentBody) },
      responses: { 200: jsonResponse(s.RoundCommitmentSchema, "Commitment"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const updated = await commitmentSvc().patch(
          sg.tenant,
          c.req.valid("param").id,
          body,
          actorOf(c, sg),
        );
        const view = await commitmentSvc().list(sg.tenant, updated.roundId);
        return c.json(commitmentBody(updated, view.round.currency), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- the interest queue -----------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/rounds/{id}/interest",
      tags: TAGS,
      summary: "The interest queue for a round",
      description:
        "`accreditationPath` and `nonAccredited` are the two badges the queue is read for: the first says what the rules asked of this investor, the second is what Rule 506(b)'s 35 counts.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_READ}+apikey`,
      middleware: [keyPerm(PERM_READ)] as const,
      request: { params: s.RoundIdParams, query: s.InterestQuery },
      responses: { 200: jsonResponse(s.InterestSubmissionListSchema, "Submissions"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const q = c.req.valid("query");
      try {
        const rows = await interestSvc().listForRound(sg.tenant, c.req.valid("param").id, q.status);
        return c.json(
          {
            submissions: rows.map((r) => ({
              ...submissionBody(r),
              displayName: r.displayName,
              email: r.email,
            })),
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/interest/{id}/accept",
      tags: TAGS,
      summary: "Accept a submission and record the commitment",
      description:
        "Under 506(c) this is refused unless the kernel holds a live `accredited` attestation for the investor, or the submission took the minimum-investment safe-harbour path and carries the written representations that go with it. `warnings` carries `non_accredited_limit` once 35 non-accredited purchasers have been accepted — a warning, never a block.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.RoundIdParams, body: jsonBody(s.AcceptInterestBody) },
      responses: { 200: jsonResponse(s.InterestDecisionSchema, "Accepted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const result = await interestSvc().accept(
          sg.tenant,
          c.req.valid("param").id,
          body,
          sg.workspace.offeringStatus,
          actorOf(c, sg),
        );
        return c.json(
          {
            submission: submissionBody(result.submission),
            commitment:
              result.commitment === undefined
                ? null
                : commitmentBody(result.commitment, result.submission.currency),
            warnings: [...result.warnings],
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/interest/{id}/decline",
      tags: TAGS,
      summary: "Decline a submission",
      description: "The row stays with its stamps; `crm` moves the pipeline card to `passed`.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.RoundIdParams, body: jsonBody(s.DeclineInterestBody) },
      responses: { 200: jsonResponse(s.InterestDecisionSchema, "Declined"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const result = await interestSvc().decline(
          sg.tenant,
          c.req.valid("param").id,
          body,
          actorOf(c, sg),
        );
        return c.json(
          {
            submission: submissionBody(result.submission),
            commitment: null,
            warnings: [...result.warnings],
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- verifications ----------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/verifications",
      tags: TAGS,
      summary: "The accreditation verification queue",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { query: s.VerificationQuery },
      responses: { 200: jsonResponse(s.RoundVerificationListSchema, "Verifications"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const q = c.req.valid("query");
      const rows = await verificationSvc().list(sg.tenant, q.status);
      return c.json(
        {
          verifications: rows.map((r) => ({
            ...verificationBody(r, requiresOf(r.provider)),
            displayName: r.displayName,
            email: r.email,
          })),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/verifications/{id}",
      tags: TAGS,
      summary: "One verification",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(s.RoundVerificationRowSchema, "Verification"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const row = await verificationSvc().get(sg.tenant, c.req.valid("param").id);
        return c.json(
          {
            ...verificationBody(row, requiresOf(row.provider)),
            displayName: row.displayName,
            email: row.email,
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/verifications/{id}/evidence",
      tags: TAGS,
      summary: "Read the uploaded evidence",
      description:
        "Decrypted on the way out, never cached, and audited with the sha256 rather than with anything that names the document. A 404 once the nightly purge has removed the file: the decision and its method survive, the file does not.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: evidenceResponse("The evidence"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const evidence = await verificationSvc().readEvidence(
          sg.tenant,
          c.req.valid("param").id,
          actorOf(c, sg),
        );
        return c.body(evidence.bytes as unknown as ArrayBuffer, 200, {
          "Content-Type": evidence.contentType,
          "Content-Length": String(evidence.bytes.byteLength),
          "Content-Disposition": "attachment",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        }) as never;
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/verifications/{id}/decide",
      tags: TAGS,
      summary: "Settle a verification",
      description:
        "`verified` needs a method and the evidence that method implies: a file for `document_review` and `professional_letter`, a note for `third_party` and `minimum_investment`. It writes the kernel's `accredited` attestation through the legal seam, expiring in 90 days for a professional letter and twelve months otherwise.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.RoundIdParams, body: jsonBody(s.DecideVerificationBody) },
      responses: { 200: jsonResponse(s.RoundVerificationSchema, "Decided"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const decided = await verificationSvc().decide(
          sg.tenant,
          c.req.valid("param").id,
          {
            status: body.status,
            ...(body.method === undefined ? {} : { method: body.method }),
            ...(body.note === undefined ? {} : { note: body.note }),
            ...(body.expiresAt === undefined ? {} : { expiresAt: new Date(body.expiresAt) }),
          },
          actorOf(c, sg),
        );
        return c.json(verificationBody(decided, requiresOf(decided.provider)), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- closing tasks ----------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/rounds/{id}/closing-tasks",
      tags: TAGS,
      summary: "The closing checklist",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(s.RoundClosingTaskListSchema, "Tasks"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const tasks = await roundSvc().closingTasks(sg.tenant, c.req.valid("param").id);
        return c.json({ tasks: tasks.map(taskBody) }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/rounds/{id}/closing-tasks",
      tags: TAGS,
      summary: "Replace the closing checklist",
      description:
        "`PUT` because the screen edits the list as a list. Items carrying an `id` keep their row (and the instant they were first ticked); items without one are new; items left out are gone.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.RoundIdParams, body: jsonBody(s.PutClosingTasksBody) },
      responses: { 200: jsonResponse(s.RoundClosingTaskListSchema, "Tasks"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const tasks = await roundSvc().replaceClosingTasks(
          sg.tenant,
          c.req.valid("param").id,
          body.tasks,
          actorOf(c, sg),
        );
        return c.json({ tasks: tasks.map(taskBody) }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- settings ---------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/settings",
      tags: TAGS,
      summary: "Evidence retention, the default currency and the closing template",
      description:
        "What is *not* here is the point: the target, the currency, the minimum and the progress bar all live on the round itself, because a workspace can run a bridge in EUR after a seed in USD. `closing` is the subscription agreement: the e-sign vendor's template reference, the template's signer role the investor fills (`templateRole`, default `Signer`; DocuSign and multi-role DocuSeal templates match the signer by it) and which fact fills each of its fields.",
      security: sessionSecurity,
      "x-requires": PERM_SETTINGS,
      middleware: [perm(PERM_SETTINGS)] as const,
      responses: { 200: jsonResponse(s.RoundSettingsSchema, "Settings"), ...ERRORS },
    }),
    (c) => c.json(parseWorkspaceSettings(signed(c).workspace.settings).round, 200),
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/settings",
      tags: TAGS,
      summary: "Change the round settings",
      description:
        "Shortening `evidenceRetentionDays` takes effect on the next nightly purge, which then deletes everything already past the new window.",
      security: sessionSecurity,
      "x-requires": `${PERM_SETTINGS}+fresh`,
      middleware: [perm(PERM_SETTINGS, true)] as const,
      request: { body: jsonBody(s.RoundSettingsPatchBody) },
      responses: { 200: jsonResponse(s.RoundSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const patch = c.req.valid("json");
      const next = await services.db.withTenant(sg.tenant, async (tx) => {
        // The `round` block alone, merged on the row-locked copy (A-3 R2 M1): never the request's
        // cached settings, never the whole document — a concurrent writer of another block keeps
        // its change. Row lock first, audit last (E3.5 LX).
        const current = parseWorkspaceSettings(
          (await lockWorkspaceFacts(tx, sg.workspace.id))?.settings,
        );
        // `closing` merges field by field: a PATCH naming only the template keeps the prefill map.
        const { closing, reverification, ...rest } = patch;
        const next = WorkspaceSettingsSchema.parse({
          ...current,
          round: {
            ...current.round,
            ...rest,
            closing: {
              ...current.round.closing,
              ...(closing?.subscriptionTemplateRef === undefined
                ? {}
                : { subscriptionTemplateRef: closing.subscriptionTemplateRef }),
              ...(closing?.templateRole === undefined
                ? {}
                : { templateRole: closing.templateRole }),
              ...(closing?.prefill === undefined ? {} : { prefill: closing.prefill }),
            },
            // E3.7: merged field by field too.
            reverification: {
              ...current.round.reverification,
              ...(reverification?.reminderDays === undefined
                ? {}
                : { reminderDays: reverification.reminderDays }),
              ...(reverification?.autoStart === undefined
                ? {}
                : { autoStart: reverification.autoStart }),
            },
          },
        });
        await updateWorkspaceSettingsBlock(tx, sg.workspace.id, "round", next.round);
        await services.audit.record(tx, sg.tenant, {
          action: "round.settings_changed",
          resourceKind: "workspace",
          resourceId: sg.workspace.id,
          actorMembershipId: sg.membership.id,
          requestId: requestIdOf(c),
          meta: {
            fields: [
              ...Object.keys(rest),
              ...Object.keys(closing ?? {}).map((k) => `closing.${k}`),
              ...Object.keys(reverification ?? {}).map((k) => `reverification.${k}`),
            ],
          },
        });
        return next;
      });
      services.workspaces.invalidate(sg.workspace.id);
      return c.json(next.round, 200);
    },
  );

  // --- accreditation vendor verification (E3.7, ADR-0055) ----------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/current/verification",
      tags: TAGS,
      summary: "My latest accreditation verification",
      description:
        "The caller's most recent verification (any round), with how to continue it: `handoff` is `upload` for manual review, `invite_sent` when the vendor emailed an invitation, `widget` (a link to the handoff page) for an embedded vendor flow. `canRenew` says whether a (re)verification may be started now. `verification: null` when there is none.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: { 200: jsonResponse(s.MyVerificationResponseSchema, "Verification"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      refuseNarrowDelegate(sg.membership);
      const reminderDays = parseWorkspaceSettings(sg.workspace.settings).round.reverification
        .reminderDays;
      const mine = await vendorSvc().current(sg.tenant, sg.membership.id, reminderDays);
      return c.json(
        {
          verification:
            mine.latest === undefined
              ? null
              : myVerificationBody(mine.latest, mine.canRenew, ACCREDITATION_HANDOFF_PATH),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/current/verification",
      tags: TAGS,
      summary: "Start (or renew) my accreditation verification",
      description:
        "Opens a verification with the workspace's provider (its accreditation vendor when connected, manual review otherwise). A vendor start runs after the answer (the vendor is never called inside the request's transaction), so `handoff` may be `null` at first — poll `GET /round/current/verification`. 409 `conflict` (`reason: verification_pending`, the pending verification in `details.verification`) when one is already pending. Rate-limited to five an hour per member.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { body: jsonBody(s.StartVerificationBody) },
      responses: { 201: jsonResponse(s.MyVerificationSchema, "Started"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      refuseDelegateWrite(sg.membership);
      const body = c.req.valid("json");
      const reminderDays = parseWorkspaceSettings(sg.workspace.settings).round.reverification
        .reminderDays;
      try {
        const result = await vendorSvc().startForMember({
          ctx: sg.tenant,
          membershipId: sg.membership.id,
          subject: body.subject,
          reminderDays,
          actor: actorOf(c, sg),
        });
        if (result.kind === "pending") {
          throw new ApiError("conflict", "you already have a verification in progress", {
            reason: "verification_pending",
            verification: myVerificationBody(
              result.verification,
              false,
              ACCREDITATION_HANDOFF_PATH,
            ),
          });
        }
        return c.json(
          myVerificationBody(result.verification, false, ACCREDITATION_HANDOFF_PATH),
          201,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/current/verification/handoff",
      tags: TAGS,
      summary: "Continue my verification with the vendor (HTML)",
      description:
        "An HTML page that embeds the accreditation vendor's JS SDK (Parallel Markets) for the caller's latest pending verification. Its own Content-Security-Policy, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. 404 unless the latest pending verification has a widget handoff. Also the vendor's registered redirect URI.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: {
        200: {
          description: "The handoff page",
          content: { "text/html": { schema: z.string() } },
        },
        ...ERRORS,
      },
    }),
    async (c) => {
      const sg = signed(c);
      refuseNarrowDelegate(sg.membership);
      const found = await vendorSvc().widgetHandoff(sg.tenant, sg.membership.id);
      if (found === undefined) throw new ApiError("not_found", "nothing to continue here");
      const nonce = randomBytes(16).toString("base64");
      const html = handoffPage({
        nonce,
        handoff: found.handoff,
        portalUrl: services.workspaceUrl(sg.workspace, "/round").href,
        providerLabel: labelOf(found.row.provider),
      });
      /*
       * The page's own CSP (contract §5), not the API's `default-src 'none'`: it runs the
       * vendor's SDK from its origin and nothing else, inline code only under this response's
       * nonce. The global security-header middleware keeps a CSP an API handler set itself.
       */
      return c.body(html, 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": handoffCsp(nonce),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      }) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/verifications/{id}/check",
      tags: TAGS,
      summary: "Re-check a verification with its vendor",
      description:
        "Queues a sync of a pending vendor verification (202). 409 `conflict` when the verification is not a vendor one or is no longer pending.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.RoundIdParams },
      responses: { 202: jsonResponse(s.VerificationCheckQueuedSchema, "Queued"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await vendorSvc().requestCheck(sg.tenant, c.req.valid("param").id);
        return c.json({ queued: true as const }, 202);
      } catch (error) {
        rethrow(error);
      }
    },
  );
}
