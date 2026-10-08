import { createHash } from "node:crypto";
import type { KeyRing } from "@fundroom/config";
import {
  type AuditCheckpointRow,
  type Database,
  listLiveWorkspaceIds,
  PLATFORM_WORKSPACE_ID,
  systemContext,
} from "@fundroom/db";
import type { AuditAnchorPort } from "@fundroom/ports";
import { ANCHOR_MISSING_DAYS } from "./anchor.js";
import {
  ANCHOR_LATE_DAYS,
  type AnchorVerifier,
  checkpointAnchorState,
  checkpointLeafHash,
  checkReceipts,
  inclusionProblem,
  type ReceiptCheck,
} from "./anchor-proof.js";
import { factsOf, verifyCheckpointSignature } from "./checkpoint.js";
import {
  type AnchorBatchRow,
  findBatches,
  listMerkleAnchors,
  listReceiptsForBatches,
  type MerkleAnchorRow,
  type StoredReceipt,
} from "./repos/anchor-repo.js";
import {
  findChainHead,
  listCheckpoints,
  listEventsBySeq,
  verifyChainInDb,
} from "./repos/audit-repo.js";

/*
 * Full verification of a workspace (the `fundroom-audit verify` CLI, E2.7's admin button):
 *  1. walk the chain in the database (audit.verify_chain recomputes every hash);
 *  2. every checkpoint must point at a row that still has that hash;
 *  3. checkpoint signatures must verify under the key ring, when one is given;
 *  4. (E3.13) every anchored checkpoint: the leaf recomputed from the checkpoint row must sit on
 *     the stored inclusion path to its batch's root, and each receipt must verify offline with the
 *     matching driver (`anchor_path_invalid`, `anchor_receipt_failed`); with anchoring configured,
 *     a checkpoint older than ANCHOR_MISSING_DAYS without any receipt is `anchor_missing`.
 *     Only a TRUSTED time (RFC 3161 genTime against a pinned signer) counts as `verified`; a
 *     trusted time more than ANCHOR_LATE_DAYS after the checkpoint is `anchor_late` (a warning:
 *     it does not clear `ok`, because history anchored when anchoring was first enabled is late
 *     by construction — but it is listed, counted and shown); Rekor-only is `presenceOnly`.
 *     Receipts are checked after the transaction is released (CPU only, no network), with an
 *     in-process cache and an event-loop yield every few receipts.
 */
export interface AnchorSummary {
  /** Checkpoints with an anchor row. */
  readonly checked: number;
  /** Trusted, on-time anchor time. */
  readonly verified: number;
  /** Trusted time more than ANCHOR_LATE_DAYS after the checkpoint (`anchor_late`). */
  readonly late: number;
  /** Present in a transparency log, no trusted time (Rekor only). */
  readonly presenceOnly: number;
  readonly unverifiedOrigin: number;
  readonly failed: number;
  readonly missing: number;
}

export type AnchorProblemCode =
  | "anchor_path_invalid"
  | "anchor_receipt_failed"
  | "anchor_missing"
  | "anchor_late"
  | "anchor_inconsistent";

export interface AnchorProblem {
  readonly code: AnchorProblemCode;
  readonly checkpointId: string;
  readonly detail: string;
}

export interface WorkspaceVerification {
  readonly workspaceId: string;
  readonly ok: boolean;
  readonly headSeq: number;
  readonly checkedRows: number;
  readonly checkpoints: number;
  readonly problems: readonly string[];
  /** E3.13: always present; all zero when nothing was ever anchored. */
  readonly anchors: AnchorSummary;
  readonly anchorProblems: readonly AnchorProblem[];
}

