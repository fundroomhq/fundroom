import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { AuditRecorder } from "@fundroom/audit";
import { ciphertextLength, decryptStream, encryptStream } from "@fundroom/crypto";
import { pgErrorCode, systemContext, type TenantContext, type Tx } from "@fundroom/db";
import type { JobDefinition, JobQueuePort, JsonObject } from "@fundroom/ports";
import { PortabilityError } from "./errors.js";
import { exportWorkspace, type PortabilityEngineDeps } from "./export.js";
import { EXPORT_OBJECT_PURPOSE } from "./format.js";
import { parseShe } from "./objects.js";
import { uuidv7 } from "./remap.js";
import {
  deleteAllExports,
  deleteExportRow,
  dueForExpiry,
  type ExportRow,
  failStale,
  findExport,
  holdWorkspaceAgainstPurge,
  insertExport,
  listExportableWorkspaces,
  listExports,
  markDownloaded,
  markExpired,
  markFailed,
  markReady,
  markRunning,
  touchRunning,
} from "./repos/export-repo.js";

/*
 * The export lifecycle behind `/api/v1/portability/*` and the two kernel jobs:
 *
 *   POST      row `queued` (partial unique index: one queued/running per workspace → 409) +
 *             `workspace.export_requested` + `portability.export` enqueued in the same tx
 *   job       `running` → the engine writes the zip to a temp file under DATA_DIR → SHE1-encrypted
 *             (purpose `workspace-export`) into `ws/<ws>/exports/<id>.zip` → `ready` (+7 days) and
 *             `workspace.export_completed`; any failure → `failed` with a bounded error and
 *             `workspace.export_failed` (never retried blindly: the owner starts a new one)
 *   download  `workspace.export_downloaded`, then the object streamed and decrypted
 *   expire    hourly: ready exports past `expires_at` lose their object and become `expired`;
 *             a running export whose heartbeat stopped 15 min ago, or a queued one nobody picked
 *             up in 12 h, becomes `failed`; orphaned temp files are deleted
 *
 * Crash safety (fix C). The job is never retried, so a worker that dies mid-export must not lock
 * the workspace out: the running job beats (`started_at`, and the temp file's mtime) at least once
 * a minute while it makes progress; 15 minutes without a beat makes the export STALE. A stale
 * export is failed by the next POST (so the owner can start again at once), by the hourly cron, and
 * may be deleted; a queued one may be cancelled (deleted) at any time. A job whose row stopped
 * being `running` under it aborts at its next beat. Temp files older than the stale window are
 * swept when an export starts and hourly.
 */

export const EXPORT_JOB = "portability.export";
export const EXPIRE_JOB = "portability.expire";
export const EXPORT_RETENTION_DAYS = 7;
/** A queued export no worker picked up within this long is failed. */
export const EXPORT_STALE_HOURS = 12;
/** A running export whose heartbeat is older than this is stale (failed, deletable). */
export const EXPORT_STALE_MINUTES = 15;
/** How often (at most) a running export writes its heartbeat. */
export const EXPORT_HEARTBEAT_MS = 60_000;
/** The error text kept on a failed export (the column allows 2 000). */
export const EXPORT_ERROR_MAX = 500;

export interface PortabilityServiceDeps extends PortabilityEngineDeps {
  readonly audit: AuditRecorder;
  /** DATA_DIR (the export's temp file goes to `<dataDir>/portability/`). */
  readonly dataDir: string;
  /** TEST SEAM (see `ExportWorkspaceInput.allowUndeclared`). */
  readonly allowUndeclared?: readonly string[] | undefined;
  /** TEST SEAM: the heartbeat interval (default `EXPORT_HEARTBEAT_MS`). */
  readonly heartbeatMs?: number | undefined;
}

export function exportObjectKey(workspaceId: string, exportId: string): string {
  return `ws/${workspaceId}/exports/${exportId}.zip`;
}

/** Stale-export cutoffs relative to `now`. */
export function staleCutoffs(now: Date): { runningBefore: Date; queuedBefore: Date } {
  return {
    runningBefore: new Date(now.getTime() - EXPORT_STALE_MINUTES * 60_000),
    queuedBefore: new Date(now.getTime() - EXPORT_STALE_HOURS * 3600_000),
  };
}

