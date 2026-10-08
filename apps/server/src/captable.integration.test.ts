import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { checkRlsCatalog, createWorkspace, systemContext, type TenantContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { publish } from "@fundroom/events";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { captableDsar, DEFAULT_DISCLAIMER, ERASED_HOLDER_NAME } from "@fundroom/module-captable";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Cap table end to end (E3.6 §8): off by default → CSV import in three formats (dry-run and import
 * give the same plan) → refusals (bad CSV, over the caps) → email matching against live members
 * only → drafts invisible to investors → step-up on publish → the investor's own lines, proven at
 * the route AND with direct queries as the member (RLS) → investorView summary/none → delegates →
 * a publish race → draft-only delete and immutable rows → DSAR erasure → module off → 404.
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
  if (init.method && init.method !== "GET" && init.cookie)
    headers.set("origin", `http://${slug}.${CANON}`);
  return running.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const codeOf = async (res: Response): Promise<string> =>
  (await json<{ error: { code: string } }>(res)).error.code;

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
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "", email };
}

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
  return withSetCookies(cookie, confirm);
}

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "viewer" | "finance" | "legal" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] ?? email });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (role === "owner" || role === "admin")
    actor.cookie = await enrolMfa(slug, email, actor.cookie);
  return actor;
}

/** A delegate row (core 0017), made directly like the authz sweep does. */
async function delegate(
  email: string,
  principal: Actor,
  scope: "all" | "data_room" | "updates",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] ?? email });
  await rows(
    `INSERT INTO core.membership (workspace_id, user_id, kind, role, status, source,
         principal_membership_id, delegate_scope, activated_at)
       VALUES ('${acmeId}', '${user.userId}', 'external', 'delegate', 'active', 'test',
               '${principal.membershipId}', '${scope}', now())`,
  );
  return signIn("acme", email);
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

async function rows<T>(query: string, workspaceId?: string): Promise<T[]> {
  const ctx = systemContext(workspaceId ?? acmeId);
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

/** Exactly what RLS lets this external membership read. */
async function rowsAsExternal<T>(membershipId: string, query: string): Promise<T[]> {
  const ctx: TenantContext = { workspaceId: acmeId, actorKind: "external", membershipId };
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

/** Stamps the actor's sessions as authenticated `ageMs` ago (what `sessions.stepUp` writes). */
async function markFresh(actor: Actor, ageMs = 0): Promise<void> {
  const [m] = await rows<{ userId: string }>(
    `SELECT user_id::text AS "userId" FROM core.membership WHERE id = '${actor.membershipId}'::uuid`,
  );
  const updated = await running.container.db.withHost(async (tx) => {
    const r = await tx.execute(
      `UPDATE core.session SET auth_time = now() - interval '${ageMs} milliseconds'
         WHERE user_id = '${m?.userId}'::uuid AND revoked_at IS NULL RETURNING id`,
    );
    return r.rows.length;
  });
  expect(updated).toBeGreaterThan(0);
}

/** The Postgres message behind a failed statement (drizzle wraps it as "Failed query: …"). */
async function pgFailure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    const e = error as { message?: string; cause?: { message?: string } };
    return `${e.message ?? ""} ${e.cause?.message ?? ""}`;
  }
  return "did not fail";
}

async function setEnabled(on: boolean): Promise<void> {
  const ctx = systemContext(acmeId);
  await running.container.db.withTenant(ctx, (tx) =>
    new ModuleEnablementRepo(ctx, tx).set("captable", on),
  );
  running.container.enablement.invalidate(acmeId);
}

