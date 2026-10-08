import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDirectoryDatabase, type TestDatabase } from "./test/directory-db.js";

/*
 * E3.11 foundation: core migration 0024 (`0024_data_residency`) and the directory schema
 * (`packages/directory/migrations/0001_directory.sql`).
 *
 *  - one database = one region: non-placeholder regions must agree; a declared region never
 *    changes (only the placeholder `default` may be replaced);
 *  - `core.workspace.data_region` is derived from the cell on insert and every update, cascades
 *    from a cell's region change, and a tenant actor cannot write it;
 *  - the `relocation` hold suspends with reason `relocation`, below `operator`;
 *  - the directory schema's uniqueness rules (live slug, one live move per entry).
 */
let pg: TestPostgres;
let dir: TestDatabase;

async function as(actor: string, q: string, params: unknown[] = []): Promise<void> {
  const client = await pg.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_kind', $1, true)", [actor]);
    await client.query(q, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("expected a failure");
}

async function workspace(slug: string) {
  const r = await pg.pool.query<{
    id: string;
    data_region: string | null;
    status: string;
    suspended_reason: string | null;
  }>("SELECT id::text, data_region, status, suspended_reason FROM core.workspace WHERE slug = $1", [
    slug,
  ]);
  return r.rows[0];
}

beforeAll(async () => {
  pg = await startPostgres();
  dir = await createDirectoryDatabase(pg);
}, 120_000);

afterAll(async () => {
  await dir?.close();
  await pg?.stop();
});

describe("0024 data residency: cells", () => {
  it("adds region_label and jurisdiction with their checks", async () => {
    const r = await pg.pool.query(
      "SELECT region, region_label, jurisdiction FROM core.cell WHERE id = 'default'",
    );
    expect(r.rows[0]).toEqual({ region: "default", region_label: "", jurisdiction: null });
    expect(
      (await errorOf(as("host", "UPDATE core.cell SET jurisdiction = 'mars' WHERE id = 'default'")))
        .code,
    ).toBe("23514");
  });

  it("derives data_region on insert, cascades a placeholder's adoption, and pins a declared region", async () => {
    await as("host", "INSERT INTO core.workspace (slug, name) VALUES ('res-a', 'A')");
    expect((await workspace("res-a"))?.data_region).toBe("default");
    // A direct write is overwritten by the derivation.
    await as("host", "UPDATE core.workspace SET data_region = 'us' WHERE slug = 'res-a'");
    expect((await workspace("res-a"))?.data_region).toBe("default");

    await as(
      "host",
      "UPDATE core.cell SET region = 'eu', region_label = 'Frankfurt', jurisdiction = 'eu' WHERE id = 'default'",
    );
    expect((await workspace("res-a"))?.data_region).toBe("eu");

    // Immutable once declared.
    const changed = await errorOf(
      as("host", "UPDATE core.cell SET region = 'us' WHERE id = 'default'"),
    );
    expect(changed.code).toBe("23514");
    expect(changed.message).toMatch(/never changes/u);
  });

  it("one database = one region (a placeholder cell is ignored)", async () => {
    const other = await errorOf(
      as("host", "INSERT INTO core.cell (id, region) VALUES ('us-1', 'us')"),
    );
    expect(other.code).toBe("23514");
    expect(other.message).toMatch(/one database = one region/u);
    await as("host", "INSERT INTO core.cell (id, region) VALUES ('eu-2', 'eu')");
    await as("host", "INSERT INTO core.cell (id, region) VALUES ('spare', 'default')");
    // A placeholder may adopt the region, never another one.
    expect(
      (await errorOf(as("host", "UPDATE core.cell SET region = 'us' WHERE id = 'spare'"))).code,
    ).toBe("23514");
    await as("host", "UPDATE core.cell SET region = 'eu' WHERE id = 'spare'");
  });

  it("a cell change re-derives data_region; a tenant actor cannot write it", async () => {
    await as("host", "INSERT INTO core.cell (id, region) VALUES ('later', 'default')");
    await as("host", "UPDATE core.workspace SET cell_id = 'later' WHERE slug = 'res-a'");
    expect((await workspace("res-a"))?.data_region).toBe("default");
    await as("host", "UPDATE core.workspace SET cell_id = 'eu-2' WHERE slug = 'res-a'");
    expect((await workspace("res-a"))?.data_region).toBe("eu");
    const tenant = await errorOf(
      as("staff", "UPDATE core.workspace SET data_region = 'us' WHERE slug = 'res-a'"),
    );
    expect(tenant.code).toBe("42501");
    // Other tenant writes still pass (the derivation leaves the value alone).
    await as("staff", "UPDATE core.workspace SET name = 'A2' WHERE slug = 'res-a'");
    expect((await workspace("res-a"))?.data_region).toBe("eu");
  });
});

describe("0024 data residency: the relocation hold", () => {
  it("suspends with reason relocation, ranked below operator and above billing", async () => {
    await as("host", "INSERT INTO core.workspace (slug, name) VALUES ('res-b', 'B')");
    await as(
      "host",
      "UPDATE core.workspace SET holds = '{relocation,billing}' WHERE slug = 'res-b'",
    );
    expect(await workspace("res-b")).toMatchObject({
      status: "suspended",
      suspended_reason: "relocation",
    });
    await as(
      "host",
      "UPDATE core.workspace SET holds = '{relocation,operator}' WHERE slug = 'res-b'",
    );
    expect((await workspace("res-b"))?.suspended_reason).toBe("operator");
    await as("host", "UPDATE core.workspace SET holds = '{}' WHERE slug = 'res-b'");
    expect((await workspace("res-b"))?.status).toBe("active");
  });
});

describe("directory schema (0001_directory)", () => {
  it("is journaled as module `directory` in the directory database", async () => {
    const r = await dir.db.pool.query(
      "SELECT module, name FROM core.schema_migration ORDER BY name",
    );
    expect(r.rows).toEqual([{ module: "directory", name: "0001_directory" }]);
    const t = await dir.db.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'directory' ORDER BY 1",
    );
    expect(t.rows.map((x) => x.table_name)).toEqual(["cell", "hostname", "move", "workspace"]);
  });

  it("a slug is unique among live entries; one live move per entry", async () => {
    const q = (s: string, p: unknown[] = []) => dir.db.pool.query(s, p);
    await q("INSERT INTO directory.cell (id, region, status) VALUES ('eu-1', 'eu', 'active')");
    await q("INSERT INTO directory.cell (id, region, status) VALUES ('us-1', 'us', 'active')");
    const e1 = "00000000-0000-7000-8000-000000000001";
    const e2 = "00000000-0000-7000-8000-000000000002";
    await q(
      "INSERT INTO directory.workspace (entry_id, workspace_id, slug, cell_id, state) VALUES ($1, $1, 'acme', 'eu-1', 'active')",
      [e1],
    );
    expect(
      (
        await errorOf(
          q(
            "INSERT INTO directory.workspace (entry_id, workspace_id, slug, cell_id) VALUES ($1, $1, 'acme', 'us-1')",
            [e2],
          ),
        )
      ).code,
    ).toBe("23505");
    await q("UPDATE directory.workspace SET state = 'deleted' WHERE entry_id = $1", [e1]);
    await q(
      "INSERT INTO directory.workspace (entry_id, workspace_id, slug, cell_id) VALUES ($1, $1, 'acme', 'us-1')",
      [e2],
    );
    const move = (id: string) =>
      q(
        `INSERT INTO directory.move (id, entry_id, source_workspace_id, slug, source_cell_id, target_cell_id, requested_by)
         VALUES ($1, $2, $2, 'acme', 'us-1', 'eu-1', 'op:1')`,
        [id, e2],
      );
    await move("00000000-0000-7000-8000-0000000000a1");
    expect((await errorOf(move("00000000-0000-7000-8000-0000000000a2"))).code).toBe("23505");
    await q("UPDATE directory.move SET state = 'cancelled'");
    await move("00000000-0000-7000-8000-0000000000a3");
  });
});
