import { isIPv6 } from "node:net";
import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  signup as s,
} from "@fundroom/contracts";
import {
  listSignupPlans,
  SIGNUP_RATES,
  SignupError,
  signupNetworkKey,
  signupSlugAvailable,
  startSignup,
  verifySignup,
} from "@fundroom/control-plane";
import { systemContext } from "@fundroom/db";
import { sha256 } from "@fundroom/identity";
import { issueSessionCookies, readDeviceCookie } from "@fundroom/identity/http";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { cookieModeOf } from "../middleware/auth.js";
import { cookieBasePathOf } from "../path-mount.js";
import { type ApiDeps, clientIp, workspaceUrl } from "./deps.js";

/*
 * Self-service signup (E3.10, ADR-0058; owner: agent A): `/api/v1/signup/*` on the canonical host
 * with no workspace, SIGNUP_MODE=open only (plain 404 otherwise). `start` answers `{ ok: true }`
 * after a constant 250 ms floor whatever the email is and never returns an id; `verify` creates
 * the workspace through `provisionWorkspace` and never says whether the email already had an
 * account. Budgets: `SIGNUP_BUDGETS` in `@fundroom/control-plane` (per address / IP / network
 * first, then the install ceiling).
 *
 * `verify` signs the new owner in on the canonical host (level 1, like an email-code sign-in) and
 * answers the workspace's own address, built from BASE_URL (`<slug>.<canonical>` or `/w/<slug>` —
 * never a custom domain, which a new workspace cannot have anyway). The browser goes there next;
 * with central auth on, the canonical session hands off. A-5: the address is `/admin/billing?plan=<id>`
 * when the plan needs a subscription before anything else (public, priced, no trial, and
 * BILLING_DRIVER=stripe so the owner can subscribe), else `/setup`.
 * `GET /signup/plans` is the public catalogue the applicant chooses from (public, unarchived;
 * no prices — the product stores only the provider's price ids).
 */

type Api = OpenAPIHono<AppEnv>;

const TAGS = ["signup"];
const ERRORS = errorResponses(400, 404, 409, 429, 500, 503);

/** Signup exists only when open, and only on the canonical host with no workspace. */
function requireSignupOpen(c: Context<AppEnv>, deps: ApiDeps): void {
  const open =
    deps.controlPlane.operators.signupEnabled &&
    c.get("classification")?.host === "canonical" &&
    c.get("workspace") === undefined;
  if (!open) throw new ApiError("not_found", "no such path");
}

/**
 * One public read per client per window (an IPv6 client is its /64, which it holds whole);
 * 429 + Retry-After past it.
 */
async function hitPerClient(
  c: Context<AppEnv>,
  deps: ApiDeps,
  bucket: "slug" | "plans",
  rule: (typeof SIGNUP_RATES)["slugPerIp" | "plansPerIp"],
): Promise<void> {
  const ip = clientIp(c, deps.trustProxy) ?? "unknown";
  // E3.11 R2-7: an IPv6 client is one /64 (it holds all of them), not one address.
  const client = isIPv6(ip) ? signupNetworkKey(ip) : ip;
  const decision = await deps.rateLimiter.hit(
    `signup:${bucket}:ip:${sha256(client).toString("hex")}`,
    rule,
  );
  if (!decision.allowed) {
    throw toApiError(
      new SignupError("rate_limited", "too many checks; try again shortly", {
        retryAfterMs: decision.retryAfterMs,
      }),
    );
  }
}

function toApiError(error: unknown): unknown {
  if (!(error instanceof SignupError)) return error;
  if (error.code === "rate_limited") {
    const retryAfterMs = error.details.retryAfterMs ?? 60_000;
    return new ApiError(
      "rate_limited",
      error.message,
      { retryAfterMs },
      { headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } },
    );
  }
  if (error.code === "invalid_code") {
    return new ApiError(
      "invalid_code",
      error.message,
      error.details.attemptsLeft === undefined ? {} : { attemptsLeft: error.details.attemptsLeft },
    );
  }
  if (error.code === "not_found") return new ApiError("not_found", "no such path");
  if (error.code === "terms_version") {
    return new ApiError("conflict", error.message, {
      reason: "terms_version",
      current: error.details.current ?? null,
    });
  }
  return new ApiError(error.code, error.message);
}

