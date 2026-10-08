import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 256-bit opaque token, base64url (43 chars). Sessions, magic links, invites, devices. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(input: string | Uint8Array): Buffer {
  return createHash("sha256").update(input).digest();
}

export function hmacSha256(key: Uint8Array, input: string | Uint8Array): Buffer {
  return createHmac("sha256", key).update(input).digest();
}

/** Constant-time equality that does not leak length either (compares digests when lengths differ). */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    // Still burn a comparison so the timing profile matches.
    timingSafeEqual(sha256(a), sha256(b));
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Numeric one-time code with a uniform distribution, zero-padded. */
export function otpCode(digits = 6): string {
  if (digits < 4 || digits > 10) throw new RangeError("otp digits must be 4..10");
  const max = 10 ** digits;
  return randomInt(0, max).toString().padStart(digits, "0");
}

/** Recovery code: 8 base32 characters (40 bits) grouped `xxxx-xxxx`, lower case for typing. */
export function recoveryCode(): string {
  const raw = base32Encode(randomBytes(5)).toLowerCase();
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

/** Normalises user-typed codes: trims, strips spaces/dashes, lower-cases. */
export function normalizeCode(input: string): string {
  return input.replace(/[\s-]+/gu, "").toLowerCase();
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding (what authenticator apps expect). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/=+$/u, "").replace(/[\s-]/gu, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character ${JSON.stringify(ch)}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}
