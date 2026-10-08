import { sha256Hex } from "@fundroom/audit";

/*
 * The click-wrap certificate document (E2.3, design/04 §4, ADR-0041 D2).
 *
 * **The canonical JSON is the artefact. The PDF is a rendering of it.** pdf-lib assigns object
 * ids in insertion order and stamps dates from the wall clock, so a PDF digest is not a stable
 * function of its content and must never be the hashed object. This is the same split ADR-0027
 * makes for audit rows: `audit.canonical()` renders a row as a jsonb object with a fixed key
 * set and hashes *that text*, and the row's own storage representation is free to change.
 *
 * The discipline copied from `audit.canonical()`, verbatim:
 *
 *  - a **fixed key set**. Not "the keys this object happens to have" — the keys this version of
 *    the format declares. An absent fact is an explicit `null`; a key is never omitted, because
 *    `{"a":1}` and `{"a":1,"b":null}` are different preimages for the same facts.
 *  - **fixed key order**, the declaration order below, emitted by a literal template in
 *    `canonicalize` so the order is visible in the source rather than inferred from a runtime
 *    object's insertion order.
 *  - **no insignificant whitespace**: no spaces after `:` or `,`, no newlines.
 *  - **timestamps `YYYY-MM-DDTHH:MM:SS.ssssssZ`, UTC only** — the exact rendering
 *    `to_char(… , 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` produces in `audit.canonical()`.
 *  - **a version number in the preimage**, so a future key set can never collide with this one.
 *
 * Everything the format admits is validated before it is emitted (`assertValidCertificateDocument`).
 * Canonicality is not only about key order: if `"0192…-A"` and `"0192…-a"` were both accepted as
 * the same membership id they would produce two digests for one fact, so ids and digests must be
 * lower case, and free text must not carry control characters that no reader will render.
 *
 * Privacy (ADR-0036): this object never holds a raw IP address, a raw User-Agent string, or the
 * signer's email address. It holds `emailSha256`, `ipHash` and a browser *family*. See the
 * README for why that is a deliberate deviation from design/04 §4.3's "IP, user agent".
 */

/** The only key set this package emits or accepts. Bumping it is a new format, not an edit. */
export const CERTIFICATE_DOCUMENT_VERSION = 1;

/**
 * The fixed key set. Absent facts are explicit `null`; key order is the declaration order.
 * No property is optional — `readonly x?: T` would let a caller omit a key and change the
 * preimage without changing any fact.
 */
export interface CertificateDocument {
  readonly version: 1;
  readonly certificateId: string;
  readonly workspace: { readonly id: string; readonly name: string; readonly host: string };
  readonly signer: {
    readonly membershipId: string;
    /** sha256 of the verified address, lower-case hex. Never the address itself. */
    readonly emailSha256: string;
    readonly displayName: string | null;
    /** What the signer typed into the "type your name" box, when the gate asked for one. */
    readonly typedName: string | null;
  };
  readonly document: {
    readonly documentId: string;
    readonly slug: string;
    readonly title: string;
    readonly versionNo: number;
    /** `<slug>:v<n>` — the attestation kind this acceptance was recorded under. */
    readonly stamp: string;
    /** sha256 of the exact body text the signer was shown, lower-case hex. */
    readonly bodySha256: string;
  };
  readonly acceptance: {
    /** `YYYY-MM-DDTHH:MM:SS.ssssssZ`; build it with `formatCertificateTimestamp`. */
    readonly acceptedAt: string;
    readonly method: "clickwrap";
    /** `chrome` | `firefox` | … — from `uaFamilyOf`, never a User-Agent string. */
    readonly uaFamily: string | null;
    /** Keyed HMAC of the address, lower-case hex — from `ipHashOf`, never an address. */
    readonly ipHash: string | null;
    /** The share link the signer arrived through, when there was one. */
    readonly viaLinkId: string | null;
  };
  /** The `legal.document_accepted` audit event this certificate evidences. */
  readonly anchor: { readonly auditSeq: number; readonly auditHash: string };
}

/** One position in the workspace's hash-chained audit log. */
export interface AuditAnchor {
  readonly auditSeq: number;
  readonly auditHash: string;
}

export type CertificateErrorCode = "invalid_document" | "unreadable";

export class CertificateError extends Error {
  override readonly name = "CertificateError";
  constructor(
    readonly code: CertificateErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>> | undefined,
  ) {
    super(message);
  }
}

