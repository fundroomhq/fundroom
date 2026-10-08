import type { MigrationSource } from "@fundroom/db";

/**
 * The directory's own migrations (`migrations/NNNN_*.sql`), applied by `runMigrations` against
 * the DIRECTORY database (DIRECTORY_DATABASE_URL) — never a cell's database. Journaled there as
 * module `directory`.
 */
export const directoryMigrationSource: MigrationSource = {
  module: "directory",
  dir: new URL("../migrations/", import.meta.url),
};
