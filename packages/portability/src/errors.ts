export type PortabilityErrorCode =
  | "not_found"
  | "undeclared_tables"
  | "blob_missing"
  | "blob_mismatch"
  | "verification_failed"
  | "unverified_origin"
  | "incompatible"
  | "slug_taken"
  | "invalid_input"
  /** The file names objects or rows outside the new workspace (README "Import refusal rules"). */
  | "unsafe_reference"
  | "import_failed"
  /** A running export whose row was failed as stale or deleted under it. */
  | "cancelled";

export class PortabilityError extends Error {
  override readonly name = "PortabilityError";
  constructor(
    readonly code: PortabilityErrorCode,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
  }
}
