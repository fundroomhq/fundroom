import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "../testing/postgres.js";

/*
 * `core.erase_user_identity` / `core.user_other_live_memberships` (0012, E2.7). Both are
 * SECURITY DEFINER and reach across workspaces, so the guard is the whole point: a tenant
 * context of one workspace must not be able to erase — or even count the memberships of — a
 * user of another. Also proves the global/per-workspace decision and that the definer works
 * when its owner is subject to RLS (not only as the superuser the test container migrates as).
 */
let db: TestPostgres;
const WS_A = "01920000-0000-7000-8000-0000000000a1";
const WS_B = "01920000-0000-7000-8000-0000000000b1";
const WS_C = "01920000-0000-7000-8000-0000000000c1";
/** Member of A only. */
const U_ONLY_A = "01920000-0000-7000-8000-000000000101";
/** Member of A and (active) of B. */
const U_A_AND_B = "01920000-0000-7000-8000-000000000102";
/** Member of A, and a *revoked* member of C. */
const U_A_REVOKED_C = "01920000-0000-7000-8000-000000000103";
/** Member of B only. */
const U_ONLY_B = "01920000-0000-7000-8000-000000000104";
/** Member of A only; erased by a definer owned by an RLS-bound role. */
const U_RLS_OWNER = "01920000-0000-7000-8000-000000000105";

async function seedUser(id: string, email: string, memberships: [string, string][]) {
  await db.pool.query(
    `INSERT INTO core."user" (id, display_name, avatar_url) VALUES ($1, 'Ada Lovelace', 'https://x.example/a.png')`,
    [id],
  );
  await db.pool.query(
    `INSERT INTO core.user_identity (user_id, type, identifier, is_primary) VALUES ($1, 'email', $2, true)`,
    [id, email],
  );
  await db.pool.query(
    `INSERT INTO core.credential (user_id, kind, secret) VALUES ($1, 'password', 'hash')`,
    [id],
  );
  const dev = await db.pool.query<{ id: string }>(
    `INSERT INTO core.device (user_id, token_hash, user_agent) VALUES ($1, sha256($2::bytea), 'UA') RETURNING id`,
    [id, `dev-${id}`],
  );
  await db.pool.query(
    `INSERT INTO core.session (token_hash, user_id, device_id, population, context, auth_level, auth_time,
       session_version, ip, user_agent, idle_expires_at, absolute_expires_at)
     VALUES (sha256($2::bytea), $1, $3, 'external', 'first_party', 1, now(), 1, '203.0.113.9', 'Mozilla',
       now() + interval '1 day', now() + interval '7 days')`,
    [id, `sess-${id}`, dev.rows[0]?.id],
  );
  await db.pool.query(
    `INSERT INTO core.auth_challenge (kind, email, secret_hash, expires_at)
     VALUES ('magic_link', $1, sha256($2::bytea), now() + interval '1 hour')`,
    [email, `chal-${id}`],
  );
  for (const [ws, status] of memberships) {
    await db.pool.query(
      `INSERT INTO core.membership (workspace_id, user_id, kind, role, status, source)
       VALUES ($1, $2, 'external', 'investor', $3, 'invite')`,
      [ws, id, status],
    );
  }
}

beforeAll(async () => {
  db = await startPostgres();
  await db.pool.query(
    "INSERT INTO core.workspace (id, slug, name) VALUES ($1, 'a', 'A'), ($2, 'b', 'B'), ($3, 'c', 'C')",
    [WS_A, WS_B, WS_C],
  );
  await seedUser(U_ONLY_A, "only-a@example.com", [[WS_A, "active"]]);
  await seedUser(U_A_AND_B, "a-and-b@example.com", [
    [WS_A, "revoked"],
    [WS_B, "active"],
  ]);
  await seedUser(U_A_REVOKED_C, "a-revoked-c@example.com", [
    [WS_A, "active"],
    [WS_C, "revoked"],
  ]);
  await seedUser(U_ONLY_B, "only-b@example.com", [[WS_B, "active"]]);
  await seedUser(U_RLS_OWNER, "rls-owner@example.com", [[WS_A, "revoked"]]);
});
afterAll(async () => {
  await db?.stop();
});

type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult<Record<string, unknown>>>;

