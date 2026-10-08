import type {
  AccreditationPath,
  Allocation,
  CommitmentStatus,
  Eligibility,
  InstrumentKind,
  RoundStage,
  Terms,
} from "@fundroom/round-terms";
import { COMMITMENT_STATUSES } from "@fundroom/round-terms";
import { FundRoomApiError, type FundRoomSchemas, isErrorBody } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { ApiFailure, apiBase, call, api as sdkApi } from "./api.js";

/*
 * Queries for the round module (E2.5 §W).
 *
 * Two things are deliberately unusual here and both are temporary scaffolding, to be
 * removed when the SDK is regenerated:
 *
 *  1. **The payload types are hand-written.** `packages/sdk` is generated from the server's
 *     OpenAPI document, and the `/round/...` operations are being written in the same epic as
 *     these screens. Until `node apps/server/dist/cli.js openapi && pnpm --filter
 *     @fundroom/sdk build` has run, `FundRoomSchemas["Round"]` does not exist. Every interface
 *     below mirrors contract §S/§P field for field so the swap is a delete, not a rewrite.
 *  2. **`api()` is narrowed to `RoundApi`.** openapi-fetch types its methods against the
 *     generated path union, so a literal `"/round/current"` is not assignable to it yet. The
 *     shim keeps every call site spelled exactly as openapi-fetch wants it — path template,
 *     `params.path`, `params.query`, `body` — so regenerating the SDK and deleting the shim
 *     leaves the call sites untouched.
 *
 * As everywhere else in this app, **money is a decimal string end to end**. `numeric(20, 6)`
 * does not survive a round trip through a double (contract §5), so nothing here parses an
 * amount; `formatMoney` in `modules/round/format.ts` is the one place a figure becomes a
 * number, and only to print it.
 */

export type { AccreditationPath, Allocation, CommitmentStatus, InstrumentKind, RoundStage, Terms };
/* Re-exported as a value so a screen needs one import for the enum and its label helper. */
export { COMMITMENT_STATUSES };

export const ROUND_STATUSES = ["planning", "open", "closed"] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export const INTEREST_STATUSES = ["submitted", "accepted", "declined", "withdrawn"] as const;
export type InterestStatus = (typeof INTEREST_STATUSES)[number];

