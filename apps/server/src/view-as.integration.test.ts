import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext, updateOfferingStatus } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { JOB_FLUSH, JOB_ROLLUP, ROLLUP_SETTLE_SECONDS } from "@fundroom/module-analytics";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import * as OTPAuth from "otpauth";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * View as investor (E2.7 package B2), end to end.
 *
 * The load-bearing part is the walk: every investor-facing GET in the OpenAPI document
 * (`x-requires: member`, plus the bootstrap, `/me` and the rendered content page) is requested
 * while a staff session views the portal as an investor, against real seeded data — a data-room
 * document, a sent update, a published content page, a KPI, an open round. None may answer 5xx,
 * none but the downloads may answer `view_as_read_only` (that would mean the READ ONLY backstop
 * caught a write the route should have skipped), and the row count of every application table
 * must be the same afterwards: nothing was recorded as the investor. Then the edges: a POST is
 * refused, leaving works, expiry, the staff member losing access, the target being revoked,
 * who may start a view, step-up, the audit trail, and replacing a view in another workspace.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

interface Actor {
  cookie: string;
  membershipId: string;
  email: string;
}

async function request(slug: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
  return running.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function codeOf(res: Response): Promise<string | undefined> {
  const text = await res.clone().text();
  try {
    return (JSON.parse(text) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function signIn(slug: string, email: string): Promise<Omit<Actor, "email">> {
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
  return { ...actor, email };
}

/** Superuser read, around RLS: the test is counting what was written, by anybody. */
async function sql<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const r = await running.container.db.pool.query(query, params);
  return r.rows as T[];
}

/** Every live session of this actor's user: auth time `ageMs` ago (step-up freshness). */
async function markFresh(actor: Actor, ageMs = 0): Promise<void> {
  const n = await sql(
    `UPDATE core.session SET auth_time = now() - ($2::int * interval '1 millisecond')
      WHERE user_id = (SELECT user_id FROM core.membership WHERE id = $1::uuid)
        AND revoked_at IS NULL RETURNING id`,
    [actor.membershipId, ageMs],
  );
  expect(n.length).toBeGreaterThan(0);
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("timed out");
}

/** Row count of every application table (pg-boss and the migration ledger excluded). */
async function snapshot(): Promise<Map<string, number>> {
  const tables = await sql<{ t: string }>(
    `SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pgboss', 'drizzle')
        AND schemaname NOT LIKE 'pg_%'
      ORDER BY 1`,
  );
  const out = new Map<string, number>();
  for (const { t } of tables) {
    const [row] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
    out.set(t, row?.n ?? 0);
  }
  return out;
}

function diff(a: Map<string, number>, b: Map<string, number>): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const [t, n] of b) if (a.get(t) !== n) out[t] = [a.get(t) ?? 0, n];
  return out;
}

/** Runs a registered job's handler inline, the way the worker would. */
async function runJob(name: string): Promise<void> {
  const job = running.container.registry
    .resolveJobs(running.container.moduleServices)
    .find((j) => j.name === name);
  if (!job) throw new Error(`no job ${name}`);
  await job.handler({ id: `test-${name}`, name, data: {}, signal: new AbortController().signal });
}

/**
 * Folds every analytics event written so far into the rollups. `analytics.rollup` is a
 * five-minute cron: without this, the engagement earlier tests produced (as the investor herself)
 * is folded whenever the cron next fires — in the middle of the walk if the clock says so — and
 * the rollup tables move although the walk wrote nothing. Events inside the settle window are
 * skipped by the rollup, so wait until the newest one is past it.
 */
async function settleAnalytics(): Promise<void> {
  await runJob(JOB_FLUSH);
  const [row] = await sql<{ wait: number | null }>(
    `SELECT ceil(extract(epoch FROM max(occurred_at) - now()) * 1000)::int
            + ${(ROLLUP_SETTLE_SECONDS + 1) * 1000} AS wait
       FROM analytics.event`,
  );
  if (row?.wait && row.wait > 0) await new Promise((r) => setTimeout(r, row.wait as number));
  await runJob(JOB_ROLLUP);
}

/** Waits until the background (outbox relay, subscribers, jobs) has stopped writing. */
async function quiet(): Promise<Map<string, number>> {
  let last = await snapshot();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    const next = await snapshot();
    if (Object.keys(diff(last, next)).length === 0) return next;
    last = next;
  }
  throw new Error("the background never went quiet");
}

