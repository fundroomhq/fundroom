import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  coreMigrationSource,
  createDatabase,
  createWorkspace,
  type MigrationSource,
  runMigrations,
} from "@fundroom/db";
import { directoryMigrationSource } from "@fundroom/directory";
import { createModuleRegistry } from "@fundroom/module-kit";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "./demo/seed.js";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { startServer } from "./server.js";
import { esignTestConfig, freshSecrets } from "./test/esign-harness.js";

/*
 * E-UP-12: a logical dump of the product must restore as written.
 *
 * `pg_dump` writes every object with `search_path = ''` and schema-qualifies what it can — but
 * not the operator behind `IS DISTINCT FROM` (nor `NULLIF`, `IN (…)` lists and the like), which
 * it can only print bare. Data-room 0006's commit-time triggers compared two `ltree` columns that
 * way, so every restore (`pg_restore --exit-on-error`, the runbook's `psql -v ON_ERROR_STOP=1`)
 * stopped at `operator does not exist: public.ltree = public.ltree`. Data-room 0008 rewrites the
 * comparison as `::text IS DISTINCT FROM ::text`.
 *
 * This is the whole product's database as the server builds it (every compiled-in module's
 * migrations, pg-boss's schema, the demo seed, data-room rows) plus the separate directory
 * database. Each is dumped in custom and in plain format with the server's own `pg_dump`
 * (same major, inside the container) and restored into an empty database exactly as
 * `docs/runbooks/backup-and-restore.md` does. A restore that errors anywhere fails the test;
 * then the restored schema must equal the original's and every table must hold the same rows,
 * and the trigger must still fire on the restored copy. A pre-0008 dump restored past its errors
 * (no ON_ERROR_STOP) arrives without the two triggers; 0008 must then recreate them, not fail.
 */
const PG_IMAGE = process.env["FUNDROOM_TEST_PG_IMAGE"] ?? "postgres:18-alpine";
const SOURCE = "seedhost";
const DIRECTORY = "directory";

let pg: StartedTestContainer;
let urlFor: (db: string) => string;

