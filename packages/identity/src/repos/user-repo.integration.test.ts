import { createDatabase, createWorkspace, type Database } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findLocalePreferences } from "./user-repo.js";

/*
 * `findLocalePreferences` runs on the CALLER's host transaction (sign-in mail, invites). A lookup
 * that fails inside Postgres aborts that transaction; swallowing the error without a savepoint
 * leaves every later statement failing with 25P02 ("current transaction is aborted"), so a
 * malformed address would break the caller's whole flow instead of just defaulting the language.
 */
let pg: TestPostgres;
let db: Database;
let workspaceId: string;

beforeAll(async () => {
  pg = await startPostgres();
  db = createDatabase({ connectionString: pg.connectionString, poolMax: 1 });
  const ws = await createWorkspace(db, { slug: "locale-ws", name: "Locale" });
  workspaceId = ws.id;
  await db.withHost((tx) =>
    tx.execute(sql`UPDATE core.workspace SET default_locale = 'en-XA' WHERE id = ${workspaceId}`),
  );
});

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

describe("findLocalePreferences on the caller's transaction", () => {
  it("a lookup Postgres rejects (NUL in the address) falls back and leaves the transaction usable", async () => {
    const result = await db.withHost(async (tx) => {
      const prefs = await findLocalePreferences(tx, {
        email: "bad\u0000@example.test",
        workspaceId,
      });
      // The caller keeps using its transaction afterwards.
      const after = await tx.execute(sql`SELECT 1 AS one`);
      return { prefs, one: (after.rows[0] as { one: number }).one };
    });
    expect(result).toEqual({ prefs: { user: null, workspace: "en-XA" }, one: 1 });
  });

  it("an unknown address reads no user preference and the workspace default", async () => {
    const prefs = await db.withHost((tx) =>
      findLocalePreferences(tx, { email: "nobody@example.test", workspaceId }),
    );
    expect(prefs).toEqual({ user: null, workspace: "en-XA" });
  });
});
