import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyRing } from "@fundroom/config";
import { deriveKey, KEY_PURPOSES } from "./keys.js";

/*
 * AES-256-GCM envelope for small secrets stored in the identity tables (TOTP seeds, OIDC
 * transient state). Format: `sb1.<key id>.<iv>.<ciphertext>.<tag>` with base64url parts.
 * The key id lets `open()` pick the right ring entry after a rotation; re-encrypt lazily by
 * calling `seal()` again with the current key when `needsReseal()` says so.
 */
const PREFIX = "sb1";
const IV_BYTES = 12;

export class SecretBoxError extends Error {
  override readonly name = "SecretBoxError";
}

export function seal(ring: KeyRing, plaintext: Uint8Array, aad = ""): string {
  const key = deriveKey(ring.current, KEY_PURPOSES.secretBox);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    ring.current.id,
    iv.toString("base64url"),
    ct.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function open(ring: KeyRing, sealed: string, aad = ""): Uint8Array {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== PREFIX) throw new SecretBoxError("malformed secret box");
  const [, keyId, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
  const entry = ring.get(keyId);
  if (!entry) throw new SecretBoxError(`no key ${JSON.stringify(keyId)} in the ring`);
  const key = deriveKey(entry, KEY_PURPOSES.secretBox);
  // The tag is pinned to 16 bytes (ASVS F-22): Node's GCM otherwise accepts a truncated tag
  // (down to 4 bytes) and checks only that prefix, which makes a forgery 2^32 guesses away.
  const tag = Buffer.from(tagB64, "base64url");
  if (tag.byteLength !== 16) throw new SecretBoxError("authentication failed");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"), {
    authTagLength: 16,
  });
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]);
  } catch {
    throw new SecretBoxError("authentication failed");
  }
}

/** True when the value was sealed under a key that is no longer current. */
export function needsReseal(ring: KeyRing, sealed: string): boolean {
  const keyId = sealed.split(".")[1];
  return keyId !== ring.current.id;
}