async function sh(cmd: string[]): Promise<string> {
  const res = await pg.exec(cmd, { env: { PGUSER: "seedhost", PGPASSWORD: "seedhost" } });
  if (res.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} exited ${res.exitCode}:\n${res.output.slice(-4000)}`);
  }
  return res.stdout;
}

async function query<T>(db: string, text: string, values: unknown[] = []): Promise<T[]> {
  const conn = createDatabase({ connectionString: urlFor(db), poolMax: 1 });
  try {
    return (await conn.pool.query(text, values)).rows as T[];
  } finally {
    await conn.close();
  }
}

/**
 * Schema-only dump, minus PG 18's per-run `\restrict` key lines, which differ every time. A CHECK
 * is compared without its parentheses: `a BETWEEN x AND y AND b` is stored expanded, printed as
 * `((a >= x) AND (a <= y)) AND b`, and re-parsed on restore as one flat AND — the same
 * constraint, printed with one pair of parentheses fewer.
 */
const schemaOf = async (db: string) =>
  (await sh(["pg_dump", "--schema-only", "-d", db]))
    .split("\n")
    .filter((l) => !/^\\(un)?restrict /u.test(l))
    .map((l) => (/ CHECK \(/u.test(l) ? l.replaceAll(/[()]/gu, "") : l))
    .join("\n");

/** Exact row count of every ordinary table, keyed `schema.table`. */
async function rowCounts(db: string): Promise<Record<string, number>> {
  const rows = await query<{ t: string; n: number }>(
    db,
    `SELECT format('%I.%I', n.nspname, c.relname) AS t,
            (xpath('/row/c/text()',
               query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
                            false, true, '')))[1]::text::int AS n
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
      ORDER BY 1`,
  );
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

/** Dump `db` both ways and restore each into a new empty database; returns their names. */
async function dumpAndRestore(db: string): Promise<string[]> {
  await sh(["pg_dump", "-Fc", "-f", `/tmp/${db}.pgc`, "-d", db]);
  await sh(["pg_dump", "-Fp", "-f", `/tmp/${db}.sql`, "-d", db]);
  const custom = `${db}_custom`;
  const plain = `${db}_plain`;
  for (const target of [custom, plain]) await sh(["createdb", "-O", "seedhost", target]);
  await sh(["pg_restore", "--exit-on-error", "-d", custom, `/tmp/${db}.pgc`]);
  await sh(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", plain, "-f", `/tmp/${db}.sql`]);
  return [custom, plain];
}

/**
 * Data-room rows the 0006/0008 triggers watch, in the first workspace of `db`: a root, folders A
 * and B, a document created in A and moved to B (the move fires `document_location_acl`).
 */
async function seedDataRoom(db: string): Promise<void> {
  const [ws] = await query<{ id: string }>(db, "SELECT id FROM core.workspace LIMIT 1");
  const wsId = ws?.id as string;
  const label = () => `f${randomUUID().replaceAll("-", "")}`;
  const root = label();
  const [rootRow] = await query<{ id: string }>(
    db,
    "INSERT INTO dataroom.folder (workspace_id, name, path) VALUES ($1, 'Root', $2::ltree) RETURNING id",
    [wsId, root],
  );
  const [fa, fb] = await query<{ id: string; path: string }>(
    db,
    `INSERT INTO dataroom.folder (workspace_id, parent_id, name, path)
     VALUES ($1, $2, 'A', $3::ltree), ($1, $2, 'B', $4::ltree) RETURNING id, path::text`,
    [wsId, rootRow?.id, `${root}.${label()}`, `${root}.${label()}`],
  );
  await query(
    db,
    `INSERT INTO dataroom.document (workspace_id, folder_id, folder_path, title)
     VALUES ($1, $2, $3::ltree, 'Deck')`,
    [wsId, fa?.id, fa?.path],
  );
  await query(
    db,
    "UPDATE dataroom.document SET folder_id = $1, folder_path = $2::ltree WHERE workspace_id = $3",
    [fb?.id, fb?.path, wsId],
  );
}

/** Both location triggers fire on `db`: an unchanged path bumps nothing, a new path bumps once. */
async function expectLocationTriggersFire(db: string): Promise<void> {
  const [doc] = await query<{ id: string; ws: string; path: string }>(
    db,
    "SELECT id, workspace_id AS ws, folder_path::text AS path FROM dataroom.document LIMIT 1",
  );
  const version = async () =>
    Number(
      (
        await query<{ v: string }>(
          db,
          "SELECT acl_version AS v FROM core.workspace WHERE id = $1",
          [doc?.ws],
        )
      )[0]?.v,
    );
  const before = await version();
  await query(db, "UPDATE dataroom.document SET folder_path = folder_path WHERE id = $1", [
    doc?.id,
  ]);
  expect(await version(), db).toBe(before);
  await query(db, "UPDATE dataroom.document SET folder_path = $2::ltree WHERE id = $1", [
    doc?.id,
    `${doc?.path.split(".")[0]}`,
  ]);
  expect(await version(), db).toBe(before + 1);
  await query(db, "UPDATE dataroom.folder SET path = path WHERE name = 'A'");
  expect(await version(), db).toBe(before + 1);
  await query(
    db,
    "UPDATE dataroom.folder SET path = subpath(path, 0, 1) || 'moved'::ltree WHERE name = 'A'",
  );
  expect(await version(), db).toBe(before + 2);
}

const locationTriggers = async (db: string) =>
  (
    await query<{ tgname: string }>(
      db,
      `SELECT tgname FROM pg_trigger
        WHERE tgname IN ('document_location_acl', 'folder_location_acl') ORDER BY 1`,
    )
  ).map((r) => r.tgname);

/** Every migration source the server applies; `dataRoomUpTo` cuts data-room's off after that file. */
function productSources(dataRoomUpTo?: string): MigrationSource[] {
  const modules = createModuleRegistry(COMPILED_IN_MODULES).migrationSources;
  return [
    coreMigrationSource,
    ...modules.map((src) => {
      if (src.module !== "data-room" || dataRoomUpTo === undefined) return src;
      const from = typeof src.dir === "string" ? src.dir : fileURLToPath(src.dir);
      const dir = mkdtempSync(join(tmpdir(), "fundroom-data-room-migrations-"));
      for (const f of readdirSync(from).filter((f) => f.endsWith(".sql") && f <= dataRoomUpTo)) {
        copyFileSync(join(from, f), join(dir, f));
      }
      return { module: src.module, dir };
    }),
  ];
}

beforeAll(async () => {
  pg = await new GenericContainer(PG_IMAGE)
    .withEnvironment({
      POSTGRES_USER: "seedhost",
      POSTGRES_PASSWORD: "seedhost",
      POSTGRES_DB: SOURCE,
    })
    .withExposedPorts(5432)
    .withTmpFs({ "/var/lib/postgresql": "rw" })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/u, 2))
    .withStartupTimeout(120_000)
    .start();
  urlFor = (db) => `postgres://seedhost:seedhost@${pg.getHost()}:${pg.getMappedPort(5432)}/${db}`;

  // The product's database as a running install has it: every module migrated, pg-boss's
  // schema created by the queue, a seeded workspace.
  const running = await startServer({
    config: esignTestConfig(freshSecrets(urlFor(SOURCE))),
    logger: createLogger({ level: "error" }),
    listenEnabled: false,
    migrate: true,
  });
  try {
    await seedDemo(running.container, { investors: 2 });
  } finally {
    await running.stop();
  }

  await seedDataRoom(SOURCE);

  // The shared cell directory is its own database with its own migrations.
  await sh(["createdb", "-O", "seedhost", DIRECTORY]);
  const dir = createDatabase({ connectionString: urlFor(DIRECTORY), poolMax: 2 });
  try {
    await runMigrations(dir.pool, { sources: [directoryMigrationSource] });
  } finally {
    await dir.close();
  }
}, 300_000);

