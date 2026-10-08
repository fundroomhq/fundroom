import {
  API_KEY_RATE_LIMIT,
  type ApiKeyService,
  displayPrefix,
  isPlausibleApiKey,
  looksLikeApiKey,
} from "@fundroom/api-keys";
import { membershipExpired, roleHasPermission } from "@fundroom/authz";
import { ApiError, errorResponse, requestIdOf } from "@fundroom/contracts";
import {
  type Database,
  type Membership,
  systemContext,
  type TenantActorKind,
  type TenantContext,
} from "@fundroom/db";
import {
  type AuthService,
  assertMayChangeAccount,
  cookieModeFor,
  isBoundSession,
  listWorkspaceMembershipsForUser,
  MembershipRepo,
  readCookie,
  STEP_UP_MAX_AGE_MS,
} from "@fundroom/identity";
import { csrfMiddleware, sessionMiddleware } from "@fundroom/identity/http";
import type {
  ApiKeyPrincipal,
  AuthenticatedSession,
  AuthLevel,
  RateLimiterPort,
  SessionViewAs,
} from "@fundroom/ports";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { publicBaseOf, publicOriginOf } from "../path-mount.js";
import { markAuthzDenial, markSecurityEvent } from "./security-events.js";

/*
 * Session → membership → tenant context (§3.3 steps 2–3). The identity kernel resolves the
 * cookie; this layer looks up the caller's membership in the resolved workspace (one
 * host-context read fenced to the acting user) and builds the `TenantContext` every
 * repository call needs. No membership → no tenant context; the route decides whether that
 * is a 401 or a 404, and the answer never reveals whether the email exists elsewhere.
 */
export interface AuthMiddlewareOptions {
  readonly auth: AuthService;
  readonly db: Database;
  readonly trustProxy: boolean;
  readonly allowedOrigins: readonly string[];
  /**
   * RBAC check for the view-as re-check (staff must still hold `access.manage`). Defaults to
   * the built-in authz matrix, which is the one the container's authz service uses.
   */
  readonly hasPermission?: (role: string, permission: string) => boolean;
  readonly now?: () => Date;
  /**
   * Workspace API keys (E3.4-A). Omitted by tests that build the chain on their own: an
   * `Authorization: Bearer frk_…` is then ignored like any other bearer value.
   */
  readonly apiKeys?: ApiKeyResolverOptions | undefined;
}

export interface ApiKeyResolverOptions {
  /** Read per request (the container is built before the service exists in some tests). */
  readonly service: () => ApiKeyService;
  readonly rateLimiter: () => RateLimiterPort;
  /** The client address as every other request helper derives it (`clientIp`, TRUST_PROXY). */
  readonly clientIp: (c: Context<AppEnv>) => string | undefined;
}

/** Methods a view-as-investor request may use; everything else is 403 `view_as_read_only`. */
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The two writes a viewing staff member must still be able to make: leaving the view, and
 * signing out. Matched on the path suffix because the API is mounted under several prefixes
 * (`/api/v1`, `/w/<slug>/api/v1`, `/embed/<slug>/api/v1`, all under `BASE_PATH`).
 */
function exemptFromViewAsReadOnly(method: string, path: string): boolean {
  if (method === "DELETE") return /\/api\/v1\/me\/view-as\/?$/u.test(path);
  if (method === "POST") return /\/api\/v1\/auth\/logout\/?$/u.test(path);
  return false;
}

/**
 * Reads that are downloads: a copy of the investor's material leaving the portal. Refused while
 * viewing as an investor, like every export. Module routes refuse their own (data-room
 * `/documents/{id}/download` checks `viewAs` itself); this list covers kernel routes.
 */
const VIEW_AS_DOWNLOADS: readonly RegExp[] = [
  /\/api\/v1\/compliance\/acceptances\/[^/]+\/certificate\/?$/u,
  /\/api\/v1\/data-room\/documents\/[^/]+\/download\/?$/u,
  // E3.5: the investor's own signed copy (audited as `esign.artifact_downloaded`).
  /\/api\/v1\/esign\/me\/envelopes\/[^/]+\/signed\.pdf$/u,
];

