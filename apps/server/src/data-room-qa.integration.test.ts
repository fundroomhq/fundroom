import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext, type TenantContext } from "@fundroom/db";
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
 * Data-room Q&A end to end (E3.3 D2/D6, ADR-0051): the switch, asking against documents and
 * folders (viewable / gated / not viewable / delegates / staff), per-asker thread visibility
 * through the API *and* through RLS directly, the budgets, the full staff workflow with four-eyes
 * approval, the inbox's counts, filters and keyset pagination, the settings PATCH merge, and a
 * one-connection pool run (authz checks never nest inside a transaction).
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let secretKey: string;
let storagePath: string;

interface Actor {
  cookie: string;
  membershipId: string;
  userId: string;
}

type Server = Pick<RunningServer, "app">;

async function request(
  path: string,
  init: RequestInit & { cookie?: string; server?: Server } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", `acme.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://acme.${CANON}`);
  return (init.server ?? running).app.request(`http://acme.${CANON}${path}`, {
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
  const body = await json<{ session: { userId: string }; membership: { id: string } | null }>(
    verify,
  );
  return {
    cookie: cookiesOf(verify),
    membershipId: body.membership?.id ?? "",
    userId: body.session.userId,
  };
}

async function stepUpToMfa(cookie: string): Promise<string> {
  const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie });
  expect(enrol.status).toBe(200);
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
  name: string,
  kind: "staff" | "external",
  role: "owner" | "legal" | "editor" | "viewer" | "investor",
): Promise<Actor> {
  const email = `${name}@${kind === "staff" ? "acme.test" : "fund.test"}`;
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: name });
  await provisionMembership(deps, {
    workspaceId: acmeId,
    userId: user.userId,
    kind,
    role,
    source: "test",
  });
  const actor = await signIn(email);
  if (role === "owner") actor.cookie = await stepUpToMfa(actor.cookie);
  return actor;
}

async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  return running.container.db.withTenant(
    systemContext(acmeId),
    async (tx) => (await tx.execute(query)).rows as T[],
  );
}

/** Raw SQL setup does not bump the ACL version; a service would. */
async function bump(): Promise<void> {
  await sql(`UPDATE core.workspace SET acl_version = acl_version + 1 WHERE id = '${acmeId}'`);
  running.container.authz.invalidate(acmeId);
}

/** Reads as the member would, under their own RLS context (not the superuser pool). */
async function asMember<T = Record<string, unknown>>(a: Actor, query: string): Promise<T[]> {
  const ctx: TenantContext = {
    workspaceId: acmeId,
    actorKind: "external",
    membershipId: a.membershipId,
    userId: a.userId,
  };
  return running.container.db.withTenant(ctx, async (tx) => (await tx.execute(query)).rows as T[]);
}

async function rlsQuestionIds(a: Actor): Promise<string[]> {
  return (await asMember<{ id: string }>(a, "SELECT id FROM dataroom.qa_question ORDER BY id"))
    .map((r) => r.id)
    .sort();
}

async function rlsAnswerQuestionIds(a: Actor): Promise<string[]> {
  return (
    await asMember<{ question_id: string }>(
      a,
      "SELECT question_id FROM dataroom.qa_answer ORDER BY question_id",
    )
  )
    .map((r) => r.question_id)
    .sort();
}

interface View {
  id: string;
  targetKind: string;
  targetId: string;
  targetTitle: string;
  mine: boolean;
  status: string;
  subject: string | null;
  body: string | null;
  publicText: string | null;
  answer: { body: string; releasedAt: string } | null;
  createdAt: string | null;
  publishedAt: string | null;
  releasedAt: string | null;
  visibility: string | null;
}

interface Detail {
  id: string;
  source: string;
  status: string;
  asker: { membershipId: string; displayName: string; email: string } | null;
  target: { kind: string; id: string; title: string; path: string | null; deleted: boolean };
  assignee: { membershipId: string; displayName: string } | null;
  subject: string;
  publicText: string | null;
  category: string | null;
  internalNote: string | null;
  visibility: string | null;
  dueAt: string | null;
  sla: string;
  answer: {
    body: string;
    author: { membershipId: string } | null;
    submittedAt: string | null;
    approvedBy: { membershipId: string } | null;
    approvedAt: string | null;
    approvalCurrent: boolean;
    rejectedNote: string | null;
  } | null;
  closedReason: string | null;
}

interface InboxPage {
  items: {
    id: string;
    subject: string;
    status: string;
    askerName: string | null;
    assigneeName: string | null;
    hasDraft: boolean;
    sla: string;
    target: { kind: string; id: string; title: string };
  }[];
  nextCursor: string | null;
  counts: Record<string, number>;
}

interface ApiErr {
  error: { code: string; message: string; reason?: string; pendingGates?: { kind: string }[] };
}

function ask(a: Actor, targetKind: "document" | "folder", targetId: string, subject: string) {
  return request("/api/v1/data-room/qa/questions", {
    method: "POST",
    cookie: a.cookie,
    body: JSON.stringify({ targetKind, targetId, subject, body: `${subject} — details please` }),
  });
}

async function asked(a: Actor, kind: "document" | "folder", id: string, subject: string) {
  const res = await ask(a, kind, id, subject);
  expect(res.status).toBe(201);
  return json<View>(res);
}

function getQ(a: Actor, id: string) {
  return request(`/api/v1/data-room/qa/questions/${id}`, { cookie: a.cookie });
}

async function onTarget(a: Actor, kind: string, id: string): Promise<View[]> {
  const res = await request(
    `/api/v1/data-room/qa/questions?scope=target&targetKind=${kind}&targetId=${id}`,
    { cookie: a.cookie },
  );
  expect(res.status).toBe(200);
  return (await json<{ items: View[] }>(res)).items;
}

async function mine(a: Actor): Promise<View[]> {
  const res = await request("/api/v1/data-room/qa/questions?scope=mine", { cookie: a.cookie });
  expect(res.status).toBe(200);
  return (await json<{ items: View[] }>(res)).items;
}

function staff(a: Actor, method: string, path: string, body?: unknown) {
  return request(`/api/v1/data-room/qa/inbox${path}`, {
    method,
    cookie: a.cookie,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function staffOk(a: Actor, method: string, path: string, body?: unknown): Promise<Detail> {
  const res = await staff(a, method, path, body);
  if (res.status !== 200 && res.status !== 201)
    throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return json<Detail>(res);
}

async function expectError(res: Response, status: number, code: string, reason?: string) {
  const text = await res.text();
  expect({ status: res.status, text }).toMatchObject({ status });
  const body = JSON.parse(text) as ApiErr;
  expect(body.error.code).toBe(code);
  if (reason !== undefined) expect(body.error.reason).toBe(reason);
  return body;
}

interface SettingsBody {
  qa: Record<string, unknown>;
  [key: string]: unknown;
}

async function patchSettings(body: Record<string, unknown>): Promise<SettingsBody> {
  const res = await request("/api/v1/data-room/settings", {
    method: "PATCH",
    cookie: owner.cookie,
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`settings: ${res.status} ${await res.text()}`);
  return json(res);
}

async function outboxCount(topic: string, questionId?: string): Promise<number> {
  const r = await pg.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM core.outbox WHERE workspace_id = $1 AND topic = $2
       AND ($3::text IS NULL OR payload->>'questionId' = $3)`,
    [acmeId, topic, questionId ?? null],
  );
  return r.rows[0]?.n ?? 0;
}

async function outboxPayloads(topic: string, questionId: string): Promise<unknown[]> {
  const r = await pg.pool.query<{ payload: unknown }>(
    `SELECT payload FROM core.outbox WHERE workspace_id = $1 AND topic = $2
       AND payload->>'questionId' = $3 ORDER BY id`,
    [acmeId, topic, questionId],
  );
  return r.rows.map((x) => x.payload);
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function auditCount(action: string, questionId: string): Promise<number> {
  const r = await pg.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = $1 AND action = $2 AND resource_id = $3`,
    [acmeId, action, questionId],
  );
  return r.rows[0]?.n ?? 0;
}

let acmeId: string;
let owner: Actor;
let legal: Actor;
let editor: Actor;
let viewer: Actor;
let ana: Actor; // asks; principal of dan
let bob: Actor; // another bidder on the same folder
let carl: Actor; // no access
let gina: Actor; // gated (NDA pending)
let rita: Actor; // budgets
let dan: Actor; // ana's data_room delegate
const F1 = { id: randomUUID(), path: "root.f1", name: "Financials" };
const F2 = { id: randomUUID(), path: "root.f2", name: "Legal" };
const F3 = { id: randomUUID(), path: "root.f3", name: "Board" };
const GF = { id: randomUUID(), path: "root.gf", name: "Gated" };
const DOC1 = { id: randomUUID(), folder: F1, title: "Model" };
const DOC_T = { id: randomUUID(), folder: F1, title: "Trashable" };
const DOC2 = { id: randomUUID(), folder: F2, title: "Contracts" };
const DOC_B = { id: randomUUID(), folder: F3, title: "Minutes" };
const DOC_G = { id: randomUUID(), folder: GF, title: "Secret" };
let biddersId: string;
let gatedId: string;

async function seed(): Promise<void> {
  await sql(`INSERT INTO dataroom.folder (workspace_id, name, path)
             VALUES ('${acmeId}', 'Root', 'root') ON CONFLICT DO NOTHING`);
  for (const f of [F1, F2, F3, GF]) {
    await sql(`INSERT INTO dataroom.folder (id, workspace_id, parent_id, name, path)
               SELECT '${f.id}', '${acmeId}', p.id, '${f.name}', '${f.path}' FROM dataroom.folder p
                WHERE p.workspace_id = '${acmeId}' AND p.parent_id IS NULL LIMIT 1`);
  }
  for (const d of [DOC1, DOC_T, DOC2, DOC_B, DOC_G]) {
    await sql(`INSERT INTO dataroom.document (id, workspace_id, folder_id, folder_path, title)
               VALUES ('${d.id}', '${acmeId}', '${d.folder.id}', '${d.folder.path}', '${d.title}')`);
  }
  const groups = await sql<{ id: string; name: string }>(
    `INSERT INTO core."group" (workspace_id, name) VALUES ('${acmeId}', 'Bidders'), ('${acmeId}', 'Gated') RETURNING id, name`,
  );
  biddersId = groups.find((g) => g.name === "Bidders")?.id as string;
  gatedId = groups.find((g) => g.name === "Gated")?.id as string;
  for (const m of [ana, bob, rita])
    await sql(`INSERT INTO core.group_member (workspace_id, group_id, membership_id)
               VALUES ('${acmeId}', '${biddersId}', '${m.membershipId}')`);
  await sql(`INSERT INTO core.group_member (workspace_id, group_id, membership_id)
             VALUES ('${acmeId}', '${gatedId}', '${gina.membershipId}')`);
  const grants = [
    ["group", biddersId, F1],
    ["membership", ana.membershipId, F3],
    ["membership", bob.membershipId, F3],
    ["group", gatedId, GF],
  ] as const;
  for (const [kind, id, r] of grants) {
    await sql(`INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, resource_kind, resource_id, resource_path, capability)
               VALUES ('${acmeId}', '${kind}', '${id}', 'folder', '${r.id}', '${r.path}', 'view')`);
  }
  await sql(`INSERT INTO core.access_policy (workspace_id, target_kind, target_id, kind, config)
             VALUES ('${acmeId}', 'group', '${gatedId}', 'nda', '{"version": "v1"}')`);
  await bump();
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
      ...extra,
    },
  });
}

