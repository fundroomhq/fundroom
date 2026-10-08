import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ciphertextLength, encryptStream } from "@fundroom/crypto";
import { systemContext, type Tx } from "@fundroom/db";
import {
  exportWorkspace,
  type ImportDeps,
  importWorkspace,
  PortabilityError,
  verifyExportFile,
} from "@fundroom/portability";
import type {
  DirectoryCell,
  DirectoryMove,
  JobDefinition,
  JsonObject,
  MoveState,
  ObjectStoragePort,
  OutboundFetch,
} from "@fundroom/ports";
import { setWorkspaceHold } from "../workspaces/status.js";
import {
  deleteSubscription,
  discardCopy,
  erasureCounts,
  insertSubscription,
  listRelocating,
  liveCustomDomains,
  liveWorkspacesBySlug,
  lockMoveWorkspace,
  lockSubscription,
  markMovedAway,
  moveIdOfCopy,
  planExists,
  readMoveWorkspace,
  readSubscription,
  replaceSubscription,
} from "./repos/move-repo.js";
import {
  auditMovePlatform,
  auditMoveTenant,
  bundleObjectKey,
  type Carried,
  carriedHolds,
  carriedOf,
  deleteBundles,
  forCell,
  LIVE_MOVE_STATES,
  localCellIds,
  MOVE_ACTOR,
  MOVE_BUNDLE_TTL_SECONDS,
  MOVE_EXPORT_JOB,
  MOVE_HEARTBEAT_MS,
  MOVE_IMPORT_JOB,
  MOVE_LEASE_MS,
  MOVE_POLL_JOB,
  MOVE_RETIRE_JOB,
  type MoveDeps,
  moveFacts,
  rollbackSource,
  secretsCleared,
} from "./service.js";
import { downloadBundle, TransferError, transferKeyBytes } from "./transfer.js";

/*
 * The moves engine (E3.11): the jobs each cell runs for the moves it is the source or the target
 * of. Every step is idempotent and safe to re-run after a crash between any two statements; the
 * minute `move.poll` is the repair path for all of them:
 *
 *   source  requested/exporting (lease free) → export again   (`runMoveExport`)
 *           exported past the bundle's expiry → failed bundle_expired, rolled back
 *           imported → the switchover (`switchMove`)
 *           switched → the local copy marked moved-away, the bundle object deleted, and once the
 *                      purge has shredded it → retired (`retireMoves`)
 *           failed / cancelled → rolled back (`rollbackSource`), the bundle object deleted
 *   target  exported / importing (lease free) → import (`runMoveImport`, which also adopts a
 *           copy a crashed import committed)
 *           switched → `relocation` lifted on the copy (holds re-applied), domains re-added
 *           failed / cancelled → the copy (if any) discarded
 *
 * The bundle URL and the transfer key live only in the directory row and in memory here: never in
 * a log line, an audit row, an error or an API response.
 */

export interface MoveEngineDeps extends MoveDeps {
  /** This cell's object store (the bundle is written and deleted here on the source). */
  readonly storage: ObjectStoragePort;
  /** A presigned GET valid for `expiresInSeconds` (a signer whose cap allows 24 h). */
  readonly presignBundle: (key: string, expiresInSeconds: number) => Promise<string>;
  /** The portability engine's dependencies (export and import). */
  readonly portability: Omit<ImportDeps, "cellId" | "directory">;
  /** DATA_DIR: bundles are spooled under `<dataDir>/moves/`. */
  readonly dataDir: string;
  /** The SSRF-guarded fetch for bundle downloads (its own byte cap and deadline). */
  readonly fetch: OutboundFetch;
  /** MOVE_MAX_BUNDLE_BYTES. */
  readonly maxBundleBytes: number;
  /** MOVE_SOURCE_RETENTION_HOURS. */
  readonly retentionHours: number;
  /** One pass of the workspace purge (crypto-shreds deleted workspaces whose time has come). */
  readonly purge?: (() => Promise<void>) | undefined;
  /** Re-adds carried custom domains to the copy as pending (best effort, after the switch). */
  readonly readdDomains?:
    | ((workspaceId: string, hostnames: readonly string[]) => Promise<void>)
    | undefined;
  /** TEST SEAMS. */
  readonly leaseMs?: number | undefined;
  readonly heartbeatMs?: number | undefined;
  /** TEST SEAM: tables tolerated without a portability decision (see the export engine). */
  readonly allowUndeclared?: readonly string[] | undefined;
}

/**
 * A transaction in the workspace's own `system` context: its import record, erasure requests and
 * custom domains are fenced from the host actor.
 */
function inWorkspace<T>(
  deps: MoveDeps,
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return deps.db.withTenant(systemContext(workspaceId), fn);
}

/** The live local copy a move's import created (crash repair), found by slug then import record. */
async function findCopy(
  deps: MoveDeps,
  move: DirectoryMove,
): Promise<{ readonly workspaceId: string } | undefined> {
  const candidates = await deps.db.withHost((tx) => liveWorkspacesBySlug(tx, move.slug));
  for (const id of candidates) {
    if ((await inWorkspace(deps, id, (tx) => moveIdOfCopy(tx, id))) === move.id)
      return { workspaceId: id };
  }
  return undefined;
}

/** A requested move without its source hold is an orphan only after this long (fix RR1-5). */
export const MOVE_REQUEST_GRACE_MS = 2 * 60_000;

/** Clock skew tolerated between the directory's clock and the source cell's (fix R1-11). */
export const MOVE_CLOCK_SKEW_MS = 5 * 60_000;