/** A running export whose heartbeat stopped (its worker died or wedged). */
export function isStaleExport(
  row: Pick<ExportRow, "status" | "startedAt" | "createdAt">,
  now: Date,
): boolean {
  if (row.status !== "running") return false;
  const beat = row.startedAt ?? row.createdAt;
  return beat.getTime() < staleCutoffs(now).runningBefore.getTime();
}

const TEMP_RE = /^export-[0-9a-f-]{36}\.zip$/u;

/**
 * Deletes export temp files under `<dataDir>/portability/` that nothing has written or touched
 * within the stale window — a crashed export's leftovers (a live one refreshes its file's mtime on
 * every heartbeat). Best effort; returns how many went.
 */
export async function sweepExportTempFiles(
  dataDir: string,
  now: Date = new Date(),
): Promise<number> {
  const dir = join(dataDir, "portability");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - EXPORT_STALE_MINUTES * 60_000;
  let removed = 0;
  for (const name of names) {
    if (!TEMP_RE.test(name)) continue;
    const path = join(dir, name);
    try {
      if ((await stat(path)).mtimeMs >= cutoff) continue;
      await rm(path, { force: true });
      removed += 1;
    } catch {
      // raced with its own export's cleanup
    }
  }
  return removed;
}

/** Fails this workspace's stale exports (with `workspace.export_failed`) on the caller's tx. */
async function failStaleExports(
  deps: { readonly audit: AuditRecorder },
  tx: Tx,
  ctx: TenantContext,
  now: Date,
): Promise<number> {
  const ids = await failStale(tx, ctx.workspaceId, staleCutoffs(now), now);
  for (const id of ids) {
    await deps.audit.record(tx, ctx, {
      action: "workspace.export_failed",
      resourceKind: "workspace_export",
      resourceId: id,
      outcome: "failure",
      meta: { code: "stale" },
    });
  }
  return ids.length;
}

/** The unique-violation constraint name of a Postgres error, walking driver wrappers. */
export function pgConstraintOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const c = (current as { constraint?: unknown }).constraint;
    if (typeof c === "string") return c;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export class ExportRunningError extends Error {
  override readonly name = "ExportRunningError";
}

/** Queues an export on the caller's tenant tx. Throws `ExportRunningError` when one is active. */
export async function requestExport(
  deps: {
    readonly audit: AuditRecorder;
    /** Omitted by the CLI, which runs the export itself (a worker must not race it). */
    readonly queue?: Pick<JobQueuePort, "sendInTransaction"> | undefined;
  },
  tx: Tx,
  ctx: TenantContext,
  input: {
    readonly requestedBy: string | null;
    readonly includeRawAnalytics: boolean;
    readonly requestId?: string | null | undefined;
    readonly now?: Date | undefined;
  },
): Promise<ExportRow> {
  // A crashed export must not block this one: fail whatever stopped beating first.
  await failStaleExports(deps, tx, ctx, input.now ?? new Date());
  const id = uuidv7();
  let row: ExportRow;
  try {
    // A savepoint, so a 23505 leaves the caller's transaction usable.
    row = await tx.transaction((sp) =>
      insertExport(sp, {
        id,
        workspaceId: ctx.workspaceId,
        requestedBy: input.requestedBy,
        includeRawAnalytics: input.includeRawAnalytics,
      }),
    );
  } catch (error) {
    if (pgErrorCode(error) === "23505" && pgConstraintOf(error) === "workspace_export_active_idx")
      throw new ExportRunningError("an export of this workspace is already queued or running");
    throw error;
  }
  await deps.audit.record(tx, ctx, {
    action: "workspace.export_requested",
    resourceKind: "workspace_export",
    resourceId: id,
    requestId: input.requestId ?? null,
    meta: { includeRawAnalytics: input.includeRawAnalytics },
  });
  await deps.queue?.sendInTransaction(tx, EXPORT_JOB, {
    exportId: id,
    workspaceId: ctx.workspaceId,
  });
  return row;
}