export const VERIFICATION_STATUSES = ["pending", "verified", "rejected", "expired"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const VERIFICATION_METHODS = [
  "document_review",
  "third_party",
  "professional_letter",
  "minimum_investment",
] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

export const SUBJECTS = ["individual", "entity"] as const;
export type Subject = (typeof SUBJECTS)[number];

/** The offering statuses this module can be reached in (`none`/`informational` 404 the routes). */
export type RoundOfferingStatus = "506b" | "506c" | "non_us";

export interface MemberSummary {
  readonly membershipId: string;
  readonly displayName: string;
  readonly email?: string | null;
}

export interface Round {
  readonly id: string;
  readonly name: string;
  readonly stage: RoundStage;
  readonly instrumentKind: InstrumentKind;
  readonly status: RoundStatus;
  readonly targetAmount: string;
  readonly currency: string;
  readonly minimumInvestment: string | null;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly showProgress: boolean;
  readonly summary: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One append-only row of `round.terms` (§D3): edits insert a revision, never update one. */
export interface TermsRevision {
  readonly id: string;
  readonly roundId: string;
  readonly revision: number;
  readonly terms: Terms;
  readonly termsSchemaVersion: number;
  readonly asOf: string;
  readonly disclaimerStamp: string | null;
  readonly supersededBy: string | null;
  readonly createdAt: string;
  readonly createdBy: MemberSummary | null;
}

/** The versioned legal text `GET /round/current` stamps onto every submission. */
export interface RoundDisclaimer {
  readonly stamp: string;
  readonly title: string;
  readonly body: string;
  readonly versionNo: number | null;
}

/** The workspace's published accreditation questionnaire, named on the consent checkbox. */
export interface AccreditationDocument {
  readonly slug: string;
  readonly title: string;
  readonly versionNo: number;
  readonly stamp: string;
}

export interface InterestSubmission {
  readonly id: string;
  readonly roundId: string;
  readonly membershipId: string;
  readonly member: MemberSummary | null;
  readonly amount: string;
  readonly currency: string;
  readonly subject: Subject;
  readonly entityName: string | null;
  readonly note: string | null;
  readonly accreditationPath: AccreditationPath;
  readonly nonAccredited: boolean;
  readonly accreditationStamp: string | null;
  readonly disclaimerStamp: string | null;
  readonly offeringStatus: string;
  readonly status: InterestStatus;
  readonly verificationId: string | null;
  readonly commitmentId: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One accreditation verification as the staff routes return it (the decide answer, the detail).
 * Generated from the server contract: the E3.7 vendor fields (`providerLabel`, `vendorStatus`,
 * `decidedByProvider`, `reverificationOf`, …) come with it.
 */
export type Verification = FundRoomSchemas["RoundVerification"];

/** A queue row: the verification plus the member's name and email, flat (not a `member` object). */
export type VerificationRow = FundRoomSchemas["RoundVerificationRow"];

export interface Commitment {
  readonly id: string;
  readonly roundId: string;
  readonly membershipId: string | null;
  readonly member: MemberSummary | null;
  readonly organizationId: string | null;
  readonly contactId: string | null;
  readonly displayName: string | null;
  readonly amount: string;
  readonly status: CommitmentStatus;
  readonly note: string | null;
  readonly interestSubmissionId: string | null;
  readonly signedDocumentId: string | null;
  readonly wiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClosingTask {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
  readonly doneAt: string | null;
  readonly position: number;
}

/** §D7: counted over *accepted* submissions whose answers named no category. Never blocks. */
export interface RoundCounters {
  readonly submitted: number;
  readonly accepted: number;
  readonly nonAccreditedAccepted: number;
  readonly limit: number;
}

export interface RoundDetail {
  readonly round: Round;
  readonly terms: TermsRevision | null;
  readonly history: readonly TermsRevision[];
  readonly allocation: Allocation;
  readonly counters: RoundCounters;
}

/** `GET /round/current` — the whole investor page in one read. */
export interface CurrentRoundView {
  readonly round: Round | null;
  readonly terms: Terms | null;
  readonly disclaimer: RoundDisclaimer | null;
  /** Honours `showProgress`; staff always see it. `null` means "do not draw a bar". */
  readonly progress: Allocation | null;
  readonly submissions: readonly InterestSubmission[];
  readonly accreditationDocument: AccreditationDocument | null;
  readonly offeringStatus: RoundOfferingStatus;
}

/** One line of the accreditation questionnaire, as the server's category list spells it. */
export interface EligibilityCategory {
  readonly key: string;
  readonly label: string;
  readonly section: "us" | "uk" | "eu" | "ca";
  /** Which subjects this category can be claimed by; absent means both. */
  readonly subjects?: readonly Subject[];
}

/** `GET /round/current/eligibility` — §P's `Eligibility` plus what the form needs to draw it. */
export interface EligibilityView extends Eligibility {
  /** Whether this member already holds a live `accredited` attestation. */
  readonly accredited: boolean;
  readonly categories: readonly EligibilityCategory[];
  readonly questionnaireVersion: number | null;
}

/** E3.5: where a subscription-template field gets its value (`ROUND_CLOSING_PREFILL_SOURCES`). */
export const ROUND_CLOSING_PREFILL_SOURCES = [
  "investor_name",
  "investor_email",
  "amount",
  "round_name",
  "company_name",
  "valuation_cap",
  "date",
] as const;
export type PrefillSource = (typeof ROUND_CLOSING_PREFILL_SOURCES)[number];

export interface RoundClosingSettings {
  /** The vendor-side template the subscription agreement is generated from; `null` = not set up. */
  readonly subscriptionTemplateRef: string | null;
  /**
   * The template's signer role the investor fills (default `Signer`). DocuSign and multi-role
   * DocuSeal templates match the signer by it, so it must be spelled as in the template.
   */
  readonly templateRole: string;
  /** Vendor field name → the fact it is filled with. */
  readonly prefill: Readonly<Record<string, PrefillSource>>;
}

export interface RoundSettings {
  readonly evidenceRetentionDays: number;
  readonly defaultCurrency: string;
  /** E3.5 closing: the vendor-side subscription template and its prefill mapping. */
  readonly closing: RoundClosingSettings;
  /** E3.7: one reminder `reminderDays` before expiry; `autoStart` opens the vendor renewal then. */
  readonly reverification: RoundReverificationSettings;
}

export interface RoundReverificationSettings {
  readonly reminderDays: number;
  readonly autoStart: boolean;
}

export interface AccreditationAnswersBody {
  readonly categories: readonly string[];
  readonly section: "us" | "uk" | "eu" | "ca";
  readonly note?: string;
  readonly questionnaireVersion?: number;
}

/** The two written representations of the minimum-investment safe harbour (§B, 12 Mar 2025). */
export interface MinimumInvestmentRepresentations {
  readonly accredited: boolean;
  readonly notThirdPartyFinanced: boolean;
}

export interface InterestBody {
  readonly amount: string;
  readonly subject: Subject;
  readonly entityName?: string;
  readonly note?: string;
  readonly consentToElectronicRecords: boolean;
  readonly accreditation?: AccreditationAnswersBody;
  readonly representations?: MinimumInvestmentRepresentations;
}

export interface InterestDecision {
  readonly submission: InterestSubmission;
  readonly commitment: Commitment | null;
  readonly warnings: readonly string[];
}

// --- SDK shim (delete once the generated client knows `/round/...`) ----------------------------

interface RoundResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

interface RoundInit {
  readonly params?: {
    readonly path?: Record<string, string>;
    readonly query?: Record<string, string | number | boolean | undefined>;
  };
  readonly body?: unknown;
}

interface RoundApi {
  GET<T>(path: string, init?: RoundInit): Promise<RoundResult<T>>;
  POST<T>(path: string, init?: RoundInit): Promise<RoundResult<T>>;
  PUT<T>(path: string, init?: RoundInit): Promise<RoundResult<T>>;
  PATCH<T>(path: string, init?: RoundInit): Promise<RoundResult<T>>;
  DELETE<T>(path: string, init?: RoundInit): Promise<RoundResult<T>>;
}

/** The typed client, with the round paths admitted early. See the file header. */
export const api = (): RoundApi => sdkApi() as unknown as RoundApi;

// --- investor ---------------------------------------------------------------------------------

export const roundCurrentQuery = queryOptions({
  queryKey: ["round", "current"],
  queryFn: () => call(api().GET<CurrentRoundView>("/round/current")),
});

export const roundMySubmissionsQuery = queryOptions({
  queryKey: ["round", "my-interest"],
  queryFn: () => call(api().GET<{ submissions: InterestSubmission[] }>("/round/current/interest")),
});

/**
 * The path for one prospective amount. Computed **server-side** (§D4) and never re-derived in
 * the browser: the answer decides what a person is asked to represent about themselves, so one
 * authority for it is the whole point. The screen debounces the amount before asking.
 */
export function roundEligibilityQuery(subject: Subject, amount: string) {
  return queryOptions({
    queryKey: ["round", "eligibility", subject, amount],
    queryFn: () =>
      call(
        api().GET<EligibilityView>("/round/current/eligibility", {
          params: { query: { subject, amount } },
        }),
      ),
    enabled: amount !== "",
  });
}

// --- staff ------------------------------------------------------------------------------------

export const roundsQuery = queryOptions({
  queryKey: ["round", "rounds"],
  queryFn: () => call(api().GET<{ rounds: Round[] }>("/round/rounds")),
});

export function roundDetailQuery(id: string) {
  return queryOptions({
    queryKey: ["round", "rounds", id],
    queryFn: () => call(api().GET<RoundDetail>("/round/rounds/{id}", { params: { path: { id } } })),
  });
}

export function roundTermsHistoryQuery(id: string) {
  return queryOptions({
    queryKey: ["round", "terms", id],
    queryFn: () =>
      call(
        api().GET<{ revisions: TermsRevision[] }>("/round/rounds/{id}/terms", {
          params: { path: { id } },
        }),
      ),
  });
}

export function roundAllocationQuery(id: string) {
  return queryOptions({
    queryKey: ["round", "allocation", id],
    queryFn: () =>
      call(
        api().GET<{ allocation: Allocation }>("/round/rounds/{id}/allocation", {
          params: { path: { id } },
        }),
      ),
  });
}

export function roundCommitmentsQuery(id: string) {
  return queryOptions({
    queryKey: ["round", "commitments", id],
    queryFn: () =>
      call(
        api().GET<{ commitments: Commitment[] }>("/round/rounds/{id}/commitments", {
          params: { path: { id } },
        }),
      ),
  });
}

export function roundInterestQueueQuery(id: string, status: InterestStatus | "all") {
  return queryOptions({
    queryKey: ["round", "interest", id, status],
    queryFn: () =>
      call(
        api().GET<{ submissions: InterestSubmission[] }>("/round/rounds/{id}/interest", {
          params: { path: { id }, query: status === "all" ? {} : { status } },
        }),
      ),
  });
}

export function roundClosingTasksQuery(id: string) {
  return queryOptions({
    queryKey: ["round", "closing-tasks", id],
    queryFn: () =>
      call(
        api().GET<{ tasks: ClosingTask[] }>("/round/rounds/{id}/closing-tasks", {
          params: { path: { id } },
        }),
      ),
  });
}

export function roundVerificationsQuery(status: VerificationStatus | "all") {
  return queryOptions({
    queryKey: ["round", "verifications", status],
    queryFn: () =>
      call(
        api().GET<{ verifications: VerificationRow[] }>("/round/verifications", {
          params: { query: status === "all" ? {} : { status } },
        }),
      ),
  });
}

export const roundSettingsQuery = queryOptions({
  queryKey: ["round", "settings"],
  queryFn: () => call(api().GET<RoundSettings>("/round/settings")),
});

// --- links and raw bodies ---------------------------------------------------------------------

/** The commitments CSV (`round.publish`, step-up). A plain anchor, so the browser saves it. */
export function roundExportHref(id: string): string {
  return `${apiBase()}/api/v1/round/rounds/${encodeURIComponent(id)}/export.csv`;
}

/** Staff-only evidence download (`round.manage`, audited server-side as `round.evidence_viewed`). */
export function verificationEvidenceHref(id: string): string {
  return `${apiBase()}/api/v1/round/verifications/${encodeURIComponent(id)}/evidence`;
}

export const EVIDENCE_CONTENT_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Uploads one evidence file to `PUT /round/verifications/{id}/evidence`.
 *
 * A raw route: the body is the bytes themselves and `content-type` is the file's own, so this
 * cannot go through the typed client (which JSON-encodes everything). The size and type are
 * checked here as well as server-side — not as a security control, which it is not, but so an
 * investor is told what is wrong before ten megabytes go up the wire.
 */
/**
 * What the raw upload route answers: a flat summary of the verification's evidence (not the
 * `{ verification }` envelope of the JSON routes, and never the storage key).
 */
export interface EvidenceUploadResult {
  readonly id: string;
  readonly status: VerificationStatus;
  readonly hasEvidence: boolean;
  readonly evidenceContentType: string | null;
  readonly evidenceBytes: number | null;
  readonly evidenceSha256: string | null;
  readonly evidenceUploadedAt: string | null;
}

export async function uploadEvidence(
  verificationId: string,
  file: File,
): Promise<EvidenceUploadResult> {
  const contentType = file.type;
  const res = await fetch(
    `${apiBase()}/api/v1/round/verifications/${encodeURIComponent(verificationId)}/evidence`,
    {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": contentType === "" ? "application/octet-stream" : contentType },
      body: file,
    },
  );
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const body = isErrorBody(parsed)
      ? parsed
      : { error: { code: "internal_error" as const, message: `HTTP ${res.status}` } };
    const retry = res.headers.get("retry-after");
    throw new ApiFailure(
      new FundRoomApiError(res.status, body, res.headers.get("x-request-id") ?? undefined),
      retry !== null && /^\d+$/u.test(retry) ? Number(retry) : undefined,
    );
  }
  return parsed as EvidenceUploadResult;
}

/** `true` for a plain decimal string; the one gate before an amount reaches the calculator. */
export function isDecimal(text: string): boolean {
  return /^\d+(?:\.\d+)?$/u.test(text.trim()) && text.trim().length <= 32;
}
