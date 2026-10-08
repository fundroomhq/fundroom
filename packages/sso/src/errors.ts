/*
 * Errors the SSO service throws to its kernel routes. `code` is an API error code
 * (`packages/contracts/src/errors.ts`) and `status` its HTTP status, so the server's `toApiError`
 * adopts an `SsoError` as is and the client sees `code` + `details`.
 *
 * The login flow's browser-facing failures are NOT these: the callback, ACS and finish routes
 * redirect with an `sso_error` code (`SsoFlowErrorCode`) and never answer JSON.
 */

export const SSO_ERROR_STATUS = {
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  service_unavailable: 503,
  sso_not_configured: 404,
  sso_disabled: 409,
  sso_invalid_config: 400,
  sso_enforce_precondition: 409,
  sso_domain_taken: 409,
  sso_domain_invalid: 400,
  sso_domain_unverified: 409,
} as const;

export type SsoErrorCode = keyof typeof SSO_ERROR_STATUS;

export class SsoError extends Error {
  override readonly name = "SsoError";
  readonly status: number;
  constructor(
    readonly code: SsoErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.status = SSO_ERROR_STATUS[code];
  }
}

export function isSsoError(error: unknown): error is SsoError {
  return error instanceof SsoError;
}

/** What the login flow puts in `?sso_error=` (contract "Error codes"). */
export const SSO_FLOW_ERROR_CODES = [
  "expired",
  "binding_mismatch",
  "invalid_response",
  "idp_error",
  "unknown_user",
  "not_provisioned",
  "suspended",
  "staff_only",
  "disabled",
  "rate_limited",
  "forbidden",
  "reauth_required",
  "reauth_mismatch",
] as const;
export type SsoFlowErrorCode = (typeof SSO_FLOW_ERROR_CODES)[number];

/** A refusal inside the login flow; the route turns it into a redirect, never JSON. */
export class SsoFlowError extends Error {
  override readonly name = "SsoFlowError";
  constructor(
    readonly code: SsoFlowErrorCode,
    /** Operator-facing reason (logs, `last_error` on a test); never an IdP claim value. */
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${reason}`, options);
  }
}