async function makePdf(pages: number, marker: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    doc
      .addPage([612, 792])
      .drawText(`${marker} page ${i} runway`, { x: 50, y: 700, size: 20, font });
  }
  return doc.save();
}

async function uploadPdf(actor: Actor, folderId: string, bytes: Uint8Array): Promise<string> {
  const start = await request("acme", "/api/v1/data-room/uploads", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify({
      fileName: "deck.pdf",
      size: bytes.byteLength,
      contentType: "application/pdf",
      folderId,
    }),
  });
  expect(start.status, await start.clone().text()).toBe(201);
  const started = await json<{ upload: { id: string }; tus: { path: string } | null }>(start);
  const endpoint = `/api/v1${started.tus?.path ?? ""}`;
  const meta = `upload ${Buffer.from(started.upload.id).toString("base64")},filename ${Buffer.from("deck.pdf").toString("base64")}`;
  const create = await request("acme", endpoint, {
    method: "POST",
    cookie: actor.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(bytes.byteLength),
      "Upload-Metadata": meta,
      "content-type": "application/offset+octet-stream",
    },
    body: new Uint8Array(0),
  });
  expect(create.status).toBe(201);
  const patch = await request("acme", `${endpoint}/${started.upload.id}`, {
    method: "PATCH",
    cookie: actor.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    body: bytes,
  });
  expect(patch.status).toBe(204);
  const complete = await request(
    "acme",
    `/api/v1/data-room/uploads/${started.upload.id}/complete`,
    { method: "POST", cookie: actor.cookie, body: JSON.stringify({}) },
  );
  expect(complete.status, await complete.clone().text()).toBe(200);
  return (await json<{ document: { id: string } }>(complete)).document.id;
}

interface ViewAsState {
  workspaceId: string;
  membershipId: string;
  name: string | null;
  startedAt: string;
  until: string;
}

async function startView(
  staff: Actor,
  target: Actor,
  slug = "acme",
  reason = "support ticket 42",
): Promise<Response> {
  return request(slug, `/api/v1/access/people/${target.membershipId}/view-as`, {
    method: "POST",
    cookie: staff.cookie,
    body: JSON.stringify({ reason }),
  });
}

async function bootstrap(actor: Actor, slug = "acme") {
  return json<{
    membership: { id: string; kind: string } | null;
    permissions: string[];
    viewAs: ViewAsState | null;
  }>(await request(slug, "/api/v1/modules", { cookie: actor.cookie }));
}

async function auditRows(action: string, workspaceId: string) {
  return sql<{
    actorKind: string;
    actorMembershipId: string | null;
    subjectMembershipId: string | null;
    meta: Record<string, unknown>;
  }>(
    `SELECT actor_kind AS "actorKind", actor_membership_id::text AS "actorMembershipId",
            subject_membership_id::text AS "subjectMembershipId", meta
       FROM audit.event WHERE action = $1 AND workspace_id = $2::uuid ORDER BY seq`,
    [action, workspaceId],
  );
}

