import { ApiError, errorResponse, requestIdOf, toApiError } from "@fundroom/contracts";
import { pgErrorCode } from "@fundroom/db";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Log } from "../logger.js";
import { isAuthzDenial, markSecurityEvent } from "./security-events.js";

/*
 * One error surface for the API (§10): every failure becomes the envelope with a stable
 * code and the request id. Identity's `AuthError` maps by code; Hono's `HTTPException`
 * (body too large, unsupported media type, method not allowed) maps by status; anything
 * else is `internal_error` and is logged with the stack, never returned.
 */
const STATUS_TO_CODE: Readonly<Record<number, ConstructorParameters<typeof ApiError>[0]>> = {
  400: "invalid_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
  503: "service_unavailable",
};

export function normalizeError(error: unknown): ApiError {
  const adopted = toApiError(error);
  if (adopted) return adopted;
  // View as investor (E2.7): the `READ ONLY` transaction backstop refused a write a route did
  // not skip. The audit recorder's own refusal is adopted above (it carries `code`/`status`).
  if (pgErrorCode(error) === "25006") {
    return new ApiError(
      "view_as_read_only",
      "this is a read-only view as an investor",
      {},
      { cause: error },
    );
  }
  if (error instanceof HTTPException) {
    const code = STATUS_TO_CODE[error.status];
    if (code !== undefined) {
      const headers: Record<string, string> = {};
      const res = error.res;
      const allow = res?.headers.get("Allow");
      if (allow) headers["Allow"] = allow;
      return new ApiError(code, error.message || undefined, {}, { cause: error, headers });
    }
  }
  return new ApiError("internal_error", "something went wrong", {}, { cause: error });
}

/** 5xx codes that mean "shed load, retry later" rather than a server fault. */
export const RETRYABLE_BUSY_CODES: ReadonlySet<string> = new Set(["forensic_busy"]);

export function apiErrorHandler(log: Log): ErrorHandler {
  return (error, c) => {
    const api = normalizeError(error);
    // F-29: every 403 `forbidden` is an authorization denial, and so is a 404 the authz layer
    // answered to hide what exists. The request log emits the event (once, after the response).
    if (api.code === "forbidden" || (api.code === "not_found" && isAuthzDenial(error))) {
      const permission = api.details["permission"];
      markSecurityEvent(c, {
        event: "authz_denied",
        code: api.code,
        ...(typeof permission === "string" ? { permission } : {}),
      });
    }
    // An expected, client-retryable "busy" 503 (E3.13 `forensic_busy`) is answered like a 429:
    // no error-level log, no stack — it is load shedding, not a fault.
    if (api.status >= 500 && !RETRYABLE_BUSY_CODES.has(api.code)) {
      const cause = api.cause ?? error;
      log("http.error", {
        level: "error",
        requestId: requestIdOf(c),
        method: c.req.method,
        path: c.req.path,
        code: api.code,
        error: cause instanceof Error ? cause.message : String(cause),
        stack: cause instanceof Error ? cause.stack : undefined,
      });
    }
    return errorResponse(c, api);
  };
}

export function apiNotFound(): NotFoundHandler {
  return (c) =>
    errorResponse(c, new ApiError("not_found", `no route for ${c.req.method} ${c.req.path}`));
}

/** For non-API trees: same envelope for JSON callers, a plain page otherwise. */
export function pageErrorResponse(c: Context, error: ApiError): Response {
  const accept = c.req.header("accept") ?? "";
  const tree = (c as Context<{ Variables: { classification?: { tree: string } } }>).get(
    "classification",
  )?.tree;
  if (tree === "api" || accept.includes("application/json") || /(^|\/)api\//u.test(c.req.path)) {
    return errorResponse(c, error);
  }
  c.status(error.status);
  return c.text(
    `${error.status} ${error.code.replace(/_/gu, " ")}\nrequest id: ${requestIdOf(c) ?? "-"}\n`,
  );
}
