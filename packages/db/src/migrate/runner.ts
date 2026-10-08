import type { Client, Pool, PoolClient } from "pg";
import { type MigrationPlan, MigrationPlanError, planMigrations } from "./plan.js";
import { type MigrationSource, readMigrationSources } from "./sources.js";

/*
 * The migration runner (ADR-0004, design/06 §9).
 *
 *  1. Take a session-level advisory lock so two replicas starting together
 *     (MIGRATE_ON_START=true in Compose) serialise instead of racing.
 *  2. Bootstrap the journal (`core.schema_migration`) if missing.
 *  3. Plan: compare journal vs files, verify checksums, refuse out-of-order by default.
 *  4. Apply each pending file: one transaction per file with `SET LOCAL lock_timeout`,
 *     retried on lock timeout; or chunk-by-chunk autocommit for `no-transaction` files.
 *  5. Post-steps: core.apply_tenant_fence() so any new workspace_id table is fenced
 *     before the app can touch it.
 *
 * The runner connects as the deployment's DATABASE_URL user (the table owner).
 * It never switches to seedhost_app.
 */

/** Two int4 keys => one bigint advisory lock id, stable across versions. */
export const MIGRATION_LOCK_KEYS = [0x5eed, 0x0001] as const;

export interface RunMigrationsOptions {
  readonly sources: readonly MigrationSource[];
  /** Print the plan and exit without applying. */
  readonly dryRun?: boolean;
  readonly allowOutOfOrder?: boolean;
  /** `SET LOCAL lock_timeout` for transactional files. Default 5 s. */
  readonly lockTimeoutMs?: number;
  /** Retries when a DDL statement hits lock_timeout. Default 5 (exponential backoff, 0.5 s base). */
  readonly lockRetries?: number;
  /** How long to wait for the advisory lock held by another runner. Default 10 min. */
  readonly waitForLockMs?: number;
  readonly log?: (line: string) => void;
}

export interface RunMigrationsResult {
  readonly plan: MigrationPlan;
  readonly applied: readonly { module: string; name: string; durationMs: number }[];
  readonly fencedTables: number;
}

