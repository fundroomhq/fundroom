import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  z,
} from "@fundroom/contracts";
import type { ResolvedWorkspace } from "@fundroom/db";
import { requestHost } from "@fundroom/http";
import { cookieModeFor, type LoginContext } from "@fundroom/identity";
import {
  clearAuthRequestCookie,
  issueAuthRequestCookie,
  issueSessionCookies,
  readAuthRequestCookie,
  readDeviceCookie,
} from "@fundroom/identity/http";
import type { SsoService } from "@fundroom/sso";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import { cookieBasePathOf, publicBaseOf } from "../path-mount.js";
import { canonicalHostOf, stripBasePath } from "../tenancy.js";
import { safeReturnPath } from "./auth.js";
import { type ApiDeps, clientIp, workspaceUrl } from "./deps.js";

/*
 * The staff SSO login flow (E3.8, ADR-0056 decisions 3, 4 and 9).
 *
 *  - `registerSsoAuthRoutes`: the public `/api/v1/auth/sso{,/discover,/begin,/finish}` routes on
 *    the WORKSPACE origin (matrix rows are public, like `/auth/oidc/*`). Begin sets the `sso_req`
 *    binding cookie there; finish reads it back, so only the browser that began a sign-in can
 *    finish it (login CSRF), however the IdP round trip went.
 *  - `ssoOpsRoutes`: the IdP-facing routes on the CANONICAL host (`BASE_URL`), so a custom-domain
 *    change never breaks the IdP registration — `GET /sso/oidc/{id}/callback`,
 *    `POST /sso/saml/{id}/acs`, `GET /sso/saml/{id}/metadata`. Mounted in `app.ts` before the
 *    session/CSRF chain; they answer only when the classifier said `ops` (canonical host, no
 *    slug) and step aside otherwise. The callback / ACS verify everything and hand the verified
 *    facts to the workspace origin with a 303 to finish (which also turns SAML's cross-site POST
 *    into a same-site GET that carries the Lax binding cookie).
 *
 * Failures on callback / ACS / finish never answer JSON: they redirect to the workspace's
 * `/login?sso_error=<code>` (or `/admin/sso?sso_test=<code>` for a test login).
 */

type Api = OpenAPIHono<AppEnv>;

const tagAuth = ["auth"];
const ERRORS = errorResponses(400, 404, 409, 429, 500, 503);
/** The ACS body ceiling (research §1.2: cap before any XML parsing). */
export const SSO_ACS_MAX_BYTES = 256 * 1024;

const SsoLoginInfoSchema = z
  .object({
    available: z.boolean(),
    name: z.string().nullable(),
    protocol: z.enum(["oidc", "saml"]).nullable(),
    enforced: z.boolean(),
  })
  .openapi("SsoLoginInfo");

const SsoDiscoverBody = z
  .object({ email: z.string().min(1).max(320) })
  .strict()
  .openapi("SsoDiscoverBody");

const SsoDiscoverResponse = z.object({ sso: z.boolean() }).openapi("SsoDiscoverResponse");

const SsoBeginBody = z
  .object({
    returnTo: z.string().max(2048).optional(),
    test: z.boolean().optional(),
    loginHint: z.string().max(320).optional(),
    reauth: z.boolean().optional().openapi({
      description:
        "Re-authenticate the caller's SSO session for step-up: forces a fresh IdP login (OIDC `prompt=login` + `max_age=0`, SAML `ForceAuthn`), requires the IdP's authentication time within 5 minutes (`sso_error=reauth_required`) and the same user (`sso_error=reauth_mismatch`). Ignored unless the caller holds a session bound to this workspace's SSO.",
    }),
  })
  .strict()
  .openapi("SsoBeginBody");

const SsoBeginResponse = z
  .object({ url: z.string().openapi({ description: "Navigate here (top-level)" }) })
  .openapi("SsoBeginResponse");

/**
 * The cookie recipe begin issues and finish reads the binding with (top-level, never embed), on
 * the request's public base (E3.9): begin and finish both run on the origin the user began on.
 */
