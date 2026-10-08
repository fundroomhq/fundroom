import { createHmac } from "node:crypto";
import { createErasureService, verifySubjectExport } from "@fundroom/compliance";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createCalendlyAdapter } from "@fundroom/integration-calendly";
import { createFakeVendor } from "@fundroom/integrations/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { IntegrationAdapter, IntegrationAdapterDeps } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  BASE,
  CANON,
  type ErrorBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
  waitFor,
} from "./test/esign-harness.js";

/*
 * Booking webhooks (E3.6): Cal.com (the real adapter — it makes no outbound call) and Calendly (the
 * real adapter's signature check and parser; its `verify`/`subscribe` answered in-process), the
 * webhook route's refusals and budgets, dedupe and status order, member matching, erasure and DSAR,
 * and a one-connection pool pass over a token refresh.
 */
let pg: TestPostgres;
let running: RunningServer;
let throttledServer: RunningServer;
let mailer: MemoryMailer;
let env: ReturnType<typeof freshSecrets>;
const xero = createFakeVendor("xero");
const calendlyCalls = {
  subscribe: [] as { callbackUrl: string; signingKey: string }[],
  unsubscribe: [] as string[],
};
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql } = h;

/** The real Calendly adapter with its network calls answered here. */
function calendly(deps: IntegrationAdapterDeps): IntegrationAdapter {
  const real = createCalendlyAdapter(deps);
  const booking = real.booking;
  if (booking === undefined) throw new Error("calendly has no booking capability");
  return {
    ...real,
    async verify(auth) {
      return auth.accessToken === "pat-good"
        ? {
            ok: true,
            value: {
              accountLabel: "Acme on Calendly",
              externalAccountId: "https://api.calendly.com/users/U1",
            },
          }
        : { ok: false, reason: "unauthorized" };
    },
    booking: {
      ...booking,
      async subscribe(_auth, input) {
        calendlyCalls.subscribe.push(input);
        return {
          ok: true,
          value: {
            subscriptionId: `https://api.calendly.com/webhook_subscriptions/S${calendlyCalls.subscribe.length}`,
          },
        };
      },
      async unsubscribe(_auth, id) {
        calendlyCalls.unsubscribe.push(id);
      },
    },
  };
}

let acmeId: string;
let owner: Actor;
let eve: Actor;
let calcom: { id: string; secret: string };
let cally: { id: string; secret: string };

function calcomDelivery(
  secret: string,
  trigger: string,
  payload: Record<string, unknown>,
): { headers: Headers; body: string } {
  const body = JSON.stringify({
    triggerEvent: trigger,
    createdAt: new Date().toISOString(),
    payload,
  });
  const sig = createHmac("sha256", secret).update(body).digest("hex");
  return {
    headers: new Headers({ "content-type": "application/json", "x-cal-signature-256": sig }),
    body,
  };
}

function calendlyDelivery(
  secret: string,
  event: string,
  payload: Record<string, unknown>,
  at = new Date(),
): { headers: Headers; body: string } {
  const body = JSON.stringify({ event, created_at: at.toISOString(), payload });
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return {
    headers: new Headers({
      "content-type": "application/json",
      "calendly-webhook-signature": `t=${t},v1=${v1}`,
    }),
    body,
  };
}

async function deliver(
  connectionId: string,
  d: { headers: Headers; body: string },
  via: RunningServer = running,
): Promise<Response> {
  const headers = new Headers(d.headers);
  headers.set("host", CANON);
  return via.app.request(`${BASE}/webhooks/integrations/${connectionId}`, {
    method: "POST",
    headers,
    body: d.body,
  });
}

const booking = (uid: string, email: string, start = "2026-10-05T15:00:00.000Z") => ({
  uid,
  title: "Investor intro",
  startTime: start,
  endTime: "2026-10-05T15:30:00.000Z",
  attendees: [{ email, name: "Eve Investor" }],
});

async function bookingRows(workspaceId: string, where = "true") {
  return sql<{
    id: string;
    external_id: string;
    status: string;
    membership_id: string | null;
    invitee_email: string;
    starts_at: string;
  }>(
    workspaceId,
    `SELECT id, external_id, status, membership_id, invitee_email::text, starts_at::text
       FROM core.integration_booking WHERE ${where} ORDER BY external_id`,
  );
}

