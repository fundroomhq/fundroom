import { defineModule, type ModuleManifest } from "@fundroom/module-kit";
import {
  onAccreditationProviderUpdated,
  onDocumentVaulted,
  onEnvelopeChanged,
  onEnvelopeCompleted,
} from "./closing/handlers.js";
import { registerRoundClosingRoutes } from "./closing-routes.js";
import { roundDsar } from "./dsar.js";
import { createErasureHandler } from "./erasure.js";
import { createRoundSummaryHydrator } from "./hydrator.js";
import { createRoundJobs } from "./jobs.js";
import { ROUND_DISABLED_WHEN } from "./model.js";
import { roundPortability } from "./portability.js";
import { registerRoundRawRoutes } from "./raw-routes.js";
import { registerRoundRoutes } from "./routes.js";
import { captureRoundServices, roundServices } from "./service/slot.js";

/*
 * The round (E2.5, EXECUTION_PLAN §15 and :336, design/03 §49 and §83, design/06 §219-221,
 * ADR-0024, ADR-0043): the raise a company is running — its instrument and terms, the form an
 * investor uses to say they are interested, the accreditation step 506(c) requires, the
 * commitments that are the record of the money, and the checklist for closing it.
 *
 * `dependsOn` names `content` as well as `access` because the module registers the
 * `round_summary` block hydrator, which only means something when there is a page to put it on.
 *
 * **`defaultEnabled: false`** — design/03 §157 lists Round among the modules that are off until
 * a workspace switches them on. A company using the portal to keep existing investors informed
 * between raises should not carry the tables, and an "Indicate interest" item in the nav of a
 * workspace that is not raising is worse than absent.
 *
 * **`offeringStatusRules.disabledWhen`** is the sharper gate and the reason this module exists
 * in E2.5 rather than earlier. `none` means nothing is being offered and `informational` means
 * the company may describe itself and must not solicit; in both, `permits(status).roundAndTerms`
 * is false, and a round module reachable in either would be a compliance control with an off
 * switch. It applies to **staff too** (ADR-0037 §3): every route 404s, the bootstrap reports the
 * module off, and its nav slots are not emitted.
 */

export const roundModule: ModuleManifest = defineModule({
  id: "round",
  version: "0.1.0",
  dsar: roundDsar,
  portability: roundPortability,
  dependsOn: ["access", "content"],
  schema: "round",
  migrations: new URL("../migrations/", import.meta.url),
  defaultEnabled: false,
  offeringStatusRules: { disabledWhen: [...ROUND_DISABLED_WHEN] },
  permissions: ["round.read", "round.manage", "round.publish", "round.settings"],
  routes: (api, services) => {
    captureRoundServices(services);
    registerRoundRoutes(api, services);
    // E3.5 closing workflow: signature requests, confirmation, the derived checklist.
    registerRoundClosingRoutes(api, services);
  },
  // The evidence upload, in front of the OpenAPI mount's 1 MiB JSON body limit.
  rawRoutes: registerRoundRawRoutes,
  jobs: (services) => {
    captureRoundServices(services);
    return createRoundJobs(services);
  },
  /*
   * Every payload is ids — an interest submission carries an *amount*, and putting the figure on
   * the outbox would publish the size of a private commitment to every subscriber, including ones
   * written later. `crm` listens without ever reading a `round.*` table (D1).
   *
   * E3.5: the module now also *handles* three events, all about its own subjects — the kernel's
   * e-sign envelope changes for `round/commitment/<id>` subjects (mirrored onto
   * `round.signature_request`; a completed one moves the commitment to `signed`) and the data
   * room's `document.vaulted` (links the signed copy). Each handler is idempotent under outbox
   * redelivery and takes the request row lock before the commitment row.
   */
  events: {
    handles: {
      "esign.envelope_changed": onEnvelopeChanged,
      "esign.envelope_completed": onEnvelopeCompleted,
      "document.vaulted": onDocumentVaulted,
      // E3.7: a vendor callback woke these provider refs up (the handler enqueues syncs).
      "accreditation.provider_updated": onAccreditationProviderUpdated,
      // E3.7: the vendor handoff (email and name) goes; the verification record stays.
      "member.erasure_requested": createErasureHandler(roundServices),
    },
    emits: [
      "round.opened",
      "round.closed",
      "round.terms_changed",
      "round.interest_submitted",
      "round.interest_decided",
      "round.commitment_created",
      "round.commitment_changed",
      "round.verification_requested",
      "round.verification_decided",
      "round.signature_completed",
      "round.commitment_confirmed",
      "round.verification_expiring",
    ],
  },
  // E3.4: outbound webhook topics (ids-only payloads, as on the outbox). E3.5 adds the two
  // closing milestones an integration reconciles against (a cap-table tool, a CRM).
  webhooks: [
    "round.opened",
    "round.closed",
    "round.interest_submitted",
    "round.commitment_created",
    "round.commitment_changed",
    "round.signature_completed",
    "round.commitment_confirmed",
    // E3.7: an integration (a CRM, a cap-table tool) tracks who is verified. Ids and a status
    // only; not person-level (a verification is not engagement tracking).
    "round.verification_requested",
    "round.verification_decided",
  ],
  blockHydrators: [
    {
      type: "round_summary",
      // `async` so a module that is somehow not registered rejects rather than throwing into
      // the renderer's synchronous call site; `BlockHydrator.hydrate` promises a Promise.
      hydrate: async (data, ctx) => createRoundSummaryHydrator(roundServices()).hydrate(data, ctx),
    },
  ],
  slots: {
    // After the KPIs (30): an investor reads what was sent, what they may read and how the
    // company is doing before they reach the thing that asks them for money.
    "investor.nav": [{ id: "round", label: "Round", to: "/round", order: 40, icon: "round" }],
    // 36, between the KPIs (35) and CRM (37): the three screens a founder raising money moves
    // between.
    "admin.nav": [
      { id: "round-admin", label: "Round", to: "/admin/round", order: 36, icon: "round" },
    ],
    // E2.7: the settings hub (`/admin/settings`) lists every manifest's `admin.settings` entries.
    "admin.settings": [
      {
        id: "round-settings",
        label: "Round",
        to: "/admin/round/settings",
        order: 44,
        icon: "round",
      },
    ],
    // Declaring the block type is what makes the content editor offer it; `blockHydrators`
    // above is what fills it in for a reader.
    "content.blocks": ["round_summary"],
  },
});

