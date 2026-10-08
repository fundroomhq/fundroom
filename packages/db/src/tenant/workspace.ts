import { and, eq, isNull, sql } from "drizzle-orm";
import { type Workspace, workspace } from "../schema/core.js";
import type { Database, Tx } from "./database.js";

/**
 * Workspace lookup for tenant resolution (EXECUTION_PLAN §3.3 step 1, design/06 §3).
 * Runs in host context: it is the one place that may see every workspace row.
 *
 * `TENANCY_MODE=single` (the default "few clicks" install) routes every request to the
 * sole workspace; `multi` resolves by slug from the Host header or path (E0.6 middleware).
 * No schema difference between the modes.
 */
export const TENANCY_MODES = ["single", "multi"] as const;
export type TenancyMode = (typeof TENANCY_MODES)[number];

export type ResolvedWorkspace = Pick<
  Workspace,
  | "id"
  | "slug"
  | "name"
  | "offeringStatus"
  | "settings"
  | "settingsSchemaVersion"
  | "aclVersion"
  /** E2.8: the workspace's default UI/email language (`core.workspace.default_locale`). */
  | "defaultLocale"
  /**
   * E3.8: staff must sign in through the workspace's SSO connection (`core.workspace.sso_enforced`,
   * mirrored from the connection). Read from the resolved row so enforcement costs no query.
   */
  | "ssoEnforced"
  /**
   * E3.8: the live enabled SSO connection's id and version (`core.workspace.sso_connection_*`,
   * mirrored from the connection); a bound session minted under another id/version is ignored.
   */
  | "ssoConnectionId"
  | "ssoConnectionVersion"
  /**
   * E3.10: the cell serving the workspace. With CONTROL_PLANE=on a request for a workspace on
   * another cell is answered 421 `wrong_cell` before any session work.
   */
  | "cellId"
  /**
   * E3.11: the region of the workspace's cell (`core.workspace.data_region`, derived by trigger);
   * null only before a cell exists. `'default'` = no region declared yet (placeholder).
   */
  | "dataRegion"
  /**
   * E3.10: `active` | `pending_review` | `suspended`, and why (`suspendedReason`). The status
   * guard (`apps/server/src/middleware/workspace-status.ts`) reads these per request, so a
   * suspension takes effect on the next request with no cache to drop in multi mode.
   */
  | "status"
  | "suspendedReason"
  /** E3.10: `core.plan.id`; null = unlimited (quotas are only enforced when set). */
  | "planId"
> & {
  /**
   * Hostname of the workspace's `active` custom domain, else null. Every public URL the server
   * mints for this workspace prefers it (E2.1): email links, `canonicalOrigin`, `workspaceUrl`.
   *
   * Because every request already resolves its workspace, this is never cold — which is what
   * lets `workspaceUrl` stay synchronous. A sync resolver that can be cold sends the first mail
   * after every restart on the wrong origin (the E1.7 lesson).
   */
  readonly primaryHost: string | null;
  /**
   * A-3 (ADR-0063): the raw `core.plan.limits` jsonb of the workspace's plan; null without a plan.
   * Raw on purpose — this package stays free of domain imports; consumers read it through
   * `entitlementsOf` (`@fundroom/domain`), whose backstop parser tolerates anything. Carried on the
   * resolved row so a plan gate costs no query and a plan change takes effect on the next request
   * in multi mode (single mode: within the resolver's 30 s cache, like every other field here).
   */
  readonly planLimits: unknown;
};

