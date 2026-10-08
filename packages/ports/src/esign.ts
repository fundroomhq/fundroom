/**
 * Electronic signature over a vendor's HTTP API (E3.5, ADR-0053). One adapter package per vendor:
 * `@fundroom/esign-documenso`, `@fundroom/esign-docuseal` (self-hostable), `@fundroom/esign-docusign`,
 * `@fundroom/esign-dropbox-sign`. The kernel service `@fundroom/esign` owns connections, envelopes,
 * sync jobs and artifact storage; adapters are stateless translators bound to one workspace connection.
 *
 * Click-wrap is deliberately NOT an adapter of this port: a synchronous click-wrap acceptance and an
 * asynchronous vendor envelope do not share a shape (ADR-0041 §7, ADR-0053).
 *
 * Security rules every adapter follows:
 * - a vendor callback is only a wake-up: `parseCallback` authenticates it, and the service then
 *   re-pulls `status()` and acts on that answer, never on the callback body;
 * - adapters use only `deps.fetch` (the guarded outbound client, no redirects) and never build their own;
 * - credentials and secrets never appear in an error message, a `detail`, or a log line.
 */
import type { Jurisdiction } from "./residency.js";

export const ESIGN_DRIVERS = ["documenso", "docuseal", "docusign", "dropbox-sign"] as const;
export type ESignDriver = (typeof ESIGN_DRIVERS)[number];

/** A credential the admin types into the connection form. `secret` fields are sealed and never echoed. */
export interface ESignCredentialField {
  /** e.g. "apiToken", "integrationKey", "privateKeyPem". */
  readonly key: string;
  /** English label; web i18n keys by `esign.field.<driver>.<key>`. */
  readonly label: string;
  readonly kind: "text" | "secret" | "pem" | "select";
  /** For "select", e.g. ["demo","production"]. */
  readonly options?: readonly string[] | undefined;
  readonly required: boolean;
  readonly help?: string | undefined;
}

export interface ESignVendorMeta {
  readonly driver: ESignDriver;
  /** "Documenso", "DocuSeal", "DocuSign", "Dropbox Sign". */
  readonly displayName: string;
  /** documenso, docuseal: true. */
  readonly selfHostable: boolean;
  /** Self-hosted: the admin supplies the base URL. */
  readonly baseUrl: { readonly required: boolean; readonly default?: string | undefined };
  readonly supports: {
    /** Envelope from a vendor-side template with prefill. */
    readonly templates: boolean;
    /** Envelope from our PDF + coordinate fields. */
    readonly pdf: boolean;
    /** `signingUrl()` can return a URL. */
    readonly embeddedSigning: boolean;
    readonly void: boolean;
  };
  /** Callback verification: who generates the secret. "ours" = we generate `callbackSecret` and the admin
   *  pastes it into the vendor; "vendor" = the vendor generates it and the admin pastes it into our form
   *  (it is then one of `credentialFields`). */
  readonly callbackSecret: "ours" | "vendor";
  readonly subProcessor: {
    readonly name: string;
    readonly purpose: string;
    readonly region: string;
    readonly dpaUrl: string;
    readonly certifications: readonly string[];
    /** E3.11: machine jurisdiction for out-of-region flags (`@fundroom/compliance` normalises). */
    readonly jurisdiction?: Jurisdiction | "varies" | undefined;
  };
}

