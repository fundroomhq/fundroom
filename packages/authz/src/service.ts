import {
  bumpAclVersionInTx,
  type Database,
  type EffectiveAccessRow,
  listLiveWorkspaceIds,
  readAclVersion,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { publish, type Subscription } from "@fundroom/events";
import type {
  AccessDecision,
  AccessHolder,
  AuthzPort,
  AuthzPrincipal,
  Capability,
  JobDefinition,
  PendingGate,
  RequestFacts,
  ResourceRef,
} from "@fundroom/ports";
import { CAPABILITIES } from "@fundroom/ports";
import {
  pendingGatesAtRebuild,
  resolveNode,
  rulesCovering,
  rulesFor,
  settleGates,
} from "./evaluate.js";
import {
  type AuthzMatrix,
  loadAuthzMatrix,
  permissionsForRole,
  roleHasPermission,
} from "./matrix.js";
import {
  isAncestorOrSelf,
  isPendingGate,
  membershipExpired,
  pathDepth,
  veiledBy,
} from "./model.js";
import { type RebuildResult, rebuildEffectiveAccess } from "./rebuild.js";
import {
  EffectiveAccessRepo,
  GrantRepo,
  PolicyRepo,
  PrincipalRepo,
  ruleOfRow,
  staffOnlyNodes,
  veilLocation,
} from "./repos/access-repo.js";
import { type MembershipLite, membershipSummary, staleWorkspaces } from "./repos/state-repo.js";

/*
 * `AuthzPort` over Postgres (ADR-0014, ADR-0032). Reads go to `core.effective_access`
 * (materialised); writes to grants/groups/policies/memberships call `bump()` in their own
 * transaction, which moves `workspace.acl_version` and publishes `acl.changed`; the
 * subscriber rebuilds; `ensureFresh()` rebuilds lazily when a read finds the table behind
 * the version. Decisions are cached per (workspace, membership, acl_version) for 60 s.
 */

/** How staff RBAC maps onto a resource kind: capability → permission that grants it wholesale. */
export interface ResourceKindPolicy {
  readonly staff: Partial<Readonly<Record<Capability, string>>>;
}

export interface AuthzServiceOptions {
  readonly db: Database;
  /** The merged permission catalogue (module registry); read lazily. */
  readonly permissionCatalogue: () => Iterable<string>;
  /** Registered by modules for their resource kinds. */
  readonly resourceKinds?: Readonly<Record<string, ResourceKindPolicy>> | undefined;
  readonly matrix?: AuthzMatrix | undefined;
  /** Decision cache ceiling. Default 60 s (§6.4). */
  readonly cacheTtlMs?: number | undefined;
  /** How long a read trusts its last look at `acl_version`. Default 5 s. */
  readonly versionTtlMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export interface AuthzService extends AuthzPort {
  /**
   * Does this staff membership hold the permission (RBAC)? External kinds never do, and neither
   * does a membership that is not `active` or whose `expiresAt` has passed (P1-01). Callers pass
   * the membership row; `expiresAt` is optional only so module-kit's narrower type still fits.
   */
  hasPermission(
    membership: {
      readonly kind: "staff" | "external";
      readonly role: string;
      readonly status: string;
      readonly expiresAt?: Date | null | undefined;
    },
    permission: string,
  ): boolean;
  /**
   * Call inside the transaction that changed grants / groups / policies / memberships /
   * attestations: `acl_version++` and `acl.changed` on the outbox. Returns the new version.
   */
  bump(tx: Tx, ctx: TenantContext, cause: string): Promise<number>;
  /** Rebuilds when `effective_access` is behind `acl_version`. Cheap when current. */
  ensureFresh(workspaceId: string): Promise<void>;
  /** Unconditional rebuild in its own system transaction. */
  rebuild(workspaceId: string): Promise<RebuildResult>;
  invalidate(workspaceId: string): void;
  /** Outbox subscriptions the composition root registers. */
  readonly subscriptions: readonly Subscription[];
  /** The hourly reconciler. */
  readonly jobs: readonly JobDefinition[];
}

/**
 * `acl_version++` plus `acl.changed` on the outbox, inside the caller's transaction. Kernel
 * services that change grants / groups / memberships call this directly; the service's
 * `bump()` adds cache invalidation on top.
 */
export async function bumpAcl(tx: Tx, ctx: TenantContext, cause: string): Promise<number> {
  const v = await bumpAclVersionInTx(tx, ctx.workspaceId);
  await publish(tx, ctx, "acl.changed", { aclVersion: v, cause });
  return v;
}

/**
 * Whether the resource lies at or below a staff-only data-room folder (E3.5, ADR-0053), located
 * from its own row. The rebuild applies the same veil to the materialised rows.
 */
async function isVeiled(tx: Tx, ctx: TenantContext, resource: ResourceRef): Promise<boolean> {
  const staffOnly = await staffOnlyNodes(tx, ctx);
  if (staffOnly.length === 0) return false;
  return veiledBy(await veilLocation(tx, ctx, resource), staffOnly);
}

interface MembershipCache {
  readonly membership: MembershipLite | undefined;
  readonly rows: readonly EffectiveAccessRow[];
  readonly until: number;
}

export function createAuthzService(options: AuthzServiceOptions): AuthzService {
  const { db } = options;
  const matrix = options.matrix ?? loadAuthzMatrix();
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const cacheTtl = options.cacheTtlMs ?? 60_000;
  const versionTtl = options.versionTtlMs ?? 5_000;
  const resourceKinds = options.resourceKinds ?? {};

  const versions = new Map<string, { value: number; until: number }>();
  const memberships = new Map<string, MembershipCache>();
  const inflight = new Map<string, Promise<RebuildResult>>();

  function invalidate(workspaceId: string): void {
    versions.delete(workspaceId);
    for (const key of memberships.keys())
      if (key.startsWith(`${workspaceId}:`)) memberships.delete(key);
  }

  async function currentVersion(workspaceId: string): Promise<number> {
    const hit = versions.get(workspaceId);
    const t = now().getTime();
    if (hit !== undefined && hit.until > t) return hit.value;
    const ctx = systemContext(workspaceId);
    const v = await db.withTenant(ctx, (tx) => readAclVersion(tx, workspaceId));
    versions.set(workspaceId, { value: v, until: t + versionTtl });
    return v;
  }

  function rebuild(workspaceId: string): Promise<RebuildResult> {
    const running = inflight.get(workspaceId);
    if (running !== undefined) return running;
    const ctx = systemContext(workspaceId);
    const p = db
      .withTenant(ctx, (tx) => rebuildEffectiveAccess(tx, ctx, { now: now() }))
      .then((r) => {
        invalidate(workspaceId);
        versions.set(workspaceId, { value: r.aclVersion, until: now().getTime() + versionTtl });
        log("authz.rebuilt", {
          workspaceId,
          aclVersion: r.aclVersion,
          rows: r.rows,
          memberships: r.memberships,
          durationMs: r.durationMs,
        });
        return r;
      })
      .finally(() => inflight.delete(workspaceId));
    inflight.set(workspaceId, p);
    return p;
  }

  async function ensureFresh(workspaceId: string): Promise<void> {
    const ctx = systemContext(workspaceId);
    const [version, state] = await Promise.all([
      currentVersion(workspaceId),
      db.withTenant(ctx, (tx) => new EffectiveAccessRepo(ctx, tx).state()),
    ]);
    if (state === undefined || Number(state.aclVersion) < version) {
      log("authz.stale", { workspaceId, built: state?.aclVersion ?? null, version });
      await rebuild(workspaceId);
    }
  }

  /**
   * The membership and its rows, rebuilt first when a row the answer may rest on has passed its
   * `expires_at` (a grant's validity, an attestation's age or expiry, the membership's own
   * expiry). Without this, time-driven changes wait for the hourly reconciler — fail-open for up
   * to an hour. One rebuild at most: the rebuilt rows' expiries lie in the future.
   */
  async function currentRows(principal: AuthzPrincipal, version: number): Promise<MembershipCache> {
    const loaded = await loadMembership(principal, version);
    const t = now().getTime();
    if (!loaded.rows.some((r) => r.expiresAt !== null && r.expiresAt.getTime() <= t)) {
      return loaded;
    }
    log("authz.expired", { workspaceId: principal.workspaceId });
    await rebuild(principal.workspaceId);
    return loadMembership(principal, version);
  }

  async function loadMembership(
    principal: AuthzPrincipal,
    version: number,
  ): Promise<MembershipCache> {
    const key = `${principal.workspaceId}:${principal.membershipId}:${version}`;
    const hit = memberships.get(key);
    const t = now().getTime();
    if (hit !== undefined && hit.until > t) return hit;
    const ctx = systemContext(principal.workspaceId);
    const value = await db.withTenant(ctx, async (tx) => ({
      membership: await membershipSummary(tx, ctx, principal.membershipId),
      rows: await new EffectiveAccessRepo(ctx, tx).listForMembership(principal.membershipId),
      until: t + cacheTtl,
    }));
    memberships.set(key, value);
    return value;
  }

  /** The resource's own row, else the deepest row whose path is an ancestor (any kind, ADR-0034). */
  function nearestRow(
    rows: readonly EffectiveAccessRow[],
    resource: ResourceRef,
  ): EffectiveAccessRow | undefined {
    let best: EffectiveAccessRow | undefined;
    let bestDepth = -1;
    for (const r of rows) {
      if (r.resourceKind === resource.kind && r.resourceId === resource.id) return r;
      if (
        resource.path !== undefined &&
        r.resourcePath !== null &&
        isAncestorOrSelf(r.resourcePath, resource.path)
      ) {
        const d = pathDepth(r.resourcePath);
        if (d > bestDepth) {
          best = r;
          bestDepth = d;
        }
      }
    }
    return best;
  }

  function gatesOf(row: EffectiveAccessRow): PendingGate[] {
    const raw = row.pendingGates;
    return Array.isArray(raw) ? raw.filter(isPendingGate) : [];
  }

  function staffCapabilities(m: MembershipLite, kind: string): Capability[] {
    if (m.kind !== "staff") return [];
    const policy = resourceKinds[kind];
    if (policy === undefined) return [];
    return CAPABILITIES.filter((cap) => {
      const perm = policy.staff[cap];
      return perm !== undefined && roleHasPermission(m.role, perm, matrix);
    });
  }

  /**
   * A materialised row past its own `expires_at` grants nothing (review R1-A6). `currentRows`
   * rebuilds when it sees one, but a check that *joins* a rebuild already in flight gets rows
   * computed at that rebuild's earlier `now` — a grant that lapsed in between would still read
   * as live. Stale-and-expired fails closed; the next request rebuilds for real.
   */
  function rowExpired(row: EffectiveAccessRow): boolean {
    return row.expiresAt !== null && row.expiresAt.getTime() <= now().getTime();
  }

  /**
   * `active` and not past its own `expires_at` (P1-01): the only memberships access rests on. A
   * delegate also needs its principal `active` and unexpired (E3.2) — checked here, not only in the
   * rebuild, so the answer changes the instant the principal lapses, before any rebuild runs.
   */
  function isLive(m: MembershipLite | undefined): m is MembershipLite {
    if (m === undefined || m.status !== "active" || membershipExpired(m.expiresAt, now()))
      return false;
    if (m.principal === null) return true;
    return m.principal.status === "active" && !membershipExpired(m.principal.expiresAt, now());
  }

  function decide(
    m: MembershipLite | undefined,
    row: EffectiveAccessRow | undefined,
    resource: ResourceRef,
    capability: Capability,
    facts: RequestFacts | undefined,
  ): AccessDecision {
    if (!isLive(m)) {
      return { allowed: false, capabilities: [], pendingGates: [], reason: "not_member" };
    }
    const viaRole = staffCapabilities(m, resource.kind);
    const viaGrant = row && !rowExpired(row) ? (row.capabilities as Capability[]) : [];
    const capabilities = CAPABILITIES.filter((c) => viaRole.includes(c) || viaGrant.includes(c));
    if (viaRole.includes(capability)) {
      return { allowed: true, capabilities, pendingGates: [], reason: "granted" };
    }
    if (!viaGrant.includes(capability)) {
      return { allowed: false, capabilities, pendingGates: [], reason: "no_grant" };
    }
    const pending = settleGates(row ? gatesOf(row) : [], facts);
    if (pending.length > 0) {
      return { allowed: false, capabilities, pendingGates: pending, reason: "gated" };
    }
    return { allowed: true, capabilities, pendingGates: [], reason: "granted" };
  }

  const subscriptions: Subscription[] = [
    {
      topic: "acl.changed",
      id: "authz.rebuild",
      handler: async (event, { tx, ctx }) => {
        if (ctx.actorKind === "host") return;
        const r = await rebuildEffectiveAccess(tx, ctx as TenantContext, { now: now() });
        invalidate(r.workspaceId);
        log("authz.rebuilt", {
          workspaceId: r.workspaceId,
          aclVersion: r.aclVersion,
          rows: r.rows,
          cause: (event.payload as { cause?: string }).cause ?? null,
          durationMs: r.durationMs,
        });
      },
    },
  ];

  const jobs: JobDefinition[] = [
    {
      name: "authz.reconcile",
      cron: "25 * * * *",
      handler: async () => {
        let rebuilt = 0;
        for (const workspaceId of await listLiveWorkspaceIds(db)) {
          const ctx = systemContext(workspaceId);
          const stale = await db.withTenant(ctx, (tx) => staleWorkspaces(tx, ctx, now()));
          if (!stale) continue;
          await rebuild(workspaceId);
          rebuilt += 1;
        }
        log("authz.reconciled", { rebuilt });
      },
    },
  ];

  return {
    permissionsFor: (membership, catalogue) => permissionsForRole(membership, catalogue, matrix),
    hasPermission: (membership, permission) =>
      membership.kind === "staff" &&
      membership.status === "active" &&
      !membershipExpired(membership.expiresAt, now()) &&
      roleHasPermission(membership.role, permission, matrix),

    async bump(tx, ctx, cause) {
      const v = await bumpAcl(tx, ctx, cause);
      invalidate(ctx.workspaceId);
      return v;
    },
    ensureFresh,
    rebuild,
    invalidate,
    subscriptions,
    jobs,

    async check(principal, resource, capability, facts) {
      await ensureFresh(principal.workspaceId);
      const version = await currentVersion(principal.workspaceId);
      const { membership, rows } = await currentRows(principal, version);
      return decide(membership, nearestRow(rows, resource), resource, capability, facts);
    },

    async listAccessible(principal, kind, facts) {
      await ensureFresh(principal.workspaceId);
      const version = await currentVersion(principal.workspaceId);
      const { membership, rows } = await currentRows(principal, version);
      if (!isLive(membership)) return [];
      return rows
        .filter(
          (r) =>
            r.resourceKind === kind &&
            !rowExpired(r) &&
            (r.capabilities as string[]).includes("view"),
        )
        .map((r) => ({
          kind: r.resourceKind,
          id: r.resourceId,
          path: r.resourcePath ?? undefined,
          capabilities: r.capabilities as Capability[],
          pendingGates: settleGates(gatesOf(r), facts),
          expiresAt: r.expiresAt ?? undefined,
        }));
    },

    async whoHasAccess(workspaceId, resource) {
      const ctx = systemContext(workspaceId);
      const t = now();
      return db.withTenant(ctx, async (tx) => {
        const principals = await new PrincipalRepo(ctx, tx).listActive();
        const rules = (await new GrantRepo(ctx, tx).listForResource(resource)).map(ruleOfRow);
        const gates = await new PolicyRepo(ctx, tx).listLiveGates();
        const veiled = await isVeiled(tx, ctx, resource);
        const holders: AccessHolder[] = [];
        for (const p of principals) {
          const mine = rulesCovering(rulesFor(rules, p), resource);
          if (mine.length === 0) continue;
          const resolved = resolveNode(mine, resource, t);
          // E3.5: inside a staff-only folder an external holder's rules are shown but grant nothing.
          const veil = veiled && p.kind === "external";
          holders.push({
            membershipId: p.membershipId,
            capabilities: veil ? [] : resolved.capabilities,
            pendingGates: veil ? [] : pendingGatesAtRebuild(gates, p, resource, t),
            via: resolved.rules,
            expiresAt: veil ? undefined : resolved.expiresAt,
          });
        }
        return holders;
      });
    },

    async explain(principal, resource, facts) {
      const ctx = systemContext(principal.workspaceId);
      const t = now();
      return db.withTenant(ctx, async (tx) => {
        const aclVersion = await readAclVersion(tx, principal.workspaceId);
        const m = await membershipSummary(tx, ctx, principal.membershipId);
        const p = await new PrincipalRepo(ctx, tx).byId(principal.membershipId);
        const rules = (await new GrantRepo(ctx, tx).listForResource(resource)).map(ruleOfRow);
        const gates = await new PolicyRepo(ctx, tx).listLiveGates();
        // An expired membership explains as "not a member", the answer check() gives (P1-01);
        // so does a delegate whose principal is not live (E3.2).
        if (m === undefined || p === undefined || !isLive(m)) {
          return {
            membershipId: principal.membershipId,
            resource,
            decision: { allowed: false, capabilities: [], pendingGates: [], reason: "not_member" },
            rules: [],
            aclVersion,
          };
        }
        const resolved = resolveNode(rulesFor(rules, p), resource, t);
        const viaRole = staffCapabilities(m, resource.kind);
        // E3.5: the staff-only veil, exactly as the rebuild materialises it.
        const viaGrant =
          p.kind === "external" && (await isVeiled(tx, ctx, resource)) ? [] : resolved.capabilities;
        const capabilities = CAPABILITIES.filter(
          (c) => viaRole.includes(c) || viaGrant.includes(c),
        );
        const pending = settleGates(pendingGatesAtRebuild(gates, p, resource, t), facts);
        const canView = capabilities.includes("view");
        const decision: AccessDecision = !canView
          ? { allowed: false, capabilities, pendingGates: [], reason: "no_grant" }
          : viaRole.includes("view")
            ? { allowed: true, capabilities, pendingGates: [], reason: "granted" }
            : pending.length > 0
              ? { allowed: false, capabilities, pendingGates: pending, reason: "gated" }
              : { allowed: true, capabilities, pendingGates: [], reason: "granted" };
        return {
          membershipId: principal.membershipId,
          resource,
          decision,
          rules: resolved.rules,
          aclVersion,
        };
      });
    },
  };
}