export class MigrationApplyError extends Error {
  override readonly name = "MigrationApplyError";
  constructor(
    readonly module: string,
    readonly migration: string,
    readonly chunkIndex: number,
    cause: unknown,
  ) {
    super(
      `${module}/${migration} chunk ${chunkIndex + 1} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

type Conn = PoolClient | Client;

const LOCK_NOT_AVAILABLE = "55P03";

export async function runMigrations(
  pool: Pool,
  options: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  const log = options.log ?? (() => {});
  const modules = await readMigrationSources(options.sources);
  const conn = await pool.connect();
  try {
    await acquireLock(conn, options.waitForLockMs ?? 600_000);
    try {
      await bootstrapJournal(conn);
      const applied = await readJournal(conn);
      const plan = planMigrations(modules, applied, {
        allowOutOfOrder: options.allowOutOfOrder ?? false,
      });
      if (plan.problems.length > 0) throw new MigrationPlanError(plan.problems);

      const bypass = await migratorBypassesRls(conn);
      if (!bypass) {
        log(
          "warning: the migrating role is not superuser/BYPASSRLS; migrations that read or " +
            "update tenant rows will see zero rows. Create structure only; backfill via jobs.",
        );
      }

      if (plan.steps.length === 0) log("migrations: up to date");
      for (const step of plan.steps) {
        log(
          `${options.dryRun ? "would apply" : "applying"} ${step.module}/${step.migration.name}` +
            `${step.migration.transactional ? "" : " (no-transaction)"}`,
        );
      }
      if (options.dryRun) return { plan, applied: [], fencedTables: 0 };

      const appliedNow: { module: string; name: string; durationMs: number }[] = [];
      for (const step of plan.steps) {
        const started = performance.now();
        if (step.migration.transactional) {
          await applyTransactional(conn, step.module, step.migration, options);
        } else {
          await applyAutocommit(conn, step.module, step.migration);
        }
        const durationMs = Math.round(performance.now() - started);
        await conn.query(
          "INSERT INTO core.schema_migration (module, name, checksum, duration_ms) VALUES ($1, $2, $3, $4)",
          [step.module, step.migration.name, step.migration.checksum, durationMs],
        );
        appliedNow.push({ module: step.module, name: step.migration.name, durationMs });
        log(`applied ${step.module}/${step.migration.name} in ${durationMs} ms`);
      }

      const fencedTables = await applyTenantFence(conn);
      if (fencedTables > 0) log(`fenced ${fencedTables} new tenant table(s)`);
      return { plan, applied: appliedNow, fencedTables };
    } finally {
      await conn.query("SELECT pg_advisory_unlock($1, $2)", [...MIGRATION_LOCK_KEYS]);
    }
  } finally {
    conn.release();
  }
}

/** Journal rows for `status` output. Bootstraps the journal so it works on an empty database. */
export async function migrationStatus(
  pool: Pool,
  sources: readonly MigrationSource[],
): Promise<MigrationPlan> {
  const modules = await readMigrationSources(sources);
  const conn = await pool.connect();
  try {
    await bootstrapJournal(conn);
    const applied = await readJournal(conn);
    return planMigrations(modules, applied, { allowOutOfOrder: true });
  } finally {
    conn.release();
  }
}

async function acquireLock(conn: Conn, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = await conn.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS ok", [
      ...MIGRATION_LOCK_KEYS,
    ]);
    if (r.rows[0]?.ok) return;
    if (Date.now() >= deadline) {
      throw new Error(`another migration run holds the lock; gave up after ${waitMs} ms`);
    }
    await sleep(500);
  }
}

async function bootstrapJournal(conn: Conn): Promise<void> {
  await conn.query(`
    CREATE SCHEMA IF NOT EXISTS core;
    CREATE TABLE IF NOT EXISTS core.schema_migration (
      module text NOT NULL,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL,
      PRIMARY KEY (module, name)
    )`);
}

async function readJournal(conn: Conn) {
  const r = await conn.query<{ module: string; name: string; checksum: string }>(
    "SELECT module, name, checksum FROM core.schema_migration ORDER BY module, name",
  );
  return r.rows;
}

async function migratorBypassesRls(conn: Conn): Promise<boolean> {
  const r = await conn.query<{ bypass: boolean }>(
    "SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user",
  );
  return r.rows[0]?.bypass ?? false;
}

async function applyTenantFence(conn: Conn): Promise<number> {
  const exists = await conn.query<{ ok: boolean }>(
    "SELECT to_regprocedure('core.apply_tenant_fence()') IS NOT NULL AS ok",
  );
  if (!exists.rows[0]?.ok) return 0;
  await conn.query("BEGIN");
  try {
    const r = await conn.query<{ n: number }>("SELECT core.apply_tenant_fence() AS n");
    await conn.query("COMMIT");
    return r.rows[0]?.n ?? 0;
  } catch (e) {
    await conn.query("ROLLBACK");
    throw e;
  }
}

async function applyTransactional(
  conn: Conn,
  module: string,
  migration: { name: string; chunks: readonly string[] },
  options: RunMigrationsOptions,
): Promise<void> {
  const retries = options.lockRetries ?? 5;
  const lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  for (let attempt = 0; ; attempt++) {
    await conn.query("BEGIN");
    let chunkIndex = 0;
    try {
      // SET LOCAL: scoped to this transaction; the pooled connection is clean afterwards.
      await conn.query(`SET LOCAL lock_timeout = '${Math.max(1, Math.floor(lockTimeoutMs))}ms'`);
      for (; chunkIndex < migration.chunks.length; chunkIndex++) {
        await conn.query(migration.chunks[chunkIndex] as string);
      }
      await conn.query("COMMIT");
      return;
    } catch (e) {
      await conn.query("ROLLBACK");
      if (isLockTimeout(e) && attempt < retries) {
        const backoff = 500 * 2 ** attempt;
        options.log?.(
          `${module}/${migration.name}: lock timeout, retrying in ${backoff} ms (${attempt + 1}/${retries})`,
        );
        await sleep(backoff);
        continue;
      }
      throw new MigrationApplyError(module, migration.name, chunkIndex, e);
    }
  }
}

async function applyAutocommit(
  conn: Conn,
  module: string,
  migration: { name: string; chunks: readonly string[] },
): Promise<void> {
  for (let i = 0; i < migration.chunks.length; i++) {
    try {
      await conn.query(migration.chunks[i] as string);
    } catch (e) {
      throw new MigrationApplyError(module, migration.name, i, e);
    }
  }
}

function isLockTimeout(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && (e as { code?: string }).code === LOCK_NOT_AVAILABLE
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