function bindingMode(c: Context<AppEnv>) {
  const basePath = publicBaseOf(c);
  return cookieModeFor({ embed: false, ...(basePath ? { basePath } : {}) });
}

function loginContextOf(c: Context<AppEnv>, deps: ApiDeps): LoginContext {
  const ws = c.get("workspace");
  const mode = bindingMode(c);
  return {
    workspaceId: ws?.id,
    workspaceName: ws?.name,
    ip: clientIp(c, deps.trustProxy),
    userAgent: c.req.header("user-agent")?.slice(0, 512),
    embed: false,
    deviceToken: readDeviceCookie(c, mode),
    rememberDevice: false,
    replacesSessionId: c.get("session")?.sessionId,
  };
}

/** `/w/<slug>` when this request addressed its workspace by path (multi-tenant), else "". */
function slugPrefixOf(c: Context<AppEnv>, basePath: string): string {
  const ws = c.get("workspace");
  const rest = stripBasePath(c.req.path, basePath) ?? "";
  const m = /^\/w\/([^/]+)(?:\/|$)/u.exec(rest);
  return ws !== undefined && m?.[1] === ws.slug ? `/w/${ws.slug}` : "";
}

/**
 * The app base the user BEGAN on (R1-M1): scheme + host + BASE_PATH (+ `/w/<slug>`), so finish
 * lands where the host-only `sso_req` cookie lives. Derived from the resolved request, never from
 * client input, and only for a host that is one of this workspace's own origins: the canonical
 * host, `<slug>.<canonical>` (multi), a verified custom domain the tenant middleware resolved to
 * this workspace (multi), or its active primary domain (single, where the classifier calls every
 * host canonical). Anything else falls back to the workspace's default URL.
 */
function beganOn(c: Context<AppEnv>, deps: ApiDeps, ws: ResolvedWorkspace): string {
  // A mounted request (E3.9) began on the mount — an allow-listed origin + prefix from config,
  // never the request's own headers — and finish must land there, where `sso_req` lives.
  const mount = c.get("pathMount");
  if (mount !== undefined) return `${mount.origin}${mount.prefix}${slugPrefixOf(c, deps.basePath)}`;
  const host = requestHost(c, deps.trustProxy !== false).replace(/:(?:80|443)$/u, "");
  const hostname = host.replace(/:\d+$/u, "");
  const canon = canonicalHostOf(deps.baseUrl);
  const kind = c.get("classification")?.host;
  // R3-L3: only BASE_URL's port (none for the scheme default) — a custom domain or primary host
  // on some other port is not an origin this install serves.
  const portOf = (h: string) => /:(\d+)$/u.exec(h)?.[1] ?? "";
  const own =
    portOf(host) === portOf(canon) &&
    (host === canon ||
      (deps.tenancy === "multi" && host === `${ws.slug}.${canon}`) ||
      (deps.tenancy === "multi" && kind === "custom") ||
      (ws.primaryHost !== null && hostname === ws.primaryHost.toLowerCase()));
  if (!own) {
    // Paths passed to `workspaceUrl` are relative to BASE_URL, which already carries the base.
    return workspaceUrl(deps.baseUrl, deps.tenancy, ws, "/", deps.basePath).href.replace(
      /\/$/u,
      "",
    );
  }
  return `${deps.baseUrl.protocol}//${host}${deps.basePath}${slugPrefixOf(c, deps.basePath)}`;
}

