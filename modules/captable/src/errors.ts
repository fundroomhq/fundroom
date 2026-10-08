/*
 * Module error type (design/06 §3): services throw these, `routes.ts` alone turns them into an
 * `ApiError`. `import_invalid` is the one module-specific refusal (API code
 * `captable_import_invalid`, 422): its `details` carry `reason` and the `problems` list.
 */
export type CaptableErrorCode = "not_found" | "conflict" | "validation_failed" | "import_invalid";

export class CaptableError extends Error {
  override readonly name = "CaptableError";
  constructor(
    readonly code: CaptableErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** Who is acting, for audit rows and `imported_by`. */
export interface Actor {
  readonly membershipId: string;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
}
