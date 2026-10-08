import { isApiError } from "@fundroom/contracts";
import { VERIFY_DEADLINE_MS } from "@fundroom/custom-domains";
import type { Database } from "@fundroom/db";
import type { DirectoryPort } from "@fundroom/ports";
import { listLocalCells } from "./repos/local-cells-repo.js";
import {
  type LocalWorkspaceFact,
  listLocalPendingHostnames,
  listLocalVerifiedHostnames,
  listLocalWorkspaceFacts,
  readLocalWorkspaceFact,
} from "./repos/local-facts-repo.js";
import { isSharedDirectory } from "./shared.js";

/** `core.cell.region` before a region is declared (0024; `PLACEHOLDER_REGION` in the db schema). */
const PLACEHOLDER_REGION = "default";

/*
 * The reconcile sweep (E3.11 §8, job `directory.reconcile`): B's placement hooks write the
 * directory best-effort after their local commit; this is the repair path. It only ever works
 * from evidence in THIS cell's database:
 *
 *  1. publish every cell this database serves (region facts, status, heartbeat, export key);
 *  2. every local workspace that is not purged gets an entry with its slug on its cell — `active`
 *     when live, `dormant` when soft-deleted (holds the slug, never routed) — except workspaces
 *     under a `relocation` hold (a move in either direction owns them). Live workspaces first; a
 *     live workspace takes a slug over from a LOCAL soft-deleted one, never from anyone else
 *     (logged as a conflict). The local row is re-read inside the directory write, and a released
 *     entry is never revived;
 *  3. a purged local workspace's entry is released (a missed purge hook);
 *  4. `reserved` entries of this database's cells older than an hour with no local workspace
 *     are released (a provisioning that died between claim and insert);
 *  5. every verified local hostname is (re-)claimed (one another entry holds is logged, not
 *     taken), and directory hostnames of local workspaces that are no longer verified here are
 *     released.
 */

export type ReconcileLog = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface PublishCellsInput {
  readonly db: Database;
  readonly directory: DirectoryPort;
  /** The export signing key's public half (`exportPublicKeys(keyRing)[0].publicKey`). */
  readonly exportPublicKey: string | null;
  /** Every key of the ring with its id (R1-6: a target matches the bundle's signer key id). */
  readonly exportPublicKeys?: readonly { readonly keyId: string; readonly publicKey: string }[];
  readonly log?: ReconcileLog | undefined;
}

/** Publishes every `core.cell` row of this database. Returns the published cell ids. */
export async function publishLocalCells(input: PublishCellsInput): Promise<string[]> {
  if (input.directory.mode !== "shared") return [];
  const log = input.log ?? (() => {});
  const published: string[] = [];
  for (const cell of await listLocalCells(input.db)) {
    if (cell.region === PLACEHOLDER_REGION) {
      // No region declared yet: a directory row saying "default" would be a false fact.
      log("directory.publish_skipped", { level: "warn", cellId: cell.id, reason: "no_region" });
      continue;
    }
    try {
      await input.directory.publishCell({
        id: cell.id,
        region: cell.region,
        regionLabel: cell.regionLabel,
        jurisdiction: cell.jurisdiction,
        publicOrigin: cell.publicOrigin,
        status: cell.status,
        exportPublicKey: input.exportPublicKey,
        exportPublicKeys: input.exportPublicKeys ?? [],
      });
    } catch (error) {
      // Another cell database published this id first (e.g. both seeded `default`): never
      // overwrite it, never place entries on it; the operator must rename one side.
      if (
        isApiError(error, "directory_unavailable") &&
        error.details["reason"] === "cell_conflict"
      ) {
        log("directory.cell_conflict", { level: "error", cellId: cell.id });
        continue;
      }
      throw error;
    }
    published.push(cell.id);
  }
  return published;
}

export interface ReconcileInput extends PublishCellsInput {
  readonly now?: (() => Date) | undefined;
  /** Reserved entries older than this are stale. Default 1 h. */
  readonly reservationTtlMs?: number | undefined;
}

