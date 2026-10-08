import type { EvidenceUploadResult } from "../lib/round-queries.js";
import type { MyVerification } from "../lib/round-verification-queries.js";
import { VERIFICATION_ID } from "./fixtures-round.js";

/*
 * The investor's own verification (E3.7): `GET /round/current/verification` rows, typed
 * against the generated SDK so a contract change breaks the fixture, not a test at runtime.
 */

const NOW_ISO = "2026-09-12T10:00:00.000Z";

export function myVerification(over: Partial<MyVerification> = {}): MyVerification {
  return {
    id: VERIFICATION_ID,
    status: "pending",
    provider: "manual",
    providerLabel: "Manual review",
    handoff: { kind: "upload" },
    vendorStatus: null,
    vendorError: null,
    expiresAt: null,
    decidedAt: null,
    createdAt: NOW_ISO,
    canRenew: false,
    ...over,
  };
}

export const verifyInvestorInvite = (over: Partial<MyVerification> = {}) =>
  myVerification({
    provider: "verifyinvestor",
    providerLabel: "VerifyInvestor.com",
    handoff: { kind: "invite_sent" },
    vendorStatus: "invited",
    ...over,
  });

export const parallelWidget = (over: Partial<MyVerification> = {}) =>
  myVerification({
    provider: "parallel-markets",
    providerLabel: "Parallel Markets",
    handoff: { kind: "widget", url: "/api/v1/round/current/verification/handoff" },
    vendorStatus: "pending",
    ...over,
  });

/** What the raw evidence upload answers: flat, no `{ verification }` envelope (§9). */
export function evidenceUploadResult(
  over: Partial<EvidenceUploadResult> = {},
): EvidenceUploadResult {
  return {
    id: VERIFICATION_ID,
    status: "pending",
    hasEvidence: true,
    evidenceContentType: "application/pdf",
    evidenceBytes: 51_200,
    evidenceSha256: "a".repeat(64),
    evidenceUploadedAt: NOW_ISO,
    ...over,
  };
}
