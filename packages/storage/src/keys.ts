import { assertObjectKey, StorageError } from "@fundroom/ports";

/*
 * Object key layout (EXECUTION_PLAN §8, design/06 §4, ADR-0006). Keys never contain original
 * filenames; everything under a workspace lives below `ws/<workspace_id>/` so a per-tenant
 * prefix can be listed, reconciled, purged or crypto-shredded as one unit.
 *
 *   ws/<ws>/blobs/<sha256>                       content-addressed, dedupe within a tenant only
 *   ws/<ws>/quarantine/<upload_id>               uploads awaiting scan/sanitise (E1.3)
 *   ws/<ws>/renditions/<version_id>/<kind>[/<n>] derived artefacts (pages, thumbs, watermarked)
 *   ws/<ws>/branding/<sha256>                    the workspace logo (E1.7), served from our origin
 *   ws/<ws>/certificates/<cert_id>/certificate.{json,pdf}
 *                                                click-wrap acceptance certificates (E2.3)
 *   ws/<ws>/esign/<envelope_id>/{signed,certificate}.pdf
 *                                                signed e-signature artifacts (E3.5)
 */
export const WORKSPACE_ROOT = "ws";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const KIND_RE = /^[a-z][a-z0-9_-]*$/u;

export type RenditionKind = "page" | "thumbnail" | "pdf" | "watermarked" | (string & {});

/**
 * The two forms one click-wrap certificate is stored in (E2.3, ADR-0041). `json` is the
 * canonical artefact — the bytes whose sha256 the audit chain cites — and `pdf` is a rendering
 * of it for a human who has nothing but a PDF reader.
 */
export const CERTIFICATE_FORMS = ["json", "pdf"] as const;
export type CertificateForm = (typeof CERTIFICATE_FORMS)[number];

/** The two artifacts one e-sign envelope can store (E3.5, ADR-0053). */
export const ESIGN_ARTIFACT_KINDS = ["signed", "certificate"] as const;
export type ESignArtifactKind = (typeof ESIGN_ARTIFACT_KINDS)[number];

export type ParsedObjectKey =
  | { readonly kind: "blob"; readonly workspaceId: string; readonly sha256: string }
  | { readonly kind: "quarantine"; readonly workspaceId: string; readonly uploadId: string }
  | {
      readonly kind: "rendition";
      readonly workspaceId: string;
      readonly versionId: string;
      readonly renditionKind: string;
      readonly index: number | undefined;
    }
  | { readonly kind: "branding"; readonly workspaceId: string; readonly sha256: string }
  | {
      readonly kind: "certificate";
      readonly workspaceId: string;
      readonly certificateId: string;
      readonly form: CertificateForm;
    }
  | {
      readonly kind: "esign_artifact";
      readonly workspaceId: string;
      readonly envelopeId: string;
      readonly which: ESignArtifactKind;
    }
  | { readonly kind: "other"; readonly workspaceId: string | undefined };

function assertUuid(value: string, what: string): string {
  if (!UUID_RE.test(value)) {
    throw new StorageError("invalid_key", `${what} must be a UUID`, { key: value });
  }
  return value.toLowerCase();
}

/** `ws/<workspaceId>` — the prefix `list()` walks for a tenant. */
export function workspacePrefix(workspaceId: string): string {
  return `${WORKSPACE_ROOT}/${assertUuid(workspaceId, "workspaceId")}`;
}

/** `ws/<ws>/blobs/<sha256>`; the digest is of the *plaintext* bytes (design/06 §4). */
export function blobKey(workspaceId: string, sha256Hex: string): string {
  const digest = sha256Hex.toLowerCase();
  if (!SHA256_RE.test(digest)) {
    throw new StorageError("invalid_key", "sha256 must be 64 hex characters", { key: sha256Hex });
  }
  const key = `${workspacePrefix(workspaceId)}/blobs/${digest}`;
  assertObjectKey(key);
  return key;
}

/**
 * `ws/<ws>/branding/<sha256>` — the workspace's logo (E1.7). Content-addressed like a blob but
 * in an area of its own: the bytes are served unauthenticated from `GET /branding/logo` (an
 * email client fetching an `<img src>` carries no session), and keeping them out of `blobs/`
 * keeps "public by design" and "private by default" visibly separate in the bucket.
 */
export function brandingLogoKey(workspaceId: string, sha256Hex: string): string {
  const digest = sha256Hex.toLowerCase();
  if (!SHA256_RE.test(digest)) {
    throw new StorageError("invalid_key", "sha256 must be 64 hex characters", { key: sha256Hex });
  }
  const key = `${workspacePrefix(workspaceId)}/branding/${digest}`;
  assertObjectKey(key);
  return key;
}

/**
 * `ws/<ws>/certificates/<certificateId>/certificate.<form>` — a click-wrap acceptance
 * certificate (E2.3, design/04 §4.1 "rendered PDF stored").
 *
 * An area of its own rather than a rendition or a blob, for three reasons. It is not
 * content-addressed: the canonical JSON's own sha256 is the evidence anchor and lives in the
 * audit chain, so addressing the object by digest would put the anchor in a place a bucket
 * owner can rename. It is not derived from a document version, so `renditions/<version_id>/`
 * is the wrong parent — a certificate outlives the version it cites. And a retention or legal
 * hold policy applies to this prefix as a unit: `certificatePrefix` is what a purge job must
 * refuse to touch while an offering's records are still in their retention window.
 *
 * Both forms live under a per-certificate prefix so one certificate is one listable,
 * copyable, purgeable unit. The bytes are SHE1 ciphertext under the workspace DEK (ADR-0016)
 * and are served only through the app with per-request authz (ADR-0015), never presigned.
 */