let acmeId: string;
let globexId: string;
let owner: Actor;
let admin: Actor;
let editor: Actor;
let ada: Actor;
let bob: Actor;
let globexOwner: Actor;
let globexInvestor: Actor;
let docId = "";
let postId = "";
let postSlug = "";
let questionId = "";

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
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
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
  const db = running.container.db;
  acmeId = (await createWorkspace(db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(db, { slug: "globex", name: "Globex" })).id;
  // Every compiled-in module on, and an offering status that lets the round module run.
  for (const ws of [acmeId, globexId]) {
    const ctx = systemContext(ws);
    await db.withTenant(ctx, async (tx) => {
      for (const id of running.container.registry.ids)
        await new ModuleEnablementRepo(ctx, tx).set(id, true);
      await updateOfferingStatus(tx, ws, "506b" as never);
    });
    running.container.enablement.invalidate(ws);
  }
  running.container.resolver.invalidate();

  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  admin = await member("acme", acmeId, "admin@example.com", "staff", "admin");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  bob = await member("acme", acmeId, "bob@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@example.org", "staff", "owner");
  globexInvestor = await member("globex", globexId, "gia@investor.test", "external", "investor");
  // The acme owner is staff in globex too (one user, two workspaces) for the "replace" case.
  const ownerUser = await sql<{ id: string }>(
    "SELECT user_id::text AS id FROM core.membership WHERE id = $1::uuid",
    [owner.membershipId],
  );
  await provisionMembership(running.container.identityDeps, {
    workspaceId: globexId,
    userId: ownerUser[0]?.id ?? "",
    kind: "staff",
    role: "admin",
    source: "test",
  });
}, 300_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("seed: real investor-facing data", () => {
  it("a data-room document the investor may view", async () => {
    await markFresh(owner);
    const tree = await json<{ rootId: string }>(
      await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie }),
    );
    docId = await uploadPdf(owner, tree.rootId, await makePdf(2, "Deck"));
    await waitFor(async () => {
      const d = await json<{ currentVersion: { renderStatus: string } | null }>(
        await request("acme", `/api/v1/data-room/documents/${docId}`, { cookie: owner.cookie }),
      );
      return d.currentVersion && d.currentVersion.renderStatus !== "pending" ? true : undefined;
    });
    // The noop scanner leaves blobs unscanned; pages are served only once the workspace opts in.
    const settings = await request("acme", "/api/v1/data-room/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ allowUnscanned: true }),
    });
    expect(settings.status, await settings.clone().text()).toBe(200);
    const grant = await request("acme", "/api/v1/access/grants", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        subject: { kind: "membership", id: ada.membershipId },
        resource: { kind: "document", id: docId },
        capabilities: ["view", "download"],
      }),
    });
    expect(grant.status, await grant.clone().text()).toBe(200);
    await waitFor(async () => {
      const res = await request("acme", `/api/v1/data-room/documents/${docId}`, {
        cookie: ada.cookie,
      });
      return res.status === 200 ? true : undefined;
    });
  });

  it("a sent update", async () => {
    const created = await request("acme", "/api/v1/updates/posts", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ title: "September update", template: "yc" }),
    });
    expect(created.status).toBe(201);
    const d = await json<{ post: { id: string; slug: string } }>(created);
    postId = d.post.id;
    postSlug = d.post.slug;
    await markFresh(owner);
    const sent = await request("acme", `/api/v1/updates/posts/${postId}/send`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(sent.status, await sent.clone().text()).toBe(202);
    await waitFor(async () => {
      const p = await json<{ post: { state: string } }>(
        await request("acme", `/api/v1/updates/posts/${postId}`, { cookie: owner.cookie }),
      );
      return p.post.state === "sent" ? true : undefined;
    });
    const reply = await request("acme", `/api/v1/updates/posts/${postId}/replies`, {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ body: "Great month." }),
    });
    expect(reply.status, await reply.clone().text()).toBe(201);
  });

  it("a published content page", async () => {
    const pages = await json<{ pages: { id: string; slug: string }[] }>(
      await request("acme", "/api/v1/content/pages", { cookie: owner.cookie }),
    );
    const home = pages.pages.find((p) => p.slug === "home");
    expect(home).toBeDefined();
    await markFresh(owner);
    const published = await request("acme", `/api/v1/content/pages/${home?.id}/publish`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({}),
    });
    expect(published.status, await published.clone().text()).toBe(200);
  });

  it("a KPI with a value", async () => {
    const def = await request("acme", "/api/v1/metrics/definitions", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ key: "arr", name: "ARR", unit: "count", audience: { kind: "all" } }),
    });
    expect(def.status, await def.clone().text()).toBe(201);
    const { id } = await json<{ id: string }>(def);
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const grid = await request("acme", "/api/v1/metrics/grid", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({
        periodKind: "month",
        cells: [{ definitionId: id, periodKey: key, value: "1200" }],
      }),
    });
    expect(grid.status, await grid.clone().text()).toBe(200);
  });

  it("an open round with terms", async () => {
    const created = await request("acme", "/api/v1/round/rounds", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        name: "Seed 2026",
        stage: "seed",
        instrumentKind: "safe",
        targetAmount: "2000000",
        currency: "USD",
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const { id } = await json<{ id: string }>(created);
    await markFresh(owner);
    const terms = await request("acme", `/api/v1/round/rounds/${id}/terms`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({
        terms: {
          kind: "safe",
          variant: "post_money",
          valuationCap: "10000000",
          discountPercent: "20",
        },
      }),
    });
    expect(terms.status, await terms.clone().text()).toBe(201);
    const opened = await request("acme", `/api/v1/round/rounds/${id}/open`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(opened.status, await opened.clone().text()).toBe(200);
  });
});

