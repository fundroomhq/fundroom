import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { checkRlsCatalog, createWorkspace, systemContext, type TenantContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { EventTopic } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { DEFAULT_STAGE_KEYS } from "@fundroom/module-crm";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * CRM-lite end to end (E2.5 §C): a module that is **off** by default → a stage ladder seeded
 * lazily on the first read rather than by the migration → contacts that are not logins, linked
 * to a membership and defaulted from it → search over a generated `tsvector` → a board whose
 * every move writes a `crm.stage_transition` row and an audit event carrying the two stage keys
 * → the ladder editor's three refusals → the four outbox subscribers, driven by publishing real
 * `round.*` events, including the redelivery that must write nothing the second time → and the
 * access model, which is staff-only twice over: `crm.read`/`crm.manage` at the route and no
 * external arm in any RLS policy underneath.
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

/**
 * Enrols a TOTP credential, which is what an owner or an admin needs before `requirePermission`
 * will look at their permissions at all: `assertAuthLevel` sits ahead of the RBAC check in the
 * chain, and the workspace's policy asks the two privileged staff roles for a second factor. No
 * CRM route declares `+fresh`, so this is enrolment only — the step-up ceremony itself has its
 * own tests in identity's suite.
 */
const totpSecrets = new Map<string, string>();
const totpStep = new Map<string, number>();
const stepOf = () => Math.floor(Date.now() / 30_000);

async function freshTotp(email: string): Promise<string> {
  const secret = totpSecrets.get(email);
  if (secret === undefined) throw new Error(`no TOTP secret for ${email}`);
  while (stepOf() <= (totpStep.get(email) ?? -1)) await new Promise((r) => setTimeout(r, 500));
  totpStep.set(email, stepOf());
  return new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret) }).generate();
}

async function enrolMfa(slug: string, email: string, cookie: string): Promise<string> {
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  totpSecrets.set(email, secretBase32);
  const confirm = await request(slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: await freshTotp(email) }),
  });
  expect(confirm.status).toBe(200);
  // Step-up rotates the session token (F-12): carry the new cookie on.
  return withSetCookies(cookie, confirm);
}

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  displayName: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "editor" | "viewer" | "finance" | "legal" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (role === "owner" || role === "admin")
    actor.cookie = await enrolMfa(slug, email, actor.cookie);
  return actor;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out");
}

/** Rows read as the `system` actor of a workspace (RLS admits staff and system on crm.*). */
async function rows<T>(query: string, workspaceId?: string): Promise<T[]> {
  const ctx = systemContext(workspaceId ?? acmeId);
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

/**
 * Rows read as a specific *external* membership: exactly what RLS lets that investor see.
 *
 * This is the half a TypeScript filter cannot stand in for. The routes refuse an investor with
 * a 404, but a bug in `routes.ts` is not the failure mode worth worrying about — a policy that
 * was never written is, and only a query run as the investor can tell the difference.
 */
async function rowsAsExternal<T>(membershipId: string, query: string): Promise<T[]> {
  const ctx: TenantContext = { workspaceId: acmeId, actorKind: "external", membershipId };
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

/** Publishes a real `round.*` event into the workspace's outbox, the way the round module does. */
async function announce(
  topic: EventTopic,
  payload: Record<string, unknown>,
  workspaceId?: string,
): Promise<void> {
  const ctx = systemContext(workspaceId ?? acmeId);
  await running.container.db.withTenant(ctx, (tx) => publish(tx, ctx, topic, payload as never));
}

interface StageBody {
  id: string;
  key: string;
  name: string;
  position: number;
  isTerminal: boolean;
}
interface StageList {
  stages: StageBody[];
}
interface ContactBody {
  id: string;
  displayName: string;
  email: string | null;
  membershipId: string | null;
  organizationId: string | null;
  tags: string[];
}
interface CardBody {
  id: string;
  roundId: string | null;
  stageId: string;
  stageKey: string | null;
  stageName?: string | null;
  amount: string | null;
  commitmentId: string | null;
  position: number;
}
interface BoardBody {
  stages: StageBody[];
  items: (CardBody & {
    contact: { id: string; displayName: string; email: string | null } | null;
    organization: { id: string; name: string } | null;
  })[];
}

const codeOf = async (res: Response): Promise<string> =>
  (await json<{ error: { code: string } }>(res)).error.code;

const auditRows = async (action: string) =>
  rows<{ meta: Record<string, unknown> | null; resourceId: string | null }>(
    `SELECT meta, resource_id::text AS "resourceId" FROM audit.event
      WHERE action = '${action}' ORDER BY occurred_at`,
  );

const transitionsFor = async (itemId: string) =>
  rows<{ fromStageKey: string | null; toStageKey: string; cause: string }>(
    `SELECT from_stage_key AS "fromStageKey", to_stage_key AS "toStageKey", cause
       FROM crm.stage_transition WHERE pipeline_item_id = '${itemId}'::uuid
      ORDER BY created_at, id`,
  );

let acmeId: string;
let globexId: string;
let owner: Actor;
let editor: Actor;
let viewer: Actor;
let ada: Actor;
let grace: Actor;
let globexOwner: Actor;

/** Two make-believe rounds. The CRM never validates these against the round module (E2.5 D1). */
const ROUND_A = randomUUID();
const ROUND_B = randomUUID();

const ids: Record<string, string> = {};

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
      SPREADSHEET_DRIVER: "noop",
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
  owner = await member("acme", acmeId, "owner@example.com", "Owner", "staff", "owner");
  editor = await member("acme", acmeId, "editor@example.com", "Ed Itor", "staff", "editor");
  viewer = await member("acme", acmeId, "viewer@example.com", "Vi Ewer", "staff", "viewer");
  ada = await member("acme", acmeId, "ada@investor.test", "Ada Lovelace", "external", "investor");
  grace = await member(
    "acme",
    acmeId,
    "grace@investor.test",
    "Grace Hopper",
    "external",
    "investor",
  );
  globexOwner = await member("globex", globexId, "boss@example.org", "Boss", "staff", "owner");
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema, registry and the off-by-default switch", () => {
  it("crm.* tables pass the RLS catalog check", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });

  /*
   * E2.5 §C: an absent `core.module_enablement` row must read as "there is no such thing here".
   * A 403 would tell an unauthorised caller that the feature exists and they merely lack the
   * right, which is the oracle the enablement guard exists to avoid.
   */
  it("is off until a workspace turns it on, and its routes 404 rather than 403 until then", async () => {
    const boot = await json<{ modules: { id: string; enabled: boolean }[] }>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    expect(boot.modules.find((m) => m.id === "crm")?.enabled).toBe(false);

    for (const path of ["/api/v1/crm/stages", "/api/v1/crm/contacts", "/api/v1/crm/pipeline"]) {
      const res = await request("acme", path, { cookie: owner.cookie });
      expect(res.status, path).toBe(404);
      expect(await codeOf(res)).toBe("module_disabled");
    }
    // Nothing was seeded while the module was off.
    expect(await rows(`SELECT 1 FROM crm.pipeline_stage`)).toEqual([]);

    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) =>
      new ModuleEnablementRepo(ctx, tx).set("crm", true),
    );
    running.container.enablement.invalidate(acmeId);
    expect((await request("acme", "/api/v1/crm/stages", { cookie: owner.cookie })).status).toBe(
      200,
    );

    const after = await json<{ modules: { id: string; slots: Record<string, unknown[]> }[] }>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    const mod = after.modules.find((m) => m.id === "crm");
    expect(mod?.slots["admin.nav"]).toHaveLength(1);
    expect(mod?.slots["investor.nav"]).toBeUndefined();
  });

  it("registers its two permissions and hands them to an editor but not to an investor", async () => {
    expect(running.container.registry.permissions.has("crm.read")).toBe(true);
    expect(running.container.registry.permissions.has("crm.manage")).toBe(true);
    const staff = await json<{ permissions: string[] }>(
      await request("acme", "/api/v1/modules", { cookie: editor.cookie }),
    );
    expect(staff.permissions).toEqual(expect.arrayContaining(["crm.read", "crm.manage"]));
    const investor = await json<{ permissions: string[] }>(
      await request("acme", "/api/v1/modules", { cookie: ada.cookie }),
    );
    expect(investor.permissions).not.toContain("crm.read");
  });
});