/** `YYYY-MM-DDTHH:MM:SS.ssssssZ` — UTC, microsecond places, no offset form. */
export const CERTIFICATE_TIMESTAMP_RE =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6}Z$/u;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX256_RE = /^[0-9a-f]{64}$/u;
const SLUG_RE = /^[a-z][a-z0-9-]{0,62}$/u;
const STAMP_RE = /^[a-z][a-z0-9-]{0,62}:v[1-9]\d{0,8}$/u;
/**
 * C0, DEL and C1: nothing a PDF reader or a terminal should be asked to render, and nothing the
 * standard 14 fonts can encode. Written as a loop rather than a regex because a character class
 * of control characters is itself a lint error, and rightly so.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const cp = value.charCodeAt(i);
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

/** Longest free-text field. Longer than any of these is a bug or an attempt on the renderer. */
export const MAX_TEXT_LENGTH = 512;

/**
 * A JS `Date` carries milliseconds, so the microsecond places are always `000`. They are emitted
 * anyway: the format has to be one format, and the day the acceptance timestamp comes back out
 * of Postgres with real microseconds must not be the day the digest changes shape.
 */
export function formatCertificateTimestamp(at: Date): string {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) {
    throw new CertificateError("invalid_document", "acceptedAt is not a valid Date");
  }
  const iso = new Date(ms).toISOString();
  const stamped = `${iso.slice(0, iso.length - 1)}000Z`;
  if (!CERTIFICATE_TIMESTAMP_RE.test(stamped)) {
    // Years outside 0001-9999 render as `+275760-09-13T…`; reject rather than emit a second shape.
    throw new CertificateError("invalid_document", `acceptedAt ${stamped} is out of range`);
  }
  return stamped;
}

function fail(what: string, value: unknown): never {
  throw new CertificateError("invalid_document", `certificate ${what} is invalid`, {
    field: what,
    type: typeof value,
  });
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    fail(what, value);
  }
  if (hasControlCharacter(value)) fail(what, value);
  return value;
}

function nullableText(value: unknown, what: string): string | null {
  if (value === null) return null;
  return text(value, what);
}

function matching(re: RegExp, value: unknown, what: string): string {
  if (typeof value !== "string" || !re.test(value)) fail(what, value);
  return value;
}

function nullableMatching(re: RegExp, value: unknown, what: string): string | null {
  if (value === null) return null;
  return matching(re, value, what);
}

function positiveInt(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(what, value);
  return value;
}

function objectAt(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(what, value);
  return value as Record<string, unknown>;
}

/**
 * Validates and *normalises* a candidate into the fixed key set: every field is checked, extra
 * keys are dropped, and the result is the object `canonicalize` will emit. Callers building a
 * document from database rows should run this before `issue` so a bad field is caught at the
 * seam rather than inside the transaction that writes the audit row.
 *
 * Extra keys are dropped rather than rejected because the canonical JSON — not the caller's
 * object — is what gets stored and hashed: what is hashed is exactly what is kept.
 */
export function assertValidCertificateDocument(doc: unknown): CertificateDocument {
  const d = objectAt(doc, "document");
  if (d["version"] !== CERTIFICATE_DOCUMENT_VERSION) fail("version", d["version"]);
  const workspace = objectAt(d["workspace"], "workspace");
  const signer = objectAt(d["signer"], "signer");
  const legal = objectAt(d["document"], "document.document");
  const acceptance = objectAt(d["acceptance"], "acceptance");
  const anchor = objectAt(d["anchor"], "anchor");
  if (acceptance["method"] !== "clickwrap") fail("acceptance.method", acceptance["method"]);
  return {
    version: CERTIFICATE_DOCUMENT_VERSION,
    certificateId: matching(UUID_RE, d["certificateId"], "certificateId"),
    workspace: {
      id: matching(UUID_RE, workspace["id"], "workspace.id"),
      name: text(workspace["name"], "workspace.name"),
      host: text(workspace["host"], "workspace.host"),
    },
    signer: {
      membershipId: matching(UUID_RE, signer["membershipId"], "signer.membershipId"),
      emailSha256: matching(HEX256_RE, signer["emailSha256"], "signer.emailSha256"),
      displayName: nullableText(signer["displayName"], "signer.displayName"),
      typedName: nullableText(signer["typedName"], "signer.typedName"),
    },
    document: {
      documentId: matching(UUID_RE, legal["documentId"], "document.documentId"),
      slug: matching(SLUG_RE, legal["slug"], "document.slug"),
      title: text(legal["title"], "document.title"),
      versionNo: positiveInt(legal["versionNo"], "document.versionNo"),
      stamp: matching(STAMP_RE, legal["stamp"], "document.stamp"),
      bodySha256: matching(HEX256_RE, legal["bodySha256"], "document.bodySha256"),
    },
    acceptance: {
      acceptedAt: matching(
        CERTIFICATE_TIMESTAMP_RE,
        acceptance["acceptedAt"],
        "acceptance.acceptedAt",
      ),
      method: "clickwrap",
      uaFamily: nullableMatching(SLUG_RE, acceptance["uaFamily"], "acceptance.uaFamily"),
      ipHash: nullableMatching(HEX256_RE, acceptance["ipHash"], "acceptance.ipHash"),
      viaLinkId: nullableMatching(UUID_RE, acceptance["viaLinkId"], "acceptance.viaLinkId"),
    },
    anchor: {
      auditSeq: positiveInt(anchor["auditSeq"], "anchor.auditSeq"),
      auditHash: matching(HEX256_RE, anchor["auditHash"], "anchor.auditHash"),
    },
  };
}

