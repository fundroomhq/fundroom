import { matchPathMount, type PathMount, requestOrigin } from "@fundroom/http";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.js";
import type { Log } from "./logger.js";

/*
 * Path-mount mode (E3.9, ADR-0057). A host site's reverse proxy serves the portal under one of
 * its own paths (`https://acme.com/investors/…`), either preserving the internal base path or
 * replacing it and saying so with `X-Forwarded-Prefix`. Routes stay registered under `BASE_PATH`
 * (the INTERNAL base); what changes per request is the PUBLIC face:
 *
 *   publicBase    the matched mount's prefix when the request is mounted, else BASE_PATH
 *   publicOrigin  the mount's origin when mounted, else the request's own origin (today's)
 *
 * Every piece of presentation — the SPA's router/API base, the index.html asset URLs, cookie
 * name + Path, relative redirects, the CSP report URL, the capability doc — reads these and
 * never `config.basePath` directly. The allow-list (`PATH_MOUNTS`), not proxy trust, is the gate:
 * a mounted request only changes the presentation of that same response, and the only
 * security-relevant effect (CSRF) narrows the accepted origin to the mount's for that request.
 * A browser cannot attach `X-Forwarded-Prefix` to a cross-origin request without a CORS
 * preflight, which is never granted.
 *
 * What is NOT per request: emails, magic links, OIDC/SAML callbacks, webhooks, security.txt's
 * `Canonical`, OpenAPI `servers` — those are built from `BASE_URL` (`canonicalBaseOf`).
 */

/** At most this many distinct ignored `X-Forwarded-Prefix` values are logged per process. */
const IGNORED_PREFIX_LOG_MAX = 32;

export interface PathMountOptions {
  readonly mounts: readonly PathMount[];
  /** BASE_PATH: the internal base, and the public one when a request is not mounted. */
  readonly basePath: string;
  readonly trustProxy: boolean;
  readonly log?: Log | undefined;
  /**
   * BASE_URL: its origin is the passkey RP origin. A request whose public origin is another one
   * (a mount on a different origin, or the direct portal when BASE_URL is a mount) gets
   * `offPasskeyOrigin` — passkeys cannot work there (E3.9 FR1 B5).
   */
  readonly baseUrl?: URL | undefined;
  /**
   * Check an UNMOUNTED request's origin against the RP origin too (E3.9 FR2 B9). On for single
   * tenancy; off for multi, where tenant subdomains and custom domains keep their own rules
   * (`refusePasskeysOnCustomDomain`) and PATH_MOUNTS is refused anyway. Default true.
   */
  readonly checkUnmountedOrigin?: boolean | undefined;
}

/** Sets `publicBase`, `publicOrigin` and (when mounted) `pathMount` on every request. */
export function pathMountResolution(options: PathMountOptions): MiddlewareHandler<AppEnv> {
  const ignored = new Set<string>();
  const ambiguousWarned = new Set<string>();
  const prefixes = new Set(options.mounts.map((m) => m.prefix));
  const rpOrigin = options.baseUrl?.origin;
  return async (c, next) => {
    const mount =
      options.mounts.length === 0
        ? undefined
        : matchPathMount(c.req.raw.headers, options.mounts, options.trustProxy);
    let publicOrigin: string;
    if (mount !== undefined) {
      c.set("pathMount", mount);
      c.set("publicBase", mount.prefix);
      publicOrigin = mount.origin;
    } else {
      c.set("publicBase", options.basePath);
      publicOrigin = requestOrigin(c, options.trustProxy);
      const prefix = c.req.header("x-forwarded-prefix");
      const configured = prefix === undefined ? undefined : configuredPrefix(prefix, prefixes);
      if (configured !== undefined) {
        /*
         * E3.9 FR2 B10: a configured prefix that did not resolve (mounts sharing it, and no
         * believed X-Forwarded-Host picked one). The request is presented as the portal's own —
         * cookies exactly as without the header — but it is really on SOME host site, so passkeys
         * (bound to one origin) are refused, and the misconfiguration is said once per prefix.
         */
        c.set("offPasskeyOrigin", true);
        // Bounded: keyed on the configured prefix (at most MAX_PATH_MOUNTS of them).
        if (options.log !== undefined && !ambiguousWarned.has(configured)) {
          ambiguousWarned.add(configured);
          options.log("http.path_mount_ambiguous", {
            level: "warn",
            prefix: configured,
            hint: "several PATH_MOUNTS share this prefix; enable TRUST_PROXY with a proxy that sends X-Forwarded-Host, or give each mount its own prefix",
          });
        }
      } else if (
        prefix !== undefined &&
        options.log !== undefined &&
        ignored.size < IGNORED_PREFIX_LOG_MAX &&
        !ignored.has(prefix)
      ) {
        ignored.add(prefix);
        options.log("http.path_mount_ignored", {
          level: "debug",
          // Bounded: a header value is attacker-chosen.
          prefix: prefix.slice(0, 128),
          configured: options.mounts.length,
        });
      }
    }
    c.set("publicOrigin", publicOrigin);
    // E3.9 FR2 B9: passkeys are bound to one origin (BASE_URL's): anywhere else, refuse them.
    if (
      rpOrigin !== undefined &&
      (mount !== undefined || options.checkUnmountedOrigin !== false) &&
      !sameHost(publicOrigin, rpOrigin)
    ) {
      c.set("offPasskeyOrigin", true);
    }
    await next();
  };
}

