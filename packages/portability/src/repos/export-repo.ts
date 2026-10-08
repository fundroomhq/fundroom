import type { Tx } from "@fundroom/db";
import type { JsonObject } from "@fundroom/ports";
import { sql } from "drizzle-orm";

/*
 * `core.workspace_export` (staff/system RLS, tenant-fenced): the export requests and their files.
 *
 * `started_at` is the job's HEARTBEAT, not only its start: `markRunning` sets it and the running
 * job moves it forward (`touchRunning`) at least once a minute while it makes progress, so
 * "running with `started_at` older than the stale window" means the worker died or wedged
 * (fix C: no new column, the existing one carries the meaning).
 */

export type ExportStatus = "queued" | "running" | "ready" | "failed" | "expired";

export interface ExportRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestedBy: string | null;
  readonly status: ExportStatus;
  readonly options: { readonly includeRawAnalytics: boolean };
  /** Data the finished export could not include (e.g. a module schema not loaded here). */
  readonly warnings: readonly string[];
  readonly storageKey: string | null;
  readonly encryption: JsonObject | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly manifestSha256: string | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly downloadedAt: Date | null;
}

const COLUMNS = sql.raw(`id, workspace_id AS "workspaceId", requested_by AS "requestedBy", status,
  options, storage_key AS "storageKey", encryption, size_bytes AS "sizeBytes",
  encode(sha256, 'hex') AS sha256, encode(manifest_sha256, 'hex') AS "manifestSha256", error,
  created_at AS "createdAt", started_at AS "startedAt", completed_at AS "completedAt",
  expires_at AS "expiresAt", downloaded_at AS "downloadedAt"`);

const date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(v as string);

function toRow(r: Record<string, unknown>): ExportRow {
  const options = (r["options"] ?? {}) as Record<string, unknown>;
  return {
    id: String(r["id"]),
    workspaceId: String(r["workspaceId"]),
    requestedBy: (r["requestedBy"] as string | null) ?? null,
    status: r["status"] as ExportStatus,
    options: { includeRawAnalytics: options["includeRawAnalytics"] === true },
    warnings: Array.isArray(options["warnings"])
      ? (options["warnings"] as unknown[]).filter((w): w is string => typeof w === "string")
      : [],
    storageKey: (r["storageKey"] as string | null) ?? null,
    encryption: (r["encryption"] as JsonObject | null) ?? null,
    sizeBytes:
      r["sizeBytes"] === null || r["sizeBytes"] === undefined ? null : Number(r["sizeBytes"]),
    sha256: (r["sha256"] as string | null) ?? null,
    manifestSha256: (r["manifestSha256"] as string | null) ?? null,
    error: (r["error"] as string | null) ?? null,
    createdAt: new Date(r["createdAt"] as string),
    startedAt: date(r["startedAt"]),
    completedAt: date(r["completedAt"]),
    expiresAt: date(r["expiresAt"]),
    downloadedAt: date(r["downloadedAt"]),
  };
}

const rowsOf = (r: unknown): Record<string, unknown>[] =>
  (r as { rows: Record<string, unknown>[] }).rows;

/** Throws 23505 (`workspace_export_active_idx`) when one is already queued or running. */
export async function insertExport(
  tx: Tx,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly requestedBy: string | null;
    readonly includeRawAnalytics: boolean;
  },
): Promise<ExportRow> {
  const r = await tx.execute(sql`
    INSERT INTO core.workspace_export (id, workspace_id, requested_by, status, options)
    VALUES (${input.id}::uuid, ${input.workspaceId}::uuid, ${input.requestedBy}::uuid, 'queued',
            ${JSON.stringify({ includeRawAnalytics: input.includeRawAnalytics })}::jsonb)
    RETURNING ${COLUMNS}`);
  return toRow(rowsOf(r)[0] as Record<string, unknown>);
}

