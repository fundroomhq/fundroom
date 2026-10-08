import { ApiError } from "@fundroom/contracts";
import { requestHost } from "@fundroom/http";
import {
  CENTRAL_AUTH_ERROR_CODES,
  type CentralAuthErrorCode,
  centralMinLevel,
  cookieModeFor,
  isBoundSession,
} from "@fundroom/identity";
import {
  clearAuthRequestCookie,
  issueAuthRequestCookie,
  issueSessionCookies,
  readAuthRequestCookie,
  readDeviceCookie,
} from "@fundroom/identity/http";
import { type Context, Hono } from "hono";
import type { CentralAuthKernel } from "../control-plane/kernel.js";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import { pageErrorResponse } from "../middleware/errors.js";
import { cookieBasePathOf, publicBaseOf } from "../path-mount.js";
import { safeReturnPath } from "./auth.js";
import { clientIp, proxyTrustOf } from "./deps.js";

/*
 * Central auth origin (E3.10, ADR-0058; owner: agent CA): `GET /auth/central/start` (workspace
 * host: custom domain or `<slug>.<canonical>`), `GET /auth/central/authorize` (canonical host),
 * `GET /auth/central/finish` (workspace host). Redirect-only, not `/api/v1` (no OpenAPI operation,
 * no matrix row). App tree, NOT ops: mounted in `app.ts` after tenant + session resolution and
 * before the SPA, so start/finish see the workspace the host resolved to and authorize sees the
 * canonical session. Every route is a 404 (falls through to the SPA's) unless CENTRAL_AUTH=on,
 * and each answers only on the host kind it belongs to — start/finish on a workspace host,
 * authorize on the canonical host with no workspace — and never on a path-mounted request (a
 * mount is somebody else's origin; its visitors sign in there the ordinary way).
 *
 *  - start `?return=<path>[&reauth=1][&level=2]` → sets `__Host-auth_creq` (the verifier) on this host, 303
 *    to the canonical authorize.
 *  - authorize `?req=` → no canonical session: 303 to the canonical `/login?returnTo=<this URL>`
 *    (the SPA navigates there with a full page load after sign-in); a canonical session below the
 *    request's minimum level (E-UP-18: `level=2`, or a re-authentication from a level-2
 *    workspace session): `/auth/step-up?reason=level&returnTo=<this URL>`; a re-authentication
 *    with a stale proof: `reason=fresh`; otherwise 303 to the origin's
 *    finish with `code=` or `error=`, or to its `/login?sso=1` for enforced-SSO staff.
 *  - finish `?code=` | `?error=` → clears the verifier cookie; on success sets the session cookie
 *    and 303s to the return path; otherwise 303s to `/login?error=<code>` (codes:
 *    `CENTRAL_AUTH_ERROR_CODES`).
 *
 * Every response is `Cache-Control: no-store`: the code and the request token ride in URLs and must
 * not reach a cache. (The app's security headers set `Referrer-Policy:
 * strict-origin-when-cross-origin` on page responses after this handler, so a Referer to another
 * site never carries the path either way; the handoff code is spent before any same-origin page
 * could send it.)
 */
export interface CentralAuthRouteOptions {
  /** Read per request (tests swap the kernel). */
  readonly centralAuth: () => CentralAuthKernel;
  readonly log: Log;
}

const AUTHORIZE_PATH = "/auth/central/authorize";
const FINISH_PATH = "/auth/central/finish";

/** A 303 that carries whatever cookies the handler set on `c`. */
function redirect(c: Context<AppEnv>, location: string): Response {
  c.header("Cache-Control", "no-store");
  return c.redirect(location, 303);
}

/** The recipe the verifier and the session cookie use on this host (top-level, never embed). */
function modeOf(c: Context<AppEnv>) {
  const basePath = publicBaseOf(c);
  return cookieModeFor({ embed: false, ...(basePath ? { basePath } : {}) });
}

/** `scheme://host[:port]` of this request: BASE_URL's scheme, the request's host (as `beganOn`). */
function originOf(c: Context<AppEnv>, kernel: CentralAuthKernel): string {
  const host = requestHost(c, proxyTrustOf(kernel.proxy) !== false).replace(/:(?:80|443)$/u, "");
  return `${kernel.baseUrl.protocol}//${host}`;
}

/** A workspace host of this install (custom domain or `<slug>.<canonical>`), not mounted. */
function onWorkspaceHost(c: Context<AppEnv>): boolean {
  const host = c.get("classification")?.host;
  return (
    (host === "custom" || host === "tenant") &&
    c.get("workspace") !== undefined &&
    c.get("pathMount") === undefined
  );
}

function errorCodeOf(raw: string | undefined): CentralAuthErrorCode {
  return CENTRAL_AUTH_ERROR_CODES.find((code) => code === raw) ?? "expired";
}

