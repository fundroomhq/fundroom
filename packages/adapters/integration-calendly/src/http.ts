import { type IntegrationFailure, type OutboundFetch, OutboundHttpError } from "@fundroom/ports";

/**
 * Small HTTP helpers for this adapter. (Adapters may not import each other, so the booking
 * adapters carry their own copy.) Rules:
 * - every call goes through the injected guarded fetch (`deps.fetch`), never the global one;
 * - no redirect is followed: `redirect: "manual"` here and `maxRedirects: 0` on the guarded agent;
 *   a 3xx answer is `malformed`;
 * - a response body is read up to {@link MAX_RESPONSE_BYTES}; more is `too_large`;
 * - a failure `detail` is a short fixed phrase or a vendor error token matching a strict pattern —
 *   never a token, a request URL, or free text from the far side.
 */

/** Per-call response cap (contract §1): 2 MiB. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type Failure = { ok: false; reason: IntegrationFailure; detail?: string };

export function failure(reason: IntegrationFailure, detail?: string): Failure {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

/** A vendor error token (`channel_not_found`, `invalid_auth`) is echoed only when it looks like one. */
export function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.]{1,64}$/u.test(value) ? value : undefined;
}

export interface SentResponse {
  readonly ok: true;
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

async function readCapped(response: Response): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Sends one request; transport problems become typed failures, never throws. */
export async function send(
  fetch: OutboundFetch,
  url: string,
  init: RequestInit,
): Promise<SentResponse | Failure> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "manual" });
  } catch (error) {
    if (error instanceof OutboundHttpError) {
      if (error.code === "response_too_large") return failure("too_large", "response too large");
      if (error.code === "too_many_redirects") return failure("malformed", "unexpected redirect");
      return failure("transport", `could not reach the vendor (${error.code})`);
    }
    return failure("transport", "could not reach the vendor");
  }
  let body: string | undefined;
  try {
    body = await readCapped(response);
  } catch {
    return failure("transport", "could not read the response");
  }
  if (body === undefined) return failure("too_large", "response too large");
  return { ok: true, status: response.status, headers: response.headers, body };
}

/** Non-2xx status → typed failure; `undefined` for 2xx. */
export function statusFailure(status: number, token?: string): Failure | undefined {
  if (status >= 200 && status < 300) return undefined;
  const suffix = token === undefined ? "" : ` (${token})`;
  if (status >= 300 && status < 400)
    return failure("malformed", `unexpected redirect (HTTP ${status})`);
  if (status === 401) return failure("unauthorized", `HTTP 401${suffix}`);
  if (status === 403) return failure("forbidden", `HTTP 403${suffix}`);
  if (status === 404 || status === 410) return failure("not_found", `HTTP ${status}${suffix}`);
  if (status === 413) return failure("too_large", `HTTP 413${suffix}`);
  if (status === 429) return failure("rate_limited", `HTTP 429${suffix}`);
  if (status >= 500) return failure("unavailable", `HTTP ${status}${suffix}`);
  return failure("malformed", `HTTP ${status}${suffix}`);
}

export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
