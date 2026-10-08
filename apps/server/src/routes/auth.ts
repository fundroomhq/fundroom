import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  kernel as k,
  OkSchema,
  type OpenAPIHono,
  sessionSecurity,
  z,
} from "@fundroom/contracts";
import type {
  FactorChangeContext,
  LoginContext,
  LoginResult,
  StepUpResult,
} from "@fundroom/identity";
import { type CookieMode, cookieModeFor, isPathScopedMode } from "@fundroom/identity";
import {
  clearAuthRequestCookie,
  clearSessionCookies,
  issueAuthRequestCookie,
  issueSessionCookies,
  readAuthRequestCookie,
  readDeviceCookie,
} from "@fundroom/identity/http";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import {
  cookieModeOf,
  refuseSsoBoundSession,
  requireFreshAuth,
  requireSession,
} from "../middleware/auth.js";
import { canonicalBaseOf, cookieBasePathOf, publicBaseOf } from "../path-mount.js";
import { type ApiDeps, clientIp } from "./deps.js";
import { deviceBody, loginBody, sessionSummaryBody } from "./serialize.js";

/*
 * Auth routes (E0.3's flows, mounted here). Anti-enumeration is the flows' job; these
 * handlers only translate HTTP: cookies in, cookies out, error codes through the envelope.
 * Start endpoints for OTP and magic link succeed for every syntactically valid email.
 */
type Api = OpenAPIHono<AppEnv>;

/*
 * Passkeys on a custom portal domain (E2.1 §1.13, ADR-0039 decision 12).
 *
 * A WebAuthn credential is bound to the RP id it was created under, and this install has exactly
 * one: `passkeys.rpId` is a single value and `passkeys.origins` a one-element array, both derived
 * from `BASE_URL` (and `packages/config` *requires* `PASSKEY_RP_ID` to be the BASE_URL host). So a
 * ceremony run on `investors.acme.com` would present options naming the canonical host, and the
 * browser would refuse them — or, worse on some platforms, half-succeed and leave a credential the
 * user cannot use anywhere.
 *
 * Per-domain passkeys need a central auth origin and a cross-domain session handoff, which E2.1
 * explicitly does not own. Until that exists the only honest behaviour is to refuse **before** the
 * ceremony starts, with an error that says what to do instead: sign in on the canonical origin, or
 * use a code. `unsupported` (400) is the existing code for "this install cannot do that"; every
 * other auth method works on a custom domain unchanged.
 */
function refusePasskeysOnCustomDomain(c: Context<AppEnv>): void {
  if (c.get("classification")?.host !== "custom") return;
  throw new ApiError(
    "unsupported",
    "passkeys are not available on a custom domain: a passkey is bound to the origin it was registered on, and this install has one passkey origin. Use an email code here, or sign in on the portal's canonical address.",
    { reason: "custom_domain" },
  );
}

/**
 * The same refusal for a path mount (E3.9 FR1 B5): the page's origin is not the passkey RP origin
 * (BASE_URL's) — a mount on another origin, or the direct portal when BASE_URL is a mount.
 */
function refusePasskeysOffRpOrigin(c: Context<AppEnv>): void {
  if (c.get("offPasskeyOrigin") !== true) return;
  throw new ApiError(
    "unsupported",
    "passkeys are not available at this address: a passkey is bound to the origin it was registered on, and this install has one passkey origin. Use an email code here, or sign in on the portal's canonical address.",
    { reason: "path_mount" },
  );
}

/*
 * Post-login return path (F-02, ASVS 3.7.2). The OIDC callback 302s to `${basePath}${returnTo}`,
 * so `returnTo` must stay a path on this origin under the base path. A prefix check is not
 * enough: WHATWG URL parsing turns `/\evil.com` and `/<TAB>/evil.com` into `//evil.com`. The
 * value is therefore refused outright if it holds a backslash, whitespace or a control character,
 * or starts with `//`; what is left is resolved against a placeholder origin, must stay on that
 * origin and inside the base path, and only the normalised path + query + fragment is kept.
 */
const RETURN_ORIGIN = "https://return-to.invalid";
/** A backslash, any C0/C1 control character, or anything the URL parser treats as whitespace. */
function hasUnsafeReturnChar(raw: string): boolean {
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0) || ch === "\\" || /\s/u.test(ch)) return true;
    if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x200e || cp === 0x200f)
      return true;
    if (cp === 0xfeff) return true;
  }
  return false;
}

