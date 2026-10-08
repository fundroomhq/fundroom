import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Jobs, dead letters and deep health (E2.7) end to end.
 *
 * Dead letters are made the real way — a handler that throws on a `retryLimit: 0` queue — on the
 * running server's own pg-boss, with payloads naming acme, globex, or no workspace at all, and
 * carrying an email address that must never reach a response body. The multi-tenant server is the
 * main subject; a second, single-tenant server on a second database in the same container proves
 * the scope switch (`queues` and the adapter checks appear only there) and that even the one
 * workspace of a single-tenant install sees only the dead letters its payloads name.
 *
 * Certificate reading itself is covered against a local `node:tls` server in `cert-probe.test.ts`;
 * here the domain rows prove which domains are contacted at all: a pending one never is.
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
const QUEUE = "opstest.fail";
const PII = "carol.secret@example.com";

interface Server {
  pg?: TestPostgres;
  running: RunningServer;
  mailer: MemoryMailer;
  /** `<slug>.<canon>` in multi mode; the canonical host in single mode. */
  host(slug: string): string;
}

interface Actor {
  cookie: string;
  membershipId: string;
}

let pg: TestPostgres;
let multi: Server;
let single: Server;
let acmeId: string;
let globexId: string;
let soloId: string;
let owner: Actor;
let admin: Actor;
let editor: Actor;
let ada: Actor;
let globexOwner: Actor;
let soloOwner: Actor;
let failing = true;
let runs = 0;

function envFor(url: string, tenancy: "single" | "multi") {
  return {
    APP_ENV: "test",
    LOG_LEVEL: "warn",
    BASE_URL: BASE,
    DATABASE_URL: url,
    FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
    STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
    TENANCY_MODE: tenancy,
    ROLES: "api,web,worker",
    OUTBOX_POLL_INTERVAL_MS: "200",
    JOBS_POLL_INTERVAL_MS: "500",
  };
}

async function req(
  s: Server,
  slug: string,
  path: string,
  init: RequestInit & { cookie?: string } = {},
) {
  const host = s.host(slug);
  const headers = new Headers(init.headers);
  headers.set("host", host);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.cookie && !headers.has("origin"))
    headers.set("origin", `https://${host}`);
  return s.running.app.request(`https://${host}${path}`, { ...init, headers });
}

