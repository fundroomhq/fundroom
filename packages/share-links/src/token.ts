import { hashCode, randomToken, sha256, verifyCode } from "@fundroom/identity";
import { PASSCODE_MAX_LENGTH, PASSCODE_MIN_LENGTH } from "./policy.js";

/*
 * The two secrets a share link carries, and why they are stored differently.
 *
 * Both primitives come from `@fundroom/identity` (E2.3 contract S2): `randomToken`, `sha256`,
 * `hashCode` and `verifyCode` are the kernel's security primitives and are not re-implemented
 * here. The dependency runs share-links → identity and never the other way; the seam identity
 * needs is the structural `ShareLinkAccess` the server wires (`service/links.ts`).
 *
 * ## The token: 256 bits, stored as a plain sha256
 *
 * `randomToken()` is 32 bytes of `randomBytes`, base64url. A plain digest is the right store for
 * it *because* it is high entropy: there is no dictionary to run against a stolen `token_hash`
 * column, and an unkeyed digest means the lookup is a single indexed equality on
 * `share_link_token_hash_idx` rather than a scan. This is exactly what `InviteRepo.findByTokenHash`
 * does with an invitation token.
 *
 * The plaintext is returned by `mint()` once and never stored. Losing it means minting a new link.
 *
 * ## The passcode: low entropy, so a keyed HMAC
 *
 * A passcode is chosen by a human and typed by a visitor, so it lives in the space a wordlist
 * covers. `sha256("hunter2")` in a leaked backup is the passcode; `HMAC(k, "share_link:<id>
 * hunter2")` is not, unless the key ring leaks too. `hashCode`/`verifyCode` derive that key from
 * the ring by HKDF under a fixed purpose label, and `verifyCode` walks every ring entry so a key
 * rotation does not lock every live link out.
 *
 * The scope string includes the **link id**, so the same passcode on two links produces two
 * different MACs: an attacker with the column cannot see that two links share a passcode, and a
 * MAC cannot be replayed from one link onto another.
 */

/** Bytes of entropy in a link token. 256 bits: the same budget as a session token. */
export const SHARE_LINK_TOKEN_BYTES = 32;

/**
 * The shortest string that could be a token: 32 bytes base64url is 43 characters. Checked before
 * hashing so a `?token=x` probe costs one comparison rather than a digest and an index probe —
 * the same guard `InviteService.resolve` makes at `packages/identity/src/services/invites.ts:199`.
 */
export const SHARE_LINK_TOKEN_MIN_LENGTH = 43;

/** A fresh link token. Returned to the admin once, by `mint()`, and stored nowhere. */
export function mintToken(): string {
  return randomToken(SHARE_LINK_TOKEN_BYTES);
}

/** What goes in `share_link.token_hash`: 32 bytes, matching the migration's `octet_length` CHECK. */
export function tokenHash(token: string): Buffer {
  return sha256(token);
}

/**
 * Could this string be one of our tokens at all? A length and alphabet guard, not authentication:
 * it exists so an unauthenticated caller cannot make us hash and index-probe arbitrary input, and
 * so that `resolve` answers `undefined` for junk without touching the database.
 */
export function isPlausibleToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    token.length >= SHARE_LINK_TOKEN_MIN_LENGTH &&
    token.length <= 512 &&
    /^[A-Za-z0-9_-]+$/u.test(token)
  );
}

/**
 * The HMAC scope for a link's passcode. The link id is in it so the same passcode on two links
 * has two MACs — see the header. Changing this string invalidates every stored passcode, so it
 * is versioned and must be treated as part of the hash format.
 */
export function passcodeScope(linkId: string): string {
  return `share_link:v1:${linkId}`;
}

/**
 * Trims and collapses the whitespace a visitor's browser, password manager or phone keyboard adds
 * around a typed passcode. Case is **kept**: unlike an OTP or a recovery code, a passcode is a
 * chosen secret and folding its case throws away entropy the admin thought they had.
 */
export function normalizePasscode(input: string): string {
  return input.trim();
}

/** Is this something we will accept as a passcode when minting? Length only; anything may be typed. */
export function isAcceptablePasscode(passcode: string): boolean {
  const normalized = normalizePasscode(passcode);
  return normalized.length >= PASSCODE_MIN_LENGTH && normalized.length <= PASSCODE_MAX_LENGTH;
}

/**
 * The key ring `hashCode`/`verifyCode` take, without importing `@fundroom/config`: this package
 * has no business knowing how the operator's keys are loaded, only that the composition root
 * hands it whatever identity's own primitives accept. Derived from the primitive so the two
 * cannot drift.
 */
export type CodeKeyRing = Parameters<typeof hashCode>[0];

/** What goes in `share_link.passcode_hash`. Never a plain digest — see the header. */
export function hashPasscode(ring: CodeKeyRing, passcode: string, linkId: string): Buffer {
  return hashCode(ring, normalizePasscode(passcode), passcodeScope(linkId));
}

/**
 * Constant-time per ring entry, via identity's `verifyCode`. Called even when the link has no
 * passcode (against a zero buffer) so that "this link has no passcode" and "this passcode is
 * wrong" cost the same — the same trick `email-otp.verify` plays at
 * `packages/identity/src/services/email-otp.ts:203`.
 */
export function verifyPasscode(
  ring: CodeKeyRing,
  passcode: string,
  linkId: string,
  stored: Uint8Array,
): boolean {
  return verifyCode(ring, normalizePasscode(passcode), passcodeScope(linkId), stored);
}
