import {
  type AuditAnchorRow,
  type AuditCheckpointRow,
  core,
  PLATFORM_WORKSPACE_ID,
  type Tx,
} from "@fundroom/db";
import type { AnchorReceipt } from "@fundroom/ports";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

/** `{ leafHash, path: [hex…], treeSize }` as stored in `audit.anchor.proof`. */
export type AuditAnchorProof = NonNullable<AuditAnchorRow["proof"]>;

/*
 * External anchoring (E3.13, ADR-0061): the only file that touches audit.anchor_batch,
 * audit.anchor_receipt and the merkle rows of audit.anchor.
 *
 * `audit.checkpoint` and `audit.anchor` are tenant-fenced; the batch and receipt tables are global
 * (system/host insert, staff/system/host read). One anchoring transaction therefore reads and
 * writes several workspaces' rows by switching the transaction-local `app.workspace_id` between
 * them in the `system` actor (`enterSystemContext`), the pattern the sanctions/billing repos use —
 * never a second pool connection under the held transaction.
 */

/** Transaction-scoped: serialises anchoring runs so no checkpoint is batched twice. */
export async function lockAnchorRun(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('audit.anchor_batch', 0))`);
}

/** Switches the transaction to `workspaceId`'s `system` actor (transaction-local settings). */
export async function enterSystemContext(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`
    SELECT set_config('app.workspace_id', ${workspaceId}, true),
           set_config('app.actor_kind', 'system', true),
           set_config('app.membership_id', '', true),
           set_config('app.user_id', '', true)`);
}

export async function enterPlatformSystemContext(tx: Tx): Promise<void> {
  await enterSystemContext(tx, PLATFORM_WORKSPACE_ID);
}

/** Checkpoints of one workspace with no merkle anchor yet, oldest first (`created_at, id`). */
export async function listUnanchoredCheckpoints(
  tx: Tx,
  workspaceId: string,
  limit: number,
): Promise<AuditCheckpointRow[]> {
  const cp = core.auditCheckpoint;
  return tx
    .select()
    .from(cp)
    .where(
      and(
        eq(cp.workspaceId, workspaceId),
        sql`NOT EXISTS (SELECT 1 FROM audit.anchor a
                         WHERE a.checkpoint_id = ${cp.id} AND a.kind = 'merkle')`,
      ),
    )
    .orderBy(cp.createdAt, cp.id)
    .limit(limit);
}

export async function insertAnchorBatch(
  tx: Tx,
  merkleRoot: Uint8Array,
  leafCount: number,
): Promise<{ id: string; createdAt: Date }> {
  const rows = await tx
    .insert(core.auditAnchorBatch)
    .values({ merkleRoot: Buffer.from(merkleRoot), leafCount })
    .returning({ id: core.auditAnchorBatch.id, createdAt: core.auditAnchorBatch.createdAt });
  const row = rows[0];
  if (!row) throw new Error("anchor batch insert returned no row");
  return row;
}

/**
 * `false` when the checkpoint already has a merkle anchor (a row this transaction could not see
 * when it selected the checkpoint): `ON CONFLICT … DO NOTHING` on `anchor_merkle_checkpoint_idx`.
 */
export async function insertMerkleAnchor(
  tx: Tx,
  values: {
    readonly workspaceId: string;
    readonly checkpointId: string;
    readonly batchId: string;
    readonly leafIndex: number;
    readonly proof: AuditAnchorProof;
  },
): Promise<boolean> {
  const r = await tx.execute(sql`
    INSERT INTO audit.anchor (workspace_id, checkpoint_id, kind, reference, batch_id, leaf_index, proof)
    VALUES (${values.workspaceId}::uuid, ${values.checkpointId}::uuid, 'merkle', ${values.batchId},
            ${values.batchId}::uuid, ${values.leafIndex}::int, ${JSON.stringify(values.proof)}::jsonb)
    ON CONFLICT (checkpoint_id) WHERE kind = 'merkle' DO NOTHING
    RETURNING id`);
  return r.rows.length > 0;
}

export interface AnchorBatchRow {
  readonly id: string;
  readonly merkleRoot: Uint8Array;
  readonly leafCount: number;
  readonly createdAt: Date;
}

export interface StoredReceipt {
  readonly id: string;
  readonly batchId: string;
  readonly kind: string;
  readonly reference: string;
  readonly anchoredAt: Date;
  readonly receipt: AnchorReceipt;
}

/**
 * Batches created within the last `days` days BY THE DATABASE CLOCK (`created_at` is its now())
 * that lack a receipt for at least one of `kinds`.
 */
export async function listBatchesMissingReceipts(
  tx: Tx,
  days: number,
  kinds: readonly string[],
): Promise<(AnchorBatchRow & { readonly haveKinds: readonly string[] })[]> {
  if (kinds.length === 0) return [];
  const b = core.auditAnchorBatch;
  const batches = await tx
    .select()
    .from(b)
    .where(gte(b.createdAt, sql`now() - make_interval(days => ${days}::int)`))
    .orderBy(b.createdAt, b.id)
    .limit(1_000);
  if (batches.length === 0) return [];
  const receipts = await tx
    .select({ batchId: core.auditAnchorReceipt.batchId, kind: core.auditAnchorReceipt.kind })
    .from(core.auditAnchorReceipt)
    .where(
      inArray(
        core.auditAnchorReceipt.batchId,
        batches.map((x) => x.id),
      ),
    );
  const have = new Map<string, string[]>();
  for (const r of receipts) have.set(r.batchId, [...(have.get(r.batchId) ?? []), r.kind]);
  return batches
    .map((x) => ({
      id: x.id,
      merkleRoot: new Uint8Array(x.merkleRoot),
      leafCount: x.leafCount,
      createdAt: x.createdAt,
      haveKinds: have.get(x.id) ?? [],
    }))
    .filter((x) => kinds.some((k) => !x.haveKinds.includes(k)));
}

/** `false` when the batch already has a receipt of this kind (a concurrent run won). */
export async function insertAnchorReceipt(
  tx: Tx,
  batchId: string,
  receipt: AnchorReceipt,
): Promise<boolean> {
  const rows = await tx
    .insert(core.auditAnchorReceipt)
    .values({
      batchId,
      kind: receipt.kind,
      reference: receipt.reference.slice(0, 2000),
      anchoredAt: new Date(receipt.anchoredAt),
      receipt: {
        kind: receipt.kind,
        reference: receipt.reference,
        anchoredAt: receipt.anchoredAt,
        proof: receipt.proof,
      },
    })
    .onConflictDoNothing({
      target: [core.auditAnchorReceipt.batchId, core.auditAnchorReceipt.kind],
    })
    .returning({ id: core.auditAnchorReceipt.id });
  return rows.length > 0;
}

export async function findBatches(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, AnchorBatchRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(core.auditAnchorBatch)
    .where(inArray(core.auditAnchorBatch.id, [...new Set(ids)]));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        merkleRoot: new Uint8Array(r.merkleRoot),
        leafCount: r.leafCount,
        createdAt: r.createdAt,
      },
    ]),
  );
}

export async function listReceiptsForBatches(
  tx: Tx,
  batchIds: readonly string[],
): Promise<Map<string, StoredReceipt[]>> {
  const out = new Map<string, StoredReceipt[]>();
  if (batchIds.length === 0) return out;
  const r = core.auditAnchorReceipt;
  const rows = await tx
    .select()
    .from(r)
    .where(inArray(r.batchId, [...new Set(batchIds)]))
    .orderBy(r.kind);
  for (const row of rows) {
    const stored = row.receipt as Record<string, unknown>;
    const receipt: AnchorReceipt = {
      kind: row.kind,
      reference: typeof stored["reference"] === "string" ? stored["reference"] : row.reference,
      anchoredAt:
        typeof stored["anchoredAt"] === "string"
          ? stored["anchoredAt"]
          : row.anchoredAt.toISOString(),
      proof:
        typeof stored["proof"] === "object" && stored["proof"] !== null
          ? (stored["proof"] as Record<string, unknown>)
          : {},
    };
    const list = out.get(row.batchId) ?? [];
    list.push({
      id: row.id,
      batchId: row.batchId,
      kind: row.kind,
      reference: row.reference,
      anchoredAt: row.anchoredAt,
      receipt,
    });
    out.set(row.batchId, list);
  }
  return out;
}

export interface MerkleAnchorRow {
  readonly checkpointId: string;
  readonly batchId: string;
  readonly leafIndex: number;
  readonly proof: AuditAnchorProof;
  readonly reference: string;
}

/** The merkle anchor rows of a workspace's checkpoints (all of them when `checkpointIds` is omitted). */
export async function listMerkleAnchors(
  tx: Tx,
  workspaceId: string,
  checkpointIds?: readonly string[],
): Promise<Map<string, MerkleAnchorRow>> {
  const a = core.auditAnchor;
  if (checkpointIds !== undefined && checkpointIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(a)
    .where(
      and(
        eq(a.workspaceId, workspaceId),
        eq(a.kind, "merkle"),
        checkpointIds === undefined ? undefined : inArray(a.checkpointId, [...checkpointIds]),
      ),
    );
  const out = new Map<string, MerkleAnchorRow>();
  for (const r of rows) {
    if (r.batchId === null || r.leafIndex === null || r.proof === null) continue;
    out.set(r.checkpointId, {
      checkpointId: r.checkpointId,
      batchId: r.batchId,
      leafIndex: r.leafIndex,
      proof: r.proof,
      reference: r.reference,
    });
  }
  return out;
}

export async function findCheckpointById(
  tx: Tx,
  workspaceId: string,
  checkpointId: string,
): Promise<AuditCheckpointRow | undefined> {
  const cp = core.auditCheckpoint;
  const rows = await tx
    .select()
    .from(cp)
    .where(and(eq(cp.workspaceId, workspaceId), eq(cp.id, checkpointId)))
    .limit(1);
  return rows[0];
}

/** One page of a workspace's checkpoints, newest first; keyset `(seq, id)` descending. */
export async function listCheckpointsPage(
  tx: Tx,
  workspaceId: string,
  page: { readonly before?: { seq: number; id: string } | undefined; readonly limit: number },
): Promise<AuditCheckpointRow[]> {
  const cp = core.auditCheckpoint;
  const before = page.before;
  return tx
    .select()
    .from(cp)
    .where(
      and(
        eq(cp.workspaceId, workspaceId),
        before === undefined
          ? undefined
          : or(lt(cp.seq, before.seq), and(eq(cp.seq, before.seq), lt(cp.id, before.id))),
      ),
    )
    .orderBy(desc(cp.seq), desc(cp.id))
    .limit(page.limit);
}
