import { randomBytes } from "node:crypto";
import type { Database } from "@fundroom/db";
import type { DirectoryPort } from "@fundroom/ports";
import { listCellRows } from "../cells/repos/cell-repo.js";
import { readEntryFacts } from "./repos/provisioning-repo.js";

/*
 * Placement hooks (E3.11, ADR-0059; owner: agent B): every place a workspace's slug is born asks
 * the cell directory first.
 *
 *   1. the workspace id is generated HERE, before anything is written (the directory entry and
 *      the local row carry the same id);
 *   2. `claimSlug` runs BEFORE the cell transaction opens — the directory is another database,
 *      and a cell transaction held open while waiting on it would pin a pool connection (and the
 *      workspace-row locks the provisioning path takes) for a network round trip. `taken` is the
 *      same answer the local unique index gives (`slug_taken`), never naming the holder;
 *   3. the caller's work runs (its own transaction, committed when it returns);
 *   4. `activate` after the commit, best effort: a failure is logged and the directory's
 *      reconcile sweep (agent A) turns the reserved entry active on its next pass;
 *   5. on ANY failure of step 3, `release` (best effort too — the sweep frees reserved entries of
 *      this cell that have no local workspace after an hour).
 *
 * In `local` mode (no DIRECTORY_DATABASE_URL) every call is a no-op answering success, so the
 * local unique index stays the only judge, exactly as before E3.11.
 */

/** The part of the directory the placement hooks use. */
export type PlacementDirectory = Pick<
  DirectoryPort,
  "mode" | "claimSlug" | "activate" | "release" | "lookupSlug"
>;

export type PlacementLog = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export class PlacementError extends Error {
  override readonly name = "PlacementError";
  constructor(
    /** `slug_taken`: another cell's workspace holds it; `directory_unavailable`: no answer. */
    readonly reason: "slug_taken" | "directory_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export function isPlacementError(error: unknown): error is PlacementError {
  return error instanceof PlacementError;
}

/**
 * A new workspace id: a UUIDv7 (48-bit millisecond timestamp, version 7, RFC 9562 variant, 74
 * random bits) — the same shape `core.uuidv7()` gives the column default, so ids stay
 * time-ordered whichever side generated them.
 */
export function newWorkspaceId(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** How a slug is stored (`core.workspace.slug` is citext; the directory compares lower case). */
export function normalizeWorkspaceSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export interface SlugClaimInput {
  readonly slug: string;
  /** The cell the new workspace is placed on (a cell of this database). */
  readonly cellId: string;
  /** Use this id instead of generating one (tests). */
  readonly workspaceId?: string | undefined;
  readonly log?: PlacementLog | undefined;
}

/**
 * Claims `slug` for a new workspace in the directory, runs `create(workspaceId)` (which must
 * insert the local row with exactly that id and COMMIT before it returns), then activates the
 * entry. Any failure of `create` releases the claim and rethrows. Without a directory (unit
 * tests, callers that predate E3.11) it just runs `create` with a fresh id.
 *
 * Throws `PlacementError('slug_taken')` when another cell's workspace holds the slug and
 * `PlacementError('directory_unavailable')` when the directory cannot be asked — nothing is
 * created in either case.
 */
export async function withSlugClaim<T>(
  directory: PlacementDirectory | undefined,
  input: SlugClaimInput,
  create: (workspaceId: string) => Promise<T>,
): Promise<T> {
  const workspaceId = input.workspaceId ?? newWorkspaceId();
  if (directory === undefined) return create(workspaceId);
  const slug = normalizeWorkspaceSlug(input.slug);
  let claim: "claimed" | "taken";
  try {
    claim = await directory.claimSlug({ workspaceId, slug, cellId: input.cellId });
  } catch (error) {
    input.log?.("directory.claim_failed", {
      level: "error",
      workspaceId,
      cellId: input.cellId,
      error: errorText(error),
    });
    throw new PlacementError(
      "directory_unavailable",
      "the cell directory could not be reached; try again shortly",
    );
  }
  // Never who holds it (another cell's tenant is none of this caller's business): the message
  // is the local unique index's.
  if (claim === "taken") throw new PlacementError("slug_taken", `the address "${slug}" is taken`);
  let result: T;
  try {
    result = await create(workspaceId);
  } catch (error) {
    await releaseQuietly(directory, workspaceId, input.log);
    throw error;
  }
  await activateQuietly(directory, workspaceId, input.log);
  return result;
}

/** `activate` after a commit: best effort (the reconcile sweep repairs a miss). */
export async function activateQuietly(
  directory: Pick<DirectoryPort, "activate"> | undefined,
  workspaceId: string,
  log?: PlacementLog,
): Promise<void> {
  if (directory === undefined) return;
  try {
    await directory.activate(workspaceId);
  } catch (error) {
    log?.("directory.activate_failed", { level: "warn", workspaceId, error: errorText(error) });
  }
}

/** `release` after a failure or a purge: best effort (the reconcile sweep repairs a miss). */
export async function releaseQuietly(
  directory: Pick<DirectoryPort, "release"> | undefined,
  workspaceId: string,
  log?: PlacementLog,
): Promise<void> {
  if (directory === undefined) return;
  try {
    await directory.release(workspaceId);
  } catch (error) {
    log?.("directory.release_failed", { level: "warn", workspaceId, error: errorText(error) });
  }
}

/** `SharedDirectory.ensureEntry`'s shape (the sweep's repair), structurally. */
export interface EntryRepairer {
  ensureEntry(input: {
    readonly workspaceId: string;
    readonly slug: string;
    readonly cellId: string;
    readonly localCellIds: readonly string[];
  }): Promise<unknown>;
}

/**
 * E3.11 RR1-8: makes a LIVE local workspace's directory entry what the reconcile sweep would make
 * it, now. A soft-deleted, purged or relocating workspace is left to the sweep and the moves
 * engine (never revived from here). Throws what the directory throws.
 */
export async function repairWorkspaceEntry(
  db: Database,
  directory: EntryRepairer,
  workspaceId: string,
): Promise<void> {
  const { facts, localCellIds } = await db.withHost(async (tx) => ({
    facts: await readEntryFacts(tx, workspaceId),
    localCellIds: (await listCellRows(tx)).map((c) => c.id),
  }));
  if (facts === undefined || facts.deletedAt !== null || facts.holds.includes("relocation")) return;
  await directory.ensureEntry({
    workspaceId,
    slug: facts.slug,
    cellId: facts.cellId,
    localCellIds,
  });
}
