/*
 * Module error type (design/06 §3): the service layer throws these, `routes.ts` is the only
 * place that turns them into an `ApiError`. Codes are a subset of the API error vocabulary so
 * the translation stays mechanical.
 *
 * The pure modules (`period.ts`, `decimal.ts`, `formula.ts`, `model.ts`) throw this too where
 * they throw at all, which is rarely: a bad *value* is a `undefined` return, because a metric
 * with no number for a period is a gap in the chart and that is the truth (§6). Only a bad
 * *call* — asking for the canonical range of a `custom` period, which has none — is an error.
 */
export type MetricsErrorCode =
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "forbidden"
  | "sync_failed"
  /** E3.6: only a monthly, manually-entered metric can be fed by a KPI integration (422). */
  | "binding_period_unsupported";

export class MetricsError extends Error {
  override readonly name = "MetricsError";
  constructor(
    readonly code: MetricsErrorCode,
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