export interface VerifyOptions {
  readonly db: Database;
  readonly keyRing?: KeyRing | undefined;
  readonly fromSeq?: number;
  /**
   * E3.13: the configured anchor drivers (their offline `verify` checks receipts). Empty or absent
   * = anchoring off: stored paths are still checked, receipts of unknown kinds count as unverified
   * origin, and nothing is ever `anchor_missing`.
   */
  readonly anchorDrivers?: readonly AuditAnchorPort[] | undefined;
  /**
   * Offline verifiers by kind, overriding the drivers' own `verify` (the server passes verifiers
   * that know every pinned cert / log key, including verification-only pins for drivers that are
   * off). Their presence does not make anchoring "configured" (no `anchor_missing`).
   */
  readonly anchorVerifiers?: Readonly<Record<string, AnchorVerifier>> | undefined;
  readonly now?: Date | undefined;
}

export async function verifyWorkspace(
  options: VerifyOptions,
  workspaceId: string,
): Promise<WorkspaceVerification> {
  const ctx = systemContext(workspaceId);
  const read = await options.db.withTenant(ctx, async (tx) => {
    const problems: string[] = [];
    const head = await findChainHead(tx, workspaceId);
    const headSeq = head ? Number(head.seq) : 0;
    const chain = await verifyChainInDb(tx, workspaceId, options.fromSeq ?? 1);
    let checkedRows = 0;
    if (chain) {
      problems.push(
        `chain: ${chain.problem} at seq ${chain.badSeq} (after ${chain.checked} good rows)`,
      );
      checkedRows = chain.checked;
    } else if (head) {
      checkedRows = headSeq - (options.fromSeq ?? 1) + 1;
    }
    if (head) {
      const [last] = await listEventsBySeq(tx, workspaceId, headSeq, headSeq);
      if (!last || Buffer.compare(Buffer.from(last.hash), Buffer.from(head.hash)) !== 0) {
        problems.push(`chain_head: hash for seq ${headSeq} does not match the stored row`);
      }
    }
    const checkpoints = await listCheckpoints(tx, workspaceId, 10_000);
    const rowTimes = new Map<string, Date>();
    for (const cp of checkpoints) {
      const seq = Number(cp.seq);
      const [row] = await listEventsBySeq(tx, workspaceId, seq, seq);
      if (!row) {
        problems.push(`checkpoint ${cp.id}: seq ${seq} no longer exists`);
      } else if (Buffer.compare(Buffer.from(row.hash), Buffer.from(cp.hash)) !== 0) {
        problems.push(`checkpoint ${cp.id}: hash at seq ${seq} differs from the checkpointed hash`);
      } else if (row.id !== cp.eventId) {
        // E3.13 FIX2 A12: the checkpoint's event id and head time are bound to the head row, so
        // lateness is measured from what the row says, not from the checkpoint's own claim.
        problems.push(`checkpoint ${cp.id}: event id differs from the row at seq ${seq}`);
      } else if (row.occurredAt.getTime() !== cp.headOccurredAt.getTime()) {
        problems.push(`checkpoint ${cp.id}: head time differs from the row at seq ${seq}`);
      } else {
        rowTimes.set(cp.id, row.occurredAt);
      }
      if (options.keyRing) {
        if (!cp.signature) {
          problems.push(`checkpoint ${cp.id}: unsigned`);
        } else if (
          !verifyCheckpointSignature(
            options.keyRing,
            factsOf(cp),
            cp.keyId,
            Buffer.from(cp.signature),
          )
        ) {
          problems.push(`checkpoint ${cp.id}: signature does not verify (key ${cp.keyId ?? "?"})`);
        }
      }
    }
    const anchors = await listMerkleAnchors(tx, workspaceId);
    const batches = await findBatches(
      tx,
      [...anchors.values()].map((a) => a.batchId),
    );
    const receipts = await listReceiptsForBatches(tx, [...batches.keys()]);
    return { problems, headSeq, checkedRows, checkpoints, rowTimes, anchors, batches, receipts };
  });
  const anchorResult = await checkAnchors(options, read);
  const problems = [
    ...read.problems,
    ...anchorResult.problems.map((p) => `${p.code}: checkpoint ${p.checkpointId}: ${p.detail}`),
  ];
  const fatal =
    read.problems.length + anchorResult.problems.filter((p) => p.code !== "anchor_late").length;
  return {
    workspaceId,
    ok: fatal === 0,
    headSeq: read.headSeq,
    checkedRows: read.checkedRows,
    checkpoints: read.checkpoints.length,
    problems,
    anchors: anchorResult.summary,
    anchorProblems: anchorResult.problems,
  };
}

