import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@fundroom/config";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { migrate, startServer } from "./server.js";

/*
 * E-UP-10: a `fundroom serve` whose start fails must exit non-zero, promptly, so the platform's
 * restart policy fires. It used to log the error and hang: the pools, pg-boss's timers and the
 * OTel SDK it had already started kept the event loop alive, so the process neither listened nor
 * exited. These run the real CLI in a child process — only a process can show that nothing is
 * left holding the event loop open.
 */
const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXIT_BUDGET_MS = 45_000;
/**
 * `cli.ts` force-exits 10 s after a failed start, as a backstop for a handle cleanup missed.
 * A clean failure exits on its own well before that, so an exit at or past the backstop means
 * a cleanup regression the backstop hid. Measured from the `server.start_failed` log line, not
 * from spawn: tsx compiling the server first takes a few seconds that vary with the machine.
 */
const PROMPT_EXIT_AFTER_FAILURE_MS = 5_000;
/** A generous ceiling from spawn, for the starts that fail before the log line exists. */
const SPAWN_TO_EXIT_CEILING_MS = 30_000;
let pg: TestPostgres;

function envFor(extra: Record<string, string> = {}): Record<string, string> {
  return {
    APP_ENV: "test",
    LOG_LEVEL: "warn",
    BASE_URL: "http://localhost:3000",
    DATABASE_URL: pg.connectionString,
    FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
    STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
    DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
    TENANCY_MODE: "single",
    ROLES: "api,web,worker",
    HOST: "127.0.0.1",
    SHUTDOWN_TIMEOUT_MS: "5000",
    ...extra,
  };
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly ms: number;
  /** From the first `server.start_failed` log line to exit; undefined if none was logged. */
  readonly afterFailureMs: number | undefined;
  readonly stderr: string;
  readonly stdout: string;
}

/** Runs `fundroom serve` from source; kills it (and answers `code: null`) past the budget. */
function serve(env: Record<string, string>): Promise<Exit> {
  const started = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
    cwd: SERVER_DIR,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (b: Buffer) => {
    stderr += b.toString();
  });
  let failedAt: number | undefined;
  child.stdout.on("data", (b: Buffer) => {
    stdout += b.toString();
    if (failedAt === undefined && stdout.includes('"event":"server.start_failed"')) {
      failedAt = Date.now();
    }
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), EXIT_BUDGET_MS);
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      clearTimeout(killer);
      const now = Date.now();
      const afterFailureMs = failedAt === undefined ? undefined : now - failedAt;
      resolve({ code, signal, ms: now - started, afterFailureMs, stderr, stdout });
    });
  });
}

/** Holds a TCP port on 127.0.0.1 until `close()`; answers its number. */
async function holdPort(): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function expectPromptExit(exit: Exit): void {
  expect(exit.signal, `killed after ${EXIT_BUDGET_MS} ms: the process hung`).toBeNull();
  expect(exit.code).toBe(1);
  expect(exit.ms).toBeLessThan(SPAWN_TO_EXIT_CEILING_MS);
  expect(
    exit.afterFailureMs,
    "no server.start_failed line: the cleanup path did not run",
  ).toBeDefined();
  expect(
    exit.afterFailureMs,
    "exited only at the cli's force-exit backstop: cleanup left a handle open",
  ).toBeLessThan(PROMPT_EXIT_AFTER_FAILURE_MS);
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  // Migrate up front, so the child's own MIGRATE_ON_START applies nothing and runs no GRANT.
  await migrate(
    loadConfig({ env: envFor() }),
    createLogger({ level: "warn" }),
    COMPILED_IN_MODULES,
  );
}, 240_000);

afterAll(async () => {
  await pg?.stop();
});

