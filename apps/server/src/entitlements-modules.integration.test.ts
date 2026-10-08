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
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { mintTestApiKey } from "./test/api-keys.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Plan entitlements for modules (A-3 / E-UP-2, ADR-0063 §3), against a real server with
 * CONTROL_PLANE=on:
 *
 *  - turning a module on: `PATCH /modules/{id}` answers 402 `plan_limit` `{limit:"module"}` for an
 *    optional module the plan does not include — only after the owner-or-admin guard, so anybody
 *    else keeps their 401/403/404 — and turning one off is never refused;
 *  - read-only: a module that is on but outside the plan (a downgrade, or a default-on module the
 *    plan leaves out) refuses staff writes with 402, sessions and API keys alike, after the
 *    permission guard; staff reads, investors' writes and the exempt routes keep working; a plan
 *    change is seen on the next request; switching the module off is allowed, back on is not;
 *  - what the SPA learns: the enablement list's `planAllows` / `readOnly` / `lockedReason:"plan"`,
 *    and the bootstrap's `modules[].readOnly` and `entitlements` (staff only);
 *  - no gating without a plan, nor with CONTROL_PLANE=off (a second server on the same database).
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
const SECRET = randomBytes(32).toString("base64");
const STORAGE = mkdtempSync(join(tmpdir(), "fundroom-storage-"));
const DATA = mkdtempSync(join(tmpdir(), "fundroom-data-"));

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const ids: Record<string, string> = {};

interface Actor {
  cookie: string;
  membershipId: string;
}
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let investor: Actor;
let freeOwner: Actor;
let keyToken: string;

type ErrorBody = { error: { code: string; limit?: string; module?: string; message?: string } };
interface Enablement {
  id: string;
  enabled: boolean;
  locked: boolean;
  lockedReason: string | null;
  planAllows: boolean;
  readOnly: boolean;
}
interface Bootstrap {
  modules: { id: string; enabled: boolean; readOnly: boolean }[];
  entitlements?: { modules: string[] | null; features: string[] | null };
}

function configFor(controlPlane: boolean) {
  return loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: SECRET,
      STORAGE_FS_PATH: STORAGE,
      DATA_DIR: DATA,
      TENANCY_MODE: "multi",
      ...(controlPlane ? { CONTROL_PLANE: "on" } : {}),
      ROLES: "api,web",
      UPDATE_CHECK: "false",
    },
  });
}

async function request(
  slug: string,
  path: string,
  init: RequestInit & { cookie?: string | undefined; server?: RunningServer } = {},
): Promise<Response> {
  const host = `${slug}.${CANON}`;
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("accept", "application/json");
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `https://${host}`);
  return (init.server ?? running).app.request(`https://${host}${path}`, { ...init, headers });
}

const send = (
  slug: string,
  method: string,
  path: string,
  who: Actor | { authorization: string } | undefined,
  body: unknown = {},
  server?: RunningServer,
) =>
  request(slug, path, {
    method,
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    ...(who === undefined
      ? {}
      : "cookie" in who
        ? { cookie: who.cookie }
        : { headers: { authorization: who.authorization } }),
    ...(server === undefined ? {} : { server }),
  });

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");

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
  return withSetCookies(cookie, confirm);
}

async function member(
  slug: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "editor" | "viewer" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, {
    workspaceId: ids[slug] as string,
    userId,
    kind,
    role,
    source: "test",
  });
  const signed = await signIn(slug, email);
  const cookie = role === "owner" ? await stepUpToMfa(slug, signed.cookie) : signed.cookie;
  return { cookie, membershipId: signed.membershipId };
}

/**
 * Puts a plan on a workspace the way the control plane does (host context). `invalidate: false`
 * proves a change is seen on the very next request (multi mode keeps no resolver cache).
 */
async function assignPlan(slug: string, planId: string | null, invalidate = true): Promise<void> {
  await running.container.db.withHost((tx) =>
    tx.execute(
      `UPDATE core.workspace SET plan_id = ${planId === null ? "NULL" : `'${planId}'`} WHERE id = '${ids[slug]}'`,
    ),
  );
  if (invalidate) running.container.resolver.invalidate();
}