beforeAll(async () => {
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
  owner = await member("owner", "staff", "owner");
  legal = await member("legal", "staff", "legal");
  editor = await member("editor", "staff", "editor");
  viewer = await member("viewer", "staff", "viewer");
  ana = await member("ana", "external", "investor");
  bob = await member("bob", "external", "investor");
  carl = await member("carl", "external", "investor");
  gina = await member("gina", "external", "investor");
  rita = await member("rita", "external", "investor");
  await seed();
  // ana's data-room delegate (E3.2)
  const allow = await request("/api/v1/access/settings", {
    method: "PATCH",
    cookie: owner.cookie,
    body: JSON.stringify({ allowDelegates: true }),
  });
  expect(allow.status).toBe(200);
  const add = await request("/api/v1/access/my/delegates", {
    method: "POST",
    cookie: ana.cookie,
    body: JSON.stringify({ email: "dan@helper.test", scope: "data_room", displayName: "dan" }),
  });
  expect(add.status).toBe(202);
  dan = await signIn("dan@helper.test");
  expect(dan.membershipId).not.toBe("");
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

// Question ids shared across the ordered describes below.
let q1: string; // ana on DOC1 — the main flow
let qFolder: string; // ana on F1

describe("switched off (the default)", () => {
  it("investor routes answer 404 except status; the staff inbox works regardless", async () => {
    const status = await json(await request("/api/v1/data-room/qa/status", { cookie: ana.cookie }));
    expect(status).toEqual({ enabled: false, canAsk: false, allowFolderQuestions: true });
    expect((await request("/api/v1/data-room/qa/questions", { cookie: ana.cookie })).status).toBe(
      404,
    );
    expect((await ask(ana, "document", DOC1.id, "Revenue?")).status).toBe(404);
    expect((await getQ(ana, randomUUID())).status).toBe(404);
    expect(
      (
        await request(`/api/v1/data-room/qa/questions/${randomUUID()}/withdraw`, {
          method: "POST",
          cookie: ana.cookie,
        })
      ).status,
    ).toBe(404);
    const inbox = await staff(owner, "GET", "");
    expect(inbox.status).toBe(200);
    expect((await json<InboxPage>(inbox)).counts).toEqual({
      open: 0,
      assigned: 0,
      awaiting_approval: 0,
      answered: 0,
      published: 0,
      closed: 0,
    });
  });
});

describe("settings", () => {
  it("PATCH merges `qa` into the data-room block without clobbering other keys", async () => {
    const before = await json<SettingsBody>(
      await request("/api/v1/data-room/settings", { cookie: viewer.cookie }),
    );
    expect(before.qa).toEqual({
      enabled: false,
      requireApproval: false,
      slaHours: 72,
      reminderLeadHours: 24,
      defaultVisibility: "asker",
      allowFolderQuestions: true,
      maxOpenPerAsker: 25,
    });
    const a = await patchSettings({ purgeAfterDays: 45, qa: { enabled: true } });
    expect(a).toMatchObject({ purgeAfterDays: 45, watermarkByDefault: true });
    expect(a.qa).toMatchObject({ enabled: true, slaHours: 72 });
    const b = await patchSettings({ watermarkByDefault: false });
    expect(b.qa).toMatchObject({ enabled: true });
    const c = await patchSettings({ qa: { slaHours: 48 } });
    expect(c).toMatchObject({ purgeAfterDays: 45, watermarkByDefault: false });
    expect(c.qa).toMatchObject({ enabled: true, slaHours: 48, maxOpenPerAsker: 25 });
    const raw = await pg.pool.query<{ s: { dataRoom: Record<string, unknown> } }>(
      "SELECT settings AS s FROM core.workspace WHERE id = $1",
      [acmeId],
    );
    expect(raw.rows[0]?.s.dataRoom).toMatchObject({
      purgeAfterDays: 45,
      watermarkByDefault: false,
      qa: { enabled: true, slaHours: 48 },
    });
    const bad = await request("/api/v1/data-room/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ qa: { slaHours: 0 } }),
    });
    expect(bad.status).toBe(400);
  });

  it("two concurrent PATCHes of different keys both land (lock, re-read, merge)", async () => {
    await Promise.all([
      patchSettings({ qa: { reminderLeadHours: 12 } }),
      patchSettings({ purgeAfterDays: 60 }),
      patchSettings({ qa: { defaultVisibility: "target" } }),
    ]);
    const now = await json<SettingsBody>(
      await request("/api/v1/data-room/settings", { cookie: owner.cookie }),
    );
    expect(now).toMatchObject({ purgeAfterDays: 60, watermarkByDefault: false });
    expect(now.qa).toMatchObject({
      enabled: true,
      slaHours: 48,
      reminderLeadHours: 12,
      defaultVisibility: "target",
    });
  });

  it("status says who may ask", async () => {
    const s = async (a: Actor) =>
      json(await request("/api/v1/data-room/qa/status", { cookie: a.cookie }));
    expect(await s(ana)).toEqual({ enabled: true, canAsk: true, allowFolderQuestions: true });
    expect(await s(dan)).toMatchObject({ enabled: true, canAsk: false });
    expect(await s(owner)).toMatchObject({ enabled: true, canAsk: false });
  });
});

describe("asking", () => {
  it("asks on a document and on a folder the investor can view; the SLA clock starts at ask", async () => {
    const v = await asked(ana, "document", DOC1.id, "Is the model audited?");
    q1 = v.id;
    expect(v).toMatchObject({
      targetKind: "document",
      targetId: DOC1.id,
      targetTitle: "Model",
      mine: true,
      status: "open",
      subject: "Is the model audited?",
      body: "Is the model audited? — details please",
      publicText: null,
      answer: null,
      visibility: null,
    });
    const f = await asked(ana, "folder", F1.id, "What is missing from Financials?");
    qFolder = f.id;
    expect(f).toMatchObject({ targetKind: "folder", targetId: F1.id, targetTitle: "Financials" });
    const rows = await sql<{ hours: number; source: string; created_by: string }>(
      `SELECT (extract(epoch FROM due_at - created_at) / 3600)::int AS hours, source, created_by
         FROM dataroom.qa_question WHERE id = '${q1}'`,
    );
    expect(rows[0]).toEqual({ hours: 48, source: "portal", created_by: ana.membershipId });
    expect(await auditCount("qa.question_asked", q1)).toBe(1);
    expect(await outboxCount("qa.question_asked", q1)).toBe(1);
  });

  it("refuses folder questions while they are turned off", async () => {
    await patchSettings({ qa: { allowFolderQuestions: false } });
    await expectError(
      await ask(ana, "folder", F1.id, "Folder?"),
      400,
      "validation_failed",
      "folder_questions_disabled",
    );
    await patchSettings({ qa: { allowFolderQuestions: true } });
  });

  it("answers 404 alike for a target that is not viewable, unknown or binned", async () => {
    const hidden = await expectError(await ask(carl, "document", DOC1.id, "Hi"), 404, "not_found");
    const unknown = await expectError(
      await ask(carl, "document", randomUUID(), "Hi"),
      404,
      "not_found",
    );
    const { requestId: _a, ...h } = hidden.error as ApiErr["error"] & { requestId?: string };
    const { requestId: _b, ...u } = unknown.error as ApiErr["error"] & { requestId?: string };
    expect(h).toEqual(u);
    await expectError(await ask(ana, "document", DOC2.id, "Hi"), 404, "not_found");
    await expectError(await ask(ana, "folder", F2.id, "Hi"), 404, "not_found");
  });

  it("answers 403 with the pending gates for a gated target", async () => {
    const err = await expectError(
      await ask(gina, "document", DOC_G.id, "Can I see it?"),
      403,
      "forbidden",
    );
    expect(err.error.pendingGates?.map((g) => g.kind)).toEqual(["nda"]);
  });

  it("refuses delegates and staff", async () => {
    await expectError(
      await ask(dan, "document", DOC1.id, "For my principal"),
      403,
      "forbidden",
      "delegate_read_only",
    );
    await expectError(
      await ask(owner, "document", DOC1.id, "Staff"),
      403,
      "forbidden",
      "not_an_investor",
    );
  });
});

describe("thread visibility before release", () => {
  it("another bidder, the delegate and staff (on the investor routes) see nothing of it", async () => {
    expect(await onTarget(bob, "document", DOC1.id)).toEqual([]);
    expect(await mine(bob)).toEqual([]);
    expect((await getQ(bob, q1)).status).toBe(404);
    // the delegate does not see its principal's private questions
    expect(await onTarget(dan, "document", DOC1.id)).toEqual([]);
    expect(await mine(dan)).toEqual([]);
    expect((await getQ(dan, q1)).status).toBe(404);
    // staff get the investor-shaped view of their own questions (none) on these routes
    expect((await getQ(owner, q1)).status).toBe(404);
    expect(await onTarget(owner, "document", DOC1.id)).toEqual([]);
    // the asker sees both
    expect((await mine(ana)).map((v) => v.id).sort()).toEqual([q1, qFolder].sort());
    expect((await onTarget(ana, "document", DOC1.id)).map((v) => v.id)).toEqual([q1]);
    expect((await json<View>(await getQ(ana, q1))).mine).toBe(true);
  });

  it("RLS: an external context reads only its own questions", async () => {
    expect(await rlsQuestionIds(bob)).toEqual([]);
    expect(await rlsQuestionIds(dan)).toEqual([]);
    expect(await rlsQuestionIds(carl)).toEqual([]);
    expect(await rlsQuestionIds(ana)).toEqual([q1, qFolder].sort());
  });
});

describe("the staff workflow", () => {
  it("the inbox lists the question with its asker; assign validates the assignee", async () => {
    const inbox = await json<InboxPage>(await staff(owner, "GET", ""));
    expect(inbox.counts["open"]).toBe(2);
    expect(inbox.items.find((i) => i.id === q1)).toMatchObject({
      subject: "Is the model audited?",
      askerName: "ana",
      assigneeName: null,
      status: "open",
      hasDraft: false,
      sla: "on_track",
      target: { kind: "document", id: DOC1.id, title: "Model" },
    });
    await expectError(
      await staff(owner, "POST", `/${q1}/assign`, { assigneeMembershipId: bob.membershipId }),
      400,
      "validation_failed",
      "invalid_assignee",
    );
    await expectError(
      await staff(owner, "POST", `/${q1}/assign`, { assigneeMembershipId: viewer.membershipId }),
      400,
      "validation_failed",
      "invalid_assignee",
    );
    await expectError(
      await staff(owner, "POST", `/${q1}/assign`, { assigneeMembershipId: randomUUID() }),
      400,
      "validation_failed",
      "invalid_assignee",
    );
    const d = await staffOk(owner, "POST", `/${q1}/assign`, {
      assigneeMembershipId: editor.membershipId,
    });
    expect(d).toMatchObject({
      status: "assigned",
      assignee: { membershipId: editor.membershipId, displayName: "editor" },
      asker: { membershipId: ana.membershipId, displayName: "ana", email: "ana@fund.test" },
      target: { kind: "document", id: DOC1.id, title: "Model", path: "Financials", deleted: false },
    });
    expect(await outboxCount("qa.question_assigned", q1)).toBe(1);
    expect(await outboxPayloads("qa.question_assigned", q1)).toEqual([
      {
        questionId: q1,
        assigneeMembershipId: editor.membershipId,
        actorMembershipId: owner.membershipId,
      },
    ]);
    expect(await auditCount("qa.question_assigned", q1)).toBe(1);
    // unassign and back
    expect(
      (await staffOk(owner, "POST", `/${q1}/assign`, { assigneeMembershipId: null })).status,
    ).toBe("open");
    await staffOk(owner, "POST", `/${q1}/assign`, { assigneeMembershipId: editor.membershipId });
    expect(await outboxCount("qa.question_assigned", q1)).toBe(3);
  });

  it("a staff viewer reads the inbox but writes nothing; investors cannot reach it", async () => {
    expect((await staff(viewer, "GET", "")).status).toBe(200);
    expect((await staff(viewer, "GET", `/${q1}`)).status).toBe(200);
    expect((await staff(viewer, "PUT", `/${q1}/answer`, { body: "x" })).status).toBe(403);
    expect(
      (await staff(viewer, "POST", `/${q1}/assign`, { assigneeMembershipId: null })).status,
    ).toBe(403);
    expect((await staff(viewer, "POST", `/${q1}/release`, { visibility: "asker" })).status).toBe(
      403,
    );
    expect((await staff(viewer, "POST", `/${q1}/close`, { reason: "declined" })).status).toBe(403);
    expect((await staff(editor, "POST", `/${q1}/approve`)).status).toBe(403);
    expect((await staff(ana, "GET", "")).status).toBe(404);
    expect((await staff(ana, "GET", `/${q1}`)).status).toBe(404);
    expect((await staff(ana, "PUT", `/${q1}/answer`, { body: "x" })).status).toBe(404);
  });

  it("answers, releases to the asker only, then publishes to the target's audience", async () => {
    const drafted = await staffOk(editor, "PUT", `/${q1}/answer`, {
      body: "Yes — by Big Four, FY2025.",
    });
    expect(drafted.answer).toMatchObject({
      body: "Yes — by Big Four, FY2025.",
      author: { membershipId: editor.membershipId },
      approvalCurrent: false,
    });
    await expectError(
      await staff(editor, "POST", `/${q1}/submit`),
      409,
      "conflict",
      "approval_not_required",
    );
    // a draft is invisible to the asker
    expect((await json<View>(await getQ(ana, q1))).answer).toBeNull();
    expect(await rlsAnswerQuestionIds(ana)).toEqual([]);

    const toAsker = await staffOk(owner, "POST", `/${q1}/release`, { visibility: "asker" });
    expect(toAsker).toMatchObject({ status: "answered", visibility: "asker" });
    const anaView = await json<View>(await getQ(ana, q1));
    expect(anaView).toMatchObject({
      status: "answered",
      visibility: "asker",
      answer: { body: "Yes — by Big Four, FY2025." },
    });
    expect((await getQ(bob, q1)).status).toBe(404);
    expect(await rlsQuestionIds(bob)).toEqual([]);
    expect(await rlsAnswerQuestionIds(bob)).toEqual([]);
    expect(await rlsAnswerQuestionIds(ana)).toEqual([q1]);

    const pub = await staffOk(owner, "POST", `/${q1}/release`, {
      visibility: "target",
      publicText: "Has the financial model been audited?",
    });
    expect(pub).toMatchObject({ status: "published", visibility: "target" });
    expect(await outboxCount("qa.answer_released", q1)).toBe(2);
  });

  it("another bidder then sees the published wording and answer — never the asker's subject, body or identity", async () => {
    const res = await getQ(bob, q1);
    expect(res.status).toBe(200);
    const text = await res.text();
    const v = JSON.parse(text) as View;
    expect(v).toEqual({
      id: q1,
      targetKind: "document",
      targetId: DOC1.id,
      targetTitle: "Model",
      mine: false,
      status: "published",
      subject: null,
      body: null,
      publicText: "Has the financial model been audited?",
      answer: { body: "Yes — by Big Four, FY2025.", releasedAt: expect.any(String) },
      // S7: when a rival asked is not another bidder's business; when it was published is
      createdAt: null,
      publishedAt: expect.any(String),
      releasedAt: expect.any(String),
      visibility: "target",
    });
    const own = await json<View>(await getQ(ana, q1));
    expect(own.createdAt).toEqual(expect.any(String));
    expect(own.publishedAt).toBe(own.releasedAt);
    expect(text).not.toContain("Is the model audited?");
    expect(text).not.toContain("ana");
    expect(text).not.toContain(ana.membershipId);
    expect((await onTarget(bob, "document", DOC1.id)).map((x) => x.id)).toEqual([q1]);
    expect(await mine(bob)).toEqual([]);
    expect(await rlsQuestionIds(bob)).toEqual([q1]);
    expect(await rlsAnswerQuestionIds(bob)).toEqual([q1]);
    // the delegate sees the published answer on a target it can view, not the private folder one
    expect((await onTarget(dan, "document", DOC1.id)).map((x) => x.id)).toEqual([q1]);
    expect((await json<View>(await getQ(dan, q1))).subject).toBeNull();
    expect((await getQ(dan, qFolder)).status).toBe(404);
    expect(await rlsQuestionIds(dan)).toEqual([q1]);
    // someone who cannot view the target sees nothing
    expect((await getQ(carl, q1)).status).toBe(404);
    expect(await onTarget(carl, "document", DOC1.id)).toEqual([]);
    expect(await rlsQuestionIds(carl)).toEqual([]);
    // staff may read published ones on the investor routes too
    expect((await json<View>(await getQ(owner, q1))).subject).toBeNull();
  });

  it("unpublish keeps it with the asker; close and reopen", async () => {
    const un = await staffOk(owner, "POST", `/${q1}/unpublish`);
    expect(un).toMatchObject({ status: "answered", visibility: "asker" });
    expect((await getQ(bob, q1)).status).toBe(404);
    expect(await rlsQuestionIds(bob)).toEqual([]);
    expect((await json<View>(await getQ(ana, q1))).answer?.body).toBe("Yes — by Big Four, FY2025.");
    expect(await outboxCount("qa.answer_released", q1)).toBe(2);
    expect(await auditCount("qa.answer_unpublished", q1)).toBe(1);
    await expectError(await staff(owner, "POST", `/${q1}/unpublish`), 409, "conflict");

    const closed = await staffOk(owner, "POST", `/${q1}/close`, { reason: "declined" });
    expect(closed).toMatchObject({ status: "closed", closedReason: "declined" });
    expect((await json<View>(await getQ(ana, q1))).status).toBe("closed");
    await expectError(
      await staff(editor, "PUT", `/${q1}/answer`, { body: "late" }),
      409,
      "conflict",
      "closed",
    );
    const reopened = await staffOk(owner, "POST", `/${q1}/reopen`);
    expect(reopened).toMatchObject({
      status: "assigned",
      closedReason: null,
      visibility: null,
      assignee: { membershipId: editor.membershipId },
    });
    for (const action of [
      "qa.answer_saved",
      "qa.answer_released",
      "qa.question_closed",
      "qa.question_reopened",
    ])
      expect(await auditCount(action, q1)).toBeGreaterThan(0);
  });
});

describe("a published answer follows the target", () => {
  it("disappears for other bidders when the target is binned", async () => {
    const q = await asked(ana, "document", DOC_T.id, "Trash me?");
    await staffOk(owner, "PUT", `/${q.id}/answer`, { body: "Sure." });
    await staffOk(owner, "POST", `/${q.id}/release`, { visibility: "target" });
    const seen = await json<View>(await getQ(bob, q.id));
    // no public text given: the asker's subject + body, as asked
    expect(seen.publicText).toBe("Trash me?\n\nTrash me? — details please");
    const del = await request(`/api/v1/data-room/documents/${DOC_T.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(200);
    expect((await getQ(bob, q.id)).status).toBe(404);
    expect(await onTarget(bob, "document", DOC_T.id)).toEqual([]);
    expect(await rlsQuestionIds(bob)).not.toContain(q.id);
    expect((await getQ(owner, q.id)).status).toBe(404);
    expect((await staffOk(owner, "GET", `/${q.id}`)).target.deleted).toBe(true);
    // the asker still has their own thread; asking on a binned target is refused
    expect((await getQ(ana, q.id)).status).toBe(200);
    await expectError(await ask(ana, "document", DOC_T.id, "Again?"), 404, "not_found");
  });

  it("disappears for a bidder who loses access to the target", async () => {
    const q = await asked(ana, "document", DOC_B.id, "Board seats?");
    await staffOk(owner, "PUT", `/${q.id}/answer`, { body: "Two." });
    await staffOk(owner, "POST", `/${q.id}/release`, { visibility: "target" });
    expect((await getQ(bob, q.id)).status).toBe(200);
    expect(await rlsQuestionIds(bob)).toContain(q.id);
    const grant = await sql<{ id: string }>(
      `SELECT id FROM core.access_grant WHERE subject_id = '${bob.membershipId}' AND resource_id = '${F3.id}'`,
    );
    const revoke = await request(`/api/v1/access/grants/${grant[0]?.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(revoke.status).toBe(200);
    // effective access is rebuilt after the change
    await waitFor(async () => ((await getQ(bob, q.id)).status === 404 ? true : undefined));
    expect(await onTarget(bob, "document", DOC_B.id)).toEqual([]);
    expect(await rlsQuestionIds(bob)).not.toContain(q.id);
    expect((await getQ(ana, q.id)).status).toBe(200);
  });
});

describe("four-eyes approval", () => {
  it("submit → approve (never one's own) → release; an edit clears the approval", async () => {
    await patchSettings({ qa: { requireApproval: true } });
    const q = await asked(ana, "document", DOC1.id, "Churn?");
    const id = q.id;
    await staffOk(owner, "PUT", `/${id}/answer`, { body: "Churn is 2%." });
    await expectError(
      await staff(owner, "POST", `/${id}/release`, { visibility: "asker" }),
      409,
      "conflict",
      "approval_required",
    );
    await expectError(
      await staff(legal, "POST", `/${id}/approve`),
      409,
      "conflict",
      "nothing_to_approve",
    );
    const submitted = await staffOk(owner, "POST", `/${id}/submit`);
    expect(submitted.status).toBe("awaiting_approval");
    expect(submitted.answer?.submittedAt).not.toBeNull();
    expect(await outboxPayloads("qa.answer_submitted", id)).toEqual([
      { questionId: id, actorMembershipId: owner.membershipId },
    ]);
    await expectError(
      await staff(owner, "POST", `/${id}/approve`),
      409,
      "conflict",
      "self_approval",
    );
    const approved = await staffOk(legal, "POST", `/${id}/approve`);
    expect(approved.answer).toMatchObject({
      approvedBy: { membershipId: legal.membershipId },
      approvalCurrent: true,
    });
    // editing after approval clears it
    const edited = await staffOk(owner, "PUT", `/${id}/answer`, { body: "Churn is 2.1%." });
    expect(edited.answer).toMatchObject({
      approvalCurrent: false,
      approvedAt: null,
      approvedBy: null,
    });
    await expectError(
      await staff(owner, "POST", `/${id}/release`, { visibility: "asker" }),
      409,
      "conflict",
      "approval_required",
    );
    await staffOk(legal, "POST", `/${id}/approve`);
    expect((await staffOk(owner, "POST", `/${id}/release`, { visibility: "asker" })).status).toBe(
      "answered",
    );
    expect((await json<View>(await getQ(ana, id))).answer?.body).toBe("Churn is 2.1%.");
    expect((await staffOk(owner, "POST", `/${id}/release`, { visibility: "target" })).status).toBe(
      "published",
    );
    // S2: under four-eyes a changed released answer goes offline (no assignee → open) until it
    // is submitted, approved and released again — nobody reads text nobody approved
    const again = await staffOk(editor, "PUT", `/${id}/answer`, { body: "Churn is 2.2%." });
    expect(again).toMatchObject({
      status: "open",
      visibility: null,
      answer: { approvalCurrent: false, submittedAt: null },
    });
    expect(await auditCount("qa.answer_withdrawn_for_review", id)).toBe(1);
    expect((await getQ(bob, id)).status).toBe(404);
    expect(await rlsQuestionIds(bob)).not.toContain(id);
    expect(await rlsAnswerQuestionIds(bob)).not.toContain(id);
    expect(await json<View>(await getQ(ana, id))).toMatchObject({
      status: "open",
      answer: null,
      visibility: null,
    });
    expect(await rlsAnswerQuestionIds(ana)).not.toContain(id);
    await expectError(
      await staff(owner, "POST", `/${id}/release`, { visibility: "target" }),
      409,
      "conflict",
      "approval_required",
    );
    await staffOk(editor, "POST", `/${id}/submit`);
    await staffOk(legal, "POST", `/${id}/approve`);
    expect((await staffOk(owner, "POST", `/${id}/release`, { visibility: "target" })).status).toBe(
      "published",
    );
    expect((await json<View>(await getQ(bob, id))).answer?.body).toBe("Churn is 2.2%.");
    expect((await json<View>(await getQ(ana, id))).answer?.body).toBe("Churn is 2.2%.");
    for (const action of ["qa.answer_submitted", "qa.answer_approved", "qa.answer_released"])
      expect(await auditCount(action, id)).toBeGreaterThan(0);
  });

  it("reject sends it back with a note", async () => {
    const q = await asked(ana, "document", DOC1.id, "Burn?");
    await staffOk(editor, "PUT", `/${q.id}/answer`, { body: "High." });
    await staffOk(editor, "POST", `/${q.id}/submit`);
    const rejected = await staffOk(legal, "POST", `/${q.id}/reject`, { note: "Be specific." });
    expect(rejected).toMatchObject({
      status: "open",
      answer: { rejectedNote: "Be specific.", submittedAt: null },
    });
    await expectError(
      await staff(legal, "POST", `/${q.id}/reject`, { note: "x" }),
      409,
      "conflict",
    );
    await patchSettings({ qa: { requireApproval: false } });
  });
});

describe("withdraw", () => {
  it("the asker withdraws before release; nobody else can", async () => {
    const q = await asked(ana, "document", DOC1.id, "Never mind?");
    await expectError(
      await request(`/api/v1/data-room/qa/questions/${q.id}/withdraw`, {
        method: "POST",
        cookie: dan.cookie,
      }),
      403,
      "forbidden",
      "delegate_read_only",
    );
    expect(
      (
        await request(`/api/v1/data-room/qa/questions/${q.id}/withdraw`, {
          method: "POST",
          cookie: bob.cookie,
        })
      ).status,
    ).toBe(404);
    const w = await request(`/api/v1/data-room/qa/questions/${q.id}/withdraw`, {
      method: "POST",
      cookie: ana.cookie,
    });
    expect(w.status).toBe(200);
    expect(await json<View>(w)).toMatchObject({ status: "closed", mine: true });
    expect((await staffOk(owner, "GET", `/${q.id}`)).closedReason).toBe("withdrawn");
    expect(await auditCount("qa.question_withdrawn", q.id)).toBe(1);
    const again = await request(`/api/v1/data-room/qa/questions/${q.id}/withdraw`, {
      method: "POST",
      cookie: ana.cookie,
    });
    await expectError(again, 409, "conflict", "closed");
  });
});

describe("budgets", () => {
  it("refuses beyond maxOpenPerAsker open questions, then beyond 20 asks a day", async () => {
    await patchSettings({ qa: { maxOpenPerAsker: 2 } });
    await asked(rita, "document", DOC1.id, "One");
    await asked(rita, "document", DOC1.id, "Two");
    await expectError(
      await ask(rita, "document", DOC1.id, "Three"),
      409,
      "conflict",
      "too_many_open",
    );
    await patchSettings({ qa: { maxOpenPerAsker: 500 } });
    // 18 more (closed, so not open) asked in the last day → 20
    await sql(`INSERT INTO dataroom.qa_question (workspace_id, target_kind, document_id, asker_membership_id,
                 source, status, subject, body, closed_reason, closed_at)
               SELECT '${acmeId}', 'document', '${DOC1.id}', '${rita.membershipId}', 'portal', 'closed',
                      'old ' || g, 'old', 'withdrawn', now() FROM generate_series(1, 18) g`);
    await expectError(await ask(rita, "document", DOC1.id, "Four"), 429, "rate_limited");
    await sql(`UPDATE dataroom.qa_question SET created_at = now() - interval '25 hours'
                WHERE asker_membership_id = '${rita.membershipId}' AND subject LIKE 'old %'`);
    expect((await ask(rita, "document", DOC1.id, "Four")).status).toBe(201);
  });
});

describe("staff entries and edits", () => {
  it("creates an FAQ entry with no asker; it can only be published", async () => {
    const d = await staffOk(owner, "POST", "", {
      targetKind: "folder",
      targetId: F1.id,
      subject: "Where is the cap table?",
      body: "Several bidders asked.",
      answer: "In 2.3.",
    });
    expect(d).toMatchObject({
      source: "staff",
      status: "assigned",
      asker: null,
      assignee: { membershipId: owner.membershipId },
      answer: { body: "In 2.3.", author: { membershipId: owner.membershipId } },
    });
    await expectError(
      await staff(owner, "POST", `/${d.id}/release`, { visibility: "asker" }),
      400,
      "validation_failed",
      "no_asker",
    );
    await staffOk(owner, "POST", `/${d.id}/release`, {
      visibility: "target",
      publicText: "Cap table?",
    });
    expect((await onTarget(bob, "folder", F1.id)).map((v) => v.publicText)).toContain("Cap table?");
    expect(await onTarget(carl, "folder", F1.id)).toEqual([]);
    // unpublish with no asker: back to assigned (it has an assignee)
    expect((await staffOk(owner, "POST", `/${d.id}/unpublish`)).status).toBe("assigned");
    await expectError(
      await staff(owner, "POST", "", {
        targetKind: "document",
        targetId: randomUUID(),
        subject: "x",
        body: "y",
        answer: "z",
      }),
      404,
      "not_found",
    );
  });

  it("PATCH edits category, note, public text and due time; a published question keeps its wording", async () => {
    const d = await staffOk(owner, "PATCH", `/${qFolder}`, {
      category: "Finance",
      internalNote: "ask CFO",
      dueAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expect(d).toMatchObject({ category: "Finance", internalNote: "ask CFO", sla: "overdue" });
    expect(await auditCount("qa.question_edited", qFolder)).toBe(1);
    await staffOk(owner, "PUT", `/${qFolder}/answer`, { body: "Nothing." });
    await staffOk(owner, "POST", `/${qFolder}/release`, { visibility: "target" });
    await expectError(
      await staff(owner, "PATCH", `/${qFolder}`, { publicText: null }),
      400,
      "validation_failed",
    );
    await staffOk(owner, "PATCH", `/${qFolder}`, { publicText: "What is missing?" });
    expect((await json<View>(await getQ(bob, qFolder))).publicText).toBe("What is missing?");
    // unpublish with an asker: back to answered (the asker keeps it)
    await staffOk(owner, "POST", `/${qFolder}/unpublish`);
  });
});

describe("the inbox: counts, filters, pagination", () => {
  it("counts every status; filters by status, assignee, target and overdue", async () => {
    const all = await sql<{ status: string; n: number }>(
      `SELECT status::text AS status, count(*)::int AS n FROM dataroom.qa_question GROUP BY status`,
    );
    const page = await json<InboxPage>(await staff(owner, "GET", "?limit=100"));
    for (const r of all) expect(page.counts[r.status]).toBe(r.n);
    expect(Object.values(page.counts).reduce((a, b) => a + b, 0)).toBe(
      all.reduce((a, r) => a + r.n, 0),
    );

    const ids = async (qs: string) =>
      (await json<InboxPage>(await staff(owner, "GET", `?limit=100&${qs}`))).items.map((i) => i.id);
    const expectIds = async (qs: string, where: string) => {
      const rows = await sql<{ id: string }>(
        `SELECT id FROM dataroom.qa_question WHERE ${where} ORDER BY created_at DESC, id DESC`,
      );
      expect(await ids(qs)).toEqual(rows.map((r) => r.id));
    };
    await expectIds("status=open", "status = 'open'");
    await expectIds("status=closed", "status = 'closed'");
    await expectIds("assignee=me", `assignee_membership_id = '${owner.membershipId}'`);
    await expectIds(
      `assignee=${editor.membershipId}`,
      `assignee_membership_id = '${editor.membershipId}'`,
    );
    await expectIds("assignee=unassigned", "assignee_membership_id IS NULL");
    await expectIds("targetKind=folder", "target_kind = 'folder'");
    await expectIds(`targetKind=document&targetId=${DOC1.id}`, `document_id = '${DOC1.id}'`);
    await expectIds(
      "overdue=true",
      "status IN ('open','assigned','awaiting_approval') AND due_at <= now()",
    );
    const open = (await json<InboxPage>(await staff(owner, "GET", "?status=open&limit=1")))
      .items[0];
    expect(open).toBeDefined();
    await staffOk(owner, "PATCH", `/${open?.id}`, {
      dueAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await expectIds(
      "overdue=true",
      "status IN ('open','assigned','awaiting_approval') AND due_at <= now()",
    );
    expect(await ids("overdue=true")).toContain(open?.id);
    const overdue = (await json<InboxPage>(await staff(owner, "GET", "?overdue=true"))).items;
    expect(overdue.every((i) => i.sla === "overdue")).toBe(true);
  });

  it("keyset pagination walks every row exactly once, ties on created_at included", async () => {
    // three rows sharing one created_at: only the id breaks the tie
    await sql(`INSERT INTO dataroom.qa_question (workspace_id, target_kind, document_id, source, subject, body, created_at)
               SELECT '${acmeId}', 'document', '${DOC1.id}', 'import', 'tie ' || g, 'tie',
                      '2026-01-01T00:00:00.123456Z' FROM generate_series(1, 3) g`);
    const expected = (
      await sql<{ id: string }>(
        `SELECT id FROM dataroom.qa_question ORDER BY created_at DESC, id DESC`,
      )
    ).map((r) => r.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const qs: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
      const p: InboxPage = await json<InboxPage>(await staff(owner, "GET", qs));
      seen.push(...p.items.map((x) => x.id));
      cursor = p.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(expected);
    await expectError(await staff(owner, "GET", "?cursor=nonsense"), 400, "validation_failed");

    // the investor list pages the same way
    const mineAll: string[] = [];
    let c2: string | null = null;
    for (let i = 0; i < 100; i++) {
      const qs: string = c2 === null ? "limit=1" : `limit=1&cursor=${c2}`;
      const r = await request(`/api/v1/data-room/qa/questions?scope=mine&${qs}`, {
        cookie: ana.cookie,
      });
      const p: { items: View[]; nextCursor: string | null } = await json(r);
      mineAll.push(...p.items.map((x) => x.id));
      c2 = p.nextCursor;
      if (c2 === null) break;
    }
    const anaRows = await sql<{ id: string }>(
      `SELECT id FROM dataroom.qa_question WHERE asker_membership_id = '${ana.membershipId}'
        ORDER BY created_at DESC, id DESC`,
    );
    expect(mineAll).toEqual(anaRows.map((r) => r.id));
  });
});

describe("a one-connection pool", () => {
  it("ask → list → inbox → assign → answer → release complete without a nested acquire", async () => {
    const single = await startServer({
      config: testConfig({ DATABASE_POOL_MAX: "1", ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    // An api node also runs the outbox relay, on the same one-connection pool: every event the
    // routes below publish wakes it, and a relay batch holds the pool's only connection while it
    // dispatches — a route then times out acquiring (a flake, not a nested acquire by a route).
    // What this test proves is that the ROUTES never hold one connection while asking for a
    // second, so the relay is stopped (`stop()` awaits an in-flight batch); the main server's
    // relay, on its own pool, still delivers these events.
    await single.container.relay.stop();
    try {
      const run = async () => {
        const post = await request("/api/v1/data-room/qa/questions", {
          method: "POST",
          cookie: bob.cookie,
          server: single,
          body: JSON.stringify({
            targetKind: "document",
            targetId: DOC1.id,
            subject: "Pool?",
            body: "Pool.",
          }),
        });
        expect(post.status).toBe(201);
        const { id } = await json<{ id: string }>(post);
        for (const path of [
          `/api/v1/data-room/qa/questions?scope=target&targetKind=document&targetId=${DOC1.id}`,
          `/api/v1/data-room/qa/questions/${id}`,
        ]) {
          expect((await request(path, { cookie: bob.cookie, server: single })).status).toBe(200);
        }
        const call = (method: string, path: string, body?: unknown) =>
          request(`/api/v1/data-room/qa/inbox${path}`, {
            method,
            cookie: owner.cookie,
            server: single,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        expect((await call("GET", "")).status).toBe(200);
        expect((await call("GET", `/${id}`)).status).toBe(200);
        expect(
          (await call("POST", `/${id}/assign`, { assigneeMembershipId: editor.membershipId }))
            .status,
        ).toBe(200);
        expect((await call("PUT", `/${id}/answer`, { body: "Yes." })).status).toBe(200);
        expect((await call("POST", `/${id}/release`, { visibility: "target" })).status).toBe(200);
        return true;
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pool deadlock: timed out")), 30_000),
      );
      expect(await Promise.race([run(), timeout])).toBe(true);
    } finally {
      await single.stop();
    }
  }, 60_000);
});

describe("fix round 1", () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

  it("S1: a gated investor cannot read a published question by id (403 + pending gates, no text)", async () => {
    const d = await staffOk(owner, "POST", "", {
      targetKind: "document",
      targetId: DOC_G.id,
      subject: "Secret terms?",
      body: "Staff FAQ.",
      answer: "The secret answer.",
    });
    await staffOk(owner, "POST", `/${d.id}/release`, {
      visibility: "target",
      publicText: "The secret wording",
    });
    const res = await getQ(gina, d.id);
    const text = await res.text();
    expect(res.status).toBe(403);
    const err = JSON.parse(text) as ApiErr;
    expect(err.error.code).toBe("forbidden");
    expect(err.error.pendingGates?.map((g) => g.kind)).toEqual(["nda"]);
    expect(text).not.toContain("secret");
    expect(await onTarget(gina, "document", DOC_G.id)).toEqual([]);
    // no access at all stays 404
    expect((await getQ(carl, d.id)).status).toBe(404);
  });

  it("S3: RLS lets an external asker only withdraw — no forged publish, target move or assignee", async () => {
    const q = await asked(ana, "document", DOC1.id, "RLS probe?");
    const upd = (set: string) =>
      asMember(ana, `UPDATE dataroom.qa_question SET ${set} WHERE id = '${q.id}' RETURNING id`);
    const withdraw = "status = 'closed', closed_reason = 'withdrawn', closed_at = now()";
    // forged publish
    await expect(
      upd("status = 'published', visibility = 'target', public_text = 'forged'"),
    ).rejects.toThrow();
    // closed, but as "declined" (a staff decision)
    await expect(
      upd("status = 'closed', closed_reason = 'declined', closed_at = now()"),
    ).rejects.toThrow();
    // a withdrawal that also moves the target / assigns / rewrites / re-dates
    await expect(upd(`${withdraw}, document_id = '${DOC_B.id}'`)).rejects.toThrow();
    await expect(
      upd(`${withdraw}, assignee_membership_id = '${editor.membershipId}'`),
    ).rejects.toThrow();
    await expect(upd(`${withdraw}, subject = 'rewritten'`)).rejects.toThrow();
    await expect(upd(`${withdraw}, due_at = now() + interval '1 year'`)).rejects.toThrow();
    await expect(upd(`${withdraw}, released_at = now()`)).rejects.toThrow();
    const row = await sql<Record<string, unknown>>(
      `SELECT status::text, document_id, assignee_membership_id, subject, visibility
         FROM dataroom.qa_question WHERE id = '${q.id}'`,
    );
    expect(row[0]).toEqual({
      status: "open",
      document_id: DOC1.id,
      assignee_membership_id: null,
      subject: "RLS probe?",
      visibility: null,
    });
    // the one thing it may do
    expect(await upd(withdraw)).toHaveLength(1);
    // and not undo it
    await expect(upd("status = 'open', closed_reason = NULL, closed_at = NULL")).rejects.toThrow();
  });

  it("S4: an erased asker's question is a tombstone (409 erased)", async () => {
    const q = await asked(ana, "document", DOC1.id, "Erase me?");
    await staffOk(owner, "PUT", `/${q.id}/answer`, { body: "Answer." });
    await sql(`UPDATE dataroom.qa_question SET status = 'closed', closed_reason = 'erased',
                 closed_at = now() WHERE id = '${q.id}'`);
    for (const [method, path, body] of [
      ["POST", `/${q.id}/reopen`, undefined],
      ["POST", `/${q.id}/release`, { visibility: "target" }],
      ["PUT", `/${q.id}/answer`, { body: "Other." }],
      ["PATCH", `/${q.id}`, { category: "x" }],
      ["PATCH", `/${q.id}`, { publicText: "Leaked?" }],
      ["POST", `/${q.id}/assign`, { assigneeMembershipId: editor.membershipId }],
    ] as const)
      await expectError(await staff(owner, method, path, body), 409, "conflict", "erased");
    expect((await staffOk(owner, "GET", `/${q.id}`)).category).toBeNull();
  });

  it("S5: a cursor that is not the µs UTC text the server writes is a 400, not a 500", async () => {
    const id = randomUUID();
    for (const t of ["2026-01-01T00:00:00Z", "2026-02-30T00:00:00.000000Z", "2026-01-01"]) {
      const cursor = b64([t, id]);
      await expectError(await staff(owner, "GET", `?cursor=${cursor}`), 400, "validation_failed");
      await expectError(
        await request(`/api/v1/data-room/qa/questions?scope=mine&cursor=${cursor}`, {
          cookie: ana.cookie,
        }),
        400,
        "validation_failed",
      );
    }
  });

  it("S6: NUL in any Q&A text is a 400", async () => {
    await expectError(
      await ask(ana, "document", DOC1.id, "nul\u0000here"),
      400,
      "validation_failed",
    );
    await expectError(
      await staff(owner, "PUT", `/${q1}/answer`, { body: "a\u0000b" }),
      400,
      "validation_failed",
    );
    for (const patch of [
      { internalNote: "a\u0000b" },
      { category: "a\u0000b" },
      { publicText: "a\u0000b" },
    ])
      await expectError(await staff(owner, "PATCH", `/${q1}`, patch), 400, "validation_failed");
    await expectError(
      await staff(legal, "POST", `/${q1}/reject`, { note: "a\u0000b" }),
      400,
      "validation_failed",
    );
    await expectError(
      await staff(owner, "POST", "", {
        targetKind: "document",
        targetId: DOC1.id,
        subject: "s",
        body: "b",
        answer: "a\u0000",
      }),
      400,
      "validation_failed",
    );
    await expectError(
      await staff(owner, "POST", `/${q1}/release`, { visibility: "target", publicText: "\u0000" }),
      400,
      "validation_failed",
    );
  });

  it("C2: close with notifyAsker tells a live asker (qa.question_declined); nobody otherwise", async () => {
    const a = await asked(ana, "document", DOC1.id, "Decline and tell?");
    await staffOk(owner, "POST", `/${a.id}/close`, { reason: "declined", notifyAsker: true });
    expect(await outboxPayloads("qa.question_declined", a.id)).toEqual([
      { questionId: a.id, askerMembershipId: ana.membershipId },
    ]);
    const b = await asked(ana, "document", DOC1.id, "Decline quietly?");
    await staffOk(owner, "POST", `/${b.id}/close`, { reason: "declined" });
    expect(await outboxCount("qa.question_declined", b.id)).toBe(0);
    const faq = await staffOk(owner, "POST", "", {
      targetKind: "document",
      targetId: DOC1.id,
      subject: "No asker",
      body: "b",
      answer: "a",
    });
    await staffOk(owner, "POST", `/${faq.id}/close`, { reason: "declined", notifyAsker: true });
    expect(await outboxCount("qa.question_declined", faq.id)).toBe(0);
  });

  it("C6: a withdrawn question stays closed; a reopen restarts the SLA and its reminders", async () => {
    const w = await asked(ana, "document", DOC1.id, "Withdraw then reopen?");
    expect(
      (
        await request(`/api/v1/data-room/qa/questions/${w.id}/withdraw`, {
          method: "POST",
          cookie: ana.cookie,
        })
      ).status,
    ).toBe(200);
    await expectError(await staff(owner, "POST", `/${w.id}/reopen`), 409, "conflict", "withdrawn");

    const q = await asked(ana, "document", DOC1.id, "Reopen me?");
    await sql(`UPDATE dataroom.qa_question SET due_at = now() - interval '10 days',
                 due_soon_notified_at = now(), overdue_notified_at = now() WHERE id = '${q.id}'`);
    await staffOk(owner, "POST", `/${q.id}/close`, { reason: "declined" });
    const before = Date.now();
    const d = await staffOk(owner, "POST", `/${q.id}/reopen`);
    expect(d.status).toBe("open");
    const due = new Date(d.dueAt ?? 0).getTime();
    expect(due).toBeGreaterThanOrEqual(before + 48 * 3_600_000 - 5_000);
    expect(due).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000 + 5_000);
    const stamps = await sql(
      `SELECT due_soon_notified_at, overdue_notified_at FROM dataroom.qa_question WHERE id = '${q.id}'`,
    );
    expect(stamps[0]).toEqual({ due_soon_notified_at: null, overdue_notified_at: null });
    // no asker: no clock
    const faq = await staffOk(owner, "POST", "", {
      targetKind: "document",
      targetId: DOC1.id,
      subject: "FAQ reopen",
      body: "b",
      answer: "a",
    });
    await staffOk(owner, "POST", `/${faq.id}/close`, { reason: "declined" });
    expect((await staffOk(owner, "POST", `/${faq.id}/reopen`)).dueAt).toBeNull();
  });

  it("C7: assigning a staff entry sets no due time", async () => {
    const faq = await staffOk(owner, "POST", "", {
      targetKind: "folder",
      targetId: F1.id,
      subject: "FAQ assign",
      body: "b",
      answer: "a",
    });
    expect(faq.dueAt).toBeNull();
    await staffOk(owner, "POST", `/${faq.id}/assign`, { assigneeMembershipId: null });
    const d = await staffOk(owner, "POST", `/${faq.id}/assign`, {
      assigneeMembershipId: editor.membershipId,
    });
    expect(d).toMatchObject({ status: "assigned", dueAt: null, sla: "none" });
  });

  it("release without a visibility follows qa.defaultVisibility (target when there is no asker)", async () => {
    await patchSettings({ qa: { defaultVisibility: "asker" } });
    const q = await asked(ana, "document", DOC1.id, "Default visibility?");
    await staffOk(owner, "PUT", `/${q.id}/answer`, { body: "Private." });
    expect(await staffOk(owner, "POST", `/${q.id}/release`, {})).toMatchObject({
      status: "answered",
      visibility: "asker",
    });
    const faq = await staffOk(owner, "POST", "", {
      targetKind: "document",
      targetId: DOC1.id,
      subject: "Default for FAQ",
      body: "b",
      answer: "a",
    });
    expect(await staffOk(owner, "POST", `/${faq.id}/release`, {})).toMatchObject({
      status: "published",
      visibility: "target",
    });
    await patchSettings({ qa: { defaultVisibility: "target" } });
    const q2 = await asked(ana, "document", DOC1.id, "Default target?");
    await staffOk(owner, "PUT", `/${q2.id}/answer`, { body: "Public." });
    expect((await staffOk(owner, "POST", `/${q2.id}/release`, {})).status).toBe("published");
  });

  it("without requireApproval an edit to a published answer stays live", async () => {
    const q = await asked(ana, "document", DOC1.id, "Live edit?");
    await staffOk(owner, "PUT", `/${q.id}/answer`, { body: "v1" });
    await staffOk(owner, "POST", `/${q.id}/release`, { visibility: "target" });
    const d = await staffOk(editor, "PUT", `/${q.id}/answer`, { body: "v2" });
    expect(d.status).toBe("published");
    expect((await json<View>(await getQ(bob, q.id))).answer?.body).toBe("v2");
  });

  it("C17/C20/C4: the qa patch is strict; the audit names the actor; flipping enabled reindexes", async () => {
    const bad = await request("/api/v1/data-room/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ qa: { enabled: true, bogus: 1 } }),
    });
    expect(bad.status).toBe(400);
    const audit = await pg.pool.query<{ actor: string | null }>(
      `SELECT actor_membership_id AS actor FROM audit.event
        WHERE workspace_id = $1 AND action = 'data_room.settings_changed'
        ORDER BY occurred_at DESC LIMIT 1`,
      [acmeId],
    );
    expect(audit.rows[0]?.actor).toBe(owner.membershipId);

    const reindexedSince = (t: string) =>
      waitFor(async () => {
        const r = await pg.pool.query<{ ok: boolean }>(
          `SELECT (requested_at IS NOT NULL OR indexed_at >= $3::timestamptz) AS ok
             FROM core.search_state WHERE workspace_id = $1 AND module = $2`,
          [acmeId, "data-room", t],
        );
        return r.rows[0]?.ok ? true : undefined;
      }, 10_000);
    const settle = async () =>
      waitFor(async () => {
        const r = await pg.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM core.search_state
            WHERE workspace_id = $1 AND module = 'data-room' AND requested_at IS NOT NULL`,
          [acmeId],
        );
        return r.rows[0]?.n === 0 ? true : undefined;
      }, 30_000);
    await settle();
    const t0 = (await pg.pool.query<{ t: string }>("SELECT now()::text AS t")).rows[0]?.t ?? "";
    await patchSettings({ qa: { enabled: false } });
    await reindexedSince(t0);
    await settle();
    const t1 = (await pg.pool.query<{ t: string }>("SELECT now()::text AS t")).rows[0]?.t ?? "";
    await patchSettings({ qa: { enabled: true } });
    await reindexedSince(t1);
  }, 60_000);
});

describe("fix round 2", () => {
  let eve: Actor; // a fresh bidder on F1 (ana is near the asks-per-day limit)
  const DOC_R = { id: randomUUID(), folder: F1, title: "Round two" };
  const withdraw = (a: Actor, id: string) =>
    request(`/api/v1/data-room/qa/questions/${id}/withdraw`, { method: "POST", cookie: a.cookie });
  const cursorTime = async (col: string, id: string) =>
    (
      await sql<{ t: string }>(
        `SELECT to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t
           FROM dataroom.qa_question WHERE id = '${id}'`,
      )
    )[0]?.t;

  beforeAll(async () => {
    eve = await member("eve", "external", "investor");
    await sql(`INSERT INTO core.group_member (workspace_id, group_id, membership_id)
               VALUES ('${acmeId}', '${biddersId}', '${eve.membershipId}')`);
    await sql(`INSERT INTO dataroom.document (id, workspace_id, folder_id, folder_path, title)
               VALUES ('${DOC_R.id}', '${acmeId}', '${F1.id}', '${F1.path}', '${DOC_R.title}')`);
    await bump();
    // self-contained (also when run alone with -t)
    await patchSettings({
      qa: { enabled: true, slaHours: 48, requireApproval: false, maxOpenPerAsker: 500 },
    });
  });

  it("H1: concurrent settings PATCHes and Q&A staff actions on one question never deadlock", async () => {
    const deadlocks = async () => {
      const r = await pg.pool.query<{ n: string }>(
        "SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()",
      );
      return Number(r.rows[0]?.n ?? 0);
    };
    const q = await asked(eve, "document", DOC1.id, "Deadlock probe?");
    await staffOk(owner, "POST", `/${q.id}/close`, { reason: "declined" });
    await new Promise((r) => setTimeout(r, 1_100)); // pg_stat flushes at most once a second
    const before = await deadlocks();
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) {
      const settings = () =>
        request("/api/v1/data-room/settings", {
          method: "PATCH",
          cookie: owner.cookie,
          body: JSON.stringify({ qa: { reminderLeadHours: 12 + (i % 2) } }),
        });
      const rs = await Promise.all([
        settings(),
        staff(owner, "POST", `/${q.id}/reopen`),
        staff(owner, "POST", `/${q.id}/close`, { reason: "declined" }),
        settings(),
      ]);
      statuses.push(...rs.map((r) => r.status));
      if ((await staffOk(owner, "GET", `/${q.id}`)).status !== "closed")
        await staffOk(owner, "POST", `/${q.id}/close`, { reason: "declined" });
    }
    expect(statuses.filter((s) => s !== 200 && s !== 409)).toEqual([]);
    await new Promise((r) => setTimeout(r, 1_100));
    expect(await deadlocks()).toBe(before);
  }, 120_000);

  it("S-cursor: scope=target orders and pages a rival's question by published_at, never its ask time", async () => {
    const a = await asked(eve, "document", DOC_R.id, "Cursor one?");
    const b = await asked(eve, "document", DOC_R.id, "Cursor two?");
    // published in the reverse order of asking: by ask time b is first, by publish time a
    for (const id of [b.id, a.id]) {
      await staffOk(owner, "PUT", `/${id}/answer`, { body: "Answered." });
      await staffOk(owner, "POST", `/${id}/release`, { visibility: "target" });
    }
    const page = await request(
      `/api/v1/data-room/qa/questions?scope=target&targetKind=document&targetId=${DOC_R.id}&limit=1`,
      { cookie: ana.cookie },
    );
    expect(page.status).toBe(200);
    const body = await json<{ items: View[]; nextCursor: string | null }>(page);
    expect(body.items.map((v) => v.id)).toEqual([a.id]);
    expect(body.items[0]?.createdAt).toBeNull();
    const [t, id] = JSON.parse(
      Buffer.from(body.nextCursor ?? "", "base64url").toString("utf8"),
    ) as [string, string];
    expect(id).toBe(a.id);
    expect(t).toBe(await cursorTime("published_at", a.id));
    expect(t).not.toBe(await cursorTime("created_at", a.id));
    const next = await request(
      `/api/v1/data-room/qa/questions?scope=target&targetKind=document&targetId=${DOC_R.id}&limit=1&cursor=${body.nextCursor}`,
      { cookie: ana.cookie },
    );
    expect((await json<{ items: View[] }>(next)).items.map((v) => v.id)).toEqual([b.id]);
  });

  it("S-withdraw: a question staff have worded can still be withdrawn", async () => {
    const q = await asked(eve, "document", DOC1.id, "Worded then withdrawn?");
    await staffOk(owner, "PATCH", `/${q.id}`, { publicText: "Staff wording" });
    const res = await withdraw(eve, q.id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await staffOk(owner, "GET", `/${q.id}`)).closedReason).toBe("withdrawn");
  });

  /** Asked by eve, released to the target under four-eyes, then taken offline by an edit. */
  async function takenOffline(subject: string): Promise<string> {
    await patchSettings({ qa: { requireApproval: true } });
    try {
      const q = await asked(eve, "document", DOC1.id, subject);
      await staffOk(owner, "PUT", `/${q.id}/answer`, { body: "v1" });
      await staffOk(owner, "POST", `/${q.id}/submit`);
      await staffOk(legal, "POST", `/${q.id}/approve`);
      await staffOk(owner, "POST", `/${q.id}/release`, {
        visibility: "target",
        publicText: "Public wording",
      });
      await sql(`UPDATE dataroom.qa_question SET due_at = now() - interval '10 days',
                   due_soon_notified_at = now(), overdue_notified_at = now() WHERE id = '${q.id}'`);
      const d = await staffOk(editor, "PUT", `/${q.id}/answer`, { body: "v2" });
      expect(d).toMatchObject({ status: "open", visibility: null });
      return q.id;
    } finally {
      await patchSettings({ qa: { requireApproval: false } });
    }
  }

  it("S-withdraw: a release taken offline for review can be withdrawn", async () => {
    const id = await takenOffline("Offline then withdrawn?");
    const res = await withdraw(eve, id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await staffOk(owner, "GET", `/${id}`)).closedReason).toBe("withdrawn");
  });

  it("S-withdraw: RLS refuses re-labelling a declined question as withdrawn; a refused write is 409", async () => {
    const q = await asked(eve, "document", DOC1.id, "Declined, relabel?");
    await staffOk(owner, "POST", `/${q.id}/close`, { reason: "declined" });
    await expect(
      asMember(
        eve,
        `UPDATE dataroom.qa_question SET closed_reason = 'withdrawn' WHERE id = '${q.id}' RETURNING id`,
      ),
    ).rejects.toThrow();
    expect((await staffOk(owner, "GET", `/${q.id}`)).closedReason).toBe("declined");
    // the service's rules pass but RLS refuses (a stray visibility): a conflict, not a 500
    const r = await asked(eve, "document", DOC1.id, "Refused withdrawal?");
    await sql(`UPDATE dataroom.qa_question SET visibility = 'asker' WHERE id = '${r.id}'`);
    await expectError(await withdraw(eve, r.id), 409, "conflict");
  });

  it("S-insert: an external INSERT cannot forge staff columns, the creator or the ask time", async () => {
    const insert = (cols: string, vals: string) =>
      asMember<{ id: string; hours: number }>(
        eve,
        `INSERT INTO dataroom.qa_question (workspace_id, target_kind, document_id,
            asker_membership_id, source, status, subject, body, created_by${cols})
         VALUES ('${acmeId}', 'document', '${DOC1.id}', '${eve.membershipId}', 'portal', 'open',
            'Raw?', 'Raw insert', '${eve.membershipId}'${vals})
         RETURNING id, (extract(epoch FROM due_at - created_at) / 3600)::int AS hours`,
      );
    // A normal ask works; the trigger sets its SLA from the settings (48 h here).
    const q = await asked(eve, "document", DOC1.id, "Plain ask under the guard?");
    const [row] = await sql<{ hours: number }>(
      `SELECT (extract(epoch FROM due_at - created_at) / 3600)::int AS hours
         FROM dataroom.qa_question WHERE id = '${q.id}'`,
    );
    expect(row?.hours).toBe(48);
    // So does the plain raw insert — so each refusal below is the forged column's.
    const [ok] = await insert("", "");
    expect(ok?.hours).toBe(48);
    const forged: [string, string][] = [
      ["public_text", "'forged'"],
      ["visibility", "'asker'"],
      ["assignee_membership_id", `'${editor.membershipId}'`],
      ["internal_note", "'note'"],
      ["category", "'cat'"],
      ["due_at", "now() + interval '1 year'"],
      ["released_at", "now()"],
      ["published_at", "now()"],
      ["first_released_at", "now()"],
      ["closed_at", "now()"],
      ["due_soon_notified_at", "now()"],
      ["overdue_notified_at", "now()"],
      ["created_at", "now() - interval '1 hour'"],
    ];
    for (const [col, val] of forged)
      await expect(insert(`, ${col}`, `, ${val}`), col).rejects.toThrow();
    // closed_reason needs a closed status (policy) — so a forged reason on an open row
    await expect(insert(", closed_reason", ", 'withdrawn'")).rejects.toThrow();
    // created_by must be the asker
    await expect(
      asMember(
        eve,
        `INSERT INTO dataroom.qa_question (workspace_id, target_kind, document_id,
            asker_membership_id, source, status, subject, body, created_by)
         VALUES ('${acmeId}', 'document', '${DOC1.id}', '${eve.membershipId}', 'portal', 'open',
            'Raw?', 'Raw insert', '${ana.membershipId}')`,
      ),
    ).rejects.toThrow();
  });

  it("L3: assigning never sets a due time staff cleared", async () => {
    const q = await asked(eve, "document", DOC1.id, "No clock please?");
    expect((await staffOk(owner, "PATCH", `/${q.id}`, { dueAt: null })).dueAt).toBeNull();
    const d = await staffOk(owner, "POST", `/${q.id}/assign`, {
      assigneeMembershipId: editor.membershipId,
    });
    expect(d).toMatchObject({ status: "assigned", dueAt: null });
  });

  it("L4: a release taken offline for review re-arms the SLA and its reminders", async () => {
    const before = Date.now();
    const id = await takenOffline("Offline re-arms?");
    const d = await staffOk(owner, "GET", `/${id}`);
    const due = new Date(d.dueAt ?? 0).getTime();
    expect(due).toBeGreaterThanOrEqual(before + 48 * 3_600_000 - 5_000);
    expect(due).toBeLessThanOrEqual(Date.now() + 48 * 3_600_000 + 5_000);
    const stamps = await sql(
      `SELECT due_soon_notified_at, overdue_notified_at FROM dataroom.qa_question WHERE id = '${id}'`,
    );
    expect(stamps[0]).toEqual({ due_soon_notified_at: null, overdue_notified_at: null });
  });

  it("flip-off: switching Q&A off drops its search entries in the PATCH itself", async () => {
    // let any rebuild from earlier flips finish first
    await waitFor(async () => {
      const r = await pg.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM core.search_state
          WHERE workspace_id = $1 AND module = 'data-room' AND requested_at IS NOT NULL`,
        [acmeId],
      );
      return r.rows[0]?.n === 0 ? true : undefined;
    }, 30_000);
    const d = await staffOk(owner, "POST", "", {
      targetKind: "document",
      targetId: DOC1.id,
      subject: "Flip off",
      body: "b",
      answer: "The zebracorn answer.",
    });
    await staffOk(owner, "POST", `/${d.id}/release`, { visibility: "target" });
    const qaHits = async () => {
      const res = await request("/api/v1/search?q=zebracorn", { cookie: bob.cookie });
      expect(res.status).toBe(200);
      return (await json<{ hits: { kind: string; refId: string }[] }>(res)).hits.filter(
        (h) => h.kind === "qa",
      );
    };
    expect((await qaHits()).map((h) => h.refId)).toEqual([d.id]);
    await patchSettings({ qa: { enabled: false } });
    const entries = await pg.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.search_entry
        WHERE workspace_id = $1 AND module = 'data-room' AND kind = 'qa'`,
      [acmeId],
    );
    expect(entries.rows[0]?.n).toBe(0);
    expect(await qaHits()).toEqual([]);
    await patchSettings({ qa: { enabled: true } });
  });
});