describe("the stage ladder", () => {
  it("seeds the ten defaults on the first read, with wired and passed terminal", async () => {
    const body = await json<StageList>(
      await request("acme", "/api/v1/crm/stages", { cookie: viewer.cookie }),
    );
    expect(body.stages.map((s) => s.key)).toEqual([...DEFAULT_STAGE_KEYS]);
    expect(body.stages.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(body.stages.filter((s) => s.isTerminal).map((s) => s.key)).toEqual(["wired", "passed"]);
    for (const stage of body.stages) ids[`stage:${stage.key}`] = stage.id;

    // Seeded once. A second read must not write a second ladder.
    await request("acme", "/api/v1/crm/stages", { cookie: viewer.cookie });
    const stored = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM crm.pipeline_stage`);
    expect(stored[0]?.n).toBe(10);
  });

  it("renames, reorders and adds a stage, keeping ids and renumbering 1..n", async () => {
    const before = await json<StageList>(
      await request("acme", "/api/v1/crm/stages", { cookie: owner.cookie }),
    );
    const entries = before.stages.map((s) => ({
      id: s.id,
      name: s.key === "soft_committed" ? "Circled" : s.name,
      isTerminal: s.isTerminal,
    }));
    // Move "Meeting" to the front and add a custom stage at the end.
    const meeting = entries.find((e) => e.id === ids["stage:meeting"]);
    if (meeting === undefined) throw new Error("no meeting stage");
    const reordered = [meeting, ...entries.filter((e) => e !== meeting)];
    const res = await request("acme", "/api/v1/crm/stages", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ stages: [...reordered, { name: "IC review", isTerminal: false }] }),
    });
    expect(res.status).toBe(200);
    const after = await json<StageList>(res);
    expect(after.stages[0]?.key).toBe("meeting");
    expect(after.stages[0]?.position).toBe(1);
    expect(after.stages.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // A rename keeps the key: the handlers address `soft_committed` by it.
    expect(after.stages.find((s) => s.key === "soft_committed")?.name).toBe("Circled");
    expect(after.stages.at(-1)).toMatchObject({ key: "custom_ic_review", name: "IC review" });
    ids["stage:custom_ic_review"] = after.stages.at(-1)?.id ?? "";

    const audit = await auditRows("crm.stages_replaced");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.meta?.["stages"]).toBe(11);
    expect(audit[0]?.meta?.["keys"]).toContain("custom_ic_review");
  });

  it("refuses to remove a seeded terminal stage", async () => {
    const before = await json<StageList>(
      await request("acme", "/api/v1/crm/stages", { cookie: owner.cookie }),
    );
    const res = await request("acme", "/api/v1/crm/stages", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({
        stages: before.stages
          .filter((s) => s.key !== "passed")
          .map((s) => ({ id: s.id, name: s.name, isTerminal: s.isTerminal })),
      }),
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: { code: string; reason: string } }>(res);
    expect(body.error.code).toBe("conflict");
    expect(body.error.reason).toBe("stage_protected");
  });

  it("refuses two stages claiming one key", async () => {
    const res = await request("acme", "/api/v1/crm/stages", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({
        stages: [
          { key: "custom_dup", name: "One", isTerminal: false },
          { key: "custom_dup", name: "Two", isTerminal: false },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("validation_failed");
  });
});

describe("organisations and contacts", () => {
  it("creates an organisation, finds it by name and refuses a duplicate", async () => {
    const created = await request("acme", "/api/v1/crm/organizations", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ name: "Acme Ventures", domain: "AcmeVC.com", kind: "fund" }),
    });
    expect(created.status).toBe(201);
    const org = await json<{ id: string; domain: string; kind: string }>(created);
    ids["org"] = org.id;
    expect(org.kind).toBe("fund");

    const listed = await json<{ items: { id: string; name: string }[]; nextCursor: string | null }>(
      await request("acme", "/api/v1/crm/organizations?q=acme%20vent", { cookie: viewer.cookie }),
    );
    expect(listed.items.map((o) => o.id)).toEqual([org.id]);
    expect(listed.nextCursor).toBeNull();

    // The partial unique index is on `lower(name)` among live rows.
    const again = await request("acme", "/api/v1/crm/organizations", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ name: "acme ventures" }),
    });
    expect(again.status).toBe(409);
    expect((await json<{ error: { reason: string } }>(again)).error.reason).toBe("duplicate_name");
  });

  it("links a contact to a member and defaults the name and email from them", async () => {
    const res = await request("acme", "/api/v1/crm/contacts", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ membershipId: ada.membershipId, organizationId: ids["org"] }),
    });
    expect(res.status).toBe(201);
    const contact = await json<ContactBody>(res);
    ids["contact:ada"] = contact.id;
    expect(contact.displayName).toBe("Ada Lovelace");
    expect(contact.email).toBe("ada@investor.test");
    expect(contact.membershipId).toBe(ada.membershipId);

    // The CRM's copy is its own from then on: editing it must not touch identity.
    const patched = await json<ContactBody>(
      await request("acme", `/api/v1/crm/contacts/${contact.id}`, {
        method: "PATCH",
        cookie: editor.cookie,
        body: JSON.stringify({ displayName: "A. Lovelace", tags: ["warm", "board"] }),
      }),
    );
    expect(patched.displayName).toBe("A. Lovelace");
    expect(patched.tags).toEqual(["warm", "board"]);
    const identity = await rows<{ displayName: string }>(
      `SELECT u.display_name AS "displayName" FROM core."user" u
         JOIN core.membership m ON m.user_id = u.id
        WHERE m.id = '${ada.membershipId}'::uuid`,
    );
    expect(identity[0]?.displayName).toBe("Ada Lovelace");
  });

  it("refuses a second contact for the same member, and a member of another workspace", async () => {
    const duplicate = await request("acme", "/api/v1/crm/contacts", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ displayName: "Ada again", membershipId: ada.membershipId }),
    });
    expect(duplicate.status).toBe(409);
    expect((await json<{ error: { reason: string } }>(duplicate)).error.reason).toBe(
      "membership_linked",
    );

    const foreign = await request("acme", "/api/v1/crm/contacts", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ displayName: "Somebody", membershipId: globexOwner.membershipId }),
    });
    expect(foreign.status).toBe(400);
    expect(await codeOf(foreign)).toBe("validation_failed");
  });

  it("searches by whole word, by prefix and by tag, and pages on a cursor", async () => {
    for (const name of ["Barbara Liskov", "Alan Kay", "Edsger Dijkstra"]) {
      const res = await request("acme", "/api/v1/crm/contacts", {
        method: "POST",
        cookie: editor.cookie,
        body: JSON.stringify({ displayName: name, email: `${name.split(" ")[1]}@vc.test` }),
      });
      expect(res.status).toBe(201);
      ids[`contact:${name}`] = (await json<{ id: string }>(res)).id;
    }
    const whole = await json<{ items: ContactBody[] }>(
      await request("acme", "/api/v1/crm/contacts?q=Liskov", { cookie: viewer.cookie }),
    );
    expect(whole.items.map((c) => c.displayName)).toEqual(["Barbara Liskov"]);

    // `plainto_tsquery('simple', 'lisk')` matches nothing; the ILIKE arm is what answers while
    // somebody is still typing.
    const prefix = await json<{ items: ContactBody[] }>(
      await request("acme", "/api/v1/crm/contacts?q=lisk", { cookie: viewer.cookie }),
    );
    expect(prefix.items.map((c) => c.displayName)).toEqual(["Barbara Liskov"]);

    const tagged = await json<{ items: ContactBody[] }>(
      await request("acme", "/api/v1/crm/contacts?tag=board", { cookie: viewer.cookie }),
    );
    expect(tagged.items.map((c) => c.id)).toEqual([ids["contact:ada"]]);

    const first = await json<{ items: ContactBody[]; nextCursor: string | null }>(
      await request("acme", "/api/v1/crm/contacts?limit=2", { cookie: viewer.cookie }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items.at(-1)?.id);
    const second = await json<{ items: ContactBody[]; nextCursor: string | null }>(
      await request("acme", `/api/v1/crm/contacts?limit=2&cursor=${first.nextCursor}`, {
        cookie: viewer.cookie,
      }),
    );
    expect(second.items.map((c) => c.id)).not.toContain(first.items[0]?.id);
    expect(
      (await request("acme", "/api/v1/crm/contacts?limit=500", { cookie: viewer.cookie })).status,
    ).toBe(400);
  });
});

describe("the board", () => {
  it("creates a card, moves it, and records the move twice over", async () => {
    const created = await request("acme", "/api/v1/crm/pipeline", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({
        roundId: ROUND_A,
        contactId: ids["contact:Barbara Liskov"],
        organizationId: ids["org"],
        stageKey: "prospect",
        amount: "250000",
        currency: "USD",
      }),
    });
    expect(created.status).toBe(201);
    const card = await json<CardBody>(created);
    ids["card:liskov"] = card.id;
    expect(card.stageKey).toBe("prospect");
    expect(card.amount).toBe("250000.000000");

    const moved = await request("acme", `/api/v1/crm/pipeline/${card.id}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ stageKey: "diligence", amount: "300000" }),
    });
    expect(moved.status).toBe(200);
    expect((await json<CardBody>(moved)).stageKey).toBe("diligence");

    const history = await transitionsFor(card.id);
    expect(history).toEqual([
      { fromStageKey: null, toStageKey: "prospect", cause: "staff" },
      { fromStageKey: "prospect", toStageKey: "diligence", cause: "staff" },
    ]);

    const audit = await auditRows("crm.pipeline_item_moved");
    const mine = audit.filter((a) => a.resourceId === card.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.meta).toEqual({ from: "prospect", to: "diligence", cause: "staff" });
  });

  it("writes nothing when a card is moved to the stage it is already in", async () => {
    const id = ids["card:liskov"] ?? "";
    const before = await transitionsFor(id);
    const res = await request("acme", `/api/v1/crm/pipeline/${id}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ stageKey: "diligence" }),
    });
    expect(res.status).toBe(200);
    expect(await transitionsFor(id)).toEqual(before);
  });

  it("filters the board by round, including the `none` sentinel", async () => {
    const loose = await request("acme", "/api/v1/crm/pipeline", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ organizationId: ids["org"], stageKey: "prospect" }),
    });
    expect(loose.status).toBe(201);
    ids["card:loose"] = (await json<{ id: string }>(loose)).id;

    const all = await json<BoardBody>(
      await request("acme", "/api/v1/crm/pipeline", { cookie: viewer.cookie }),
    );
    expect(all.items.map((i) => i.id).sort()).toEqual(
      [ids["card:liskov"], ids["card:loose"]].sort(),
    );
    expect(all.stages).toHaveLength(11);

    const byRound = await json<BoardBody>(
      await request("acme", `/api/v1/crm/pipeline?roundId=${ROUND_A}`, { cookie: viewer.cookie }),
    );
    expect(byRound.items.map((i) => i.id)).toEqual([ids["card:liskov"]]);
    expect(byRound.items[0]?.contact?.displayName).toBe("Barbara Liskov");
    expect(byRound.items[0]?.organization?.name).toBe("Acme Ventures");
    expect(byRound.items[0]?.stageKey).toBe("diligence");

    const noRound = await json<BoardBody>(
      await request("acme", "/api/v1/crm/pipeline?roundId=none", { cookie: viewer.cookie }),
    );
    expect(noRound.items.map((i) => i.id)).toEqual([ids["card:loose"]]);
    expect(noRound.items[0]?.contact).toBeNull();
  });

  it("refuses to remove a stage that still holds a live card, and allows it once the card moves", async () => {
    const stages = await json<StageList>(
      await request("acme", "/api/v1/crm/stages", { cookie: owner.cookie }),
    );
    const without = (key: string) =>
      stages.stages
        .filter((s) => s.key !== key)
        .map((s) => ({ id: s.id, name: s.name, isTerminal: s.isTerminal }));

    const refused = await request("acme", "/api/v1/crm/stages", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ stages: without("diligence") }),
    });
    expect(refused.status).toBe(409);
    const body = await json<{ error: { reason: string; key: string; items: number } }>(refused);
    expect(body.error).toMatchObject({ reason: "stage_in_use", key: "diligence", items: 1 });

    // The custom stage nothing sits in comes out cleanly, and its cards' history is untouched.
    const allowed = await request("acme", "/api/v1/crm/stages", {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ stages: without("custom_ic_review") }),
    });
    expect(allowed.status).toBe(200);
    expect((await json<StageList>(allowed)).stages.map((s) => s.key)).not.toContain(
      "custom_ic_review",
    );
    expect(await transitionsFor(ids["card:liskov"] ?? "")).toHaveLength(2);
  });

  it("gathers a contact's organisation, notes, tasks and cards on one screen", async () => {
    const contactId = ids["contact:Barbara Liskov"] ?? "";
    const note = await request("acme", "/api/v1/crm/notes", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({
        subjectKind: "contact",
        subjectId: contactId,
        body: "Passed last time; thinks the cap is rich.",
      }),
    });
    expect(note.status).toBe(201);
    ids["note"] = (await json<{ id: string }>(note)).id;

    const task = await request("acme", "/api/v1/crm/tasks", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({
        subjectKind: "contact",
        subjectId: contactId,
        title: "Send the deck",
        dueAt: "2026-10-01T09:00:00.000Z",
        assigneeMembershipId: editor.membershipId,
      }),
    });
    expect(task.status).toBe(201);
    ids["task"] = (await json<{ id: string }>(task)).id;

    const detail = await json<{
      contact: ContactBody;
      organization: { id: string; name: string } | null;
      notes: { id: string; body: string }[];
      tasks: { id: string; title: string; doneAt: string | null }[];
      items: CardBody[];
    }>(await request("acme", `/api/v1/crm/contacts/${contactId}`, { cookie: viewer.cookie }));
    expect(detail.contact.id).toBe(contactId);
    expect(detail.organization).toBeNull();
    expect(detail.notes.map((n) => n.id)).toEqual([ids["note"]]);
    expect(detail.tasks.map((t) => t.id)).toEqual([ids["task"]]);
    expect(detail.items.map((i) => i.id)).toEqual([ids["card:liskov"]]);
    expect(detail.items[0]?.stageKey).toBe("diligence");
    expect(detail.items[0]?.stageName).toBe("Diligence");

    const done = await json<{ doneAt: string | null }>(
      await request("acme", `/api/v1/crm/tasks/${ids["task"]}`, {
        method: "PATCH",
        cookie: editor.cookie,
        body: JSON.stringify({ done: true }),
      }),
    );
    expect(done.doneAt).not.toBeNull();
    expect(
      (
        await request("acme", `/api/v1/crm/notes/${ids["note"]}`, {
          method: "DELETE",
          cookie: editor.cookie,
        })
      ).status,
    ).toBe(200);
    const afterDelete = await json<{ notes: unknown[] }>(
      await request("acme", `/api/v1/crm/contacts/${contactId}`, { cookie: viewer.cookie }),
    );
    expect(afterDelete.notes).toEqual([]);
  });

  /*
   * §C is explicit: never emails, names or note bodies in audit meta. `audit.event` is the one
   * table exported wholesale to counsel and kept for six years, and a CRM note is the most
   * candid prose in the product.
   */
  it("keeps every name, email and note body out of the audit trail", async () => {
    const trail = await rows<{ action: string; meta: unknown }>(
      `SELECT action, meta FROM audit.event WHERE action LIKE 'crm.%'`,
    );
    expect(trail.length).toBeGreaterThan(8);
    const text = JSON.stringify(trail.map((r) => r.meta));
    for (const secret of [
      "@",
      "Lovelace",
      "Liskov",
      "Acme Ventures",
      "cap is rich",
      "Send the deck",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });
});

describe("the outbox subscribers", () => {
  const cardForContact = async (contactId: string, roundId: string) =>
    (
      await rows<{ id: string; stageId: string; commitmentId: string | null }>(
        `SELECT id::text AS id, stage_id::text AS "stageId", commitment_id::text AS "commitmentId"
           FROM crm.pipeline_item
          WHERE contact_id = '${contactId}'::uuid AND round_id = '${roundId}'::uuid
            AND deleted_at IS NULL`,
      )
    )[0];

  const contactForMember = async (membershipId: string, workspaceId?: string) =>
    (
      await rows<{ id: string; displayName: string; email: string | null }>(
        `SELECT id::text AS id, display_name AS "displayName", email::text AS email
           FROM crm.contact WHERE membership_id = '${membershipId}'::uuid AND deleted_at IS NULL`,
        workspaceId,
      )
    )[0];

  it("makes a contact and a card in Contacted when a member indicates interest", async () => {
    await announce("round.interest_submitted", {
      submissionId: randomUUID(),
      roundId: ROUND_B,
      membershipId: grace.membershipId,
    });
    const contact = await waitFor(() => contactForMember(grace.membershipId));
    // The name and the email came from `MembershipRepo.person`, not from the event.
    expect(contact.displayName).toBe("Grace Hopper");
    expect(contact.email).toBe("grace@investor.test");
    ids["contact:grace"] = contact.id;

    const card = await waitFor(() => cardForContact(contact.id, ROUND_B));
    ids["card:grace"] = card.id;
    const history = await transitionsFor(card.id);
    expect(history).toEqual([
      { fromStageKey: null, toStageKey: "contacted", cause: "interest_submitted" },
    ]);
  });

  it("is idempotent: a redelivered interest event makes no second card and no second history row", async () => {
    await announce("round.interest_submitted", {
      submissionId: randomUUID(),
      roundId: ROUND_B,
      membershipId: grace.membershipId,
    });
    // Nothing to wait *for*, so wait for the outbox to have drained past this event instead.
    await waitFor(async () => {
      const pending = await running.container.db.withHost(async (tx) => {
        const r = await tx.execute(
          `SELECT count(*)::int AS n FROM core.outbox WHERE topic = 'round.interest_submitted' AND processed_at IS NULL`,
        );
        return (r.rows as { n: number }[])[0]?.n ?? 0;
      });
      return pending === 0 ? true : undefined;
    });
    const cards = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM crm.pipeline_item
        WHERE contact_id = '${ids["contact:grace"]}'::uuid AND deleted_at IS NULL`,
    );
    expect(cards[0]?.n).toBe(1);
    expect(await transitionsFor(ids["card:grace"] ?? "")).toHaveLength(1);
  });

  it("links a commitment and moves the card to Soft-committed", async () => {
    const commitmentId = randomUUID();
    ids["commitment"] = commitmentId;
    await announce("round.commitment_created", {
      commitmentId,
      roundId: ROUND_B,
      membershipId: grace.membershipId,
    });
    await waitFor(async () => {
      const card = await cardForContact(ids["contact:grace"] ?? "", ROUND_B);
      return card?.commitmentId === commitmentId ? card : undefined;
    });
    const history = await transitionsFor(ids["card:grace"] ?? "");
    expect(history.at(-1)).toEqual({
      fromStageKey: "contacted",
      toStageKey: "soft_committed",
      cause: "commitment_created",
    });
  });

  it("maps a commitment status onto a stage, and ignores a repeat of the same status", async () => {
    await announce("round.commitment_changed", {
      commitmentId: ids["commitment"] ?? "",
      roundId: ROUND_B,
      status: "wired",
    });
    await waitFor(async () => {
      const history = await transitionsFor(ids["card:grace"] ?? "");
      return history.at(-1)?.toStageKey === "wired" ? history : undefined;
    });
    const afterFirst = (await transitionsFor(ids["card:grace"] ?? "")).length;
    expect((await transitionsFor(ids["card:grace"] ?? "")).at(-1)?.cause).toBe(
      "commitment_changed",
    );

    await announce("round.commitment_changed", {
      commitmentId: ids["commitment"] ?? "",
      roundId: ROUND_B,
      status: "wired",
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await transitionsFor(ids["card:grace"] ?? "")).toHaveLength(afterFirst);
  });

  it("sends a declined interest submission to Passed", async () => {
    await announce("round.interest_decided", {
      submissionId: randomUUID(),
      roundId: ROUND_B,
      membershipId: grace.membershipId,
      decision: "declined",
    });
    const history = await waitFor(async () => {
      const rowsOut = await transitionsFor(ids["card:grace"] ?? "");
      return rowsOut.at(-1)?.toStageKey === "passed" ? rowsOut : undefined;
    });
    expect(history.at(-1)?.cause).toBe("interest_decided");
  });

  /*
   * A workspace that never switched the CRM on must not acquire CRM rows because somebody
   * indicated interest in a round. Globex has the module off throughout this suite.
   */
  it("does nothing at all for a workspace with the CRM switched off", async () => {
    await announce(
      "round.interest_submitted",
      {
        submissionId: randomUUID(),
        roundId: randomUUID(),
        membershipId: globexOwner.membershipId,
      },
      globexId,
    );
    await new Promise((r) => setTimeout(r, 2000));
    expect(await rows(`SELECT 1 FROM crm.contact`, globexId)).toEqual([]);
    expect(await rows(`SELECT 1 FROM crm.pipeline_stage`, globexId)).toEqual([]);
  });
});

