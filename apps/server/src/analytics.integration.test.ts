import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { checkRlsCatalog, createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { AnalyticsSettings, EventPayload, EventTopic } from "@fundroom/domain";
import { type EventHandler, publish } from "@fundroom/events";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import {
  createAnalyticsJobs,
  createErasureHandler,
  createHotListService,
  createMailDeliveryHandler,
  createTrackingService,
  eraseMemberRows,
  flushIdleFor,
  HEARTBEAT_MAX_MS,
  JOB_FLUSH,
  JOB_MAINTAIN,
  JOB_ROLLUP,
  onDocumentDownloaded,
  onDocumentViewed,
  onUpdateViewed,
  ROLLUP_SETTLE_SECONDS,
} from "@fundroom/module-analytics";
import { loadWorkspaceModules, type ModuleServices } from "@fundroom/module-kit";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Engagement analytics end to end (E1.5): outbox ingest (`document.viewed`, `.downloaded`,
 * `update.viewed`) with its two dedupe rules and the fact's own timestamp → the tracking
 * modes (`off` / `essential` / `engagement`) gating every writer → capped, coalesced
 * page-dwell heartbeats flushed by the close beacon and by `analytics.flush` → the
 * `analytics.rollup` keyset walk into the two rollup tables (settle window + idempotence) →
 * the staff reads (overview, who viewed, page dwell, keyset timeline) → settings and the
 * DSAR erasure → RLS catalog, the no-oracle 404s for investors and cross-tenant isolation.
 *
 * E2.6 (appended at the end so the E1.5 counts above stay as they were): email opens/clicks
 * from `mail.delivery_recorded` through the real outbox, with the mode and consent gates and
 * MPP flagging → the page heatmap rollup → the hot list (automated never scored, staff never
 * ranked, consent honoured), its audited formula-safe CSV and the once-per-window alert →
 * `member.erasure_requested` → per-workspace retention under a legal hold.
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
  role: "owner" | "admin" | "editor" | "viewer" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (role === "owner" || role === "admin") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
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

/** Rows read as the `system` actor of a workspace (RLS admits staff and system here). */
async function rows<T>(query: string, workspaceId?: string): Promise<T[]> {
  const ctx = systemContext(workspaceId ?? acmeId);
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

/** Files a real outbox row; the relay turns it into subscriber jobs after commit. */
async function publishOutbox<T extends EventTopic>(
  workspaceId: string,
  topic: T,
  payload: EventPayload<T>,
): Promise<number> {
  const ctx = systemContext(workspaceId);
  return running.container.db.withTenant(ctx, (tx) => publish(tx, ctx, topic, payload));
}

/**
 * Delivers one event straight to a module subscriber the way the dispatcher does — a system
 * transaction for the workspace plus the job carrying the outbox row id. Synchronous, and it
 * lets a test choose the fact's own timestamp (the relay always stamps `now()`).
 */
async function deliver<T extends EventTopic>(
  handler: EventHandler,
  topic: T,
  payload: EventPayload<T>,
  at: Date,
  outboxId: number,
): Promise<void> {
  const ctx = systemContext(acmeId);
  await running.container.db.withTenant(ctx, (tx) =>
    handler(
      { outboxId, topic, workspaceId: acmeId, payload, schemaVersion: 1, createdAt: at },
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

async function runJob(name: string, data: Record<string, string | number> = {}): Promise<void> {
  const jobs = running.container.registry.resolveJobs(running.container.moduleServices);
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`no job ${name}`);
  await job.handler({ id: `test-${name}`, name, data, signal: new AbortController().signal });
}

/**
 * `ms` in the past, never earlier than this UTC month: `analytics.event` is partitioned from
 * the month the migration ran, so a test must not backdate out of the partition range.
 */
function backdated(ms: number): Date {
  const now = Date.now();
  const month = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1));
  return new Date(Math.max(now - ms, month.getTime() + 60_000));
}

/**
 * Two backdated instants guaranteed to carry the same UTC date. `syntheticSessionKey` is a
 * digest of `membership:YYYY-MM-DD`, so a pair that straddles midnight belongs to two different
 * synthetic sessions and the dedupe this exercises can never fire — a flake that only appears in
 * the few minutes after 00:00 UTC. Anchoring the earlier instant to the later one's day, rather
 * than taking both from `Date.now()`, removes the window entirely.
 */
function sameDayPair(gapMs: number, fromNowMs: number): [Date, Date] {
  const later = backdated(fromNowMs);
  const startOfDay = Date.UTC(later.getUTCFullYear(), later.getUTCMonth(), later.getUTCDate());
  const earlier = Math.min(later.getTime(), Math.max(later.getTime() - gapMs, startOfDay + 60_000));
  return [new Date(earlier), later];
}

interface Timeline {
  items: {
    id: string;
    occurredAt: string;
    type: string;
    resourceKind: string;
    resourceId: string;
    pageNo: number | null;
    durationMs: number | null;
    props: Record<string, unknown>;
  }[];
  nextBefore: string | null;
  nextBeforeId: string | null;
}

interface Overview {
  mode: string;
  range: { from: string; to: string };
  totals: { views: number; uniqueViewers: number; downloads: number; totalMs: number };
  topDocuments: {
    resourceId: string;
    views: number;
    uniqueViewers: number;
    totalMs: number;
    downloads: number;
  }[];
  recent: {
    id: string;
    type: string;
    membershipId: string;
    membership: { displayName: string; kind: string; role: string } | null;
    resourceId: string;
  }[];
}

interface ViewerList {
  mode: string;
  viewers: {
    membershipId: string;
    displayName: string;
    kind: string;
    role: string;
    views: number;
    downloads: number;
    totalMs: number;
    maxPageReached: number | null;
    pagesSeen: number[];
  }[];
}

/** E2.6 settings defaults the older assertions now carry (`analytics.hotListWindowDays` / `hotLeadThreshold`). */
const HOT_DEFAULTS = { hotListWindowDays: 14, hotLeadThreshold: 60 };

const DOC_A = randomUUID();
const DOC_B = randomUUID();
const DOC_C = randomUUID();
const DOC_D = randomUUID();
const DOC_E = randomUUID();
const POST_P = randomUUID();
const VERSION_A = randomUUID();
const VERSION_B = randomUUID();
const VERSION_D = randomUUID();
const VERSION_P = randomUUID();
const VERSION_C = randomUUID();
const VERSION_E = randomUUID();

let acmeId: string;
let globexId: string;
let owner: Actor;
let viewer: Actor;
let ada: Actor;
let bob: Actor;
let globexOwner: Actor;
let firstOutboxId: number;
let adaSessionId: string;

/** The kernel session id behind an actor's cookie (what the heartbeat hashes into a view session). */
async function sessionIdOf(actor: Actor): Promise<string> {
  const userId = (
    await rows<{ userId: string }>(
      `SELECT user_id AS "userId" FROM core.membership WHERE id = '${actor.membershipId}'::uuid`,
    )
  )[0]?.userId;
  return running.container.db.withHost(async (tx) => {
    const r = await tx.execute(
      `SELECT id FROM core.session WHERE user_id = '${userId}'::uuid AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    );
    return (r.rows as { id: string }[])[0]?.id ?? "";
  });
}

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
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(running.container.db, { slug: "globex", name: "Globex" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  viewer = await member("acme", acmeId, "viewer@example.com", "staff", "viewer");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  bob = await member("acme", acmeId, "bob@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@example.org", "staff", "owner");
  adaSessionId = await sessionIdOf(ada);
  // E1.6 (ADR-0037) made `legal.consentMode` default to `opt_in`, under which engagement
  // analytics record nothing for a member who has never been asked. This suite is about the
  // tracking *modes*; the consent decision table has its own suite in
  // `compliance.integration.test.ts`, so put this workspace in the "record until told not to"
  // mode and keep the two concerns from testing each other.
  const consent = await request("acme", "/api/v1/compliance/settings", {
    method: "PATCH",
    cookie: owner.cookie,
    body: JSON.stringify({ consentMode: "opt_out" }),
  });
  expect(consent.status).toBe(200);
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema + registry", () => {
  it("analytics.* tables pass the RLS catalog check", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });

  it("registers permissions, jobs and the admin nav slot", async () => {
    const registry = running.container.registry;
    for (const p of ["analytics.read", "analytics.settings"]) {
      expect(registry.permissions.has(p)).toBe(true);
    }
    const jobs = registry.resolveJobs(running.container.moduleServices).map((j) => j.name);
    expect(jobs).toEqual(expect.arrayContaining([JOB_FLUSH, JOB_ROLLUP, JOB_MAINTAIN]));
    const boot = await json<{ modules: { id: string; slots: Record<string, unknown[]> }[] }>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    const mod = boot.modules.find((m) => m.id === "analytics");
    expect(mod?.slots["admin.nav"]).toHaveLength(1);
  });
});

describe("outbox ingest", () => {
  it("a document.viewed event writes a view session and one event at the fact's own time", async () => {
    // The data room reports the opener's session, so the view session this creates is the same
    // one Ada's page-dwell heartbeats later touch.
    firstOutboxId = await publishOutbox(acmeId, "document.viewed", {
      documentId: DOC_A,
      versionId: VERSION_A,
      membershipId: ada.membershipId,
      sessionId: adaSessionId,
    });
    const row = await waitFor(async () => {
      const found = await rows<{ id: string; occurredAt: string; props: Record<string, unknown> }>(
        `SELECT id, occurred_at AS "occurredAt", props FROM analytics.event
         WHERE resource_id = '${DOC_A}'::uuid AND type = 'document_viewed'`,
      );
      return found[0];
    });
    expect(row.props["outboxId"]).toBe(firstOutboxId);

    // The event carries the outbox row's own time, not the delivery's.
    const outbox = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT created_at AS "createdAt" FROM core.outbox WHERE id = ${firstOutboxId}`,
      );
      return (r.rows as { createdAt: string }[])[0];
    });
    expect(new Date(row.occurredAt).getTime()).toBe(new Date(outbox?.createdAt ?? 0).getTime());

    // A fact without a session id still gets a (synthetic, per member per day) view session.
    const sessions = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM analytics.view_session
       WHERE membership_id = '${ada.membershipId}'::uuid`,
    );
    expect(sessions[0]?.n).toBe(1);
    expect(
      (
        await rows<{ viewSessionId: string | null }>(
          `SELECT view_session_id AS "viewSessionId" FROM analytics.event WHERE id = '${row.id}'::uuid`,
        )
      )[0]?.viewSessionId,
    ).not.toBeNull();
  });

  it("the same outbox row delivered twice writes one event, keeping the first fact's time", async () => {
    const [first, again] = sameDayPair(3 * 60_000, 2 * 60_000);
    for (const at of [first, again]) {
      await deliver(
        onDocumentViewed,
        "document.viewed",
        {
          documentId: DOC_B,
          versionId: VERSION_B,
          membershipId: ada.membershipId,
          sessionId: null,
        },
        at,
        4242,
      );
    }
    const found = await rows<{ occurredAt: string }>(
      `SELECT occurred_at AS "occurredAt" FROM analytics.event
       WHERE resource_id = '${DOC_B}'::uuid AND type = 'document_viewed'`,
    );
    expect(found).toHaveLength(1);
    expect(new Date(found[0]?.occurredAt ?? 0).getTime()).toBe(first.getTime());
    // Backdating is the point: the row is not stamped with the ingest time.
    expect(Date.now() - new Date(found[0]?.occurredAt ?? 0).getTime()).toBeGreaterThan(30_000);
  });
});

describe("tracking modes", () => {
  it("`off` writes nothing at all", async () => {
    const patched = await request("acme", "/api/v1/analytics/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ mode: "off" }),
    });
    expect(patched.status).toBe(200);
    expect(await json(patched)).toEqual({ mode: "off", retentionMonths: 13, ...HOT_DEFAULTS });

    await deliver(
      onDocumentViewed,
      "document.viewed",
      { documentId: DOC_C, versionId: VERSION_C, membershipId: ada.membershipId, sessionId: null },
      backdated(60_000),
      4243,
    );
    const beat = await request("acme", "/api/v1/analytics/heartbeat", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ resourceKind: "document", resourceId: DOC_C, page: 1, ms: 5_000 }),
    });
    expect(await json(beat)).toEqual({ accepted: false, reason: "mode" });
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM analytics.event WHERE resource_id = '${DOC_C}'::uuid`,
        )
      )[0]?.n,
    ).toBe(0);
    expect(
      await json(await request("acme", "/api/v1/analytics/notice", { cookie: ada.cookie })),
    ).toEqual({
      mode: "off",
      tracks: [],
      consent: { mode: "opt_out", granted: null, gpc: false, shouldAsk: false },
      dwell: false,
      emailTracking: { granted: null, active: false },
    });
  });

  it("`essential` records server-side facts but refuses heartbeats", async () => {
    const patched = await request("acme", "/api/v1/analytics/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ mode: "essential" }),
    });
    expect(patched.status).toBe(200);

    await deliver(
      onDocumentDownloaded,
      "document.downloaded",
      {
        documentId: DOC_A,
        versionId: VERSION_A,
        membershipId: ada.membershipId,
        variant: "original",
      },
      backdated(4 * 60_000),
      4244,
    );
    expect(
      (
        await rows<{ n: number; variant: string }>(
          `SELECT count(*)::int AS n, max(props->>'variant') AS variant FROM analytics.event
           WHERE resource_id = '${DOC_A}'::uuid AND type = 'document_downloaded'`,
        )
      )[0],
    ).toEqual({ n: 1, variant: "original" });

    const beat = await request("acme", "/api/v1/analytics/heartbeat", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ resourceKind: "document", resourceId: DOC_A, page: 1, ms: 5_000 }),
    });
    expect(await json(beat)).toEqual({ accepted: false, reason: "mode" });
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM analytics.page_open WHERE resource_id = '${DOC_B}'::uuid`,
        )
      )[0]?.n,
    ).toBe(0);
    expect(
      await json(await request("acme", "/api/v1/analytics/notice", { cookie: ada.cookie })),
    ).toEqual({
      mode: "essential",
      tracks: ["document_views", "downloads", "update_views"],
      consent: { mode: "opt_out", granted: null, gpc: false, shouldAsk: false },
      dwell: false,
      emailTracking: { granted: null, active: false },
    });
  });

  it("`engagement` accepts heartbeats and says so in the notice", async () => {
    const patched = await request("acme", "/api/v1/analytics/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ mode: "engagement" }),
    });
    expect(patched.status).toBe(200);
    expect(
      await json(await request("acme", "/api/v1/analytics/notice", { cookie: ada.cookie })),
    ).toEqual({
      mode: "engagement",
      tracks: [
        "document_views",
        "downloads",
        "update_views",
        "page_dwell",
        "browser_family",
        "hashed_ip",
        // E2.6: engagement also records email opens/clicks and ranks the member on the hot list.
        "email_opens",
        "email_clicks",
        "engagement_score",
      ],
      // `opt_out` records until the member objects, so there is nothing to ask and dwell is on.
      consent: { mode: "opt_out", granted: null, gpc: false, shouldAsk: false },
      dwell: true,
      emailTracking: { granted: null, active: true },
    });
    // Email tracking is its own purpose: withdrawing it shows in the notice, dwell unaffected.
    const withdraw = await request("acme", "/api/v1/compliance/consent", {
      method: "PUT",
      cookie: ada.cookie,
      body: JSON.stringify({ purpose: "email_tracking", granted: false, source: "settings" }),
    });
    expect(withdraw.status).toBe(200);
    const after = await json<{ dwell: boolean; emailTracking: unknown }>(
      await request("acme", "/api/v1/analytics/notice", { cookie: ada.cookie }),
    );
    expect(after).toMatchObject({ dwell: true, emailTracking: { granted: false, active: false } });
    const restore = await request("acme", "/api/v1/compliance/consent", {
      method: "PUT",
      cookie: ada.cookie,
      body: JSON.stringify({ purpose: "email_tracking", granted: true, source: "settings" }),
    });
    expect(restore.status).toBe(200);
  });
});

describe("page dwell", () => {
  async function beat(actor: Actor, resourceId: string, page: number, ms: number) {
    const res = await request("acme", "/api/v1/analytics/heartbeat", {
      method: "POST",
      cookie: actor.cookie,
      headers: { "user-agent": "Mozilla/5.0 (X11) Firefox/140.0" },
      body: JSON.stringify({ resourceKind: "document", resourceId, page, ms }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ accepted: true });
  }

  it("refuses a beat for a resource this session was never recorded opening", async () => {
    /*
     * The beat is the one thing a member sends about themselves, so it is honoured only behind
     * a fact the server produced. Before the `document.viewed` ingest lands there is nothing
     * backing the claim — which is also what a forged beat for someone else's document looks
     * like — and after it lands the same beat is accepted.
     */
    const before = await request("acme", "/api/v1/analytics/heartbeat", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ resourceKind: "document", resourceId: DOC_E, page: 1, ms: 5_000 }),
    });
    expect(before.status).toBe(200);
    expect(await json(before)).toEqual({ accepted: false, reason: "unopened" });
    expect(
      await rows(`SELECT 1 FROM analytics.page_open WHERE resource_id = '${DOC_E}'::uuid`),
    ).toEqual([]);

    await deliver(
      onDocumentViewed,
      "document.viewed",
      {
        documentId: DOC_E,
        versionId: VERSION_E,
        membershipId: ada.membershipId,
        sessionId: adaSessionId,
      },
      backdated(1_000),
      4255,
    );
    const after = await request("acme", "/api/v1/analytics/heartbeat", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ resourceKind: "document", resourceId: DOC_E, page: 1, ms: 5_000 }),
    });
    expect(await json(after)).toEqual({ accepted: true });
  });

  it("refuses a beat from a member who never opened the document, though another did", async () => {
    // Ada opened DOC_E above. Bob may not ride her open into its "who viewed" list.
    const res = await request("acme", "/api/v1/analytics/heartbeat", {
      method: "POST",
      cookie: bob.cookie,
      body: JSON.stringify({ resourceKind: "document", resourceId: DOC_E, page: 1, ms: 9_000 }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ accepted: false, reason: "unopened" });
    const mine = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM analytics.page_open po
       JOIN analytics.view_session vs ON vs.id = po.view_session_id
       WHERE po.resource_id = '${DOC_E}'::uuid AND vs.membership_id = '${bob.membershipId}'::uuid`,
    );
    expect(mine[0]?.n).toBe(0);
  });

  it("caps each beat at 15 s and coalesces them per (session, page)", async () => {
    // The 15 s cap is part of the contract: a longer beat is refused, not silently trimmed.
    const tooLong = await request("acme", "/api/v1/analytics/heartbeat", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({
        resourceKind: "document",
        resourceId: DOC_A,
        page: 1,
        ms: HEARTBEAT_MAX_MS + 5_000,
      }),
    });
    expect(tooLong.status).toBe(400);

    await beat(ada, DOC_A, 1, HEARTBEAT_MAX_MS);
    await beat(ada, DOC_A, 1, 5_000);
    await beat(ada, DOC_A, 2, 3_000);
    const open = await rows<{ pageNo: number; durationMs: number }>(
      `SELECT page_no AS "pageNo", duration_ms AS "durationMs" FROM analytics.page_open
       WHERE resource_id = '${DOC_A}'::uuid ORDER BY page_no`,
    );
    expect(open).toEqual([
      { pageNo: 1, durationMs: HEARTBEAT_MAX_MS + 5_000 },
      { pageNo: 2, durationMs: 3_000 },
    ]);
    // The session row records a browser family and a salted IP hash, never the raw values.
    const session = await rows<{ uaFamily: string; hasIp: boolean; embed: boolean }>(
      `SELECT ua_family AS "uaFamily", ip_hash IS NOT NULL AS "hasIp", embed FROM analytics.view_session
       WHERE membership_id = '${ada.membershipId}'::uuid AND ua_family IS NOT NULL`,
    );
    expect(session[0]).toMatchObject({ uaFamily: "firefox", embed: false });
  });

  it("the close beacon turns this session's open pages into page_viewed events", async () => {
    const res = await request("acme", "/api/v1/analytics/close", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ resourceKind: "document", resourceId: DOC_A }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ flushed: 2 });
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM analytics.page_open WHERE resource_id = '${DOC_A}'::uuid`,
        )
      )[0]?.n,
    ).toBe(0);
    const events = await rows<{
      pageNo: number;
      durationMs: number;
      props: Record<string, string>;
    }>(
      `SELECT page_no AS "pageNo", duration_ms AS "durationMs", props FROM analytics.event
       WHERE resource_id = '${DOC_A}'::uuid AND type = 'page_viewed' ORDER BY page_no`,
    );
    expect(events.map((e) => [e.pageNo, e.durationMs])).toEqual([
      [1, 20_000],
      [2, 3_000],
    ]);
    expect(events[0]?.props["firstAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    // Closing again flushes nothing: the rows are gone.
    const again = await request("acme", "/api/v1/analytics/close", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ resourceKind: "document", resourceId: DOC_A }),
    });
    expect(await json(again)).toEqual({ flushed: 0 });
  });

  it("analytics.flush times out a tab that closed without a beacon", async () => {
    await deliver(
      onDocumentViewed,
      "document.viewed",
      {
        documentId: DOC_B,
        versionId: VERSION_B,
        membershipId: ada.membershipId,
        sessionId: adaSessionId,
      },
      backdated(90_000),
      4247,
    );
    await beat(ada, DOC_B, 1, 4_000);
    await running.container.db.withTenant(systemContext(acmeId), (tx) =>
      tx.execute(
        `UPDATE analytics.page_open SET last_at = now() - interval '5 minutes'
         WHERE resource_id = '${DOC_B}'::uuid`,
      ),
    );
    await runJob(JOB_FLUSH, { workspaceId: acmeId });
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM analytics.page_open WHERE resource_id = '${DOC_B}'::uuid`,
        )
      )[0]?.n,
    ).toBe(0);
    expect(
      (
        await rows<{ durationMs: number }>(
          `SELECT duration_ms AS "durationMs" FROM analytics.event
           WHERE resource_id = '${DOC_B}'::uuid AND type = 'page_viewed'`,
        )
      )[0]?.durationMs,
    ).toBe(4_000);
  });
});

