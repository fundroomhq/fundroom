// sql-hygiene-allow: the refusal tests deliberately pass `SET ROLE postgres` to the CLI, which must refuse it.
import { readFileSync } from "node:fs";
import { type AuditRecorder, createAuditService, verifyWorkspace } from "@fundroom/audit";
import {
  createDatabase,
  createWorkspace,
  type Database,
  hostRoleStatus,
  PLATFORM_WORKSPACE_ID,
  runBreakGlassStatement,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type BreakGlassDeps, breakGlassCommand, sha256Hex } from "./break-glass.js";
import { evidenceCommand } from "./evidence.js";

/*
 * Break-glass end to end against real Postgres 18 (E2.10): the 0015 role and session table, the
 * CLI's open → sql → close flow, the database-clock time box, read-only by default, the
 * single-statement and role-escape guards, the double audit trail (tenant chain + platform
 * chain) with a verifying tenant chain, owner notification (and fail-closed when nobody can be
 * told), the evidence listings, and the managed-Postgres path where the migrating user cannot
 * create a BYPASSRLS role.
 */
let pg: TestPostgres;
let db: Database;
let mailer: MemoryMailer;
let wsA: string;
let wsB: string;
let out: string[];
let err: string[];

const OWNER_A1 = "ada@a.example";
const OWNER_A2 = "grace@a.example";
const REVOKED_OWNER = "former@a.example";
const INVESTOR = "investor@a.example";

function deps(overrides: Partial<BreakGlassDeps> = {}): BreakGlassDeps {
  return {
    db,
    audit: createAuditService({ db }),
    mailer,
    osUser: "opsuser",
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    ...overrides,
  };
}

async function person(
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: string,
  status: string,
  locale: string | null = null,
): Promise<void> {
  const u = await pg.pool.query<{ id: string }>(
    `INSERT INTO core."user" (display_name, locale) VALUES ($1, $2) RETURNING id`,
    [email.split("@")[0], locale],
  );
  const userId = u.rows[0]?.id;
  await pg.pool.query(
    `INSERT INTO core.user_identity (user_id, type, identifier, verified_at, is_primary)
     VALUES ($1, 'email', $2, now(), true)`,
    [userId, email],
  );
  await pg.pool.query(
    `INSERT INTO core.membership (workspace_id, user_id, kind, role, status, source)
     VALUES ($1, $2, $3, $4, $5, 'test')`,
    [workspaceId, userId, kind, role, status],
  );
}

async function auditRows(workspaceId: string, prefix = "host.break_glass") {
  const r = await pg.pool.query<{
    action: string;
    meta: Record<string, unknown>;
    outcome: string;
    actor_kind: string;
  }>(
    `SELECT action, meta, outcome, actor_kind FROM audit.event
      WHERE workspace_id = $1 AND action LIKE $2 ORDER BY seq`,
    [workspaceId, `${prefix}%`],
  );
  return r.rows;
}

async function open(extra: string[] = []): Promise<string> {
  const code = await breakGlassCommand(
    [
      "open",
      "--workspace",
      "alpha",
      "--ticket",
      "OPS-1234",
      "--reason",
      "Customer reports missing documents after import",
      ...extra,
    ],
    deps(),
  );
  expect(code, err.join("\n")).toBe(0);
  const id = out.at(-1);
  if (id === undefined) throw new Error("no session id printed");
  return id;
}

async function runSql(sessionId: string, query: string, extra: string[] = []): Promise<number> {
  return breakGlassCommand(["sql", "--session", sessionId, "--query", query, ...extra], deps());
}

beforeAll(async () => {
  pg = await startPostgres();
  db = createDatabase({ connectionString: pg.connectionString, poolMax: 4 });
  wsA = (await createWorkspace(db, { slug: "alpha", name: "Alpha Capital" })).id;
  wsB = (await createWorkspace(db, { slug: "beta", name: "Beta Fund" })).id;
  await person(wsA, OWNER_A1, "staff", "owner", "active", "en-XA");
  await person(wsA, OWNER_A2, "staff", "owner", "dormant");
  await person(wsA, REVOKED_OWNER, "staff", "owner", "revoked");
  await person(wsA, INVESTOR, "external", "investor", "active");
  await pg.pool.query(
    "INSERT INTO core.module_enablement (workspace_id, module, enabled) VALUES ($1, 'updates', true), ($2, 'updates', true)",
    [wsA, wsB],
  );
}, 120_000);

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

