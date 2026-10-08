import type { AuditRecorder } from "@fundroom/audit";
import { type CellRow, core, type Database, pgErrorCode, pgErrorMessage } from "@fundroom/db";
import { JURISDICTIONS, type Jurisdiction } from "@fundroom/ports";
import { auditPlatformChain } from "../workspaces/chains.js";
import type { ControlPlaneActor } from "../workspaces/status.js";
import {
  adoptPlaceholderCells,
  cellHasWorkspaces,
  cellsOutsideRegion,
  countLiveWorkspacesOnCell,
  findCell,
  insertCell,
  listCellRows,
  lockCell,
  lockCellNoKey,
  refreshRegionFacts,
  writeCellOrigin,
  writeCellStatus,
} from "./repos/cell-repo.js";

/** The cell every database is seeded with (0023). */
const PLACEHOLDER_CELL_ID = "default";

/*
 * Cells (E3.10, ADR-0058; owner: agent A): where a workspace is served. `core.cell` starts with
 * the `default` row (empty public origin = this install); the CLI adds and drains others
 * (`fundroom cell list|add|set-origin|drain`, audited `cell.add` / `cell.update` on the platform chain).
 *
 * A `draining` cell keeps serving the workspaces it has but takes no new ones: provisioning and
 * `PATCH /platform/workspaces/{id}` only place a workspace on an `active` cell.
 */

export interface CellSummary extends CellRow {
  readonly workspaces: number;
}

export interface CellDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly actor?: ControlPlaneActor | undefined;
  /**
   * E3.11: DATA_REGION. When set, a new cell must declare exactly this region (one database =
   * one region; the 0024 trigger is the backstop, this is the clear message).
   */
  readonly dataRegion?: string | undefined;
}

const CELL_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/u;
/**
 * The `core.cell` CHECK: an https origin with no path, or '' for this install. Never plain http:
 * an edge would carry sessions and tenant traffic to it in the clear.
 */
const CELL_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/u;

export class CellInputError extends Error {
  override readonly name = "CellInputError";
  constructor(
    readonly field: "id" | "region" | "publicOrigin" | "regionLabel" | "jurisdiction",
    message: string,
  ) {
    super(message);
  }
}

/** Every cell with its workspace count. */
export async function listCells(db: Database): Promise<readonly CellSummary[]> {
  return db.withHost((tx) => listCellRows(tx));
}

/** Live (not deleted) workspaces on the cell, counted up to 1000 (a start-up hint, not a census). */
export async function liveWorkspacesOnCell(db: Database, id: string): Promise<number> {
  return db.withHost((tx) => countLiveWorkspacesOnCell(tx, id));
}

/** The cell, if it exists and takes new workspaces (`active`). */
export async function cellAcceptsWorkspaces(db: Database, id: string): Promise<boolean> {
  const row = await db.withHost((tx) => findCell(tx, id));
  return row?.status === "active";
}

export function isJurisdiction(value: string): value is Jurisdiction {
  return (JURISDICTIONS as readonly string[]).includes(value);
}

/**
 * E-UP-13: this process's CELL_ID cannot take a new workspace — its `core.cell` row is missing
 * (`missing`), or it is `draining` / `closed` (fix round 1 L2, as provisioning refuses). Placing
 * the workspace on the seeded `default` instead (what E3.11 did for a missing row) put it where
 * the cell guard answers `421 wrong_cell` for every request under the control plane, so
 * placement refuses. The server creates a missing row at start-up (`ensureOwnCell`); `missing`
 * here is a database no server has started on yet.
 */
export class OwnCellUnavailableError extends Error {
  override readonly name = "OwnCellUnavailableError";
  constructor(
    readonly cellId: string,
    readonly state: "missing" | "draining" | "closed",
  ) {
    super(
      state === "missing"
        ? `CELL_ID=${cellId} has no row in core.cell, so a new workspace has nowhere to go. Start the server once (it creates the row from CELL_ID, DATA_REGION and BASE_URL), or add it: fundroom cell add ${cellId} --region <DATA_REGION> --origin <https origin>.`
        : `CELL_ID=${cellId} is ${state} (fundroom cell list): it takes no new workspaces.`,
    );
  }
}

export function isOwnCellUnavailableError(error: unknown): error is OwnCellUnavailableError {
  return error instanceof OwnCellUnavailableError;
}

