import type { KeyRing } from "@fundroom/config";
import {
  type AuditCheckpointRow,
  type Database,
  listLiveWorkspaceIds,
  PLATFORM_WORKSPACE_ID,
  platformContext,
  type Tx,
} from "@fundroom/db";
import { AnchorError, type AuditAnchorPort, type JobDefinition } from "@fundroom/ports";
import { type AnchorProofDocument, checkpointLeafHash } from "./anchor-proof.js";
import { checkpointCanonical, factsOf, verifyCheckpointSignature } from "./checkpoint.js";
import { buildMerkleTree, toHex } from "./merkle.js";
import {
  enterPlatformSystemContext,
  enterSystemContext,
  findBatches,
  findCheckpointById,
  insertAnchorBatch,
  insertAnchorReceipt,
  insertMerkleAnchor,
  listBatchesMissingReceipts,
  listCheckpointsPage,
  listMerkleAnchors,
  listReceiptsForBatches,
  listUnanchoredCheckpoints,
  lockAnchorRun,
} from "./repos/anchor-repo.js";
import { type AuditRecorder, createAuditService } from "./service.js";

/*
 * External anchoring of audit checkpoints (E3.13, ADR-0061; contract §2).
 *
 * One run (`anchorPending`, the daily `audit.anchor` job at 02:40 UTC — 30 min after
 * `audit.checkpoint` — and `fundroom audit anchor`):
 *
 *  1. BATCH. In one transaction, under a run-wide advisory lock, collect every checkpoint of every
 *     live workspace and the platform chain that has no merkle anchor yet (oldest first:
 *     `created_at, id`), build an RFC 6962 tree over `leaf = SHA-256(0x00 || canonical checkpoint)`
 *     and write the `audit.anchor_batch` row plus one `audit.anchor` row (kind `merkle`) per
 *     checkpoint holding its inclusion path. The lock makes concurrent runs queue: the second one
 *     re-reads after the first committed and finds nothing (or only newer checkpoints) to batch;
 *     the partial unique index `anchor_merkle_checkpoint_idx` is the backstop. No network here.
 *  2. RECEIPTS. Outside any transaction, every configured driver anchors the 32-byte root of each
 *     batch from the last `ANCHOR_RETRY_DAYS` that still lacks that driver's receipt (so a failed
 *     driver is retried by the next runs for a week); each receipt is checked with the driver's own
 *     offline `verify` before it is stored, in its own short transaction. Two overlapping runs may
 *     both call a driver for the same batch; `UNIQUE (batch_id, kind)` keeps the first receipt.
 *  3. AUDIT. One `audit.anchored` event per batch attempted, on the PLATFORM chain only (a tenant
 *     learns nothing about other tenants or the batch from its own log).
 *
 * Tenants learn nothing about each other from a proof: a leaf is a hash of a canonical checkpoint
 * (itself hashes and ids of that workspace), and a workspace's proof carries only sibling hashes.
 */

export const ANCHOR_JOB_NAME = "audit.anchor";
export const ANCHOR_JOB_CRON = "40 2 * * *";
/** Drivers that failed are retried on later runs for this long after the batch was built. */
export const ANCHOR_RETRY_DAYS = 7;
/** A checkpoint older than this with no receipt is `anchor_missing` while anchoring is on. */
export const ANCHOR_MISSING_DAYS = 8;
/** Leaves per batch (oldest checkpoints first); a run builds further batches for the rest. */
export const MAX_BATCH_LEAVES = 10_000;
/** Batches one run may build; anything left waits for the next run. */
export const MAX_BATCHES_PER_RUN = 20;

export interface AnchorOptions {
  readonly db: Database;
  readonly drivers: readonly AuditAnchorPort[];
  /** When given, checkpoints whose HMAC does not verify are not anchored (logged, left pending). */
  readonly keyRing?: KeyRing | undefined;
  /** Records `audit.anchored` on the platform chain; default a recorder over `db`. */
  readonly audit?: AuditRecorder | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  readonly now?: (() => Date) | undefined;
  /** Leaves per batch (default MAX_BATCH_LEAVES; tests lower it). */
  readonly maxBatchLeaves?: number | undefined;
}

export interface AnchorAttempt {
  readonly batchId: string;
  readonly kind: string;
  readonly ok: boolean;
  /** `AnchorError` code (or `error` for anything else) when `ok` is false. */
  readonly code?: string;
}

export interface AnchorRunResult {
  /** The first batch this run built, or null when there was nothing new to anchor. */
  readonly batchId: string | null;
  /** Every batch this run built (≤ MAX_BATCH_LEAVES leaves each). */
  readonly batchIds: readonly string[];
  /** Leaves over all batches built. */
  readonly leaves: number;
  /**
   * Checkpoints whose anchor row could not be written (conflict or error): left out of every
   * tree this run (never anchored without a row) and reported; they stay pending.
   */
  readonly skipped: number;
  readonly skippedCheckpointIds: readonly string[];
  /** Every driver call this run made (the new batches and retries of older ones). */
  readonly receipts: readonly AnchorAttempt[];
}

