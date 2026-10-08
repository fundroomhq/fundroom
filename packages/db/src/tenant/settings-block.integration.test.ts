import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "../testing/postgres.js";
import { systemContext } from "./context.js";
import { createDatabase, type Database } from "./database.js";
import {
  createWorkspace,
  lockWorkspaceFacts,
  updateWorkspaceSettings,
  updateWorkspaceSettingsBlock,
} from "./workspace.js";

/*
 * `updateWorkspaceSettingsBlock` (A-3 R2 M1) against a real Postgres: one top-level key is set in
 * one statement and every other key stays as the row holds it — including what a concurrent
 * transaction committed after this writer's own copy was read. The route-level races are in
 * `apps/server/src/settings-block-writes.integration.test.ts`.
 */
let pg: TestPostgres;
let db: Database;

beforeAll(async () => {
  pg = await startPostgres();
  db = createDatabase({ connectionString: pg.connectionString, poolMax: 4 });
});
afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

const stored = async (id: string) =>
  (
    await pg.pool.query<{ settings: unknown }>(
      "SELECT settings FROM core.workspace WHERE id = $1",
      [id],
    )
  ).rows[0]?.settings;

describe("updateWorkspaceSettingsBlock", () => {
  it("replaces one block, keeps every other key, and returns the stored document", async () => {
    const { id } = await createWorkspace(db, { slug: "blk1", name: "Blk 1" });
    const ctx = systemContext(id);
    await db.withTenant(ctx, (tx) =>
      updateWorkspaceSettings(tx, id, {
        branding: { tagline: "old", accentColor: "#123456" },
        dataRoom: { qa: { enabled: false } },
        zzFuture: [1, 2],
      }),
    );
    const out = await db.withTenant(ctx, (tx) =>
      updateWorkspaceSettingsBlock(tx, id, "branding", { tagline: "new" }),
    );
    const expected = {
      branding: { tagline: "new" },
      dataRoom: { qa: { enabled: false } },
      zzFuture: [1, 2],
    };
    expect(out).toEqual(expected);
    expect(await stored(id)).toEqual(expected);
    // A new key, and values that are not objects.
    await db.withTenant(ctx, (tx) => updateWorkspaceSettingsBlock(tx, id, "flag", null));
    await db.withTenant(ctx, (tx) => updateWorkspaceSettingsBlock(tx, id, "n", 3));
    expect(await stored(id)).toEqual({ ...expected, flag: null, n: 3 });
  });

  it("treats stored settings that are not an object as {}", async () => {
    const { id } = await createWorkspace(db, { slug: "blk2", name: "Blk 2" });
    await pg.pool.query("UPDATE core.workspace SET settings = '[1]'::jsonb WHERE id = $1", [id]);
    await db.withTenant(systemContext(id), (tx) =>
      updateWorkspaceSettingsBlock(tx, id, "legal", { legalHold: true }),
    );
    expect(await stored(id)).toEqual({ legal: { legalHold: true } });
  });

  it("applies over a block another transaction committed while it waited for the row", async () => {
    const { id } = await createWorkspace(db, { slug: "blk3", name: "Blk 3" });
    const ctx = systemContext(id);
    await db.withTenant(ctx, (tx) =>
      updateWorkspaceSettings(tx, id, { dataRoom: { qa: { enabled: true } } }),
    );
    const holder = await pg.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        `UPDATE core.workspace SET settings = jsonb_set(settings, '{dataRoom,qa,enabled}', 'false') WHERE id = $1`,
        [id],
      );
      const write = db.withTenant(ctx, (tx) =>
        updateWorkspaceSettingsBlock(tx, id, "branding", { tagline: "racing" }),
      );
      // Wait until the block write is queued behind the holder's row lock.
      const deadline = Date.now() + 15_000;
      for (;;) {
        const { rows } = await pg.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted",
        );
        if ((rows[0]?.n ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("the block write never blocked");
        await new Promise((r) => setTimeout(r, 25));
      }
      await holder.query("COMMIT");
      await write;
    } finally {
      holder.release();
    }
    expect(await stored(id)).toEqual({
      dataRoom: { qa: { enabled: false } },
      branding: { tagline: "racing" },
    });
  });

  it("refuses an undefined value or an empty key, and an invisible workspace", async () => {
    const { id } = await createWorkspace(db, { slug: "blk4", name: "Blk 4" });
    const other = await createWorkspace(db, { slug: "blk5", name: "Blk 5" });
    const ctx = systemContext(id);
    await expect(
      db.withTenant(ctx, (tx) => updateWorkspaceSettingsBlock(tx, id, "x", undefined)),
    ).rejects.toThrow(/undefined/u);
    await expect(
      db.withTenant(ctx, (tx) => updateWorkspaceSettingsBlock(tx, id, "", {})),
    ).rejects.toThrow(/key/u);
    // RLS: another workspace's row is not visible under this workspace's context.
    await expect(
      db.withTenant(ctx, (tx) => updateWorkspaceSettingsBlock(tx, other.id, "x", {})),
    ).rejects.toThrow(/not visible/u);
    expect(await db.withTenant(ctx, (tx) => lockWorkspaceFacts(tx, id))).toMatchObject({
      settings: {},
    });
  });
});