/** Field geometry: fractions of the page, origin top-left, page is 1-based. */
export interface ESignField {
  readonly signerKey: string;
  readonly kind: "signature" | "date" | "name";
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ESignSigner {
  /** Our stable key, "s1", "s2", … */
  readonly signerKey: string;
  readonly name: string;
  readonly email: string;
  /** Template role name, required for template envelopes. */
  readonly role?: string | undefined;
  /** 1-based signing order. */
  readonly order: number;
}

export type ESignDocumentSource =
  | {
      readonly kind: "pdf";
      readonly filename: string;
      readonly bytes: Uint8Array;
      readonly fields: readonly ESignField[];
    }
  | {
      readonly kind: "template";
      readonly templateRef: string;
      readonly prefill: Readonly<Record<string, string>>;
    };

export interface ESignEnvelopeInput {
  /** Our core.esign_envelope.id — adapters MUST send it to the vendor (metadata/external_id) and use it
   *  for idempotency where supported. */
  readonly externalId: string;
  readonly title: string;
  readonly message?: string | undefined;
  readonly document: ESignDocumentSource;
  readonly signers: readonly ESignSigner[];
  /** Where the vendor sends the signer after signing. */
  readonly redirectUrl?: string | undefined;
  /** true: we will ask signingUrl(); the vendor should not email the link. */
  readonly embedded: boolean;
}

export type ESignEnvelopeStatus =
  | "sent"
  | "delivered"
  | "completed"
  | "declined"
  | "voided"
  | "expired";
export type ESignSignerStatus = "pending" | "viewed" | "signed" | "declined";

export interface ESignEnvelopeState {
  readonly status: ESignEnvelopeStatus;
  readonly signers: readonly {
    readonly signerKey: string;
    readonly status: ESignSignerStatus;
    readonly at?: Date | undefined;
  }[];
  readonly completedAt?: Date | undefined;
}

export interface ESignArtifacts {
  /** The signed PDF. */
  readonly document: Uint8Array;
  /** Vendor audit trail / certificate PDF, when separate. */
  readonly certificate?: Uint8Array | undefined;
}

export interface ESignCallback {
  /** Whatever the (now authenticated) body names; used only to pick which envelope to re-pull. */
  readonly providerRef?: string | undefined;
  readonly externalId?: string | undefined;
  /** Vendor event name, for logs only. */
  readonly event: string;
}

export type ESignVerifyResult =
  | { readonly ok: true; readonly account?: string | undefined }
  | {
      readonly ok: false;
      readonly reason: "unauthorized" | "unreachable" | "misconfigured";
      readonly detail?: string | undefined;
    };

export type ESignProviderErrorCode =
  | "unauthorized"
  | "not_found"
  | "rejected"
  | "rate_limited"
  | "unavailable"
  | "invalid_response"
  | "too_large";

/** Thrown by adapters for vendor-side failures. `retryable` drives job retries. Never includes secrets. */
export class ESignProviderError extends Error {
  override readonly name = "ESignProviderError";
  constructor(
    message: string,
    readonly code: ESignProviderErrorCode,
    readonly retryable: boolean,
    readonly status?: number | undefined,
  ) {
    super(message);
  }
}

/** One port instance is bound to one workspace connection (its credentials). */
export interface ESignPort {
  readonly driver: ESignDriver;
  verifyCredentials(): Promise<ESignVerifyResult>;
  createEnvelope(input: ESignEnvelopeInput): Promise<{ readonly providerRef: string }>;
  status(providerRef: string): Promise<ESignEnvelopeState>;
  /** undefined when the vendor has no embedded/redirect signing for this envelope. */
  signingUrl(
    providerRef: string,
    signerKey: string,
    returnUrl: string,
  ): Promise<string | undefined>;
  downloadSigned(
    providerRef: string,
    limits: { readonly maxBytes: number },
  ): Promise<ESignArtifacts>;
  void(providerRef: string, reason: string): Promise<void>;
  /** Verify the callback's authenticity with this connection's secret. undefined = not authentic. Must be
   *  constant-time, must not throw on garbage, must bound any timestamp window it can (≤ 5 min skew). */
  parseCallback(request: {
    readonly headers: Headers;
    readonly body: Uint8Array;
  }): Promise<ESignCallback | undefined>;
}

export interface ESignConnectionConfig {
  /** Validated https origin (or allow-listed private host). */
  readonly baseUrl?: string | undefined;
  readonly credentials: Readonly<Record<string, string>>;
  /** Present when meta.callbackSecret === "ours". */
  readonly callbackSecret?: string | undefined;
}

export interface ESignAdapterDeps {
  /** The guarded outbound fetch (no redirects); adapters never build their own. */
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly log?: { warn(obj: object, msg?: string): void } | undefined;
}

export interface ESignAdapterDefinition {
  readonly meta: ESignVendorMeta;
  readonly credentialFields: readonly ESignCredentialField[];
  create(config: ESignConnectionConfig, deps: ESignAdapterDeps): ESignPort;
}
