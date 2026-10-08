/*
 * Errors the e-sign service throws. `code` is an API error code (`packages/contracts/src/errors.ts`)
 * and `status` its HTTP status, so the server's `toApiError` adopts an `ESignError` as is and the
 * client sees `code` + `details` (flattened into the error object).
 */

export const ESIGN_ERROR_STATUS = {
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  esign_not_configured: 409,
  esign_provider_error: 502,
  esign_credentials_rejected: 422,
  esign_template_unsupported: 422,
  envelope_not_open: 409,
  envelopes_open: 409,
  esign_consent_required: 422,
  nda_version_superseded: 409,
  esign_ceremony_in_use: 409,
  /** E3.5 fix A4: a changed base URL needs every stored secret re-entered. */
  esign_credentials_required: 422,
  /** E3.5 fix A15: the NDA text has characters the e-sign PDF cannot draw. */
  esign_nda_text_unsupported: 422,
  /** E3.5 fix A7: the per-member NDA start budget. */
  rate_limited: 429,
} as const;

export type ESignErrorCode = keyof typeof ESIGN_ERROR_STATUS;

export class ESignError extends Error {
  override readonly name = "ESignError";
  readonly status: number;
  constructor(
    readonly code: ESignErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.status = ESIGN_ERROR_STATUS[code];
  }
}

export function isESignError(error: unknown): error is ESignError {
  return error instanceof ESignError;
}
