import { createHmac, hkdfSync, randomBytes } from "node:crypto";

/** HKDF `info` for the per-install pattern key (one per key-ring entry). */
export const FORENSIC_KEY_PURPOSE = "seed-host/forensic/pattern/v1";
/** Random bytes per (recipient membership, document version) mark. */
export const FORENSIC_TOKEN_BYTES = 8;

const SEED_PREFIX = Buffer.from("mark\0", "utf8");

/** A fresh mark token: 8 random bytes (`dataroom.forensic_mark.token`). */
export function newForensicToken(): Uint8Array {
  return new Uint8Array(randomBytes(FORENSIC_TOKEN_BYTES));
}

/**
 * The pattern key for one key-ring entry: HKDF-SHA256(entry key, salt empty, info
 * `FORENSIC_KEY_PURPOSE`, 32 bytes). Domain-separated from every other key the ring derives.
 */
export function deriveForensicPatternKey(ringEntryKey: Uint8Array): Uint8Array {
  if (ringEntryKey.length < 16) throw new RangeError("forensic: key-ring entry is too short");
  return new Uint8Array(
    hkdfSync("sha256", ringEntryKey, new Uint8Array(0), FORENSIC_KEY_PURPOSE, 32),
  );
}

/** The 32-byte pattern seed of one mark: HMAC-SHA256(patternKey, "mark\0" || token). */
export function forensicSeed(patternKey: Uint8Array, token: Uint8Array): Uint8Array {
  if (patternKey.length !== 32) throw new RangeError("forensic: pattern key must be 32 bytes");
  if (token.length !== FORENSIC_TOKEN_BYTES)
    throw new RangeError(`forensic: token must be ${FORENSIC_TOKEN_BYTES} bytes`);
  return new Uint8Array(
    createHmac("sha256", patternKey).update(SEED_PREFIX).update(token).digest(),
  );
}
