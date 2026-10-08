/**
 * Accredited-investor verification (E2.5, design/04 §1.6, Rule 506(c)).
 *
 * Under Rule 506(c) an issuer may generally solicit only if it takes **reasonable steps to
 * verify** that every purchaser is accredited — the investor's own word is not enough, which is
 * exactly where E2.3's self-certification stops. This port is the seam behind that second step:
 * a verification is *started* for a member, somebody or something decides, and the decision comes
 * back with the method it was reached by.
 *
 * It is deliberately two methods. The shipped adapter (`@fundroom/accred-manual`) has a human
 * on the other end — an admin reads the uploaded evidence and decides — so `start` cannot answer
 * anything but `pending`, and `check` is what a future vendor adapter (a verification bureau, a
 * letter-of-accreditation service) will poll. Everything else a verification needs — the evidence
 * blob, its scan verdict, the retention clock, the audit trail — belongs to the round module and
 * the kernel ports it already has (`storage`, `crypto`, `scanner`), not here: a port that owned
 * the file would have to own encryption and purging with it, and no vendor's API works that way.
 *
 * What this port must never do is decide *for* the tenant. `verified` without evidence is refused
 * by the service above it (design/04 §1.6); an adapter that answered `verified` out of `start`
 * would be claiming an issuer took reasonable steps it never took.
 */
import type { Jurisdiction } from "./residency.js";

/** Adapter ids accepted by `ACCREDITATION_DRIVER`. One today; the shape is the point. */
export const ACCREDITATION_DRIVERS = ["manual"] as const;

export interface AccreditationVerificationStart {
  readonly workspaceId: string;
  readonly membershipId: string;
  /** The `round.verification` row this attempt belongs to; the adapter's correlation key. */
  readonly verificationId: string;
  readonly subject: "individual" | "entity";
  /** ISO 3166-1 alpha-2 when the caller knows it; jurisdiction profiles are later work. */
  readonly jurisdiction?: string;
}

export interface AccreditationVerificationState {
  readonly status: "pending" | "verified" | "rejected";
  /** The provider's own handle for the attempt, stored on the row so `check` can find it. */
  readonly providerRef?: string;
  /** When the decision stops standing; absent means the service applies its own default. */
  readonly expiresAt?: Date;
  readonly method?:
    | "document_review"
    | "third_party"
    | "professional_letter"
    | "minimum_investment";
}

export interface AccreditationVerificationPort {
  readonly driver: string;
  /**
   * What the flow above has to arrange before this adapter can produce a decision:
   * `evidenceUpload` — the investor must be offered a file upload; `adminDecision` — a human
   * settles it, so no amount of polling will change the answer on its own.
   */
  readonly requires: { readonly evidenceUpload: boolean; readonly adminDecision: boolean };
  start(input: AccreditationVerificationStart): Promise<AccreditationVerificationState>;
  check(input: { readonly providerRef: string }): Promise<AccreditationVerificationState>;
}

/* -------------------------------------------------------------------------------------------------
 * Vendor adapters (E3.7). A vendor account belongs to the issuer (the workspace): credentials are a
 * per-workspace connection sealed under the workspace key, owned by the kernel `@fundroom/accreditation`.
 * Adapters are stateless translators bound to one connection:
 * - a vendor callback is only a wake-up — `parseCallback` authenticates it and returns refs to re-check;
 *   the service re-reads `check()` over the authenticated API and never trusts the callback body;
 * - adapters use only `deps.fetch` (the guarded outbound client, no redirects);
 * - credentials never appear in an error message, a log line, or a returned value.
 * ---------------------------------------------------------------------------------------------- */

export const ACCREDITATION_VENDOR_DRIVERS = ["verifyinvestor", "parallel-markets"] as const;
export type AccreditationVendorDriver = (typeof ACCREDITATION_VENDOR_DRIVERS)[number];
export type AccreditationDriver = "manual" | AccreditationVendorDriver;

/** A credential the admin types into the connection form. `secret` fields are sealed and never echoed. */
export interface AccreditationCredentialField {
  readonly key: string;
  readonly label: string;
  readonly kind: "text" | "secret" | "select";
  readonly options?: readonly string[] | undefined;
  readonly required: boolean;
  readonly help?: string | undefined;
}

