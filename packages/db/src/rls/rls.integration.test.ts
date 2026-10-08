import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "../testing/postgres.js";
import { checkRlsCatalog, listTenantTables } from "./check.js";

/*
 * The RLS suite the plan requires (§6.4 "Testing", §7): the catalog check is clean after
 * migrating, and for every tenant table, as the application role with the context unset,
 * SELECT returns zero rows and INSERT is refused — even though the pool connects as a
 * superuser. Tables are auto-discovered so new module tables are covered without edits.
 */
let db: TestPostgres;
const WS_A = "01920000-0000-7000-8000-00000000000a";
const WS_B = "01920000-0000-7000-8000-00000000000b";
// Two share-link visitors in WS_A, admitted through the same link (E2.3).
const VISITOR_1 = "01920000-0000-7000-8000-000000000011";
const VISITOR_2 = "01920000-0000-7000-8000-000000000012";
const LINK_A = "01920000-0000-7000-8000-000000000021";
// One counted view session each, so `max_views` means "unique sessions" across restarts (E2.3).
const SESSION_1 = "01920000-0000-7000-8000-000000000031";
const SESSION_2 = "01920000-0000-7000-8000-000000000032";

beforeAll(async () => {
  db = await startPostgres();
  await db.pool.query(
    "INSERT INTO core.workspace (id, slug, name) VALUES ($1, 'a', 'A'), ($2, 'b', 'B')",
    [WS_A, WS_B],
  );
  await db.pool.query(
    "INSERT INTO core.module_enablement (workspace_id, module, enabled) VALUES ($1, 'updates', true), ($2, 'updates', true)",
    [WS_A, WS_B],
  );
  await db.pool.query(
    "INSERT INTO core.outbox (workspace_id, topic, payload) VALUES ($1, 't', '{}'), ($2, 't', '{}'), (NULL, 'host.t', '{}')",
    [WS_A, WS_B],
  );
  await db.pool.query(
    `INSERT INTO core.custom_domain (workspace_id, hostname, token, status)
     VALUES ($1, 'investors.a.example', 'AAAAAAAAAAAAAAAAAAAA', 'active'),
            ($2, 'investors.b.example', 'BBBBBBBBBBBBBBBBBBBB', 'dns_ok')`,
    [WS_A, WS_B],
  );
  await db.pool.query(
    `INSERT INTO core."user" (id, display_name) VALUES ($1, 'One'), ($2, 'Two')`,
    [VISITOR_1, VISITOR_2],
  );
  await db.pool.query(
    `INSERT INTO core.membership (id, workspace_id, user_id, kind, role, status, source)
     VALUES ($1, $3, $1, 'external', 'investor', 'active', $4),
            ($2, $3, $2, 'external', 'investor', 'active', $4)`,
    [VISITOR_1, VISITOR_2, WS_A, `link:${LINK_A}`],
  );
  await db.pool.query(
    `INSERT INTO core.share_link (id, workspace_id, label, token_hash, passcode_hash)
     VALUES ($1, $2, 'Q3 deck', sha256('token'::bytea), sha256('passcode'::bytea))`,
    [LINK_A, WS_A],
  );
  await db.pool.query(
    `INSERT INTO core.share_link_visit (workspace_id, link_id, membership_id)
     VALUES ($1, $2, $3), ($1, $2, $4)`,
    [WS_A, LINK_A, VISITOR_1, VISITOR_2],
  );
  await db.pool.query(
    `INSERT INTO core.share_link_view (workspace_id, link_id, membership_id, session_id)
     VALUES ($1, $2, $3, $5), ($1, $2, $4, $6)`,
    [WS_A, LINK_A, VISITOR_1, VISITOR_2, SESSION_1, SESSION_2],
  );
});
afterAll(async () => {
  await db?.stop();
});

/** Runs statements as seedhost_app inside one transaction with the given context, then rolls back. */
async function asApp<T>(
  settings: Record<string, string>,
  fn: (
    q: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  ) => Promise<T>,
): Promise<T> {
  const c = await db.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE seedhost_app");
    for (const [k, v] of Object.entries(settings))
      await c.query("SELECT set_config($1, $2, true)", [k, v]);
    return await fn((sql, params) => c.query(sql, params));
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}

