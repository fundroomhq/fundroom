export type DataRoomErrorCode =
  | "not_found"
  | "conflict"
  | "validation_failed"
  | "forbidden"
  | "unsupported_media_type"
  | "payload_too_large"
  | "invalid_request"
  | "service_unavailable"
  // E3.13 forensic watermark detection
  | "forensic_image_invalid"
  | "forensic_no_marks"
  | "forensic_alignment_failed"
  | "forensic_too_many_candidates"
  | "forensic_rate_limited"
  | "forensic_busy";

export class DataRoomError extends Error {
  override readonly name = "DataRoomError";
  constructor(
    readonly code: DataRoomErrorCode,
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
  readonly ip?: string | undefined;
}