describe("seed: data-room Q&A", () => {
  it("Q&A switched on and a question the investor asked on her document", async () => {
    const on = await request("acme", "/api/v1/data-room/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ qa: { enabled: true } }),
    });
    expect(on.status, await on.clone().text()).toBe(200);
    const asked = await request("acme", "/api/v1/data-room/qa/questions", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({
        targetKind: "document",
        targetId: docId,
        subject: "Runway assumptions",
        body: "How many months of runway does the deck assume?",
      }),
    });
    expect(asked.status, await asked.clone().text()).toBe(201);
    questionId = (await json<{ id: string }>(asked)).id;
    expect(questionId).not.toBe("");
  });
});

describe("who may start a view", () => {
  it("an editor gets 403, an investor 404, an unknown or staff target 404", async () => {
    expect((await startView(editor, ada)).status).toBe(403);
    expect((await startView(ada, bob)).status).toBe(404);
    await markFresh(owner);
    expect((await startView(owner, editor)).status).toBe(404);
    expect((await startView(owner, globexInvestor)).status).toBe(404);
  });

  it("needs a fresh step-up", async () => {
    await markFresh(owner, 11 * 60_000);
    const res = await startView(owner, ada);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("step_up_required");
  });

  it("refuses a missing or too-short reason", async () => {
    await markFresh(owner);
    expect((await startView(owner, ada, "acme", "x")).status).toBe(400);
  });
});

/** Investor-facing reads, from the contract itself. */
async function investorReads(): Promise<string[]> {
  const doc = await json<{
    paths: Record<string, Record<string, { "x-requires"?: string }>>;
  }>(await request("acme", "/api/v1/openapi.json"));
  const out: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    const get = ops["get"];
    if (get?.["x-requires"] === "member") out.push(path);
  }
  // The shell and the pages every portal visit starts with.
  out.push("/modules", "/me", "/me/view-as", "/content/render/{slug}");
  return out;
}

/** Reads that are downloads: refused under view-as. */
const DOWNLOADS = new Set([
  "/data-room/documents/{id}/download",
  "/compliance/acceptances/{membershipId}/certificate",
  "/esign/me/envelopes/{id}/signed.pdf",
]);

/**
 * Reads whose honest answer here is 404: the cap table is an optional module (E3.6) that this
 * workspace never enables, and `/captable/me` answers 404 rather than an empty 200 by design; the
 * accreditation hand-off page (E3.7) exists only while the investor has a pending vendor widget.
 */
const NOT_FOUND_OK = new Set(["/captable/me", "/round/current/verification/handoff"]);

