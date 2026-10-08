export const COMPLIANCE_ERROR_CODES = [
  "not_found",
  "conflict",
  "validation_failed",
  "forbidden",
  /** Switching away from `506c`: the reliance is irrevocable for the offering (design/04 §1.6). */
  "offering_irrevocable",
  /** The change needs an explicit confirmation the route layer has not supplied yet. */
  "confirmation_required",
  /**
   * A self-certification was asked for in a workspace that has published no `accreditation`
   * document (E2.5 D5). Distinct from `not_found`, which would read to an investor as "your
   * submission is gone": nothing of theirs is missing, the workspace has simply not published the
   * text they would be certifying against, and the fix is an admin's. The API renders it
   * `accreditation_unavailable` (409).
   */
  "accreditation_document_missing",
  /**
   * An erasure request was made while the workspace is under legal hold (E2.6 decision 5,
   * design/04 §3.2 exception (a)). The API renders it 409 with `reason: "legal_hold"`.
   */
  "legal_hold",
] as const;

export type ComplianceErrorCode = (typeof COMPLIANCE_ERROR_CODES)[number];

export class ComplianceError extends Error {
  override readonly name = "ComplianceError";
  constructor(
    readonly code: ComplianceErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export function isComplianceError(e: unknown): e is ComplianceError {
  return e instanceof ComplianceError;
}

/**
 * Who is making the change. `membershipId` is the staff member; the compliance tables store it in
 * `changed_by` / `created_by` and the audit row repeats it, because these are the rows counsel
 * reads when asking who decided what.
 */
export interface Actor {
  readonly membershipId: string;
  readonly userId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
}
