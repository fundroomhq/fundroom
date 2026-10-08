import {
  createHash,
  createPublicKey,
  type KeyObject,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import {
  AnchorError,
  type AnchorReceipt,
  type AnchorVerification,
  type AuditAnchorPort,
  type OutboundFetch,
} from "@fundroom/ports";
import { displayUrl, requestCapped } from "./http.js";
import { leafHash, verifyInclusion } from "./merkle.js";
import {
  type LogKey,
  logKeysFromPems,
  NoteError,
  parseCheckpoint,
  parseSignedNote,
  verifyNote,
} from "./note.js";

/*
 * Sigstore Rekor v2 anchor (E3.13, ADR-0061).
 *
 * The anchored "artifact" is the 32-byte batch root itself: we sign it with the key-ring-derived
 * ECDSA P-256 key (ECDSA-SHA256, so the signed hash is SHA-256(root)) and submit a hashedrekord
 * whose digest is SHA-256(root) — exactly what a Sigstore client does for a file whose bytes are
 * the root. (Pure Ed25519 is refused by Rekor for hashedrekord; P-256 needs no prehash tricks.)
 * The response, a TransparencyLogEntry with its inclusion proof and signed checkpoint, is stored
 * whole in the receipt; v2 has no lookup API, so it is the only copy of the proof we will have.
 *
 * Offline verification (`verifyRekorReceipt`, no network):
 *   1. the canonicalized body is a hashedrekord v0.0.2 whose digest is SHA-256(root) and whose
 *      ECDSA P-256 signature over the root verifies with the public key it carries;
 *   2. leaf = SHA-256(0x00 || body) is included at `logIndex` in the tree of the checkpoint's
 *      size and root (RFC 9162 inclusion proof);
 *   3. the checkpoint is a signed note signed under its origin by a pinned log key.
 * 1 or 2 failing, or a pinned key's signature not verifying → `failed`; only 3 missing a pinned
 * signature → `unverified_origin`. Rekor v2 asserts no time: `anchoredAt` is our submission time,
 * covered by no signature, so a verified rekor receipt is PRESENCE-ONLY evidence
 * (`timeTrusted: false`); trusted time comes only from RFC 3161.
 */

export const REKOR_ANCHOR_KIND = "rekor";
export const REKOR_PROOF_VERSION = 1;
/** An entry with a 64-level proof and a few cosignatures is ~4 KiB; this is generous. */
export const REKOR_MAX_RESPONSE_BYTES = 1024 * 1024;
export const REKOR_KEY_DETAILS = "PKIX_ECDSA_P256_SHA_256";

export interface RekorAnchorOptions {
  /** The log shard base URL (AUDIT_ANCHOR_REKOR_URL), e.g. https://log2025-1.rekor.sigstore.dev. */
  readonly url: string;
  /**
   * The log's PEM public key(s) (AUDIT_ANCHOR_REKOR_LOG_KEY): one PEM, a bundle, or a list. A
   * checkpoint signed by any of them verifies (keep old shards' keys for old receipts).
   */
  readonly logPublicKeyPem: string | readonly string[];
  /**
   * Pinned checkpoint origin(s) (C2SP note names; AUDIT_ANCHOR_REKOR_ORIGIN). The FIRST is the
   * current shard's: every checkpoint returned at anchor time / health check must carry exactly
   * it. All of them are accepted by `verify` (keep old shards' origins, with their keys, so their
   * receipts stay verifiable). Default: the hostname of `url`, which is what rekor-tiles uses
   * (`--hostname`).
   */
  readonly origin?: string | readonly string[] | undefined;
  /** ECDSA P-256 key derived from the key ring (`deriveAnchorSigningKey` in @fundroom/audit). */
  readonly signingKey: KeyObject;
  /** The guarded outbound client's fetch (no redirects, size cap). */
  readonly http: OutboundFetch;
  /**
   * Per-request timeout (AUDIT_ANCHOR_TIMEOUT_MS). Rekor v2 answers only once the checkpoint that
   * includes the entry is published, so allow for a few seconds.
   */
  readonly timeoutMs: number;
  readonly now?: (() => Date) | undefined;
}

/** `receipt.proof` of a `rekor` receipt. */
export interface RekorProof {
  readonly v: number;
  /** The shard the entry was written to (origin + path; no query). */
  readonly logUrl: string;
  /** The checkpoint origin the entry was verified under at anchor time (informational only: verify uses pinned origins). */
  readonly origin: string;
  /** The TransparencyLogEntry exactly as the log returned it (protojson). */
  readonly entry: Record<string, unknown>;
}

interface HashedRekordBody {
  readonly apiVersion?: unknown;
  readonly kind?: unknown;
  readonly spec?: {
    readonly hashedRekordV002?: {
      readonly data?: { readonly algorithm?: unknown; readonly digest?: unknown };
      readonly signature?: {
        readonly content?: unknown;
        readonly verifier?: {
          readonly keyDetails?: unknown;
          readonly publicKey?: { readonly rawBytes?: unknown };
        };
      };
    };
  };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function b64(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value === "" || !BASE64.test(value)) return null;
  return new Uint8Array(Buffer.from(value, "base64"));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
}

/** protojson int64 fields arrive as decimal strings (or numbers from other encoders). */
function int64(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function isP256(key: KeyObject): boolean {
  return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
}

type Verdict = AnchorVerification & { readonly logIndex?: number; readonly origin?: string };

function checkEntry(
  digest: Uint8Array,
  entry: Record<string, unknown>,
  pins: readonly LogKey[],
  origins: { readonly accepted: readonly string[]; readonly strict: boolean },
): Verdict {
  const failed = (detail: string): Verdict => ({ status: "failed", detail });

  // 1. The body binds our root and a valid signature over it.
  const bodyBytes = b64(entry["canonicalizedBody"]);
  if (!bodyBytes) return failed("the entry has no canonicalized body");
  let body: HashedRekordBody;
  try {
    body = JSON.parse(Buffer.from(bodyBytes).toString("utf8")) as HashedRekordBody;
  } catch {
    return failed("the entry body is not JSON");
  }
  if (body.kind !== "hashedrekord" || body.apiVersion !== "0.0.2") {
    return failed("the entry is not a hashedrekord v0.0.2");
  }
  const spec = body.spec?.hashedRekordV002;
  if (spec?.data?.algorithm !== "SHA2_256") return failed("the entry digest is not SHA2_256");
  const entryDigest = b64(spec.data.digest);
  if (!entryDigest || !sameBytes(entryDigest, sha256(digest))) {
    return failed("the entry does not record this digest");
  }
  if (spec.signature?.verifier?.keyDetails !== REKOR_KEY_DETAILS) {
    return failed("the entry's signing key is not ECDSA P-256");
  }
  const signature = b64(spec.signature.content);
  const spki = b64(spec.signature.verifier.publicKey?.rawBytes);
  if (!signature || !spki) return failed("the entry has no signature or public key");
  let signer: KeyObject;
  try {
    signer = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
  } catch {
    return failed("the entry's public key does not parse");
  }
  if (!isP256(signer)) return failed("the entry's signing key is not ECDSA P-256");
  let signatureOk = false;
  try {
    signatureOk = verifyBytes("sha256", digest, signer, signature);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return failed("the entry's signature over the digest is invalid");

  // 2. The body is in the tree the checkpoint commits to.
  const logIndex = int64(entry["logIndex"]);
  if (logIndex === null) return failed("the entry has no log index");
  const proof = record(entry["inclusionProof"]);
  const envelope = record(proof?.["checkpoint"])?.["envelope"];
  if (!proof || typeof envelope !== "string") return failed("the entry has no inclusion proof");
  let note: ReturnType<typeof parseSignedNote>;
  let checkpoint: ReturnType<typeof parseCheckpoint>;
  try {
    note = parseSignedNote(envelope);
    checkpoint = parseCheckpoint(note.body);
  } catch (error) {
    return failed(error instanceof NoteError ? error.message : "the checkpoint does not parse");
  }
  // At anchor time the checkpoint must be the configured shard's own (strict: a key that signs
  // several logs cannot vouch for an entry in another log).
  const originPinned = origins.accepted.includes(checkpoint.origin);
  if (origins.strict && !originPinned) {
    return failed(
      `the checkpoint origin "${checkpoint.origin}" is not the log's origin "${origins.accepted[0] ?? ""}"`,
    );
  }
  const hashesRaw = proof["hashes"] ?? [];
  if (!Array.isArray(hashesRaw)) return failed("the inclusion proof hashes are malformed");
  const hashes: Uint8Array[] = [];
  for (const h of hashesRaw) {
    const bytes = b64(h);
    if (bytes?.byteLength !== 32) return failed("the inclusion proof hashes are malformed");
    hashes.push(bytes);
  }
  if (!verifyInclusion(leafHash(bodyBytes), logIndex, checkpoint.size, hashes, checkpoint.root)) {
    return failed("the inclusion proof does not lead to the checkpoint root");
  }

  // 3. A pinned log key signed the checkpoint.
  const signed = verifyNote(note, checkpoint.origin, pins);
  if (signed.status === "failed") return { ...signed, logIndex, origin: checkpoint.origin };
  // On verify, only PINNED origins count (never the receipt's own unsigned claim): a consistent
  // entry in a log whose origin is not pinned is evidence of unknown origin.
  if (!originPinned) {
    return {
      status: "unverified_origin",
      detail: `the checkpoint origin "${checkpoint.origin}" is not a pinned log origin`,
      logIndex,
      origin: checkpoint.origin,
    };
  }
  if (signed.status !== "verified") return { ...signed, logIndex, origin: checkpoint.origin };
  return {
    status: "verified",
    anchoredAt: "",
    detail: `entry ${logIndex} of ${checkpoint.origin} (tree size ${checkpoint.size})`,
    logIndex,
    origin: checkpoint.origin,
  };
}

function verifyReceipt(
  digest: Uint8Array,
  receipt: AnchorReceipt,
  pems: readonly string[],
  origins: readonly string[],
): AnchorVerification {
  if (receipt.kind !== REKOR_ANCHOR_KIND) {
    return { status: "failed", detail: `not a ${REKOR_ANCHOR_KIND} receipt` };
  }
  if (digest.byteLength !== 32) return { status: "failed", detail: "the digest is not 32 bytes" };
  const proof = record(receipt.proof);
  const entry = record(proof?.["entry"]);
  if (!entry) return { status: "failed", detail: "the receipt carries no log entry" };
  const verdict = checkEntry(digest, entry, logKeysFromPems(pems), {
    accepted: origins,
    strict: false,
  });
  if (verdict.status === "failed") return { status: "failed", detail: verdict.detail };
  if (verdict.status === "unverified_origin") {
    return { status: "unverified_origin", detail: verdict.detail };
  }
  if (Number.isNaN(Date.parse(receipt.anchoredAt))) {
    return { status: "failed", detail: "the receipt has no valid anchoredAt" };
  }
  // Presence only: Rekor v2 signs no time, and `anchoredAt` is the submitter's own clock.
  return {
    status: "verified",
    anchoredAt: receipt.anchoredAt,
    timeTrusted: false,
    detail: `present in the log: ${verdict.detail ?? "entry verified"}; no trusted time (anchoredAt is the submitter's clock)`,
  };
}

/**
 * Offline verification of a `rekor` receipt over `digest` against pinned log public keys
 * (`trusted.pems`, PEM SPKI or bundles; Ed25519, ECDSA or RSA; any pinned key may sign) and
 * pinned log origins (`trusted.origins`; the receipt's own `proof.origin` / `logUrl` never
 * count). A `verified` result has `timeTrusted: false`: it proves the digest is in the log, not
 * when. With no pinned key or no pinned origin matching, a consistent receipt is
 * `unverified_origin`. Never throws, never touches the network. Typed as
 * `AuditAnchorPort["verify"]` so the export-bundle verifier can take it as is.
 */
export const verifyRekorReceipt: AuditAnchorPort["verify"] = async (digest, receipt, trusted) =>
  verifyReceipt(digest, receipt, trusted?.pems ?? [], trusted?.origins ?? []);

function baseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function createRekorAnchor(options: RekorAnchorOptions): AuditAnchorPort {
  if (!isP256(options.signingKey) || options.signingKey.type !== "private") {
    throw new Error("anchor-rekor: the signing key must be an ECDSA P-256 private key");
  }
  const pins =
    typeof options.logPublicKeyPem === "string"
      ? [options.logPublicKeyPem]
      : [...options.logPublicKeyPem];
  if (logKeysFromPems(pins).length === 0) {
    throw new Error("anchor-rekor: no usable log public key (PEM SPKI) is configured");
  }
  const now = options.now ?? (() => new Date());
  const base = baseUrl(options.url);
  const configuredOrigins =
    options.origin === undefined
      ? [new URL(base).hostname]
      : typeof options.origin === "string"
        ? [options.origin]
        : [...options.origin];
  const origin = configuredOrigins[0];
  if (origin === undefined || configuredOrigins.some((o) => o === "" || /\s|\+/.test(o))) {
    throw new Error(
      "anchor-rekor: the log origin(s) must be non-empty names without spaces or '+'",
    );
  }
  const what = `Rekor ${displayUrl(base)}`;
  const spki = new Uint8Array(
    createPublicKey(options.signingKey).export({ type: "spki", format: "der" }),
  );

  return {
    kind: REKOR_ANCHOR_KIND,
    async anchor(digest: Uint8Array): Promise<AnchorReceipt> {
      if (digest.byteLength !== 32) {
        throw new AnchorError("rejected", "the anchored digest must be 32 bytes (SHA-256)");
      }
      const submittedAt = now();
      const signature = new Uint8Array(signBytes("sha256", digest, options.signingKey));
      const request = {
        hashedRekordRequestV002: {
          digest: Buffer.from(sha256(digest)).toString("base64"),
          signature: {
            content: Buffer.from(signature).toString("base64"),
            verifier: {
              publicKey: { rawBytes: Buffer.from(spki).toString("base64") },
              keyDetails: REKOR_KEY_DETAILS,
            },
          },
        },
      };
      const answer = await requestCapped({
        http: options.http,
        url: `${base}/api/v2/log/entries`,
        method: "POST",
        body: new TextEncoder().encode(JSON.stringify(request)),
        headers: { "content-type": "application/json", accept: "application/json" },
        timeoutMs: options.timeoutMs,
        maxBytes: REKOR_MAX_RESPONSE_BYTES,
        what,
      });
      let entry: Record<string, unknown> | null;
      try {
        entry = record(JSON.parse(Buffer.from(answer.bytes).toString("utf8")));
      } catch {
        entry = null;
      }
      if (!entry)
        throw new AnchorError("invalid_response", `${what}: the answer is not a log entry`);
      const verdict = checkEntry(digest, entry, logKeysFromPems(pins), {
        accepted: [origin],
        strict: true,
      });
      if (verdict.status !== "verified" || verdict.logIndex === undefined) {
        throw new AnchorError(
          "verification_failed",
          `${what}: ${verdict.status === "verified" ? "no log index" : verdict.detail}`,
        );
      }
      const proof: RekorProof = {
        v: REKOR_PROOF_VERSION,
        logUrl: displayUrl(base),
        origin,
        entry,
      };
      return {
        kind: REKOR_ANCHOR_KIND,
        reference: `${displayUrl(base)} logIndex ${verdict.logIndex}`,
        anchoredAt: submittedAt.toISOString(),
        proof: { ...proof },
      };
    },
    async verify(digest, receipt, trusted) {
      return verifyReceipt(
        digest,
        receipt,
        trusted?.pems ?? pins,
        trusted?.origins ?? configuredOrigins,
      );
    },
    async healthCheck(): Promise<void> {
      const answer = await requestCapped({
        http: options.http,
        url: `${base}/api/v2/checkpoint`,
        method: "GET",
        headers: { accept: "text/plain" },
        timeoutMs: options.timeoutMs,
        maxBytes: 64 * 1024,
        what,
      });
      try {
        const note = parseSignedNote(Buffer.from(answer.bytes).toString("utf8"));
        const checkpoint = parseCheckpoint(note.body);
        if (checkpoint.origin !== origin) {
          throw new AnchorError(
            "verification_failed",
            `${what}: the checkpoint origin "${checkpoint.origin}" is not "${origin}"`,
          );
        }
        const signed = verifyNote(note, checkpoint.origin, logKeysFromPems(pins));
        if (signed.status !== "verified") {
          throw new AnchorError("verification_failed", `${what}: ${signed.detail}`);
        }
      } catch (error) {
        if (error instanceof AnchorError) throw error;
        throw new AnchorError("invalid_response", `${what}: the checkpoint does not parse`);
      }
    },
  };
}

export { inclusionPath, leafHash, merkleRoot, nodeHash, verifyInclusion } from "./merkle.js";
export {
  type Checkpoint,
  type LogKey,
  logKeyFromPem,
  noteKeyId,
  parseCheckpoint,
  parseSignedNote,
  signNote,
} from "./note.js";