beforeEach(() => {
  mailer = createMemoryMailer();
  out = [];
  err = [];
});

describe("migration 0015", () => {
  it("creates seedhost_host as NOLOGIN BYPASSRLS with seedhost_app's privileges, switchable by the migrator", async () => {
    const r = await pg.pool.query(
      `SELECT rolbypassrls, rolcanlogin, rolsuper, rolinherit,
              pg_has_role('seedhost_host', 'seedhost_app', 'USAGE') AS has_app
         FROM pg_roles WHERE rolname = 'seedhost_host'`,
    );
    expect(r.rows[0]).toEqual({
      rolbypassrls: true,
      rolcanlogin: false,
      rolsuper: false,
      rolinherit: true,
      has_app: true,
    });
    expect(await hostRoleStatus(pg.pool)).toEqual({ ok: true });
    // The app role itself still never bypasses RLS.
    const app = await pg.pool.query(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'seedhost_app'",
    );
    expect(app.rows[0]).toEqual({ rolbypassrls: false });
  });

  it("refuses rewrites, deletes and statements on a session outside its window", async () => {
    const s = await pg.pool.query<{ id: string }>(
      `INSERT INTO core.break_glass_session (workspace_id, ticket, reason, operator, os_user, opened_at, expires_at)
       VALUES ($1, 'OPS-OLD', 'an old investigation long closed', 'x', 'x', now() - interval '2 hours', now() - interval '90 minutes')
       RETURNING id`,
      [wsB],
    );
    const id = s.rows[0]?.id;
    await expect(
      pg.pool.query(
        "UPDATE core.break_glass_session SET statements = statements + 1 WHERE id = $1",
        [id],
      ),
    ).rejects.toThrow(/closed, expired or not yet active/u);
    await expect(
      pg.pool.query("UPDATE core.break_glass_session SET ticket = 'OPS-X' WHERE id = $1", [id]),
    ).rejects.toThrow(/immutable/u);
    // A window over one hour is refused by the CHECK.
    await expect(
      pg.pool.query(
        `INSERT INTO core.break_glass_session (workspace_id, ticket, reason, operator, os_user, expires_at)
         VALUES ($1, 'OPS-LONG', 'this window is far too long', 'x', 'x', now() + interval '61 minutes')`,
        [wsB],
      ),
    ).rejects.toThrow(/break_glass_session_window/u);
    // The app role has no DELETE.
    const c = await pg.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE seedhost_app");
      await c.query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_kind', 'system', true)",
        [wsB],
      );
      await expect(
        c.query("DELETE FROM core.break_glass_session WHERE id = $1", [id]),
      ).rejects.toThrow(/permission denied/u);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("fences the session log: owning workspace and host read, other tenants and externals do not", async () => {
    const count = async (settings: Record<string, string>) => {
      const c = await pg.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE seedhost_app");
        for (const [k, v] of Object.entries(settings))
          await c.query("SELECT set_config($1, $2, true)", [k, v]);
        const r = await c.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM core.break_glass_session",
        );
        return r.rows[0]?.n;
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    };
    expect(await count({ "app.workspace_id": wsB, "app.actor_kind": "staff" })).toBe(1);
    expect(await count({ "app.workspace_id": wsA, "app.actor_kind": "staff" })).toBe(0);
    expect(await count({ "app.workspace_id": wsB, "app.actor_kind": "external" })).toBe(0);
    expect(await count({ "app.actor_kind": "host" })).toBeGreaterThanOrEqual(1);
    expect(await count({})).toBe(0);
  });
});

