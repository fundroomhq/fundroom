import { createDatabase } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgBossQueue, grantLockTimeoutWithin, type PgBossQueue } from "./pgboss-queue.js";

/*
 * E-UP-10: on a fresh database `app` and `worker` start the queue at the same moment, and each
 * runs the app-role grant batch. Unserialised, Postgres refuses one side's GRANT with "tuple
 * concurrently updated" (7 of 12 rehearsal boots). Every round here is a fresh pg-boss schema
 * (a fresh install) started by several processes' worth of queues at once, each on its own
 * pool, each also creating queues — the start-up shape of `app` + `worker` + a restart.
 */
const ROUNDS = 12;
const PROCESSES = 4;
let pg0: TestPostgres;

beforeAll(async () => {
  pg0 = await startPostgres({ sources: [] });
  await pg0.pool.query(
    "DO $$ BEGIN CREATE ROLE seedhost_app NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
  );
}, 180_000);

afterAll(async () => {
  await pg0?.stop();
});

describe("concurrent start-up grants", () => {
  it(`never fail with "tuple concurrently updated" (${ROUNDS} fresh installs × ${PROCESSES} processes)`, async () => {
    const failures: string[] = [];
    // The locks must make the batches take turns; the retry is only for replicas without them,
    // so a retry here means the serialisation failed and the retry hid it.
    const retries: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const schema = `grants_race_${round}`;
      const pools = Array.from(
        { length: PROCESSES },
        () => new pg.Pool({ connectionString: pg0.connectionString, max: 3 }),
      );
      const queues: PgBossQueue[] = pools.map((pool) =>
        createPgBossQueue({
          pool,
          schema,
          supervise: false,
          schedule: false,
          log: (event, fields) => {
            if (event === "jobs.grant_retry")
              retries.push(`round ${round}: ${String(fields?.["error"])}`);
          },
        }),
      );
      try {
        const results = await Promise.allSettled(
          queues.map(async (q, i) => {
            await q.start();
            // Each "process" also creates queues, some shared, as the module registries do.
            await Promise.all([q.ensureQueue("race.shared"), q.ensureQueue(`race.own${i}`)]);
          }),
        );
        for (const r of results) {
          if (r.status === "rejected") failures.push(`round ${round}: ${String(r.reason)}`);
        }
        // Every queue's partition is usable by the app role, whichever process created it.
        const { rows } = await pg0.pool.query<{ table: string; ok: boolean }>(
          `SELECT c.relname AS table, has_table_privilege('seedhost_app', c.oid, 'INSERT') AS ok
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')`,
          [schema],
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.filter((r) => !r.ok)).toEqual([]);
      } finally {
        await Promise.all(queues.map((q) => q.stop({ timeoutMs: 1_000 }).catch(() => {})));
        await Promise.all(pools.map((p) => p.end()));
      }
    }
    expect(failures).toEqual([]);
    expect(retries).toEqual([]);
  }, 300_000);

  it("a start that fails after pg-boss started stops pg-boss again (nothing keeps the process alive)", async () => {
    // A role that does not exist makes the grant batch fail after `boss.start()` succeeded.
    const pool = new pg.Pool({ connectionString: pg0.connectionString, max: 2 });
    const q = createPgBossQueue({ pool, schema: "grants_fail", appRole: "no_such_role" });
    let stopped = false;
    q.boss.once("stopped", () => {
      stopped = true;
    });
    try {
      await expect(q.start()).rejects.toThrow(/no_such_role/u);
      // pg-boss was stopped before the rejection surfaced: its maintenance, supervision and cron
      // timers are gone, so they can neither keep the process alive nor query a closed pool.
      expect(stopped).toBe(true);
    } finally {
      await pool.end();
    }
    // A second start of a fresh instance on the same schema still works (no half state).
    const pool2 = new pg.Pool({ connectionString: pg0.connectionString, max: 2 });
    const ok = createPgBossQueue({ pool: pool2, schema: "grants_fail", supervise: false });
    try {
      await ok.start();
    } finally {
      await ok.stop({ timeoutMs: 1_000 });
      await pool2.end();
    }
  }, 120_000);

  it("a failure inside pg-boss's own start (after it armed its timers) stops pg-boss again", async () => {
    // The timekeeper's queue is created last in `boss.start()`, after the manager armed its
    // cache and wip intervals and supervision started. Its row insert is made to fail: once
    // pg-boss's install creates `<schema>.queue`, an event trigger arms a row trigger on it.
    const schema = "grants_boss_start";
    await pg0.pool.query(`
      CREATE FUNCTION public.fail_send_it() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = '__pgboss__send-it' THEN
          RAISE EXCEPTION 'injected: timekeeper queue creation failed';
        END IF;
        RETURN NEW;
      END $$;
      CREATE FUNCTION public.arm_fail_send_it() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands()
                    WHERE object_identity = '${schema}.queue') THEN
          CREATE TRIGGER fail_send_it BEFORE INSERT ON ${schema}.queue
            FOR EACH ROW EXECUTE FUNCTION public.fail_send_it();
        END IF;
      END $$;
      CREATE EVENT TRIGGER arm_fail_send_it ON ddl_command_end
        WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.arm_fail_send_it();
    `);
    const pool = new pg.Pool({ connectionString: pg0.connectionString, max: 2 });
    const q = createPgBossQueue({ pool, schema });
    let stopped = false;
    q.boss.once("stopped", () => {
      stopped = true;
    });
    try {
      await expect(q.start()).rejects.toThrow(/injected: timekeeper queue creation failed/u);
      expect(stopped).toBe(true);
    } finally {
      await pg0.pool.query("DROP EVENT TRIGGER IF EXISTS arm_fail_send_it");
      await pg0.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pg0.pool.query("DROP FUNCTION IF EXISTS public.arm_fail_send_it()");
      await pg0.pool.query("DROP FUNCTION IF EXISTS public.fail_send_it()");
      await pool.end();
    }
  }, 120_000);

  it("waits a bounded time for pg-boss's locks, then fails naming them", async () => {
    // Another session holds pg-boss's create-queue lock (pg-boss's own key expression).
    const schema = "grants_lock_wait";
    const holder = await pg0.pool.connect();
    const pool = new pg.Pool({ connectionString: pg0.connectionString, max: 2 });
    // No timekeeper: it would wait on the same lock inside pg-boss's own start.
    const q = createPgBossQueue({ pool, schema, schedule: false, grantLockTimeoutMs: 500 });
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT pg_advisory_xact_lock(('x' || encode(sha224((current_database() || '.pgboss.${schema}create-queue')::bytea), 'hex'))::bit(64)::bigint)`,
      );
      const t0 = Date.now();
      await expect(q.start()).rejects.toThrow(
        /gave up after 500 ms waiting for a lock \(most likely pg-boss's/u,
      );
      expect(Date.now() - t0).toBeLessThan(10_000);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await pool.end();
    }
  }, 120_000);

  it("on a pool that cuts queries client-side, the lock timeout (naming the lock) fires first", async () => {
    // The container's pool shape with DATABASE_STATEMENT_TIMEOUT_MS=2000: 3 s client bound.
    const bounds = { clientTimeoutMs: 3_000, graceMs: 1_000 };
    const schema = "grants_client_bound";
    const db = createDatabase({
      connectionString: pg0.connectionString,
      poolMax: 2,
      statementTimeoutMs: 2_000,
      clientTimeoutMs: bounds.clientTimeoutMs,
      clientTimeoutGraceMs: bounds.graceMs,
    });
    const holder = await pg0.pool.connect();
    const q = createPgBossQueue({
      pool: db.pool,
      schema,
      schedule: false,
      grantLockTimeoutMs: grantLockTimeoutWithin(bounds),
    });
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT pg_advisory_xact_lock(('x' || encode(sha224((current_database() || '.pgboss.${schema}create-queue')::bytea), 'hex'))::bit(64)::bigint)`,
      );
      await expect(q.start()).rejects.toThrow(/waiting for a lock \(most likely pg-boss's/u);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
      await db.close();
    }
  }, 120_000);

  it("a failed start does not wait on a wedged pg-boss stop forever", async () => {
    const pool = new pg.Pool({ connectionString: pg0.connectionString, max: 2 });
    const events: string[] = [];
    const q = createPgBossQueue({
      pool,
      schema: "grants_wedged_stop",
      appRole: "no_such_role",
      supervise: false,
      schedule: false,
      log: (event) => events.push(event),
    });
    // pg-boss's stop never settles, as when it waits on a query a wedged database never answers.
    const realStop = q.boss.stop.bind(q.boss);
    q.boss.stop = () => new Promise<void>(() => {});
    try {
      const t0 = Date.now();
      await expect(q.start()).rejects.toThrow(/no_such_role/u);
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(events).toContain("jobs.stop_after_failed_start_timeout");
    } finally {
      await realStop({ graceful: false, close: false }).catch(() => {});
      await pool.end();
    }
  }, 60_000);
});
