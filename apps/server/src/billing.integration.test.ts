import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { setWorkspaceHold } from "@fundroom/control-plane";
import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BillingKernel } from "./control-plane/billing-wiring.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitMail, awaitSignInCode } from "./test/sign-in-mail.js";
import { restoreWorkspace } from "./workspace/lifecycle.js";

/*
 * Billing (E3.10 §5.4, agent B) end to end, against a fake Stripe (`STRIPE_API_BASE`) and signed
 * webhooks: the gate (404 after the permission guard), checkout / portal (URLs on the BASE_URL
 * host, the customer stored before anybody can pay), the webhook (cap, signature, dedupe,
 * re-read, ordering, mapping only from our own ids — forged metadata, cross-customer events),
 * grace → suspension → payment → unsuspension, precedence over operator and sanctions
 * suspensions, the provisioning hook, the usage report, retention; then the manual driver's
 * operator route on a second server over the same database.
 *
 * The main server runs on ONE pool connection (lock order: a nested transaction or a lock held
 * across a second checkout hangs the suite instead of passing by luck).
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
const WHSEC = "whsec_billing_test_secret";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const ids: Record<string, string> = {};

// --- fake Stripe --------------------------------------------------------------------------------

interface StripeCall {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly form: URLSearchParams;
}

const stripe = {
  server: undefined as Server | undefined,
  calls: [] as StripeCall[],
  subs: new Map<string, Record<string, unknown>>(),
  customers: 0,
  /** Awaited before a checkout session is answered (a test interleaves work there). */
  onCheckout: undefined as (() => Promise<void>) | undefined,
  /** DELETE /v1/subscriptions/{id} answers 500 this many more times. */
  failDeletes: 0,
  /** The next DELETE finds the subscription canceled meanwhile (400, as Stripe answers). */
  cancelRace: false,
  /** Billing meters by id → their event name. */
  meters: new Map([
    // Seats on the default event name; storage on an operator-chosen one (BILLING_METER_*_EVENT).
    ["mtr_seats", "fundroom_staff_seats"],
    ["mtr_gb", "acme_storage_gb"],
    // A-2: a meter created before the rename, still on the old default event name.
    ["mtr_legacy", "seedhost_staff_seats"],
  ]),
};

/** Warn-and-above log lines of the main server (JSON), for asserting operator-facing warnings. */
const logLines: Record<string, unknown>[] = [];
const logSink = {
  write(line: string) {
    logLines.push(JSON.parse(line) as Record<string, unknown>);
  },
};

function startFakeStripe(): Promise<number> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://stripe.local");
      const call = {
        method: req.method ?? "GET",
        path: url.pathname,
        headers: req.headers,
        form: new URLSearchParams(body),
      };
      stripe.calls.push(call);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== "Bearer sk_test_billing") {
        return send(401, { error: { type: "invalid_request_error" } });
      }
      if (call.method === "POST" && call.path === "/v1/customers") {
        stripe.customers += 1;
        return send(200, { id: `cus_new${stripe.customers}`, object: "customer" });
      }
      if (call.method === "POST" && call.path === "/v1/checkout/sessions") {
        await stripe.onCheckout?.();
        return send(200, {
          id: "cs_1",
          object: "checkout.session",
          url: "https://checkout.stripe.test/c/pay/cs_1",
        });
      }
      if (call.method === "POST" && call.path === "/v1/billing_portal/sessions") {
        return send(200, { id: "bps_1", url: "https://billing.stripe.test/p/session/x" });
      }
      if (call.method === "POST" && call.path === "/v1/billing/meter_events") {
        return send(200, { object: "billing.meter_event" });
      }
      const meter = /^\/v1\/billing\/meters\/([^/]+)$/u.exec(call.path);
      if (call.method === "GET" && meter?.[1] !== undefined) {
        const name = stripe.meters.get(decodeURIComponent(meter[1]));
        return name === undefined
          ? send(404, { error: { type: "invalid_request_error", code: "resource_missing" } })
          : send(200, { id: meter[1], object: "billing.meter", event_name: name });
      }
      const sub = /^\/v1\/subscriptions\/([^/]+)$/u.exec(call.path);
      if (call.method === "DELETE" && sub?.[1] !== undefined) {
        const found = stripe.subs.get(decodeURIComponent(sub[1]));
        if (stripe.cancelRace && found !== undefined) {
          stripe.cancelRace = false;
          found["status"] = "canceled";
          return send(400, { error: { type: "invalid_request_error" } });
        }
        if (stripe.failDeletes > 0) {
          stripe.failDeletes -= 1;
          return send(500, { error: { type: "api_error" } });
        }
        if (found === undefined || found["status"] === "canceled") {
          return send(400, { error: { type: "invalid_request_error" } });
        }
        found["status"] = "canceled";
        return send(200, found);
      }
      if (call.method === "GET" && sub?.[1] !== undefined) {
        const found = stripe.subs.get(decodeURIComponent(sub[1]));
        return found === undefined
          ? send(404, { error: { type: "invalid_request_error", code: "resource_missing" } })
          : send(200, found);
      }
      return send(404, { error: { type: "invalid_request_error" } });
    });
  });
  stripe.server = server;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

const T0 = Math.floor(Date.now() / 1000);

function setSub(
  id: string,
  fields: {
    customer: string;
    status: string;
    workspaceId?: string | undefined;
    price?: string | undefined;
    periodEnd?: number | undefined;
    /** Metered items: their price bills on the meter (`recurring.meter`, see `stripe.meters`). */
    metered?: readonly { price: string; meter: string }[] | undefined;
  },
) {
  stripe.subs.set(id, {
    id,
    object: "subscription",
    customer: fields.customer,
    status: fields.status,
    metadata: fields.workspaceId === undefined ? {} : { workspace_id: fields.workspaceId },
    cancel_at_period_end: false,
    trial_end: null,
    items: {
      data: [
        {
          price: { id: fields.price ?? "price_starter" },
          current_period_end: fields.periodEnd ?? T0 + 30 * 86_400,
        },
        ...(fields.metered ?? []).map((m) => ({
          price: { id: m.price, recurring: { usage_type: "metered", meter: m.meter } },
          current_period_end: fields.periodEnd ?? T0 + 30 * 86_400,
        })),
      ],
    },
  });
}

const getsOf = (id: string) =>
  stripe.calls.filter((c) => c.method === "GET" && c.path === `/v1/subscriptions/${id}`).length;

// --- webhooks -------------------------------------------------------------------------------------

let eventSeq = 0;

function subscriptionEvent(subId: string, created: number, id = `evt_${++eventSeq}`) {
  return {
    id,
    object: "event",
    type: "customer.subscription.updated",
    created,
    data: { object: stripe.subs.get(subId) },
  };
}

function checkoutEvent(input: {
  workspaceId: string;
  customer: string;
  subscription: string;
  created: number;
}) {
  return {
    id: `evt_${++eventSeq}`,
    object: "event",
    type: "checkout.session.completed",
    created: input.created,
    data: {
      object: {
        id: "cs_1",
        object: "checkout.session",
        mode: "subscription",
        client_reference_id: input.workspaceId,
        customer: input.customer,
        subscription: input.subscription,
        metadata: { workspace_id: input.workspaceId },
      },
    },
  };
}

function signature(body: string, t = Math.floor(Date.now() / 1000), secret = WHSEC): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function deliver(
  event: unknown,
  opts: { header?: string | null; body?: string } = {},
): Promise<Response> {
  const body = opts.body ?? JSON.stringify(event);
  const headers = new Headers({ host: CANON, "content-type": "application/json" });
  const header = opts.header === undefined ? signature(body) : opts.header;
  if (header !== null) headers.set("stripe-signature", header);
  return running.app.request(`https://${CANON}/webhooks/billing/stripe`, {
    method: "POST",
    headers,
    body,
  });
}