export function safeReturnPath(raw: string | undefined, basePath: string): string | undefined {
  if (raw === undefined || raw === "" || raw.length > 2048) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  if (hasUnsafeReturnChar(raw)) return undefined;
  // An encoded backslash or slash right after the leading one is how the same trick survives a
  // client that decodes before navigating; nothing legitimate starts that way.
  if (/^\/%(?:5c|2f)/iu.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(`${basePath}${raw}`, RETURN_ORIGIN);
  } catch {
    return undefined;
  }
  if (url.origin !== RETURN_ORIGIN) return undefined;
  if (basePath !== "" && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
    return undefined;
  const path = url.pathname.slice(basePath.length) || "/";
  if (!path.startsWith("/") || path.startsWith("//")) return undefined;
  // Again on the *normalised* path (E2.10 R1-06): dot segments vanish in normalisation, so
  // `/./%2Fevil.com` only starts with an encoded slash afterwards. An encoded slash or backslash
  // anywhere in the first segment is refused: nothing legitimate has one there.
  if (/%(?:2f|5c)/iu.test(path.slice(1).split("/")[0] ?? "")) return undefined;
  return `${path}${url.search}${url.hash}`;
}

/**
 * The cookie recipe the OIDC *callback* reads with. The callback is always a top-level request on
 * the API tree (never the embed tree), so the binding cookie is issued in that recipe even when
 * `begin` was called from a framed page.
 */
function oidcCookieMode(c: Context<AppEnv>): CookieMode {
  const basePath = publicBaseOf(c);
  return cookieModeFor({ embed: false, ...(basePath ? { basePath } : {}) });
}

/*
 * `Clear-Site-Data` on sign-out (F-25, ASVS 14.3.1): drop cached responses and web storage the
 * signed-in user left behind. Not `"cookies"`: that would also delete the long-lived device
 * cookie (every next login would look like a new device) and, in the embed iframe, is not
 * needed because the session cookie is already cleared by name. Not sent on a path-mounted
 * install: the header is origin-wide, and there the origin belongs to the host site too.
 */
function clearSiteData(c: Context<AppEnv>, mode: CookieMode): void {
  if (!isPathScopedMode(mode)) c.header("Clear-Site-Data", '"cache", "storage"');
}

function loginContext(c: Context<AppEnv>, deps: ApiDeps, rememberDevice: boolean): LoginContext {
  const ws = c.get("workspace");
  const mode = cookieModeOf(c);
  return {
    workspaceId: ws?.id,
    workspaceName: ws?.name,
    ip: clientIp(c, deps.trustProxy),
    userAgent: c.req.header("user-agent")?.slice(0, 512),
    embed: c.get("embed") === true,
    // `session.top_site` stays null for now, including on a framed login. The obvious source is
    // the `Origin` header, and it is wrong: the framed SPA fetches its own API same-origin, so
    // that header carries the *portal's* origin, not the embedding site's — the one fact the
    // column exists to record. Before E2.2 the flag never fired on an API request and the column
    // was always null; now that it does fire, filling it with a known-wrong value would be worse
    // than leaving it empty, because a diagnostics field nobody can trust costs more than one
    // that is absent. The embedding origin is knowable only at the embed *document* request
    // (its `Referer`, which `checkEmbedInitiator` already reads) or from the child over the
    // bridge; carrying either down to the login call is deferred with the rest of the top-site
    // telemetry.
    topSite: undefined,
    deviceToken: readDeviceCookie(c, mode),
    rememberDevice,
    // The session this browser already holds (resolved from its cookie, so never a client-chosen
    // id) ends when the new one is issued (F-12, ASVS 7.2.4).
    replacesSessionId: c.get("session")?.sessionId,
  };
}

function finishLogin(c: Context<AppEnv>, result: LoginResult, rememberDevice: boolean) {
  const mode = cookieModeOf(c);
  const maxAgeSeconds = rememberDevice
    ? Math.max(60, Math.floor((result.session.absoluteExpiresAt.getTime() - Date.now()) / 1000))
    : undefined;
  issueSessionCookies(c, {
    token: result.token,
    deviceToken: result.deviceToken,
    mode,
    basePath: cookieBasePathOf(c),
    maxAgeSeconds,
  });
  return c.json(loginBody(result), 200);
}

/*
 * Step-up rotates the session token (F-12, ASVS 7.2.4): the identity kernel hands back the new
 * one and the cookie is re-issued here, in the same recipe (`__Host-`, the embed's partitioned
 * cookie, or the path-mounted `__Secure-`) the request came in with. Persistent only where the
 * login's cookie was (a remembered device), as at sign-in.
 */
function reissueSession(c: Context<AppEnv>, r: StepUpResult | undefined): void {
  // No token: a concurrent step-up on this session rotated it first (R1-04) and its response
  // carries the live cookie; overwriting it here could leave the browser with a dead one.
  if (r?.token === undefined) return;
  const maxAgeSeconds =
    r.persistUntil === undefined
      ? undefined
      : Math.max(60, Math.floor((r.persistUntil.getTime() - Date.now()) / 1000));
  issueSessionCookies(c, {
    token: r.token,
    mode: cookieModeOf(c),
    basePath: cookieBasePathOf(c),
    maxAgeSeconds,
  });
}

/** What the security notice and the "sign out the others" step need from the request (P2-01). */
function factorContext(c: Context<AppEnv>): FactorChangeContext {
  const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
  const ws = c.get("workspace");
  return {
    sessionId: s.sessionId,
    workspaceId: ws?.id,
    workspaceName: ws?.name,
    userAgent: c.req.header("user-agent")?.slice(0, 512),
  };
}

/*
 * Managing sign-in factors (P2-01). Freshness alone is not enough: an email code is a fresh proof,
 * so whoever reads the mailbox could remove the authenticator app and enrol their own, and walk
 * away with a level-2 session. Once the user holds a second factor (a confirmed authenticator app
 * or any passkey), every change to their factors — adding, removing, replacing, new recovery
 * codes, the password — needs a level-2 session, i.e. a proof with a factor they already have.
 * Enrolling the *first* second factor from a level-1 session stays possible (onboarding); a
 * password is not a second factor. Lost every factor? Recovery codes, or the operator CLI.
 * A step-up with a passkey that did no user verification (a security key without a PIN) also
 * counts here (E2.10 R1-05), though it leaves the session at level 1: it proves possession of
 * an enrolled factor, and a user whose only factor is such a key would otherwise be locked out
 * of their own factors for good. See `AuthService.canManageFactors`.
 */
function requireFactorProof(deps: ApiDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get("session");
    if (s === undefined) throw new ApiError("unauthenticated", "sign in to continue");
    if (!(await deps.auth.canManageFactors(s))) {
      throw new ApiError(
        "step_up_required",
        "confirm it's you with your authenticator app or a passkey",
        { reason: "level", requiredLevel: 2, currentLevel: s.authLevel },
      );
    }
    await next();
  };
}

