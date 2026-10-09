import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server as HttpServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eraseIdentity } from "@fundroom/compliance";
import { loadConfig } from "@fundroom/config";
import {
  createWorkspace,
  type DsarRequest,
  listActiveWorkspaceIds,
  listLiveWorkspaceIds,
  systemContext,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { publish } from "@fundroom/events";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { verifyWebhook, WebhookVerificationError } from "@fundroom/webhooks";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContainer } from "./container.js";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import { bearer, mintTestApiKey } from "./test/api-keys.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Outbound webhooks end to end (E3.4-B, ADR-0052), against a real receiver on 127.0.0.1
 * (`WEBHOOK_ALLOW_PRIVATE_HOSTS`, the one way plain http is allowed) that checks every
 * signature with the SDK's `verifyWebhook`:
 *
 *  - endpoint CRUD: URL rules, the URL never returned/audited, the 20-endpoint cap under a race;
 *  - fan-out from a real domain event (`membership.created` via provisioning) through the outbox;
 *  - the person-level gate for `document.viewed` (analytics mode, consent, erasure, module on),
 *    session ids stripped from what is sent;
 *  - retries with Retry-After → `failed` (the DLQ); 410 → `gone`; 20 exhausted → `failing`
 *    (queued rows cancelled, audited once); redeliver; ping; secret rotation (dual signature);
 *  - the deliveries list (keyset, filters, API key reads); delete cascade; retention (legal
 *    hold); cross-workspace isolation; DSAR erasure;
 *  - concurrency: claims never double-send, deletes/disables/redelivers racing delivery never
 *    deadlock (`pg_stat_database.deadlocks` unchanged), and a one-connection pool pass.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let secretKey: string;
let storagePath: string;
let acmeId: string;
let betaId: string;
let owner: Actor;
let betaOwner: Actor;

interface Actor {
  cookie: string;
  membershipId: string;
  userId: string;
}

type Server = Pick<RunningServer, "app" | "container">;

// --- the receiver ---------------------------------------------------------------------------

interface Hit {
  readonly name: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  readonly json: {
    id: string;
    eventId: string;
    type: string;
    timestamp: string;
    workspaceId: string;
    data: Record<string, unknown>;
    schemaVersion: number;
  };
}
interface Behaviour {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
}
const behaviours = new Map<string, Behaviour>();
const hits: Hit[] = [];
let receiver: HttpServer;
let port: number;

function hookUrl(name: string): string {
  // The path and query stand in for the token a real receiver embeds; neither may ever leak.
  return `http://127.0.0.1:${port}/r/${name}/tok3n-${name}?sig=q5ecret`;
}

function hitsFor(name: string): Hit[] {
  return hits.filter((h) => h.name === name);
}

async function verify(hit: Hit, secret: string) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(hit.headers)) if (typeof v === "string") headers[k] = v;
  return verifyWebhook({ headers, body: hit.body, secret });
}

// --- HTTP helpers ---------------------------------------------------------------------------

async function request(
  path: string,
  init: RequestInit & { cookie?: string; server?: Server; slug?: string } = {},
): Promise<Response> {
  const slug = init.slug ?? "acme";
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
  return (init.server ?? running).app.request(`http://${slug}.${CANON}${path}`, {
    ...init,
    headers,
  });
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
  const start = await request("/api/v1/auth/otp/start", {
    method: "POST",
    slug,
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verifyRes = await request("/api/v1/auth/otp/verify", {
    method: "POST",
    slug,
    body: JSON.stringify({ email, code }),
  });
  expect(verifyRes.status).toBe(200);
  const body = await json<{ session: { userId: string }; membership: { id: string } | null }>(
    verifyRes,
  );
  return {
    cookie: cookiesOf(verifyRes),
    membershipId: body.membership?.id ?? "",
    userId: body.session.userId,
  };
}

async function stepUpToMfa(cookie: string, slug: string): Promise<string> {
  const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie, slug });
  expect(enrol.status).toBe(200);
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request("/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    slug,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

async function staffOwner(workspaceId: string, slug: string, name: string): Promise<Actor> {
  const email = `${name}@${slug}.test`;
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: name });
  await provisionMembership(deps, {
    workspaceId,
    userId: user.userId,
    kind: "staff",
    role: "owner",
    source: "test",
  });
  const actor = await signIn(slug, email);
  actor.cookie = await stepUpToMfa(actor.cookie, slug);
  return actor;
}

/** A new external member: publishes a real `membership.created` through the outbox. */
async function newInvestor(workspaceId = acmeId): Promise<string> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, {
    email: `inv-${randomUUID().slice(0, 8)}@fund.test`,
    displayName: "Investor",
  });
  const m = await provisionMembership(deps, {
    workspaceId,
    userId: user.userId,
    kind: "external",
    role: "investor",
    source: "test",
  });
  return m.id;
}

async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  const r = await running.container.db.pool.query(query, params);
  return r.rows as T[];
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface EndpointBody {
  id: string;
  urlHost: string;
  urlHint: string;
  events: string[];
  enabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  secretRotating: boolean;
  lastSuccessAt: string | null;
  stats?: { last24h: Record<string, number> };
}
interface DeliveryBody {
  id: string;
  endpointId: string;
  topic: string;
  eventId: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  manual: boolean;
  payload?: Record<string, unknown>;
  lastResponseExcerpt?: string | null;
}
interface ApiErr {
  error: { code: string; reason?: string };
}

