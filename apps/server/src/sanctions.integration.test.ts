import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { setWorkspaceHold } from "@fundroom/control-plane";
import { createWorkspace, PLATFORM_WORKSPACE_ID } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionUser } from "@fundroom/identity";
import type { JsonObject } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";

/*
 * Sanctions screening end to end (E3.10, contract §5.5), against a fake OFAC Sanctions List
 * Service (302 to a fake "S3", no-header CSVs with OFAC's quoting) and a fake yente:
 *
 *  - a new workspace is held (`pending_review`) the moment it is provisioned and a
 *    `sanctions.screen` job is queued in the same transaction; the job releases it on `clear`;
 *  - a hit keeps it held and lands in the operator queue; a decision needs a note; `cleared`
 *    releases, `confirmed` suspends (`sanctions`); a decided screening cannot be decided again;
 *  - the list download fails closed (a redirect to a host that is not allowed, an HTTP error):
 *    the workspace stays held, one `error` row, the job throws to be retried; the retry that
 *    works supersedes the error;
 *  - a list change (refresh) re-screens every live workspace not yet screened against it; a hit
 *    on a LIVE workspace is recorded and queued but does not take the portal down;
 *  - the operator API is invisible to everybody else; tenants never see a screening;
 *  - the opensanctions driver: yente down → held + error; back → cleared.
 *
 * The OFAC server runs on a ONE-connection pool: a second checkout while a transaction is open
 * hangs the suite instead of passing by luck.
 */

const BASE = "https://portal.example.test";
const CANON = "portal.example.test";

let pg: TestPostgres;
let ofacServer: RunningServer;
let yenteServer: RunningServer;
let fakeOfac: Server;
let fakeYente: Server;
let ofacPort = 0;
let dataDir = "";
/** Moves the OFAC server's clock (the adapter re-downloads a snapshot older than an hour). */
let offsetMs = 0;

// --- the fake OFAC SLS ---------------------------------------------------------------------------

/** The adapter refuses an SDN list shorter than 1000 rows (a truncated download): pad it. */
const FILLER = Array.from(
  { length: 1000 },
  (_, i) =>
    `${100000 + i},"ZZYZXQ ${i.toString(26).replace(/[0-9]/gu, (d) => "klmnopqrst"[Number(d)] ?? d)}",-0- ,"TEST",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `,
);
const SDN_ROWS = [
  ...FILLER,
  `36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `,
  `7160,"ROSNEFT OIL COMPANY",-0- ,"RUSSIA-EO14024",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"A ""quoted"" remark,
over two lines."`,
];
const files: Record<string, string> = {
  "SDN.CSV": `${SDN_ROWS.join("\r\n")}\r\n\u001a`,
  "ALT.CSV": `36,12,"aka","AERO-CARIBBEAN",-0- `,
  "CONS_PRIM.CSV": `17000,"PETROPARS LTD.",-0- ,"NS-MBS",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `,
  "CONS_ALT.CSV": `17000,1,"aka","PETRO PARS",-0- `,
};
/** `s3`: 302 to our fake S3 (allowed); `evil`: 302 to `localhost` (not allowed); `down`: 500. */
let ofacMode: "s3" | "evil" | "down" = "s3";
const userAgents: (string | undefined)[] = [];

function serveOfac(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://x");
  userAgents.push(req.headers["user-agent"]);
  if (!req.headers["user-agent"]) {
    res.writeHead(403).end();
    return;
  }
  const name = url.pathname.split("/").pop() ?? "";
  if (url.pathname.startsWith("/exports/")) {
    if (ofacMode === "down") {
      res.writeHead(500).end("maintenance");
      return;
    }
    const host = ofacMode === "evil" ? "localhost" : "127.0.0.1";
    res.writeHead(302, { location: `http://${host}:${ofacPort}/s3/${name}?X-Amz-Expires=3600` });
    res.end();
    return;
  }
  const body = files[name];
  if (!url.pathname.startsWith("/s3/") || body === undefined) {
    res.writeHead(404).end();
    return;
  }
  const bytes = Buffer.from(body, "latin1");
  res.writeHead(200, { "content-type": "text/csv", "content-length": String(bytes.byteLength) });
  res.end(bytes);
}