export function registerSignupRoutes(api: Api, deps: ApiDeps): void {
  api.openapi(
    createRoute({
      method: "get",
      path: "/signup/slug",
      tags: TAGS,
      summary: "Is this workspace address free?",
      "x-requires": "public",
      request: { query: s.SignupSlugQuery },
      responses: { 200: jsonResponse(s.SignupSlugAvailabilitySchema, "Availability"), ...ERRORS },
    }),
    async (c) => {
      requireSignupOpen(c, deps);
      const { slug } = c.req.valid("query");
      await hitPerClient(c, deps, "slug", SIGNUP_RATES.slugPerIp);
      const available = await signupSlugAvailable(deps.controlPlane.operators.signup, slug);
      return c.json({ slug, available }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/signup/plans",
      tags: TAGS,
      summary: "The plans a new workspace can choose",
      description:
        "Public, unarchived plans in catalogue order. No prices (the marketing site shows them). 429 past 30 a minute per client.",
      "x-requires": "public",
      responses: { 200: jsonResponse(s.SignupPlansSchema, "Plans"), ...ERRORS },
    }),
    async (c) => {
      requireSignupOpen(c, deps);
      await hitPerClient(c, deps, "plans", SIGNUP_RATES.plansPerIp);
      const plans = await listSignupPlans(deps.controlPlane.operators.signup);
      c.header("Cache-Control", "public, max-age=60");
      return c.json(
        {
          plans: plans.map((p) => ({
            id: p.id,
            name: p.name,
            limits: p.limits,
            trialDays: p.trialDays,
            paid: p.paid,
          })),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/signup/start",
      tags: TAGS,
      summary: "Start a signup: email a code",
      description:
        "Responds identically whether or not the email is known. Needs `acceptTerms: true` and the current `termsVersion` (409 `conflict` otherwise). 429 past the per-address, per-IP, per-network (/24, /64) or install budgets.",
      "x-requires": "public",
      request: { body: jsonBody(s.SignupStartBody) },
      responses: { 200: jsonResponse(OkSchema, "Code sent (or silently not sent)"), ...ERRORS },
    }),
    async (c) => {
      requireSignupOpen(c, deps);
      const body = c.req.valid("json");
      try {
        await startSignup(deps.controlPlane.operators.signup, {
          email: body.email,
          companyName: body.companyName,
          legalName: body.legalName,
          country: body.country,
          slug: body.slug,
          locale: body.locale,
          acceptTerms: body.acceptTerms,
          termsVersion: body.termsVersion,
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
      path: "/signup/verify",
      tags: TAGS,
      summary: "Finish a signup with the emailed code",
      description:
        "Creates the workspace, its owner and the chosen plan (`planId` when public and live, else the default); returns where the owner goes next (`/admin/billing?plan=<id>` when the plan needs a subscription now, else `/setup`). 409 `slug_taken` when the address went meanwhile.",
      "x-requires": "public",
      request: { body: jsonBody(s.SignupVerifyBody) },
      responses: { 201: jsonResponse(s.SignupCompleteSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      requireSignupOpen(c, deps);
      const body = c.req.valid("json");
      const ip = clientIp(c, deps.trustProxy);
      const userAgent = c.req.header("user-agent")?.slice(0, 512);
      let done: Awaited<ReturnType<typeof verifySignup>>;
      try {
        done = await verifySignup(deps.controlPlane.operators.signup, {
          email: body.email,
          code: body.code,
          planId: body.planId,
          ip,
          requestId: requestIdOf(c),
        });
      } catch (error) {
        throw toApiError(error);
      }
      // Signed in on the canonical host, like an email-code sign-in (level 1).
      const mode = cookieModeOf(c);
      const started = await deps.auth.sessions.startSession({
        userId: done.userId,
        population: "staff",
        context: "first_party",
        authLevel: 1,
        ip,
        userAgent,
        workspaceId: done.workspaceId,
        workspaceName: done.name,
        deviceToken: readDeviceCookie(c, mode),
        replacesSessionId: c.get("session")?.sessionId,
      });
      await deps.audit.recordDetached(systemContext(done.workspaceId), {
        action: "auth.login",
        resourceKind: "session",
        resourceId: started.session.sessionId,
        sessionId: started.session.sessionId,
        actorKind: "staff",
        actorMembershipId: done.membershipId,
        actorUserId: done.userId,
        subjectMembershipId: done.membershipId,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
        requestId: requestIdOf(c),
        meta: { method: "signup", authLevel: 1, population: "staff", embed: false },
      });
      issueSessionCookies(c, {
        token: started.token,
        deviceToken: started.deviceToken,
        mode,
        basePath: cookieBasePathOf(c),
      });
      // A public paid plan with no trial and self-serve checkout needs a subscription first;
      // everything else starts setting up.
      const landing = done.checkoutFirst
        ? `/admin/billing?plan=${encodeURIComponent(done.planId)}`
        : "/setup";
      const url = workspaceUrl(
        deps.baseUrl,
        deps.tenancy,
        { slug: done.slug, primaryHost: null },
        landing,
      );
      return c.json({ workspaceUrl: url.href }, 201);
    },
  );
}