describe("a failed start", () => {
  it("exits non-zero when the queue's start-up grant fails (the E-UP-10 race), instead of hanging", async () => {
    // Every GRANT naming the pg-boss schema now fails the way the losing side of the race did.
    // pg-boss has started (its timers armed) and the pools are open when it fires.
    await pg.pool.query(`
      CREATE FUNCTION public.eup10_fail_grant() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_query() ILIKE '%pgboss%' THEN
          RAISE EXCEPTION 'tuple concurrently updated' USING ERRCODE = 'XX000';
        END IF;
      END $$;
      CREATE EVENT TRIGGER eup10_fail_grant ON ddl_command_end
        WHEN TAG IN ('GRANT', 'ALTER DEFAULT PRIVILEGES') EXECUTE FUNCTION public.eup10_fail_grant();
    `);
    // A free port (config refuses 0): this start never gets as far as listening.
    const free = await holdPort();
    await free.close();
    try {
      const exit = await serve(envFor({ PORT: String(free.port) }));
      expectPromptExit(exit);
      expect(exit.stderr + exit.stdout).toContain("tuple concurrently updated");
    } finally {
      await pg.pool.query("DROP EVENT TRIGGER IF EXISTS eup10_fail_grant");
      await pg.pool.query("DROP FUNCTION IF EXISTS public.eup10_fail_grant()");
    }
  }, 120_000);

  it("exits promptly when pg-boss's own start fails after it armed its timers", async () => {
    // A fresh pg-boss install; once its install creates `pgboss.queue`, an event trigger arms a
    // row trigger that fails the timekeeper's queue — the last step of `boss.start()`, after the
    // manager's cache/wip intervals and supervision are running.
    await pg.pool.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    await pg.pool.query(`
      CREATE FUNCTION public.eup10_fail_send_it() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.name = '__pgboss__send-it' THEN
          RAISE EXCEPTION 'injected: timekeeper queue creation failed';
        END IF;
        RETURN NEW;
      END $$;
      CREATE FUNCTION public.eup10_arm_fail_send_it() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands()
                    WHERE object_identity = 'pgboss.queue') THEN
          CREATE TRIGGER eup10_fail_send_it BEFORE INSERT ON pgboss.queue
            FOR EACH ROW EXECUTE FUNCTION public.eup10_fail_send_it();
        END IF;
      END $$;
      CREATE EVENT TRIGGER eup10_arm_fail_send_it ON ddl_command_end
        WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.eup10_arm_fail_send_it();
    `);
    const free = await holdPort();
    await free.close();
    try {
      const exit = await serve(envFor({ PORT: String(free.port) }));
      expectPromptExit(exit);
      expect(exit.stderr + exit.stdout).toContain("injected: timekeeper queue creation failed");
    } finally {
      await pg.pool.query("DROP EVENT TRIGGER IF EXISTS eup10_arm_fail_send_it");
      await pg.pool.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
      await pg.pool.query("DROP FUNCTION IF EXISTS public.eup10_arm_fail_send_it()");
      await pg.pool.query("DROP FUNCTION IF EXISTS public.eup10_fail_send_it()");
    }
  }, 120_000);

  it("exits non-zero when a grant fails after the queue started (a release that adds a queue)", async () => {
    // A fresh pg-boss install, so `queue.start()` itself (its grant, the dead-letter queue and
    // pg-boss's own `__pgboss__…` queues) succeeds and only the first module queue's grant fails: pg-boss is running, its timers
    // armed, but `container.start()` never finished — so `container.stop()` alone left it running.
    await pg.pool.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    await pg.pool.query(`
      CREATE FUNCTION public.eup10_fail_late_grant() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_query() ILIKE '%pgboss%'
           AND EXISTS (SELECT 1 FROM pgboss.queue
                        WHERE name <> 'dead-letter' AND left(name, 8) <> '__pgboss') THEN
          RAISE EXCEPTION 'tuple concurrently updated' USING ERRCODE = 'XX000';
        END IF;
      END $$;
      CREATE EVENT TRIGGER eup10_fail_late_grant ON ddl_command_end
        WHEN TAG IN ('GRANT', 'ALTER DEFAULT PRIVILEGES')
        EXECUTE FUNCTION public.eup10_fail_late_grant();
    `);
    const free = await holdPort();
    await free.close();
    try {
      const exit = await serve(envFor({ PORT: String(free.port) }));
      expectPromptExit(exit);
      expect(exit.stderr + exit.stdout).toContain("tuple concurrently updated");
      expect(exit.stderr + exit.stdout).toContain("server.start_failed");
    } finally {
      await pg.pool.query("DROP EVENT TRIGGER IF EXISTS eup10_fail_late_grant");
      await pg.pool.query("DROP FUNCTION IF EXISTS public.eup10_fail_late_grant()");
    }
  }, 120_000);

  it("exits non-zero when the port is taken, after the queue and its workers started", async () => {
    const taken = await holdPort();
    try {
      const exit = await serve(envFor({ PORT: String(taken.port) }));
      expectPromptExit(exit);
      expect(exit.stderr + exit.stdout).toContain("EADDRINUSE");
      // The listener's error went through the start-failure path (cleanup ran), not an
      // uncaught exception.
      expect(exit.stderr + exit.stdout).toContain("server.start_failed");
    } finally {
      await taken.close();
    }
  }, 120_000);

  it("with a low statement timeout, a held pg-boss lock fails the start naming the lock, not as a client timeout", async () => {
    // The container wires the grant's lock timeout to fit its pool's client-side bound
    // (DATABASE_STATEMENT_TIMEOUT_MS=2000 → 3 s). pg-boss is installed by the tests above, so its
    // own start takes no install lock; the grant waits for it, held here by another session.
    const holder = await pg.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `SELECT pg_advisory_xact_lock(('x' || encode(sha224((current_database() || '.pgboss.pgboss')::bytea), 'hex'))::bit(64)::bigint)`,
      );
      const config = loadConfig({ env: envFor({ DATABASE_STATEMENT_TIMEOUT_MS: "2000" }) });
      const t0 = Date.now();
      await expect(
        startServer({
          config,
          logger: createLogger({ level: "error" }),
          listenEnabled: false,
          migrate: false,
          announceSetup: false,
        }),
      ).rejects.toThrow(/waiting for a lock \(most likely pg-boss's/u);
      expect(Date.now() - t0).toBeLessThan(15_000);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  }, 120_000);
});
