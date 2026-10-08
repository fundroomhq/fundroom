import type { TenantContext, Tx } from "@fundroom/db";
import type { JsonObject, JsonValue } from "@fundroom/ports";
import { type AnyColumn, and, eq, getTableColumns, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

/*
 * Shared plumbing for module DSAR exporters (E2.7, `ModuleManifest.dsar`): read one table's rows
 * about one member, on the kernel's transaction, and turn them into plain JSON.
 *
 * Deliberately small. Each module still decides *which* tables and columns are about the member
 * and which are secrets or other people's data (`omit`); this only saves eight modules from
 * writing the same select-convert-bound loop.
 */

/** Rows one table may contribute to one export before it is cut (and says so). */
export const DSAR_TABLE_ROW_LIMIT = 50_000;

export interface DsarRows {
  readonly rows: JsonObject[];
  /** More rows existed than `limit`; the export says so rather than looking complete. */
  readonly truncated: boolean;
}

export interface DsarRowsOptions {
  /** Property names (drizzle keys) to leave out: secrets, hashes, other people's data. */
  readonly omit?: readonly string[] | undefined;
  readonly orderBy?: readonly (PgColumn | SQL)[] | undefined;
  readonly limit?: number | undefined;
  /** Extra conditions ANDed with the member filter. */
  readonly where?: SQL | undefined;
}

/**
 * A value as the export writes it: dates as ISO strings, bytes dropped (`undefined`), bigints
 * as strings, nested JSON kept.
 */
export function dsarValue(value: unknown): JsonValue | undefined {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return undefined;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((v) => dsarValue(v)).filter((v): v is JsonValue => v !== undefined);
  }
  if (typeof value === "object") return dsarRow(value as Record<string, unknown>);
  return null;
}

/** One row as JSON, without the omitted keys and without byte columns. */
export function dsarRow(
  row: Readonly<Record<string, unknown>>,
  omit: readonly string[] = [],
): JsonObject {
  const out: JsonObject = {};
  const skip = new Set(omit);
  for (const [key, value] of Object.entries(row)) {
    if (skip.has(key)) continue;
    const v = dsarValue(value);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * Every row of `table` whose `memberColumn` is the member, fenced to the workspace (the RLS
 * fence already is; the explicit predicate keeps the plan on the workspace index), bounded.
 */
export async function dsarRowsFor(
  tx: Tx,
  ctx: TenantContext,
  table: PgTable,
  memberColumn: AnyColumn,
  membershipId: string,
  options: DsarRowsOptions = {},
): Promise<DsarRows> {
  const limit = options.limit ?? DSAR_TABLE_ROW_LIMIT;
  const columns = getTableColumns(table) as Record<string, AnyColumn>;
  const ws = columns["workspaceId"];
  const conditions: SQL[] = [eq(memberColumn, membershipId)];
  if (ws !== undefined) conditions.push(eq(ws, ctx.workspaceId));
  if (options.where !== undefined) conditions.push(options.where);
  const query = tx
    .select()
    .from(table)
    .where(and(...conditions))
    .$dynamic();
  const ordered =
    options.orderBy !== undefined && options.orderBy.length > 0
      ? query.orderBy(...options.orderBy)
      : query;
  const rows = (await ordered.limit(limit + 1)) as Record<string, unknown>[];
  return {
    rows: rows.slice(0, limit).map((r) => dsarRow(r, options.omit)),
    truncated: rows.length > limit,
  };
}