function api(
  method: string,
  path: string,
  body?: unknown,
  opts: { actor?: Actor; slug?: string; server?: Server } = {},
) {
  return request(`/api/v1${path}`, {
    method,
    cookie: (opts.actor ?? owner).cookie,
    ...(opts.slug === undefined ? {} : { slug: opts.slug }),
    ...(opts.server === undefined ? {} : { server: opts.server }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createEndpoint(
  name: string,
  events: string[] = ["membership.created"],
  opts: { actor?: Actor; slug?: string; behaviour?: Behaviour } = {},
): Promise<{ id: string; secret: string; endpoint: EndpointBody }> {
  behaviours.set(name, opts.behaviour ?? { status: 204 });
  const res = await api("POST", "/webhooks/endpoints", { url: hookUrl(name), events }, opts);
  expect(res.status, await res.clone().text()).toBe(201);
  const body = await json<{ endpoint: EndpointBody; secret: string }>(res);
  return { id: body.endpoint.id, secret: body.secret, endpoint: body.endpoint };
}

interface Row {
  id: string;
  status: string;
  attempts: number;
  event_id: string;
  topic: string;
  manual: boolean;
  next_attempt_at: Date | null;
  last_status_code: number | null;
  last_error: string | null;
  payload: Record<string, unknown>;
}

async function rowsOf(endpointId: string): Promise<Row[]> {
  return sql<Row>(
    "SELECT * FROM core.webhook_delivery WHERE endpoint_id = $1 ORDER BY created_at, id",
    [endpointId],
  );
}

async function endpointRow(id: string) {
  const [row] = await sql<{
    enabled: boolean;
    disabled_reason: string | null;
    consecutive_failures: number;
  }>("SELECT * FROM core.webhook_endpoint WHERE id = $1", [id]);
  return row;
}

/** Makes an endpoint's pending rows due and runs delivery until none is in flight. */
async function drive(endpointId: string, workspaceId = acmeId): Promise<void> {
  await sql(
    "UPDATE core.webhook_delivery SET next_attempt_at = now() - interval '1 second' WHERE endpoint_id = $1 AND status = 'pending'",
    [endpointId],
  );
  await running.container.webhooks.deliverWorkspace(workspaceId);
  await waitFor("no delivery in flight", async () => {
    const rows = await rowsOf(endpointId);
    return rows.every((r) => r.status !== "sending") ? true : undefined;
  });
}

async function deadlocks(): Promise<number> {
  const [r] = await sql<{ deadlocks: string }>(
    "SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()",
  );
  return Number(r?.deadlocks ?? 0);
}

function testConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: secretKey,
      STORAGE_FS_PATH: storagePath,
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
      WEBHOOK_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
      // Not inherited by webhooks (fix H1): this host stays refused for them.
      OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: "10.1.2.3",
      ...extra,
    },
  });
}

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const name = (req.url ?? "").split("/")[2] ?? "";
      let parsed: Hit["json"];
      try {
        parsed = JSON.parse(body) as Hit["json"];
      } catch {
        parsed = {} as Hit["json"];
      }
      hits.push({ name, headers: req.headers, body, json: parsed });
      const b = behaviours.get(name) ?? { status: 204 };
      setTimeout(() => {
        res.writeHead(b.status, b.headers ?? {});
        res.end(b.body ?? "");
      }, b.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  port = (receiver.address() as AddressInfo).port;

  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  secretKey = randomBytes(32).toString("base64");
  storagePath = mkdtempSync(join(tmpdir(), "fundroom-storage-"));
  running = await startServer({
    config: testConfig(),
    logger: createLogger({ level: "warn" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  betaId = (await createWorkspace(running.container.db, { slug: "beta", name: "Beta" })).id;
  owner = await staffOwner(acmeId, "acme", "owner");
  betaOwner = await staffOwner(betaId, "beta", "boss");
}, 180_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
  await new Promise<void>((resolve) => receiver?.close(() => resolve()));
});

describe("endpoints", () => {
  it("offers the enabled modules' topics, flags person-level ones, never webhook.ping", async () => {
    const res = await api("GET", "/webhooks/topics");
    expect(res.status).toBe(200);
    const { topics } = await json<{
      topics: { topic: string; moduleId: string; description: string; personLevel: boolean }[];
    }>(res);
    const by = new Map(topics.map((t) => [t.topic, t]));
    expect(by.get("membership.created")).toMatchObject({ moduleId: "access", personLevel: false });
    expect(by.get("document.viewed")).toMatchObject({ moduleId: "data-room", personLevel: true });
    expect(by.get("update.viewed")?.personLevel).toBe(true);
    expect(by.has("webhook.ping")).toBe(false);
    expect(by.get("membership.created")?.description.length).toBeGreaterThan(10);

    // A module switched off takes its topics with it.
    await sql(
      "INSERT INTO core.module_enablement (workspace_id, module, enabled) VALUES ($1, 'updates', false) ON CONFLICT (workspace_id, module) DO UPDATE SET enabled = false",
      [acmeId],
    );
    try {
      const off = await json<{ topics: { topic: string }[] }>(await api("GET", "/webhooks/topics"));
      expect(off.topics.map((t) => t.topic)).not.toContain("update.published");
      const refused = await api("POST", "/webhooks/endpoints", {
        url: "https://hooks.example.com/x",
        events: ["update.published"],
      });
      expect(refused.status).toBe(400);
      expect((await json<ApiErr>(refused)).error.reason).toBe("unknown_topic");
    } finally {
      await sql(
        "DELETE FROM core.module_enablement WHERE workspace_id = $1 AND module = 'updates'",
        [acmeId],
      );
    }
  });

  it("validates the URL: https unless the host is exempt, the guard's policy, known topics", async () => {
    const cases: [string, string[], string][] = [
      ["http://hooks.example.com/x", ["membership.created"], "https_required"],
      ["https://10.0.0.1/x", ["membership.created"], "url_not_allowed"],
      // Allowed for the kernel's other outbound agents, never for webhooks.
      ["https://10.1.2.3/x", ["membership.created"], "url_not_allowed"],
      ["https://localhost/x", ["membership.created"], "url_not_allowed"],
      ["ftp://hooks.example.com/x", ["membership.created"], "url_not_allowed"],
      ["https://user:pw@hooks.example.com/x", ["membership.created"], "url_not_allowed"],
      ["not a url", ["membership.created"], "invalid_url"],
      ["https://hooks.example.com/x", ["no.such_topic"], "unknown_topic"],
      ["https://hooks.example.com/x", ["webhook.ping"], "unknown_topic"],
    ];
    for (const [url, events, reason] of cases) {
      const res = await api("POST", "/webhooks/endpoints", { url, events });
      expect(res.status, url).toBe(400);
      const body = await res.text();
      expect(JSON.parse(body).error.reason, url).toBe(reason);
      // The refusal never quotes the URL back.
      if (url.includes("/x")) expect(body).not.toContain("hooks.example.com/x");
    }
  });

  it("returns the secret once and never the URL — not in responses, audit meta or the table", async () => {
    const { id, secret, endpoint } = await createEndpoint("secretive");
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]{40,}$/u);
    expect(endpoint.urlHost).toBe(`http://127.0.0.1:${port}`);
    expect(endpoint.urlHint).toBe(hookUrl("secretive").slice(-4));
    expect(endpoint.enabled).toBe(true);
    for (const path of ["/webhooks/endpoints", `/webhooks/endpoints/${id}`]) {
      const text = await (await api("GET", path)).text();
      expect(text).not.toContain("tok3n");
      expect(text).not.toContain("q5ecret");
      expect(text).not.toContain(secret);
      expect(text).not.toContain("whsec_");
    }
    const detail = await json<EndpointBody>(await api("GET", `/webhooks/endpoints/${id}`));
    expect(detail.stats?.last24h).toEqual({
      pending: 0,
      sending: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
    });
    const patched = await api("PATCH", `/webhooks/endpoints/${id}`, {
      url: `${hookUrl("secretive")}&v=2`,
      description: "CRM",
    });
    expect(patched.status).toBe(200);
    expect(await patched.text()).not.toContain("tok3n");
    const audit = await sql<{ action: string; meta: unknown }>(
      "SELECT action, meta FROM audit.event WHERE workspace_id = $1 AND resource_id = $2",
      [acmeId, id],
    );
    expect(audit.map((a) => a.action)).toEqual([
      "webhook.endpoint_created",
      "webhook.endpoint_updated",
    ]);
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain("tok3n");
    expect(auditText).not.toContain("q5ecret");
    expect(auditText).not.toContain("whsec_");
    const [raw] = await sql<{ url_enc: Buffer; secret_enc: Buffer; encryption: unknown }>(
      "SELECT url_enc, secret_enc, encryption FROM core.webhook_endpoint WHERE id = $1",
      [id],
    );
    expect(raw?.url_enc.toString("latin1")).not.toContain("tok3n");
    expect(raw?.secret_enc.toString("latin1")).not.toContain("whsec_");
    expect(raw?.encryption).toMatchObject({
      url: { format: "she1" },
      secret: { format: "she1" },
    });
    expect((await api("DELETE", `/webhooks/endpoints/${id}`)).status).toBe(200);
  });

  it("holds the 20-endpoint cap under a burst of concurrent creates", async () => {
    const existing = (
      await json<{ items: EndpointBody[] }>(await api("GET", "/webhooks/endpoints"))
    ).items.length;
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        api("POST", "/webhooks/endpoints", {
          url: `https://hooks.example.com/cap/${i}`,
          events: ["membership.created"],
        }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(20 - existing);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(25 - (20 - existing));
    expect((await json<ApiErr>(refused[0] as Response)).error.reason).toBe("too_many_endpoints");
    const [{ n } = { n: "0" }] = await sql<{ n: string }>(
      "SELECT count(*) AS n FROM core.webhook_endpoint WHERE workspace_id = $1",
      [acmeId],
    );
    expect(Number(n)).toBe(20);
    await sql("DELETE FROM core.webhook_endpoint WHERE workspace_id = $1 AND url_host = $2", [
      acmeId,
      "https://hooks.example.com",
    ]);
  });
});

describe("fan-out and delivery", () => {
  it("delivers a real domain event, signed, with the documented body", async () => {
    const { id, secret } = await createEndpoint("main", ["membership.created"], {
      behaviour: { status: 200, body: "ok\u0007\r\n\u001b[1mfine‮" },
    });
    const membershipId = await newInvestor();
    const hit = await waitFor("the membership.created delivery", async () =>
      hitsFor("main").find((h) => h.json.data?.["membershipId"] === membershipId),
    );
    const verified = await verify(hit, secret);
    const [row] = (await rowsOf(id)).filter((r) => r.payload["data"] !== undefined);
    expect(hit.headers["webhook-id"]).toBe(verified.id);
    expect(hit.headers["content-type"]).toBe("application/json");
    expect(hit.headers["user-agent"]).toBe("FundRoom-Webhooks/1");
    expect(Object.keys(hit.json)).toEqual([
      "id",
      "eventId",
      "type",
      "timestamp",
      "workspaceId",
      "data",
      "schemaVersion",
    ]);
    expect(hit.json).toMatchObject({
      id: hit.headers["webhook-id"],
      type: "membership.created",
      workspaceId: acmeId,
      schemaVersion: 1,
    });
    expect(hit.json.data).toMatchObject({ membershipId, kind: "external", role: "investor" });
    // Fix H2: the global user id never leaves (it links one person across workspaces).
    expect(hit.json.data).not.toHaveProperty("userId");
    const delivery = await waitFor("the row to succeed", async () => {
      const rows = await rowsOf(id);
      const r = rows.find((x) => x.id === hit.json.id);
      return r?.status === "succeeded" ? r : undefined;
    });
    expect(delivery.event_id).toBe(hit.json.eventId);
    expect(row?.manual).toBe(false);
    const detail = await json<DeliveryBody>(
      await api("GET", `/webhooks/deliveries/${delivery.id}`),
    );
    expect(detail.status).toBe("succeeded");
    expect(detail.lastStatusCode).toBe(200);
    expect(detail.attempts).toBe(1);
    expect(detail.payload).toMatchObject({ id: delivery.id, eventId: delivery.event_id });
    expect(detail.lastResponseExcerpt).toBe("ok [1mfine");
    const ep = await json<EndpointBody>(await api("GET", `/webhooks/endpoints/${id}`));
    expect(ep.lastSuccessAt).not.toBeNull();
    expect(ep.stats?.last24h["succeeded"]).toBeGreaterThanOrEqual(1);
    // An outbox redelivery of the same event cannot double-send (dedupe on endpoint + event).
    const ctx = systemContext(acmeId);
    const again = await running.container.db.withTenant(ctx, (tx) =>
      running.container.webhooks.fanOut(
        {
          outboxId: Number(delivery.event_id),
          topic: "membership.created",
          payload: hit.json.data,
          schemaVersion: 1,
          createdAt: new Date(),
        },
        { tx, ctx },
      ),
    );
    expect(again).toBe(0);
  });

  it("gates person-level topics on analytics mode, consent, erasure and the module; strips session ids", async () => {
    const { id, secret } = await createEndpoint("views", ["document.viewed"]);
    const member = await newInvestor();
    const ctx = systemContext(acmeId);
    const fan = (membershipId: string) =>
      running.container.db.withTenant(ctx, (tx) =>
        running.container.webhooks.fanOut(
          {
            outboxId: 900_000_000 + Math.floor(Math.random() * 1_000_000),
            topic: "document.viewed",
            payload: {
              documentId: randomUUID(),
              versionId: randomUUID(),
              membershipId,
              sessionId: randomUUID(),
            },
            schemaVersion: 1,
            createdAt: new Date(),
          },
          { tx, ctx },
        ),
      );
    const setAnalytics = (mode: string) =>
      sql(
        `UPDATE core.workspace SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{analytics}', jsonb_build_object('mode', $2::text)) WHERE id = $1`,
        [acmeId, mode],
      );
    const unconsented = await newInvestor();
    await sql(
      "INSERT INTO core.consent_event (workspace_id, membership_id, purpose, granted, source) VALUES ($1, $2, 'analytics_engagement', true, 'settings')",
      [acmeId, member],
    );
    // essential (the default): person-level tracking is off → nothing, consent or not.
    expect(await fan(member)).toBe(0);
    expect(await fan(unconsented)).toBe(0);
    // engagement: no consent under opt_in → nothing; consent granted → delivered.
    await setAnalytics("engagement");
    expect(await fan(unconsented)).toBe(0);
    expect(await fan(member)).toBe(1);
    // The data-room module switched off → nothing, whatever the consent says.
    await sql(
      "INSERT INTO core.module_enablement (workspace_id, module, enabled) VALUES ($1, 'data-room', false)",
      [acmeId],
    );
    expect(await fan(member)).toBe(0);
    await sql(
      "DELETE FROM core.module_enablement WHERE workspace_id = $1 AND module = 'data-room'",
      [acmeId],
    );
    // An erasure request on file → nothing.
    const erased = await newInvestor();
    await sql(
      "INSERT INTO core.consent_event (workspace_id, membership_id, purpose, granted, source) VALUES ($1, $2, 'analytics_engagement', true, 'settings')",
      [acmeId, erased],
    );
    expect(await fan(erased)).toBe(1);
    await sql(
      "INSERT INTO core.dsar_request (workspace_id, membership_id, requested_by, due_at) VALUES ($1, $2, $3, now() + interval '30 days')",
      [acmeId, erased, owner.membershipId],
    );
    expect(await fan(erased)).toBe(0);

    // End to end through the outbox: what reaches the receiver has no session id.
    const documentId = randomUUID();
    await running.container.db.withTenant(ctx, (tx) =>
      publish(tx, ctx, "document.viewed", {
        documentId,
        versionId: randomUUID(),
        membershipId: member,
        sessionId: randomUUID(),
      }),
    );
    const hit = await waitFor("the document.viewed delivery", async () =>
      hitsFor("views").find((h) => h.json.data?.["documentId"] === documentId),
    );
    await verify(hit, secret);
    expect(hit.json.data).toEqual({
      documentId,
      versionId: expect.any(String),
      membershipId: member,
    });
    expect(hit.body.toLowerCase()).not.toContain("session");
    const stored = await rowsOf(id);
    expect(JSON.stringify(stored.map((r) => r.payload)).toLowerCase()).not.toContain("session");
    await setAnalytics("essential");
  });

  it("retries with the schedule (Retry-After honoured) and dead-letters after 10 attempts", async () => {
    const { id } = await createEndpoint("flaky", ["membership.created"], {
      behaviour: { status: 503, headers: { "retry-after": "120" }, body: "busy" },
    });
    const membershipId = await newInvestor();
    const first = await waitFor("the first failed attempt", async () => {
      const [r] = await rowsOf(id);
      return r?.status === "pending" && r.attempts === 1 ? r : undefined;
    });
    expect(first.payload["data"]).toMatchObject({ membershipId });
    expect(first.last_status_code).toBe(503);
    expect(first.last_error).toBe("HTTP 503");
    // Retry-After 120 beats the scheduled 30 s.
    const wait = (first.next_attempt_at as Date).getTime() - Date.now();
    expect(wait).toBeGreaterThan(100_000);
    expect(wait).toBeLessThan(125_000);
    behaviours.set("flaky", { status: 500 });
    for (let i = 0; i < 12; i++) {
      const [r] = await rowsOf(id);
      if (r?.status === "failed") break;
      await drive(id);
    }
    const [dead] = await rowsOf(id);
    expect(dead).toMatchObject({ status: "failed", attempts: 10, next_attempt_at: null });
    expect(hitsFor("flaky").filter((h) => h.json.id === dead?.id)).toHaveLength(10);
    // Every attempt carried the same webhook-id.
    expect(new Set(hitsFor("flaky").map((h) => h.headers["webhook-id"]))).toEqual(
      new Set([dead?.id]),
    );
    expect((await endpointRow(id))?.consecutive_failures).toBe(1);
    const dlq = await json<{ items: DeliveryBody[] }>(
      await api("GET", `/webhooks/deliveries?endpointId=${id}&status=failed`),
    );
    expect(dlq.items.map((d) => d.id)).toEqual([dead?.id]);
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });

  it("disables an endpoint that answers 410 at once, cancelling its queue, audited as system", async () => {
    const { id } = await createEndpoint("gone", ["membership.created"], {
      behaviour: { status: 500 },
    });
    await newInvestor();
    await waitFor("a pending retry", async () => {
      const rows = await rowsOf(id);
      return rows.some((r) => r.status === "pending" && r.attempts === 1) ? true : undefined;
    });
    // A second queued row that stays queued (not due for an hour).
    await newInvestor();
    await waitFor("two rows", async () => ((await rowsOf(id)).length === 2 ? true : undefined));
    await waitFor("both attempted once", async () =>
      (await rowsOf(id)).every((r) => r.attempts === 1 && r.status === "pending")
        ? true
        : undefined,
    );
    const [one, two] = await rowsOf(id);
    await sql(
      "UPDATE core.webhook_delivery SET next_attempt_at = now() + interval '1 hour' WHERE id = $1",
      [two?.id],
    );
    behaviours.set("gone", { status: 410 });
    await sql(
      "UPDATE core.webhook_delivery SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
      [one?.id],
    );
    await running.container.webhooks.deliverWorkspace(acmeId);
    await waitFor("the endpoint to be disabled", async () =>
      (await endpointRow(id))?.enabled === false ? true : undefined,
    );
    expect(await endpointRow(id)).toMatchObject({ enabled: false, disabled_reason: "gone" });
    const rows = await rowsOf(id);
    expect(rows.find((r) => r.id === one?.id)).toMatchObject({
      status: "failed",
      last_status_code: 410,
    });
    expect(rows.find((r) => r.id === two?.id)).toMatchObject({
      status: "cancelled",
      next_attempt_at: null,
    });
    const audit = await sql<{ actor_kind: string; meta: { reason: string } }>(
      "SELECT actor_kind, meta FROM audit.event WHERE workspace_id = $1 AND action = 'webhook.endpoint_disabled' AND resource_id = $2",
      [acmeId, id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: "system", meta: { reason: "gone" } });
    // A disabled endpoint gets no fan-out, no ping and no redelivery.
    const before = (await rowsOf(id)).length;
    await newInvestor();
    const test = await api("POST", `/webhooks/endpoints/${id}/test`);
    expect(test.status).toBe(409);
    expect((await json<ApiErr>(test)).error.reason).toBe("endpoint_disabled");
    const redeliver = await api("POST", `/webhooks/deliveries/${one?.id}/redeliver`);
    expect(redeliver.status).toBe(409);
    expect((await json<ApiErr>(redeliver)).error.reason).toBe("endpoint_disabled");
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await rowsOf(id)).length).toBe(before);
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });

  it("auto-disables after 20 exhausted deliveries in a row (failing), once, and re-enables clean", async () => {
    const { id } = await createEndpoint("failing", ["membership.created"], {
      behaviour: { status: 500 },
    });
    await newInvestor();
    await newInvestor();
    await waitFor("two retries queued", async () => {
      const rows = await rowsOf(id);
      return rows.length === 2 && rows.every((r) => r.status === "pending" && r.attempts === 1)
        ? true
        : undefined;
    });
    const [one, two] = await rowsOf(id);
    await sql("UPDATE core.webhook_endpoint SET consecutive_failures = 19 WHERE id = $1", [id]);
    // `one` is on its last attempt; `two` stays queued for later.
    await sql(
      "UPDATE core.webhook_delivery SET attempts = 9, next_attempt_at = now() - interval '1 second' WHERE id = $1",
      [one?.id],
    );
    await sql(
      "UPDATE core.webhook_delivery SET next_attempt_at = now() + interval '1 hour' WHERE id = $1",
      [two?.id],
    );
    await running.container.webhooks.deliverWorkspace(acmeId);
    await waitFor("auto-disable", async () =>
      (await endpointRow(id))?.enabled === false ? true : undefined,
    );
    expect(await endpointRow(id)).toMatchObject({
      enabled: false,
      disabled_reason: "failing",
      consecutive_failures: 20,
    });
    const rows = await rowsOf(id);
    expect(rows.find((r) => r.id === one?.id)?.status).toBe("failed");
    expect(rows.find((r) => r.id === two?.id)?.status).toBe("cancelled");
    const disabled = await sql(
      "SELECT 1 FROM audit.event WHERE workspace_id = $1 AND action = 'webhook.endpoint_disabled' AND resource_id = $2",
      [acmeId, id],
    );
    expect(disabled).toHaveLength(1);
    const ep = await json<EndpointBody>(await api("GET", `/webhooks/endpoints/${id}`));
    expect(ep).toMatchObject({ enabled: false, disabledReason: "failing" });
    // Re-enabling clears the reason and the count.
    const on = await api("PATCH", `/webhooks/endpoints/${id}`, { enabled: true });
    expect(on.status).toBe(200);
    expect(await json<EndpointBody>(on)).toMatchObject({
      enabled: true,
      disabledReason: null,
      consecutiveFailures: 0,
    });
    // A manual disable says so and cancels what is queued.
    behaviours.set("failing", { status: 204 });
    const off = await api("PATCH", `/webhooks/endpoints/${id}`, { enabled: false });
    expect(await json<EndpointBody>(off)).toMatchObject({
      enabled: false,
      disabledReason: "manual",
    });
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });

  it("redelivers under a new webhook-id with the same eventId, and pings", async () => {
    const { id, secret } = await createEndpoint("again");
    const membershipId = await newInvestor();
    const original = await waitFor("the delivery", async () =>
      hitsFor("again").find((h) => h.json.data?.["membershipId"] === membershipId),
    );
    await waitFor("succeeded", async () =>
      (await rowsOf(id)).some((r) => r.status === "succeeded") ? true : undefined,
    );
    const res = await api("POST", `/webhooks/deliveries/${original.json.id}/redeliver`);
    expect(res.status).toBe(202);
    const { delivery } = await json<{ delivery: DeliveryBody }>(res);
    expect(delivery.id).not.toBe(original.json.id);
    expect(delivery).toMatchObject({
      manual: true,
      topic: "membership.created",
      eventId: original.json.eventId,
      status: "pending",
    });
    const resent = await waitFor("the redelivery", async () =>
      hitsFor("again").find((h) => h.json.id === delivery.id),
    );
    await verify(resent, secret);
    expect(resent.headers["webhook-id"]).toBe(delivery.id);
    expect(resent.json.eventId).toBe(original.json.eventId);
    expect(resent.json.data).toEqual(original.json.data);
    expect(resent.json.timestamp).toBe(original.json.timestamp);
    expect((await api("POST", `/webhooks/deliveries/${randomUUID()}/redeliver`)).status).toBe(404);

    const ping = await api("POST", `/webhooks/endpoints/${id}/test`);
    expect(ping.status).toBe(202);
    const pinged = (await json<{ delivery: DeliveryBody }>(ping)).delivery;
    expect(pinged).toMatchObject({ topic: "webhook.ping", manual: true });
    expect(pinged.eventId).toMatch(/^ping:/u);
    const pingHit = await waitFor("the ping", async () =>
      hitsFor("again").find((h) => h.json.id === pinged.id),
    );
    await verify(pingHit, secret);
    expect(pingHit.json).toMatchObject({ type: "webhook.ping", data: { endpointId: id } });
    const audit = await sql<{ action: string }>(
      "SELECT action FROM audit.event WHERE workspace_id = $1 AND action IN ('webhook.redelivered', 'webhook.tested') AND (resource_id = $2 OR resource_id = $3)",
      [acmeId, delivery.id, id],
    );
    expect(audit.map((a) => a.action).sort()).toEqual(["webhook.redelivered", "webhook.tested"]);

    // A failing ping is one attempt, and never counts toward auto-disable.
    behaviours.set("again", { status: 500 });
    const bad = (
      await json<{ delivery: DeliveryBody }>(await api("POST", `/webhooks/endpoints/${id}/test`))
    ).delivery;
    await waitFor("the failed ping", async () => {
      const r = (await rowsOf(id)).find((x) => x.id === bad.id);
      return r?.status === "failed" ? r : undefined;
    });
    expect((await endpointRow(id))?.consecutive_failures).toBe(0);
    // Ten a minute per endpoint (two used above).
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      statuses.push((await api("POST", `/webhooks/endpoints/${id}/test`)).status);
    }
    expect(statuses.slice(0, 8).every((s) => s === 202)).toBe(true);
    const limited = await api("POST", `/webhooks/endpoints/${id}/test`);
    expect(statuses[8] === 429 || limited.status === 429).toBe(true);
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });

  it("signs with both secrets during a rotation's overlap, and with the new one only after", async () => {
    const { id, secret: first } = await createEndpoint("rotor");
    const rotated = await api("POST", `/webhooks/endpoints/${id}/rotate-secret`, {
      graceHours: 24,
    });
    expect(rotated.status).toBe(200);
    const { secret: second, endpoint } = await json<{ secret: string; endpoint: EndpointBody }>(
      rotated,
    );
    expect(second).not.toBe(first);
    expect(endpoint.secretRotating).toBe(true);
    const m1 = await newInvestor();
    const h1 = await waitFor("an overlap delivery", async () =>
      hitsFor("rotor").find((h) => h.json.data?.["membershipId"] === m1),
    );
    expect(String(h1.headers["webhook-signature"]).split(" ")).toHaveLength(2);
    await verify(h1, first);
    await verify(h1, second);

    // Fix D6: a second overlapping rotation would drop `first` before its grace ends.
    const again = await api("POST", `/webhooks/endpoints/${id}/rotate-secret`, { graceHours: 24 });
    expect(again.status).toBe(409);
    expect((await json<ApiErr>(again)).error.reason).toBe("rotation_in_progress");
    const hard = await api("POST", `/webhooks/endpoints/${id}/rotate-secret`, { graceHours: 0 });
    const { secret: third, endpoint: after } = await json<{
      secret: string;
      endpoint: EndpointBody;
    }>(hard);
    expect(after.secretRotating).toBe(false);
    const m2 = await newInvestor();
    const h2 = await waitFor("a post-rotation delivery", async () =>
      hitsFor("rotor").find((h) => h.json.data?.["membershipId"] === m2),
    );
    expect(String(h2.headers["webhook-signature"]).split(" ")).toHaveLength(1);
    await verify(h2, third);
    await expect(verify(h2, second)).rejects.toBeInstanceOf(WebhookVerificationError);
    const audit = await sql(
      "SELECT 1 FROM audit.event WHERE workspace_id = $1 AND action = 'webhook.secret_rotated' AND resource_id = $2",
      [acmeId, id],
    );
    expect(audit).toHaveLength(2);
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });
});