async function recorded(workspaceId: string, bookingId: string): Promise<string[]> {
  const rows = await sql<{ status: string }>(
    workspaceId,
    `SELECT payload->>'status' AS status FROM core.outbox
      WHERE topic = 'integration.booking_recorded' AND payload->>'bookingId' = '${bookingId}' ORDER BY id`,
  );
  return rows.map((r) => r.status);
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  env = freshSecrets(pg.connectionString);
  const config = esignTestConfig(env, {
    INTEGRATIONS_XERO_CLIENT_ID: "xero-client",
    INTEGRATIONS_XERO_CLIENT_SECRET: "xero-secret-value",
  });
  const adapters = { xero: () => xero.adapter, calendly };
  running = await startServer({
    config,
    logger: createLogger({ level: "error" }),
    mailer,
    integrationAdapters: adapters,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  // Same database, a second process whose webhook budget is one delivery per connection a minute.
  throttledServer = await startServer({
    config: esignTestConfig(env, { ROLES: "api" }),
    logger: createLogger({ level: "error" }),
    mailer,
    integrationAdapters: adapters,
    integrationWebhookBudget: { perConnectionPerMinute: 1 },
    listenEnabled: false,
    migrate: false,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  eve = await member("acme", acmeId, "eve@investor.test", "external", "investor");
}, 240_000);

afterAll(async () => {
  await throttledServer?.stop();
  await running?.stop();
  await pg?.stop();
});

describe("connecting booking providers", () => {
  it("Cal.com: no credential; the webhook URL and a secret are shown once", async () => {
    const res = await request("acme", "/api/v1/integrations/calcom/connect", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ credentials: {} }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<{
      connection: { id: string; webhookUrl: string; accountLabel: string };
      webhookSecret: string;
    }>(res);
    expect(body.connection.webhookUrl).toBe(`${BASE}/webhooks/integrations/${body.connection.id}`);
    expect(body.webhookSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    calcom = { id: body.connection.id, secret: body.webhookSecret };
    const listed = await request("acme", "/api/v1/integrations/connections", {
      cookie: owner.cookie,
    });
    expect(await listed.text()).not.toContain(body.webhookSecret);
  });

  it("Calendly: verifies the token and subscribes with our signing key on the connection's URL", async () => {
    const bad = await request("acme", "/api/v1/integrations/calendly/connect", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ credentials: { personalAccessToken: "pat-bad" } }),
    });
    expect(bad.status).toBe(422);
    expect(calendlyCalls.subscribe).toHaveLength(0);
    const res = await request("acme", "/api/v1/integrations/calendly/connect", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ credentials: { personalAccessToken: "pat-good" } }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<{
      connection: { id: string; accountLabel: string };
      webhookSecret: string;
    }>(res);
    expect(body.connection.accountLabel).toBe("Acme on Calendly");
    expect(calendlyCalls.subscribe).toEqual([
      {
        callbackUrl: `${BASE}/webhooks/integrations/${body.connection.id}`,
        signingKey: body.webhookSecret,
      },
    ]);
    cally = { id: body.connection.id, secret: body.webhookSecret };
  });
});

describe("the booking webhook", () => {
  it("records a verified booking, matches the member by email and publishes in the same tx", async () => {
    const res = await deliver(
      calcom.id,
      calcomDelivery(calcom.secret, "BOOKING_CREATED", booking("uid-1", "EVE@investor.test")),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await bookingRows(acmeId, "external_id = 'uid-1'");
    expect(row).toMatchObject({
      status: "booked",
      membership_id: eve.membershipId,
      invitee_email: "eve@investor.test",
    });
    expect(await recorded(acmeId, row?.id ?? "")).toEqual(["booked"]);
  });

  it("dedupes by the vendor's id; a cancel after the booking updates it, a late booking does not undo it", async () => {
    const created = calcomDelivery(
      calcom.secret,
      "BOOKING_CREATED",
      booking("uid-1", "eve@investor.test"),
    );
    expect((await deliver(calcom.id, created)).status).toBe(200);
    expect(await bookingRows(acmeId, "external_id = 'uid-1'")).toHaveLength(1);
    const [row] = await bookingRows(acmeId, "external_id = 'uid-1'");
    expect(await recorded(acmeId, row?.id ?? "")).toEqual(["booked"]);
    expect(
      (
        await deliver(
          calcom.id,
          calcomDelivery(calcom.secret, "BOOKING_CANCELLED", booking("uid-1", "eve@investor.test")),
        )
      ).status,
    ).toBe(200);
    expect((await bookingRows(acmeId, "external_id = 'uid-1'"))[0]?.status).toBe("cancelled");
    expect((await deliver(calcom.id, created)).status).toBe(200);
    expect((await bookingRows(acmeId, "external_id = 'uid-1'"))[0]?.status).toBe("cancelled");
    expect(await recorded(acmeId, row?.id ?? "")).toEqual(["booked", "cancelled"]);
  });

  it("a reschedule records both halves from one delivery", async () => {
    const d = calcomDelivery(calcom.secret, "BOOKING_RESCHEDULED", {
      ...booking("uid-2b", "stranger@elsewhere.test", "2026-10-07T15:00:00.000Z"),
      rescheduleUid: "uid-2a",
      rescheduleStartTime: "2026-10-06T15:00:00.000Z",
      rescheduleEndTime: "2026-10-06T15:30:00.000Z",
    });
    expect((await deliver(calcom.id, d)).status).toBe(200);
    const rows = await bookingRows(acmeId, "external_id IN ('uid-2a', 'uid-2b')");
    expect(rows.map((r) => [r.external_id, r.status, r.membership_id])).toEqual([
      ["uid-2a", "rescheduled", null],
      ["uid-2b", "booked", null],
    ]);
  });

  it("refuses a bad signature, an unknown connection and a non-uuid with the same 401", async () => {
    const forged = calcomDelivery(
      "not-the-secret",
      "BOOKING_CREATED",
      booking("uid-x", "x@x.test"),
    );
    for (const id of [calcom.id, "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a"]) {
      const res = await deliver(id, forged);
      expect(res.status, id).toBe(401);
      expect(await json<ErrorBody>(res)).toEqual({ error: { code: "unauthenticated" } });
    }
    expect((await deliver("not-a-uuid", forged)).status).not.toBe(200);
    expect(await bookingRows(acmeId, "external_id = 'uid-x'")).toEqual([]);
  });

  it("refuses a body over 256 KiB before verifying anything", async () => {
    const big = calcomDelivery(calcom.secret, "BOOKING_CREATED", {
      ...booking("uid-big", "x@x.test"),
      pad: "x".repeat(300 * 1024),
    });
    expect((await deliver(calcom.id, big)).status).toBe(413);
  });

  it("Calendly: a signed delivery is recorded; a replay with an old timestamp is refused", async () => {
    const payload = {
      uri: "https://api.calendly.com/scheduled_events/E1/invitees/I1",
      email: "eve@investor.test",
      name: "Eve",
      scheduled_event: {
        start_time: "2026-10-08T09:00:00.000Z",
        end_time: "2026-10-08T09:30:00.000Z",
        name: "Intro",
      },
    };
    const fresh = calendlyDelivery(cally.secret, "invitee.created", payload);
    expect((await deliver(cally.id, fresh)).status).toBe(200);
    expect((await bookingRows(acmeId, `external_id = '${payload.uri}'`))[0]).toMatchObject({
      status: "booked",
      membership_id: eve.membershipId,
    });
    const old = calendlyDelivery(
      cally.secret,
      "invitee.canceled",
      payload,
      new Date(Date.now() - 10 * 60_000),
    );
    expect((await deliver(cally.id, old)).status).toBe(401);
    expect((await bookingRows(acmeId, `external_id = '${payload.uri}'`))[0]?.status).toBe("booked");
    // The Cal.com secret does not open the Calendly connection.
    const cross = calendlyDelivery(calcom.secret, "invitee.canceled", payload);
    expect((await deliver(cally.id, cross)).status).toBe(401);
  });

  it("over the post-auth budget: 200, nothing recorded", async () => {
    const first = calcomDelivery(calcom.secret, "BOOKING_CREATED", booking("uid-b1", "b@b.test"));
    const second = calcomDelivery(calcom.secret, "BOOKING_CREATED", booking("uid-b2", "b@b.test"));
    expect((await deliver(calcom.id, first, throttledServer)).status).toBe(200);
    const shed = await deliver(calcom.id, second, throttledServer);
    expect(shed.status).toBe(200);
    expect(await json(shed)).toEqual({ ok: true });
    expect(
      (await bookingRows(acmeId, "external_id IN ('uid-b1', 'uid-b2')")).map((r) => r.external_id),
    ).toEqual(["uid-b1"]);
  });

  it("rotating the secret: the old one stops working; Calendly is re-subscribed", async () => {
    const res = await request("acme", "/api/v1/integrations/calcom/rotate-webhook-secret", {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const { webhookSecret } = await json<{ webhookSecret: string }>(res);
    const d = (s: string) => calcomDelivery(s, "BOOKING_CREATED", booking("uid-r", "r@r.test"));
    expect((await deliver(calcom.id, d(calcom.secret))).status).toBe(401);
    expect((await deliver(calcom.id, d(webhookSecret))).status).toBe(200);
    calcom = { ...calcom, secret: webhookSecret };
    const rot = await request("acme", "/api/v1/integrations/calendly/rotate-webhook-secret", {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(rot.status).toBe(200);
    expect(calendlyCalls.subscribe).toHaveLength(2);
    expect(calendlyCalls.unsubscribe).toEqual([
      "https://api.calendly.com/webhook_subscriptions/S1",
    ]);
  });

  it("the register lists bookings newest meeting first", async () => {
    const res = await request("acme", "/api/v1/integrations/bookings?limit=2", {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const page = await json<{ items: { startsAt: string }[]; nextCursor: string | null }>(res);
    expect(page.items).toHaveLength(2);
    expect((page.items[0]?.startsAt ?? "") >= (page.items[1]?.startsAt ?? "")).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    const next = await request(
      "acme",
      `/api/v1/integrations/bookings?limit=2&cursor=${page.nextCursor}`,
      {
        cookie: owner.cookie,
      },
    );
    expect(next.status).toBe(200);
  });

  it("a disconnected booking connection's URL answers 401", async () => {
    const ws = (await createWorkspace(running.container.db, { slug: "gone", name: "G" })).id;
    const o = await member("gone", ws, "owner@gone.test", "staff", "owner");
    const res = await request("gone", "/api/v1/integrations/calcom/connect", {
      method: "POST",
      cookie: o.cookie,
      body: JSON.stringify({ credentials: {} }),
    });
    const body = await json<{ connection: { id: string }; webhookSecret: string }>(res);
    await request("gone", "/api/v1/integrations/calcom", { method: "DELETE", cookie: o.cookie });
    const d = calcomDelivery(body.webhookSecret, "BOOKING_CREATED", booking("uid-g", "g@g.test"));
    expect((await deliver(body.connection.id, d)).status).toBe(401);
  });
});

describe("Calendly secret rotation against the real API's duplicate-URL rule (fix round 1)", () => {
  /** A Calendly API that, like the real one, answers 409 to a second subscription for a URL. */
  const api = {
    subs: new Map<string, string>(),
    n: 0,
    refuseCreate: false,
    posts: 0,
    /** Each POST /webhook_subscriptions takes the next hold (if any) and waits on it. */
    holds: [] as Promise<void>[],
  };
  async function calendlyFetch(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(String(input));
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/users/me")
      return reply(200, {
        resource: {
          uri: "https://api.calendly.com/users/U1",
          name: "Acme",
          current_organization: "https://api.calendly.com/organizations/O1",
        },
      });
    if (url.pathname === "/webhook_subscriptions" && init?.method === "POST") {
      api.posts += 1;
      const hold = api.holds.shift();
      if (hold !== undefined) await hold;
      const body = JSON.parse(String(init.body)) as { url: string };
      for (const u of api.subs.values())
        if (u === body.url) return reply(409, { title: "Already Exists" });
      if (api.refuseCreate) return reply(503, { title: "Unavailable" });
      api.n += 1;
      const id = `0000000${api.n}-0000-4000-8000-000000000000`;
      api.subs.set(id, body.url);
      return reply(201, {
        resource: { uri: `https://api.calendly.com/webhook_subscriptions/${id}` },
      });
    }
    if (url.pathname === "/webhook_subscriptions" && (init?.method ?? "GET") === "GET") {
      return reply(200, {
        collection: [...api.subs.entries()].map(([id, u]) => ({
          uri: `https://api.calendly.com/webhook_subscriptions/${id}`,
          callback_url: u,
        })),
        pagination: { next_page_token: null },
      });
    }
    if (url.pathname.startsWith("/webhook_subscriptions/") && init?.method === "DELETE") {
      api.subs.delete(url.pathname.split("/").pop() ?? "");
      return new Response(null, { status: 204 });
    }
    return reply(404, {});
  }
  let server: RunningServer;
  let wsId: string;
  let o: Actor;
  const rotate = () =>
    request("cal409", "/api/v1/integrations/calendly/rotate-webhook-secret", {
      method: "POST",
      cookie: o.cookie,
      server,
    });

  beforeAll(async () => {
    server = await startServer({
      config: esignTestConfig(env, { ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      integrationAdapters: {
        calendly: (deps) => createCalendlyAdapter({ ...deps, fetch: calendlyFetch as never }),
      },
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    wsId = (await createWorkspace(running.container.db, { slug: "cal409", name: "C" })).id;
    o = await member("cal409", wsId, "owner@cal409.test", "staff", "owner");
    const res = await request("cal409", "/api/v1/integrations/calendly/connect", {
      method: "POST",
      cookie: o.cookie,
      server,
      body: JSON.stringify({ credentials: { personalAccessToken: "pat" } }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(api.subs.size).toBe(1);
  }, 60_000);
  afterAll(async () => {
    await server?.stop();
  });

  it("on 409 it removes the old subscription and subscribes again", async () => {
    const [before] = [...api.subs.keys()];
    const res = await rotate();
    expect(res.status, await res.clone().text()).toBe(200);
    const { webhookSecret, connection } = await json<{
      webhookSecret: string;
      connection: { id: string };
    }>(res);
    expect(api.subs.size).toBe(1);
    expect([...api.subs.keys()][0]).not.toBe(before);
    const [row] = await sql<{ sub: string; status: string }>(
      wsId,
      `SELECT webhook_subscription_id AS sub, status FROM core.integration_connection WHERE id = '${connection.id}'`,
    );
    expect(row?.sub).toContain([...api.subs.keys()][0] ?? "none");
    expect(row?.status).toBe("active");
    // The new key verifies deliveries.
    const d = calendlyDelivery(webhookSecret, "invitee.created", {
      uri: "https://api.calendly.com/scheduled_events/E9/invitees/I9",
      email: "x@x.test",
      scheduled_event: { start_time: "2026-10-09T09:00:00.000Z" },
    });
    expect((await deliver(connection.id, d)).status).toBe(200);
  });

  it("if the re-subscribe fails too, the connection is degraded with a clear error (never silent)", async () => {
    api.refuseCreate = true;
    const res = await rotate();
    api.refuseCreate = false;
    expect(res.status).toBe(422);
    expect(
      (await json<ErrorBody & { error: { subscriptionLost?: boolean } }>(res)).error,
    ).toMatchObject({
      code: "integration_credentials_rejected",
      reason: "subscribe_failed",
      subscriptionLost: true,
    });
    expect(api.subs.size).toBe(0);
    const [row] = await sql<{ sub: string | null; status: string; last_error: string; id: string }>(
      wsId,
      "SELECT id, webhook_subscription_id AS sub, status, last_error FROM core.integration_connection WHERE provider = 'calendly' AND deleted_at IS NULL",
    );
    expect(row).toMatchObject({ sub: null, status: "degraded" });
    expect(row?.last_error).toMatch(/^webhook_subscription_lost:/u);
    const [ev] = await sql<{ n: number }>(
      wsId,
      `SELECT count(*)::int AS n FROM core.outbox WHERE topic = 'integration.connection_unhealthy' AND payload->>'connectionId' = '${row?.id}'`,
    );
    expect(ev?.n).toBe(1);
    // Rotating again (the API is back) heals it.
    const again = await rotate();
    expect(again.status).toBe(200);
    expect(api.subs.size).toBe(1);
  });

  it("two parallel rotations end consistent, five rounds in a row", async () => {
    for (let round = 0; round < 5; round += 1) {
      const results = await Promise.all([rotate(), rotate()]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses, `round ${round}`).not.toContain(422);
      expect(statuses).toContain(200);
      for (const r of results) {
        if (r.status === 409)
          expect((await json<ErrorBody>(r)).error.reason).toBe("rotation_in_progress");
      }
      const [row] = await sql<{ sub: string | null; status: string }>(
        wsId,
        "SELECT webhook_subscription_id AS sub, status FROM core.integration_connection WHERE provider = 'calendly' AND deleted_at IS NULL",
      );
      expect(row?.status).toBe("active");
      expect(api.subs.size).toBe(1);
      expect(row?.sub ?? "").toContain([...api.subs.keys()][0] ?? "none");
    }
    expect((await rotate()).status).toBe(200);
  });

  it("with the stored subscription id lost, a rotation finds ours by URL and replaces it", async () => {
    await sql(
      wsId,
      "UPDATE core.integration_connection SET webhook_subscription_id = NULL WHERE provider = 'calendly' AND deleted_at IS NULL",
    );
    expect(api.subs.size).toBe(1);
    const res = await rotate();
    expect(res.status, await res.clone().text()).toBe(200);
    expect(api.subs.size).toBe(1);
    const [row] = await sql<{ sub: string | null }>(
      wsId,
      "SELECT webhook_subscription_id AS sub FROM core.integration_connection WHERE provider = 'calendly' AND deleted_at IS NULL",
    );
    expect(row?.sub ?? "").toContain([...api.subs.keys()][0] ?? "none");
  });

  it("a lease that expires mid-rotation: the taker's lease survives the first rotation's finally (fix round 3)", async () => {
    const leaseOf = async () =>
      (
        await sql<{
          token: string | null;
          until: string | null;
          sub: string | null;
          status: string;
        }>(
          wsId,
          `SELECT webhook_rotation_lease_token::text AS token, webhook_rotation_lease_until::text AS until,
                  webhook_subscription_id AS sub, status
             FROM core.integration_connection WHERE provider = 'calendly' AND deleted_at IS NULL`,
        )
      )[0];
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    api.holds.push(
      new Promise<void>((r) => (releaseA = r)),
      new Promise<void>((r) => (releaseB = r)),
    );
    const posts = api.posts;
    // A starts and stalls inside its first vendor call.
    const a = rotate();
    await waitFor("A's subscribe", async () => api.posts > posts);
    const aToken = (await leaseOf())?.token;
    expect(aToken).not.toBeNull();
    // A's lease runs out (a slow vendor); B takes the connection over and stalls too.
    await sql(
      wsId,
      "UPDATE core.integration_connection SET webhook_rotation_lease_until = now() - interval '1 second' WHERE provider = 'calendly' AND deleted_at IS NULL",
    );
    const b = rotate();
    await waitFor("B's subscribe", async () => api.posts > posts + 1);
    const bToken = (await leaseOf())?.token;
    expect(bToken).not.toBe(aToken);
    // A resumes: it lost the lease, so it aborts without writing — and its finally leaves B's
    // lease alone.
    releaseA();
    const aRes = await a;
    expect(aRes.status).toBe(409);
    const during = await leaseOf();
    expect(during?.token).toBe(bToken);
    expect(during?.until).not.toBeNull();
    // B finishes: one live subscription, stored, connection healthy.
    releaseB();
    const bRes = await b;
    expect(bRes.status, await bRes.clone().text()).toBe(200);
    const after = await leaseOf();
    expect(after).toMatchObject({ token: null, until: null, status: "active" });
    expect(api.subs.size).toBe(1);
    expect(after?.sub ?? "").toContain([...api.subs.keys()][0] ?? "none");
  });
});

describe("erasure and DSAR", () => {
  it("the DSAR export carries the member's bookings; erasure pseudonymises them (by membership and every address) and a vendor retry cannot bring them back", async () => {
    const res = await request("acme", `/api/v1/compliance/subjects/${eve.membershipId}/export`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const check = verifySubjectExport(new Uint8Array(await res.arrayBuffer()));
    expect(check.problems).toEqual([]);
    const exported = JSON.parse(check.files["integration-bookings.json"] ?? "null") as {
      version: number;
      bookings: { inviteeEmail: string }[];
    };
    expect(exported.version).toBe(1);
    expect(exported.bookings.length).toBeGreaterThanOrEqual(2);
    expect(exported.bookings.every((b) => b.inviteeEmail === "eve@investor.test")).toBe(true);

    // A second email identity of the same person, booked with it and matched by address only:
    // erasure must find it through ANY of the user's addresses, as ingest does.
    const [eveUser] = await sql<{ user_id: string }>(
      acmeId,
      `SELECT user_id::text FROM core.membership WHERE id = '${eve.membershipId}'`,
    );
    await running.container.db.withHost(async (tx) => {
      await tx.execute(
        `INSERT INTO core.user_identity (user_id, type, identifier)
           VALUES ('${eveUser?.user_id}', 'email', 'eve.alt@investor.test')`,
      );
    });
    expect(
      (
        await deliver(
          calcom.id,
          calcomDelivery(
            calcom.secret,
            "BOOKING_CREATED",
            booking("uid-alt", "eve.alt@investor.test"),
          ),
        )
      ).status,
    ).toBe(200);
    await sql(
      acmeId,
      "UPDATE core.integration_booking SET membership_id = NULL WHERE external_id = 'uid-alt'",
    );
    // One more by address only (matched to nobody at ingest: a different case, same person).
    await sql(
      acmeId,
      "UPDATE core.integration_booking SET membership_id = NULL WHERE external_id = 'uid-1'",
    );
    const mine = await bookingRows(
      acmeId,
      `invitee_email IN ('eve@investor.test', 'eve.alt@investor.test') OR membership_id = '${eve.membershipId}'`,
    );
    expect(mine.length).toBeGreaterThanOrEqual(2);

    const ctx = systemContext(acmeId);
    const detail = await running.container.db.withTenant(ctx, (tx) =>
      createErasureService({
        db: running.container.db,
        audit: running.container.audit,
        bookingSuppressionKeys: running.container.envelope,
      }).request(ctx, tx, {
        membershipId: eve.membershipId,
        expectedModules: [],
        actor: { membershipId: owner.membershipId },
      }),
    );
    expect(detail.request.status).toBe("completed");
    const [step] = await sql<{ counts: Record<string, number> }>(
      acmeId,
      `SELECT counts FROM core.dsar_step WHERE request_id = '${detail.request.id}' AND module = 'core.identity'`,
    );
    expect(step?.counts["integrationBookings"]).toBe(mine.length);
    // Pseudonymised, not deleted: the rows stay (vendor-retry dedupe) without the person.
    expect(
      await bookingRows(
        acmeId,
        `invitee_email = 'eve@investor.test' OR membership_id = '${eve.membershipId}'`,
      ),
    ).toEqual([]);
    const erased = await sql<{
      email: string;
      name: string | null;
      event: string | null;
      at: string | null;
    }>(
      acmeId,
      `SELECT invitee_email::text AS email, invitee_name AS name, event_name AS event, erased_at::text AS at
         FROM core.integration_booking WHERE id IN (${mine.map((m) => `'${m.id}'`).join(",")})`,
    );
    expect(erased).toHaveLength(mine.length);
    for (const r of erased) {
      expect(r.email).toMatch(/^erased\+[0-9a-f]{32}@erased\.invalid$/u);
      expect(r).toMatchObject({ name: null, event: null });
      expect(r.at).not.toBeNull();
    }
    // A vendor retry of the very same signed delivery (Cal.com signs no timestamp) dedupes against
    // the erased row: the address never comes back.
    const retry = calcomDelivery(
      calcom.secret,
      "BOOKING_CANCELLED",
      booking("uid-1", "eve@investor.test"),
    );
    expect((await deliver(calcom.id, retry)).status).toBe(200);
    expect(await bookingRows(acmeId, "invitee_email = 'eve@investor.test'")).toEqual([]);
    const [uid1] = await sql<{ email: string; name: string | null }>(
      acmeId,
      "SELECT invitee_email::text AS email, invitee_name AS name FROM core.integration_booking WHERE external_id = 'uid-1'",
    );
    expect(uid1?.email).toMatch(/^erased\+/u);
    expect(uid1?.name).toBeNull();
    // A NEW booking uid for the erased person (either address) is dropped, never stored.
    expect(step?.counts["integrationBookingEmailsSuppressed"]).toBe(2);
    for (const [uid, addr] of [
      ["uid-new-1", "eve@investor.test"],
      ["uid-new-2", "EVE.ALT@investor.test"],
    ] as const) {
      const res = await deliver(
        calcom.id,
        calcomDelivery(calcom.secret, "BOOKING_CREATED", booking(uid, addr)),
      );
      expect(res.status).toBe(200);
      expect(await bookingRows(acmeId, `external_id = '${uid}'`)).toEqual([]);
    }
    // Anyone else still books.
    expect(
      (
        await deliver(
          calcom.id,
          calcomDelivery(calcom.secret, "BOOKING_CREATED", booking("uid-new-3", "fred@x.test")),
        )
      ).status,
    ).toBe(200);
    expect(await bookingRows(acmeId, "external_id = 'uid-new-3'")).toHaveLength(1);
    // Other people's meetings stay.
    expect((await bookingRows(acmeId, "external_id = 'uid-2b'")).length).toBe(1);
  });
});

describe("one database connection", () => {
  it("a token refresh + read completes on a 1-connection pool (no vendor call inside a tx)", async () => {
    const ws = (await createWorkspace(running.container.db, { slug: "pool", name: "P" })).id;
    const o = await member("pool", ws, "owner@pool.test", "staff", "owner");
    const begun = await request("pool", "/api/v1/integrations/xero/oauth/begin", {
      method: "POST",
      cookie: o.cookie,
      body: "{}",
    });
    const { startUrl } = await json<{ startUrl: string }>(begun);
    const started = await running.app.request(startUrl, {
      headers: { host: CANON },
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const cookie = (started.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const cb = await running.app.request(
      `${BASE}/oauth/integrations/callback?code=${xero.code}&state=${state}`,
      { headers: { host: CANON, cookie }, redirect: "manual" },
    );
    const landed = new URL(cb.headers.get("location") ?? "");
    const pendingToken = new URLSearchParams(landed.hash.slice(1)).get("pending") ?? "";
    const done = await request("pool", "/api/v1/integrations/xero/oauth/complete", {
      method: "POST",
      cookie: o.cookie,
      body: JSON.stringify({ pendingToken }),
    });
    expect(done.status, await done.clone().text()).toBe(200);
    xero.accessTokens.clear();
    await sql(
      ws,
      "UPDATE core.integration_connection SET access_expires_at = now() - interval '1 minute' WHERE provider = 'xero'",
    );

    const single = await startServer({
      config: esignTestConfig(env, {
        DATABASE_POOL_MAX: "1",
        ROLES: "api",
        INTEGRATIONS_XERO_CLIENT_ID: "xero-client",
        INTEGRATIONS_XERO_CLIENT_SECRET: "xero-secret-value",
      }),
      logger: createLogger({ level: "error" }),
      mailer,
      integrationAdapters: { xero: () => xero.adapter },
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    try {
      const before = xero.calls.refresh;
      const read = single.container.integrations.services.readKpi(systemContext(ws), "xero", {
        metrics: ["revenue"],
        fromMonth: "2026-01",
        toMonth: "2026-01",
      });
      const timeout = new Promise<"deadlock">((r) => setTimeout(() => r("deadlock"), 15_000));
      const result = await Promise.race([read, timeout]);
      expect(result).toMatchObject({ ok: true });
      expect(xero.calls.refresh - before).toBe(1);
    } finally {
      await single.stop();
    }
  }, 60_000);
});