/** Receipt checks are pure functions of (root, receipt, verifier): cache them per process. */
const receiptCache = new Map<string, ReceiptCheck>();
const RECEIPT_CACHE_MAX = 20_000;
const verifierIds = new WeakMap<AnchorVerifier, number>();
let nextVerifierId = 1;

function verifierId(v: AnchorVerifier | undefined): number {
  if (!v) return 0;
  let id = verifierIds.get(v);
  if (id === undefined) {
    id = nextVerifierId++;
    verifierIds.set(v, id);
  }
  return id;
}

/** Key = which verifier (its pins), receipt id, and a hash of exactly what was checked. */
function cacheKey(stored: StoredReceipt, root: Uint8Array, verifier: AnchorVerifier | undefined) {
  const h = createHash("sha256").update(root).update(JSON.stringify(stored.receipt)).digest("hex");
  return `${verifierId(verifier)}:${stored.id}:${h}`;
}

const YIELD_EVERY = 16;

/** One stable wrapper per driver object, so the cache key's verifier id survives across calls. */
const driverVerifiers = new WeakMap<AuditAnchorPort, AnchorVerifier>();
function driverVerifier(d: AuditAnchorPort): AnchorVerifier {
  let v = driverVerifiers.get(d);
  if (!v) {
    v = (digest, receipt, trusted) => d.verify(digest, receipt, trusted);
    driverVerifiers.set(d, v);
  }
  return v;
}

async function checkStoredReceipts(
  root: Uint8Array,
  stored: readonly StoredReceipt[],
  verifiers: Readonly<Record<string, AnchorVerifier>>,
  tick: () => Promise<void>,
): Promise<ReceiptCheck[]> {
  const out: ReceiptCheck[] = [];
  for (const r of stored) {
    const verifier = Object.hasOwn(verifiers, r.kind) ? verifiers[r.kind] : undefined;
    const key = cacheKey(r, root, verifier);
    let check = receiptCache.get(key);
    if (!check) {
      await tick();
      [check] = (await checkReceipts(root, [r.receipt], verifiers)) as [ReceiptCheck];
      if (receiptCache.size >= RECEIPT_CACHE_MAX) receiptCache.clear();
      receiptCache.set(key, check);
    }
    out.push(check);
  }
  return out;
}