describe("the delivery log", () => {
  it("pages newest first by keyset, filters, and answers API keys on the two reads only", async () => {
    const { id } = await createEndpoint("log");
    const members: string[] = [];
    for (let i = 0; i < 5; i++) members.push(await newInvestor());
    await waitFor("five deliveries", async () =>
      (await rowsOf(id)).filter((r) => r.status === "succeeded").length === 5 ? true : undefined,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = `/webhooks/deliveries?endpointId=${id}&limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const page = await json<{ items: DeliveryBody[]; nextCursor: string | null }>(
        await api("GET", q),
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      for (const d of page.items) {
        expect(d.payload).toBeUndefined();
        seen.push(d.id);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    const ordered = await sql<{ id: string }>(
      "SELECT id FROM core.webhook_delivery WHERE endpoint_id = $1 ORDER BY created_at DESC, id DESC",
      [id],
    );
    expect(seen).toEqual(ordered.map((r) => r.id));
    expect(new Set(seen).size).toBe(5);
    const none = await json<{ items: DeliveryBody[] }>(
      await api("GET", `/webhooks/deliveries?endpointId=${id}&topic=document.viewed`),
    );
    expect(none.items).toEqual([]);
    const bad = await api("GET", "/webhooks/deliveries?cursor=bm9wZQ");
    expect(bad.status).toBe(400);
    expect((await json<ApiErr>(bad)).error.reason).toBe("invalid_cursor");

    const key = await mintTestApiKey(running.container.db, {
      workspaceId: acmeId,
      creatorMembershipId: owner.membershipId,
      scopes: ["webhooks.read"],
    });
    const viaKey = (path: string, method = "GET") =>
      running.app.request(`http://acme.${CANON}/api/v1${path}`, {
        method,
        headers: { host: `acme.${CANON}`, ...bearer(key.token) },
      });
    const listed = await viaKey(`/webhooks/deliveries?endpointId=${id}`);
    expect(listed.status).toBe(200);
    expect((await json<{ items: DeliveryBody[] }>(listed)).items).toHaveLength(5);
    const one = await viaKey(`/webhooks/deliveries/${seen[0]}`);
    expect(one.status).toBe(200);
    expect((await json<DeliveryBody>(one)).payload).toBeDefined();
    for (const [path, method] of [
      ["/webhooks/endpoints", "GET"],
      ["/webhooks/topics", "GET"],
      [`/webhooks/deliveries/${seen[0]}/redeliver`, "POST"],
    ] as const) {
      const res = await viaKey(path, method);
      expect(res.status, path).toBe(401);
      expect((await json<ApiErr>(res)).error.reason).toBe("api_key_not_allowed");
    }
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });

  it("an endpoint's deliveries go with it", async () => {
    const { id } = await createEndpoint("cascade");
    await newInvestor();
    await waitFor("a delivery", async () => ((await rowsOf(id)).length > 0 ? true : undefined));
    const del = await api("DELETE", `/webhooks/endpoints/${id}`);
    expect(del.status).toBe(200);
    expect(await rowsOf(id)).toEqual([]);
    expect((await api("GET", `/webhooks/endpoints/${id}`)).status).toBe(404);
    expect((await api("DELETE", `/webhooks/endpoints/${id}`)).status).toBe(404);
    const audit = await sql(
      "SELECT 1 FROM audit.event WHERE workspace_id = $1 AND action = 'webhook.endpoint_deleted' AND resource_id = $2",
      [acmeId, id],
    );
    expect(audit).toHaveLength(1);
  });

  it("keeps 30 days of finished deliveries, never live ones, and nothing under legal hold", async () => {
    const { id } = await createEndpoint("old");
    await newInvestor();
    await newInvestor();
    await waitFor("two done", async () =>
      (await rowsOf(id)).filter((r) => r.status === "succeeded").length === 2 ? true : undefined,
    );
    const [a, b] = await rowsOf(id);
    await sql(
      "UPDATE core.webhook_delivery SET created_at = now() - interval '31 days' WHERE endpoint_id = $1",
      [id],
    );
    await sql(
      "UPDATE core.webhook_delivery SET status = 'pending', next_attempt_at = now() + interval '1 day' WHERE id = $1",
      [b?.id],
    );
    await sql(
      `UPDATE core.workspace SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{legal}', '{"legalHold": true}'::jsonb) WHERE id = $1`,
      [acmeId],
    );
    expect(await running.container.webhooks.applyRetention(acmeId)).toEqual({
      skipped: "legal_hold",
      deleted: 0,
    });
    expect(await rowsOf(id)).toHaveLength(2);
    await sql(
      `UPDATE core.workspace SET settings = jsonb_set(settings, '{legal}', '{"legalHold": false}'::jsonb) WHERE id = $1`,
      [acmeId],
    );
    const r = await running.container.webhooks.applyRetention(acmeId);
    expect(r.skipped).toBeNull();
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    const left = await rowsOf(id);
    expect(left.map((x) => x.id)).toEqual([b?.id]);
    expect(left.map((x) => x.id)).not.toContain(a?.id);
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });
});

