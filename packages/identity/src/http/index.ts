import type { AuthenticatedSession, AuthLevel, AuthPort } from "@fundroom/ports";
import type { Context, MiddlewareHandler } from "hono";
import { type CookieMode, clearCookie, readCookie, serializeCookie } from "../cookies/cookies.js";
import { type CsrfOptions, checkCsrf } from "../csrf/csrf.js";
import { AuthError } from "../errors.js";
import { STEP_UP_MAX_AGE_MS } from "../policy/lifetimes.js";

/*
 * Hono middleware over the kernel (ADR-0002). E0.6 mounts these in apps/server; modules use
 * `requireSession()` / `requireAuthLevel()` / `requireFreshAuth()` on their routes. Errors are
 * returned as the kernel's JSON envelope (`{ error: { code, message, … } }`).
 */
export interface AuthVariables {
  session?: AuthenticatedSession;
  /** Raw token from the cookie, for logout (revoke by id is preferred). */
  sessionToken?: string;
  cookieMode: CookieMode;
  /**
   * Set when this request was refused for a security reason worth an event of its own (E2.10
   * F-29, ASVS 16.3.2/16.3.3): an authorization denial or a CSRF rejection. The server's
   * request log turns it into a `security.*` log event and a counter; nothing here logs.
   */
  securityEvent?: SecurityEventMark;
  /**
   * Staff SSO enforcement (E3.8): set when the caller is a live staff member of the resolved
   * workspace but the workspace requires SSO and this session was not minted by its connection.
   * The membership is then NOT admitted (no `membership` / `tenant`); guards answer 403
   * `sso_required` and the bootstrap reports it. `breakGlass`: the member is an owner, who is
   * admitted once the session reaches auth level 2 (step-up with TOTP or a passkey).
   */
  ssoRequired?: { readonly breakGlass: boolean };
}

/** What a refused request records for the security-event log (no PII: codes and ids only). */
export interface SecurityEventMark {
  /**
   * `access_request_throttled` (E3.1 S4): the public access-request form's workspace-wide or
   * per-IP budget refused a submission. The answer the client got was the ordinary one.
   * `api_key_rejected` (E3.4): a malformed, unknown, revoked or expired `frk_` (or legacy `shk_`)
   * bearer key.
   * `esign_callback_rejected` (E3.5): an e-sign vendor callback failed authentication (401).
   * `accreditation_callback_rejected` (E3.7): the same for an accreditation vendor callback.
   * (`esign_artifact_infected`, the collector's other E3.5 security event, has no request and is
   * counted through the server's `countSecurityEvent`.)
   */
  readonly event:
    | "authz_denied"
    | "csrf_rejected"
    | "access_request_throttled"
    | "api_key_rejected"
    | "esign_callback_rejected"
    | "accreditation_callback_rejected";
  /** The error code answered (`forbidden`, `not_found`, `csrf_rejected`). */
  readonly code: string;
  /** Bounded reason (`cross_site`, `origin_mismatch`, …) where the refusal has one. */
  readonly reason?: string | undefined;
  /** The RBAC permission that was missing, for `authz_denied`. */
  readonly permission?: string | undefined;
  /**
   * `api_key_rejected` only: the display prefix (`frk_`/`shk_` + 8) of a token-shaped bearer value —
   * never the token. Absent when the value was not shaped like a token.
   */
  readonly keyPrefix?: string | undefined;
}

export type AuthEnv = { Variables: AuthVariables };

export interface SessionMiddlewareOptions {
  readonly auth: Pick<AuthPort, "resolveSession">;
  /** Decides the cookie recipe for this request (embed route tree → `partitioned`). */
  readonly cookieMode: (c: Context) => CookieMode;
  /**
   * Whether a live session may serve this request (E3.8: an SSO-bound session only serves its own
   * workspace). A session it refuses is treated as absent — not revoked. Default: every session.
   */
  readonly admits?: ((c: Context, session: AuthenticatedSession) => boolean) | undefined;
}

export function errorResponse(c: Context, error: AuthError): Response {
  const body = error.toBody();
  const headers: Record<string, string> = {};
  const retry = error.details["retryAfterMs"];
  if (typeof retry === "number") headers["Retry-After"] = String(Math.ceil(retry / 1000));
  return c.json(body, error.status as 400, headers);
}

/** Resolves the session cookie (if any) into `c.get("session")`; never rejects by itself. */
export function sessionMiddleware(options: SessionMiddlewareOptions): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const mode = options.cookieMode(c);
    c.set("cookieMode", mode);
    const token = readCookie(c.req.header("cookie"), "session", mode);
    if (token) {
      const session = await options.auth.resolveSession(token);
      if (session && (options.admits === undefined || options.admits(c, session))) {
        c.set("session", session);
        c.set("sessionToken", token);
      }
    }
    await next();
  };
}

export interface CsrfMiddlewareOptions {
  readonly selfOrigin: string | ((c: Context) => string);
  readonly allowedOrigins?: ((c: Context) => readonly string[]) | undefined;
  /** Skip the check for requests that carry no cookie session (bearer API clients). Default true. */
  readonly skipWithoutSession?: boolean | undefined;
}

