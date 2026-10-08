import type { TenantContext, Tx } from "@fundroom/db";
import { dsarRow } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { and, asc, eq } from "drizzle-orm";
import { definition, metricImport, point, sheetConnection, source } from "../schema/metrics.js";

const CAP = 10_000;

/**
 * Metrics holds no data *about* anybody: definitions, points and imports are the company's
 * numbers. What it does hold about a (staff) member is authorship — which rows they created or
 * imported, and when (E2.7 DSAR export; see `../dsar.ts`).
 */
export async function readMemberMetrics(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
): Promise<JsonObject> {
  const ws = ctx.workspaceId;
  const definitions = await tx
    .select({ id: definition.id, key: definition.key, createdAt: definition.createdAt })
    .from(definition)
    .where(and(eq(definition.workspaceId, ws), eq(definition.createdBy, membershipId)))
    .orderBy(asc(definition.createdAt), asc(definition.id))
    .limit(CAP);
  const points = await tx
    .select({ id: point.id, definitionId: point.definitionId, createdAt: point.createdAt })
    .from(point)
    .where(and(eq(point.workspaceId, ws), eq(point.createdBy, membershipId)))
    .orderBy(asc(point.createdAt), asc(point.id))
    .limit(CAP);
  const sources = await tx
    .select({ id: source.id, kind: source.kind, importedAt: source.importedAt })
    .from(source)
    .where(and(eq(source.workspaceId, ws), eq(source.importedBy, membershipId)))
    .orderBy(asc(source.importedAt), asc(source.id))
    .limit(CAP);
  const imports = await tx
    .select({ id: metricImport.id, status: metricImport.status, createdAt: metricImport.createdAt })
    .from(metricImport)
    .where(and(eq(metricImport.workspaceId, ws), eq(metricImport.createdBy, membershipId)))
    .orderBy(asc(metricImport.createdAt), asc(metricImport.id))
    .limit(CAP);
  const sheets = await tx
    .select({ id: sheetConnection.id, createdAt: sheetConnection.createdAt })
    .from(sheetConnection)
    .where(and(eq(sheetConnection.workspaceId, ws), eq(sheetConnection.createdBy, membershipId)))
    .orderBy(asc(sheetConnection.createdAt), asc(sheetConnection.id))
    .limit(CAP);
  return {
    version: 1,
    heldAboutMember: false,
    note: "Metrics are the company's figures; this lists only what the member created or imported.",
    authored: {
      definitions: definitions.map((r) => dsarRow(r)),
      points: points.map((r) => dsarRow(r)),
      sources: sources.map((r) => dsarRow(r)),
      imports: imports.map((r) => dsarRow(r)),
      sheetConnections: sheets.map((r) => dsarRow(r)),
    },
  };
}