export function certificateKey(
  workspaceId: string,
  certificateId: string,
  form: CertificateForm,
): string {
  if (!(CERTIFICATE_FORMS as readonly string[]).includes(form)) {
    throw new StorageError("invalid_key", `certificate form ${JSON.stringify(form)} is invalid`);
  }
  const key = `${certificatePrefix(workspaceId, certificateId)}certificate.${form}`;
  assertObjectKey(key);
  return key;
}

/** Prefix holding every form of one certificate. */
export function certificatePrefix(workspaceId: string, certificateId: string): string {
  return `${workspacePrefix(workspaceId)}/certificates/${assertUuid(certificateId, "certificateId")}/`;
}

/**
 * `ws/<ws>/esign/<envelopeId>/{signed,certificate}.pdf` — a completed envelope's signed document
 * and the vendor's certificate (E3.5). SHE1 under a per-object key of purpose `esign-artifact`,
 * retained under legal hold with the envelope, served only through the app (never presigned).
 */
export function esignArtifactKey(
  workspaceId: string,
  envelopeId: string,
  which: ESignArtifactKind,
): string {
  if (!(ESIGN_ARTIFACT_KINDS as readonly string[]).includes(which)) {
    throw new StorageError("invalid_key", `e-sign artifact ${JSON.stringify(which)} is invalid`);
  }
  const key = `${esignArtifactPrefix(workspaceId, envelopeId)}${which}.pdf`;
  assertObjectKey(key);
  return key;
}

/** Prefix holding one envelope's artifacts. */
export function esignArtifactPrefix(workspaceId: string, envelopeId: string): string {
  return `${workspacePrefix(workspaceId)}/esign/${assertUuid(envelopeId, "envelopeId")}/`;
}

/** `ws/<ws>/quarantine/<uploadId>` — where an upload lands before the scan job promotes it. */
export function quarantineKey(workspaceId: string, uploadId: string): string {
  const key = `${workspacePrefix(workspaceId)}/quarantine/${assertUuid(uploadId, "uploadId")}`;
  assertObjectKey(key);
  return key;
}

/** `ws/<ws>/renditions/<versionId>/<kind>[/<index>]`. */
export function renditionKey(
  workspaceId: string,
  versionId: string,
  kind: RenditionKind,
  index?: number,
): string {
  if (!KIND_RE.test(kind)) {
    throw new StorageError("invalid_key", `rendition kind ${JSON.stringify(kind)} is invalid`);
  }
  if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
    throw new StorageError("invalid_key", "rendition index must be a non-negative integer");
  }
  const base = `${workspacePrefix(workspaceId)}/renditions/${assertUuid(versionId, "versionId")}/${kind}`;
  const key = index === undefined ? base : `${base}/${index}`;
  assertObjectKey(key);
  return key;
}

/** Prefix of every rendition of one document version (deleted first on purge). */
export function renditionPrefix(workspaceId: string, versionId: string): string {
  return `${workspacePrefix(workspaceId)}/renditions/${assertUuid(versionId, "versionId")}/`;
}

/** Classifies a key produced by this module; foreign keys come back as `other`. */
export function parseObjectKey(key: string): ParsedObjectKey {
  assertObjectKey(key);
  const parts = key.split("/");
  if (parts[0] !== WORKSPACE_ROOT || parts.length < 3 || !UUID_RE.test(parts[1] ?? "")) {
    return { kind: "other", workspaceId: undefined };
  }
  const workspaceId = (parts[1] as string).toLowerCase();
  const [, , area, a, b, c] = parts;
  if (area === "blobs" && parts.length === 4 && a !== undefined && SHA256_RE.test(a)) {
    return { kind: "blob", workspaceId, sha256: a };
  }
  if (area === "branding" && parts.length === 4 && a !== undefined && SHA256_RE.test(a)) {
    return { kind: "branding", workspaceId, sha256: a };
  }
  if (area === "certificates" && parts.length === 5 && a !== undefined && UUID_RE.test(a)) {
    const form = CERTIFICATE_FORMS.find((f) => b === `certificate.${f}`);
    if (form !== undefined) {
      return { kind: "certificate", workspaceId, certificateId: a.toLowerCase(), form };
    }
  }
  if (area === "esign" && parts.length === 5 && a !== undefined && UUID_RE.test(a)) {
    const which = ESIGN_ARTIFACT_KINDS.find((k) => b === `${k}.pdf`);
    if (which !== undefined) {
      return { kind: "esign_artifact", workspaceId, envelopeId: a.toLowerCase(), which };
    }
  }
  if (area === "quarantine" && parts.length === 4 && a !== undefined && UUID_RE.test(a)) {
    return { kind: "quarantine", workspaceId, uploadId: a.toLowerCase() };
  }
  if (
    area === "renditions" &&
    (parts.length === 5 || parts.length === 6) &&
    a !== undefined &&
    UUID_RE.test(a) &&
    b !== undefined &&
    KIND_RE.test(b)
  ) {
    const index = c === undefined ? undefined : Number(c);
    if (index !== undefined && (!Number.isInteger(index) || index < 0 || String(index) !== c)) {
      return { kind: "other", workspaceId };
    }
    return { kind: "rendition", workspaceId, versionId: a.toLowerCase(), renditionKind: b, index };
  }
  return { kind: "other", workspaceId };
}

export function isQuarantineKey(key: string): boolean {
  return parseObjectKey(key).kind === "quarantine";
}