async function enablement(slug: string, who: Actor, server?: RunningServer) {
  const res = await send(slug, "GET", "/api/v1/modules/enablement", who, undefined, server);
  expect(res.status).toBe(200);
  const list = await json<{ modules: Enablement[] }>(res);
  return new Map(list.modules.map((m) => [m.id, m]));
}

async function bootstrap(slug: string, who: Actor | undefined, server?: RunningServer) {
  const res = await send(slug, "GET", "/api/v1/modules", who, undefined, server);
  expect(res.status).toBe(200);
  return json<Bootstrap>(res);
}

async function expectModuleLimit(res: Response, module: string): Promise<void> {
  expect(res.status).toBe(402);
  const body = await json<ErrorBody>(res);
  expect(body.error).toMatchObject({ code: "plan_limit", limit: "module", module });
  expect(body.error.message).toBe(`the workspace's plan does not include the ${module} module`);
}

async function enablementEvents(slug: string, module: string): Promise<number> {
  const ctx = systemContext(ids[slug] as string);
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(
      `SELECT count(*)::int AS n FROM audit.event WHERE action = 'module.enablement_changed' AND meta->>'module' = '${module}'`,
    );
    return (r.rows[0] as { n: number }).n;
  });
}

const contact = (name: string) => ({ displayName: name });