describe("rollups", () => {
  it("leaves unsettled events for the next pass, then folds everything exactly once", async () => {
    // A second viewer of DOC_A and an update open, both settled (backdated).
    await deliver(
      onDocumentViewed,
      "document.viewed",
      { documentId: DOC_A, versionId: VERSION_A, membershipId: bob.membershipId, sessionId: null },
      backdated(3 * 60_000),
      4245,
    );
    await deliver(
      onUpdateViewed,
      "update.viewed",
      { postId: POST_P, versionId: VERSION_P, membershipId: ada.membershipId, sessionId: null },
      backdated(2 * 60_000),
      4246,
    );
    await deliver(
      onDocumentViewed,
      "document.viewed",
      {
        documentId: DOC_D,
        versionId: VERSION_D,
        membershipId: ada.membershipId,
        sessionId: adaSessionId,
      },
      backdated(80_000),
      4248,
    );
    // Fresh dwell on DOC_D: younger than the settle window, so this pass must skip it.
    await request("acme", "/api/v1/analytics/heartbeat", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ resourceKind: "document", resourceId: DOC_D, page: 1, ms: 8_000 }),
    });
    await request("acme", "/api/v1/analytics/close", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ resourceKind: "document", resourceId: DOC_D }),
    });

    await runJob(JOB_ROLLUP, { workspaceId: acmeId });
    // The settled open is folded; the dwell event written a moment ago is not.
    expect(
      (
        await rows<{ views: number; totalMs: number }>(
          `SELECT sum(views)::int AS views, sum(total_ms)::int AS "totalMs"
           FROM analytics.daily_resource_rollup WHERE resource_id = '${DOC_D}'::uuid`,
        )
      )[0],
    ).toEqual({ views: 1, totalMs: 0 });

    await new Promise((r) => setTimeout(r, (ROLLUP_SETTLE_SECONDS + 1) * 1_000));
    await runJob(JOB_ROLLUP, { workspaceId: acmeId });

    const viewerRow = await rows<{
      views: number;
      downloads: number;
      totalMs: number;
      maxPageReached: number | null;
      pagesSeen: number[];
    }>(
      `SELECT views, downloads, total_ms::int AS "totalMs", max_page_reached AS "maxPageReached",
              pages_seen AS "pagesSeen"
       FROM analytics.viewer_resource_rollup
       WHERE membership_id = '${ada.membershipId}'::uuid AND resource_id = '${DOC_A}'::uuid`,
    );
    expect(viewerRow[0]).toEqual({
      views: 1,
      downloads: 1,
      totalMs: 23_000,
      maxPageReached: 2,
      pagesSeen: [1, 2],
    });
    const daily = await rows<{ views: number; downloads: number; totalMs: number; uniq: number }>(
      `SELECT sum(views)::int AS views, sum(downloads)::int AS downloads,
              sum(total_ms)::int AS "totalMs", max(unique_viewers)::int AS uniq
       FROM analytics.daily_resource_rollup WHERE resource_id = '${DOC_A}'::uuid`,
    );
    expect(daily[0]).toEqual({ views: 2, downloads: 1, totalMs: 23_000, uniq: 2 });

    // Re-running walks from the cursor: no double counting.
    await runJob(JOB_ROLLUP, { workspaceId: acmeId });
    await runJob(JOB_ROLLUP, { workspaceId: acmeId });
    expect(
      (
        await rows<{ views: number; totalMs: number }>(
          `SELECT sum(views)::int AS views, sum(total_ms)::int AS "totalMs"
           FROM analytics.daily_resource_rollup WHERE resource_id = '${DOC_A}'::uuid`,
        )
      )[0],
    ).toEqual({ views: 2, totalMs: 23_000 });
  }, 60_000);

  it("analytics.maintain keeps the monthly partitions in place", async () => {
    await runJob(JOB_MAINTAIN);
    const parts = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'analytics' AND c.relname ~ '^event_\\d{6}$'`,
      );
      return (r.rows as { n: number }[])[0]?.n ?? 0;
    });
    expect(parts).toBeGreaterThanOrEqual(4);
  });
});

describe("staff reads", () => {
  it("the overview totals come from the rollups and the recent strip from raw events", async () => {
    const res = await request("acme", "/api/v1/analytics/overview?days=30", {
      cookie: viewer.cookie,
    });
    expect(res.status).toBe(200);
    const o = await json<Overview>(res);
    expect(o.mode).toBe("engagement");
    expect(o.totals).toEqual({ views: 7, uniqueViewers: 2, downloads: 1, totalMs: 35_000 });
    const top = o.topDocuments.find((t) => t.resourceId === DOC_A);
    expect(top).toEqual({
      resourceId: DOC_A,
      views: 2,
      uniqueViewers: 2,
      downloads: 1,
      totalMs: 23_000,
    });
    // The post is counted in the totals but is not a "top document".
    expect(o.topDocuments.map((t) => t.resourceId)).not.toContain(POST_P);
    expect(o.recent).toHaveLength(12);
    expect(o.recent.find((r) => r.membershipId === ada.membershipId)?.membership).toEqual({
      displayName: "ada",
      kind: "external",
      role: "investor",
    });
  });

  it("who viewed a document, and the per-viewer page dwell behind it", async () => {
    const list = await json<ViewerList>(
      await request("acme", `/api/v1/analytics/document/${DOC_A}/viewers`, {
        cookie: viewer.cookie,
      }),
    );
    expect(list.mode).toBe("engagement");
    expect(list.viewers.map((v) => v.membershipId).sort()).toEqual(
      [ada.membershipId, bob.membershipId].sort(),
    );
    const adaRow = list.viewers.find((v) => v.membershipId === ada.membershipId);
    expect(adaRow).toMatchObject({
      displayName: "ada",
      kind: "external",
      role: "investor",
      views: 1,
      downloads: 1,
      totalMs: 23_000,
      maxPageReached: 2,
      pagesSeen: [1, 2],
    });

    const pages = await json<{ pages: { pageNo: number; durationMs: number; views: number }[] }>(
      await request(
        "acme",
        `/api/v1/analytics/document/${DOC_A}/viewers/${ada.membershipId}/pages`,
        { cookie: viewer.cookie },
      ),
    );
    expect(pages.pages).toEqual([
      { pageNo: 1, durationMs: 20_000, views: 1 },
      { pageNo: 2, durationMs: 3_000, views: 1 },
    ]);
    // Nobody has dwell on a post.
    const none = await json<{ pages: unknown[] }>(
      await request("acme", `/api/v1/analytics/post/${POST_P}/viewers/${ada.membershipId}/pages`, {
        cookie: viewer.cookie,
      }),
    );
    expect(none.pages).toEqual([]);
  });

  it("a contact's timeline is newest-first and complete in one page", async () => {
    const all = await json<Timeline>(
      await request("acme", `/api/v1/analytics/members/${ada.membershipId}/timeline?limit=200`, {
        cookie: viewer.cookie,
      }),
    );
    expect(all.nextBefore).toBeNull();
    // Every event of Ada's: five document opens, one download, one update open, four page reads.
    expect(all.items).toHaveLength(11);
    expect(all.items.filter((i) => i.type === "page_viewed")).toHaveLength(4);
    const times = all.items.map((i) => new Date(i.occurredAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(all.items[0]?.resourceId).toBe(DOC_D);
    expect(all.items.at(-1)?.resourceId).toBe(DOC_B);
  });

  it("pages backwards with the keyset cursor without losing rows tied on occurred_at", async () => {
    const all = await json<Timeline>(
      await request("acme", `/api/v1/analytics/members/${ada.membershipId}/timeline?limit=200`, {
        cookie: viewer.cookie,
      }),
    );
    const seen: string[] = [];
    let before: string | null = null;
    let beforeId: string | null = null;
    for (let i = 0; i < 20; i++) {
      const cursor =
        before === null || beforeId === null
          ? ""
          : `&before=${encodeURIComponent(before)}&beforeId=${beforeId}`;
      const page: Timeline = await json<Timeline>(
        await request(
          "acme",
          `/api/v1/analytics/members/${ada.membershipId}/timeline?limit=3${cursor}`,
          { cookie: viewer.cookie },
        ),
      );
      const times = page.items.map((x) => new Date(x.occurredAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      seen.push(...page.items.map((x) => x.id));
      before = page.nextBefore;
      beforeId = page.nextBeforeId;
      if (before === null) break;
    }
    expect(before).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);

    /*
     * The page reads flushed by one close beacon share `occurred_at` to the microsecond, and
     * the page size of 3 makes a boundary fall inside such a tie. The cursor carries the row
     * id as well as the timestamp — the id is part of the sort key — so the rest of the tie is
     * still handed out: paging must return exactly what one big page returns.
     */
    const tiedAt = all.items.filter(
      (i) => all.items.filter((j) => j.occurredAt === i.occurredAt).length > 1,
    );
    expect(tiedAt.length).toBeGreaterThanOrEqual(2);
    expect(seen.sort()).toEqual(all.items.map((i) => i.id).sort());
  });
});

describe("settings + DSAR", () => {
  it("reads need analytics.read, writes need analytics.settings", async () => {
    expect(
      await json(await request("acme", "/api/v1/analytics/settings", { cookie: viewer.cookie })),
    ).toEqual({ mode: "engagement", retentionMonths: 13, ...HOT_DEFAULTS });
    const denied = await request("acme", "/api/v1/analytics/settings", {
      method: "PATCH",
      cookie: viewer.cookie,
      body: JSON.stringify({ retentionMonths: 6 }),
    });
    expect(denied.status).toBe(403);
    const bad = await request("acme", "/api/v1/analytics/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ retentionMonths: 0 }),
    });
    expect(bad.status).toBe(400);
    const ok = await request("acme", "/api/v1/analytics/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ retentionMonths: 6 }),
    });
    expect(await json(ok)).toEqual({ mode: "engagement", retentionMonths: 6, ...HOT_DEFAULTS });
  });

  it("anonymising a member erases their rows and leaves the anonymous daily counts", async () => {
    const unknown = await request("acme", `/api/v1/analytics/members/${randomUUID()}/anonymise`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(unknown.status).toBe(404);
    const denied = await request(
      "acme",
      `/api/v1/analytics/members/${ada.membershipId}/anonymise`,
      { method: "POST", cookie: viewer.cookie },
    );
    expect(denied.status).toBe(403);

    const dailyBefore = await rows<{ views: number }>(
      `SELECT sum(views)::int AS views FROM analytics.daily_resource_rollup`,
    );
    const res = await request("acme", `/api/v1/analytics/members/${ada.membershipId}/anonymise`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const body = await json<{ ok: true; deleted: Record<string, number> }>(res);
    expect(body.ok).toBe(true);
    expect(body.deleted).toMatchObject({
      events: 11,
      pageOpens: 1,
      viewerRollups: 5,
      // DOC_A pages 1 and 2, DOC_B page 1, DOC_D page 1 (the heatmap's distinct-reader rows)
      pageViewers: 4,
      hotLeadAlerts: expect.any(Number),
    });
    expect(body.deleted["viewSessions"]).toBeGreaterThanOrEqual(1);

    expect(
      (
        await json<Timeline>(
          await request("acme", `/api/v1/analytics/members/${ada.membershipId}/timeline`, {
            cookie: viewer.cookie,
          }),
        )
      ).items,
    ).toEqual([]);
    const list = await json<ViewerList>(
      await request("acme", `/api/v1/analytics/document/${DOC_A}/viewers`, {
        cookie: viewer.cookie,
      }),
    );
    expect(list.viewers.map((v) => v.membershipId)).toEqual([bob.membershipId]);
    // The daily rollups name nobody, so they are untouched.
    expect(
      (
        await rows<{ views: number }>(
          `SELECT sum(views)::int AS views FROM analytics.daily_resource_rollup`,
        )
      )[0]?.views,
    ).toBe(dailyBefore[0]?.views);
  });
});

describe("authorization + tenancy", () => {
  const staffPaths = () => [
    "/api/v1/analytics/overview",
    `/api/v1/analytics/document/${DOC_A}/viewers`,
    `/api/v1/analytics/document/${DOC_A}/viewers/${bob.membershipId}/pages`,
    `/api/v1/analytics/members/${bob.membershipId}/timeline`,
    "/api/v1/analytics/settings",
  ];

  it("an investor gets 404 on every staff route but may still beat, close and read the notice", async () => {
    for (const path of staffPaths()) {
      expect((await request("acme", path, { cookie: ada.cookie })).status, path).toBe(404);
    }
    const patch = await request("acme", "/api/v1/analytics/settings", {
      method: "PATCH",
      cookie: ada.cookie,
      body: JSON.stringify({ mode: "off" }),
    });
    expect(patch.status).toBe(404);
    const anonymise = await request(
      "acme",
      `/api/v1/analytics/members/${bob.membershipId}/anonymise`,
      { method: "POST", cookie: ada.cookie },
    );
    expect(anonymise.status).toBe(404);

    for (const [path, body] of [
      [
        "/api/v1/analytics/heartbeat",
        { resourceKind: "document", resourceId: DOC_A, page: 1, ms: 1 },
      ],
      ["/api/v1/analytics/close", { resourceKind: "document", resourceId: DOC_A }],
    ] as const) {
      const res = await request("acme", path, {
        method: "POST",
        cookie: ada.cookie,
        body: JSON.stringify(body),
      });
      expect(res.status, path).toBe(200);
    }
    expect((await request("acme", "/api/v1/analytics/notice", { cookie: ada.cookie })).status).toBe(
      200,
    );
  });

  it("a viewer-role staff member matches the matrix: reads yes, settings no", async () => {
    for (const path of staffPaths()) {
      expect((await request("acme", path, { cookie: viewer.cookie })).status, path).toBe(200);
    }
    expect(
      (
        await request("acme", `/api/v1/analytics/members/${bob.membershipId}/anonymise`, {
          method: "POST",
          cookie: viewer.cookie,
        })
      ).status,
    ).toBe(403);
  });

  it("another tenant sees none of these rows and cannot erase this tenant's member", async () => {
    const timeline = await json<Timeline>(
      await request("globex", `/api/v1/analytics/members/${bob.membershipId}/timeline`, {
        cookie: globexOwner.cookie,
      }),
    );
    expect(timeline.items).toEqual([]);
    const viewers = await json<ViewerList>(
      await request("globex", `/api/v1/analytics/document/${DOC_A}/viewers`, {
        cookie: globexOwner.cookie,
      }),
    );
    expect(viewers.viewers).toEqual([]);
    const anonymise = await request(
      "globex",
      `/api/v1/analytics/members/${bob.membershipId}/anonymise`,
      { method: "POST", cookie: globexOwner.cookie },
    );
    expect(anonymise.status).toBe(404);
  });

  it("the audit trail carries the settings changes and the erasure", async () => {
    const audit = await rows<{ action: string; n: number }>(
      `SELECT action, count(*)::int AS n FROM audit.event
       WHERE action LIKE 'analytics.%' GROUP BY action ORDER BY action`,
    );
    expect(Object.fromEntries(audit.map((r) => [r.action, r.n]))).toEqual({
      "analytics.settings_changed": 4,
      "analytics.anonymised": 1,
    });
    const outbox = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT topic, count(*)::int AS n FROM core.outbox WHERE topic = 'document.viewed' GROUP BY topic`,
      );
      return (r.rows as { topic: string; n: number }[])[0];
    });
    expect(outbox).toEqual({ topic: "document.viewed", n: 1 });
  });
});

