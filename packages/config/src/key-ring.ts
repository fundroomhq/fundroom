import { createHash } from "node:crypto";
import type { ConfigIssue } from "./errors.js";

/** Minimum raw key length in bytes (256-bit). */
export const MIN_KEY_BYTES = 32;

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u;

export interface KeyRingEntry {
  /** Stable identifier stored alongside ciphertext / signatures, e.g. `v2`. */
  readonly id: string;
  readonly key: Uint8Array;
  /** `sha256:<first 12 hex>` — safe to log; lets an operator confirm which key is live. */
  readonly fingerprint: string;
}

export interface KeyRing {
  /** The key used for all new encryption and signing. Always the first entry. */
  readonly current: KeyRingEntry;
  /** Every key, newest first. Older keys are decrypt/verify-only. */
  readonly entries: readonly KeyRingEntry[];
  get(id: string): KeyRingEntry | undefined;
}

export type KeyRingParseResult =
  | { readonly ok: true; readonly ring: KeyRing }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export const KEY_RING_EXAMPLE = "v2:$(openssl rand -base64 32),v1:<previous key>";

/**
 * Parses `SECRET_KEY_RING`, a comma-separated list of `id:base64key` entries,
 * newest first. Rotation is non-breaking: add the new key at the front, keep the
 * old one until everything has been re-encrypted, then drop it.
 *
 * Keys are base64 (standard or URL-safe) or hex and must decode to at least
 * 32 bytes. Ids must be unique and match `[A-Za-z0-9][A-Za-z0-9_-]{0,31}`.
 */
export function parseKeyRing(raw: string, envKey = "SECRET_KEY_RING"): KeyRingParseResult {
  const issues: ConfigIssue[] = [];
  const entries: KeyRingEntry[] = [];
  const seen = new Set<string>();

  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (parts.length === 0) {
    return {
      ok: false,
      issues: [{ key: envKey, message: "is empty.", example: KEY_RING_EXAMPLE }],
    };
  }

  parts.forEach((part, index) => {
    const sep = part.indexOf(":");
    if (sep <= 0 || sep === part.length - 1) {
      issues.push({
        key: envKey,
        message: `entry ${index + 1} must look like id:base64key.`,
        example: KEY_RING_EXAMPLE,
      });
      return;
    }
    const id = part.slice(0, sep);
    const encoded = part.slice(sep + 1);

    if (!KEY_ID_PATTERN.test(id)) {
      issues.push({
        key: envKey,
        message: `key id "${id}" must match [A-Za-z0-9][A-Za-z0-9_-]{0,31}.`,
      });
      return;
    }
    if (seen.has(id)) {
      issues.push({ key: envKey, message: `duplicate key id "${id}".` });
      return;
    }
    seen.add(id);

    const key = decodeKey(encoded);
    if (key === undefined) {
      issues.push({
        key: envKey,
        message: `key "${id}" is not valid base64 or hex.`,
        example: `${id}:$(openssl rand -base64 32)`,
      });
      return;
    }
    if (key.byteLength < MIN_KEY_BYTES) {
      issues.push({
        key: envKey,
        message: `key "${id}" is ${key.byteLength} bytes; need at least ${MIN_KEY_BYTES}.`,
        example: `${id}:$(openssl rand -base64 32)`,
      });
      return;
    }
    entries.push({ id, key, fingerprint: fingerprintKey(key) });
  });

  if (issues.length > 0) return { ok: false, issues };

  const first = entries[0];
  if (first === undefined) {
    // Unreachable: parts.length > 0 and no issues implies at least one entry.
    return { ok: false, issues: [{ key: envKey, message: "no usable keys." }] };
  }
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  return {
    ok: true,
    ring: {
      current: first,
      entries,
      get: (id) => byId.get(id),
    },
  };
}

/**
 * Builds a single-key ring from `FUNDROOM_SECRET_KEY` (id `v1`). Kept for the
 * "one key, no rotation yet" install; switching to `SECRET_KEY_RING` later is
 * a pure superset (`v2:new,v1:<this key>`).
 */
export function keyRingFromSingleKey(raw: string): KeyRingParseResult {
  const result = parseKeyRing(`v1:${raw.trim()}`, "FUNDROOM_SECRET_KEY");
  if (result.ok) return result;
  return {
    ok: false,
    issues: result.issues.map((i) => ({
      key: "FUNDROOM_SECRET_KEY",
      message: i.message
        .replace(/key "v1" /u, "")
        .replace(/^entry 1 must look like id:base64key\.$/u, "must be base64 or hex."),
      example: "$(openssl rand -base64 32)",
    })),
  };
}

export function fingerprintKey(key: Uint8Array): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/**
 * The fingerprint `doctor` and the boot log would print for this key text (`sha256:<12 hex>` of
 * the decoded key bytes, after the same trim `keyRingFromSingleKey` applies), or `undefined` when
 * the text is not a usable key. Lets a config error identify a key in the same terms as `doctor`.
 */
export function keyTextFingerprint(raw: string): string | undefined {
  const key = decodeKey(raw.trim());
  return key === undefined || key.byteLength < MIN_KEY_BYTES ? undefined : fingerprintKey(key);
}

/** Redacted, log-safe description: `v2 (sha256:…), v1 (sha256:…)`. */
export function describeKeyRing(ring: KeyRing): string {
  return ring.entries.map((e) => `${e.id} (${e.fingerprint})`).join(", ");
}

function decodeKey(encoded: string): Uint8Array | undefined {
  const s = encoded.trim();
  if (s.length === 0) return undefined;

  if (/^[0-9a-fA-F]+$/u.test(s) && s.length % 2 === 0 && s.length >= 2 * MIN_KEY_BYTES) {
    return Uint8Array.from(Buffer.from(s, "hex"));
  }
  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(s)) {
    const buf = Buffer.from(s, "base64");
    // Buffer.from(base64) silently drops junk; make sure it round-trips.
    if (buf.toString("base64").replace(/=+$/u, "") !== s.replace(/=+$/u, "")) return undefined;
    return Uint8Array.from(buf);
  }
  if (/^[A-Za-z0-9_-]+={0,2}$/u.test(s)) {
    const buf = Buffer.from(s, "base64url");
    if (buf.toString("base64url") !== s.replace(/=+$/u, "")) return undefined;
    return Uint8Array.from(buf);
  }
  return undefined;
}
