/*
 * Module error type (design/06 §3): the services throw these, `routes.ts` is the only place that
 * turns one into an `ApiError`. The codes are deliberately *specific* rather than a subset of the
 * API vocabulary, because a round refuses things for reasons an investor has to be able to act
 * on — "below the minimum" and "this round is not open" are both 409s on the wire and completely
 * different sentences on screen. `API_CODE` in `routes.ts` is the one place the two vocabularies
 * meet, and the round code travels on as `details.reason` so the SPA can pick the copy.
 */
export type RoundErrorCode =
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "forbidden"
  | "rate_limited"
  /** The round is not `open`, so it is not taking interest. */
  | "round_not_open"
  /** Another round in this workspace is already open (23505 on `round_one_open_idx`). */
  | "round_already_open"
  /** A round cannot be opened until it has terms (§R). */
  | "terms_missing"
  /** The amount is under `round.minimum_investment`. */
  | "below_minimum"
  /** 506(c): the member is not accredited and the submission was not self-certified. */
  | "accreditation_required"
  /** `verified` was asked for without the evidence that method needs (design/04 §1.6). */
  | "evidence_required"
  /** The uploaded evidence is not one of the three readable types. */
  | "unsupported_media_type"
  /** The uploaded evidence is over 10 MiB or over `limits.uploadMaxBytes`. */
  | "payload_too_large"
  /** The scanner said the upload is infected, or could not say. */
  | "scan_failed"
  // --- closing workflow (E3.5, ADR-0053) ---
  /** Another signature request for this commitment is pending, sent or delivered. */
  | "signature_request_open"
  /** A `pending` claim (its vendor call still in flight) cannot be voided yet. */
  | "signature_request_pending"
  /** The signature request is already terminal. */
  | "envelope_not_open"
  /** Only a soft or verbal commitment is sent for signature. */
  | "commitment_not_signable"
  /** Only a wired commitment can be confirmed. */
  | "commitment_not_wired"
  /** No address to send the agreement to (no member, and none given). */
  | "signer_email_missing"
  /** The workspace has no e-sign connection. */
  | "esign_not_configured"
  /** The connected vendor cannot create envelopes from a template. */
  | "esign_template_unsupported"
  /** `round.closing.subscriptionTemplateRef` is not set. */
  | "subscription_template_missing"
  // --- accreditation vendors (E3.7, ADR-0055) ---
  /** The member already has a pending verification (`details.verification` carries it). */
  | "verification_pending"
  /** A vendor check was asked for a verification that is not a pending vendor one. */
  | "verification_not_vendor"
  /** The member has been erased: no accreditation is recorded for them any more. */
  | "member_erased";

export class RoundError extends Error {
  override readonly name = "RoundError";
  constructor(
    readonly code: RoundErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** Who is acting, for audit rows and `created_by` provenance. */
export interface Actor {
  readonly membershipId: string;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
  /** The API key the request authenticated with (E3.4); audited as `meta.apiKeyId`. */
  readonly apiKeyId?: string | undefined;
}