describe("isolation and erasure", () => {
  it("one workspace never sees, triggers or redelivers another's webhooks", async () => {
    const acme = await createEndpoint("acme-iso");
    const beta = await createEndpoint("beta-iso", ["membership.created"], {
      actor: betaOwner,
      slug: "beta",
    });
    const betaMember = await newInvestor(betaId);
    await waitFor("beta's delivery", async () =>
      hitsFor("beta-iso").find((h) => h.json.data?.["membershipId"] === betaMember),
    );
    const betaHit = hitsFor("beta-iso").find((h) => h.json.data?.["membershipId"] === betaMember);
    expect(betaHit?.json.workspaceId).toBe(betaId);
    // Give acme's subscriber the same chance, then check it saw nothing of beta.
    const acmeMember = await newInvestor();
    await waitFor("acme's own delivery", async () =>
      hitsFor("acme-iso").find((h) => h.json.data?.["membershipId"] === acmeMember),
    );
    expect(hitsFor("acme-iso").some((h) => h.json.data?.["membershipId"] === betaMember)).toBe(
      false,
    );
    const betaOpts = { actor: betaOwner, slug: "beta" };
    expect((await api("GET", `/webhooks/endpoints/${acme.id}`, undefined, betaOpts)).status).toBe(
      404,
    );
    expect(
      (await api("PATCH", `/webhooks/endpoints/${acme.id}`, { enabled: false }, betaOpts)).status,
    ).toBe(404);
    expect(
      (await api("POST", `/webhooks/endpoints/${acme.id}/test`, undefined, betaOpts)).status,
    ).toBe(404);
    const acmeDelivery = (await rowsOf(acme.id))[0];
    expect(
      (await api("GET", `/webhooks/deliveries/${acmeDelivery?.id}`, undefined, betaOpts)).status,
    ).toBe(404);
    expect(
      (await api("POST", `/webhooks/deliveries/${acmeDelivery?.id}/redeliver`, undefined, betaOpts))
        .status,
    ).toBe(404);
    // Fix D7: beta cannot spend acme's per-endpoint test budget by guessing the id.
    for (let i = 0; i < 12; i++) {
      expect(
        (await api("POST", `/webhooks/endpoints/${acme.id}/test`, undefined, betaOpts)).status,
      ).toBe(404);
    }
    expect((await api("POST", `/webhooks/endpoints/${acme.id}/test`)).status).toBe(202);
    const betaList = await json<{ items: DeliveryBody[] }>(
      await api("GET", "/webhooks/deliveries", undefined, betaOpts),
    );
    expect(betaList.items.every((d) => d.endpointId === beta.id)).toBe(true);
    await api("DELETE", `/webhooks/endpoints/${acme.id}`);
    await api("DELETE", `/webhooks/endpoints/${beta.id}`, undefined, betaOpts);
  });

  it("identity erasure deletes the member's undelivered deliveries and keeps delivered ones", async () => {
    const { id } = await createEndpoint("erase", ["membership.created"]);
    const member = await newInvestor();
    await waitFor("delivered", async () =>
      (await rowsOf(id)).some((r) => r.status === "succeeded") ? true : undefined,
    );
    const [delivered] = await rowsOf(id);
    // Two undelivered rows naming the member: a queued retry and a dead letter.
    const ctx = systemContext(acmeId);
    for (const status of ["pending", "failed"] as const) {
      await sql(
        `INSERT INTO core.webhook_delivery (workspace_id, endpoint_id, topic, event_id, payload, status, next_attempt_at, manual)
         VALUES ($1, $2, 'membership.created', $3, $4::jsonb, $5, $6, true)`,
        [
          acmeId,
          id,
          `manual-${status}`,
          JSON.stringify({ type: "membership.created", data: { membershipId: member } }),
          status,
          status === "pending" ? new Date(Date.now() + 3_600_000) : null,
        ],
      );
    }
    // And one about somebody else, which stays.
    await sql(
      `INSERT INTO core.webhook_delivery (workspace_id, endpoint_id, topic, event_id, payload, status, next_attempt_at, manual)
       VALUES ($1, $2, 'membership.revoked', 'other', $3::jsonb, 'failed', NULL, true)`,
      [acmeId, id, JSON.stringify({ data: { membershipIds: [randomUUID()] } })],
    );
    const [dsar] = await sql<DsarRequest>(
      `INSERT INTO core.dsar_request (workspace_id, membership_id, requested_by, due_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now() + interval '30 days')
       RETURNING id, workspace_id AS "workspaceId", membership_id AS "membershipId"`,
      [acmeId, member, owner.membershipId],
    );
    const erased = await running.container.db.withTenant(ctx, (tx) =>
      eraseIdentity(
        { audit: running.container.audit, bookingSuppressionKeys: running.container.envelope },
        ctx,
        tx,
        dsar as DsarRequest,
        new Date(),
      ),
    );
    expect(erased.counts).toMatchObject({ webhookDeliveries: 2 });
    const left = await rowsOf(id);
    expect(left.map((r) => r.event_id).sort()).toEqual([delivered?.event_id ?? "", "other"].sort());
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });
});