/**
 * E3.11: the cell a workspace created outside provisioning (setup wizard, demo seed, workspace
 * import) is placed on — this process's CELL_ID. The seeded `default` only when CELL_ID is
 * `default`; a named CELL_ID without its row, or not `active`, throws `OwnCellUnavailableError`
 * (E-UP-13), never a silent `default`.
 */
export async function localPlacementCell(db: Database, cellId: string): Promise<string> {
  if (cellId === PLACEHOLDER_CELL_ID) return cellId;
  const row = await db.withHost((tx) => findCell(tx, cellId));
  if (row === undefined) throw new OwnCellUnavailableError(cellId, "missing");
  if (row.status !== "active") throw new OwnCellUnavailableError(cellId, row.status);
  return row.id;
}

export interface OwnCellDeclaration {
  /** CELL_ID. */
  readonly id: string;
  /** DATA_REGION; undefined = not declared (the row takes the placeholder region). */
  readonly region?: string | undefined;
  readonly regionLabel?: string | undefined;
  readonly jurisdiction?: string | undefined;
  /**
   * The origin other cells and edges reach this cell at: BASE_URL's origin under the control
   * plane, '' (= this install) otherwise or when BASE_URL cannot be a cell origin (plain http).
   */
  readonly publicOrigin: string;
}

export type OwnCellOutcome =
  /** CELL_ID is `default`: the seeded row is the install's own (nothing to do). */
  | { readonly outcome: "placeholder" }
  | { readonly outcome: "created"; readonly row: CellRow }
  | { readonly outcome: "present"; readonly row: CellRow }
  /** The row exists but says something else; left exactly as it is (an operator may have edited it). */
  | {
      readonly outcome: "differs";
      readonly row: CellRow;
      readonly differences: readonly string[];
    }
  /** The row could not be created (another region declared in this database, a bad origin). */
  | { readonly outcome: "refused"; readonly reason: string };

/** The `core.cell` origin shape, or '' when `origin` cannot be one (plain http, an IPv6 literal). */
export function cellOriginOf(origin: string): string {
  const normalised = origin.trim().toLowerCase().replace(/\/+$/u, "");
  return CELL_ORIGIN_RE.test(normalised) ? normalised : "";
}

/**
 * E-UP-13: the install's own cell row, created at start-up when it is missing, from CELL_ID,
 * DATA_REGION (+ label, jurisdiction) and BASE_URL — what `fundroom cell add` would have
 * written, audited the same way (`cell.add` on the platform chain, actor `system/boot`).
 *
 * Idempotent and never destructive: an existing row is only compared, never written. A row
 * whose declared region or origin disagrees with the configuration is reported as `differs`
 * (the caller warns; the row's status is the caller's to report, since draining is deliberate): it may be an operator's deliberate edit, and silently rewriting
 * an origin or a region is worse than a warning. The placeholder region on the row is not a
 * difference (the region boot check adopts it). Concurrent starts (app and worker) are safe:
 * the insert is `ON CONFLICT DO NOTHING`, and the loser compares like any later start.
 */
export async function ensureOwnCell(
  deps: Pick<CellDeps, "db" | "audit">,
  own: OwnCellDeclaration,
): Promise<OwnCellOutcome> {
  if (own.id === PLACEHOLDER_CELL_ID) return { outcome: "placeholder" };
  const existing = await deps.db.withHost((tx) => findCell(tx, own.id));
  if (existing !== undefined) return compareOwnCell(existing, own);
  let created: CellRow | undefined;
  try {
    created = await addCell(
      {
        db: deps.db,
        audit: deps.audit,
        actor: { kind: "system", source: "boot" },
        dataRegion: own.region,
      },
      {
        id: own.id,
        region: own.region ?? core.PLACEHOLDER_REGION,
        publicOrigin: own.publicOrigin,
        regionLabel: own.region === undefined ? undefined : own.regionLabel,
        jurisdiction: own.region === undefined ? undefined : own.jurisdiction,
      },
    );
  } catch (error) {
    if (error instanceof CellInputError) return { outcome: "refused", reason: error.message };
    throw error;
  }
  if (created !== undefined) return { outcome: "created", row: created };
  // Another process (app next to worker) created it between the read and the insert.
  const raced = await deps.db.withHost((tx) => findCell(tx, own.id));
  if (raced === undefined) return { outcome: "refused", reason: "the row vanished after insert" };
  return compareOwnCell(raced, own);
}

