import { type CellRow, type CellStatus, core, type Tx } from "@fundroom/db";
import { and, asc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";

const { cell, PLACEHOLDER_REGION } = core;

/*
 * `core.cell` (E3.10). Anybody may read the catalogue; only the host context writes it.
 */

export interface CellCountRow extends CellRow {
  readonly workspaces: number;
}

/** Every cell with the number of (not deleted) workspaces placed on it. */
export async function listCellRows(tx: Tx): Promise<CellCountRow[]> {
  const rows = await tx
    .select({
      id: cell.id,
      region: cell.region,
      publicOrigin: cell.publicOrigin,
      status: cell.status,
      regionLabel: cell.regionLabel,
      jurisdiction: cell.jurisdiction,
      createdAt: cell.createdAt,
      updatedAt: cell.updatedAt,
      workspaces: sql<number>`(
        SELECT count(*)::int FROM core.workspace w
         WHERE w.cell_id = core.cell.id AND w.deleted_at IS NULL)`,
    })
    .from(cell)
    .orderBy(asc(cell.createdAt), asc(cell.id));
  return rows.map((r) => ({ ...r, workspaces: Number(r.workspaces) }));
}

export async function findCell(tx: Tx, id: string): Promise<CellRow | undefined> {
  const rows = await tx.select().from(cell).where(eq(cell.id, id)).limit(1);
  return rows[0];
}

/** Inserts a cell; `undefined` when the id exists already. */
export async function insertCell(
  tx: Tx,
  values: {
    id: string;
    region: string;
    publicOrigin: string;
    regionLabel?: string;
    jurisdiction?: core.CellJurisdiction | null;
  },
): Promise<CellRow | undefined> {
  const rows = await tx.insert(cell).values(values).onConflictDoNothing().returning();
  return rows[0];
}

export async function lockCell(tx: Tx, id: string): Promise<CellRow | undefined> {
  const rows = await tx.select().from(cell).where(eq(cell.id, id)).limit(1).for("update");
  return rows[0];
}

export async function writeCellStatus(
  tx: Tx,
  id: string,
  status: CellStatus,
): Promise<CellRow | undefined> {
  const rows = await tx.update(cell).set({ status }).where(eq(cell.id, id)).returning();
  return rows[0];
}

/**
 * The cell row, locked `FOR NO KEY UPDATE`: enough to serialise writers of its non-key columns
 * (`public_origin`) without blocking inserts of workspaces that reference it (their foreign-key
 * check takes `FOR KEY SHARE`, which `FOR UPDATE` would conflict with).
 */
export async function lockCellNoKey(tx: Tx, id: string): Promise<CellRow | undefined> {
  const rows = await tx.select().from(cell).where(eq(cell.id, id)).limit(1).for("no key update");
  return rows[0];
}

/** Live (not deleted) workspaces placed on the cell; stops counting at `cap`. */
export async function countLiveWorkspacesOnCell(tx: Tx, id: string, cap = 1000): Promise<number> {
  const rows = await tx.execute(sql`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM core.workspace w
       WHERE w.cell_id = ${id} AND w.deleted_at IS NULL
       LIMIT ${cap}) live`);
  return Number((rows.rows[0] as { n: number } | undefined)?.n ?? 0);
}

/** E-UP-13 fix round 1: the cell's public origin (`fundroom cell set-origin`). */
export async function writeCellOrigin(
  tx: Tx,
  id: string,
  publicOrigin: string,
): Promise<CellRow | undefined> {
  const rows = await tx.update(cell).set({ publicOrigin }).where(eq(cell.id, id)).returning();
  return rows[0];
}

/**
 * E3.11 boot adoption: every placeholder cell (`region = 'default'`) not in `skip` takes the
 * declared region, label and jurisdiction. The 0024 triggers keep the single-region rule and
 * cascade the region to the cell's workspaces. Returns the adopted ids.
 */
export async function adoptPlaceholderCells(
  tx: Tx,
  declared: { region: string; regionLabel: string; jurisdiction: core.CellJurisdiction | null },
  skip: readonly string[],
): Promise<string[]> {
  const adopted = await tx
    .update(cell)
    .set({
      region: declared.region,
      regionLabel: declared.regionLabel,
      jurisdiction: declared.jurisdiction,
    })
    .where(
      skip.length === 0
        ? eq(cell.region, PLACEHOLDER_REGION)
        : and(eq(cell.region, PLACEHOLDER_REGION), notInArray(cell.id, [...skip])),
    )
    .returning({ id: cell.id });
  return adopted.map((r) => r.id);
}

/**
 * E3.11: the declared label and jurisdiction follow the deployment's config — every cell of the
 * declared region whose label or jurisdiction differs from a DECLARED value is refreshed (an
 * unset DATA_REGION_LABEL / DATA_REGION_JURISDICTION leaves the cells' own values alone).
 * Returns the previous values of the rows it changed.
 */
export async function refreshRegionFacts(
  tx: Tx,
  declared: { region: string; regionLabel: string; jurisdiction: core.CellJurisdiction | null },
): Promise<{ id: string; regionLabel: string; jurisdiction: string | null }[]> {
  const label = declared.regionLabel === "" ? undefined : declared.regionLabel;
  const jurisdiction = declared.jurisdiction ?? undefined;
  const differs = [
    ...(label === undefined ? [] : [ne(cell.regionLabel, label)]),
    ...(jurisdiction === undefined
      ? []
      : [sql`${cell.jurisdiction} IS DISTINCT FROM ${jurisdiction}`]),
  ];
  if (differs.length === 0) return [];
  const stale = await tx
    .select({ id: cell.id, regionLabel: cell.regionLabel, jurisdiction: cell.jurisdiction })
    .from(cell)
    .where(and(eq(cell.region, declared.region), or(...differs)))
    .orderBy(asc(cell.id))
    .for("update");
  if (stale.length > 0) {
    await tx
      .update(cell)
      .set({
        ...(label === undefined ? {} : { regionLabel: label }),
        ...(jurisdiction === undefined ? {} : { jurisdiction }),
      })
      .where(
        inArray(
          cell.id,
          stale.map((r) => r.id),
        ),
      );
  }
  return stale;
}

/** Whether any workspace row (live or deleted) is placed on the cell. */
export async function cellHasWorkspaces(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: core.workspace.id })
    .from(core.workspace)
    .where(eq(core.workspace.cellId, id))
    .limit(1);
  return rows.length > 0;
}

/** Cells whose region is neither the placeholder nor `region`. */
export async function cellsOutsideRegion(
  tx: Tx,
  region: string | null,
): Promise<{ id: string; region: string }[]> {
  const rows = await tx
    .select({ id: cell.id, region: cell.region })
    .from(cell)
    .where(
      region === null
        ? ne(cell.region, PLACEHOLDER_REGION)
        : and(ne(cell.region, PLACEHOLDER_REGION), ne(cell.region, region)),
    )
    .orderBy(asc(cell.id));
  return rows;
}
