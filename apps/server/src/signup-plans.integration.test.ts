import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { SIGNUP_RATES } from "@fundroom/control-plane";
import { createWorkspace, PLATFORM_WORKSPACE_ID } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Signup and the catalogue (A-5, E-UP-4) end to end: `GET /signup/plans` lists only public,
 * unarchived plans with `paid` and no price ids, is cached briefly, rate-limited per client and a
 * plain 404 when signup is closed; `verify` puts the workspace on the chosen plan when it is
 * public and live and silently on the default otherwise (`requestedPlanId` in the audit); the
 * landing is `/admin/billing?plan=<id>` for a paid plan without a trial, `/setup` otherwise; the
 * terms version is configuration (`SIGNUP_TERMS_VERSION=2` here); and what the fresh signup
 * session can do on `POST /billing/checkout` (D3) against a fake Stripe.
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let stripeServer: Server | undefined;
let ipCounter = 0;
const stripeCalls: string[] = [];

/** Just enough Stripe for a checkout: a customer, then a checkout session. */
function startFakeStripe(): Promise<number> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://stripe.local").pathname;
      stripeCalls.push(`${req.method} ${path}`);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && path === "/v1/customers") {
        return send(200, { id: `cus_${stripeCalls.length}`, object: "customer" });
      }
      if (req.method === "POST" && path === "/v1/checkout/sessions") {
        return send(200, {
          id: "cs_signup",
          object: "checkout.session",
          url: "https://checkout.stripe.test/c/pay/cs_signup",
        });
      }
      return send(404, { error: { type: "invalid_request_error" } });
    });
  });
  stripeServer = server;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

async function request(
  host: string,
  path: string,
  init: RequestInit & { cookie?: string | undefined; ip?: string | undefined } = {},
  server: RunningServer = running,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("accept", "application/json");
  // A fresh /24 per request unless the test names an address (the per-client budgets).
  const n = ipCounter++;
  headers.set("x-forwarded-for", init.ip ?? `10.${Math.floor(n / 250) % 250}.${n % 250}.9`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `https://${host}`);
  return server.app.request(`https://${host}${path}`, { ...init, headers });
}

const post = (path: string, body: unknown, server: RunningServer = running) =>
  request(CANON, `/api/v1/signup${path}`, { method: "POST", body: JSON.stringify(body) }, server);

async function errorOf(res: Response): Promise<Record<string, unknown>> {
  return ((await res.clone().json()) as { error: Record<string, unknown> }).error;
}

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await pg.pool.query(text, params)).rows as T[];
}

const application = (email: string, slug: string, termsVersion = 2) => ({
  email,
  companyName: `${slug} Inc`,
  legalName: `${slug} Holdings GmbH`,
  country: "DE",
  slug,
  acceptTerms: true,
  termsVersion,
});

/** start → the emailed code. */
async function startAndCode(
  email: string,
  slug: string,
  server: RunningServer = running,
  mail: MemoryMailer = mailer,
): Promise<string> {
  const since = mail.sent.length;
  expect((await post("/start", application(email, slug), server)).status).toBe(200);
  return awaitSignInCode(mail, email, since);
}

/** start → code → verify (with `planId` when given); the verify response. */
async function signUp(
  email: string,
  slug: string,
  planId?: string,
  server: RunningServer = running,
  mail: MemoryMailer = mailer,
): Promise<Response> {
  const code = await startAndCode(email, slug, server, mail);
  return post("/verify", { email, code, ...(planId === undefined ? {} : { planId }) }, server);
}

/**
 * A second server over the same database (no migrations), signup open, with `extra` over the
 * main server's settings (`undefined` drops a key); stopped after `fn`.
 */
async function withServer(
  extra: Record<string, string | undefined>,
  fn: (server: RunningServer, mail: MemoryMailer) => Promise<void>,
): Promise<void> {
  const mail = createMemoryMailer();
  const server = await startServer({
    config: loadConfig({
      env: env(stripePort, {
        SIGNUP_MODE: "open",
        SIGNUP_DEFAULT_PLAN: "free",
        SIGNUP_TERMS_VERSION: "2",
        ...extra,
      }),
    }),
    logger: createLogger({ level: "error" }),
    mailer: mail,
    listenEnabled: false,
    migrate: false,
    announceSetup: false,
  });
  try {
    await fn(server, mail);
  } finally {
    await server.stop();
  }
}

async function planOf(slug: string): Promise<string | undefined> {
  return (
    await sql<{ plan_id: string }>(`SELECT plan_id FROM core.workspace WHERE slug = $1`, [slug])
  )[0]?.plan_id;
}