/**
 * `core.custom_domain` is read here as a correlated scalar subquery rather than a join.
 * `custom_domain_one_per_workspace_idx` already guarantees at most one verified hostname per
 * workspace, so today a join could not multiply the outer row — but `findSoleWorkspace` counts
 * rows to detect a mis-set `TENANCY_MODE`, and a shape that cannot multiply the outer row at all
 * keeps that reading correct however the exclusivity rule later moves. The `ORDER BY … LIMIT 1`
 * is kept for the same reason: the chosen host stays deterministic, so `canonicalOrigin` cannot
 * flip between requests. Served by `custom_domain_active_idx`.
 *
 * All three finders run in host context, which the table's fence admits (see the migration).
 *
 * The outer column is interpolated as `${workspace}.${workspace.id}`, not `${workspace.id}`:
 * drizzle emits a bare `"id"` for a column inside a select list, and `core.custom_domain` has an
 * `id` of its own, so the unqualified form silently binds to `cd.id` and the subquery always
 * returns null.
 */
const primaryHostSql = sql<string | null>`(
    SELECT cd.hostname::text
    FROM core.custom_domain cd
    WHERE cd.workspace_id = ${workspace}.${workspace.id}
      AND cd.status = 'active'
      AND cd.deleted_at IS NULL
    ORDER BY cd.activated_at NULLS LAST, cd.id
    LIMIT 1
  )`;

/**
 * The plan's `limits`, as a correlated scalar subquery for the same reason as `primaryHostSql`
 * (the shape cannot multiply the outer row), and with the outer column qualified for the same
 * reason too: `core.plan` has an `id` of its own. `core.plan` is readable in any context
 * (`plan_read`), so this works on a tenant transaction as well as the host one.
 */
const planLimitsSql = sql<unknown>`(
    SELECT p.limits
    FROM core.plan p
    WHERE p.id = ${workspace}.${workspace.planId}
  )`;

const columns = {
  id: workspace.id,
  slug: workspace.slug,
  name: workspace.name,
  offeringStatus: workspace.offeringStatus,
  settings: workspace.settings,
  settingsSchemaVersion: workspace.settingsSchemaVersion,
  aclVersion: workspace.aclVersion,
  defaultLocale: workspace.defaultLocale,
  ssoEnforced: workspace.ssoEnforced,
  ssoConnectionId: workspace.ssoConnectionId,
  ssoConnectionVersion: workspace.ssoConnectionVersion,
  cellId: workspace.cellId,
  dataRegion: workspace.dataRegion,
  status: workspace.status,
  suspendedReason: workspace.suspendedReason,
  planId: workspace.planId,
  primaryHost: primaryHostSql,
  planLimits: planLimitsSql,
};

export class SingleTenantError extends Error {
  override readonly name = "SingleTenantError";
}

export async function findWorkspaceBySlug(
  db: Database,
  slug: string,
): Promise<ResolvedWorkspace | undefined> {
  const normalized = slug.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  return db.withHost(async (tx) => {
    const rows = await tx
      .select(columns)
      .from(workspace)
      .where(and(eq(workspace.slug, normalized), isNull(workspace.deletedAt)))
      .limit(1);
    return rows[0];
  });
}

/**
 * The one workspace of a single-tenant install. `undefined` before setup has run
 * (the caller shows the setup wizard); throws if more than one exists, because that
 * means the operator switched modes without cleaning up.
 */
/** A live workspace by id (jobs that run per workspace and need its slug, name and settings). */
export async function findWorkspaceById(
  db: Database,
  id: string,
): Promise<ResolvedWorkspace | undefined> {
  return db.withHost(async (tx) => {
    const rows = await tx
      .select(columns)
      .from(workspace)
      .where(and(eq(workspace.id, id), isNull(workspace.deletedAt)))
      .limit(1);
    return rows[0];
  });
}

export async function findSoleWorkspace(db: Database): Promise<ResolvedWorkspace | undefined> {
  return db.withHost(async (tx) => {
    const rows = await tx
      .select(columns)
      .from(workspace)
      .where(isNull(workspace.deletedAt))
      .orderBy(workspace.createdAt)
      .limit(2);
    if (rows.length > 1) {
      throw new SingleTenantError(
        "TENANCY_MODE=single but more than one workspace exists; set TENANCY_MODE=multi or delete the extra workspace",
      );
    }
    return rows[0];
  });
}