/**
 * `JSON.stringify` of a string is the only escaping used. It is specified (ES2019 well-formed
 * `JSON.stringify` escapes lone surrogates as `\udXXX`) and therefore deterministic across
 * engines and versions; hand-rolling an escaper here would be a second, less tested one.
 */
function s(value: string): string {
  return JSON.stringify(value);
}

function sn(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

/**
 * The canonical serialisation. PURE and deterministic: the same facts always produce the same
 * bytes, whatever order the input object's keys happen to be in and however it was round-tripped.
 *
 * The literal template below *is* the format specification. Reordering a line changes every
 * digest this package has ever produced, which is why it is one expression a reviewer can read
 * top to bottom rather than a loop over a key list.
 */
export function canonicalize(doc: CertificateDocument): string {
  const d = assertValidCertificateDocument(doc);
  return (
    "{" +
    `"version":${CERTIFICATE_DOCUMENT_VERSION},` +
    `"certificateId":${s(d.certificateId)},` +
    `"workspace":{` +
    `"id":${s(d.workspace.id)},` +
    `"name":${s(d.workspace.name)},` +
    `"host":${s(d.workspace.host)}` +
    `},` +
    `"signer":{` +
    `"membershipId":${s(d.signer.membershipId)},` +
    `"emailSha256":${s(d.signer.emailSha256)},` +
    `"displayName":${sn(d.signer.displayName)},` +
    `"typedName":${sn(d.signer.typedName)}` +
    `},` +
    `"document":{` +
    `"documentId":${s(d.document.documentId)},` +
    `"slug":${s(d.document.slug)},` +
    `"title":${s(d.document.title)},` +
    `"versionNo":${d.document.versionNo},` +
    `"stamp":${s(d.document.stamp)},` +
    `"bodySha256":${s(d.document.bodySha256)}` +
    `},` +
    `"acceptance":{` +
    `"acceptedAt":${s(d.acceptance.acceptedAt)},` +
    `"method":"clickwrap",` +
    `"uaFamily":${sn(d.acceptance.uaFamily)},` +
    `"ipHash":${sn(d.acceptance.ipHash)},` +
    `"viaLinkId":${sn(d.acceptance.viaLinkId)}` +
    `},` +
    `"anchor":{` +
    `"auditSeq":${d.anchor.auditSeq},` +
    `"auditHash":${s(d.anchor.auditHash)}` +
    `}` +
    "}"
  );
}

/** `sha256(utf8(canonicalize(doc)))`, lower-case hex. PURE. */
export function digestOf(doc: CertificateDocument): string {
  return sha256Hex(canonicalize(doc));
}

/**
 * Reads back a stored certificate. `canonicalize(parseCertificateDocument(text))` is `text` for
 * anything this package wrote, which is what lets a verifier recompute the digest from the bytes
 * in the bucket with nothing but this function and sha256.
 */
export function parseCertificateDocument(json: string): CertificateDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new CertificateError("unreadable", "certificate JSON does not parse", {
      cause: String(cause),
    });
  }
  return assertValidCertificateDocument(parsed);
}