const request = (slug: string, path: string, init: RequestInit & { cookie?: string } = {}) =>
  req(multi, slug, path, init);

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function signIn(s: Server, slug: string, email: string): Promise<Actor> {
  const since = s.mailer.sent.length;
  const start = await req(s, slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(s.mailer, email, since);
  const verify = await req(s, slug, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "" };
}

async function stepUpToMfa(s: Server, slug: string, cookie: string): Promise<string> {
  const enrol = await req(s, slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await req(s, slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  // Step-up rotates the session token (F-12): carry the new cookie on.
  return withSetCookies(cookie, confirm);
}

async function member(
  s: Server,
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "editor" | "investor",
): Promise<Actor> {
  const deps = s.running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(s, slug, email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(s, slug, actor.cookie);
  return actor;
}

async function rows<T>(workspaceId: string, query: string): Promise<T[]> {
  return multi.running.container.db.withTenant(systemContext(workspaceId), async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

async function auditRows(workspaceId: string, action: string) {
  return rows<{ resource_id: string; meta: Record<string, unknown> }>(
    workspaceId,
    `SELECT resource_id, meta FROM audit.event WHERE workspace_id = '${workspaceId}'::uuid
       AND action = '${action}' ORDER BY seq`,
  );
}

async function backdateSession(actor: Actor, ageMs: number): Promise<void> {
  const [m] = await rows<{ user_id: string }>(
    acmeId,
    `SELECT user_id FROM core.membership WHERE id = '${actor.membershipId}'::uuid`,
  );
  await multi.running.container.db.withHost(async (tx) => {
    await tx.execute(
      `UPDATE core.session SET auth_time = now() - interval '${ageMs} milliseconds'
         WHERE user_id = '${m?.user_id}'::uuid AND revoked_at IS NULL`,
    );
  });
}

async function waitForAsync(pred: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** A failing queue on `s`'s pg-boss, and one dead letter per payload. */
async function deadLetter(s: Server, payloads: Record<string, unknown>[]): Promise<void> {
  const queue = s.running.container.queue;
  await queue.ensureQueue(QUEUE, { retryLimit: 0, retryBackoff: false });
  await queue.work(QUEUE, async () => {
    runs++;
    if (failing) throw new Error("upstream said 503");
  });
  const before = await queue.deadLetters.count();
  for (const p of payloads) await queue.send(QUEUE, p as never);
  await waitForAsync(async () => (await queue.deadLetters.count()) === before + payloads.length);
}

interface JobsBody {
  scope: string;
  queues: { name: string }[];
  deadLetters: {
    count: number;
    items: {
      id: string;
      sourceQueue: string;
      error: string;
      dataKeys: string[];
      topic?: string;
      eventId?: string;
    }[];
  };
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  await pg.pool.query("CREATE DATABASE seedhost_single");
  const singleUrl = pg.connectionString.replace(/\/seedhost_test(?=$|\?)/u, "/seedhost_single");

  const multiMailer = createMemoryMailer();
  multi = {
    mailer: multiMailer,
    host: (slug) => `${slug}.${CANON}`,
    running: await startServer({
      config: loadConfig({ env: envFor(pg.connectionString, "multi") }),
      logger: createLogger({ level: "warn" }),
      mailer: multiMailer,
      modules: COMPILED_IN_MODULES,
      listenEnabled: false,
      migrate: true,
      announceSetup: false,
    }),
  };
  acmeId = (await createWorkspace(multi.running.container.db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(multi.running.container.db, { slug: "globex", name: "Globex" }))
    .id;
  owner = await member(multi, "acme", acmeId, "owner@acme.test", "staff", "owner");
  admin = await member(multi, "acme", acmeId, "admin@acme.test", "staff", "admin");
  editor = await member(multi, "acme", acmeId, "editor@acme.test", "staff", "editor");
  ada = await member(multi, "acme", acmeId, "ada@acme.test", "external", "investor");
  globexOwner = await member(multi, "globex", globexId, "owner@globex.test", "staff", "owner");
  await deadLetter(multi, [
    {
      workspaceId: acmeId,
      topic: "member.invited",
      outboxId: 41,
      subscriber: "opstest.probe",
      email: PII,
    },
    { workspaceId: acmeId, email: PII, n: 2 },
    { workspaceId: globexId, email: "globex@example.com" },
    { email: "nobody@example.com" },
  ]);

  const singleMailer = createMemoryMailer();
  single = {
    mailer: singleMailer,
    host: () => CANON,
    running: await startServer({
      config: loadConfig({ env: envFor(singleUrl, "single") }),
      logger: createLogger({ level: "warn" }),
      mailer: singleMailer,
      modules: COMPILED_IN_MODULES,
      listenEnabled: false,
      migrate: true,
      announceSetup: false,
    }),
  };
  soloId = (await createWorkspace(single.running.container.db, { slug: "solo", name: "Solo" })).id;
  soloOwner = await member(single, "solo", soloId, "owner@solo.test", "staff", "owner");
  await deadLetter(single, [{ workspaceId: soloId, n: 1 }, { n: 2 }]);
}, 240_000);

afterAll(async () => {
  await single?.running.stop();
  await multi?.running.stop();
  await pg?.stop();
});

describe("GET /ops/jobs", () => {
  it("lists this workspace's dead letters without their payload, and no queue stats in multi mode", async () => {
    const res = await request("acme", "/api/v1/ops/jobs", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const text = await res.text();
    // The payloads carry an email; the response must not.
    expect(text).not.toContain(PII);
    expect(text).not.toContain("globex@example.com");
    const body = JSON.parse(text) as JobsBody;
    expect(body.scope).toBe("workspace");
    expect(body.queues).toEqual([]);
    expect(body.deadLetters.count).toBe(2);
    expect(body.deadLetters.items).toHaveLength(2);
    const event = body.deadLetters.items.find((i) => i.topic !== undefined);
    expect(event).toMatchObject({
      sourceQueue: QUEUE,
      topic: "member.invited",
      eventId: "41",
      error: "upstream said 503",
      dataKeys: ["email", "outboxId", "subscriber", "topic", "workspaceId"],
    });
    const limited = await json<JobsBody>(
      await request("acme", "/api/v1/ops/jobs?limit=1", { cookie: owner.cookie }),
    );
    expect(limited.deadLetters).toMatchObject({ count: 2 });
    expect(limited.deadLetters.items).toHaveLength(1);
  });

  it("owner and admin read; editor is forbidden; an investor gets the unknown-route 404", async () => {
    for (const path of ["/api/v1/ops/jobs", "/api/v1/ops/health"]) {
      expect((await request("acme", path, { cookie: admin.cookie })).status, path).toBe(200);
      const asEditor = await request("acme", path, { cookie: editor.cookie });
      expect(asEditor.status, path).toBe(403);
      expect((await json<{ error: { code: string } }>(asEditor)).error.code).toBe("forbidden");
      expect((await request("acme", path, { cookie: ada.cookie })).status, path).toBe(404);
    }
    const [item] = (
      await json<JobsBody>(await request("acme", "/api/v1/ops/jobs", { cookie: owner.cookie }))
    ).deadLetters.items;
    const retry = `/api/v1/ops/jobs/dead-letters/${item?.id}/retry`;
    expect((await request("acme", retry, { method: "POST", cookie: editor.cookie })).status).toBe(
      403,
    );
    expect((await request("acme", retry, { method: "POST", cookie: ada.cookie })).status).toBe(404);
  });
});

describe("tenant isolation", () => {
  it("globex sees only its own dead letter and cannot retry or discard acme's (404)", async () => {
    const theirs = await json<JobsBody>(
      await request("globex", "/api/v1/ops/jobs", { cookie: globexOwner.cookie }),
    );
    expect(theirs.deadLetters.count).toBe(1);
    const acme = await json<JobsBody>(
      await request("acme", "/api/v1/ops/jobs", { cookie: owner.cookie }),
    );
    const ids = new Set(acme.deadLetters.items.map((i) => i.id));
    expect(theirs.deadLetters.items.some((i) => ids.has(i.id))).toBe(false);
    for (const id of ids) {
      const retry = await request("globex", `/api/v1/ops/jobs/dead-letters/${id}/retry`, {
        method: "POST",
        cookie: globexOwner.cookie,
      });
      expect(retry.status).toBe(404);
      const discard = await request("globex", `/api/v1/ops/jobs/dead-letters/${id}`, {
        method: "DELETE",
        cookie: globexOwner.cookie,
      });
      expect(discard.status).toBe(404);
    }
    // Still there, untouched.
    expect(await multi.running.container.queue.deadLetters.count({ workspaceId: acmeId })).toBe(2);
    // A dead letter naming no workspace is nobody's on the admin page either.
    const [orphan] = (await multi.running.container.queue.deadLetters.list()).filter(
      (j) => j.data["workspaceId"] === undefined,
    );
    expect(orphan).toBeDefined();
    const orphanRetry = await request("acme", `/api/v1/ops/jobs/dead-letters/${orphan?.id}/retry`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(orphanRetry.status).toBe(404);
    // Unknown and malformed ids.
    expect(
      (
        await request(
          "acme",
          "/api/v1/ops/jobs/dead-letters/01920000-0000-7000-8000-0000000000ff/retry",
          {
            method: "POST",
            cookie: owner.cookie,
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request("acme", "/api/v1/ops/jobs/dead-letters/nope/retry", {
          method: "POST",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(400);
  });
});

describe("retry and discard", () => {
  it("discard needs a fresh session; retry does not; both are audited without the payload", async () => {
    const list = await json<JobsBody>(
      await request("acme", "/api/v1/ops/jobs", { cookie: owner.cookie }),
    );
    const [first, second] = list.deadLetters.items;
    await backdateSession(admin, 30 * 60_000);
    const stale = await request("acme", `/api/v1/ops/jobs/dead-letters/${first?.id}`, {
      method: "DELETE",
      cookie: admin.cookie,
    });
    expect(stale.status).toBe(403);
    expect((await json<{ error: { code: string; reason: string } }>(stale)).error).toMatchObject({
      code: "step_up_required",
      reason: "fresh",
    });

    failing = false;
    const before = runs;
    const retried = await request("acme", `/api/v1/ops/jobs/dead-letters/${first?.id}/retry`, {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(retried.status).toBe(204);
    await waitForAsync(async () => runs > before);

    const discarded = await request("acme", `/api/v1/ops/jobs/dead-letters/${second?.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(discarded.status).toBe(204);
    const again = await request("acme", `/api/v1/ops/jobs/dead-letters/${second?.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(again.status).toBe(404);
    expect(await multi.running.container.queue.deadLetters.count({ workspaceId: acmeId })).toBe(0);

    const r = await auditRows(acmeId, "ops.dead_letter_retried");
    const d = await auditRows(acmeId, "ops.dead_letter_discarded");
    expect(r.map((x) => x.resource_id)).toEqual([first?.id]);
    expect(d.map((x) => x.resource_id)).toEqual([second?.id]);
    expect(r[0]?.meta).toMatchObject({ sourceQueue: QUEUE });
    expect(JSON.stringify([r, d])).not.toContain(PII);
    // Globex's chain has nothing of acme's operator actions.
    expect(await auditRows(globexId, "ops.dead_letter_retried")).toEqual([]);
  });
});

describe("GET /ops/health", () => {
  it("multi-tenant: no instance checks; only verified domains are probed", async () => {
    await rows(
      acmeId,
      `INSERT INTO core.custom_domain (workspace_id, hostname, status, token, dns_ok_at, activated_at)
         VALUES ('${acmeId}'::uuid, 'portal.acme-ops.invalid', 'active', 'k7q2v9x4m3n8b5c1z6t0r7y2', now(), now()),
                ('${acmeId}'::uuid, 'pending.acme-ops.invalid', 'pending', 'k7q2v9x4m3n8b5c1z6t0r7y3', NULL, NULL)
         RETURNING id`,
    );
    const res = await request("acme", "/api/v1/ops/health", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const body = await json<{
      scope: string;
      checks: unknown[];
      domains: { hostname: string; status: string; certStatus: string; certError: string | null }[];
    }>(res);
    expect(body.scope).toBe("workspace");
    expect(body.checks).toEqual([]);
    const byHost = new Map(body.domains.map((d) => [d.hostname, d]));
    expect(byHost.get("pending.acme-ops.invalid")).toMatchObject({
      status: "pending",
      certStatus: "not_checked",
      certError: null,
    });
    // Verified, so contacted — and `.invalid` never resolves, which is the answer the row gives.
    expect(byHost.get("portal.acme-ops.invalid")).toMatchObject({
      status: "active",
      certStatus: "unreachable",
      certError: "DNS lookup failed",
    });
    // Another workspace's health lists none of acme's domains.
    const globex = await json<{ domains: unknown[] }>(
      await request("globex", "/api/v1/ops/health", { cookie: globexOwner.cookie }),
    );
    expect(globex.domains).toEqual([]);
  });
});

describe("single-tenant install", () => {
  it("reports instance scope with queue stats, but still only this workspace's dead letters", async () => {
    const res = await req(single, "solo", "/api/v1/ops/jobs", { cookie: soloOwner.cookie });
    expect(res.status).toBe(200);
    const body = await json<JobsBody>(res);
    expect(body.scope).toBe("instance");
    expect(body.queues.map((q) => q.name)).toContain(QUEUE);
    expect(body.deadLetters.count).toBe(1);
    expect(await single.running.container.queue.deadLetters.count()).toBe(2);
  });

  it("reports the adapter checks", async () => {
    const res = await req(single, "solo", "/api/v1/ops/health", { cookie: soloOwner.cookie });
    expect(res.status).toBe(200);
    const body = await json<{
      scope: string;
      checks: { name: string; status: string; latencyMs: number | null }[];
    }>(res);
    expect(body.scope).toBe("instance");
    const names = body.checks.map((c) => c.name);
    for (const n of ["db", "migrations", "storage", "mail", "queue", "avscan", "dns"]) {
      expect(names).toContain(n);
    }
    expect(body.checks.find((c) => c.name === "db")?.status).toBe("ok");
    expect(body.checks.find((c) => c.name === "queue")?.status).toBe("ok");
    // AV_DRIVER=noop (the test default) scans nothing, so it is never reported as healthy.
    const av = body.checks.find((c) => c.name === "avscan") as
      | { status: string; detail: string | null }
      | undefined;
    expect(av?.status).toBe("skipped");
    expect(av?.detail).toMatch(/not virus-scanned.*AV_ACCEPT_UNSCANNED/u);
    for (const c of body.checks) {
      expect(["ok", "degraded", "down", "skipped"]).toContain(c.status);
    }
  });
});
