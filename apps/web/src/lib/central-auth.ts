import { m } from "../paraglide/messages.js";
import { safeReturnTo } from "./api.js";

/*
 * Central auth origin (E3.10, ADR-0058 §5.6), the SPA's half. A custom domain or
 * `<slug>.<canonical>` host with CENTRAL_AUTH on signs people in through the canonical host:
 *
 *   workspace host  /auth/central/start?return=<path>    → canonical /auth/central/authorize
 *   canonical host  /login?returnTo=/auth/central/authorize?req=…  (no canonical session yet;
 *                   a re-auth with a stale proof: /auth/step-up?reason=fresh&returnTo=…)
 *   canonical host  /auth/central/authorize?req=…        → workspace host /auth/central/finish
 *   workspace host  /auth/central/finish?code=…          → the return path, signed in
 *                   … or /login?error=<CentralAuthError> | /login?sso=1 (enforced SSO)
 *
 * Those three are server routes, not SPA screens: reaching one after sign-in has to be a real
 * page load (the router would render its own not-found for them), and so does starting one.
 */

/** Test seam: the top-level navigations into the central-auth server routes. */
export const centralAuthNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/*
 * The server routes a return path could name, mirroring the server's own classifier
 * (apps/server `tenancy.ts`: the ops tree) plus the API, the central-auth steps and the embed
 * loader — as exactly as cheaply possible, because the portal's catch-all route renders module
 * pages at top-level paths (`/kpis`, `/updates`, …). `/metrics` is the server's ops endpoint on
 * every host; the investor KPIs page moved off it to `/kpis` (E-UP-18 D3), and a module's nav
 * entry may never be an ops path (apps/server `module-nav-ops.test.ts`). None of these is a page
 * the router renders, so none may be a sign-in's or a step's return path (L5). Not a complete
 * list of what the server serves — static assets and root files are left out, as no flow puts
 * them in a return path. `/auth/` itself is not here:
 * `/auth/step-up`, `/auth/magic-link` and `/auth/popup` are SPA screens.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Ops paths matched exactly (tenancy.ts `OPS_PATHS` and the other exact ops paths). */