function concrete(path: string): string {
  const fill: Record<string, string> = {
    "/content/render/{slug}": "/content/render/home",
    "/updates/archive/{slug}": `/updates/archive/${postSlug}`,
    "/updates/posts/{id}/replies": `/updates/posts/${postId}/replies`,
    "/data-room/documents/{id}/search": `/data-room/documents/${docId}/search?q=runway`,
    "/data-room/documents/{id}/pages/{n}": `/data-room/documents/${docId}/pages/1`,
    "/data-room/documents/{id}/pages/{n}/text": `/data-room/documents/${docId}/pages/1/text`,
    "/search": "/search?q=runway",
    "/compliance/acceptances/{membershipId}/certificate": `/compliance/acceptances/${ada.membershipId}/certificate?stamp=nda`,
    "/round/current/calculate": "/round/current/calculate?amount=50000",
    "/round/current/eligibility": "/round/current/eligibility?amount=50000&subject=individual",
    "/data-room/qa/questions": "/data-room/qa/questions?scope=mine",
    "/data-room/qa/questions/{id}": `/data-room/qa/questions/${questionId}`,
    // E3.5: no envelope exists here; the download is refused before any lookup under view-as.
    "/esign/me/envelopes/{id}/signed.pdf":
      "/esign/me/envelopes/00000000-0000-7000-8000-000000000000/signed.pdf",
    "/esign/nda/status": "/esign/nda/status?documentId=00000000-0000-7000-8000-000000000000",
  };
  const filled =
    fill[path] ?? path.replace("/data-room/documents/{id}", `/data-room/documents/${docId}`);
  if (filled.includes("{")) throw new Error(`no fixture for ${path}`);
  return `/api/v1${filled}`;
}