export interface WorkspaceResolver {
  readonly mode: TenancyMode;
  /** `slug` is ignored in single mode. Returns undefined for unknown/absent workspaces. */
  resolve(slug?: string): Promise<ResolvedWorkspace | undefined>;
  /** Drops the single-tenant cache (the setup wizard just created the workspace). */
  invalidate(): void;
}

export interface ResolverOptions {
  /** Cache TTL for the single-tenant lookup (workspaces are created once). Default 30 s. */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

export function createWorkspaceResolver(
  db: Database,
  mode: TenancyMode,
  options: ResolverOptions = {},
): WorkspaceResolver {
  const cacheMs = options.cacheMs ?? 30_000;
  const now = options.now ?? Date.now;
  let cached: { value: ResolvedWorkspace; until: number } | undefined;

  return {
    mode,
    async resolve(slug) {
      if (mode === "multi") {
        return slug === undefined ? undefined : findWorkspaceBySlug(db, slug);
      }
      if (cached && cached.until > now()) return cached.value;
      const ws = await findSoleWorkspace(db);
      cached = ws ? { value: ws, until: now() + cacheMs } : undefined;
      return ws;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

export interface CreateWorkspaceInput {
  readonly slug: string;
  readonly name: string;
  /**
   * E3.11: the id the slug was claimed under in the cell directory (placement hooks). Absent:
   * the column default.
   */
  readonly id?: string | undefined;
  /** E3.11: the cell (must exist in `core.cell`). Absent: the column default (`default`). */
  readonly cellId?: string | undefined;
}

/** Host-level create (setup wizard, host admin). Slug is normalised; uniqueness comes from the index. */
export async function createWorkspace(
  db: Database,
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  const slug = input.slug.trim().toLowerCase();
  return db.withHost(async (tx) => {
    const rows = await tx
      .insert(workspace)
      .values({
        slug,
        name: input.name.trim(),
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.cellId === undefined ? {} : { cellId: input.cellId }),
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("insert returned no row");
    return row;
  });
}

/**
 * The caches a workspace deletion has to drop.
 *
 * Structurally typed so `packages/db` depends on nothing: `lookup` is
 * `@fundroom/custom-domains`' hostname → workspace cache and `workspaces` is the single-tenant
 * `WorkspaceResolver`. **Required, not optional** (E2.1 M9): a soft delete that dropped neither
 * left a closed portal routing — and a certificate still mintable for it — for up to the 60-second
 * lookup TTL, and the way that bug happened was nobody remembering the cache existed. A parameter
 * the compiler asks for cannot be forgotten by the next caller either.
 */
export interface WorkspaceDeletionCaches {
  /** Cleared entirely: a workspace may hold several hostnames and this path knows none of them. */
  readonly lookup: { invalidate(hostname?: string): void };
  /** The single-tenant `ResolvedWorkspace` cache, which carries `primaryHost`. */
  readonly workspaces: { invalidate(): void };
}

/**
 * Soft-deletes a workspace (`deleted_at`); rows stay for the audit chain and the retention
 * window. Returns false when it was already gone. Host-level (`seed-demo --reset`, host admin).
 *
 * Invalidates both caches on success, because `core.custom_domain` rows are *not* deleted with
 * the workspace — `findIssuableByHostname` excludes a deleted workspace on a fresh read, so the
 * only thing that could still route it is a cached entry.
 */
export async function deleteWorkspace(
  db: Database,
  workspaceId: string,
  caches: WorkspaceDeletionCaches,
): Promise<boolean> {
  const deleted = await db.withHost(async (tx) => {
    const rows = await tx
      .update(workspace)
      .set({ deletedAt: new Date() })
      .where(and(eq(workspace.id, workspaceId), isNull(workspace.deletedAt)))
      .returning({ id: workspace.id });
    return rows.length > 0;
  });
  if (deleted) {
    caches.lookup.invalidate();
    caches.workspaces.invalidate();
  }
  return deleted;
}

/**
 * Ids of every workspace that may act on the outside world — not deleted AND `status = 'active'`
 * — oldest first. Jobs that SEND (mail, channel posts, outbound webhooks, vendor syncs) iterate
 * this (§7; E3.10 FR1 R1-M1): a held (`pending_review`) or suspended workspace keeps its queued
 * work, which resumes when it is active again. Maintenance that must run whatever the status
 * (retention, purge, erasure, key rewrap, audit checkpoints, sweeps) uses `listLiveWorkspaceIds`.
 */
export async function listActiveWorkspaceIds(db: Database): Promise<string[]> {
  return db.withHost(async (tx) => {
    const rows = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(and(isNull(workspace.deletedAt), eq(workspace.status, "active")))
      .orderBy(workspace.createdAt);
    return rows.map((r) => r.id);
  });
}

/**
 * Ids of every workspace not soft-deleted, whatever its control-plane status, oldest first.
 * Host-level maintenance iterates this: retention, purge, reconciliation, sweeps, key rewrap,
 * audit checkpoints — work a held or suspended workspace still needs (E3.10 FR1).
 */
export async function listLiveWorkspaceIds(db: Database): Promise<string[]> {
  return db.withHost(async (tx) => {
    const rows = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(isNull(workspace.deletedAt))
      .orderBy(workspace.createdAt);
    return rows.map((r) => r.id);
  });
}

/**
 * Whether the workspace is active right now (not deleted, `status = 'active'`), read on the
 * caller's transaction — tenant (the fence admits the current workspace's own row) or host.
 * Per-workspace send handlers check it at send time and DEFER (leave the work queued) when it is
 * false; SCIM refuses (E3.10 FR1). A plain read, no lock. Unknown workspace → false.
 */
export async function workspaceIsActive(tx: Tx, workspaceId: string): Promise<boolean> {
  const rows = await tx
    .select({ status: workspace.status, deletedAt: workspace.deletedAt })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  const row = rows[0];
  return row !== undefined && row.deletedAt === null && row.status === "active";
}

/**
 * A live workspace's plan id and that plan's raw `limits` (A-3, ADR-0063), read on the caller's
 * transaction — tenant (the fence admits the workspace's own row; `core.plan` is readable in any
 * context) or host. For jobs and services that hold only an id (`EntitlementsPort.forWorkspace`);
 * a request already has both on its `ResolvedWorkspace`. A plain read, no lock. `undefined` when
 * the workspace is not visible or deleted.
 */
export async function readWorkspacePlanLimits(
  tx: Tx,
  workspaceId: string,
): Promise<{ readonly planId: string | null; readonly planLimits: unknown } | undefined> {
  const rows = await tx
    .select({ planId: workspace.planId, planLimits: planLimitsSql })
    .from(workspace)
    .where(and(eq(workspace.id, workspaceId), isNull(workspace.deletedAt)))
    .limit(1);
  return rows[0];
}

/** Bumps `acl_version` so the effective_access rebuild job (ADR-0014) knows it is stale. */
export async function bumpAclVersion(db: Database, workspaceId: string): Promise<void> {
  await db.withHost(async (tx) => {
    await tx
      .update(workspace)
      .set({ aclVersion: sql`${workspace.aclVersion} + 1` })
      .where(eq(workspace.id, workspaceId));
  });
}

/**
 * Same as `bumpAclVersion` but inside the caller's tenant transaction, so the version moves
 * atomically with the grant / group / membership change that made it stale. Returns the new
 * version (the caller publishes `acl.changed` with it). Works under a tenant context because
 * `core.workspace`'s fence admits the current workspace's own row.
 */
export async function bumpAclVersionInTx(tx: Tx, workspaceId: string): Promise<number> {
  const rows = await tx
    .update(workspace)
    .set({ aclVersion: sql`${workspace.aclVersion} + 1` })
    .where(eq(workspace.id, workspaceId))
    .returning({ v: workspace.aclVersion });
  const v = rows[0]?.v;
  if (v === undefined) throw new Error("workspace not visible to this transaction");
  // Marks the transaction as bumped for this workspace (transaction-local). The data-room's
  // commit-time location triggers (`dataroom.bump_acl_on_location_change`, data-room migration
  // 0006) read it and skip their own bump: the version already moves with this commit.
  await tx.execute(sql`SELECT set_config('authz.acl_bumped', ${workspaceId}, true)`);
  return Number(v);
}

/** Reads the current `acl_version` (tenant or host context). */
export async function readAclVersion(tx: Tx, workspaceId: string): Promise<number> {
  const rows = await tx
    .select({ v: workspace.aclVersion })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return Number(rows[0]?.v ?? 0);
}

/**
 * Row-locks the workspace `FOR NO KEY UPDATE` until the transaction ends — the first half of the
 * global lock order (E3.5 LX): **workspace row → audit chain**. `lockAuditChain` (every audit
 * insert) takes it before the chain's advisory lock, and so does every search-index write, so a
 * transaction that audits always holds the row first, whatever it did before. A no-op when the
 * transaction already holds the row (this mode or stronger: an `UPDATE` of `core.workspace`, a
 * `FOR UPDATE`). Harmless when no row is visible (the platform pseudo-workspace has none).
 *
 * `NO KEY UPDATE`, not `SHARE`: two transactions holding `SHARE` that both go on to audit (or to
 * bump `acl_version`) would each wait for the other to upgrade — so nothing locks this row
 * `FOR SHARE` / `FOR KEY SHARE` explicitly and then writes. `NO KEY UPDATE` does not conflict
 * with the `KEY SHARE` a foreign-key insert takes (outbox, any workspace-scoped table).
 */
export async function lockWorkspaceRow(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(
    sql`SELECT 1 FROM core.workspace WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`,
  );
}

/**
 * The workspace's settings and offering status as the caller's transaction sees them, row-locked
 * `FOR NO KEY UPDATE` until commit — for a decision that depends on them (an approval under the
 * current offering mode, a Q&A write under the current Q&A settings) and for a read-modify-write
 * of `settings`, which `updateWorkspaceSettings` replaces whole. Unlike the resolver's cached
 * `ResolvedWorkspace`, never stale. Tenant or system context.
 *
 * One mode on purpose (E3.5 LX, see `lockWorkspaceRow`): not `SHARE` — every caller writes and
 * audits afterwards, and two share holders would deadlock on the audit's upgrade; not `UPDATE` —
 * that conflicts with the `KEY SHARE` of every foreign-key insert in the workspace, so a settings
 * writer would queue behind (and in front of) unrelated inserters. `NO KEY UPDATE` still
 * serialises two settings writers.
 */
export async function lockWorkspaceFacts(
  tx: Tx,
  workspaceId: string,
): Promise<
  { readonly settings: unknown; readonly offeringStatus: Workspace["offeringStatus"] } | undefined
> {
  const rows = await tx
    .select({ settings: workspace.settings, offeringStatus: workspace.offeringStatus })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1)
    .for("no key update");
  return rows[0];
}

/**
 * REPLACES `workspace.settings` (jsonb) with `settings`, whole, inside the caller's transaction.
 * Only for a caller that owns the whole document: one that read it with `lockWorkspaceFacts` in
 * this transaction (and carries every other key over), or one writing a row nobody else can see
 * yet (provisioning, import). Built from anything else — the resolver's cached copy above all —
 * it restores stale values of every block a concurrent writer just changed (A-3 R2 M1: a
 * branding save racing a Q&A switch-off turned Q&A back on, on a plan without `qa`). A writer
 * that changes one block uses `updateWorkspaceSettingsBlock`.
 */
export async function updateWorkspaceSettings(
  tx: Tx,
  workspaceId: string,
  settings: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rows = await tx
    .update(workspace)
    .set({ settings })
    .where(eq(workspace.id, workspaceId))
    .returning({ settings: workspace.settings });
  const out = rows[0]?.settings;
  if (out === undefined) throw new Error("workspace not visible to this transaction");
  return out as Record<string, unknown>;
}

/**
 * Sets ONE top-level block of `workspace.settings` (`branding`, `legal`, `access`, …) to `value`
 * in a single statement, inside the caller's transaction, and returns the whole document as
 * stored afterwards. Every other key is left exactly as the row holds it at that moment — the
 * `UPDATE` re-reads a row a concurrent writer changed before it applies (`settings || …`), so a
 * writer of one block can never undo another writer's change to a different block, whatever
 * copy of the settings it started from. (`updateWorkspaceSettings`, by contrast, replaces the
 * whole document.) A stored value that is not a JSON object is treated as `{}`.
 *
 * `value` replaces the block whole. A writer that merges a patch INTO its block reads the block
 * first with `lockWorkspaceFacts` in the same transaction, so two writers of the same block
 * serialise instead of one undoing the other's fields. Lock order: the row is taken here (or
 * by that lock), so call it before anything that audits — `lockAuditChain` takes the workspace
 * row first anyway, so after an audit in the same transaction this re-takes a row already held.
 */
export async function updateWorkspaceSettingsBlock(
  tx: Tx,
  workspaceId: string,
  key: string,
  value: unknown,
): Promise<Record<string, unknown>> {
  if (key.length === 0) throw new Error("a settings block needs a key");
  if (value === undefined) throw new Error(`settings block ${key}: undefined is not a value`);
  const rows = await tx
    .update(workspace)
    .set({
      settings: sql`(CASE WHEN jsonb_typeof(${workspace.settings}) = 'object' THEN ${workspace.settings} ELSE '{}'::jsonb END) || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)`,
    })
    .where(eq(workspace.id, workspaceId))
    .returning({ settings: workspace.settings });
  const out = rows[0]?.settings;
  if (out === undefined) throw new Error("workspace not visible to this transaction");
  return out as Record<string, unknown>;
}

/**
 * Sets `workspace.default_locale` (E2.8, `PUT /workspace/locale`) inside the caller's
 * transaction and returns the previous value. A column rather than a `settings` key, because
 * `updateWorkspaceSettings` replaces the whole jsonb and a concurrent settings write would race it.
 */
export async function updateWorkspaceDefaultLocale(
  tx: Tx,
  workspaceId: string,
  locale: string,
): Promise<{ readonly before: string; readonly after: string }> {
  const prev = await tx
    .select({ locale: workspace.defaultLocale })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1)
    .for("no key update"); // not UPDATE: see `lockWorkspaceFacts`
  const before = prev[0]?.locale;
  if (before === undefined) throw new Error("workspace not visible to this transaction");
  await tx.update(workspace).set({ defaultLocale: locale }).where(eq(workspace.id, workspaceId));
  return { before, after: locale };
}

/**
 * Moves `workspace.offering_status` inside the caller's transaction, so the column and the
 * `core.offering_period` row that evidences the change commit together (ADR-0019, E1.6). The
 * column is the fast read every request makes; the period table is the history counsel asks for.
 */
export async function updateOfferingStatus(
  tx: Tx,
  workspaceId: string,
  status: Workspace["offeringStatus"],
): Promise<Workspace["offeringStatus"]> {
  const rows = await tx
    .update(workspace)
    .set({ offeringStatus: status })
    .where(eq(workspace.id, workspaceId))
    .returning({ offeringStatus: workspace.offeringStatus });
  const out = rows[0]?.offeringStatus;
  if (out === undefined) throw new Error("workspace not visible to this transaction");
  return out;
}
