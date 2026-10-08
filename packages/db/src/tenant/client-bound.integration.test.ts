import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "../testing/postgres.js";
import { systemContext } from "./context.js";
import { ClientTimeoutError, createDatabase, type Database, pgErrorCode } from "./database.js";

/*
 * The opt-in client-side bound of createDatabase (`clientTimeoutMs`) against a real Postgres:
 * it follows the transaction's statement timeout through savepoints and the forms it cannot
 * parse, bounds COMMIT on its own terms, and reports its own cut instead of the dead
 * connection's ROLLBACK error (E2.10 review R1: DB-1..DB-4).
 */
let pg: TestPostgres;
let db: Database;
let noServerTimeout: Database;
const WS = "00000000-0000-7000-8000-00000000000b";
const ctx = systemContext(WS);

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

beforeAll(async () => {
  pg = await startPostgres();
  await pg.pool.query("CREATE TABLE public.bound_probe (x int)");
  await pg.pool.query("GRANT INSERT ON public.bound_probe TO seedhost_app");
  // Server cancels at 500 ms; the client bound is 800 ms (500 + 300 grace in a transaction).
  db = createDatabase({
    connectionString: pg.connectionString,
    poolMax: 2,
    statementTimeoutMs: 500,
    clientTimeoutMs: 800,
    clientTimeoutGraceMs: 300,
  });
  noServerTimeout = createDatabase({
    connectionString: pg.connectionString,
    poolMax: 2,
    statementTimeoutMs: 0,
    clientTimeoutMs: 500,
  });
}, 120_000);

afterAll(async () => {
  await db?.close();
  await noServerTimeout?.close();
  await pg?.stop();
});

describe("client-side bound", () => {
  it("DB-1: a rolled-back savepoint does not re-arm the bound while the server's timeout stays off", async () => {
    const value = await db.withTenant(ctx, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL statement_timeout = 0"));
      await tx
        .transaction(async (sp) => {
          await sp.execute(sql`select 1/0`);
        })
        .catch(() => {});
      const st = await tx.execute(sql`select current_setting('statement_timeout') AS st`);
      expect(st.rows[0]?.["st"]).toBe("0");
      await tx.execute(sql`select pg_sleep(1.2)`);
      return "ok";
    });
    expect(value).toBe("ok");
  });

  it("DB-1: ROLLBACK TO a savepoint taken before the change restores the earlier bound", async () => {
    const started = Date.now();
    const error = await failure(
      noServerTimeout.withTenant(ctx, async (tx) => {
        await tx.execute(sql.raw("SAVEPOINT a"));
        await tx.execute(sql.raw("SET LOCAL statement_timeout = 0"));
        await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT a"));
        // The bound (500 ms, no server timeout) applies again.
        await tx.execute(sql`select pg_sleep(3)`);
      }),
    );
    expect(error).toBeInstanceOf(ClientTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("DB-4: `= '2s'`, set_config and TO DEFAULT are honoured, never cut short by the client", async () => {
    await db.withTenant(ctx, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '2s'"));
      await tx.execute(sql`select pg_sleep(1.2)`);
    });
    await db.withTenant(ctx, async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '0', true)`);
      await tx.execute(sql`select pg_sleep(1.2)`);
    });
    await db.withTenant(ctx, async (tx) => {
      await tx.execute(sql`select set_config(${"statement_timeout"}, ${"0"}, true)`);
      await tx.execute(sql`select pg_sleep(1.2)`);
    });
    await db.withTenant(ctx, async (tx) => {
      // The test server's default is 0.
      await tx.execute(sql.raw("SET LOCAL statement_timeout TO DEFAULT"));
      await tx.execute(sql`select pg_sleep(1.2)`);
    });
    // A read of the setting changes nothing: the server still cancels at 500 ms.
    const error = await failure(
      db.withTenant(ctx, async (tx) => {
        await tx.execute(sql`select current_setting('statement_timeout')`);
        await tx.execute(sql`select pg_sleep(1.2)`);
      }),
    );
    expect(pgErrorCode(error)).toBe("57014");
  });

  it("DB-3: a statement cut by the bound reports the bound, with the driver's error as cause", async () => {
    const error = await failure(
      noServerTimeout.withTenant(ctx, (tx) => tx.execute(sql`select pg_sleep(3)`)),
    );
    expect(error).toBeInstanceOf(ClientTimeoutError);
    expect((error as Error).message).toMatch(/query exceeded the 500 ms client-side bound/u);
    expect(pgErrorCode(error)).toBe("08006");
    expect((error as Error).cause).toBeDefined();
    // The pool is not poisoned.
    await noServerTimeout.withTenant(ctx, (tx) => tx.execute(sql`select 1`));
  });

  it("DB-2: COMMIT keeps a bound after `= 0` and a cut COMMIT says its outcome is unknown", async () => {
    // A synchronous standby that never answers: COMMIT waits forever, and the server's
    // statement timeout does not cancel that wait.
    await pg.pool.query("ALTER SYSTEM SET synchronous_standby_names = 'ghost'");
    await pg.pool.query("SELECT pg_reload_conf()");
    // pg_reload_conf only signals; on a loaded machine the COMMIT below could otherwise run
    // before the setting applies (and succeed). Wait until a fresh statement sees it.
    for (let i = 0; i < 50; i++) {
      const s = await pg.pool.query("SHOW synchronous_standby_names");
      if (s.rows[0]?.synchronous_standby_names === "ghost") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    try {
      const started = Date.now();
      const error = await failure(
        db.withTenant(ctx, async (tx) => {
          await tx.execute(sql.raw("SET LOCAL statement_timeout = 0"));
          await tx.execute(sql`insert into public.bound_probe values (1)`);
        }),
      );
      expect(error).toBeInstanceOf(ClientTimeoutError);
      expect((error as ClientTimeoutError).phase).toBe("commit");
      expect(pgErrorCode(error)).toBe("08007");
      expect((error as Error).message).toMatch(/may or may not have committed/u);
      // The plain bound (800 ms), not "lifted forever".
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await pg.pool.query("ALTER SYSTEM RESET synchronous_standby_names");
      await pg.pool.query("SELECT pg_reload_conf()");
    }
    // Released by the reload: the insert did commit locally — which is why "unknown" matters.
    for (let i = 0; i < 50; i++) {
      const r = await pg.pool.query("SELECT count(*)::int AS n FROM public.bound_probe");
      if (r.rows[0]?.n === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const r = await pg.pool.query("SELECT count(*)::int AS n FROM public.bound_probe");
    expect(r.rows[0]?.n).toBe(1);
  }, 20_000);
});
