import { sql } from "drizzle-orm";
import type { Db as PgBossDb } from "pg-boss";
import { fromDrizzle } from "pg-boss";

/**
 * Bridges a `@fundroom/db` transaction (a drizzle transaction) to pg-boss's `IDatabase`
 * so `send()` runs its INSERT inside the caller's transaction. Lives under `repos/`
 * because it is the one place in this adapter that touches drizzle (lint rule
 * `only-repos-touch-drizzle`).
 */
export function pgBossDbFor(tx: { execute(query: unknown): Promise<unknown> }): PgBossDb {
  return fromDrizzle(
    tx as Parameters<typeof fromDrizzle>[0],
    sql as unknown as Parameters<typeof fromDrizzle>[1],
  );
}