describe("fix round 1", () => {
  async function pendingRetry(endpointId: string): Promise<Row> {
    return waitFor("a pending retry", async () => {
      const r = (await rowsOf(endpointId)).find((x) => x.status === "pending" && x.attempts >= 1);
      return r;
    });
  }

  it("D1: an erased member's deliveries are neither redelivered nor retried", async () => {
    const { id } = await createEndpoint("d1erase");
    const member = await newInvestor();
    const sent = await waitFor("delivered", async () =>
      (await rowsOf(id)).find((r) => r.status === "succeeded"),
    );
    behaviours.set("d1erase", { status: 500 });
    const other = await newInvestor();
    const retry = await pendingRetry(id);
    expect(retry.payload["data"]).toMatchObject({ membershipId: other });
    for (const m of [member, other]) {
      await sql(
        "INSERT INTO core.dsar_request (workspace_id, membership_id, requested_by, due_at) VALUES ($1, $2, $3, now() + interval '30 days')",
        [acmeId, m, owner.membershipId],
      );
    }
    const refused = await api("POST", `/webhooks/deliveries/${sent.id}/redeliver`);
    expect(refused.status).toBe(409);
    expect((await json<ApiErr>(refused)).error.reason).toBe("subject_erased");
    const before = hitsFor("d1erase").length;
    await drive(id);
    const cancelled = (await rowsOf(id)).find((r) => r.id === retry.id);
    expect(cancelled).toMatchObject({ status: "cancelled", last_error: "subject_erased" });
    expect(hitsFor("d1erase").length).toBe(before);
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });

  it("D1: withdrawn consent cancels a queued person-level retry and refuses its redelivery", async () => {
    const { id } = await createEndpoint("d1consent", ["document.viewed"], {
      behaviour: { status: 500 },
    });
    const member = await newInvestor();
    await sql(
      `UPDATE core.workspace SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{analytics}', '{"mode":"engagement"}'::jsonb) WHERE id = $1`,
      [acmeId],
    );
    try {
      await sql(
        "INSERT INTO core.consent_event (workspace_id, membership_id, purpose, granted, source) VALUES ($1, $2, 'analytics_engagement', true, 'settings')",
        [acmeId, member],
      );
      const ctx = systemContext(acmeId);
      await running.container.db.withTenant(ctx, (tx) =>
        publish(tx, ctx, "document.viewed", {
          documentId: randomUUID(),
          versionId: randomUUID(),
          membershipId: member,
          sessionId: null,
        }),
      );
      const retry = await pendingRetry(id);
      await sql(
        "INSERT INTO core.consent_event (workspace_id, membership_id, purpose, granted, source) VALUES ($1, $2, 'analytics_engagement', false, 'settings')",
        [acmeId, member],
      );
      const refused = await api("POST", `/webhooks/deliveries/${retry.id}/redeliver`);
      expect(refused.status).toBe(409);
      expect((await json<ApiErr>(refused)).error.reason).toBe("tracking_not_allowed");
      const before = hitsFor("d1consent").length;
      await drive(id);
      expect((await rowsOf(id)).find((r) => r.id === retry.id)).toMatchObject({
        status: "cancelled",
        last_error: "consent_withdrawn",
      });
      expect(hitsFor("d1consent").length).toBe(before);
    } finally {
      await sql(
        `UPDATE core.workspace SET settings = jsonb_set(settings, '{analytics}', '{"mode":"essential"}'::jsonb) WHERE id = $1`,
        [acmeId],
      );
      await api("DELETE", `/webhooks/endpoints/${id}`);
    }
  });

  it("D8: a topic unsubscribed or a module switched off cancels queued rows and refuses redelivery", async () => {
    const { id } = await createEndpoint("d8", ["membership.created", "document.viewed"], {
      behaviour: { status: 500 },
    });
    await newInvestor();
    const retry = await pendingRetry(id);
    // Unsubscribed from the topic.
    expect(
      (await api("PATCH", `/webhooks/endpoints/${id}`, { events: ["document.viewed"] })).status,
    ).toBe(200);
    const refused = await api("POST", `/webhooks/deliveries/${retry.id}/redeliver`);
    expect(refused.status).toBe(409);
    expect((await json<ApiErr>(refused)).error.reason).toBe("topic_unavailable");
    await drive(id);
    expect((await rowsOf(id)).find((r) => r.id === retry.id)).toMatchObject({
      status: "cancelled",
      last_error: "topic_unavailable",
    });
    // The declaring module switched off (a queued row inserted as fan-out would have left it).
    const [queued] = await sql<{ id: string }>(
      `INSERT INTO core.webhook_delivery (workspace_id, endpoint_id, topic, event_id, payload, status, next_attempt_at)
       VALUES ($1, $2, 'document.viewed', 'd8-mod', '{"type":"document.viewed","data":{}}'::jsonb, 'pending', now() + interval '1 hour')
       RETURNING id`,
      [acmeId, id],
    );
    await sql(
      "INSERT INTO core.module_enablement (workspace_id, module, enabled) VALUES ($1, 'data-room', false)",
      [acmeId],
    );
    try {
      await drive(id);
      expect((await rowsOf(id)).find((r) => r.id === queued?.id)).toMatchObject({
        status: "cancelled",
        last_error: "topic_unavailable",
      });
    } finally {
      await sql(
        "DELETE FROM core.module_enablement WHERE workspace_id = $1 AND module = 'data-room'",
        [acmeId],
      );
      await api("DELETE", `/webhooks/endpoints/${id}`);
    }
  });

  it("D2: a backed-up endpoint cannot starve another endpoint of the same workspace", async () => {
    const busy = await createEndpoint("d2busy");
    const quiet = await createEndpoint("d2quiet");
    // Busy: 10 fresh claims in flight elsewhere + 90 overdue rows. Quiet: one due row.
    await sql(
      `INSERT INTO core.webhook_delivery (workspace_id, endpoint_id, topic, event_id, payload, status, claimed_at, attempts)
       SELECT $1, $2, 'membership.created', 'd2s-' || g, '{"type":"membership.created","data":{}}'::jsonb, 'sending', now(), 1
         FROM generate_series(1, 10) g`,
      [acmeId, busy.id],
    );
    await sql(
      `INSERT INTO core.webhook_delivery (workspace_id, endpoint_id, topic, event_id, payload, status, next_attempt_at)
       SELECT $1, $2, 'membership.created', 'd2p-' || g, '{"type":"membership.created","data":{}}'::jsonb, 'pending', now() - interval '1 hour'
         FROM generate_series(1, 90) g`,
      [acmeId, busy.id],
    );
    await sql(
      `INSERT INTO core.webhook_delivery (workspace_id, endpoint_id, topic, event_id, payload, status, next_attempt_at)
       VALUES ($1, $2, 'membership.created', 'd2q', '{"type":"membership.created","data":{}}'::jsonb, 'pending', now())`,
      [acmeId, quiet.id],
    );
    await running.container.webhooks.deliverWorkspace(acmeId);
    await waitFor("the quiet endpoint's row delivered", async () =>
      (await rowsOf(quiet.id)).every((r) => r.status === "succeeded") ? true : undefined,
    );
    // The busy endpoint stayed at its cap: nothing of it was claimed on top of the 10.
    const busyRows = await rowsOf(busy.id);
    expect(busyRows.filter((r) => r.status === "pending")).toHaveLength(90);
    expect(hitsFor("d2busy")).toHaveLength(0);
    await sql("DELETE FROM core.webhook_endpoint WHERE id = ANY($1::uuid[])", [
      [busy.id, quiet.id],
    ]);
  });

  it("D3: a workspace's turn is bounded, and the sweep only enqueues", async () => {
    const { id } = await createEndpoint("d3", ["membership.created"], {
      behaviour: { status: 204, delayMs: 1_000 },
    });
    await sql(
      `INSERT INTO core.webhook_delivery (workspace_id, endpoint_id, topic, event_id, payload, status, next_attempt_at)
       SELECT $1, $2, 'membership.created', 'd3-' || g, '{"type":"membership.created","data":{}}'::jsonb, 'pending', now() - interval '1 second'
         FROM generate_series(1, 30) g`,
      [acmeId, id],
    );
    // One bounded turn: a single claim round (≤ 10 in flight for the endpoint), then `more`.
    const turn = await running.container.webhooks.deliverWorkspace(acmeId, undefined, {
      turnMs: 50,
    });
    expect(turn.more).toBe(true);
    expect(turn.claimed).toBeGreaterThan(0);
    expect(turn.claimed).toBeLessThanOrEqual(10);
    // The sweep finds the due workspace and enqueues it without sending anything itself (≥ 20
    // rows at 1 s each would take seconds).
    const started = Date.now();
    expect(await running.container.webhooks.enqueueDue()).toBeGreaterThanOrEqual(1);
    expect(Date.now() - started).toBeLessThan(1_000);
    await sql("DELETE FROM core.webhook_endpoint WHERE id = $1", [id]);
  });

  it("D4: a 2xx with a body over 64 KiB is a success (no excerpt)", async () => {
    const { id } = await createEndpoint("d4", ["membership.created"], {
      // A declared length over the cap: the guard never reads the body (a chunked one would be
      // read up to the cap, and its first 512 characters kept as usual).
      behaviour: {
        status: 200,
        headers: { "content-length": String(200 * 1024) },
        body: "x".repeat(200 * 1024),
      },
    });
    const member = await newInvestor();
    const row = await waitFor("the delivery settled", async () => {
      const r = (await rowsOf(id)).find(
        (x) => (x.payload["data"] as { membershipId?: string })?.membershipId === member,
      );
      return r !== undefined && r.status !== "sending" && r.attempts >= 1 ? r : undefined;
    });
    expect(row).toMatchObject({ status: "succeeded", last_status_code: 200, attempts: 1 });
    const detail = await json<DeliveryBody>(await api("GET", `/webhooks/deliveries/${row.id}`));
    expect(detail.lastResponseExcerpt).toBeNull();
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });

  it("D5: an answer from the old URL has no endpoint side effects after a re-point", async () => {
    const { id } = await createEndpoint("d5old", ["membership.created"], {
      behaviour: { status: 410, delayMs: 1_500 },
    });
    behaviours.set("d5new", { status: 204 });
    const member = await newInvestor();
    await waitFor("the in-flight POST to the old URL", async () =>
      hitsFor("d5old").find((h) => h.json.data?.["membershipId"] === member),
    );
    const repointed = await api("PATCH", `/webhooks/endpoints/${id}`, { url: hookUrl("d5new") });
    expect(repointed.status).toBe(200);
    // This member's row (earlier tests' outbox backlog may fan out here too).
    const row = await waitFor("the attempt recorded", async () => {
      const r = (await rowsOf(id)).find(
        (x) => (x.payload["data"] as { membershipId?: string })?.membershipId === member,
      );
      return r !== undefined && r.status !== "sending" ? r : undefined;
    });
    expect(row).toMatchObject({ status: "pending", last_status_code: 410 });
    expect(await endpointRow(id)).toMatchObject({ enabled: true, disabled_reason: null });
    await drive(id);
    expect(hitsFor("d5new").some((h) => h.json.data?.["membershipId"] === member)).toBe(true);
    expect((await rowsOf(id)).find((r) => r.id === row.id)?.status).toBe("succeeded");
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });
});

