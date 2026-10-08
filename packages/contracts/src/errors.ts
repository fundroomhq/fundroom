import { z } from "@hono/zod-openapi";

/*
 * The error envelope (EXECUTION_PLAN §10 "API", E0.6). Every non-2xx JSON response from
 * `/api/v1` has this shape:
 *
 *   { "error": { "code": "not_found", "message": "…", "requestId": "…", …details } }
 *
 * `code` is stable API vocabulary (clients branch on it; it is documented in the OpenAPI
 * `ErrorCode` enum); `message` is for developers and never shown verbatim to users;
 * `requestId` echoes the `X-Request-Id` of the response so a support ticket can be matched
 * to a log line. Extra fields are error-specific (`reason`, `retryAfterMs`, `issues`) and
 * never carry PII.
 *
 * Codes and statuses here cover the kernel; `@fundroom/identity`'s `AuthError` codes are a
 * subset with the same statuses, so an `AuthError` maps 1:1 onto an `ApiError`.
 */
export const API_ERROR_CODES = {
  // identity (mirrors AUTH_ERROR_CODES)
  invalid_code: 400,
  expired: 400,
  too_many_attempts: 429,
  rate_limited: 429,
  not_eligible: 403,
  invalid_credential: 401,
  password_policy: 400,
  password_breached: 400,
  mfa_not_enrolled: 400,
  mfa_already_enrolled: 409,
  credential_not_found: 404,
  binding_mismatch: 409,
  unsupported: 400,
  oidc_failed: 401,
  mail_failed: 503,
  /** F-21: HIBP could not be reached and AUTH_HIBP_FAIL_MODE=closed; retry later. */
  breach_check_unavailable: 503,
  unauthenticated: 401,
  step_up_required: 403,
  csrf_rejected: 403,
  invalid_request: 400,
  // kernel
  validation_failed: 400,
  forbidden: 403,
  not_found: 404,
  workspace_not_found: 404,
  module_disabled: 404,
  setup_required: 404,
  /**
   * The caller must accept a legal document before the portal serves them anything else
   * (E1.6, §13.1). `details` names the outstanding documents so the SPA can render the gate.
   */
  legal_acceptance_required: 403,
  /**
   * The requested offering-status change cannot be made: general solicitation under 506(c)
   * cannot be withdrawn for an offering already in flight (ADR-0037).
   */
  offering_irrevocable: 409,
  /**
   * A self-certification was asked for, but the workspace has published no `accreditation`
   * document to certify against (E2.5 D5). Not `not_found`: nothing the investor asked for is
   * missing, and rendering that would send them looking for their own submission. The SPA tells
   * them the company has not finished setting this up; an admin publishes the document.
   */
  accreditation_unavailable: 409,
  /**
   * Approving an access request under Rule 506(b) needs the approver to attest the pre-existing
   * substantive relationship (`relationship: { source, establishedAt }`, design/03:182, E3.1):
   * under 506(b) a stranger who filled in a public form may only be admitted on the strength of
   * a relationship that existed before they asked.
   */
  relationship_attestation_required: 422,
  /**
   * The sign-in credential was proven, but the membership it would open has passed its own
   * `expires_at` (E3.2) — in the named workspace, or, on the canonical host, in every workspace
   * the person belongs to. Raised after the credential check, so it tells a stranger nothing.
   */
  membership_expired: 403,
  /**
   * Delegates (E3.2): the workspace's `access.allowDelegates` is off, so an investor cannot add
   * their own delegate (an admin still can, from the People screen).
   */
  delegates_disabled: 403,
  /**
   * The principal already has `access.maxDelegatesPerPrincipal` delegates, counting accepted ones
   * and pending invitations (E3.2). Remove one first.
   */
  delegate_limit_reached: 409,
  /**
   * A staff member is viewing the portal as an investor (E2.7 "view as"), and the request would
   * change something or take a copy away: any non-GET/HEAD/OPTIONS request other than ending the
   * view or signing out, and any download or export. The view is read-only by construction.
   */
  view_as_read_only: 403,
  // workspace export (E2.8)
  /** A workspace export is already queued or running; one at a time per workspace. */
  export_running: 409,
  /** The export exists but is not `ready` (still queued/running, or it failed). */
  export_not_ready: 409,
  /** The export's 7-day download window has passed and its file was deleted. */
  export_expired: 410,
  // search (E2.8)
  /** The query has no searchable term (only punctuation, or too long after normalisation). */
  search_query_invalid: 400,
  // e-signature (E3.5, ADR-0053)
  /** The workspace has no active e-sign vendor connection (or a feature needs one). */
  esign_not_configured: 409,
  /** The e-sign vendor refused or failed a call. `details.providerCode` is the port's error code. */
  esign_provider_error: 502,
  /** Saving a connection: the live credential check failed. `details.reason` says why. */
  esign_credentials_rejected: 422,
  /** The connected vendor cannot create envelopes from a template (round closing needs one). */
  esign_template_unsupported: 422,
  /** The envelope is already terminal (completed, declined, voided or expired). */
  envelope_not_open: 409,
  /** The connection cannot be replaced or removed while envelopes are still open. */
  envelopes_open: 409,
  /** The document's ceremony is `esign`: accept it by signing, not by click-wrap. */
  esign_required: 409,
  /** Starting an e-sign NDA needs the ESIGN consent to electronic records (not pre-ticked). */
  esign_consent_required: 422,
  /** The NDA version the envelope was for is no longer the document's current version. */
  nda_version_superseded: 409,
  /** The connection cannot be removed while a live legal document uses the `esign` ceremony. */
  esign_ceremony_in_use: 409,
  /**
   * Saving a same-provider connection whose base URL changed: every stored secret must be typed
   * again (never sent to a new host). `details.reason` is `base_url_changed`, `details.fields` the
   * credential keys to re-enter.
   */
  esign_credentials_required: 422,
  /**
   * The NDA's title or body has characters the e-signature PDF cannot show (it would sign altered
   * text). `details.field` is `title`|`body`, `details.characters` up to ten of them.
   */
  esign_nda_text_unsupported: 422,
  /** The `esign` ceremony is only for `nda` documents (E3.5 fix B4). */
  esign_ceremony_unsupported: 422,
  /**
   * Round closing (E3.5 §6): a subscription agreement has nobody to go to — the commitment names
   * no member (or the member has no email address) and the request gave no signer.
   */
  signer_email_missing: 422,
  // integrations hub (E3.6, ADR-0054)
  /** The operator has not configured this provider's OAuth client (INTEGRATIONS_<P>_CLIENT_ID/_SECRET). */
  integration_not_available: 409,
  /** The provider connects through OAuth (`POST /integrations/{provider}/oauth/begin`), not a pasted secret. */
  integration_oauth_required: 409,
  /** The workspace has no live connection to this provider. */
  integration_not_connected: 404,
  /** The vendor refused the credentials on connect/verify. `details.reason` is the port's failure. */
  integration_credentials_rejected: 422,
  /** A full-access secret key (`sk_…`) was pasted where a restricted key (`rk_…`) is required. */
  integration_secret_key_refused: 422,
  /**
   * Confirming an OAuth connection failed: the pending token is unknown, expired, already used,
   * for another provider or started by another member (one answer for all of them).
   */
  integration_oauth_pending_invalid: 404,
  /** The external account (e.g. a Xero organisation) is not one this connection can reach. */
  integration_account_unknown: 422,
  /** A booking link's URL is not https on one of the provider's booking hosts. */
  booking_link_invalid_url: 422,
  /** The workspace already has the maximum number of booking links (10). */
  booking_link_limit: 409,
  /** The path names a provider this install does not know. */
  unknown_provider: 404,
  /** metrics (E3.6): only month-period, non-formula definitions may be bound to a KPI source. */
  binding_period_unsupported: 422,
  /** notify (E3.6): the Slack channel id is not one the Slack app can post to. */
  slack_channel_unknown: 422,
  /** captable (E3.6): the CSV could not be imported; `details` carries the row/column problems. */
  captable_import_invalid: 422,
  // accreditation vendors (E3.7, ADR-0055)
  /**
   * Saving or re-verifying an accreditation vendor connection: the live credential check failed.
   * `details.fields` (optional) names the credential keys at fault, `details.reason` why.
   */
  accreditation_credentials_invalid: 422,
  /** The operator does not offer this accreditation vendor (`ACCREDITATION_DRIVERS`). */
  accreditation_driver_not_offered: 422,
  /** The accreditation vendor was unreachable or failed a call. `details.providerCode` is the port's code. */
  accreditation_provider_error: 502,
  // staff SSO + SCIM (E3.8, ADR-0056)
  /**
   * The workspace enforces SSO for staff and this session was not established through the
   * workspace's own connection (`details.reason: "enforced"`). Owners at auth level 2 are admitted
   * (break-glass); externals are never affected.
   */
  sso_required: 403,
  /**
   * The session was established through one workspace's SSO connection, so it may not change the
   * global account: sign-in factors, password, recovery codes, other sessions or devices, the
   * user's own settings. Sign in another way (email code, passkey) to do that. Step-up with an
   * already-enrolled factor stays allowed.
   */
  sso_session_restricted: 403,
  /** The workspace has no live SSO connection (or its protocol is no longer offered). */
  sso_not_configured: 404,
  /** The workspace's SSO connection exists but is disabled. */
  sso_disabled: 409,
  /**
   * Saving an SSO connection: the configuration did not verify. `details.reason` is one of
   * `discovery_failed | issuer_mismatch | invalid_metadata | invalid_certificate |
   * secret_required | protocol_unavailable`.
   */
  sso_invalid_config: 400,
  /**
   * Turning enforcement on needs an enabled connection that has completed a login or a test
   * (`details.reason: "not_enabled" | "never_signed_in"`).
   */
  sso_enforce_precondition: 409,
  /** The domain is already verified by another workspace. */
  sso_domain_taken: 409,
  /** Not a registrable hostname (or a public suffix / reserved name). */
  sso_domain_invalid: 400,
  /** The DNS TXT check failed; `details.reason` says why. */
  sso_domain_unverified: 409,
  /** A workspace may hold at most two live SCIM tokens. */
  scim_token_limit: 409,
  /** SCIM is switched off on this install (`SCIM_ENABLED=false`). */
  scim_disabled: 404,
  // managed-host control plane (E3.10, ADR-0058). Operator denials, a closed signup and the
  // control plane being off are all plain `not_found`: none of them is an oracle.
  /**
   * The workspace is served by another cell (`CONTROL_PLANE=on`). The response carries
   * `X-Fundroom-Cell: <cellId>` (and, for one minor release, the deprecated `X-Seedhost-Cell`) so an
   * edge can retry there; no other detail.
   */
  wrong_cell: 421,
  /**
   * The workspace is suspended or held for review; only sign-in, the bootstrap and (for billing
   * managers) billing still answer. Staff only: investors, anonymous callers and API keys get
   * `not_found` instead.
   */
  workspace_unavailable: 423,
  /**
   * The workspace's plan does not allow this. A quota (`details.limit`: `staffSeats |
   * investorSeats | storageBytes | customDomains`, `details.max`), or an entitlement (A-3,
   * ADR-0063): `details.limit: "module"` + `details.module` (turning the module on, or a staff
   * write to a module that is read-only on the plan) or `details.limit: "feature"` +
   * `details.feature` (turning the feature on). Only ever after the route's own authentication
   * and authorization passed, so it is never an oracle.
   */
  plan_limit: 402,
  /** This install bills manually: the operator records the subscription; there is no checkout. */
  billing_manual: 409,
  /** Billing is not available for this workspace yet (no plan with a price, no customer). */
  billing_unavailable: 409,
  /** Unsuspending a sanctions suspension needs the latest screening to be decided `cleared`. */
  sanctions_unresolved: 409,
  /**
   * The session was handed to this workspace's host by central auth, so it is bound to this
   * workspace and may not change the global account (as `sso_session_restricted` is for SSO).
   */
  bound_session_restricted: 403,
  /**
   * The slug is already a workspace (self-service signup, operator provisioning; E3.11: also a
   * slug held by a workspace on another cell in the shared directory — never naming it).
   */
  slug_taken: 409,
  // per-tenant data residency (E3.11, ADR-0059).
  /**
   * A move between cells is not possible: no shared directory (local mode), the target cell is
   * not accepting workspaces, or (PATCH `cellId` to a remote cell) `details.reason: "use_move"`.
   */
  move_unavailable: 409,
  /** A live move exists for this workspace already. */
  move_busy: 409,
  /** The shared cell directory could not be reached. */
  directory_unavailable: 503,
  /** This deployment declares no data region (DATA_REGION) and the action needs one. */
  region_not_declared: 409,
  /** The record changed since it was read (`version` mismatch); re-read and retry. */
  version_conflict: 409,
  // AI assist (E3.12, ADR-0060). Deliberately not authz-shaped: a caller learns only that the
  // feature is off, never whether a resource exists.
  /** AI assist is not configured on this install (AI_PROVIDER=none). */
  ai_unavailable: 409,
  /** AI assist (or this feature) is off for this workspace. */
  ai_disabled: 409,
  /** The current model provider has not been acknowledged for this workspace (`ai.manage`). */
  ai_acknowledgement_required: 409,
  /** Too many AI requests from this member this hour (`Retry-After`). */
  ai_rate_limited: 429,
  /** Too many AI requests in flight for this workspace; try again shortly. */
  ai_busy: 429,
  /** The workspace's monthly AI token budget is spent (`Retry-After` to the next UTC month). */
  ai_budget_exhausted: 429,
  // Forensic watermark detection (E3.13, ADR-0061). Staff-only route; see data-room contracts.
  /** The uploaded image is undecodable, too large (> 15 MiB / 50 MP) or too small (< 200 px wide). */
  forensic_image_invalid: 422,
  /** This document version was never served with a forensic mark: nobody to test against. */
  forensic_no_marks: 409,
  /** The image could not be registered onto the page (wrong page, rotated, heavily cropped). */
  forensic_alignment_failed: 422,
  /** More recipients than one detection tests (2,000); narrow by version. */
  forensic_too_many_candidates: 422,
  /** Too many detection runs by this member this hour (`Retry-After`). */
  forensic_rate_limited: 429,
  /** Every forensic detection slot of this server is busy; try again shortly (`Retry-After`). */
  forensic_busy: 503,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
  service_unavailable: 503,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;
export type ApiErrorStatus = (typeof API_ERROR_CODES)[ApiErrorCode];

export const API_ERROR_CODE_LIST = Object.keys(API_ERROR_CODES) as readonly ApiErrorCode[];

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: ApiErrorStatus;
  readonly details: Readonly<Record<string, unknown>>;
  /** Extra response headers (`Retry-After`, `Allow`). */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    readonly code: ApiErrorCode,
    message?: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions & { readonly headers?: Readonly<Record<string, string>> },
  ) {
    super(message ?? code.replace(/_/gu, " "), options?.cause === undefined ? undefined : options);
    this.status = API_ERROR_CODES[code];
    this.details = details;
    this.headers = options?.headers ?? {};
  }

  toBody(requestId?: string): ErrorBody {
    return {
      error: {
        ...this.details,
        code: this.code,
        message: this.message,
        ...(requestId === undefined ? {} : { requestId }),
      },
    };
  }
}

