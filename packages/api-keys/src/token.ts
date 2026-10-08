import { createHash, randomBytes } from "node:crypto";

/*
 * The API key token (E3.4, ADR-0052).
 *
 * `frk_` + base64url(32 random bytes) = 4 + 43 = 47 characters. 256 bits of entropy, so the
 * store is a plain sha256 (like a share-link or invite token): no dictionary runs against a
 * high-entropy secret, and the lookup is one indexed equality on `api_key_token_hash_idx`.
 * The plaintext is returned once by create/rotate and stored nowhere. The prefix makes a leaked
 * key recognisable to secret scanners (`.gitleaks.toml`) and lets the bearer resolver ignore
 * every other `Authorization: Bearer` value (METRICS_TOKEN on ops routes keeps working).
 *
 * A-2 (ADR-0062): new keys are minted `frk_`. Keys minted before the rename carry the legacy
 * `shk_` prefix and keep working indefinitely — the stored digest covers the whole token, prefix
 * included, so only the guards below have to accept both; rotating a key moves it to `frk_`.
 */

/** The prefix every new token is minted with. */
export const API_KEY_TOKEN_PREFIX = "frk_";
/** The pre-rename prefix, still accepted (never minted). */
export const LEGACY_API_KEY_TOKEN_PREFIX = "shk_";
/** Every prefix the guards accept: the current one first. */
export const API_KEY_TOKEN_PREFIXES = [API_KEY_TOKEN_PREFIX, LEGACY_API_KEY_TOKEN_PREFIX] as const;
/** Random bytes in a token. */
export const API_KEY_TOKEN_BYTES = 32;
/** The whole token: prefix + 43 base64url characters. */
export const API_KEY_TOKEN_LENGTH = 47;
/** Characters of the token kept in clear for display (`frk_` + 8). */
export const API_KEY_DISPLAY_PREFIX_LENGTH = 12;
/** The plausibility guard, checked before any hashing or database work. */
export const API_KEY_TOKEN_RE = /^(?:frk|shk)_[A-Za-z0-9_-]{43}$/u;

/** A fresh token. Returned to the caller once and stored nowhere. */
export function mintApiKeyToken(): string {
  return `${API_KEY_TOKEN_PREFIX}${randomBytes(API_KEY_TOKEN_BYTES).toString("base64url")}`;
}

/** What goes in `api_key.token_hash`: sha256 of the whole token (32 bytes, the CHECK's length). */
export function apiKeyTokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Could this be one of our tokens at all? Shape only, not authentication: an unauthenticated
 * caller must not make us hash and index-probe arbitrary input.
 */
export function isPlausibleApiKey(token: unknown): token is string {
  return typeof token === "string" && API_KEY_TOKEN_RE.test(token);
}

/** Does this `Authorization: Bearer` value claim to be an API key (even a malformed one)? */
export function looksLikeApiKey(bearer: string): boolean {
  return API_KEY_TOKEN_PREFIXES.some((prefix) => bearer.startsWith(prefix));
}

/** The display prefix stored in `api_key.prefix` (`frk_Ab3dE6gH`, or `shk_…` for a legacy key). */
export function displayPrefix(token: string): string {
  return token.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}