describe("fix round 2", () => {
  async function insertRow(endpointId: string, topic: string, data: unknown, eventId: string) {
    const [r] = await sql<{ id: string }>(
      `INSERT INTO core.webhook_delivery (workspace_id, endpoint_id, topic, event_id, payload, status, next_attempt_at, manual)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'failed', NULL, false) RETURNING id`,
      [acmeId, endpointId, topic, eventId, JSON.stringify({ type: topic, data })],
    );
    return r?.id as string;
  }

  it("R2: only the erasure notice's own subjects are exempt from the erased-member check", async () => {
    const { id } = await createEndpoint("r2", ["membership.revoked"]);
    const erased = await newInvestor();
    const alsoErased = await newInvestor();
    const alive = await newInvestor();
    for (const m of [erased, alsoErased]) {
      await sql(
        "INSERT INTO core.dsar_request (workspace_id, membership_id, requested_by, due_at) VALUES ($1, $2, $3, now() + interval '30 days')",
        [acmeId, m, owner.membershipId],
      );
    }
    const redeliver = (rowId: string) => api("POST", `/webhooks/deliveries/${rowId}/redeliver`);
    // An ordinary revocation BY an erased member: the erased id is not the notice's subject.
    const byErased = await insertRow(
      id,
      "membership.revoked",
      { membershipIds: [alive], byMembershipId: erased, reason: "revoked" },
      "r2-a",
    );
    const a = await redeliver(byErased);
    expect(a.status).toBe(409);
    expect((await json<ApiErr>(a)).error.reason).toBe("subject_erased");
    // The erasure notice itself still goes out (receivers erase downstream on it)…
    const notice = await insertRow(
      id,
      "membership.revoked",
      { membershipIds: [erased], byMembershipId: null, reason: "erased" },
      "r2-b",
    );
    expect((await redeliver(notice)).status).toBe(202);
    // …but not when it also names another erased member outside its subjects.
    const mixed = await insertRow(
      id,
      "membership.revoked",
      { membershipIds: [erased], byMembershipId: alsoErased, reason: "erased" },
      "r2-c",
    );
    const c = await redeliver(mixed);
    expect(c.status).toBe(409);
    expect((await json<ApiErr>(c)).error.reason).toBe("subject_erased");
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });

  it("R3: wakes are keyed per workspace, so two workspaces' pings both enqueue a job", async () => {
    const acme = await createEndpoint("r3a");
    const beta = await createEndpoint("r3b", ["membership.created"], {
      actor: betaOwner,
      slug: "beta",
    });
    const [{ t0 } = { t0: "" }] = await sql<{ t0: string }>("SELECT now()::text AS t0");
    const [ra, rb] = await Promise.all([
      api("POST", `/webhooks/endpoints/${acme.id}/test`),
      api("POST", `/webhooks/endpoints/${beta.id}/test`, undefined, {
        actor: betaOwner,
        slug: "beta",
      }),
    ]);
    expect([ra.status, rb.status]).toEqual([202, 202]);
    // Each workspace has a wake: created by its ping, or already queued under its own key (a
    // queued job of the same workspace is exactly what a keyed wake dedupes against).
    const jobs = await sql<{ ws: string; key: string | null }>(
      `SELECT data->>'workspaceId' AS ws, singleton_key AS key FROM pgboss.job
        WHERE name = 'webhooks.deliver'
          AND singleton_key LIKE 'webhooks.deliver:ws:%'
          AND (created_on >= $1::timestamptz OR state = 'created')`,
      [t0],
    );
    expect(new Set(jobs.map((j) => j.ws))).toEqual(new Set([acmeId, betaId]));
    for (const j of jobs) expect(j.key).toBe(`webhooks.deliver:ws:${j.ws}`);
    await api("DELETE", `/webhooks/endpoints/${acme.id}`);
    await api("DELETE", `/webhooks/endpoints/${beta.id}`, undefined, {
      actor: betaOwner,
      slug: "beta",
    });
  });

  it("R4: a claim lost while waiting for a send slot is never POSTed", async () => {
    // The claim must be this call's, never the background workers'. So: a workspace of its own
    // (no members, so no fan-out adds rows to it) and an unstarted container whose clock runs an
    // hour ahead. The row is due in 30 minutes: due for that container's claim, and not due for
    // this server's sweep or deliver jobs, whatever they are doing meanwhile. (Making a row due
    // with Postgres now() instead is not enough: background workers may claim it first, and the
    // claim compares it with a millisecond JS clock, so on a clock shared with the database a
    // claim in the same millisecond finds it not yet due.)
    const ws = (await createWorkspace(running.container.db, { slug: "r4-claims", name: "R4" })).id;
    behaviours.set("r4", { status: 204 });
    const { endpoint } = await running.container.webhooks.createEndpoint(
      systemContext(ws),
      { url: hookUrl("r4"), events: ["membership.created"] },
      {},
    );
    const [row] = await sql<{ id: string }>(
      `INSERT INTO core.webhook_delivery (workspace_id, endpoint_id, topic, event_id, payload, status, next_attempt_at)
       VALUES ($1, $2, 'membership.created', 'r4', '{"type":"membership.created","data":{}}'::jsonb, 'pending', $3)
       RETURNING id`,
      [ws, endpoint.id, new Date(Date.now() + 30 * 60_000)],
    );
    const ahead = createContainer({
      config: testConfig(),
      logger: createLogger({ level: "warn" }),
      modules: COMPILED_IN_MODULES,
      mailer,
      now: () => new Date(Date.now() + 60 * 60_000),
    });
    try {
      const outcome = await ahead.webhooks.deliverWorkspace(ws, undefined, {
        afterClaim: async (claimed) => {
          if (!claimed.some((d) => d.id === row?.id)) return;
          // While this worker waited for a slot, its lease ran out and another worker re-claimed.
          await sql(
            "UPDATE core.webhook_delivery SET claimed_at = claimed_at + interval '1 second' WHERE id = $1",
            [row?.id],
          );
        },
      });
      expect(outcome.claimed).toBe(1);
    } finally {
      await ahead.stop();
    }
    expect(hitsFor("r4")).toHaveLength(0);
    const after = (await rowsOf(endpoint.id)).find((r) => r.id === row?.id);
    expect(after?.status).toBe("sending");
    await sql("DELETE FROM core.webhook_endpoint WHERE id = $1", [endpoint.id]);
  });

  it("R7: a failure from the old URL after a re-point still honours Retry-After", async () => {
    const { id } = await createEndpoint("r7old", ["membership.created"], {
      behaviour: { status: 503, headers: { "retry-after": "600" }, delayMs: 1_500 },
    });
    behaviours.set("r7new", { status: 204 });
    const member = await newInvestor();
    await waitFor("the in-flight POST", async () =>
      hitsFor("r7old").find((h) => h.json.data?.["membershipId"] === member),
    );
    expect(
      (await api("PATCH", `/webhooks/endpoints/${id}`, { url: hookUrl("r7new") })).status,
    ).toBe(200);
    // This member's row (earlier tests' outbox backlog may fan out here too).
    const row = await waitFor("the attempt recorded", async () => {
      const r = (await rowsOf(id)).find(
        (x) => (x.payload["data"] as { membershipId?: string })?.membershipId === member,
      );
      return r !== undefined && r.status !== "sending" ? r : undefined;
    });
    expect(row.status).toBe("pending");
    const wait = (row.next_attempt_at as Date).getTime() - Date.now();
    expect(wait).toBeGreaterThan(500_000);
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });
});