/** The permission a staff member needs to view as an investor, re-checked on every request. */
export const VIEW_AS_PERMISSION = "access.manage";

const LIVE_STATUSES: ReadonlySet<Membership["status"]> = new Set(["active", "dormant"]);

/**
 * Whether a membership admits its user to the workspace at `now`: a live status *and* not past
 * its own `expires_at` (P1-01). An expired membership gets no tenant context, so member-only
 * routes answer 404, staff RBAC has no membership to check, and view-as refuses both ends.
 */
export function membershipIsLive(m: Pick<Membership, "status" | "expiresAt">, now: Date): boolean {
  return LIVE_STATUSES.has(m.status) && !membershipExpired(m.expiresAt, now);
}

/**
 * The cookie recipe for this request: embed or not, and the request's PUBLIC base (E3.9) — a
 * mounted request gets `__Secure-…; Path=<mount prefix>`, a direct one what BASE_PATH implies.
 * Cookie names differ by recipe, so a session minted on one face is never read on the other.
 * Pair with `cookieBasePathOf(c)` for the `basePath` of the cookie helpers.
 */
export function cookieModeOf(c: Context<AppEnv>) {
  const basePath = publicBaseOf(c);
  return cookieModeFor({ embed: c.get("embed") === true, ...(basePath ? { basePath } : {}) });
}

/**
 * Staff SSO (E3.8 decision 5): a session minted by a workspace's SSO connection serves that
 * workspace and nothing else — not another tenant, not the canonical host with no workspace. It is
 * treated as absent there (never revoked: the browser may be on its way back to its own
 * workspace). A tenant's IdP can assert any address, so this is what keeps what it vouches for
 * inside that tenant.
 *
 * Central auth (E3.10): a session a handoff minted (`boundWorkspaceId`) is bound the same way —
 * its cookie lives on a host the tenant may control, so it must never open another workspace or
 * the canonical host.
 */
export function sessionServesWorkspace(
  session: Pick<AuthenticatedSession, "sso"> &
    Partial<Pick<AuthenticatedSession, "population" | "boundWorkspaceId">>,
  workspace:
    | {
        readonly id: string;
        readonly ssoConnectionId: string | null;
        readonly ssoConnectionVersion: number | null;
      }
    | undefined,
): boolean {
  // E3.10: an operator session serves the operator API only (`__Host-op_sid`, read by
  // `requirePlatformOperator()`); replayed in the tenant cookie it is no session at all, so it can
  // never carry a membership or reach a tenant route.
  if (session.population === "operator") return false;
  if (
    session.boundWorkspaceId !== undefined &&
    (workspace === undefined || workspace.id !== session.boundWorkspaceId)
  ) {
    return false;
  }
  const sso = session.sso;
  if (sso === undefined) return true;
  if (workspace === undefined || sso.workspaceId !== workspace.id) return false;
  // E3.8 FR3: only while the connection that minted it is still the workspace's live, enabled
  // connection at the version it was minted under. A disable, delete or security-relevant save
  // clears or bumps the mirror in the same transaction, so the session stops serving on the next
  // request even if the post-commit revoke never ran.
  return (
    workspace.ssoConnectionId === sso.connectionId &&
    sso.connectionVersion !== undefined &&
    workspace.ssoConnectionVersion === sso.connectionVersion
  );
}

/**
 * Enforced SSO (E3.8 decision 8): whether a live membership must be refused because this
 * workspace requires SSO and the session was not minted by its connection. Only staff are
 * affected (investors and delegates never), and an owner at auth level 2 is always admitted —
 * the break-glass that keeps a broken IdP from locking the tenant out.
 */
export function ssoBlocks(
  workspace: { readonly id: string; readonly ssoEnforced: boolean },
  membership: Pick<Membership, "kind" | "role">,
  session: Pick<AuthenticatedSession, "sso" | "authLevel">,
): boolean {
  if (!workspace.ssoEnforced || membership.kind !== "staff") return false;
  if (session.sso?.workspaceId === workspace.id) return false;
  return !(membership.role === "owner" && session.authLevel >= 2);
}

