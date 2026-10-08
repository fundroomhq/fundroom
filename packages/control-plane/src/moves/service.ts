import type { AuditRecorder } from "@fundroom/audit";
import { type Database, systemContext, type Tx } from "@fundroom/db";
import type {
  DirectoryCell,
  DirectoryMove,
  DirectoryPort,
  JobQueuePort,
  JsonObject,
  MoveCarried,
  MoveState,
  ObjectStoragePort,
} from "@fundroom/ports";
import { auditPlatformChain, auditTenantChain } from "../workspaces/chains.js";
import { type ControlPlaneActor, setWorkspaceHold } from "../workspaces/status.js";
import {
  type CarriedSubscription,
  erasureCounts,
  lockMoveWorkspace,
  readMoveWorkspace,
} from "./repos/move-repo.js";
import { newTransferKey } from "./transfer.js";

/*
 * Moves between cells (E3.11, ADR-0059): the operator-facing half — request, cancel, list — and
 * the shared vocabulary. The engine (export, transfer, import, switchover, retire, rollback) is
 * `./engine.ts`.
 *
 * State machine (one `directory.move` row; every step a compare-and-set, long steps under a lease
 * with an owner token and a heartbeat, every step idempotent and repaired by `move.poll`):
 *
 *   requested ─export (source)→ exporting → exported ─import (target)→ importing → imported
 *     ─switch (SOURCE, under its workspace-row lock)→ switched ─purge (source)→ retired
 *   any state before `imported` → failed {stage, code} (rolled back) | cancelled (operator)
 *
 * The SOURCE performs the switchover (not the target): only the source can see an erasure
 * request recorded after the move was requested, and it re-checks that under the same row lock an
 * erasure request needs, so the directory never points at a copy an erasure has overtaken.
 *
 * Holds: the source gets `relocation` at the request (staff 423, everyone else 404 — like any
 * hold); the copy is created with `relocation` plus every other hold the source had, so a held
 * workspace arrives held; the target lifts only `relocation`, after the switchover, and re-applies
 * any hold the source gained after the export (the switch writes the final set into `carried`).
 */

export const MOVE_EXPORT_JOB = "move.export";
export const MOVE_IMPORT_JOB = "move.import";
export const MOVE_POLL_JOB = "move.poll";
export const MOVE_RETIRE_JOB = "move.retire";
/** The presigned bundle URL's lifetime (and the bundle object's, unless imported sooner). */
export const MOVE_BUNDLE_TTL_SECONDS = 24 * 3600;
/** A target cell whose directory heartbeat is older than this takes no move. */
export const MOVE_TARGET_FRESH_MS = 15 * 60_000;
export const MOVE_LEASE_MS = 5 * 60_000;
export const MOVE_HEARTBEAT_MS = 60_000;

/** States an operator may still cancel (the import has not completed). */
export const CANCELLABLE_MOVE_STATES: readonly MoveState[] = [
  "requested",
  "exporting",
  "exported",
  "importing",
];
export const LIVE_MOVE_STATES: readonly MoveState[] = [
  "requested",
  "exporting",
  "exported",
  "importing",
  "imported",
];

/** Why a move cannot be requested (`move_unavailable` details `reason`). */
export type MoveRefusal =
  | "no_directory"
  | "target_unknown"
  | "target_local"
  | "target_inactive"
  | "target_stale"
  | "source_remote"
  | "deleted"
  | "legal_hold"
  | "erasure_open"
  | "not_in_directory"
  | "storage"
  | "sanctions_review";

export class MoveError extends Error {
  override readonly name = "MoveError";
  constructor(
    readonly code:
      | "move_unavailable"
      | "move_busy"
      | "not_found"
      | "confirmation_mismatch"
      | "not_cancellable"
      | "directory_unavailable",
    message: string,
    readonly reason?: MoveRefusal | undefined,
  ) {
    super(message);
  }
}

