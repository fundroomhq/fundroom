import type { AuditRecorder } from "@fundroom/audit";
import type { AuthzService } from "@fundroom/authz";
import { createAcceptanceService, type PendingAcceptance } from "@fundroom/compliance";
import { ApiError } from "@fundroom/contracts";
import {
  type Database,
  type Membership,
  type OfferingStatus,
  type ResolvedWorkspace,
  readAclVersion,
  systemContext,
} from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import { requiredAuthLevelFor, STEP_UP_MAX_AGE_MS } from "@fundroom/identity";
import type { AuthenticatedSession } from "@fundroom/ports";
import type { Context, MiddlewareHandler } from "hono";
import { runAsApiKey } from "../api-key-context.js";
import type { AppEnv } from "../env.js";
import { assertModuleWritable } from "../module-read-only.js";
import { apiKeyCreatorOf, apiKeyNotAllowed, keyOnly, ssoRequiredError } from "./auth.js";
import { markAuthzDenial } from "./security-events.js";

/*
 * Authorization middleware (ADR-0014 layer 2, §6.2 MFA policy). `requirePermission(p)` is
 * what every staff route mounts: signed in → live member → session strong enough for the
 * role in this workspace → role holds `p`. External kinds hitting a staff route get the same
 * 404 an unknown URL gives (deny-by-default, no oracle); staff without the permission get 403.
 * On a module route, a write the caller is otherwise allowed is then refused with 402 while the
 * module is read-only on the workspace's plan (A-3, `module-read-only.ts`).
 */
export interface AuthzMiddlewareOptions {
  /** Read per request, never at registration (the OpenAPI generator uses a throwing stub). */
  readonly authz: () => AuthzService;
}

/** The auth level this membership needs here: owner/admin → 2; else the workspace setting. */
export function requiredAuthLevel(
  workspace: Pick<ResolvedWorkspace, "settings">,
  membership: Pick<Membership, "kind" | "role">,
): 0 | 1 | 2 {
  const access = parseWorkspaceSettings(workspace.settings).access;
  const requiresMfa =
    membership.kind === "staff" ? access.requireMfaForStaff : access.requireMfaForExternal;
  return requiredAuthLevelFor(membership.role, requiresMfa);
}

/** Throws `step_up_required` (reason `level`) when the session is weaker than the role needs. */
export function assertAuthLevel(c: Context<AppEnv>): void {
  const s = c.get("session");
  const ws = c.get("workspace");
  const m = c.get("membership");
  if (s === undefined || ws === undefined || m === undefined) return;
  const required = requiredAuthLevel(ws, m);
  if (s.authLevel < required) {
    throw new ApiError("step_up_required", "this workspace requires a stronger sign-in", {
      reason: "level",
      requiredLevel: required,
      currentLevel: s.authLevel,
      mfaEnrolled: s.user.mfaEnrolled,
    });
  }
}

/**
 * Enforced SSO (E3.8): the caller is a staff member here whose session was not minted by this
 * workspace's SSO connection, so the membership was not admitted — say so (403 `sso_required`)
 * rather than the 404 a stranger gets, so the SPA can send them to their IdP. Only ever set for
 * a real, live staff membership, so it is no oracle.
 */
function refuseWithoutSso(c: Context<AppEnv>): void {
  const refused = ssoRequiredError(c);
  if (refused !== undefined) throw refused;
}

export function assertFresh(
  s: AuthenticatedSession,
  maxAgeMs = STEP_UP_MAX_AGE_MS,
  now: () => Date = () => new Date(),
): void {
  const age = now().getTime() - s.authTime.getTime();
  if (age > maxAgeMs) {
    throw new ApiError("step_up_required", "please confirm it's you", {
      reason: "fresh",
      maxAgeMs,
      ageMs: age,
    });
  }
}

/*
 * The legal-acceptance gate (E1.6, ADR-0037 decision 5, §13.1).
 *
 * It is enforced here rather than in the SPA on purpose: a gate a client renders is a
 * suggestion, and principle 1's "no offering content reachable" has to be true of the API, not
 * only of the UI. An external member with an outstanding required acceptance is refused every
 * member route except the handful in `routes/compliance.ts` that let them read the text and
 * accept it — those mount `requireMember()` with no gate, which is the opt-out.
 *
 * Staff are never gated. The tenant privacy notice is investor onboarding (design/04 §7): the
 * founder who has to publish it must be able to reach the screen that publishes it, and locking
 * an owner out of their own admin because they have not clicked through their own document is a
 * failure mode with no upside.
 */
