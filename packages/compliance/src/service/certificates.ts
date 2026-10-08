import type { TenantContext, Tx } from "@fundroom/db";

/*
 * The click-wrap certificate seam (E2.3, contract D1/D2/§5.4).
 *
 * `@fundroom/clickwrap` builds and stores the certificate; this package only knows that
 * something can. The shape below is declared **here**, structurally, and clickwrap implements it
 * without either package importing the other — the composition root wires them. That is the same
 * pattern identity uses for `ShareLinkAccess`, and it exists for the same reason: compliance is
 * kernel, the certificate is an epic's machinery, and the dependency must not run that way.
 *
 * Click-wrap is deliberately not an `ESignPort` adapter (D1, confirmed by ADR-0053 in E3.5): it is
 * synchronous and in-process; vendor e-sign is asynchronous envelopes with webhooks and status
 * polling (`@fundroom/esign`). An e-signed NDA is recorded through `accept()` with
 * `evidence.method = "esign"`, which issues no certificate here.
 */

/**
 * The acceptance the certificate attests to, plus the audit anchor it must cite.
 *
 * `acceptanceSeq`/`acceptanceHash` come from the `legal.document_accepted` row written moments
 * earlier in the same transaction, which is what binds the certificate to the audit chain in both
 * directions: the JSON cites the acceptance event, and the `legal.certificate_issued` event the
 * issuer writes cites the JSON's sha256. No cycle, no second hash chain (D2).
 */
export interface IssueCertificateInput {
  readonly attestationId: string;
  readonly membershipId: string;
  readonly documentId: string;
  readonly slug: string;
  readonly title: string;
  readonly versionNo: number;
  /** `<slug>:v<n>` — what the signer is recorded as having accepted. */
  readonly stamp: string;
  /** Hex sha256 of the body the signer was shown, read from the stored version, never the client. */
  readonly bodySha256: string;
  readonly acceptedAt: Date;
  /** The `legal.document_accepted` audit row this certificate is anchored to. */
  readonly acceptanceSeq: number;
  readonly acceptanceHash: string;
  /** Browser family only — never a User-Agent string (ADR-0036). */
  readonly uaFamily?: string | undefined;
  /** Keyed HMAC of the address, hex — never an address. */
  readonly ipHash?: string | undefined;
  /** The name the signer typed, when the ceremony asked for one (`design/04` §4.3). */
  readonly typedName?: string | undefined;
  /** The share link the signer came in through, when they did (E2.3). */
  readonly viaLinkId?: string | undefined;
}

export interface IssuedCertificate {
  /** Storage reference; goes into `attestation.evidence_ref`. */
  readonly reference: string;
  /** Hex sha256 of the canonical JSON — the certificate's own identity. */
  readonly sha256: string;
}

export interface CertificateBytes {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface CertificateIssuer {
  issue(ctx: TenantContext, tx: Tx, input: IssueCertificateInput): Promise<IssuedCertificate>;
  fetch(
    ctx: TenantContext,
    tx: Tx,
    reference: string,
    as: "json" | "pdf",
  ): Promise<CertificateBytes | undefined>;
}

/**
 * Issues a certificate if — and only if — an issuer is wired.
 *
 * With no issuer this returns `undefined` **without touching the transaction, the audit log or
 * anything else**, so an acceptance in a deployment that has no clickwrap package behaves exactly
 * as it did before E2.3: the attestation row, the audit row, the ACL bump, and a null
 * `evidence_ref`. That is not a degraded mode to be tidied up later; it is the contract, because
 * every existing compliance test and every existing tenant depends on it.
 *
 * A failing issuer is a different matter and is left to throw. The certificate and the acceptance
 * are written in one transaction on purpose: an acceptance that claims a certificate reference
 * nobody stored would be worse evidence than no certificate at all.
 */
export async function issueCertificate(
  certificates: CertificateIssuer | undefined,
  ctx: TenantContext,
  tx: Tx,
  input: IssueCertificateInput,
): Promise<IssuedCertificate | undefined> {
  if (certificates === undefined) return undefined;
  return certificates.issue(ctx, tx, input);
}