// --- the fake yente -------------------------------------------------------------------------------

let yenteDown = true;
const yenteBodies: JsonObject[] = [];

function serveYente(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://x");
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    if (yenteDown) {
      res.writeHead(503).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/catalog") {
      res.end(JSON.stringify({ datasets: [{ name: "sanctions", version: "20260927-a" }] }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/match/sanctions") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonObject;
      yenteBodies.push(body);
      const name = JSON.stringify(body);
      const results = name.includes("Evil")
        ? [{ id: "NK-evil", caption: "Evil Corp", score: 0.97, match: true, datasets: ["x"] }]
        : [];
      res.end(JSON.stringify({ responses: { q: { status: 200, results } } }));
      return;
    }
    res.writeHead(404).end();
  });
}

/** `::` is dual-stack: `localhost` reaches it whether it resolves to ::1 or 127.0.0.1. */
async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return (server.address() as AddressInfo).port;
}

// --- helpers --------------------------------------------------------------------------------------

function env(extra: Record<string, string>): Record<string, string> {
  return {
    APP_ENV: "test",
    LOG_LEVEL: "error",
    BASE_URL: BASE,
    DATABASE_URL: pg.connectionString,
    FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
    STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
    DATA_DIR: dataDir,
    TENANCY_MODE: "multi",
    CONTROL_PLANE: "on",
    ROLES: "api",
    UPDATE_CHECK: "false",
    // `localhost` is exempt from the private-address check too, so the OFAC client's refusal of a
    // redirect there is its own host allowlist at work, not the SSRF guard.
    OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: "127.0.0.1,localhost",
    ...extra,
  };
}