describe("fundroom break-glass", () => {
  it("validates its input before touching anything", async () => {
    const base = ["open", "--workspace", "alpha", "--reason", "a long enough reason here"];
    expect(await breakGlassCommand([...base, "--ticket", "no spaces allowed"], deps())).toBe(2);
    expect(await breakGlassCommand([...base, "--ticket", "OPS-1", "--minutes", "61"], deps())).toBe(
      2,
    );
    expect(
      await breakGlassCommand(
        ["open", "--workspace", "alpha", "--ticket", "OPS-1", "--reason", "short"],
        deps(),
      ),
    ).toBe(2);
    expect(
      await breakGlassCommand(
        ["open", "--workspace", "nope", "--ticket", "OPS-1", "--reason", "a long enough reason"],
        deps(),
      ),
    ).toBe(1);
    expect(mailer.sent).toHaveLength(0);
  });

  it("opens a ticketed, time-boxed session, tells every owner and records it in both chains", async () => {
    const before = (await auditRows(wsB)).length;
    const id = await open(["--minutes", "30", "--operator", "Nora (on call)"]);
    const s = await pg.pool.query(
      `SELECT ticket, operator, os_user, statements, closed_at,
              round(extract(epoch FROM expires_at - opened_at))::int AS window_s
         FROM core.break_glass_session WHERE id = $1`,
      [id],
    );
    expect(s.rows[0]).toEqual({
      ticket: "OPS-1234",
      operator: "Nora (on call)",
      os_user: "opsuser",
      statements: 0,
      closed_at: null,
      window_s: 1800,
    });
    // Active and dormant owners; not the revoked owner, not the investor.
    expect(mailer.sent.map((m) => m.to).sort()).toEqual([OWNER_A1, OWNER_A2]);
    for (const m of mailer.sent) {
      expect(m.stream).toBe("transactional");
      expect(m.workspaceId).toBe(wsA);
      expect(m.text).toContain("OPS-1234");
      expect(m.template?.name).toBe("notification");
    }
    // The owner with a locale gets it in their language.
    expect(mailer.sent.find((m) => m.to === OWNER_A1)?.subject).toMatch(/^⟦/u);
    expect(mailer.sent.find((m) => m.to === OWNER_A2)?.subject).toBe(
      "Security notice: operator access to Alpha Capital",
    );

    const tenant = await auditRows(wsA);
    expect(tenant.map((r) => r.action)).toEqual(["host.break_glass", "host.break_glass_notified"]);
    expect(tenant[0]).toMatchObject({
      actor_kind: "host",
      meta: { ticket: "OPS-1234", sessionId: id, phase: "opened", operator: "Nora (on call)" },
    });
    expect(tenant[1]?.meta).toMatchObject({ recipients: 2, delivered: 2, failed: 0 });
    const platform = await auditRows(PLATFORM_WORKSPACE_ID);
    expect(platform.at(-1)).toMatchObject({
      action: "host.break_glass_notified",
      meta: { workspaceId: wsA },
    });
    expect(
      platform.some((r) => r.action === "host.break_glass" && r.meta["sessionId"] === id),
    ).toBe(true);
    // Nothing lands in another tenant's chain.
    expect((await auditRows(wsB)).length).toBe(before);
  });

  it("runs reads as seedhost_host (past RLS), audits hash-before and result-after, never the text in the tenant chain", async () => {
    const id = await open();
    out = [];
    const query =
      "SELECT workspace_id::text AS ws, current_user::text AS who FROM core.module_enablement ORDER BY 1";
    expect(await runSql(id, query), err.join("\n")).toBe(0);
    const result = JSON.parse(out.join("\n")) as {
      rows: { ws: string; who: string }[];
      rowCount: number;
    };
    // BYPASSRLS: both workspaces are visible. The session names who is told, not what is fenced.
    expect(result.rows.map((r) => r.ws).sort()).toEqual([wsA, wsB].sort());
    expect(result.rows.every((r) => r.who === "seedhost_host")).toBe(true);

    const tenant = (await auditRows(wsA)).filter((r) => r.meta["sessionId"] === id);
    expect(tenant.map((r) => r.action)).toEqual([
      "host.break_glass",
      "host.break_glass_notified",
      "host.break_glass_statement",
      "host.break_glass_result",
    ]);
    const sha = sha256Hex(query);
    expect(tenant[2]?.meta).toMatchObject({
      sha256: sha,
      verb: "select",
      write: false,
      statement: 1,
    });
    expect(tenant[3]).toMatchObject({
      outcome: "success",
      meta: { sha256: sha, rowCount: 2, command: "SELECT" },
    });
    expect(JSON.stringify(tenant)).not.toContain("module_enablement");
    const platform = (await auditRows(PLATFORM_WORKSPACE_ID)).filter(
      (r) => r.meta["sessionId"] === id,
    );
    expect(platform.find((r) => r.action === "host.break_glass_statement")?.meta).toMatchObject({
      sql: query,
      sha256: sha,
      workspaceId: wsA,
    });
    const v = await verifyWorkspace({ db }, wsA);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    const vp = await verifyWorkspace({ db }, PLATFORM_WORKSPACE_ID);
    expect(vp.ok, JSON.stringify(vp)).toBe(true);
  });

  it("is read-only unless --write, one statement at a time, and cannot switch roles", async () => {
    const id = await open();
    // A DML verb without --write, and anything Postgres will not PREPARE, is refused before
    // anything is recorded.
    const n0 = (await auditRows(wsA)).length;
    expect(await runSql(id, "UPDATE core.workspace SET name = 'Hijacked'")).toBe(2);
    expect(await runSql(id, "SET ROLE postgres")).toBe(2);
    expect(await runSql(id, "COMMIT")).toBe(2);
    // Two statements cannot ride in one (the extended protocol refuses it).
    expect(await runSql(id, "SELECT 1; SELECT 2")).toBe(2);
    expect((await auditRows(wsA)).length).toBe(n0);
    // DML hidden in a CTE gets past the keyword hint and hits READ ONLY.
    expect(
      await runSql(
        id,
        "WITH x AS (UPDATE core.workspace SET name = 'Hijacked' RETURNING id) SELECT * FROM x",
      ),
    ).toBe(1);
    expect(err.join("\n")).toMatch(/read-only transaction/u);
    // A role switch inside a query is refused by Postgres (security-definer frame).
    expect(await runSql(id, "SELECT set_config('role', 'seedhost_app', true)")).toBe(1);
    expect(err.join("\n")).toMatch(/cannot set parameter "role" within security-definer function/u);
    // A session-level change of the tenant context survives the function: caught, rolled back.
    expect(await runSql(id, `SELECT set_config('app.workspace_id', '${wsB}', false)`)).toBe(1);
    expect(err.join("\n")).toMatch(/escaped|changed the transaction/u);
    const names = await pg.pool.query("SELECT name FROM core.workspace ORDER BY slug");
    expect(names.rows.map((r) => r.name)).toEqual(["Alpha Capital", "Beta Fund"]);
    // Failures are recorded as failures.
    const results = (await auditRows(wsA)).filter(
      (r) => r.meta["sessionId"] === id && r.action === "host.break_glass_result",
    );
    expect(results.map((r) => r.outcome)).toEqual(["failure", "failure", "failure"]);
    expect(results.map((r) => r.meta["error"])).toEqual(["failed", "failed", "escaped"]);
  });

  it("returns rows as JSON with exact big integers, and counts past --max-rows", async () => {
    const id = await open();
    out = [];
    expect(
      await runSql(
        id,
        "SELECT g AS n, 9007199254740993::bigint AS big, 'x' AS s FROM generate_series(1, 5) g",
        ["--max-rows", "2"],
      ),
      err.join("\n"),
    ).toBe(0);
    const r = JSON.parse(out.join("\n")) as {
      command: string;
      rowCount: number;
      fields: string[];
      rows: Record<string, unknown>[];
      truncated: boolean;
    };
    expect(r).toMatchObject({ command: "SELECT", rowCount: 5, truncated: true });
    expect(r.fields).toEqual(["n", "big", "s"]);
    expect(r.rows).toEqual([
      { n: 1, big: "9007199254740993", s: "x" },
      { n: 2, big: "9007199254740993", s: "x" },
    ]);
  });

  it("--write commits, counts the write and tells the owners", async () => {
    const id = await open();
    mailer.clear();
    expect(
      await runSql(
        id,
        `UPDATE core.module_enablement SET enabled = false WHERE workspace_id = '${wsA}'`,
        ["--write"],
      ),
      err.join("\n"),
    ).toBe(0);
    const me = await pg.pool.query(
      "SELECT enabled FROM core.module_enablement WHERE workspace_id = $1",
      [wsA],
    );
    expect(me.rows).toEqual([{ enabled: false }]);
    const s = await pg.pool.query(
      "SELECT statements, writes FROM core.break_glass_session WHERE id = $1",
      [id],
    );
    expect(s.rows[0]).toEqual({ statements: 1, writes: 1 });
    expect(mailer.sent.map((m) => m.to).sort()).toEqual([OWNER_A1, OWNER_A2]);
    expect(mailer.sent.find((m) => m.to === OWNER_A2)?.text).toMatch(
      /UPDATE statement that affected 1 row\./u,
    );
    await pg.pool.query(
      "UPDATE core.module_enablement SET enabled = true WHERE workspace_id = $1",
      [wsA],
    );
  });

  it("refuses statements on an expired or closed session (database clock), and closes once", async () => {
    // Expired: a session whose window ended by the database's clock.
    const expired = await pg.pool.query<{ id: string }>(
      `INSERT INTO core.break_glass_session (workspace_id, ticket, reason, operator, os_user, opened_at, expires_at)
       VALUES ($1, 'OPS-EXP', 'window already over by the db clock', 'x', 'x', now() - interval '61 minutes', now() - interval '1 minute')
       RETURNING id`,
      [wsA],
    );
    const expiredId = expired.rows[0]?.id as string;
    expect(await runSql(expiredId, "SELECT 1")).toBe(1);
    expect(err.join("\n")).toMatch(/is expired/u);
    const e = await pg.pool.query("SELECT statements FROM core.break_glass_session WHERE id = $1", [
      expiredId,
    ]);
    expect(e.rows[0]).toEqual({ statements: 0 });

    const id = await open();
    expect(await breakGlassCommand(["close", "--session", id], deps())).toBe(0);
    expect(await runSql(id, "SELECT 1")).toBe(1);
    expect(await breakGlassCommand(["close", "--session", id], deps())).toBe(1);
    const closed = (await auditRows(wsA)).filter(
      (r) => r.meta["sessionId"] === id && r.action === "host.break_glass_closed",
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]?.meta).toMatchObject({ closeReason: "closed", statements: 0 });
  });

  it("fails closed when no owner can be told: the session is closed at once", async () => {
    const failing = createMemoryMailer();
    failing.failNext(10);
    const code = await breakGlassCommand(
      [
        "open",
        "--workspace",
        "alpha",
        "--ticket",
        "OPS-9",
        "--reason",
        "mail is down but we try anyway",
      ],
      deps({ mailer: failing }),
    );
    expect(code).toBe(1);
    const row = await pg.pool.query(
      "SELECT close_reason FROM core.break_glass_session WHERE ticket = 'OPS-9'",
    );
    expect(row.rows).toEqual([{ close_reason: "notification_failed" }]);
  });

  it("fails closed when seedhost_host has lost BYPASSRLS", async () => {
    await pg.pool.query("ALTER ROLE seedhost_host NOBYPASSRLS");
    try {
      const code = await breakGlassCommand(
        [
          "open",
          "--workspace",
          "alpha",
          "--ticket",
          "OPS-2",
          "--reason",
          "should never open at all",
        ],
        deps(),
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toMatch(/lacks BYPASSRLS/u);
    } finally {
      await pg.pool.query("ALTER ROLE seedhost_host BYPASSRLS");
    }
  });

  it("lists sessions", async () => {
    expect(await breakGlassCommand(["list", "--workspace", "alpha", "--json"], deps())).toBe(0);
    const rows = JSON.parse(out.join("\n")) as { workspaceId: string; state: string }[];
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => r.workspaceId === wsA)).toBe(true);
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(["open", "closed", "expired"]));
  });
});

