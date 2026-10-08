/*
 * Cookie recipes per deployment mode (EXECUTION_PLAN §6.3, ADR-0009, ADR-0022, ADR-0057):
 *
 *   first_party             __Host-sid;   Secure; HttpOnly; SameSite=Lax;                Path=/
 *   partitioned             __Host-sid;   Secure; HttpOnly; SameSite=None; Partitioned;  Path=/       (embed iframe)
 *   path_mount              __Secure-sid; Secure; HttpOnly; SameSite=Lax;                Path=<base>
 *   partitioned_path_mount  __Secure-sid; Secure; HttpOnly; SameSite=None; Partitioned;  Path=<base>  (embed under a base)
 *
 * `<base>` is the request's *public* base (E3.9): BASE_PATH, or the matched `PATH_MOUNTS` prefix
 * when a proxy mounted the portal under a path of its own. `__Host-` forbids Domain and a non-root
 * Path, so any non-empty base falls back to `__Secure-`. The name depends only on the mode, so a
 * direct-origin `__Host-sid` is never read on a mounted request and vice versa.
 * Cookies are always Secure: browsers treat http://localhost as a secure context.
 */
export type CookieMode = "first_party" | "partitioned" | "path_mount" | "partitioned_path_mount";

export const COOKIE_BASENAMES = {
  session: "sid",
  device: "did",
  /** Browser binding for magic links: set on request, checked on POST-to-confirm. */
  authRequest: "auth_req",
  /**
   * Browser binding for an OIDC login (F-03): set at `/auth/oidc/begin`, required at the
   * callback. Separate from `auth_req` so starting SSO does not break a pending magic link.
   * SameSite=Lax, so it rides the IdP's top-level GET redirect back.
   */
  oidcRequest: "oidc_req",
  /**
   * Browser binding for a per-workspace staff SSO login (E3.8, ADR-0056): set on the workspace
   * origin at `/auth/sso/begin`, required at `/auth/sso/finish` on the same origin (the IdP returns
   * to the canonical host, which 303s back with a single-use handoff). Separate from `oidc_req` so
   * the install-wide OIDC login and a workspace SSO login cannot consume each other's binding.
   */
  ssoRequest: "sso_req",
  /**
   * The central-auth verifier (E3.10, ADR-0058): set on the workspace host at
   * `/auth/central/start`, presented at `/auth/central/finish` on the same host. The request stores
   * only its SHA-256 (a PKCE-style verifier), so a handoff code that leaks — from a log, a Referer,
   * the tenant's own DNS — is useless without the browser that began the sign-in.
   */
  centralRequest: "auth_creq",
} as const;

export type CookieKind = keyof typeof COOKIE_BASENAMES;

export interface CookieOptions {
  readonly mode: CookieMode;
  /**
   * The request's public base. Required for the path-scoped modes (`path_mount`,
   * `partitioned_path_mount`) and must be BASE_PATH-shaped (`/seg[/seg…]`, leading slash, no
   * trailing slash); ignored otherwise.
   */
  readonly basePath?: string | undefined;
  readonly maxAgeSeconds?: number | undefined;
}

/** Chrome caps cookie lifetime at 400 days. */
export const MAX_COOKIE_AGE_SECONDS = 400 * 24 * 3600;

/**
 * The recipe for a request: `embed` picks SameSite=None + Partitioned, a non-empty `basePath` (the
 * request's public base — BASE_PATH or the matched path mount's prefix) picks `__Secure-` +
 * `Path=<basePath>`.
 */
export function cookieModeFor(input: {
  embed: boolean;
  basePath?: string | undefined;
}): CookieMode {
  const based = input.basePath !== undefined && input.basePath !== "";
  if (input.embed) return based ? "partitioned_path_mount" : "partitioned";
  return based ? "path_mount" : "first_party";
}

/** Whether the mode scopes cookies to a base path (`__Secure-`, `Path=<base>`). */
export function isPathScopedMode(mode: CookieMode): boolean {
  return mode === "path_mount" || mode === "partitioned_path_mount";
}

export function cookieName(kind: CookieKind, mode: CookieMode): string {
  const prefix = isPathScopedMode(mode) ? "__Secure-" : "__Host-";
  return `${prefix}${COOKIE_BASENAMES[kind]}`;
}

/** BASE_PATH's shape (config), non-empty: nothing here can end the attribute list. */
const COOKIE_PATH_RE = /^(?:\/[A-Za-z0-9._~-]+)+$/u;

const COOKIE_VALUE_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/u;

function attributes(options: CookieOptions): string {
  const parts: string[] = [];
  if (isPathScopedMode(options.mode)) {
    const basePath = options.basePath ?? "";
    if (basePath === "") throw new Error(`${options.mode} cookies need a basePath`);
    if (!COOKIE_PATH_RE.test(basePath)) throw new Error("cookie basePath is not a valid base path");
    parts.push(`Path=${basePath}`);
  } else {
    parts.push("Path=/");
  }
  parts.push("Secure", "HttpOnly");
  if (options.mode === "partitioned" || options.mode === "partitioned_path_mount") {
    parts.push("SameSite=None", "Partitioned");
  } else parts.push("SameSite=Lax");
  return parts.join("; ");
}

export function serializeCookie(kind: CookieKind, value: string, options: CookieOptions): string {
  if (!COOKIE_VALUE_RE.test(value)) throw new Error("cookie value contains forbidden characters");
  const maxAge =
    options.maxAgeSeconds === undefined
      ? ""
      : `; Max-Age=${Math.min(Math.max(0, Math.floor(options.maxAgeSeconds)), MAX_COOKIE_AGE_SECONDS)}`;
  return `${cookieName(kind, options.mode)}=${value}; ${attributes(options)}${maxAge}`;
}

export function clearCookie(
  kind: CookieKind,
  options: Omit<CookieOptions, "maxAgeSeconds">,
): string {
  return `${cookieName(kind, options.mode)}=; ${attributes(options)}; Max-Age=0`;
}

/** Minimal RFC 6265 request-cookie parser; later duplicates win, values are not decoded. */
export function parseCookies(header: string | null | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out.set(name, value);
  }
  return out;
}

export function readCookie(
  header: string | null | undefined,
  kind: CookieKind,
  mode: CookieMode,
): string | undefined {
  return parseCookies(header).get(cookieName(kind, mode));
}
