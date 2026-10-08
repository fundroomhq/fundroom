import { randomBytes } from "node:crypto";
import {
  coreMigrationSource,
  createDatabase,
  type Database,
  type MigrationSource,
  runMigrations,
} from "@fundroom/db";
import type { TestPostgres } from "@fundroom/db/testing";
import { directoryMigrationSource } from "@fundroom/directory";
import { createModuleRegistry } from "@fundroom/module-kit";
import { COMPILED_IN_MODULES } from "../modules.js";

/*
 * E3.11 integration helpers: extra databases inside the one testcontainer Postgres a test file
 * already started (`startPostgres` from `@fundroom/db/testing`). Each call creates a fresh
 * database with a unique name, so files and describes never share one.
 *
 *   const dir = await createDirectoryDatabase(pg);   // DIRECTORY_DATABASE_URL = dir.url
 *   const cell2 = await createCellDatabase(pg);      // DATABASE_URL of a second cell
 *   …
 *   await dir.close(); await cell2.close();          // drops the database
 *
 * Roles (`seedhost_app`) are cluster-wide, so a second cell database migrates cleanly next to the
 * first. `startServer` migrates on boot anyway; `createCellDatabase` migrates up front so a test
 * can seed rows before any server exists (pass `migrate: false` to skip).
 */

export interface TestDatabase {
  /** postgres:// URL of the new database (same server, user and password as `pg`). */
  readonly url: string;
  /** The database name. */
  readonly name: string;
  /**
   * A small pool to it as the container superuser (`db.pool.query` for seeding rows and
   * assertions; `withHost`/`withTenant` switch to seedhost_app as usual). Closed by `close()`.
   */
  readonly db: Database;
  /** Ends the pool and drops the database (terminating any other connection to it). */
  close(): Promise<void>;
}

function urlWithDatabase(connectionString: string, name: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A fresh empty database, optionally migrated with `sources`. */
export async function createTestDatabase(
  server: TestPostgres,
  options: { readonly prefix?: string; readonly sources?: readonly MigrationSource[] } = {},
): Promise<TestDatabase> {
  const name = `${options.prefix ?? "seedhost_extra"}_${randomBytes(5).toString("hex")}`;
  await server.pool.query(`CREATE DATABASE ${name}`);
  const url = urlWithDatabase(server.connectionString, name);
  const db = createDatabase({ connectionString: url, poolMax: 4 });
  if (options.sources !== undefined && options.sources.length > 0) {
    await runMigrations(db.pool, { sources: options.sources });
  }
  return {
    url,
    name,
    db,
    async close() {
      await db.close().catch(() => {});
      await server.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

/** A fresh directory database with `packages/directory/migrations` applied. */
export function createDirectoryDatabase(server: TestPostgres): Promise<TestDatabase> {
  return createTestDatabase(server, {
    prefix: "seedhost_directory",
    sources: [directoryMigrationSource],
  });
}

/**
 * A fresh database for a second (third, …) cell with the kernel and every compiled-in module's
 * migrations applied (`migrate: false` leaves it empty for `startServer` to migrate).
 */
export function createCellDatabase(
  server: TestPostgres,
  options: { readonly migrate?: boolean } = {},
): Promise<TestDatabase> {
  const registry = createModuleRegistry(COMPILED_IN_MODULES);
  return createTestDatabase(server, {
    prefix: "seedhost_cell",
    sources: options.migrate === false ? [] : [coreMigrationSource, ...registry.migrationSources],
  });
}
