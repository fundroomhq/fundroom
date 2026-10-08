/*
 * Test double for `deps.fetch` (copied verbatim between the three KPI adapter packages; no shared
 * test package by design). Records every request and answers from a handler.
 */
import type { OutboundFetch } from "@fundroom/ports";

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
  redirect: RequestInit["redirect"];
  signal: AbortSignal | null;
}

export type Handler = (req: RecordedRequest) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: OutboundFetch;
  calls: RecordedRequest[];
}

export function fakeFetch(handler: Handler): FakeFetch {
  const calls: RecordedRequest[] = [];
  const fetch: OutboundFetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const body = init?.body;
    const req: RecordedRequest = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body:
        typeof body === "string" ? body : body === undefined || body === null ? null : String(body),
      redirect: init?.redirect,
      signal: init?.signal ?? null,
    };
    calls.push(req);
    return handler(req);
  };
  return { fetch, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Routes by `METHOD pathname` (exact) or a predicate; unmatched requests fail the test loudly. */
export function router(routes: Record<string, Handler>, fallback?: Handler): Handler {
  return (req) => {
    const key = `${req.method} ${req.url.pathname}`;
    const handler = routes[key] ?? fallback;
    if (handler === undefined) throw new Error(`unexpected request ${key}`);
    return handler(req);
  };
}

export function formOf(req: RecordedRequest): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(req.body ?? ""));
}