export interface ReconcileReport {
  readonly cells: string[];
  readonly created: number;
  readonly repaired: number;
  readonly conflicts: number;
  readonly skippedRelocating: number;
  readonly released: number;
  readonly staleReservations: number;
  readonly hostnamesClaimed: number;
  readonly hostnameConflicts: number;
  readonly hostnamesReleased: number;
}

export const RESERVATION_TTL_MS = 60 * 60 * 1000;

/** How long after a switch the target may re-add a carried domain (its lift runs on a poll). */
export const CARRIED_READD_GRACE_MS = 60 * 60 * 1000;

export async function reconcileDirectory(input: ReconcileInput): Promise<ReconcileReport | null> {
  const { directory } = input;
  if (!isSharedDirectory(directory)) return null;
  const log = input.log ?? (() => {});
  const now = input.now ?? (() => new Date());

  const cells = await publishLocalCells(input);
  const localCellIds = (await listLocalCells(input.db)).map((c) => c.id);
  const published = new Set(cells);
  const workspaces = await listLocalWorkspaceFacts(input.db);

  // One read of every entry bound to our cells: the sweep writes only where something differs.
  const entries = new Map(
    (await directory.entriesOfCells(localCellIds)).map((e) => [e.workspaceId, e] as const),
  );

  let created = 0;
  let repaired = 0;
  let conflicts = 0;
  let skippedRelocating = 0;
  let released = 0;
  const relocating = new Set<string>();
  // R2-5: live workspaces first, so a live one wins a slug a soft-deleted one also carries.
  const ordered = [...workspaces].sort((a, b) => Number(a.deleted) - Number(b.deleted));
  const softDeletedBySlug = new Map<string, string[]>();
  for (const w of workspaces) {
    if (w.deleted && !w.purged) {
      softDeletedBySlug.set(w.slug, [...(softDeletedBySlug.get(w.slug) ?? []), w.id]);
    }
  }
  for (const ws of ordered) {
    if (ws.holds.includes("relocation")) {
      relocating.add(ws.id);
      skippedRelocating += 1;
      continue;
    }
    const entry = entries.get(ws.id);
    if (ws.purged) {
      // Only an entry still bound to this very id on one of our cells: a move rebinds the entry
      // to the target's id, so a purged move source matches nothing here.
      if (entry !== undefined && entry.state !== "deleted") {
        await directory.release(ws.id);
        released += 1;
      }
      continue;
    }
    // A cell whose region is not declared was not published; its entries cannot exist yet.
    if (!published.has(ws.cellId)) continue;
    const target = ws.deleted ? "dormant" : "active";
    if (
      entry !== undefined &&
      entry.state === target &&
      entry.slug === ws.slug &&
      entry.cellId === ws.cellId
    ) {
      continue;
    }
    const result = await directory.ensureEntry({
      workspaceId: ws.id,
      slug: ws.slug,
      cellId: ws.cellId,
      localCellIds,
      state: target,
      displace: ws.deleted ? [] : (softDeletedBySlug.get(ws.slug) ?? []),
      // R2-10: nothing is written when the row changed since it was read (purged, renamed,
      // deleted or restored, put under a relocation hold).
      confirm: async () => sameFacts(ws, await readLocalWorkspaceFact(input.db, ws.id)),
    });
    if (result === "created") created += 1;
    else if (result === "repaired") repaired += 1;
    else if (result === "slug_taken" || result === "elsewhere" || result === "released") {
      conflicts += 1;
      // Never names the holder: the directory is shared, the log is this cell's.
      log("directory.reconcile_conflict", {
        level: "warn",
        workspaceId: ws.id,
        reason: result,
      });
    }
  }

  const stale = await directory.releaseStaleReservations({
    cellIds: localCellIds,
    olderThan: new Date(now().getTime() - (input.reservationTtlMs ?? RESERVATION_TTL_MS)),
    keep: workspaces.map((w) => w.id),
  });

  let hostnamesClaimed = 0;
  let hostnameConflicts = 0;
  let hostnamesReleased = 0;
  const known = new Map(workspaces.map((w) => [w.id, w] as const));
  const verified = await listLocalVerifiedHostnames(input.db);
  const verifiedKeys = new Set(verified.map((h) => `${h.workspaceId} ${h.hostname}`));
  for (const h of verified) {
    const ws = known.get(h.workspaceId);
    if (ws === undefined || ws.purged || ws.deleted || relocating.has(h.workspaceId)) continue;
    try {
      const result = await directory.claimHost({
        hostname: h.hostname,
        workspaceId: h.workspaceId,
      });
      if (result === "claimed") hostnamesClaimed += 1;
      else {
        hostnameConflicts += 1;
        log("directory.reconcile_hostname_conflict", {
          level: "warn",
          workspaceId: h.workspaceId,
          hostname: h.hostname,
        });
      }
    } catch (error) {
      // No entry (its slug is held elsewhere) or not a storable hostname: skip, keep sweeping.
      log("directory.reconcile_hostname_skipped", {
        level: "warn",
        workspaceId: h.workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // R2-4: a directory hostname of a local workspace that is no longer verified here (demoted,
  // removed, and the best-effort release hook missed it) would park the name and misroute it.
  //
  // RR1-4: except a hostname a move carried. The copy re-verifies its domains (`pending`) and the
  // claim that followed the entry at the switchover is kept while that local row is pending —
  // until it verifies (then it is claimed as usual) or fails / is removed (then it is pruned). The
  // marker is the directory's own move row: this workspace is the TARGET of a switched move.
  //
  // RR3-4: and only for the row the move re-added (created and first attempted within
  // CARRIED_READD_GRACE_MS of the switch — a tenant reopening a failed row or removing and
  // re-adding it gets a later timestamp) and never past the switch + VERIFY_DEADLINE_MS.
  let pending: Map<string, { readonly createdAt: Date; readonly firstAttemptAt: Date }> | undefined;
  const switchedAtOf = new Map<string, Date | null>();
  const nowMs = now().getTime();
  for (const h of await directory.hostnamesOfCells(localCellIds)) {
    const ws = known.get(h.workspaceId);
    if (ws === undefined || relocating.has(h.workspaceId)) continue;
    const key = `${h.workspaceId} ${h.hostname}`;
    if (verifiedKeys.has(key)) continue;
    pending ??= new Map(
      (await listLocalPendingHostnames(input.db)).map((p) => [`${p.workspaceId} ${p.hostname}`, p]),
    );
    const row = pending.get(key);
    if (row !== undefined) {
      let switchedAt = switchedAtOf.get(h.workspaceId);
      if (switchedAt === undefined) {
        const moves = await directory.moves.list({
          workspaceId: h.workspaceId,
          states: ["switched", "retired"],
          limit: 10,
        });
        const times = moves
          .filter((m) => m.targetWorkspaceId === h.workspaceId && m.switchedAt instanceof Date)
          .map((m) => (m.switchedAt as Date).getTime());
        switchedAt = times.length === 0 ? null : new Date(Math.max(...times));
        switchedAtOf.set(h.workspaceId, switchedAt);
      }
      if (switchedAt !== null) {
        const sw = switchedAt.getTime();
        const carried =
          row.createdAt.getTime() <= sw + CARRIED_READD_GRACE_MS &&
          row.firstAttemptAt.getTime() <= sw + CARRIED_READD_GRACE_MS &&
          nowMs < sw + VERIFY_DEADLINE_MS;
        if (carried) continue;
      }
    }
    await directory.releaseHost({ hostname: h.hostname, workspaceId: h.workspaceId });
    hostnamesReleased += 1;
  }

  const report: ReconcileReport = {
    cells,
    created,
    repaired,
    conflicts,
    skippedRelocating,
    released,
    staleReservations: stale.length,
    hostnamesClaimed,
    hostnameConflicts,
    hostnamesReleased,
  };
  log("directory.reconciled", { ...report });
  return report;
}

function sameFacts(read: LocalWorkspaceFact, now: LocalWorkspaceFact | undefined): boolean {
  return (
    now !== undefined &&
    !now.purged &&
    now.deleted === read.deleted &&
    now.slug === read.slug &&
    now.cellId === read.cellId &&
    !now.holds.includes("relocation")
  );
}