// --- E2.6 -----------------------------------------------------------------------------------------

const POST_Q = randomUUID();
const DOC_H = randomUUID();
const VERSION_H1 = randomUUID();
const VERSION_H2 = randomUUID();
const LINK_A = "https://acme.example/deck";
const LINK_B = "https://acme.example/terms";

let carol: Actor;
let dave: Actor;
let eve: Actor;

/** The live `ModuleServices` with some members replaced (it is a Proxy, so it cannot be spread). */
function servicesWith(over: Partial<ModuleServices>): ModuleServices {
  const base = running.container.moduleServices;
  return new Proxy({} as ModuleServices, {
    get: (_t, prop) =>
      prop in over ? over[prop as keyof ModuleServices] : base[prop as keyof ModuleServices],
  });
}

const liveMailHandler = () => createMailDeliveryHandler(() => running.container.moduleServices);

function mailEvent(
  over: Partial<EventPayload<"mail.delivery_recorded">> = {},
): EventPayload<"mail.delivery_recorded"> {
  return {
    messageRef: randomUUID(),
    providerMessageId: `pm-${randomUUID()}`,
    kind: "open",
    bounceType: null,
    automated: false,
    refKind: "post",
    refId: POST_Q,
    membershipId: carol.membershipId,
    link: null,
    occurredAt: backdated(5 * 60_000).toISOString(),
    ...over,
  };
}

