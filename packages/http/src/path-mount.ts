/*
 * Path-mount matching (E3.9, ADR-0057). A marketing site can put the portal under one of its own
 * paths (`https://acme.com/investors/…`) through a reverse proxy. The proxy says so with
 * `X-Forwarded-Prefix`; the operator lists the mounts it accepts in config `PATH_MOUNTS`.
 *
 * The allow-list, not proxy trust, is the gate: a header value is believed only when it names a
 * configured prefix byte for byte. A matched mount changes the presentation of that one response
 * (router base, asset URLs, cookie name/Path, relative redirects, the CSRF-accepted origin); a
 * browser cannot attach `X-Forwarded-Prefix` to a cross-origin request without a CORS preflight,
 * which the app never grants.
 *
 * Rules:
 *   - `X-Forwarded-Prefix` must carry exactly one value: a header with a comma (several proxies
 *     appended, or a client value plus a proxy value) never matches. The value is trimmed and one
 *     trailing `/` is removed (after stripping SP/HTAB), then compared byte for byte with each mount's prefix. No decoding,
 *     no case folding, no dot-segment resolution.
 *   - One mount with that prefix: that mount; `X-Forwarded-Host` is not consulted (rejecting on it
 *     would add no security — an attacker can omit it — and would break every internet proxy
 *     whose X-Forwarded-Host the portal's own edge overwrites).
 *   - Several mounts share the prefix: only a believed `X-Forwarded-Host` (TRUST_PROXY on; the
 *     rightmost entry — the one `requestHost` believes — lower-cased, default port dropped) naming
 *     one of their hosts picks it. Otherwise the request is NOT mounted (fail closed): guessing
 *     would accept the wrong origin for CSRF and scope cookies to the wrong site.
 * Pure: no logging here (the server logs ignored values, bounded).
 */

export interface PathMount {
  /** `scheme://host[:port]` as `URL.origin` renders it: lower-case host, no default port, no slash. */
  readonly origin: string;
  /** Non-empty, BASE_PATH-shaped: `/segment[/segment…]`, no trailing slash. */
  readonly prefix: string;
}

/** Anything with a case-insensitive `get` — `Headers`, or Hono's `c.req.raw.headers`. */
export interface HeaderReader {
  get(name: string): string | null;
}

/** Longest header value considered at all; anything longer cannot be a configured prefix. */
const MAX_PREFIX_HEADER = 1024;

/** Strips RFC 9110 optional whitespace (SP / HTAB) only — never CR, LF, NUL or Unicode spaces. */
function trimOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/gu, "");
}

function forwardedPrefix(headers: HeaderReader): string | undefined {
  const raw = headers.get("x-forwarded-prefix");
  if (raw === null || raw.length > MAX_PREFIX_HEADER || raw.includes(",")) return undefined;
  let value = trimOws(raw);
  if (value.endsWith("/")) value = value.slice(0, -1);
  return value === "" ? undefined : value;
}

function hostOf(origin: string): { host: string; defaultPort: string } | undefined {
  try {
    const url = new URL(origin);
    return { host: url.host.toLowerCase(), defaultPort: url.protocol === "http:" ? "80" : "443" };
  } catch {
    return undefined;
  }
}

function forwardedHost(headers: HeaderReader): string | undefined {
  const raw = headers.get("x-forwarded-host");
  if (raw === null) return undefined;
  return trimOws(raw.split(",").at(-1) ?? "").toLowerCase();
}

function hostMatches(xfh: string, origin: string): boolean {
  const mount = hostOf(origin);
  if (mount === undefined) return false;
  if (xfh === mount.host) return true;
  // `acme.com:443` names the same origin as `https://acme.com`.
  return xfh === `${mount.host}:${mount.defaultPort}`;
}

/** The configured mount this request came through, or undefined (the header is then ignored). */
export function matchPathMount(
  headers: HeaderReader,
  mounts: readonly PathMount[],
  trustProxy: boolean,
): PathMount | undefined {
  if (mounts.length === 0) return undefined;
  const prefix = forwardedPrefix(headers);
  if (prefix === undefined) return undefined;
  const candidates = mounts.filter((m) => m.prefix === prefix);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const xfh = trustProxy ? forwardedHost(headers) : undefined;
  return xfh === undefined ? undefined : candidates.find((m) => hostMatches(xfh, m.origin));
}