/** What a move carries beyond the port's named facts (kept verbatim in the directory's jsonb). */
export interface Carried extends MoveCarried {
  /** Erasure requests the source had ever recorded when the move was requested. */
  readonly erasureCount?: number | undefined;
  /** base64 32-byte key the bundle object is encrypted with (never logged, never shown). */
  readonly transferKey?: string | undefined;
  /** The billing binding, read at the export. */
  readonly subscription?: CarriedSubscription | null | undefined;
  /** Live custom domain hostnames, read at the export; re-added as pending on the target. */
  readonly domains?: readonly string[] | undefined;
}

export function carriedOf(move: Pick<DirectoryMove, "carried">): Carried {
  return (move.carried ?? { planId: null, legalName: null, country: null, holds: [] }) as Carried;
}

/** The holds a move may carry (never `relocation`: each copy's own is the engine's). */
const CARRIED_HOLDS = new Set(["sanctions_review", "operator", "billing", "sanctions"]);

export function carriedHolds(holds: readonly string[]): string[] {
  return [...new Set(holds.filter((h) => CARRIED_HOLDS.has(h)))].sort();
}

export interface MoveDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly directory: DirectoryPort;
  /** This process's cell (CELL_ID). */
  readonly cellId: string;
  /** `WorkspaceResolver.invalidate`, after a committed hold change. */
  readonly invalidate: () => void;
  readonly queue?: Pick<JobQueuePort, "send" | "sendInTransaction"> | undefined;
  /** The object store can presign a GET (S3); moves need it. Default true. */
  readonly canPresign?: boolean | undefined;
  /** This cell's object store: a rolled-back move's bundle objects are deleted from it. */
  readonly storage?: Pick<ObjectStoragePort, "list" | "deleteMany"> | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

/** Every attempt's bundle of a move lives under this prefix of the source cell's object store. */
export function bundlePrefix(workspaceId: string, moveId: string): string {
  return `ws/${workspaceId}/moves/${moveId}/`;
}

/**
 * One export attempt's (encrypted) bundle. Per attempt (fix R1-5): an exporter that lost its
 * lease deletes only its own object, never the one the lease holder published.
 */
export function bundleObjectKey(workspaceId: string, moveId: string, attempt: string): string {
  return `${bundlePrefix(workspaceId, moveId)}${attempt}.bin`;
}

/** Deletes every bundle object of a move (switch, rollback, cancel). Best effort. */
export async function deleteBundles(
  storage: Pick<ObjectStoragePort, "list" | "deleteMany"> | undefined,
  workspaceId: string,
  moveId: string,
): Promise<void> {
  if (storage === undefined) return;
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const listed = await storage.list({
        prefix: bundlePrefix(workspaceId, moveId),
        ...(cursor === undefined ? {} : { cursor }),
      });
      const keys = listed.objects.map((o) => o.key);
      if (keys.length > 0) await storage.deleteMany(keys);
      if (listed.cursor === undefined) break;
      cursor = listed.cursor;
    }
  } catch {
    // the next rollback / poll pass tries again
  }
}

/**
 * The patch that retires a move's secrets (fix R1-7): the presigned URL and the transfer key are
 * needed only until the import; a switched or terminal move keeps neither.
 */
export function secretsCleared(move: Pick<DirectoryMove, "carried">): {
  readonly bundle: null;
  readonly carried: Carried;
} {
  const { transferKey: _dropped, ...rest } = carriedOf(move);
  return { bundle: null, carried: rest as Carried };
}

/**
 * The cells this database serves (fix RR3-3): the directory's cells marked `local`, plus this
 * process's own. Sibling label cells share one database and one job queue, so a process drives the
 * moves of every one of them.
 */
export async function localCellIds(deps: MoveDeps): Promise<string[]> {
  const ids = new Set([deps.cellId]);
  try {
    for (const c of await deps.directory.listCells()) if (c.local) ids.add(c.id);
  } catch {
    // unreachable directory: this process's own cell only
  }
  return [...ids];
}

