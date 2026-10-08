import type { AppConfig, KeyRing } from "@fundroom/config";
import { createDatabase, type Database } from "@fundroom/db";
import { createLocalDirectory, createSharedDirectory } from "@fundroom/directory";
import type { DirectoryPort } from "@fundroom/ports";
import {
  directoryOwnerKeys,
  migrateDirectoryDatabase,
  runDirectoryReconcile,
} from "../residency/directory-jobs.js";

export const DIRECTORY_USAGE = `usage: fundroom directory status [--json]
       fundroom directory sync
       fundroom directory migrate`;

/*
 * fundroom directory status|sync (E3.11, ADR-0059; owner: agent A). Exit 0 ok, 1 failed, 2 usage.
 *
 *  - status: the directory mode (`local` without DIRECTORY_DATABASE_URL, else `shared`) and every
 *    cell the directory knows, with its region, status, whether this database serves it, and the
 *    age of its last heartbeat. Local mode lists this database's cells (no heartbeats).
 *  - sync: one reconcile pass now (what the 10-minute `directory.reconcile` job does): publish
 *    this database's cells, repair entries for local workspaces, release stale reservations,
 *    re-claim verified hostnames. Shared mode only.
 *  - migrate: apply the directory database's migrations now and fail loudly if it is unreachable
 *    (a booting server skips an unreachable directory instead, R2-2). Shared mode only.
 */

export interface DirectoryCommandDeps {
  readonly db: Database;
  readonly directory: DirectoryPort;
  readonly keyRing: KeyRing;
  readonly now?: (() => Date) | undefined;
  readonly out?: ((line: string) => void) | undefined;
  readonly err?: ((line: string) => void) | undefined;
}

function age(from: Date | null, now: Date): string {
  if (from === null) return "never";
  const s = Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
  if (s < 120) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export async function directoryCommand(
  argv: readonly string[],
  deps: DirectoryCommandDeps,
): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const now = deps.now ?? (() => new Date());
  switch (argv[0]) {
    case "status": {
      const cells = await deps.directory.listCells();
      const at = now();
      if (argv.includes("--json")) {
        out(JSON.stringify({ mode: deps.directory.mode, cells }, null, 2));
        return 0;
      }
      out(`mode: ${deps.directory.mode}`);
      for (const c of cells) {
        out(
          `${c.id.padEnd(24)} ${c.status.padEnd(9)} ${c.region.padEnd(16)} ${(c.local ? "local" : "remote").padEnd(7)} heartbeat ${deps.directory.mode === "local" ? "n/a" : age(c.heartbeatAt, at)}  ${c.publicOrigin === "" ? "(this install)" : c.publicOrigin}`,
        );
      }
      return 0;
    }
    case "sync": {
      if (deps.directory.mode !== "shared") {
        err("the cell directory is local (no DIRECTORY_DATABASE_URL): nothing to sync");
        return 1;
      }
      const report = await runDirectoryReconcile({
        db: deps.db,
        directory: deps.directory,
        keyRing: deps.keyRing,
        now,
      });
      if (report === null) {
        err("the directory does not support reconciliation");
        return 1;
      }
      out(
        `published: ${report.cells.join(", ") || "(none)"}; entries created ${report.created}, repaired ${report.repaired}, conflicts ${report.conflicts}, released ${report.released}, stale reservations ${report.staleReservations}; hostnames claimed ${report.hostnamesClaimed}, conflicts ${report.hostnameConflicts}; skipped (relocating) ${report.skippedRelocating}`,
      );
      return report.conflicts + report.hostnameConflicts > 0 ? 1 : 0;
    }
  }
  err(DIRECTORY_USAGE);
  return 2;
}

export async function runDirectory(argv: readonly string[], config: AppConfig): Promise<number> {
  if (argv[0] === "migrate") {
    const url = config.raw.DIRECTORY_DATABASE_URL;
    if (url === undefined) {
      console.error("the cell directory is local (no DIRECTORY_DATABASE_URL): nothing to migrate");
      return 1;
    }
    await migrateDirectoryDatabase({
      url,
      mode: "required",
      log: (event, fields) => console.error(`${event} ${JSON.stringify(fields ?? {})}`),
    });
    return 0;
  }
  const db = createDatabase({ connectionString: config.raw.DATABASE_URL, poolMax: 2 });
  const url = config.raw.DIRECTORY_DATABASE_URL;
  const directory =
    url === undefined
      ? createLocalDirectory({ db })
      : createSharedDirectory({
          url,
          poolMax: 2,
          db,
          cellId: config.raw.CELL_ID,
          ownerKeys: directoryOwnerKeys(config.keyRing),
        });
  try {
    return await directoryCommand(argv, { db, directory, keyRing: config.keyRing });
  } finally {
    await directory.close();
    await db.close();
  }
}