export interface AcceptanceGateDeps {
  /** Thunks, not values: the OpenAPI generator builds every middleware against a throwing stub. */
  readonly db: () => Database;
  readonly audit: () => AuditRecorder;
}

export interface AcceptanceGate {
  /**
   * What this caller still owes, cached. Empty for staff, for anonymous callers, and for a
   * workspace that has turned `legal.enforceAcceptance` off — the bootstrap reads the same
   * answer the middleware enforces, so the interstitial and the 403 can never disagree.
   */
  pending(c: Context<AppEnv>): Promise<readonly PendingAcceptance[]>;
  /** Throws `legal_acceptance_required` when this member still owes an acceptance. */
  check(c: Context<AppEnv>): Promise<void>;
  /** Drops cached answers after a publish or an acceptance; the whole workspace when no member. */
  invalidate(workspaceId: string, membershipId?: string): void;
}

/** Ceiling on a cached "nothing outstanding"; `acl_version` is what actually invalidates it. */
const GATE_TTL_MS = 30_000;
/** How long a request trusts its last look at `acl_version` (the authz service uses 5 s too). */
const ACL_VERSION_TTL_MS = 5_000;
/** Cache ceiling, so a workspace with many members cannot grow this map without bound. */
const GATE_CACHE_MAX = 5_000;

/**
 * Cached per `(membershipId, aclVersion)` the way `@fundroom/authz` caches its decisions, with a
 * short ceiling on top. Publishing a version and accepting one both bump `acl_version` already
 * (the compliance services do it inside the same transaction), so the invalidation seam exists
 * and this uses it rather than inventing a second one; `invalidate` is only the local shortcut
 * that makes the member's very next request see their own acceptance without waiting out the
 * version cache.
 */
export function createAcceptanceGate(deps: AcceptanceGateDeps): AcceptanceGate {
  let service: ReturnType<typeof createAcceptanceService> | undefined;
  const acceptances = () =>
    (service ??= createAcceptanceService({ db: deps.db(), audit: deps.audit() }));
  const versions = new Map<string, { value: number; until: number }>();
  const pending = new Map<string, { value: readonly PendingAcceptance[]; until: number }>();

  async function aclVersionOf(workspaceId: string): Promise<number> {
    const hit = versions.get(workspaceId);
    const t = Date.now();
    if (hit !== undefined && hit.until > t) return hit.value;
    const ctx = systemContext(workspaceId);
    const value = await deps.db().withTenant(ctx, (tx) => readAclVersion(tx, workspaceId));
    versions.set(workspaceId, { value, until: t + ACL_VERSION_TTL_MS });
    return value;
  }

  /** The cached answer for this caller. Extracted so `check` never depends on `this`. */
  async function pendingFor(c: Context<AppEnv>): Promise<readonly PendingAcceptance[]> {
    const membership = c.get("membership");
    const workspace = c.get("workspace");
    if (membership === undefined || workspace === undefined) return [];
    if (membership.kind === "staff") return [];
    if (!parseWorkspaceSettings(workspace.settings).legal.enforceAcceptance) return [];

    const aclVersion = await aclVersionOf(workspace.id);
    const key = `${workspace.id}:${membership.id}:${aclVersion}`;
    const t = Date.now();
    let entry = pending.get(key);
    if (entry === undefined || entry.until <= t) {
      const ctx = systemContext(workspace.id);
      const value = await deps
        .db()
        .withTenant(ctx, (tx) =>
          acceptances().pendingFor(ctx, tx, { id: membership.id, kind: membership.kind }),
        );
      if (pending.size >= GATE_CACHE_MAX) pending.clear();
      entry = { value, until: t + GATE_TTL_MS };
      pending.set(key, entry);
    }
    return entry.value;
  }

  return {
    invalidate(workspaceId, membershipId) {
      versions.delete(workspaceId);
      if (membershipId === undefined) {
        for (const key of pending.keys())
          if (key.startsWith(`${workspaceId}:`)) pending.delete(key);
        return;
      }
      for (const key of pending.keys())
        if (key.startsWith(`${workspaceId}:${membershipId}:`)) pending.delete(key);
    },

    pending: pendingFor,

    async check(c) {
      const outstanding = await pendingFor(c);
      if (outstanding.length === 0) return;
      // `details` names the outstanding documents (not their bodies) so a client that got here
      // without the bootstrap still knows what to fetch and show.
      throw new ApiError(
        "legal_acceptance_required",
        "accept the outstanding legal documents to continue",
        {
          documents: outstanding.map((p) => ({
            documentId: p.documentId,
            slug: p.slug,
            title: p.title,
            versionNo: p.versionNo,
            stamp: p.stamp,
          })),
        },
      );
    },
  };
}