/** `deps` acting as local cell `cellId` (a sibling label cell of this database). */
export function forCell<T extends MoveDeps>(deps: T, cellId: string): T {
  return cellId === deps.cellId ? deps : { ...deps, cellId };
}

export const MOVE_ACTOR: ControlPlaneActor = { kind: "system", source: "move" };

/** Runs a directory call; an outage becomes `directory_unavailable`. */
export async function dir<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MoveError) throw error;
    const code = (error as { code?: unknown }).code;
    if (code === "move_unavailable")
      throw new MoveError("move_unavailable", "moves need the shared directory", "no_directory");
    throw new MoveError("directory_unavailable", "the cell directory could not be reached");
  }
}

// --- audit ----------------------------------------------------------------------------------------

export type MoveAction =
  | "workspace.move_request"
  | "workspace.move_export"
  | "workspace.move_import"
  | "workspace.move_switch"
  | "workspace.move_retire"
  | "workspace.move_cancel"
  | "workspace.move_fail";

/** Facts every move audit row carries (ids and codes only: never the URL, key or names). */
export function moveFacts(move: DirectoryMove, extra: JsonObject = {}): JsonObject {
  return {
    moveId: move.id,
    sourceCellId: move.sourceCellId,
    targetCellId: move.targetCellId,
    ...extra,
  };
}

export async function auditMoveTenant(
  tx: Tx,
  audit: AuditRecorder,
  workspaceId: string,
  actor: ControlPlaneActor,
  action: MoveAction,
  meta: JsonObject,
  outcome?: "failure",
): Promise<void> {
  await auditTenantChain(tx, audit, workspaceId, actor, {
    action,
    resourceKind: "workspace",
    resourceId: workspaceId,
    ...(outcome === undefined ? {} : { outcome }),
    meta,
  });
}

export async function auditMovePlatform(
  tx: Tx,
  audit: AuditRecorder,
  workspaceId: string,
  actor: ControlPlaneActor,
  action: MoveAction,
  meta: JsonObject,
  outcome?: "failure",
): Promise<void> {
  await auditPlatformChain(tx, audit, actor, {
    action,
    resourceKind: "workspace",
    resourceId: workspaceId,
    ...(outcome === undefined ? {} : { outcome }),
    meta: { ...meta, workspaceId },
  });
}

// --- the public view ------------------------------------------------------------------------------