describe("the walk: every investor-facing read, as the investor, writes nothing", () => {
  let paths: string[] = [];

  it("the contract lists the investor surface", async () => {
    paths = await investorReads();
    // A shrinking list would make the walk vacuous.
    expect(paths.length).toBeGreaterThanOrEqual(20);
    for (const p of [
      "/data-room/tree",
      "/updates/archive/{slug}",
      "/round/current",
      "/metrics/series",
      "/access/my",
      "/data-room/qa/status",
      "/data-room/qa/questions",
      "/data-room/qa/questions/{id}",
    ]) {
      expect(paths).toContain(p);
    }
  });

  it("warms every read as staff and as the investor herself (caches, lazily created keys)", async () => {
    for (const actor of [owner, ada]) {
      for (const p of paths) {
        if (DOWNLOADS.has(p)) continue;
        const res = await request("acme", concrete(p), { cookie: actor.cookie });
        expect(res.status, `${p} as ${actor.email}`).toBeLessThan(500);
      }
    }
  }, 120_000);

  it("starts a view: 200 with the state, bootstrap and /me carry it", async () => {
    await markFresh(owner);
    const res = await startView(owner, ada);
    expect(res.status, await res.clone().text()).toBe(200);
    const { viewAs } = await json<{ viewAs: ViewAsState }>(res);
    expect(viewAs).toMatchObject({
      workspaceId: acmeId,
      membershipId: ada.membershipId,
      name: "ada",
    });
    const until = new Date(viewAs.until).getTime() - new Date(viewAs.startedAt).getTime();
    expect(until).toBe(30 * 60_000);

    const boot = await bootstrap(owner);
    expect(boot.membership).toMatchObject({ id: ada.membershipId, kind: "external" });
    expect(boot.permissions).toEqual([]);
    expect(boot.viewAs?.membershipId).toBe(ada.membershipId);
    const me = await json<{ membership: { id: string }; viewAs: ViewAsState | null }>(
      await request("acme", "/api/v1/me", { cookie: owner.cookie }),
    );
    expect(me.membership.id).toBe(ada.membershipId);
    expect(me.viewAs?.membershipId).toBe(ada.membershipId);
    // The investor's own session is untouched.
    expect((await bootstrap(ada)).viewAs).toBeNull();
  });

  it("walks every read: no 5xx, only downloads refused, no row written anywhere", async () => {
    const exposureBefore = await sql<{ at: string | null }>(
      "SELECT first_exposure_at::text AS at FROM core.membership WHERE id = $1::uuid",
      [ada.membershipId],
    );
    await settleAnalytics();
    const before = await quiet();
    expect(before.get("audit.event") ?? 0).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const p of paths) {
      // Sec-GPC too: the staff member's browser signal must not become the investor's refusal.
      const res = await request("acme", concrete(p), {
        cookie: owner.cookie,
        headers: { "sec-gpc": "1" },
      });
      const code = await codeOf(res);
      if (res.status >= 500) problems.push(`${p}: ${res.status} ${await res.text()}`);
      else if (DOWNLOADS.has(p)) {
        if (res.status !== 403 || code !== "view_as_read_only")
          problems.push(`${p}: download answered ${res.status} ${code}`);
      } else if (res.status !== 200 && !(res.status === 404 && NOT_FOUND_OK.has(p))) {
        problems.push(`${p}: ${res.status} ${await res.text()}`);
      }
    }
    expect(problems).toEqual([]);
    // Let the outbox relay and every subscriber run before counting again.
    await new Promise((r) => setTimeout(r, 2_000));
    const after = await quiet();
    expect(diff(before, after)).toEqual({});
    const exposureAfter = await sql<{ at: string | null }>(
      "SELECT first_exposure_at::text AS at FROM core.membership WHERE id = $1::uuid",
      [ada.membershipId],
    );
    expect(exposureAfter).toEqual(exposureBefore);
  }, 180_000);

  it("a mutating request is 403 view_as_read_only; the database refuses too", async () => {
    for (const [method, path, body] of [
      ["POST", `/api/v1/data-room/documents/${docId}/viewed`, undefined],
      ["POST", `/api/v1/updates/posts/${postId}/replies`, { body: "as ada?" }],
      ["PUT", "/api/v1/updates/subscription", { subscribed: false }],
      ["POST", "/api/v1/compliance/consent", { purpose: "analytics", granted: true }],
      ["POST", "/api/v1/analytics/events", { events: [] }],
    ] as const) {
      const res = await request("acme", path, {
        method,
        cookie: owner.cookie,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await codeOf(res)).toBe("view_as_read_only");
    }
    // The DB backstop, independent of the gate: a write in a view-as transaction is refused.
    const ctx = {
      workspaceId: acmeId,
      actorKind: "external" as const,
      membershipId: ada.membershipId,
      viewAs: { staffMembershipId: owner.membershipId, staffUserId: ada.membershipId },
    };
    const refusal = await running.container.db
      .withTenant(ctx, (tx) =>
        tx.execute(`UPDATE core.membership SET profile = profile WHERE id = '${ada.membershipId}'`),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(JSON.stringify(refusal, Object.getOwnPropertyNames(refusal ?? {}))).toMatch(
      /read-only transaction|25006/u,
    );
  });

  it("DELETE /me/view-as leaves the view, idempotently, and audits start and end", async () => {
    const res = await request("acme", "/api/v1/me/view-as", {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(204);
    expect(
      (await request("acme", "/api/v1/me/view-as", { method: "DELETE", cookie: owner.cookie }))
        .status,
    ).toBe(204);
    const boot = await bootstrap(owner);
    expect(boot.membership?.id).toBe(owner.membershipId);
    expect(boot.viewAs).toBeNull();

    const started = await auditRows("access.view_as_started", acmeId);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      actorKind: "staff",
      actorMembershipId: owner.membershipId,
      subjectMembershipId: ada.membershipId,
    });
    expect(started[0]?.meta).toMatchObject({ reason: "support ticket 42", reasonLength: 17 });
    const ended = await auditRows("access.view_as_ended", acmeId);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      actorKind: "staff",
      actorMembershipId: owner.membershipId,
      subjectMembershipId: ada.membershipId,
      meta: { reason: "exited" },
    });
  });
});