/** Origin / Sec-Fetch-Site check on every mutating request that rides on a cookie. */
export function csrfMiddleware(options: CsrfMiddlewareOptions): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const hasCookieSession = c.get("session") !== undefined || c.req.header("cookie") !== undefined;
    if ((options.skipWithoutSession ?? true) && !hasCookieSession) return next();
    const csrf: CsrfOptions = {
      selfOrigin:
        typeof options.selfOrigin === "function" ? options.selfOrigin(c) : options.selfOrigin,
      ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins(c) } : {}),
    };
    const verdict = checkCsrf(c.req.method, c.req.raw.headers, csrf);
    if (!verdict.ok) {
      c.set("securityEvent", {
        event: "csrf_rejected",
        code: "csrf_rejected",
        reason: verdict.reason,
      });
      return errorResponse(
        c,
        new AuthError("csrf_rejected", `request rejected (${verdict.reason})`, {
          reason: verdict.reason,
        }),
      );
    }
    await next();
  };
}

export function requireSession(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!c.get("session"))
      return errorResponse(c, new AuthError("unauthenticated", "sign in to continue"));
    await next();
  };
}

/** `auth_level >= level`; otherwise 403 `step_up_required` with `reason: "level"`. */
export function requireAuthLevel(level: AuthLevel): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const s = c.get("session");
    if (!s) return errorResponse(c, new AuthError("unauthenticated", "sign in to continue"));
    if (s.authLevel < level) {
      return errorResponse(
        c,
        new AuthError("step_up_required", "stronger authentication required", {
          reason: "level",
          requiredLevel: level,
          currentLevel: s.authLevel,
        }),
      );
    }
    await next();
  };
}

/** Step-up (§6.2): the last proof must be younger than `maxAgeMs`; otherwise `reason: "fresh"`. */
export function requireFreshAuth(
  maxAgeMs = STEP_UP_MAX_AGE_MS,
  now: () => Date = () => new Date(),
): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const s = c.get("session");
    if (!s) return errorResponse(c, new AuthError("unauthenticated", "sign in to continue"));
    const age = now().getTime() - s.authTime.getTime();
    if (age > maxAgeMs) {
      return errorResponse(
        c,
        new AuthError("step_up_required", "please confirm it's you", {
          reason: "fresh",
          maxAgeMs,
          ageMs: age,
        }),
      );
    }
    await next();
  };
}

export interface IssueCookiesInput {
  readonly token: string;
  readonly deviceToken?: string | undefined;
  readonly mode: CookieMode;
  readonly basePath?: string | undefined;
  /** Session cookie lifetime; defaults to a browser-session cookie. */
  readonly maxAgeSeconds?: number | undefined;
}

/** Appends the session (and device) `Set-Cookie` headers to a response. */
export function issueSessionCookies(c: Context, input: IssueCookiesInput): void {
  const base = { mode: input.mode, ...(input.basePath ? { basePath: input.basePath } : {}) };
  c.header(
    "Set-Cookie",
    serializeCookie("session", input.token, {
      ...base,
      ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
    }),
    { append: true },
  );
  if (input.deviceToken) {
    c.header(
      "Set-Cookie",
      serializeCookie("device", input.deviceToken, { ...base, maxAgeSeconds: 400 * 24 * 3600 }),
      { append: true },
    );
  }
}

export function clearSessionCookies(
  c: Context,
  input: { mode: CookieMode; basePath?: string | undefined; clearDevice?: boolean | undefined },
): void {
  const base = { mode: input.mode, ...(input.basePath ? { basePath: input.basePath } : {}) };
  c.header("Set-Cookie", clearCookie("session", base), { append: true });
  if (input.clearDevice) c.header("Set-Cookie", clearCookie("device", base), { append: true });
}

/**
 * A browser-binding cookie kind: magic link (`auth_req`), OIDC (`oidc_req`), workspace SSO
 * (`sso_req`) or central auth (`auth_creq`, E3.10).
 */
export type BindingCookieKind = "authRequest" | "oidcRequest" | "ssoRequest" | "centralRequest";

/** A browser-binding cookie (magic link by default), set when a sign-in is requested. */
export function issueAuthRequestCookie(
  c: Context,
  input: {
    bindingToken: string;
    maxAgeSeconds: number;
    mode: CookieMode;
    basePath?: string | undefined;
    kind?: BindingCookieKind | undefined;
  },
): void {
  c.header(
    "Set-Cookie",
    serializeCookie(input.kind ?? "authRequest", input.bindingToken, {
      mode: input.mode,
      ...(input.basePath ? { basePath: input.basePath } : {}),
      maxAgeSeconds: input.maxAgeSeconds,
    }),
    { append: true },
  );
}

export function readAuthRequestCookie(
  c: Context,
  mode: CookieMode,
  kind: BindingCookieKind = "authRequest",
): string | undefined {
  return readCookie(c.req.header("cookie"), kind, mode);
}

/** Expires a binding cookie once its sign-in attempt is over. */
export function clearAuthRequestCookie(
  c: Context,
  input: { mode: CookieMode; basePath?: string | undefined; kind?: BindingCookieKind | undefined },
): void {
  c.header(
    "Set-Cookie",
    clearCookie(input.kind ?? "authRequest", {
      mode: input.mode,
      ...(input.basePath ? { basePath: input.basePath } : {}),
    }),
    { append: true },
  );
}

export function readDeviceCookie(c: Context, mode: CookieMode): string | undefined {
  return readCookie(c.req.header("cookie"), "device", mode);
}