export default roundModule;

export * from "./contracts.js";
export { roundDsar } from "./dsar.js";
export { createErasureHandler } from "./erasure.js";
export { type Actor, RoundError, type RoundErrorCode } from "./errors.js";
export {
  createRoundSummaryHydrator,
  type RoundSummaryHydrated,
} from "./hydrator.js";
export { createRoundJobs, EVIDENCE_PURGE_CRON, JOB_EVIDENCE_PURGE } from "./jobs.js";
export {
  ACCREDITATION_PATHS,
  type AccreditationPath,
  COMMITMENT_STATUSES,
  type CommitmentStatus,
  EVIDENCE_CONTENT_TYPES,
  EVIDENCE_KEY_PURPOSE,
  EVIDENCE_MAX_BYTES,
  type EvidenceContentType,
  evidenceKeyFor,
  evidenceRef,
  INSTRUMENT_KINDS,
  INTEREST_STATUSES,
  INTEREST_SUBJECTS,
  type InstrumentKind,
  type InterestStatus,
  type InterestSubject,
  isEvidenceContentType,
  methodNeedsFile,
  NON_ACCREDITED_LIMIT,
  PROFESSIONAL_LETTER_VALID_DAYS,
  ROUND_DISABLED_WHEN,
  ROUND_STAGES,
  ROUND_STATUSES,
  type RoundStage,
  type RoundStatus,
  roundDisabledFor,
  VERIFICATION_METHODS,
  VERIFICATION_STATUSES,
  VERIFICATION_VALID_MONTHS,
  type VerificationMethod,
  type VerificationStatus,
  verificationExpiry,
} from "./model.js";
export {
  exportVendorColumns,
  exportVerificationRow,
  importVerificationRow,
  roundPortability,
} from "./portability.js";
export { EVIDENCE_PATH, handleEvidenceUpload, registerRoundRawRoutes } from "./raw-routes.js";
export {
  type ClosingTaskRecord,
  ClosingTaskRepo,
  type CommitmentRecord,
  CommitmentRepo,
  type InterestRecord,
  InterestRepo,
  type NewRound,
  type RoundPatch,
  type RoundRecord,
  RoundRepo,
  readRoundSettings,
  type TermsRecord,
  TermsRepo,
  type VerificationRecord,
  VerificationRepo,
} from "./repos/round-repo.js";
export {
  PERM_MANAGE,
  PERM_PUBLISH,
  PERM_READ,
  PERM_SETTINGS,
  registerRoundRoutes,
} from "./routes.js";
export {
  allocationOf,
  investorProgress,
  type RoundAllocation,
  readAllocation,
} from "./service/allocation.js";
export {
  type CommitmentInput,
  type CommitmentListView,
  type CommitmentPatch,
  type CommitmentService,
  createCommitmentService,
} from "./service/commitments.js";
export { CSV_COLUMNS, commitmentsCsv, csvField, csvFilename } from "./service/export.js";
export {
  createInterestService,
  INTEREST_RATE,
  type InterestDecisionResult,
  type InterestRow,
  type InterestService,
  type SubmitInterestInput,
  type SubmitInterestResult,
} from "./service/interest.js";
export {
  calculatorDefault,
  createRoundService,
  type InvestorView,
  type InvestorViewInput,
  type RoundCounters,
  type RoundDetail,
  type RoundService,
} from "./service/rounds.js";
export { createTermsService, type PutTermsInput, type TermsService } from "./service/terms.js";
export {
  createVendorVerificationService,
  INV_WAKE_LIMIT,
  isVendorDriver,
  JOB_VERIFICATION_LIFECYCLE,
  JOB_VERIFICATION_START,
  JOB_VERIFICATION_SYNC,
  JOB_VERIFICATION_SYNC_DUE,
  openVerification,
  SYNC_CLAIM_PER_WORKSPACE,
  VERIFICATION_LIFECYCLE_CRON,
  VERIFICATION_START_RATE,
  VERIFICATION_SYNC_DUE_CRON,
  type VendorVerificationService,
  type VerificationJobData,
  vendorEvidenceNote,
} from "./service/vendor.js";
export {
  canRenew,
  escapeHtml,
  handoffCsp,
  handoffPage,
  myHandoff,
  nextCheckAt,
  PARALLEL_SDK_URL,
  POLL_LIFETIME_DAYS,
  parseHandoff,
  pollingExhausted,
  START_ATTEMPTS,
  StoredHandoffSchema,
  SYNC_BACKOFF_MS,
  SYNC_LEASE_MS,
  scriptJson,
  splitName,
  VENDOR_DEFAULT_VALID_DAYS,
  vendorExpiry,
} from "./service/vendor-rules.js";
export {
  createVerificationService,
  type DecideVerificationInput,
  type EvidenceRead,
  type EvidenceUpload,
  storeEvidenceObject,
  type VerificationRow,
  type VerificationService,
} from "./service/verification.js";
