/*
 * Standard Webhooks signing and verification (https://www.standardwebhooks.com), E3.4 / ADR-0052.
 *
 * Runtime-neutral on purpose: no imports, only WebCrypto (`globalThis.crypto.subtle`), `btoa`/
 * `atob` and `TextEncoder`, so `@fundroom/sdk` re-exports this file for receivers on Node ≥ 20,
 * Deno, Bun and edge runtimes. Import it as `@fundroom/webhooks/signature`.
 *
 *  - Secret: `whsec_` + base64(32 random bytes). The HMAC key is the base64-DECODED bytes.
 *  - Signed content: `${webhook-id}.${webhook-timestamp}.${body}` (timestamp in unix seconds).
 *  - `webhook-signature`: space-separated `v1,<base64 HMAC-SHA256>` — one per secret still valid
 *    (the current one, plus the previous one during a rotation's overlap window).
 */

export const WEBHOOK_SECRET_PREFIX = "whsec_";
export const WEBHOOK_SECRET_BYTES = 32;
/** Default freshness window for `webhook-timestamp`, both directions. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";

export type WebhookVerificationReason =
  | "missing_headers"
  | "invalid_secret"
  | "invalid_timestamp"
  | "timestamp_too_old"
  | "timestamp_too_new"
  | "no_matching_signature";

export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError";
  constructor(readonly reason: WebhookVerificationReason) {
    super(`webhook verification failed: ${reason}`);
  }
}

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(value: string): Uint8Array {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The HMAC key bytes of a secret (`whsec_` prefix optional, as the spec's libraries accept). */
export function webhookSecretBytes(secret: string): Uint8Array {
  const raw = secret.startsWith(WEBHOOK_SECRET_PREFIX)
    ? secret.slice(WEBHOOK_SECRET_PREFIX.length)
    : secret;
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(raw);
  } catch {
    throw new WebhookVerificationError("invalid_secret");
  }
  if (bytes.length === 0) throw new WebhookVerificationError("invalid_secret");
  return bytes;
}

/** A fresh secret: `whsec_` + base64(32 random bytes). Shown to the admin once. */
export function mintWebhookSecret(): string {
  const bytes = new Uint8Array(WEBHOOK_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return `${WEBHOOK_SECRET_PREFIX}${toBase64(bytes)}`;
}

function hmacKey(secret: string, usage: "sign" | "verify") {
  const bytes = webhookSecretBytes(secret);
  return crypto.subtle.importKey(
    "raw",
    bytes as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function signedContent(id: string, timestamp: number, body: string | Uint8Array): Uint8Array {
  const head = encoder.encode(`${id}.${timestamp}.`);
  const tail = typeof body === "string" ? encoder.encode(body) : body;
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

export interface SignPayloadInput {
  /** `webhook-id`: the delivery id, stable across retries. */
  readonly id: string;
  /** `webhook-timestamp`: unix seconds at send. */
  readonly timestamp: number;
  /** The exact body bytes that will be sent. */
  readonly body: string | Uint8Array;
  /** Current secret first, then any previous one still in its overlap window. */
  readonly secrets: readonly string[];
}

/** The `webhook-signature` header value: `v1,<sig>` per secret, space-separated. */
export async function signPayload(input: SignPayloadInput): Promise<string> {
  if (input.secrets.length === 0) throw new WebhookVerificationError("invalid_secret");
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new WebhookVerificationError("invalid_timestamp");
  }
  const content = signedContent(input.id, input.timestamp, input.body);
  const parts: string[] = [];
  for (const secret of input.secrets) {
    const key = await hmacKey(secret, "sign");
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, content as Uint8Array<ArrayBuffer>),
    );
    parts.push(`v1,${toBase64(mac)}`);
  }
  return parts.join(" ");
}

/** Headers as a `Headers` object or a Node-style record (names case-insensitive). */
export type WebhookHeaders =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() !== name) continue;
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v.join(" ");
  }
  return undefined;
}

export interface VerifyWebhookInput {
  readonly headers: WebhookHeaders;
  /** The raw request body, exactly as received (do not re-serialise parsed JSON). */
  readonly body: string | Uint8Array;
  readonly secret: string;
  readonly toleranceSeconds?: number | undefined;
  /** The clock (a `Date` or epoch milliseconds); default now. */
  readonly now?: Date | number | undefined;
}

export interface VerifiedWebhook {
  readonly id: string;
  readonly timestamp: number;
}

/**
 * Verifies a delivery: the three headers are present, the timestamp is within the tolerance
 * (both directions), and at least one `v1` signature matches (compared by WebCrypto's
 * constant-time `verify`). Throws `WebhookVerificationError` otherwise.
 */
export async function verifyWebhook(input: VerifyWebhookInput): Promise<VerifiedWebhook> {
  const id = header(input.headers, WEBHOOK_ID_HEADER);
  const ts = header(input.headers, WEBHOOK_TIMESTAMP_HEADER);
  const sig = header(input.headers, WEBHOOK_SIGNATURE_HEADER);
  if (!id || !ts || !sig) throw new WebhookVerificationError("missing_headers");
  if (!/^\d{1,15}$/u.test(ts)) throw new WebhookVerificationError("invalid_timestamp");
  const timestamp = Number(ts);
  const nowMs =
    input.now === undefined
      ? Date.now()
      : typeof input.now === "number"
        ? input.now
        : input.now.getTime();
  const nowSeconds = Math.floor(nowMs / 1000);
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (timestamp < nowSeconds - tolerance) throw new WebhookVerificationError("timestamp_too_old");
  if (timestamp > nowSeconds + tolerance) throw new WebhookVerificationError("timestamp_too_new");
  const key = await hmacKey(input.secret, "verify");
  const content = signedContent(id, timestamp, input.body);
  for (const part of sig.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0 || part.slice(0, comma) !== "v1") continue;
    let mac: Uint8Array;
    try {
      mac = fromBase64(part.slice(comma + 1));
    } catch {
      continue;
    }
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      mac as Uint8Array<ArrayBuffer>,
      content as Uint8Array<ArrayBuffer>,
    );
    if (ok) return { id, timestamp };
  }
  throw new WebhookVerificationError("no_matching_signature");
}