/** 403 `sso_required` for a staff member of an SSO-enforced workspace without an SSO session. */
export function ssoRequiredError(c: Context<AppEnv>): ApiError | undefined {
  const required = c.get("ssoRequired");
  if (required === undefined) return undefined;
  return new ApiError("sso_required", "this workspace requires single sign-on", {
    reason: "enforced",
    ...(required.breakGlass ? { breakGlass: true } : {}),
  });
}

export function sessionResolution(options: AuthMiddlewareOptions): MiddlewareHandler<AppEnv>[] {
  const session = sessionMiddleware({
    auth: options.auth,
    cookieMode: (c) => cookieModeOf(c as Context<AppEnv>),
    admits: (c, s) => sessionServesWorkspace(s, (c as Context<AppEnv>).get("workspace")),
  }) as unknown as MiddlewareHandler<AppEnv>;

  const hasPermission = options.hasPermission ?? ((role, p) => roleHasPermission(role, p));
  const now = options.now ?? (() => new Date());

  /*
   * View as investor (E2.7). The session row says which member; nothing on it is trusted
   * beyond that: every request re-checks that the view has not expired, that the staff member
   * is still an active staff member here holding `access.manage`, and that the target is still
   * an active external member. Any failure ends the view (audited once, however many requests
   * race to notice) and the request is served as the staff member.
   */
  async function applyViewAs(
    c: Context<AppEnv>,
    s: AuthenticatedSession,
    view: SessionViewAs,
    workspaceId: string,
    staff: Pick<Membership, "id" | "kind" | "role" | "status"> | undefined,
  ): Promise<boolean> {
    const end = async (reason: "expired" | "staff_unauthorized" | "target_unavailable") => {
      await options.auth.sessions.endViewAs({
        sessionId: s.sessionId,
        reason,
        expected: view,
        requestId: requestIdOf(c),
      });
      return false;
    };
    if (view.until.getTime() <= now().getTime()) return end("expired");
    if (
      staff === undefined ||
      staff.kind !== "staff" ||
      staff.status !== "active" ||
      !hasPermission(staff.role, VIEW_AS_PERMISSION)
    ) {
      return end("staff_unauthorized");
    }
    const sys = systemContext(workspaceId);
    const target = await options.db.withTenant(sys, (tx) =>
      new MembershipRepo(sys, tx).byId(view.membershipId),
    );
    if (
      target === undefined ||
      target.kind !== "external" ||
      target.status !== "active" ||
      membershipExpired(target.expiresAt, now())
    ) {
      return end("target_unavailable");
    }
    const tenant: TenantContext = {
      workspaceId,
      actorKind: "external",
      membershipId: target.id,
      userId: target.userId,
      viewAs: { staffMembershipId: staff.id, staffUserId: s.userId },
    };
    c.set("membership", target);
    c.set("tenant", tenant);
    c.set("viewAs", {
      staffMembershipId: staff.id,
      staffUserId: s.userId,
      membershipId: target.id,
      startedAt: view.startedAt,
      until: view.until,
    });
    return true;
  }

  const membership: MiddlewareHandler<AppEnv> = async (c, next) => {
    const s = c.get("session");
    const ws = c.get("workspace");
    if (s !== undefined && ws !== undefined) {
      const rows = await options.db.withHost(
        (tx) => listWorkspaceMembershipsForUser(tx, s.userId),
        {
          actorKind: "host",
          userId: s.userId,
        },
      );
      const at = now();
      const live = rows.find((m) => m.workspaceId === ws.id && membershipIsLive(m, at));
      // Enforced SSO (E3.8): the staff membership is not admitted at all — no tenant context, no
      // view as investor — and the guards answer 403 `sso_required`. The bootstrap still answers.
      const blocked = live !== undefined && ssoBlocks(ws, live, s);
      if (blocked) c.set("ssoRequired", { breakGlass: live.role === "owner" });
      const row = blocked ? undefined : live;
      const viewing =
        !blocked && s.viewAs !== undefined && s.viewAs.workspaceId === ws.id
          ? await applyViewAs(c, s, s.viewAs, ws.id, row)
          : false;
      if (viewing) {
        // Read only: the database backstop (`SET TRANSACTION READ ONLY`) only covers the
        // investor's own context, so the method gate is what keeps every write out.
        if (!READ_METHODS.has(c.req.method) && !exemptFromViewAsReadOnly(c.req.method, c.req.path))
          throw new ApiError("view_as_read_only", "this is a read-only view as an investor");
        if (VIEW_AS_DOWNLOADS.some((re) => re.test(c.req.path)))
          throw new ApiError(
            "view_as_read_only",
            "downloads are disabled while viewing as an investor",
          );
        if (s.lastWorkspaceId !== ws.id) await options.auth.touchWorkspace(s.sessionId, ws.id);
      } else if (row !== undefined) {
        const tenant = {
          workspaceId: ws.id,
          actorKind: row.kind as TenantActorKind,
          membershipId: row.id,
          userId: s.userId,
        };
        const full = await options.db.withTenant(tenant, async (tx) => {
          const repo = new MembershipRepo(tenant, tx);
          const m = await repo.byId(row.id);
          // A delegate is admitted only while its principal is live too (E3.2): suspending,
          // revoking or expiring the principal closes the delegate's door on the next request,
          // before any rebuild has run. Its own row stays as it is (the principal may come back).
          if (m?.role !== "delegate" || m.principalMembershipId === null) return m;
          const principal = await repo.byId(m.principalMembershipId);
          // F6: and only while that principal is still an external investor — a principal promoted
          // to staff (portability `makeOwner`) lends nothing, whatever its status.
          return principal !== undefined &&
            principal.kind === "external" &&
            principal.role === "investor" &&
            principal.status === "active" &&
            !membershipExpired(principal.expiresAt, at)
            ? m
            : undefined;
        });
        if (full !== undefined) {
          c.set("membership", full);
          c.set("tenant", tenant);
          if (s.lastWorkspaceId !== ws.id) await options.auth.touchWorkspace(s.sessionId, ws.id);
        }
      }
    }
    await next();
  };

  const csrf = csrfMiddleware({
    // E3.9: the request's public origin — on a mounted request the mount's, and only it (the
    // portal's own origin is not also accepted there); otherwise the request's own, as before.
    selfOrigin: (c) => publicOriginOf(c as Context<AppEnv>, options.trustProxy),
    allowedOrigins: () => options.allowedOrigins,
  }) as unknown as MiddlewareHandler<AppEnv>;

  const chain: MiddlewareHandler<AppEnv>[] = [session];
  if (options.apiKeys !== undefined) chain.push(apiKeyResolution(options.apiKeys));
  chain.push(membership, csrf);
  return chain;
}