export async function listExports(tx: Tx, workspaceId: string, limit = 50): Promise<ExportRow[]> {
  const r = await tx.execute(sql`
    SELECT ${COLUMNS} FROM core.workspace_export WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY created_at DESC, id DESC LIMIT ${limit}`);
  return rowsOf(r).map(toRow);
}

export async function findExport(
  tx: Tx,
  workspaceId: string,
  id: string,
  lock = false,
): Promise<ExportRow | undefined> {
  const r = await tx.execute(sql`
    SELECT ${COLUMNS} FROM core.workspace_export
    WHERE workspace_id = ${workspaceId}::uuid AND id = ${id}::uuid ${sql.raw(lock ? "FOR UPDATE" : "")}`);
  const row = rowsOf(r)[0];
  return row ? toRow(row) : undefined;
}

/** queued|running → running (a retried job restarts a stale `running`). */
export async function markRunning(
  tx: Tx,
  workspaceId: string,
  id: string,
  now: Date,
): Promise<boolean> {
  const r = await tx.execute(sql`
    UPDATE core.workspace_export SET status = 'running', started_at = ${now.toISOString()}::timestamptz,
      error = NULL
    WHERE workspace_id = ${workspaceId}::uuid AND id = ${id}::uuid AND status IN ('queued', 'running')
    RETURNING id`);
  return rowsOf(r).length > 0;
}

export async function markReady(
  tx: Tx,
  input: {
    readonly workspaceId: string;
    readonly id: string;
    readonly storageKey: string;
    readonly encryption: JsonObject;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly manifestSha256: string;
    readonly completedAt: Date;
    readonly expiresAt: Date;
    readonly warnings?: readonly string[] | undefined;
  },
): Promise<boolean> {
  const warnings = JSON.stringify({ warnings: input.warnings ?? [] });
  const r = await tx.execute(sql`
    UPDATE core.workspace_export SET status = 'ready', storage_key = ${input.storageKey},
      options = options || ${warnings}::jsonb,
      encryption = ${JSON.stringify(input.encryption)}::jsonb, size_bytes = ${input.sizeBytes},
      sha256 = decode(${input.sha256}, 'hex'), manifest_sha256 = decode(${input.manifestSha256}, 'hex'),
      completed_at = ${input.completedAt.toISOString()}::timestamptz,
      expires_at = ${input.expiresAt.toISOString()}::timestamptz, error = NULL
    WHERE workspace_id = ${input.workspaceId}::uuid AND id = ${input.id}::uuid AND status = 'running'
    RETURNING id`);
  return rowsOf(r).length > 0;
}

export async function markFailed(
  tx: Tx,
  workspaceId: string,
  id: string,
  error: string,
  now: Date,
): Promise<boolean> {
  const r = await tx.execute(sql`
    UPDATE core.workspace_export SET status = 'failed', error = ${error.slice(0, 1000)},
      completed_at = ${now.toISOString()}::timestamptz
    WHERE workspace_id = ${workspaceId}::uuid AND id = ${id}::uuid AND status IN ('queued', 'running')
    RETURNING id`);
  return rowsOf(r).length > 0;
}

export async function markDownloaded(
  tx: Tx,
  workspaceId: string,
  id: string,
  now: Date,
): Promise<void> {
  await tx.execute(sql`
    UPDATE core.workspace_export SET downloaded_at = ${now.toISOString()}::timestamptz
    WHERE workspace_id = ${workspaceId}::uuid AND id = ${id}::uuid`);
}

export async function deleteExportRow(tx: Tx, workspaceId: string, id: string): Promise<void> {
  await tx.execute(
    sql`DELETE FROM core.workspace_export WHERE workspace_id = ${workspaceId}::uuid AND id = ${id}::uuid`,
  );
}

/** Ready exports past their expiry, locked; the caller deletes the object and marks them expired. */
export async function dueForExpiry(tx: Tx, workspaceId: string, now: Date): Promise<ExportRow[]> {
  const r = await tx.execute(sql`
    SELECT ${COLUMNS} FROM core.workspace_export
    WHERE workspace_id = ${workspaceId}::uuid AND status = 'ready'
      AND expires_at <= ${now.toISOString()}::timestamptz
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED`);
  return rowsOf(r).map(toRow);
}

