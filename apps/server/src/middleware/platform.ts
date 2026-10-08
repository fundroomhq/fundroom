import { BlockList } from "node:net";
import { parseCidr } from "@fundroom/config";
import { ApiError } from "@fundroom/contracts";
import { isLiveOperator } from "@fundroom/control-plane";
import { checkCsrf, parseCookies } from "@fundroom/identity";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { cookieBasePathOf, publicOriginOf } from "../path-mount.js";
import { type ApiDeps, clientIp } from "../routes/deps.js";
import { markAuthzDenial, markSecurityEvent } from "./security-events.js";

/*
 * The platform-operator boundary (E3.10, ADR-0058): `requirePlatformOperator()` guards every
 * `/api/v1/platform/*` route except `POST /platform/session` (authz matrix `requires:
 * platform-operator`). Every check runs on EVERY request, in this order, and every failure is the
 * same plain 404 `not_found` ("no such path", the authz middleware's own answer) — an operator
 * surface that answered 401 or 403 would tell anybody who probed it that it exists and roughly why
 * they were refused:
 *
 *   1. CONTROL_PLANE=on.
 *   2. The canonical host with no workspace (never a tenant host, a `/w/<slug>` path or a custom
 *      domain — a tenant must not be able to host a page that talks to the operator API
 *      same-origin).
 *   3. The client address is inside PLATFORM_OPERATOR_CIDRS, when that is set.
 *   4. An operator session: the `__Host-op_sid` cookie (never the tenant `__Host-sid`), resolving
 *      to a live session row of population `operator`. Idle 1 h / absolute 12 h / 3 concurrent come
 *      from the identity lifetimes.
 *   5. The user is a live operator right now (`core.platform_operator`, revoked_at NULL): a revoke
 *      takes effect on the next request whatever sessions are still open.
 *   6. CSRF: an unsafe method must come from our own origin (the same Origin / Sec-Fetch-Site check
 *      as every other cookie write; the cookie is also SameSite=Strict). A refusal here is the
 *      ordinary 403 `csrf_rejected` — by then the caller holds a live operator cookie.
 *
 * The operator session grants no tenant membership: the tenant session middleware never reads
 * the `op_sid` cookie and ignores a `population: operator` session even if its token is replayed
 * in the tenant cookie (`sessionServesWorkspace`).
 */

/** Cookie basename of the operator session (`__Host-op_sid`; `__Secure-op_sid` under a base path). */
export const OPERATOR_COOKIE_BASENAME = "op_sid";

/** The operator cookie's name for this request (the public base decides `__Host-` vs `__Secure-`). */
export function operatorCookieName(c: Context<AppEnv>): string {
  return cookieBasePathOf(c) === undefined
    ? `__Host-${OPERATOR_COOKIE_BASENAME}`
    : `__Secure-${OPERATOR_COOKIE_BASENAME}`;
}

function operatorCookieAttributes(c: Context<AppEnv>): string {
  const base = cookieBasePathOf(c);
  return `Path=${base ?? "/"}; Secure; HttpOnly; SameSite=Strict`;
}

/** The operator session token from the request, if any. */
export function readOperatorCookie(c: Context<AppEnv>): string | undefined {
  return parseCookies(c.req.header("cookie")).get(operatorCookieName(c));
}

/** `Set-Cookie` for a freshly minted operator session (browser-session cookie by default). */
export function issueOperatorCookie(
  c: Context<AppEnv>,
  token: string,
  maxAgeSeconds?: number | undefined,
): void {
  const maxAge =
    maxAgeSeconds === undefined ? "" : `; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
  c.header(
    "Set-Cookie",
    `${operatorCookieName(c)}=${token}; ${operatorCookieAttributes(c)}${maxAge}`,
    {
      append: true,
    },
  );
}

export function clearOperatorCookie(c: Context<AppEnv>): void {
  c.header("Set-Cookie", `${operatorCookieName(c)}=; ${operatorCookieAttributes(c)}; Max-Age=0`, {
    append: true,
  });
}

/** `PLATFORM_OPERATOR_CIDRS` as a matcher; `undefined` = no restriction. */
export function operatorNetwork(cidrs: readonly string[]): BlockList | undefined {
  if (cidrs.length === 0) return undefined;
  const list = new BlockList();
  for (const entry of cidrs) {
    const parsed = parseCidr(entry);
    if (parsed !== undefined) list.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }
  return list;
}

/** Whether `ip` may reach the operator surface (check 3). No address = refused when restricted. */
export function operatorNetworkAllows(
  list: BlockList | undefined,
  ip: string | undefined,
): boolean {
  if (list === undefined) return true;
  if (ip === undefined) return false;
  const family = ip.includes(":") ? "ipv6" : "ipv4";
  try {
    return list.check(ip, family);
  } catch {
    return false;
  }
}

/** Checks 1–3: the request may be an operator request at all (also used by `POST /platform/session`). */
export function platformSurfaceReachable(c: Context<AppEnv>, deps: ApiDeps): boolean {
  if (!deps.controlPlane.enabled) return false;
  if (c.get("classification")?.host !== "canonical" || c.get("workspace") !== undefined) {
    return false;
  }
  return operatorNetworkAllows(
    operatorNetwork(deps.platformOperatorCidrs),
    clientIp(c, deps.trustProxy),
  );
}

/** What `requirePlatformOperator()` leaves on the request for the handler. */
export type PlatformOperatorContext = NonNullable<AppEnv["Variables"]["platformOperator"]>;

export function platformOperatorOf(c: Context<AppEnv>): PlatformOperatorContext {
  const op = c.get("platformOperator");
  if (op === undefined) throw markAuthzDenial(new ApiError("not_found", "no such path"));
  return op;
}

function notFound(c: Context<AppEnv>): ApiError {
  markSecurityEvent(c, { event: "authz_denied", code: "not_found", reason: "platform_operator" });
  return markAuthzDenial(new ApiError("not_found", "no such path"));
}

/** The guard for `requires: platform-operator` rows (see the header). `deps` is read per request. */
export function requirePlatformOperator(deps: ApiDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!platformSurfaceReachable(c, deps)) throw notFound(c);
    const token = readOperatorCookie(c);
    if (token === undefined) throw notFound(c);
    const session = await deps.auth.resolveSession(token);
    if (session === undefined || session.population !== "operator") throw notFound(c);
    if (!(await isLiveOperator(deps.db, session.userId))) throw notFound(c);
    const verdict = checkCsrf(c.req.method, c.req.raw.headers, {
      selfOrigin: publicOriginOf(c, deps.trustProxy !== false),
    });
    if (!verdict.ok) {
      c.set("securityEvent", {
        event: "csrf_rejected",
        code: "csrf_rejected",
        reason: verdict.reason,
      });
      throw new ApiError("csrf_rejected", `request rejected (${verdict.reason})`, {
        reason: verdict.reason,
      });
    }
    c.set("platformOperator", { userId: session.userId, sessionId: session.sessionId, session });
    await next();
  };
}