describe("RLS catalog", () => {
  it("is clean after migrating the kernel", async () => {
    expect(await checkRlsCatalog(db.pool)).toEqual([]);
  });

  it("discovers the kernel tenant tables", async () => {
    const tables = await listTenantTables(db.pool);
    expect(tables).toEqual(
      expect.arrayContaining([
        { schema: "core", table: "module_enablement" },
        { schema: "core", table: "outbox" },
      ]),
    );
  });

  it("flags a new workspace_id table that was not fenced, and apply_tenant_fence fixes it", async () => {
    await db.pool.query(
      "CREATE SCHEMA tmp; CREATE TABLE tmp.t (workspace_id uuid NOT NULL, doc jsonb NOT NULL)",
    );
    try {
      const findings = await checkRlsCatalog(db.pool);
      expect(findings.map((f) => f.problem)).toEqual(
        expect.arrayContaining([
          "row level security not enabled",
          "row level security not forced",
          "missing tenant_fence policy",
          "seedhost_app lacks SELECT privilege",
          "jsonb column doc has no *_schema_version sibling",
        ]),
      );
      await db.pool.query("SELECT core.apply_tenant_fence()");
      await db.pool.query(
        "GRANT USAGE ON SCHEMA tmp TO seedhost_app; GRANT SELECT ON tmp.t TO seedhost_app; ALTER TABLE tmp.t ADD COLUMN doc_schema_version int NOT NULL DEFAULT 1",
      );
      expect(await checkRlsCatalog(db.pool)).toEqual([]);
    } finally {
      await db.pool.query("DROP SCHEMA tmp CASCADE");
    }
  });
});

/** The same `asApp` call three of the share-link assertions need: visitor 1's own context. */
function asVisitor1(
  fn: (
    q: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
  ) => Promise<{ rows: Record<string, unknown>[] }>,
): Promise<{ rows: Record<string, unknown>[] }> {
  return asApp(
    {
      "app.workspace_id": WS_A,
      "app.actor_kind": "external",
      "app.membership_id": VISITOR_1,
    },
    fn,
  );
}