export interface MoveView {
  readonly id: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly sourceCellId: string;
  readonly targetCellId: string;
  readonly sourceRegion: string | null;
  readonly targetRegion: string | null;
  readonly state: MoveState;
  readonly error: { readonly stage: string; readonly code: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `MoveSchema`: never the bundle, the carried facts or the lease. */
export function moveView(move: DirectoryMove, cells: readonly DirectoryCell[]): MoveView {
  const region = (id: string) => cells.find((c) => c.id === id)?.region ?? null;
  return {
    id: move.id,
    workspaceId: move.sourceWorkspaceId,
    slug: move.slug,
    sourceCellId: move.sourceCellId,
    targetCellId: move.targetCellId,
    sourceRegion: region(move.sourceCellId),
    targetRegion: region(move.targetCellId),
    state: move.state,
    error: move.error === null ? null : { stage: move.error.stage, code: move.error.code },
    createdAt: move.createdAt.toISOString(),
    updatedAt: move.updatedAt.toISOString(),
  };
}

async function cellsOf(deps: MoveDeps): Promise<DirectoryCell[]> {
  return dir(() => deps.directory.listCells());
}

// --- request --------------------------------------------------------------------------------------

export interface RequestMoveInput {
  readonly workspaceId: string;
  readonly targetCellId: string;
  readonly confirmSlug: string;
  readonly actor: ControlPlaneActor;
  /** Opaque operator reference stored on the move (never an email): `op:<user id>`, `cli:<os user>`. */
  readonly requestedBy: string;
}

/** Why the target cannot take a move now, or null. */
export function targetRefusal(
  target: DirectoryCell | undefined,
  now: Date,
): Exclude<MoveRefusal, "no_directory"> | null {
  if (target === undefined) return "target_unknown";
  if (target.local) return "target_local";
  if (target.status !== "active") return "target_inactive";
  if (
    target.heartbeatAt === null ||
    now.getTime() - target.heartbeatAt.getTime() > MOVE_TARGET_FRESH_MS
  )
    return "target_stale";
  return null;
}

const REFUSAL_TEXT: Record<MoveRefusal, string> = {
  no_directory: "moves need the shared cell directory (DIRECTORY_DATABASE_URL)",
  target_unknown: "no such cell in the directory",
  target_local: "that cell is served by this database: change the workspace's cell instead",
  target_inactive: "that cell takes no new workspaces",
  target_stale: "that cell has not reported to the directory in the last 15 minutes",
  source_remote: "the workspace's cell is not served by this process's directory entry",
  deleted: "the workspace is being deleted",
  legal_hold: "the workspace is under legal hold",
  erasure_open: "an erasure request is still open; finish it before moving the workspace",
  not_in_directory: "the workspace has no directory entry yet (the reconcile sweep adds it)",
  storage: "moves need an object store that can presign downloads (STORAGE_DRIVER=s3)",
  sanctions_review:
    "the workspace awaits its first sanctions screening; clear or decide it before moving the workspace",
};

export function refuse(reason: MoveRefusal): MoveError {
  return new MoveError("move_unavailable", REFUSAL_TEXT[reason], reason);
}

/**
 * Requests a move (operator): holds the workspace (`relocation`), records the move in the
 * directory and enqueues the export — the local writes in one transaction under the workspace
 * row lock, the directory row created inside it (a `busy` directory rolls the local writes back).
 */
export async function requestMove(deps: MoveDeps, input: RequestMoveInput): Promise<MoveView> {
  const now = deps.now?.() ?? new Date();
  if (deps.directory.mode !== "shared") throw refuse("no_directory");
  if (deps.canPresign === false) throw refuse("storage");
  const current = await deps.db.withHost((tx) => readMoveWorkspace(tx, input.workspaceId));
  if (current === undefined) throw new MoveError("not_found", "no such workspace");
  if (input.confirmSlug.trim().toLowerCase() !== current.slug)
    throw new MoveError("confirmation_mismatch", "type the workspace slug to confirm");
  const cells = await cellsOf(deps);
  const why = targetRefusal(
    cells.find((c) => c.id === input.targetCellId),
    now,
  );
  if (why !== null) throw refuse(why);

  let created: DirectoryMove | undefined;
  let afterCommit: (() => void) | undefined;
  try {
    // The workspace's own system context: its erasure requests are fenced from the host.
    const move = await deps.db.withTenant(systemContext(input.workspaceId), async (tx) => {
      const ws = await lockMoveWorkspace(tx, input.workspaceId);
      if (ws === undefined) throw new MoveError("not_found", "no such workspace");
      if (ws.deletedAt !== null) throw refuse("deleted");
      if (ws.legalHold) throw refuse("legal_hold");
      if (ws.holds.includes("relocation"))
        throw new MoveError("move_busy", "the workspace is already moving");
      if (!cells.some((c) => c.id === ws.cellId && c.local)) throw refuse("source_remote");
      // Fix RR3-3: any process of this database may request (and drive) the move of a workspace
      // on any of its cells — the job queue is shared by every cell of a database; the source cell
      // is the workspace's own (`source_remote` above refuses a cell this database does not serve).
      // Fix RR2-2: a workspace still awaiting its first screen is not moved (the screening that
      // would release it is this cell's record, which does not travel).
      if (ws.holds.includes("sanctions_review")) throw refuse("sanctions_review");
      const erasures = await erasureCounts(tx, ws.id);
      if (erasures.open > 0) throw refuse("erasure_open");
      const carried: Carried = {
        planId: ws.planId,
        legalName: ws.legalName,
        country: ws.country,
        holds: carriedHolds(ws.holds),
        erasureCount: erasures.total,
        transferKey: newTransferKey(),
      };
      const result = await dir(() =>
        deps.directory.moves.request({
          workspaceId: ws.id,
          slug: ws.slug,
          sourceCellId: ws.cellId,
          targetCellId: input.targetCellId,
          requestedBy: input.requestedBy.slice(0, 200),
          carried,
        }),
      );
      if (result === "busy") throw new MoveError("move_busy", "a move of this workspace is live");
      if (result === "unknown_workspace") throw refuse("not_in_directory");
      created = result;
      const meta = moveFacts(result, { holds: carried.holds });
      // Lock order: the workspace row (held), the tenant chain, then the platform chain.
      await auditMoveTenant(tx, deps.audit, ws.id, input.actor, "workspace.move_request", meta);
      const hold = await setWorkspaceHold(
        tx,
        {
          workspaceId: ws.id,
          hold: "relocation",
          on: true,
          actor: input.actor,
          meta: { moveId: result.id },
        },
        { audit: deps.audit, invalidate: deps.invalidate, now: deps.now },
      );
      afterCommit = hold.afterCommit;
      await auditMovePlatform(tx, deps.audit, ws.id, input.actor, "workspace.move_request", meta);
      await deps.queue?.sendInTransaction(
        tx,
        MOVE_EXPORT_JOB,
        { moveId: result.id },
        { idempotencyKey: result.id },
      );
      return result;
    });
    afterCommit?.();
    // Best effort: the export step sets it again (and the poll repairs a lost one).
    await deps.directory.setState(move.sourceWorkspaceId, "moving").catch(() => undefined);
    return moveView(move, cells);
  } catch (error) {
    // The directory row exists but the local writes did not commit: fail it, so the entry is
    // free for a new request (nothing local happened, so there is nothing to roll back).
    const orphan = created as DirectoryMove | undefined;
    if (orphan !== undefined) {
      await deps.directory.moves
        .transition(orphan.id, {
          from: ["requested"],
          to: "failed",
          patch: { error: { stage: "request", code: "internal" }, ...secretsCleared(orphan) },
        })
        .catch(() => undefined);
    }
    throw error;
  }
}

// --- read -----------------------------------------------------------------------------------------

/** Moves this cell is the source or the target of, newest first. */
export async function listMoves(
  deps: MoveDeps,
  filter: { readonly workspaceId?: string | undefined; readonly state?: MoveState | undefined },
): Promise<MoveView[]> {
  if (deps.directory.mode !== "shared") return [];
  const cells = await cellsOf(deps);
  const local = await localCellIds(deps);
  const byId = new Map<string, DirectoryMove>();
  for (const cellId of local) {
    const moves = await dir(() =>
      deps.directory.moves.list({
        cellId,
        ...(filter.workspaceId === undefined ? {} : { workspaceId: filter.workspaceId }),
        ...(filter.state === undefined ? {} : { states: [filter.state] }),
        limit: 200,
      }),
    );
    for (const m of moves) byId.set(m.id, m);
  }
  return [...byId.values()]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id))
    .slice(0, 200)
    .map((m) => moveView(m, cells));
}

