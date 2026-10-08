/*
 * Module error type (design/06 §3): the service layer throws these, `routes.ts` is the only
 * place that turns them into an `ApiError`. Codes are a subset of the API error vocabulary so
 * the translation stays mechanical.
 */
export type AnalyticsErrorCode = "not_found" | "conflict" | "validation_failed" | "forbidden";

export class AnalyticsError extends Error {
  override readonly name = "AnalyticsError";
  constructor(
    readonly code: AnalyticsErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** Who is acting, for audit rows and session-scoped writes. */
export interface Actor {
  readonly membershipId: string;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly ip?: string | undefined;
}
