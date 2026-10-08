/*
 * Errors the accreditation service throws to its kernel routes. `code` is an API error code
 * (`packages/contracts/src/errors.ts`) and `status` its HTTP status, so the server's `toApiError`
 * adopts an `AccreditationError` as is and the client sees `code` + `details`.
 *
 * Vendor calls made for modules (`start`/`check`/`fetchEvidence`) throw the port's
 * `AccreditationProviderError` instead — the round module's jobs act on its `code`/`retryable`.
 */

export const ACCREDITATION_ERROR_STATUS = {
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  accreditation_credentials_invalid: 422,
  accreditation_driver_not_offered: 422,
  accreditation_provider_error: 502,
} as const;

export type AccreditationErrorCode = keyof typeof ACCREDITATION_ERROR_STATUS;

export class AccreditationError extends Error {
  override readonly name = "AccreditationError";
  readonly status: number;
  constructor(
    readonly code: AccreditationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.status = ACCREDITATION_ERROR_STATUS[code];
  }
}

export function isAccreditationError(error: unknown): error is AccreditationError {
  return error instanceof AccreditationError;
}
