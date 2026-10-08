import { randomUUID } from "node:crypto";
import { type AuditRecorder, sha256Hex } from "@fundroom/audit";
import { decryptStream, type EnvelopeService, encryptBytes, streamToBytes } from "@fundroom/crypto";
import type { TenantContext, Tx } from "@fundroom/db";
import type { ObjectStoragePort } from "@fundroom/ports";
import { type CertificateForm, certificateKey } from "@fundroom/storage";
import {
  assertValidCertificateDocument,
  type CertificateDocument,
  CertificateError,
  canonicalize,
  formatCertificateTimestamp,
} from "./document.js";
import { renderCertificatePdf } from "./pdf.js";

/*
 * Issuing a certificate (E2.3, ADR-0041 D2).
 *
 * The order below is the whole design, and it is why there is no second hash chain and no cycle:
 *
 *   1. the caller (`@fundroom/compliance`) has already written `core.attestation` and audited
 *      `legal.document_accepted`, and hands us that event's `seq` and `hash`;
 *   2. we build the canonical JSON, which *cites* that event, and hash it;
 *   3. we audit `legal.certificate_issued`, which *cites* the hash of the JSON, and keep that
 *      event's `seq` and `hash`;
 *   4. we store the encrypted JSON and the rendered PDF and hand back a reference, which the
 *      caller puts in `attestation.evidence_ref`.
 *
 * The acceptance cannot be back-dated or removed without breaking the chain after it, and the
 * certificate cannot be swapped for another without breaking step 3's event. `audit.anchor`
 * stays unused: this epic adds no external anchoring adapter, because the chain plus the daily
 * HMAC checkpoint (`audit.checkpoint`) is what we actually ship today.
 *
 * Everything runs in the caller's transaction. A failure anywhere rolls the acceptance back with
 * it. The one thing a rollback cannot undo is the object write: an orphaned pair of objects can
 * be left under a certificate id no row names, which is why `certificatePrefix` exists and why a
 * reconciliation sweep over `ws/<ws>/certificates/` has something unambiguous to compare against.
 */

/**
 * Exactly the shape `@fundroom/compliance` declares in `service/certificates.ts` (contract
 * §5.4, S2). Flat, because it mirrors what `AcceptanceService.accept()` has in its hand at the
 * moment it calls: the attestation it just wrote, the version it just validated, and the audit
 * row it just recorded.
 *
 * Note what is **not** here: the workspace's name and host, the signer's email digest and the
 * signer's display name. The frozen `CertificateDocument` needs all four, and none of them are
 * things the compliance service knows — the host is a per-request tenancy fact and the rest live
 * on `core.workspace` / `core.membership`, which this package must not query (only `repos/` may
 * touch drizzle). They arrive through `CertificateIssuerDeps.facts`, supplied by the composition
 * root, which knows all four.
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
  /** Hex sha256 of the body the signer was shown, read from the stored version. */
  readonly bodySha256: string;
  readonly acceptedAt: Date;
  /** The `legal.document_accepted` audit row this certificate is anchored to. */
  readonly acceptanceSeq: number;
  readonly acceptanceHash: string;
  /** Browser family only — never a User-Agent string (ADR-0036). */
  readonly uaFamily?: string | undefined;
  /** Keyed HMAC of the address, hex — never an address. */
  readonly ipHash?: string | undefined;
  /** The name the signer typed, when the ceremony asked for one (design/04 §4.3). */
  readonly typedName?: string | undefined;
  /** The share link the signer came in through, when they did. */
  readonly viaLinkId?: string | undefined;
}

/**
 * The four facts the certificate needs and the acceptance path does not carry.
 *
 * `host` is the workspace's canonical host as the request resolved it (a custom domain when one
 * is verified, otherwise the platform host). It is on the certificate because six years later
 * "which site was this?" is the first question, and a workspace id does not answer it.
 */
export interface CertificateFacts {
  readonly workspace: { readonly id: string; readonly name: string; readonly host: string };
  readonly signer: {
    /** sha256 of the verified address — hex or bytes. Never the address itself. */
    readonly emailSha256: string | Uint8Array;
    readonly displayName: string | null;
  };
}

export type CertificateFactsResolver = (
  ctx: TenantContext,
  tx: Tx,
  input: IssueCertificateInput,
) => Promise<CertificateFacts>;

