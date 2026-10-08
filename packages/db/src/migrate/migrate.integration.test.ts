import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "../testing/postgres.js";
import { MigrationPlanError } from "./plan.js";
import { MIGRATION_LOCK_KEYS, migrationStatus, runMigrations } from "./runner.js";
import { coreMigrationSource } from "./sources.js";

/*
 * Runner behaviour against a real Postgres: empty → migrated, idempotent re-run, checksum
 * drift, no-transaction files with CONCURRENTLY, advisory lock serialisation, and the
 * post-run fence. Also proves the uuidv7 shim on whichever image is under test
 * (FUNDROOM_TEST_PG_IMAGE=postgres:16-alpine exercises the plpgsql path).
 */
let db: TestPostgres;
beforeAll(async () => {
  db = await startPostgres({ sources: [] });
});
afterAll(async () => {
  await db?.stop();
});

async function tempModule(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "fundroom-mig-"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

async function resetDatabase() {
  await db.pool.query(
    "DROP SCHEMA IF EXISTS core CASCADE; DROP SCHEMA IF EXISTS audit CASCADE; DROP SCHEMA IF EXISTS testmod CASCADE;",
  );
}

/** Every kernel file, in order; new kernel migrations are appended here. */
const KERNEL = [
  "0000_core_kernel",
  "0001_identity",
  "0002_audit_events",
  "0003_workspace_key",
  "0004_access",
  "0005_access_path_inheritance",
  "0006_compliance",
  "0007_custom_domains",
  "0008_share_links",
  "0009_link_policy_target",
  "0010_mail_feedback",
  "0011_dsar",
  "0012_admin_surfaces",
  "0013_search_portability_i18n",
  "0014_import_reference_guard",
  "0015_break_glass",
  "0016_access_requests",
  "0017_delegates",
  "0018_api_keys_webhooks",
  "0019_esign",
  "0020_integrations",
  "0021_accreditation",
  "0022_sso_scim",
  "0023_control_plane",
  "0024_data_residency",
  "0025_ai_assist",
  "0026_evidence_authz",
  "0027_fundroom_identifiers",
];

describe("runMigrations", () => {
  it("migrates the kernel from an empty database and is idempotent", async () => {
    await resetDatabase();
    const lines: string[] = [];
    const first = await runMigrations(db.pool, {
      sources: [coreMigrationSource],
      log: (l) => lines.push(l),
    });
    expect(first.applied.map((a) => a.name)).toEqual(KERNEL);
    expect(lines.some((l) => l.startsWith("applied core/0000_core_kernel"))).toBe(true);

    const journal = await db.pool.query<{ module: string; name: string; checksum: string }>(
      "SELECT module, name, checksum FROM core.schema_migration ORDER BY 1, 2",
    );
    expect(journal.rows).toEqual(
      KERNEL.map((name) => ({
        module: "core",
        name,
        checksum: expect.stringMatching(/^sha256:/u),
      })),
    );

    const second = await runMigrations(db.pool, { sources: [coreMigrationSource] });
    expect(second.applied).toEqual([]);
    expect(second.plan.steps).toEqual([]);

    const status = await migrationStatus(db.pool, [coreMigrationSource]);
    expect(status.appliedCount).toBe(KERNEL.length);
    expect(status.steps).toEqual([]);
  });

  it("dry-run reports the plan without touching the journal", async () => {
    await resetDatabase();
    const r = await runMigrations(db.pool, { sources: [coreMigrationSource], dryRun: true });
    expect(r.plan.steps.map((s) => s.migration.name)).toEqual(KERNEL);
    const rows = await db.pool.query("SELECT count(*)::int AS n FROM core.schema_migration");
    expect(rows.rows[0]).toEqual({ n: 0 });
    const ws = await db.pool.query("SELECT to_regclass('core.workspace') AS r");
    expect(ws.rows[0]).toEqual({ r: null });
  });

  it("uuidv7() yields version-7, RFC-variant, time-ordered ids on this server", async () => {
    await resetDatabase();
    await runMigrations(db.pool, { sources: [coreMigrationSource] });
    const r = await db.pool.query<{ id: string }>(
      "SELECT core.uuidv7()::text AS id FROM generate_series(1, 50)",
    );
    const ids = r.rows.map((x) => x.id);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    }
    expect(new Set(ids).size).toBe(50);
    // The 48-bit millisecond prefix is now-ish and non-decreasing across the batch.
    const ms = ids.map((id) => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16));
    const now = Date.now();
    for (const t of ms) expect(Math.abs(t - now)).toBeLessThan(60_000);
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeGreaterThanOrEqual(ms[i - 1] as number);
    // On 18 the wrapper delegates to the native function; on 16/17 it is the plpgsql shim.
    const lang = await db.pool.query<{ l: string }>(
      "SELECT l.lanname AS l FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'core.uuidv7()'::regprocedure",
    );
    expect(lang.rows[0]?.l).toBe(db.serverVersion >= 18 ? "sql" : "plpgsql");
  });

  it("applies module migrations after the kernel, fences new tenant tables, and journals per module", async () => {
    await resetDatabase();
    const dir = await tempModule({
      "0001_init.sql": `
        CREATE SCHEMA testmod;
        GRANT USAGE ON SCHEMA testmod TO seedhost_app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA testmod GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
        CREATE TABLE testmod.thing (
          id uuid PRIMARY KEY DEFAULT core.uuidv7(),
          workspace_id uuid NOT NULL REFERENCES core.workspace (id),
          name text NOT NULL
        );
        CREATE POLICY thing_access ON testmod.thing FOR ALL USING (true) WITH CHECK (true);`,
    });
    const r = await runMigrations(db.pool, {
      sources: [coreMigrationSource, { module: "testmod", dir }],
    });
    expect(r.applied.map((a) => `${a.module}/${a.name}`)).toEqual([
      ...KERNEL.map((name) => `core/${name}`),
      "testmod/0001_init",
    ]);
    expect(r.fencedTables).toBe(1);
    const pol = await db.pool.query<{ permissive: string }>(
      "SELECT permissive FROM pg_policies WHERE schemaname = 'testmod' AND tablename = 'thing' AND policyname = 'tenant_fence'",
    );
    expect(pol.rows[0]?.permissive).toBe("RESTRICTIVE");
    const rls = await db.pool.query<{ e: boolean; f: boolean }>(
      "SELECT relrowsecurity AS e, relforcerowsecurity AS f FROM pg_class WHERE oid = 'testmod.thing'::regclass",
    );
    expect(rls.rows[0]).toEqual({ e: true, f: true });
  });

  it("refuses to run when an applied migration's checksum changed", async () => {
    await resetDatabase();
    const dir = await tempModule({ "0001_init.sql": "CREATE SCHEMA testmod;" });
    await runMigrations(db.pool, { sources: [coreMigrationSource, { module: "testmod", dir }] });
    await writeFile(join(dir, "0001_init.sql"), "CREATE SCHEMA testmod; -- edited");
    await expect(
      runMigrations(db.pool, { sources: [coreMigrationSource, { module: "testmod", dir }] }),
    ).rejects.toThrow(MigrationPlanError);
  });

  it("rolls a failing transactional migration back and does not journal it", async () => {
    await resetDatabase();
    const dir = await tempModule({
      "0001_init.sql":
        "CREATE SCHEMA testmod; CREATE TABLE testmod.a (id int);\n--> statement-breakpoint\nSELECT 1/0;",
    });
    await expect(
      runMigrations(db.pool, { sources: [coreMigrationSource, { module: "testmod", dir }] }),
    ).rejects.toThrow(/testmod\/0001_init chunk 2 failed: division by zero/u);
    const t = await db.pool.query("SELECT to_regclass('testmod.a') AS r");
    expect(t.rows[0]).toEqual({ r: null });
    const j = await db.pool.query(
      "SELECT count(*)::int AS n FROM core.schema_migration WHERE module = 'testmod'",
    );
    expect(j.rows[0]).toEqual({ n: 0 });
  });

  it("runs no-transaction files chunk by chunk so CONCURRENTLY works", async () => {
    await resetDatabase();
    const dir = await tempModule({
      "0001_init.sql":
        "CREATE SCHEMA testmod; CREATE TABLE testmod.a (workspace_id uuid NOT NULL, v int);",
      "0002_idx.sql":
        "-- seedhost: no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_v_idx ON testmod.a (workspace_id, v);\n" +
        "--> statement-breakpoint\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_v2_idx ON testmod.a (v);",
    });
    const r = await runMigrations(db.pool, {
      sources: [coreMigrationSource, { module: "testmod", dir }],
    });
    expect(r.applied.map((a) => a.name)).toEqual([...KERNEL, "0001_init", "0002_idx"]);
    const idx = await db.pool.query<{ indexname: string; indisvalid: boolean }>(
      `SELECT i.indexname, x.indisvalid FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname
       JOIN pg_index x ON x.indexrelid = c.oid WHERE i.schemaname = 'testmod' ORDER BY 1`,
    );
    expect(idx.rows).toEqual([
      { indexname: "a_v2_idx", indisvalid: true },
      { indexname: "a_v_idx", indisvalid: true },
    ]);
  });

  it("serialises concurrent runners with the advisory lock", async () => {
    await resetDatabase();
    // Hold the lock from a separate session; the runner must wait, then proceed.
    const holder = new pg.Client({ connectionString: db.connectionString });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1, $2)", [...MIGRATION_LOCK_KEYS]);
    let finished = false;
    const run = runMigrations(db.pool, {
      sources: [coreMigrationSource],
      waitForLockMs: 20_000,
    }).then((r) => {
      finished = true;
      return r;
    });
    await new Promise((res) => setTimeout(res, 1_500));
    expect(finished).toBe(false);
    await holder.query("SELECT pg_advisory_unlock($1, $2)", [...MIGRATION_LOCK_KEYS]);
    const r = await run;
    expect(r.applied).toHaveLength(KERNEL.length);
    await holder.end();

    // And a runner that cannot get the lock in time fails loudly rather than racing.
    const holder2 = new pg.Client({ connectionString: db.connectionString });
    await holder2.connect();
    await holder2.query("SELECT pg_advisory_lock($1, $2)", [...MIGRATION_LOCK_KEYS]);
    await expect(
      runMigrations(db.pool, { sources: [coreMigrationSource], waitForLockMs: 800 }),
    ).rejects.toThrow(/holds the lock/u);
    await holder2.end();
  });

  it("retries DDL that hits lock_timeout", async () => {
    await resetDatabase();
    await runMigrations(db.pool, { sources: [coreMigrationSource] });
    const dir = await tempModule({
      "0001_alter.sql": "ALTER TABLE core.workspace ADD COLUMN tmp_col int;",
    });
    // Another session holds an ACCESS SHARE lock in an open transaction: ALTER TABLE must wait.
    const blocker = new pg.Client({ connectionString: db.connectionString });
    await blocker.connect();
    await blocker.query("BEGIN; SELECT * FROM core.workspace;");
    const lines: string[] = [];
    const run = runMigrations(db.pool, {
      sources: [coreMigrationSource, { module: "testmod", dir }],
      lockTimeoutMs: 300,
      lockRetries: 10,
      log: (l) => lines.push(l),
    });
    await new Promise((res) => setTimeout(res, 1_200));
    await blocker.query("COMMIT");
    await blocker.end();
    const r = await run;
    expect(r.applied.map((a) => a.name)).toEqual(["0001_alter"]);
    expect(lines.some((l) => /lock timeout, retrying/u.test(l))).toBe(true);
  });
});