async function boot(extra: Record<string, string>, now?: () => Date): Promise<RunningServer> {
  return startServer({
    config: loadConfig({ env: env(extra) }),
    now,
    logger: createLogger({ level: "error" }),
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
}

/** What operator provisioning does: the row, then the hooks, in one host transaction. */
async function provision(
  server: RunningServer,
  slug: string,
  legalName: string,
  country: string | null = "DE",
): Promise<string> {
  const { db, sanctions } = server.container;
  const { id } = await createWorkspace(db, { slug, name: slug.toUpperCase() });
  await db.withHost(async (tx) => {
    await tx.execute(
      `UPDATE core.workspace SET legal_name = '${legalName}', country = ${country === null ? "NULL" : `'${country}'`} WHERE id = '${id}'`,
    );
    await sanctions.hooks.onWorkspaceCreated?.(tx, {
      id,
      slug,
      legalName,
      country,
      planId: null,
      ownerEmail: `owner@${slug}.test`,
    });
  });
  return id;
}

/** Runs one of the kernel's job handlers the way pg-boss would. */
async function runJob(server: RunningServer, name: string, data: JsonObject): Promise<void> {
  const def = server.container.sanctions.jobs.find((j) => j.name === name);
  if (def === undefined) throw new Error(`no job ${name}`);
  await def.handler({
    id: randomBytes(4).toString("hex"),
    name,
    data,
    signal: new AbortController().signal,
  });
}

async function statusOf(id: string): Promise<{ status: string; reason: string | null }> {
  const r = await pg.pool.query<{ status: string; reason: string | null }>(
    "SELECT status, suspended_reason AS reason FROM core.workspace WHERE id = $1",
    [id],
  );
  return r.rows[0] as { status: string; reason: string | null };
}

async function screenings(id: string) {
  const r = await pg.pool.query<{
    id: string;
    outcome: string;
    list_version: string;
    decision: string | null;
    matches: { listEntryId: string }[];
  }>(
    `SELECT id::text, outcome, list_version, decision, matches FROM core.sanctions_screening
      WHERE workspace_id = $1 ORDER BY created_at, id`,
    [id],
  );
  return r.rows;
}

async function queuedScreens(id: string): Promise<number> {
  const r = await pg.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pgboss.job
      WHERE name = 'sanctions.screen' AND data->>'workspaceId' = $1 AND state = 'created'`,
    [id],
  );
  return r.rows[0]?.n ?? 0;
}

async function clearQueuedScreens(): Promise<void> {
  await pg.pool.query(
    "DELETE FROM pgboss.job WHERE name = 'sanctions.screen' AND state = 'created'",
  );
}

async function request(
  server: RunningServer,
  path: string,
  init: RequestInit & { cookie?: string | undefined } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", CANON);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `https://${CANON}`);
  return server.app.request(`https://${CANON}${path}`, { ...init, headers });
}

async function operatorCookie(
  server: RunningServer,
  email: string,
): Promise<{ cookie: string; userId: string }> {
  const { auth, identityDeps, db } = server.container;
  const { userId } = await provisionUser(identityDeps, { email, displayName: "Operator" });
  const minted = await auth.sessions.startSession({
    userId,
    population: "operator",
    context: "first_party",
    authLevel: 2,
  });
  await db.withHost((tx) =>
    tx.execute(
      `INSERT INTO core.platform_operator (user_id, created_by) VALUES ('${userId}', 'cli:test') ON CONFLICT DO NOTHING`,
    ),
  );
  return { cookie: `__Host-op_sid=${minted.token}`, userId };
}

async function platformAudit(action: string, workspaceId: string) {
  const r = await pg.pool.query<{
    action: string;
    actor_kind: string;
    actor_user_id: string | null;
    meta: JsonObject;
  }>(
    `SELECT action, actor_kind, actor_user_id::text, meta FROM audit.event
      WHERE workspace_id = $1 AND action = $2 AND meta->>'workspaceId' = $3
      ORDER BY occurred_at, seq`,
    [PLATFORM_WORKSPACE_ID, action, workspaceId],
  );
  return r.rows;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  dataDir = mkdtempSync(join(tmpdir(), "fundroom-data-"));
  fakeOfac = createServer(serveOfac);
  ofacPort = await listen(fakeOfac, "::");
  fakeYente = createServer(serveYente);
  const yentePort = await listen(fakeYente);
  ofacServer = await boot(
    {
      SANCTIONS_DRIVER: "ofac",
      SANCTIONS_OFAC_URL: `http://127.0.0.1:${ofacPort}/exports/`,
      // One pool connection (see the header).
      DATABASE_POOL_MAX: "1",
    },
    () => new Date(Date.now() + offsetMs),
  );
  yenteServer = await boot({
    SANCTIONS_DRIVER: "opensanctions",
    SANCTIONS_OPENSANCTIONS_URL: `http://127.0.0.1:${yentePort}`,
  });
}, 240_000);

afterAll(async () => {
  await yenteServer?.stop();
  await ofacServer?.stop();
  await new Promise((r) => fakeOfac?.close(r));
  await new Promise((r) => fakeYente?.close(r));
  await pg?.stop();
});

// --- tests ----------------------------------------------------------------------------------------

describe("ofac: provisioning holds, the screen job decides", () => {
  it("fails closed while the list cannot be downloaded, then releases on a clear screen", async () => {
    ofacMode = "evil";
    const id = await provision(ofacServer, "first", "Seed Host Ventures GmbH");
    // Held from the moment it exists, with its screen queued in the same transaction.
    expect(await statusOf(id)).toEqual({ status: "pending_review", reason: null });
    expect(await queuedScreens(id)).toBe(1);
    await clearQueuedScreens();

    // A redirect to a host other than the allowed one: no list, no "clear". The job throws so
    // pg-boss retries it, and one error row goes to the operator queue.
    await expect(runJob(ofacServer, "sanctions.screen", { workspaceId: id })).rejects.toThrow();
    ofacMode = "down";
    await expect(runJob(ofacServer, "sanctions.screen", { workspaceId: id })).rejects.toThrow();
    expect(await statusOf(id)).toEqual({ status: "pending_review", reason: null });
    const errors = await screenings(id);
    expect(errors.map((s) => [s.outcome, s.list_version])).toEqual([["error", "ofac:unavailable"]]);

    ofacMode = "s3";
    await runJob(ofacServer, "sanctions.screen", { workspaceId: id });
    expect(await statusOf(id)).toEqual({ status: "active", reason: null });
    const rows = await screenings(id);
    expect(rows.map((s) => s.outcome)).toEqual(["error", "clear"]);
    expect(rows[1]?.list_version).toMatch(/^ofac:[0-9a-f]{12}:jw4$/u);
    // Every request carried a User-Agent (SLS answers 403 without one).
    expect(userAgents.every((ua) => typeof ua === "string" && ua.length > 0)).toBe(true);
    // The list is cached under DATA_DIR/sanctions.
    expect(readdirSync(join(dataDir, "sanctions", "ofac"))).toContain("current.json");

    // The tenant chain shows the hold and the release; the platform chain the screens.
    const tenant = await pg.pool.query<{ action: string }>(
      `SELECT action FROM audit.event WHERE workspace_id = $1 AND action LIKE 'workspace.%' ORDER BY seq`,
      [id],
    );
    expect(tenant.rows.map((r) => r.action)).toEqual(["workspace.hold", "workspace.release"]);
    const screens = await platformAudit("sanctions.screen", id);
    expect(screens.map((a) => [a.meta["outcome"], a.actor_kind])).toEqual([
      ["error", "system"],
      ["clear", "system"],
    ]);
    // Nothing about the screening on the tenant's own chain.
    const leak = await pg.pool.query(
      "SELECT 1 FROM audit.event WHERE workspace_id = $1 AND action LIKE 'sanctions.%'",
      [id],
    );
    expect(leak.rowCount).toBe(0);
  });

  it("keeps a hit held and puts it in the operator queue", async () => {
    const id = await provision(ofacServer, "hit", "Aero Caribbean Airlines S.A.", "CU");
    await runJob(ofacServer, "sanctions.screen", { workspaceId: id });
    expect(await statusOf(id)).toEqual({ status: "pending_review", reason: null });
    const [row] = await screenings(id);
    expect(row?.outcome).toBe("potential_match");
    expect(row?.matches.map((m) => m.listEntryId)).toEqual(["sdn:36"]);
  });

  it("holds a name with nothing to screen as an error, without retrying it (R3-L8)", async () => {
    const id = await provision(ofacServer, "blank", "--- !!!");
    const before = userAgents.length;
    // Recorded, not thrown: no retry can make "--- !!!" screenable.
    await runJob(ofacServer, "sanctions.screen", { workspaceId: id });
    expect(userAgents.length).toBe(before);
    expect(await statusOf(id)).toEqual({ status: "pending_review", reason: null });
    const rows = await screenings(id);
    expect(rows.map((r) => [r.outcome, r.list_version])).toEqual([
      ["error", "ofac:unscreenable:jw4"],
    ]);
  });

  it("tenant staff cannot read screenings at all (host-only table)", async () => {
    const [hit] = await pg.pool
      .query<{ id: string }>("SELECT id FROM core.workspace WHERE slug = 'hit'")
      .then((r) => r.rows);
    const seen = await ofacServer.container.db.withTenant(
      { workspaceId: hit?.id as string, actorKind: "system" },
      (tx) => tx.execute("SELECT count(*)::int AS n FROM core.sanctions_screening"),
    );
    expect((seen.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("ofac: operator review", () => {
  let op: { cookie: string; userId: string };
  let hitId = "";
  let screeningId = "";

  beforeAll(async () => {
    op = await operatorCookie(ofacServer, "operator@platform.test");
    hitId = (
      await pg.pool.query<{ id: string }>("SELECT id FROM core.workspace WHERE slug = 'hit'")
    ).rows[0]?.id as string;
    screeningId = (await screenings(hitId))[0]?.id as string;
  });

  it("is a plain 404 for everybody but a live operator", async () => {
    const nobody = await request(ofacServer, "/api/v1/platform/sanctions");
    expect(nobody.status).toBe(404);
    const { auth, identityDeps } = ofacServer.container;
    const { userId } = await provisionUser(identityDeps, { email: "someone@tenant.test" });
    const notOperator = await auth.sessions.startSession({
      userId,
      population: "operator",
      context: "first_party",
      authLevel: 2,
    });
    expect(
      (
        await request(ofacServer, "/api/v1/platform/sanctions", {
          cookie: `__Host-op_sid=${notOperator.token}`,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(ofacServer, `/api/v1/platform/sanctions/${screeningId}/decision`, {
          method: "POST",
          cookie: `__Host-sid=${notOperator.token}`,
          body: JSON.stringify({ decision: "cleared", note: "x" }),
        })
      ).status,
    ).toBe(404);
  });

  it("lists the open queue and shows the matches", async () => {
    const list = await request(ofacServer, "/api/v1/platform/sanctions", { cookie: op.cookie });
    expect(list.status).toBe(200);
    const items = (
      (await list.json()) as {
        items: { id: string; outcome: string; workspaceSlug: string; matchCount: number }[];
      }
    ).items;
    // The superseded error of `first` is not open; the hit is, and so is `blank`'s unscreenable
    // name (an error nobody superseded: the operator decides it).
    expect(items.map((i) => [i.workspaceSlug, i.outcome, i.matchCount]).sort()).toEqual([
      ["blank", "error", 0],
      ["hit", "potential_match", 1],
    ]);
    const all = await request(ofacServer, "/api/v1/platform/sanctions?status=all", {
      cookie: op.cookie,
    });
    expect(((await all.json()) as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(3);

    const detail = await request(ofacServer, `/api/v1/platform/sanctions/${screeningId}`, {
      cookie: op.cookie,
    });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: screeningId,
      subjectName: "Aero Caribbean Airlines S.A.",
      subjectCountry: "CU",
      provider: "ofac",
      decision: null,
      matches: [{ listEntryId: "sdn:36", programs: ["CUBA"], source: "OFAC SDN" }],
    });
    expect(
      (await request(ofacServer, `/api/v1/platform/sanctions/${hitId}`, { cookie: op.cookie }))
        .status,
    ).toBe(404);
  });

  it("needs a note, releases on cleared, and refuses a second decision", async () => {
    const path = `/api/v1/platform/sanctions/${screeningId}/decision`;
    for (const body of [{ decision: "cleared" }, { decision: "cleared", note: "  " }]) {
      const res = await request(ofacServer, path, {
        method: "POST",
        cookie: op.cookie,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    expect(await statusOf(hitId)).toEqual({ status: "pending_review", reason: null });
    const ok = await request(ofacServer, path, {
      method: "POST",
      cookie: op.cookie,
      body: JSON.stringify({ decision: "cleared", note: "Different company: Havana vs Hamburg" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      decision: "cleared",
      decidedBy: op.userId,
      decisionNote: "Different company: Havana vs Hamburg",
    });
    expect(await statusOf(hitId)).toEqual({ status: "active", reason: null });
    const again = await request(ofacServer, path, {
      method: "POST",
      cookie: op.cookie,
      body: JSON.stringify({ decision: "confirmed", note: "changed my mind" }),
    });
    expect(again.status).toBe(409);
    expect(await statusOf(hitId)).toEqual({ status: "active", reason: null });
    // Audited on the platform chain as the operator (host actor + user id); the tenant chain
    // shows only the release.
    const decisions = await platformAudit("sanctions.decision", hitId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ actor_kind: "host", actor_user_id: op.userId });
    expect(decisions[0]?.meta).toMatchObject({ decision: "cleared", operator: true });
  });

  it("confirmed suspends for sanctions", async () => {
    const id = await provision(ofacServer, "rosneft", "Rosneft Trading Ltd", "CH");
    await runJob(ofacServer, "sanctions.screen", { workspaceId: id });
    const [row] = await screenings(id);
    expect(row?.outcome).toBe("potential_match");
    const res = await request(ofacServer, `/api/v1/platform/sanctions/${row?.id}/decision`, {
      method: "POST",
      cookie: op.cookie,
      body: JSON.stringify({ decision: "confirmed", note: "Subsidiary of a listed party" }),
    });
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toEqual({ status: "suspended", reason: "sanctions" });
  });

  it("cleared never lifts another reason's suspension", async () => {
    const id = await provision(ofacServer, "opsusp", "Petropars Trading", "IR");
    await runJob(ofacServer, "sanctions.screen", { workspaceId: id });
    const [row] = await screenings(id);
    expect(row?.outcome).toBe("potential_match");
    const { db, audit } = ofacServer.container;
    await db.withHost((tx) =>
      setWorkspaceHold(
        tx,
        {
          workspaceId: id,
          hold: "operator",
          on: true,
          actor: { kind: "system", source: "cli" },
        },
        { audit, invalidate: () => {} },
      ),
    );
    const res = await request(ofacServer, `/api/v1/platform/sanctions/${row?.id}/decision`, {
      method: "POST",
      cookie: op.cookie,
      body: JSON.stringify({ decision: "cleared", note: "Not the listed Petropars" }),
    });
    expect(res.status).toBe(200);
    expect(await statusOf(id)).toEqual({ status: "suspended", reason: "operator" });
  });

  it("an operator re-screen is queued (202) and audited; unknown workspace 404", async () => {
    await clearQueuedScreens();
    const res = await request(ofacServer, `/api/v1/platform/workspaces/${hitId}/rescreen`, {
      method: "POST",
      cookie: op.cookie,
    });
    expect(res.status).toBe(202);
    expect(await queuedScreens(hitId)).toBe(1);
    const requested = await platformAudit("sanctions.screen", hitId);
    expect(requested.at(-1)).toMatchObject({ actor_kind: "host", actor_user_id: op.userId });
    const missing = await request(
      ofacServer,
      "/api/v1/platform/workspaces/0192f000-0000-7000-8000-000000000001/rescreen",
      { method: "POST", cookie: op.cookie },
    );
    expect(missing.status).toBe(404);
    await clearQueuedScreens();
  });
});

describe("ofac: list change → re-screen", () => {
  it("re-screens every live workspace not yet screened against the new version", async () => {
    const firstId = (
      await pg.pool.query<{ id: string }>("SELECT id FROM core.workspace WHERE slug = 'first'")
    ).rows[0]?.id as string;
    // The list gains an entry matching the (live) `first` workspace.
    files["SDN.CSV"] =
      `${SDN_ROWS.join("\r\n")}\r\n99,"SEED HOST VENTURES",-0- ,"SDGT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- \r\n`;
    await clearQueuedScreens();
    const before = (await screenings(firstId)).at(-1)?.list_version;
    // Within the hour the refresh reuses its snapshot; the next day's run downloads again.
    offsetMs = 24 * 3600_000;
    await runJob(ofacServer, "sanctions.refresh", {});
    const version = (
      await pg.pool.query<{ v: string }>(
        "SELECT data->>'listVersion' AS v FROM pgboss.job WHERE name = 'sanctions.rescreen' ORDER BY created_on DESC LIMIT 1",
      )
    ).rows[0]?.v as string;
    expect(version).toMatch(/^ofac:[0-9a-f]{12}:jw4$/u);
    expect(version).not.toBe(before);
    const queued = await pg.pool.query<{ key: string }>(
      "SELECT singleton_key AS key FROM pgboss.job WHERE name = 'sanctions.rescreen' AND data->>'listVersion' = $1",
      [version],
    );
    expect(queued.rows).toHaveLength(1);
    await runJob(ofacServer, "sanctions.rescreen", { listVersion: version });
    expect(await queuedScreens(firstId)).toBe(1);
    await runJob(ofacServer, "sanctions.screen", { workspaceId: firstId, reason: "rescreen" });
    // A hit on a live workspace: recorded and queued, the portal stays up.
    expect(await statusOf(firstId)).toEqual({ status: "active", reason: null });
    const last = (await screenings(firstId)).at(-1);
    expect(last?.outcome).toBe("potential_match");
    expect(last?.list_version).toBe(version);
    // Screened against the new version now: the next fan-out skips it.
    await clearQueuedScreens();
    await runJob(ofacServer, "sanctions.rescreen", { listVersion: version });
    expect(await queuedScreens(firstId)).toBe(0);
  });

  it("skips an unscreenable name on every list change until it is renamed (RR2-3)", async () => {
    const blankId = (
      await pg.pool.query<{ id: string }>("SELECT id FROM core.workspace WHERE slug = 'blank'")
    ).rows[0]?.id as string;
    const version = (
      await pg.pool.query<{ v: string }>(
        "SELECT data->>'listVersion' AS v FROM pgboss.job WHERE name = 'sanctions.rescreen' ORDER BY created_on DESC LIMIT 1",
      )
    ).rows[0]?.v as string;
    await clearQueuedScreens();
    await runJob(ofacServer, "sanctions.rescreen", { listVersion: version });
    expect(await queuedScreens(blankId)).toBe(0);
    // Renamed to something readable (Cyrillic is, since jw4): screened again, and matched.
    await ofacServer.container.db.withHost((tx) =>
      tx.execute(`UPDATE core.workspace SET legal_name = 'Роснефть' WHERE id = '${blankId}'`),
    );
    await runJob(ofacServer, "sanctions.rescreen", { listVersion: version });
    expect(await queuedScreens(blankId)).toBe(1);
    await runJob(ofacServer, "sanctions.screen", { workspaceId: blankId, reason: "rescreen" });
    const last = (await screenings(blankId)).at(-1);
    expect(last?.outcome).toBe("potential_match");
    expect(last?.matches.map((m) => m.listEntryId)).toEqual(["sdn:7160"]);
  });

  it("holds a name the local matcher cannot read, and compares names by code point (FR4)", async () => {
    const version = (
      await pg.pool.query<{ v: string }>(
        "SELECT data->>'listVersion' AS v FROM pgboss.job WHERE name = 'sanctions.rescreen' ORDER BY created_on DESC LIMIT 1",
      )
    ).rows[0]?.v as string;
    // Part Arabic: the ofac driver cannot compare it with a romanised list — held, not "clear".
    const mixedId = await provision(ofacServer, "mixed", "بنك ملي Trading");
    await runJob(ofacServer, "sanctions.screen", { workspaceId: mixedId });
    expect(await statusOf(mixedId)).toEqual({ status: "pending_review", reason: null });
    expect((await screenings(mixedId)).map((r) => r.list_version)).toEqual([
      "ofac:unscreenable:jw4",
    ]);
    // 200 astral letters (the legal-name maximum) are 400 UTF-16 units: a UTF-16 cut at 300 would
    // store 150 of them, and the fan-out (SQL left(…, 300), code points) would never recognise it.
    const astralId = await provision(ofacServer, "astral", "\u{10380}".repeat(200));
    await runJob(ofacServer, "sanctions.screen", { workspaceId: astralId });
    const [row] = await screenings(astralId);
    expect(row?.outcome).toBe("error");
    await clearQueuedScreens();
    await runJob(ofacServer, "sanctions.rescreen", { listVersion: version });
    expect(await queuedScreens(mixedId)).toBe(0);
    expect(await queuedScreens(astralId)).toBe(0);
  });
});

describe("opensanctions (yente)", () => {
  it("holds while yente is down, then screens through it", async () => {
    yenteDown = true;
    const id = await provision(yenteServer, "yente-one", "Friendly Robotics AG", "CH");
    expect(await statusOf(id)).toEqual({ status: "pending_review", reason: null });
    await expect(runJob(yenteServer, "sanctions.screen", { workspaceId: id })).rejects.toThrow();
    expect((await screenings(id)).map((s) => s.outcome)).toEqual(["error"]);
    yenteDown = false;
    await runJob(yenteServer, "sanctions.screen", { workspaceId: id });
    expect(await statusOf(id)).toEqual({ status: "active", reason: null });
    const rows = await screenings(id);
    expect(rows.at(-1)).toMatchObject({
      outcome: "clear",
      list_version: "opensanctions:sanctions:20260927-a",
    });
    expect(yenteBodies.at(-1)).toEqual({
      queries: {
        q: {
          schema: "Company",
          properties: { name: ["Friendly Robotics AG"], country: ["ch"] },
        },
      },
    });
  });

  it("yente reads other scripts itself: a partly non-Latin name is sent, not held as unscreenable (FR4)", async () => {
    const id = await provision(yenteServer, "yente-mixed", "Evil 株式会社", null);
    await runJob(yenteServer, "sanctions.screen", { workspaceId: id });
    const rows = await screenings(id);
    expect(rows.map((r) => r.outcome)).toEqual(["potential_match"]);
    expect(rows[0]?.list_version).not.toContain("unscreenable");
  });

  it("a yente hit keeps the new workspace held", async () => {
    const id = await provision(yenteServer, "yente-evil", "Evil Holdings", null);
    await runJob(yenteServer, "sanctions.screen", { workspaceId: id });
    expect(await statusOf(id)).toEqual({ status: "pending_review", reason: null });
    expect((await screenings(id)).at(-1)?.matches).toEqual([
      {
        listEntryId: "NK-evil",
        name: "Evil Corp",
        score: 0.97,
        programs: ["x"],
        source: "OpenSanctions",
      },
    ]);
  });
});