interface Preview {
  format: string;
  source: string;
  rows: number;
  matched: number;
  unmatched: number;
  summary: {
    fullyDilutedShares: string;
    classes: { name: string; kind: string; percentFullyDiluted: string }[];
    optionPool: {
      poolShares: string | null;
      granted: string | null;
      available: string | null;
    } | null;
    convertiblesOutstanding: { currency: string; total: string }[];
  };
  warnings: { line: number | null; code: string }[];
  lines: { holderName: string; membershipId: string | null }[];
}
interface Snapshot {
  id: string;
  status: string;
  source: string;
  publishedAt: string | null;
  summary: Preview["summary"];
}
interface Me {
  snapshotId: string;
  asOf: string;
  disclaimer: string;
  holdings: { className: string; kind: string; shares: string | null; amount: string | null }[];
  ownership: { fullyDilutedShares: string; percentFullyDiluted: string };
  summary: { buckets: Record<string, unknown>[] } | null;
}

let acmeId: string;
let owner: Actor;
let finance: Actor;
let viewer: Actor;
let ada: Actor;
let grace: Actor;
let bob: Actor;
let gone: Actor;

const csvTemplate = () =>
  [
    "holder_name,holder_email,class,kind,shares,amount,currency,issued_on",
    `Founder,${owner.email},Common,common,8000000,,,2024-01-15`,
    "Ada Lovelace,ADA@Investor.Test,Series Seed,preferred,1500000,1500000,USD,2025-03-01",
    "Ada Lovelace,ada@investor.test,Common,common,100000,,,2025-03-01",
    "Option pool,,2024 Plan,option_pool,1000000,,,",
    "Employee,emp@acme.test,Options,option,250000,,,2024-06-01",
    "Grace Hopper,grace@investor.test,Post-money SAFE,safe,,250000,USD,2025-06-30",
    "Gone Member,gone@investor.test,Common,common,5000,,,",
  ].join("\n");

const importBody = (csv: string, format = "template", asOf = "2026-09-30") =>
  JSON.stringify({ format, csv, asOf, note: "Q3 board pack" });