async function completeMeta(slug: string): Promise<Record<string, unknown> | undefined> {
  return (
    await sql<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE workspace_id = $1 AND action = 'signup.complete'
          AND meta->>'slug' = $2`,
      [PLATFORM_WORKSPACE_ID, slug],
    )
  )[0]?.meta;
}

/** One key for every server here: a code issued by one server verifies on another. */
const SECRET_KEY = randomBytes(32).toString("base64");

function env(port: number, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const all: Record<string, string | undefined> = {
    APP_ENV: "test",
    LOG_LEVEL: "error",
    BASE_URL: BASE,
    DATABASE_URL: pg.connectionString,
    DATABASE_POOL_MAX: process.env["FUNDROOM_TEST_POOL_MAX"] ?? "6",
    FUNDROOM_SECRET_KEY: SECRET_KEY,
    STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
    DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
    TENANCY_MODE: "multi",
    CONTROL_PLANE: "on",
    BILLING_DRIVER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_signup",
    STRIPE_WEBHOOK_SECRET: "whsec_signup_test",
    STRIPE_API_BASE: `http://127.0.0.1:${port}`,
    OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
    TRUST_PROXY: "true",
    ROLES: "api",
    UPDATE_CHECK: "false",
    ...extra,
  };
  return Object.fromEntries(
    Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

let stripePort: number;

const MANUAL = { BILLING_DRIVER: "manual" };
const NO_BILLING = {
  BILLING_DRIVER: "none",
  STRIPE_SECRET_KEY: undefined,
  STRIPE_WEBHOOK_SECRET: undefined,
  STRIPE_API_BASE: undefined,
};

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  stripePort = await startFakeStripe();
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: env(stripePort, {
      SIGNUP_MODE: "open",
      SIGNUP_DEFAULT_PLAN: "free",
      SIGNUP_TERMS_VERSION: "2",
    }),
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
  // Created one after another so the catalogue order (oldest first) is this order.
  for (const [id, name, price, trial, pub, archived] of [
    ["free", "Free", null, 0, true, false],
    ["trial", "Trial", "price_trial", 14, true, false],
    ["pro", "Pro", "price_pro", 0, true, false],
    ["hidden", "Hidden", "price_hidden", 0, false, false],
    ["old", "Old", "price_old", 0, true, true],
  ] as const) {
    await sql(
      `INSERT INTO core.plan (id, name, limits, billing_price_ref, trial_days, public, archived_at, created_at)
       VALUES ($1, $2, '{"staffSeats": 3}', $3, $4, $5, CASE WHEN $6 THEN now() END, clock_timestamp())`,
      [id, name, price, trial, pub, archived],
    );
  }
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await new Promise((resolve) => stripeServer?.close(resolve));
  await pg?.stop();
});

