import type { LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { type OutboundFetch, OutboundHttpError, type OutboundHttpPort } from "@fundroom/ports";
import { Agent, fetch as undiciFetch } from "undici";
import { assessAddresses, assessUrl, type OutboundPolicy, type Verdict } from "./policy.js";

/*
 * SSRF-guarded fetch (EXECUTION_PLAN §5.2 `OutboundHttpPort`, §10, design/02 §5).
 *
 * Every hop: static URL policy → DNS pre-resolution through an injectable resolver → every
 * address checked → the connection pinned to the first checked address (undici's
 * `connect.lookup` returns it, so the socket cannot go anywhere else while `Host`/SNI still
 * carry the hostname; DNS rebinding between check and connect is impossible) → redirects
 * followed manually with the full assessment re-run on each `Location`. A total deadline
 * covers all hops; the response body is wrapped in a counting stream that fails past the
 * cap. Nothing here logs URLs with query strings or any body bytes.
 */
export type AddressLookup = (
  hostname: string,
) => Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>;

export interface OutboundHttpOptions extends OutboundPolicy {
  /** Whole request including redirects. Default 5 000 ms. */
  readonly timeoutMs?: number | undefined;
  /** Response body cap. Default 1 MiB. */
  readonly maxResponseBytes?: number | undefined;
  /** Default 5. */
  readonly maxRedirects?: number | undefined;
  /**
   * Asked before each redirect is followed, with the target (fragment removed) and the redirect's
   * number (1 = the first). `false` fails the fetch with `blocked_host` before anything is looked
   * up. For callers whose redirects may only go somewhere specific (the OFAC list download: one
   * hop, https, a pre-signed S3 host). Default: every target the policy allows.
   */
  readonly redirectAllowed?: ((to: URL, hop: number) => boolean) | undefined;
  /**
   * What a body over `maxResponseBytes` does. `error` (default): the fetch (known length) or the
   * body read (counted) fails with `response_too_large`. `truncate`: the response is still
   * returned — status and headers intact — with its body cut at the cap (an over-long declared
   * length yields an empty body). For callers that care about the status, not the body
   * (outbound webhooks: a 2xx with a large body is still a delivery). Never the default.
   */
  readonly oversizeResponse?: "error" | "truncate" | undefined;
  /**
   * At most this many DNS lookups in flight for this agent; one more fails fast with
   * `dns_failed` without starting a lookup. Default unlimited. A lookup that outlives the request
   * deadline cannot be cancelled (`getaddrinfo` keeps a libuv threadpool thread, 4 by default,
   * shared with fs/crypto/zlib), so an agent whose targets are chosen by tenants caps them.
   */
  readonly maxConcurrentLookups?: number | undefined;
  /** Default `FundRoom`. */
  readonly userAgent?: string | undefined;
  /** DNS resolver; tests inject one. Default `dns.promises.lookup(host, { all: true })`. */
  readonly lookup?: AddressLookup | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export interface OutboundHttp extends OutboundHttpPort {
  /** Static policy check without network I/O (validation of a webhook URL at save time). */
  assess(url: string | URL): Verdict;
  /** Destroys the connection pool. */
  close(): Promise<void>;
}

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;

const PIN_CAPACITY = 1024;
const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];

const defaultLookup: AddressLookup = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    ((error as { name: unknown }).name === "AbortError" ||
      (error as { name: unknown }).name === "TimeoutError")
  );
}

function redactedUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export function createOutboundHttp(options: OutboundHttpOptions = {}): OutboundHttp {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const truncate = options.oversizeResponse === "truncate";
  const maxLookups = options.maxConcurrentLookups ?? Number.POSITIVE_INFINITY;
  let lookupsInFlight = 0;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const userAgent = options.userAgent ?? "FundRoom";
  const lookup = options.lookup ?? defaultLookup;
  const log = options.log ?? (() => {});
  const policy: OutboundPolicy = {
    allowPrivate: options.allowPrivate,
    allowedPrivateHosts: options.allowedPrivateHosts,
    allowedPorts: options.allowedPorts,
  };

  /*
   * hostname → address checked for the most recent request to it. The connector consults
   * this instead of DNS, so a hostname that was never assessed cannot connect at all (fail
   * closed). Two concurrent requests to one hostname may swap addresses; both were checked.
   */
  const pins = new Map<string, { address: string; family: 4 | 6 }>();
  function pin(hostname: string, entry: { address: string; family: 4 | 6 }): void {
    pins.delete(hostname);
    pins.set(hostname, entry);
    if (pins.size > PIN_CAPACITY) {
      const oldest = pins.keys().next().value;
      if (oldest !== undefined) pins.delete(oldest);
    }
  }

  const agent = new Agent({
    connect: {
      // Node's socket lookup signature; undici forwards the option to net/tls.connect.
      lookup: ((
        hostname: string,
        lookupOptions: LookupOptions,
        callback: (...args: unknown[]) => void,
      ) => {
        const pinned = pins.get(hostname.toLowerCase());
        if (!pinned) {
          callback(new Error(`outbound-http: no pinned address for ${hostname}`));
          return;
        }
        if (lookupOptions.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      }) as never,
    },
    connectTimeout: timeoutMs,
  });

  async function resolveAndPin(
    verdict: Verdict & { ok: true },
    signal: AbortSignal,
  ): Promise<void> {
    let addresses: readonly { readonly address: string; readonly family: 4 | 6 }[];
    if (verdict.literal !== undefined) {
      addresses = [{ address: verdict.literal, family: verdict.literal.includes(":") ? 6 : 4 }];
    } else {
      try {
        // Inside the request's deadline: the resolver has no timeout of its own, and a host a
        // tenant chose can answer DNS as slowly as it likes.
        if (lookupsInFlight >= maxLookups) {
          throw new OutboundHttpError("dns_failed", "too many DNS lookups in flight", {
            url: redactedUrl(verdict.url),
          });
        }
        lookupsInFlight += 1;
        // Released when the lookup itself settles, not when the deadline gives up on it: the
        // count is of lookups actually holding a resolver thread.
        const pending = lookup(verdict.hostname).finally(() => {
          lookupsInFlight -= 1;
        });
        addresses = await withinDeadline(pending, signal);
      } catch (cause) {
        if (cause instanceof OutboundHttpError) throw cause;
        // The caller's own abort propagates as theirs; the deadline is a timeout.
        const timedOut =
          signal.aborted &&
          (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError";
        if (signal.aborted && !timedOut) throw signal.reason;
        if (timedOut) {
          throw new OutboundHttpError("timeout", `request exceeded ${timeoutMs} ms`, {
            cause,
            url: redactedUrl(verdict.url),
          });
        }
        throw new OutboundHttpError("dns_failed", `could not resolve ${verdict.hostname}`, {
          cause,
          url: redactedUrl(verdict.url),
        });
      }
    }
    const check = assessAddresses(
      addresses.map((a) => a.address),
      verdict.exempt,
    );
    if (!check.ok) {
      log("outbound_http.blocked", { host: verdict.hostname, code: check.code });
      throw new OutboundHttpError(check.code, check.message, { url: redactedUrl(verdict.url) });
    }
    const first = addresses[0];
    if (!first) {
      throw new OutboundHttpError("dns_failed", `could not resolve ${verdict.hostname}`, {
        url: redactedUrl(verdict.url),
      });
    }
    pin(verdict.hostname, first);
  }

  function capBody(response: Response, url: URL): Response {
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > maxBytes) {
      response.body?.cancel().catch(() => {});
      if (truncate) {
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        return new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      throw new OutboundHttpError(
        "response_too_large",
        `response of ${length} bytes exceeds the ${maxBytes} byte cap`,
        { url: redactedUrl(url) },
      );
    }
    if (response.body === null) return response;
    let seen = 0;
    const counting = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes && truncate) {
          const room = chunk.byteLength - (seen - maxBytes);
          if (room > 0) controller.enqueue(chunk.subarray(0, room));
          controller.terminate();
          return;
        }
        if (seen > maxBytes) {
          controller.error(
            new OutboundHttpError(
              "response_too_large",
              `response exceeds the ${maxBytes} byte cap`,
              { url: redactedUrl(url) },
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(counting), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const guardedFetch: OutboundFetch = async (input, init) => {
    /*
     * The static policy runs on the caller's URL before anything else touches it: the Fetch
     * standard's `Request` constructor throws a bare `TypeError` on a URL that carries
     * credentials (`http://user@host/`) or is not absolute, and a caller that maps only
     * `OutboundHttpError` would turn that into a 500 (pen test P2b-01). Every refusal the guard
     * makes is an `OutboundHttpError` with a fixed code.
     */
    const target =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const upfront = assessUrl(target, policy);
    if (!upfront.ok) {
      log("outbound_http.blocked", { code: upfront.code, hop: 0 });
      throw new OutboundHttpError(upfront.code, upfront.message, { url: safeUrlText(target) });
    }
    let request: Request;
    try {
      request = new Request(input, init);
    } catch (cause) {
      throw new OutboundHttpError("blocked_scheme", "the request could not be constructed", {
        cause,
        url: safeUrlText(target),
      });
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([deadline, init.signal])
      : request.signal
        ? AbortSignal.any([deadline, request.signal])
        : deadline;

    let method = request.method;
    let headers = new Headers(request.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
    // A streamed body cannot be replayed on a redirect; buffer small bodies up front.
    let body: ArrayBuffer | null = request.body === null ? null : await request.arrayBuffer();
    let current = request.url;
    let origin: string | undefined;

    for (let hop = 0; ; hop++) {
      const verdict = assessUrl(current, policy);
      if (!verdict.ok) {
        log("outbound_http.blocked", { code: verdict.code, hop });
        throw new OutboundHttpError(verdict.code, verdict.message, {
          url: safeUrlText(current),
        });
      }
      // The combined signal: the caller's abort also stops waiting for DNS.
      await resolveAndPin(verdict, signal);

      if (origin !== undefined && origin !== verdict.url.origin) {
        for (const h of SENSITIVE_HEADERS) headers.delete(h);
      }
      origin = verdict.url.origin;

      let response: Response;
      try {
        response = (await undiciFetch(verdict.url.href, {
          method,
          headers: Array.from(headers.entries()),
          body: body === null ? null : new Uint8Array(body),
          redirect: "manual",
          signal,
          dispatcher: agent,
        })) as unknown as Response;
      } catch (cause) {
        if (isAbort(cause) || deadline.aborted) {
          if (deadline.aborted || !init?.signal?.aborted) {
            throw new OutboundHttpError("timeout", `request exceeded ${timeoutMs} ms`, {
              cause,
              url: redactedUrl(verdict.url),
            });
          }
        }
        throw cause;
      }

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel().catch(() => {});
        if (hop >= maxRedirects) {
          throw new OutboundHttpError("too_many_redirects", `more than ${maxRedirects} redirects`, {
            url: redactedUrl(verdict.url),
          });
        }
        let next: URL;
        try {
          next = new URL(location, verdict.url);
        } catch {
          throw new OutboundHttpError("blocked_scheme", "redirect to an invalid URL", {
            url: redactedUrl(verdict.url),
          });
        }
        next.hash = "";
        if (options.redirectAllowed !== undefined && !options.redirectAllowed(next, hop + 1)) {
          log("outbound_http.blocked", { code: "blocked_host", hop, redirect: true });
          throw new OutboundHttpError("blocked_host", "redirect target not allowed", {
            url: redactedUrl(verdict.url),
          });
        }
        // Method rewriting as in the Fetch standard §4.4.
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          method = "GET";
          body = null;
          headers = new Headers(headers);
          for (const h of ["content-type", "content-length", "content-encoding"]) {
            headers.delete(h);
          }
        }
        log("outbound_http.redirect", { from: verdict.hostname, to: next.hostname, hop });
        current = next.href;
        continue;
      }
      return capBody(response, verdict.url);
    }
  };

  return {
    fetch: guardedFetch,
    assess: (url) => assessUrl(url, policy),
    async close() {
      await agent.close();
    },
  };
}

/** `p`, or a rejection as soon as `signal` aborts (the lookup itself cannot be cancelled). */
function withinDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function safeUrlText(url: string): string | undefined {
  try {
    return redactedUrl(new URL(url));
  } catch {
    return undefined;
  }
}