export async function getMove(deps: MoveDeps, id: string): Promise<MoveView | undefined> {
  if (deps.directory.mode !== "shared") return undefined;
  const move = await dir(() => deps.directory.moves.get(id));
  const local = await localCellIds(deps);
  if (move === null || (!local.includes(move.sourceCellId) && !local.includes(move.targetCellId)))
    return undefined;
  return moveView(move, await cellsOf(deps));
}

// --- cancel ---------------------------------------------------------------------------------------

/**
 * Cancels a move that has not finished importing. The directory row flips first (compare-and-set,
 * no lease: a running step loses its next heartbeat and stops); the source copy is rolled back at
 * once when this cell is the source, else by the source's next poll. The target discards any copy
 * it had already written when it sees the cancellation.
 */
export async function cancelMove(
  deps: MoveDeps,
  id: string,
  actor: ControlPlaneActor,
): Promise<MoveView> {
  if (deps.directory.mode !== "shared") throw refuse("no_directory");
  const move = await dir(() => deps.directory.moves.get(id));
  const local = await localCellIds(deps);
  if (move === null || (!local.includes(move.sourceCellId) && !local.includes(move.targetCellId)))
    throw new MoveError("not_found", "no such move");
  if (!CANCELLABLE_MOVE_STATES.includes(move.state))
    throw new MoveError("not_cancellable", `a move in state ${move.state} cannot be cancelled`);
  const cancelled = await dir(() =>
    deps.directory.moves.transition(id, {
      from: [...CANCELLABLE_MOVE_STATES],
      to: "cancelled",
      patch: secretsCleared(move),
    }),
  );
  if (cancelled === null)
    throw new MoveError("not_cancellable", "the move moved on; it can no longer be cancelled");
  if (local.includes(cancelled.sourceCellId)) {
    await rollbackSource(
      forCell(deps, cancelled.sourceCellId),
      cancelled,
      actor,
      "workspace.move_cancel",
    );
  } else {
    await deps.db.withHost((tx) =>
      auditMovePlatform(
        tx,
        deps.audit,
        cancelled.sourceWorkspaceId,
        actor,
        "workspace.move_cancel",
        moveFacts(cancelled),
      ),
    );
  }
  return moveView(cancelled, await cellsOf(deps));
}

