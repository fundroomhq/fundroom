#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import pg from "pg";
import { migrationStatus, runMigrations } from "./migrate/runner.js";
import { coreMigrationSource } from "./migrate/sources.js";
import { checkRlsCatalog, formatRlsFindings } from "./rls/check.js";

/*
 * fundroom-db <migrate|status|check-rls> [--dry-run] [--allow-out-of-order]
 *
 * Kernel-only CLI used by CI and by `pnpm --filter @fundroom/db migrate`. The product
 * CLI (`fundroom migrate`, apps/server) wraps runMigrations() with every module's source.
 * Reads DATABASE_URL (or DATABASE_URL_FILE) directly so it works without the full config.
 * `seedhost-db` (the pre-rename bin, ADR-0062) still points here for one minor release.
 */
const LEGACY_BIN = "seedhost-db";
const LEGACY_BIN_NOTE =
  "`seedhost-db` is now `fundroom-db`; the old name is removed in the next minor release.";

function databaseUrl(): string {
  const direct = process.env["DATABASE_URL"];
  const file = process.env["DATABASE_URL_FILE"];
  if (direct && file) throw new Error("set DATABASE_URL or DATABASE_URL_FILE, not both");
  if (direct) return direct;
  if (file) return readFileSync(file, "utf8").trim();
  throw new Error("DATABASE_URL is required. Example: postgres://seedhost:secret@db:5432/seedhost");
}

async function main(argv: readonly string[]): Promise<number> {
  const [command = "help", ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const log = (line: string) => console.error(line);

  if (command === "help" || command === "--help" || command === "-h") {
    console.error(
      "usage: fundroom-db <migrate|status|check-rls> [--dry-run] [--allow-out-of-order]",
    );
    return 0;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 2 });
  try {
    switch (command) {
      case "migrate": {
        await runMigrations(pool, {
          sources: [coreMigrationSource],
          dryRun: flags.has("--dry-run"),
          allowOutOfOrder: flags.has("--allow-out-of-order"),
          log,
        });
        return 0;
      }
      case "status": {
        const plan = await migrationStatus(pool, [coreMigrationSource]);
        console.error(`applied: ${plan.appliedCount}, pending: ${plan.steps.length}`);
        for (const s of plan.steps) console.error(`  pending ${s.module}/${s.migration.name}`);
        for (const p of plan.problems)
          console.error(`  problem ${p.module}/${p.name}: ${p.problem}`);
        return plan.problems.length === 0 ? 0 : 1;
      }
      case "check-rls": {
        const findings = await checkRlsCatalog(pool);
        console.error(formatRlsFindings(findings));
        return findings.length === 0 ? 0 : 1;
      }
      default:
        console.error(`unknown command ${command}`);
        return 2;
    }
  } finally {
    await pool.end();
  }
}

if (basename(process.argv[1] ?? "").replace(/\.(?:c|m)?js$/u, "") === LEGACY_BIN)
  console.error(LEGACY_BIN_NOTE);

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