/** One transaction as seedhost_app with a tenant context; commits when `commit`, else rolls back. */
async function asTenant<T>(
  ws: string,
  actorKind: string,
  fn: (q: Q) => Promise<T>,
  options: { commit?: boolean; before?: (q: Q) => Promise<void> } = {},
): Promise<T> {
  const c = await db.pool.connect();
  const q: Q = (sql, params) => c.query(sql, params);
  try {
    await c.query("BEGIN");
    await options.before?.(q);
    await c.query("SET LOCAL ROLE seedhost_app");
    await c.query("SELECT set_config('app.workspace_id', $1, true)", [ws]);
    await c.query("SELECT set_config('app.actor_kind', $1, true)", [actorKind]);
    const out = await fn(q);
    await c.query(options.commit ? "COMMIT" : "ROLLBACK");
    return out;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}

async function identityOf(userId: string) {
  const user = await db.pool.query(
    `SELECT display_name, avatar_url, deleted_at FROM core."user" WHERE id = $1`,
    [userId],
  );
  const ident = await db.pool.query(
    "SELECT identifier::text AS identifier FROM core.user_identity WHERE user_id = $1",
    [userId],
  );
  const creds = await db.pool.query(
    "SELECT count(*)::int AS n FROM core.credential WHERE user_id = $1",
    [userId],
  );
  const devices = await db.pool.query(
    "SELECT count(*)::int AS n FROM core.device WHERE user_id = $1",
    [userId],
  );
  const sessions = await db.pool.query(
    "SELECT revoked_at, revoked_reason, ip, user_agent FROM core.session WHERE user_id = $1",
    [userId],
  );
  return {
    user: user.rows[0],
    identifiers: ident.rows.map((r) => r["identifier"] as string),
    credentials: creds.rows[0]?.["n"],
    devices: devices.rows[0]?.["n"],
    sessions: sessions.rows,
  };
}

const erase = (q: Q, user: string, ws: string) =>
  q("SELECT core.erase_user_identity($1, $2) AS global", [user, ws]).then(
    (r) => r.rows[0]?.["global"],
  );
const others = (q: Q, user: string, ws: string) =>
  q("SELECT core.user_other_live_memberships($1, $2) AS n", [user, ws]).then(
    (r) => r.rows[0]?.["n"],
  );

describe("identity erasure guard", () => {
  it("refuses a tenant context of another workspace, whatever workspace id it passes", async () => {
    // Workspace B names A's workspace id: the context is B, so the call is refused.
    await expect(asTenant(WS_B, "staff", (q) => erase(q, U_ONLY_A, WS_A))).rejects.toMatchObject({
      code: "42501",
    });
    // Workspace B names itself, but the user has no membership in B.
    await expect(asTenant(WS_B, "staff", (q) => erase(q, U_ONLY_A, WS_B))).rejects.toMatchObject({
      code: "42501",
    });
    await expect(asTenant(WS_B, "system", (q) => others(q, U_ONLY_A, WS_A))).rejects.toMatchObject({
      code: "42501",
    });
    expect((await identityOf(U_ONLY_A)).user?.["deleted_at"]).toBeNull();
  });

  it("refuses an external or host actor, and an unset context", async () => {
    await expect(asTenant(WS_A, "external", (q) => erase(q, U_ONLY_A, WS_A))).rejects.toMatchObject(
      { code: "42501" },
    );
    await expect(asTenant(WS_A, "host", (q) => erase(q, U_ONLY_A, WS_A))).rejects.toMatchObject({
      code: "42501",
    });
    await expect(asTenant("", "", (q) => erase(q, U_ONLY_A, WS_A))).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("is not executable by PUBLIC, and the internal guard not by the app role", async () => {
    const r = await db.pool.query<{ f: string; app: boolean; pub: boolean }>(
      `SELECT p.proname AS f,
              has_function_privilege('seedhost_app', p.oid, 'EXECUTE') AS app,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS pub
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'core' AND p.proname IN ('erase_user_identity', 'user_other_live_memberships', 'identity_erasure_guard')
       ORDER BY 1`,
    );
    expect(r.rows).toEqual([
      { f: "erase_user_identity", app: true, pub: false },
      { f: "identity_erasure_guard", app: false, pub: false },
      { f: "user_other_live_memberships", app: true, pub: false },
    ]);
  });
});

describe("user_other_live_memberships", () => {
  it("counts non-revoked memberships in other workspaces only", async () => {
    await asTenant(WS_A, "staff", async (q) => {
      expect(await others(q, U_ONLY_A, WS_A)).toBe(0);
      expect(await others(q, U_A_AND_B, WS_A)).toBe(1);
      // A revoked membership elsewhere is not a live relationship.
      expect(await others(q, U_A_REVOKED_C, WS_A)).toBe(0);
      // The caller's context is restored after the call.
      const ctx = await q(
        "SELECT current_setting('app.actor_kind', true) AS k, current_setting('app.user_id', true) AS u",
      );
      expect(ctx.rows[0]).toEqual({ k: "staff", u: expect.toSatisfy((v) => !v) });
    });
  });
});

describe("erase_user_identity", () => {
  it("does not erase a user who still belongs to another workspace", async () => {
    const global = await asTenant(WS_A, "system", (q) => erase(q, U_A_AND_B, WS_A), {
      commit: true,
    });
    expect(global).toBe(false);
    const after = await identityOf(U_A_AND_B);
    expect(after.user).toMatchObject({ display_name: "Ada Lovelace", deleted_at: null });
    expect(after.identifiers).toEqual(["a-and-b@example.com"]);
    expect(after.credentials).toBe(1);
    expect(after.devices).toBe(1);
    expect(after.sessions[0]).toMatchObject({ revoked_at: null, ip: "203.0.113.9" });
  });

  it("pseudonymises a user with no other live membership, idempotently", async () => {
    const global = await asTenant(
      WS_A,
      "staff",
      async (q) => {
        const g = await erase(q, U_ONLY_A, WS_A);
        const ctx = await q("SELECT current_setting('app.actor_kind', true) AS k");
        expect(ctx.rows[0]).toEqual({ k: "staff" });
        return g;
      },
      { commit: true },
    );
    expect(global).toBe(true);
    const after = await identityOf(U_ONLY_A);
    expect(after.user).toMatchObject({ display_name: "", avatar_url: null });
    expect(after.user?.["deleted_at"]).toBeInstanceOf(Date);
    expect(after.identifiers).toEqual([
      // Keyed on the identity row (32 hex), never on a hash of the old address: that collided
      // when an address was erased, re-registered and erased again (E2.7 review H1).
      expect.stringMatching(/^erased\+[0-9a-f]{32}@erased\.invalid$/u),
    ]);
    expect(after.credentials).toBe(0);
    expect(after.devices).toBe(0);
    expect(after.sessions).toEqual([
      { revoked_at: expect.any(Date), revoked_reason: "erased", ip: null, user_agent: "" },
    ]);
    const challenges = await db.pool.query(
      "SELECT count(*)::int AS n FROM core.auth_challenge WHERE email = 'only-a@example.com'",
    );
    expect(challenges.rows[0]).toEqual({ n: 0 });

    // A second call changes nothing.
    const again = await asTenant(WS_A, "staff", (q) => erase(q, U_ONLY_A, WS_A), { commit: true });
    expect(again).toBe(true);
    expect((await identityOf(U_ONLY_A)).identifiers).toEqual(after.identifiers);

    // Another workspace's user is untouched.
    expect((await identityOf(U_ONLY_B)).identifiers).toEqual(["only-b@example.com"]);
  });

  it("treats a revoked membership elsewhere as gone", async () => {
    const global = await asTenant(WS_A, "system", (q) => erase(q, U_A_REVOKED_C, WS_A));
    expect(global).toBe(true);
  });

  it("works when the definer's owner is subject to row-level security", async () => {
    // Re-own the functions to the (NOBYPASSRLS, non-owner) app role inside a rolled-back
    // transaction: every read and write in the body now passes through the global fences.
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("ALTER FUNCTION core.erase_user_identity(uuid, uuid) OWNER TO seedhost_app");
      await c.query(
        "ALTER FUNCTION core.user_other_live_memberships(uuid, uuid) OWNER TO seedhost_app",
      );
      await c.query("ALTER FUNCTION core.identity_erasure_guard(uuid, uuid) OWNER TO seedhost_app");
      await c.query("SET LOCAL ROLE seedhost_app");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [WS_A]);
      await c.query("SELECT set_config('app.actor_kind', 'staff', true)");
      // The other workspace's membership is only visible through the host switch.
      const n = await c.query("SELECT core.user_other_live_memberships($1, $2) AS n", [
        U_A_AND_B,
        WS_A,
      ]);
      expect(n.rows[0]).toEqual({ n: 1 });
      const kept = await c.query("SELECT core.erase_user_identity($1, $2) AS g", [U_A_AND_B, WS_A]);
      expect(kept.rows[0]).toEqual({ g: false });
      const r = await c.query("SELECT core.erase_user_identity($1, $2) AS g", [U_RLS_OWNER, WS_A]);
      expect(r.rows[0]).toEqual({ g: true });
      const ctx = await c.query("SELECT current_setting('app.actor_kind', true) AS k");
      expect(ctx.rows[0]).toEqual({ k: "staff" });
      await c.query("SET LOCAL ROLE seedhost");
      const u = await c.query(`SELECT display_name, deleted_at FROM core."user" WHERE id = $1`, [
        U_RLS_OWNER,
      ]);
      expect(u.rows[0]).toMatchObject({ display_name: "", deleted_at: expect.any(Date) });
      const cr = await c.query(
        "SELECT count(*)::int AS n FROM core.credential WHERE user_id = $1",
        [U_RLS_OWNER],
      );
      expect(cr.rows[0]).toEqual({ n: 0 });
      const s = await c.query("SELECT revoked_at FROM core.session WHERE user_id = $1", [
        U_RLS_OWNER,
      ]);
      expect(s.rows[0]?.["revoked_at"]).toBeInstanceOf(Date);
      // A workspace-less login challenge is only reachable through the host switch too.
      const ch = await c.query(
        "SELECT count(*)::int AS n FROM core.auth_challenge WHERE email = 'rls-owner@example.com'",
      );
      expect(ch.rows[0]).toEqual({ n: 0 });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});
