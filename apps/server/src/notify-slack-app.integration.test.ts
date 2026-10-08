import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { EventPayload, EventTopic } from "@fundroom/domain";
import type { EventHandler } from "@fundroom/events";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { IntegrationNotConnected, IntegrationServices } from "@fundroom/module-kit";
import { CHANNEL_DISABLE_AFTER, JOB_CHANNELS } from "@fundroom/module-notify";
import type {
  ChatChannelRef,
  ChatMessage,
  ChatWebhookPort,
  IntegrationResult,
} from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * E3.6 notify ↔ integrations hub, end to end against a fake `ModuleServices.integrations` (the
 * kernel's Slack app connection is Agent A's and has its own suite):
 *
 *  - `GET /notify/slack/channels` (notify.manage): not connected → 404, Slack down → 503 + reason,
 *    otherwise the bot's channels by name;
 *  - `slack_app` channels: created from that list only (unknown → 422, duplicate → 409, a webhook
 *    URL on an app channel → 400), step-up to create and to re-point, no credential stored, the
 *    same generic text as a webhook post, rendered as escaped Slack mrkdwn;
 *  - delivery through `integrations.slackPost`: `not_connected` / `unauthorized` / `forbidden` /
 *    `not_found` are permanent (auto-disable after 3), `rate_limited` retries;
 *  - `integration.connection_unhealthy`: in-app + instant email to `integrations.manage` holders
 *    (owner, admin; never an editor), and every opted-in channel — except the Slack app's own
 *    channels when it is Slack that is unhealthy.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
const SLUG = "wayne";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let wsId: string;

// --- fakes ---------------------------------------------------------------------------------------

const webhookPosts: { url: string; message: ChatMessage }[] = [];
const fakeChat: ChatWebhookPort = {
  driver: "fake",
  validateUrl(url) {
    return url.startsWith("https://hooks.slack.com/services/")
      ? { ok: true }
      : { ok: false, reason: "not a webhook" };
  },
  async post(url, message) {
    webhookPosts.push({ url, message });
    return { ok: true };
  },
};

type SlackAnswer = IntegrationResult<void> | IntegrationNotConnected;
const slack = {
  connected: true,
  listFailure: undefined as undefined | "unavailable" | "unauthorized",
  channels: [
    { id: "C0DEALS", name: "deals", isPrivate: false },
    { id: "G0BOARD", name: "board-room", isPrivate: true },
    { id: "C0ALERTS", name: "alerts", isPrivate: false },
  ] as ChatChannelRef[],
  posts: [] as { channelId: string; text: string }[],
  /** Canned answers per Slack channel id (default ok). */
  answers: new Map<string, SlackAnswer>(),
};

const fakeIntegrations: Partial<IntegrationServices> = {
  async slackChannels() {
    if (!slack.connected) return { ok: false, reason: "not_connected" };
    if (slack.listFailure !== undefined) return { ok: false, reason: slack.listFailure };
    return { ok: true, value: slack.channels };
  },
  async slackPost(_ctx, channelId, message) {
    if (!slack.connected) return { ok: false, reason: "not_connected" };
    slack.posts.push({ channelId, text: message.text });
    return slack.answers.get(channelId) ?? { ok: true, value: undefined };
  },
};

// --- harness -------------------------------------------------------------------------------------

interface Actor {
  cookie: string;
  membershipId: string;
  email: string;
}

async function request(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `${SLUG}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.cookie)
    headers.set("origin", `http://${SLUG}.${CANON}`);
  return running.app.request(`http://${SLUG}.${CANON}${path}`, { ...init, headers });
}

