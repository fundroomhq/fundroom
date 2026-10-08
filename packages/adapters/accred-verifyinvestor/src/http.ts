import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AccreditationProviderError, OutboundHttpError } from "@fundroom/ports";

/**
 * Small HTTP helpers shared by this adapter's calls. (Adapters may not import each other, so the
 * Parallel Markets adapter carries its own copy.) Rules:
 * - every call goes through the injected guarded fetch (`deps.fetch`), never the global one;
 * - no redirects are followed: a 3xx answer is an error, never chased;
 * - error messages name the vendor, the operation and the HTTP status, never a credential, a
 *   download URL or a vendor body we have not bounded and sanitised.
 */

/** JSON bodies from the vendor API are small; anything bigger is refused. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
/** Certificates are one-to-a-few-page PDFs; the port promises ≤10 MiB. */
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/** Constant-time equality of two byte strings; unequal lengths still spend a compare. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength || a.byteLength === 0) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function hmacSha256(key: string | Uint8Array, message: Uint8Array): Buffer {
  return createHmac("sha256", key).update(message).digest();
}

/**
 * A random per-port HMAC key used when no webhook secret is configured, so `parseCallback` still
 * spends one HMAC-SHA256 over the body: a connection without a secret then costs about the same as
 * one with a wrong signature (no timing oracle on "is a secret configured").
 */
export function decoyKey(): Buffer {
  return randomBytes(32);
}

/** Replace any occurrence of a secret in a vendor-supplied string, then bound its length. */
export function sanitize(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join("[redacted]");
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from vendor text
  out = out.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  return out.length > 160 ? `${out.slice(0, 157)}...` : out;
}

/** Map a thrown fetch failure (guard refusal, timeout, network) onto the port's error. */
export function fetchFailure(vendor: string, op: string, err: unknown): AccreditationProviderError {
  if (err instanceof AccreditationProviderError) return err;
  if (err instanceof OutboundHttpError) {
    switch (err.code) {
      case "response_too_large":
        return new AccreditationProviderError(
          `${vendor} ${op}: response too large`,
          "unavailable",
          false,
        );
      case "too_many_redirects":
        return new AccreditationProviderError(
          `${vendor} ${op}: vendor answered with a redirect (not followed)`,
          "unavailable",
          false,
        );
      case "timeout":
      case "dns_failed":
        return new AccreditationProviderError(`${vendor} ${op}: ${err.code}`, "unavailable", true);
      default:
        // blocked_scheme / blocked_host / blocked_port / blocked_address: a policy refusal that a
        // retry cannot fix (the base URL or a vendor-supplied URL points somewhere we never call).
        return new AccreditationProviderError(
          `${vendor} ${op}: refused by the outbound policy (${err.code})`,
          "unavailable",
          false,
        );
    }
  }
  return new AccreditationProviderError(`${vendor} ${op}: network error`, "unavailable", true);
}

/** Map a non-2xx HTTP status onto the port's error. `detail` is an already-sanitised vendor message. */
export function statusFailure(
  vendor: string,
  op: string,
  status: number,
  detail?: string,
): AccreditationProviderError {
  const suffix = detail !== undefined && detail.length > 0 ? `: ${detail}` : "";
  if (status >= 300 && status < 400) {
    return new AccreditationProviderError(
      `${vendor} ${op}: unexpected redirect (HTTP ${status})`,
      "unavailable",
      false,
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new AccreditationProviderError(
      `${vendor} ${op}: credentials rejected (HTTP ${status})`,
      "unauthorized",
      false,
      status,
    );
  }
  if (status === 404) {
    return new AccreditationProviderError(
      `${vendor} ${op}: not found (HTTP 404)`,
      "not_found",
      false,
      404,
    );
  }
  if (status === 409) {
    return new AccreditationProviderError(
      `${vendor} ${op}: conflict (HTTP 409)${suffix}`,
      "conflict",
      false,
      409,
    );
  }
  if (status === 429) {
    return new AccreditationProviderError(
      `${vendor} ${op}: rate limited (HTTP 429)`,
      "rate_limited",
      true,
      429,
    );
  }
  if (status >= 500) {
    return new AccreditationProviderError(
      `${vendor} ${op}: vendor unavailable (HTTP ${status})`,
      "unavailable",
      true,
      status,
    );
  }
  // 400 / 413 / 422 and any other 4xx: the vendor refused this request as made.
  return new AccreditationProviderError(
    `${vendor} ${op}: rejected (HTTP ${status})${suffix}`,
    "invalid_request",
    false,
    status,
  );
}

/**
 * Read a response body, refusing more than `maxBytes` while streaming (and up front when the
 * vendor declares a Content-Length). Cancels the stream on overflow.
 */
export async function readBounded(
  res: Response,
  maxBytes: number,
  vendor: string,
  op: string,
): Promise<Uint8Array> {
  const tooLarge = (): AccreditationProviderError =>
    new AccreditationProviderError(
      `${vendor} ${op}: response exceeds ${maxBytes} bytes`,
      "unavailable",
      false,
    );
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } catch (err) {
    throw fetchFailure(vendor, op, err);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Parse a bounded JSON body; any failure is a non-retryable `unavailable`. */
export async function readJson(res: Response, vendor: string, op: string): Promise<unknown> {
  const bytes = await readBounded(res, MAX_JSON_BYTES, vendor, op);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new AccreditationProviderError(
      `${vendor} ${op}: response is not JSON`,
      "unavailable",
      false,
    );
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse an ISO timestamp; undefined for anything that is not a valid date string. */
export function asDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Decode a callback body as a JSON object without ever throwing. */
export function parseJsonObject(body: Uint8Array): Record<string, unknown> | undefined {
  if (body.byteLength === 0 || body.byteLength > MAX_JSON_BYTES) return undefined;
  try {
    return asRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
  } catch {
    return undefined;
  }
}

/** A readable, bounded vendor error message (`error` or `message` field), or undefined. */
export async function vendorMessage(
  res: Response,
  secrets: readonly string[],
): Promise<string | undefined> {
  try {
    const bytes = await readBounded(res, 16 * 1024, "vendor", "error body");
    const parsed = asRecord(JSON.parse(new TextDecoder().decode(bytes)));
    const msg = asString(parsed?.["error"]) ?? asString(parsed?.["message"]);
    return msg === undefined ? undefined : sanitize(msg, secrets);
  } catch {
    return undefined;
  }
}

/** Clip a vendor string to the port's length bound. */
export function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