export function centralAuthRoutes(options: CentralAuthRouteOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>({ strict: false });

  app.get("/auth/central/:step{start|authorize|finish}", async (c, next) => {
    if (c.get("classification")?.tree !== "app") return next();
    const kernel = options.centralAuth();
    const service = kernel.service;
    if (!kernel.enabled || service === undefined) return next();
    const base = publicBaseOf(c);
    const step = c.req.param("step");

    if (step === "start") {
      if (!onWorkspaceHost(c)) return next();
      const ws = c.get("workspace");
      if (ws === undefined) return next();
      const wanted = safeReturnPath(c.req.query("return"), base) ?? "/";
      // Never back into this flow: a return path inside it would only loop.
      const returnPath = wanted.startsWith("/auth/central/") ? "/" : wanted;
      const reauth = c.req.query("reauth") === "1";
      const current = c.get("session");
      const started = await service.start({
        workspace: ws,
        origin: originOf(c, kernel),
        returnPath,
        reauth,
        reauthUserId: reauth ? current?.userId : undefined,
        minLevel: centralMinLevel({
          reauth,
          currentLevel: current?.authLevel,
          levelQuery: c.req.query("level"),
        }),
        ip: clientIp(c, proxyTrustOf(kernel.proxy)),
      });
      if (!started.ok) {
        if (started.code === "origin") return next();
        const seconds = Math.ceil((started.retryAfterMs ?? 60_000) / 1000);
        return c.text("Too many sign-in attempts. Try again shortly.", 429, {
          "Retry-After": String(seconds),
          "Cache-Control": "no-store",
        });
      }
      issueAuthRequestCookie(c, {
        kind: "centralRequest",
        bindingToken: started.verifier,
        maxAgeSeconds: started.maxAgeSeconds,
        mode: modeOf(c),
        basePath: cookieBasePathOf(c),
      });
      const target = `${kernel.baseUrl.origin}${kernel.basePath}${AUTHORIZE_PATH}?req=${encodeURIComponent(started.requestToken)}`;
      return redirect(c, target);
    }

    if (step === "authorize") {
      // The canonical host, with no workspace: the only place the canonical session is admitted.
      if (c.get("classification")?.host !== "canonical" || c.get("workspace") !== undefined)
        return next();
      if (c.get("pathMount") !== undefined) return next();
      const token = c.req.query("req") ?? "";
      const session = c.get("session");
      const outcome = await service.authorize({
        requestToken: token,
        // Belt and braces: the middleware never admits a bound session without a workspace.
        session: session !== undefined && !isBoundSession(session) ? session : undefined,
      });
      const self = `${AUTHORIZE_PATH}?req=${encodeURIComponent(token)}`;
      switch (outcome.kind) {
        case "invalid":
          return pageErrorResponse(c, new ApiError("not_found", "no such sign-in request"));
        case "sign_in":
          return redirect(c, `${base}/login?returnTo=${encodeURIComponent(self)}`);
        case "step_up":
          return redirect(
            c,
            `${base}/auth/step-up?reason=${outcome.reason}&returnTo=${encodeURIComponent(self)}`,
          );
        case "back":
          return redirect(
            c,
            `${outcome.origin}${kernel.basePath}${FINISH_PATH}?error=${outcome.error}`,
          );
        case "sso":
          return redirect(c, `${outcome.origin}${kernel.basePath}/login?sso=1`);
        case "code":
          return redirect(
            c,
            `${outcome.origin}${kernel.basePath}${FINISH_PATH}?code=${encodeURIComponent(outcome.code)}`,
          );
      }
    }

    // finish
    if (!onWorkspaceHost(c)) return next();
    const ws = c.get("workspace");
    if (ws === undefined) return next();
    const mode = modeOf(c);
    const verifier = readAuthRequestCookie(c, mode, "centralRequest");
    // One attempt per verifier, whatever the outcome: a second finish needs a new start.
    clearAuthRequestCookie(c, { kind: "centralRequest", mode, basePath: cookieBasePathOf(c) });
    const done = (location: string) => redirect(c, location);
    const code = c.req.query("code");
    if (code === undefined) {
      return done(`${base}/login?error=${errorCodeOf(c.req.query("error"))}`);
    }
    const current = c.get("session");
    const outcome = await service.finish({
      code,
      verifier,
      workspaceId: ws.id,
      workspaceName: ws.name,
      origin: originOf(c, kernel),
      ip: clientIp(c, proxyTrustOf(kernel.proxy)),
      userAgent: c.req.header("user-agent")?.slice(0, 512),
      deviceToken: readDeviceCookie(c, mode),
      replacesSessionId: current?.sessionId,
    });
    if (outcome.kind === "error") return done(`${base}/login?error=${outcome.code}`);
    issueSessionCookies(c, {
      token: outcome.started.token,
      deviceToken: outcome.started.deviceToken,
      mode,
      basePath: cookieBasePathOf(c),
    });
    options.log("central_auth.signed_in", { workspaceId: ws.id });
    return done(`${base}${safeReturnPath(outcome.returnPath, base) ?? "/"}`);
  });

  return app;
}