describe("review R1: break-glass hardening", () => {
  it("BG-1: Postgres, not a lexer, decides — a DO hidden behind nested comments is refused unrecorded", async () => {
    const id = await open();
    const n0 = (await auditRows(wsA)).length;
    const attack =
      "/* /* */ SELECT */ DO $$ BEGIN EXECUTE 'CREATE TABLE core.pwned(x int)'; " +
      "EXECUTE 'ALTER TABLE core.break_glass_session DISABLE TRIGGER break_glass_session_guard'; END $$";
    expect(await runSql(id, attack, ["--write"])).toBe(2);
    expect(err.join("\n")).toMatch(/refused: break-glass runs exactly one SELECT/u);
    // Also when the lexer is fooled into seeing a query first.
    expect(await runSql(id, "/* /* */ */ SELECT 1 */ DO $$ BEGIN END $$", ["--write"])).toBe(2);
    expect((await auditRows(wsA)).length).toBe(n0);
    // The run re-checks in its own transaction (a caller that skipped the vet gets nowhere).
    await expect(
      runBreakGlassStatement(db.pool, {
        sessionId: id,
        workspaceId: wsA,
        sql: attack,
        write: true,
      }),
    ).rejects.toMatchObject({ code: "refused" });
    const pwned = await pg.pool.query("SELECT to_regclass('core.pwned') AS t");
    expect(pwned.rows[0]).toEqual({ t: null });
    const trg = await pg.pool.query(
      "SELECT tgenabled FROM pg_trigger WHERE tgname = 'break_glass_session_guard'",
    );
    expect(trg.rows[0]).toEqual({ tgenabled: "O" });
  });

  it("BG-2: a statement cannot leave seedhost_host and come back (superuser file read)", async () => {
    const id = await open();
    out = [];
    const attack =
      "SELECT set_config('role', current_setting('is_superuser') || '', true) AS a, " +
      "query_to_xml('select set_config(''role'', session_user::text, true), pg_read_file(''/etc/hostname'') f', true, false, '') AS b, " +
      "set_config('role', 'seedhost_host', true) AS c";
    expect(await runSql(id, attack)).toBe(1);
    expect(err.join("\n")).toMatch(/cannot set parameter "role" within security-definer function/u);
    const inner =
      "SELECT query_to_xml('select set_config(''role'', session_user::text, true)', true, false, '') AS x";
    expect(await runSql(id, inner)).toBe(1);
    expect(err.join("\n")).toMatch(/cannot set parameter "role" within security-definer function/u);
    expect(
      await runSql(id, "SELECT set_config('session_authorization', session_user::text, true)"),
    ).toBe(1);
    expect(err.join("\n")).toMatch(/cannot set parameter "session_authorization"/u);
    expect(out).toEqual([]);
    // seedhost_app (the application's role) cannot run the definer function at all.
    const c = await pg.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE seedhost_app");
      await expect(
        c.query("SELECT * FROM core.break_glass_exec('SELECT 1', true, 10)"),
      ).rejects.toThrow(/permission denied/u);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("BG-3: --write cannot forge or touch sessions or the audit chain; the app cannot backdate one", async () => {
    const id = await open();
    const before = await pg.pool.query("SELECT count(*)::int AS n FROM core.break_glass_session");
    const forge = `INSERT INTO core.break_glass_session (workspace_id, ticket, reason, operator, os_user, opened_at, expires_at, notified_at)
      VALUES ('${wsB}', 'OPS-FAKE', 'forged by a write statement', 'x', 'x', now() + interval '10 years', now() + interval '10 years 1 hour', now() + interval '10 years')`;
    expect(await runSql(id, forge, ["--write"])).toBe(1);
    expect(err.join("\n")).toMatch(/may not write core\.break_glass_session/u);
    expect(
      await runSql(id, `UPDATE core.break_glass_session SET statements = 0 WHERE id = '${id}'`, [
        "--write",
      ]),
    ).toBe(1);
    expect(
      await runSql(
        id,
        `INSERT INTO audit.event (workspace_id, action, actor_kind, outcome) VALUES ('${wsB}', 'auth.login', 'system', 'success')`,
        ["--write"],
      ),
    ).toBe(1);
    expect(err.join("\n")).toMatch(/may not write audit\.event/u);
    const after = await pg.pool.query("SELECT count(*)::int AS n FROM core.break_glass_session");
    expect(after.rows[0]).toEqual(before.rows[0]);
    // The app role (what the CLI itself uses) always gets a fresh, pending window from now().
    const c = await pg.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE seedhost_app");
      await c.query(
        "SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_kind', 'system', true)",
        [wsB],
      );
      await c.query("SAVEPOINT late");
      await expect(
        c.query(
          `INSERT INTO core.break_glass_session (workspace_id, ticket, reason, operator, os_user, opened_at, expires_at)
           VALUES ($1, 'OPS-LATE', 'a backdated or future window', 'x', 'x', now() + interval '10 years', now() + interval '10 years 1 hour')`,
          [wsB],
        ),
      ).rejects.toThrow(/break_glass_session_window/u);
      await c.query("ROLLBACK TO SAVEPOINT late");
      const ok = await c.query<{ fresh: boolean; notified_at: Date | null; statements: number }>(
        `INSERT INTO core.break_glass_session (workspace_id, ticket, reason, operator, os_user, opened_at, expires_at, notified_at, statements)
         VALUES ($1, 'OPS-NOW', 'a window that starts now', 'x', 'x', now() - interval '1 day', now() + interval '30 minutes', now(), 0)
         RETURNING opened_at = now() AS fresh, notified_at, statements`,
        [wsB],
      );
      expect(ok.rows[0]).toEqual({ fresh: true, notified_at: null, statements: 0 });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("BG-4: a session is pending — unusable — until it is recorded and the owners were told", async () => {
    const real = createAuditService({ db });
    const failing: AuditRecorder = {
      record: (tx, ctx, input) => real.record(tx, ctx, input),
      recordDetached: async (ctx, input) => {
        if (input.action === "host.break_glass") throw new Error("platform chain unavailable");
        return real.recordDetached(ctx, input);
      },
    };
    await expect(
      breakGlassCommand(
        [
          "open",
          "--workspace",
          "alpha",
          "--ticket",
          "OPS-CRASH",
          "--reason",
          "the process dies between open and notify",
        ],
        deps({ audit: failing }),
      ),
    ).rejects.toThrow(/platform chain unavailable/u);
    expect(mailer.sent).toHaveLength(0);
    const row = await pg.pool.query<{
      id: string;
      notified_at: Date | null;
      closed_at: Date | null;
    }>(
      "SELECT id, notified_at, closed_at FROM core.break_glass_session WHERE ticket = 'OPS-CRASH'",
    );
    expect(row.rows).toHaveLength(1);
    const pending = row.rows[0] as { id: string; notified_at: Date | null; closed_at: Date | null };
    expect(pending.notified_at).toBeNull();
    expect(pending.closed_at).toBeNull();
    expect(await runSql(pending.id, "SELECT 1")).toBe(1);
    expect(err.join("\n")).toMatch(/is pending; open a new one/u);
    const s = await pg.pool.query("SELECT statements FROM core.break_glass_session WHERE id = $1", [
      pending.id,
    ]);
    expect(s.rows[0]).toEqual({ statements: 0 });
    out = [];
    expect(await breakGlassCommand(["list", "--workspace", "alpha", "--json"], deps())).toBe(0);
    const listed = JSON.parse(out.join("\n")) as { id: string; state: string }[];
    expect(listed.find((r) => r.id === pending.id)?.state).toBe("pending");
  });

  it("BG-5: the owners hear about a committed write even when recording its result fails", async () => {
    const id = await open();
    mailer.clear();
    const real = createAuditService({ db });
    const failing: AuditRecorder = {
      record: (tx, ctx, input) => real.record(tx, ctx, input),
      recordDetached: async (ctx, input) => {
        if (input.action === "host.break_glass_result") throw new Error("audit write failed");
        return real.recordDetached(ctx, input);
      },
    };
    await expect(
      breakGlassCommand(
        [
          "sql",
          "--session",
          id,
          "--query",
          `UPDATE core.module_enablement SET enabled = enabled WHERE workspace_id = '${wsA}'`,
          "--write",
        ],
        deps({ audit: failing }),
      ),
    ).rejects.toThrow(/audit write failed/u);
    expect(mailer.sent.map((m) => m.to).sort()).toEqual([OWNER_A1, OWNER_A2]);
    const notified = (await auditRows(wsA)).filter(
      (r) =>
        r.meta["sessionId"] === id &&
        r.action === "host.break_glass_notified" &&
        r.meta["statement"] === 1,
    );
    expect(notified).toHaveLength(1);
  });
});

describe("fundroom evidence", () => {
  it("access-reviews: last review, digest, reviewer and overdue flag per workspace", async () => {
    const reviewer = await pg.pool.query<{ id: string }>(
      "SELECT m.id FROM core.membership m JOIN core.user_identity i ON i.user_id = m.user_id WHERE i.identifier = $1",
      [OWNER_A1],
    );
    await pg.pool.query(
      `INSERT INTO core.access_review (workspace_id, reviewer_membership_id, completed_at, member_count, flagged_count, report_sha256, report)
       VALUES ($1, $2, now() - interval '100 days', 4, 1, $3, '{}')`,
      [wsA, reviewer.rows[0]?.id, "a".repeat(64)],
    );
    const lines: string[] = [];
    const code = await evidenceCommand(["access-reviews", "--since", "2000-01-01"], {
      db,
      out: (l) => void lines.push(l),
    });
    expect(code).toBe(0);
    const doc = JSON.parse(lines.join("\n")) as {
      summary: { workspaces: number; overdue: number; neverReviewed: number; notOnPlan: number };
      workspaces: Record<string, unknown>[];
    };
    expect(doc.summary).toEqual({ workspaces: 2, overdue: 1, neverReviewed: 1, notOnPlan: 0 });
    const a = doc.workspaces.find((w) => w["slug"] === "alpha");
    expect(a).toMatchObject({
      overdue: true,
      lastReview: { reportSha256: "a".repeat(64), reviewerName: "ada", memberCount: 4 },
    });
    // 100 days since the review, due every 90: ten days overdue (± the container's clock skew).
    expect(a?.["daysOverdue"]).toBeGreaterThanOrEqual(9);
    expect(a?.["daysOverdue"]).toBeLessThanOrEqual(10);
    expect(a?.["reviewsInPeriod"]).toHaveLength(1);
    expect(doc.workspaces.find((w) => w["slug"] === "beta")).toMatchObject({
      overdue: false,
      neverReviewed: true,
      lastReview: null,
    });
  });

  it("operators: elevated roles, who may become seedhost_host, and break-glass sessions", async () => {
    const lines: string[] = [];
    expect(await evidenceCommand(["operators"], { db, out: (l) => void lines.push(l) })).toBe(0);
    const doc = JSON.parse(lines.join("\n")) as {
      breakGlass: { available: boolean };
      roles: { name: string; bypass_rls: boolean }[];
      memberships: { role: string; member: string; set_option: boolean; inherit_option: boolean }[];
      breakGlassSessions: { sessions: unknown[] };
    };
    expect(doc.breakGlass.available).toBe(true);
    expect(doc.roles.find((r) => r.name === "seedhost_host")?.bypass_rls).toBe(true);
    expect(doc.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "seedhost_host",
          member: "seedhost",
          set_option: true,
          inherit_option: false,
        }),
        expect.objectContaining({
          role: "seedhost_app",
          member: "seedhost_host",
          inherit_option: true,
        }),
      ]),
    );
    expect(doc.breakGlassSessions.sessions.length).toBeGreaterThan(0);
  });

  it("break-glass: sessions and totals since a date", async () => {
    const lines: string[] = [];
    expect(
      await evidenceCommand(["break-glass", "--since", "2000-01-01"], {
        db,
        out: (l) => void lines.push(l),
      }),
    ).toBe(0);
    const doc = JSON.parse(lines.join("\n")) as {
      summary: { sessions: number; writes: number; workspaces: number };
    };
    expect(doc.summary.writes).toBeGreaterThanOrEqual(1);
    expect(doc.summary.workspaces).toBe(2);
    expect(
      await evidenceCommand(["break-glass", "--since", "not-a-date"], { db, err: () => {} }),
    ).toBe(2);
  });
});

