import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import {
  SIGNUP_RATES,
  SIGNUP_TERMS_ATTESTATION_KIND,
  SIGNUP_TERMS_VERSION,
} from "@fundroom/control-plane";
import { createWorkspace, PLATFORM_WORKSPACE_ID } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { ProvisionedWorkspace } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Self-service signup end to end (E3.10 §5.7, agent A): only on the canonical host with
 * SIGNUP_MODE=open; `start` answers the same `{ ok: true }` after the 250 ms floor for a new and a
 * known address and never an id; the per-address and global budgets; `verify` creates the user,
 * the workspace on SIGNUP_DEFAULT_PLAN, the active owner membership, the terms attestation and runs
 * the hooks in ONE transaction, signs the owner in on the canonical host and answers the
 * workspace's own address; a known address gets the same answer; a missing/archived default plan
 * is a clean 404; a slug that went meanwhile (also under a race) is 409 `slug_taken` with nothing
 * half-created.
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const hookCalls: ProvisionedWorkspace[] = [];
let ipCounter = 0;

async function request(
  host: string,
  path: string,
  init: RequestInit & { cookie?: string | undefined; ip?: string | undefined } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("accept", "application/json");
  // A fresh /24 per request unless the test names an address (the per-IP / per-network budgets).
  const n = ipCounter++;
  headers.set("x-forwarded-for", init.ip ?? `10.${Math.floor(n / 250) % 250}.${n % 250}.7`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `https://${host}`);
  return running.app.request(`https://${host}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown, host = CANON, ip?: string) =>
  request(host, `/api/v1/signup${path}`, { method: "POST", body: JSON.stringify(body), ip });

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
}

async function superQuery<T = Record<string, unknown>>(sql: string, args: unknown[] = []) {
  return (await pg.pool.query(sql, args)).rows as T[];
}

const application = (email: string, slug: string) => ({
  email,
  companyName: `${slug} Inc`,
  legalName: `${slug} Holdings GmbH`,
  country: "DE",
  slug,
  acceptTerms: true,
  termsVersion: SIGNUP_TERMS_VERSION,
});

/** start → the emailed code. */
async function startAndCode(email: string, slug: string): Promise<string> {
  const since = mailer.sent.length;
  const res = await post("/start", application(email, slug));
  expect(res.status).toBe(200);
  return awaitSignInCode(mailer, email, since);
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      DATABASE_POOL_MAX: process.env["FUNDROOM_TEST_POOL_MAX"] ?? "6",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      CONTROL_PLANE: "on",
      SIGNUP_MODE: "open",
      SIGNUP_DEFAULT_PLAN: "starter",
      TRUST_PROXY: "true",
      ROLES: "api,web",
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
  await createWorkspace(running.container.db, { slug: "taken", name: "Taken" });
  await superQuery(
    `INSERT INTO core.plan (id, name, limits, public) VALUES ('starter', 'Starter', '{"staffSeats": 3}', true)`,
  );
  Object.assign(running.container.sanctions, {
    hooks: {
      async onWorkspaceCreated(_tx: unknown, ws: ProvisionedWorkspace) {
        hookCalls.push(ws);
      },
    },
  });
  Object.assign(running.container.billing, { hooks: {} });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("where signup exists", () => {
  it("is a plain 404 on a tenant host or a /w/<slug> path", async () => {
    for (const [host, path] of [
      [`taken.${CANON}`, "/api/v1/signup/slug?slug=free"],
      [CANON, "/w/taken/api/v1/signup/slug?slug=free"],
    ] as const) {
      const res = await request(host, path);
      expect(res.status, `${host}${path}`).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
    const start = await post("/start", application("x@y.test", "xy"), `taken.${CANON}`);
    expect(start.status).toBe(404);
  });
});

describe("GET /signup/slug", () => {
  it("answers availability; reserved and taken slugs are unavailable", async () => {
    const q = async (slug: string) =>
      (
        (await (await request(CANON, `/api/v1/signup/slug?slug=${slug}`)).json()) as {
          available: boolean;
        }
      ).available;
    expect(await q("brand-new")).toBe(true);
    expect(await q("taken")).toBe(false);
    expect(await q("www")).toBe(false);
    expect(await q("platform")).toBe(false);
    // R1-L4: mail/identity hostnames and IDNA A-labels (lookalikes) are never offered.
    for (const slug of [
      "mta-sts",
      "autodiscover",
      "sso",
      "scim",
      "ns1",
      "status",
      // A-5: the edge's own records.
      "portals",
      "fallback",
      "xn--pple-43d",
    ]) {
      expect(await q(slug), slug).toBe(false);
    }
  });

  it("is rate-limited per client address (30 a minute)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push(
        (await request(CANON, "/api/v1/signup/slug?slug=abc", { ip: "10.99.99.99" })).status,
      );
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("POST /signup/start", () => {
  it("answers { ok: true } after the 250 ms floor, for a new and a known address alike", async () => {
    await provisionUser(running.container.identityDeps, { email: "known@start.test" });
    const timings: number[] = [];
    const bodies: unknown[] = [];
    for (const email of ["new@start.test", "known@start.test"]) {
      const t0 = performance.now();
      const res = await post("/start", application(email, "start-co"));
      timings.push(performance.now() - t0);
      expect(res.status).toBe(200);
      bodies.push(await res.json());
      expect(res.headers.getSetCookie()).toEqual([]);
    }
    expect(bodies).toEqual([{ ok: true }, { ok: true }]);
    for (const t of timings) expect(t).toBeGreaterThanOrEqual(245);
    // A code is sent either way (the address is proven at verify, not guessed at start).
    await awaitSignInCode(mailer, "new@start.test", 0);
    await awaitSignInCode(mailer, "known@start.test", 0);
  });

  it("spends 5 per address per hour, then 429 (still after the floor)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      const res = await post("/start", application("budget@start.test", "budget-co"));
      statuses.push(res.status);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(245);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("spends 10 per client address per hour before the global ceiling (R1-M2)", async () => {
    const limiter = running.container.identityDeps.rateLimiter;
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await post("/start", application(`ip${i}@start.test`, "ip-co"), CANON, "10.200.1.1"))
          .status,
      );
    }
    expect(statuses).toEqual([...Array(10).fill(200), 429]);
    // A refused client never touches the install ceiling: with ONE global slot left, the blocked
    // address is refused and somebody else still gets the slot.
    await limiter.reset("signup:start:global");
    for (let i = 0; i < SIGNUP_RATES.startGlobal.max - 1; i++) {
      await limiter.hit("signup:start:global", SIGNUP_RATES.startGlobal);
    }
    expect(
      (await post("/start", application("ipx@start.test", "ip-co"), CANON, "10.200.1.1")).status,
    ).toBe(429);
    expect((await post("/start", application("other@start.test", "ip-co"))).status).toBe(200);
    await limiter.reset("signup:start:global");
  });

  it("spends 30 per /24 (and per /64) per hour", async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 31; i++) {
      const res = await post(
        "/start",
        application(`net${i}@start.test`, "net-co"),
        CANON,
        `10.201.9.${i}`,
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    // Another /24 is another budget.
    expect(
      (await post("/start", application("net-x@start.test", "net-co"), CANON, "10.201.10.1"))
        .status,
    ).toBe(200);
    const v6: number[] = [];
    for (let i = 1; i <= 31; i++) {
      const res = await post(
        "/start",
        application(`v6-${i}@start.test`, "v6-co"),
        CANON,
        `2001:db8:7:7::${i.toString(16)}`,
      );
      v6.push(res.status);
    }
    expect(v6[30]).toBe(429);
  });

  it("spends 60 starts per IPv6 /48, across its /64s (fix round 3)", async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 61; i++) {
      const res = await post(
        "/start",
        application(`w48-${i}@start.test`, "w48-co"),
        CANON,
        `2001:db8:48:${i.toString(16)}::1`,
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    // Another /48 is another budget.
    expect(
      (await post("/start", application("w48-x@start.test", "w48-co"), CANON, "2001:db8:49::1"))
        .status,
    ).toBe(200);
  });

  it("requires the terms, at the current version", async () => {
    const { acceptTerms: _a, ...noTerms } = application("terms@start.test", "terms-co");
    expect((await post("/start", noTerms)).status).toBe(400);
    expect((await post("/start", { ...noTerms, acceptTerms: false })).status).toBe(400);
    const stale = await post("/start", {
      ...application("terms@start.test", "terms-co"),
      termsVersion: SIGNUP_TERMS_VERSION + 1,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: Record<string, unknown> }).error).toMatchObject({
      code: "conflict",
      reason: "terms_version",
      current: SIGNUP_TERMS_VERSION,
    });
  });

  it("has a high global ceiling", async () => {
    const limiter = running.container.identityDeps.rateLimiter;
    const rule = SIGNUP_RATES.startGlobal;
    await limiter.reset("signup:start:global");
    // Fill the global bucket.
    for (let i = 0; i < rule.max; i++) await limiter.hit("signup:start:global", rule);
    const res = await post("/start", application("global@start.test", "global-co"));
    expect(res.status).toBe(429);
    expect(await errorCode(res)).toBe("rate_limited");
    await limiter.reset("signup:start:global");
    expect((await post("/start", application("global@start.test", "global-co"))).status).toBe(200);
  });
});

describe("POST /signup/verify", () => {
  it("creates user, workspace, owner, plan and terms attestation in one go; signs the owner in", async () => {
    const code = await startAndCode("founder@newco.test", "newco");
    const wrong = await post("/verify", { email: "founder@newco.test", code: "000000" });
    expect(wrong.status).toBe(400);
    expect(await errorCode(wrong)).toBe("invalid_code");
    const res = await post("/verify", { email: "founder@newco.test", code });
    expect(res.status).toBe(201);
    // A-5: a free default plan lands on the setup wizard.
    expect(await res.json()).toEqual({ workspaceUrl: "https://newco.portal.example.test/setup" });
    const sid = res.headers.getSetCookie().find((c) => c.startsWith("__Host-sid="));
    expect(sid).toBeDefined();
    const cookie = (sid as string).split(";")[0] as string;
    // The session works on the canonical host and on the new workspace's host.
    expect((await request(CANON, "/api/v1/me", { cookie })).status).toBe(200);
    const me = await request(`newco.${CANON}`, "/api/v1/me", { cookie });
    expect(me.status).toBe(200);

    const [ws] = await superQuery<{
      id: string;
      name: string;
      legal_name: string;
      country: string;
      plan_id: string;
      status: string;
      cell_id: string;
    }>(
      `SELECT id::text, name, legal_name, country, plan_id, status, cell_id FROM core.workspace WHERE slug = 'newco'`,
    );
    expect(ws).toMatchObject({
      name: "newco Inc",
      legal_name: "newco Holdings GmbH",
      country: "DE",
      plan_id: "starter",
      status: "active",
      cell_id: "default",
    });
    const wsId = (ws as { id: string }).id;
    const members = await superQuery<{
      kind: string;
      role: string;
      status: string;
      source: string;
    }>(
      `SELECT m.kind::text, m.role::text, m.status::text, m.source FROM core.membership m
         JOIN core.user_identity ui ON ui.user_id = m.user_id
        WHERE m.workspace_id = $1 AND ui.identifier = 'founder@newco.test'`,
      [wsId],
    );
    expect(members).toEqual([{ kind: "staff", role: "owner", status: "active", source: "signup" }]);
    const attest = await superQuery<{ kind: string; data: Record<string, unknown> }>(
      `SELECT kind, data FROM core.attestation WHERE workspace_id = $1`,
      [wsId],
    );
    // From the challenge: the version accepted at start, and when.
    expect(attest).toEqual([
      {
        kind: SIGNUP_TERMS_ATTESTATION_KIND,
        data: expect.objectContaining({
          termsVersion: SIGNUP_TERMS_VERSION,
          acceptedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
          source: "signup",
        }),
      },
    ]);
    expect(hookCalls.at(-1)).toMatchObject({ id: wsId, slug: "newco", planId: "starter" });
    const platform = await superQuery<{ action: string; meta: Record<string, unknown> }>(
      `SELECT action, meta FROM audit.event WHERE workspace_id = $1 AND action = 'signup.complete'`,
      [PLATFORM_WORKSPACE_ID],
    );
    expect(platform).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({ workspaceId: wsId, newUser: true }),
      }),
    ]);
    const tenant = await superQuery<{ action: string }>(
      `SELECT action FROM audit.event WHERE workspace_id = $1
          AND action IN ('workspace.created', 'membership.created', 'auth.login') ORDER BY seq`,
      [wsId],
    );
    expect(tenant.map((r) => r.action)).toEqual([
      "membership.created",
      "workspace.created",
      "auth.login",
    ]);
    // Single use.
    const replay = await post("/verify", { email: "founder@newco.test", code });
    expect(replay.status).toBe(400);
  });

  it("a known address gets the same answer and simply owns one more workspace", async () => {
    const existing = await provisionUser(running.container.identityDeps, {
      email: "serial@founder.test",
    });
    const code = await startAndCode("serial@founder.test", "second-co");
    const res = await post("/verify", { email: "serial@founder.test", code });
    expect(res.status).toBe(201);
    expect(Object.keys((await res.json()) as object)).toEqual(["workspaceUrl"]);
    const owners = await superQuery<{ user_id: string }>(
      `SELECT m.user_id::text FROM core.membership m JOIN core.workspace w ON w.id = m.workspace_id
        WHERE w.slug = 'second-co' AND m.role = 'owner'`,
    );
    expect(owners).toEqual([{ user_id: existing.userId }]);
  });

  it("dies after 5 wrong codes", async () => {
    const code = await startAndCode("guesser@x.test", "guess-co");
    for (let i = 0; i < 5; i++) {
      expect((await post("/verify", { email: "guesser@x.test", code: "111111" })).status).toBe(400);
    }
    const last = await post("/verify", { email: "guesser@x.test", code });
    expect(last.status).toBe(429);
    expect(await errorCode(last)).toBe("too_many_attempts");
    expect(await superQuery(`SELECT id FROM core.workspace WHERE slug = 'guess-co'`)).toEqual([]);
  });

  it("spends 30 verifies per client address per hour, whatever the address guessed (R1-M2)", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const res = await post(
        "/verify",
        { email: `spray${i}@x.test`, code: "111111" },
        CANON,
        "10.202.3.3",
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("a slug that went meanwhile is 409 slug_taken with nothing created, and the code stays usable", async () => {
    const code = await startAndCode("late@taken.test", "taken");
    const res = await post("/verify", { email: "late@taken.test", code });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("slug_taken");
    expect(
      await superQuery(
        `SELECT u.id FROM core.user_identity u WHERE u.identifier = 'late@taken.test'`,
      ),
    ).toEqual([]);
    const reserved = await startAndCode("sneaky@x.test", "www");
    expect(await errorCode(await post("/verify", { email: "sneaky@x.test", code: reserved }))).toBe(
      "slug_taken",
    );
  });

  it("two signups racing for one slug: one 201, one 409, no half-created rows", async () => {
    const codeA = await startAndCode("a@race.test", "race");
    const codeB = await startAndCode("b@race.test", "race");
    const [a, b] = await Promise.all([
      post("/verify", { email: "a@race.test", code: codeA }),
      post("/verify", { email: "b@race.test", code: codeB }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await superQuery(`SELECT id FROM core.workspace WHERE slug = 'race'`)).toHaveLength(1);
    const users = await superQuery<{ identifier: string }>(
      `SELECT identifier::text FROM core.user_identity WHERE identifier IN ('a@race.test', 'b@race.test')`,
    );
    // Only the winner's user exists: the loser's was created in the transaction that rolled back.
    expect(users).toHaveLength(1);
    const memberships = await superQuery(
      `SELECT m.id FROM core.membership m JOIN core.user_identity ui ON ui.user_id = m.user_id
        WHERE ui.identifier IN ('a@race.test', 'b@race.test')`,
    );
    expect(memberships).toHaveLength(1);
  });

  it("a missing or archived default plan is a clean 404 with nothing created", async () => {
    await superQuery(`UPDATE core.plan SET archived_at = now() WHERE id = 'starter'`);
    try {
      const code = await startAndCode("unlucky@plan.test", "plan-co");
      const res = await post("/verify", { email: "unlucky@plan.test", code });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
      expect(await superQuery(`SELECT id FROM core.workspace WHERE slug = 'plan-co'`)).toEqual([]);
      expect(
        await superQuery(
          `SELECT id FROM core.user_identity WHERE identifier = 'unlucky@plan.test'`,
        ),
      ).toEqual([]);
    } finally {
      await superQuery(`UPDATE core.plan SET archived_at = NULL WHERE id = 'starter'`);
    }
  });
});
