import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { deriveWorkspaceStatus, setWorkspaceHold } from "@fundroom/control-plane";
import { createWorkspace, PLATFORM_WORKSPACE_ID, pgErrorCode } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";
import { CONFIG_META_NAME, type WebConfig } from "./web.js";

/*
 * The control plane's request-time guards (E3.10, foundation): the cell guard (421 `wrong_cell`),
 * the workspace status guard (a suspended or held workspace serves sign-in, the bootstrap and — to
 * billing holders — billing; staff get 423, everybody else 404), the status in the bootstrap and
 * the page config, `setWorkspaceHold` (independent flags, derived status, both audit chains; live
 * on the next request), the guard
 * trigger that keeps tenant actors off the control-plane columns, and the platform-operator
 * boundary (a plain 404 without a live operator's `op_sid` session; an operator session is no
 * session at all on tenant routes).
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const ids: Record<string, string> = {};

function fakeWebDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "fundroom-web-dist-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><meta property="csp-nonce" nonce="__CSP_NONCE__"><script type="module" src="/assets/app.js" nonce="__CSP_NONCE__"></script></head><body></body></html>`,
  );
  writeFileSync(join(dir, "assets", "app.js"), "");
  return dir;
}

async function request(
  host: string,
  path: string,
  init: RequestInit & { cookie?: string | undefined } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `https://${host}`);
  return running.app.request(`https://${host}${path}`, { ...init, headers });
}

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

async function page(host: string, path: string, cookie?: string): Promise<WebConfig> {
  const res = await running.app.request(`https://${host}${path}`, {
    headers: { host, ...(cookie ? { cookie } : {}) },
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  const m = new RegExp(`<meta name="${CONFIG_META_NAME}" content="([^"]*)">`, "u").exec(html);
  if (!m?.[1]) throw new Error(`no config meta: ${html.slice(0, 200)}`);
  return JSON.parse(
    m[1]
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">")
      .replace(/&amp;/gu, "&"),
  ) as WebConfig;
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");

/** A member of `slug` signed in with an email code on its tenant host. */
async function member(
  slug: string,
  email: string,
  kind: "staff" | "external",
  role: string,
): Promise<{ cookie: string; userId: string }> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, {
    workspaceId: ids[slug] as string,
    userId,
    kind,
    role: role as never,
    source: "test",
  });
  const host = `${slug}.${CANON}`;
  const since = mailer.sent.length;
  expect(
    (
      await request(host, "/api/v1/auth/otp/start", {
        method: "POST",
        body: JSON.stringify({ email }),
      })
    ).status,
  ).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request(host, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  return { cookie: cookiesOf(verify), userId };
}

async function setHold(
  slug: string,
  hold: "sanctions_review" | "operator" | "billing" | "sanctions" | "relocation",
  on: boolean,
) {
  const { db, audit, resolver } = running.container;
  const change = await db.withHost((tx) =>
    setWorkspaceHold(
      tx,
      {
        workspaceId: ids[slug] as string,
        hold,
        on,
        actor: { kind: "system", source: "cli" },
      },
      { audit, invalidate: () => resolver.invalidate() },
    ),
  );
  change.afterCommit();
  return change;
}

