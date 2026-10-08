import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveForensicPatternKey,
  FORENSIC_KEY_PURPOSE,
  FORENSIC_TOKEN_BYTES,
  forensicSeed,
  newForensicToken,
} from "./keys.js";

const ENTRY = new Uint8Array(32).fill(7);

describe("forensic keys", () => {
  it("tokens are 8 random bytes", () => {
    const a = newForensicToken();
    const b = newForensicToken();
    expect(a).toHaveLength(FORENSIC_TOKEN_BYTES);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("derives the pattern key with HKDF-SHA256 under its own purpose", () => {
    const key = deriveForensicPatternKey(ENTRY);
    expect(key).toHaveLength(32);
    const expected = Buffer.from(
      hkdfSync("sha256", ENTRY, Buffer.alloc(0), FORENSIC_KEY_PURPOSE, 32),
    );
    expect(Buffer.from(key).equals(expected)).toBe(true);
    // domain separation: another purpose (the checkpoint HMAC sub-key) gives another key
    const other = Buffer.from(
      hkdfSync("sha256", ENTRY, Buffer.alloc(0), "seed-host/audit/checkpoint-hmac/v1", 32),
    );
    expect(Buffer.from(key).equals(other)).toBe(false);
    expect(
      Buffer.from(deriveForensicPatternKey(new Uint8Array(32).fill(8))).equals(Buffer.from(key)),
    ).toBe(false);
  });

  it("seed = HMAC-SHA256(patternKey, 'mark\\0' || token)", () => {
    const key = deriveForensicPatternKey(ENTRY);
    const token = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const seed = forensicSeed(key, token);
    const expected = createHmac("sha256", key)
      .update(Buffer.concat([Buffer.from("mark\0"), Buffer.from(token)]))
      .digest();
    expect(Buffer.from(seed).equals(expected)).toBe(true);
    expect(seed).toHaveLength(32);
    const other = forensicSeed(key, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9]));
    expect(Buffer.from(other).equals(Buffer.from(seed))).toBe(false);
  });

  it("refuses malformed inputs", () => {
    expect(() => deriveForensicPatternKey(new Uint8Array(4))).toThrow(RangeError);
    expect(() => forensicSeed(new Uint8Array(16), new Uint8Array(8))).toThrow(RangeError);
    expect(() => forensicSeed(new Uint8Array(32), new Uint8Array(7))).toThrow(RangeError);
  });
});
