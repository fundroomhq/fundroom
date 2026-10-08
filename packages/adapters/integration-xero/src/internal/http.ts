/*
 * Vendor HTTP for one integration adapter (E3.6, ADR-0054).
 *
 * NOTE: `http.ts`, `decimal.ts` and `months.ts` under `src/internal/` are deliberately copied
 * verbatim between `@fundroom/integration-quickbooks`, `-xero` and `-stripe` (the contract allows
 * adapters exactly one runtime dependency, `@fundroom/ports`, and no new shared package). Change
 * one, change all three.
 *
 * Rules enforced here, once, for every call an adapter makes:
 * - `redirect: "manual"` — a redirect is never followed (the container's guard also refuses them);
 *   a 3xx answer is a `transport` failure, not something to chase with our bearer token attached.
 * - bodies are capped at 2 MiB (the guard caps too; this is the adapter's own belt);
 * - a thrown `OutboundHttpError` is the guard speaking and maps like `@fundroom/sheets-google`:
 *   `response_too_large` → `too_large`, anything else → `transport`;
 * - status → failure: 401 `unauthorized`, 403 `forbidden`, 404 `not_found`, 429 `rate_limited`,
 *   5xx `unavailable`, other non-2xx `transport`. Rate limits are reported, never waited out.
 * - `init.signal` (the caller's `KpiReadRequest.signal`) is passed to fetch and checked before
 *   every call, so paging stops between pages: an aborted read answers
 *   `{ok:false, reason:"unavailable", detail:"aborted"}` (never `transport`);
 * - a `detail` never carries a token, a code, a response body or a vendor message — only the
 *   operation name and the HTTP status.
 */
import { type IntegrationFailure, type OutboundFetch, OutboundHttpError } from "@fundroom/ports";

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** KPI reads may page, but stop here and answer `too_large` (contract §1). */
export const MAX_PAGES = 50;

export interface Failure {
  ok: false;
  reason: IntegrationFailure;
  detail?: string;
}

export function fail(reason: IntegrationFailure, detail?: string): Failure {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

export interface RawResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON, or `undefined` when the body was empty or not JSON. */
  json: unknown;
}

export type Logger = (event: string, fields: Record<string, unknown>) => void;

/** The caller aborted the read (`KpiReadRequest.signal`). */
export function abortedFailure(): Failure {
  return fail("unavailable", "aborted");
}

/** `{signal}` for a RequestInit when there is one (exactOptionalPropertyTypes-safe). */
export function withSignal(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

/** An `OutboundHttpError` is the guard speaking, and `response_too_large` is the one we name. */
export function transportFailure(error: unknown, where: string): Failure {
  const guarded =
    error instanceof OutboundHttpError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { name?: unknown }).name === "OutboundHttpError");
  if (guarded) {
    const code = (error as OutboundHttpError).code;
    if (code === "response_too_large") {
      return fail("too_large", `the ${where} response exceeded the outbound size cap`);
    }
    return fail("transport", `the ${where} request was refused by the outbound guard (${code})`);
  }
  return fail("transport", `the ${where} request failed`);
}

export function statusFailure(status: number, where: string): Failure {
  if (status === 401) return fail("unauthorized", `${where} answered HTTP 401`);
  if (status === 403) return fail("forbidden", `${where} answered HTTP 403`);
  if (status === 404) return fail("not_found", `${where} answered HTTP 404`);
  if (status === 429) return fail("rate_limited", `${where} answered HTTP 429`);
  if (status >= 300 && status < 400) {
    return fail(
      "transport",
      `${where} answered a redirect (HTTP ${status}); redirects are never followed`,
    );
  }
  if (status >= 500) return fail("unavailable", `${where} answered HTTP ${status}`);
  return fail("transport", `${where} answered HTTP ${status}`);
}

/**
 * One request. Resolves to the status, headers and parsed JSON body for ANY status (callers that
 * need the body of an error — token endpoints — read it); only transport problems and oversized
 * bodies are failures here.
 */
export async function send(
  fetch: OutboundFetch,
  url: string,
  init: RequestInit,
  where: string,
  log?: Logger,
): Promise<{ ok: true; value: RawResponse } | Failure> {
  const signal = init.signal ?? undefined;
  if (signal?.aborted) return abortedFailure();
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "manual" });
  } catch (error) {
    if (signal?.aborted) return abortedFailure();
    log?.("integration.http_unreachable", { where, level: "warn" });
    return transportFailure(error, where);
  }
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    response.body?.cancel().catch(() => {});
    return fail("too_large", `the ${where} response is over the ${MAX_RESPONSE_BYTES} byte cap`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) return abortedFailure();
    return transportFailure(error, where);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    return fail("too_large", `the ${where} response is over the ${MAX_RESPONSE_BYTES} byte cap`);
  }
  let json: unknown;
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = undefined;
    }
  }
  if (response.status < 200 || response.status >= 300) {
    log?.("integration.http_status", { where, status: response.status, level: "warn" });
  }
  return { ok: true, value: { status: response.status, headers: response.headers, json } };
}

/** GET/POST expecting a 2xx JSON object; everything else is a typed failure. */
export async function requestJson(
  fetch: OutboundFetch,
  url: string,
  init: RequestInit,
  where: string,
  log?: Logger,
): Promise<{ ok: true; value: Record<string, unknown> | unknown[] } | Failure> {
  const sent = await send(fetch, url, init, where, log);
  if (!sent.ok) return sent;
  const { status, json } = sent.value;
  if (status < 200 || status >= 300) return statusFailure(status, where);
  if (typeof json !== "object" || json === null) {
    return fail("malformed", `${where} did not answer with a JSON object`);
  }
  return { ok: true, value: json as Record<string, unknown> | unknown[] };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function basicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}