/** A statement as the host actor (the guard trigger admits only host/system writers). */
async function asHost(q: string, params: unknown[]): Promise<void> {
  const client = await pg.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_kind', 'host', true)");
    await client.query(q, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function stateOf(slug: string) {
  const r = await pg.pool.query<{
    status: string;
    suspended_reason: string | null;
    suspended_at: Date | null;
    holds: string[];
  }>("SELECT status, suspended_reason, suspended_at, holds FROM core.workspace WHERE id = $1", [
    ids[slug],
  ]);
  return r.rows[0];
}

let owner: { cookie: string; userId: string };
let viewer: { cookie: string; userId: string };
let investor: { cookie: string; userId: string };
let holdOwner: { cookie: string; userId: string };

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      CONTROL_PLANE: "on",
      ROLES: "api,web",
      WEB_DIST_PATH: fakeWebDist(),
      UPDATE_CHECK: "false",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  const db = running.container.db;
  for (const slug of ["acme", "susp", "hold", "far"]) {
    ids[slug] = (await createWorkspace(db, { slug, name: slug.toUpperCase() })).id;
  }
  // `far` lives on another cell (the control plane writes placement in host context).
  await db.withHost(async (tx) => {
    await tx.execute(
      "INSERT INTO core.cell (id, region, public_origin) VALUES ('eu-2', 'eu', 'https://eu-2.example.test')",
    );
    await tx.execute(`UPDATE core.workspace SET cell_id = 'eu-2' WHERE id = '${ids["far"]}'`);
  });
  owner = await member("susp", "owner@susp.test", "staff", "owner");
  viewer = await member("susp", "viewer@susp.test", "staff", "viewer");
  investor = await member("susp", "investor@susp.test", "external", "investor");
  holdOwner = await member("hold", "owner@hold.test", "staff", "owner");
  await setHold("susp", "billing", true);
  await setHold("hold", "sanctions_review", true);
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("cell guard", () => {
  it("answers 421 wrong_cell with the cell header for a workspace on another cell", async () => {
    const res = await request(`far.${CANON}`, "/api/v1/modules");
    expect(res.status).toBe(421);
    expect(res.headers.get("x-fundroom-cell")).toBe("eu-2");
    expect(await errorCode(res)).toBe("wrong_cell");
    // The canonical host has no workspace and is unaffected; so is a workspace on this cell.
    expect((await request(CANON, "/api/v1/modules")).status).toBe(200);
    expect((await request(`acme.${CANON}`, "/api/v1/modules")).status).toBe(200);
  });
});

describe("workspace status guard", () => {
  const susp = `susp.${CANON}`;

  it("still serves sign-in and the bootstrap, with the status for staff", async () => {
    expect(
      (
        await request(susp, "/api/v1/auth/otp/start", {
          method: "POST",
          body: JSON.stringify({ email: "nobody@susp.test" }),
        })
      ).status,
    ).toBe(200);
    const boot = await request(susp, "/api/v1/modules", { cookie: owner.cookie });
    expect(boot.status).toBe(200);
    expect(((await boot.json()) as { workspaceStatus: unknown }).workspaceStatus).toEqual({
      status: "suspended",
      reason: "billing",
    });
    expect((await request(susp, "/api/v1/me", { cookie: viewer.cookie })).status).toBe(200);
  });

  it("tells investors and anonymous callers only that the portal is unavailable", async () => {
    const boot = await request(susp, "/api/v1/modules", { cookie: investor.cookie });
    expect(((await boot.json()) as { workspaceStatus: unknown }).workspaceStatus).toEqual({
      status: "suspended",
      reason: null,
    });
    expect((await page(susp, "/", investor.cookie)).workspaceStatus).toEqual({
      status: "suspended",
      reason: null,
    });
    expect((await page(susp, "/admin", owner.cookie)).workspaceStatus).toEqual({
      status: "suspended",
      reason: "billing",
    });
  });

  it("answers 423 to staff and 404 to everybody else", async () => {
    const staff = await request(susp, "/api/v1/access/people", { cookie: owner.cookie });
    expect(staff.status).toBe(423);
    const body = (await staff.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      code: "workspace_unavailable",
      workspaceStatus: "suspended",
      reason: "billing",
    });
    const inv = await request(susp, "/api/v1/access/my", { cookie: investor.cookie });
    expect(inv.status).toBe(404);
    expect(await errorCode(inv)).toBe("not_found");
    // Anonymous: 404, not the 401 an active workspace would answer — nothing about the state.
    const anon = await request(susp, "/api/v1/access/people");
    expect(anon.status).toBe(404);
    // The same routes on an active workspace answer as usual.
    expect((await request(`acme.${CANON}`, "/api/v1/access/people")).status).toBe(401);
  });

  it("lets billing holders reach billing, and nobody else", async () => {
    const holder = await request(susp, "/api/v1/billing", { cookie: owner.cookie });
    expect(holder.status).not.toBe(423);
    expect(await errorCode(holder)).not.toBe("workspace_unavailable");
    expect((await request(susp, "/api/v1/billing", { cookie: viewer.cookie })).status).toBe(423);
    expect((await request(susp, "/api/v1/billing", { cookie: investor.cookie })).status).toBe(404);
  });

  it("holds a pending_review workspace the same way", async () => {
    const hold = `hold.${CANON}`;
    const boot = await request(hold, "/api/v1/modules", { cookie: holdOwner.cookie });
    expect(((await boot.json()) as { workspaceStatus: unknown }).workspaceStatus).toEqual({
      status: "pending_review",
      reason: null,
    });
    expect(
      (await request(hold, "/api/v1/access/people", { cookie: holdOwner.cookie })).status,
    ).toBe(423);
    // Anonymous page config: a hold reads as "unavailable", like a suspension.
    expect((await page(hold, "/")).workspaceStatus).toEqual({ status: "suspended", reason: null });
  });
});

describe("setWorkspaceHold", () => {
  it("keeps each owner's flag independent, audits both chains, and is live on the next request", async () => {
    await setHold("acme", "sanctions", true);
    // A billing flag under a sanctions suspension is recorded but changes nothing visible, and
    // clearing it (paid again) cannot lift the sanctions one.
    const billingOn = await setHold("acme", "billing", true);
    expect(billingOn).toMatchObject({
      changed: true,
      action: "workspace.suspend",
      after: { status: "suspended", reason: "sanctions", holds: ["billing", "sanctions"] },
    });
    expect((await setHold("acme", "billing", true)).changed).toBe(false);
    expect((await setHold("acme", "billing", false)).after).toEqual({
      status: "suspended",
      reason: "sanctions",
      holds: ["sanctions"],
    });
    expect((await request(`acme.${CANON}`, "/api/v1/access/people")).status).toBe(404);
    const lifted = await setHold("acme", "sanctions", false);
    expect(lifted).toMatchObject({ changed: true, action: "workspace.unsuspend" });
    expect(lifted.after).toEqual({ status: "active", reason: null, holds: [] });
    expect((await request(`acme.${CANON}`, "/api/v1/access/people")).status).toBe(401);

    // The chains are fenced (no context reads another's), so read them as the superuser.
    const all = await pg.pool.query<{
      ws: string;
      action: string;
      actor_kind: string;
      hold: string;
      on: string;
    }>(
      `SELECT workspace_id::text AS ws, action, actor_kind, meta->>'hold' AS hold, meta->>'on' AS on
         FROM audit.event
        WHERE action LIKE 'workspace.%' AND (workspace_id = $1 OR (workspace_id = $2 AND meta->>'workspaceId' = $1::text))
        ORDER BY occurred_at, seq`,
      [ids["acme"], PLATFORM_WORKSPACE_ID],
    );
    expect(
      all.rows.map(
        (r) =>
          `${r.ws === PLATFORM_WORKSPACE_ID ? "platform" : "tenant"} ${r.action} ${r.actor_kind} ${r.hold}:${r.on}`,
      ),
    ).toEqual([
      "tenant workspace.suspend system sanctions:true",
      "platform workspace.suspend host sanctions:true",
      "tenant workspace.suspend system billing:true",
      "platform workspace.suspend host billing:true",
      "tenant workspace.unsuspend system billing:false",
      "platform workspace.unsuspend host billing:false",
      "tenant workspace.unsuspend system sanctions:false",
      "platform workspace.unsuspend host sanctions:false",
    ]);
  });

  it("the trigger derives status, reason and suspended_at exactly like deriveWorkspaceStatus", async () => {
    const holds = ["sanctions_review", "operator", "billing", "sanctions", "relocation"] as const;
    // Every subset, written straight to the column (as the host actor). E3.11 added `relocation`.
    for (let mask = 0; mask < 32; mask += 1) {
      const set = holds.filter((_, i) => (mask >> i) & 1);
      await asHost("UPDATE core.workspace SET holds = $2 WHERE id = $1", [
        ids["acme"],
        [...set].reverse(),
      ]);
      const row = await stateOf("acme");
      const want = deriveWorkspaceStatus([...set]);
      expect({ status: row?.status, reason: row?.suspended_reason, holds: row?.holds }).toEqual({
        ...want,
        holds: [...set].sort(),
      });
      expect(row?.suspended_at === null).toBe(want.status !== "suspended");
    }
    // suspended_at is when it became suspended, kept while another reason keeps it suspended.
    await asHost("UPDATE core.workspace SET holds = '{}' WHERE id = $1", [ids["acme"]]);
    await asHost("UPDATE core.workspace SET holds = '{billing}' WHERE id = $1", [ids["acme"]]);
    const first = (await stateOf("acme"))?.suspended_at;
    await asHost("UPDATE core.workspace SET holds = '{operator}' WHERE id = $1", [ids["acme"]]);
    expect((await stateOf("acme"))?.suspended_at).toEqual(first);
    await asHost("UPDATE core.workspace SET holds = '{}' WHERE id = $1", [ids["acme"]]);
  });

  it("refuses a status written against the holds, and unknown or duplicate holds", async () => {
    const code = (q: string) =>
      asHost(q, [ids["acme"]]).then(
        () => "ok",
        (e: unknown) => pgErrorCode(e),
      );
    // Nobody can desync the mirror: a direct status write that disagrees with the holds fails.
    expect(await code("UPDATE core.workspace SET status = 'active' WHERE id = $1")).toBe("ok");
    expect(
      await code(
        "UPDATE core.workspace SET status = 'suspended', suspended_reason = 'operator', suspended_at = now() WHERE id = $1",
      ),
    ).toBe("23514");
    expect(await code("UPDATE core.workspace SET holds = '{nope}' WHERE id = $1")).toBe("23514");
    // Duplicates are folded by the trigger (stored once).
    expect(
      await code("UPDATE core.workspace SET holds = '{operator,operator}' WHERE id = $1"),
    ).toBe("ok");
    expect((await stateOf("acme"))?.holds).toEqual(["operator"]);
    await asHost("UPDATE core.workspace SET holds = '{}' WHERE id = $1", [ids["acme"]]);
    expect((await stateOf("acme"))?.status).toBe("active");
  });

  it("core.session.source_session_id links a derived session to its source, nulled on purge", async () => {
    const { auth } = running.container;
    const source = await auth.sessions.startSession({
      userId: owner.userId,
      population: "staff",
      context: "first_party",
      authLevel: 1,
    });
    const derived = await auth.sessions.startSession({
      userId: owner.userId,
      population: "staff",
      context: "first_party",
      authLevel: 1,
    });
    await pg.pool.query("UPDATE core.session SET source_session_id = $2 WHERE id = $1", [
      derived.session.sessionId,
      source.session.sessionId,
    ]);
    await pg.pool.query("DELETE FROM core.session WHERE id = $1", [source.session.sessionId]);
    const r = await pg.pool.query<{ source_session_id: string | null }>(
      "SELECT source_session_id FROM core.session WHERE id = $1",
      [derived.session.sessionId],
    );
    expect(r.rows).toEqual([{ source_session_id: null }]);
  });

  it("the guard trigger keeps tenant actors off the control-plane columns", async () => {
    const { db } = running.container;
    const own = await db
      .withTenant(
        {
          workspaceId: ids["susp"] as string,
          actorKind: "staff",
          membershipId: "01920000-0000-7000-8000-0000000000aa",
          userId: owner.userId,
        },
        (tx) => tx.execute(`UPDATE core.workspace SET holds = '{}' WHERE id = '${ids["susp"]}'`),
      )
      .then(
        () => "ok",
        (e: unknown) => pgErrorCode(e),
      );
    // A tenant context may still update its own row's other columns (settings, locale).
    expect(own).toBe("42501");
  });
});

describe("platform operator boundary", () => {
  it("is a plain 404 without a live operator session, whatever else the caller has", async () => {
    for (const cookie of [undefined, owner.cookie]) {
      const res = await request(CANON, "/api/v1/platform/me", { cookie });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
    // Minting needs a user session first.
    expect((await request(CANON, "/api/v1/platform/session", { method: "POST" })).status).toBe(401);
  });

  it("admits a live operator's op_sid session, and nothing else carries it", async () => {
    const { auth, db } = running.container;
    const minted = await auth.sessions.startSession({
      userId: owner.userId,
      population: "operator",
      context: "first_party",
      authLevel: 2,
    });
    const op = `__Host-op_sid=${minted.token}`;
    // Not an operator (yet): 404.
    expect((await request(CANON, "/api/v1/platform/me", { cookie: op })).status).toBe(404);
    await db.withHost((tx) =>
      tx.execute(
        `INSERT INTO core.platform_operator (user_id, created_by) VALUES ('${owner.userId}', 'cli:test')`,
      ),
    );
    // Past the boundary: the (unimplemented) handler answers, not the guard.
    const through = await request(CANON, "/api/v1/platform/me", { cookie: op });
    expect(through.status).not.toBe(404);
    // Only on the canonical host: a tenant host or a /w/<slug> path is a 404.
    expect((await request(`acme.${CANON}`, "/api/v1/platform/me", { cookie: op })).status).toBe(
      404,
    );
    expect((await request(CANON, "/w/acme/api/v1/platform/me", { cookie: op })).status).toBe(404);
    // An unsafe method from another origin is refused.
    const csrf = await running.app.request(`https://${CANON}/api/v1/platform/session`, {
      method: "DELETE",
      headers: {
        host: CANON,
        cookie: op,
        origin: "https://evil.example",
        accept: "application/json",
      },
    });
    expect(csrf.status).toBe(403);
    // The operator token in the tenant cookie is no session at all.
    expect(
      (await request(`acme.${CANON}`, "/api/v1/me", { cookie: `__Host-sid=${minted.token}` }))
        .status,
    ).toBe(401);
    // A revoke takes effect on the next request.
    await db.withHost((tx) =>
      tx.execute(
        `UPDATE core.platform_operator SET revoked_at = now() WHERE user_id = '${owner.userId}'`,
      ),
    );
    expect((await request(CANON, "/api/v1/platform/me", { cookie: op })).status).toBe(404);
  });
});