/** A log-safe tag for an error: its name and code, never its message (fix R1-8). */
function errorTag(error: unknown): string {
  if (!(error instanceof Error)) return "error";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/u.test(code)
    ? `${error.name}:${code}`
    : error.name;
}

/**
 * The source cell's published export key that signed the bundle (fix R1-6): every key of its
 * ring is published with its key id, and the bundle names the one it was signed with, so a key
 * rotation between export and import does not fail the move. Falls back to the cell's current key.
 * Never a key carried in the bundle.
 */
export function publishedKeyFor(cell: DirectoryCell, keyId: string): string | null {
  const ring = cell.exportPublicKeys ?? [];
  if (ring.length > 0) {
    // A published ring decides alone: a key id it does not list is not the source's key.
    const match = ring.find((k) => k.keyId === keyId)?.publicKey;
    return match !== undefined && match.length > 0 ? match : null;
  }
  return cell.exportPublicKey !== null && cell.exportPublicKey.length > 0
    ? cell.exportPublicKey
    : null;
}

const SPOOL_RE = /^(export|import)-([0-9a-f-]{36})\.zip$/u;

/**
 * Deletes plaintext spool files of `<DATA_DIR>/moves/` that no live step of this cell needs (fix
 * R1-10): an export file unless its move is still requested/exporting, an import file unless it
 * is still importing. Runs every poll (and so right after boot). Best effort; returns the count.
 */
