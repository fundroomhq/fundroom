import { core, type Database } from "@fundroom/db";
import type { DirectoryCell } from "@fundroom/ports";
import { asc } from "drizzle-orm";

const { cell } = core;

/** This database's `core.cell` rows as directory cells (`local: true`). Host context. */
export async function listLocalCells(db: Database): Promise<DirectoryCell[]> {
  const rows = await db.withHost((tx) =>
    tx.select().from(cell).orderBy(asc(cell.createdAt), asc(cell.id)),
  );
  return rows.map((r) => ({
    id: r.id,
    region: r.region,
    regionLabel: r.regionLabel,
    jurisdiction: r.jurisdiction ?? null,
    publicOrigin: r.publicOrigin,
    status: r.status,
    exportPublicKey: null,
    heartbeatAt: null,
    local: true,
  }));
}