export interface AccreditationVendorMeta {
  readonly driver: AccreditationVendorDriver;
  /** "VerifyInvestor.com", "Parallel Markets". */
  readonly label: string;
  /** VerifyInvestor emails the investor; Parallel needs its JS SDK page. */
  readonly handoff: "invite_email" | "widget";
  readonly supportsEntities: boolean;
  /** Can fetch a PDF certificate/letter. */
  readonly certificate: boolean;
  /** Human text, e.g. "X-Signature-SHA256 HMAC". */
  readonly callbackSignature: string;
  readonly subProcessor: {
    readonly name: string;
    readonly purpose: string;
    readonly location: string;
    readonly url: string;
    /** E3.11: machine jurisdiction for out-of-region flags (`@fundroom/compliance` normalises). */
    readonly jurisdiction?: Jurisdiction | "varies" | undefined;
  };
}

export type AccreditationHandoff =
  /** manual: the investor uploads evidence. */
  | { readonly kind: "upload" }
  /** The vendor emailed the investor. */
  | { readonly kind: "invite_sent" }
  /** An https vendor page (not used by v1 adapters; reserved). */
  | { readonly kind: "redirect"; readonly url: string }
  | {
      readonly kind: "widget";
      readonly sdk: "parallel-markets";
      readonly config: {
        readonly clientId: string;
        readonly environment: "demo" | "production";
        readonly requiredEntityId: string;
        readonly email: string;
        readonly firstName?: string | undefined;
        readonly lastName?: string | undefined;
        readonly entityType: "self" | "business";
      };
    };

export interface AccreditationVendorStartInput {
  /** Correlation (external_id / identifier). */
  readonly verificationId: string;
  readonly subject: "individual" | "entity";
  readonly email: string;
  readonly firstName?: string | undefined;
  readonly lastName?: string | undefined;
  readonly legalName?: string | undefined;
  /** Workspace display name. */
  readonly portalName?: string | undefined;
}

export interface AccreditationVendorStartResult {
  /** Opaque, ≤200 chars. */
  readonly providerRef: string;
  readonly handoff: Exclude<AccreditationHandoff, { kind: "upload" }>;
  readonly vendorStatus?: string | undefined;
}

export type AccreditationVendorStatus =
  | "in_progress"
  | "needs_investor_action"
  | "under_review"
  | "accredited"
  | "not_accredited"
  | "expired"
  | "canceled"
  | "unknown";

export interface AccreditationVendorCheck {
  readonly status: AccreditationVendorStatus;
  /** Raw vendor value, ≤100 chars, kept verbatim. */
  readonly vendorStatus: string;
  /** Set when the ref upgraded (VerifyInvestor `inv:` → `vr:`). */
  readonly providerRef?: string | undefined;
  readonly expiresAt?: Date | undefined;
  readonly decidedAt?: Date | undefined;
  /** Vendor method/assertion type, raw (≤100). */
  readonly assertion?: string | undefined;
  /** ≤200. */
  readonly rejectionReason?: string | undefined;
}

export interface AccreditationEvidence {
  readonly contentType: "application/pdf";
  readonly bytes: Uint8Array;
}

export class AccreditationProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unauthorized"
      | "not_found"
      | "rate_limited"
      | "unavailable"
      | "invalid_request"
      | "conflict"
      | "not_connected",
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AccreditationProviderError";
  }
}

export interface AccreditationVendorPort {
  readonly driver: AccreditationVendorDriver;
  /** Throws AccreditationProviderError. */
  verifyCredentials(): Promise<void>;
  start(input: AccreditationVendorStartInput): Promise<AccreditationVendorStartResult>;
  check(input: { readonly providerRef: string }): Promise<AccreditationVendorCheck>;
  /** ≤10 MiB. */
  fetchEvidence(input: { readonly providerRef: string }): Promise<AccreditationEvidence | null>;
  /** Constant-time; never throws; undefined = not authentic. Returns provider refs to wake (≤20). */
  parseCallback(input: {
    readonly headers: Headers;
    readonly rawBody: Uint8Array;
    readonly now: Date;
  }): Promise<{ readonly refs: readonly string[] } | undefined>;
}

export interface AccreditationConnectionConfig {
  readonly credentials: Readonly<Record<string, string>>;
}

export interface AccreditationAdapterDeps {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly log?: ((event: string, fields?: Record<string, unknown>) => void) | undefined;
  /** Test seam only: replaces the vendor's fixed API base URL. */
  readonly apiBaseUrl?: string | undefined;
}

export interface AccreditationAdapterDefinition {
  readonly meta: AccreditationVendorMeta;
  readonly credentialFields: readonly AccreditationCredentialField[];
  create(
    config: AccreditationConnectionConfig,
    deps: AccreditationAdapterDeps,
  ): AccreditationVendorPort;
}

export const ACCREDITATION_CALLBACK_PATH_PREFIX = "/webhooks/accreditation/";
/** Parallel's client redirect URI must match this page exactly (per workspace host). */
export const ACCREDITATION_HANDOFF_PATH = "/api/v1/round/current/verification/handoff";