function boundedError(error: unknown): string {
  const text =
    error instanceof PortabilityError
      ? error.message
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  return text.replace(/\s+/gu, " ").slice(0, EXPORT_ERROR_MAX);
}

export interface RunExportResult {
  readonly status: "ready" | "failed" | "skipped";
  readonly row?: ExportRow | undefined;
  readonly error?: string | undefined;
}

/** The `portability.export` job body (also the CLI's, which passes `copyTo`). Never throws. */
export async function runExport(
  deps: PortabilityServiceDeps,
  input: {
    readonly exportId: string;
    readonly workspaceId: string;
    readonly copyTo?: string | undefined;
  },
): Promise<RunExportResult> {
  const now = () => deps.now?.() ?? new Date();
  const ctx = systemContext(input.workspaceId);
  const claimed = await deps.db.withTenant(ctx, async (tx) => {
    const row = await findExport(tx, input.workspaceId, input.exportId, true);
    if (row === undefined) return undefined;
    return (await markRunning(tx, input.workspaceId, input.exportId, now())) ? row : undefined;
  });
  if (claimed === undefined) return { status: "skipped" };

  const dir = join(deps.dataDir, "portability");
  const tmp = join(dir, `export-${input.exportId}.zip`);
  let stored: string | undefined;
  // The heartbeat: at most once a minute, fire-and-forget (never awaited while the snapshot
  // transaction holds a connection — with a one-connection pool it simply waits for the commit);
  // it also refreshes the temp file's mtime so the sweeper leaves a live export alone. When the
  // row is no longer `running` (failed as stale, deleted) the next progress call aborts the job.
  let lastBeat = Date.now();
  let beating: Promise<void> | undefined;
  let lost = false;
  const beat = () => {
    if (lost)
      throw new PortabilityError(
        "cancelled",
        "the export was cancelled or marked stale while it was being written",
      );
    if (beating !== undefined || Date.now() - lastBeat < (deps.heartbeatMs ?? EXPORT_HEARTBEAT_MS))
      return;
    lastBeat = Date.now();
    beating = (async () => {
      await utimes(tmp, new Date(), new Date()).catch(() => undefined);
      const alive = await deps.db.withTenant(ctx, (tx) =>
        touchRunning(tx, input.workspaceId, input.exportId, now()),
      );
      if (!alive) lost = true;
    })()
      .catch(() => undefined)
      .finally(() => {
        beating = undefined;
      });
  };
  try {
    await mkdir(dir, { recursive: true });
    await sweepExportTempFiles(deps.dataDir).catch(() => 0);
    const result = await exportWorkspace(deps, {
      workspaceId: input.workspaceId,
      includeRawAnalytics: claimed.options.includeRawAnalytics,
      outPath: tmp,
      allowUndeclared: deps.allowUndeclared,
      onProgress: beat,
    });
    // A checkpoint between the phases that is awaited (the per-chunk beats are not): the row must
    // still be ours before the file is stored.
    await beating;
    const stillOurs = await deps.db.withTenant(ctx, (tx) =>
      touchRunning(tx, input.workspaceId, input.exportId, now()),
    );
    if (!stillOurs) lost = true;
    beat();
    const key = exportObjectKey(input.workspaceId, input.exportId);
    const dek = await deps.db.withTenant(ctx, (tx) =>
      deps.envelope.currentKey(tx, ctx, EXPORT_OBJECT_PURPOSE),
    );
    async function* upload(): AsyncGenerator<Uint8Array> {
      for await (const chunk of createReadStream(tmp) as AsyncIterable<Uint8Array>) {
        beat();
        yield chunk;
      }
    }
    await deps.storage.put(key, encryptStream(dek.key, ReadableStream.from(upload())), {
      contentType: "application/octet-stream",
      contentLength: ciphertextLength(result.size),
      metadata: { "sh-format": "she1", "sh-content-type": "application/zip" },
    });
    stored = key;
    if (input.copyTo !== undefined) await copyFile(tmp, input.copyTo);
    const completedAt = now();
    const expiresAt = new Date(completedAt.getTime() + EXPORT_RETENTION_DAYS * 24 * 3600_000);
    const ready = await deps.db.withTenant(ctx, async (tx) => {
      const ok = await markReady(tx, {
        workspaceId: input.workspaceId,
        id: input.exportId,
        storageKey: key,
        encryption: { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef },
        sizeBytes: result.size,
        sha256: result.sha256,
        manifestSha256: result.manifestSha256,
        completedAt,
        expiresAt,
        warnings: result.warnings,
      });
      if (!ok) return undefined;
      await deps.audit.record(tx, ctx, {
        action: "workspace.export_completed",
        resourceKind: "workspace_export",
        resourceId: input.exportId,
        meta: {
          sizeBytes: result.size,
          sha256: result.sha256,
          manifestSha256: result.manifestSha256,
          keyId: result.manifest.signature.keyId,
          tables: result.manifest.tables.filter((t) => t.skipped === undefined).length,
          rows: result.manifest.tables.reduce((n, t) => n + t.rows, 0),
          blobs: result.manifest.blobs.count,
          auditRows: result.manifest.audit.rows,
          omittedSchemas: (result.manifest.omitted ?? []).map((o) => o.schema),
        },
      });
      return findExport(tx, input.workspaceId, input.exportId);
    });
    if (ready === undefined) throw new Error("the export was deleted while it was being written");
    return { status: "ready", row: ready };
  } catch (error) {
    if (stored !== undefined) await deps.storage.delete(stored).catch(() => undefined);
    const message = boundedError(error);
    deps.log?.("portability.export_failed", {
      level: "error",
      workspaceId: input.workspaceId,
      exportId: input.exportId,
      error: message,
    });
    await deps.db
      .withTenant(ctx, async (tx) => {
        if (await markFailed(tx, input.workspaceId, input.exportId, message, now())) {
          await deps.audit.record(tx, ctx, {
            action: "workspace.export_failed",
            resourceKind: "workspace_export",
            resourceId: input.exportId,
            outcome: "failure",
            meta: { code: error instanceof PortabilityError ? error.code : "error" },
          });
        }
      })
      .catch(() => undefined);
    return { status: "failed", error: message };
  } finally {
    lost = true; // no further beats
    await beating;
    await rm(tmp, { force: true });
  }
}

