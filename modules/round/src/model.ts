import type { OfferingStatus } from "@fundroom/db";
import {
  ACCREDITATION_PATHS,
  type AccreditationPath,
  COMMITMENT_STATUSES,
  type CommitmentStatus,
  INSTRUMENT_KINDS,
  type InstrumentKind,
  ROUND_STAGES,
  type RoundStage,
} from "@fundroom/round-terms";

/*
 * The round module's pure vocabulary (E2.5 §S).
 *
 * No drizzle, no pg, no Hono: `src/schema/round.ts` types its columns *from* here and
 * `src/contracts.ts` builds its enums from here, so the list a route validates and the list a
 * column stores cannot drift. Four of the eight enums are not declared here at all — they are
 * re-exported from `@fundroom/round-terms`, because the browser's calculator and eligibility
 * function need the same words and a second copy in this module is a second copy that can be
 * wrong.
 */

export {
  ACCREDITATION_PATHS,
  type AccreditationPath,
  COMMITMENT_STATUSES,
  type CommitmentStatus,
  INSTRUMENT_KINDS,
  type InstrumentKind,
  ROUND_STAGES,
  type RoundStage,
};

/** Mirrors the `round.status` enum. `planning` is invisible to investors; the other two are not. */
export const ROUND_STATUSES = ["planning", "open", "closed"] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

/** Mirrors `round.interest_status`. */
export const INTEREST_STATUSES = ["submitted", "accepted", "declined", "withdrawn"] as const;
export type InterestStatus = (typeof INTEREST_STATUSES)[number];

/** Mirrors `round.verification_status`. */
export const VERIFICATION_STATUSES = ["pending", "verified", "rejected", "expired"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Mirrors `round.verification_method` and `AccreditationVerificationState["method"]`. */
export const VERIFICATION_METHODS = [
  "document_review",
  "third_party",
  "professional_letter",
  "minimum_investment",
] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/** Who is subscribing; the `subject` column's CHECK and `EligibilityInput["subject"]`. */
export const INTEREST_SUBJECTS = ["individual", "entity"] as const;
export type InterestSubject = (typeof INTEREST_SUBJECTS)[number];

/**
 * The offering statuses that switch the whole module off (`offeringStatusRules.disabledWhen`).
 *
 * It is **exactly** the set where `permits(status).roundAndTerms` is false — `none` (nothing is
 * being offered) and `informational` (the company may describe itself and must not solicit).
 * `src/index.test.ts` pins the two lists against each other; it pins them against a literal copy
 * rather than against `permits()` itself, because `@fundroom/compliance` is not a dependency of
 * this module and must not become one — a module that imported the compliance package could
 * reach `core.*` through it, which is the coupling ADR-0033 forbids.
 */
export const ROUND_DISABLED_WHEN = ["none", "informational"] as const;
export type RoundDisabledStatus = (typeof ROUND_DISABLED_WHEN)[number];

/** Whether the module is switched off for this workspace's offering status. */
export function roundDisabledFor(status: OfferingStatus): boolean {
  return (ROUND_DISABLED_WHEN as readonly string[]).includes(status);
}

/**
 * Rule 506(b) admits up to 35 non-accredited purchasers. E2.5 D7: a **warning**, never a block —
 * the rule counts purchasers in an offering, and only the company and its counsel know whether
 * this portal holds all of them.
 */
export const NON_ACCREDITED_LIMIT = 35;

/** Evidence uploads: the three types a verification can actually be read from. */
export const EVIDENCE_CONTENT_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
export type EvidenceContentType = (typeof EVIDENCE_CONTENT_TYPES)[number];

/** The module's own ceiling, applied under `services.limits.uploadMaxBytes` (§P). */
export const EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;

export function isEvidenceContentType(value: string): value is EvidenceContentType {
  return (EVIDENCE_CONTENT_TYPES as readonly string[]).includes(value);
}

/** Where a verification's evidence lives; one object per verification, so an upload replaces. */
export function evidenceKeyFor(workspaceId: string, verificationId: string): string {
  return `round/verification/${workspaceId}/${verificationId}`;
}

/**
 * The envelope-encryption purpose the evidence DEK is minted under.
 *
 * Hyphen, not a dot: `core.workspace_key.purpose` carries a CHECK of `^[a-z][a-z0-9-]*$`, so
 * `round.evidence` is refused by the column — which is how `metrics-sheets` is spelled too.
 */
export const EVIDENCE_KEY_PURPOSE = "round-evidence";

/**
 * Methods that need a **file**, not a sentence (design/04 §1.6, §183).
 *
 * `document_review` means somebody read a tax return or a brokerage statement, and
 * `professional_letter` means somebody read a letter from a CPA or an attorney — in both cases
 * the paper is the evidence and a note saying "I saw it" is a claim about evidence rather than
 * evidence. `third_party` and `minimum_investment` are the other way round: the record is a
 * bureau's reference or the investor's own written representation, and the note is where it goes.
 */
export function methodNeedsFile(method: VerificationMethod): boolean {
  return method === "document_review" || method === "professional_letter";
}

/** A professional letter is stale after 90 days (design/04 §183). */
export const PROFESSIONAL_LETTER_VALID_DAYS = 90;
/** Everything else follows `ACCREDITATION_VALID_MONTHS`: twelve calendar months. */
export const VERIFICATION_VALID_MONTHS = 12;

/** When a `verified` decision stops standing, given the method it was reached by. */
export function verificationExpiry(method: VerificationMethod, decidedAt: Date): Date {
  if (method === "professional_letter") {
    return new Date(decidedAt.getTime() + PROFESSIONAL_LETTER_VALID_DAYS * 86_400_000);
  }
  const out = new Date(decidedAt.getTime());
  out.setUTCMonth(out.getUTCMonth() + VERIFICATION_VALID_MONTHS);
  return out;
}

/**
 * The evidence reference written onto the kernel `accredited` attestation.
 *
 * Two spellings, and the distinction is the point: `storage:<key>` names an object somebody can
 * fetch (until the purge job removes it — the *reference* outlives the file, which is what makes
 * "this was verified from a document" provable after the document is gone), while `note:<sha256>`
 * names the exact text of the verifier's note without copying it into a kernel table, so a note
 * naming an investor's bank cannot leak into the compliance register.
 */
export function evidenceRef(input: {
  key?: string | undefined;
  noteSha256?: string | undefined;
}): string | undefined {
  if (input.key !== undefined) return `storage:${input.key}`;
  if (input.noteSha256 !== undefined) return `note:${input.noteSha256}`;
  return undefined;
}

/** The accreditation path an interest submission is stored with. Re-exported for the contracts. */
export type { AccreditationPath as InterestAccreditationPath };

/**
 * Mirrors `core.esign_envelope.status` minus `draft`, plus `pending`: the claim taken before the
 * vendor call, which has no envelope yet (0004).
 */
export const SIGNATURE_REQUEST_STATUSES = [
  "pending",
  "sent",
  "delivered",
  "completed",
  "declined",
  "voided",
  "expired",
  "error",
] as const;
export type SignatureRequestStatus = (typeof SIGNATURE_REQUEST_STATUSES)[number];
