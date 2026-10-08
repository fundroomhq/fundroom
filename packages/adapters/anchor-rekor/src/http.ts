import { AnchorError, type AnchorErrorCode, type OutboundFetch } from "@fundroom/ports";

/*
 * (Same helper as @fundroom/anchor-rfc3161's: adapters do not import each other.)
 * One outbound request with the anchor's own guard rails on top of the guarded client the operator
 * wiring passes in (which already refuses private hosts nobody named, redirects and oversize
 * bodies): a deadline over the whole exchange including the body read, `redirect: "manual"` with
 * any 3xx refused (a redirect is how a request reaches a host nobody configured), and a body cap
 * enforced while reading. Every failure becomes an `AnchorError` with a fixed code; nothing from
 * the response body ever reaches a message.
 */

export interface PostResult {
  readonly status: number;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : undefined;
}

function outboundCode(error: unknown): string | undefined {
  if (errorName(error) !== "OutboundHttpError") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Maps a thrown fetch / body-read failure onto an anchor error code. */
export function anchorErrorFrom(error: unknown, what: string, timeoutMs: number): AnchorError {
  if (error instanceof AnchorError) return error;
  const name = errorName(error);
  const code = outboundCode(error);
  let mapped: AnchorErrorCode = "unreachable";
  let message = `${what}: the request failed`;
  if (code === "timeout" || name === "TimeoutError" || name === "AbortError") {
    mapped = "timeout";
    message = `${what}: no answer within ${timeoutMs} ms`;
  } else if (code === "response_too_large") {
    mapped = "invalid_response";
    message = `${what}: the response exceeds the size cap`;
  } else if (code === "too_many_redirects") {
    mapped = "rejected";
    message = `${what}: answered with a redirect, which is never followed`;
  } else if (code !== undefined) {
    message = `${what}: the request was refused by the outbound guard (${code})`;
  }
  return new AnchorError(mapped, message, { cause: error });
}

async function readCapped(response: Response, maxBytes: number, what: string): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new AnchorError("invalid_response", `${what}: the response exceeds ${maxBytes} bytes`);
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new AnchorError("invalid_response", `${what}: the response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface PostOptions {
  readonly http: OutboundFetch;
  readonly url: string;
  /** Default POST. */
  readonly method?: "GET" | "POST" | undefined;
  readonly body?: Uint8Array | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** For messages: "Rekor https://host/path". Never includes a query string or body bytes. */
  readonly what: string;
}

/** Sends the request and returns a 2xx answer's bytes; every other outcome throws `AnchorError`. */
export async function requestCapped(options: PostOptions): Promise<PostResult> {
  const { what, timeoutMs } = options;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await options.http(options.url, {
      method: options.method ?? "POST",
      headers: options.headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      redirect: "manual",
      signal,
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => {});
      throw new AnchorError(
        "rejected",
        `${what}: answered with a redirect (${response.status}), which is never followed`,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      const transient = response.status === 429 || response.status >= 500;
      throw new AnchorError(
        transient ? "unreachable" : "rejected",
        `${what}: answered HTTP ${response.status}`,
      );
    }
    const bytes = await readCapped(response, options.maxBytes, what);
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      bytes,
    };
  } catch (error) {
    throw anchorErrorFrom(error, what, timeoutMs);
  }
}

/** `origin + path` of a URL, for messages and references (never a query string or credentials). */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "<invalid url>";
  }
}