// --- requests and members ---------------------------------------------------------------------

async function request(
  host: string,
  path: string,
  init: RequestInit & { cookie?: string | undefined } = {},
  server: RunningServer = running,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `https://${host}`);
  return server.app.request(`https://${host}${path}`, { ...init, headers });
}

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");

async function member(
  slug: string,
  email: string,
  kind: "staff" | "external",
  role: string,
  server: RunningServer = running,
  mail: MemoryMailer = mailer,
): Promise<{ cookie: string; userId: string }> {
  const deps = server.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, {
    workspaceId: ids[slug] as string,
    userId,
    kind,
    role: role as never,
    source: "test",
  });
  const host = `${slug}.${CANON}`;
  const since = mail.sent.length;
  const start = await request(
    host,
    "/api/v1/auth/otp/start",
    { method: "POST", body: JSON.stringify({ email }) },
    server,
  );
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mail, email, since);
  const verify = await request(
    host,
    "/api/v1/auth/otp/verify",
    { method: "POST", body: JSON.stringify({ email, code }) },
    server,
  );
  expect(verify.status).toBe(200);
  const cookie = cookiesOf(verify);
  if (kind === "external") return { cookie, userId };
  // Staff of a workspace sign in at level 2 (TOTP), fresh: what checkout's step-up asks for.
  const enrol = await request(host, "/api/v1/auth/totp/enrol", { method: "POST", cookie }, server);
  const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request(
    host,
    "/api/v1/auth/totp/enrol/confirm",
    { method: "POST", cookie, body: JSON.stringify({ code: totp.generate() }) },
    server,
  );
  expect(confirm.status).toBe(200);
  return { cookie: withSetCookies(cookie, confirm), userId };
}

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await pg.pool.query(text, params)).rows as T[];
}

/** A write to the workspace's control-plane columns, as the host (the guard trigger's rule). */
async function hostSql(text: string, params: unknown[] = []): Promise<void> {
  const client = await pg.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_kind', 'host', true)");
    await client.query(text, params);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface SubRow {
  status: string;
  plan_id: string;
  provider: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  grace_until: Date | null;
  last_event_at: Date | null;
  trial_end: Date | null;
}

async function subOf(slug: string): Promise<SubRow | undefined> {
  return (
    await sql<SubRow>("SELECT * FROM core.subscription WHERE workspace_id = $1", [ids[slug]])
  )[0];
}

async function wsOf(slug: string) {
  return (
    await sql<{ status: string; suspended_reason: string | null; plan_id: string | null }>(
      "SELECT status, suspended_reason, plan_id FROM core.workspace WHERE id = $1",
      [ids[slug]],
    )
  )[0];
}

async function suspend(slug: string, reason: "operator" | "sanctions") {
  const { db, audit, resolver } = running.container;
  const change = await db.withHost((tx) =>
    setWorkspaceHold(
      tx,
      {
        workspaceId: ids[slug] as string,
        hold: reason,
        on: true,
        actor: { kind: "system", source: "cli" },
      },
      { audit, invalidate: () => resolver.invalidate() },
    ),
  );
  change.afterCommit();
}

const billing = (server: RunningServer = running): BillingKernel => server.container.billing;

let owner: { cookie: string; userId: string };
let finance: { cookie: string; userId: string };
let viewer: { cookie: string; userId: string };
let otherOwner: { cookie: string; userId: string };
let port: number;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  port = await startFakeStripe();
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      DATABASE_POOL_MAX: "1",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      CONTROL_PLANE: "on",
      BILLING_DRIVER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_billing",
      STRIPE_WEBHOOK_SECRET: WHSEC,
      STRIPE_API_BASE: `http://127.0.0.1:${port}`,
      OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
      BILLING_GRACE_DAYS: "14",
      // A-2: the storage meter's event name comes from config; seats keeps its default.
      BILLING_METER_STORAGE_EVENT: "acme_storage_gb",
      ROLES: "api",
      UPDATE_CHECK: "false",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn", destination: logSink }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  await sql(
    `INSERT INTO core.plan (id, name, limits, billing_price_ref, trial_days, public) VALUES
       ('starter', 'Starter', '{"staffSeats": 5}', 'price_starter', 0, true),
       ('pro', 'Pro', '{}', 'price_pro', 0, true),
       ('trial', 'Trial', '{}', 'price_trial', 14, true),
       ('free', 'Free', '{}', NULL, 0, true),
       ('hidden', 'Hidden', '{}', 'price_hidden', 0, false)`,
  );
  const db = running.container.db;
  for (const slug of ["acme", "other", "held", "opsus", "hooked"]) {
    ids[slug] = (await createWorkspace(db, { slug, name: slug.toUpperCase() })).id;
  }
  owner = await member("acme", "owner@acme.test", "staff", "owner");
  finance = await member("acme", "finance@acme.test", "staff", "finance");
  viewer = await member("acme", "viewer@acme.test", "staff", "viewer");
  otherOwner = await member("other", "owner@other.test", "staff", "owner");
  await member("held", "owner@held.test", "staff", "owner");
  await member("opsus", "owner@opsus.test", "staff", "owner");
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await new Promise((resolve) => stripe.server?.close(resolve));
  await pg?.stop();
});