interface BuiltBatch {
  readonly id: string;
  readonly leafCount: number;
}

interface BatchAttempt {
  readonly batch: BuiltBatch | null;
  /** Candidates selected before any exclusion (a full selection means more may be waiting). */
  readonly selected: number;
  /** Checkpoints whose anchor row could not be written; excluded from the batch's tree. */
  readonly skippedIds: readonly string[];
}

const byAge = (a: AuditCheckpointRow, b: AuditCheckpointRow) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Thrown inside the batch savepoint to roll back a tree that contains unwritable leaves. */
class LeavesSkipped extends Error {
  constructor(readonly ids: readonly string[]) {
    super("anchor leaves skipped");
  }
}

const MAX_BATCH_ATTEMPTS = 3;

/**
 * One batch: the oldest ≤ maxBatchLeaves pending checkpoints over all workspaces, minus those
 * already `excluded` in this run. Memory stays bounded (≤ 2 × max rows): the candidate set is cut
 * after each workspace. The batch row and its anchor rows are written in a savepoint; when any
 * anchor row cannot be written (a conflicting row, or an error — per workspace savepoint), the
 * whole batch is rolled back and the tree is REBUILT without those leaves (E3.13 FIX2 A13), so a
 * root is never anchored for checkpoints that were not recorded in it. Skipped ids are added to
 * `excluded` so the rest of the run does not pick them again.
 */
async function buildBatch(
  options: AnchorOptions,
  workspaceIds: readonly string[],
  excluded: Set<string>,
): Promise<BatchAttempt> {
  const log = options.log;
  const max = options.maxBatchLeaves ?? MAX_BATCH_LEAVES;
  return options.db.withTenant(platformContext(), async (tx) => {
    await lockAnchorRun(tx);
    let chosen: AuditCheckpointRow[] = [];
    for (const ws of workspaceIds) {
      await enterSystemContext(tx, ws);
      const rows = await listUnanchoredCheckpoints(tx, ws, max + excluded.size);
      for (const cp of rows) {
        if (excluded.has(cp.id)) continue;
        if (options.keyRing) {
          const ok =
            cp.signature !== null &&
            verifyCheckpointSignature(
              options.keyRing,
              factsOf(cp),
              cp.keyId,
              Buffer.from(cp.signature),
            );
          if (!ok) {
            excluded.add(cp.id);
            log?.("audit.anchor_checkpoint_skipped", {
              workspaceId: cp.workspaceId,
              checkpointId: cp.id,
              reason: "signature",
            });
            continue;
          }
        }
        chosen.push(cp);
      }
      if (chosen.length > max) {
        chosen.sort(byAge);
        chosen = chosen.slice(0, max);
      }
    }
    await enterPlatformSystemContext(tx);
    chosen.sort(byAge);
    const selected = chosen.length;
    const skippedIds: string[] = [];
    for (let attempt = 0; attempt < MAX_BATCH_ATTEMPTS && chosen.length > 0; attempt++) {
      const leaves = chosen.map((cp) => checkpointLeafHash(factsOf(cp)));
      const tree = buildMerkleTree(leaves);
      const current = chosen;
      try {
        const batch = await tx.transaction(async (sp) => {
          const row = await insertAnchorBatch(sp, tree.root, leaves.length);
          // Grouped by workspace so the context switches once per workspace, not once per leaf.
          const byWorkspace = new Map<string, number[]>();
          for (const [i, cp] of current.entries()) {
            byWorkspace.set(cp.workspaceId, [...(byWorkspace.get(cp.workspaceId) ?? []), i]);
          }
          const failed: string[] = [];
          for (const [ws, indexes] of byWorkspace) {
            await enterSystemContext(sp, ws);
            try {
              const conflicts = await sp.transaction(async (inner) => {
                const lost: string[] = [];
                for (const i of indexes) {
                  const cp = current[i] as AuditCheckpointRow;
                  const inserted = await insertMerkleAnchor(inner, {
                    workspaceId: ws,
                    checkpointId: cp.id,
                    batchId: row.id,
                    leafIndex: i,
                    proof: {
                      leafHash: toHex(leaves[i] as Uint8Array),
                      path: (tree.paths[i] ?? []).map(toHex),
                      treeSize: leaves.length,
                    },
                  });
                  if (!inserted) lost.push(cp.id);
                }
                return lost;
              });
              for (const id of conflicts) {
                failed.push(id);
                log?.("audit.anchor_leaf_skipped", {
                  workspaceId: ws,
                  checkpointId: id,
                  reason: "already_anchored",
                });
              }
            } catch (error) {
              for (const i of indexes) failed.push((current[i] as AuditCheckpointRow).id);
              log?.("audit.anchor_leaf_skipped", {
                workspaceId: ws,
                leaves: indexes.length,
                reason: "error",
                error: error instanceof Error ? error.message.slice(0, 200) : "error",
              });
            }
          }
          await enterPlatformSystemContext(sp);
          if (failed.length > 0) throw new LeavesSkipped(failed);
          return { id: row.id, leafCount: leaves.length };
        });
        await enterPlatformSystemContext(tx);
        return { batch, selected, skippedIds };
      } catch (error) {
        if (!(error instanceof LeavesSkipped)) throw error;
        await enterPlatformSystemContext(tx);
        const lost = new Set(error.ids);
        for (const id of lost) {
          excluded.add(id);
          skippedIds.push(id);
        }
        chosen = chosen.filter((cp) => !lost.has(cp.id));
      }
    }
    return { batch: null, selected, skippedIds };
  });
}