export async function markExpired(tx: Tx, workspaceId: string, id: string): Promise<void> {
  await tx.execute(sql`
    UPDATE core.workspace_export SET status = 'expired', storage_key = NULL
    WHERE workspace_id = ${workspaceId}::uuid AND id = ${id}::uuid`);
}

/** The running job's heartbeat. False when the row is no longer `running` (failed as stale, deleted). */
export async function touchRunning(
  tx: Tx,
  workspaceId: string,
  id: string,
  now: Date,
): Promise<boolean> {
  const r = await tx.execute(sql`
    UPDATE core.workspace_export SET started_at = ${now.toISOString()}::timestamptz
    WHERE workspace_id = ${workspaceId}::uuid AND id = ${id}::uuid AND status = 'running'
    RETURNING id`);
  return rowsOf(r).length > 0;
}

/**
 * Exports a dead worker left behind → `failed`: running ones whose heartbeat stopped before
 * `runningBefore`, queued ones nobody picked up since `queuedBefore`.
 */
export async function failStale(
  tx: Tx,
  workspaceId: string,
  cutoffs: { readonly runningBefore: Date; readonly queuedBefore: Date },
  now: Date,
): Promise<string[]> {
  const r = await tx.execute(sql`
    UPDATE core.workspace_export SET status = 'failed', completed_at = ${now.toISOString()}::timestamptz,
      error = 'the export stopped making progress (worker stopped or wedged); start a new one'
    WHERE workspace_id = ${workspaceId}::uuid
      AND ((status = 'running'
            AND coalesce(started_at, created_at) < ${cutoffs.runningBefore.toISOString()}::timestamptz)
        OR (status = 'queued' AND created_at < ${cutoffs.queuedBefore.toISOString()}::timestamptz))
    RETURNING id`);
  return rowsOf(r).map((x) => String(x["id"]));
}

/**
 * Holds the workspace row against a purge for the rest of the transaction (`FOR KEY SHARE`) and
 * says whether the workspace is still there (not purged). The purge takes the row `FOR UPDATE`
 * and then deletes the export rows (`deleteAllExports`), while the expiry sweep writes export
 * rows and then audits (which takes the row `FOR NO KEY UPDATE`): without this the two closed a
 * cycle (E3.5 R3B). `KEY SHARE` conflicts only with the purge's `FOR UPDATE` — not with an audit's
 * `NO KEY UPDATE` or another sweep — and upgrading it to the audit's mode later in the same
 * transaction does not queue behind a waiting purge, so it adds no cycle of its own.
 */
export async function holdWorkspaceAgainstPurge(tx: Tx, workspaceId: string): Promise<boolean> {
  const r = await tx.execute(sql`
    SELECT purged_at IS NULL AS live FROM core.workspace WHERE id = ${workspaceId}::uuid
    FOR KEY SHARE`);
  return rowsOf(r)[0]?.["live"] === true;
}

/** Every export object of a workspace (purge) — rows deleted, keys returned. */
export async function deleteAllExports(tx: Tx, workspaceId: string): Promise<string[]> {
  const r = await tx.execute(sql`
    DELETE FROM core.workspace_export WHERE workspace_id = ${workspaceId}::uuid
    RETURNING storage_key AS "storageKey"`);
  return rowsOf(r)
    .map((x) => x["storageKey"])
    .filter((k): k is string => typeof k === "string");
}

/** Workspaces whose exports may still hold objects (live or inside their restore window). */
export async function listExportableWorkspaces(tx: Tx): Promise<string[]> {
  const r = await tx.execute(
    sql`SELECT id FROM core.workspace WHERE purged_at IS NULL ORDER BY id`,
  );
  return rowsOf(r).map((x) => String(x["id"]));
}
