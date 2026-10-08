import type { AuditRecorder } from "@fundroom/audit";
import { activateQuietly, releaseQuietly } from "@fundroom/control-plane";
import {
  type Database,
  isPlatformWorkspace,
  pgErrorCode,
  platformContext,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import { purgeExports } from "@fundroom/portability";
import type { DirectoryPort, JobDefinition, JsonObject, ObjectStoragePort } from "@fundroom/ports";
import { deleteWorkspaceSearch } from "@fundroom/search";
import {
  countOtherLiveWorkspaces,
  findDeleted,
  type LifecycleRow,
  lockWorkspace,
  markDeleted,
  markPurged,
  purgeDue,
  restoreDeleted,
  shredWorkspaceKeys,
} from "./repos/lifecycle-repo.js";

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/*
 * The workspace lifecycle after "delete workspace" (E2.7 package B1).
 *
 *   delete   (owner, danger zone)  deleted_at = now, purge_after = now + 30 days, audited in the
 *                                  workspace's own chain as `workspace.deleted`. Tenant resolution
 *                                  already ignores deleted workspaces, so the portal stops
 *                                  resolving as soon as the caches are dropped.
 *   restore  (operator CLI)        only while purge_after > now and purged_at is null; clears
 *                                  both columns (the `workspace_purge_shape` CHECK). Platform
 *                                  audit `workspace.restored`.
 *   purge    (daily job)           past purge_after, not under legal hold, not purged: under a
 *                                  row lock, stamp purged_at and then crypto-shred every
 *                                  `core.workspace_key` (the wrapped DEK is overwritten, the row
 *                                  kept as a tombstone) in the same transaction; platform audit
 *                                  `workspace.purged`. Blobs encrypted under those keys become
 *                                  unreadable, which is the point. Restore locks the same row, so
 *                                  a restore and a purge never interleave: whichever comes second
 *                                  sees the other's outcome (never "restored with shredded keys").
 *
 * In single-tenant mode the portal refuses to delete the instance's only live workspace
 * (`last_workspace`), and the first-run setup gate counts a deleted-but-not-purged workspace as
 * existing — a workspace inside its restore window must never let the setup token mint a new
 * owner next to it.
 *
 * **Row deletion is out of scope.** The purge removes the ability to decrypt, not the rows:
 * metadata rows (memberships, audit chain, analytics) stay until an operator deletes the
 * workspace row itself, whose ON DELETE CASCADE then removes them. Postgres MVCC, WAL and backups
 * may still hold the pre-shred wrapped keys until vacuum and backup expiry — the KEK in the KMS
 * is what those copies need, and rotating it is the operator's remaining lever.
 */

/** How long a deleted workspace can still be restored. */
export const WORKSPACE_PURGE_DELAY_DAYS = 30;
/** At most this many workspaces are purged per job run; the next run takes the rest. */
export const WORKSPACE_PURGE_BATCH = 50;
export const WORKSPACE_PURGE_JOB = "workspace.purge";

export class WorkspaceLifecycleError extends Error {
  override readonly name = "WorkspaceLifecycleError";
  constructor(
    readonly code:
      | "legal_hold"
      | "last_workspace"
      | "not_found"
      | "ambiguous"
      | "expired"
      | "slug_taken"
      /** E3.11: a move is relocating the workspace (its `relocation` hold is set). */
      | "relocating"
      /**
       * E3.11 RR1-7: this copy is the SOURCE of a finished move (soft-deleted at the switch, still
       * held `relocation`): the workspace lives in another cell now; restoring this copy would
       * make two.
       */
      | "moved",
    message: string,
  ) {
    super(message);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function legalHoldOf(row: Pick<LifecycleRow, "settings">): boolean {
  return parseWorkspaceSettings((row.settings ?? {}) as Record<string, unknown>).legal.legalHold;
}

export interface SoftDeleteInput {
  readonly requestId?: string | null | undefined;
  readonly now?: Date | undefined;
  /**
   * Refuse (`last_workspace`) when no other live workspace would remain. Set in single-tenant
   * mode: there the instance *is* its workspace, and with none left the first-run setup wizard
   * would reopen for whoever holds the setup token.
   */
  readonly refuseLast?: boolean | undefined;
}

export const LAST_WORKSPACE_MESSAGE =
  "this is the instance's only workspace: deleting it from the portal would leave an empty instance. To decommission a single-tenant instance, the operator stops it and removes its database (see the operator guide).";

/**
 * Soft-deletes the workspace of `ctx` in one tenant transaction with its audit row. Refuses
 * (`legal_hold`) while the workspace is under legal hold — a hold exists to preserve exactly what
 * the purge would destroy — and (`last_workspace`, with `refuseLast`) when it is the last live
 * one. Sessions and caches are the caller's job, *after* this returns.
 */
export async function softDeleteWorkspace(
  deps: {
    readonly db: Database;
    readonly audit: AuditRecorder;
    /**
     * Runs in the delete transaction after its audit row (lock order: the outbox last), e.g. the
     * control plane's `billing.cancel` enqueue (E3.10 R3-L1): it happens iff the delete commits.
     */
    readonly onDeleted?: ((tx: Tx, workspaceId: string) => Promise<void>) | undefined;
    /**
     * E3.11 (R2-3): after the commit the directory entry turns `dormant` — the slug and verified
     * hostnames stay held for the restore window, but other cells no longer route to it, so a
     * deleted workspace answers exactly like one that never existed. Best effort (logged); the
     * reconcile sweep repairs a miss.
     */
    readonly directory?: Pick<DirectoryPort, "setState"> | undefined;
    readonly log?: Log | undefined;
  },
  ctx: TenantContext,
  input: SoftDeleteInput = {},
): Promise<{ purgeAfter: Date; slug: string }> {
  const at = input.now ?? new Date();
  const purgeAfter = new Date(at.getTime() + WORKSPACE_PURGE_DELAY_DAYS * 24 * 3600_000);
  if (input.refuseLast === true) {
    // A host read, sequenced before the tenant transaction (never nested in it).
    const others = await deps.db.withHost((tx) => countOtherLiveWorkspaces(tx, ctx.workspaceId));
    if (others === 0) throw new WorkspaceLifecycleError("last_workspace", LAST_WORKSPACE_MESSAGE);
  }
  const result = await deps.db.withTenant(ctx, async (tx) => {
    // Locked (E3.11 R1-2): a move sets and checks its `relocation` hold under this same row lock,
    // so a delete and a move's switch never interleave.
    const current = await lockWorkspace(tx, ctx.workspaceId);
    if (current === undefined || current.deletedAt !== null)
      throw new WorkspaceLifecycleError("not_found", "no such workspace");
    if (current.holds.includes("relocation"))
      throw new WorkspaceLifecycleError(
        "relocating",
        "the workspace is being moved to another cell; it cannot be deleted until the move ends",
      );
    if (legalHoldOf(current))
      throw new WorkspaceLifecycleError(
        "legal_hold",
        "the workspace is under legal hold; it cannot be deleted until the hold is lifted",
      );
    const row = await markDeleted(tx, ctx.workspaceId, at, purgeAfter);
    if (row === undefined) throw new WorkspaceLifecycleError("not_found", "no such workspace");
    await deps.audit.record(tx, ctx, {
      action: "workspace.deleted",
      resourceKind: "workspace",
      resourceId: ctx.workspaceId,
      requestId: input.requestId ?? null,
      meta: { purgeAfter: purgeAfter.toISOString(), purgeDelayDays: WORKSPACE_PURGE_DELAY_DAYS },
    });
    await deps.onDeleted?.(tx, ctx.workspaceId);
    return { purgeAfter, slug: row.slug };
  });
  await setDirectoryState(deps.directory, ctx.workspaceId, "dormant", deps.log);
  return result;
}

/** A best-effort directory state change after a commit (E3.11 R2-3). Never throws. */
async function setDirectoryState(
  directory: Pick<DirectoryPort, "setState"> | undefined,
  workspaceId: string,
  state: "active" | "dormant",
  log: Log | undefined,
): Promise<void> {
  if (directory === undefined) return;
  try {
    await directory.setState(workspaceId, state);
  } catch (error) {
    log?.("directory.set_state_failed", {
      level: "warn",
      workspaceId,
      state,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    });
  }
}

/**
 * Operator restore (`fundroom workspace restore <id|slug>`). Host-level; audited on the platform
 * trail. The slug must still be free among live workspaces (`workspace_slug_active_idx`).
 */
export async function restoreWorkspace(
  deps: {
    readonly db: Database;
    readonly audit: AuditRecorder;
    /**
     * E3.11 (R2-3): the entry goes back to `active` (routed) after the commit, best effort. An
     * entry that was RELEASED meanwhile (setup undo, `seed-demo --reset`) is claimed again
     * before the local restore — refused (`slug_taken`) when another cell's workspace took the
     * slug since, never naming it.
     */
    readonly directory?:
      | Pick<DirectoryPort, "setState" | "lookupWorkspace" | "claimSlug" | "activate" | "release">
      | undefined;
    readonly log?: Log | undefined;
  },
  idOrSlug: string,
  now: Date = new Date(),
): Promise<LifecycleRow> {
  const key = idOrSlug.trim();
  let by: { id: string } | { slug: string } = UUID_RE.test(key)
    ? { id: key.toLowerCase() }
    : { slug: key.toLowerCase() };
  const directory = deps.directory;
  let claimed: string | undefined;
  if (directory !== undefined) {
    // Which workspace, read first (a host read of its own): the directory is another database
    // and is never asked inside the restore transaction. The transaction re-checks everything.
    const candidates = await deps.db.withHost((tx) => findDeleted(tx, by));
    const target = candidates.filter((w) => w.purgeAfter !== null && w.purgeAfter > now);
    if (target.length === 1) {
      const t = target[0] as LifecycleRow;
      if (t.holds.includes("relocation")) throw movedAway(key);
      by = { id: t.id };
      const entry = await directory.lookupWorkspace(t.id);
      if (entry === null || entry.state === "deleted") {
        const claim = await directory.claimSlug({
          workspaceId: t.id,
          slug: t.slug,
          cellId: t.cellId,
        });
        if (claim === "taken")
          throw new WorkspaceLifecycleError(
            "slug_taken",
            `another workspace now uses the slug ${t.slug}; rename it first`,
          );
        claimed = t.id;
      }
    }
  }
  let restored: LifecycleRow;
  try {
    restored = await restoreLocally(deps, by, key, now);
  } catch (error) {
    if (claimed !== undefined) await releaseQuietly(directory, claimed, deps.log);
    throw error;
  }
  if (claimed !== undefined) await activateQuietly(directory, claimed, deps.log);
  await deps.audit.recordDetached(platformContext(), {
    action: "workspace.restored",
    resourceKind: "workspace",
    resourceId: restored.id,
    actorKind: "system",
    meta: { workspaceId: restored.id, slug: restored.slug },
  });
  await setDirectoryState(deps.directory, restored.id, "active", deps.log);
  return restored;
}

function movedAway(key: string): WorkspaceLifecycleError {
  return new WorkspaceLifecycleError(
    "moved",
    `${key} was moved to another cell; this is the old copy, kept only until it is purged, and it cannot be restored`,
  );
}

async function restoreLocally(
  deps: { readonly db: Database },
  by: { readonly id: string } | { readonly slug: string },
  key: string,
  now: Date,
): Promise<LifecycleRow> {
  return deps.db.withHost(async (tx) => {
    const found = await findDeleted(tx, by);
    const restorable = found.filter((w) => w.purgeAfter !== null && w.purgeAfter > now);
    if (found.length === 0)
      throw new WorkspaceLifecycleError("not_found", `no deleted workspace matches ${key}`);
    if (restorable.length === 0)
      throw new WorkspaceLifecycleError(
        "expired",
        `the restore window of ${key} has closed; it is due to be purged`,
      );
    if (restorable.length > 1)
      throw new WorkspaceLifecycleError(
        "ambiguous",
        `${restorable.length} deleted workspaces use the slug ${key}; restore by id (${restorable.map((w) => w.id).join(", ")})`,
      );
    const target = restorable[0] as LifecycleRow;
    // Under the row lock `findDeleted` took: never a moved-away source (RR1-7).
    if (target.holds.includes("relocation")) throw movedAway(key);
    try {
      const row = await restoreDeleted(tx, target.id, now);
      if (row === undefined)
        throw new WorkspaceLifecycleError("expired", `${key} can no longer be restored`);
      return row;
    } catch (error) {
      if (pgErrorCode(error) === "23505")
        throw new WorkspaceLifecycleError(
          "slug_taken",
          `another live workspace now uses the slug ${target.slug}; rename it first`,
        );
      throw error;
    }
  });
}

export interface PurgeOptions {
  readonly db: Database;
  readonly audit: AuditRecorder;
  /** Drops cached plaintext keys in this process (`EnvelopeService.invalidate`). */
  readonly invalidateKeys?: ((workspaceId: string) => void) | undefined;
  /** Deletes the purged workspace's export files (E2.8); rows go in the shred transaction. */
  readonly storage?: Pick<ObjectStoragePort, "deleteMany"> | undefined;
  /**
   * E3.11: the cell directory. A purged workspace's entry is released after the shred commits
   * (slug and verified hostnames free for every cell). Best effort — the reconcile sweep repairs
   * a miss. An entry that already belongs to another cell's copy (the source of a finished move)
   * is untouched: `release` matches the entry's CURRENT workspace id only.
   */
  readonly directory?: Pick<DirectoryPort, "release"> | undefined;
  readonly now?: (() => Date) | undefined;
  readonly batchSize?: number | undefined;
  readonly log?: Log | undefined;
  /** Test seam: interleave work between the locked re-check and the shred. */
  readonly hooks?: { readonly afterRecheck?: (workspaceId: string) => Promise<void> } | undefined;
}

export interface PurgeResult {
  readonly purged: string[];
  readonly held: string[];
  readonly keysShredded: number;
}

/**
 * One purge pass. The scan runs in a host transaction; each workspace is then shredded in its
 * own system-context transaction (sequenced, never nested), and its platform audit row follows.
 */
export async function purgeDeletedWorkspaces(options: PurgeOptions): Promise<PurgeResult> {
  const now = options.now?.() ?? new Date();
  const due = await options.db.withHost((tx) =>
    purgeDue(tx, now, options.batchSize ?? WORKSPACE_PURGE_BATCH),
  );
  const purged: string[] = [];
  const held: string[] = [];
  let keysShredded = 0;
  for (const ws of due) {
    if (isPlatformWorkspace(ws.id)) continue;
    if (legalHoldOf(ws)) {
      held.push(ws.id);
      continue;
    }
    const ctx = systemContext(ws.id);
    let exportKeys: string[] = [];
    const shredded = await options.db.withTenant(ctx, async (tx) => {
      // Re-check under a row lock: a restore may have raced the scan, and one that comes after
      // this point waits for the lock (`findDeleted` locks too) and then finds the row purged.
      const current = await lockWorkspace(tx, ws.id);
      if (
        current === undefined ||
        current.deletedAt === null ||
        current.purgedAt !== null ||
        current.purgeAfter === null ||
        current.purgeAfter > now ||
        legalHoldOf(current)
      )
        return undefined;
      await options.hooks?.afterRecheck?.(ws.id);
      // Stamp first, shred only if the stamp took: keys are never shredded under a workspace
      // that is not (or no longer) marked purged.
      if (!(await markPurged(tx, ws.id, now))) return undefined;
      const keys = await shredWorkspaceKeys(tx, ws.id, now);
      // E2.8 search: the index holds extracted plaintext of content the shred makes unreadable.
      await deleteWorkspaceSearch(tx, ws.id);
      // E2.8 portability: export rows go now, their files (a whole-company copy) after commit.
      exportKeys = await purgeExports(tx, ws.id);
      return keys;
    });
    if (shredded === undefined) continue;
    if (exportKeys.length > 0) await options.storage?.deleteMany(exportKeys).catch(() => undefined);
    options.invalidateKeys?.(ws.id);
    await releaseQuietly(options.directory, ws.id, options.log);
    keysShredded += shredded;
    purged.push(ws.id);
    await options.audit.recordDetached(platformContext(), {
      action: "workspace.purged",
      resourceKind: "workspace",
      resourceId: ws.id,
      actorKind: "system",
      meta: { workspaceId: ws.id, keysShredded: shredded },
    });
  }
  options.log?.("workspace.purge_run", {
    purged: purged.length,
    held: held.length,
    keysShredded,
  });
  return { purged, held, keysShredded };
}

/** The daily `workspace.purge` job (kernel; registered in container.ts). */
export function createWorkspacePurgeJob(options: PurgeOptions): JobDefinition<JsonObject> {
  return {
    name: WORKSPACE_PURGE_JOB,
    cron: "20 4 * * *",
    handler: async () => {
      await purgeDeletedWorkspaces(options);
    },
  };
}
