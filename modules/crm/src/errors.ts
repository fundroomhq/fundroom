/*
 * Module error type (design/06 §3): the service layer throws these, `routes.ts` is the only
 * place that turns them into an `ApiError`. Codes are a subset of the API error vocabulary so
 * the translation stays mechanical.
 *
 * There is no module-specific code here, unlike metrics' `sync_failed`: everything the CRM
 * refuses is either a row that is not there, a rule about the caller's input, or a conflict
 * with a row that is. The *reason* for a conflict travels in `details.reason` —
 * `stage_in_use`, `stage_protected`, `duplicate_key` — because `ApiErrorCode` is a closed
 * kernel vocabulary and a module must not widen it to name its own rules.
 */
export type CrmErrorCode = "not_found" | "conflict" | "validation_failed" | "forbidden";

export class CrmError extends Error {
  override readonly name = "CrmError";
  constructor(
    readonly code: CrmErrorCode,
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
