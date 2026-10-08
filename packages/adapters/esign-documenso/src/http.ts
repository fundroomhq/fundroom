import { timingSafeEqual } from "node:crypto";
import { ESignProviderError, OutboundHttpError } from "@fundroom/ports";

/**
 * Small HTTP helpers shared by this adapter's calls. (Adapters may not import each other, so the
 * DocuSeal adapter carries its own copy.) Rules:
 * - every call goes through the injected guarded fetch (`deps.fetch`), never the global one;
 * - no redirects are expected: a 3xx answer is an `invalid_response`, never followed;
 * - error messages name the vendor, the operation and the HTTP status, never a credential, a
 *   presigned URL or a response body we have not bounded and sanitised.
 */

/** JSON bodies from the vendor API are small; anything bigger is refused. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PDF_MAGIC.length && PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/** Constant-time string equality on equal-length buffers; unequal lengths still spend a compare. */
export function secretEquals(
  given: string | null | undefined,
  expected: string | undefined,
): boolean {
  if (typeof given !== "string" || expected === undefined || expected.length === 0) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
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
export function fetchFailure(vendor: string, op: string, err: unknown): ESignProviderError {
  if (err instanceof ESignProviderError) return err;
  if (err instanceof OutboundHttpError) {
    switch (err.code) {
      case "response_too_large":
        return new ESignProviderError(`${vendor} ${op}: response too large`, "too_large", false);
      case "too_many_redirects":
        return new ESignProviderError(
          `${vendor} ${op}: vendor answered with a redirect (not followed)`,
          "invalid_response",
          false,
        );
      case "timeout":
      case "dns_failed":
        return new ESignProviderError(`${vendor} ${op}: ${err.code}`, "unavailable", true);
      default:
        // blocked_scheme / blocked_host / blocked_port / blocked_address: a policy refusal that a
        // retry cannot fix (the base URL or a vendor-supplied URL points somewhere we never call).
        return new ESignProviderError(
          `${vendor} ${op}: refused by the outbound policy (${err.code})`,
          "unavailable",
          false,
        );
    }
  }
  return new ESignProviderError(`${vendor} ${op}: network error`, "unavailable", true);
}

/** Map a non-2xx HTTP status onto the port's error. `detail` is an already-sanitised vendor message. */
export function statusFailure(
  vendor: string,
  op: string,
  status: number,
  detail?: string,
): ESignProviderError {
  const suffix = detail !== undefined && detail.length > 0 ? `: ${detail}` : "";
  if (status >= 300 && status < 400) {
    return new ESignProviderError(
      `${vendor} ${op}: unexpected redirect (HTTP ${status})`,
      "invalid_response",
      false,
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new ESignProviderError(
      `${vendor} ${op}: credentials rejected (HTTP ${status})`,
      "unauthorized",
      false,
      status,
    );
  }
  if (status === 404) {
    return new ESignProviderError(`${vendor} ${op}: not found (HTTP 404)`, "not_found", false, 404);
  }
  if (status === 429) {
    return new ESignProviderError(
      `${vendor} ${op}: rate limited (HTTP 429)`,
      "rate_limited",
      true,
      429,
    );
  }
  if (status >= 500) {
    return new ESignProviderError(
      `${vendor} ${op}: vendor unavailable (HTTP ${status})`,
      "unavailable",
      true,
      status,
    );
  }
  // 400 / 409 / 413 / 422 and any other 4xx: the vendor refused this request as made.
  return new ESignProviderError(
    `${vendor} ${op}: rejected (HTTP ${status})${suffix}`,
    "rejected",
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
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new ESignProviderError(
      `${vendor} ${op}: artifact exceeds ${maxBytes} bytes`,
      "too_large",
      false,
    );
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
        throw new ESignProviderError(
          `${vendor} ${op}: artifact exceeds ${maxBytes} bytes`,
          "too_large",
          false,
        );
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

/** Parse a bounded JSON body; any failure is `invalid_response`. */
export async function readJson(res: Response, vendor: string, op: string): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await readBounded(res, MAX_JSON_BYTES, vendor, op);
  } catch (err) {
    if (err instanceof ESignProviderError && err.code === "too_large") {
      throw new ESignProviderError(
        `${vendor} ${op}: response too large`,
        "invalid_response",
        false,
      );
    }
    throw err;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ESignProviderError(
      `${vendor} ${op}: response is not JSON`,
      "invalid_response",
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

/** A readable, bounded vendor error message (`message` or `error` field), or undefined. */
export async function vendorMessage(
  res: Response,
  secrets: readonly string[],
): Promise<string | undefined> {
  try {
    const bytes = await readBounded(res, 16 * 1024, "vendor", "error body");
    const parsed = asRecord(JSON.parse(new TextDecoder().decode(bytes)));
    const msg = asString(parsed?.["message"]) ?? asString(parsed?.["error"]);
    return msg === undefined ? undefined : sanitize(msg, secrets);
  } catch {
    return undefined;
  }
}