describe("tenant billing routes", () => {
  const acme = () => `acme.${CANON}`;

  it("answers the billing page to billing.read holders; the permission guard answers first", async () => {
    const res = await request(acme(), "/api/v1/billing", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      driver: string;
      subscription: unknown;
      plans: { id: string }[];
      canManage: boolean;
    };
    expect(body.driver).toBe("stripe");
    expect(body.subscription).toBeNull();
    expect(body.canManage).toBe(true);
    // Public plans only.
    expect(body.plans.map((p) => p.id).sort()).toEqual(["free", "pro", "starter", "trial"]);
    const fin = await request(acme(), "/api/v1/billing", { cookie: finance.cookie });
    expect(fin.status).toBe(200);
    expect(((await fin.json()) as { canManage: boolean }).canManage).toBe(false);
    expect((await request(acme(), "/api/v1/billing", { cookie: viewer.cookie })).status).toBe(403);
    const checkout = await request(acme(), "/api/v1/billing/checkout", {
      method: "POST",
      cookie: finance.cookie,
      body: JSON.stringify({ planId: "starter" }),
    });
    expect(checkout.status).toBe(403);
  });

  it("404s every route when billing is off — after the permission guard", async () => {
    const kernel = billing();
    const saved = kernel.enabled;
    Object.assign(kernel, { enabled: false });
    try {
      const res = await request(acme(), "/api/v1/billing", { cookie: owner.cookie });
      expect(res.status).toBe(404);
      // The gate's own message, never the authz guard's "no such path" (the sweep tells them apart).
      const gate = (await res.json()) as { error: { code: string; message: string } };
      expect(gate.error).toMatchObject({
        code: "not_found",
        message: "billing is not enabled on this install",
      });
      // A member without the permission still gets the authz answer, not the gate's.
      expect((await request(acme(), "/api/v1/billing", { cookie: viewer.cookie })).status).toBe(
        403,
      );
      const portal = await request(acme(), "/api/v1/billing/portal", {
        method: "POST",
        cookie: owner.cookie,
      });
      expect(portal.status).toBe(404);
      // The webhook endpoint does not exist either.
      expect((await deliver(subscriptionEvent("sub_none", T0))).status).toBe(404);
    } finally {
      Object.assign(kernel, { enabled: saved });
    }
  });

  it("refuses a plan that is not public, not priced, or not there", async () => {
    for (const [planId, status, code] of [
      ["hidden", 404, "not_found"],
      ["nope", 404, "not_found"],
      ["free", 409, "billing_unavailable"],
    ] as const) {
      const res = await request(acme(), "/api/v1/billing/checkout", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ planId }),
      });
      expect(res.status).toBe(status);
      expect(await errorCode(res)).toBe(code);
    }
    // The portal needs a customer first.
    const portal = await request(acme(), "/api/v1/billing/portal", {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(portal.status).toBe(409);
  });

  it("starts a checkout: customer created and stored, URLs on the BASE_URL host, audited", async () => {
    // A verified custom domain must not become the return address.
    await sql(
      `INSERT INTO core.custom_domain (workspace_id, hostname, status, token, dns_ok_at, activated_at)
         VALUES ($1, 'invest.acme.test', 'active', $2, now(), now())`,
      [ids["acme"], "tok-billing".padEnd(20, "x")],
    );
    running.container.resolver.invalidate();
    running.container.customDomainLookup.invalidate();
    const before = stripe.calls.length;
    const res = await request(acme(), "/api/v1/billing/checkout", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ planId: "starter" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url: string }).url).toBe(
      "https://checkout.stripe.test/c/pay/cs_1",
    );
    const calls = stripe.calls.slice(before);
    expect(calls.map((c) => c.path)).toEqual(["/v1/customers", "/v1/checkout/sessions"]);
    const session = calls[1] as StripeCall;
    expect(session.headers["stripe-version"]).toBe("2026-08-26.dahlia");
    expect(session.headers["idempotency-key"]).toMatch(/^fundroom:checkout:.+:checkout$/u);
    expect(session.form.get("mode")).toBe("subscription");
    expect(session.form.get("customer")).toBe("cus_new1");
    expect(session.form.get("client_reference_id")).toBe(ids["acme"]);
    expect(session.form.get("subscription_data[metadata][workspace_id]")).toBe(ids["acme"]);
    expect(session.form.get("success_url")).toBe(
      `https://acme.${CANON}/admin/billing?checkout=success`,
    );
    expect(session.form.get("cancel_url")).toBe(
      `https://acme.${CANON}/admin/billing?checkout=cancel`,
    );
    expect(calls[0]?.form.get("email")).toBe("owner@acme.test");
    const row = await subOf("acme");
    expect(row).toMatchObject({
      status: "incomplete",
      provider: "stripe",
      plan_id: "starter",
      provider_customer_id: "cus_new1",
      provider_subscription_id: null,
    });
    const audit = await sql(
      "SELECT actor_kind, actor_user_id FROM audit.event WHERE workspace_id = $1 AND action = 'billing.checkout_start'",
      [ids["acme"]],
    );
    expect(audit).toEqual([{ actor_kind: "staff", actor_user_id: owner.userId }]);
    // A second attempt reuses the stored customer.
    const again = stripe.calls.length;
    await request(acme(), "/api/v1/billing/checkout", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ planId: "starter" }),
    });
    expect(stripe.calls.slice(again).map((c) => c.path)).toEqual(["/v1/checkout/sessions"]);
    expect(stripe.calls.at(-1)?.form.get("customer")).toBe("cus_new1");
  });

  it("opens the portal for the stored customer, returning to the BASE_URL host", async () => {
    const res = await request(acme(), "/api/v1/billing/portal", {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const call = stripe.calls.at(-1) as StripeCall;
    expect(call.path).toBe("/v1/billing_portal/sessions");
    expect(call.form.get("customer")).toBe("cus_new1");
    expect(call.form.get("return_url")).toBe(`https://acme.${CANON}/admin/billing`);
  });

  it("the manual operator route is refused with the stripe driver", async () => {
    const minted = await running.container.auth.sessions.startSession({
      userId: owner.userId,
      population: "operator",
      context: "first_party",
      authLevel: 2,
    });
    await sql("INSERT INTO core.platform_operator (user_id, created_by) VALUES ($1, 'cli:test')", [
      owner.userId,
    ]);
    const res = await request(CANON, `/api/v1/platform/workspaces/${ids["acme"]}/subscription`, {
      method: "POST",
      cookie: `__Host-op_sid=${minted.token}`,
      body: JSON.stringify({ status: "active" }),
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("billing_unavailable");
    await sql("DELETE FROM core.platform_operator WHERE user_id = $1", [owner.userId]);
  });
});

describe("the Stripe webhook", () => {
  it("verifies before anything: missing, bad, old signatures and oversize bodies", async () => {
    setSub("sub_1", { customer: "cus_new1", status: "active", workspaceId: ids["acme"] });
    const event = checkoutEvent({
      workspaceId: ids["acme"] as string,
      customer: "cus_new1",
      subscription: "sub_1",
      created: T0,
    });
    const body = JSON.stringify(event);
    const before = stripe.calls.length;
    const now = Math.floor(Date.now() / 1000);
    for (const header of [
      null,
      "garbage",
      signature(body, now, "whsec_wrong"),
      signature(body, now - 301),
      signature(body, now + 301),
      // v0 only: a downgrade.
      signature(body, now).replace("v1=", "v0="),
    ]) {
      const res = await deliver(event, { header });
      expect(res.status).toBe(400);
    }
    // A valid signature over a different body.
    expect((await deliver(event, { header: signature(`${body} `) })).status).toBe(400);
    const big = JSON.stringify({ ...event, pad: "x".repeat(256 * 1024) });
    expect((await deliver(event, { body: big, header: signature(big) })).status).toBe(413);
    // Nothing reached Stripe or the database.
    expect(stripe.calls.length).toBe(before);
    expect(await sql("SELECT id FROM core.billing_event")).toEqual([]);
    expect((await subOf("acme"))?.status).toBe("incomplete");
  });

  it("applies a completed checkout from the re-read, and ignores the replay", async () => {
    const event = checkoutEvent({
      workspaceId: ids["acme"] as string,
      customer: "cus_new1",
      subscription: "sub_1",
      created: T0,
    });
    const res = await deliver(event);
    expect(res.status).toBe(200);
    expect(getsOf("sub_1")).toBe(1);
    const row = await subOf("acme");
    expect(row).toMatchObject({
      status: "active",
      provider_customer_id: "cus_new1",
      provider_subscription_id: "sub_1",
      grace_until: null,
    });
    expect(row?.last_event_at?.getTime()).toBe(T0 * 1000);
    expect((await wsOf("acme"))?.plan_id).toBe("starter");
    const events = await sql("SELECT id, workspace_id FROM core.billing_event");
    expect(events).toEqual([{ id: event.id, workspace_id: ids["acme"] }]);
    // Replay: 200, no second Stripe read, no second audit row.
    expect((await deliver(event)).status).toBe(200);
    expect(getsOf("sub_1")).toBe(1);
    const audits = await sql(
      "SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = $1 AND action = 'subscription.update'",
      [ids["acme"]],
    );
    expect(audits).toEqual([{ n: 1 }]);
  });

  it("starts the grace period on past_due (mail), and ignores an older event", async () => {
    setSub("sub_1", { customer: "cus_new1", status: "past_due", workspaceId: ids["acme"] });
    const since = mailer.sent.length;
    expect((await deliver(subscriptionEvent("sub_1", T0 + 100))).status).toBe(200);
    const row = await subOf("acme");
    expect(row?.status).toBe("past_due");
    const grace = row?.grace_until?.getTime() ?? 0;
    expect(Math.abs(grace - (Date.now() + 14 * 86_400_000))).toBeLessThan(120_000);
    const mail = await awaitMail(mailer, {
      to: "owner@acme.test",
      since,
      match: (m) => m.tags?.includes("past-due") === true,
    });
    expect(mail.text).toContain(`https://acme.${CANON}/admin/billing`);
    expect(mail.text).not.toContain("invest.acme.test");
    // Finance holds billing.read but is not an owner: no mail.
    expect(mailer.sent.slice(since).some((m) => m.to === "finance@acme.test")).toBe(false);
    // An event created BEFORE the one applied is stale, even though Stripe now says active.
    setSub("sub_1", { customer: "cus_new1", status: "active", workspaceId: ids["acme"] });
    expect((await deliver(subscriptionEvent("sub_1", T0 + 50))).status).toBe(200);
    expect((await subOf("acme"))?.status).toBe("past_due");
    expect((await subOf("acme"))?.last_event_at?.getTime()).toBe((T0 + 100) * 1000);
    setSub("sub_1", { customer: "cus_new1", status: "past_due", workspaceId: ids["acme"] });
  });

  it("drops forged metadata and never maps another customer's subscription", async () => {
    // `other` has its own stored customer from its own checkout.
    const res = await request(`other.${CANON}`, "/api/v1/billing/checkout", {
      method: "POST",
      cookie: otherOwner.cookie,
      body: JSON.stringify({ planId: "pro" }),
    });
    expect(res.status).toBe(200);
    const otherRow = await subOf("other");
    expect(otherRow?.provider_customer_id).toBe("cus_new2");
    const acmeBefore = await subOf("acme");

    // 1. acme's customer, a new subscription whose metadata names `other`.
    setSub("sub_evil", { customer: "cus_new1", status: "active", workspaceId: ids["other"] });
    expect((await deliver(subscriptionEvent("sub_evil", T0 + 200))).status).toBe(200);
    // 2. a checkout that claims `other` for acme's customer.
    expect(
      (
        await deliver(
          checkoutEvent({
            workspaceId: ids["other"] as string,
            customer: "cus_new1",
            subscription: "sub_evil",
            created: T0 + 201,
          }),
        )
      ).status,
    ).toBe(200);
    // 3. an unknown customer naming `other`.
    setSub("sub_x", { customer: "cus_stranger", status: "active", workspaceId: ids["other"] });
    expect((await deliver(subscriptionEvent("sub_x", T0 + 202))).status).toBe(200);
    // 4. other's customer, metadata naming acme.
    setSub("sub_y", { customer: "cus_new2", status: "active", workspaceId: ids["acme"] });
    expect((await deliver(subscriptionEvent("sub_y", T0 + 203))).status).toBe(200);
    // 5. the event says acme's customer, the re-read says other's (no metadata to cross-check).
    setSub("sub_z", { customer: "cus_new2", status: "active" });
    const lying = subscriptionEvent("sub_z", T0 + 204);
    lying.data.object = { ...lying.data.object, customer: "cus_new1" };
    expect((await deliver(lying)).status).toBe(200);

    expect(await subOf("other")).toEqual(otherRow);
    expect(await subOf("acme")).toEqual(acmeBefore);
    expect((await wsOf("other"))?.plan_id).toBeNull();
  });

  it("suspends after grace, and a payment lifts the billing suspension", async () => {
    await sql(
      "UPDATE core.subscription SET grace_until = now() - interval '1 hour' WHERE workspace_id = $1",
      [ids["acme"]],
    );
    const since = mailer.sent.length;
    const summary = await billing().tasks?.enforce();
    expect(summary?.suspended).toBeGreaterThanOrEqual(1);
    expect(await wsOf("acme")).toMatchObject({ status: "suspended", suspended_reason: "billing" });
    await awaitMail(mailer, {
      to: "owner@acme.test",
      since,
      match: (m) => m.tags?.includes("suspended") === true,
    });
    // A suspended workspace still serves billing to its owner, nothing else to staff.
    const acme = `acme.${CANON}`;
    expect((await request(acme, "/api/v1/billing", { cookie: owner.cookie })).status).toBe(200);
    expect((await request(acme, "/api/v1/access/people", { cookie: owner.cookie })).status).toBe(
      423,
    );
    // Running it again changes nothing.
    expect((await billing().tasks?.enforce())?.suspended).toBe(0);

    setSub("sub_1", { customer: "cus_new1", status: "active", workspaceId: ids["acme"] });
    expect((await deliver(subscriptionEvent("sub_1", T0 + 300))).status).toBe(200);
    expect((await subOf("acme"))?.grace_until).toBeNull();
    expect(await wsOf("acme")).toMatchObject({ status: "active", suspended_reason: null });
    const actions = await sql<{ action: string }>(
      "SELECT action FROM audit.event WHERE workspace_id = $1 AND action LIKE 'workspace.%suspend' ORDER BY seq",
      [ids["acme"]],
    );
    expect(actions.map((a) => a.action)).toEqual(["workspace.suspend", "workspace.unsuspend"]);
  });

  it("never lifts or replaces an operator or sanctions suspension", async () => {
    for (const [slug, reason, customer, subId] of [
      ["held", "sanctions", "cus_held", "sub_held"],
      ["opsus", "operator", "cus_opsus", "sub_opsus"],
    ] as const) {
      await sql(
        `INSERT INTO core.subscription (workspace_id, plan_id, provider, status, provider_customer_id,
                                        provider_subscription_id, grace_until)
           VALUES ($1, 'starter', 'stripe', 'past_due', $2, $3, now() - interval '1 hour')`,
        [ids[slug], customer, subId],
      );
      await suspend(slug, reason);
      await billing().tasks?.enforce();
      expect(await wsOf(slug)).toMatchObject({ status: "suspended", suspended_reason: reason });
      // Paid: the record is kept current (accepted, 200) but the suspension stays, and nobody
      // is mailed about money for a workspace that is not running.
      const since = mailer.sent.length;
      setSub(subId, { customer, status: "active", workspaceId: ids[slug] });
      expect((await deliver(subscriptionEvent(subId, T0 + 400))).status).toBe(200);
      expect((await subOf(slug))?.status).toBe("active");
      expect(await wsOf(slug)).toMatchObject({ status: "suspended", suspended_reason: reason });
      await billing().tasks?.enforce();
      expect(await wsOf(slug)).toMatchObject({ status: "suspended", suspended_reason: reason });
      // Past due again while suspended: no past-due mail.
      setSub(subId, { customer, status: "past_due", workspaceId: ids[slug] });
      expect((await deliver(subscriptionEvent(subId, T0 + 500))).status).toBe(200);
      expect((await subOf(slug))?.grace_until).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(mailer.sent.slice(since).filter((m) => m.tags?.includes("billing"))).toEqual([]);
    }
  });

  it("answers 500 when the re-read fails, so Stripe retries (and the event is not consumed)", async () => {
    const event = subscriptionEvent("sub_1", T0 + 600);
    stripe.subs.delete("sub_1");
    // The event carries the old object; the re-read now 404s.
    const failed = await deliver(event);
    expect(failed.status).toBe(500);
    expect(await sql("SELECT id FROM core.billing_event WHERE id = $1", [event.id])).toEqual([]);
    setSub("sub_1", { customer: "cus_new1", status: "active", workspaceId: ids["acme"] });
    expect((await deliver(subscriptionEvent("sub_1", T0 + 600, event.id))).status).toBe(200);
    expect(await sql("SELECT id FROM core.billing_event WHERE id = $1", [event.id])).toHaveLength(
      1,
    );
  });

  it("acknowledges event types it does not act on", async () => {
    const res = await deliver({
      id: "evt_invoice",
      object: "event",
      type: "invoice.paid",
      created: T0,
      data: { object: { id: "in_1", object: "invoice" } },
    });
    expect(res.status).toBe(200);
    expect(await sql("SELECT type FROM core.billing_event WHERE id = 'evt_invoice'")).toEqual([
      { type: "invoice.paid" },
    ]);
  });
});

describe("provisioning, trials, usage, retention", () => {
  async function created(planId: string | null) {
    await sql("DELETE FROM core.subscription WHERE workspace_id = $1", [ids["hooked"]]);
    await running.container.db.withHost((tx) =>
      (
        billing().hooks.onWorkspaceCreated as NonNullable<
          BillingKernel["hooks"]["onWorkspaceCreated"]
        >
      )(tx, {
        id: ids["hooked"] as string,
        slug: "hooked",
        legalName: null,
        country: null,
        planId,
        ownerEmail: "owner@hooked.test",
      }),
    );
    return subOf("hooked");
  }

  it("opens a local trial, an incomplete row with grace, or nothing (free plan / no plan)", async () => {
    const trial = await created("trial");
    expect(trial).toMatchObject({ status: "trialing", provider: "stripe", plan_id: "trial" });
    expect(
      Math.abs((trial?.trial_end?.getTime() ?? 0) - (Date.now() + 14 * 86_400_000)),
    ).toBeLessThan(120_000);
    const paid = await created("starter");
    expect(paid).toMatchObject({ status: "incomplete", plan_id: "starter" });
    expect(paid?.grace_until).not.toBeNull();
    expect(await created("free")).toBeUndefined();
    expect(await created(null)).toBeUndefined();
  });

  it("an ended local trial goes incomplete with grace (mail); checkout then grants no trial", async () => {
    await created("trial");
    await hostSql("UPDATE core.workspace SET plan_id = 'trial' WHERE id = $1", [ids["hooked"]]);
    const hookedOwner = await member("hooked", "owner@hooked.test", "staff", "owner");
    // While the trial runs, checkout grants the rest of it.
    let res = await request(`hooked.${CANON}`, "/api/v1/billing/checkout", {
      method: "POST",
      cookie: hookedOwner.cookie,
      body: JSON.stringify({ planId: "trial" }),
    });
    expect(res.status).toBe(200);
    expect(stripe.calls.at(-1)?.form.get("subscription_data[trial_period_days]")).toBe("14");
    await sql(
      "UPDATE core.subscription SET trial_end = now() - interval '1 minute' WHERE workspace_id = $1",
      [ids["hooked"]],
    );
    const since = mailer.sent.length;
    expect((await billing().tasks?.enforce())?.trialsEnded).toBe(1);
    expect(await subOf("hooked")).toMatchObject({ status: "incomplete" });
    expect((await subOf("hooked"))?.grace_until).not.toBeNull();
    await awaitMail(mailer, {
      to: "owner@hooked.test",
      since,
      match: (m) => m.tags?.includes("past-due") === true,
    });
    res = await request(`hooked.${CANON}`, "/api/v1/billing/checkout", {
      method: "POST",
      cookie: hookedOwner.cookie,
      body: JSON.stringify({ planId: "trial" }),
    });
    expect(res.status).toBe(200);
    expect(stripe.calls.at(-1)?.form.has("subscription_data[trial_period_days]")).toBe(false);
  });

  it("reports yesterday's seats and storage with idempotent identifiers", async () => {
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await sql(
      `INSERT INTO core.tenant_usage_daily (workspace_id, day, staff_seats, storage_bytes, computed_at)
         VALUES ($1, $2, 3, 1500000000, now())`,
      [ids["acme"], day],
    );
    const meterEvents = (from: number) =>
      stripe.calls.slice(from).filter((c) => c.path === "/v1/billing/meter_events");
    // Only the seats price is on the subscription: storage is not reported (and is no error).
    setSub("sub_1", {
      customer: "cus_new1",
      status: "active",
      workspaceId: ids["acme"],
      metered: [{ price: "price_seats", meter: "mtr_seats" }],
    });
    let before = stripe.calls.length;
    expect(await billing().tasks?.reportUsage()).toBe(1);
    expect(meterEvents(before).map((c) => c.form.get("event_name"))).toEqual([
      "fundroom_staff_seats",
    ]);
    // Both metered prices on it: both meters.
    setSub("sub_1", {
      customer: "cus_new1",
      status: "active",
      workspaceId: ids["acme"],
      metered: [
        { price: "price_seats", meter: "mtr_seats" },
        { price: "price_gb", meter: "mtr_gb" },
      ],
    });
    before = stripe.calls.length;
    expect(await billing().tasks?.reportUsage()).toBe(2);
    const meters = meterEvents(before).map((c) => Object.fromEntries(c.form));
    expect(meters).toEqual([
      {
        event_name: "fundroom_staff_seats",
        "payload[value]": "3",
        "payload[stripe_customer_id]": "cus_new1",
        identifier: `${ids["acme"]}:${day}:fundroom_staff_seats`,
        timestamp: String(Date.parse(`${day}T23:59:59Z`) / 1000),
      },
      {
        event_name: "acme_storage_gb",
        "payload[value]": "2",
        "payload[stripe_customer_id]": "cus_new1",
        identifier: `${ids["acme"]}:${day}:acme_storage_gb`,
        timestamp: String(Date.parse(`${day}T23:59:59Z`) / 1000),
      },
    ]);
    // A second run sends the same identifiers (Stripe dedupes them).
    const again = stripe.calls.length;
    await billing().tasks?.reportUsage();
    expect(meterEvents(again).map((c) => c.form.get("identifier"))).toEqual(
      meters.map((m) => m["identifier"]),
    );
  });

  it("warns when a subscription bills on a meter whose event name is not configured (A-2 rename)", async () => {
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await sql(
      `INSERT INTO core.tenant_usage_daily (workspace_id, day, staff_seats, storage_bytes, computed_at)
         VALUES ($1, $2, 3, 1500000000, now())
       ON CONFLICT DO NOTHING`,
      [ids["acme"], day],
    );
    setSub("sub_1", {
      customer: "cus_new1",
      status: "active",
      workspaceId: ids["acme"],
      metered: [{ price: "price_seats_old", meter: "mtr_legacy" }],
    });
    const before = stripe.calls.length;
    const from = logLines.length;
    expect(await billing().tasks?.reportUsage()).toBe(0);
    expect(stripe.calls.slice(before).some((c) => c.path === "/v1/billing/meter_events")).toBe(
      false,
    );
    expect(logLines.slice(from)).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "billing.usage_meter_unknown",
        workspaceId: ids["acme"],
        meter: "seedhost_staff_seats",
      }),
    );
  });

  it("drops billing events after 90 days", async () => {
    await sql(
      "INSERT INTO core.billing_event (id, provider, type, received_at) VALUES ('evt_old', 'stripe', 'x', now() - interval '91 days')",
    );
    const kept = (await sql("SELECT count(*)::int AS n FROM core.billing_event"))[0] as {
      n: number;
    };
    expect(await billing().tasks?.retention()).toBe(1);
    expect(await sql("SELECT count(*)::int AS n FROM core.billing_event")).toEqual([
      { n: kept.n - 1 },
    ]);
  });

  it("registers the four jobs", () => {
    expect(billing().jobs.map((j) => [j.name, j.cron])).toEqual([
      ["billing.enforce", "20 * * * *"],
      ["billing.report-usage", "45 0 * * *"],
      ["billing.retention", "50 3 * * *"],
      ["billing.cancel", undefined],
    ]);
  });
});