describe("who may see any of this", () => {
  it("answers an investor with 404 on every route, never 403", async () => {
    for (const path of [
      "/api/v1/crm/stages",
      "/api/v1/crm/contacts",
      "/api/v1/crm/organizations",
      "/api/v1/crm/pipeline",
      `/api/v1/crm/contacts/${ids["contact:ada"]}`,
    ]) {
      const res = await request("acme", path, { cookie: ada.cookie });
      expect(res.status, path).toBe(404);
      expect(await codeOf(res), path).toBe("not_found");
    }
    const write = await request("acme", "/api/v1/crm/organizations", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ name: "Investor Co" }),
    });
    expect(write.status).toBe(404);
  });

  it("lets a viewer read and refuses every write with 403", async () => {
    expect((await request("acme", "/api/v1/crm/contacts", { cookie: viewer.cookie })).status).toBe(
      200,
    );
    const writes: [string, string, unknown][] = [
      ["POST", "/api/v1/crm/organizations", { name: "Viewer Co" }],
      ["POST", "/api/v1/crm/contacts", { displayName: "Nobody" }],
      ["POST", "/api/v1/crm/pipeline", { organizationId: ids["org"], stageKey: "prospect" }],
      ["PUT", "/api/v1/crm/stages", { stages: [{ name: "Only", isTerminal: false }] }],
      [
        "POST",
        "/api/v1/crm/notes",
        { subjectKind: "contact", subjectId: ids["contact:ada"], body: "no" },
      ],
    ];
    for (const [method, path, body] of writes) {
      const res = await request("acme", path, {
        method,
        cookie: viewer.cookie,
        body: JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await codeOf(res)).toBe("forbidden");
    }
  });

  /*
   * The row-security half. Every policy in the `crm` schema admits staff and system and no
   * third arm; a test that only drove the routes would pass on a build whose policies had been
   * dropped.
   */
  it("shows an external actor no crm row of any kind", async () => {
    for (const table of [
      "crm.organization",
      "crm.contact",
      "crm.pipeline_stage",
      "crm.pipeline_item",
      "crm.note",
      "crm.task",
      "crm.stage_transition",
    ]) {
      expect(await rowsAsExternal(ada.membershipId, `SELECT 1 FROM ${table}`), table).toEqual([]);
    }
    // And the rows are really there for staff.
    expect((await rows(`SELECT 1 FROM crm.contact`)).length).toBeGreaterThan(0);
  });

  it("answers 404 for another workspace's ids rather than leaking their existence", async () => {
    const ctx = systemContext(globexId);
    await running.container.db.withTenant(ctx, (tx) =>
      new ModuleEnablementRepo(ctx, tx).set("crm", true),
    );
    running.container.enablement.invalidate(globexId);
    try {
      for (const path of [
        `/api/v1/crm/contacts/${ids["contact:ada"]}`,
        `/api/v1/crm/organizations/${ids["org"]}`,
      ]) {
        const res = await request("globex", path, { cookie: globexOwner.cookie });
        expect(res.status, path).toBe(404);
        expect(await codeOf(res)).toBe("not_found");
      }
      const move = await request("globex", `/api/v1/crm/pipeline/${ids["card:liskov"]}`, {
        method: "PATCH",
        cookie: globexOwner.cookie,
        body: JSON.stringify({ stageKey: "passed" }),
      });
      expect(move.status).toBe(404);
      // Globex seeded its own ladder by reading; Acme's card did not move.
      const acmeCard = await rows<{ stageId: string }>(
        `SELECT stage_id::text AS "stageId" FROM crm.pipeline_item WHERE id = '${ids["card:liskov"]}'::uuid`,
      );
      expect(acmeCard[0]?.stageId).toBe(ids["stage:diligence"]);
    } finally {
      await running.container.db.withTenant(ctx, (tx) =>
        new ModuleEnablementRepo(ctx, tx).set("crm", false),
      );
      running.container.enablement.invalidate(globexId);
    }
  });
});