function errorCode(error: unknown): string {
  return error instanceof AnchorError ? error.code : "error";
}

/** Runs one anchoring pass (see the file comment). Never throws for a driver failure. */
export async function anchorPending(options: AnchorOptions): Promise<AnchorRunResult> {
  const log = options.log;
  // Listed before the batch transaction opens: `listLiveWorkspaceIds` takes its own connection.
  const workspaceIds = [PLATFORM_WORKSPACE_ID, ...(await listLiveWorkspaceIds(options.db))];
  const built: BuiltBatch[] = [];
  const skippedIds: string[] = [];
  const excluded = new Set<string>();
  const max = options.maxBatchLeaves ?? MAX_BATCH_LEAVES;
  for (let n = 0; n < MAX_BATCHES_PER_RUN; n++) {
    const b = await buildBatch(options, workspaceIds, excluded);
    skippedIds.push(...b.skippedIds);
    if (b.batch) {
      built.push(b.batch);
      log?.("audit.anchor_batch_built", {
        batchId: b.batch.id,
        leaves: b.batch.leafCount,
        skipped: b.skippedIds.length,
      });
    }
    if (b.selected < max) break;
  }

  const kinds = options.drivers.map((d) => d.kind);
  // The retry window is measured on the database clock (`created_at` is the database's now()).
  const due = await options.db.withTenant(platformContext(), (tx) =>
    listBatchesMissingReceipts(tx, ANCHOR_RETRY_DAYS, kinds),
  );

  const attempts: AnchorAttempt[] = [];
  const audit = options.audit ?? createAuditService({ db: options.db });
  for (const batch of due) {
    const tried: AnchorAttempt[] = [];
    for (const driver of options.drivers) {
      if (batch.haveKinds.includes(driver.kind)) continue;
      try {
        const receipt = await driver.anchor(batch.merkleRoot);
        if (receipt.kind !== driver.kind) {
          throw new AnchorError(
            "invalid_response",
            `driver ${driver.kind} returned a ${receipt.kind} receipt`,
          );
        }
        // Only a receipt that verifies against the driver's pins is evidence worth keeping; an
        // unpinned one would sit there forever and never be retried.
        const check = await driver.verify(batch.merkleRoot, receipt);
        if (check.status !== "verified") {
          throw new AnchorError(
            "verification_failed",
            `receipt is ${check.status}: ${"detail" in check ? check.detail : ""}`,
          );
        }
        await options.db.withTenant(platformContext(), (tx) =>
          insertAnchorReceipt(tx, batch.id, receipt),
        );
        tried.push({ batchId: batch.id, kind: driver.kind, ok: true });
      } catch (error) {
        const code = errorCode(error);
        // `errorCode`, not `code`: the server logger redacts fields named `code`.
        log?.("audit.anchor_driver_failed", {
          batchId: batch.id,
          kind: driver.kind,
          errorCode: code,
        });
        tried.push({ batchId: batch.id, kind: driver.kind, ok: false, code });
      }
    }
    if (tried.length === 0) continue;
    attempts.push(...tried);
    await audit.recordDetached(platformContext(), {
      action: "audit.anchored",
      resourceKind: "audit_anchor_batch",
      resourceId: batch.id,
      actorKind: "system",
      meta: {
        batchId: batch.id,
        leafCount: batch.leafCount,
        kinds: tried.filter((t) => t.ok).map((t) => t.kind),
        failures: tried
          .filter((t) => !t.ok)
          .map((t) => ({ kind: t.kind, code: t.code ?? "error" })),
      },
    });
  }
  return {
    batchId: built[0]?.id ?? null,
    batchIds: built.map((b) => b.id),
    leaves: built.reduce((n, b) => n + b.leafCount, 0),
    skipped: skippedIds.length,
    skippedCheckpointIds: skippedIds,
    receipts: attempts,
  };
}