function compareOwnCell(row: CellRow, own: OwnCellDeclaration): OwnCellOutcome {
  const differences: string[] = [];
  if (
    own.region !== undefined &&
    row.region !== core.PLACEHOLDER_REGION &&
    row.region !== own.region
  )
    differences.push(`region is ${row.region}, DATA_REGION is ${own.region}`);
  if (own.publicOrigin !== "" && row.publicOrigin !== own.publicOrigin)
    differences.push(
      `public origin is ${row.publicOrigin === "" ? "'' (this install)" : row.publicOrigin}, BASE_URL gives ${own.publicOrigin}`,
    );
  return differences.length === 0
    ? { outcome: "present", row }
    : { outcome: "differs", row, differences };
}

/** Adds a cell; `undefined` when the id is taken. */
export async function addCell(
  deps: CellDeps,
  input: {
    readonly id: string;
    readonly region: string;
    readonly publicOrigin: string;
    /** E3.11: human text for the region (0–120 characters). */
    readonly regionLabel?: string | undefined;
    /** E3.11: `eu|uk|ch|us|ca|au|other`. */
    readonly jurisdiction?: string | undefined;
  },
): Promise<CellRow | undefined> {
  const id = input.id.trim();
  const region = input.region.trim();
  const publicOrigin = normaliseCellOrigin(input.publicOrigin);
  const regionLabel = (input.regionLabel ?? "").trim();
  const jurisdiction = input.jurisdiction?.trim().toLowerCase();
  if (!CELL_ID_RE.test(id)) throw new CellInputError("id", "a cell id is a lower-case label");
  if (region.length < 1 || region.length > 64)
    throw new CellInputError("region", "a region is 1-64 characters");
  if (regionLabel.length > 120)
    throw new CellInputError("regionLabel", "a region label is at most 120 characters");
  if (jurisdiction !== undefined && !isJurisdiction(jurisdiction))
    throw new CellInputError("jurisdiction", `a jurisdiction is one of ${JURISDICTIONS.join("|")}`);
  if (deps.dataRegion !== undefined && region !== deps.dataRegion)
    throw new CellInputError(
      "region",
      `this deployment declares DATA_REGION=${deps.dataRegion}; a cell of this database must be in that region (one database = one region). A cell in another region is a separate deployment with its own database, joined through the shared cell directory.`,
    );
  try {
    return await deps.db.withHost(async (tx) => {
      const row = await insertCell(tx, {
        id,
        region,
        publicOrigin,
        regionLabel,
        jurisdiction: jurisdiction ?? null,
      });
      if (row === undefined) return undefined;
      await auditPlatformChain(tx, deps.audit, deps.actor ?? { kind: "system", source: "cli" }, {
        action: "cell.add",
        resourceKind: "cell",
        resourceId: null,
        meta: { cellId: id, region, publicOrigin, regionLabel, jurisdiction: jurisdiction ?? null },
      });
      return row;
    });
  } catch (error) {
    // The 0024 trigger `cell_single_region` (another cell of this database declares another
    // region): the same rule, said plainly rather than as a constraint violation.
    if (
      pgErrorCode(error) === "23514" &&
      /one database = one region/u.test(pgErrorMessage(error))
    ) {
      throw new CellInputError(
        "region",
        `this database already serves another region; a cell of this database cannot declare region ${region} (one database = one region)`,
      );
    }
    throw error;
  }
}

export interface RegionAdoption {
  /** Placeholder cells (`region = 'default'`) that took the declared region. */
  readonly adopted: readonly string[];
  /** Cells of the declared region whose label / jurisdiction were refreshed from config. */
  readonly refreshed: readonly string[];
  /** Cells declaring a region other than the declared one (or any region, when none is). */
  readonly foreign: readonly { readonly id: string; readonly region: string }[];
}

/**
 * E3.11 region boot check, the database half. With a declared region:
 *
 *  - placeholder cells adopt it (label and jurisdiction too) — except the seeded `default` row
 *    when this process serves another cell (`cellId`) and no workspace was ever placed on it:
 *    every cell database is seeded with one, so adopting (and publishing) it in each would give
 *    the shared directory the same cell id from several databases;
 *  - cells of the declared region take DATA_REGION_LABEL / DATA_REGION_JURISDICTION when they
 *    differ (the config is the declaration; a typo is fixed by fixing the config);
 *  - both audited `cell.update` on the platform chain;
 *
 * then the cells that still disagree are reported. Without a declared region it only reports the
 * cells that declare one.
 */