/** A one-page PDF through the tus endpoint, the way the browser uploads; the document id. */
async function uploadPdf(who: Actor, folderId: string): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const bytes = await doc.save();
  const start = await send("acme", "POST", "/api/v1/data-room/uploads", who, {
    fileName: "Deck.pdf",
    size: bytes.byteLength,
    contentType: "application/pdf",
    folderId,
  });
  expect(start.status).toBe(201);
  const started = await json<{ upload: { id: string }; tus: { path: string } | null }>(start);
  const endpoint = `/api/v1${started.tus?.path ?? ""}`;
  const tus = (extra: Record<string, string>) => ({
    cookie: who.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "content-type": "application/offset+octet-stream",
      ...extra,
    },
  });
  const meta = `upload ${Buffer.from(started.upload.id).toString("base64")},filename ${Buffer.from("Deck.pdf").toString("base64")}`;
  const create = await request("acme", endpoint, {
    method: "POST",
    ...tus({ "Upload-Length": String(bytes.byteLength), "Upload-Metadata": meta }),
    body: new Uint8Array(0),
  });
  expect(create.status).toBe(201);
  const patch = await request("acme", `${endpoint}/${started.upload.id}`, {
    method: "PATCH",
    ...tus({ "Upload-Offset": "0" }),
    body: bytes,
  });
  expect(patch.status).toBe(204);
  const complete = await send(
    "acme",
    "POST",
    `/api/v1/data-room/uploads/${started.upload.id}/complete`,
    who,
  );
  expect(complete.status).toBe(200);
  return (await json<{ document: { id: string } }>(complete)).document.id;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  running = await startServer({
    config: configFor(true),
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  const db = running.container.db;
  for (const slug of ["acme", "free"])
    ids[slug] = (await createWorkspace(db, { slug, name: slug.toUpperCase() })).id;
  await db.withHost((tx) =>
    tx.execute(
      `INSERT INTO core.plan (id, name, limits, limits_schema_version) VALUES
         ('full', 'Everything', '{}', 2),
         ('lite', 'Lite', '{"modules":["analytics","data-room","notify","updates"]}', 2),
         ('none', 'Nothing', '{"modules":[],"features":[]}', 2)`,
    ),
  );
  owner = await member("acme", "owner@acme.test", "staff", "owner");
  editor = await member("acme", "editor@acme.test", "staff", "editor");
  viewer = await member("acme", "viewer@acme.test", "staff", "viewer");
  investor = await member("acme", "investor@fund.test", "external", "investor");
  freeOwner = await member("free", "owner@free.test", "staff", "owner");
  keyToken = (
    await mintTestApiKey(db, {
      workspaceId: ids["acme"] as string,
      creatorMembershipId: owner.membershipId,
      scopes: ["crm.read", "crm.manage"],
    })
  ).token;
}, 300_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("turning a module on", () => {
  it("without a plan every module is allowed and none is read-only", async () => {
    const list = await enablement("acme", owner);
    for (const m of list.values()) {
      expect(m, m.id).toMatchObject({ planAllows: true, readOnly: false });
      expect(m.lockedReason, m.id).not.toBe("plan");
    }
  });

  it("is refused with 402 for a module the plan leaves out, and nothing is written", async () => {
    await assignPlan("acme", "lite");
    const list = await enablement("acme", owner);
    // crm is off by default and not on `lite`: the switch is locked for the plan.
    expect(list.get("crm")).toMatchObject({
      enabled: false,
      planAllows: false,
      locked: true,
      lockedReason: "plan",
      readOnly: false,
    });
    expect(list.get("data-room")).toMatchObject({ planAllows: true, readOnly: false });
    // A required module is never on a plan's list and always allowed.
    expect(list.get("content")).toMatchObject({ planAllows: true, lockedReason: "required" });

    const events = await enablementEvents("acme", "crm");
    await expectModuleLimit(
      await send("acme", "PATCH", "/api/v1/modules/crm", owner, { enabled: true }),
      "crm",
    );
    expect(await enablementEvents("acme", "crm")).toBe(events);
    expect((await enablement("acme", owner)).get("crm")?.enabled).toBe(false);

    // Off is never refused for the plan; an allowed module turns on as before.
    const off = await send("acme", "PATCH", "/api/v1/modules/crm", owner, { enabled: false });
    expect(off.status).toBe(200);
    expect(await json<Enablement>(off)).toMatchObject({ enabled: false, lockedReason: "plan" });
    const on = await send("acme", "PATCH", "/api/v1/modules/data-room", owner, { enabled: true });
    expect(on.status).toBe(200);
    // Turning a required module "on" is not a plan question either.
    const content = await send("acme", "PATCH", "/api/v1/modules/content", owner, {
      enabled: true,
    });
    expect(content.status).toBe(200);
    // None of the three changed anything (crm was off, data-room and content on), so none is an
    // enablement change in the audit trail (decision 21).
    expect(await enablementEvents("acme", "crm")).toBe(events);
    expect(await enablementEvents("acme", "data-room")).toBe(0);
    expect(await enablementEvents("acme", "content")).toBe(0);
  });

  it("answers everybody the guard refuses exactly as before (never an oracle)", async () => {
    const body = { enabled: true };
    expect((await send("acme", "PATCH", "/api/v1/modules/crm", undefined, body)).status).toBe(401);
    const asInvestor = await send("acme", "PATCH", "/api/v1/modules/crm", investor, body);
    expect(asInvestor.status).toBe(404);
    const asEditor = await send("acme", "PATCH", "/api/v1/modules/crm", editor, body);
    expect(asEditor.status).toBe(403);
    expect((await json<ErrorBody>(asEditor)).error.code).toBe("forbidden");
    const asKey = await send("acme", "PATCH", "/api/v1/modules/crm", {
      authorization: `Bearer ${keyToken}`,
    });
    expect(asKey.status).toBe(401);
    const unknown = await send("acme", "PATCH", "/api/v1/modules/nosuch", owner, body);
    expect(unknown.status).toBe(404);
  });
});

describe("a module on but outside the plan is read-only for staff", () => {
  let contactCount = 0;
  /** Published to the archive (investors reply to it). */
  let publishedId = "";
  /** Scheduled for tomorrow before the downgrade. */
  let scheduledId = "";
  let documentId = "";

  it("setup: crm on under a plan that includes it, with a contact, two updates and a document", async () => {
    await assignPlan("acme", "full");
    const events = await enablementEvents("acme", "crm");
    const on = await send("acme", "PATCH", "/api/v1/modules/crm", owner, { enabled: true });
    expect(on.status).toBe(200);
    // A real change is audited (the no-change PATCHes elsewhere in this file are not).
    expect(await enablementEvents("acme", "crm")).toBe(events + 1);
    expect(await json<Enablement>(on)).toMatchObject({
      enabled: true,
      planAllows: true,
      readOnly: false,
    });
    const created = await send("acme", "POST", "/api/v1/crm/contacts", owner, contact("Ada"));
    expect(created.status).toBe(201);
    contactCount = 1;

    const post = async (title: string) => {
      const res = await send("acme", "POST", "/api/v1/updates/posts", owner, {
        title,
        template: "blank",
      });
      expect(res.status).toBe(201);
      return (await json<{ post: { id: string } }>(res)).post.id;
    };
    publishedId = await post("Published note");
    const published = await send(
      "acme",
      "POST",
      `/api/v1/updates/posts/${publishedId}/publish`,
      owner,
    );
    expect(published.status).toBe(200);
    scheduledId = await post("Scheduled note");
    const scheduled = await send(
      "acme",
      "POST",
      `/api/v1/updates/posts/${scheduledId}/schedule`,
      owner,
      {
        scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      },
    );
    expect(scheduled.status).toBe(200);

    const tree = await json<{ rootId: string }>(
      await send("acme", "GET", "/api/v1/data-room/tree", owner),
    );
    documentId = await uploadPdf(owner, tree.rootId);
    await assignPlan("acme", "none");
  });

  it("reports it read-only (and not locked: it can still be switched off)", async () => {
    const list = await enablement("acme", owner);
    expect(list.get("crm")).toMatchObject({
      enabled: true,
      planAllows: false,
      readOnly: true,
      locked: false,
      lockedReason: null,
    });
    // A default-on module with no row counts as on: read-only, not hidden.
    expect(list.get("updates")).toMatchObject({ enabled: true, readOnly: true });
    expect(list.get("content")).toMatchObject({ readOnly: false, planAllows: true });
  });

  it("refuses staff writes with 402 — session and API key alike — and keeps reads", async () => {
    await expectModuleLimit(
      await send("acme", "POST", "/api/v1/crm/contacts", owner, contact("Bob")),
      "crm",
    );
    await expectModuleLimit(
      await send("acme", "POST", "/api/v1/crm/contacts", editor, contact("Bob")),
      "crm",
    );
    const key = { authorization: `Bearer ${keyToken}` };
    await expectModuleLimit(
      await send("acme", "POST", "/api/v1/crm/contacts", key, contact("Bob")),
      "crm",
    );

    const read = await send("acme", "GET", "/api/v1/crm/contacts", owner);
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("Ada");
    expect((await send("acme", "GET", "/api/v1/crm/contacts", key)).status).toBe(200);
    // Nothing was written by the refused calls.
    const listed = await json<{ items: unknown[] }>(
      await send("acme", "GET", "/api/v1/crm/contacts", owner),
    );
    expect(listed.items).toHaveLength(contactCount);
  });

  it("answers callers the permission guard refuses exactly as before", async () => {
    const body = contact("Eve");
    expect((await send("acme", "POST", "/api/v1/crm/contacts", undefined, body)).status).toBe(401);
    const asInvestor = await send("acme", "POST", "/api/v1/crm/contacts", investor, body);
    expect(asInvestor.status).toBe(404);
    const asViewer = await send("acme", "POST", "/api/v1/crm/contacts", viewer, body);
    expect(asViewer.status).toBe(403);
    expect((await json<ErrorBody>(asViewer)).error.code).toBe("forbidden");
  });

  it("leaves investors' writes and the exempt staff routes alone", async () => {
    // `updates` is read-only on `none`, but the investor's subscription is a member route.
    const sub = await send("acme", "PUT", "/api/v1/updates/subscription", investor, {
      subscribed: false,
    });
    expect(sub.status).toBe(200);
    expect(await json<{ subscribed: boolean }>(sub)).toEqual({ subscribed: false });
    // `notify` is read-only too; a person's own inbox bookkeeping is exempt (READ_ONLY_EXEMPT).
    const readAll = await send("acme", "POST", "/api/v1/notify/inbox/read-all", owner, {});
    expect(readAll.status).toBe(200);
    // A non-exempt notify write is refused.
    await expectModuleLimit(
      await send("acme", "POST", "/api/v1/notify/channels", owner, {}),
      "notify",
    );
  });

  it("refuses a staff member writing through a member route; the investor's same write works (R1 M1)", async () => {
    const path = `/api/v1/updates/posts/${publishedId}/replies`;
    const staffReply = { body: "Thanks!", threadMembershipId: investor.membershipId };
    await expectModuleLimit(await send("acme", "POST", path, owner, staffReply), "updates");
    // `viewer` holds only `updates.read`, which is all the member route asks of staff.
    await expectModuleLimit(await send("acme", "POST", path, viewer, staffReply), "updates");
    const asked = await send("acme", "POST", path, investor, { body: "When is the next round?" });
    expect(asked.status).toBe(201);
    // Staff telemetry on a member route is exempt (not content).
    const viewed = await send(
      "acme",
      "POST",
      `/api/v1/data-room/documents/${documentId}/viewed`,
      owner,
    );
    expect(viewed.status).not.toBe(402);
  });

  it("still lets staff withdraw: cancel a scheduled send, delete the update, delete a document (decision 8)", async () => {
    // The control: scheduling is new, and refused.
    await expectModuleLimit(
      await send("acme", "POST", `/api/v1/updates/posts/${publishedId}/schedule`, owner, {
        scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      "updates",
    );
    const unscheduled = await send(
      "acme",
      "POST",
      `/api/v1/updates/posts/${scheduledId}/unschedule`,
      owner,
    );
    expect(unscheduled.status).toBe(200);
    expect((await json<{ post: { state: string } }>(unscheduled)).post.state).toBe("draft");
    const deleted = await send("acme", "DELETE", `/api/v1/updates/posts/${scheduledId}`, owner);
    expect(deleted.status).toBeLessThan(300);

    const binned = await send("acme", "DELETE", `/api/v1/data-room/documents/${documentId}`, owner);
    expect(binned.status).toBeLessThan(300);
    // Undeleting is not withdrawing (delete + restore would move read-only content): it waits for
    // an upgrade (ROUND-2 decision 14).
    await expectModuleLimit(
      await send("acme", "POST", `/api/v1/data-room/documents/${documentId}/restore`, owner),
      "data-room",
    );
    // Archiving a published update withdraws it; un-archiving would re-publish it (decision 16).
    const archive = (archived: unknown) =>
      send("acme", "PUT", `/api/v1/updates/posts/${publishedId}/archived`, owner, { archived });
    const archived = await archive(true);
    expect(archived.status).toBe(200);
    expect((await json<{ post: { state: string } }>(archived)).post.state).toBe("archived");
    await expectModuleLimit(await archive(false), "updates");
    await expectModuleLimit(await archive("true"), "updates");
    // A change to the document is still refused.
    await expectModuleLimit(
      await send("acme", "PATCH", `/api/v1/data-room/documents/${documentId}`, owner, {
        title: "Renamed",
      }),
      "data-room",
    );
  });

  it('answers "on" for a module that already is with success, even outside the plan (R2 L4)', async () => {
    // `updates` is on by default and outside `none`: nothing turns on, so nothing is refused —
    // and nothing is audited either (decision 21).
    const events = await enablementEvents("acme", "updates");
    const res = await send("acme", "PATCH", "/api/v1/modules/updates", owner, { enabled: true });
    expect(res.status).toBe(200);
    expect(await json<Enablement>(res)).toMatchObject({
      enabled: true,
      planAllows: false,
      readOnly: true,
    });
    expect(await enablementEvents("acme", "updates")).toBe(events);
  });

  it("tells staff in the bootstrap, and investors and signed-out callers nothing", async () => {
    const staff = await bootstrap("acme", owner);
    const ro = Object.fromEntries(staff.modules.map((m) => [m.id, m.readOnly]));
    expect(ro).toMatchObject({ crm: true, updates: true, "data-room": true, content: false });
    expect(staff.entitlements).toEqual({ modules: [], features: [] });
    for (const who of [investor, undefined]) {
      const b = await bootstrap("acme", who);
      expect(b.modules.every((m) => !m.readOnly)).toBe(true);
      expect("entitlements" in b).toBe(false);
    }
  });

  it("sees a plan change on the next request, with nothing invalidated", async () => {
    await assignPlan("acme", "full", false);
    const created = await send("acme", "POST", "/api/v1/crm/contacts", owner, contact("Cy"));
    expect(created.status).toBe(201);
    contactCount++;
    expect((await bootstrap("acme", owner)).entitlements).toEqual({
      modules: null,
      features: null,
    });
    expect((await enablement("acme", owner)).get("crm")).toMatchObject({ readOnly: false });
    await assignPlan("acme", "none", false);
    await expectModuleLimit(
      await send("acme", "POST", "/api/v1/crm/contacts", owner, contact("Dee")),
      "crm",
    );
  });

  it('decides "already on" from the stored row, not this process\'s cache (decision 15)', async () => {
    // This process's cache says crm is on...
    expect((await enablement("acme", owner)).get("crm")?.enabled).toBe(true);
    // ...when another instance switches it off (its invalidation does not reach this process).
    const ctx = systemContext(ids["acme"] as string);
    await running.container.db.withTenant(ctx, (tx) =>
      tx.execute("UPDATE core.module_enablement SET enabled = false WHERE module = 'crm'"),
    );
    await expectModuleLimit(
      await send("acme", "PATCH", "/api/v1/modules/crm", owner, { enabled: true }),
      "crm",
    );
    const stored = await running.container.db.withTenant(ctx, async (tx) => {
      const r = await tx.execute("SELECT enabled FROM core.module_enablement WHERE module = 'crm'");
      return (r.rows[0] as { enabled: boolean }).enabled;
    });
    expect(stored).toBe(false);
    // The same for a default-on module that has no row until the other instance writes "off".
    expect((await enablement("acme", owner)).get("updates")?.enabled).toBe(true);
    await running.container.db.withTenant(ctx, (tx) =>
      tx.execute(
        `INSERT INTO core.module_enablement (workspace_id, module, enabled)
           VALUES ('${ids["acme"]}', 'updates', false)
         ON CONFLICT (workspace_id, module) DO UPDATE SET enabled = false`,
      ),
    );
    await expectModuleLimit(
      await send("acme", "PATCH", "/api/v1/modules/updates", owner, { enabled: true }),
      "updates",
    );
    // Put both back as they were for the next tests (the cache never saw them go).
    await running.container.db.withTenant(ctx, async (tx) => {
      await tx.execute("UPDATE core.module_enablement SET enabled = true WHERE module = 'crm'");
      await tx.execute("DELETE FROM core.module_enablement WHERE module = 'updates'");
    });
  });

  it("can be switched off, and is then refused when switched back on", async () => {
    const off = await send("acme", "PATCH", "/api/v1/modules/crm", owner, { enabled: false });
    expect(off.status).toBe(200);
    expect(await json<Enablement>(off)).toMatchObject({
      enabled: false,
      readOnly: false,
      locked: true,
      lockedReason: "plan",
    });
    expect((await send("acme", "GET", "/api/v1/crm/contacts", owner)).status).toBe(404);
    await expectModuleLimit(
      await send("acme", "PATCH", "/api/v1/modules/crm", owner, { enabled: true }),
      "crm",
    );
  });
});

describe("no gating", () => {
  it("for a workspace without a plan, even with CONTROL_PLANE=on", async () => {
    const on = await send("free", "PATCH", "/api/v1/modules/crm", freeOwner, { enabled: true });
    expect(on.status).toBe(200);
    const created = await send("free", "POST", "/api/v1/crm/contacts", freeOwner, contact("Fay"));
    expect(created.status).toBe(201);
    const b = await bootstrap("free", freeOwner);
    expect(b.entitlements).toEqual({ modules: null, features: null });
    expect(b.modules.every((m) => !m.readOnly)).toBe(true);
  });

  it("with CONTROL_PLANE=off, even for a workspace whose plan allows nothing", async () => {
    // A second server on the same database: only the switch differs.
    const off = await startServer({
      config: configFor(false),
      logger: createLogger({ level: "error" }),
      mailer,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    try {
      const list = await enablement("acme", owner, off);
      for (const m of list.values())
        expect(m, m.id).toMatchObject({ planAllows: true, readOnly: false });
      const on = await send("acme", "PATCH", "/api/v1/modules/crm", owner, { enabled: true }, off);
      expect(on.status).toBe(200);
      const created = await send(
        "acme",
        "POST",
        "/api/v1/crm/contacts",
        owner,
        contact("Gus"),
        off,
      );
      expect(created.status).toBe(201);
      const b = await bootstrap("acme", owner, off);
      expect(b.entitlements).toEqual({ modules: null, features: null });
      expect(b.modules.every((m) => !m.readOnly)).toBe(true);
    } finally {
      await off.stop();
    }
    // The other process switched crm back on: drop this one's enablement cache, as a deployment
    // would within its TTL. Back on the control-plane server the workspace is read-only again.
    running.container.enablement.invalidate(ids["acme"] as string);
    await expectModuleLimit(
      await send("acme", "POST", "/api/v1/crm/contacts", owner, contact("Hal")),
      "crm",
    );
  });
});