describe("fix round R3 (plan moves, trials, enforcement listing, cancellation)", () => {
  const extra: Record<string, { cookie: string; userId: string }> = {};

  beforeAll(async () => {
    const db = running.container.db;
    for (const slug of [
      "planov",
      "abandon",
      "race",
      "pend",
      "gone1",
      "gone2",
      "sanc",
      "gone3",
      "sanc2",
    ]) {
      ids[slug] = (await createWorkspace(db, { slug, name: slug.toUpperCase() })).id;
    }
    for (const slug of ["abandon", "race", "gone2", "sanc"]) {
      extra[slug] = await member(slug, `owner@${slug}.test`, "staff", "owner");
    }
  }, 120_000);

  const checkout = (slug: string, planId: string) =>
    request(`${slug}.${CANON}`, "/api/v1/billing/checkout", {
      method: "POST",
      cookie: extra[slug]?.cookie,
      body: JSON.stringify({ planId }),
    });

  async function stripeRow(slug: string, fields: Record<string, unknown>) {
    const row = {
      plan_id: "starter",
      status: "active",
      provider_customer_id: null,
      provider_subscription_id: null,
      grace_until: null,
      trial_end: null,
      last_event_at: null,
      ...fields,
    };
    await sql(
      `INSERT INTO core.subscription (workspace_id, plan_id, provider, status, provider_customer_id,
         provider_subscription_id, grace_until, trial_end, last_event_at)
       VALUES ($1, $2, 'stripe', $3, $4, $5, $6, $7, $8)`,
      [
        ids[slug],
        row.plan_id,
        row.status,
        row.provider_customer_id,
        row.provider_subscription_id,
        row.grace_until,
        row.trial_end,
        row.last_event_at,
      ],
    );
  }

  const cancelJobs = (slug: string) =>
    sql<{ reason: string }>(
      "SELECT data->>'reason' AS reason FROM pgboss.job WHERE name = 'billing.cancel' AND data->>'workspaceId' = $1",
      [ids[slug]],
    );

  it("moves the plan only when the price changed, found by any item's price (R3-L2, L9)", async () => {
    // A subscription that has had provider facts (the first one always sets the plan).
    await stripeRow("planov", {
      provider_customer_id: "cus_pl",
      provider_subscription_id: "sub_pl",
      last_event_at: new Date(T0 * 1000),
    });
    // The operator moved the workspace to `pro` by hand; Stripe still bills the starter price.
    await hostSql("UPDATE core.workspace SET plan_id = 'pro' WHERE id = $1", [ids["planov"]]);
    setSub("sub_pl", { customer: "cus_pl", status: "active", workspaceId: ids["planov"] });
    expect((await deliver(subscriptionEvent("sub_pl", T0 + 1000))).status).toBe(200);
    expect((await wsOf("planov"))?.plan_id).toBe("pro");
    expect((await subOf("planov"))?.plan_id).toBe("starter");
    // A real plan change in the portal: a metered item first, the new base price second.
    const sub = stripe.subs.get("sub_pl") as { items: { data: unknown[] } };
    sub.items.data = [
      { price: { id: "price_metered_seats" }, current_period_end: T0 + 30 * 86_400 },
      { price: { id: "price_trial" }, current_period_end: T0 + 30 * 86_400 },
    ];
    expect((await deliver(subscriptionEvent("sub_pl", T0 + 1001))).status).toBe(200);
    expect((await subOf("planov"))?.plan_id).toBe("trial");
    expect((await wsOf("planov"))?.plan_id).toBe("trial");
  });

  it("checkout adds the plan's metered prices as line items without a quantity (G3-1)", async () => {
    await sql(
      "UPDATE core.plan SET billing_metered_price_refs = '{price_seats,price_gb}' WHERE id = 'pro'",
    );
    try {
      const res = await checkout("abandon", "pro");
      expect(res.status).toBe(200);
      const form = stripe.calls.at(-1)?.form as URLSearchParams;
      expect(Object.fromEntries([...form].filter(([k]) => k.startsWith("line_items")))).toEqual({
        "line_items[0][price]": "price_pro",
        "line_items[0][quantity]": "1",
        "line_items[1][price]": "price_seats",
        "line_items[2][price]": "price_gb",
      });
    } finally {
      await sql("UPDATE core.plan SET billing_metered_price_refs = '{}' WHERE id = 'pro'");
    }
  });

  it("an abandoned first checkout keeps the trial (R3-L7)", async () => {
    let res = await checkout("abandon", "trial");
    expect(res.status).toBe(200);
    expect(stripe.calls.at(-1)?.form.get("subscription_data[trial_period_days]")).toBe("14");
    expect(await subOf("abandon")).toMatchObject({ status: "incomplete", trial_end: null });
    // Nobody paid; the owner comes back later.
    res = await checkout("abandon", "trial");
    expect(res.status).toBe(200);
    expect(stripe.calls.at(-1)?.form.get("subscription_data[trial_period_days]")).toBe("14");
  });

  it("a concurrent first checkout gets a clean 409, not a 500 (R3-L7)", async () => {
    const client = await pg.pool.connect();
    let sawWaiter = false;
    let committed: Promise<void> = Promise.resolve();
    stripe.onCheckout = async () => {
      stripe.onCheckout = undefined;
      // Another checkout's row, inserted but not committed while ours looks and inserts.
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO core.subscription (workspace_id, plan_id, provider, status, provider_customer_id)
           VALUES ($1, 'starter', 'stripe', 'incomplete', 'cus_other')`,
        [ids["race"]],
      );
      committed = (async () => {
        for (let i = 0; i < 200 && !sawWaiter; i++) {
          const waiting = await pg.pool.query(
            "SELECT 1 FROM pg_locks WHERE NOT granted AND locktype = 'transactionid'",
          );
          sawWaiter = (waiting.rowCount ?? 0) > 0;
          if (!sawWaiter) await new Promise((r) => setTimeout(r, 25));
        }
        await client.query("COMMIT");
      })();
    };
    try {
      const res = await checkout("race", "starter");
      await committed;
      expect(sawWaiter).toBe(true);
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("billing_unavailable");
      expect((await subOf("race"))?.provider_customer_id).toBe("cus_other");
    } finally {
      stripe.onCheckout = undefined;
      client.release();
    }
  });

  it("enforcement pages through its listing and leaves a workspace in sanctions review alone (R3-L5, L6)", async () => {
    const { db, audit, resolver } = running.container;
    // Held for review (never live): its grace is not enforced while it is held.
    const held = await db.withHost((tx) =>
      setWorkspaceHold(
        tx,
        {
          workspaceId: ids["pend"] as string,
          hold: "sanctions_review",
          on: true,
          actor: { kind: "system", source: "sanctions" },
        },
        { audit, invalidate: () => resolver.invalidate() },
      ),
    );
    held.afterCommit();
    const past = new Date(Date.now() - 60_000);
    await stripeRow("pend", { status: "past_due", grace_until: past });
    // A deleted workspace's local trial is not ended (no mail, nothing to suspend).
    await stripeRow("gone1", { plan_id: "trial", status: "trialing", trial_end: past });
    await hostSql(
      "UPDATE core.workspace SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1",
      [ids["gone1"]],
    );
    // Three due workspaces on pages of two: every one is reached.
    const due = ["race", "abandon", "planov"];
    for (const slug of due) {
      await sql(
        "UPDATE core.subscription SET status = 'past_due', grace_until = $2 WHERE workspace_id = $1",
        [ids[slug], past],
      );
    }
    const summary = await billing().tasks?.enforce({ pageSize: 2 });
    expect(summary?.failed).toBe(0);
    expect(summary?.suspended).toBeGreaterThanOrEqual(3);
    for (const slug of due) {
      expect(await wsOf(slug)).toMatchObject({ status: "suspended", suspended_reason: "billing" });
    }
    expect(await wsOf("pend")).toMatchObject({ status: "pending_review" });
    expect((await subOf("gone1"))?.status).toBe("trialing");
    // Nothing left to act on: the flagged ones are not listed again.
    expect(await billing().tasks?.enforce({ pageSize: 2 })).toMatchObject({ suspended: 0 });
    for (const slug of due) {
      await sql(
        "UPDATE core.subscription SET status = 'active', grace_until = NULL WHERE workspace_id = $1",
        [ids[slug]],
      );
    }
    expect((await billing().tasks?.enforce({ pageSize: 2 }))?.unsuspended).toBeGreaterThanOrEqual(
      3,
    );
    for (const slug of due) expect((await wsOf(slug))?.status).toBe("active");
  });

  it("deleting the workspace cancels the Stripe subscription through a retried job (R3-L1)", async () => {
    await stripeRow("gone2", {
      provider_customer_id: "cus_gone",
      provider_subscription_id: "sub_gone",
    });
    setSub("sub_gone", { customer: "cus_gone", status: "active", workspaceId: ids["gone2"] });
    const res = await request(`gone2.${CANON}`, "/api/v1/workspace", {
      method: "DELETE",
      cookie: extra["gone2"]?.cookie,
      body: JSON.stringify({ confirm: "gone2" }),
    });
    expect(res.status).toBe(202);
    expect(await cancelJobs("gone2")).toEqual([{ reason: "deleted" }]);
    const tasks = billing().tasks as NonNullable<BillingKernel["tasks"]>;
    // Stripe fails once: the job throws (the queue retries), nothing is recorded.
    stripe.failDeletes = 1;
    await expect(tasks.cancel(ids["gone2"] as string, "deleted")).rejects.toThrow();
    expect((await subOf("gone2"))?.status).toBe("active");
    // Canceled at Stripe meanwhile (the dashboard, a retry that got through): Stripe refuses the
    // second cancel, and the re-read says it is done.
    stripe.cancelRace = true;
    expect(await tasks.cancel(ids["gone2"] as string, "deleted")).toBe("canceled");
    expect(stripe.subs.get("sub_gone")?.["status"]).toBe("canceled");
    expect((await subOf("gone2"))?.status).toBe("canceled");
    // Idempotent.
    expect(await tasks.cancel(ids["gone2"] as string, "deleted")).toBe("none");
    // The cancellation keeps a grace period (from the paid-up period's end), never none (RR1-M3):
    // a workspace restored later is suspended once it runs out instead of running for free.
    expect((await subOf("gone2"))?.grace_until).not.toBeNull();
    await restoreWorkspace(
      { db: running.container.db, audit: running.container.audit },
      ids["gone2"] as string,
    );
    expect((await wsOf("gone2"))?.status).toBe("active");
    await sql(
      "UPDATE core.subscription SET grace_until = now() - interval '1 minute' WHERE workspace_id = $1",
      [ids["gone2"]],
    );
    await billing().tasks?.enforce();
    expect(await wsOf("gone2")).toMatchObject({ status: "suspended", suspended_reason: "billing" });
  });

  it("a confirmed sanctions match cancels it too; a lifted one is left alone (R3-L1)", async () => {
    await stripeRow("sanc", {
      provider_customer_id: "cus_sanc",
      provider_subscription_id: "sub_sanc",
    });
    setSub("sub_sanc", { customer: "cus_sanc", status: "active", workspaceId: ids["sanc"] });
    const tasks = billing().tasks as NonNullable<BillingKernel["tasks"]>;
    // Not (or no longer) suspended for sanctions: the job does nothing.
    expect(await tasks.cancel(ids["sanc"] as string, "sanctions")).toBe("moot");
    const [screening] = await sql<{ id: string }>(
      `INSERT INTO core.sanctions_screening (workspace_id, subject_name, provider, list_version, outcome)
         VALUES ($1, 'SANC', 'ofac', 'ofac:x:jw2', 'potential_match') RETURNING id`,
      [ids["sanc"]],
    );
    const service = running.container.sanctions.service;
    await service?.decide({
      id: (screening as { id: string }).id,
      decision: "confirmed",
      note: "listed",
      operator: { userId: owner.userId },
    });
    expect(await cancelJobs("sanc")).toEqual([{ reason: "sanctions" }]);
    // Due whichever cause queued it (RR2-6): a job queued for a delete that was undone still
    // cancels while the sanctions suspension stands.
    expect(await tasks.cancel(ids["sanc"] as string, "deleted")).toBe("canceled");
    expect(stripe.subs.get("sub_sanc")?.["status"]).toBe("canceled");
  });

  it("no checkout or portal under a sanctions suspension; a live subscription is canceled again (RR1-M1)", async () => {
    for (const path of ["/api/v1/billing/checkout", "/api/v1/billing/portal"]) {
      const res = await request(`sanc.${CANON}`, path, {
        method: "POST",
        cookie: extra["sanc"]?.cookie,
        body: JSON.stringify({ planId: "starter" }),
      });
      expect(res.status, path).toBe(409);
      const body = (await res.json()) as { error: { code: string; reason?: string } };
      expect(body.error).toMatchObject({ code: "billing_unavailable", reason: "sanctions" });
    }
    // The subscription comes back to life at Stripe (a resumed one, a race with the cancel): the
    // webhook records it and queues the cancel again.
    await sql(
      "DELETE FROM pgboss.job WHERE name = 'billing.cancel' AND data->>'workspaceId' = $1",
      [ids["sanc"]],
    );
    setSub("sub_sanc", { customer: "cus_sanc", status: "active", workspaceId: ids["sanc"] });
    expect((await deliver(subscriptionEvent("sub_sanc", T0 + 5000))).status).toBe(200);
    expect(await cancelJobs("sanc")).toEqual([{ reason: "sanctions" }]);
  });
});

describe("fix round FR4: subscriptions the row does not hold", () => {
  const jobsFor = (slug: string) =>
    sql<{ data: { workspaceId: string; reason: string; subscriptionId?: string } }>(
      "SELECT data FROM pgboss.job WHERE name = 'billing.cancel' AND data->>'workspaceId' = $1 ORDER BY created_on",
      [ids[slug]],
    );
  const runJobs = async (slug: string) => {
    const tasks = billing().tasks as NonNullable<BillingKernel["tasks"]>;
    for (const { data } of await jobsFor(slug)) {
      await tasks.cancel(data.workspaceId, data.reason as "deleted", data.subscriptionId);
    }
  };
  async function row(slug: string, customer: string, subscription: string, status: string) {
    await sql(
      `INSERT INTO core.subscription (workspace_id, plan_id, provider, status, provider_customer_id, provider_subscription_id)
         VALUES ($1, 'starter', 'stripe', $2, $3, $4)`,
      [ids[slug], status, customer, subscription],
    );
  }

  it("(A) a checkout that completes after the delete is canceled too", async () => {
    await row("gone3", "cus_g3", "sub_z1", "canceled");
    await hostSql(
      "UPDATE core.workspace SET deleted_at = now(), purge_after = now() + interval '30 days' WHERE id = $1",
      [ids["gone3"]],
    );
    setSub("sub_z2", { customer: "cus_g3", status: "active", workspaceId: ids["gone3"] });
    const late = checkoutEvent({
      workspaceId: ids["gone3"] as string,
      customer: "cus_g3",
      subscription: "sub_z2",
      created: T0 + 6000,
    });
    expect((await deliver(late)).status).toBe(200);
    expect((await jobsFor("gone3")).map((j) => j.data)).toEqual([
      { workspaceId: ids["gone3"], reason: "deleted", subscriptionId: "sub_z2" },
    ]);
    await runJobs("gone3");
    expect(stripe.subs.get("sub_z2")?.["status"]).toBe("canceled");
  });

  it("(B) a second subscription on a sanctioned workspace's customer is canceled now", async () => {
    await row("sanc2", "cus_s2", "sub_s1", "active");
    setSub("sub_s1", { customer: "cus_s2", status: "active", workspaceId: ids["sanc2"] });
    await suspend("sanc2", "sanctions");
    await sql(
      "DELETE FROM pgboss.job WHERE name = 'billing.cancel' AND data->>'workspaceId' = $1",
      [ids["sanc2"]],
    );
    setSub("sub_s2", { customer: "cus_s2", status: "active", workspaceId: ids["sanc2"] });
    expect((await deliver(subscriptionEvent("sub_s2", T0 + 7000))).status).toBe(200);
    // Not adopted (the row keeps s1), but queued for cancellation.
    expect((await subOf("sanc2"))?.provider_subscription_id).toBe("sub_s1");
    expect((await jobsFor("sanc2")).map((j) => j.data)).toEqual([
      { workspaceId: ids["sanc2"], reason: "sanctions", subscriptionId: "sub_s2" },
    ]);
    await runJobs("sanc2");
    expect(stripe.subs.get("sub_s2")?.["status"]).toBe("canceled");
    expect(stripe.subs.get("sub_s1")?.["status"]).toBe("canceled");
  });

  it("never cancels a subscription on somebody else's customer", async () => {
    setSub("sub_foreign", { customer: "cus_foreign", status: "active" });
    const tasks = billing().tasks as NonNullable<BillingKernel["tasks"]>;
    expect(await tasks.cancel(ids["gone3"] as string, "deleted", "sub_foreign")).toBe("none");
    expect(stripe.subs.get("sub_foreign")?.["status"]).toBe("active");
  });
});

describe("the manual driver", () => {
  let manual: RunningServer;
  let manualMail: MemoryMailer;
  let opCookie: string;
  let manualOwner: { cookie: string; userId: string };

  beforeAll(async () => {
    manualMail = createMemoryMailer();
    manual = await startServer({
      config: loadConfig({
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
          BILLING_DRIVER: "manual",
          ROLES: "api",
          UPDATE_CHECK: "false",
        },
      }),
      logger: createLogger({ level: "error" }),
      mailer: manualMail,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    ids["hand"] = (await createWorkspace(manual.container.db, { slug: "hand", name: "Hand" })).id;
    await hostSql("UPDATE core.workspace SET plan_id = 'pro' WHERE id = $1", [ids["hand"]]);
    manualOwner = await member("hand", "owner@hand.test", "staff", "owner", manual, manualMail);
    const { userId } = await provisionUser(manual.container.identityDeps, {
      email: "operator@platform.test",
      displayName: "Operator",
    });
    await sql("INSERT INTO core.platform_operator (user_id, created_by) VALUES ($1, 'cli:test')", [
      userId,
    ]);
    const minted = await manual.container.auth.sessions.startSession({
      userId,
      population: "operator",
      context: "first_party",
      authLevel: 2,
    });
    opCookie = `__Host-op_sid=${minted.token}`;
  }, 240_000);

  afterAll(async () => {
    await manual?.stop();
  });

  const record = (body: unknown, cookie = opCookie) =>
    request(
      CANON,
      `/api/v1/platform/workspaces/${ids["hand"]}/subscription`,
      { method: "POST", cookie, body: JSON.stringify(body) },
      manual,
    );

  it("checkout and portal answer billing_manual; there is no webhook", async () => {
    for (const path of ["/api/v1/billing/checkout", "/api/v1/billing/portal"]) {
      const res = await request(
        `hand.${CANON}`,
        path,
        { method: "POST", cookie: manualOwner.cookie, body: JSON.stringify({ planId: "pro" }) },
        manual,
      );
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("billing_manual");
    }
    const hook = await manual.app.request(`https://${CANON}/webhooks/billing/stripe`, {
      method: "POST",
      headers: { host: CANON, "stripe-signature": "t=1,v1=00" },
      body: "{}",
    });
    expect(hook.status).toBe(404);
  });

  it("is an operator-only route (plain 404 for anybody else)", async () => {
    expect((await record({ status: "active" }, manualOwner.cookie)).status).toBe(404);
    expect((await record({ status: "active" }, "")).status).toBe(404);
  });

  it("records past due → grace → suspension → active → unsuspended, on both chains", async () => {
    let res = await record({ status: "past_due", currentPeriodEnd: "2026-10-01T00:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "past_due",
      provider: "manual",
      currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    });
    expect(await subOf("hand")).toMatchObject({
      provider: "manual",
      status: "past_due",
      plan_id: "pro",
    });
    expect((await subOf("hand"))?.grace_until).not.toBeNull();
    await awaitMail(manualMail, {
      to: "owner@hand.test",
      since: 0,
      match: (m) => m.tags?.includes("past-due") === true,
    });
    await sql(
      "UPDATE core.subscription SET grace_until = now() - interval '1 minute' WHERE workspace_id = $1",
      [ids["hand"]],
    );
    await billing(manual).tasks?.enforce();
    expect(await wsOf("hand")).toMatchObject({ status: "suspended", suspended_reason: "billing" });
    res = await record({ status: "active" });
    expect(res.status).toBe(200);
    expect(await wsOf("hand")).toMatchObject({ status: "active" });
    expect((await subOf("hand"))?.grace_until).toBeNull();
    const tenant = await sql<{ actor_kind: string; actor_user_id: string | null }>(
      "SELECT actor_kind, actor_user_id FROM audit.event WHERE workspace_id = $1 AND action = 'subscription.update'",
      [ids["hand"]],
    );
    // The tenant's chain says "the operator" (meta), never which one (R1-L5).
    expect(tenant).toEqual([
      { actor_kind: "host", actor_user_id: null },
      { actor_kind: "host", actor_user_id: null },
    ]);
    const platform = await sql(
      "SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = '00000000-0000-7000-8000-000000000000' AND action = 'subscription.update' AND meta->>'workspaceId' = $1",
      [ids["hand"]],
    );
    expect(platform).toEqual([{ n: 2 }]);
  });

  it("a new workspace on a trial plan gets a manual trialing subscription", async () => {
    const id = (await createWorkspace(manual.container.db, { slug: "handtrial", name: "T" })).id;
    await manual.container.db.withHost((tx) =>
      (
        billing(manual).hooks.onWorkspaceCreated as NonNullable<
          BillingKernel["hooks"]["onWorkspaceCreated"]
        >
      )(tx, {
        id,
        slug: "handtrial",
        legalName: null,
        country: null,
        planId: "trial",
        ownerEmail: "x@hand.test",
      }),
    );
    const row = (
      await sql<SubRow>("SELECT * FROM core.subscription WHERE workspace_id = $1", [id])
    )[0];
    expect(row).toMatchObject({ provider: "manual", status: "trialing", plan_id: "trial" });
  });
});