/**
 * The mount prefix an `X-Forwarded-Prefix` value names (one value, SP/HTAB-trimmed, one trailing
 * `/` dropped — `matchPathMount`'s reading), or undefined.
 */
function configuredPrefix(value: string, prefixes: ReadonlySet<string>): string | undefined {
  if (value.includes(",")) return undefined;
  let v = value.replace(/^[ \t]+|[ \t]+$/gu, "");
  if (v.length > 1 && v.endsWith("/")) v = v.slice(0, -1);
  return prefixes.has(v) ? v : undefined;
}

/**
 * Same host (name + non-default port). Not the scheme: without TRUST_PROXY a TLS-terminating
 * proxy makes every request's own origin `http:`, which is the same page as the `https:` RP origin.
 */
function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/**
 * The request's public base path (`""` or `/x`). `fallback` (BASE_PATH) only matters for a
 * sub-app exercised without `pathMountResolution` in front of it (unit tests).
 */
export function publicBaseOf(c: Context<AppEnv>, fallback = ""): string {
  return c.get("publicBase") ?? fallback;
}

/** The request's public origin (`https://host[:port]`). */
export function publicOriginOf(c: Context<AppEnv>, trustProxy = false): string {
  return c.get("publicOrigin") ?? requestOrigin(c, trustProxy);
}

/** `basePath` for the identity cookie helpers: the public base, or undefined at the root. */
export function cookieBasePathOf(c: Context<AppEnv>): string | undefined {
  const base = publicBaseOf(c);
  return base === "" ? undefined : base;
}

/**
 * `path` (after the base) as an absolute URL on the mount, when the request is mounted.
 * Undefined otherwise, so the caller keeps its own canonical URL.
 */
export function mountedUrl(c: Context<AppEnv>, path: string): string | undefined {
  const mount = c.get("pathMount");
  return mount === undefined ? undefined : `${mount.origin}${mount.prefix}${path}`;
}

/** `BASE_URL` without its trailing slash: the base of every canonical (non-request) URL. */
export function canonicalBaseOf(baseUrl: URL): string {
  const href = `${baseUrl.origin}${baseUrl.pathname}`;
  return href.endsWith("/") ? href.slice(0, -1) : href;
}

/** `BASE_URL`'s path without the trailing slash (`""` or `/x`). */
export function canonicalPathOf(baseUrl: URL): string {
  return baseUrl.pathname.endsWith("/") ? baseUrl.pathname.slice(0, -1) : baseUrl.pathname;
}

/** Merges `tokens` into a `Vary` value without duplicating any (case-insensitive). */
export function mergeVary(existing: string | null | undefined, tokens: readonly string[]): string {
  const out = (existing ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (out.includes("*")) return "*";
  const seen = new Set(out.map((t) => t.toLowerCase()));
  for (const t of tokens) {
    if (!seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out.join(", ");
}

/** Adds `tokens` to the response's `Vary` (append, never clobber). */
export function addVary(c: Context<AppEnv>, ...tokens: string[]): void {
  c.header("Vary", mergeVary(c.res.headers.get("Vary"), tokens));
}

/**
 * Caching (E3.9 §3): a response the browser or a shared cache must not reuse across users
 * (`no-store` / `private`) also names what makes it per-user or per-mount, so a host CDN that
 * ignores `private` still keys on the cookie and the mount. Runs after every other header has
 * been set (it is registered outside the security-headers middleware).
 */
export function varyByMount(
  options: { readonly mountsConfigured?: boolean } = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const cc = c.res.headers.get("Cache-Control") ?? "";
    if (/(?:^|[\s,])(?:no-store|private)(?:$|[\s,=])/iu.test(cc)) {
      addVary(c, "Cookie", "X-Forwarded-Prefix");
    } else if (options.mountsConfigured === true && cc.trim() !== "") {
      // E3.9 FR2 B11: with PATH_MOUNTS set, even a base-independent public response differs by
      // mount (HSTS is omitted on mounted responses), so a shared cache must key on it too.
      addVary(c, "X-Forwarded-Prefix");
    }
  };
}

/**
 * Whether BASE_URL itself is one of the path mounts (its origin + path equals an entry) — the
 * strip shape, where the canonical address is the host site's. Its origin is then the HOST
 * site's: it must never be CORS/CSRF-trusted for direct requests, nor stand in for the portal.
 */
export function baseUrlIsMount(baseUrl: URL, mounts: readonly PathMount[]): boolean {
  const base = canonicalBaseOf(baseUrl);
  return mounts.some((m) => `${m.origin}${m.prefix}` === base);
}

/** Whether `origin` is the origin of any path mount (a host site's, never the portal's). */
export function isMountOrigin(origin: string, mounts: readonly PathMount[]): boolean {
  return mounts.some((m) => m.origin === origin.toLowerCase());
}
