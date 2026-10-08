import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { KeyRing, KeyRingEntry } from "@fundroom/config";
import {
  type AuditCheckpointRow,
  type Database,
  listLiveWorkspaceIds,
  PLATFORM_WORKSPACE_ID,
  systemContext,
} from "@fundroom/db";
import type { JobDefinition } from "@fundroom/ports";
import { findChainHead, findLatestCheckpoint, insertCheckpoint } from "./repos/audit-repo.js";

/*
 * Checkpoints (ADR-0017): a daily snapshot of each workspace's chain head, signed with
 * HMAC-SHA256 under a key derived from the config key ring. The key lives in the
 * environment, not the database, so a database superuser who rewrites rows and re-chains
 * them cannot forge the signature over the old head. External anchors (audit.anchor)
 * extend this to "not even the operator" in Phase 2.
 */
export const CHECKPOINT_KEY_PURPOSE = "seed-host/audit/checkpoint-hmac/v1";

export function checkpointKey(entry: KeyRingEntry): Uint8Array {
  return new Uint8Array(
    hkdfSync("sha256", entry.key, new Uint8Array(0), CHECKPOINT_KEY_PURPOSE, 32),
  );
}

export interface CheckpointFacts {
  readonly workspaceId: string;
  readonly seq: number;
  /** Hex. */
  readonly hash: string;
  readonly eventId: string;
  readonly headOccurredAt: Date;
  readonly previousCheckpointId: string | null;
}

/** Fixed field order, no whitespace: what gets signed. */
export function checkpointCanonical(f: CheckpointFacts): string {
  return JSON.stringify({
    workspace_id: f.workspaceId,
    seq: f.seq,
    hash: f.hash.toLowerCase(),
    event_id: f.eventId,
    head_occurred_at: f.headOccurredAt.toISOString(),
    previous_checkpoint_id: f.previousCheckpointId,
  });
}

export function signCheckpoint(
  ring: KeyRing,
  f: CheckpointFacts,
): { keyId: string; signature: Buffer } {
  const mac = createHmac("sha256", checkpointKey(ring.current))
    .update(checkpointCanonical(f), "utf8")
    .digest();
  return { keyId: ring.current.id, signature: mac };
}

/** Verifies with the named key when the ring still has it, else with every entry. */
export function verifyCheckpointSignature(
  ring: KeyRing,
  f: CheckpointFacts,
  keyId: string | null,
  signature: Uint8Array,
): boolean {
  const text = checkpointCanonical(f);
  const candidates = keyId ? ring.entries.filter((e) => e.id === keyId) : [];
  const entries = candidates.length > 0 ? candidates : ring.entries;
  let ok = false;
  for (const entry of entries) {
    const mac = createHmac("sha256", checkpointKey(entry)).update(text, "utf8").digest();
    if (mac.length === signature.length && timingSafeEqual(mac, signature)) ok = true;
  }
  return ok;
}

export function factsOf(row: AuditCheckpointRow): CheckpointFacts {
  return {
    workspaceId: row.workspaceId,
    seq: Number(row.seq),
    hash: Buffer.from(row.hash).toString("hex"),
    eventId: row.eventId,
    headOccurredAt: row.headOccurredAt,
    previousCheckpointId: row.previousCheckpointId,
  };
}

export interface CheckpointOptions {
  readonly db: Database;
  readonly keyRing: KeyRing;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export interface CheckpointResult {
  readonly workspaceId: string;
  /** `written`: head advanced since the last checkpoint. `unchanged`: nothing new. `empty`: no events yet. */
  readonly status: "written" | "unchanged" | "empty";
  readonly seq: number;
}

/** Writes a checkpoint for one workspace if its head moved. Runs in that workspace's system context. */
export async function writeCheckpoint(
  options: CheckpointOptions,
  workspaceId: string,
): Promise<CheckpointResult> {
  const ctx = systemContext(workspaceId);
  return options.db.withTenant(ctx, async (tx) => {
    const head = await findChainHead(tx, workspaceId);
    if (!head) return { workspaceId, status: "empty", seq: 0 };
    const last = await findLatestCheckpoint(tx, workspaceId);
    if (last && Number(last.seq) === Number(head.seq)) {
      return { workspaceId, status: "unchanged", seq: Number(head.seq) };
    }
    const facts: CheckpointFacts = {
      workspaceId,
      seq: Number(head.seq),
      hash: Buffer.from(head.hash).toString("hex"),
      eventId: head.eventId,
      headOccurredAt: head.occurredAt,
      previousCheckpointId: last?.id ?? null,
    };
    const { keyId, signature } = signCheckpoint(options.keyRing, facts);
    await insertCheckpoint(tx, {
      workspaceId,
      seq: facts.seq,
      hash: Buffer.from(head.hash),
      eventId: facts.eventId,
      headOccurredAt: facts.headOccurredAt,
      previousCheckpointId: facts.previousCheckpointId,
      keyId,
      signature,
    });
    return { workspaceId, status: "written", seq: facts.seq };
  });
}

/** Every live workspace plus the platform pseudo-workspace. */
export async function writeAllCheckpoints(options: CheckpointOptions): Promise<CheckpointResult[]> {
  const ids = [PLATFORM_WORKSPACE_ID, ...(await listLiveWorkspaceIds(options.db))];
  const results: CheckpointResult[] = [];
  for (const id of ids) {
    const r = await writeCheckpoint(options, id);
    results.push(r);
    if (r.status === "written")
      options.log?.("audit.checkpoint_written", { workspaceId: id, seq: r.seq });
  }
  return results;
}

/** Daily at 02:10 UTC (design/06 §5 "a daily job writes the chain head"). */
export function createCheckpointJob(options: CheckpointOptions): JobDefinition {
  return {
    name: "audit.checkpoint",
    cron: "10 2 * * *",
    queue: { retryLimit: 3, retryDelaySeconds: 60 },
    handler: async () => {
      await writeAllCheckpoints(options);
    },
  };
}
