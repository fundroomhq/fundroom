import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * Unsubscribe tokens (RFC 8058 one-click + the footer link). HMAC-SHA256 under the
 * workspace's data key for the purpose `updates-unsubscribe` (envelope-encrypted per
 * workspace, ADR-0016), so a token never works across tenants and rotates with the key.
 * Payload: workspace, membership, key id, expiry; no email address in the URL.
 */
export const UNSUBSCRIBE_PURPOSE = "updates-unsubscribe";
export const UNSUBSCRIBE_TTL_DAYS = 400;

export interface UnsubscribePayload {
  readonly v: 1;
  readonly ws: string;
  readonly m: string;
  readonly k: string;
  /** Unix seconds. */
  readonly e: number;
}

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

function sign(key: Uint8Array, payload: string): string {
  return b64(createHmac("sha256", key).update(payload).digest());
}

export function signUnsubscribeToken(key: Uint8Array, payload: UnsubscribePayload): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(key, body)}`;
}

export function decodeUnsubscribeToken(token: string): UnsubscribePayload | undefined {
  const [body, sig] = token.split(".");
  if (!body || !sig || token.split(".").length !== 2) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const p = parsed as Record<string, unknown>;
    if (p["v"] !== 1) return undefined;
    if (typeof p["ws"] !== "string" || typeof p["m"] !== "string" || typeof p["k"] !== "string")
      return undefined;
    if (typeof p["e"] !== "number") return undefined;
    return { v: 1, ws: p["ws"], m: p["m"], k: p["k"], e: p["e"] };
  } catch {
    return undefined;
  }
}

export function verifyUnsubscribeToken(
  key: Uint8Array,
  token: string,
  now: Date,
): UnsubscribePayload | undefined {
  const payload = decodeUnsubscribeToken(token);
  if (payload === undefined) return undefined;
  const [body, sig] = token.split(".");
  const expected = Buffer.from(sign(key, body ?? ""));
  const given = Buffer.from(sig ?? "");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  if (payload.e * 1000 < now.getTime()) return undefined;
  return payload;
}
