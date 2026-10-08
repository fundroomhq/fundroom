import { createHash, randomBytes } from "node:crypto";

/*
 * The SCIM bearer token (E3.8, ADR-0056): `frs_` + base64url(32 random bytes) = 47 characters,
 * the API-key recipe (`packages/api-keys/src/token.ts`) with its own prefix. 256 bits of entropy,
 * so the store is a plain sha256 and the lookup one indexed equality on `scim_token_hash_idx`.
 * Returned once by `createToken`, stored nowhere.
 *
 * A-2 (ADR-0062): new tokens are minted `frs_`; tokens minted before the rename carry the legacy
 * `shs_` prefix and keep authenticating (the digest covers the whole token, so only the shape guard
 * has to accept both). Rotating a token moves the identity provider to `frs_`.
 */

/** The prefix every new token is minted with. */
export const SCIM_TOKEN_PREFIX = "frs_";
/** The pre-rename prefix, still accepted (never minted). */
export const LEGACY_SCIM_TOKEN_PREFIX = "shs_";
export const SCIM_TOKEN_BYTES = 32;
/** Characters kept in clear for the admin list (`frs_` + 8). */
export const SCIM_DISPLAY_PREFIX_LENGTH = 12;
/** The shape guard: either prefix + 43 base64url characters. */
export const SCIM_TOKEN_RE = /^(?:frs|shs)_[A-Za-z0-9_-]{43}$/u;
/** Live tokens per workspace (two, so a rotation can overlap). */
export const SCIM_MAX_LIVE_TOKENS = 2;

export function mintScimToken(): string {
  return `${SCIM_TOKEN_PREFIX}${randomBytes(SCIM_TOKEN_BYTES).toString("base64url")}`;
}

export function scimTokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/** Shape only: an unauthenticated caller must not make us hash and probe arbitrary input. */
export function isPlausibleScimToken(token: unknown): token is string {
  return typeof token === "string" && SCIM_TOKEN_RE.test(token);
}

export function scimDisplayPrefix(token: string): string {
  return token.slice(0, SCIM_DISPLAY_PREFIX_LENGTH);
}
