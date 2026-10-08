import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  kernel as k,
  OkSchema,
  type OpenAPIHono,
  platform as p,
} from "@fundroom/contracts";
import {
  type EnrolSession,
  endEnrolSession,
  enrolSessionMayAddFactor,
  OPERATOR_ENROL_SESSION_TTL_MS,
  OperatorEnrolError,
  resolveEnrolSession,
  startEnrolment,
  verifyEnrolment,
} from "@fundroom/control-plane";
import { parseCookies } from "@fundroom/identity";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { platformSurfaceReachable } from "../middleware/platform.js";
import { cookieBasePathOf } from "../path-mount.js";
import { type ApiDeps, clientIp } from "./deps.js";

/*
 * A new operator's enrolment (E3.10 fix round 2): `/api/v1/platform/enrol/*` on the canonical
 * host. See `@fundroom/control-plane` `operators/enrol.ts` for the flow: the CLI prints a
 * single-use link token, `start` emails a code to the address it was minted for, `verify` opens a
 * 15-minute ENROLMENT-ONLY session (cookie `__Host-op_enrol`, SameSite=Strict) that these routes
 * alone accept — begin/confirm an authenticator, begin/finish a passkey — and that ends as soon as
 * one factor is added. Then `fundroom operator grant`.
 *
 * Matrix rows are `public` (no user session exists yet); the enrolment cookie is checked in the
 * handlers. Off the canonical host, with CONTROL_PLANE=off or outside PLATFORM_OPERATOR_CIDRS,
 * everything is the plain 404 of the operator surface.
 */

type Api = OpenAPIHono<AppEnv>;

const TAGS = ["platform"];
const ERRORS = errorResponses(400, 404, 409, 429, 500, 503);

const ENROL_COOKIE_BASENAME = "op_enrol";

function enrolCookieName(c: Context<AppEnv>): string {
  return cookieBasePathOf(c) === undefined
    ? `__Host-${ENROL_COOKIE_BASENAME}`
    : `__Secure-${ENROL_COOKIE_BASENAME}`;
}

function enrolCookieAttributes(c: Context<AppEnv>): string {
  return `Path=${cookieBasePathOf(c) ?? "/"}; Secure; HttpOnly; SameSite=Strict`;
}

function issueEnrolCookie(c: Context<AppEnv>, token: string): void {
  c.header(
    "Set-Cookie",
    `${enrolCookieName(c)}=${token}; ${enrolCookieAttributes(c)}; Max-Age=${OPERATOR_ENROL_SESSION_TTL_MS / 1000}`,
    { append: true },
  );
}

function clearEnrolCookie(c: Context<AppEnv>): void {
  c.header("Set-Cookie", `${enrolCookieName(c)}=; ${enrolCookieAttributes(c)}; Max-Age=0`, {
    append: true,
  });
}

function requireReachable(c: Context<AppEnv>, deps: ApiDeps): void {
  if (!platformSurfaceReachable(c, deps)) throw new ApiError("not_found", "no such path");
}

function toApiError(error: unknown): unknown {
  if (!(error instanceof OperatorEnrolError)) return error;
  switch (error.code) {
    case "rate_limited": {
      const retryAfterMs = error.retryAfterMs ?? 60_000;
      return new ApiError(
        "rate_limited",
        error.message,
        { retryAfterMs },
        { headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } },
      );
    }
    case "invalid_code":
      return new ApiError("invalid_code", error.message);
    case "already_enrolled":
      return new ApiError("conflict", error.message, { reason: "already_enrolled" });
    case "invalid_request":
      return new ApiError("validation_failed", error.message, { field: "email" });
  }
}

