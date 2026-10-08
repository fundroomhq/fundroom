import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type CodeKeyRing,
  hashPasscode,
  isAcceptablePasscode,
  isPlausibleToken,
  mintToken,
  normalizePasscode,
  passcodeScope,
  SHARE_LINK_TOKEN_MIN_LENGTH,
  tokenHash,
  verifyPasscode,
} from "./token.js";

const LINK_A = "01930000-0000-7000-8000-00000000000a";
const LINK_B = "01930000-0000-7000-8000-00000000000b";

/** A minimal key ring. Structural, so this package need not depend on `@fundroom/config`. */
function ring(...raw: readonly Uint8Array[]): CodeKeyRing {
  const entries = raw.map((key, i) => ({
    id: `v${raw.length - i}`,
    key,
    fingerprint: `sha256:${i}`,
  }));
  const current = entries[0];
  if (current === undefined) throw new Error("a ring needs at least one key");
  return {
    current,
    entries,
    get: (id: string) => entries.find((e) => e.id === id),
  };
}

const KEY_NEW = randomBytes(32);
const KEY_OLD = randomBytes(32);

describe("mintToken", () => {
  it("is 256 bits of base64url, the same budget as a session token", () => {
    const token = mintToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintToken()));
    expect(seen.size).toBe(200);
  });
});

describe("tokenHash", () => {
  it("is 32 bytes, which is what `share_link_token_hash_length` CHECKs", () => {
    expect(tokenHash(mintToken())).toHaveLength(32);
  });

  it("is deterministic, because the unique index is the lookup", () => {
    const token = mintToken();
    expect(tokenHash(token).equals(tokenHash(token))).toBe(true);
  });

  it("differs for a token that differs by one character", () => {
    expect(tokenHash("a".repeat(43)).equals(tokenHash(`${"a".repeat(42)}b`))).toBe(false);
  });
});

describe("isPlausibleToken", () => {
  it("accepts what `mintToken` produces", () => {
    expect(isPlausibleToken(mintToken())).toBe(true);
  });

  it("refuses anything shorter than 32 bytes base64url, before a digest is computed", () => {
    expect(isPlausibleToken("x".repeat(SHARE_LINK_TOKEN_MIN_LENGTH - 1))).toBe(false);
    expect(isPlausibleToken("")).toBe(false);
  });

  it("refuses characters base64url cannot produce, so no probe reaches the index", () => {
    expect(isPlausibleToken(`${"a".repeat(42)}+`)).toBe(false);
    expect(isPlausibleToken(`${"a".repeat(42)}/`)).toBe(false);
    expect(isPlausibleToken(`${"a".repeat(42)} `)).toBe(false);
  });

  it("refuses an over-long string, so a megabyte of junk is not hashed", () => {
    expect(isPlausibleToken("a".repeat(513))).toBe(false);
  });

  it("refuses a non-string, because the value arrives from an unvalidated URL segment", () => {
    expect(isPlausibleToken(undefined)).toBe(false);
    expect(isPlausibleToken(null)).toBe(false);
    expect(isPlausibleToken(42)).toBe(false);
  });
});

describe("passcodeScope", () => {
  it("names the link, so the same passcode on two links has two different MACs", () => {
    expect(passcodeScope(LINK_A)).not.toBe(passcodeScope(LINK_B));
  });
});

describe("normalizePasscode", () => {
  it("trims the padding a password manager or phone keyboard adds", () => {
    expect(normalizePasscode("  swordfish ")).toBe("swordfish");
  });

  it("keeps the case: a chosen secret loses entropy if it is folded", () => {
    expect(normalizePasscode("SwordFish")).toBe("SwordFish");
  });
});

describe("isAcceptablePasscode", () => {
  it("refuses a passcode short enough to be guessed before the lockout bites", () => {
    expect(isAcceptablePasscode("abc12")).toBe(false);
    expect(isAcceptablePasscode("abc123")).toBe(true);
  });

  it("measures the trimmed value, so five characters and three spaces is still too short", () => {
    expect(isAcceptablePasscode("  abc12  ")).toBe(false);
  });

  it("refuses something too long to be a passcode at all", () => {
    expect(isAcceptablePasscode("a".repeat(129))).toBe(false);
  });
});

describe("hashPasscode / verifyPasscode", () => {
  const keys = ring(KEY_NEW);

  it("stores 32 bytes, which is what `share_link_passcode_hash_length` CHECKs", () => {
    expect(hashPasscode(keys, "swordfish", LINK_A)).toHaveLength(32);
  });

  it("verifies the passcode it hashed", () => {
    const stored = hashPasscode(keys, "swordfish", LINK_A);
    expect(verifyPasscode(keys, "swordfish", LINK_A, stored)).toBe(true);
  });

  it("refuses a different passcode", () => {
    const stored = hashPasscode(keys, "swordfish", LINK_A);
    expect(verifyPasscode(keys, "swordfis", LINK_A, stored)).toBe(false);
  });

  it("is keyed, not a bare digest: a stolen column is not a wordlist attack", () => {
    const other = ring(KEY_OLD);
    const stored = hashPasscode(keys, "swordfish", LINK_A);
    expect(hashPasscode(other, "swordfish", LINK_A).equals(stored)).toBe(false);
    expect(verifyPasscode(other, "swordfish", LINK_A, stored)).toBe(false);
  });

  it("does not replay across links, because the scope carries the link id", () => {
    const stored = hashPasscode(keys, "swordfish", LINK_A);
    expect(verifyPasscode(keys, "swordfish", LINK_B, stored)).toBe(false);
    expect(hashPasscode(keys, "swordfish", LINK_B).equals(stored)).toBe(false);
  });

  it("normalises the same way on both sides, so a pasted space is not a wrong passcode", () => {
    const stored = hashPasscode(keys, "swordfish", LINK_A);
    expect(verifyPasscode(keys, "  swordfish  ", LINK_A, stored)).toBe(true);
  });

  it("still verifies after a key rotation, so rotating does not lock every live link out", () => {
    const stored = hashPasscode(ring(KEY_OLD), "swordfish", LINK_A);
    const rotated = ring(KEY_NEW, KEY_OLD);
    expect(verifyPasscode(rotated, "swordfish", LINK_A, stored)).toBe(true);
  });

  it("refuses once the old key has been dropped from the ring", () => {
    const stored = hashPasscode(ring(KEY_OLD), "swordfish", LINK_A);
    expect(verifyPasscode(ring(KEY_NEW), "swordfish", LINK_A, stored)).toBe(false);
  });

  it("refuses against a zero buffer without throwing, which is the no-passcode timing path", () => {
    expect(verifyPasscode(keys, "swordfish", LINK_A, Buffer.alloc(32))).toBe(false);
  });
});
