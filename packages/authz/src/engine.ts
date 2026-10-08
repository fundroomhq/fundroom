import type { Database, TenantContext } from "@fundroom/db";
import type { Subscription } from "@fundroom/events";
import type {
  AccessDecision,
  AccessibleResource,
  AuthzPrincipal,
  Capability,
  EngineState,
  JobDefinition,
  JobQueuePort,
  JsonObject,
  RelationshipEnginePort,
  RelationshipNodeRef,
  RelationshipResource,
  ResourceRef,
} from "@fundroom/ports";
import { CAPABILITIES, RelationshipEngineError } from "@fundroom/ports";
import {
  createEngineStore,
  createLeaseSyncLock,
  type EngineStore,
  type EngineView,
  SYNC_BUSY,
  type SyncLock,
} from "./repos/engine-state-repo.js";
import type { AuthzService } from "./service.js";

/*
 * The external relationship engine behind the authz port (E3.13, ADR-0061 §3).
 *
 * Postgres stays the source of truth: `effective_access` is still materialised (RLS reads it
 * through `core.has_access()`), and every answer starts as the Postgres answer. The engine holds a
 * projection of the raw rules (`buildRelationshipSnapshot`) and is consulted only for EXTERNAL,
 * NON-DELEGATE principals on `check` / `listAccessible`:
 *
 *  - `shadow`: Postgres decides. A sample of checks is replayed against the engine off the request
 *    path (fire-and-forget, at most `shadowConcurrency` in flight, the rest dropped and counted);
 *    each capability on which the two disagree is counted and logged with ids only.
 *  - `enforce`: the capabilities are Postgres ∩ engine — the engine can only narrow. Any engine
 *    error (or a workspace never synced) fails CLOSED: the check is denied (`no_grant`), the list is
 *    empty. A stale engine (synced acl_version behind the workspace's) is still intersected — a new
 *    grant waits for the sync, a revocation never does (Postgres already denies) — and a sync is
 *    kicked.
 *
 * Staff principals and delegated memberships are always Postgres-only (staff RBAC, delegate F4).
 * `permissionsFor`, `hasPermission`, `whoHasAccess`, `explain` are always Postgres.
 *
 * Sync: `acl.changed` → `authz.engine_sync` (stately per workspace): the snapshot is read in one
 * short system transaction, the engine is called with NO transaction open (no pool connection or
 * lock is held across the network), and the outcome is written in a second short transaction. The
 * hourly `authz.engine_reconcile` re-enqueues workspaces whose engine lags or last failed, and drops
 * the stores of workspaces deleted within `DROP_WINDOW_DAYS`.
 */

export const ENGINE_SYNC_JOB = "authz.engine_sync";
export const ENGINE_RECONCILE_JOB = "authz.engine_reconcile";
export const RELATIONSHIP_ENGINE_MODES = ["shadow", "enforce"] as const;
export type RelationshipEngineMode = (typeof RELATIONSHIP_ENGINE_MODES)[number];

/** `listAccessible` filters through BatchCheck in chunks of this size. */
export const ENGINE_BATCH_CHUNK = 50;
/** Deleted workspaces whose engine store the reconciler still drops. */
export const DROP_WINDOW_DAYS = 90;

export type EngineOperation = "check" | "batch_check" | "sync" | "drop" | "health";