const api = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  request(`/api/v1/notify${path}`, init);

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const codeOf = async (res: Response) =>
  (await json<{ error: { code: string; field?: string; reason?: string } }>(res)).error;

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function signIn(email: string): Promise<Actor> {
  const since = mailer.sent.length;
  const start = await request("/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "", email };
}

async function stepUp(cookie: string): Promise<string> {
  const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request("/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

async function member(
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "editor" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, {
    workspaceId: wsId,
    userId: user.userId,
    kind,
    role,
    source: "test",
  });
  const actor = await signIn(email);
  if (role === "owner" || role === "admin") actor.cookie = await stepUp(actor.cookie);
  return actor;
}

async function rows<T>(query: string): Promise<T[]> {
  return running.container.db.withTenant(systemContext(wsId), async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

function handlerFor(topic: EventTopic): EventHandler {
  const sub = running.container.subscriptions
    .subscribersFor(topic)
    .find((x) => x.id.startsWith("notify."));
  if (!sub) throw new Error(`no notify subscriber for ${topic}`);
  return sub.handler;
}

/** Delivers one event to notify's subscriber the way the dispatcher does. */
async function deliver<T extends EventTopic>(
  topic: T,
  payload: EventPayload<T>,
  outboxId: number,
): Promise<void> {
  const ctx = systemContext(wsId);
  await running.container.db.withTenant(ctx, (tx) =>
    handlerFor(topic)(
      { outboxId, topic, workspaceId: wsId, payload, schemaVersion: 1, createdAt: new Date() },
      {
        tx,
        ctx,
        job: {
          id: `test-${outboxId}`,
          name: `event.${topic}`,
          data: { outboxId },
          signal: new AbortController().signal,
        },
      },
    ),
  );
}

async function runChannels(): Promise<void> {
  const job = running.container.registry
    .resolveJobs(running.container.moduleServices)
    .find((j) => j.name === JOB_CHANNELS);
  if (!job) throw new Error("no channels job");
  await job.handler({
    id: `test-${randomUUID()}`,
    name: JOB_CHANNELS,
    data: { workspaceId: wsId },
    signal: new AbortController().signal,
  });
}

/** Makes every queued delivery due now (the retry backoff is minutes). */
async function makeDue(): Promise<void> {
  await rows(
    `UPDATE notify.channel_delivery SET next_attempt_at = now() - interval '1 second'
      WHERE status = 'pending' RETURNING id`,
  );
}

interface Channel {
  id: string;
  kind: string;
  name: string;
  urlHint: string | null;
  slackChannelId: string | null;
  slackChannelName: string | null;
  eventTypes: string[];
  enabled: boolean;
  disabledReason: string | null;
  failureCount: number;
  lastError: string | null;
}

let owner: Actor;
let admin: Actor;
let editor: Actor;
let investor: Actor;
let outbox = 70_000;
const nextOutbox = (): number => {
  outbox += 1;
  return outbox;
};

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
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer,
    chat: fakeChat,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  // The container test seam (E3.6): the Slack app half of the integrations port, faked.
  Object.assign(running.container.integrations.services, fakeIntegrations);
  wsId = (await createWorkspace(running.container.db, { slug: SLUG, name: "Wayne <& Co>" })).id;
  owner = await member("bruce@wayne.test", "staff", "owner");
  admin = await member("lucius@wayne.test", "staff", "admin");
  editor = await member("alfred@wayne.test", "staff", "editor");
  investor = await member("selina@investor.test", "external", "investor");
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

beforeEach(() => {
  slack.connected = true;
  slack.listFailure = undefined;
  slack.answers.clear();
  slack.posts.length = 0;
  webhookPosts.length = 0;
});

describe("GET /notify/slack/channels", () => {
  it("lists what the Slack app can post to, sorted by name, for notify.manage only", async () => {
    const res = await api("/slack/channels", { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      channels: [
        { id: "C0ALERTS", name: "alerts", isPrivate: false },
        { id: "G0BOARD", name: "board-room", isPrivate: true },
        { id: "C0DEALS", name: "deals", isPrivate: false },
      ],
    });
    expect((await api("/slack/channels", { cookie: editor.cookie })).status).toBe(403);
    // An investor learns nothing, not even that the route exists.
    expect((await api("/slack/channels", { cookie: investor.cookie })).status).toBe(404);
  });

  it("answers 404 integration_not_connected without a Slack connection", async () => {
    slack.connected = false;
    const res = await api("/slack/channels", { cookie: owner.cookie });
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toMatchObject({ code: "integration_not_connected" });
  });

  it("answers 503 with the integration's reason when Slack refuses", async () => {
    slack.listFailure = "unauthorized";
    const res = await api("/slack/channels", { cookie: owner.cookie });
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toMatchObject({
      code: "service_unavailable",
      reason: "unauthorized",
    });
  });
});

describe("slack_app channels", () => {
  let deals: Channel;

  const create = (body: unknown, cookie = owner.cookie) =>
    api("/channels", { method: "POST", cookie, body: JSON.stringify(body) });

  it("creates a channel from the Slack app's list, storing no credential", async () => {
    const res = await create({
      kind: "slack_app",
      slackChannelId: "C0DEALS",
      eventTypes: ["integration.connection_unhealthy", "access_review.overdue"],
    });
    expect(res.status).toBe(201);
    deals = await json<Channel>(res);
    expect(deals).toMatchObject({
      kind: "slack_app",
      name: "#deals",
      urlHint: null,
      slackChannelId: "C0DEALS",
      slackChannelName: "deals",
      enabled: true,
      disabledReason: null,
    });
    const [row] = await rows<{ urlEnc: unknown; encryption: unknown }>(
      `SELECT url_enc AS "urlEnc", encryption FROM notify.channel WHERE id = '${deals.id}'::uuid`,
    );
    expect(row).toEqual({ urlEnc: null, encryption: {} });
    const [audit] = await rows<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE action = 'notify.channel_created'
         AND resource_id = '${deals.id}'::uuid`,
    );
    expect(audit?.meta).toMatchObject({ kind: "slack_app" });
  });

  it("refuses an unknown channel, a duplicate, a missing connection and mixed fields", async () => {
    const unknown = await create({ kind: "slack_app", slackChannelId: "C0NOPE", eventTypes: [] });
    expect(unknown.status).toBe(422);
    expect(await codeOf(unknown)).toMatchObject({
      code: "slack_channel_unknown",
      field: "slackChannelId",
    });
    const dup = await create({ kind: "slack_app", slackChannelId: "C0DEALS", eventTypes: [] });
    expect(dup.status).toBe(409);
    expect(await codeOf(dup)).toMatchObject({ code: "conflict", reason: "duplicate_channel" });
    const mixed = await create({
      kind: "slack_app",
      slackChannelId: "C0ALERTS",
      url: "https://hooks.slack.com/services/T/B/x",
      eventTypes: [],
    });
    expect(mixed.status).toBe(400);
    expect(await codeOf(mixed)).toMatchObject({ code: "validation_failed", field: "url" });
    const webhookWithId = await create({
      name: "Deals",
      url: "https://hooks.slack.com/services/T/B/x",
      slackChannelId: "C0ALERTS",
      eventTypes: [],
    });
    expect(webhookWithId.status).toBe(400);
    const badId = await create({ kind: "slack_app", slackChannelId: "c0-lower", eventTypes: [] });
    expect(badId.status).toBe(400);
    slack.connected = false;
    const offline = await create({ kind: "slack_app", slackChannelId: "C0ALERTS", eventTypes: [] });
    expect(offline.status).toBe(404);
    expect(await codeOf(offline)).toMatchObject({ code: "integration_not_connected" });
    // An editor cannot add one at all.
    expect(
      (
        await create(
          { kind: "slack_app", slackChannelId: "C0ALERTS", eventTypes: [] },
          editor.cookie,
        )
      ).status,
    ).toBe(403);
  });

  it("re-points to another Slack channel (validated), and refuses a URL on an app channel", async () => {
    const url = await api(`/channels/${deals.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ url: "https://hooks.slack.com/services/T/B/x" }),
    });
    expect(url.status).toBe(400);
    expect(await codeOf(url)).toMatchObject({ field: "url" });
    const unknown = await api(`/channels/${deals.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ slackChannelId: "C0NOPE" }),
    });
    expect(unknown.status).toBe(422);
    const moved = await api(`/channels/${deals.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ slackChannelId: "G0BOARD" }),
    });
    expect(moved.status).toBe(200);
    expect(await json<Channel>(moved)).toMatchObject({
      slackChannelId: "G0BOARD",
      slackChannelName: "board-room",
      // The admin's name for it stays.
      name: "#deals",
    });
    const back = await api(`/channels/${deals.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ slackChannelId: "C0DEALS" }),
    });
    expect(back.status).toBe(200);
  });

  it("posts the same generic text as a webhook, as escaped Slack mrkdwn with the link", async () => {
    await deliver(
      "integration.connection_unhealthy",
      { connectionId: randomUUID(), provider: "quickbooks", status: "reauth_required" },
      nextOutbox(),
    );
    await runChannels();
    expect(slack.posts).toEqual([
      {
        channelId: "C0DEALS",
        text: `The QuickBooks connection of Wayne &lt;&amp; Co&gt; needs to be reconnected: the service no longer accepts its authorisation. <http://${SLUG}.${CANON}/admin/integrations|Open integrations>`,
      },
    ]);
    const [ch] = await rows<{ ok: boolean; n: number }>(
      `SELECT last_success_at IS NOT NULL AS ok, failure_count AS n FROM notify.channel
        WHERE id = '${deals.id}'::uuid`,
    );
    expect(ch).toEqual({ ok: true, n: 0 });
  });

  it("the test post goes through the Slack app and reports not_connected plainly", async () => {
    const ok = await api(`/channels/${deals.id}/test`, { method: "POST", cookie: admin.cookie });
    expect(await json(ok)).toEqual({ ok: true, reason: null, detail: null });
    expect(slack.posts.at(-1)?.channelId).toBe("C0DEALS");
    expect(slack.posts.at(-1)?.text).toContain("Test message from Wayne &lt;&amp; Co&gt;");
    slack.connected = false;
    const off = await api(`/channels/${deals.id}/test`, { method: "POST", cookie: admin.cookie });
    expect(await json(off)).toMatchObject({ ok: false, reason: "not_connected" });
    // A failed test does not count toward auto-disable.
    const [ch] = await rows<{ n: number; enabled: boolean }>(
      `SELECT failure_count AS n, enabled FROM notify.channel WHERE id = '${deals.id}'::uuid`,
    );
    expect(ch).toEqual({ n: 0, enabled: true });
  });

  it("retries a rate-limited post, and switches the channel off after repeated permanent refusals", async () => {
    slack.answers.set("C0DEALS", { ok: false, reason: "rate_limited" });
    await deliver(
      "integration.connection_unhealthy",
      { connectionId: randomUUID(), provider: "xero", status: "degraded" },
      nextOutbox(),
    );
    await runChannels();
    const [pending] = await rows<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM notify.channel_delivery d JOIN notify.channel c ON c.id = d.channel_id
        WHERE c.id = '${deals.id}'::uuid ORDER BY d.created_at DESC LIMIT 1`,
    );
    expect(pending).toEqual({ status: "pending", attempts: 1 });

    // Each of the four permanent answers counts; the third in a row disables the channel.
    slack.answers.set("C0DEALS", { ok: false, reason: "forbidden", detail: "not_in_channel" });
    await makeDue();
    await runChannels();
    slack.answers.set("C0DEALS", { ok: false, reason: "unauthorized" });
    await deliver(
      "integration.connection_unhealthy",
      { connectionId: randomUUID(), provider: "stripe", status: "degraded" },
      nextOutbox(),
    );
    await runChannels();
    let [ch] = await rows<{ n: number; enabled: boolean }>(
      `SELECT failure_count AS n, enabled FROM notify.channel WHERE id = '${deals.id}'::uuid`,
    );
    expect(ch).toEqual({ n: 2, enabled: true });
    slack.answers.set("C0DEALS", { ok: false, reason: "not_found", detail: "channel_not_found" });
    await deliver(
      "integration.connection_unhealthy",
      { connectionId: randomUUID(), provider: "calendly", status: "degraded" },
      nextOutbox(),
    );
    await runChannels();
    [ch] = await rows<{ n: number; enabled: boolean }>(
      `SELECT failure_count AS n, enabled FROM notify.channel WHERE id = '${deals.id}'::uuid`,
    );
    expect(ch).toEqual({ n: CHANNEL_DISABLE_AFTER, enabled: false });
    const listed = await json<{ channels: Channel[] }>(
      await api("/channels", { cookie: owner.cookie }),
    );
    expect(listed.channels.find((c) => c.id === deals.id)).toMatchObject({
      enabled: false,
      disabledReason: "not_found",
      lastError: "not_found: channel_not_found",
    });
    const disabled = await rows(
      `SELECT 1 FROM audit.event WHERE action = 'notify.channel_disabled'
         AND resource_id = '${deals.id}'::uuid`,
    );
    expect(disabled).toHaveLength(1);
  });

  it("disables with not_connected when the Slack app goes away, and re-enabling clears it", async () => {
    const res = await create({
      kind: "slack_app",
      name: "Alerts",
      slackChannelId: "C0ALERTS",
      eventTypes: ["integration.connection_unhealthy"],
    });
    expect(res.status).toBe(201);
    const alerts = await json<Channel>(res);
    slack.connected = false;
    for (let i = 0; i < CHANNEL_DISABLE_AFTER; i += 1) {
      await deliver(
        "integration.connection_unhealthy",
        { connectionId: randomUUID(), provider: "quickbooks", status: "degraded" },
        nextOutbox(),
      );
      await runChannels();
    }
    const [row] = await rows<{ enabled: boolean; reason: string }>(
      `SELECT enabled, disabled_reason AS reason FROM notify.channel WHERE id = '${alerts.id}'::uuid`,
    );
    expect(row).toEqual({ enabled: false, reason: "not_connected" });
    slack.connected = true;
    const on = await api(`/channels/${alerts.id}`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: JSON.stringify({ enabled: true }),
    });
    expect(await json<Channel>(on)).toMatchObject({
      enabled: true,
      disabledReason: null,
      failureCount: 0,
    });
  });
});

describe("integration.connection_unhealthy", () => {
  let webhook: Channel;
  let app: Channel;

  beforeAll(async () => {
    const wh = await api("/channels", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        name: "Ops",
        url: "https://hooks.slack.com/services/T0WAYNE/B0OPS/opsT0ken",
        eventTypes: ["integration.connection_unhealthy"],
      }),
    });
    expect(wh.status).toBe(201);
    webhook = await json<Channel>(wh);
    // The app channel that was auto-disabled above: switch it back on for this block.
    const listed = await json<{ channels: Channel[] }>(
      await api("/channels", { cookie: owner.cookie }),
    );
    const found = listed.channels.find((c) => c.slackChannelId === "C0ALERTS");
    if (found === undefined) throw new Error("no app channel");
    app = found;
    await api(`/channels/${app.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ enabled: true }),
    });
  });

  it("alerts owners and admins in-app and by email, never an editor, and every opted-in channel", async () => {
    const since = mailer.sent.length;
    const connectionId = randomUUID();
    await deliver(
      "integration.connection_unhealthy",
      { connectionId, provider: "xero", status: "reauth_required" },
      nextOutbox(),
    );
    const inbox = await rows<{ membershipId: string; payload: Record<string, unknown> }>(
      `SELECT membership_id::text AS "membershipId", payload FROM notify.notification
        WHERE event_type = 'integration.connection_unhealthy' AND resource_id = '${connectionId}'::uuid`,
    );
    expect(inbox.map((r) => r.membershipId).sort()).toEqual(
      [owner.membershipId, admin.membershipId].sort(),
    );
    expect(inbox[0]?.payload).toEqual({
      connectionId,
      provider: "xero",
      status: "reauth_required",
    });
    // Instant email through the real `notification.created` → `notify.send` path.
    const mails = await waitFor(async () => {
      const got = mailer.sent
        .slice(since)
        .filter((m) => m.subject === "Xero needs to be reconnected");
      return got.length >= 2 ? got : undefined;
    });
    expect(mails.map((m) => String(m.to)).sort()).toEqual([admin.email, owner.email].sort());
    expect(mailer.sent.slice(since).some((m) => String(m.to) === editor.email)).toBe(false);
    // The editor's inbox route shows nothing either.
    const editorInbox = await json<{ items: { eventType: string }[] }>(
      await api("/inbox", { cookie: editor.cookie }),
    );
    expect(editorInbox.items.some((i) => i.eventType === "integration.connection_unhealthy")).toBe(
      false,
    );

    await runChannels();
    expect(webhookPosts.map((p) => p.message.text)).toEqual([
      "The Xero connection of Wayne <& Co> needs to be reconnected: the service no longer accepts its authorisation.",
    ]);
    expect(slack.posts.map((p) => p.channelId)).toEqual(["C0ALERTS"]);
  });

  it("a redelivered event alerts nobody twice; a new transition alerts again", async () => {
    const connectionId = randomUUID();
    const id = nextOutbox();
    const payload = { connectionId, provider: "stripe", status: "degraded" } as const;
    await deliver("integration.connection_unhealthy", payload, id);
    await deliver("integration.connection_unhealthy", payload, id);
    const count = async () =>
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM notify.notification WHERE resource_id = '${connectionId}'::uuid`,
        )
      )[0]?.n;
    expect(await count()).toBe(2);
    const deliveries = await rows(
      `SELECT 1 FROM notify.channel_delivery WHERE source_key LIKE 'integration.connection_unhealthy:${connectionId}:%'`,
    );
    expect(deliveries).toHaveLength(2);
    await deliver("integration.connection_unhealthy", payload, nextOutbox());
    expect(await count()).toBe(4);
  });

  it("a Slack outage is announced on the webhook channels only, never through the Slack app", async () => {
    await deliver(
      "integration.connection_unhealthy",
      { connectionId: randomUUID(), provider: "slack", status: "reauth_required" },
      nextOutbox(),
    );
    await runChannels();
    expect(webhookPosts.map((p) => p.message.text)).toContain(
      "The Slack connection of Wayne <& Co> needs to be reconnected: the service no longer accepts its authorisation.",
    );
    expect(slack.posts.some((p) => p.text.includes("The Slack connection"))).toBe(false);
    expect(webhook.kind).toBe("slack");
    expect(app.kind).toBe("slack_app");
  });
});
