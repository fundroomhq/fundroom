import type { KeyRing } from "@fundroom/config";
import {
  type AppliedMigration,
  createDatabase,
  type Database,
  planMigrations,
  readMigrationSources,
  runMigrations,
} from "@fundroom/db";
import {
  directoryMigrationSource,
  publishLocalCells,
  type ReconcileReport,
  reconcileDirectory,
} from "@fundroom/directory";
import { exportPublicKeys } from "@fundroom/portability";
import type { DirectoryPort, JobDefinition, JsonObject } from "@fundroom/ports";

/*
 * The directory's upkeep jobs (E3.11 §8, ADR-0059; owner: agent A). Shared directory only — in
 * local mode there is nothing to publish or repair and no job is registered.
 *
 *  - `directory.heartbeat` every 5 min: publishes every cell this database serves (region facts,
 *    status, heartbeat, and the public half of the instance's portability export signing key —
 *    what a move's target verifies the source's bundle against). Moves refuse a target whose
 *    heartbeat is older than 15 min, so this runs well inside that.
 *  - `directory.reconcile` every 10 min: the repair path behind B's best-effort placement hooks
 *    (`reconcileDirectory` in @fundroom/directory: entries for local workspaces, missed purge
 *    releases, stale reservations, verified hostnames). It publishes too.
 *
 * Both are idempotent and singleton-queued: a slow run and the next tick never overlap.
 */

export const JOB_DIRECTORY_HEARTBEAT = "directory.heartbeat";
export const JOB_DIRECTORY_RECONCILE = "directory.reconcile";