describe("GET /signup/plans", () => {
  it("lists public, unarchived plans in catalogue order, with `paid` and no price ids", async () => {
    const res = await request(CANON, "/api/v1/signup/plans");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = (await res.json()) as { plans: Record<string, unknown>[] };
    expect(body).toEqual({
      plans: [
        { id: "free", name: "Free", limits: { staffSeats: 3 }, trialDays: 0, paid: false },
        { id: "trial", name: "Trial", limits: { staffSeats: 3 }, trialDays: 14, paid: true },
        { id: "pro", name: "Pro", limits: { staffSeats: 3 }, trialDays: 0, paid: true },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("price_");
  });

  it("is a plain 404 on a tenant host", async () => {
    const res = await request(`taken.${CANON}`, "/api/v1/signup/plans");
    expect(res.status).toBe(404);
    expect((await errorOf(res))["code"]).toBe("not_found");
  });

  it("is a plain 404 when signup is closed", async () => {
    await withServer({ SIGNUP_MODE: undefined }, async (closed) => {
      const res = await request(CANON, "/api/v1/signup/plans", {}, closed);
      expect(res.status).toBe(404);
      expect((await errorOf(res))["code"]).toBe("not_found");
    });
  });

  it("nothing is `paid` when workspaces cannot subscribe themselves (manual or no billing)", async () => {
    for (const extra of [MANUAL, NO_BILLING]) {
      await withServer(extra, async (server) => {
        const res = await request(CANON, "/api/v1/signup/plans", {}, server);
        expect(res.status).toBe(200);
        const { plans } = (await res.json()) as { plans: { id: string; paid: boolean }[] };
        expect(plans.map((p) => [p.id, p.paid])).toEqual([
          ["free", false],
          ["trial", false],
          ["pro", false],
        ]);
      });
    }
  });

  it("is rate-limited per client (30 a minute; an IPv6 client is its /64), with Retry-After", async () => {
    expect(SIGNUP_RATES.plansPerIp.max).toBe(30);
    for (const ipOf of [
      () => "10.98.98.98",
      (i: number) => `2001:db8:5:5::${(i + 1).toString(16)}`,
    ]) {
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 31; i++) {
        last = await request(CANON, "/api/v1/signup/plans", { ip: ipOf(i) });
        statuses.push(last.status);
      }
      expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
      expect(statuses[30]).toBe(429);
      expect((await errorOf(last as Response))["code"]).toBe("rate_limited");
      expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    }
  });
});

describe("terms version from configuration (SIGNUP_TERMS_VERSION=2)", () => {
  it("refuses a client still showing version 1, naming the current one", async () => {
    const res = await post("/start", application("stale@terms.test", "stale-terms", 1));
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({
      code: "conflict",
      reason: "terms_version",
      current: 2,
    });
  });

  it("a version raised between start and verify refuses the code, with nothing created", async () => {
    const code = await startAndCode("raised@terms.test", "terms-raised");
    await withServer({ SIGNUP_TERMS_VERSION: "3" }, async (server) => {
      const res = await post("/verify", { email: "raised@terms.test", code }, server);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toMatchObject({
        code: "conflict",
        reason: "terms_version",
        current: 3,
      });
    });
    expect(await sql(`SELECT id FROM core.workspace WHERE slug = 'terms-raised'`)).toEqual([]);
    expect(
      await sql(`SELECT user_id FROM core.user_identity WHERE identifier = 'raised@terms.test'`),
    ).toEqual([]);
  });

  it("records the attestation as platform-terms:v2", async () => {
    const res = await signUp("ok@terms.test", "terms-v2");
    expect(res.status).toBe(201);
    const attest = await sql<{ kind: string; data: Record<string, unknown> }>(
      `SELECT a.kind, a.data FROM core.attestation a JOIN core.workspace w ON w.id = a.workspace_id
        WHERE w.slug = 'terms-v2'`,
    );
    expect(attest).toEqual([
      { kind: "platform-terms:v2", data: expect.objectContaining({ termsVersion: 2 }) },
    ]);
  });
});

describe("POST /signup/verify: plan choice and landing", () => {
  it("no planId: the default plan, landing on /setup", async () => {
    const res = await signUp("none@plan.test", "plan-none");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ workspaceUrl: `https://plan-none.${CANON}/setup` });
    expect(await planOf("plan-none")).toBe("free");
    expect(await completeMeta("plan-none")).not.toHaveProperty("requestedPlanId");
  });

  it("a public paid plan with a trial is used; landing on /setup", async () => {
    const res = await signUp("trial@plan.test", "plan-trial", "trial");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ workspaceUrl: `https://plan-trial.${CANON}/setup` });
    expect(await planOf("plan-trial")).toBe("trial");
    const meta = await completeMeta("plan-trial");
    expect(meta).toMatchObject({ planId: "trial" });
    expect(meta).not.toHaveProperty("requestedPlanId");
  });

  it("a private, archived or unknown plan falls back to the default silently (audited)", async () => {
    for (const [i, planId] of ["hidden", "old", "nosuch"].entries()) {
      const slug = `plan-fallback-${i}`;
      const res = await signUp(`fallback${i}@plan.test`, slug, planId);
      expect(res.status, planId).toBe(201);
      expect(await res.json()).toEqual({ workspaceUrl: `https://${slug}.${CANON}/setup` });
      expect(await planOf(slug)).toBe("free");
      expect(await completeMeta(slug)).toMatchObject({ planId: "free", requestedPlanId: planId });
    }
  });

  it("a plan archived between the read and provisioning falls back to the default", async () => {
    await sql(
      `INSERT INTO core.plan (id, name, limits, billing_price_ref, trial_days, public)
       VALUES ('flaky', 'Flaky', '{}', 'price_flaky', 0, true)`,
    );
    const db = running.container.db;
    const withHost = db.withHost;
    // Archive the plan right after verify has read it as choosable.
    db.withHost = (async (fn: Parameters<typeof withHost>[0]) => {
      const out = await withHost.call(db, fn);
      if ((out as { id?: unknown } | undefined)?.id === "flaky") {
        await sql(`UPDATE core.plan SET archived_at = now() WHERE id = 'flaky'`);
      }
      return out;
    }) as typeof withHost;
    try {
      const res = await signUp("flaky@plan.test", "plan-flaky", "flaky");
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ workspaceUrl: `https://plan-flaky.${CANON}/setup` });
    } finally {
      db.withHost = withHost;
    }
    expect(await planOf("plan-flaky")).toBe("free");
    expect(await completeMeta("plan-flaky")).toMatchObject({
      planId: "free",
      requestedPlanId: "flaky",
    });
  });

  it("the fallback re-claims the slug as the same workspace when the first release failed", async () => {
    await sql(
      `INSERT INTO core.plan (id, name, limits, billing_price_ref, trial_days, public)
       VALUES ('flaky2', 'Flaky 2', '{}', 'price_flaky2', 0, true)`,
    );
    const provisioning = running.container.controlPlane.operators.signup.provisioning;
    const realDirectory = provisioning.directory;
    // A shared directory in miniature (the `claimSlug` rules of @fundroom/directory: a live slug
    // held by another workspace id is taken, the same id's claim is idempotent) whose release is
    // down — so the first claim stays reserved.
    const entries = new Map<string, string>();
    const claims: string[] = [];
    const directory = {
      ...realDirectory,
      async claimSlug(input: { workspaceId: string; slug: string }) {
        claims.push(input.workspaceId);
        const holder = entries.get(input.slug);
        if (holder !== undefined && holder !== input.workspaceId) return "taken" as const;
        entries.set(input.slug, input.workspaceId);
        return "claimed" as const;
      },
      async activate() {},
      async release() {
        throw new Error("directory down");
      },
    };
    const db = running.container.db;
    const withHost = db.withHost;
    db.withHost = (async (fn: Parameters<typeof withHost>[0]) => {
      const out = await withHost.call(db, fn);
      if ((out as { id?: unknown } | undefined)?.id === "flaky2") {
        await sql(`UPDATE core.plan SET archived_at = now() WHERE id = 'flaky2'`);
      }
      return out;
    }) as typeof withHost;
    Object.assign(provisioning, { directory });
    try {
      const res = await signUp("flaky2@plan.test", "plan-flaky2", "flaky2");
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ workspaceUrl: `https://plan-flaky2.${CANON}/setup` });
    } finally {
      db.withHost = withHost;
      Object.assign(provisioning, { directory: realDirectory });
    }
    expect(claims).toHaveLength(2);
    expect(claims[1]).toBe(claims[0]);
    const [ws] = await sql<{ id: string; plan_id: string }>(
      `SELECT id::text, plan_id FROM core.workspace WHERE slug = 'plan-flaky2'`,
    );
    expect(ws).toEqual({ id: claims[0], plan_id: "free" });
  });

  it("manual or no billing: a priced plan without a trial lands on /setup", async () => {
    for (const [i, extra] of [MANUAL, NO_BILLING].entries()) {
      await withServer(extra, async (server, mail) => {
        const slug = `plan-nostripe-${i}`;
        const res = await signUp(`nostripe${i}@plan.test`, slug, "pro", server, mail);
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ workspaceUrl: `https://${slug}.${CANON}/setup` });
        expect(await planOf(slug)).toBe("pro");
      });
    }
  });

  it("a private default plan (priced, no trial) lands on /setup: the billing page offers only public plans", async () => {
    await withServer({ SIGNUP_DEFAULT_PLAN: "hidden" }, async (server, mail) => {
      const res = await signUp("private@plan.test", "plan-private", undefined, server, mail);
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ workspaceUrl: `https://plan-private.${CANON}/setup` });
      expect(await planOf("plan-private")).toBe("hidden");
    });
  });

  it("a paid plan without a trial lands on the billing page, and the fresh session's checkout (D3)", async () => {
    const res = await signUp("owner@paid.test", "plan-paid", "pro");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      workspaceUrl: `https://plan-paid.${CANON}/admin/billing?plan=pro`,
    });
    expect(await planOf("plan-paid")).toBe("pro");
    const host = `plan-paid.${CANON}`;
    let cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] ?? "")
      .join("; ");
    const checkout = () =>
      request(host, "/api/v1/billing/checkout", {
        method: "POST",
        cookie,
        body: JSON.stringify({ planId: "pro" }),
      });
    // The signup session is level 1 (an email code) and an owner needs level 2 (MFA) on every
    // staff route, so the billing page and checkout both ask for the step-up first.
    for (const refused of [await request(host, "/api/v1/billing", { cookie }), await checkout()]) {
      expect(refused.status).toBe(403);
      expect(await errorOf(refused)).toMatchObject({
        code: "step_up_required",
        reason: "level",
        requiredLevel: 2,
        currentLevel: 1,
      });
    }
    // Enrolling TOTP on that same session (the SPA's step-up path) makes it level 2 and fresh.
    const enrol = await request(host, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
    expect(enrol.status).toBe(200);
    const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
    const confirm = await request(host, "/api/v1/auth/totp/enrol/confirm", {
      method: "POST",
      cookie,
      body: JSON.stringify({ code: totp.generate() }),
    });
    expect(confirm.status).toBe(200);
    cookie = withSetCookies(cookie, confirm);
    expect((await request(host, "/api/v1/billing", { cookie })).status).toBe(200);
    const ok = await checkout();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ url: "https://checkout.stripe.test/c/pay/cs_signup" });
    expect(stripeCalls).toEqual(["POST /v1/customers", "POST /v1/checkout/sessions"]);
  });
});