export async function adoptDeclaredRegion(
  deps: CellDeps,
  declared: {
    readonly region: string;
    readonly regionLabel: string;
    readonly jurisdiction: Jurisdiction | null;
  } | null,
  options: { readonly cellId?: string | undefined } = {},
): Promise<RegionAdoption> {
  if (declared === null) {
    const foreign = await deps.db.withHost((tx) => cellsOutsideRegion(tx, null));
    return { adopted: [], refreshed: [], foreign };
  }
  const actor = deps.actor ?? { kind: "system" as const, source: "boot" as const };
  return deps.db.withHost(async (tx) => {
    const skip: string[] = [];
    if (
      options.cellId !== undefined &&
      options.cellId !== PLACEHOLDER_CELL_ID &&
      !(await cellHasWorkspaces(tx, PLACEHOLDER_CELL_ID))
    ) {
      skip.push(PLACEHOLDER_CELL_ID);
    }
    const adopted = await adoptPlaceholderCells(tx, declared, skip);
    for (const cellId of adopted) {
      await auditPlatformChain(tx, deps.audit, actor, {
        action: "cell.update",
        resourceKind: "cell",
        resourceId: null,
        meta: {
          cellId,
          from: "default",
          to: declared.region,
          regionLabel: declared.regionLabel,
          jurisdiction: declared.jurisdiction,
        },
      });
    }
    const stale = await refreshRegionFacts(tx, declared);
    for (const row of stale) {
      if (adopted.includes(row.id)) continue;
      await auditPlatformChain(tx, deps.audit, actor, {
        action: "cell.update",
        resourceKind: "cell",
        resourceId: null,
        meta: {
          cellId: row.id,
          region: declared.region,
          from: { regionLabel: row.regionLabel, jurisdiction: row.jurisdiction },
          to: { regionLabel: declared.regionLabel, jurisdiction: declared.jurisdiction },
        },
      });
    }
    const foreign = await cellsOutsideRegion(tx, declared.region);
    return {
      adopted,
      refreshed: stale.map((r) => r.id).filter((id) => !adopted.includes(id)),
      foreign,
    };
  });
}

/** The `core.cell` origin input: '' (this install) or https://host[:port], lower-cased, no slash. */
function normaliseCellOrigin(input: string): string {
  const publicOrigin = input.trim().toLowerCase().replace(/\/+$/u, "");
  if (publicOrigin !== "" && !CELL_ORIGIN_RE.test(publicOrigin))
    throw new CellInputError("publicOrigin", "an origin is https://host[:port] with no path");
  return publicOrigin;
}

/**
 * E-UP-13 fix round 1: corrects a cell's public origin (`fundroom cell set-origin`) — notably
 * the own cell's row the server created at start-up from BASE_URL, which `cell add` cannot
 * touch (it refuses an existing id). Same validation as `add`; `''` means "this install".
 * Audited `cell.update` on the platform chain with the old and new origin. `undefined`: no such
 * cell. With a shared directory the change reaches it at the next heartbeat (or
 * `fundroom directory sync`).
 */
export async function setCellOrigin(
  deps: CellDeps,
  id: string,
  origin: string,
): Promise<CellRow | undefined> {
  const publicOrigin = normaliseCellOrigin(origin);
  return deps.db.withHost(async (tx) => {
    // Lock order: the cell row, then the platform audit chain (as `drainCell`). FOR NO KEY
    // UPDATE: the origin is not a key, so workspace inserts on this cell are not held up.
    const current = await lockCellNoKey(tx, id);
    if (current === undefined) return undefined;
    if (current.publicOrigin === publicOrigin) return current;
    const row = await writeCellOrigin(tx, id, publicOrigin);
    await auditPlatformChain(tx, deps.audit, deps.actor ?? { kind: "system", source: "cli" }, {
      action: "cell.update",
      resourceKind: "cell",
      resourceId: null,
      meta: { cellId: id, from: { publicOrigin: current.publicOrigin }, to: { publicOrigin } },
    });
    return row;
  });
}

/** Marks a cell `draining` (no new workspaces placed there). `undefined`: no such cell. */
export async function drainCell(deps: CellDeps, id: string): Promise<CellRow | undefined> {
  return deps.db.withHost(async (tx) => {
    const current = await lockCell(tx, id);
    if (current === undefined) return undefined;
    if (current.status === "draining") return current;
    const row = await writeCellStatus(tx, id, "draining");
    await auditPlatformChain(tx, deps.audit, deps.actor ?? { kind: "system", source: "cli" }, {
      action: "cell.update",
      resourceKind: "cell",
      resourceId: null,
      meta: { cellId: id, from: current.status, to: "draining" },
    });
    return row;
  });
}