/** The hourly `portability.expire` body. */
export async function expireExports(
  deps: Pick<PortabilityServiceDeps, "db" | "storage" | "audit" | "now" | "log"> & {
    readonly dataDir?: string | undefined;
  },
): Promise<{ expired: number; failed: number; swept: number }> {
  const now = deps.now?.() ?? new Date();
  let expired = 0;
  let failed = 0;
  for (const workspaceId of await deps.db.withHost((tx) => listExportableWorkspaces(tx))) {
    const ctx = systemContext(workspaceId);
    await deps.db.withTenant(ctx, async (tx) => {
      // The workspace row before any export row (R3B): a purge holds it FOR UPDATE and then
      // deletes the export rows; one that won the race leaves nothing here to expire.
      if (!(await holdWorkspaceAgainstPurge(tx, workspaceId))) return;
      failed += await failStaleExports(deps, tx, ctx, now);
      for (const row of await dueForExpiry(tx, workspaceId, now)) {
        if (row.storageKey !== null) await deps.storage.delete(row.storageKey);
        await markExpired(tx, workspaceId, row.id);
        expired += 1;
      }
    });
  }
  // Temp files by wall-clock mtime (the file system's clock, not the injected one).
  const swept =
    deps.dataDir === undefined ? 0 : await sweepExportTempFiles(deps.dataDir).catch(() => 0);
  if (expired + failed + swept > 0) deps.log?.("portability.expired", { expired, failed, swept });
  return { expired, failed, swept };
}