export interface DirectoryJobDeps {
  readonly db: Database;
  readonly directory: DirectoryPort;
  readonly keyRing: KeyRing;
  /**
   * DIRECTORY_DATABASE_URL. With it, every `directory.heartbeat` tick applies the directory's
   * migrations first (idempotent; the runner's advisory lock serialises cells) — so a directory
   * that was unreachable when a cell booted is migrated by whichever worker runs the next tick,
   * whatever MIGRATE_ON_START says for that process (RR1-3).
   */
  readonly directoryUrl?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

/**
 * Every export public key of this deployment's ring (current first): the shared directory's
 * `ownerKeys`, i.e. the proof that a published cell row is this cell database's.
 */
export function directoryOwnerKeys(keyRing: KeyRing): string[] {
  return exportPublicKeys(keyRing).map((k) => k.publicKey);
}

/** The export signing key's public half the portability exporter signs bundles with. */
export function exportPublicKeyOf(keyRing: KeyRing): string | null {
  return exportPublicKeys(keyRing)[0]?.publicKey ?? null;
}

/** Every key of the ring with its id (R1-6): a target matches the bundle's signer key id. */
export function exportPublicKeyListOf(keyRing: KeyRing): { keyId: string; publicKey: string }[] {
  return exportPublicKeys(keyRing).map((k) => ({ keyId: k.keyId, publicKey: k.publicKey }));
}

function publishInput(deps: DirectoryJobDeps) {
  return {
    db: deps.db,
    directory: deps.directory,
    exportPublicKey: exportPublicKeyOf(deps.keyRing),
    exportPublicKeys: exportPublicKeyListOf(deps.keyRing),
    log: deps.log,
  };
}

/** How long boot waits for the first publish before carrying on (it finishes in the background). */
export const BOOT_PUBLISH_WAIT_MS = 5_000;

/**
 * Publishes this database's cells once (boot). Never throws and never holds the boot up for
 * more than `waitMs` (R2-2): a directory that is down or slow at boot must not stop the cell from
 * serving its own tenants; the publish finishes in the background and the heartbeat job retries.
 * Resolves with the published ids, or `[]` when it failed or is still running.
 */
export async function publishDirectoryCells(
  deps: DirectoryJobDeps & { readonly waitMs?: number | undefined },
): Promise<string[]> {
  const log = deps.log ?? (() => {});
  if (deps.directory.mode !== "shared") return [];
  const work = publishLocalCells(publishInput(deps)).then(
    (cells) => {
      log("directory.published", { cells });
      return cells;
    },
    (error: unknown) => {
      log("directory.publish_failed", {
        level: "warn",
        error: error instanceof Error ? error.message : String(error),
      });
      return [] as string[];
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => {
      log("directory.publish_slow", { level: "warn", waitMs: deps.waitMs ?? BOOT_PUBLISH_WAIT_MS });
      resolve([]);
    }, deps.waitMs ?? BOOT_PUBLISH_WAIT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Set when the boot could not reach the directory to migrate it; the heartbeat job retries the
 * migration before its first successful publish (R2-2). Process-wide on purpose.
 */
let migrationPending: { url: string } | undefined;

export interface DirectoryMigrateOptions {
  readonly url: string;
  /**
   * `best-effort` (server boot): an UNREACHABLE directory is logged loudly and skipped — the cell
   * boots and serves its own tenants, directory-dependent features fail closed per call (claims
   * 503, routing misses), and the heartbeat job / `fundroom directory migrate` apply it later.
   * `required` (`fundroom migrate`, `fundroom directory migrate`): any failure throws.
   * A failure AFTER connecting (a broken migration) always throws.
   */
  readonly mode: "best-effort" | "required";
  readonly connectTimeoutMs?: number | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

/** Applies the directory's migrations (its own database). Returns false when skipped. */
export async function migrateDirectoryDatabase(options: DirectoryMigrateOptions): Promise<boolean> {
  const log = options.log ?? (() => {});
  const dir = createDatabase({
    connectionString: options.url,
    poolMax: 2,
    connectionTimeoutMs: options.connectTimeoutMs ?? 5_000,
  });
  try {
    try {
      await dir.pool.query("SELECT 1");
    } catch (error) {
      if (options.mode === "required") throw error;
      migrationPending = { url: options.url };
      log("migrate.directory.skipped", {
        level: "error",
        reason: "directory database unreachable",
        error: error instanceof Error ? error.message : String(error),
        hint: "the cell serves its own tenants; slug claims answer 503 and cross-cell routing is off until the directory is back (the heartbeat job retries; or run `fundroom directory migrate`)",
      });
      return false;
    }
    const result = await runMigrations(dir.pool, {
      sources: [directoryMigrationSource],
      log: (line) => log("migrate.directory.progress", { line }),
    });
    migrationPending = undefined;
    if (result.applied.length > 0 || options.mode === "best-effort") {
      log("migrate.directory.done", {
        applied: result.applied.map((a) => `${a.module}/${a.name}`),
      });
    }
    return true;
  } finally {
    await dir.close();
  }
}

/** Test seam: whether a boot skipped the directory migration and it is still pending. */
export function directoryMigrationPending(): boolean {
  return migrationPending !== undefined;
}

/** One reconcile pass (the job, and `fundroom directory sync`). Throws on a directory error. */
export async function runDirectoryReconcile(
  deps: DirectoryJobDeps,
): Promise<ReconcileReport | null> {
  return reconcileDirectory({ ...publishInput(deps), now: deps.now });
}

export function createDirectoryJobs(deps: DirectoryJobDeps): JobDefinition<JsonObject>[] {
  if (deps.directory.mode !== "shared") return [];
  const log = deps.log ?? (() => {});
  return [
    {
      name: JOB_DIRECTORY_HEARTBEAT,
      cron: "*/5 * * * *",
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 120 },
      handler: async () => {
        // RR1-3: every tick, in every process (not only the one whose boot skipped it) — but
        // RR3-1: plan first, apply only what is pending, and never let the migration step
        // (a newer schema from a cell already upgraded, a broken file, a role without CREATE)
        // stop the publish: a cell that stops publishing is `target_stale` within 15 minutes.
        const url = deps.directoryUrl ?? migrationPending?.url;
        if (url !== undefined) await heartbeatMigrate(url, log);
        await publishLocalCells(publishInput(deps));
      },
    },
    {
      name: JOB_DIRECTORY_RECONCILE,
      cron: "*/10 * * * *",
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 600 },
      handler: async () => {
        await runDirectoryReconcile(deps);
      },
    },
  ];
}

/** Warnings the heartbeat repeats at most once an hour per process (RR3-1). */
const HEARTBEAT_WARN_EVERY_MS = 60 * 60 * 1000;
const lastWarned = new Map<string, number>();

function warnRateLimited(
  log: (event: string, fields?: Readonly<Record<string, unknown>>) => void,
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  const at = Date.now();
  const last = lastWarned.get(event);
  if (last !== undefined && at - last < HEARTBEAT_WARN_EVERY_MS) return;
  lastWarned.set(event, at);
  log(event, { level: "warn", ...fields });
}

/**
 * The heartbeat's migration step (RR3-1). Reads the directory journal WITHOUT creating anything
 * (a least-privilege directory role without CREATE is fine when nothing is pending), plans, and
 * applies only when something is pending and the plan is clean. A journal holding a migration
 * this code does not have (a cell already upgraded to a newer release — the normal state during a
 * region-by-region rollout) is schema skew: a rate-limited warning, never an error. Never throws.
 * Returns the number of migrations applied.
 */
export async function heartbeatMigrate(
  url: string,
  log: (event: string, fields?: Readonly<Record<string, unknown>>) => void,
): Promise<number> {
  const dir = createDatabase({ connectionString: url, poolMax: 1, connectionTimeoutMs: 5_000 });
  try {
    const modules = await readMigrationSources([directoryMigrationSource]);
    const exists = await dir.pool.query<{ ok: boolean }>(
      "SELECT to_regclass('core.schema_migration') IS NOT NULL AS ok",
    );
    const applied: AppliedMigration[] =
      exists.rows[0]?.ok === true
        ? (
            await dir.pool.query<AppliedMigration>(
              "SELECT module, name, checksum FROM core.schema_migration WHERE module = $1",
              [directoryMigrationSource.module],
            )
          ).rows
        : [];
    const plan = planMigrations(modules, applied, { allowOutOfOrder: true });
    const newer = plan.problems.filter((p) => p.problem.includes("missing on disk"));
    const broken = plan.problems.filter((p) => !p.problem.includes("missing on disk"));
    if (newer.length > 0) {
      warnRateLimited(log, "migrate.directory.schema_newer", {
        applied: newer.map((p) => `${p.module}/${p.name}`),
        hint: "the directory has migrations from a newer release (another cell is upgraded); upgrade this cell",
      });
    }
    if (broken.length > 0) {
      warnRateLimited(log, "migrate.directory.plan_problem", {
        problems: broken.map((p) => `${p.module}/${p.name}: ${p.problem}`),
      });
      return 0;
    }
    if (plan.steps.length === 0) return 0;
    const result = await runMigrations(dir.pool, {
      sources: [directoryMigrationSource],
      log: (line) => log("migrate.directory.progress", { line }),
    });
    migrationPending = undefined;
    log("migrate.directory.done", {
      applied: result.applied.map((a) => `${a.module}/${a.name}`),
    });
    return result.applied.length;
  } catch (error) {
    warnRateLimited(log, "migrate.directory.heartbeat_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  } finally {
    await dir.close();
  }
}
