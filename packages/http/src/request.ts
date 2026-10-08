import { isIP } from "node:net";
import type { Context } from "hono";
import { edgeForwardedOf } from "./edge.js";

/*
 * Request facts that depend on the proxy in front of the app (design/07 §2.4, ADR-0022).
 * `X-Forwarded-*` is only believed when the operator set TRUST_PROXY; otherwise the
 * request's own URL is the truth. E0.6's tenant resolution and the identity CSRF check
 * (`selfOrigin`) build on `requestOrigin`.
 *
 * Which entry of a forwarded list to believe (E2.10 F-07). Proxies *append* to these headers,
 * so everything left of the entries our own proxies wrote is whatever the client sent. The
 * rightmost `X-Forwarded-Host`/`-Proto` entry is the nearest proxy's; the client address is the
 * `X-Forwarded-For` entry `TRUST_PROXY_HOPS` places from the right (see `clientAddress`). Taking
 * the leftmost entry, as this file used to, let any client choose its own address, host and
 * scheme behind every appending proxy (Fly, Render, Railway, most ingress controllers).
 *
 * An EDGE-FORWARDED request (E-UP-7, `./edge.ts`: the edge Worker's shared secret matched) is
 * answered from the edge's facts first — the customer host, always `https` — whatever
 * `trustProxy` says: the secret, not the proxy chain, is what vouches for those.
 */
function forwarded(c: Context, name: string): string | undefined {
  const raw = c.req.header(name);
  if (raw === undefined) return undefined;
  const last = raw.split(",").at(-1)?.trim();
  return last === undefined || last === "" ? undefined : last;
}

/** True when the client reached us over TLS (directly, or via a trusted proxy that says so). */
export function isSecureRequest(c: Context, trustProxy: boolean): boolean {
  if (edgeForwardedOf(c) !== undefined) return true;
  if (trustProxy) {
    const proto = forwarded(c, "x-forwarded-proto");
    if (proto !== undefined) return proto.toLowerCase() === "https";
  }
  return new URL(c.req.url).protocol === "https:";
}

/** Host header as the client sent it (via the proxy when trusted); lower-cased, no whitespace. */
export function requestHost(c: Context, trustProxy: boolean): string {
  const edge = edgeForwardedOf(c);
  if (edge !== undefined) return edge.host;
  const fromProxy = trustProxy ? forwarded(c, "x-forwarded-host") : undefined;
  const host = fromProxy ?? c.req.header("host") ?? new URL(c.req.url).host;
  return host.trim().toLowerCase();
}

/** `scheme://host[:port]` the client used, for cookies, CSRF and absolute links. */
export function requestOrigin(c: Context, trustProxy: boolean): string {
  const scheme = isSecureRequest(c, trustProxy) ? "https" : "http";
  return `${scheme}://${requestHost(c, trustProxy)}`;
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/** Hosts where HSTS makes no sense (browsers ignore it, and dev would be locked out). */
export function isLocalOrIpHost(host: string): boolean {
  let name = host.toLowerCase();
  if (name.startsWith("[")) return true; // IPv6 literal
  const colon = name.lastIndexOf(":");
  if (colon !== -1) name = name.slice(0, colon);
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  return IPV4_RE.test(name);
}

/** How the client address is derived behind a trusted proxy (config TRUST_PROXY_HOPS / CLIENT_IP_HEADER). */
export interface ProxyTrust {
  /** Proxies that append to `X-Forwarded-For`; the client is this many entries from the right. */
  readonly hops: number;
  /** A single-valued header the platform edge overwrites (`Fly-Client-IP`); wins over hops. */
  readonly clientIpHeader?: string | undefined;
  /**
   * `CLOUDFLARE_TRUSTED_PROXY=on` (E3.10): when the address the rules above arrive at is a
   * Cloudflare edge address, the client is `CF-Connecting-IP` (`cloudflareClientIp`).
   */
  readonly cloudflare?: boolean | undefined;
}

/** `TRUST_PROXY=true` with no other setting: one appending proxy. */
export const ONE_PROXY: ProxyTrust = { hops: 1 };

/** An IP literal, with a `:port` / `[v6]:port` suffix removed; undefined when it is not one. */
export function normalizeIp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let v = value.trim();
  if (v === "") return undefined;
  if (isIP(v) !== 0) return v;
  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::\d+)?$/u.exec(v);
  if (bracketed?.[1] !== undefined) v = bracketed[1];
  else {
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/u.exec(v);
    if (withPort?.[1] !== undefined) v = withPort[1];
  }
  return isIP(v) !== 0 ? v : undefined;
}

/**
 * The client address the trusted proxy chain vouches for, or undefined when the headers do not
 * name one (the caller then uses the socket address).
 *
 * `clientIpHeader` set: that header only; a request without it did not come through the
 * platform's edge, and `X-Forwarded-For` is never consulted as a fallback. Otherwise the entry
 * `hops` places from the right of `X-Forwarded-For`; with fewer entries than hops, the leftmost
 * (as Express's `trust proxy = n` does).
 */
export function forwardedClientIp(
  header: (name: string) => string | undefined,
  trust: ProxyTrust,
): string | undefined {
  if (trust.clientIpHeader !== undefined) return normalizeIp(header(trust.clientIpHeader));
  const entries = (header("x-forwarded-for") ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  if (entries.length === 0) return undefined;
  const hops = Math.max(1, Math.floor(trust.hops));
  return normalizeIp(entries[Math.max(0, entries.length - hops)]);
}
