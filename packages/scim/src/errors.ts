/*
 * Errors the SCIM service's ADMIN methods throw to the kernel admin routes (`routes/sso.ts`).
 * `code` is an API error code (`packages/contracts/src/errors.ts`) and `status` its HTTP status,
 * so the server's `toApiError` adopts a `ScimAdminError` as is. The `/scim/v2` protocol methods
 * throw `ScimError` (RFC 7644 §3.12) instead.
 */

export const SCIM_ADMIN_ERROR_STATUS = {
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  scim_token_limit: 409,
  scim_disabled: 404,
} as const;

export type ScimAdminErrorCode = keyof typeof SCIM_ADMIN_ERROR_STATUS;

export class ScimAdminError extends Error {
  override readonly name = "ScimAdminError";
  readonly status: number;
  constructor(
    readonly code: ScimAdminErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.status = SCIM_ADMIN_ERROR_STATUS[code];
  }
}