export interface IssuedCertificate {
  /** Goes into `attestation.evidence_ref`; `fetch` takes it back. */
  readonly reference: string;
  /** sha256 of the canonical JSON — the digest the audit chain carries. */
  readonly sha256: string;
}

export interface CertificateBytes {
  readonly certificateId: string;
  readonly form: CertificateForm;
  readonly contentType: string;
  /** A sensible `Content-Disposition` filename for the download route (design/04 §4.6). */
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/**
 * The seam `@fundroom/compliance` declares for itself (ADR-0041 D1). Neither package imports
 * the other; the server wires this implementation into `ComplianceDeps.certificates`. Click-wrap
 * is not an `ESignPort` adapter (ADR-0053): it is synchronous and in-process, a vendor envelope is
 * asynchronous with webhooks. An e-signed acceptance (`method: "esign"`, E3.5) never reaches this
 * issuer — compliance skips it so the `esign:v1:<envelopeId>` evidence reference stands — and the
 * certificate document stays v1 with `method: "clickwrap"`.
 */
export interface CertificateIssuer {
  issue(ctx: TenantContext, tx: Tx, input: IssueCertificateInput): Promise<IssuedCertificate>;
  fetch(
    ctx: TenantContext,
    tx: Tx,
    reference: string,
    as: CertificateForm,
  ): Promise<CertificateBytes | undefined>;
}

export interface CertificateIssuerDeps {
  readonly audit: AuditRecorder;
  readonly crypto: EnvelopeService;
  readonly storage: ObjectStoragePort;
  /** Resolves what the acceptance path cannot supply; see `CertificateFacts`. */
  readonly facts: CertificateFactsResolver;
  /** Certificate ids are not database keys and order nothing; a v4 UUID is enough. */
  readonly newId?: (() => string) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REFERENCE_RE = /^cert:v1:([0-9a-f-]{36}):she1:([0-9a-f-]{36})$/u;

export interface CertificateReference {
  readonly certificateId: string;
  /** The `core.workspace_key` row whose DEK wrapped these objects (ADR-0016). */
  readonly keyId: string;
}

/**
 * `cert:v1:<certificateId>:she1:<keyId>`.
 *
 * The key id is in the reference rather than in the object's user metadata for the same reason
 * the data room keeps `blob.encryption` on the row: the database is the durable record, and a
 * bucket-level copy, re-upload or lifecycle transition can lose user metadata without losing
 * bytes. It is not a secret — the wrapped DEK never leaves Postgres and unwrapping it needs the
 * KMS — and it names nothing outside the workspace the reference already belongs to.
 *
 * The workspace id is deliberately *absent*: `fetch` builds the key from `ctx.workspaceId`, so a
 * reference copied into another tenant's row resolves under that tenant's own prefix and finds
 * nothing, rather than pointing at the original workspace's object.
 */
export function formatCertificateReference(ref: CertificateReference): string {
  if (!UUID_RE.test(ref.certificateId) || !UUID_RE.test(ref.keyId)) {
    throw new CertificateError("invalid_document", "certificate reference needs two UUIDs");
  }
  return `cert:v1:${ref.certificateId}:she1:${ref.keyId}`;
}

/** `undefined` for anything this package did not write — including an `ESignPort` reference. */
export function parseCertificateReference(reference: string): CertificateReference | undefined {
  const m = REFERENCE_RE.exec(reference);
  const certificateId = m?.[1];
  const keyId = m?.[2];
  if (certificateId === undefined || keyId === undefined) return undefined;
  if (!UUID_RE.test(certificateId) || !UUID_RE.test(keyId)) return undefined;
  return { certificateId, keyId };
}

function hex(value: string | Uint8Array): string {
  return typeof value === "string" ? value : Buffer.from(value).toString("hex");
}

const CONTENT_TYPE: Readonly<Record<CertificateForm, string>> = {
  json: "application/json",
  pdf: "application/pdf",
};

export function createCertificateIssuer(deps: CertificateIssuerDeps): CertificateIssuer {
  const newId = deps.newId ?? (() => randomUUID());
  const log = deps.log ?? (() => {});

  async function put(
    dek: Uint8Array,
    key: string,
    bytes: Uint8Array,
    form: CertificateForm,
    certificateSha256: string,
  ): Promise<void> {
    const ciphertext = await encryptBytes(dek, bytes);
    await deps.storage.put(key, ciphertext, {
      contentType: "application/octet-stream",
      contentLength: ciphertext.byteLength,
      metadata: {
        "sh-format": "she1",
        "sh-content-type": CONTENT_TYPE[form],
        // Not PII, and it lets a bucket-level sweep tie an object to an audit event with no
        // database at all.
        "sh-cert-sha256": certificateSha256,
      },
    });
  }

  return {
    async issue(ctx, tx, input) {
      const facts = await deps.facts(ctx, tx, input);
      const certificateId = newId();
      const doc: CertificateDocument = assertValidCertificateDocument({
        version: 1,
        certificateId,
        workspace: {
          id: facts.workspace.id,
          name: facts.workspace.name,
          host: facts.workspace.host,
        },
        signer: {
          membershipId: input.membershipId,
          emailSha256: hex(facts.signer.emailSha256),
          displayName: facts.signer.displayName,
          typedName: input.typedName ?? null,
        },
        document: {
          documentId: input.documentId,
          slug: input.slug,
          title: input.title,
          versionNo: input.versionNo,
          stamp: input.stamp,
          bodySha256: input.bodySha256,
        },
        acceptance: {
          acceptedAt: formatCertificateTimestamp(input.acceptedAt),
          method: "clickwrap",
          uaFamily: input.uaFamily ?? null,
          ipHash: input.ipHash ?? null,
          viaLinkId: input.viaLinkId ?? null,
        },
        anchor: { auditSeq: input.acceptanceSeq, auditHash: input.acceptanceHash },
      });

      const canonical = canonicalize(doc);
      const certificateSha256 = sha256Hex(canonical);

      // Step 3: the event that binds the chain to the certificate. Written before the bytes
      // exist, so a storage failure rolls it back with the acceptance.
      const issued = await deps.audit.record(tx, ctx, {
        action: "legal.certificate_issued",
        resourceKind: "certificate",
        resourceId: certificateId,
        subjectMembershipId: input.membershipId,
        meta: {
          certificateSha256,
          acceptanceSeq: input.acceptanceSeq,
          acceptanceHash: input.acceptanceHash,
          attestationId: input.attestationId,
          stamp: doc.document.stamp,
        },
      });

      const pdfBytes = await renderCertificatePdf(doc, {
        issuance: { auditSeq: issued.seq, auditHash: issued.hash },
      });

      const dek = await deps.crypto.currentKey(tx, ctx);
      await put(
        dek.key,
        certificateKey(ctx.workspaceId, certificateId, "json"),
        new TextEncoder().encode(canonical),
        "json",
        certificateSha256,
      );
      await put(
        dek.key,
        certificateKey(ctx.workspaceId, certificateId, "pdf"),
        pdfBytes,
        "pdf",
        certificateSha256,
      );

      log("clickwrap.certificate_issued", {
        workspaceId: ctx.workspaceId,
        certificateId,
        certificateSha256,
        auditSeq: issued.seq,
      });

      return {
        reference: formatCertificateReference({ certificateId, keyId: dek.keyId }),
        sha256: certificateSha256,
      };
    },

    async fetch(ctx, tx, reference, as) {
      const ref = parseCertificateReference(reference);
      if (ref === undefined) return undefined;
      const dek = await deps.crypto.keyById(tx, ctx, ref.keyId);
      if (dek === undefined) {
        // The key row is gone: the workspace was crypto-shredded (ADR-0016) and the bytes are
        // unrecoverable by design. Say so rather than returning "no such certificate".
        throw new CertificateError(
          "unreadable",
          "the key this certificate was sealed with is gone",
          {
            certificateId: ref.certificateId,
            keyId: ref.keyId,
          },
        );
      }
      const read = await deps.storage.get(certificateKey(ctx.workspaceId, ref.certificateId, as));
      if (read === undefined) return undefined;
      return {
        certificateId: ref.certificateId,
        form: as,
        contentType: CONTENT_TYPE[as],
        filename: `certificate-${ref.certificateId}.${as}`,
        bytes: await streamToBytes(decryptStream(dek.key, read.body)),
      };
    },
  };
}
