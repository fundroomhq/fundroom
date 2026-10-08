import { createHmac } from "node:crypto";

/*
 * The challenge token (design/07 §2.2 step 1: `token = base32(HMAC(secret, tenant, domain))`).
 * It is derived, not random, and that is the point: re-rendering the admin screen, a second
 * replica, and the verify job all produce the same string without a read, and losing the row
 * loses nothing. It proves control of the zone and nothing else — it authorises no request,
 * so publishing it in public DNS costs us nothing, and because it is an HMAC it carries no
 * fragment of the key that made it.
 */

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Token length in base32 characters: 32 × 5 = 160 bits of the digest, uniformly. */
const TOKEN_CHARS = 32;

/**
 * RFC 4648 base32, lower-cased and unpadded. Deliberately re-implemented rather than
 * imported from `@fundroom/identity`: this package must stay dependency-free so the pure
 * verdict logic can run in a unit test, a job and (later) the classifier with nothing behind
 * it. Lower case because a founder retypes this into a DNS form by hand — and every
 * comparison against it is case-insensitive anyway (`verify.ts`).
 */
function base32(bytes: Uint8Array, chars: number): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= chars) break;
  }
  if (bits > 0 && out.length < chars) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * `base32(HMAC-SHA256(key, `${workspaceId}:${hostname}`))` truncated to 32 chars.
 * Reproducible, carries no secret of its own, stable across renders of the screen.
 *
 * `hostname` must already be the output of `normalizeHostname` — the token is bound to the
 * exact stored spelling, so a token minted for `ACME.com` would never match the row for
 * `acme.com`.
 */
export function challengeToken(key: Uint8Array, workspaceId: string, hostname: string): string {
  const mac = createHmac("sha256", key).update(`${workspaceId}:${hostname}`).digest();
  return base32(mac, TOKEN_CHARS);
}