/*
 * Ending *other* sessions needs a fresh proof (F-26, ASVS 7.5.2): a stolen session cookie must
 * not be able to sign the rightful owner out everywhere and keep itself. Ending the session the
 * request itself carries is signing out, which never asks for anything.
 */
function requireFreshUnlessCurrent(): MiddlewareHandler<AppEnv> {
  const fresh = requireFreshAuth();
  return async (c, next) => {
    if (c.req.param("id") === c.get("session")?.sessionId) return next();
    return fresh(c, next);
  };
}

const AUTH_ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const tagAuth = ["auth"];
const tagAccount = ["account"];

export function registerAuthRoutes(api: Api, deps: ApiDeps): void {
  const factorProof = requireFactorProof(deps);
  // --- email OTP -----------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/otp/start",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Send a sign-in code",
      description: "Responds identically whether or not the email is known.",
      request: { body: jsonBody(k.OtpStartBody) },
      responses: {
        200: jsonResponse(k.OtpStartResponse, "Code sent (or silently not sent)"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const { email } = c.req.valid("json");
      const ws = c.get("workspace");
      const r = await deps.auth.emailOtp.start({
        email,
        ip: clientIp(c, deps.trustProxy),
        workspaceId: ws?.id,
        workspaceName: ws?.name,
      });
      return c.json({ status: r.status, emailHint: r.emailHint, ttlMinutes: r.ttlMinutes }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/otp/verify",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Verify a sign-in code and start a session",
      request: { body: jsonBody(k.OtpVerifyBody) },
      responses: {
        200: jsonResponse(k.LoginResponse, "Signed in; session cookie set"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const r = await deps.auth.emailOtp.verify({
        email: body.email,
        code: body.code,
        ...loginContext(c, deps, body.rememberDevice),
      });
      return finishLogin(c, r, body.rememberDevice);
    },
  );

  // --- magic link ----------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/magic-link/start",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Send a magic link (with a code fallback)",
      request: { body: jsonBody(k.MagicLinkStartBody) },
      responses: {
        200: jsonResponse(
          k.MagicLinkStartResponse,
          "Link sent (or silently not sent); binding cookie set",
        ),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      if (!deps.magicLinkEnabled)
        throw new ApiError("unsupported", "magic links are disabled on this install");
      const { email } = c.req.valid("json");
      const ws = c.get("workspace");
      const r = await deps.auth.magicLink.start({
        email,
        ip: clientIp(c, deps.trustProxy),
        userAgent: c.req.header("user-agent")?.slice(0, 512),
        workspaceId: ws?.id,
        workspaceName: ws?.name,
      });
      issueAuthRequestCookie(c, {
        bindingToken: r.bindingToken,
        maxAgeSeconds: r.bindingMaxAgeSeconds,
        mode: cookieModeOf(c),
        basePath: cookieBasePathOf(c),
      });
      return c.json({ status: r.status, emailHint: r.emailHint, ttlMinutes: r.ttlMinutes }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/auth/magic-link/peek",
      "x-requires": "public",
      tags: tagAuth,
      summary: "What the confirm page may show before the button is pressed",
      request: { query: k.MagicLinkPeekQuery },
      responses: {
        200: jsonResponse(k.MagicLinkPeekResponse, "Never consumes the link"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const { token } = c.req.valid("query");
      const r = await deps.auth.magicLink.peek(token);
      return c.json(
        {
          valid: r.valid,
          ...(r.emailHint === undefined ? {} : { emailHint: r.emailHint }),
          ...(r.requestedFrom === undefined ? {} : { requestedFrom: r.requestedFrom }),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/magic-link/confirm",
      "x-requires": "public",
      tags: tagAuth,
      summary: "POST-to-confirm a magic link",
      description:
        "`binding_mismatch` (409) means the link was opened in a different browser; the emailed code still works via `/auth/otp/verify`.",
      request: { body: jsonBody(k.MagicLinkConfirmBody) },
      responses: {
        200: jsonResponse(k.LoginResponse, "Signed in; session cookie set"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const mode = cookieModeOf(c);
      const r = await deps.auth.magicLink.confirm({
        token: body.token,
        bindingToken: readAuthRequestCookie(c, mode),
        ...loginContext(c, deps, body.rememberDevice),
      });
      return finishLogin(c, r, body.rememberDevice);
    },
  );

  // --- passkeys ------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/passkeys/login/begin",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Begin a discoverable passkey sign-in",
      responses: {
        200: jsonResponse(k.PasskeyAuthenticationBegin, "WebAuthn request options"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      refusePasskeysOnCustomDomain(c);
      refusePasskeysOffRpOrigin(c);
      const r = await deps.auth.passkeys.beginAuthentication({ ip: clientIp(c, deps.trustProxy) });
      return c.json(
        { challengeId: r.challengeId, options: r.options as unknown as Record<string, unknown> },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/passkeys/login/finish",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Finish a passkey sign-in and start a session",
      request: { body: jsonBody(k.PasskeyAuthenticationFinishBody) },
      responses: {
        200: jsonResponse(k.LoginResponse, "Signed in; session cookie set"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      refusePasskeysOnCustomDomain(c);
      refusePasskeysOffRpOrigin(c);
      const body = c.req.valid("json");
      const r = await deps.auth.passkeys.finishAuthentication({
        challengeId: body.challengeId,
        response: body.response as never,
        ...loginContext(c, deps, body.rememberDevice),
      });
      return finishLogin(c, r, body.rememberDevice);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/passkeys/step-up/finish",
      "x-requires": "session",
      tags: tagAuth,
      summary: "Re-prove possession of a passkey on the current session (step-up)",
      description:
        "Rotates the session token: the response sets a new session cookie and the old value stops working.",
      security: sessionSecurity,
      middleware: [requireSession()] as const,
      request: {
        body: jsonBody(
          k.PasskeyAuthenticationFinishBody.pick({ challengeId: true, response: true }),
        ),
      },
      responses: {
        200: jsonResponse(OkSchema, "Session auth time refreshed at level 2"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      refusePasskeysOnCustomDomain(c);
      refusePasskeysOffRpOrigin(c);
      const body = c.req.valid("json");
      const r = await deps.auth.passkeys.finishStepUp({
        challengeId: body.challengeId,
        response: body.response as never,
        sessionId: s.sessionId,
        userId: s.userId,
        presentedToken: c.get("sessionToken"),
      });
      reissueSession(c, r);
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/passkeys/register/begin",
      "x-requires": "session+fresh",
      tags: tagAccount,
      summary: "Begin registering a passkey for the signed-in user",
      description:
        "When the user already has a second factor (authenticator app or passkey), a level-2 session is required.",
      security: sessionSecurity,
      middleware: [requireSession(), factorProof, requireFreshAuth()] as const,
      responses: {
        200: jsonResponse(k.PasskeyRegistrationBegin, "WebAuthn creation options"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      refusePasskeysOnCustomDomain(c);
      refusePasskeysOffRpOrigin(c);
      const r = await deps.auth.passkeys.beginRegistration({ userId: s.userId });
      return c.json(
        { challengeId: r.challengeId, options: r.options as unknown as Record<string, unknown> },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/passkeys/register/finish",
      "x-requires": "session",
      tags: tagAccount,
      summary: "Finish registering a passkey",
      description:
        "Signs out the user's other sessions and emails a security notice. Level 2 is required when the user already has a second factor. When the authenticator verified the user (UV), steps the session up to level 2 and rotates its token (new session cookie); `authLevel` is the session's level after the call.",
      security: sessionSecurity,
      middleware: [requireSession(), factorProof] as const,
      request: { body: jsonBody(k.PasskeyRegistrationFinishBody) },
      responses: {
        200: jsonResponse(k.PasskeyRegisteredSchema, "The new passkey and the session's level"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      refusePasskeysOnCustomDomain(c);
      refusePasskeysOffRpOrigin(c);
      const body = c.req.valid("json");
      const { userVerified, ...p } = await deps.auth.passkeys.finishRegistration({
        userId: s.userId,
        challengeId: body.challengeId,
        response: body.response as never,
        label: body.label,
        context: factorContext(c),
      });
      // E-UP-18 (D2): a user-verified passkey is a second factor proved just now, as the first
      // TOTP code is at enrolment — step up and rotate the token the same way. A non-UV key
      // registers but proves nothing beyond possession, so the level stays as it was.
      if (userVerified) {
        reissueSession(
          c,
          await deps.auth.sessions.stepUp(s.sessionId, 2, "passkey_registration", {
            presentedToken: c.get("sessionToken"),
          }),
        );
      }
      return c.json(
        {
          ...p,
          authLevel: userVerified ? 2 : s.authLevel,
          createdAt: p.createdAt.toISOString(),
          lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
          transports: [...p.transports],
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/auth/passkeys",
      "x-requires": "session",
      tags: tagAccount,
      summary: "List the signed-in user's passkeys",
      security: sessionSecurity,
      middleware: [requireSession(), refuseSsoBoundSession()] as const,
      responses: {
        200: jsonResponse(
          z.object({ passkeys: z.array(k.PasskeySummarySchema) }).openapi("PasskeyList"),
          "Passkeys",
        ),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const list = await deps.auth.passkeys.list(s.userId);
      return c.json(
        {
          passkeys: list.map((p) => ({
            ...p,
            createdAt: p.createdAt.toISOString(),
            lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
            transports: [...p.transports],
          })),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/auth/passkeys/{id}",
      "x-requires": "session",
      tags: tagAccount,
      summary: "Rename a passkey",
      security: sessionSecurity,
      middleware: [requireSession(), refuseSsoBoundSession()] as const,
      request: { params: k.IdParam, body: jsonBody(k.PasskeyRenameBody) },
      responses: { 200: jsonResponse(OkSchema, "Renamed"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const ok = await deps.auth.passkeys.rename(
        s.userId,
        c.req.valid("param").id,
        c.req.valid("json").label,
      );
      if (!ok) throw new ApiError("credential_not_found");
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/auth/passkeys/{id}",
      "x-requires": "session+fresh",
      tags: tagAccount,
      summary: "Remove a passkey",
      description:
        "Needs a level-2 session (the user has a second factor). Signs out the user's other sessions and emails a security notice.",
      security: sessionSecurity,
      middleware: [requireSession(), factorProof, requireFreshAuth()] as const,
      request: { params: k.IdParam },
      responses: { 200: jsonResponse(OkSchema, "Removed"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const ok = await deps.auth.passkeys.remove(
        s.userId,
        c.req.valid("param").id,
        factorContext(c),
      );
      if (!ok) throw new ApiError("credential_not_found");
      return c.json({ ok: true as const }, 200);
    },
  );

  // --- TOTP ----------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/auth/totp",
      "x-requires": "session",
      tags: tagAccount,
      summary: "TOTP enrolment status",
      security: sessionSecurity,
      middleware: [requireSession(), refuseSsoBoundSession()] as const,
      responses: { 200: jsonResponse(k.TotpStatusSchema, "Status"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      return c.json(await deps.auth.totp.status(s.userId), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/totp/enrol",
      "x-requires": "session+fresh",
      tags: tagAccount,
      summary: "Begin TOTP enrolment (returns the secret once)",
      description:
        "When the user already has a passkey, a level-2 session is required: only the first second factor may be enrolled from a level-1 session.",
      security: sessionSecurity,
      middleware: [requireSession(), factorProof, requireFreshAuth()] as const,
      responses: {
        200: jsonResponse(k.TotpEnrolmentSchema, "Pending until the first valid code"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      return c.json(await deps.auth.totp.beginEnrolment({ userId: s.userId }), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/totp/enrol/confirm",
      "x-requires": "session",
      tags: tagAccount,
      summary: "Confirm TOTP enrolment with the first code; returns recovery codes once",
      description:
        "Steps the session up to level 2 and rotates its token (new session cookie). Signs out the user's other sessions and emails a security notice.",
      security: sessionSecurity,
      middleware: [requireSession(), factorProof] as const,
      request: { body: jsonBody(k.TotpCodeBody) },
      responses: { 200: jsonResponse(k.RecoveryCodesSchema, "Enrolled"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const r = await deps.auth.totp.confirmEnrolment({
        userId: s.userId,
        code: c.req.valid("json").code,
        context: factorContext(c),
      });
      reissueSession(
        c,
        await deps.auth.sessions.stepUp(s.sessionId, 2, "totp_enrolment", {
          presentedToken: c.get("sessionToken"),
        }),
      );
      return c.json({ recoveryCodes: [...r.recoveryCodes] }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/totp/verify",
      "x-requires": "session",
      tags: tagAuth,
      summary: "Verify a TOTP code on the current session (step-up to level 2)",
      description:
        "Rotates the session token: the response sets a new session cookie and the old value stops working.",
      security: sessionSecurity,
      middleware: [requireSession()] as const,
      request: { body: jsonBody(k.TotpCodeBody) },
      responses: { 200: jsonResponse(OkSchema, "Verified"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const r = await deps.auth.totp.verify({
        userId: s.userId,
        code: c.req.valid("json").code,
        sessionId: s.sessionId,
        presentedToken: c.get("sessionToken"),
        // E3.8 FR2 (M2): a bound session's attempts never spend the user's global budget.
        sso: s.sso,
        boundWorkspaceId: s.boundWorkspaceId,
        ip: clientIp(c, deps.trustProxy),
      });
      reissueSession(c, r);
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/totp/recovery",
      "x-requires": "session",
      tags: tagAuth,
      summary: "Use a recovery code instead of a TOTP code",
      description: "Steps the session up to level 2 and rotates its token (new session cookie).",
      security: sessionSecurity,
      middleware: [requireSession()] as const,
      request: { body: jsonBody(k.RecoveryCodeBody) },
      responses: {
        200: jsonResponse(k.RecoveryRemainingSchema, "Accepted; codes left"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const r = await deps.auth.totp.verifyRecoveryCode({
        userId: s.userId,
        code: c.req.valid("json").code,
        sessionId: s.sessionId,
        presentedToken: c.get("sessionToken"),
        // E3.8 FR2 (M2): a bound session's attempts never spend the user's global budget.
        sso: s.sso,
        boundWorkspaceId: s.boundWorkspaceId,
        ip: clientIp(c, deps.trustProxy),
      });
      reissueSession(c, r.stepUp);
      return c.json({ remaining: r.remaining }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/totp/recovery-codes",
      "x-requires": "session+fresh",
      tags: tagAccount,
      summary: "Regenerate recovery codes (invalidates the old set)",
      description:
        "Needs a level-2 session. Signs out the user's other sessions and emails a security notice.",
      security: sessionSecurity,
      middleware: [requireSession(), factorProof, requireFreshAuth()] as const,
      responses: {
        200: jsonResponse(k.RecoveryCodesSchema, "New codes, shown once"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const r = await deps.auth.totp.regenerateRecoveryCodes({
        userId: s.userId,
        context: factorContext(c),
      });
      return c.json({ recoveryCodes: [...r.recoveryCodes] }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/auth/totp",
      "x-requires": "session+fresh",
      tags: tagAccount,
      summary: "Disable TOTP",
      description:
        "Needs a level-2 session (the user has a second factor). Signs out the user's other sessions and emails a security notice.",
      security: sessionSecurity,
      middleware: [requireSession(), factorProof, requireFreshAuth()] as const,
      responses: { 200: jsonResponse(OkSchema, "Disabled"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      await deps.auth.totp.disable({ userId: s.userId, context: factorContext(c) });
      return c.json({ ok: true as const }, 200);
    },
  );

  // --- password ------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/auth/password",
      "x-requires": "session",
      tags: tagAccount,
      summary: "Whether password login is enabled and set for the signed-in user",
      security: sessionSecurity,
      middleware: [requireSession(), refuseSsoBoundSession()] as const,
      responses: { 200: jsonResponse(k.PasswordStatusSchema, "Status"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const set = deps.passwordEnabled ? await deps.auth.password.has(s.userId) : false;
      return c.json({ enabled: deps.passwordEnabled, set }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/password/login",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Sign in with email and password (off unless AUTH_PASSWORD_ENABLED)",
      request: { body: jsonBody(k.PasswordLoginBody) },
      responses: {
        200: jsonResponse(k.LoginResponse, "Signed in; session cookie set"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const r = await deps.auth.password.login({
        email: body.email,
        password: body.password,
        ...loginContext(c, deps, body.rememberDevice),
      });
      return finishLogin(c, r, body.rememberDevice);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/auth/password",
      "x-requires": "session+fresh",
      tags: tagAccount,
      summary: "Set or replace the password (signs out other sessions)",
      description:
        "Replacing an existing password needs `currentPassword`. When the user has a second factor, a level-2 session is required. Emails a security notice.",
      security: sessionSecurity,
      middleware: [requireSession(), factorProof, requireFreshAuth()] as const,
      request: { body: jsonBody(k.PasswordSetBody) },
      responses: { 200: jsonResponse(OkSchema, "Set"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const body = c.req.valid("json");
      await deps.auth.password.set({
        userId: s.userId,
        password: body.password,
        currentPassword: body.currentPassword,
        keepSessionId: s.sessionId,
        context: factorContext(c),
      });
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/password/reverify",
      "x-requires": "session",
      tags: tagAuth,
      summary: "Re-enter the password to refresh step-up freshness",
      description:
        "Rotates the session token: the response sets a new session cookie and the old value stops working.",
      security: sessionSecurity,
      middleware: [requireSession()] as const,
      request: { body: jsonBody(k.PasswordReverifyBody) },
      responses: { 200: jsonResponse(OkSchema, "Refreshed"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const r = await deps.auth.password.reverify({
        userId: s.userId,
        password: c.req.valid("json").password,
        sessionId: s.sessionId,
        presentedToken: c.get("sessionToken"),
        // E3.8 FR2 (M2): a bound session's attempts never spend the user's global budget.
        sso: s.sso,
        boundWorkspaceId: s.boundWorkspaceId,
      });
      reissueSession(c, r);
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/auth/password",
      "x-requires": "session+fresh",
      tags: tagAccount,
      summary: "Remove the password",
      description:
        "Needs `currentPassword` unless the session is level 2 (otherwise an email code alone could remove the password and set a new one with nothing to check). When the user has a second factor, a level-2 session is required. A user with no password gets 200 and nothing happens. Signs out the user's other sessions and emails a security notice.",
      security: sessionSecurity,
      middleware: [requireSession(), factorProof, requireFreshAuth()] as const,
      request: {
        body: {
          required: false,
          content: { "application/json": { schema: k.PasswordRemoveBody.strict() } },
        },
      },
      responses: { 200: jsonResponse(OkSchema, "Removed"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      // Optional body: absent (or not JSON) reads as "no current password given".
      const body = (c.req.valid("json") ?? {}) as { currentPassword?: string };
      await deps.auth.password.remove({
        userId: s.userId,
        currentPassword: body.currentPassword,
        sessionAuthLevel: s.authLevel,
        context: factorContext(c),
      });
      return c.json({ ok: true as const }, 200);
    },
  );

  // --- OIDC ----------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/auth/oidc/providers",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Configured OIDC providers",
      responses: {
        200: jsonResponse(k.OidcProvidersSchema, "Providers (empty when none)"),
        ...AUTH_ERRORS,
      },
    }),
    (c) => c.json({ providers: (deps.auth.oidc?.providerIds ?? []).map((id) => ({ id })) }, 200),
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/oidc/begin",
      "x-requires": "public",
      tags: tagAuth,
      summary: "Begin an OIDC login; returns the provider URL to navigate to",
      request: { body: jsonBody(k.OidcBeginQuery) },
      responses: {
        200: jsonResponse(k.OidcBeginResponse, "Redirect the browser here (top-level)"),
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const oidc = deps.auth.oidc;
      if (!oidc) throw new ApiError("unsupported", "no OIDC provider is configured");
      const body = c.req.valid("json");
      const returnTo = safeReturnPath(body.returnTo, publicBaseOf(c));
      const r = await oidc.begin({
        provider: body.provider,
        // BASE_URL, never the request (E3.9 §2): the one redirect URI registered with the IdP.
        redirectUri: `${canonicalBaseOf(deps.baseUrl)}/api/v1/auth/oidc/callback`,
        returnTo,
        ip: clientIp(c, deps.trustProxy),
        workspaceId: c.get("workspace")?.id,
      });
      // Browser binding (F-03): only the browser that began the login can finish it.
      issueAuthRequestCookie(c, {
        kind: "oidcRequest",
        bindingToken: r.bindingToken,
        maxAgeSeconds: r.bindingMaxAgeSeconds,
        mode: oidcCookieMode(c),
        basePath: cookieBasePathOf(c),
      });
      return c.json({ url: r.url }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/auth/oidc/callback",
      "x-requires": "public",
      tags: tagAuth,
      summary: "OIDC redirect target; completes the login and redirects to `returnTo`",
      request: {
        query: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
      },
      responses: {
        302: {
          description: "Signed in; session cookie set; redirect to the app",
          headers: { Location: { schema: { type: "string" } } },
        },
        ...AUTH_ERRORS,
      },
    }),
    async (c) => {
      const oidc = deps.auth.oidc;
      if (!oidc) throw new ApiError("unsupported", "no OIDC provider is configured");
      const bindingMode = oidcCookieMode(c);
      const r = await oidc.complete({
        // The registered redirect URI (BASE_URL-based, as `begin` sent it) + this query: the token
        // request's `redirect_uri` is derived from it and must match. `c.req.url` is the INTERNAL
        // URL, which behind a path-mount proxy (E3.9) or a TLS-terminating one is not it.
        currentUrl: new URL(
          `${canonicalBaseOf(deps.baseUrl)}/api/v1/auth/oidc/callback${new URL(c.req.url).search}`,
        ),
        bindingToken: readAuthRequestCookie(c, bindingMode, "oidcRequest"),
        ...loginContext(c, deps, false),
      });
      const mode = cookieModeOf(c);
      issueSessionCookies(c, {
        token: r.token,
        deviceToken: r.deviceToken,
        mode,
        basePath: cookieBasePathOf(c),
      });
      clearAuthRequestCookie(c, {
        kind: "oidcRequest",
        mode: bindingMode,
        basePath: cookieBasePathOf(c),
      });
      // Re-validated on the way out as well: the stored value predates this check on a login
      // begun before an upgrade, and a redirect is the sink that matters.
      // Relative to the callback's public face (a mount's prefix when it came through one).
      const base = publicBaseOf(c);
      return c.redirect(`${base}${safeReturnPath(r.returnTo, base) ?? "/"}`, 302);
    },
  );

  // --- sessions & devices --------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/logout",
      "x-requires": "session",
      tags: tagAuth,
      summary: "Sign out of this session",
      security: sessionSecurity,
      middleware: [requireSession()] as const,
      responses: { 200: jsonResponse(OkSchema, "Signed out; cookie cleared"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      await deps.auth.revokeSession(s.sessionId, "logout");
      const mode = cookieModeOf(c);
      clearSessionCookies(c, { mode, basePath: cookieBasePathOf(c) });
      clearSiteData(c, mode);
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/logout-everywhere",
      "x-requires": "session+fresh",
      tags: tagAuth,
      summary: "Sign out of every session on every device",
      description: "Needs a fresh proof (step-up): it ends sessions other than this one (F-26).",
      security: sessionSecurity,
      middleware: [requireSession(), refuseSsoBoundSession(), requireFreshAuth()] as const,
      responses: { 200: jsonResponse(k.RevokedCountSchema, "Sessions revoked"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const revoked = await deps.auth.revokeAllSessions(s.userId, "logout_everywhere");
      const mode = cookieModeOf(c);
      clearSessionCookies(c, { mode, basePath: cookieBasePathOf(c) });
      clearSiteData(c, mode);
      return c.json({ revoked }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/auth/sessions/revoke-by-token",
      "x-requires": "public",
      tags: tagAuth,
      summary: "One-click revoke from the new-device email",
      request: { body: jsonBody(k.RevokeByTokenBody) },
      responses: { 200: jsonResponse(OkSchema, "Revoked (or already gone)"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const ok = await deps.auth.sessions.revokeByToken(c.req.valid("json").token);
      if (!ok) throw new ApiError("expired", "this link has already been used or has expired");
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/me/sessions",
      "x-requires": "session",
      tags: tagAccount,
      summary: "Active sessions of the signed-in user",
      security: sessionSecurity,
      middleware: [requireSession(), refuseSsoBoundSession()] as const,
      responses: { 200: jsonResponse(k.SessionListSchema, "Sessions"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const list = await deps.auth.sessions.listSessions(s.userId, s.sessionId);
      return c.json({ sessions: list.map(sessionSummaryBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/me/sessions/{id}",
      "x-requires": "session+fresh",
      tags: tagAccount,
      summary: "Revoke one of the signed-in user's sessions",
      description:
        "Revoking another session needs a fresh proof (step-up, F-26); revoking the current one is signing out and does not.",
      security: sessionSecurity,
      middleware: [
        requireSession(),
        refuseSsoBoundSession({ allowCurrentSession: true }),
        requireFreshUnlessCurrent(),
      ] as const,
      request: { params: k.IdParam },
      responses: { 200: jsonResponse(OkSchema, "Revoked"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const { id } = c.req.valid("param");
      const mine = (await deps.auth.sessions.listSessions(s.userId, s.sessionId)).some(
        (x) => x.id === id,
      );
      if (!mine) throw new ApiError("not_found", "no such session");
      await deps.auth.revokeSession(id, id === s.sessionId ? "logout" : "admin");
      if (id === s.sessionId) {
        const mode = cookieModeOf(c);
        clearSessionCookies(c, { mode, basePath: cookieBasePathOf(c) });
        clearSiteData(c, mode);
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/me/devices",
      "x-requires": "session",
      tags: tagAccount,
      summary: "Known devices of the signed-in user",
      security: sessionSecurity,
      middleware: [requireSession(), refuseSsoBoundSession()] as const,
      responses: { 200: jsonResponse(k.DeviceListSchema, "Devices"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      return c.json(
        { devices: (await deps.auth.sessions.listDevices(s.userId)).map(deviceBody) },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/me/devices/{id}",
      "x-requires": "session",
      tags: tagAccount,
      summary: "Rename a device",
      security: sessionSecurity,
      middleware: [requireSession(), refuseSsoBoundSession()] as const,
      request: { params: k.IdParam, body: jsonBody(k.DeviceRenameBody) },
      responses: { 200: jsonResponse(OkSchema, "Renamed"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const ok = await deps.auth.sessions.renameDevice(
        s.userId,
        c.req.valid("param").id,
        c.req.valid("json").name,
      );
      if (!ok) throw new ApiError("not_found", "no such device");
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/me/devices/{id}",
      "x-requires": "session+fresh",
      tags: tagAccount,
      summary: "Forget a device and revoke its sessions",
      description: "Needs a fresh proof (step-up): it ends that device's sessions (F-26).",
      security: sessionSecurity,
      middleware: [requireSession(), refuseSsoBoundSession(), requireFreshAuth()] as const,
      request: { params: k.IdParam },
      responses: { 200: jsonResponse(OkSchema, "Revoked"), ...AUTH_ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const ok = await deps.auth.sessions.revokeDevice(s.userId, c.req.valid("param").id);
      if (!ok) throw new ApiError("not_found", "no such device");
      return c.json({ ok: true as const }, 200);
    },
  );
}