/*
 * The bearer resolver (E3.4-A, ADR-0052). Runs after the session cookie is resolved and before
 * the session's membership lookup, on the API tree only.
 *
 *  - Only `Authorization: Bearer frk_…` (or the pre-rename `shk_…`) is ours. Any other bearer
 *    value (METRICS_TOKEN on the ops routes, which answer before this chain anyway) is ignored,
 *    as it always was.
 *  - A session cookie *and* a key → 400 `validation_failed` / `ambiguous_credentials`: which one
 *    the request meant is not ours to guess, and picking either would let a page's cookie widen
 *    what a script's key may do (or the reverse). Any session cookie counts, resolved or not.
 *  - The embed tree never takes a key (401 `api_key_not_allowed`): keys are for server-to-server
 *    calls, the embed is a browser in somebody else's page.
 *  - Malformed, unknown (including another workspace's: the lookup is fenced to this one),
 *    revoked, expired, or a creator who is no longer live → one answer, 401 `unauthenticated` /
 *    `invalid_api_key`, and a `security.api_key_rejected` event carrying the display prefix
 *    only when the value is shaped like a token (never the token). Unknown and revoked cost the
 *    same single indexed statement (`findByTokenHashWithCreator`).
 *  - A usable key → per-key rate limit (600 / 60 s, 429 with Retry-After), a throttled last-used
 *    write on its own short transaction, and `c.var.apiKey`. Deliberately NOT `membership` /
 *    `tenant`: those are set only by the one guard that admits a key
 *    (`requirePermission(…, { apiKey: true })`), so a route that reads `c.get("membership")`
 *    without a guard, or a guard that forgot the key case, sees an anonymous caller rather than
 *    the key's creator. Deny by construction, not by audit of every route. The creator's row
 *    rides on the `apiKey` variable under a private symbol (`apiKeyCreatorOf`) until then.
 *
 * A key request never has a session, so it is never a view-as request, never "fresh", and
 * never touches `lastWorkspaceId`.
 */
