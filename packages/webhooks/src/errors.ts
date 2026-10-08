/*
 * The package's own refusal, mirroring `@fundroom/custom-domains` and `@fundroom/share-links`:
 * `code` is always a member of the closed `ApiErrorCode` set and `reason` disambiguates, so the
 * route layer maps it one to one (`error.reason` on the wire). Messages never quote a URL or a
 * secret back.
 */
export type WebhookErrorCode = "not_found" | "validation_failed" | "conflict" | "rate_limited";

export type WebhookErrorReason =
  | "not_found"
  | "invalid_url"
  | "https_required"
  | "url_not_allowed"
  | "unknown_topic"
  | "too_many_endpoints"
  | "endpoint_disabled"
  | "rotation_in_progress"
  | "subject_erased"
  | "tracking_not_allowed"
  | "topic_unavailable"
  | "invalid_cursor"
  | "rate_limited";

export class WebhookError extends Error {
  override readonly name = "WebhookError";
  constructor(
    readonly code: WebhookErrorCode,
    readonly reason: WebhookErrorReason,
    message: string,
    readonly details: Readonly<Record<string, string | number | readonly string[]>> = {},
  ) {
    super(message);
  }
}

export function isWebhookError(error: unknown): error is WebhookError {
  return error instanceof WebhookError;
}
