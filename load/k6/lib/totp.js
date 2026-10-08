import { sleep } from "k6";
import crypto from "k6/crypto";

/*
 * RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for the owner's second factor. Owners and admins need
 * auth level 2 for every staff route, and a seed-demo owner has no factor enrolled, so setup()
 * enrols one over the API and steps up with it (see session.js `stepUpOwner`).
 */
function base32ToBytes(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out).buffer;
}

export function totpCode(secretBase32, at = Date.now()) {
  let counter = Math.floor(at / 1000 / 30);
  const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    msg[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hex = crypto.hmac("sha1", base32ToBytes(secretBase32), msg.buffer, "hex");
  const bytes = hex.match(/../g).map((h) => Number.parseInt(h, 16));
  const offset = bytes[19] & 0x0f;
  const bin =
    ((bytes[offset] & 0x7f) << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

/** A code from a later time step than `used` (codes are single-use). Waits up to ~31 s. */
export function freshTotpCode(secretBase32, used) {
  for (let i = 0; i < 64; i++) {
    const code = totpCode(secretBase32);
    if (code !== used) return code;
    sleep(0.5);
  }
  throw new Error("no fresh TOTP code within a time step");
}