export async function sweepMoveSpool(deps: MoveEngineDeps): Promise<number> {
  const dir = join(deps.dataDir, "moves");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const m = SPOOL_RE.exec(name);
    if (m === null) continue;
    const move = await deps.directory.moves.get(m[2] as string).catch(() => undefined);
    if (move === undefined) continue; // directory unreachable: next pass
    const live =
      move !== null &&
      (m[1] === "export"
        ? move.state === "requested" || move.state === "exporting"
        : move.state === "importing");
    if (live) continue;
    await rm(join(dir, name), { force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

function nowOf(deps: MoveDeps): Date {
  return deps.now?.() ?? new Date();
}

function leaseOwner(deps: MoveDeps): string {
  return `${deps.cellId}:${randomUUID()}`;
}

function warn(deps: MoveDeps, event: string, fields: Record<string, unknown>): void {
  deps.log?.(event, { level: "warn", ...fields });
}

/**
 * A lease heartbeat for a long step: beats every `heartbeatMs` on the directory's own pool (never
 * the cell's, so a step inside a cell transaction cannot starve it); `lost` turns true once a beat
 * is refused (cancelled, failed, or the lease expired and was taken) or no beat got through for a
 * whole lease period.
 */
function keepLease(deps: MoveEngineDeps, id: string, owner: string) {
  const ttl = deps.leaseMs ?? MOVE_LEASE_MS;
  const state = { lost: false };
  let lastOk = Date.now();
  const timer = setInterval(() => {
    deps.directory.moves
      .heartbeat(id, owner, ttl)
      .then((ok) => {
        if (ok) lastOk = Date.now();
        else state.lost = true;
      })
      .catch(() => {
        // Fix R1-1: beats that cannot reach the directory for a whole lease period mean the lease
        // may be someone else's now — stop, never assume it is still ours.
        if (Date.now() - lastOk >= ttl) state.lost = true;
      });
  }, deps.heartbeatMs ?? MOVE_HEARTBEAT_MS);
  timer.unref();
  return {
    state,
    stop: async (release: boolean) => {
      clearInterval(timer);
      // A zero-length heartbeat ends the lease at once, so the other cell need not wait it out.
      if (release) await deps.directory.moves.heartbeat(id, owner, 0).catch(() => false);
    },
  };
}

/** Marks a move failed (compare-and-set) and records `move_fail` on this cell's platform chain. */
async function failMove(
  deps: MoveEngineDeps,
  move: DirectoryMove,
  from: MoveState[],
  error: { stage: string; code: string },
  owner?: string,
): Promise<DirectoryMove | null> {
  const failed = await deps.directory.moves
    .transition(move.id, {
      from,
      to: "failed",
      ...(owner === undefined ? {} : { leaseOwner: owner }),
      patch: { error, ...secretsCleared(move) },
    })
    .catch(() => null);
  if (failed === null) return null;
  deps.log?.("moves.failed", { level: "warn", moveId: move.id, ...error });
  if (failed.sourceCellId === deps.cellId) {
    await rollbackSource(deps, failed, MOVE_ACTOR, "workspace.move_fail");
  } else {
    await deps.db
      .withHost((tx) =>
        auditMovePlatform(
          tx,
          deps.audit,
          failed.sourceWorkspaceId,
          MOVE_ACTOR,
          "workspace.move_fail",
          moveFacts(failed, error),
          "failure",
        ),
      )
      .catch(() => undefined);
  }
  return failed;
}

// --- export (source) ------------------------------------------------------------------------------

export type StepResult = "done" | "skipped" | "failed";

/**
 * `deps` acting as the local cell `cellId` names, or undefined when this database does not serve
 * it (fix RR3-3: sibling label cells share one database and one job queue, so any of their
 * processes drives any of their moves — a job is never dropped for "another" local cell).
 */
async function asLocalCell(
  deps: MoveEngineDeps,
  cellId: string,
): Promise<MoveEngineDeps | undefined> {
  return (await localCellIds(deps)).includes(cellId) ? forCell(deps, cellId) : undefined;
}

/** The `move.export` body (any process of the source cell's database). Never throws. */
export async function runMoveExport(deps: MoveEngineDeps, moveId: string): Promise<StepResult> {
  const found = await deps.directory.moves.get(moveId).catch(() => null);
  if (found === null) return "skipped";
  const scoped = await asLocalCell(deps, found.sourceCellId);
  return scoped === undefined ? "skipped" : exportStep(scoped, moveId);
}

/** The `move.import` body (any process of the target cell's database). Never throws. */
export async function runMoveImport(deps: MoveEngineDeps, moveId: string): Promise<StepResult> {
  const found = await deps.directory.moves.get(moveId).catch(() => null);
  if (found === null) return "skipped";
  const scoped = await asLocalCell(deps, found.targetCellId);
  return scoped === undefined ? "skipped" : importStep(scoped, moveId);
}

/** Export, encrypt, store, presign → `exported`, as the source cell (`deps.cellId`). */
async function exportStep(deps: MoveEngineDeps, moveId: string): Promise<StepResult> {
  const found = await deps.directory.moves.get(moveId).catch(() => null);
  if (found === null || found.sourceCellId !== deps.cellId) return "skipped";
  if (found.state !== "requested" && found.state !== "exporting") return "skipped";
  const owner = leaseOwner(deps);
  const ttl = deps.leaseMs ?? MOVE_LEASE_MS;
  const leased = await deps.directory.moves
    .acquireLease(moveId, owner, ttl, ["requested", "exporting"])
    .catch(() => null);
  if (leased === null) return "skipped";
  let move = leased;
  if (move.state === "requested") {
    const next = await deps.directory.moves
      .transition(moveId, { from: ["requested"], to: "exporting", leaseOwner: owner })
      .catch(() => null);
    if (next === null) return "skipped";
    move = next;
  }
  const lease = keepLease(deps, moveId, owner);
  const dir = join(deps.dataDir, "moves");
  const tmp = join(dir, `export-${moveId}.zip`);
  // This attempt's own object (fix R1-5): a stale exporter never touches the lease holder's.
  const key = bundleObjectKey(move.sourceWorkspaceId, moveId, randomUUID());
  let release = true;
  try {
    const ws = await deps.db.withHost((tx) => readMoveWorkspace(tx, move.sourceWorkspaceId));
    if (ws === undefined || ws.deletedAt !== null) {
      await failMove(deps, move, ["exporting"], { stage: "export", code: "export_failed" }, owner);
      return "failed";
    }
    // Fix R1-9: the request's local transaction sets the hold together with the directory row; a
    // move without it is one whose request failed (and whose "failed" mark was lost) — the
    // operator was told so, so it must never run: fail it instead of holding the workspace now.
    if (!ws.holds.includes("relocation")) {
      // Fix RR1-5: a request whose local transaction is still committing looks the same for a
      // moment: only a move older than the grace window is an orphan.
      // The directory's clock (the lease expiry it just set, minus the TTL), not this process's.
      const dirNow =
        leased.leaseExpiresAt === null
          ? nowOf(deps).getTime()
          : leased.leaseExpiresAt.getTime() - ttl;
      if (dirNow - move.createdAt.getTime() < MOVE_REQUEST_GRACE_MS) return "skipped";
      await failMove(deps, move, ["exporting"], { stage: "request", code: "internal" }, owner);
      return "failed";
    }
    await deps.directory.setState(move.sourceWorkspaceId, "moving");
    await mkdir(dir, { recursive: true });
    const result = await exportWorkspace(deps.portability, {
      workspaceId: move.sourceWorkspaceId,
      includeRawAnalytics: true,
      outPath: tmp,
      allowUndeclared: deps.allowUndeclared,
      onProgress: () => {
        if (lease.state.lost) throw new Error("the move's lease was lost");
      },
    });
    const transferKey = transferKeyBytes(carriedOf(move).transferKey);
    const { size } = result;
    await deps.storage.put(
      key,
      encryptStream(
        transferKey,
        ReadableStream.from(createReadStream(tmp) as AsyncIterable<Uint8Array>),
      ),
      {
        contentType: "application/octet-stream",
        contentLength: ciphertextLength(size),
        metadata: { "sh-format": "she1" },
      },
    );
    const url = await deps.presignBundle(key, MOVE_BUNDLE_TTL_SECONDS);
    const expiresAt = new Date(nowOf(deps).getTime() + MOVE_BUNDLE_TTL_SECONDS * 1000);
    // The billing binding and the domains as of now (the holds are re-read at the switchover).
    const facts = await inWorkspace(deps, move.sourceWorkspaceId, async (tx) => ({
      ws: await readMoveWorkspace(tx, move.sourceWorkspaceId),
      subscription: await readSubscription(tx, move.sourceWorkspaceId),
      domains: await liveCustomDomains(tx, move.sourceWorkspaceId),
    }));
    const carried: Carried = {
      ...carriedOf(move),
      planId: facts.ws?.planId ?? null,
      legalName: facts.ws?.legalName ?? null,
      country: facts.ws?.country ?? null,
      holds: carriedHolds(facts.ws?.holds ?? []),
      subscription: facts.subscription,
      domains: facts.domains,
    };
    const exported = await deps.directory.moves.transition(moveId, {
      from: ["exporting"],
      to: "exported",
      leaseOwner: owner,
      patch: {
        bundle: {
          url,
          sha256: result.sha256,
          bytes: ciphertextLength(size),
          expiresAt: expiresAt.toISOString(),
          signerKeyFingerprint: result.manifest.signature.keyId,
        },
        carried,
      },
    });
    if (exported === null) {
      // Cancelled (or failed) meanwhile: the bundle must not outlive it.
      await deps.storage.delete(key).catch(() => undefined);
      release = false;
      return "skipped";
    }
    await deps.db.withHost(async (tx) => {
      const meta = moveFacts(exported, {
        sizeBytes: exported.bundle?.bytes ?? 0,
        sha256: result.sha256,
        keyId: result.manifest.signature.keyId,
      });
      await auditMoveTenant(
        tx,
        deps.audit,
        move.sourceWorkspaceId,
        MOVE_ACTOR,
        "workspace.move_export",
        meta,
      );
      await auditMovePlatform(
        tx,
        deps.audit,
        move.sourceWorkspaceId,
        MOVE_ACTOR,
        "workspace.move_export",
        meta,
      );
    });
    deps.log?.("moves.exported", { moveId, bytes: exported.bundle?.bytes ?? 0 });
    return "done";
  } catch (error) {
    await deps.storage.delete(key).catch(() => undefined);
    if (lease.state.lost) {
      release = false;
      return "skipped";
    }
    warn(deps, "moves.export_error", { moveId, error: errorTag(error) });
    await failMove(deps, move, ["exporting"], { stage: "export", code: "export_failed" }, owner);
    release = false;
    return "failed";
  } finally {
    await lease.stop(release);
    await rm(tmp, { force: true });
  }
}

// --- import (target) ------------------------------------------------------------------------------

function importFailureCode(error: unknown): { stage: string; code: string } {
  if (error instanceof TransferError)
    return {
      stage: error.code === "sha256_mismatch" ? "verify" : "transfer",
      code: error.code,
    };
  if (error instanceof PortabilityError) {
    switch (error.code) {
      case "unverified_origin":
      case "verification_failed":
        return { stage: "verify", code: "signature_invalid" };
      case "slug_taken":
        return { stage: "import", code: "slug_taken" };
      case "incompatible":
        return { stage: "import", code: "incompatible" };
      default:
        return { stage: "import", code: "import_failed" };
    }
  }
  return { stage: "import", code: "import_failed" };
}

class MoveStepError extends Error {
  constructor(
    readonly stage: string,
    readonly code: string,
  ) {
    super(`${stage}: ${code}`);
  }
}

/**
 * The `move.import` body (target): download, verify against the SOURCE cell's published export
 * key, import under `relocation` with the carried facts → `imported`. Never throws.
 */
async function importStep(deps: MoveEngineDeps, moveId: string): Promise<StepResult> {
  const found = await deps.directory.moves.get(moveId).catch(() => null);
  if (found === null || found.targetCellId !== deps.cellId) return "skipped";
  if (found.state !== "exported" && found.state !== "importing") return "skipped";
  const owner = leaseOwner(deps);
  const ttl = deps.leaseMs ?? MOVE_LEASE_MS;
  const leased = await deps.directory.moves
    .acquireLease(moveId, owner, ttl, ["exported", "importing"])
    .catch(() => null);
  if (leased === null) return "skipped";
  let move = leased;

  // Repair: a crashed import may have committed its copy before it could say so.
  if (move.state === "importing") {
    const copy = await findCopy(deps, move);
    if (copy !== undefined) {
      const done = await deps.directory.moves
        .transition(moveId, {
          from: ["importing"],
          to: "imported",
          leaseOwner: owner,
          patch: { targetWorkspaceId: copy.workspaceId },
        })
        .catch(() => null);
      await deps.directory.moves.heartbeat(moveId, owner, 0).catch(() => false);
      return done === null ? "skipped" : "done";
    }
  } else {
    const next = await deps.directory.moves
      .transition(moveId, { from: ["exported"], to: "importing", leaseOwner: owner })
      .catch(() => null);
    if (next === null) return "skipped";
    move = next;
  }

  const lease = keepLease(deps, moveId, owner);
  const dir = join(deps.dataDir, "moves");
  const file = join(dir, `import-${moveId}.zip`);
  let release = true;
  let imported: string | undefined;
  try {
    const bundle = move.bundle;
    const carried = carriedOf(move);
    if (bundle === null) throw new MoveStepError("transfer", "download_failed");
    if (new Date(bundle.expiresAt).getTime() <= nowOf(deps).getTime())
      throw new MoveStepError("transfer", "bundle_expired");
    // The trust root: the SOURCE cell's key as the directory publishes it — never the bundle's.
    const source = (await deps.directory.listCells()).find((c) => c.id === move.sourceCellId);
    const sourceKey =
      source === undefined ? null : publishedKeyFor(source, bundle.signerKeyFingerprint);
    if (sourceKey === null || sourceKey.length === 0)
      throw new MoveStepError("verify", "unknown_signer");
    // Every plan the copy will reference must exist here (plans are per database).
    const plans = [carried.planId, carried.subscription?.planId].filter(
      (p): p is string => typeof p === "string",
    );
    for (const plan of plans) {
      if (!(await deps.db.withHost((tx) => planExists(tx, plan))))
        throw new MoveStepError("import", "plan_unknown");
    }
    await mkdir(dir, { recursive: true });
    await downloadBundle(deps.fetch, {
      url: bundle.url,
      sha256: bundle.sha256,
      bytes: bundle.bytes,
      maxBytes: deps.maxBundleBytes,
      transferKey: transferKeyBytes(carried.transferKey),
      outPath: file,
      onProgress: () => {
        if (lease.state.lost) throw new MoveStepError("transfer", "download_failed");
      },
    });
    // Signature and every hash, against the source cell's key only; then the manifest must be
    // this move's workspace (a validly signed bundle of another workspace is not this move's).
    const verification = await verifyExportFile(file, { trustedPublicKeys: [sourceKey] });
    if (!verification.ok || verification.trusted !== true || verification.manifest === null)
      throw new MoveStepError("verify", "signature_invalid");
    if (verification.manifest.source.workspaceId !== move.sourceWorkspaceId)
      throw new MoveStepError("verify", "bundle_mismatch");
    // Fix R1-11: an older (validly signed) export of the same workspace is not this move's.
    const exportedAt = Date.parse(verification.manifest.exportedAt);
    if (!Number.isFinite(exportedAt) || exportedAt < move.createdAt.getTime() - MOVE_CLOCK_SKEW_MS)
      throw new MoveStepError("verify", "bundle_mismatch");
    if (lease.state.lost) throw new MoveStepError("import", "import_failed");

    const holds = ["relocation", ...carriedHolds(carried.holds)];
    const result = await importWorkspace(
      { ...deps.portability, cellId: deps.cellId },
      {
        file,
        slug: move.slug,
        trustedPublicKeys: [sourceKey],
        importedBy: `move:${moveId}`.slice(0, 200),
        allowUndeclared: deps.allowUndeclared,
        relocation: {
          moveId,
          holds,
          planId: carried.planId,
          legalName: carried.legalName,
          country: carried.country,
          beforeCommit: async (tx, workspaceId) => {
            if (carried.subscription)
              await insertSubscription(tx, workspaceId, carried.subscription);
            const meta = moveFacts(move, { holds: carriedHolds(carried.holds) });
            await auditMoveTenant(
              tx,
              deps.audit,
              workspaceId,
              MOVE_ACTOR,
              "workspace.move_import",
              meta,
            );
            await auditMovePlatform(
              tx,
              deps.audit,
              workspaceId,
              MOVE_ACTOR,
              "workspace.move_import",
              meta,
            );
          },
        },
      },
    );
    imported = result.workspaceId;
    const done = await deps.directory.moves.transition(moveId, {
      from: ["importing"],
      to: "imported",
      leaseOwner: owner,
      patch: { targetWorkspaceId: result.workspaceId },
    });
    if (done === null) {
      // Cancelled, failed, or the lease lost while importing. Fix R1-1: the copy is discarded only
      // when the directory says it is not this move's (a new lease holder may have adopted it).
      await discardIfNotAdopted(deps, moveId, result.workspaceId);
      release = false;
      return "skipped";
    }
    deps.log?.("moves.imported", { moveId, workspaceId: result.workspaceId });
    return "done";
  } catch (error) {
    if (imported !== undefined)
      await discardIfNotAdopted(deps, moveId, imported).catch(() => undefined);
    const why =
      error instanceof MoveStepError
        ? { stage: error.stage, code: error.code }
        : importFailureCode(error);
    warn(deps, "moves.import_error", {
      moveId,
      ...why,
      // Fix R1-8: a name and a code only — never a message (driver errors carry SQL parameters,
      // i.e. tenant data) and never the URL.
      error: errorTag(error),
    });
    release = false;
    if (lease.state.lost) return "skipped";
    await failMove(deps, move, ["importing"], why, owner);
    return "failed";
  } finally {
    await lease.stop(release);
    await rm(file, { force: true });
  }
}

/**
 * Whether a local copy of `move` may be thrown away (fix R1-1): only when the directory says the
 * move is over without it (failed / cancelled), or names ANOTHER workspace as its copy. A copy that
 * is — or may yet become — the move's `targetWorkspaceId` is never discarded, so a switched move
 * can never point at a discarded copy.
 */
export function copyDiscardable(move: DirectoryMove | null, workspaceId: string): boolean {
  if (move === null) return true; // no such move at all (rows are never deleted)
  if (move.state === "failed" || move.state === "cancelled") return true;
  return move.targetWorkspaceId !== null && move.targetWorkspaceId !== workspaceId;
}

/** Re-reads the move and discards the copy only when `copyDiscardable` says so. */
async function discardIfNotAdopted(
  deps: MoveEngineDeps,
  moveId: string,
  workspaceId: string,
): Promise<boolean> {
  const move = await deps.directory.moves.get(moveId).catch(() => undefined);
  // Unknown (directory unreachable): keep it; the poll decides later with a fresh read.
  if (move === undefined || !copyDiscardable(move, workspaceId)) return false;
  await discardLocalCopy(deps, workspaceId);
  return true;
}

/** Deletes a copy this cell imported for a move that will not switch to it. */
async function discardLocalCopy(deps: MoveEngineDeps, workspaceId: string): Promise<void> {
  await inWorkspace(deps, workspaceId, (tx) => discardCopy(tx, workspaceId, nowOf(deps)));
  deps.invalidate();
  // Its objects: listed under its own prefix and deleted (the purge shreds the keys too).
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const listed = await deps.storage
      .list({ prefix: `ws/${workspaceId}/`, ...(cursor === undefined ? {} : { cursor }) })
      .catch(() => undefined);
    if (listed === undefined) break;
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) await deps.storage.deleteMany(keys).catch(() => undefined);
    if (listed.cursor === undefined) break;
    cursor = listed.cursor;
  }
  await deps.purge?.().catch(() => undefined);
}

// --- switch (source) ------------------------------------------------------------------------------

/**
 * The switchover, by the SOURCE: under its workspace-row lock (which an erasure request needs
 * too), it refuses when an erasure request is open or was recorded after the move was requested
 * (→ failed `erasure_during_move`, rolled back: the copy predates the erasure and must never
 * serve), writes the final holds into `carried`, flips the directory entry, and marks its own
 * copy moved-away (deleted, purge after MOVE_SOURCE_RETENTION_HOURS) with its billing binding
 * removed — all before its local commit, so a crash leaves at worst a switched move whose source
 * is not yet marked (repaired by the poll).
 */
export async function switchMove(outer: MoveEngineDeps, moveId: string): Promise<StepResult> {
  const found = await outer.directory.moves.get(moveId).catch(() => null);
  if (found === null) return "skipped";
  const deps = await asLocalCell(outer, found.sourceCellId);
  if (deps === undefined) return "skipped";
  const owner = leaseOwner(deps);
  const ttl = deps.leaseMs ?? MOVE_LEASE_MS;
  const leased = await deps.directory.moves
    .acquireLease(moveId, owner, ttl, ["imported"])
    .catch(() => null);
  if (leased === null || leased.sourceCellId !== deps.cellId) return "skipped";
  const move = leased;
  const at = nowOf(deps);
  const purgeAfter = new Date(at.getTime() + deps.retentionHours * 3600_000);
  let refusal: string | undefined;
  let switched: DirectoryMove | null = null;
  try {
    switched = await inWorkspace(deps, move.sourceWorkspaceId, async (tx) => {
      await lockSubscription(tx, move.sourceWorkspaceId);
      const ws = await lockMoveWorkspace(tx, move.sourceWorkspaceId);
      if (ws === undefined) return null;
      const carried = carriedOf(move);
      // Fix R1-2/R1-4: a source deleted, released or put under legal hold since the request must
      // not come back to life on the target (nor leave the move stuck `switched` forever).
      if (ws.deletedAt !== null) {
        refusal = "deleted";
        return null;
      }
      if (!ws.holds.includes("relocation")) {
        refusal = "not_held";
        return null;
      }
      if (ws.legalHold) {
        refusal = "legal_hold";
        return null;
      }
      const counts = await erasureCounts(tx, ws.id);
      if (counts.open > 0 || counts.total !== (carried.erasureCount ?? 0)) {
        refusal = "erasure_during_move";
        return null;
      }
      // The final facts under the locks (fix R1-3: the billing binding as of now, not the
      // export), and the secrets retired (fix R1-7: the copy is imported, nothing fetches again).
      const subscription = await readSubscription(tx, ws.id);
      const final = await deps.directory.moves.transition(moveId, {
        from: ["imported"],
        to: "imported",
        leaseOwner: owner,
        patch: {
          bundle: null,
          carried: {
            ...secretsCleared(move).carried,
            holds: carriedHolds(ws.holds),
            subscription,
          } as Carried,
        },
      });
      if (final === null) return null;
      const flipped = await deps.directory.moves.switchover(moveId, owner);
      if (flipped === null) return null;
      await markMovedAway(tx, ws.id, at, purgeAfter);
      await deleteSubscription(tx, ws.id);
      const meta = moveFacts(flipped, { targetWorkspaceId: flipped.targetWorkspaceId });
      await auditMoveTenant(tx, deps.audit, ws.id, MOVE_ACTOR, "workspace.move_switch", meta);
      await auditMovePlatform(tx, deps.audit, ws.id, MOVE_ACTOR, "workspace.move_switch", meta);
      return flipped;
    });
  } catch (error) {
    warn(deps, "moves.switch_error", { moveId, error: errorTag(error) });
    // If the directory flipped but the local commit failed, the poll's repair marks the source.
  }
  if (refusal !== undefined) {
    await failMove(deps, move, ["imported"], { stage: "switch", code: refusal }, owner);
    return "failed";
  }
  await deps.directory.moves.heartbeat(moveId, owner, 0).catch(() => false);
  if (switched === null) return "skipped";
  deps.invalidate();
  await deleteBundles(deps.storage, move.sourceWorkspaceId, moveId);
  deps.log?.("moves.switched", { moveId, targetCellId: move.targetCellId });
  return "done";
}

/** Source repair after a switch: the local copy marked moved-away (idempotent). */
async function settleSwitchedSource(deps: MoveEngineDeps, move: DirectoryMove): Promise<void> {
  const at = nowOf(deps);
  const marked = await inWorkspace(deps, move.sourceWorkspaceId, async (tx) => {
    await lockSubscription(tx, move.sourceWorkspaceId);
    const ws = await lockMoveWorkspace(tx, move.sourceWorkspaceId);
    if (ws === undefined || ws.deletedAt !== null) return false;
    await markMovedAway(tx, ws.id, at, new Date(at.getTime() + deps.retentionHours * 3600_000));
    await deleteSubscription(tx, ws.id);
    const meta = moveFacts(move, { targetWorkspaceId: move.targetWorkspaceId, repaired: true });
    await auditMoveTenant(tx, deps.audit, ws.id, MOVE_ACTOR, "workspace.move_switch", meta);
    await auditMovePlatform(tx, deps.audit, ws.id, MOVE_ACTOR, "workspace.move_switch", meta);
    return true;
  });
  if (marked) deps.invalidate();
  await deleteBundles(deps.storage, move.sourceWorkspaceId, move.id);
}

// --- target after the switch ---------------------------------------------------------------------

/**
 * The copy goes live: every hold the source had at the switch is (re)applied, then `relocation`
 * is lifted — tenant chain `move_switch`, the holds' own audits, platform chain `move_switch`.
 * Carried custom domains are re-added as pending afterwards (best effort).
 */
async function liftCopy(deps: MoveEngineDeps, move: DirectoryMove, workspaceId: string) {
  const carried = carriedOf(move);
  const wanted = carriedHolds(carried.holds);
  const commits: (() => void)[] = [];
  const lifted = await inWorkspace(deps, workspaceId, async (tx) => {
    // Fix RR1-1: the global lock order — the billing row before the workspace row (as billing,
    // switchMove and settleSwitchedSource take them); the copy's binding is replaced below.
    await lockSubscription(tx, workspaceId);
    const ws = await lockMoveWorkspace(tx, workspaceId);
    if (ws === undefined || ws.deletedAt !== null || !ws.holds.includes("relocation")) return false;
    const meta = moveFacts(move, { holds: wanted });
    await auditMoveTenant(tx, deps.audit, workspaceId, MOVE_ACTOR, "workspace.move_switch", meta);
    const status = { audit: deps.audit, invalidate: deps.invalidate, now: deps.now };
    for (const hold of wanted) {
      if (ws.holds.includes(hold)) continue;
      const h = await setWorkspaceHold(
        tx,
        {
          workspaceId,
          hold: hold as "sanctions_review" | "operator" | "billing" | "sanctions",
          on: true,
          actor: MOVE_ACTOR,
          meta: { moveId: move.id },
        },
        status,
      );
      commits.push(h.afterCommit);
    }
    const h = await setWorkspaceHold(
      tx,
      { workspaceId, hold: "relocation", on: false, actor: MOVE_ACTOR, meta: { moveId: move.id } },
      status,
    );
    commits.push(h.afterCommit);
    // The billing binding as the source had it at the switch (fix R1-3).
    if ("subscription" in carried)
      await replaceSubscription(tx, workspaceId, carried.subscription ?? null);
    await auditMovePlatform(tx, deps.audit, workspaceId, MOVE_ACTOR, "workspace.move_switch", meta);
    return true;
  });
  for (const c of commits) c();
  if (!lifted) return;
  deps.log?.("moves.live", { moveId: move.id, workspaceId });
  const domains = carried.domains ?? [];
  if (domains.length > 0 && deps.readdDomains !== undefined) {
    await deps.readdDomains(workspaceId, domains).catch((error: unknown) =>
      warn(deps, "moves.domains_readd_failed", {
        moveId: move.id,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      }),
    );
  }
}

// --- retire (source) ------------------------------------------------------------------------------

/** Switched moves whose source copy the purge has shredded → `retired` (platform chain). */
export async function retireMoves(deps: MoveEngineDeps): Promise<number> {
  const switched = await deps.directory.moves
    .list({ cellId: deps.cellId, role: "source", states: ["switched"], limit: 100 })
    .catch(() => []);
  let retired = 0;
  let purged = false;
  for (const move of switched) {
    let ws = await deps.db.withHost((tx) => readMoveWorkspace(tx, move.sourceWorkspaceId));
    if (ws !== undefined && ws.deletedAt === null) {
      await settleSwitchedSource(deps, move);
      ws = await deps.db.withHost((tx) => readMoveWorkspace(tx, move.sourceWorkspaceId));
    }
    if (
      ws !== undefined &&
      ws.purgedAt === null &&
      ws.purgeAfter !== null &&
      ws.purgeAfter.getTime() <= nowOf(deps).getTime() &&
      !purged
    ) {
      await deps.purge?.().catch(() => undefined);
      purged = true;
      ws = await deps.db.withHost((tx) => readMoveWorkspace(tx, move.sourceWorkspaceId));
    }
    if (ws !== undefined && ws.purgedAt === null) continue;
    const done = await deps.directory.moves
      .transition(move.id, { from: ["switched"], to: "retired" })
      .catch(() => null);
    if (done === null) continue;
    await deps.db.withHost((tx) =>
      auditMovePlatform(
        tx,
        deps.audit,
        move.sourceWorkspaceId,
        MOVE_ACTOR,
        "workspace.move_retire",
        moveFacts(done),
      ),
    );
    retired += 1;
  }
  return retired;
}

// --- the poll -------------------------------------------------------------------------------------

export interface PollResult {
  readonly exported: number;
  readonly imported: number;
  readonly switched: number;
  readonly rolledBack: number;
  readonly lifted: number;
  readonly discarded: number;
  readonly retired: number;
}

function leaseFree(move: DirectoryMove, now: Date): boolean {
  return move.leaseOwner === null || move.leaseExpiresAt === null || move.leaseExpiresAt <= now;
}

/**
 * One `move.poll` pass. `inline`: run export/import steps here instead of enqueuing them (the CLI
 * and tests; the job enqueues so a long import never blocks the minute poll).
 */
export async function pollMoves(
  deps: MoveEngineDeps,
  options: { readonly inline?: boolean | undefined } = {},
): Promise<PollResult> {
  const now = nowOf(deps);
  const counts = {
    exported: 0,
    imported: 0,
    switched: 0,
    rolledBack: 0,
    lifted: 0,
    discarded: 0,
    retired: 0,
  };
  if (deps.directory.mode !== "shared") return counts;
  const run = async (
    job: string,
    step: (d: MoveEngineDeps, id: string) => Promise<StepResult>,
    id: string,
  ): Promise<StepResult> => {
    if (options.inline === true || deps.queue === undefined) return step(deps, id);
    await deps.queue.send(job, { moveId: id }, { idempotencyKey: id });
    return "skipped";
  };

  const local = await localCellIds(deps);
  for (const cellId of local) await pollCellSteps(forCell(deps, cellId), run, now, counts);

  // Every local workspace under `relocation`: source copies and target copies. A workspace can be
  // both (a copy that arrived by an earlier move and is now moving on): the newer move decides.
  const relocating = await deps.db.withHost((tx) => listRelocating(tx, 200));
  for (const found of relocating) {
    // Fix RR3-3: as the workspace's own cell (any cell of this database), and its moves looked up
    // across ALL local cells — a hold is "unexplained" only if no local cell has a move for it.
    const wsDeps = forCell(deps, local.includes(found.cellId) ? found.cellId : deps.cellId);
    await sweepRelocating(wsDeps, found, local, counts);
  }

  await sweepMoveSpool(deps);
  for (const cellId of local) counts.retired += await retireMoves(forCell(deps, cellId));
  return counts;
}

/** One `relocation`-held local workspace: roll back, settle, discard, lift, or release. */
async function sweepRelocating(
  deps: MoveEngineDeps,
  ws: Awaited<ReturnType<typeof listRelocating>>[number],
  local: readonly string[],
  counts: { rolledBack: number; lifted: number; discarded: number },
): Promise<void> {
  {
    const asSource = (
      await deps.directory.moves.list({ workspaceId: ws.id, limit: 20 }).catch(() => undefined)
    )?.filter((m) => m.sourceWorkspaceId === ws.id && local.includes(m.sourceCellId));
    if (asSource === undefined) return; // directory outage: next pass
    const latest = asSource.find((m) => m.sourceWorkspaceId === ws.id);
    const copyId = await inWorkspace(deps, ws.id, (tx) => moveIdOfCopy(tx, ws.id));
    const copyMove =
      copyId === undefined ? null : await deps.directory.moves.get(copyId).catch(() => undefined);
    if (copyMove === undefined) return;
    const asTarget =
      copyMove !== null &&
      (latest === undefined || copyMove.createdAt.getTime() > latest.createdAt.getTime());

    if (!asTarget && latest !== undefined) {
      if (latest.state === "failed" || latest.state === "cancelled") {
        const action = latest.state === "failed" ? "workspace.move_fail" : "workspace.move_cancel";
        if (await rollbackSource(deps, latest, MOVE_ACTOR, action)) counts.rolledBack += 1;
      } else if (latest.state === "switched" || latest.state === "retired") {
        await settleSwitchedSource(deps, latest);
      }
      return; // a live move: the steps above drive it
    }
    if (copyId !== undefined) {
      if (copyDiscardable(copyMove, ws.id)) {
        await discardLocalCopy(deps, ws.id);
        counts.discarded += 1;
      } else if (
        copyMove !== null &&
        (copyMove.state === "switched" || copyMove.state === "retired") &&
        copyMove.targetWorkspaceId === ws.id
      ) {
        await liftCopy(deps, copyMove, ws.id);
        counts.lifted += 1;
      }
      return;
    }
    // A `relocation` hold no move explains (the directory row never got written): lifted.
    let afterCommit: (() => void) | undefined;
    await deps.db.withHost(async (tx) => {
      const h = await setWorkspaceHold(
        tx,
        { workspaceId: ws.id, hold: "relocation", on: false, actor: MOVE_ACTOR },
        { audit: deps.audit, invalidate: deps.invalidate, now: deps.now },
      );
      afterCommit = h.afterCommit;
    });
    afterCommit?.();
    await deps.directory.setState(ws.id, "active").catch(() => undefined);
    counts.rolledBack += 1;
  }
}

/** The source and target steps of one local cell's moves (fix RR3-3: every local cell). */
async function pollCellSteps(
  deps: MoveEngineDeps,
  run: (
    job: string,
    step: (d: MoveEngineDeps, id: string) => Promise<StepResult>,
    id: string,
  ) => Promise<StepResult>,
  now: Date,
  counts: { exported: number; imported: number; switched: number },
): Promise<void> {
  // Source side.
  const outbound = await deps.directory.moves.list({
    cellId: deps.cellId,
    role: "source",
    states: [...LIVE_MOVE_STATES],
    limit: 200,
  });
  for (const move of outbound) {
    if ((move.state === "requested" || move.state === "exporting") && leaseFree(move, now)) {
      if ((await run(MOVE_EXPORT_JOB, runMoveExport, move.id)) === "done") counts.exported += 1;
    } else if (move.state === "exported") {
      const expires = move.bundle === null ? 0 : new Date(move.bundle.expiresAt).getTime();
      if (expires <= now.getTime())
        await failMove(deps, move, ["exported"], { stage: "transfer", code: "bundle_expired" });
    } else if (move.state === "imported" && leaseFree(move, now)) {
      if ((await switchMove(deps, move.id)) === "done") counts.switched += 1;
    }
  }

  // Target side.
  const inbound = await deps.directory.moves.list({
    cellId: deps.cellId,
    role: "target",
    states: ["exported", "importing"],
    limit: 200,
  });
  for (const move of inbound) {
    if (!leaseFree(move, now)) continue;
    if ((await run(MOVE_IMPORT_JOB, runMoveImport, move.id)) === "done") counts.imported += 1;
  }
}

export function createMoveJobs(deps: MoveEngineDeps): JobDefinition<JsonObject>[] {
  const once = { retryLimit: 0, expireInSeconds: 12 * 3600, deadLetter: false } as const;
  return [
    {
      name: MOVE_EXPORT_JOB,
      queue: { ...once, policy: "short" },
      handler: async (job) => {
        const id = job.data["moveId"];
        if (typeof id === "string") await runMoveExport(deps, id);
      },
    },
    {
      name: MOVE_IMPORT_JOB,
      queue: { ...once, policy: "short" },
      handler: async (job) => {
        const id = job.data["moveId"];
        if (typeof id === "string") await runMoveImport(deps, id);
      },
    },
    {
      name: MOVE_POLL_JOB,
      cron: "* * * * *",
      queue: { retryLimit: 0, deadLetter: false, policy: "singleton" },
      handler: async () => {
        await pollMoves(deps);
      },
    },
    {
      name: MOVE_RETIRE_JOB,
      cron: "41 * * * *",
      queue: { retryLimit: 0, deadLetter: false },
      handler: async () => {
        if (deps.directory.mode === "shared") await retireMoves(deps);
      },
    },
  ];
}