/** The daily job; register it only when at least one driver is configured. */
export function createAnchorJob(options: AnchorOptions): JobDefinition {
  return {
    name: ANCHOR_JOB_NAME,
    cron: ANCHOR_JOB_CRON,
    queue: { retryLimit: 2, retryDelaySeconds: 300 },
    handler: async () => {
      const r = await anchorPending(options);
      options.log?.("audit.anchor_run", {
        batchIds: r.batchIds,
        leaves: r.leaves,
        skipped: r.skipped,
        ok: r.receipts.filter((x) => x.ok).length,
        failed: r.receipts.filter((x) => !x.ok).length,
      });
    },
  };
}

/** The proof for one checkpoint of `workspaceId`, read in the caller's transaction; null if not anchored. */
export async function readAnchorProof(
  tx: Tx,
  workspaceId: string,
  checkpointId: string,
): Promise<AnchorProofDocument | null | undefined> {
  const cp = await findCheckpointById(tx, workspaceId, checkpointId);
  if (!cp) return undefined;
  const anchor = (await listMerkleAnchors(tx, workspaceId, [cp.id])).get(cp.id);
  if (!anchor) return null;
  const batch = (await findBatches(tx, [anchor.batchId])).get(anchor.batchId);
  if (!batch) return null;
  const receipts = (await listReceiptsForBatches(tx, [batch.id])).get(batch.id) ?? [];
  const f = factsOf(cp);
  return {
    checkpoint: JSON.parse(checkpointCanonical(f)) as AnchorProofDocument["checkpoint"],
    leafHash: anchor.proof.leafHash,
    leafIndex: anchor.leafIndex,
    path: [...anchor.proof.path],
    treeSize: anchor.proof.treeSize,
    root: toHex(batch.merkleRoot),
    receipts: receipts.map((r) => r.receipt),
  };
}

export interface AnchorListItem {
  readonly checkpointId: string;
  readonly seq: number;
  readonly createdAt: Date;
  /** At least one receipt exists for the checkpoint's batch. */
  readonly anchored: boolean;
  /**
   * `anchored`: ≥ 1 receipt. `pending`: not batched yet, or batched and still inside the retry
   * window. `failed`: batched, but every driver failed for ANCHOR_RETRY_DAYS (no more retries),
   * or the checkpoint's signature does not verify (the job never anchors it).
   */
  readonly state: "anchored" | "pending" | "failed";
  readonly batchId: string | null;
  readonly receipts: readonly { kind: string; reference: string; anchoredAt: Date }[];
}

/**
 * One page of a workspace's checkpoints with their anchor state, newest first (keyset
 * `(seq, id)`), read in the caller's transaction (`GET /audit/anchors`). Returns `limit + 1` rows
 * at most so the caller can tell whether there is a next page.
 */
export async function listAnchorPage(
  tx: Tx,
  workspaceId: string,
  page: { readonly before?: { seq: number; id: string } | undefined; readonly limit: number },
  now: Date = new Date(),
  /** When given, an unanchored checkpoint whose HMAC fails is `failed` (it will never be anchored). */
  keyRing?: KeyRing,
): Promise<AnchorListItem[]> {
  const cps = await listCheckpointsPage(tx, workspaceId, page);
  const anchors = await listMerkleAnchors(
    tx,
    workspaceId,
    cps.map((c) => c.id),
  );
  const batchIds = [...new Set([...anchors.values()].map((a) => a.batchId))];
  const batches = await findBatches(tx, batchIds);
  const receipts = await listReceiptsForBatches(tx, batchIds);
  const giveUpBefore = now.getTime() - ANCHOR_RETRY_DAYS * 86_400_000;
  return cps.map((cp) => {
    const a = anchors.get(cp.id);
    const rs = a ? (receipts.get(a.batchId) ?? []) : [];
    const batch = a ? batches.get(a.batchId) : undefined;
    const badSignature =
      rs.length === 0 &&
      keyRing !== undefined &&
      (cp.signature === null ||
        !verifyCheckpointSignature(keyRing, factsOf(cp), cp.keyId, Buffer.from(cp.signature)));
    const state: AnchorListItem["state"] =
      rs.length > 0
        ? "anchored"
        : badSignature || (batch && batch.createdAt.getTime() < giveUpBefore)
          ? "failed"
          : "pending";
    return {
      checkpointId: cp.id,
      seq: Number(cp.seq),
      createdAt: cp.createdAt,
      anchored: rs.length > 0,
      state,
      batchId: a?.batchId ?? null,
      receipts: rs.map((r) => ({
        kind: r.kind,
        reference: r.reference,
        anchoredAt: r.anchoredAt,
      })),
    };
  });
}