describe("the view ends by itself", () => {
  it("after 30 minutes: served as staff again, audited once as expired", async () => {
    await markFresh(owner);
    expect((await startView(owner, ada)).status).toBe(200);
    await sql(
      `UPDATE core.session SET view_as_until = now() - interval '1 second',
              view_as_started_at = now() - interval '31 minutes'
        WHERE view_as_membership_id = $1::uuid`,
      [ada.membershipId],
    );
    const [a, b] = await Promise.all([bootstrap(owner), bootstrap(owner)]);
    expect(a.membership?.id).toBe(owner.membershipId);
    expect(b.viewAs).toBeNull();
    const ended = await auditRows("access.view_as_ended", acmeId);
    expect(ended.filter((e) => e.meta["reason"] === "expired")).toHaveLength(1);
    const left = await sql("SELECT id FROM core.session WHERE view_as_membership_id IS NOT NULL");
    expect(left).toEqual([]);
  });

  it("when the staff member is demoted: falls back to staff, audited", async () => {
    await markFresh(admin);
    expect((await startView(admin, bob)).status).toBe(200);
    expect((await bootstrap(admin)).membership?.id).toBe(bob.membershipId);
    await markFresh(owner);
    const demoted = await request("acme", `/api/v1/access/people/${admin.membershipId}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ role: "editor" }),
    });
    expect(demoted.status, await demoted.clone().text()).toBe(200);
    const boot = await bootstrap(admin);
    expect(boot.membership?.id).toBe(admin.membershipId);
    expect(boot.viewAs).toBeNull();
    const ended = await auditRows("access.view_as_ended", acmeId);
    expect(ended.at(-1)).toMatchObject({
      subjectMembershipId: bob.membershipId,
      meta: { reason: "staff_unauthorized" },
    });
    // And a POST goes through as the (now editor) staff member again: no view is applied.
    const res = await request("acme", "/api/v1/me/view-as", { cookie: admin.cookie });
    expect(await json(res)).toEqual({ viewAs: null });
  });

  it("when the investor is revoked", async () => {
    await markFresh(owner);
    expect((await startView(owner, bob)).status).toBe(200);
    expect((await bootstrap(owner)).membership?.id).toBe(bob.membershipId);
    await sql(
      `UPDATE core.membership SET status = 'revoked', revoked_at = now(), revoke_reason = 'test'
        WHERE id = $1::uuid`,
      [bob.membershipId],
    );
    const boot = await bootstrap(owner);
    expect(boot.membership?.id).toBe(owner.membershipId);
    expect(boot.viewAs).toBeNull();
    const ended = await auditRows("access.view_as_ended", acmeId);
    expect(ended.at(-1)).toMatchObject({
      subjectMembershipId: bob.membershipId,
      meta: { reason: "target_unavailable" },
    });
  });
});

describe("one view per session", () => {
  it("starting one in another workspace replaces it (end audited in the first)", async () => {
    await markFresh(owner);
    expect((await startView(owner, ada)).status).toBe(200);
    // In globex the acme view does not apply: the owner is plain staff there and may start one.
    const res = await startView(owner, globexInvestor, "globex");
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await bootstrap(owner, "globex")).membership?.id).toBe(globexInvestor.membershipId);
    // Back in acme: no view any more.
    expect((await bootstrap(owner)).membership?.id).toBe(owner.membershipId);
    const ended = await auditRows("access.view_as_ended", acmeId);
    expect(ended.at(-1)).toMatchObject({
      actorMembershipId: owner.membershipId,
      subjectMembershipId: ada.membershipId,
      meta: { reason: "replaced" },
    });
    const started = await auditRows("access.view_as_started", globexId);
    expect(started.at(-1)).toMatchObject({
      actorKind: "staff",
      subjectMembershipId: globexInvestor.membershipId,
    });
  });

  it("logout still works under a view, and ends it", async () => {
    const res = await request("globex", "/api/v1/auth/logout", {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBeLessThan(300);
    const ended = await auditRows("access.view_as_ended", globexId);
    expect(ended.at(-1)?.meta).toEqual({ reason: "logout" });
    expect(globexOwner.membershipId).not.toBe("");
  });
});