export function registerPlatformEnrolRoutes(api: Api, deps: ApiDeps): void {
  const enrol = () => deps.controlPlane.operators.enrol;

  /** The live enrolment session of this browser, or a plain 404. */
  async function enrolSessionOf(c: Context<AppEnv>): Promise<EnrolSession> {
    requireReachable(c, deps);
    const token = parseCookies(c.req.header("cookie")).get(enrolCookieName(c));
    const session = token === undefined ? undefined : await resolveEnrolSession(enrol(), token);
    if (session === undefined) throw new ApiError("not_found", "no enrolment in progress");
    return session;
  }

  /** The one thing the session may do: add the FIRST factor (a second is a normal step-up act). */
  async function mayAddFactor(session: EnrolSession): Promise<void> {
    if (!(await enrolSessionMayAddFactor(enrol(), session))) {
      throw new ApiError("conflict", "a factor is already enrolled", {
        reason: "already_enrolled",
      });
    }
  }

  const factorContext = (c: Context<AppEnv>) => ({
    userAgent: c.req.header("user-agent")?.slice(0, 512),
  });

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/enrol/start",
      tags: TAGS,
      summary: "New operator: email a code to the enrolment link's address",
      description:
        "Answers `{ ok: true }` after a constant floor whatever the token or address (no oracle); a code is sent only when the token is live and was minted for exactly that address. 429 past the per-IP budget.",
      "x-requires": "public",
      request: { body: jsonBody(p.PlatformEnrolStartBody) },
      responses: { 200: jsonResponse(OkSchema, "Code sent (or silently not sent)"), ...ERRORS },
    }),
    async (c) => {
      requireReachable(c, deps);
      const body = c.req.valid("json");
      try {
        await startEnrolment(enrol(), {
          token: body.token,
          email: body.email,
          ip: clientIp(c, deps.trustProxy),
        });
      } catch (error) {
        throw toApiError(error);
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/enrol/verify",
      tags: TAGS,
      summary: "New operator: token + address + code → a 15-minute enrolment-only session",
      description:
        "Spends the link, creates the account if the address has none and sets `__Host-op_enrol`, which only the `/platform/enrol/*` routes accept. 400 `invalid_code` for any wrong part; 409 `conflict` (`already_enrolled`) when the account already holds a second factor.",
      "x-requires": "public",
      request: { body: jsonBody(p.PlatformEnrolVerifyBody) },
      responses: { 200: jsonResponse(p.PlatformEnrolSessionSchema, "Enrolling"), ...ERRORS },
    }),
    async (c) => {
      requireReachable(c, deps);
      const body = c.req.valid("json");
      let done: Awaited<ReturnType<typeof verifyEnrolment>>;
      try {
        done = await verifyEnrolment(enrol(), {
          token: body.token,
          email: body.email,
          code: body.code,
          ip: clientIp(c, deps.trustProxy),
        });
      } catch (error) {
        throw toApiError(error);
      }
      issueEnrolCookie(c, done.sessionToken);
      return c.json(
        { email: done.session.email, expiresAt: done.session.expiresAt.toISOString() },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/enrol/session",
      tags: TAGS,
      summary: "New operator: the enrolment session in progress",
      "x-requires": "public",
      responses: { 200: jsonResponse(p.PlatformEnrolSessionSchema, "Enrolling"), ...ERRORS },
    }),
    async (c) => {
      const s = await enrolSessionOf(c);
      return c.json({ email: s.email, expiresAt: s.expiresAt.toISOString() }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/platform/enrol/session",
      tags: TAGS,
      summary: "New operator: end the enrolment session",
      "x-requires": "public",
      responses: { 204: { description: "Ended" }, ...ERRORS },
    }),
    async (c) => {
      const s = await enrolSessionOf(c);
      await endEnrolSession(enrol(), s, "signed_out");
      clearEnrolCookie(c);
      return c.body(null, 204);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/enrol/totp",
      tags: TAGS,
      summary: "New operator: begin authenticator enrolment (returns the secret once)",
      "x-requires": "public",
      responses: {
        200: jsonResponse(k.TotpEnrolmentSchema, "Pending until the first valid code"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const s = await enrolSessionOf(c);
      await mayAddFactor(s);
      return c.json(await deps.auth.totp.beginEnrolment({ userId: s.userId }), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/enrol/totp/confirm",
      tags: TAGS,
      summary: "New operator: confirm the authenticator; returns recovery codes once",
      description: "Ends the enrolment session.",
      "x-requires": "public",
      request: { body: jsonBody(k.TotpCodeBody) },
      responses: { 200: jsonResponse(k.RecoveryCodesSchema, "Enrolled"), ...ERRORS },
    }),
    async (c) => {
      const s = await enrolSessionOf(c);
      await mayAddFactor(s);
      const r = await deps.auth.totp.confirmEnrolment({
        userId: s.userId,
        code: c.req.valid("json").code,
        context: factorContext(c),
      });
      await endEnrolSession(enrol(), s, "factor_added", "totp");
      clearEnrolCookie(c);
      return c.json({ recoveryCodes: [...r.recoveryCodes] }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/enrol/passkey/begin",
      tags: TAGS,
      summary: "New operator: begin registering a passkey",
      "x-requires": "public",
      responses: {
        200: jsonResponse(k.PasskeyRegistrationBegin, "WebAuthn creation options"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const s = await enrolSessionOf(c);
      await mayAddFactor(s);
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
      path: "/platform/enrol/passkey/finish",
      tags: TAGS,
      summary: "New operator: finish registering a passkey",
      description: "Ends the enrolment session.",
      "x-requires": "public",
      request: { body: jsonBody(k.PasskeyRegistrationFinishBody) },
      responses: { 200: jsonResponse(k.PasskeySummarySchema, "The new passkey"), ...ERRORS },
    }),
    async (c) => {
      const s = await enrolSessionOf(c);
      await mayAddFactor(s);
      const body = c.req.valid("json");
      // Operator enrolment never steps a session up (it ends one): drop the UV flag (E-UP-18).
      const { userVerified: _userVerified, ...pk } = await deps.auth.passkeys.finishRegistration({
        userId: s.userId,
        challengeId: body.challengeId,
        response: body.response as never,
        label: body.label,
        context: factorContext(c),
      });
      await endEnrolSession(enrol(), s, "factor_added", "passkey");
      clearEnrolCookie(c);
      return c.json(
        {
          ...pk,
          createdAt: pk.createdAt.toISOString(),
          lastUsedAt: pk.lastUsedAt?.toISOString() ?? null,
          transports: [...pk.transports],
        },
        200,
      );
    },
  );
}