/** Counters the composition root binds to its metrics registry. */
export interface RelationshipEngineMetrics {
  /** `fundroom_authz_shadow_mismatch_total{capability,direction,stale}`. */
  shadowMismatch(labels: {
    readonly capability: Capability;
    readonly direction: "pg_only" | "engine_only";
    /** Observed while the engine's synced acl_version lagged (expected, not divergence). */
    readonly stale: boolean;
  }): void;
  /** `fundroom_authz_engine_errors_total{operation,code}`. */
  engineError(labels: { readonly operation: EngineOperation; readonly code: string }): void;
  /** `fundroom_authz_shadow_dropped_total`: shadow comparisons skipped because the pool was full. */
  shadowDropped(): void;
  /** `fundroom_authz_shadow_skipped_total{reason}`: comparisons not attempted (e.g. `too_deep`). */
  shadowSkipped?(reason: string): void;
}

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface WithRelationshipEngineOptions {
  readonly mode: RelationshipEngineMode;
  /** Fraction of eligible `check`s replayed in shadow mode (0..1). */
  readonly sample: number;
  readonly db: Database;
  /** Enqueues `authz.engine_sync` (read lazily: the queue may be built after the service). */
  readonly queue: Pick<JobQueuePort, "send" | "sendInTransaction">;
  readonly log?: Log | undefined;
  readonly metrics?: RelationshipEngineMetrics | undefined;
  readonly now?: (() => Date) | undefined;
  readonly random?: (() => number) | undefined;
  /** Shadow comparisons in flight at once; more are dropped. Default 8. */
  readonly shadowConcurrency?: number | undefined;
  /** How long a read trusts its last look at the engine state / acl_version. Default 5 s. */
  readonly stateTtlMs?: number | undefined;
  /** How long a membership's kind/role is cached. Default 60 s. */
  readonly memberTtlMs?: number | undefined;
  /**
   * Backstop deadline on each check/batchCheck call (the adapter has its own). Exceeded →
   * `timeout`, which fails closed in enforce mode. Default: none.
   */
  readonly callTimeoutMs?: number | undefined;
  /** Test seam: the state/snapshot store. Default: `core.authz_engine_state` over `db`. */
  readonly store?: EngineStore | undefined;
  /** The module registry's resource kinds, declared in every snapshot (FIX3 RR2-1). */
  readonly resourceKinds?: (() => Iterable<string>) | undefined;
  /**
   * Mutual exclusion of syncs per workspace (R3-4). Default: the lease row on
   * `core.authz_engine_state` (cross-process, pooler-safe, FIX2 C9).
   */
  readonly syncLock?: SyncLock | undefined;
}

export interface SyncOutcome {
  /** `busy`: another sync of the workspace holds the lock (the job retries). */
  readonly status: "synced" | "skipped" | "failed" | "busy";
  readonly aclVersion?: number | undefined;
  readonly writes?: number | undefined;
  readonly deletes?: number | undefined;
  readonly code?: string | undefined;
}

/** What the composition root and tests reach on the composed service. */
export interface RelationshipEngineHandle {
  readonly driver: string;
  readonly mode: RelationshipEngineMode;
  /** Readiness probe (enforce mode makes it a gate). */
  healthCheck(): Promise<void>;
  /** One full sync of the workspace now (what the job runs). */
  syncWorkspace(workspaceId: string): Promise<SyncOutcome>;
  /** Drops the workspace's store and state row (workspace deletion). */
  dropWorkspace(workspaceId: string): Promise<boolean>;
  /** Resolves when every shadow comparison started so far has finished (tests). */
  shadowIdle(): Promise<void>;
}

