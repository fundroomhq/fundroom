import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyExportBundle, writeCheckpoint } from "@fundroom/audit";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * E2.7 package A end to end: the audit log search, chain verification, the export signing keys
 * and the signed export bundle, against a real server and Postgres.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

interface Actor {
  cookie: string;
  membershipId: string;
}

interface AuditEvent {
  id: string;
  seq: number;
  action: string;
  actorMembershipId: string | null;
  actorName: string | null;
  subjectMembershipId: string | null;
  subjectName: string | null;
  resourceKind: string;
  outcome: string;
  meta: Record<string, unknown>;
}

interface Page {
  items: AuditEvent[];
  nextCursor: string | null;
}

async function request(slug: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.cookie)
    headers.set("origin", `http://${slug}.${CANON}`);
  return running.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function signIn(slug: string, email: string): Promise<Actor> {
  const since = mailer.sent.length;
  const start = await request(slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request(slug, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "" };
}

async function stepUpToMfa(slug: string, cookie: string): Promise<string> {
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request(slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  // Step-up rotates the session token (F-12): carry the new cookie on.
  return withSetCookies(cookie, confirm);
}

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "legal" | "editor" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

async function rows<T>(query: string, workspaceId: string): Promise<T[]> {
  return running.container.db.withTenant(systemContext(workspaceId), async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

async function backdateSession(actor: Actor, workspaceId: string, ageMs: number): Promise<void> {
  const userId = (
    await rows<{ userId: string }>(
      `SELECT user_id AS "userId" FROM core.membership WHERE id = '${actor.membershipId}'::uuid`,
      workspaceId,
    )
  )[0]?.userId;
  await running.container.db.withHost(async (tx) => {
    await tx.execute(
      `UPDATE core.session SET auth_time = now() - interval '${ageMs} milliseconds'
         WHERE user_id = '${userId}'::uuid AND revoked_at IS NULL`,
    );
  });
}

/** Synthetic events written through the real recorder, as the system actor of the workspace. */
async function recordEvents(
  workspaceId: string,
  n: number,
  input: { action: string; actor?: string; subject?: string; outcome?: "success" | "denied" },
): Promise<void> {
  const ctx = systemContext(workspaceId);
  for (let i = 0; i < n; i++) {
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.audit.record(tx, ctx, {
        action: input.action as never,
        resourceKind: "grant",
        actorMembershipId: input.actor ?? null,
        subjectMembershipId: input.subject ?? null,
        outcome: input.outcome ?? "success",
        meta: { i },
      }),
    );
  }
}

async function events(slug: string, actor: Actor, query = ""): Promise<Page> {
  const res = await request(slug, `/api/v1/audit/events${query}`, { cookie: actor.cookie });
  expect(res.status).toBe(200);
  return json<Page>(res);
}

async function exportZip(slug: string, actor: Actor, body: Record<string, string> = {}) {
  return request(slug, "/api/v1/audit/exports", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify(body),
  });
}

async function publishedKeys(slug: string, actor: Actor): Promise<string[]> {
  const res = await request(slug, "/api/v1/audit/export-key", { cookie: actor.cookie });
  expect(res.status).toBe(200);
  const body = await json<{ alg: string; keys: { publicKey: string; current: boolean }[] }>(res);
  expect(body.alg).toBe("Ed25519");
  expect(body.keys.filter((k) => k.current)).toHaveLength(1);
  return body.keys.map((k) => k.publicKey);
}

let acmeId: string;
let globexId: string;
let owner: Actor;
let admin: Actor;
let counsel: Actor;
let editor: Actor;
let ada: Actor;
let globexOwner: Actor;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(running.container.db, { slug: "globex", name: "Globex" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  admin = await member("acme", acmeId, "admin@example.com", "staff", "admin");
  counsel = await member("acme", acmeId, "counsel@example.com", "staff", "legal");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@example.org", "staff", "owner");
  await recordEvents(acmeId, 5, {
    action: "grant.changed",
    actor: owner.membershipId,
    subject: ada.membershipId,
  });
  await recordEvents(acmeId, 2, { action: "grant.revoked", outcome: "denied" });
  await recordEvents(globexId, 3, { action: "grant.changed", actor: globexOwner.membershipId });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("RBAC", () => {
  it("owner, admin and legal read; editor 403; an investor gets 404", async () => {
    for (const who of [owner, admin, counsel]) {
      expect((await request("acme", "/api/v1/audit/events", { cookie: who.cookie })).status).toBe(
        200,
      );
    }
    const denied = await request("acme", "/api/v1/audit/events", { cookie: editor.cookie });
    expect(denied.status).toBe(403);
    for (const path of [
      "/api/v1/audit/events",
      "/api/v1/audit/verify",
      "/api/v1/audit/export-key",
    ]) {
      expect((await request("acme", path, { cookie: ada.cookie })).status).toBe(404);
    }
    expect((await exportZip("acme", ada)).status).toBe(404);
  });

  it("export is owner/legal only: admin and editor are refused", async () => {
    expect((await exportZip("acme", admin)).status).toBe(403);
    expect((await exportZip("acme", editor)).status).toBe(403);
  });
});

describe("GET /audit/events", () => {
  it("filters by exact action, prefix, subject, actor and outcome, with names joined", async () => {
    const changed = await events("acme", counsel, "?action=grant.changed");
    expect(changed.items).toHaveLength(5);
    expect(changed.items[0]).toMatchObject({
      actorMembershipId: owner.membershipId,
      actorName: "owner",
      subjectMembershipId: ada.membershipId,
      subjectName: "ada",
    });
    expect((await events("acme", counsel, "?action=grant.")).items).toHaveLength(7);
    expect(
      (await events("acme", counsel, `?subjectMembershipId=${ada.membershipId}`)).items.every(
        (e) => e.subjectMembershipId === ada.membershipId,
      ),
    ).toBe(true);
    const denied = await events("acme", counsel, "?outcome=denied");
    expect(denied.items.map((e) => e.action)).toEqual(["grant.revoked", "grant.revoked"]);
    const byActor = await events(
      "acme",
      counsel,
      `?actorMembershipId=${owner.membershipId}&action=grant.`,
    );
    expect(byActor.items).toHaveLength(5);
    // `_` is not a wildcard: a prefix that only matches under LIKE semantics finds nothing.
    expect((await events("acme", counsel, "?action=grant_")).items).toHaveLength(0);
  });

  it("pages newest first with an opaque cursor, without gaps or overlap", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page = await events(
        "acme",
        counsel,
        `?action=grant.&limit=3${cursor ? `&cursor=${cursor}` : ""}`,
      );
      seen.push(...page.items.map((e) => e.seq));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
    expect(new Set(seen).size).toBe(7);
  });

  it("time bounds apply to occurredAt", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect((await events("acme", counsel, `?from=${encodeURIComponent(future)}`)).items).toEqual(
      [],
    );
  });

  it("rejects a malformed cursor", async () => {
    const res = await request("acme", "/api/v1/audit/events?cursor=bm9wZQ", {
      cookie: counsel.cookie,
    });
    expect(res.status).toBe(400);
  });

  it("workspace B never sees workspace A's rows", async () => {
    const acmeIds = new Set((await events("acme", owner, "?limit=200")).items.map((e) => e.id));
    const globex = await events("globex", globexOwner, "?limit=200");
    expect(globex.items.length).toBeGreaterThanOrEqual(3);
    expect(globex.items.some((e) => acmeIds.has(e.id))).toBe(false);
    // A's membership ids resolve to nothing in B, even as a filter.
    expect(
      (await events("globex", globexOwner, `?subjectMembershipId=${ada.membershipId}`)).items,
    ).toEqual([]);
    // And A's staff cannot reach B at all.
    expect((await request("globex", "/api/v1/audit/events", { cookie: owner.cookie })).status).toBe(
      404,
    );
  });
});

describe("GET /audit/verify", () => {
  it("verifies the chain and the signed checkpoints", async () => {
    await writeCheckpoint(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      acmeId,
    );
    const res = await request("acme", "/api/v1/audit/verify", { cookie: counsel.cookie });
    expect(res.status).toBe(200);
    const body = await json<{
      ok: boolean;
      headSeq: number;
      checkpoints: number;
      problems: string[];
    }>(res);
    expect(body).toMatchObject({ ok: true, checkpoints: 1, problems: [] });
    expect(body.headSeq).toBeGreaterThanOrEqual(7);
  });
});

describe("POST /audit/exports", () => {
  it("needs a fresh sign-in", async () => {
    const stale = await member("acme", acmeId, "stale@example.com", "staff", "legal");
    await backdateSession(stale, acmeId, 30 * 60_000);
    const res = await exportZip("acme", stale);
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("step_up_required");
  });

  it("returns a signed zip that verifies offline against the published key, and audits it", async () => {
    const keys = await publishedKeys("acme", counsel);
    const res = await exportZip("acme", counsel);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="audit-acme-/u);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const v = verifyExportBundle(bytes, { trustedPublicKeys: keys });
    expect(v.problems).toEqual([]);
    expect(v).toMatchObject({ ok: true, trusted: true });
    const m = v.manifest;
    expect(m).toMatchObject({
      workspace: { id: acmeId, slug: "acme", name: "Acme" },
      generatedBy: { membershipId: counsel.membershipId },
      range: { fromSeq: 1 },
      prevHash: null,
    });
    expect(m?.rowCount).toBe((m?.range.toSeq ?? 0) - 1 + 1);
    // Every line names this workspace (the verifier checks each canonical's workspace_id), and
    // every file listed in the manifest is present and hashed.
    expect(Object.keys(m?.files ?? {}).sort()).toEqual([
      "VERIFY.md",
      "checkpoints.json",
      "events.csv",
      "events.jsonl",
    ]);
    expect(Buffer.from(bytes).includes(Buffer.from(globexId))).toBe(false);

    const audited = await rows<{ meta: Record<string, unknown>; actor: string; seq: string }>(
      `SELECT meta, actor_membership_id AS actor, seq FROM audit.event
        WHERE workspace_id = '${acmeId}'::uuid AND action = 'audit.exported'
        ORDER BY seq DESC LIMIT 1`,
      acmeId,
    );
    expect(audited[0]?.actor).toBe(counsel.membershipId);
    expect(audited[0]?.meta).toMatchObject({
      fromSeq: 1,
      toSeq: m?.range.toSeq,
      rows: m?.rowCount,
      sha256: res.headers.get("x-content-sha256"),
    });
    // The export row is never inside the export it describes.
    expect(Number(audited[0]?.seq)).toBeGreaterThan(m?.range.toSeq ?? 0);
  });

  it("a mid-chain window carries prevHash and still verifies", async () => {
    await new Promise((r) => setTimeout(r, 20));
    const mid = new Date();
    await recordEvents(acmeId, 3, { action: "grant.created" });
    const res = await exportZip("acme", owner, { from: mid.toISOString() });
    expect(res.status).toBe(200);
    const v = verifyExportBundle(new Uint8Array(await res.arrayBuffer()), {
      trustedPublicKeys: await publishedKeys("acme", owner),
    });
    expect(v.problems).toEqual([]);
    expect(v.manifest?.rowCount).toBe(3);
    expect(v.manifest?.range.fromSeq).toBeGreaterThan(1);
    expect(v.manifest?.prevHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("an empty window is an empty, valid bundle; from after to is a 400", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const empty = await exportZip("acme", owner, { from: future });
    expect(empty.status).toBe(200);
    const v = verifyExportBundle(new Uint8Array(await empty.arrayBuffer()));
    expect(v).toMatchObject({ ok: true, manifest: { rowCount: 0 } });
    const bad = await exportZip("acme", owner, {
      from: future,
      to: new Date().toISOString(),
    });
    expect(bad.status).toBe(400);
  });

  it("one export per workspace at a time: a second concurrent one is 409 export_running", async () => {
    // Hold the audit table so the first export parks inside its read, then ask again.
    const locker = await pg.pool.connect();
    let first: Promise<Response> | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE audit.event IN ACCESS EXCLUSIVE MODE");
      first = exportZip("acme", counsel);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows: waiting } = await pg.pool.query(
          `SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = 'relation'`,
        );
        if ((waiting[0] as { n: number }).n > 0) break;
        if (Date.now() > deadline) throw new Error("the first export never reached its read");
        await new Promise((r) => setTimeout(r, 50));
      }
      const second = await exportZip("acme", owner);
      expect(second.status).toBe(409);
      expect(await json(second)).toMatchObject({
        error: { code: "conflict", reason: "export_running" },
      });
    } finally {
      await locker.query("COMMIT");
      locker.release();
    }
    expect((await first).status).toBe(200);
    // Released afterwards: the next export runs.
    expect((await exportZip("acme", owner, { from: new Date().toISOString() })).status).toBe(200);
  });
});

describe("tampering", () => {
  it("/audit/verify reports a row rewritten behind the triggers' back", async () => {
    // Globex's chain, so the other tests' chain stays intact.
    await pg.pool.query("ALTER TABLE audit.event DISABLE TRIGGER event_immutable");
    try {
      await pg.pool.query(
        "UPDATE audit.event SET meta = '{\"i\": 999}'::jsonb WHERE workspace_id = $1 AND seq = 2",
        [globexId],
      );
    } finally {
      await pg.pool.query("ALTER TABLE audit.event ENABLE TRIGGER event_immutable");
    }
    const res = await request("globex", "/api/v1/audit/verify", { cookie: globexOwner.cookie });
    const body = await json<{ ok: boolean; problems: string[] }>(res);
    expect(body.ok).toBe(false);
    expect(body.problems[0]).toMatch(/hash mismatch \(row altered\) at seq 2/u);
    // Acme is unaffected.
    const acme = await json<{ ok: boolean }>(
      await request("acme", "/api/v1/audit/verify", { cookie: owner.cookie }),
    );
    expect(acme.ok).toBe(true);
  });

  it("an export of the tampered chain fails offline verification", async () => {
    const res = await exportZip("globex", globexOwner);
    expect(res.status).toBe(200);
    const v = verifyExportBundle(new Uint8Array(await res.arrayBuffer()));
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /hash mismatch .* at seq 2/u.test(p))).toBe(true);
  });
});