export function isApiError(error: unknown, code?: ApiErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

/**
 * Anything with `{ code, status, message, details? }` (identity's `AuthError`, a module's own
 * error class) becomes an `ApiError` when the code is in the catalogue and the status agrees.
 */
export function toApiError(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as { code?: unknown; status?: unknown; message?: unknown; details?: unknown };
  if (typeof e.code !== "string" || !(e.code in API_ERROR_CODES)) return undefined;
  const code = e.code as ApiErrorCode;
  if (typeof e.status === "number" && e.status !== API_ERROR_CODES[code]) return undefined;
  const details =
    typeof e.details === "object" && e.details !== null
      ? (e.details as Record<string, unknown>)
      : {};
  const headers: Record<string, string> = {};
  const retry = details["retryAfterMs"];
  if (typeof retry === "number")
    headers["Retry-After"] = String(Math.max(1, Math.ceil(retry / 1000)));
  return new ApiError(code, typeof e.message === "string" ? e.message : undefined, details, {
    cause: error,
    headers,
  });
}

export const ErrorCodeSchema = z
  .enum(API_ERROR_CODE_LIST as [ApiErrorCode, ...ApiErrorCode[]])
  .openapi("ErrorCode");

export const ValidationIssueSchema = z
  .object({
    path: z
      .string()
      .openapi({ example: "body.email", description: "Dotted path into the request part" }),
    message: z.string().openapi({ example: "Invalid email address" }),
    code: z.string().openapi({ example: "invalid_format" }),
  })
  .openapi("ValidationIssue");

export const ErrorBodySchema = z
  .object({
    error: z
      .object({
        code: ErrorCodeSchema,
        message: z.string().openapi({ example: "sign in to continue" }),
        requestId: z
          .string()
          .optional()
          .openapi({ example: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a" }),
        issues: z.array(ValidationIssueSchema).optional(),
      })
      .catchall(z.unknown()),
  })
  .openapi("Error");

export type ErrorBody = z.infer<typeof ErrorBodySchema>;
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/** Zod issues → the documented shape (paths only, never the offending value). */
export function validationIssues(
  issues: readonly { path: PropertyKey[]; message: string; code: string }[],
  part?: string,
): ValidationIssue[] {
  return issues.map((i) => ({
    path: [part, ...i.path.map(String)].filter((p): p is string => p !== undefined).join("."),
    message: i.message,
    code: i.code,
  }));
}
