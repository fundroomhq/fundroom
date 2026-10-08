import { ESignProviderError } from "@fundroom/ports";

/**
 * HTTP plumbing shared by every Dropbox Sign call: status → `ESignProviderError` mapping, bounded body
 * reads, and JSON parsing that never lets a vendor message (which can echo our input) or a
 * credential reach an error string. Error messages name the operation, the HTTP status and at most
 * the vendor's machine-readable error code.
 */

const ERROR_CODE_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const JSON_LIMIT = 1024 * 1024;

export function mapHttpError(op: string, status: number, vendorCode?: string): ESignProviderError {
  const suffix = vendorCode && ERROR_CODE_RE.test(vendorCode) ? ` [${vendorCode}]` : "";
  const msg = `dropbox-sign: ${op} failed (HTTP ${status})${suffix}`;
  if (status === 401 || status === 403)
    return new ESignProviderError(msg, "unauthorized", false, status);
  if (status === 404) return new ESignProviderError(msg, "not_found", false, status);
  if (status === 429) return new ESignProviderError(msg, "rate_limited", true, status);
  if (status >= 500) return new ESignProviderError(msg, "unavailable", true, status);
  // 400/409/422 and anything else unexpected: the vendor refused this request as sent.
  return new ESignProviderError(msg, "rejected", false, status);
}

/** `deps.fetch` with network failures (DNS, reset, timeout, guard refusal) mapped to `unavailable`. */
export async function send(
  fetchFn: typeof fetch,
  op: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchFn(url, { ...init, redirect: "manual" });
  } catch (err) {
    if (err instanceof ESignProviderError) throw err;
    throw new ESignProviderError(`dropbox-sign: ${op} failed (network)`, "unavailable", true);
  }
}

/** Read at most `maxBytes` of a body; `too_large` beyond it (checked on Content-Length first). */
export async function readBounded(
  res: Response,
  op: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new ESignProviderError(
      `dropbox-sign: ${op} exceeds ${maxBytes} bytes`,
      "too_large",
      false,
    );
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ESignProviderError(
          `dropbox-sign: ${op} exceeds ${maxBytes} bytes`,
          "too_large",
          false,
        );
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ESignProviderError) throw err;
    throw new ESignProviderError(`dropbox-sign: ${op} failed (network)`, "unavailable", true);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function readJson(res: Response, op: string): Promise<unknown> {
  const bytes = await readBounded(res, op, JSON_LIMIT).catch((err: unknown) => {
    if (err instanceof ESignProviderError && err.code === "too_large") {
      throw new ESignProviderError(
        `dropbox-sign: ${op} returned an oversized response`,
        "invalid_response",
        false,
      );
    }
    throw err;
  });
  if (bytes.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ESignProviderError(
      `dropbox-sign: ${op} returned invalid JSON`,
      "invalid_response",
      false,
      res.status,
    );
  }
}

/** Dropbox Sign errors are `{ error: { error_name, error_msg, error_path } }`; only the name is kept. */
function vendorCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body["error"])) return undefined;
  const code = body["error"]["error_name"];
  return typeof code === "string" ? code : undefined;
}

/** Throw the mapped error for a non-2xx response; parse and return the JSON body otherwise. */
export async function jsonOrThrow(res: Response, op: string): Promise<unknown> {
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new ESignProviderError(
      `dropbox-sign: ${op} was redirected`,
      "invalid_response",
      false,
      res.status,
    );
  }
  if (!res.ok) {
    let body: unknown;
    try {
      body = await readJson(res, op);
    } catch {
      body = undefined;
    }
    throw mapHttpError(op, res.status, vendorCode(body));
  }
  const body = await readJson(res, op);
  return body;
}

export async function throwForStatus(res: Response, op: string): Promise<void> {
  if (res.ok) return;
  await jsonOrThrow(res, op);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function invalid(op: string, what: string): ESignProviderError {
  return new ESignProviderError(`dropbox-sign: ${op} returned ${what}`, "invalid_response", false);
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function isPdf(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}
