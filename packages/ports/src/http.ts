/**
 * Outbound HTTP (EXECUTION_PLAN §5.2 `OutboundHttpPort`, design/02 §5 SSRF). The guarded
 * implementation is `@fundroom/outbound-http` (DNS pre-resolve, private-range deny, pinned
 * address, 5 s timeout, 1 MB cap, 5 redirects re-checked per hop). Callers accept any
 * `fetch`-compatible function so tests can inject fakes (HIBP lookups, OIDC discovery,
 * webhooks, logo import).
 */
export type OutboundFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type OutboundHttpErrorCode =
  | "blocked_scheme"
  | "blocked_host"
  | "blocked_port"
  | "blocked_address"
  | "dns_failed"
  | "too_many_redirects"
  | "response_too_large"
  | "timeout";

export class OutboundHttpError extends Error {
  override readonly name = "OutboundHttpError";
  constructor(
    readonly code: OutboundHttpErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly url?: string | undefined },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.url = options?.url;
  }
  readonly url: string | undefined;
}

export interface OutboundHttpPort {
  readonly fetch: OutboundFetch;
}
