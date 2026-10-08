import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { runMigrations } from "../migrate/runner.js";
import { coreMigrationSource, type MigrationSource } from "../migrate/sources.js";
import { endPool } from "../tenant/database.js";

/**
 * Testcontainers Postgres for integration tests (`*.integration.test.ts`).
 * Image defaults to Postgres 18; set FUNDROOM_TEST_PG_IMAGE=postgres:16-alpine to exercise
 * the uuidv7 shim path. The container user is a superuser, exactly like the default Compose
 * install, which is why withTenant() switches to seedhost_app for RLS to bite.
 */
export interface TestPostgresOptions {
  readonly image?: string;
  /** Migration sources to apply; default kernel only. Pass `[]` for an empty database. */
  readonly sources?: readonly MigrationSource[];
}

export interface TestPostgres {
  readonly connectionString: string;
  readonly pool: pg.Pool;
  readonly serverVersion: number;
  stop(): Promise<void>;
}

export async function startPostgres(options: TestPostgresOptions = {}): Promise<TestPostgres> {
  const image = options.image ?? process.env["FUNDROOM_TEST_PG_IMAGE"] ?? "postgres:18-alpine";
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(image)
    .withDatabase("seedhost_test")
    .withUsername("seedhost")
    .withPassword("seedhost")
    .start();
  const connectionString = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString, max: 8 });
  // An idle connection the container kills must not become an uncaught exception (see
  // `createDatabase`); the test that owns this pool asserts through its queries, not this event.
  pool.on("error", () => {});
  const v = await pool.query<{ v: number }>(
    "SELECT current_setting('server_version_num')::int AS v",
  );
  const serverVersion = Math.floor((v.rows[0]?.v ?? 0) / 10000);

  const sources = options.sources ?? [coreMigrationSource];
  if (sources.length > 0) await runMigrations(pool, { sources });

  return {
    connectionString,
    pool,
    serverVersion,
    async stop() {
      await endPool(pool);
      await container.stop();
    },
  };
}