export function createPortabilityJobs(deps: PortabilityServiceDeps): JobDefinition<JsonObject>[] {
  return [
    {
      name: EXPORT_JOB,
      // One export can take a while (a data room is gigabytes); a failure is recorded on the row
      // and the owner starts a new one, so pg-boss does not retry it.
      queue: { retryLimit: 0, expireInSeconds: 6 * 3600, deadLetter: false },
      handler: async (job) => {
        const exportId = job.data["exportId"];
        const workspaceId = job.data["workspaceId"];
        if (typeof exportId !== "string" || typeof workspaceId !== "string") return;
        await runExport(deps, { exportId, workspaceId });
      },
    },
    {
      name: EXPIRE_JOB,
      cron: "17 * * * *",
      handler: async () => {
        await expireExports(deps);
      },
    },
  ];
}

export class ExportStateError extends Error {
  override readonly name = "ExportStateError";
  constructor(
    readonly code: "not_found" | "export_not_ready" | "export_expired" | "export_running",
  ) {
    super(code);
  }
}

/**
 * Download: checks the state, stamps `downloaded_at` and records `workspace.export_downloaded` on
 * the caller's tx, and returns what the route needs to stream the object after the commit.
 */
export async function beginDownload(
  deps: { readonly audit: AuditRecorder; readonly envelope: PortabilityEngineDeps["envelope"] },
  tx: Tx,
  ctx: TenantContext,
  exportId: string,
  input: { readonly now: Date; readonly requestId?: string | null | undefined },
): Promise<{ row: ExportRow; key: string; dek: Uint8Array }> {
  const row = await findExport(tx, ctx.workspaceId, exportId);
  if (row === undefined) throw new ExportStateError("not_found");
  if (row.status === "expired") throw new ExportStateError("export_expired");
  if (row.status !== "ready" || row.storageKey === null)
    throw new ExportStateError("export_not_ready");
  if (row.expiresAt !== null && row.expiresAt <= input.now)
    throw new ExportStateError("export_expired");
  const she = parseShe(row.encryption);
  if (she === undefined) throw new ExportStateError("export_not_ready");
  const dek = await deps.envelope.keyById(tx, ctx, she.keyId);
  if (dek === undefined) throw new ExportStateError("export_expired");
  await markDownloaded(tx, ctx.workspaceId, exportId, input.now);
  await deps.audit.record(tx, ctx, {
    action: "workspace.export_downloaded",
    resourceKind: "workspace_export",
    resourceId: exportId,
    requestId: input.requestId ?? null,
    meta: { sha256: row.sha256, sizeBytes: row.sizeBytes },
  });
  return { row, key: row.storageKey, dek: dek.key };
}

/** The plaintext zip stream of a stored export. */
export async function openExportObject(
  storage: PortabilityEngineDeps["storage"],
  key: string,
  dek: Uint8Array,
): Promise<ReadableStream<Uint8Array> | undefined> {
  const read = await storage.get(key);
  if (read === undefined) return undefined;
  return decryptStream(dek, read.body);
}

/**
 * Deletes an export's row on the caller's tx; returns the object key to delete after. A queued
 * export is cancelled (its job finds no row and does nothing); a running one only when it is
 * stale (its worker died) — a live one answers `export_running`.
 */
export async function deleteExport(
  deps: { readonly audit: AuditRecorder },
  tx: Tx,
  ctx: TenantContext,
  exportId: string,
  requestId?: string | null,
  now: Date = new Date(),
): Promise<string | null> {
  const row = await findExport(tx, ctx.workspaceId, exportId, true);
  if (row === undefined) throw new ExportStateError("not_found");
  if (row.status === "running" && !isStaleExport(row, now))
    throw new ExportStateError("export_running");
  await deleteExportRow(tx, ctx.workspaceId, exportId);
  await deps.audit.record(tx, ctx, {
    action: "workspace.export_deleted",
    resourceKind: "workspace_export",
    resourceId: exportId,
    requestId: requestId ?? null,
    meta: { status: row.status, ...(row.status === "running" ? { stale: true } : {}) },
  });
  return row.storageKey;
}

/** Purge (workspace lifecycle): every export row of the workspace deleted, object keys returned. */
export async function purgeExports(tx: Tx, workspaceId: string): Promise<string[]> {
  return deleteAllExports(tx, workspaceId);
}

export { type ExportRow, findExport, listExports };