interface ApiKeyStash {
  readonly creator: Membership;
  readonly tenant: TenantContext;
}
/**
 * The creator rides on the `apiKey` variable itself, under a module-private symbol and not
 * enumerable, so it never serialises and no other code can reach it by name. (Not a WeakMap on
 * the request: a module sub-app sees a different `Request` object than the resolver did.)
 */
const STASH: unique symbol = Symbol("apiKeyCreator");
type StashedPrincipal = ApiKeyPrincipal & { readonly [STASH]?: ApiKeyStash };

/** The key's creator and tenant context, for the guard that admits the key (and only it). */
export function apiKeyCreatorOf(c: Context<AppEnv>): ApiKeyStash | undefined {
  return (c.get("apiKey") as StashedPrincipal | undefined)?.[STASH];
}

/**
 * 401 `unauthenticated` with `reason`, the one answer a key gets where it may not go — marked as
 * a security event (`api_key_rejected` / `api_key_not_allowed`, with the key's display prefix and
 * id in the log line): a key probing routes it may not call is worth seeing (fix round 1, D5).
 */
export function apiKeyNotAllowed(c: Context<AppEnv>): ApiError {
  markSecurityEvent(c, {
    event: "api_key_rejected",
    code: "unauthenticated",
    reason: "api_key_not_allowed",
    keyPrefix: c.get("apiKey")?.prefix,
  });
  return new ApiError("unauthenticated", "this route cannot be called with an API key", {
    reason: "api_key_not_allowed",
  });
}

/** True when the request authenticated with a key and carries no session. */
export function keyOnly(c: Context<AppEnv>): boolean {
  return c.get("apiKey") !== undefined && c.get("session") === undefined;
}

function bearerOf(c: Context<AppEnv>): string | undefined {
  const header = c.req.header("authorization");
  if (header === undefined) return undefined;
  const m = /^Bearer[ ]+(\S+)\s*$/iu.exec(header);
  return m?.[1];
}

export function apiKeyResolution(options: ApiKeyResolverOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get("classification")?.tree !== "api") return next();
    const bearer = bearerOf(c);
    if (bearer === undefined || !looksLikeApiKey(bearer)) return next();

    const mode = cookieModeOf(c);
    if (
      c.get("session") !== undefined ||
      readCookie(c.req.header("cookie"), "session", mode) !== undefined
    ) {
      return errorResponse(
        c,
        new ApiError("validation_failed", "send either a session cookie or an API key, not both", {
          reason: "ambiguous_credentials",
        }),
      );
    }
    if (c.get("embed") === true) {
      const refused = apiKeyNotAllowed(c);
      c.set("securityEvent", {
        event: "api_key_rejected",
        code: "unauthenticated",
        reason: "api_key_not_allowed",
        ...(isPlausibleApiKey(bearer) ? { keyPrefix: displayPrefix(bearer) } : {}),
      });
      return errorResponse(c, refused);
    }

    const reject = () => {
      c.set("securityEvent", {
        event: "api_key_rejected",
        code: "unauthenticated",
        reason: "invalid_api_key",
        ...(isPlausibleApiKey(bearer) ? { keyPrefix: displayPrefix(bearer) } : {}),
      });
      return errorResponse(
        c,
        new ApiError("unauthenticated", "invalid API key", { reason: "invalid_api_key" }),
      );
    };
    const ws = c.get("workspace");
    // Host-level request (no workspace resolved): no key can be looked up, so none is valid.
    if (ws === undefined) return reject();
    const hit = await options.service().authenticate(ws.id, bearer);
    if (hit === undefined) return reject();

    const budget = await options.rateLimiter().hit(`api_key:${hit.key.id}`, {
      max: API_KEY_RATE_LIMIT.limit,
      windowMs: API_KEY_RATE_LIMIT.windowMs,
    });
    if (!budget.allowed) {
      const retryAfterMs = Math.max(1000, budget.retryAfterMs);
      return errorResponse(
        c,
        new ApiError(
          "rate_limited",
          "this API key is over its request budget",
          { reason: "api_key_rate_limited", retryAfterMs },
          { headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } },
        ),
      );
    }
    // Its own short system transaction, before the handler's: reads stay reads.
    await options.service().touchLastUsed(ws.id, hit.key.id, options.clientIp(c));

    const principal: ApiKeyPrincipal = {
      id: hit.key.id,
      name: hit.key.name,
      prefix: hit.key.prefix,
      scopes: hit.key.scopes,
      creatorMembershipId: hit.key.createdByMembershipId,
    };
    const stash: ApiKeyStash = {
      creator: hit.creator,
      tenant: {
        workspaceId: ws.id,
        actorKind: "staff",
        membershipId: hit.creator.id,
        userId: hit.creator.userId,
      },
    };
    Object.defineProperty(principal, STASH, { value: stash, enumerable: false });
    c.set("apiKey", Object.freeze(principal));
    return next();
  };
}

