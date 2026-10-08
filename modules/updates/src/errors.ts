export type UpdatesErrorCode =
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "forbidden"
  | "mail_failed"
  | "unauthenticated";

export class UpdatesError extends Error {
  override readonly name = "UpdatesError";
  constructor(
    readonly code: UpdatesErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export interface Actor {
  readonly membershipId: string;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
  /** The API key the request authenticated with (E3.4); audited as `meta.apiKeyId`. */
  readonly apiKeyId?: string | undefined;
}