function noStoreRedirect(location: string, status: 302 | 303): Response {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export function registerSsoAuthRoutes(api: Api, deps: ApiDeps): void {
  api.openapi(
    createRoute({
      method: "get",
      path: "/auth/sso",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Whether this workspace offers staff single sign-on",
      description:
        "`available`: an enabled connection on a protocol this install offers. `enforced`: staff must sign in with SSO here. All false/null with no resolved workspace.",
      responses: { 200: jsonResponse(SsoLoginInfoSchema, "SSO availability"), ...ERRORS },
    }),
    async (c) => {
      const ws = c.get("workspace");
      if (ws === undefined) {
        return c.json({ available: false, name: null, protocol: null, enforced: false }, 200);
      }
      return c.json(await deps.sso.publicInfo(ws.id), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/sso/discover",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Whether an email should sign in with this workspace's SSO",
      description:
        "True when the email's domain is a verified SSO domain of this workspace and SSO is available. Rate-limited per IP; answers after the same minimum time either way.",
      request: { body: jsonBody(SsoDiscoverBody) },
      responses: { 200: jsonResponse(SsoDiscoverResponse, "Discovery answer"), ...ERRORS },
    }),
    async (c) => {
      const ws = c.get("workspace");
      const { email } = c.req.valid("json");
      if (ws === undefined) return c.json({ sso: false }, 200);
      const sso = await deps.sso.discover({
        workspaceId: ws.id,
        email,
        ip: clientIp(c, deps.trustProxy),
      });
      return c.json({ sso }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/sso/begin",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Begin a staff SSO sign-in; returns the IdP URL to navigate to",
      description:
        "Sets the `sso_req` browser-binding cookie. `test: true` (a member holding `sso.manage`) runs the whole verification even while the connection is disabled, writes no identity, membership or session, and ends on `/admin/sso?sso_test=ok|<code>`.",
      request: { body: jsonBody(SsoBeginBody) },
      responses: { 200: jsonResponse(SsoBeginResponse, "Redirect the browser here"), ...ERRORS },
    }),
    async (c) => {
      const ws = c.get("workspace");
      const body = c.req.valid("json");
      if (ws === undefined) {
        throw new ApiError("sso_not_configured", "no workspace here offers single sign-on");
      }
      let tester: { membershipId: string; userId: string } | undefined;
      if (body.test === true) {
        const session = c.get("session");
        const m = c.get("membership");
        if (
          session === undefined ||
          m === undefined ||
          m.kind !== "staff" ||
          !deps.authz.hasPermission(m, "sso.manage")
        ) {
          throw new ApiError("forbidden", "a test sign-in needs the sso.manage permission", {
            permission: "sso.manage",
          });
        }
        tester = { membershipId: m.id, userId: session.userId };
      }
      const bound = c.get("session");
      const reauthUserId =
        body.reauth === true && tester === undefined && bound?.sso?.workspaceId === ws.id
          ? bound.userId
          : undefined;
      const appBase = beganOn(c, deps, ws);
      const r = await deps.sso.begin({
        workspaceId: ws.id,
        appBase,
        returnTo: safeReturnPath(body.returnTo, publicBaseOf(c)),
        tester,
        loginHint: body.loginHint,
        reauthUserId,
        ip: clientIp(c, deps.trustProxy),
      });
      issueAuthRequestCookie(c, {
        kind: "ssoRequest",
        bindingToken: r.bindingToken,
        maxAgeSeconds: r.bindingMaxAgeSeconds,
        mode: bindingMode(c),
        basePath: cookieBasePathOf(c),
      });
      c.header("Cache-Control", "no-store");
      return c.json({ url: r.url }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/auth/sso/finish",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Finish a staff SSO sign-in (the IdP round trip's last hop)",
      description:
        "Checks the `sso_req` binding cookie, consumes the single-use handoff, resolves the user (linking / JIT) and sets the session cookies. Always a redirect: to `returnTo`, to `/admin/sso?sso_test=…` for a test, or to `/login?sso_error=<code>` on failure. Only what never reaches the handler is JSON: a malformed query (an `h` over 256 characters) and the kernel's own refusals (unknown host, rate limit, unavailable).",
      request: { query: z.object({ h: z.string().max(256).optional() }) },
      responses: {
        302: {
          description: "Signed in (or refused); redirect into the app",
          headers: { Location: { schema: { type: "string" } } },
        },
        ...errorResponses(400, 404, 429, 500, 503),
      },
    }),
    async (c) => {
      // The public base for everything the browser sees; the internal one to parse the path.
      const base = publicBaseOf(c);
      const mode = bindingMode(c);
      const bindingToken = readAuthRequestCookie(c, mode, "ssoRequest");
      clearAuthRequestCookie(c, {
        kind: "ssoRequest",
        mode,
        basePath: cookieBasePathOf(c),
      });
      const redirect = (path: string) => {
        c.header("Cache-Control", "no-store");
        c.header("Referrer-Policy", "no-referrer");
        return c.redirect(`${base}${slugPrefixOf(c, deps.basePath)}${path}`, 302);
      };
      let outcome: Awaited<ReturnType<SsoService["finish"]>>;
      try {
        outcome = await deps.sso.finish({
          handoff: c.req.query("h") ?? "",
          bindingToken,
          workspaceId: c.get("workspace")?.id,
          login: loginContextOf(c, deps),
        });
      } catch (error) {
        deps.log("sso.finish_failed", {
          level: "error",
          error: error instanceof Error ? error.name : "unknown",
        });
        return redirect("/login?sso_error=invalid_response");
      }
      if (outcome.kind === "error") return redirect(`/login?sso_error=${outcome.code}`);
      if (outcome.kind === "test") return redirect(`/admin/sso?sso_test=${outcome.outcome}`);
      issueSessionCookies(c, {
        token: outcome.result.token,
        deviceToken: outcome.result.deviceToken,
        mode,
        basePath: cookieBasePathOf(c),
      });
      return redirect(safeReturnPath(outcome.returnTo, base) ?? "/");
    },
  );
}

export interface SsoOpsOptions {
  /** Read per request (the container's service). */
  readonly sso: () => SsoService;
  readonly log: Log;
}

export function ssoOpsRoutes(options: SsoOpsOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const failed = (step: string, error: unknown) => {
    options.log("sso.ops_failed", {
      level: "error",
      step,
      error: error instanceof Error ? error.name : "unknown",
    });
  };

  app.get("/sso/oidc/:connectionId/callback", async (c, next) => {
    if (c.get("classification")?.tree !== "ops") return next();
    try {
      const location = await options
        .sso()
        .oidcCallback(c.req.param("connectionId"), new URL(c.req.url));
      return noStoreRedirect(location, 303);
    } catch (error) {
      failed("oidc_callback", error);
      return c.text("sign-in failed", 500);
    }
  });

  app.post(
    "/sso/saml/:connectionId/acs",
    async (c, next) => {
      if (c.get("classification")?.tree !== "ops") return next();
      return bodyLimit({
        maxSize: SSO_ACS_MAX_BYTES,
        onError: (cc) => cc.text("payload too large", 413),
      })(c, next);
    },
    async (c, next) => {
      if (c.get("classification")?.tree !== "ops") return next();
      const type = c.req.header("content-type") ?? "";
      if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
        return c.text("unsupported media type", 415);
      }
      try {
        const body = await c.req.parseBody();
        const field = (k: string) =>
          typeof body[k] === "string" ? (body[k] as string) : undefined;
        const location = await options.sso().samlAcs(c.req.param("connectionId"), {
          SAMLResponse: field("SAMLResponse"),
          RelayState: field("RelayState"),
        });
        return noStoreRedirect(location, 303);
      } catch (error) {
        failed("saml_acs", error);
        return c.text("sign-in failed", 500);
      }
    },
  );

  app.get("/sso/saml/:connectionId/metadata", async (c, next) => {
    if (c.get("classification")?.tree !== "ops") return next();
    try {
      const xml = await options.sso().spMetadata(c.req.param("connectionId"));
      if (xml === undefined) return c.text("not found", 404);
      return c.body(xml, 200, {
        "Content-Type": "application/samlmetadata+xml; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      });
    } catch (error) {
      failed("saml_metadata", error);
      return c.text("unavailable", 503);
    }
  });

  return app;
}
