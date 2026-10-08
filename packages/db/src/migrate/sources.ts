import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { MIGRATION_FILE_RE, parseMigration } from "./parse.js";
import type { ModuleMigrations } from "./plan.js";

/** Where a module keeps its SQL. Modules pass `new URL("./migrations", import.meta.url)`. */
export interface MigrationSource {
  readonly module: string;
  readonly dir: URL | string;
}

/** The kernel's own migrations, shipped inside this package. */
export const coreMigrationSource: MigrationSource = {
  module: "core",
  dir: new URL("../../migrations/core/", import.meta.url),
};

function toPath(dir: URL | string): string {
  return typeof dir === "string" ? dir : fileURLToPath(dir);
}

/** Reads and parses every `NNNN_name.sql` in a source directory (non-recursive; `meta/` etc. ignored). */
export async function readMigrationSource(source: MigrationSource): Promise<ModuleMigrations> {
  const path = toPath(source.dir);
  const entries = await readdir(path, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "en"));
  const migrations = [];
  for (const file of files) {
    if (!MIGRATION_FILE_RE.test(file)) {
      throw new Error(
        `${source.module}: ${file} does not match NNNN_snake_case.sql; rename it or move it out of ${path}`,
      );
    }
    const content = await readFile(`${path.replace(/\/$/u, "")}/${file}`, "utf8");
    migrations.push(parseMigration(file, content));
  }
  return { module: source.module, migrations };
}

export async function readMigrationSources(
  sources: readonly MigrationSource[],
): Promise<ModuleMigrations[]> {
  const out: ModuleMigrations[] = [];
  for (const s of sources) out.push(await readMigrationSource(s));
  return out;
}