/**
 * Undoes a move on the source after it failed or was cancelled: lifts `relocation`, sets the
 * directory entry back to `active`, audits (`move_fail` / `move_cancel`) on both chains.
 * Idempotent: a workspace without the hold is left alone (and nothing is audited again).
 */
export async function rollbackSource(
  deps: MoveDeps,
  move: DirectoryMove,
  actor: ControlPlaneActor,
  action: "workspace.move_fail" | "workspace.move_cancel",
): Promise<boolean> {
  let afterCommit: (() => void) | undefined;
  let deleted = false;
  const changed = await deps.db.withTenant(systemContext(move.sourceWorkspaceId), async (tx) => {
    const ws = await lockMoveWorkspace(tx, move.sourceWorkspaceId);
    deleted = ws !== undefined && ws.deletedAt !== null;
    if (ws === undefined || !ws.holds.includes("relocation")) return false;
    const meta = moveFacts(
      move,
      move.error === null ? {} : { stage: move.error.stage, code: move.error.code },
    );
    const outcome = action === "workspace.move_fail" ? "failure" : undefined;
    await auditMoveTenant(tx, deps.audit, ws.id, actor, action, meta, outcome);
    const hold = await setWorkspaceHold(
      tx,
      { workspaceId: ws.id, hold: "relocation", on: false, actor, meta: { moveId: move.id } },
      { audit: deps.audit, invalidate: deps.invalidate, now: deps.now },
    );
    afterCommit = hold.afterCommit;
    await auditMovePlatform(tx, deps.audit, ws.id, actor, action, meta, outcome);
    return true;
  });
  afterCommit?.();
  // Fix RR1-6: a source deleted meanwhile is released too, and its entry goes dormant (still
  // holding the slug for the restore window, never routed), not active.
  await deps.directory
    .setState(move.sourceWorkspaceId, deleted ? "dormant" : "active")
    .catch(() => undefined);
  await deleteBundles(deps.storage, move.sourceWorkspaceId, move.id);
  if (changed) deps.log?.("moves.rolled_back", { moveId: move.id, state: move.state, action });
  return changed;
}