export interface RequireMemberOptions {
  /**
   * The legal-acceptance gate. Omitted only by the compliance routes a blocked member must
   * still reach — reading what they owe, accepting it, and answering the consent question.
   */
  readonly gate?: AcceptanceGate | undefined;
}

/** Signed in, live member, strong enough session, no outstanding acceptance. Investors and staff. */
export function requireMember(options: RequireMemberOptions = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (keyOnly(c)) throw apiKeyNotAllowed(c);
    if (c.get("session") === undefined)
      throw new ApiError("unauthenticated", "sign in to continue");
    refuseWithoutSso(c);
    if (c.get("tenant") === undefined || c.get("membership") === undefined)
      throw markAuthzDenial(new ApiError("not_found", "no such workspace for this account"));
    assertAuthLevel(c);
    if (options.gate !== undefined) await options.gate.check(c);
    // A-3 (R1 M1): a staff member writing through a `member` route of a read-only module is a
    // staff write. Investors are never refused here; API keys never reach a member route.
    if (c.get("membership")?.kind === "staff") await assertModuleWritable(c);
    await next();
  };
}

/**
 * The `owner-or-admin` requirement *with* workspace context (E1.7 module enablement).
 *
 * `routes/setup.ts` enforces the same word by listing the caller's memberships, because a
 * first-run probe runs before any workspace is resolved. Here the workspace is resolved, so
 * the ordinary chain applies and the answers stay consistent with every other staff route:
 * an external member gets the 404 an unknown URL gives (no oracle) and a staff member in the
 * wrong role gets 403.
 *
 * A role check rather than a permission: enablement is not a per-module capability but a
 * decision about the shape of the whole workspace, so it is not in the RBAC catalogue.
 */
export function requireOwnerOrAdmin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (keyOnly(c)) throw apiKeyNotAllowed(c);
    if (c.get("session") === undefined)
      throw new ApiError("unauthenticated", "sign in to continue");
    refuseWithoutSso(c);
    const m = c.get("membership");
    if (c.get("tenant") === undefined || m === undefined)
      throw markAuthzDenial(new ApiError("not_found", "no such workspace for this account"));
    if (m.kind !== "staff") throw markAuthzDenial(new ApiError("not_found", "no such path"));
    assertAuthLevel(c);
    if (m.role !== "owner" && m.role !== "admin")
      throw new ApiError("forbidden", `your role (${m.role}) cannot do this`);
    await next();
  };
}

/*
 * Offering mode as a *route* guard (E1.6 R3, ADR-0037 decision 3, E2.3 contract S4).
 *
 * `ModuleManifest.offeringStatusRules.disabledWhen` already expresses "this workspace may not run
 * this at all", and `api.ts` turns it into a 404 for every route a **module package** mounts. It
 * cannot do the same for kernel routes: they are registered directly on the API app, above the
 * per-module enablement middleware, precisely because they read `core.*`. Dropping the module from
 * the enabled set therefore closes a module package's routes and none of ours, whatever the
 * bootstrap says about it.
 *
 * So the rule is enforced here, where the route is. The manifest still declares `disabledWhen`
 * and the route still reads that same list, so the two cannot drift; the declaration is what the
 * bootstrap and the admin nav read, and this is what actually closes the door.
 *
 * It answers **404**, not 403: the compliance decision is that the feature does not exist for
 * this workspace, and E1.6's as-built is blunt that a compliance control which only edits a menu
 * is one an admin can walk around. It runs before any permission check and before anything reads
 * the feature's own tables, so a public route guarded by it cannot be distinguished by timing
 * either.
 */