export interface AuthzServiceWithEngine extends AuthzService {
  readonly engine: RelationshipEngineHandle;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The deny an unavailable engine yields in enforce mode. */
const ENGINE_DENY: AccessDecision = Object.freeze({
  allowed: false,
  capabilities: [],
  pendingGates: [],
  reason: "no_grant",
});

/** The engine holds no store for the workspace (never synced by this driver): fails closed. */
class EngineNotSynced extends Error {
  override readonly name = "EngineNotSynced";
}

function errorCode(error: unknown): string {
  if (error instanceof EngineNotSynced) return "not_synced";
  if (error instanceof RelationshipEngineError) return error.code;
  return "internal";
}

function withDeadline<T>(p: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RelationshipEngineError("timeout", `engine call exceeded ${ms} ms`)),
      ms,
    );
    timer.unref?.();
  });
  return Promise.race([p, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Data-room node kinds whose ltree paths name their ancestor folders. */
const TREE_KINDS = new Set(["folder", "document"]);
const LABEL_HEX_RE = /^[0-9a-f]{32}$/u;

/**
 * The ancestor folders of a data-room node as its CURRENT path says (R3-1), nearest first: the
 * folder a document sits in (`path` = its folder's path) or a folder's parent (`path` = its own),
 * up to the root. Labels are folder ids without dashes (`childPath`); the root's label is `r`,
 * resolved to `rootId`. An unexpected label ends the chain there (the synced tree still answers
 * above it). Other kinds, or no path: none.
 */
export function ancestorsOf(
  resource: ResourceRef,
  rootId: string | undefined,
): RelationshipNodeRef[] {
  if (!TREE_KINDS.has(resource.kind) || resource.path === undefined || resource.path === "")
    return [];
  const labels = resource.path.split(".");
  if (resource.kind === "folder") labels.pop();
  const out: RelationshipNodeRef[] = [];
  for (const label of labels.reverse()) {
    if (label === "r" && out.length === labels.length - 1) {
      if (rootId !== undefined) out.push({ kind: "folder", id: rootId });
      break;
    }
    const hex = label.toLowerCase();
    if (!LABEL_HEX_RE.test(hex)) break;
    out.push({
      kind: "folder",
      id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    });
  }
  return out;
}

/**
 * FIX2 (RR1 #1): contextual ancestors that duplicate synced `parent` edges make OpenFGA's check
 * cost exponential in depth. Only the UNSYNCED leading part of a chain is sent (at most
 * `ENGINE_MAX_CONTEXT_EDGES` edges), and trees deeper than `ENGINE_MAX_TREE_DEPTH` (path labels)
 * are refused before any engine call as `rejected` items (deny in enforce, skipped in shadow).
 */
export const ENGINE_MAX_TREE_DEPTH = 20;
export const ENGINE_MAX_CONTEXT_EDGES = 8;
/** Synced-folder cache budget (ids): per workspace, and across workspaces in one process. */
export const SYNCED_FOLDERS_PER_WORKSPACE = 20_000;
export const SYNCED_FOLDERS_TOTAL = 200_000;
/** Folders created this long before the synced snapshot was read still count as unsynced. */
const SYNC_MARGIN_MS = 60_000;

/**
 * The part of `chain` (nearest first) the engine must be told: the node's own parent edge always
 * (one duplicate hop at most), then each further ancestor only while the previous one is not known
 * to be synced. `synced` undefined (unknown / over budget): the whole chain (the caller caps it at
 * `ENGINE_MAX_CONTEXT_EDGES`; the adapter drops edges its store already holds).
 */
export function unsyncedPrefix(
  chain: readonly RelationshipNodeRef[],
  synced: ReadonlySet<string> | undefined,
): RelationshipNodeRef[] {
  const out: RelationshipNodeRef[] = [];
  for (const a of chain) {
    out.push(a);
    if (synced?.has(a.id) === true) break;
  }
  return out;
}

/** The engine refused the item (unknown kind, …) — not our own depth refusal, not transport. */
function refusedByEngine(error: unknown): boolean {
  return (
    error instanceof RelationshipEngineError &&
    error.code === "rejected" &&
    !(error instanceof TreeTooDeep)
  );
}

/** Thrown (and counted as `rejected`) for a node the engine must not be asked about. */
class TreeTooDeep extends RelationshipEngineError {
  constructor(depth: number) {
    super("rejected", `node depth ${depth} exceeds the engine limit`);
  }
}

/** Caches here are TTL-checked; this caps their size (R3-8) by evicting the oldest entries. */
const CACHE_CAP = 10_000;
function capped<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_CAP) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

export function withRelationshipEngine(
  pg: AuthzService,
  engine: RelationshipEnginePort,
  options: WithRelationshipEngineOptions,
): AuthzServiceWithEngine {
  const { db, mode } = options;
  const log: Log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const sample = Math.min(1, Math.max(0, options.sample));
  const shadowLimit = Math.max(1, options.shadowConcurrency ?? 8);
  const stateTtl = options.stateTtlMs ?? 5_000;
  const memberTtl = options.memberTtlMs ?? 60_000;
  const metrics = options.metrics;
  const store = options.store ?? createEngineStore(db, { kinds: options.resourceKinds });
  const syncLock = options.syncLock ?? createLeaseSyncLock(store, engine.driver);

  const views = new Map<string, { value: EngineView; until: number }>();
  const shapes = new Map<string, { eligible: boolean; until: number }>();
  const kicked = new Map<string, number>();
  const roots = new Map<string, { id: string | undefined; until: number }>();
  /** Per workspace: folder ids in the last synced snapshot (by its time), or undefined (over budget). */
  const syncedFolders = new Map<string, { at: number; ids: Set<string> | undefined }>();
  let syncedFolderTotal = 0;
  const shadowTasks = new Set<Promise<void>>();
  /** Shadow eligibility lookups in flight (they take no engine slot, but are bounded too). */
  const shadowLookups = new Set<Promise<void>>();

  function invalidateLocal(workspaceId: string): void {
    views.delete(workspaceId);
    for (const key of shapes.keys()) if (key.startsWith(`${workspaceId}:`)) shapes.delete(key);
  }

  async function viewOf(workspaceId: string): Promise<EngineView> {
    const hit = views.get(workspaceId);
    const t = now().getTime();
    if (hit !== undefined && hit.until > t) return hit.value;
    const value = await store.view(workspaceId);
    capped(views, workspaceId, { value, until: t + stateTtl });
    return value;
  }

  /** External and not a delegate: the only principals the engine answers for. */
  async function eligible(principal: AuthzPrincipal): Promise<boolean> {
    const key = `${principal.workspaceId}:${principal.membershipId}`;
    const hit = shapes.get(key);
    const t = now().getTime();
    if (hit !== undefined && hit.until > t) return hit.eligible;
    if (!UUID_RE.test(principal.membershipId)) return false;
    const shape = await store.shape(principal.workspaceId, principal.membershipId);
    const value = shape !== undefined && shape.kind === "external" && shape.role !== "delegate";
    capped(shapes, key, { eligible: value, until: t + memberTtl });
    return value;
  }

  /** The refs to call the engine with; null when this driver never synced the workspace. */
  function refsOf(view: EngineView): EngineState | null {
    const s = view.state;
    if (s === undefined || s.driver !== engine.driver || s.storeRef === null) return null;
    return { storeRef: s.storeRef, modelRef: s.modelRef };
  }

  /**
   * FIX3 RR2-1: the engine lacks part of the tree (a cut unsynced chain, an item it refused as
   * unknown). Once per synced generation and at most once a minute per workspace, so a refusal that
   * a sync cannot cure never turns into a sync loop.
   */
  const treeKicks = new Map<string, { generation: number; at: number }>();
  function kickTreeSync(workspaceId: string, why: string): void {
    const generation = views.get(workspaceId)?.value.state?.syncedAt?.getTime() ?? 0;
    const t = now().getTime();
    const last = treeKicks.get(workspaceId);
    if (last !== undefined && (last.generation === generation || t - last.at < 60_000)) return;
    capped(treeKicks, workspaceId, { generation, at: t });
    kicked.delete(workspaceId);
    kickSync(workspaceId, why);
  }

  function kickSync(workspaceId: string, why: string): void {
    const t = now().getTime();
    const last = kicked.get(workspaceId);
    if (last !== undefined && t - last < 10_000) return;
    capped(kicked, workspaceId, t);
    void options.queue
      .send(
        ENGINE_SYNC_JOB,
        { workspaceId },
        { idempotencyKey: `${ENGINE_SYNC_JOB}:${workspaceId}` },
      )
      .then(() => log("authz.engine_sync_kicked", { workspaceId, why }))
      .catch((error: unknown) =>
        log("authz.engine_sync_kick_failed", {
          level: "warn",
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  /** The engine's view of `resource`: id plus its current ancestor chain (R3-1). */
  async function engineResource(
    workspaceId: string,
    resource: ResourceRef,
  ): Promise<RelationshipResource> {
    if (!TREE_KINDS.has(resource.kind) || resource.path === undefined)
      return { kind: resource.kind, id: resource.id };
    let rootId: string | undefined;
    // The chain ends at the root (label `r`) unless the node IS the root folder.
    const needsRoot =
      resource.path.split(".")[0] === "r" && !(resource.kind === "folder" && resource.path === "r");
    if (needsRoot) {
      const t = now().getTime();
      const hit = roots.get(workspaceId);
      if (hit !== undefined && hit.until > t) rootId = hit.id;
      else {
        rootId = await store.rootFolderId(workspaceId);
        // A missing root is re-read soon (it is created on first use).
        capped(roots, workspaceId, {
          id: rootId,
          until: t + (rootId === undefined ? 30_000 : 10 * 60_000),
        });
      }
    }
    const chain = ancestorsOf(resource, rootId);
    if (chain.length > ENGINE_MAX_TREE_DEPTH) throw new TreeTooDeep(chain.length);
    if (chain.length === 0) return { kind: resource.kind, id: resource.id };
    // Capped, never refused: a longer unsynced chain (e.g. a deep subtree imported moments before
    // the sync) loses only its upper edges — which, if truly unsynced, can only narrow (deny).
    const known = await syncedFolderIds(workspaceId);
    const prefix = unsyncedPrefix(chain, known);
    // FIX3 RR2-1: a cut chain may lose an edge the store lacks → a sync makes the cut transient.
    if (known !== undefined && prefix.length > ENGINE_MAX_CONTEXT_EDGES)
      kickTreeSync(workspaceId, "unsynced_tree");
    const ancestors = prefix.slice(0, ENGINE_MAX_CONTEXT_EDGES);
    return { kind: resource.kind, id: resource.id, ancestors };
  }

  /** Folder ids the last recorded sync saw (bounded cache, refreshed when the sync time moves). */
  async function syncedFolderIds(workspaceId: string): Promise<Set<string> | undefined> {
    const syncedAt = (await viewOf(workspaceId)).state?.syncedAt ?? null;
    if (syncedAt === null) return undefined;
    const at = syncedAt.getTime();
    const hit = syncedFolders.get(workspaceId);
    if (hit !== undefined && hit.at === at) return hit.ids;
    const ids = await store.foldersBefore(
      workspaceId,
      new Date(at - SYNC_MARGIN_MS),
      SYNCED_FOLDERS_PER_WORKSPACE,
    );
    const set = ids === undefined ? undefined : new Set(ids);
    if (hit?.ids !== undefined) syncedFolderTotal -= hit.ids.size;
    syncedFolders.delete(workspaceId);
    syncedFolders.set(workspaceId, { at, ids: set });
    syncedFolderTotal += set?.size ?? 0;
    // Evict the least recently refreshed workspaces until the total budget holds.
    for (const [ws, entry] of syncedFolders) {
      if (syncedFolderTotal <= SYNCED_FOLDERS_TOTAL || ws === workspaceId) break;
      syncedFolderTotal -= entry.ids?.size ?? 0;
      syncedFolders.delete(ws);
    }
    return set;
  }

  /** Current refs for an engine call, kicking a sync when behind; throws when never synced. */
  async function refsForCall(
    workspaceId: string,
  ): Promise<{ refs: EngineState; view: EngineView }> {
    const view = await viewOf(workspaceId);
    const refs = refsOf(view);
    if (refs === null) {
      kickSync(workspaceId, "never_synced");
      throw new EngineNotSynced("the engine holds no store for this workspace");
    }
    if ((view.state?.syncedAclVersion ?? 0) < view.aclVersion) kickSync(workspaceId, "stale");
    return { refs, view };
  }

  function engineFailed(
    operation: EngineOperation,
    error: unknown,
    fields: Record<string, unknown>,
  ): void {
    const code = errorCode(error);
    metrics?.engineError({ operation, code });
    log("authz.engine_error", { level: "warn", operation, errorCode: code, ...fields });
  }

  // --- shadow ---------------------------------------------------------------------------------

  function shadow(
    principal: AuthzPrincipal,
    resource: ResourceRef,
    decision: AccessDecision,
  ): void {
    if (decision.reason === "not_member") return;
    if (sample <= 0 || random() >= sample) return;
    // R3-8: staff and delegates never take an engine slot. Known shapes are decided from the
    // cache; an unknown one is looked up first (bounded separately), then takes a slot if eligible.
    const key = `${principal.workspaceId}:${principal.membershipId}`;
    const hit = shapes.get(key);
    const at = now();
    if (hit !== undefined && hit.until > at.getTime()) {
      if (!hit.eligible) return;
      start(principal, resource, decision, at);
      return;
    }
    if (shadowLookups.size >= shadowLimit * 4) return;
    const lookup: Promise<void> = eligible(principal)
      .then((ok) => {
        if (ok) start(principal, resource, decision, at);
      })
      .catch(() => undefined)
      .finally(() => shadowLookups.delete(lookup));
    shadowLookups.add(lookup);
  }

  function start(
    principal: AuthzPrincipal,
    resource: ResourceRef,
    decision: AccessDecision,
    at: Date,
  ): void {
    if (shadowTasks.size >= shadowLimit) {
      metrics?.shadowDropped();
      return;
    }
    const task = compare(principal, resource, decision, at)
      .catch((error: unknown) => {
        engineFailed("check", error, {
          workspaceId: principal.workspaceId,
          membershipId: principal.membershipId,
          shadow: true,
        });
        if (refusedByEngine(error)) kickTreeSync(principal.workspaceId, "engine_rejected");
      })
      .finally(() => shadowTasks.delete(task));
    shadowTasks.add(task);
  }

  async function compare(
    principal: AuthzPrincipal,
    resource: ResourceRef,
    decision: AccessDecision,
    at: Date,
  ): Promise<void> {
    const view = await viewOf(principal.workspaceId);
    const refs = refsOf(view);
    if (refs === null) {
      kickSync(principal.workspaceId, "never_synced");
      return;
    }
    // R3-6: shadow keeps the engine current too.
    const stale = (view.state?.syncedAclVersion ?? 0) < view.aclVersion;
    if (stale) kickSync(principal.workspaceId, "stale");
    let target: RelationshipResource;
    try {
      target = await engineResource(principal.workspaceId, resource);
    } catch (error) {
      if (!(error instanceof TreeTooDeep)) throw error;
      metrics?.shadowSkipped?.("too_deep");
      return;
    }
    const fga = await withDeadline(
      engine.check(refs, {
        membershipId: principal.membershipId,
        resource: target,
        capabilities: CAPABILITIES,
        at,
      }),
      options.callTimeoutMs,
    );
    for (const capability of CAPABILITIES) {
      const pgHas = decision.capabilities.includes(capability);
      const fgaHas = fga[capability] === true;
      if (pgHas === fgaHas) continue;
      metrics?.shadowMismatch({
        capability,
        direction: pgHas ? "pg_only" : "engine_only",
        stale,
      });
      log("authz.shadow_mismatch", {
        level: "warn",
        workspaceId: principal.workspaceId,
        membershipId: principal.membershipId,
        resourceKind: resource.kind,
        resourceId: resource.id,
        capability,
        pg: pgHas,
        fga: fgaHas,
        aclVersion: view.aclVersion,
        syncedAclVersion: view.state?.syncedAclVersion ?? null,
        stale,
      });
    }
  }

  // --- enforce --------------------------------------------------------------------------------

  async function enforceCheck(
    principal: AuthzPrincipal,
    resource: ResourceRef,
    capability: Capability,
    decision: AccessDecision,
  ): Promise<AccessDecision> {
    // Nothing to narrow, or a principal the engine never answers for.
    if (decision.capabilities.length === 0) return decision;
    if (!(await eligible(principal))) return decision;
    let fga: Readonly<Record<Capability, boolean>>;
    try {
      const { refs } = await refsForCall(principal.workspaceId);
      fga = await withDeadline(
        engine.check(refs, {
          membershipId: principal.membershipId,
          resource: await engineResource(principal.workspaceId, resource),
          capabilities: decision.capabilities,
          at: now(),
        }),
        options.callTimeoutMs,
      );
    } catch (error) {
      engineFailed("check", error, {
        workspaceId: principal.workspaceId,
        membershipId: principal.membershipId,
        resourceKind: resource.kind,
        resourceId: resource.id,
      });
      if (refusedByEngine(error)) kickTreeSync(principal.workspaceId, "engine_rejected");
      return ENGINE_DENY;
    }
    const capabilities = decision.capabilities.filter((c) => fga[c] === true);
    if (decision.capabilities.includes(capability) && !capabilities.includes(capability)) {
      return { allowed: false, capabilities, pendingGates: [], reason: "no_grant" };
    }
    return { ...decision, capabilities };
  }

  async function enforceList(
    principal: AuthzPrincipal,
    kind: string,
    items: AccessibleResource[],
  ): Promise<AccessibleResource[]> {
    if (items.length === 0) return items;
    if (!(await eligible(principal))) return items;
    const allowed = new Set<string>();
    try {
      const { refs } = await refsForCall(principal.workspaceId);
      const at = now();
      for (let i = 0; i < items.length; i += ENGINE_BATCH_CHUNK) {
        const chunk = items.slice(i, i + ENGINE_BATCH_CHUNK);
        const resources: RelationshipResource[] = [];
        const refused = new Map<string, "rejected">();
        for (const r of chunk) {
          try {
            resources.push(
              await engineResource(principal.workspaceId, { kind: r.kind, id: r.id, path: r.path }),
            );
          } catch (error) {
            if (!(error instanceof TreeTooDeep)) throw error;
            refused.set(r.id, "rejected");
          }
        }
        const result =
          resources.length === 0
            ? { allowed: new Set<string>(), failed: new Map<string, string>() }
            : await withDeadline(
                engine.batchCheck(refs, {
                  membershipId: principal.membershipId,
                  resources,
                  capability: "view",
                  at,
                }),
                options.callTimeoutMs,
              );
        for (const id of result.allowed) allowed.add(id);
        // R3-3: an item the engine could not decide is denied on its own; the rest stand.
        if ([...result.failed.values()].includes("rejected"))
          kickTreeSync(principal.workspaceId, "engine_rejected");
        for (const [id, code] of [...result.failed, ...refused]) {
          allowed.delete(id);
          metrics?.engineError({ operation: "batch_check", code });
          log("authz.engine_item_failed", {
            level: "warn",
            workspaceId: principal.workspaceId,
            membershipId: principal.membershipId,
            resourceKind: kind,
            resourceId: id,
            errorCode: code,
          });
        }
      }
    } catch (error) {
      engineFailed("batch_check", error, {
        workspaceId: principal.workspaceId,
        membershipId: principal.membershipId,
        resourceKind: kind,
      });
      return [];
    }
    return items.filter((r) => allowed.has(r.id));
  }

  // --- sync -----------------------------------------------------------------------------------

  async function syncWorkspace(workspaceId: string): Promise<SyncOutcome> {
    const outcome = await syncLock(workspaceId, (lease) => syncLocked(workspaceId, lease));
    if (outcome === SYNC_BUSY) {
      log("authz.engine_sync_busy", { workspaceId });
      return { status: "busy" };
    }
    return outcome;
  }

  async function syncLocked(workspaceId: string, leaseOwner: string | null): Promise<SyncOutcome> {
    // When the snapshot was read: recorded as `synced_at`, it tells checks which nodes the engine
    // holds (FIX2: only later ones get contextual parent edges).
    // 1. One short transaction: the snapshot, the refs and its DB time. Nothing is held past it.
    const read = await store.snapshot(workspaceId);
    if (read === undefined) return { status: "skipped" };
    // Recorded as `synced_at` (FIX3 RR2-2: the DB clock, as the folders' `created_at`): it tells
    // checks which folders the engine holds.
    const snapshotAt = read.at;
    const refs = refsOf(read.view) ?? { storeRef: null, modelRef: null };
    // 2. The engine, with no transaction open.
    const started = performance.now();
    let result: Awaited<ReturnType<RelationshipEnginePort["sync"]>>;
    try {
      result = await engine.sync(read.snapshot, refs);
    } catch (error) {
      const code = errorCode(error);
      metrics?.engineError({ operation: "sync", code });
      log("authz.engine_sync_failed", {
        level: "warn",
        workspaceId,
        errorCode: code,
        aclVersion: read.snapshot.aclVersion,
      });
      // 3a. Record the failure (its own short transaction) for the reconciler.
      await store.recordError(workspaceId, engine.driver, code);
      invalidateLocal(workspaceId);
      return { status: "failed", code, aclVersion: read.snapshot.aclVersion };
    }
    // 3b. Record the success.
    const recorded = await store.recordSynced(workspaceId, {
      driver: engine.driver,
      storeRef: result.storeRef,
      modelRef: result.modelRef,
      syncedAclVersion: read.snapshot.aclVersion,
      at: snapshotAt,
      leaseOwner,
    });
    invalidateLocal(workspaceId);
    if (!recorded) {
      // The lease was taken over (or a newer snapshot already recorded): what we pushed may be
      // interleaved with another sync's writes, so another full sync makes the store whole.
      log("authz.engine_sync_superseded", { level: "warn", workspaceId });
      await options.queue.send(
        ENGINE_SYNC_JOB,
        { workspaceId },
        { idempotencyKey: `${ENGINE_SYNC_JOB}:${workspaceId}` },
      );
      return { status: "skipped", aclVersion: read.snapshot.aclVersion };
    }
    // 4. The workspace moved on while we pushed: go again (one queued job per workspace).
    const after = await store.view(workspaceId);
    if (after.aclVersion > read.snapshot.aclVersion) {
      await options.queue.send(
        ENGINE_SYNC_JOB,
        { workspaceId },
        { idempotencyKey: `${ENGINE_SYNC_JOB}:${workspaceId}` },
      );
    }
    log("authz.engine_synced", {
      workspaceId,
      aclVersion: read.snapshot.aclVersion,
      writes: result.writes,
      deletes: result.deletes,
      members: read.snapshot.members.length,
      rules: read.snapshot.rules.length,
      nodes: read.snapshot.nodes.length,
      durationMs: Math.round(performance.now() - started),
    });
    return {
      status: "synced",
      aclVersion: read.snapshot.aclVersion,
      writes: result.writes,
      deletes: result.deletes,
    };
  }

  async function dropWorkspace(workspaceId: string): Promise<boolean> {
    const view = await store.view(workspaceId);
    if (view.state === undefined) return false;
    const refs = refsOf(view);
    if (refs !== null) {
      try {
        await engine.dropWorkspace(refs);
      } catch (error) {
        const code = errorCode(error);
        metrics?.engineError({ operation: "drop", code });
        log("authz.engine_drop_failed", { level: "warn", workspaceId, errorCode: code });
        return false;
      }
    }
    await store.deleteState(workspaceId);
    invalidateLocal(workspaceId);
    log("authz.engine_dropped", { workspaceId });
    return true;
  }

  const subscriptions: Subscription[] = [
    ...pg.subscriptions,
    {
      topic: "acl.changed",
      id: "authz.engine_sync",
      handler: async (_event, { tx, ctx }) => {
        if (ctx.actorKind === "host") return;
        const workspaceId = (ctx as TenantContext).workspaceId;
        await options.queue.sendInTransaction(
          tx,
          ENGINE_SYNC_JOB,
          { workspaceId },
          { idempotencyKey: `${ENGINE_SYNC_JOB}:${workspaceId}` },
        );
      },
    },
  ];

  const jobs: JobDefinition[] = [
    ...pg.jobs,
    {
      name: ENGINE_SYNC_JOB,
      // At most one queued and one running per workspace; a burst of acl.changed collapses into
      // the one queued job, which reads the latest snapshot when it runs.
      queue: {
        policy: "stately",
        retryLimit: 3,
        retryDelaySeconds: 5,
        retryBackoff: true,
        deadLetter: false,
      },
      work: { concurrency: 2 },
      handler: async (job) => {
        const workspaceId = (job.data as JsonObject)["workspaceId"];
        if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) return;
        const outcome = await syncWorkspace(workspaceId);
        // Retried with backoff by the queue; the reconciler picks up whatever still fails.
        if (outcome.status === "failed")
          throw new Error(`authz engine sync failed (${outcome.code ?? "unknown"})`);
        if (outcome.status === "busy")
          throw new Error("authz engine sync busy (another sync of the workspace is running)");
      },
    },
    {
      name: ENGINE_RECONCILE_JOB,
      cron: "35 * * * *",
      handler: async () => {
        let enqueued = 0;
        let dropped = 0;
        for (const workspaceId of await store.liveWorkspaceIds()) {
          try {
            const view = await store.view(workspaceId);
            const s = view.state;
            const lagging =
              s === undefined ||
              s.driver !== engine.driver ||
              s.storeRef === null ||
              s.syncedAclVersion < view.aclVersion ||
              s.lastErrorCode !== null;
            if (!lagging) continue;
            await options.queue.send(
              ENGINE_SYNC_JOB,
              { workspaceId },
              { idempotencyKey: `${ENGINE_SYNC_JOB}:${workspaceId}` },
            );
            enqueued += 1;
          } catch (error) {
            log("authz.engine_reconcile_failed", {
              level: "warn",
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const since = new Date(now().getTime() - DROP_WINDOW_DAYS * 24 * 3600_000);
        for (const workspaceId of await store.recentlyDeletedWorkspaceIds(since)) {
          if (await dropWorkspace(workspaceId)) dropped += 1;
        }
        log("authz.engine_reconciled", { enqueued, dropped });
      },
    },
  ];

  const handle: RelationshipEngineHandle = {
    driver: engine.driver,
    mode,
    healthCheck: () => engine.healthCheck(),
    syncWorkspace,
    dropWorkspace,
    async shadowIdle() {
      while (shadowTasks.size > 0 || shadowLookups.size > 0)
        await Promise.allSettled([...shadowTasks, ...shadowLookups]);
    },
  };

  return {
    ...pg,
    engine: handle,
    subscriptions,
    jobs,
    invalidate(workspaceId) {
      pg.invalidate(workspaceId);
      invalidateLocal(workspaceId);
    },
    async bump(tx, ctx, cause) {
      const v = await pg.bump(tx, ctx, cause);
      invalidateLocal(ctx.workspaceId);
      return v;
    },
    async check(principal, resource, capability, facts) {
      const decision = await pg.check(principal, resource, capability, facts);
      if (mode === "shadow") {
        shadow(principal, resource, decision);
        return decision;
      }
      return enforceCheck(principal, resource, capability, decision);
    },
    async listAccessible(principal, kind, facts) {
      const items = await pg.listAccessible(principal, kind, facts);
      if (mode === "shadow") return items;
      return enforceList(principal, kind, [...items]);
    },
  };
}