const SERVER_EXACT: ReadonlySet<string> = new Set([
  "/healthz",
  "/readyz",
  "/metrics",
  "/csp-report",
  "/internal/tls/ask",
  "/security.txt",
  "/oauth/integrations/start",
  "/oauth/integrations/callback",
  "/webhooks/billing/stripe",
]);
const SERVER_PATTERNS: readonly RegExp[] = [
  /^\/api(?:\/|$)/u,
  /^\/auth\/central\//u,
  /^\/\.well-known\//u,
  /^\/scim\/v2(?:\/|$)/u,
  /^\/webhooks\/email\/[a-z0-9-]{1,32}$/u,
  new RegExp(`^/webhooks/(?:esign|accreditation|integrations)/${UUID}$`, "u"),
  new RegExp(`^/sso/(?:oidc/${UUID}/callback|saml/${UUID}/(?:acs|metadata))$`, "u"),
  /^\/embed\/(?:v\d+|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/[A-Za-z0-9._-]+$/u,
  /^\/embed\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/theme\.json$/u,
];

function pathnameOf(path: string): string {
  const raw = path.split(/[?#]/u, 1)[0] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The post-sign-in destination, router-relative. `next` (what the server's central-auth
 * redirect sets) wins over the SPA's own `returnTo`; both go through `safeReturnTo`. A `next`
 * that carries BASE_PATH has it removed, so either spelling works.
 */
export function signInReturnPath(
  input: { next?: string | undefined; returnTo?: string | undefined },
  basePath: string,
): string {
  const raw = input.next ?? input.returnTo;
  const safe = safeReturnTo(raw);
  if (basePath !== "" && (safe === basePath || safe.startsWith(`${basePath}/`))) {
    return signInDestination(safe.slice(basePath.length) || "/");
  }
  return signInDestination(safe);
}

/** True for a path the server serves (see `SERVER_EXACT` / `SERVER_PATTERNS`), not the router. */
export function isServerReturnPath(path: string): boolean {
  const pathname = pathnameOf(path);
  // The server's router is not strict about a trailing slash (`/metrics/` is the ops endpoint
  // too), so the path is asked both ways.
  const trimmed = pathname.replace(/(?<=.)\/+$/u, "");
  return [pathname, trimmed].some(
    (p) => SERVER_EXACT.has(p) || SERVER_PATTERNS.some((re) => re.test(p)),
  );
}

/** The one server path a sign-in may return to: a central-auth step (a full page load). */
function isCentralReturnPath(path: string): boolean {
  // The raw pathname, as the server routes it: `%2F` is not a separator there.
  return /^\/auth\/central\/[a-z]+$/u.test(path.split(/[?#]/u, 1)[0] ?? "");
}

/**
 * Where a sign-in goes on to: `safeReturnTo`, then any server path but a central-auth step
 * becomes `/` — the router would only render its not-found for one.
 */
export function signInDestination(raw: string | undefined): string {
  const safe = safeReturnTo(raw);
  return isServerReturnPath(safe) && !isCentralReturnPath(safe) ? "/" : safe;
}

/**
 * After a sign-in or step-up: a central-auth step is a full page load under BASE_PATH (returns
 * `true`); anything else is left to the caller's router navigation (returns `false`).
 */
export function leaveForServerPath(path: string, basePath: string): boolean {
  if (!isCentralReturnPath(path)) return false;
  centralAuthNavigation.assign(`${basePath}${path}`);
  return true;
}

/**
 * `path` without its `stepped` marker (`?stepped=1`: back from the step-up screen). A sign-in
 * afresh has confirmed nothing, so the marker never rides into one.
 */
export function withoutSteppedMarker(path: string): string {
  const url = new URL(path, "https://spa.invalid");
  url.searchParams.delete("stepped");
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * `startPath?return=<path>`: where the "Continue" button on a workspace host goes. `reauth`
 * (step-up) asks the canonical host for a fresh sign-in before it hands the session back;
 * `level: 2` (E-UP-18 D1) asks it to hand back nothing below level 2 — the canonical host
 * steps its own session up first (`/auth/step-up?reason=level`).
 */
export function centralStartHref(
  startPath: string,
  returnTo: string,
  opts: { reauth?: boolean; level?: 2 } = {},
): string {
  const safe = safeReturnTo(returnTo);
  const params: string[] = [];
  // Never bounce back into the central flow itself (a loop), and "/" needs no parameter.
  if (safe !== "/" && !isServerReturnPath(safe)) params.push(`return=${encodeURIComponent(safe)}`);
  if (opts.reauth === true) params.push("reauth=1");
  if (opts.level === 2) params.push("level=2");
  if (params.length === 0) return startPath;
  return `${startPath}${startPath.includes("?") ? "&" : "?"}${params.join("&")}`;
}

/**
 * Why a central sign-in came back to the workspace host without a session: the ONLY values the
 * server's finish puts in `/login?error=` (it maps anything else to `expired`).
 */
export const CENTRAL_AUTH_ERRORS = [
  "no_access",
  "expired",
  "binding_mismatch",
  "reauth_mismatch",
  "session_ended",
] as const;
export type CentralAuthError = (typeof CENTRAL_AUTH_ERRORS)[number];

export function isCentralAuthError(value: string | undefined): value is CentralAuthError {
  return CENTRAL_AUTH_ERRORS.some((code) => code === value);
}

/** Our sentence for each code — the raw value is never rendered. */
export function centralAuthErrorText(
  code: CentralAuthError,
  instance: string,
): { title: string; body: string } {
  switch (code) {
    case "no_access":
      return {
        title: m.login_central_no_access_title(),
        body: m.login_central_no_access_body(),
      };
    case "binding_mismatch":
      return {
        title: m.login_central_error_title(),
        body: m.login_central_error_binding_mismatch(),
      };
    case "reauth_mismatch":
      return {
        title: m.login_central_error_title(),
        body: m.login_central_error_reauth_mismatch({ instance }),
      };
    case "session_ended":
      return {
        title: m.login_central_error_title(),
        body: m.login_central_error_session_ended({ instance }),
      };
    default:
      return { title: m.login_central_error_title(), body: m.login_central_error_expired() };
  }
}