describe("managed Postgres: the migrating user cannot create a BYPASSRLS role", () => {
  let bare: TestPostgres;
  beforeAll(async () => {
    bare = await startPostgres({ sources: [] });
  }, 120_000);
  afterAll(async () => {
    await bare?.stop();
  });

  it("the role section only raises a NOTICE, and the CLI then refuses to open a session", async () => {
    const file = new URL(
      "../../../../packages/db/migrations/core/0015_break_glass.sql",
      import.meta.url,
    );
    const sections = readFileSync(file, "utf8").split("--> statement-breakpoint");
    const roleSection = sections.find((s) => s.includes("CREATE ROLE seedhost_host"));
    expect(roleSection).toBeDefined();
    // A managed-Postgres admin: may create roles, is neither superuser nor BYPASSRLS.
    await bare.pool.query("CREATE ROLE limited_admin NOLOGIN CREATEROLE NOSUPERUSER NOBYPASSRLS");
    const c = await bare.pool.connect();
    const notices: string[] = [];
    c.on("notice", (n) => notices.push(n.message ?? ""));
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE limited_admin");
      await c.query(roleSection as string);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    expect(notices.join("\n")).toMatch(/seedhost_host was not created/u);
    const r = await bare.pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'seedhost_host'");
    expect(r.rows).toHaveLength(0);

    const bareDb = createDatabase({ connectionString: bare.connectionString, poolMax: 2 });
    try {
      const status = await hostRoleStatus(bareDb.pool);
      expect(status.ok).toBe(false);
      expect(status.problem).toMatch(/seedhost_host is missing/u);
      const code = await breakGlassCommand(
        [
          "open",
          "--workspace",
          "alpha",
          "--ticket",
          "OPS-3",
          "--reason",
          "managed postgres cannot do this",
        ],
        deps({ db: bareDb }),
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toMatch(/break-glass is unavailable: role seedhost_host is missing/u);
    } finally {
      await bareDb.close();
    }
  });
});