async function checkAnchors(
  options: VerifyOptions,
  read: {
    readonly checkpoints: readonly AuditCheckpointRow[];
    readonly rowTimes: ReadonlyMap<string, Date>;
    readonly anchors: ReadonlyMap<string, MerkleAnchorRow>;
    readonly batches: ReadonlyMap<string, AnchorBatchRow>;
    readonly receipts: ReadonlyMap<string, StoredReceipt[]>;
  },
): Promise<{ summary: AnchorSummary; problems: AnchorProblem[] }> {
  const drivers = options.anchorDrivers ?? [];
  const verifiers: Record<string, AnchorVerifier> = {};
  for (const d of drivers) verifiers[d.kind] = driverVerifier(d);
  Object.assign(verifiers, options.anchorVerifiers ?? {});
  const configured = drivers.length > 0;
  const now = options.now ?? new Date();
  const missingBefore = now.getTime() - ANCHOR_MISSING_DAYS * 86_400_000;
  const problems: AnchorProblem[] = [];
  let checked = 0;
  let verified = 0;
  let late = 0;
  let presenceOnly = 0;
  let unverifiedOrigin = 0;
  let failed = 0;
  let missing = 0;
  let work = 0;
  // Yield to the event loop every few receipt checks: a long history must not stall requests.
  const tick = async () => {
    work += 1;
    if (work % YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
  };
  for (const cp of read.checkpoints) {
    const anchor = read.anchors.get(cp.id);
    const old = cp.createdAt.getTime() < missingBefore;
    if (!anchor) {
      if (configured && old) {
        missing += 1;
        problems.push({ code: "anchor_missing", checkpointId: cp.id, detail: "never anchored" });
      }
      continue;
    }
    checked += 1;
    const batch = read.batches.get(anchor.batchId);
    if (!batch) {
      failed += 1;
      problems.push({
        code: "anchor_path_invalid",
        checkpointId: cp.id,
        detail: `batch ${anchor.batchId} not found`,
      });
      continue;
    }
    const pathProblem =
      anchor.reference !== batch.id
        ? "the anchor row names another batch"
        : inclusionProblem(
            checkpointLeafHash(factsOf(cp)),
            anchor.proof,
            anchor.leafIndex,
            batch.merkleRoot,
            batch.leafCount,
          );
    if (pathProblem) {
      failed += 1;
      problems.push({ code: "anchor_path_invalid", checkpointId: cp.id, detail: pathProblem });
      continue;
    }
    const stored = read.receipts.get(batch.id) ?? [];
    if (stored.length === 0) {
      if (configured && old) {
        missing += 1;
        problems.push({ code: "anchor_missing", checkpointId: cp.id, detail: "no receipt" });
      }
      continue;
    }
    const checks = await checkStoredReceipts(batch.merkleRoot, stored, verifiers, tick);
    const headTime = read.rowTimes.get(cp.id) ?? cp.headOccurredAt;
    const { state, trustedTime } = checkpointAnchorState(checks, [headTime, cp.createdAt]);
    if (state === "failed") {
      failed += 1;
      for (const c of checks.filter((x) => x.status === "failed")) {
        problems.push({
          code: "anchor_receipt_failed",
          checkpointId: cp.id,
          detail: `${c.kind} (${c.reference}): ${c.detail ?? "failed"}`,
        });
      }
    } else if (state === "inconsistent") {
      failed += 1;
      problems.push({
        code: "anchor_inconsistent",
        checkpointId: cp.id,
        detail: `the head event (${headTime.toISOString()}) is later than the trusted anchor time ${trustedTime}`,
      });
    } else if (state === "time_verified") {
      verified += 1;
    } else if (state === "late") {
      late += 1;
      problems.push({
        code: "anchor_late",
        checkpointId: cp.id,
        detail: `earliest trusted anchor time ${trustedTime} is more than ${ANCHOR_LATE_DAYS} days after the checkpoint (head ${headTime.toISOString()}, written ${cp.createdAt.toISOString()})`,
      });
    } else if (state === "presence_only") {
      presenceOnly += 1;
    } else {
      unverifiedOrigin += 1;
    }
  }
  return {
    summary: { checked, verified, late, presenceOnly, unverifiedOrigin, failed, missing },
    problems,
  };
}
export async function verifyAllWorkspaces(
  options: VerifyOptions,
): Promise<WorkspaceVerification[]> {
  const ids = [PLATFORM_WORKSPACE_ID, ...(await listLiveWorkspaceIds(options.db))];
  const out: WorkspaceVerification[] = [];
  for (const id of ids) out.push(await verifyWorkspace(options, id));
  return out;
}

export function formatVerification(results: readonly WorkspaceVerification[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const label = r.workspaceId === PLATFORM_WORKSPACE_ID ? "platform" : r.workspaceId;
    lines.push(
      `${r.ok ? "OK  " : "FAIL"} ${label}: head seq ${r.headSeq}, ${r.checkedRows} rows checked, ${r.checkpoints} checkpoint(s)`,
    );
    const a = r.anchors;
    if (a.checked > 0 || a.missing > 0) {
      lines.push(
        `      anchors: ${a.checked} anchored, ${a.verified} verified (trusted time), ${a.late} late, ${a.presenceOnly} present in log without trusted time, ${a.unverifiedOrigin} unverified origin, ${a.failed} failed, ${a.missing} missing`,
      );
    }
    for (const p of r.problems) lines.push(`      - ${p}`);
  }
  const bad = results.filter((r) => !r.ok).length;
  lines.push(
    bad === 0 ? "audit: all chains verified" : `audit: ${bad} workspace(s) FAILED verification`,
  );
  return lines.join("\n");
}
