/**
 * Every failure the kernel reports to callers. Codes are stable API vocabulary (they end up
 * in the error envelope); messages are for developers, never shown verbatim to users.
 * Anti-enumeration: flows that must not reveal account existence never throw distinct
 * codes for "unknown email" versus "wrong code" — both are `invalid_code`.
 */
export const AUTH_ERROR_CODES = {
  invalid_code: 400,
  expired: 400,
  too_many_attempts: 429,
  rate_limited: 429,
  not_eligible: 403,
  invalid_credential: 401,
  password_policy: 400,
  password_breached: 400,
  mfa_not_enrolled: 400,
  mfa_already_enrolled: 409,
  credential_not_found: 404,
  binding_mismatch: 409,
  unsupported: 400,
  oidc_failed: 401,
  mail_failed: 503,
  /** F-21: HIBP could not be reached and AUTH_HIBP_FAIL_MODE=closed; retry later. */
  breach_check_unavailable: 503,
  unauthenticated: 401,
  step_up_required: 403,
  csrf_rejected: 403,
  invalid_request: 400,
  // kernel-shared codes (same statuses as @fundroom/contracts API_ERROR_CODES)
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 400,
  /** E3.1: a 506(b) approval must attest the pre-existing relationship. */
  relationship_attestation_required: 422,
  /** E3.2: the credential is good, but the membership it would open has expired. */
  membership_expired: 403,
  /** E3.2: this workspace does not let investors add their own delegates. */
  delegates_disabled: 403,
  /** E3.2: the principal already has `access.maxDelegatesPerPrincipal` live or pending delegates. */
  delegate_limit_reached: 409,
  /**
   * E3.8: an SSO-bound session (minted by one workspace's IdP) may not change the global account —
   * factors, password, other sessions and devices, the user's own settings.
   */
  sso_session_restricted: 403,
  /**
   * E3.10: a session minted by a central-auth handoff is bound to the workspace whose host received
   * it and may not change the global account (the central-auth twin of `sso_session_restricted`).
   */
  bound_session_restricted: 403,
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_CODES;

export class AuthError extends Error {
  override readonly name = "AuthError";
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    readonly code: AuthErrorCode,
    message?: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message ?? code, options);
    this.status = AUTH_ERROR_CODES[code];
    this.details = details;
  }

  /** Shape of the JSON error envelope (E0.6 formalises it in `packages/contracts`). */
  toBody(): { error: { code: AuthErrorCode; message: string } & Record<string, unknown> } {
    return { error: { ...this.details, code: this.code, message: this.message } };
  }
}

export function isAuthError(error: unknown, code?: AuthErrorCode): error is AuthError {
  return error instanceof AuthError && (code === undefined || error.code === code);
}