describe("E3.10 FR1: a held or suspended workspace (R1-M1)", () => {
  const setHolds = (id: string, holds: string) =>
    running.container.db.withHost((tx) =>
      tx.execute(`UPDATE core.workspace SET holds = '${holds}' WHERE id = '${id}'`),
    );

  it("sends nothing while held: rows stay due (deferred, not dropped) and go once active again", async () => {
    const { id } = await createEndpoint("held");
    try {
      await setHolds(acmeId, "{operator}");
      await sql(
        `INSERT INTO core.webhook_delivery (workspace_id, endpoint_id, topic, event_id, payload, status, next_attempt_at)
         VALUES ($1, $2, 'membership.created', 'held-1', '{"type":"membership.created","data":{}}'::jsonb, 'pending', now() - interval '1 second')`,
        [acmeId, id],
      );
      const turn = await running.container.webhooks.deliverWorkspace(acmeId);
      expect(turn).toMatchObject({ claimed: 0, deferred: true });
      // The due sweep walks active workspaces only.
      expect(await listActiveWorkspaceIds(running.container.db)).not.toContain(acmeId);
      expect(await listLiveWorkspaceIds(running.container.db)).toContain(acmeId);
      expect((await rowsOf(id)).map((r) => [r.status, r.attempts])).toEqual([["pending", 0]]);
      expect(hitsFor("held")).toEqual([]);
    } finally {
      await setHolds(acmeId, "{}");
    }
    await drive(id);
    expect((await rowsOf(id)).map((r) => r.status)).toEqual(["succeeded"]);
    expect(hitsFor("held")).toHaveLength(1);
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });
});