afterAll(async () => {
  await pg?.stop();
});

describe("a logical dump restores as written (E-UP-12)", () => {
  it("the product database: pg_restore --exit-on-error and psql ON_ERROR_STOP both succeed, losslessly", async () => {
    const restored = await dumpAndRestore(SOURCE);
    const schema = await schemaOf(SOURCE);
    const counts = await rowCounts(SOURCE);
    expect(counts["dataroom.document"]).toBe(1);
    expect(counts["core.workspace"]).toBeGreaterThan(0);
    expect(counts["core.schema_migration"]).toBeGreaterThan(0);
    for (const db of restored) {
      expect(await schemaOf(db), db).toBe(schema);
      expect(await rowCounts(db), db).toEqual(counts);
    }
  });

  it("the restored copy's location triggers still fire", async () => {
    for (const db of [`${SOURCE}_custom`, `${SOURCE}_plain`]) {
      expect(await locationTriggers(db), db).toEqual([
        "document_location_acl",
        "folder_location_acl",
      ]);
      await expectLocationTriggersFire(db);
    }
  });

  it("a pre-0008 dump restored past its errors loses both triggers; migrating puts them back", async () => {
    // A database migrated only up to data-room 0007, as every install before this fix.
    const legacy = "legacy";
    await sh(["createdb", "-O", "seedhost", legacy]);
    const conn = createDatabase({ connectionString: urlFor(legacy), poolMax: 2 });
    try {
      await runMigrations(conn.pool, { sources: productSources("0007_forensic.sql") });
      await createWorkspace(conn, { slug: "legacy", name: "Legacy" });
    } finally {
      await conn.close();
    }
    await seedDataRoom(legacy);
    expect(await locationTriggers(legacy)).toEqual([
      "document_location_acl",
      "folder_location_acl",
    ]);

    // Its dump, restored WITHOUT stopping on errors: everything but the two triggers arrives.
    await sh(["pg_dump", "-Fp", "-f", `/tmp/${legacy}.sql`, "-d", legacy]);
    const restored = `${legacy}_restored`;
    await sh(["createdb", "-O", "seedhost", restored]);
    const res = await pg.exec(["psql", "-X", "-q", "-d", restored, "-f", `/tmp/${legacy}.sql`], {
      env: { PGUSER: "seedhost", PGPASSWORD: "seedhost" },
    });
    expect(res.stderr).toContain("operator does not exist: public.ltree = public.ltree");
    expect(await locationTriggers(restored)).toEqual([]);

    // The next start migrates: 0008 alone is pending and recreates both triggers.
    const target = createDatabase({ connectionString: urlFor(restored), poolMax: 2 });
    try {
      const result = await runMigrations(target.pool, { sources: productSources() });
      expect(result.applied.map((a) => `${a.module}/${a.name}`)).toEqual([
        "data-room/0008_dump_safe_location_triggers",
      ]);
    } finally {
      await target.close();
    }
    expect(await locationTriggers(restored)).toEqual([
      "document_location_acl",
      "folder_location_acl",
    ]);
    await expectLocationTriggersFire(restored);
  });

  it("the directory database restores the same way", async () => {
    const restored = await dumpAndRestore(DIRECTORY);
    const schema = await schemaOf(DIRECTORY);
    const counts = await rowCounts(DIRECTORY);
    for (const db of restored) {
      expect(await schemaOf(db), db).toBe(schema);
      expect(await rowCounts(db), db).toEqual(counts);
    }
  });
});