describe("tenant fence behaviour (as seedhost_app)", () => {
  it("superuser pool sees everything, so the tests below only mean something with the role switch", async () => {
    const r = await db.pool.query("SELECT count(*)::int AS n FROM core.module_enablement");
    expect(r.rows[0]).toEqual({ n: 2 });
  });

  it("every tenant table returns zero rows with the context unset", async () => {
    const tables = await listTenantTables(db.pool);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) {
      const n = await asApp({}, async (q) => {
        const r = await q(`SELECT count(*)::int AS n FROM "${t.schema}"."${t.table}"`);
        return r.rows[0]?.["n"];
      });
      expect(n, `${t.schema}.${t.table}`).toBe(0);
    }
  });

  it("every tenant table returns zero rows for a foreign workspace and refuses foreign inserts", async () => {
    const unknown = "01920000-0000-7000-8000-0000000000ff";
    for (const t of await listTenantTables(db.pool)) {
      const n = await asApp(
        { "app.workspace_id": unknown, "app.actor_kind": "staff" },
        async (q) => {
          const r = await q(`SELECT count(*)::int AS n FROM "${t.schema}"."${t.table}"`);
          return r.rows[0]?.["n"];
        },
      );
      expect(n, `${t.schema}.${t.table}`).toBe(0);
    }
    await expect(
      asApp({ "app.workspace_id": WS_A, "app.actor_kind": "staff" }, (q) =>
        q("INSERT INTO core.module_enablement (workspace_id, module) VALUES ($1, 'metrics')", [
          WS_B,
        ]),
      ),
    ).rejects.toThrow(/row-level security policy/u);
  });

  it("a tenant context sees only its own rows", async () => {
    const rows = await asApp({ "app.workspace_id": WS_A, "app.actor_kind": "staff" }, async (q) => {
      const me = await q("SELECT workspace_id FROM core.module_enablement");
      const ws = await q("SELECT id FROM core.workspace");
      const ob = await q("SELECT workspace_id FROM core.outbox");
      return { me: me.rows, ws: ws.rows, ob: ob.rows };
    });
    expect(rows.me).toEqual([{ workspace_id: WS_A }]);
    expect(rows.ws).toEqual([{ id: WS_A }]);
    expect(rows.ob).toEqual([{ workspace_id: WS_A }]);
  });

  it("the host context sees all workspaces and all outbox rows but no tenant rows", async () => {
    const rows = await asApp({ "app.actor_kind": "host" }, async (q) => {
      const ws = await q("SELECT count(*)::int AS n FROM core.workspace");
      const ob = await q("SELECT count(*)::int AS n FROM core.outbox");
      const me = await q("SELECT count(*)::int AS n FROM core.module_enablement");
      return { ws: ws.rows[0], ob: ob.rows[0], me: me.rows[0] };
    });
    expect(rows).toEqual({ ws: { n: 2 }, ob: { n: 3 }, me: { n: 0 } });
  });

  /*
   * core.custom_domain carries a hand-written fence that admits the `host` actor as well as the
   * owning workspace, because the Caddy `ask` endpoint and the tenant classifier read it before
   * any workspace is known (E2.1). Both halves of that are asserted here: a tenant must not see
   * a rival's hostname, and host context must see every row — a fence that only got one half
   * right would either leak the customer list or break TLS issuance, and the generic loops above
   * only cover the first half.
   */
  it("custom domains are invisible across workspaces but fully visible to the host", async () => {
    const mine = await asApp(
      { "app.workspace_id": WS_A, "app.actor_kind": "staff" },
      async (q) => (await q("SELECT hostname::text AS h FROM core.custom_domain")).rows,
    );
    expect(mine).toEqual([{ h: "investors.a.example" }]);

    const asHost = await asApp(
      { "app.actor_kind": "host" },
      async (q) =>
        (await q("SELECT hostname::text AS h FROM core.custom_domain ORDER BY hostname")).rows,
    );
    expect(asHost).toEqual([{ h: "investors.a.example" }, { h: "investors.b.example" }]);

    // An external member of the workspace never sees a domain row: the token is a control proof
    // and the customer's hostname is not an investor's business.
    const asExternal = await asApp(
      { "app.workspace_id": WS_A, "app.actor_kind": "external" },
      async (q) => (await q("SELECT count(*)::int AS n FROM core.custom_domain")).rows[0],
    );
    expect(asExternal).toEqual({ n: 0 });

    // And the fence bites on writes, not just reads.
    await expect(
      asApp({ "app.workspace_id": WS_A, "app.actor_kind": "staff" }, (q) =>
        q(
          "INSERT INTO core.custom_domain (workspace_id, hostname, token) VALUES ($1, 'squat.b.example', 'CCCCCCCCCCCCCCCCCCCC')",
          [WS_B],
        ),
      ),
    ).rejects.toThrow(/row-level security policy/u);
  });

  /*
   * core.share_link and core.share_link_visit carry hand-written fences (E2.3). The generic
   * loops above only prove the *workspace* boundary; what matters here is the boundary *inside*
   * a workspace, because a share-link visitor is a full `external` member of it the moment they
   * are admitted. Three separate claims, each of which the migration's comments argue for:
   *
   *  1. an external member reads no core.share_link row at all — the row holds `token_hash`
   *     (the link itself) and `passcode_hash` (a low-entropy digest), and Postgres RLS is
   *     row-level, so "no row" is the only way to say "not those two columns";
   *  2. an external member reads its own core.share_link_visit row and nobody else's — another
   *     visitor's row is an attendance list for whoever else was sent the same link;
   *  3. an external member cannot *write* a core.share_link_visit row. That is the sharp one:
   *     the row is an authorization edge, so forging one would grant the forger every
   *     capability the link carries without the token, the passcode or the OTP.
   */
  it("a link visitor reads neither the link nor another visitor's visit, and can forge no binding", async () => {
    const asVisitor = { "app.workspace_id": WS_A, "app.actor_kind": "external" };

    // 1. The link row, digests and all, is invisible to the members it admitted.
    const links = await asVisitor1((q) => q("SELECT count(*)::int AS n FROM core.share_link"));
    expect(links.rows[0]).toEqual({ n: 0 });

    // 2. Own visit only. Staff and system see both; visitor 1 sees exactly one, and it is theirs.
    const staffVisits = await asApp({ "app.workspace_id": WS_A, "app.actor_kind": "staff" }, (q) =>
      q("SELECT count(*)::int AS n FROM core.share_link_visit"),
    );
    expect(staffVisits.rows[0]).toEqual({ n: 2 });
    const mine = await asVisitor1((q) => q("SELECT membership_id FROM core.share_link_visit"));
    expect(mine.rows).toEqual([{ membership_id: VISITOR_1 }]);

    // 3. No forged binding: neither for somebody else, nor for themselves.
    for (const membershipId of [VISITOR_1, VISITOR_2]) {
      await expect(
        asApp({ ...asVisitor, "app.membership_id": VISITOR_1 }, (q) =>
          q(
            "INSERT INTO core.share_link_visit (workspace_id, link_id, membership_id) VALUES ($1, $2, $3)",
            [WS_A, LINK_A, membershipId],
          ),
        ),
      ).rejects.toThrow(/row-level security policy/u);
    }
    // Nor may they lift their own binding's view counter or un-revoke it.
    const updated = await asVisitor1((q) =>
      q("UPDATE core.share_link_visit SET views = 99 WHERE membership_id = $1 RETURNING id", [
        VISITOR_1,
      ]),
    );
    expect(updated.rows).toEqual([]);
  });

  /*
   * core.share_link_view is the per-session ledger that makes a view cap mean "unique sessions"
   * rather than "unique sessions since this process started". Its fence follows core.share_link,
   * not core.share_link_visit: an external member matches **no** permissive policy, not even for
   * its own rows.
   *
   * That is the assertion worth holding, because the tempting alternative — own-row SELECT, by
   * analogy with the binding one table over — is wrong for a reason a reader has to be told. The
   * binding is a fact about the visitor; a view row is the meter on a control being applied to
   * them, and rows appearing one per session and never per request say exactly how the budget is
   * spent: a reload is free, a fresh login costs a view. That is the recipe for burning a shared
   * link's budget to lock out the rival investors it was also sent to.
   */
  it("a link visitor sees no counted-view row, not even its own, and cannot write one", async () => {
    // Staff (and the system actor noteView runs as) do see them.
    const staffViews = await asApp({ "app.workspace_id": WS_A, "app.actor_kind": "staff" }, (q) =>
      q("SELECT count(*)::int AS n FROM core.share_link_view"),
    );
    expect(staffViews.rows[0]).toEqual({ n: 2 });

    // The visitor sees none — including the row keyed to their own membership and session.
    const mine = await asVisitor1((q) =>
      q("SELECT count(*)::int AS n FROM core.share_link_view WHERE membership_id = $1", [
        VISITOR_1,
      ]),
    );
    expect(mine.rows[0]).toEqual({ n: 0 });

    // Nor may they claim a session themselves. Forging a claim is not an access grant the way a
    // forged share_link_visit row is — it is the reverse: it would let a visitor pre-claim the
    // sessions of everyone else on the link so that nobody's views ever counted, or (with a
    // DELETE) refund their own.
    await expect(
      asApp(
        { "app.workspace_id": WS_A, "app.actor_kind": "external", "app.membership_id": VISITOR_1 },
        (q) =>
          q(
            "INSERT INTO core.share_link_view (workspace_id, link_id, membership_id, session_id) VALUES ($1, $2, $3, $4)",
            [WS_A, LINK_A, VISITOR_1, "01920000-0000-7000-8000-000000000039"],
          ),
      ),
    ).rejects.toThrow(/row-level security policy/u);
    const deleted = await asVisitor1((q) =>
      q("DELETE FROM core.share_link_view WHERE membership_id = $1 RETURNING session_id", [
        VISITOR_1,
      ]),
    );
    expect(deleted.rows).toEqual([]);
  });

  /*
   * The control plane's tables (E3.10, 0023). The generic loops above cover the workspace
   * boundary; these are the boundaries INSIDE it: screenings and provider events are host-only
   * (a tenant's own staff never see them), a subscription and the usage rows are readable by the
   * tenant's staff but written only by host/system actors, the plan and cell catalogues are
   * readable by anyone and writable by the host alone, and who the operators are is host business.
   */
  it("control-plane tables: host-only rows, staff-readable billing, host-written catalogues", async () => {
    await db.pool.query("INSERT INTO core.plan (id, name) VALUES ('starter', 'Starter')");
    await db.pool.query(
      `INSERT INTO core.subscription (workspace_id, plan_id, provider, status)
       VALUES ($1, 'starter', 'manual', 'active')`,
      [WS_A],
    );
    await db.pool.query(
      `INSERT INTO core.sanctions_screening (workspace_id, subject_name, provider, list_version, outcome)
       VALUES ($1, 'Acme Ltd', 'ofac', 'ofac:abc:jw1', 'potential_match')`,
      [WS_A],
    );
    await db.pool.query(
      `INSERT INTO core.platform_operator (user_id, created_by) VALUES ($1, 'cli:test')`,
      [VISITOR_1],
    );
    const staffA = { "app.workspace_id": WS_A, "app.actor_kind": "staff" };
    const count = async (settings: Record<string, string>, table: string) =>
      asApp(
        settings,
        async (q) => (await q(`SELECT count(*)::int AS n FROM core.${table}`)).rows[0],
      );

    expect(await count(staffA, "sanctions_screening")).toEqual({ n: 0 });
    expect(await count({ ...staffA, "app.actor_kind": "system" }, "sanctions_screening")).toEqual({
      n: 0,
    });
    expect(await count({ "app.actor_kind": "host" }, "sanctions_screening")).toEqual({ n: 1 });
    expect(await count(staffA, "platform_operator")).toEqual({ n: 0 });
    expect(await count({ "app.actor_kind": "host" }, "platform_operator")).toEqual({ n: 1 });
    expect(await count(staffA, "subscription")).toEqual({ n: 1 });
    expect(
      await count({ "app.workspace_id": WS_A, "app.actor_kind": "external" }, "subscription"),
    ).toEqual({ n: 0 });
    expect(await count(staffA, "plan")).toEqual({ n: 1 });
    expect(await count(staffA, "cell")).toEqual({ n: 1 });

    // Staff can neither write their own subscription nor the catalogues.
    const updated = await asApp(staffA, (q) =>
      q("UPDATE core.subscription SET status = 'active' WHERE workspace_id = $1 RETURNING 1", [
        WS_A,
      ]),
    );
    expect(updated.rows).toEqual([]);
    await expect(
      asApp(staffA, (q) => q("INSERT INTO core.plan (id, name) VALUES ('free', 'Free')")),
    ).rejects.toThrow(/row-level security policy/u);
    const cellDeleted = await asApp(staffA, (q) => q("DELETE FROM core.cell RETURNING id"));
    expect(cellDeleted.rows).toEqual([]);

    // And no tenant actor lifts its own suspension or picks a plan: the guard trigger.
    await expect(
      asApp(staffA, (q) =>
        q("UPDATE core.workspace SET plan_id = 'starter' WHERE id = $1", [WS_A]),
      ),
    ).rejects.toThrow(/host or system actor only/u);
    const system = await asApp({ ...staffA, "app.actor_kind": "system" }, (q) =>
      q("UPDATE core.workspace SET plan_id = 'starter' WHERE id = $1 RETURNING plan_id", [WS_A]),
    );
    expect(system.rows).toEqual([{ plan_id: "starter" }]);
  });

  it("the app role cannot write the migration journal", async () => {
    await expect(
      asApp({ "app.actor_kind": "host" }, (q) =>
        q(
          "INSERT INTO core.schema_migration (module, name, checksum, duration_ms) VALUES ('x', 'y', 'z', 0)",
        ),
      ),
    ).rejects.toThrow(/permission denied/u);
  });
});
