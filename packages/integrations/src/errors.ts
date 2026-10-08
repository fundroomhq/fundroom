/*
 * Errors the integrations service throws. `code` is an API error code
 * (`packages/contracts/src/errors.ts`) and `status` its HTTP status, so the server's `toApiError`
 * adopts an `IntegrationError` as is and the client sees `code` + `details` (flattened into the
 * error object, e.g. `error.reason`).
 */

export const INTEGRATION_ERROR_STATUS = {
  validation_failed: 400,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  integration_not_available: 409,
  integration_oauth_required: 409,
  integration_oauth_pending_invalid: 404,
  integration_not_connected: 404,
  integration_credentials_rejected: 422,
  integration_secret_key_refused: 422,
  integration_account_unknown: 422,
  booking_link_invalid_url: 422,
  booking_link_limit: 409,
  unknown_provider: 404,
} as const;

export type IntegrationErrorCode = keyof typeof INTEGRATION_ERROR_STATUS;

export class IntegrationError extends Error {
  override readonly name = "IntegrationError";
  readonly status: number;
  constructor(
    readonly code: IntegrationErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.status = INTEGRATION_ERROR_STATUS[code];
  }
}

export function isIntegrationError(error: unknown): error is IntegrationError {
  return error instanceof IntegrationError;
}
