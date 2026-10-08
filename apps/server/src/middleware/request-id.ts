import { randomUUID } from "node:crypto";
import { REQUEST_ID_HEADER } from "@fundroom/contracts";
import type { MiddlewareHandler } from "hono";

const INCOMING_RE = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * Every request gets an id (§10 "API"): the client's `X-Request-Id` when well-formed
 * (proxies and the SDK set one), else a fresh UUID. Echoed on the response, attached to
 * every log line and audit row, and returned in the error envelope.
 */
export function requestId(): MiddlewareHandler<{ Variables: { requestId: string } }> {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const id = incoming !== undefined && INCOMING_RE.test(incoming) ? incoming : randomUUID();
    c.set("requestId", id);
    c.header(REQUEST_ID_HEADER, id);
    await next();
  };
}