describe("concurrency", () => {
  it("two workers never send one delivery twice", async () => {
    const { id } = await createEndpoint("race", ["membership.created"], {
      behaviour: { status: 204, delayMs: 50 },
    });
    // Fifteen due rows at once; the background sweep may join the three workers below, which
    // only makes the race harder.
    const ctx = systemContext(acmeId);
    const ids: string[] = [];
    await running.container.db.withTenant(ctx, async (tx) => {
      for (let i = 0; i < 15; i++) {
        const [r] = (
          await tx.execute(
            `INSERT INTO core.webhook_delivery (workspace_id, endpoint_id, topic, event_id, payload, status, next_attempt_at, manual)
             VALUES ('${acmeId}', '${id}', 'membership.created', 'race-${i}', '{"type":"membership.created","data":{}}'::jsonb, 'pending', now() - interval '1 second', false)
             RETURNING id`,
          )
        ).rows as { id: string }[];
        if (r) ids.push(r.id);
      }
    });
    const before = await deadlocks();
    await Promise.all([
      running.container.webhooks.deliverWorkspace(acmeId),
      running.container.webhooks.deliverWorkspace(acmeId),
      running.container.webhooks.deliverWorkspace(acmeId),
    ]);
    await waitFor("all sent", async () =>
      (await rowsOf(id)).every((r) => r.status === "succeeded") ? true : undefined,
    );
    const counts = new Map<string, number>();
    for (const h of hitsFor("race")) {
      const wid = String(h.headers["webhook-id"]);
      counts.set(wid, (counts.get(wid) ?? 0) + 1);
    }
    for (const d of ids) expect(counts.get(d), d).toBe(1);
    expect((await rowsOf(id)).every((r) => r.attempts === 1)).toBe(true);
    expect(await deadlocks()).toBe(before);
    await api("DELETE", `/webhooks/endpoints/${id}`);
  });

  it("deletes, disables, pings and redeliveries racing delivery never deadlock or error", async () => {
    const before = await deadlocks();
    const unexpected: string[] = [];
    for (let round = 0; round < 4; round++) {
      const name = `churn${round}`;
      const { id } = await createEndpoint(name, ["membership.created"], {
        behaviour: { status: round % 2 === 0 ? 500 : 204, delayMs: 30 },
      });
      await newInvestor();
      await newInvestor();
      await waitFor("deliveries", async () => ((await rowsOf(id)).length >= 2 ? true : undefined));
      const [first] = await rowsOf(id);
      await sql("UPDATE core.webhook_endpoint SET consecutive_failures = 19 WHERE id = $1", [id]);
      await sql(
        "UPDATE core.webhook_delivery SET attempts = 9, status = 'pending', next_attempt_at = now() - interval '1 second', claimed_at = NULL WHERE endpoint_id = $1",
        [id],
      );
      const ops: Promise<unknown>[] = [
        running.container.webhooks.deliverWorkspace(acmeId),
        running.container.webhooks.deliverWorkspace(acmeId),
        api("POST", `/webhooks/endpoints/${id}/test`).then((r) => {
          if (![202, 404, 409].includes(r.status)) unexpected.push(`test ${r.status}`);
        }),
        api("POST", `/webhooks/deliveries/${first?.id}/redeliver`).then((r) => {
          if (![202, 404, 409].includes(r.status)) unexpected.push(`redeliver ${r.status}`);
        }),
        api("PATCH", `/webhooks/endpoints/${id}`, { enabled: false }).then((r) => {
          if (![200, 404].includes(r.status)) unexpected.push(`patch ${r.status}`);
        }),
        api("POST", `/webhooks/endpoints/${id}/rotate-secret`, { graceHours: 1 }).then((r) => {
          if (![200, 404].includes(r.status)) unexpected.push(`rotate ${r.status}`);
        }),
        new Promise((r) => setTimeout(r, round * 15)).then(() =>
          api("DELETE", `/webhooks/endpoints/${id}`).then((r) => {
            if (![200, 404].includes(r.status)) unexpected.push(`delete ${r.status}`);
          }),
        ),
      ];
      const settled = await Promise.allSettled(ops);
      for (const s of settled) {
        if (s.status === "rejected") unexpected.push(String(s.reason));
      }
      await waitFor("the endpoint gone", async () =>
        (await rowsOf(id)).length === 0 && (await endpointRow(id)) === undefined ? true : undefined,
      );
    }
    expect(unexpected).toEqual([]);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await deadlocks()).toBe(before);
  });
});

describe("a one-connection pool", () => {
  it("every route and the delivery path complete without a nested acquire", async () => {
    const single = await startServer({
      config: testConfig({ DATABASE_POOL_MAX: "1", ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    // As in data-room-qa: the relay would hold the only connection while dispatching; what this
    // proves is that routes, fan-out and delivery never hold one connection while asking for a
    // second, so the relay is stopped.
    await single.container.relay.stop();
    try {
      const run = async () => {
        const opts = { server: single };
        behaviours.set("single", { status: 204 });
        const created = await api(
          "POST",
          "/webhooks/endpoints",
          { url: hookUrl("single"), events: ["membership.created", "document.viewed"] },
          opts,
        );
        expect(created.status).toBe(201);
        const { endpoint, secret } = await json<{ endpoint: EndpointBody; secret: string }>(
          created,
        );
        const id = endpoint.id;
        for (const path of [
          "/webhooks/topics",
          "/webhooks/endpoints",
          `/webhooks/endpoints/${id}`,
          "/webhooks/deliveries",
        ]) {
          expect((await api("GET", path, undefined, opts)).status, path).toBe(200);
        }
        expect(
          (await api("PATCH", `/webhooks/endpoints/${id}`, { description: "one" }, opts)).status,
        ).toBe(200);
        expect(
          (await api("POST", `/webhooks/endpoints/${id}/rotate-secret`, { graceHours: 1 }, opts))
            .status,
        ).toBe(200);
        const test = await api("POST", `/webhooks/endpoints/${id}/test`, undefined, opts);
        expect(test.status).toBe(202);
        const { delivery } = await json<{ delivery: DeliveryBody }>(test);
        // The fan-out subscriber, on the single connection it is handed (person-level gate too).
        const ctx = systemContext(acmeId);
        await sql(
          "INSERT INTO core.consent_event (workspace_id, membership_id, purpose, granted, source) VALUES ($1, $2, 'analytics_engagement', true, 'settings')",
          [acmeId, owner.membershipId],
        );
        const fanned = await single.container.db.withTenant(ctx, (tx) =>
          single.container.webhooks.fanOut(
            {
              outboxId: 990_000_001,
              topic: "document.viewed",
              payload: {
                documentId: randomUUID(),
                versionId: randomUUID(),
                membershipId: owner.membershipId,
                sessionId: null,
              },
              schemaVersion: 1,
              createdAt: new Date(),
            },
            { tx, ctx },
          ),
        );
        expect(fanned).toBe(0); // analytics mode is `essential`
        await single.container.webhooks.deliverWorkspace(acmeId);
        await waitFor("the ping on the single pool", async () =>
          hitsFor("single").find((h) => h.json.id === delivery.id),
        );
        await verify(hitsFor("single").find((h) => h.json.id === delivery.id) as Hit, secret);
        expect(
          (await api("GET", `/webhooks/deliveries/${delivery.id}`, undefined, opts)).status,
        ).toBe(200);
        expect(
          (await api("POST", `/webhooks/deliveries/${delivery.id}/redeliver`, undefined, opts))
            .status,
        ).toBe(202);
        await single.container.webhooks.applyRetention(acmeId);
        expect((await api("DELETE", `/webhooks/endpoints/${id}`, undefined, opts)).status).toBe(
          200,
        );
        return true;
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pool deadlock: timed out")), 45_000),
      );
      expect(await Promise.race([run(), timeout])).toBe(true);
    } finally {
      await single.stop();
    }
  }, 90_000);
});