/*
 * E2.6 DSAR erasure, driven through the real outbox: the kernel publishes
 * `member.erasure_requested`, and this module pseudonymises and detaches the member's contact,
 * deletes what staff wrote about them, and keeps the board — the cards and their stage history
 * are the workspace's record of its raise, and after this they name "Erased contact".
 */
describe("DSAR erasure (E2.6)", () => {
  const announceIn = async (
    workspaceId: string,
    topic: EventTopic,
    payload: Record<string, unknown>,
  ) => {
    const ctx = systemContext(workspaceId);
    await running.container.db.withTenant(ctx, (tx) => publish(tx, ctx, topic, payload as never));
  };

  const drained = async (topic: EventTopic) => {
    await waitFor(async () => {
      const pending = await running.container.db.withHost(async (tx) => {
        const r = await tx.execute(
          `SELECT count(*)::int AS n FROM core.outbox WHERE topic = '${topic}' AND processed_at IS NULL`,
        );
        return (r.rows as { n: number }[])[0]?.n ?? 0;
      });
      return pending === 0 ? true : undefined;
    });
    await new Promise((r) => setTimeout(r, 1_500));
  };

  const contactRow = async (id: string) =>
    (
      await rows<{
        displayName: string;
        email: string | null;
        title: string | null;
        notes: string | null;
        tags: string[];
        membershipId: string | null;
        organizationId: string | null;
      }>(
        `SELECT display_name AS "displayName", email::text AS email, title, notes, tags,
                membership_id::text AS "membershipId", organization_id::text AS "organizationId"
           FROM crm.contact WHERE id = '${id}'::uuid`,
      )
    )[0];

  const requestId = randomUUID();

  it("pseudonymises and detaches the member's contact and deletes what was written about them", async () => {
    const contactId = ids["contact:grace"] ?? "";
    const cardId = ids["card:grace"] ?? "";
    expect(contactId).not.toBe("");
    // Give staff something to have written about Grace: on the contact, and on her card.
    const patched = await request("acme", `/api/v1/crm/contacts/${contactId}`, {
      method: "PATCH",
      cookie: editor.cookie,
      body: JSON.stringify({ title: "Rear Admiral", tags: ["navy"], notes: "Prefers mornings." }),
    });
    expect(patched.status).toBe(200);
    for (const [subjectKind, subjectId, body] of [
      ["contact", contactId, "Grace mentioned her divorce."],
      ["pipeline_item", cardId, "Grace wants pro-rata."],
    ] as const) {
      const note = await request("acme", "/api/v1/crm/notes", {
        method: "POST",
        cookie: editor.cookie,
        body: JSON.stringify({ subjectKind, subjectId, body }),
      });
      expect(note.status).toBe(201);
    }
    const task = await request("acme", "/api/v1/crm/tasks", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ subjectKind: "contact", subjectId: contactId, title: "Call Grace" }),
    });
    expect(task.status).toBe(201);
    // Somebody else's note, which must survive.
    const other = await request("acme", "/api/v1/crm/notes", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({
        subjectKind: "contact",
        subjectId: ids["contact:ada"] ?? "",
        body: "Ada is keen.",
      }),
    });
    expect(other.status).toBe(201);
    // A contact staff typed in by hand before Grace joined: nothing links it to her membership,
    // but it carries her address (in another case) — it is her data all the same. A stranger's
    // hand-made contact must survive.
    const manual = await request("acme", "/api/v1/crm/contacts", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({
        displayName: "G. Hopper (conference)",
        email: "GRACE@Investor.TEST",
        notes: "Met at the navy dinner.",
      }),
    });
    expect(manual.status).toBe(201);
    const manualId = (await json<ContactBody>(manual)).id;
    const stranger = await request("acme", "/api/v1/crm/contacts", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ displayName: "Linus (conference)", email: "linus@kernel.test" }),
    });
    expect(stranger.status).toBe(201);
    const strangerId = (await json<ContactBody>(stranger)).id;
    const historyBefore = await transitionsFor(cardId);
    const cardBefore = (
      await rows<{ stageId: string; contactId: string }>(
        `SELECT stage_id::text AS "stageId", contact_id::text AS "contactId"
           FROM crm.pipeline_item WHERE id = '${cardId}'::uuid`,
      )
    )[0];

    await announceIn(acmeId, "member.erasure_requested", {
      requestId,
      membershipId: grace.membershipId,
    });
    const erased = await waitFor(async () => {
      const row = await contactRow(contactId);
      return row?.displayName === "Erased contact" ? row : undefined;
    });
    expect(erased).toEqual({
      displayName: "Erased contact",
      email: null,
      title: null,
      notes: null,
      tags: [],
      membershipId: null,
      organizationId: null,
    });
    expect(await contactRow(manualId)).toMatchObject({
      displayName: "Erased contact",
      email: null,
      notes: null,
    });
    expect(await contactRow(strangerId)).toMatchObject({
      displayName: "Linus (conference)",
      email: "linus@kernel.test",
    });
    const leftovers = await rows<{ n: number }>(
      `SELECT (SELECT count(*) FROM crm.note
                WHERE (subject_kind = 'contact' AND subject_id = '${contactId}'::uuid)
                   OR (subject_kind = 'pipeline_item' AND subject_id = '${cardId}'::uuid))
            + (SELECT count(*) FROM crm.task
                WHERE subject_kind = 'contact' AND subject_id = '${contactId}'::uuid) AS n`,
    );
    expect(Number(leftovers[0]?.n)).toBe(0);
    // The board is untouched: same card, same stage, same history, now naming a pseudonym.
    const cardAfter = (
      await rows<{ stageId: string; contactId: string }>(
        `SELECT stage_id::text AS "stageId", contact_id::text AS "contactId"
           FROM crm.pipeline_item WHERE id = '${cardId}'::uuid`,
      )
    )[0];
    expect(cardAfter).toEqual(cardBefore);
    expect(await transitionsFor(cardId)).toEqual(historyBefore);
    // Nothing in the store still says "Grace", and Ada's note is still there.
    const mentions = await rows<{ n: number }>(
      `SELECT (SELECT count(*) FROM crm.contact WHERE display_name ILIKE '%grace%' OR email::text ILIKE '%grace%')
            + (SELECT count(*) FROM crm.note WHERE body ILIKE '%grace%')
            + (SELECT count(*) FROM crm.task WHERE title ILIKE '%grace%') AS n`,
    );
    expect(Number(mentions[0]?.n)).toBe(0);
    expect(
      await rows(`SELECT 1 FROM crm.note WHERE body = 'Ada is keen.' AND deleted_at IS NULL`),
    ).toHaveLength(1);
    // The audit row says which contact and which request — never who.
    const trail = await auditRows("crm.contact_erased");
    expect(trail.map((t) => t.resourceId).sort()).toEqual([contactId, manualId].sort());
    for (const t of trail) {
      expect(t.meta).toMatchObject({ requestId, notes: 2, tasks: 1 });
      expect(JSON.stringify(t.meta)).not.toMatch(/grace|@/iu);
    }
  });

  it("is idempotent: a redelivered request erases nothing twice and audits nothing twice", async () => {
    await announceIn(acmeId, "member.erasure_requested", {
      requestId,
      membershipId: grace.membershipId,
    });
    await drained("member.erasure_requested");
    expect(await auditRows("crm.contact_erased")).toHaveLength(2);
  });

  it("leaves no contact linked to the member, so the pseudonym cannot be re-identified by the link", async () => {
    expect(
      await rows(`SELECT 1 FROM crm.contact WHERE membership_id = '${grace.membershipId}'::uuid`),
    ).toEqual([]);
  });

  /*
   * Contract decision 5 (amended): erasure ignores enablement. Acme switches the CRM off with a
   * linked contact still in it (Ada's); a real erasure request, created through the compliance
   * route and published by the kernel, must still pseudonymise her contact and record the step.
   */
  it("erases and records its DSAR step even with the CRM switched off", async () => {
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) =>
      new ModuleEnablementRepo(ctx, tx).set("crm", false),
    );
    running.container.enablement.invalidate(acmeId);
    try {
      const created = await request("acme", "/api/v1/compliance/erasure-requests", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ membershipId: ada.membershipId }),
      });
      expect(created.status).toBe(201);
      const { id } = await json<{ id: string }>(created);
      const step = await waitFor(
        async () =>
          (
            await rows<{ counts: Record<string, number> }>(
              `SELECT counts FROM core.dsar_step WHERE request_id = '${id}'::uuid AND module = 'crm'`,
            )
          )[0],
      );
      expect(step.counts).toMatchObject({ contacts: 1 });
      expect(await contactRow(ids["contact:ada"] ?? "")).toMatchObject({
        displayName: "Erased contact",
        email: null,
        membershipId: null,
      });
    } finally {
      await running.container.db.withTenant(ctx, (tx) =>
        new ModuleEnablementRepo(ctx, tx).set("crm", true),
      );
      running.container.enablement.invalidate(acmeId);
    }
  });

  /*
   * Ada's erasure request (above) is a real, non-cancelled kernel request. A round event about
   * her that was emitted before it and is dispatched after it must not re-create her contact.
   */
  it("drops a round event about an erased member instead of re-creating the contact", async () => {
    await announceIn(acmeId, "round.interest_submitted", {
      submissionId: randomUUID(),
      roundId: ROUND_B,
      membershipId: ada.membershipId,
    });
    await drained("round.interest_submitted");
    expect(
      await rows(`SELECT 1 FROM crm.contact WHERE membership_id = '${ada.membershipId}'::uuid`),
    ).toEqual([]);
    expect(await rows(`SELECT 1 FROM crm.contact WHERE email::text ILIKE 'ada@%'`)).toEqual([]);
  });
});
