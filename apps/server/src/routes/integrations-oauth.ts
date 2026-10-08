import type { IntegrationsKernel } from "@fundroom/integrations";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import { publicBaseOf } from "../path-mount.js";

/*
 * The OAuth handshake's two browser-facing halves (E3.6 contract §3, fix round 1), in the ops
 * tree: no tenant, no session, no CSRF. Both answer only on the canonical host without a slug
 * (`OAUTH_INTEGRATIONS_PATHS` in `tenancy.ts`); elsewhere these handlers step aside (the SPA's 404).
 *
 *  GET /oauth/integrations/start?ticket=…    burns the one-time ticket from
 *      `POST /integrations/{provider}/oauth/begin` (2 minutes), mints the OAuth `state`, a browser
 *      nonce and (PKCE) a verifier, sets the nonce as the binding cookie (HttpOnly, SameSite=Lax —
 *      Lax so it rides the vendor's top-level GET back — 10 minutes) and sends the browser to the
 *      vendor's consent screen. It needs no session: whoever holds the start URL can open it.
 *  GET /oauth/integrations/callback?code&state   consumes the state and requires the SAME browser
 *      that opened the start URL (`browser_mismatch` otherwise). That binds the two halves to one
 *      browser, but NOT to the member who began: a start URL mailed to someone else runs start and
 *      callback in their browser, with their vendor account. So the callback connects nothing. It
 *      exchanges the code, verifies the account and stores the grant as PENDING, then redirects to
 *      the workspace's `returnPath?integration=<p>&result=pending#pending=<one-time token>`. Only
 *      the initiator, signed in to that workspace with `integrations.manage` and a fresh session,
 *      turns it into a connection (`POST /integrations/{provider}/oauth/complete`) — the victim of
 *      a forwarded link has no session there, and the sender never sees the fragment. Errors
 *      redirect to `…?integration=<p>&result=error&reason=<code>`; an unknown or expired state to
 *      `/admin/integrations?result=error&reason=expired` on the base URL. Never a token, code or
 *      vendor error text in a query string.
 *
 * Cookie naming follows the session cookie's recipe (`@fundroom/identity` cookies): `__Host-` on a
 * root install, `__Secure-` with `Path=<public base>` under a base path — BASE_PATH, or the prefix
 * of the path mount the request came through (E3.9), decided per request — when `Secure` applies,
 * i.e. an https BASE_URL or a loopback host (browsers treat http://localhost as secure). A
 * plain-http BASE_URL on another host gets an unprefixed, non-Secure cookie, which the browser
 * would otherwise drop (every callback would be `browser_mismatch`).
 */
export const OAUTH_BINDING_COOKIE = "sh_intg";
const COOKIE_MAX_AGE_SECONDS = 600;

export interface IntegrationOAuthOptions {
  /** Read per request (the container's service). */
  readonly service: () => IntegrationsKernel;
  /** `Secure` + the `__Host-`/`__Secure-` prefix (see `bindingCookieSecure`). Default true. */
  readonly secure?: boolean | undefined;
  readonly log: Log;
}

/** Secure unless BASE_URL is plain http on a non-loopback host (see the file comment). */
export function bindingCookieSecure(baseUrl: URL): boolean {
  if (baseUrl.protocol === "https:") return true;
  const host = baseUrl.hostname.replace(/^\[|\]$/gu, "");
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./u.test(host)
  );
}

export function bindingCookieName(basePath: string, secure = true): string {
  if (!secure) return OAUTH_BINDING_COOKIE;
  return basePath === "" ? `__Host-${OAUTH_BINDING_COOKIE}` : `__Secure-${OAUTH_BINDING_COOKIE}`;
}

function cookieAttributes(basePath: string, secure: boolean): string {
  return `Path=${basePath === "" ? "/" : basePath};${secure ? " Secure;" : ""} HttpOnly; SameSite=Lax`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) found = part.slice(eq + 1).trim();
  }
  return found;
}

export function integrationOAuthRoutes(options: IntegrationOAuthOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const secure = options.secure ?? true;
  /** Per request: the public base (a path mount's prefix, else BASE_PATH) scopes the cookie. */
  const cookieOf = (c: Context<AppEnv>) => {
    const base = publicBaseOf(c);
    const name = bindingCookieName(base, secure);
    const attrs = cookieAttributes(base, secure);
    return { name, attrs, clear: `${name}=; ${attrs}; Max-Age=0` };
  };

  const redirect = (location: string, cookie?: string) => {
    const headers = new Headers({
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    if (cookie !== undefined) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 302, headers });
  };

  app.get("/oauth/integrations/start", async (c, next) => {
    if (c.get("classification")?.tree !== "ops") return next();
    const { name, attrs, clear } = cookieOf(c);
    const ticket = c.req.query("ticket") ?? "";
    try {
      const started = await options.service().startOAuth(ticket);
      if ("error" in started) {
        return redirect(options.service().oauthErrorUrl(started.error), clear);
      }
      return redirect(
        started.redirectTo,
        `${name}=${started.browserNonce}; ${attrs}; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      );
    } catch (error) {
      options.log("integrations.oauth_start_failed", {
        level: "error",
        error: error instanceof Error ? error.name : "unknown",
      });
      return redirect(options.service().oauthErrorUrl("internal"), clear);
    }
  });

  app.get("/oauth/integrations/callback", async (c, next) => {
    if (c.get("classification")?.tree !== "ops") return next();
    const { name, clear } = cookieOf(c);
    const query: Record<string, string> = {};
    for (const [k, v] of new URL(c.req.url).searchParams) {
      // First value wins; nothing longer than a vendor would ever send.
      if (!(k in query) && k.length <= 64 && v.length <= 4096) query[k] = v;
    }
    const nonce = readCookie(c.req.header("cookie"), name);
    try {
      const done = await options.service().completeOAuth(query, nonce);
      return redirect(done.redirectTo, clear);
    } catch (error) {
      // Only the error's name: a message could quote a vendor answer.
      options.log("integrations.oauth_callback_failed", {
        level: "error",
        error: error instanceof Error ? error.name : "unknown",
      });
      return redirect(options.service().oauthErrorUrl("internal"), clear);
    }
  });

  return app;
}