async function emailRows(resourceId = POST_Q) {
  return rows<{ membershipId: string; type: string; props: Record<string, unknown> }>(
    `SELECT membership_id AS "membershipId", type, props FROM analytics.event
     WHERE resource_id = '${resourceId}'::uuid AND type IN ('email_opened', 'email_clicked')
     ORDER BY occurred_at, id`,
  );
}

async function patchSettings(body: Record<string, unknown>): Promise<void> {
  const res = await request("acme", "/api/v1/analytics/settings", {
    method: "PATCH",
    cookie: owner.cookie,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

async function setConsent(actor: Actor, purpose: string, granted: boolean): Promise<void> {
  const res = await request("acme", "/api/v1/compliance/consent", {
    method: "PUT",
    cookie: actor.cookie,
    body: JSON.stringify({ purpose, granted, source: "settings" }),
  });
  expect(res.status).toBe(200);
}

async function hotLeadOutbox(membershipId: string): Promise<number> {
  return running.container.db.withHost(async (tx) => {
    const r = await tx.execute(
      `SELECT count(*)::int AS n FROM core.outbox
       WHERE topic = 'analytics.hot_lead' AND payload->>'membershipId' = '${membershipId}'`,
    );
    return (r.rows as { n: number }[])[0]?.n ?? 0;
  });
}

interface HotListBody {
  mode: string;
  days: number;
  threshold: number | null;
  entries: {
    membershipId: string;
    displayName: string;
    score: number;
    points: Record<string, number>;
    counts: Record<string, number>;
    lastActivityAt: string | null;
  }[];
}

describe("E2.6 email opens and clicks", () => {
  beforeAll(async () => {
    carol = await member("acme", acmeId, "carol@investor.test", "external", "investor");
    dave = await member("acme", acmeId, "dave@investor.test", "external", "investor");
    eve = await member("acme", acmeId, "eve@investor.test", "external", "investor");
    // Alerts off until the alert test turns them on: every rollup below runs the alert pass.
    await patchSettings({ hotLeadThreshold: null });
  }, 60_000);

  it("records opens and clicks on a post from mail.delivery_recorded, flagging automated ones", async () => {
    const payloads = [
      mailEvent({ kind: "open" }),
      mailEvent({ kind: "open", automated: true }),
      mailEvent({ kind: "click", link: LINK_A }),
      mailEvent({ kind: "click", link: LINK_A, automated: true }),
      mailEvent({ kind: "click", link: LINK_B }),
      mailEvent({ kind: "open", membershipId: dave.membershipId }),
    ];
    for (const p of payloads) await publishOutbox(acmeId, "mail.delivery_recorded", p);
    const found = await waitFor(async () => {
      const r = await emailRows();
      return r.length === payloads.length ? r : undefined;
    });
    expect(found.filter((r) => r.type === "email_opened")).toHaveLength(3);
    expect(found.filter((r) => r.props["automated"] === true)).toHaveLength(2);
    const clicked = found.filter((r) => r.type === "email_clicked");
    expect(clicked.map((r) => r.props["link"]).sort()).toEqual([LINK_A, LINK_A, LINK_B]);
    // Opens carry no link; every row names its message.
    expect(found.find((r) => r.type === "email_opened")?.props["link"]).toBeUndefined();
    expect(new Set(found.map((r) => r.props["messageRef"])).size).toBe(payloads.length);
  });

  it("is idempotent on (message, kind, time) however often the fact is delivered", async () => {
    const before = (await emailRows()).length;
    const p = mailEvent({ kind: "click", link: LINK_B });
    await deliver(liveMailHandler(), "mail.delivery_recorded", p, new Date(), 6001);
    await deliver(liveMailHandler(), "mail.delivery_recorded", p, new Date(), 6002);
    await publishOutbox(acmeId, "mail.delivery_recorded", p);
    // A different time on the same message is a second open, not a duplicate.
    await deliver(
      liveMailHandler(),
      "mail.delivery_recorded",
      { ...p, occurredAt: backdated(4 * 60_000).toISOString() },
      new Date(),
      6003,
    );
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await emailRows()).length).toBe(before + 2);
  });

  it("ignores deliveries, bounces and anything not tied to a post and a member", async () => {
    const before = (await emailRows()).length;
    for (const p of [
      mailEvent({ kind: "delivered" }),
      mailEvent({ kind: "bounce", bounceType: "hard" }),
      mailEvent({ kind: "complaint" }),
      mailEvent({ kind: "open", refKind: "notification" }),
      mailEvent({ kind: "open", refKind: null, refId: null }),
      mailEvent({ kind: "open", membershipId: null }),
    ]) {
      await deliver(liveMailHandler(), "mail.delivery_recorded", p, new Date(), 6010);
    }
    expect((await emailRows()).length).toBe(before);
  });

  it("records nothing outside `engagement` or once email_tracking consent is withdrawn", async () => {
    const before = (await emailRows()).length;
    await patchSettings({ mode: "essential" });
    await deliver(liveMailHandler(), "mail.delivery_recorded", mailEvent(), new Date(), 6020);
    expect((await emailRows()).length).toBe(before);
    await patchSettings({ mode: "engagement" });

    // The kernel checked consent at the webhook; the outbox may deliver after a withdrawal.
    await setConsent(carol, "email_tracking", false);
    await deliver(liveMailHandler(), "mail.delivery_recorded", mailEvent(), new Date(), 6021);
    expect((await emailRows()).length).toBe(before);
    await setConsent(carol, "email_tracking", true);
    await deliver(liveMailHandler(), "mail.delivery_recorded", mailEvent(), new Date(), 6022);
    expect((await emailRows()).length).toBe(before + 1);
  });

  it("GET /posts/{id}/email keeps human and automated apart and counts clicks per link", async () => {
    const res = await request("acme", `/api/v1/analytics/posts/${POST_Q}/email`, {
      cookie: viewer.cookie,
    });
    expect(res.status).toBe(200);
    const body = await json<{
      mode: string;
      opens: Record<string, number>;
      clicks: Record<string, number>;
      uniqueEngaged: number;
      links: {
        link: string | null;
        clicks: number;
        uniqueClickers: number;
        automatedClicks: number;
      }[];
    }>(res);
    expect(body.mode).toBe("engagement");
    // carol ×2 human (first test + the post-consent one), dave ×1; carol ×1 automated.
    expect(body.opens).toEqual({ human: 3, uniqueHuman: 2, automated: 1, uniqueAutomated: 1 });
    // carol: LINK_A, LINK_B, LINK_B (deduped twice) + LINK_B at another time; one automated LINK_A.
    expect(body.clicks).toEqual({ human: 4, uniqueHuman: 1, automated: 1 });
    expect(body.uniqueEngaged).toBe(2);
    expect(body.links).toEqual([
      { link: LINK_B, clicks: 3, uniqueClickers: 1, automatedClicks: 0 },
      { link: LINK_A, clicks: 1, uniqueClickers: 1, automatedClicks: 1 },
    ]);
    // An update nobody opened reports zeros, not 404: the route does not know which posts exist.
    const none = await json<{ opens: Record<string, number>; links: unknown[] }>(
      await request("acme", `/api/v1/analytics/posts/${randomUUID()}/email`, {
        cookie: viewer.cookie,
      }),
    );
    expect(none.opens).toEqual({ human: 0, uniqueHuman: 0, automated: 0, uniqueAutomated: 0 });
    expect(none.links).toEqual([]);
  });
});

describe("E2.6 page heatmap", () => {
  async function open(actor: Actor, versionId: string, outboxId: number) {
    await deliver(
      onDocumentViewed,
      "document.viewed",
      {
        documentId: DOC_H,
        versionId,
        membershipId: actor.membershipId,
        sessionId: await sessionIdOf(actor),
      },
      backdated(1_000),
      outboxId,
    );
  }
  async function read(actor: Actor, versionId: string, page: number, ms: number) {
    const res = await request("acme", "/api/v1/analytics/heartbeat", {
      method: "POST",
      cookie: actor.cookie,
      body: JSON.stringify({ resourceKind: "document", resourceId: DOC_H, versionId, page, ms }),
    });
    expect(await json(res)).toEqual({ accepted: true });
  }
  async function close(actor: Actor) {
    const res = await request("acme", "/api/v1/analytics/close", {
      method: "POST",
      cookie: actor.cookie,
      body: JSON.stringify({ resourceKind: "document", resourceId: DOC_H }),
    });
    expect(res.status).toBe(200);
  }

  interface HeatmapBody {
    mode: string;
    versions: {
      versionId: string | null;
      pages: { pageNo: number; totalMs: number; views: number; viewers: number; avgMs: number }[];
    }[];
  }

  it("folds page reads into per-version page cells with distinct readers, exactly once", async () => {
    await open(carol, VERSION_H1, 6101);
    await open(dave, VERSION_H1, 6102);
    await read(carol, VERSION_H1, 1, 5_000);
    await read(carol, VERSION_H1, 1, 3_000);
    await read(carol, VERSION_H1, 2, 2_000);
    await read(dave, VERSION_H1, 1, 4_000);
    await close(carol);
    await close(dave);
    // Carol re-reads page 1 in a new version: a different page of a different document text.
    await read(carol, VERSION_H2, 1, 1_000);
    await close(carol);

    await new Promise((r) => setTimeout(r, (ROLLUP_SETTLE_SECONDS + 1) * 1_000));
    await runJob(JOB_ROLLUP, { workspaceId: acmeId });
    await runJob(JOB_ROLLUP, { workspaceId: acmeId });

    const res = await request("acme", `/api/v1/analytics/document/${DOC_H}/heatmap`, {
      cookie: viewer.cookie,
    });
    expect(res.status).toBe(200);
    const body = await json<HeatmapBody>(res);
    expect(body.mode).toBe("engagement");
    const byVersion = new Map(body.versions.map((v) => [v.versionId, v.pages]));
    expect(byVersion.get(VERSION_H1)).toEqual([
      { pageNo: 1, totalMs: 12_000, views: 2, viewers: 2, avgMs: 6_000 },
      { pageNo: 2, totalMs: 2_000, views: 1, viewers: 1, avgMs: 2_000 },
    ]);
    expect(byVersion.get(VERSION_H2)).toEqual([
      { pageNo: 1, totalMs: 1_000, views: 1, viewers: 1, avgMs: 1_000 },
    ]);

    const one = await json<HeatmapBody>(
      await request("acme", `/api/v1/analytics/document/${DOC_H}/heatmap?versionId=${VERSION_H2}`, {
        cookie: viewer.cookie,
      }),
    );
    expect(one.versions.map((v) => v.versionId)).toEqual([VERSION_H2]);

    // Alerts are off (`hotLeadThreshold: null`): these rollups announced nobody.
    expect(await hotLeadOutbox(carol.membershipId)).toBe(0);
  }, 60_000);

  it("a second read of a page by the same member adds dwell but not a reader", async () => {
    await open(carol, VERSION_H1, 6103);
    await read(carol, VERSION_H1, 2, 1_500);
    await close(carol);
    await new Promise((r) => setTimeout(r, (ROLLUP_SETTLE_SECONDS + 1) * 1_000));
    await runJob(JOB_ROLLUP, { workspaceId: acmeId });
    const body = await json<HeatmapBody>(
      await request("acme", `/api/v1/analytics/document/${DOC_H}/heatmap?versionId=${VERSION_H1}`, {
        cookie: viewer.cookie,
      }),
    );
    expect(body.versions[0]?.pages.find((p) => p.pageNo === 2)).toEqual({
      pageNo: 2,
      totalMs: 3_500,
      views: 2,
      viewers: 1,
      avgMs: 1_750,
    });
  }, 60_000);
});

describe("E2.6 hot list", () => {
  it("ranks external members, never scores automated opens and never ranks staff", async () => {
    // Eve's mail client opened the update forty times on its own (MPP), and a scanner clicked.
    for (let i = 0; i < 40; i++) {
      await deliver(
        liveMailHandler(),
        "mail.delivery_recorded",
        mailEvent({ membershipId: eve.membershipId, automated: true }),
        new Date(),
        6200 + i,
      );
    }
    await deliver(
      liveMailHandler(),
      "mail.delivery_recorded",
      mailEvent({ membershipId: eve.membershipId, kind: "click", link: LINK_A, automated: true }),
      new Date(),
      6250,
    );
    // A staff member reading the deck is not a lead.
    await deliver(
      onDocumentViewed,
      "document.viewed",
      {
        documentId: DOC_H,
        versionId: VERSION_H1,
        membershipId: viewer.membershipId,
        sessionId: null,
      },
      backdated(2_000),
      6251,
    );

    const res = await request("acme", "/api/v1/analytics/hot-list", { cookie: viewer.cookie });
    expect(res.status).toBe(200);
    const list = await json<HotListBody>(res);
    expect(list).toMatchObject({ mode: "engagement", days: 14, threshold: null });
    const ids = list.entries.map((e) => e.membershipId);
    expect(ids).not.toContain(eve.membershipId);
    expect(ids).not.toContain(viewer.membershipId);
    expect(ids).not.toContain(owner.membershipId);
    expect(ids).toEqual(expect.arrayContaining([carol.membershipId, dave.membershipId]));
    // Ranked by score, highest first; carol read more, opened and clicked more than dave.
    const scores = list.entries.map((e) => e.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(ids.indexOf(carol.membershipId)).toBeLessThan(ids.indexOf(dave.membershipId));
    const c = list.entries.find((e) => e.membershipId === carol.membershipId);
    expect(c?.counts).toMatchObject({
      views: 1, // the re-open (6103) fell inside the 60 s dedupe of the first
      dwellMs: 12_500,
      downloads: 0,
      humanOpens: 2,
      clicks: 4,
      automatedOpens: 1,
      automatedClicks: 1,
    });
    expect(c?.points["opens"]).toBeGreaterThan(0);
    expect(c?.lastActivityAt).not.toBeNull();

    // `days` bounds: 1..90.
    for (const bad of ["0", "91", "x"]) {
      expect(
        (await request("acme", `/api/v1/analytics/hot-list?days=${bad}`, { cookie: viewer.cookie }))
          .status,
      ).toBe(400);
    }
    const narrow = await json<HotListBody>(
      await request("acme", "/api/v1/analytics/hot-list?days=1", { cookie: viewer.cookie }),
    );
    expect(narrow.days).toBe(1);
  });

  it("takes a member off the list once their consent refuses engagement analytics", async () => {
    await setConsent(dave, "analytics_engagement", false);
    const list = await json<HotListBody>(
      await request("acme", "/api/v1/analytics/hot-list", { cookie: viewer.cookie }),
    );
    expect(list.entries.map((e) => e.membershipId)).not.toContain(dave.membershipId);
    expect(list.entries.map((e) => e.membershipId)).toContain(carol.membershipId);
    await setConsent(dave, "analytics_engagement", true);
  });

  it("the CSV export is audited, no-store and neutralises a formula in a display name", async () => {
    const userId = (
      await rows<{ userId: string }>(
        `SELECT user_id AS "userId" FROM core.membership WHERE id = '${carol.membershipId}'::uuid`,
      )
    )[0]?.userId;
    await running.container.db.withHost((tx) =>
      tx.execute(
        `UPDATE core.user SET display_name = '=HYPERLINK("http://evil.example","x")' WHERE id = '${userId}'::uuid`,
      ),
    );
    const res = await request("acme", "/api/v1/analytics/hot-list.csv", { cookie: viewer.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="hot-list-14d.csv"');
    const csv = await res.text();
    const lines = csv.replace(/^\uFEFF/u, "").split("\r\n");
    expect(lines[0]).toBe(
      "rank,membership_id,name,role,score,views,dwell_seconds,downloads,human_opens,clicks,automated_opens,last_activity_at",
    );
    const carolLine = lines.find((l) => l.includes(carol.membershipId)) ?? "";
    expect(carolLine).toContain(`,"'=HYPERLINK(""http://evil.example"",""x"")",investor,`);
    expect(csv).not.toContain(",=HYPERLINK");
    expect(csv).not.toContain(eve.membershipId);

    const audit = await rows<{ actor: string; meta: Record<string, unknown> }>(
      `SELECT actor_membership_id AS actor, meta FROM audit.event
       WHERE action = 'analytics.hot_list_exported' ORDER BY seq DESC LIMIT 1`,
    );
    expect(audit[0]?.actor).toBe(viewer.membershipId);
    expect(audit[0]?.meta).toMatchObject({ days: 14, mode: "engagement" });
    expect(audit[0]?.meta["rows"]).toBe(lines.length - 2);
  });

  it("announces a hot lead once per window, and never while the threshold is null", async () => {
    expect(await hotLeadOutbox(carol.membershipId)).toBe(0);
    await patchSettings({ hotLeadThreshold: 5 });
    await runJob(JOB_ROLLUP, { workspaceId: acmeId });
    expect(await hotLeadOutbox(carol.membershipId)).toBe(1);
    const payload = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT payload FROM core.outbox WHERE topic = 'analytics.hot_lead'
         AND payload->>'membershipId' = '${carol.membershipId}'`,
      );
      return (r.rows as { payload: { score: number } }[])[0]?.payload;
    });
    expect(payload?.score).toBeGreaterThanOrEqual(5);
    // Automated-only activity never makes a lead, whatever the threshold.
    expect(await hotLeadOutbox(eve.membershipId)).toBe(0);
    // More activity inside the same window: no second alert.
    await deliver(
      onDocumentDownloaded,
      "document.downloaded",
      {
        documentId: DOC_H,
        versionId: VERSION_H1,
        membershipId: carol.membershipId,
        variant: "original",
      },
      backdated(2_000),
      6300,
    );
    await runJob(JOB_ROLLUP, { workspaceId: acmeId });
    await runJob(JOB_ROLLUP, { workspaceId: acmeId });
    expect(await hotLeadOutbox(carol.membershipId)).toBe(1);
    expect(
      await rows(
        `SELECT 1 FROM analytics.hot_lead_alert WHERE membership_id = '${carol.membershipId}'::uuid`,
      ),
    ).toHaveLength(1);
  });

  it("the new staff routes answer investors 404 and admit a viewer-role staff member", async () => {
    const paths = [
      `/api/v1/analytics/document/${DOC_H}/heatmap`,
      "/api/v1/analytics/hot-list",
      "/api/v1/analytics/hot-list.csv",
      `/api/v1/analytics/posts/${POST_Q}/email`,
    ];
    for (const path of paths) {
      expect((await request("acme", path, { cookie: carol.cookie })).status, path).toBe(404);
      expect((await request("acme", path, { cookie: viewer.cookie })).status, path).toBe(200);
    }
    // Another tenant sees none of acme's rows.
    const other = await json<HotListBody>(
      await request("globex", "/api/v1/analytics/hot-list", { cookie: globexOwner.cookie }),
    );
    expect(other.entries).toEqual([]);
    const heat = await json<{ versions: unknown[] }>(
      await request("globex", `/api/v1/analytics/document/${DOC_H}/heatmap`, {
        cookie: globexOwner.cookie,
      }),
    );
    expect(heat.versions).toEqual([]);
  });

  it("settings carry the hot-list window and threshold, validated", async () => {
    for (const bad of [
      { hotListWindowDays: 0 },
      { hotListWindowDays: 91 },
      { hotLeadThreshold: 0 },
      { hotLeadThreshold: 101 },
    ]) {
      const res = await request("acme", "/api/v1/analytics/settings", {
        method: "PATCH",
        cookie: owner.cookie,
        body: JSON.stringify(bad),
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const ok = await request("acme", "/api/v1/analytics/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ hotListWindowDays: 30, hotLeadThreshold: 70 }),
    });
    expect(await json(ok)).toEqual({
      mode: "engagement",
      retentionMonths: 6,
      hotListWindowDays: 30,
      hotLeadThreshold: 70,
    });
    const list = await json<HotListBody>(
      await request("acme", "/api/v1/analytics/hot-list", { cookie: viewer.cookie }),
    );
    expect(list).toMatchObject({ days: 30, threshold: 70 });
  });
});

describe("E2.6 DSAR erasure", () => {
  it("member.erasure_requested erases the member's rows, keeps the anonymous counts and audits it", async () => {
    const heatBefore = await rows<{ viewers: number; totalMs: number }>(
      `SELECT sum(viewers)::int AS viewers, sum(total_ms)::int AS "totalMs"
       FROM analytics.page_rollup WHERE resource_id = '${DOC_H}'::uuid`,
    );
    const requestId = randomUUID();
    await publishOutbox(acmeId, "member.erasure_requested", {
      requestId,
      membershipId: carol.membershipId,
    });
    const audit = await waitFor(async () => {
      const found = await rows<{ meta: Record<string, unknown>; actorKind: string }>(
        `SELECT meta, actor_kind AS "actorKind" FROM audit.event
         WHERE action = 'analytics.anonymised' AND meta->>'requestId' = '${requestId}'`,
      );
      return found[0];
    });
    expect(audit.actorKind).toBe("system");
    expect(audit.meta).toMatchObject({ hotLeadAlerts: 1 });
    expect(audit.meta["events"]).toBeGreaterThan(0);
    expect(audit.meta["pageViewers"]).toBe(3);

    for (const table of [
      "event",
      "view_session",
      "viewer_resource_rollup",
      "page_viewer",
      "hot_lead_alert",
    ]) {
      expect(
        await rows(
          `SELECT 1 FROM analytics.${table} WHERE membership_id = '${carol.membershipId}'::uuid`,
        ),
        table,
      ).toEqual([]);
    }
    // The heatmap's counts name nobody, so they stay as they were.
    expect(
      await rows(
        `SELECT sum(viewers)::int AS viewers, sum(total_ms)::int AS "totalMs"
         FROM analytics.page_rollup WHERE resource_id = '${DOC_H}'::uuid`,
      ),
    ).toEqual(heatBefore);
    // …and carol is off the hot list.
    const list = await json<HotListBody>(
      await request("acme", "/api/v1/analytics/hot-list", { cookie: viewer.cookie }),
    );
    expect(list.entries.map((e) => e.membershipId)).not.toContain(carol.membershipId);
  });

  it("reports its counts to legal.completeErasureStep in the same transaction", async () => {
    const calls: { requestId: string; module: string; counts: Readonly<Record<string, number>> }[] =
      [];
    const live = running.container.moduleServices.legal;
    const services = servicesWith({
      legal: {
        ...live,
        completeErasureStep: async (_tx, _ctx, requestId, module, counts) => {
          calls.push({ requestId, module, counts });
        },
      } as ModuleServices["legal"],
    });
    const requestId = randomUUID();
    await deliver(
      createErasureHandler(() => services),
      "member.erasure_requested",
      { requestId, membershipId: dave.membershipId },
      new Date(),
      6400,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ requestId, module: "analytics" });
    expect(calls[0]?.counts).toMatchObject({ pageViewers: 1, pageOpens: 0 });
    expect(calls[0]?.counts["events"]).toBeGreaterThan(0);
    expect(
      await rows(
        `SELECT 1 FROM analytics.event WHERE membership_id = '${dave.membershipId}'::uuid`,
      ),
    ).toEqual([]);

    // A step that fails rolls the erasure back with it: never "reported but not erased".
    await deliver(
      onDocumentViewed,
      "document.viewed",
      {
        documentId: DOC_H,
        versionId: VERSION_H1,
        membershipId: dave.membershipId,
        sessionId: null,
      },
      backdated(1_000),
      6401,
    );
    const failing = servicesWith({
      legal: {
        ...live,
        completeErasureStep: async () => {
          throw new Error("kernel unavailable");
        },
      } as ModuleServices["legal"],
    });
    await expect(
      deliver(
        createErasureHandler(() => failing),
        "member.erasure_requested",
        { requestId: randomUUID(), membershipId: dave.membershipId },
        new Date(),
        6402,
      ),
    ).rejects.toThrow("kernel unavailable");
    expect(
      await rows(
        `SELECT 1 FROM analytics.event WHERE membership_id = '${dave.membershipId}'::uuid`,
      ),
    ).toHaveLength(1);
  });
});

describe("E2.6 DSAR erasure ignores module enablement", () => {
  it("erases and reports even where analytics is switched off for the workspace", async () => {
    // A row written while the module was on; then the workspace switches analytics off.
    await rows(
      `INSERT INTO analytics.event (workspace_id, membership_id, type, resource_kind, resource_id)
       VALUES ('${globexId}'::uuid, '${globexOwner.membershipId}'::uuid, 'document_viewed', 'document',
               '${randomUUID()}'::uuid) RETURNING id`,
      globexId,
    );
    await rows(
      `INSERT INTO core.module_enablement (workspace_id, module, enabled)
       VALUES ('${globexId}'::uuid, 'analytics', false) RETURNING module`,
      globexId,
    );
    expect(
      (
        await loadWorkspaceModules(
          running.container.db,
          systemContext(globexId),
          running.container.registry,
        )
      ).enabled.has("analytics"),
    ).toBe(false);
    try {
      const requestId = randomUUID();
      await publishOutbox(globexId, "member.erasure_requested", {
        requestId,
        membershipId: globexOwner.membershipId,
      });
      const audit = await waitFor(async () => {
        const found = await rows<{ meta: Record<string, unknown> }>(
          `SELECT meta FROM audit.event
           WHERE action = 'analytics.anonymised' AND meta->>'requestId' = '${requestId}'`,
          globexId,
        );
        return found[0];
      });
      expect(audit.meta["events"]).toBe(1);
      expect(
        await rows(
          `SELECT 1 FROM analytics.event WHERE membership_id = '${globexOwner.membershipId}'::uuid`,
          globexId,
        ),
      ).toEqual([]);
    } finally {
      await rows(
        `DELETE FROM core.module_enablement WHERE workspace_id = '${globexId}'::uuid
         AND module = 'analytics' RETURNING module`,
        globexId,
      );
    }
  });
});

describe("E2.6 per-workspace retention", () => {
  it("trims each workspace's raw events to its own retention, and not while it is on legal hold", async () => {
    await publishOutbox(globexId, "document.viewed", {
      documentId: DOC_A,
      versionId: VERSION_A,
      membershipId: globexOwner.membershipId,
      sessionId: null,
    });
    const count = (ws: string) =>
      rows<{ n: number }>(`SELECT count(*)::int AS n FROM analytics.event`, ws).then(
        (r) => r[0]?.n ?? 0,
      );
    await waitFor(async () => ((await count(globexId)) > 0 ? true : undefined));
    expect(await count(acmeId)).toBeGreaterThan(0);

    const setHold = (hold: boolean) =>
      running.container.db.withHost((tx) =>
        tx.execute(
          `UPDATE core.workspace SET settings = settings || jsonb_build_object('legal',
             coalesce(settings->'legal', '{}'::jsonb) || jsonb_build_object('legalHold', ${hold}))
           WHERE id = '${globexId}'::uuid`,
        ),
      );
    await setHold(true);

    // Sixteen months on: past acme's 6-month retention and globex's default 13.
    const later = new Date(Date.now() + 16 * 31 * 86_400_000);
    const maintain = () =>
      createAnalyticsJobs(servicesWith({ now: () => later }))
        .find((j) => j.name === JOB_MAINTAIN)
        ?.handler({
          id: "test-maintain",
          name: JOB_MAINTAIN,
          data: {},
          signal: new AbortController().signal,
        });
    await maintain();
    expect(await count(acmeId)).toBe(0);
    expect(
      (
        await rows<{ n: number }>(`SELECT count(*)::int AS n FROM analytics.view_session`, acmeId)
      )[0]?.n,
    ).toBe(0);
    // The hold overrides deletion.
    expect(await count(globexId)).toBeGreaterThan(0);
    // The anonymous rollups are never trimmed.
    expect(
      (
        await rows<{ n: number }>(`SELECT count(*)::int AS n FROM analytics.daily_resource_rollup`)
      )[0]?.n,
    ).toBeGreaterThan(0);

    await setHold(false);
    await maintain();
    expect(await count(globexId)).toBe(0);
  });
});

// --- E2.6 review fixes (FX3) ----------------------------------------------------------------------

/** Merges `patch` into each named settings block of a workspace (host write, cache-free reads follow). */
async function mergeSettings(
  workspaceId: string,
  patch: Record<string, Record<string, unknown>>,
): Promise<void> {
  for (const [block, value] of Object.entries(patch)) {
    await running.container.db.withHost((tx) =>
      tx.execute(
        `UPDATE core.workspace SET settings = settings || jsonb_build_object('${block}',
           coalesce(settings->'${block}', '{}'::jsonb) || '${JSON.stringify(value)}'::jsonb)
         WHERE id = '${workspaceId}'::uuid`,
      ),
    );
  }
  running.container.moduleServices.workspaces.invalidate(workspaceId);
}

/** Live services whose `legal.isErased` answers from `erased` (everything else stays real). */
function erasing(erased: (membershipId: string) => boolean): ModuleServices {
  return servicesWith({
    legal: {
      ...running.container.moduleServices.legal,
      isErased: async (_tx, _ctx, membershipId) => erased(membershipId),
    } as ModuleServices["legal"],
  });
}

const ENGAGEMENT: AnalyticsSettings = {
  mode: "engagement",
  retentionMonths: 13,
  hotListWindowDays: 14,
  hotLeadThreshold: null,
};

async function runMaintain(services: ModuleServices = running.container.moduleServices) {
  await createAnalyticsJobs(services)
    .find((j) => j.name === JOB_MAINTAIN)
    ?.handler({
      id: "test-maintain",
      name: JOB_MAINTAIN,
      data: {},
      signal: new AbortController().signal,
    });
}

async function partitionExists(name: string): Promise<boolean> {
  return running.container.db.withHost(async (tx) => {
    const r = await tx.execute(`SELECT to_regclass('analytics.${name}') IS NOT NULL AS present`);
    return (r.rows as { present: boolean }[])[0]?.present === true;
  });
}

/** A new workspace with `n` external members (fresh users), consent `opt_out`, analytics `engagement`. */
async function scratchWorkspace(slug: string, n: number) {
  const ws = await createWorkspace(running.container.db, { slug, name: slug });
  const deps = running.container.identityDeps;
  const members: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const user = await provisionUser(deps, {
      email: `${slug}-${i}@investor.test`,
      displayName: `${slug} ${i}`,
    });
    const m = await provisionMembership(deps, {
      workspaceId: ws.id,
      userId: user.userId,
      kind: "external",
      role: "investor",
      source: "test",
    });
    members.push(m.id);
  }
  await mergeSettings(ws.id, {
    legal: { consentMode: "opt_out" },
    analytics: { mode: "engagement" },
  });
  return { id: ws.id, members };
}

async function insertEvent(
  workspaceId: string,
  membershipId: string,
  resourceId: string,
  occurredAt: string,
  type = "document_viewed",
  props: Record<string, unknown> = {},
): Promise<void> {
  await rows(
    `INSERT INTO analytics.event (workspace_id, occurred_at, membership_id, type, resource_kind, resource_id, props)
     VALUES ('${workspaceId}'::uuid, '${occurredAt}'::timestamptz, '${membershipId}'::uuid, '${type}',
             '${type.startsWith("email_") ? "post" : "document"}', '${resourceId}'::uuid, '${JSON.stringify(props)}'::jsonb)
     RETURNING id`,
    workspaceId,
  );
}

describe("E2.6 shared partitions are dropped at the longest retention", () => {
  const monthsAgo = (n: number) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 15, 12));
  };
  const old = monthsAgo(24);
  const partition = `event_${old.toISOString().slice(0, 7).replace("-", "")}`;

  it("keeps another workspace's rows when one workspace's retention is shorter", async () => {
    await running.container.db.withHost((tx) =>
      tx.execute(
        `SELECT analytics.ensure_partitions(0, '${old.toISOString().slice(0, 10)}'::date)`,
      ),
    );
    expect(await partitionExists(partition)).toBe(true);
    const short = await scratchWorkspace("keep-short", 0);
    const long = await scratchWorkspace("keep-long", 0);
    await mergeSettings(short.id, { analytics: { retentionMonths: 1 } });
    await mergeSettings(long.id, { analytics: { retentionMonths: 120 } });
    const who = randomUUID();
    await insertEvent(short.id, who, DOC_A, old.toISOString());
    await insertEvent(long.id, who, DOC_A, old.toISOString());
    const count = (ws: string) =>
      rows<{ n: number }>(`SELECT count(*)::int AS n FROM analytics.event`, ws).then(
        (r) => r[0]?.n ?? 0,
      );

    await runMaintain();
    // The 24-month-old partition is within B's 120 months: it stays, and so do B's rows…
    expect(await partitionExists(partition)).toBe(true);
    expect(await count(long.id)).toBe(1);
    // …while A's own trim still honours A's one month.
    expect(await count(short.id)).toBe(0);

    // A soft-deleted workspace on legal hold still holds rows in the shared partitions.
    await mergeSettings(long.id, { analytics: { retentionMonths: 12 } });
    const gone = await scratchWorkspace("keep-gone", 0);
    await insertEvent(gone.id, who, DOC_A, old.toISOString());
    await mergeSettings(gone.id, { legal: { legalHold: true } });
    await running.container.db.withHost((tx) =>
      tx.execute(`UPDATE core.workspace SET deleted_at = now() WHERE id = '${gone.id}'::uuid`),
    );
    await runMaintain();
    expect(await count(long.id)).toBe(0);
    expect(await partitionExists(partition)).toBe(true);
    expect(await count(gone.id)).toBe(1);

    // Hold lifted: every workspace's retention is now shorter than 24 months, so it goes.
    await mergeSettings(gone.id, { legal: { legalHold: false } });
    await runMaintain();
    expect(await partitionExists(partition)).toBe(false);
  });
});

describe("E2.6 per-member rollups follow the workspace retention", () => {
  it("trims viewer rollups, heatmap readers and hot-lead markers past retention, not under hold", async () => {
    const ws = await scratchWorkspace("trim-rollups", 0);
    await mergeSettings(ws.id, { analytics: { retentionMonths: 1 } });
    const stale = randomUUID();
    const fresh = randomUUID();
    const oldAt = new Date(Date.now() - 200 * 86_400_000).toISOString();
    for (const [m, at] of [
      [stale, oldAt],
      [fresh, new Date().toISOString()],
    ] as const) {
      await rows(
        `INSERT INTO analytics.viewer_resource_rollup (workspace_id, membership_id, resource_kind, resource_id, first_at, last_at, views)
         VALUES ('${ws.id}'::uuid, '${m}'::uuid, 'document', '${DOC_A}'::uuid, '${at}', '${at}', 1) RETURNING 1`,
        ws.id,
      );
      await rows(
        `INSERT INTO analytics.page_viewer (workspace_id, resource_id, version_key, page_no, membership_id, last_at)
         VALUES ('${ws.id}'::uuid, '${DOC_A}'::uuid, '${VERSION_A}'::uuid, 1, '${m}'::uuid, '${at}') RETURNING 1`,
        ws.id,
      );
      await rows(
        `INSERT INTO analytics.hot_lead_alert (workspace_id, membership_id, alerted_at, score)
         VALUES ('${ws.id}'::uuid, '${m}'::uuid, '${at}', 70) RETURNING 1`,
        ws.id,
      );
    }
    const members = async () => {
      const out: Record<string, string[]> = {};
      for (const t of ["viewer_resource_rollup", "page_viewer", "hot_lead_alert"]) {
        out[t] = (
          await rows<{ m: string }>(
            `SELECT membership_id AS m FROM analytics.${t} ORDER BY 1`,
            ws.id,
          )
        ).map((r) => r.m);
      }
      return out;
    };
    const both = [stale, fresh].sort();

    await mergeSettings(ws.id, { legal: { legalHold: true } });
    await runMaintain();
    expect(await members()).toEqual({
      viewer_resource_rollup: both,
      page_viewer: both,
      hot_lead_alert: both,
    });

    await mergeSettings(ws.id, { legal: { legalHold: false } });
    await runMaintain();
    expect(await members()).toEqual({
      viewer_resource_rollup: [fresh],
      page_viewer: [fresh],
      hot_lead_alert: [fresh],
    });
  });
});

describe("E2.6 erasure is not undone by the pipeline", () => {
  it("drops an email open for an erased member at ingest", async () => {
    const live = mailEvent({ membershipId: eve.membershipId, refId: POST_P });
    await deliver(
      createMailDeliveryHandler(() => erasing((id) => id === eve.membershipId)),
      "mail.delivery_recorded",
      live,
      new Date(),
      7001,
    );
    expect(await emailRows(POST_P)).toEqual([]);
    await deliver(liveMailHandler(), "mail.delivery_recorded", live, new Date(), 7002);
    expect(await emailRows(POST_P)).toHaveLength(1);
  });

  it("refuses a heartbeat from an erased member and writes no page_open", async () => {
    const doc = randomUUID();
    await deliver(
      onDocumentViewed,
      "document.viewed",
      {
        documentId: doc,
        versionId: randomUUID(),
        membershipId: ada.membershipId,
        sessionId: adaSessionId,
      },
      backdated(1_000),
      7010,
    );
    const who = {
      membershipId: ada.membershipId,
      sessionId: adaSessionId,
      gpc: false,
      embed: false,
    };
    const input = { resourceKind: "document" as const, resourceId: doc, page: 1, ms: 3_000 };
    const refused = await createTrackingService(erasing((id) => id === ada.membershipId)).heartbeat(
      acmeId,
      ENGAGEMENT,
      who,
      input,
    );
    expect(refused.accepted).toBe(false);
    expect(
      await rows(`SELECT 1 FROM analytics.page_open WHERE resource_id = '${doc}'::uuid`),
    ).toEqual([]);
    const accepted = await createTrackingService(running.container.moduleServices).heartbeat(
      acmeId,
      ENGAGEMENT,
      who,
      input,
    );
    expect(accepted).toEqual({ accepted: true });
    await rows(`DELETE FROM analytics.page_open WHERE resource_id = '${doc}'::uuid RETURNING 1`);
  });

  it("the flush discards an erased member's open pages instead of turning them into events", async () => {
    const ws = await scratchWorkspace("flush-erased", 2);
    const [erased, kept] = ws.members as [string, string];
    const doc = randomUUID();
    for (const m of [erased, kept]) {
      await rows(
        `WITH s AS (
           INSERT INTO analytics.view_session (workspace_id, membership_id, session_key)
           VALUES ('${ws.id}'::uuid, '${m}'::uuid, decode(md5(random()::text) || md5(random()::text), 'hex'))
           RETURNING id)
         INSERT INTO analytics.page_open (workspace_id, view_session_id, membership_id, resource_kind, resource_id, page_no, duration_ms, last_at)
         SELECT '${ws.id}'::uuid, s.id, '${m}'::uuid, 'document', '${doc}'::uuid, 1, 4000, now() - interval '10 minutes' FROM s
         RETURNING 1`,
        ws.id,
      );
    }
    const ctx = systemContext(ws.id);
    const flushed = await running.container.db.withTenant(ctx, (tx) =>
      flushIdleFor(
        erasing((id) => id === erased),
        tx,
        ctx,
        new Date(),
      ),
    );
    expect(flushed).toBe(1);
    expect(
      await rows<{ m: string }>(
        `SELECT membership_id AS m FROM analytics.event WHERE resource_id = '${doc}'::uuid`,
        ws.id,
      ),
    ).toEqual([{ m: kept }]);
    expect(await rows(`SELECT 1 FROM analytics.page_open`, ws.id)).toEqual([]);
  });

  it("the rollup does not fold an erased member back in, nor rank them on the hot list", async () => {
    const ws = await scratchWorkspace("fold-erased", 2);
    const [erased, kept] = ws.members as [string, string];
    const doc = randomUUID();
    const at = new Date(Date.now() - 60 * 60_000).toISOString();
    for (const m of [erased, kept]) await insertEvent(ws.id, m, doc, at);
    const services = erasing((id) => id === erased);
    await createAnalyticsJobs(services)
      .find((j) => j.name === JOB_ROLLUP)
      ?.handler({
        id: "test-rollup",
        name: JOB_ROLLUP,
        data: { workspaceId: ws.id },
        signal: new AbortController().signal,
      });
    expect(
      await rows<{ m: string }>(
        `SELECT membership_id AS m FROM analytics.viewer_resource_rollup WHERE resource_id = '${doc}'::uuid`,
        ws.id,
      ),
    ).toEqual([{ m: kept }]);

    const ranked = (s: ModuleServices) =>
      createHotListService(s)
        .list(systemContext(ws.id), ENGAGEMENT, 14)
        .then((l) => l.entries.map((e) => e.membershipId).sort());
    expect(await ranked(running.container.moduleServices)).toEqual([erased, kept].sort());
    expect(await ranked(services)).toEqual([kept]);
  });

  it("erasure and the rollup walk serialise on the workspace analytics lock", async () => {
    const ws = await scratchWorkspace("lock-erase", 1);
    const ctx = systemContext(ws.id);
    let release: () => void = () => {};
    let locked: () => void = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = running.container.db.withTenant(ctx, async (tx) => {
      await tx.execute(
        `SELECT pg_advisory_xact_lock(hashtextextended('analytics.rollup:${ws.id}', 0))`,
      );
      locked();
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await isLocked;
    let erased = false;
    const erase = running.container.db
      .withTenant(ctx, (tx) => eraseMemberRows(ctx, tx, ws.members[0] ?? ""))
      .then(() => {
        erased = true;
      });
    let rolled = false;
    const rollup = createAnalyticsJobs(running.container.moduleServices)
      .find((j) => j.name === JOB_ROLLUP)
      ?.handler({
        id: "test-rollup-lock",
        name: JOB_ROLLUP,
        data: { workspaceId: ws.id },
        signal: new AbortController().signal,
      })
      .then(() => {
        rolled = true;
      });
    await new Promise((r) => setTimeout(r, 750));
    expect({ erased, rolled }).toEqual({ erased: false, rolled: false });
    release();
    await Promise.all([holder, erase, rollup]);
    expect({ erased, rolled }).toEqual({ erased: true, rolled: true });
  });
});

describe("E2.6 email ingest dedupe and unscored links", () => {
  it("a redelivered future-dated event is recorded once, at a time no later than its receipt", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const p = mailEvent({ membershipId: eve.membershipId, refId: POST_P, occurredAt: future });
    const firstReceipt = new Date();
    await deliver(liveMailHandler(), "mail.delivery_recorded", p, firstReceipt, 7101);
    await new Promise((r) => setTimeout(r, 50));
    await deliver(liveMailHandler(), "mail.delivery_recorded", p, new Date(), 7102);
    const found = await rows<{ at: string }>(
      `SELECT occurred_at AS at FROM analytics.event
       WHERE type = 'email_opened' AND props->>'messageRef' = '${p.messageRef}'`,
    );
    expect(found).toHaveLength(1);
    expect(new Date(String(found[0]?.at)).getTime()).toBeLessThanOrEqual(firstReceipt.getTime());
  });

  it("drops clicks on /unsubscribe and /api/ paths at ingest, and never scores stored ones", async () => {
    for (const link of [
      "https://acme.portal.example.test/unsubscribe",
      "https://acme.portal.example.test/api/v1/mail/unsubscribe/tok",
    ]) {
      const p = mailEvent({ kind: "click", link, membershipId: eve.membershipId, refId: POST_P });
      await deliver(liveMailHandler(), "mail.delivery_recorded", p, new Date(), 7110);
      expect(
        await rows(`SELECT 1 FROM analytics.event WHERE props->>'messageRef' = '${p.messageRef}'`),
      ).toEqual([]);
    }

    // A click row stored before the filter (or by any other path) scores nothing.
    const ws = await scratchWorkspace("unscored-click", 1);
    const [m] = ws.members as [string];
    await insertEvent(
      ws.id,
      m,
      randomUUID(),
      new Date(Date.now() - 60_000).toISOString(),
      "email_clicked",
      {
        link: "https://acme.portal.example.test/unsubscribe",
        automated: false,
      },
    );
    const list = await createHotListService(running.container.moduleServices).list(
      systemContext(ws.id),
      ENGAGEMENT,
      14,
    );
    expect(list.entries).toEqual([]);
  });
});

describe("E2.6 staff anonymise honours the legal hold", () => {
  it("refuses with 409 conflict / legal_hold and erases nothing", async () => {
    const count = async () =>
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM analytics.event WHERE membership_id = '${bob.membershipId}'::uuid`,
        )
      )[0]?.n ?? 0;
    await insertEvent(acmeId, bob.membershipId, DOC_A, backdated(60_000).toISOString());
    const before = await count();
    expect(before).toBeGreaterThan(0);
    await mergeSettings(acmeId, { legal: { legalHold: true } });
    try {
      const res = await request("acme", `/api/v1/analytics/members/${bob.membershipId}/anonymise`, {
        method: "POST",
        cookie: owner.cookie,
      });
      expect(res.status).toBe(409);
      expect((await json<{ error: { code: string; reason: string } }>(res)).error).toMatchObject({
        code: "conflict",
        reason: "legal_hold",
      });
      expect(await count()).toBe(before);
    } finally {
      await mergeSettings(acmeId, { legal: { legalHold: false } });
    }
  });
});