/**
 * E3.8 fix round 1 (H1): refuses an SSO-bound session with 403 `sso_session_restricted` on a route
 * that changes or reveals the global account (the user's other sessions and devices, their own
 * settings). Factor and password changes are refused in the identity service itself
 * (`canManageFactors` → `assertMayChangeAccount`). `allowCurrentSession`: a DELETE naming the
 * request's own session is signing out, which a bound session may always do.
 *
 * E3.10: any bound session — a central-auth one (`boundWorkspaceId`) answers 403
 * `bound_session_restricted` instead.
 */
export function refuseBoundSession(
  options: { readonly allowCurrentSession?: boolean } = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get("session");
    if (s !== undefined && isBoundSession(s)) {
      if (options.allowCurrentSession === true && c.req.param("id") === s.sessionId) return next();
      assertMayChangeAccount(s);
    }
    await next();
  };
}

/** The E3.8 name, kept for its call sites: every bound session, not only SSO, since E3.10. */
export const refuseSsoBoundSession = refuseBoundSession;

export function requireSession(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (keyOnly(c)) throw apiKeyNotAllowed(c);
    if (c.get("session") === undefined)
      throw new ApiError("unauthenticated", "sign in to continue");
    await next();
  };
}

/** Signed in *and* a live member of the resolved workspace. */
export function requireMembership(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (keyOnly(c)) throw apiKeyNotAllowed(c);
    if (c.get("session") === undefined)
      throw new ApiError("unauthenticated", "sign in to continue");
    const sso = ssoRequiredError(c);
    if (sso !== undefined) throw sso;
    if (c.get("tenant") === undefined)
      throw markAuthzDenial(new ApiError("not_found", "no such workspace for this account"));
    await next();
  };
}

export function requireAuthLevel(level: AuthLevel): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (keyOnly(c)) throw apiKeyNotAllowed(c);
    const s = c.get("session");
    if (s === undefined) throw new ApiError("unauthenticated", "sign in to continue");
    if (s.authLevel < level) {
      throw new ApiError("step_up_required", "stronger authentication required", {
        reason: "level",
        requiredLevel: level,
        currentLevel: s.authLevel,
      });
    }
    await next();
  };
}

/** Step-up freshness (§6.2): the last proof must be younger than `maxAgeMs`. */
export function requireFreshAuth(
  maxAgeMs = STEP_UP_MAX_AGE_MS,
  now: () => Date = () => new Date(),
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (keyOnly(c)) throw apiKeyNotAllowed(c);
    const s = c.get("session");
    if (s === undefined) throw new ApiError("unauthenticated", "sign in to continue");
    const age = now().getTime() - s.authTime.getTime();
    if (age > maxAgeMs) {
      throw new ApiError("step_up_required", "please confirm it's you", {
        reason: "fresh",
        maxAgeMs,
        ageMs: age,
      });
    }
    await next();
  };
}