export function requireOffering(
  disabledWhen: readonly OfferingStatus[],
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const workspace = c.get("workspace");
    // No resolved workspace means the tenant classifier found none; `setup_required` is the
    // answer every other route gives there, and it is not this guard's question.
    if (workspace !== undefined && disabledWhen.includes(workspace.offeringStatus)) {
      throw new ApiError(
        "module_disabled",
        `this feature is unavailable while the offering status is ${workspace.offeringStatus}`,
        { reason: "offering_status", offeringStatus: workspace.offeringStatus },
      );
    }
    await next();
  };
}

/**
 * A live *staff* membership holding `permission` (RBAC matrix). `fresh` adds the 10-minute
 * step-up check for sensitive mutations (§6.2).
 */
export function requirePermission(
  options: AuthzMiddlewareOptions,
  permission: string,
  // `apiKey` (E3.4): the route's matrix row is `apiKey: true`, so a key-only request may be
  // admitted (see `admitApiKey`); without it a key gets 401 `api_key_not_allowed`.
  extra: { readonly fresh?: boolean | undefined; readonly apiKey?: boolean | undefined } = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (keyOnly(c)) {
      // A key never satisfies a freshness check (the matrix loader refuses `apiKey` + `stepUp`;
      // this is the runtime half of that rule).
      if (extra.apiKey !== true || extra.fresh === true) throw apiKeyNotAllowed(c);
      return admitApiKey(c, options, permission, next);
    }
    const s = c.get("session");
    if (s === undefined) throw new ApiError("unauthenticated", "sign in to continue");
    refuseWithoutSso(c);
    const m = c.get("membership");
    if (c.get("tenant") === undefined || m === undefined)
      throw markAuthzDenial(new ApiError("not_found", "no such workspace for this account"));
    if (m.kind !== "staff") throw markAuthzDenial(new ApiError("not_found", "no such path"));
    assertAuthLevel(c);
    if (!options.authz().hasPermission(m, permission)) {
      throw new ApiError("forbidden", `your role (${m.role}) cannot do this`, { permission });
    }
    if (extra.fresh) assertFresh(s);
    // Last, so only a caller every check above admitted can learn the plan (A-3).
    await assertModuleWritable(c);
    await next();
  };
}

/*
 * Admitting a key-only request to a key-callable route (E3.4-A, ADR-0052).
 *
 * The key acts as its creator's membership capped by its scopes: the permission must be one of
 * the key's scopes AND held by the creator's CURRENT role (the resolver already refused a
 * creator who is not live). Failing either is 403 `forbidden` / `scope_missing` — the route is
 * key-callable, so answering differently from a non-key route is not an oracle. The creator's
 * membership and tenant context are set here and nowhere else (see `apiKeyResolution`), and the
 * handler runs inside `runAsApiKey`, which is how every audit entry it writes gets
 * `meta.apiKeyId`. A key counts as auth level 2 (it was minted on a fresh level-2 session), so
 * the MFA level check is satisfied by construction.
 */
async function admitApiKey(
  c: Context<AppEnv>,
  options: AuthzMiddlewareOptions,
  permission: string,
  next: () => Promise<void>,
): Promise<void> {
  const key = c.get("apiKey");
  const stash = apiKeyCreatorOf(c);
  if (key === undefined || stash === undefined) throw apiKeyNotAllowed(c);
  if (
    !key.scopes.includes(permission) ||
    !options.authz().hasPermission(stash.creator, permission)
  ) {
    throw new ApiError("forbidden", "this API key does not have the scope this route needs", {
      reason: "scope_missing",
      permission,
    });
  }
  c.set("membership", stash.creator);
  c.set("tenant", stash.tenant);
  // A key writes to a read-only module no more than its creator's session could (A-3).
  await assertModuleWritable(c);
  await runAsApiKey(key.id, next);
}