async function importDraft(csv = csvTemplate(), format = "template"): Promise<string> {
  const res = await request("acme", "/api/v1/captable/import", {
    method: "POST",
    cookie: finance.cookie,
    body: importBody(csv, format),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await json<{ snapshot: Snapshot }>(res)).snapshot.id;
}

async function publishSnapshot(id: string, actor = owner): Promise<Response> {
  return request("acme", `/api/v1/captable/snapshots/${id}/publish`, {
    method: "POST",
    cookie: actor.cookie,
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
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  finance = await member("acme", acmeId, "fin@acme.test", "staff", "finance");
  viewer = await member("acme", acmeId, "viewer@acme.test", "staff", "viewer");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  grace = await member("acme", acmeId, "grace@investor.test", "external", "investor");
  bob = await member("acme", acmeId, "bob@investor.test", "external", "investor");
  gone = await member("acme", acmeId, "gone@investor.test", "external", "investor");
  // A revoked member is not a live membership: their address must not be matched.
  await rows(
    `UPDATE core.membership SET status = 'revoked', revoked_at = now()
      WHERE id = '${gone.membershipId}'::uuid`,
  );
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema and the off-by-default switch", () => {
  it("captable.* tables pass the RLS catalog check", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });

  it("is off until enabled: every route, /me included, answers 404 module_disabled", async () => {
    for (const [path, actor] of [
      ["/api/v1/captable/snapshots", owner],
      ["/api/v1/captable/settings", owner],
      ["/api/v1/captable/me", ada],
    ] as const) {
      const res = await request("acme", path, { cookie: actor.cookie });
      expect(res.status, path).toBe(404);
      expect(await codeOf(res)).toBe("module_disabled");
    }
    await setEnabled(true);
    expect(
      (await request("acme", "/api/v1/captable/snapshots", { cookie: owner.cookie })).status,
    ).toBe(200);
  });

  it("refuses the staff routes to a viewer (403) and an investor (404, no oracle)", async () => {
    // A staff member without the permission is told so; an investor learns nothing (404).
    const staff = await request("acme", "/api/v1/captable/snapshots", { cookie: viewer.cookie });
    expect(staff.status).toBe(403);
    const investor = await request("acme", "/api/v1/captable/snapshots", { cookie: ada.cookie });
    expect(investor.status).toBe(404);
  });
});

describe("settings", () => {
  it("defaults to own_line with the default disclaimer, and saves a replacement", async () => {
    const res = await request("acme", "/api/v1/captable/settings", { cookie: finance.cookie });
    expect(await json(res)).toEqual({
      investorView: "own_line",
      disclaimer: null,
      defaultDisclaimer: DEFAULT_DISCLAIMER,
    });
    // Widening what investors see needs a fresh step-up.
    await markFresh(finance, 11 * 60_000);
    const stale = await request("acme", "/api/v1/captable/settings", {
      method: "PUT",
      cookie: finance.cookie,
      body: JSON.stringify({ investorView: "summary", disclaimer: null }),
    });
    expect(stale.status).toBe(403);
    expect(await codeOf(stale)).toBe("step_up_required");
    await markFresh(finance);
    const put = await request("acme", "/api/v1/captable/settings", {
      method: "PUT",
      cookie: finance.cookie,
      body: JSON.stringify({ investorView: "own_line", disclaimer: "  Not the ledger.  " }),
    });
    expect(put.status).toBe(200);
    expect((await json<{ disclaimer: string }>(put)).disclaimer).toBe("Not the ledger.");
    // The switch itself was not touched by the settings write.
    const [row] = await rows<{ enabled: boolean; config: Record<string, unknown> }>(
      `SELECT enabled, config FROM core.module_enablement WHERE module = 'captable'`,
    );
    expect(row?.enabled).toBe(true);
    expect(row?.config["settings"]).toEqual({
      investorView: "own_line",
      disclaimer: "Not the ledger.",
    });
  });
});

describe("import", () => {
  it("dry-runs and imports the same plan; matches live members only, case-insensitively", async () => {
    const dry = await request("acme", "/api/v1/captable/import/dry-run", {
      method: "POST",
      cookie: finance.cookie,
      body: importBody(csvTemplate()),
    });
    expect(dry.status, await dry.clone().text()).toBe(200);
    const preview = await json<Preview>(dry);
    expect(preview.source).toBe("csv");
    expect(preview.rows).toBe(7);
    const linked = Object.fromEntries(preview.lines.map((l) => [l.holderName, l.membershipId]));
    expect(linked["Ada Lovelace"]).toBe(ada.membershipId);
    expect(linked["Grace Hopper"]).toBe(grace.membershipId);
    expect(linked["Founder"]).toBe(owner.membershipId);
    expect(linked["Gone Member"]).toBeNull(); // revoked: not a live membership
    expect(linked["Employee"]).toBeNull();
    expect(preview.matched).toBe(4);
    expect(preview.summary.fullyDilutedShares).toBe("10605000");
    expect(preview.summary.optionPool).toEqual({
      poolShares: "1000000",
      granted: "250000",
      available: "750000",
    });
    expect(await rows(`SELECT 1 FROM captable.snapshot`)).toEqual([]); // nothing written

    const res = await request("acme", "/api/v1/captable/import", {
      method: "POST",
      cookie: finance.cookie,
      body: importBody(csvTemplate()),
    });
    expect(res.status).toBe(201);
    const created = await json<{ snapshot: Snapshot; preview: Preview }>(res);
    expect(created.preview).toEqual(preview);
    expect(created.snapshot.status).toBe("draft");
    expect(created.snapshot.summary).toEqual(preview.summary);
    const [counts] = await rows<{ classes: number; lines: number }>(
      `SELECT (SELECT count(*)::int FROM captable.security_class WHERE snapshot_id = '${created.snapshot.id}') AS classes,
              (SELECT count(*)::int FROM captable.holding WHERE snapshot_id = '${created.snapshot.id}') AS lines`,
    );
    expect(counts).toEqual({ classes: 5, lines: 7 });
    const audit = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event WHERE action = 'captable.snapshot_imported'`,
    );
    expect(audit[0]?.n).toBe(1);
    // The draft carries a detail with holders aggregated (Ada's two lines are one holder).
    const detail = await json<{ holders: { membershipId: string | null; lines: number }[] }>(
      await request("acme", `/api/v1/captable/snapshots/${created.snapshot.id}`, {
        cookie: finance.cookie,
      }),
    );
    expect(detail.holders.find((h) => h.membershipId === ada.membershipId)?.lines).toBe(2);
  });

  it("imports Carta and Pulley exports (inferred columns) as their own sources", async () => {
    const carta = [
      "Stakeholder Name,Stakeholder Email,Share Class,Quantity Outstanding,Cash Paid,Issue Date",
      'Ada Lovelace,ada@investor.test,Series Seed Preferred,"1,500,000","$1,500,000.00",3/1/2025',
      "Founder,owner@acme.test,Common Stock,8000000,,1/15/2024",
    ].join("\n");
    const pulley = [
      "Stakeholder,Email,Share Class,Security Type,Shares,Investment Amount,Currency",
      "Grace Hopper,grace@investor.test,Seed SAFE,SAFE,,50000,USD",
      "Founder,owner@acme.test,Common,Common Stock,8000000,,",
    ].join("\n");
    for (const [format, csv] of [
      ["carta", carta],
      ["pulley", pulley],
    ] as const) {
      const res = await request("acme", "/api/v1/captable/import/dry-run", {
        method: "POST",
        cookie: finance.cookie,
        body: importBody(csv, format),
      });
      expect(res.status, format).toBe(200);
      const p = await json<Preview>(res);
      expect(p.source).toBe(format);
      expect(p.matched).toBe(2);
    }
  });

  it("never links a line to a member whose erasure is pending", async () => {
    const csv =
      "holder_name,holder_email,class,kind,shares\nBob,bob@investor.test,Common,common,10\n";
    const linkOf = async () =>
      (
        await json<Preview>(
          await request("acme", "/api/v1/captable/import/dry-run", {
            method: "POST",
            cookie: finance.cookie,
            body: importBody(csv),
          }),
        )
      ).lines[0]?.membershipId;
    expect(await linkOf()).toBe(bob.membershipId);
    // An accepted erasure request whose outbox event has not been handled yet.
    const [req] = await rows<{ id: string }>(
      `INSERT INTO core.dsar_request (workspace_id, membership_id, due_at, kind)
         VALUES ('${acmeId}', '${bob.membershipId}', now() + interval '30 days', 'erasure')
       RETURNING id::text AS id`,
    );
    try {
      expect(await linkOf()).toBeNull();
    } finally {
      await rows(
        `UPDATE core.dsar_request SET status = 'cancelled', cancelled_at = now() WHERE id = '${req?.id}'`,
      );
    }
    expect(await linkOf()).toBe(bob.membershipId);
  });

  it("refuses a bad CSV with 422 captable_import_invalid, the reason and every problem", async () => {
    const res = await request("acme", "/api/v1/captable/import", {
      method: "POST",
      cookie: finance.cookie,
      body: importBody("holder_name,class,kind,shares\nA,Common,common,lots\nB,Common,bogus,1\n"),
    });
    expect(res.status).toBe(422);
    const body = await json<{
      error: { code: string; reason: string; problems: { line: number; code: string }[] };
    }>(res);
    expect(body.error.code).toBe("captable_import_invalid");
    expect(body.error.reason).toBe("invalid_rows");
    expect(body.error.problems.map((p) => [p.line, p.code])).toEqual([
      [2, "shares_invalid"],
      [3, "kind_invalid"],
    ]);
    const missing = await request("acme", "/api/v1/captable/import/dry-run", {
      method: "POST",
      cookie: finance.cookie,
      body: importBody("name,shares\nA,1\n"),
    });
    expect(missing.status).toBe(422);
    expect((await json<{ error: { reason: string } }>(missing)).error.reason).toBe(
      "missing_columns",
    );
  });

  it("refuses over the caps: more than 5000 rows, and more than 2 MiB", async () => {
    const lines = Array.from({ length: 5001 }, (_, i) => `H${i},Common,common,1`);
    const many = await request("acme", "/api/v1/captable/import/dry-run", {
      method: "POST",
      cookie: finance.cookie,
      body: importBody(`holder_name,class,kind,shares\n${lines.join("\n")}`),
    });
    expect(many.status).toBe(422);
    expect((await json<{ error: { reason: string } }>(many)).error.reason).toBe("too_many_rows");
    const huge = await request("acme", "/api/v1/captable/import/dry-run", {
      method: "POST",
      cookie: finance.cookie,
      body: importBody(
        `holder_name,class,kind,shares\nA,Common,common,1\n${"#".repeat(2 * 1024 * 1024 + 10)}`,
      ),
    });
    // The body limit (413), the schema bound (400) or the service cap (422): never accepted.
    expect([400, 413, 422]).toContain(huge.status);
    expect(await rows(`SELECT 1 FROM captable.snapshot WHERE note IS NULL`)).toEqual([]);
  });
});

describe("publishing and the investor's view", () => {
  let draftId: string;

  it("keeps drafts invisible to investors (route 404, and RLS returns no line)", async () => {
    const [d] = await rows<{ id: string }>(
      `SELECT id::text AS id FROM captable.snapshot WHERE status = 'draft' ORDER BY created_at LIMIT 1`,
    );
    draftId = d?.id ?? "";
    const res = await request("acme", "/api/v1/captable/me", { cookie: ada.cookie });
    expect(res.status).toBe(404);
    expect(await rowsAsExternal(ada.membershipId, "SELECT id FROM captable.holding")).toEqual([]);
  });

  it("asks for a fresh step-up to publish", async () => {
    await markFresh(owner, 11 * 60_000);
    const stale = await publishSnapshot(draftId);
    expect(stale.status).toBe(403);
    expect(await codeOf(stale)).toBe("step_up_required");
    await markFresh(owner);
    const res = await publishSnapshot(draftId);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await json<Snapshot>(res)).status).toBe("published");
    const again = await publishSnapshot(draftId);
    expect(again.status).toBe(409);
    expect((await json<{ error: { reason: string } }>(again)).error.reason).toBe("not_draft");
  });

  it("shows an investor their own lines only, with the disclaimer", async () => {
    const me = await json<Me>(await request("acme", "/api/v1/captable/me", { cookie: ada.cookie }));
    expect(me.snapshotId).toBe(draftId);
    expect(me.asOf).toBe("2026-09-30");
    expect(me.disclaimer).toBe("Not the ledger.");
    expect(me.holdings.map((h) => [h.className, h.shares]).sort()).toEqual([
      ["Common", "100000"],
      ["Series Seed", "1500000"],
    ]);
    // 1.6M of 10.605M fully diluted.
    expect(me.ownership).toEqual({ fullyDilutedShares: "1600000", percentFullyDiluted: "15.09" });
    expect(me.summary).toBeNull();

    const g = await json<Me>(
      await request("acme", "/api/v1/captable/me", { cookie: grace.cookie }),
    );
    expect(g.holdings).toEqual([
      {
        className: "Post-money SAFE",
        kind: "safe",
        shares: null,
        amount: "250000",
        currency: "USD",
        issuedOn: "2025-06-30",
      },
    ]);
    const b = await json<Me>(await request("acme", "/api/v1/captable/me", { cookie: bob.cookie }));
    expect(b.holdings).toEqual([]);
  });

  it("RLS: a member reads only their own published lines, never another member's or the summary", async () => {
    const own = await rowsAsExternal<{ membership_id: string }>(
      ada.membershipId,
      "SELECT membership_id::text FROM captable.holding",
    );
    expect(own.length).toBe(2);
    expect(new Set(own.map((r) => r.membership_id))).toEqual(new Set([ada.membershipId]));
    // Asking for Grace's lines directly, as Ada, returns nothing.
    expect(
      await rowsAsExternal(
        ada.membershipId,
        `SELECT id FROM captable.holding WHERE membership_id = '${grace.membershipId}'::uuid`,
      ),
    ).toEqual([]);
    expect(await rowsAsExternal(ada.membershipId, "SELECT id FROM captable.snapshot")).toEqual([]);
    expect(
      await rowsAsExternal(ada.membershipId, "SELECT id FROM captable.security_class"),
    ).toEqual([]);
    // And no write path at all.
    await expect(
      rowsAsExternal(
        ada.membershipId,
        `UPDATE captable.holding SET membership_id = NULL RETURNING id`,
      ),
    ).resolves.toEqual([]);
  });

  it("investorView summary adds class totals without names; none hides the card", async () => {
    await markFresh(finance);
    const put = (investorView: string) =>
      request("acme", "/api/v1/captable/settings", {
        method: "PUT",
        cookie: finance.cookie,
        body: JSON.stringify({ investorView, disclaimer: null }),
      });
    expect((await put("summary")).status).toBe(200);
    const me = await json<Me>(await request("acme", "/api/v1/captable/me", { cookie: ada.cookie }));
    expect(me.disclaimer).toBe(DEFAULT_DISCLAIMER);
    // Every kind bucket has fewer than three holders besides Ada (common: the founder and the
    // revoked member's line; options: one optionee — the pool is not a holder; convertibles:
    // Grace), so nothing can be shown without narrowing to somebody: an empty breakdown.
    expect(me.summary).toEqual({ buckets: [] });
    // Three more sizeable common holders and optionees (none dominating: ≤ 70 % / 90 %) make those buckets showable — as 1-dp
    // percentages only. Preferred stays hidden (Ada alone: the complement is only her own).
    const extra = ["C1", "C2", "C3"].map((h) => `${h},,Common,common,4000000,,,`);
    const opts = ["O1", "O2", "O3"].map((h) => `${h},,Options,option,250000,,,`);
    const more = await importDraft([csvTemplate(), ...extra, ...opts].join("\n"));
    await markFresh(owner);
    expect((await publishSnapshot(more)).status).toBe(200);
    const again = await json<Me>(
      await request("acme", "/api/v1/captable/me", { cookie: ada.cookie }),
    );
    expect(again.summary).toEqual({
      buckets: [
        { kind: "common", percentFullyDiluted: "88.9" },
        { kind: "options", percentFullyDiluted: "4.4" },
      ],
    });
    expect(JSON.stringify(me.summary)).not.toContain("Grace");
    expect((await put("none")).status).toBe(200);
    expect((await request("acme", "/api/v1/captable/me", { cookie: ada.cookie })).status).toBe(404);
    expect((await put("own_line")).status).toBe(200);
  });

  it("an all-scope delegate sees its principal's lines; a narrower one gets 404", async () => {
    const helper = await delegate("helper@ada.test", ada, "all");
    const narrow = await delegate("dr@ada.test", ada, "data_room");
    const me = await json<Me>(
      await request("acme", "/api/v1/captable/me", { cookie: helper.cookie }),
    );
    expect(me.holdings).toHaveLength(2);
    expect(
      (await rowsAsExternal(helper.membershipId, "SELECT id FROM captable.holding")).length,
    ).toBe(2);
    expect((await request("acme", "/api/v1/captable/me", { cookie: narrow.cookie })).status).toBe(
      404,
    );
    expect(await rowsAsExternal(narrow.membershipId, "SELECT id FROM captable.holding")).toEqual(
      [],
    );
  });
});

describe("snapshots are records", () => {
  it("serialises concurrent publishes: exactly one snapshot ends up published", async () => {
    const a = await importDraft();
    const b = await importDraft();
    await markFresh(owner);
    const [ra, rb] = await Promise.all([publishSnapshot(a), publishSnapshot(b)]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const published = await rows<{ id: string }>(
      `SELECT id::text AS id FROM captable.snapshot WHERE status = 'published'`,
    );
    expect(published).toHaveLength(1);
    expect([a, b]).toContain(published[0]?.id);
    const superseded = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM captable.snapshot WHERE status = 'superseded'`,
    );
    // The two published earlier in this file, plus whichever of a and b lost.
    expect(superseded[0]?.n).toBe(3);

    // The same draft published twice at once: one wins, the other is told it is not a draft.
    const c = await importDraft();
    const both = await Promise.all([publishSnapshot(c), publishSnapshot(c)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("deletes a draft only, and the rows refuse to change", async () => {
    const d = await importDraft();
    const del = await request("acme", `/api/v1/captable/snapshots/${d}`, {
      method: "DELETE",
      cookie: finance.cookie,
    });
    expect(del.status).toBe(200);
    expect(await rows(`SELECT 1 FROM captable.holding WHERE snapshot_id = '${d}'`)).toEqual([]);
    const [pub] = await rows<{ id: string }>(
      `SELECT id::text AS id FROM captable.snapshot WHERE status = 'published'`,
    );
    const refused = await request("acme", `/api/v1/captable/snapshots/${pub?.id}`, {
      method: "DELETE",
      cookie: finance.cookie,
    });
    expect(refused.status).toBe(409);
    expect(
      await pgFailure(
        rows(`UPDATE captable.holding SET shares = 1 WHERE snapshot_id = '${pub?.id}'`),
      ),
    ).toMatch(/immutable/u);
    expect(
      await pgFailure(
        rows(`UPDATE captable.snapshot SET as_of = '2020-01-01' WHERE id = '${pub?.id}'`),
      ),
    ).toMatch(/immutable/u);
    expect(
      await pgFailure(rows(`DELETE FROM captable.holding WHERE snapshot_id = '${pub?.id}'`)),
    ).toMatch(/published snapshot/u);
    const missing = await request("acme", `/api/v1/captable/snapshots/${randomUUID()}`, {
      cookie: finance.cookie,
    });
    expect(missing.status).toBe(404);
  });
});

describe("DSAR", () => {
  it("exports the member's own lines", async () => {
    const ctx = systemContext(acmeId);
    const out = await running.container.db.withTenant(ctx, (tx) =>
      captableDsar.export({ tx, ctx, membershipId: ada.membershipId, related: {} }),
    );
    const holdings = out["holdings"] as { holderName: string; linked: boolean }[];
    expect(holdings.length).toBeGreaterThan(0);
    expect(holdings.every((h) => h.holderName === "Ada Lovelace" && h.linked)).toBe(true);
  });

  it("erasure pseudonymises the member's lines (linked or by address) and keeps the numbers", async () => {
    const before = await rows<{ n: number; total: string }>(
      `SELECT count(*)::int AS n, sum(amount)::text AS total FROM captable.holding
        WHERE membership_id = '${grace.membershipId}'::uuid`,
    );
    expect(before[0]?.n).toBeGreaterThan(0);
    // An unlinked line carrying Grace's address (imported while she was not a member here).
    const unlinkedCsv = [
      "holder_name,holder_email,class,kind,shares",
      "G. Hopper,GRACE@investor.test,Common,common,10",
    ].join("\n");
    const draft = await importDraft(unlinkedCsv);
    await rows(
      `UPDATE captable.holding SET membership_id = NULL WHERE snapshot_id = '${draft}'::uuid`,
    );
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) =>
      publish(tx, ctx, "member.erasure_requested", {
        requestId: randomUUID(),
        membershipId: grace.membershipId,
      } as never),
    );
    const erased = await waitFor(async () => {
      const r = await rows<{ holderName: string; holderEmail: string | null; erased: boolean }>(
        `SELECT holder_name AS "holderName", holder_email AS "holderEmail", erased_at IS NOT NULL AS erased
           FROM captable.holding WHERE holder_name = '${ERASED_HOLDER_NAME}'`,
      );
      return r.length === before[0]!.n + 1 ? r : undefined;
    });
    expect(erased.every((r) => r.holderEmail === null && r.erased)).toBe(true);
    expect(
      await rows(`SELECT 1 FROM captable.holding WHERE holder_email = 'grace@investor.test'`),
    ).toEqual([]);
    const after = await rows<{ total: string }>(
      `SELECT sum(amount)::text AS total FROM captable.holding
        WHERE holder_name = '${ERASED_HOLDER_NAME}' AND amount IS NOT NULL`,
    );
    expect(after[0]?.total).toBe(before[0]?.total);
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit.event WHERE action = 'captable.holder_erased'`,
        )
      )[0]?.n,
    ).toBe(1);
  });
});

describe("R5: the viewer's unlinked lines under their own addresses", () => {
  it("counts them as the viewer's (holdings, DSAR) and never as other holders in the summary", async () => {
    const [u] = await rows<{ userId: string }>(
      `SELECT user_id::text AS "userId" FROM core.membership WHERE id = '${ada.membershipId}'::uuid`,
    );
    await running.container.db.withHost((tx) =>
      tx.execute(
        `INSERT INTO core.user_identity (user_id, type, identifier, is_primary, verified_at)
           VALUES ('${u?.userId}', 'email', 'ada.alt@family.test', false, now()),
                  ('${u?.userId}', 'email', 'ada.llc@family.test', false, now())`,
      ),
    );
    const csv = [
      "holder_name,holder_email,class,kind,shares",
      "Ada Lovelace,ada@investor.test,Common,common,1000",
      "Ada Family Trust,ada@investor.test,Common,common,2000",
      "Ada (alt),ada.alt@family.test,Common,common,2000",
      "Ada Holdings LLC,ADA.LLC@family.test,Common,common,2000",
      "X,x@elsewhere.test,Common,common,237",
      "P1,,Series A,preferred,10000",
      "P2,,Series A,preferred,10000",
      "P3,,Series A,preferred,10000",
    ].join("\n");
    const id = await importDraft(csv);
    // The trust line was imported before Ada joined: unlinked, but under her primary address.
    await rows(
      `UPDATE captable.holding SET membership_id = NULL
        WHERE snapshot_id = '${id}'::uuid AND holder_name = 'Ada Family Trust'`,
    );
    await markFresh(owner);
    expect((await publishSnapshot(id)).status).toBe(200);
    await markFresh(finance);
    const put = await request("acme", "/api/v1/captable/settings", {
      method: "PUT",
      cookie: finance.cookie,
      body: JSON.stringify({ investorView: "summary", disclaimer: null }),
    });
    expect(put.status).toBe(200);

    const me = await json<Me>(await request("acme", "/api/v1/captable/me", { cookie: ada.cookie }));
    expect(me.holdings.map((h) => h.shares).sort()).toEqual(["1000", "2000", "2000", "2000"]);
    expect(me.ownership.fullyDilutedShares).toBe("7000");
    // Counting her three unlinked lines as other holders would show common (19.4 %) and let her
    // recover X's 237 shares; with them treated as hers, common has one other holder and goes,
    // and preferred goes with it (the complement would be X).
    expect(me.summary).toEqual({ buckets: [] });

    const ctx = systemContext(acmeId);
    const out = await running.container.db.withTenant(ctx, (tx) =>
      captableDsar.export({ tx, ctx, membershipId: ada.membershipId, related: {} }),
    );
    const names = (out["holdings"] as { holderName: string }[]).map((h) => h.holderName);
    expect(names).toEqual(
      expect.arrayContaining(["Ada Family Trust", "Ada (alt)", "Ada Holdings LLC"]),
    );
  });
});

describe("module off", () => {
  it("answers 404 on /me again once the module is switched off", async () => {
    await setEnabled(false);
    const res = await request("acme", "/api/v1/captable/me", { cookie: ada.cookie });
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("module_disabled");
  });
});
