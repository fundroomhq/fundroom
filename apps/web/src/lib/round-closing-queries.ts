import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { call, describeError, isApiError } from "./api.js";
import { esignErrorCode } from "./esign-queries.js";
import {
  api,
  type CommitmentStatus,
  type PrefillSource,
  ROUND_CLOSING_PREFILL_SOURCES,
  type RoundClosingSettings,
} from "./round-queries.js";

/*
 * Round closing, staff side (E3.5 §6, ADR-0053). The checklist is derived server-side from the
 * commitment, its signature request and the vaulted document — never stored, never re-derived
 * here — and `GET /round/rounds/{id}/closing` returns it with the round's roll-up and the manual
 * closing tasks.
 *
 * The payload types mirror `modules/round/src/contracts.ts` field for field (`RoundClosing` and
 * friends) and go through the same `api()` shim as the rest of `round-queries.ts`.
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

export const OPEN_SIGNATURE_STATUSES: readonly SignatureRequestStatus[] = [
  "pending",
  "sent",
  "delivered",
];

export const CLOSING_STAGES = [
  "not_started",
  "documents_sent",
  "signed",
  "wired",
  "confirmed",
  "withdrawn",
] as const;
export type ClosingStage = (typeof CLOSING_STAGES)[number];

export type { PrefillSource, RoundClosingSettings };
export { ROUND_CLOSING_PREFILL_SOURCES };

/*
 * The payload shapes come straight from the generated SDK (D's `modules/round/src/contracts.ts`),
 * so a server-side change is a compile error here rather than a silently stale screen.
 */
export type RoundSignatureRequest = FundRoomSchemas["RoundSignatureRequest"];
export type RoundClosingChecklist = FundRoomSchemas["RoundClosingChecklist"];
export type RoundClosingStageTotal = FundRoomSchemas["RoundClosingStageTotal"];
export type RoundClosingSummary = FundRoomSchemas["RoundClosingSummary"];
export type RoundClosingCommitment = FundRoomSchemas["RoundClosingCommitment"];
export type RoundClosing = FundRoomSchemas["RoundClosing"];

export function roundClosingQuery(id: string) {
  return queryOptions({
    queryKey: ["round", "closing", id],
    queryFn: () =>
      call(api().GET<RoundClosing>("/round/rounds/{id}/closing", { params: { path: { id } } })),
  });
}

/** Commitment statuses a subscription agreement may be sent for (the server's rule, restated). */
export const SIGNABLE_COMMITMENT_STATUSES: readonly CommitmentStatus[] = ["soft", "verbal"];

export function isOpenSignatureRequest(request: RoundSignatureRequest | null): boolean {
  return request !== null && OPEN_SIGNATURE_STATUSES.includes(request.status);
}

/**
 * Open, or in `error` with an envelope the vendor accepted: the kernel's `error` is recoverable
 * (a later pull may still see it sent, delivered or completed), so such a request is voided
 * rather than replaced. An `error` with no envelope never reached the vendor and is over.
 */
export function isLiveSignatureRequest(request: RoundSignatureRequest | null): boolean {
  return (
    isOpenSignatureRequest(request) ||
    (request !== null && request.status === "error" && request.envelopeId !== null)
  );
}

// --- labels -----------------------------------------------------------------------------------

export function signatureStatusLabel(status: SignatureRequestStatus): string {
  switch (status) {
    case "pending":
      return m.round_signature_pending();
    case "sent":
      return m.round_signature_sent();
    case "delivered":
      return m.round_signature_delivered();
    case "completed":
      return m.round_signature_completed();
    case "declined":
      return m.round_signature_declined();
    case "voided":
      return m.round_signature_voided();
    case "expired":
      return m.round_signature_expired();
    case "error":
      return m.round_signature_error();
  }
}

export function signatureStatusVariant(
  status: SignatureRequestStatus,
): "success" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "completed":
      return "success";
    case "declined":
    case "error":
      return "destructive";
    case "voided":
    case "expired":
      return "secondary";
    default:
      return "outline";
  }
}

export function closingStageLabel(stage: ClosingStage): string {
  switch (stage) {
    case "not_started":
      return m.round_closing_stage_not_started();
    case "documents_sent":
      return m.round_closing_stage_documents_sent();
    case "signed":
      return m.round_closing_stage_signed();
    case "wired":
      return m.round_closing_stage_wired();
    case "confirmed":
      return m.round_closing_stage_confirmed();
    case "withdrawn":
      return m.round_closing_stage_withdrawn();
  }
}

export function prefillSourceLabel(source: PrefillSource): string {
  switch (source) {
    case "investor_name":
      return m.round_prefill_investor_name();
    case "investor_email":
      return m.round_prefill_investor_email();
    case "amount":
      return m.round_prefill_amount();
    case "round_name":
      return m.round_prefill_round_name();
    case "company_name":
      return m.round_prefill_company_name();
    case "valuation_cap":
      return m.round_prefill_valuation_cap();
    case "date":
      return m.round_prefill_date();
  }
}

// --- errors -----------------------------------------------------------------------------------

/** `details.reason` of a round refusal (flattened into the error object by the API). */
function reasonOf(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  const flat = error.body.error["reason"];
  if (typeof flat === "string") return flat;
  const nested = (error.body.error["details"] as Record<string, unknown> | undefined)?.["reason"];
  return typeof nested === "string" ? nested : undefined;
}

export type ClosingRefusal =
  | "esign_not_configured"
  | "esign_template_unsupported"
  | "subscription_template_missing"
  | "signature_request_open"
  | "commitment_not_signable"
  | "commitment_not_wired"
  | "round_not_open"
  | "signer_email_missing"
  | "envelope_not_open"
  | "esign_provider_error";

/** Which of the closing refusals this is, if any: codes first, then a `conflict`'s reason. */
export function closingRefusal(error: unknown): ClosingRefusal | undefined {
  const code = esignErrorCode(error);
  switch (code) {
    case "esign_not_configured":
    case "esign_template_unsupported":
    case "signer_email_missing":
    case "envelope_not_open":
    case "esign_provider_error":
      return code;
    default:
      break;
  }
  switch (reasonOf(error)) {
    case "subscription_template_missing":
      return "subscription_template_missing";
    case "signature_request_open":
    case "signature_request_pending":
      return "signature_request_open";
    case "commitment_not_signable":
      return "commitment_not_signable";
    case "commitment_not_wired":
      return "commitment_not_wired";
    case "round_not_open":
      return "round_not_open";
    case "esign_not_configured":
      return "esign_not_configured";
    case "esign_template_unsupported":
      return "esign_template_unsupported";
    default:
      return undefined;
  }
}

export function describeClosingError(error: unknown): string {
  switch (closingRefusal(error)) {
    case "esign_not_configured":
      return m.round_closing_error_not_configured();
    case "esign_template_unsupported":
      return m.round_closing_error_template_unsupported();
    case "subscription_template_missing":
      return m.round_closing_error_template_missing();
    case "signature_request_open":
      return m.round_closing_error_request_open();
    case "commitment_not_signable":
      return m.round_closing_error_not_signable();
    case "commitment_not_wired":
      return m.round_closing_error_not_wired();
    case "round_not_open":
      return m.round_closing_error_round_not_open();
    case "signer_email_missing":
      return m.round_closing_error_signer_email_missing();
    case "envelope_not_open":
      return m.round_closing_error_envelope_not_open();
    case "esign_provider_error":
      return m.round_closing_error_provider();
    default:
      return describeError(error).body;
  }
}
