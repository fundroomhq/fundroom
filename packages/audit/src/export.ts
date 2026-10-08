import type { KeyRing } from "@fundroom/config";
import type { Tx } from "@fundroom/db";
import {
  buildExportBundle,
  type ExportAnchor,
  type ExportBundle,
  type ExportBundleInput,
  type ExportCheckpoint,
  exportSigningKey,
} from "./bundle.js";
import { toHex } from "./merkle.js";
import { findBatches, listMerkleAnchors, listReceiptsForBatches } from "./repos/anchor-repo.js";
import {
  exportRows,
  listCheckpointsInRange,
  listEventsBySeq,
  seqRangeForTime,
} from "./repos/audit-repo.js";

/*
 * Reads what a signed export needs out of one workspace's chain (`readWorkspaceExport`, inside
 * the caller's tenant transaction — no second connection) and builds the bundle (`bundle.ts`).
 * The route reads in one transaction, builds the zip after releasing it (the deflate runs on a
 * worker thread) and records `audit.exported` in a second, sequential transaction: the range
 * was fixed at read time, so the export row is never inside the export it describes.
 */

/**
 * Largest range one export may carry. The bundle is built in memory: measured at 50,000 rows
 * (`buildExportBundleAsync`), ~0.9 s wall, ~0.4 s of it on the event loop (the JSONL/CSV text;
 * the deflate runs on a worker) and ~170 MB peak transient RSS; at the former 200,000 cap, built
 * synchronously, it was ~5.2 s blocking the event loop and ~600 MB. Larger histories export as
 * several date ranges.
 */
export const MAX_EXPORT_ROWS = 50_000;

export class ExportRangeTooLargeError extends Error {
  constructor(readonly rows: number) {
    super(
      `the range holds ${rows} events; one export carries at most ${MAX_EXPORT_ROWS} — narrow the date range (export it in several parts)`,
    );
    this.name = "ExportRangeTooLargeError";
  }
}

export interface WorkspaceExportInput {
  readonly workspace: { readonly id: string; readonly slug: string; readonly name: string };
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly generatedBy: { readonly membershipId: string | null };
  readonly keyRing: KeyRing;
  readonly now?: Date | undefined;
}

/** Everything the bundle needs, read in the caller's transaction; throws `ExportRangeTooLargeError`. */
export async function readWorkspaceExport(
  tx: Tx,
  input: WorkspaceExportInput,
): Promise<ExportBundleInput> {
  const wsId = input.workspace.id;
  const range = await seqRangeForTime(tx, wsId, input.from, input.to);
  if (range && range.toSeq - range.fromSeq + 1 > MAX_EXPORT_ROWS) {
    throw new ExportRangeTooLargeError(range.toSeq - range.fromSeq + 1);
  }
  const rows = range ? await exportRows(tx, wsId, range.fromSeq, range.toSeq) : [];
  let prevHash: string | null = null;
  const first = rows[0];
  if (first && first.seq > 1) {
    // The stored hash of the row before; if retention dropped it, the first row's own
    // embedded prev_hash (the same value while the chain is intact).
    const [before] = await listEventsBySeq(tx, wsId, first.seq - 1, first.seq - 1);
    prevHash = before
      ? Buffer.from(before.hash).toString("hex")
      : ((JSON.parse(first.canonical) as { prev_hash?: string | null }).prev_hash ?? null);
  }
  const checkpoints: ExportCheckpoint[] = range
    ? (await listCheckpointsInRange(tx, wsId, range.fromSeq, range.toSeq)).map((cp) => ({
        id: cp.id,
        seq: Number(cp.seq),
        hash: Buffer.from(cp.hash).toString("hex"),
        eventId: cp.eventId,
        headOccurredAt: cp.headOccurredAt.toISOString(),
        previousCheckpointId: cp.previousCheckpointId,
        keyId: cp.keyId,
        signature: cp.signature ? Buffer.from(cp.signature).toString("base64") : null,
      }))
    : [];
  // E3.13 (bundle v2): the external anchors of the exported checkpoints, from the same snapshot.
  const merkle = await listMerkleAnchors(
    tx,
    wsId,
    checkpoints.map((c) => c.id),
  );
  const batches = await findBatches(
    tx,
    [...merkle.values()].map((a) => a.batchId),
  );
  const receipts = await listReceiptsForBatches(tx, [...batches.keys()]);
  const anchors: ExportAnchor[] = [];
  for (const cp of checkpoints) {
    const a = merkle.get(cp.id);
    const batch = a ? batches.get(a.batchId) : undefined;
    if (!a || !batch) continue;
    anchors.push({
      checkpointId: cp.id,
      leafIndex: a.leafIndex,
      path: [...a.proof.path],
      treeSize: a.proof.treeSize,
      root: toHex(batch.merkleRoot),
      receipts: (receipts.get(batch.id) ?? []).map((r) => r.receipt),
    });
  }
  return {
    workspace: input.workspace,
    generatedAt: input.now ?? new Date(),
    generatedBy: input.generatedBy,
    range: { from: input.from ?? null, to: input.to ?? null },
    rows,
    prevHash,
    checkpoints,
    anchors,
    signingKey: exportSigningKey(input.keyRing.current),
  };
}

/** Read and build in one go (the zip is built while `tx` is still held — tests and scripts). */
export async function buildWorkspaceExport(
  tx: Tx,
  input: WorkspaceExportInput,
): Promise<ExportBundle> {
  return buildExportBundle(await readWorkspaceExport(tx, input));
}
