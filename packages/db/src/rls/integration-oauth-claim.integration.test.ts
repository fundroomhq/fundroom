import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "../testing/postgres.js";

/*
 * `core.integration_oauth_ticket_claim` / `core.integration_oauth_state_claim` (0020, E3.6). The
 * OAuth ops routes arrive with no tenant and the host actor has no policy on
 * core.integration_oauth_state, so these SECURITY DEFINER functions are the only way in: knowing
 * the secret (its sha256) is the capability, each claim burns it, and only the host actor may call
 * them. Also pins the RLS arms of the other 0020 tables that the ops routes and the portal rely on.
 */
let db: TestPostgres;
const WS_A = "01920000-0000-7000-8000-0000000020a1";
const WS_B = "01920000-0000-7000-8000-0000000020b1";
const USER = "01920000-0000-7000-8000-000000002101";
const MEMBER = "01920000-0000-7000-8000-000000002111";

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult<Record<string, unknown>>>;

async function as<T>(ws: string | null, actorKind: string, fn: (q: Q) => Promise<T>): Promise<T> {
  const c = await db.pool.connect();
  const q: Q = (sql, params) => c.query(sql, params);
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE seedhost_app");
    if (ws) await c.query("SELECT set_config('app.workspace_id', $1, true)", [ws]);
    await c.query("SELECT set_config('app.actor_kind', $1, true)", [actorKind]);
    const out = await fn(q);
    await c.query("COMMIT");
    return out;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest();

async function begin(opts: { ticketTtl?: string } = {}) {
  const ticket = randomBytes(32);
  const row = await as(WS_A, "system", (q) =>
    q(
      `INSERT INTO core.integration_oauth_state
         (workspace_id, provider, membership_id, ticket_hash, ticket_expires_at, expires_at)
       VALUES ($1, 'xero', $2, $3, now() + $4::interval, now() + interval '10 minutes')
       RETURNING id`,
      [WS_A, MEMBER, sha(ticket), opts.ticketTtl ?? "2 minutes"],
    ),
  );
  return { ticket, id: row.rows[0]?.["id"] as string };
}

beforeAll(async () => {
  db = await startPostgres();
  await db.pool.query(
    "INSERT INTO core.workspace (id, slug, name) VALUES ($1, 'ia', 'A'), ($2, 'ib', 'B')",
    [WS_A, WS_B],
  );
  await db.pool.query(`INSERT INTO core."user" (id, display_name) VALUES ($1, 'Grace')`, [USER]);
  await db.pool.query(
    `INSERT INTO core.membership (id, workspace_id, user_id, kind, role, status, source)
     VALUES ($1, $2, $3, 'staff', 'admin', 'active', 'invite')`,
    [MEMBER, WS_A, USER],
  );
});
afterAll(async () => {
  await db?.stop();
});

describe("integration OAuth claim functions", () => {
  it("claims a ticket once, then the state once, as the host actor", async () => {
    const { ticket, id } = await begin();
    const claimed = await as(null, "host", (q) =>
      q("SELECT id, workspace_id FROM core.integration_oauth_ticket_claim($1)", [sha(ticket)]),
    );
    expect(claimed.rows).toEqual([{ id, workspace_id: WS_A }]);
    // A second claim of the same ticket finds nothing.
    const again = await as(null, "host", (q) =>
      q("SELECT id FROM core.integration_oauth_ticket_claim($1)", [sha(ticket)]),
    );
    expect(again.rows).toHaveLength(0);

    // The kernel writes the state hash in a system context of the returned workspace.
    const state = randomBytes(32);
    await as(WS_A, "system", (q) =>
      q("UPDATE core.integration_oauth_state SET state_hash = $2 WHERE id = $1", [id, sha(state)]),
    );
    const consumed = await as(null, "host", (q) =>
      q("SELECT id, consumed_at FROM core.integration_oauth_state_claim($1)", [sha(state)]),
    );
    expect(consumed.rows[0]?.["id"]).toBe(id);
    expect(consumed.rows[0]?.["consumed_at"]).toBeInstanceOf(Date);
    const replay = await as(null, "host", (q) =>
      q("SELECT id FROM core.integration_oauth_state_claim($1)", [sha(state)]),
    );
    expect(replay.rows).toHaveLength(0);
  });

  it("refuses an expired ticket", async () => {
    const { ticket } = await begin({ ticketTtl: "-1 second" });
    const r = await as(null, "host", (q) =>
      q("SELECT id FROM core.integration_oauth_ticket_claim($1)", [sha(ticket)]),
    );
    expect(r.rows).toHaveLength(0);
  });

  it("refuses a caller that is not the host actor", async () => {
    const { ticket } = await begin();
    await expect(
      as(WS_A, "staff", (q) =>
        q("SELECT id FROM core.integration_oauth_ticket_claim($1)", [sha(ticket)]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("gives the host no direct access to OAuth state rows", async () => {
    await begin();
    const r = await as(null, "host", (q) => q("SELECT id FROM core.integration_oauth_state"));
    expect(r.rows).toHaveLength(0);
  });
});

describe("0020 RLS arms", () => {
  it("lets the host read, never write, a connection; another tenant sees nothing", async () => {
    const inserted = await as(WS_A, "system", (q) =>
      q(
        `INSERT INTO core.integration_connection (workspace_id, provider, auth_kind, credentials_enc)
         VALUES ($1, 'calcom', 'secret', '\\x00') RETURNING id`,
        [WS_A],
      ),
    );
    const id = inserted.rows[0]?.["id"] as string;
    const host = await as(null, "host", (q) =>
      q("SELECT workspace_id FROM core.integration_connection WHERE id = $1", [id]),
    );
    expect(host.rows).toEqual([{ workspace_id: WS_A }]);
    const updated = await as(null, "host", (q) =>
      q("UPDATE core.integration_connection SET status = 'degraded' WHERE id = $1", [id]),
    );
    expect(updated.rowCount).toBe(0);
    const other = await as(WS_B, "staff", (q) =>
      q("SELECT id FROM core.integration_connection WHERE id = $1", [id]),
    );
    expect(other.rows).toHaveLength(0);
  });

  it("shows externals enabled booking links only", async () => {
    await as(WS_A, "staff", (q) =>
      q(
        `INSERT INTO core.booking_link (workspace_id, provider, url, label, enabled)
         VALUES ($1, 'calcom', 'https://cal.com/a', 'On', true),
                ($1, 'calcom', 'https://cal.com/b', 'Off', false)`,
        [WS_A],
      ),
    );
    const r = await as(WS_A, "external", (q) => q("SELECT label FROM core.booking_link"));
    expect(r.rows).toEqual([{ label: "On" }]);
  });
});
