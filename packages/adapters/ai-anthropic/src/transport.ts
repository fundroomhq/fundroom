import {
  type ModelAdapterDeps,
  type ModelErrorCode,
  ModelProviderError,
  OutboundHttpError,
} from "@fundroom/ports";

/*
 * The HTTP plumbing both model adapters share (E3.12 §3/§8). Adapters may not import each other,
 * so `@fundroom/ai-anthropic` carries an identical copy of this file — change both.
 *
 * - ONE internal retry on a retryable failure, honouring the server's retry-after when it is at
 *   most 10 s (a longer one surfaces as the error, with `retryAfterMs`); never a second retry.
 * - One deadline (`timeoutMs`) covers both attempts and the wait between them, combined with the
 *   caller's signal. Either aborting → `timeout`, never retried.
 * - Nothing here logs or puts into an error message any request or response text: log events
 *   carry the provider, HTTP status, a sanitised vendor error type/code, the request id, timings
 *   and token counts.
 */

export const MAX_RETRY_AFTER_MS = 10_000;
/** The wait before the retry when the server did not say how long. */
export const DEFAULT_RETRY_DELAY_MS = 500;

export type Log = NonNullable<ModelAdapterDeps["log"]>;

/** A vendor error `type`/`code` token, or undefined when it is not a plain token. */
export function token(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  return typeof v === "string" && /^[A-Za-z0-9_.:-]{1,64}$/u.test(v) ? v : undefined;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `retry-after-ms` (OpenAI), then `retry-after` in seconds or as an HTTP date. */
export function retryAfterMs(headers: Headers, now: Date): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\d+(\.\d+)?$/u.test(ms.trim())) return Math.ceil(Number(ms));
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const v = raw.trim();
  if (/^\d+(\.\d+)?$/u.test(v)) return Math.ceil(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function hasName(e: unknown, ...names: string[]): boolean {
  return (
    typeof e === "object" && e !== null && names.includes(String((e as { name?: unknown }).name))
  );
}

/** A transport failure (the fetch or the body read threw) as a port error. */
export function transportError(e: unknown): ModelProviderError {
  if (e instanceof ModelProviderError) return e;
  if (e instanceof OutboundHttpError || hasName(e, "OutboundHttpError")) {
    const code = (e as OutboundHttpError).code;
    switch (code) {
      case "timeout":
        return new ModelProviderError("timeout", "the model server did not answer in time", false);
      case "dns_failed":
        return new ModelProviderError(
          "unavailable",
          "the model server's name did not resolve",
          true,
        );
      case "too_many_redirects":
        return new ModelProviderError(
          "unavailable",
          "the model server answered with a redirect, which is refused",
          false,
        );
      case "response_too_large":
        return new ModelProviderError(
          "unavailable",
          "the model server's answer exceeds the size cap",
          false,
        );
      default:
        return new ModelProviderError(
          "unavailable",
          `the outbound policy refused the model server (${code})`,
          false,
        );
    }
  }
  if (hasName(e, "AbortError", "TimeoutError")) {
    return new ModelProviderError("timeout", "the model call was aborted", false);
  }
  const cause = typeof e === "object" && e !== null ? (e as { cause?: unknown }).cause : undefined;
  const sysCode = isRecord(cause) ? token(cause["code"]) : undefined;
  return new ModelProviderError(
    "unavailable",
    `the model server is unreachable${sysCode === undefined ? "" : ` (${sysCode})`}`,
    true,
  );
}

/** Reads a (capped) error body as JSON; undefined when it is not JSON (a proxy's HTML page). */
export async function errorBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function httpError(
  code: ModelErrorCode,
  status: number,
  detail: string | undefined,
  retryable: boolean,
  retryAfter?: number,
): ModelProviderError {
  return new ModelProviderError(
    code,
    `the model server answered HTTP ${status}${detail === undefined ? "" : ` (${detail})`}`,
    retryable,
    retryAfter,
  );
}

export interface CallContext {
  readonly provider: string;
  readonly timeoutMs: number;
  readonly log: Log;
  readonly callerSignal: AbortSignal | undefined;
}

/**
 * Runs `attempt` with the combined deadline + caller signal, retrying once when it throws a
 * retryable `ModelProviderError` whose wait fits the cap.
 */
export async function withOneRetry<T>(
  ctx: CallContext,
  attempt: (signal: AbortSignal, n: number) => Promise<T>,
): Promise<T> {
  const cancelled = () => new ModelProviderError("timeout", "the model call was cancelled", false);
  if (ctx.callerSignal?.aborted === true) throw cancelled();
  const deadline = AbortSignal.timeout(ctx.timeoutMs);
  const signal =
    ctx.callerSignal === undefined ? deadline : AbortSignal.any([ctx.callerSignal, deadline]);
  const aborted = (): ModelProviderError | undefined => {
    if (ctx.callerSignal?.aborted === true) return cancelled();
    if (deadline.aborted) {
      return new ModelProviderError(
        "timeout",
        `the model server did not answer within ${ctx.timeoutMs} ms`,
        false,
      );
    }
    return undefined;
  };
  for (let n = 1; ; n++) {
    let error: ModelProviderError;
    try {
      return await attempt(signal, n);
    } catch (e) {
      error = aborted() ?? transportError(e);
    }
    const wait = error.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS;
    if (n >= 2 || !error.retryable || wait > MAX_RETRY_AFTER_MS) throw error;
    ctx.log({ event: "ai.model_retry", provider: ctx.provider, code: error.code, waitMs: wait });
    try {
      await sleep(wait, signal);
    } catch {
      throw aborted() ?? cancelled();
    }
  }
}
