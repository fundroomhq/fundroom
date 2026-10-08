import { type OutboundFetch, OutboundHttpError, RelationshipEngineError } from "@fundroom/ports";

/*
 * A minimal OpenFGA HTTP client over the injected (guarded) fetch: JSON in, JSON out, a per-call
 * timeout, and every failure turned into a RelationshipEngineError code. No retries here — the
 * kernel decides (enforce mode fails closed; the sync job is retried by the queue).
 */

export interface OpenFgaHttpOptions {
  readonly url: string;
  readonly apiToken?: string | undefined;
  readonly http: OutboundFetch;
  readonly timeoutMs: number;
}

export interface OpenFgaApiError {
  readonly status: number;
  readonly code: string;
}

/** The OpenFGA error body code (`store_id_not_found`, `validation_error`, …) when one was sent. */
export function apiErrorOf(error: unknown): OpenFgaApiError | undefined {
  if (!(error instanceof RelationshipEngineError)) return undefined;
  const api = (error as { api?: OpenFgaApiError }).api;
  return api;
}

function codeForStatus(status: number): RelationshipEngineError["code"] {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 504 || status === 408) return "timeout";
  if (status === 429 || status >= 500) return "unreachable";
  return "rejected";
}

function engineError(
  code: RelationshipEngineError["code"],
  message: string,
  cause?: unknown,
  api?: OpenFgaApiError,
): RelationshipEngineError {
  const error = new RelationshipEngineError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
  if (api !== undefined) Object.defineProperty(error, "api", { value: api, enumerable: false });
  return error;
}

export type OpenFgaRequest = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<Record<string, unknown>>;

export function createOpenFgaHttp(options: OpenFgaHttpOptions): OpenFgaRequest {
  const base = options.url.replace(/\/+$/u, "");
  return async (method, path, body) => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.apiToken !== undefined && options.apiToken !== "") {
      headers["authorization"] = `Bearer ${options.apiToken}`;
    }
    const what = `${method} ${path.replace(/\/stores\/[^/?]+/u, "/stores/{id}")}`;
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      response = await options.http(`${base}${path}`, init);
    } catch (error) {
      throw transportError(error, what);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw transportError(error, what);
    }
    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch (error) {
        if (!response.ok) {
          throw engineError(
            codeForStatus(response.status),
            `openfga ${what}: HTTP ${response.status}`,
          );
        }
        throw engineError("invalid_response", `openfga ${what}: response is not JSON`, error);
      }
    }
    const obj =
      typeof json === "object" && json !== null && !Array.isArray(json)
        ? (json as Record<string, unknown>)
        : undefined;
    if (!response.ok) {
      const apiCode = typeof obj?.["code"] === "string" ? (obj["code"] as string) : "";
      const apiMessage = typeof obj?.["message"] === "string" ? (obj["message"] as string) : "";
      throw engineError(
        codeForStatus(response.status),
        `openfga ${what}: HTTP ${response.status}${apiCode ? ` ${apiCode}` : ""}${apiMessage ? `: ${apiMessage.slice(0, 300)}` : ""}`,
        undefined,
        { status: response.status, code: apiCode },
      );
    }
    if (text.length === 0) return {};
    if (obj === undefined) {
      throw engineError("invalid_response", `openfga ${what}: response is not a JSON object`);
    }
    return obj;
  };
}

function transportError(error: unknown, what: string): RelationshipEngineError {
  if (error instanceof RelationshipEngineError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  if (error instanceof OutboundHttpError) {
    if (error.code === "timeout")
      return engineError("timeout", `openfga ${what}: timed out`, error);
    if (error.code === "response_too_large") {
      return engineError("invalid_response", `openfga ${what}: response too large`, error);
    }
    return engineError("unreachable", `openfga ${what}: ${error.code}`, error);
  }
  if (name === "TimeoutError" || name === "AbortError") {
    return engineError("timeout", `openfga ${what}: timed out`, error);
  }
  return engineError(
    "unreachable",
    `openfga ${what}: ${String((error as Error)?.message ?? error)}`,
    error,
  );
}
