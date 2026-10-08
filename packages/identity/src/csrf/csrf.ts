/*
 * CSRF for cookie sessions (EXECUTION_PLAN §6.3, design/02 §5). Embed cookies are
 * SameSite=None, so SameSite alone is not a defence; every mutation is checked against
 * Fetch Metadata and the Origin header. All mutations are non-GET JSON, so a plain HTML form
 * cannot produce them either, but the header check is the control that does not depend on
 * how the body is parsed.
 *
 * Decision table (mutating methods only):
 *   Sec-Fetch-Site: same-origin | none          → allow
 *   Sec-Fetch-Site: same-site | cross-site      → allow only if Origin is allowlisted
 *   no Sec-Fetch-Site (old UA / non-browser)    → require Origin (or Referer) to be self or allowlisted
 *
 * `same-site` is deliberately not trusted: a host site at acme.com is same-site with a
 * portal at investors.acme.com (ADR-0010) but is not the portal.
 */
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export interface CsrfOptions {
  /** The portal's own origin for this request, e.g. `https://investors.acme.com`. */
  readonly selfOrigin: string;
  /** Extra origins allowed to call mutating endpoints with cookies (CORS'd SDK clients). */
  readonly allowedOrigins?: readonly string[];
}

export type CsrfVerdict =
  | { readonly ok: true; readonly via: "safe-method" | "fetch-metadata" | "origin" | "referer" }
  | { readonly ok: false; readonly reason: "cross-site" | "bad-origin" | "missing-origin" };

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

export function checkCsrf(
  method: string,
  headers: Pick<Headers, "get">,
  options: CsrfOptions,
): CsrfVerdict {
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true, via: "safe-method" };

  const self = normalizeOrigin(options.selfOrigin);
  const allowed = new Set<string>();
  if (self) allowed.add(self);
  for (const o of options.allowedOrigins ?? []) {
    const n = normalizeOrigin(o);
    if (n) allowed.add(n);
  }

  const originHeader = headers.get("origin");
  const origin =
    originHeader && originHeader !== "null" ? normalizeOrigin(originHeader) : undefined;

  const site = headers.get("sec-fetch-site")?.toLowerCase();
  if (site === "same-origin" || site === "none") return { ok: true, via: "fetch-metadata" };
  if (site === "same-site" || site === "cross-site") {
    return origin && allowed.has(origin)
      ? { ok: true, via: "origin" }
      : { ok: false, reason: "cross-site" };
  }

  if (originHeader) {
    return origin && allowed.has(origin)
      ? { ok: true, via: "origin" }
      : { ok: false, reason: "bad-origin" };
  }
  const referer = headers.get("referer");
  if (referer) {
    const refOrigin = normalizeOrigin(referer);
    return refOrigin && allowed.has(refOrigin)
      ? { ok: true, via: "referer" }
      : { ok: false, reason: "bad-origin" };
  }
  return { ok: false, reason: "missing-origin" };
}
