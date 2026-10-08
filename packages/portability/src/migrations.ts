import { coreMigrationSource, readMigrationSource } from "@fundroom/db";
import type { ModuleManifest } from "@fundroom/module-kit";

/**
 * The migration names this build ships, per journal module (`core`, then every module with
 * migrations). The server applies all of them at boot (`serve` refuses to run behind its schema),
 * so this is the schema a running instance has — read from the build rather than from
 * `core.schema_migration`, which the application role is not granted.
 */
export async function buildMigrations(
  modules: readonly ModuleManifest[],
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const sources = [
    coreMigrationSource,
    ...modules.flatMap((m) =>
      m.migrations === undefined ? [] : [{ module: m.id, dir: m.migrations }],
    ),
  ];
  for (const s of sources) {
    out[s.module] = (await readMigrationSource(s)).migrations.map((m) => m.name);
  }
  return out;
}
