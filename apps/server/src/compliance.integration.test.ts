import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createErasureService, createLegalPort, createOfferingService } from "@fundroom/compliance";
import { loadConfig } from "@fundroom/config";
import { checkRlsCatalog, createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { MembershipRepo, provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { resetGpcRefusalCache } from "./middleware/gpc.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Offering mode and the legal kernel end to end (E1.6, ADR-0037).
 *
 * The shape of the epic, in order: the offering status as a period history that closes one row
 * and opens the next → 506(c) as a confirmed, one-way door → the template library and the tenant
 * document library with immutable versions → the acceptance gate actually refusing an investor
 * every other route until they click through, and letting them straight back in afterwards →
 * consent as a decision folded on the server, with Global Privacy Control overriding a stored
 * grant → the acceptance register → the relationship facts on the People screen → the RLS the
 * 0006 migration tightened, and cross-tenant isolation.
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

async function request(
  slug: string,
  path: string,
  init: RequestInit & { cookie?: string; gpc?: boolean } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.gpc) headers.set("sec-gpc", "1");
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
  role: "owner" | "admin" | "editor" | "viewer" | "legal" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

/** Rows read as the `system` actor of a workspace. */
async function rows<T>(query: string, workspaceId?: string): Promise<T[]> {
  const ctx = systemContext(workspaceId ?? acmeId);
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

/** Rows read as a specific *external* membership: exactly what RLS lets that investor see. */
async function rowsAsExternal<T>(
  workspaceId: string,
  membershipId: string,
  query: string,
): Promise<T[]> {
  const ctx = { workspaceId, actorKind: "external" as const, membershipId };
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

interface OfferingState {
  status: string;
  current: { id: string; status: string; startedAt: string; endedAt: string | null };
  history: { id: string; status: string; startedAt: string; endedAt: string | null }[];
  permits: { status: string; publicSections: boolean; accreditationRequired: boolean };
  table: { status: string }[];
  irrevocable: boolean;
}

interface DocumentDetail {
  document: {
    id: string;
    slug: string;
    title: string;
    requiresAcceptance: boolean;
    currentVersionNo: number | null;
    stamp: string | null;
  };
  current: { versionNo: number; bodySha256: string; body: string } | null;
  versions: { versionNo: number }[];
}

interface Pending {
  pending: { documentId: string; slug: string; versionNo: number; stamp: string; body: string }[];
}

interface ConsentState {
  consentMode: string;
  gpc: boolean;
  purposes: { purpose: string; granted: boolean | null; source: string | null; allowed: boolean }[];
}

const NOTICE_BODY_V1 = "# Privacy notice\n\nWe process what we must. Version one.";
const NOTICE_BODY_V2 = "# Privacy notice\n\nWe process what we must. Version two, with detail.";

let acmeId: string;
let globexId: string;
let initechId: string;
let owner: Actor;
let counsel: Actor;
let ada: Actor;
let bob: Actor;
let globexOwner: Actor;
let initechOwner: Actor;
/** The tenant privacy notice acme publishes; the gate hangs off it. */
let noticeId: string;

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
  initechId = (await createWorkspace(running.container.db, { slug: "initech", name: "Initech" }))
    .id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  counsel = await member("acme", acmeId, "counsel@example.com", "staff", "legal");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  bob = await member("acme", acmeId, "bob@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@example.org", "staff", "owner");
  initechOwner = await member("initech", initechId, "boss@initech.test", "staff", "owner");
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema + registry", () => {
  it("the compliance tables pass the RLS catalog check", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });

  it("registers the three permissions and the admin nav slot", async () => {
    const registry = running.container.registry;
    for (const p of ["compliance.read", "compliance.manage", "compliance.offering"]) {
      expect(registry.permissions.get(p)).toBe("compliance");
    }
    const boot = await json<{ modules: { id: string; slots: Record<string, unknown[]> }[] }>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    const mod = boot.modules.find((m) => m.id === "compliance");
    expect(mod?.slots["admin.nav"]).toHaveLength(1);
  });

  it("an investor cannot reach the staff compliance surfaces at all (404, no oracle)", async () => {
    for (const path of ["/api/v1/compliance/offering", "/api/v1/compliance/documents"]) {
      expect((await request("acme", path, { cookie: ada.cookie })).status).toBe(404);
    }
  });
});

describe("offering mode", () => {
  it("reads a lazily opened period and the whole §11 table", async () => {
    const res = await request("acme", "/api/v1/compliance/offering", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const state = await json<OfferingState>(res);
    // A workspace that pre-dates E1.6 has a status but no period rows; the first read opens one
    // *now* rather than inventing a start date nobody can stand behind.
    expect(state.status).toBe("none");
    expect(state.current.endedAt).toBeNull();
    expect(state.history).toHaveLength(1);
    expect(state.table.map((t) => t.status)).toEqual([
      "none",
      "informational",
      "506b",
      "506c",
      "non_us",
    ]);
    expect(state.irrevocable).toBe(false);
  });

  it("a change closes the open period and opens the next one in one transaction", async () => {
    const res = await request("acme", "/api/v1/compliance/offering", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ status: "informational", reason: "pre-raise" }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ from: string; to: string }>(res)).from).toBe("none");

    const periods = await rows<{ status: string; ended_at: string | null; reason: string | null }>(
      `SELECT status, ended_at, reason FROM core.offering_period
       WHERE workspace_id = '${acmeId}'::uuid ORDER BY started_at`,
    );
    expect(periods.map((p) => p.status)).toEqual(["none", "informational"]);
    expect(periods[0]?.ended_at).not.toBeNull();
    expect(periods[1]?.ended_at).toBeNull();
    expect(periods[1]?.reason).toBe("pre-raise");

    // The column and its history must agree — a column that disagrees with its own history is
    // worse than either alone.
    const ws = await rows<{ offering_status: string }>(
      `SELECT offering_status FROM core.workspace WHERE id = '${acmeId}'::uuid`,
    );
    expect(ws[0]?.offering_status).toBe("informational");
  });

  it("audits the change and puts it on the outbox", async () => {
    const audit = await rows<{ action: string; meta: Record<string, unknown> }>(
      `SELECT action, meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'workspace.offering_status_changed' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit[0]?.meta["from"]).toBe("none");
    expect(audit[0]?.meta["to"]).toBe("informational");
    const outbox = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT topic FROM core.outbox WHERE workspace_id = '${acmeId}'::uuid
           AND topic = 'workspace.offering_status_changed'`,
      );
      return r.rows;
    });
    expect(outbox.length).toBeGreaterThan(0);
  });

  it("`hiddenWhen` hides a module from an investor's nav without disabling its routes", async () => {
    const investorBoot = await json<{
      modules: { id: string; hidden: boolean; enabled: boolean }[];
    }>(await request("acme", "/api/v1/modules", { cookie: ada.cookie }));
    const dataRoom = investorBoot.modules.find((m) => m.id === "data-room");
    expect(dataRoom).toMatchObject({ hidden: true, enabled: true });
    const staffBoot = await json<{ modules: { id: string; hidden: boolean }[] }>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    expect(staffBoot.modules.find((m) => m.id === "data-room")?.hidden).toBe(false);
    // Hidden is a nav decision, so the route still answers.
    expect((await request("acme", "/api/v1/data-room/tree", { cookie: ada.cookie })).status).toBe(
      200,
    );
  });

  it("`disabledWhen` switches `share-links` off for staff too: no module, no nav, no permission, 404", async () => {
    /*
     * E1.6 built the `disabledWhen` seam (ADR-0037 decision 3) and this test pinned that no
     * module used it yet — i.e. it pinned the *absence* of a feature, which goes stale the day
     * one arrives rather than defending a decision. E2.3's `share-links` is the first consumer
     * (contract §S4, §10 H4), so the assertion is re-aimed at the rule itself.
     *
     * `acme` is `informational` at this point in the file, which is in `SHARE_LINKS_DISABLED_WHEN`.
     * The declaration alone proves nothing — until work package H removed `isDisabledForOffering`'s
     * `required` short-circuit the field was accepted and silently ignored on every kernel
     * manifest — so all four halves of the control are asserted against the running server, for an
     * **owner**, who is the actor a nav-only control would let walk around it.
     */
    const boot = await json<{
      workspace: { offeringStatus: string };
      modules: { id: string; enabled: boolean; slots: Record<string, unknown[]> }[];
      permissions: string[];
    }>(await request("acme", "/api/v1/modules", { cookie: owner.cookie }));
    expect(boot.workspace.offeringStatus).toBe("informational");
    const shareLinks = boot.modules.find((m) => m.id === "share-links");
    // Off, and contributing no admin nav item — a nav that offered a screen whose routes 404 is
    // the shape H4 fixed.
    expect(shareLinks).toMatchObject({ enabled: false, slots: {} });
    // ...and the permission catalogue agrees with the module list (H5), so the browser never has
    // to reconcile two server facts. The owner holds `compliance.offering` in the same body.
    expect(boot.permissions.filter((p) => p.startsWith("share-links."))).toEqual([]);
    expect(boot.permissions).toContain("compliance.offering");
    // A module with no `disabledWhen` is untouched at the same status: the switch is the rule
    // firing, not the workspace being broken.
    expect(boot.modules.find((m) => m.id === "data-room")?.enabled).toBe(true);

    // The door itself. `requireOffering` runs before any permission check, so an owner gets the
    // same 404 an anonymous caller would.
    const res = await request("acme", "/api/v1/links", { cookie: owner.cookie });
    expect(res.status).toBe(404);
    const body = await json<{ error: { code: string; reason: string; offeringStatus: string } }>(
      res,
    );
    expect(body.error).toMatchObject({
      code: "module_disabled",
      reason: "offering_status",
      offeringStatus: "informational",
    });

    // The declaration the four assertions above are the behaviour of. Asserted last, and kept
    // deliberately: one list feeds both halves (`SHARE_LINKS_DISABLED_WHEN`), and a module that
    // quietly acquired a compliance switch should be visible here. E2.5's `round` module is the
    // second declarer (`ROUND_DISABLED_WHEN`, the statuses where `permits(s).roundAndTerms` is
    // false) and the list is the same one.
    const declaring = COMPILED_IN_MODULES.filter(
      (m) => (m.offeringStatusRules?.disabledWhen ?? []).length > 0,
    );
    expect(declaring.map((m) => m.id)).toEqual(["share-links", "round"]);
    for (const m of declaring) {
      expect(m.offeringStatusRules?.disabledWhen).toEqual(["none", "informational"]);
    }
    expect(
      COMPILED_IN_MODULES.filter((m) =>
        (m.offeringStatusRules?.hiddenWhen ?? []).includes("informational"),
      ).map((m) => m.id),
    ).toEqual(["data-room", "updates"]);
  });

  it("moves on to 506(b) and the permits table follows", async () => {
    const res = await request("acme", "/api/v1/compliance/offering", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ status: "506b", reason: "friends and family" }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ permits: { accreditationRequired: boolean } }>(res);
    expect(body.permits.accreditationRequired).toBe(false);
  });

  it("needs `compliance.offering` — counsel may read the mode but not change it", async () => {
    expect(
      (await request("acme", "/api/v1/compliance/offering", { cookie: counsel.cookie })).status,
    ).toBe(200);
    const res = await request("acme", "/api/v1/compliance/offering", {
      method: "PATCH",
      cookie: counsel.cookie,
      body: JSON.stringify({ status: "506c" }),
    });
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("forbidden");
  });

  it("switching to 506(c) writes nothing until it is confirmed, and can never be undone", async () => {
    // In its own workspace: the move is irrevocable by design, so a test that makes it must not
    // take the rest of the file's fixtures with it.
    const first = await request("initech", "/api/v1/compliance/offering", {
      method: "PATCH",
      cookie: initechOwner.cookie,
      body: JSON.stringify({ status: "506c" }),
    });
    expect(first.status).toBe(409);
    const conflict = await json<{
      error: { code: string; requiresConfirmation: boolean; confirm: string };
    }>(first);
    expect(conflict.error.code).toBe("conflict");
    expect(conflict.error.requiresConfirmation).toBe(true);
    expect(conflict.error.confirm).toBe("506c");
    /*
     * Nothing changed, and "nothing" is literal: a refused change does not even lazily seed the
     * period it would have closed. This workspace has never had its offering status read, so it
     * still has no period rows at all — a 409 must not leave a write behind.
     */
    const seeded = await rows<{ status: string; ended_at: string | null }>(
      `SELECT status, ended_at FROM core.offering_period WHERE workspace_id = '${initechId}'::uuid`,
      initechId,
    );
    expect(seeded).toHaveLength(0);

    const confirmed = await request("initech", "/api/v1/compliance/offering", {
      method: "PATCH",
      cookie: initechOwner.cookie,
      body: JSON.stringify({ status: "506c", confirm: "506c" }),
    });
    expect(confirmed.status).toBe(200);
    expect((await json<{ irrevocable: boolean }>(confirmed)).irrevocable).toBe(true);

    const back = await request("initech", "/api/v1/compliance/offering", {
      method: "PATCH",
      cookie: initechOwner.cookie,
      body: JSON.stringify({ status: "506b", confirm: "506b" }),
    });
    expect(back.status).toBe(409);
    expect((await json<{ error: { code: string } }>(back)).error.code).toBe("offering_irrevocable");
    const state = await json<OfferingState>(
      await request("initech", "/api/v1/compliance/offering", { cookie: initechOwner.cookie }),
    );
    expect(state.status).toBe("506c");
    expect(state.permits.accreditationRequired).toBe(true);
  });

  it("two concurrent first reads both get the one seeded period, not a unique-violation 500", async () => {
    // E3.2: the lazy seed used to be a plain INSERT, so the second of two first reads hit
    // `offering_period_open_idx` and the request answered 500. Made deterministic here: the first
    // transaction seeds and holds its row uncommitted until the second is blocked on that index.
    const db = running.container.db;
    const wsId = (await createWorkspace(db, { slug: "piedpiper", name: "Pied Piper" })).id;
    const ctx = systemContext(wsId);
    const offering = createOfferingService({ db, audit: running.container.audit });
    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let seeded: () => void = () => {};
    const firstSeeded = new Promise<void>((r) => {
      seeded = r;
    });
    const first = db.withTenant(ctx, async (tx) => {
      const state = await offering.current(ctx, tx);
      seeded();
      await hold;
      return state.period.id;
    });
    await firstSeeded;
    const second = db.withTenant(ctx, async (tx) => (await offering.current(ctx, tx)).period.id);
    try {
      // Wait until the second transaction is actually waiting on the first one's row lock. The
      // pool's login role (not `seedhost_app`) is what may read other sessions' query text.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE '%insert into "core"."offering_period"%'`,
        );
        if ((waiting.rows[0]?.n ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("the second read never blocked on the seed");
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      release();
    }
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    const periods = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.offering_period",
      wsId,
    );
    expect(periods[0]?.n).toBe(1);
  });
});

describe("the template library and tenant documents", () => {
  it("lists the shipped templates as metadata only", async () => {
    const res = await request("acme", "/api/v1/compliance/templates", { cookie: counsel.cookie });
    expect(res.status).toBe(200);
    const { templates } = await json<{
      templates: { id: string; requiresAcceptance: boolean; mergeFields: string[] }[];
    }>(res);
    expect(templates.length).toBeGreaterThan(5);
    const notice = templates.find((t) => t.id === "privacy-notice");
    expect(notice?.mergeFields.length).toBeGreaterThan(0);
    expect(Object.keys(templates[0] ?? {})).not.toContain("body");
  });

  it("returns one template's body and what it renders to for this workspace", async () => {
    const res = await request("acme", "/api/v1/compliance/templates/privacy-notice", {
      cookie: counsel.cookie,
    });
    expect(res.status).toBe(200);
    const body = await json<{ body: string; preview: string }>(res);
    expect(body.body).toContain("{{");
    expect(body.preview).not.toContain("{{");
    expect(body.preview).toContain("Acme");
    expect(
      (
        await request("acme", "/api/v1/compliance/templates/not-a-template", {
          cookie: counsel.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it("creates a document from a template and publishes its first version at once", async () => {
    const res = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({
        slug: "privacy-notice",
        from: "privacy-notice",
        requiresAcceptance: false,
      }),
    });
    expect(res.status).toBe(200);
    const detail = await json<DocumentDetail>(res);
    noticeId = detail.document.id;
    expect(detail.document.stamp).toBe("privacy-notice:v1");
    expect(detail.current?.versionNo).toBe(1);
    expect(detail.current?.body).not.toContain("{{");
    expect(detail.versions).toHaveLength(1);
  });

  it("refuses a duplicate slug and a malformed one", async () => {
    const dup = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ slug: "privacy-notice", body: "x" }),
    });
    expect(dup.status).toBe(409);
    const bad = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ slug: "Not A Slug", body: "x" }),
    });
    expect(bad.status).toBe(400);
  });

  it("publishes a second version, and refuses to republish an identical body", async () => {
    const second = await request("acme", `/api/v1/compliance/documents/${noticeId}/versions`, {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ body: NOTICE_BODY_V1, summary: "our own words" }),
    });
    expect(second.status).toBe(200);
    const published = await json<{ published: boolean; version: { versionNo: number } }>(second);
    expect(published).toMatchObject({ published: true, version: { versionNo: 2 } });

    const again = await request("acme", `/api/v1/compliance/documents/${noticeId}/versions`, {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ body: NOTICE_BODY_V1 }),
    });
    expect(again.status).toBe(200);
    // Not an error — the caller gets the version that already says exactly this.
    expect(await json<{ published: boolean; version: { versionNo: number } }>(again)).toMatchObject(
      {
        published: false,
        version: { versionNo: 2 },
      },
    );
    const versions = await json<{ versions: { versionNo: number }[] }>(
      await request("acme", `/api/v1/compliance/documents/${noticeId}/versions`, {
        cookie: counsel.cookie,
      }),
    );
    expect(versions.versions.map((v) => v.versionNo)).toEqual([2, 1]);
  });

  it("keeps published versions immutable in the database", async () => {
    await expect(
      rows(
        `UPDATE core.legal_document_version SET body = 'tampered'
         WHERE workspace_id = '${acmeId}'::uuid AND version_no = 1`,
      ),
    ).rejects.toThrow();
  });

  it("a document with no published version gates nothing", async () => {
    const created = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ slug: "draft-nda", requiresAcceptance: true }),
    });
    expect(created.status).toBe(200);
    const detail = await json<DocumentDetail>(created);
    expect(detail.current).toBeNull();
    const gates = await json<Pending>(
      await request("acme", "/api/v1/compliance/gates", { cookie: ada.cookie }),
    );
    expect(gates.pending).toHaveLength(0);
    // Tidy it away again: a soft delete keeps the versions and the acceptances.
    expect(
      (
        await request("acme", `/api/v1/compliance/documents/${detail.document.id}`, {
          method: "DELETE",
          cookie: counsel.cookie,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("acme", `/api/v1/compliance/documents/${detail.document.id}`, {
          cookie: counsel.cookie,
        })
      ).status,
    ).toBe(404);
  });
});

describe("the acceptance gate", () => {
  it("requiring acceptance of a published notice blocks every other member route", async () => {
    const patched = await request("acme", `/api/v1/compliance/documents/${noticeId}`, {
      method: "PATCH",
      cookie: counsel.cookie,
      body: JSON.stringify({ requiresAcceptance: true, audience: "external" }),
    });
    expect(patched.status).toBe(200);

    // A kernel member route and a module member route: the gate lives in `requireMember`, so
    // both are refused by the same middleware.
    for (const path of ["/api/v1/access/my", "/api/v1/data-room/tree", "/api/v1/updates/archive"]) {
      const res = await request("acme", path, { cookie: ada.cookie });
      expect(res.status, path).toBe(403);
      const body = await json<{ error: { code: string; documents: { slug: string }[] } }>(res);
      expect(body.error.code).toBe("legal_acceptance_required");
      expect(body.error.documents.map((d) => d.slug)).toEqual(["privacy-notice"]);
    }
  });

  it("staff are never gated by their own tenant's notice", async () => {
    expect((await request("acme", "/api/v1/access/my", { cookie: owner.cookie })).status).toBe(200);
    expect(
      (await request("acme", "/api/v1/compliance/documents", { cookie: counsel.cookie })).status,
    ).toBe(200);
  });

  it("the bootstrap carries the outstanding documents so the SPA can render the interstitial", async () => {
    const boot = await json<{
      pendingAcceptances: { slug: string; versionNo: number; stamp: string; body: string }[];
    }>(await request("acme", "/api/v1/modules", { cookie: ada.cookie }));
    expect(boot.pendingAcceptances).toHaveLength(1);
    expect(boot.pendingAcceptances[0]).toMatchObject({
      slug: "privacy-notice",
      versionNo: 2,
      stamp: "privacy-notice:v2",
    });
    expect(boot.pendingAcceptances[0]?.body).toBe(NOTICE_BODY_V1);

    // Staff and signed-out callers see nothing.
    expect(
      (
        await json<{ pendingAcceptances: unknown[] }>(
          await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
        )
      ).pendingAcceptances,
    ).toEqual([]);
    expect(
      (await json<{ pendingAcceptances: unknown[] }>(await request("acme", "/api/v1/modules")))
        .pendingAcceptances,
    ).toEqual([]);
  });

  it("the gate's own routes stay reachable while everything else is refused", async () => {
    const gates = await json<Pending>(
      await request("acme", "/api/v1/compliance/gates", { cookie: ada.cookie }),
    );
    expect(gates.pending).toHaveLength(1);
    expect(gates.pending[0]?.body).toBe(NOTICE_BODY_V1);
    expect(
      (await request("acme", "/api/v1/compliance/consent", { cookie: ada.cookie })).status,
    ).toBe(200);
  });

  it("accepting the current version unblocks the portal and records the evidence", async () => {
    const res = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: ada.cookie,
      headers: { "user-agent": "Mozilla/5.0 (X11) Firefox/140.0" },
      body: JSON.stringify({ documentId: noticeId, versionNo: 2 }),
    });
    expect(res.status).toBe(200);
    const accepted = await json<{ stamp: string; recorded: boolean; pending: unknown[] }>(res);
    expect(accepted).toMatchObject({ stamp: "privacy-notice:v2", recorded: true, pending: [] });

    expect((await request("acme", "/api/v1/access/my", { cookie: ada.cookie })).status).toBe(200);
    expect((await request("acme", "/api/v1/data-room/tree", { cookie: ada.cookie })).status).toBe(
      200,
    );

    // The attestation is the evidence: the exact bytes, a browser *family*, a keyed hash of the
    // address — never a User-Agent string and never a raw IP (ADR-0036).
    const att = await rows<{ kind: string; data: Record<string, unknown> }>(
      `SELECT kind, data FROM core.attestation
       WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${ada.membershipId}'::uuid`,
    );
    expect(att[0]?.kind).toBe("privacy-notice:v2");
    expect(att[0]?.data["uaFamily"]).toBe("firefox");
    expect(att[0]?.data["bodySha256"]).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(att[0]?.data)).not.toContain("Mozilla");
  });

  it("is idempotent: a second click writes no second row", async () => {
    const again = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ documentId: noticeId, versionNo: 2 }),
    });
    expect(again.status).toBe(200);
    expect((await json<{ recorded: boolean }>(again)).recorded).toBe(false);
    const count = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.attestation
       WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${ada.membershipId}'::uuid`,
    );
    expect(count[0]?.n).toBe(1);
  });

  it("refuses an acceptance of a superseded version", async () => {
    const res = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: bob.cookie,
      body: JSON.stringify({ documentId: noticeId, versionNo: 1 }),
    });
    expect(res.status).toBe(409);
  });

  it("republishing an identical body does not make anybody accept again", async () => {
    const again = await request("acme", `/api/v1/compliance/documents/${noticeId}/versions`, {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ body: NOTICE_BODY_V1 }),
    });
    expect((await json<{ published: boolean }>(again)).published).toBe(false);
    expect((await request("acme", "/api/v1/access/my", { cookie: ada.cookie })).status).toBe(200);
  });

  it("a genuinely new version gates the member again until they accept it", async () => {
    const v3 = await request("acme", `/api/v1/compliance/documents/${noticeId}/versions`, {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ body: NOTICE_BODY_V2, summary: "more detail" }),
    });
    expect((await json<{ published: boolean }>(v3)).published).toBe(true);

    const blocked = await request("acme", "/api/v1/access/my", { cookie: ada.cookie });
    expect(blocked.status).toBe(403);
    const accept = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ documentId: noticeId, versionNo: 3 }),
    });
    expect(accept.status).toBe(200);
    expect((await request("acme", "/api/v1/access/my", { cookie: ada.cookie })).status).toBe(200);
  });

  it("`legal.enforceAcceptance: false` lets an unaccepted member through without erasing anything", async () => {
    // Bob has still accepted nothing.
    expect((await request("acme", "/api/v1/access/my", { cookie: bob.cookie })).status).toBe(403);
    const off = await request("acme", "/api/v1/compliance/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ enforceAcceptance: false }),
    });
    expect(off.status).toBe(200);
    expect((await request("acme", "/api/v1/access/my", { cookie: bob.cookie })).status).toBe(200);
    // He is still told what he owes: turning enforcement off is not the same as agreeing.
    expect(
      (
        await json<Pending>(
          await request("acme", "/api/v1/compliance/gates", { cookie: bob.cookie }),
        )
      ).pending,
    ).toHaveLength(1);

    const on = await request("acme", "/api/v1/compliance/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ enforceAcceptance: true }),
    });
    expect(on.status).toBe(200);
    expect((await request("acme", "/api/v1/access/my", { cookie: bob.cookie })).status).toBe(403);
  });

  it("the register says who accepted what, paginated on a cursor that carries the whole key", async () => {
    const bobAccepts = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: bob.cookie,
      body: JSON.stringify({ documentId: noticeId, versionNo: 3 }),
    });
    expect(bobAccepts.status).toBe(200);

    const all = await json<{
      items: { membershipId: string; displayName: string; stamp: string; bodySha256: string }[];
      nextCursor: string | null;
    }>(
      await request("acme", "/api/v1/compliance/acceptances?slug=privacy-notice", {
        cookie: counsel.cookie,
      }),
    );
    // Ada accepted v2 and v3; Bob accepted v3.
    expect(all.items).toHaveLength(3);
    expect(new Set(all.items.map((i) => i.stamp))).toEqual(
      new Set(["privacy-notice:v2", "privacy-notice:v3"]),
    );
    expect(all.items.every((i) => /^[0-9a-f]{64}$/u.test(i.bodySha256))).toBe(true);
    expect(all.items.map((i) => i.displayName).every((n) => n.length > 0)).toBe(true);
    expect(all.nextCursor).toBeNull();

    // Walk it one row at a time: no row is repeated and none is dropped, which a timestamp-only
    // cursor could not promise for rows that share a microsecond.
    const walked: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const qs = `limit=1${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const page: { items: { stamp: string; membershipId: string }[]; nextCursor: string | null } =
        await json(
          await request("acme", `/api/v1/compliance/acceptances?${qs}`, { cookie: counsel.cookie }),
        );
      for (const item of page.items) walked.push(`${item.membershipId}:${item.stamp}`);
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(walked).toHaveLength(3);
    expect(new Set(walked).size).toBe(3);

    const mine = await json<{ items: { membershipId: string }[] }>(
      await request("acme", `/api/v1/compliance/acceptances?membershipId=${bob.membershipId}`, {
        cookie: counsel.cookie,
      }),
    );
    expect(mine.items.map((i) => i.membershipId)).toEqual([bob.membershipId]);
  });
});

describe("consent (R13)", () => {
  it("reports a never-asked purpose and refuses dwell under the opt-in default", async () => {
    const settings = await request("acme", "/api/v1/analytics/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ mode: "engagement" }),
    });
    expect(settings.status).toBe(200);

    const state = await json<ConsentState>(
      await request("acme", "/api/v1/compliance/consent", { cookie: ada.cookie }),
    );
    expect(state.consentMode).toBe("opt_in");
    const engagement = state.purposes.find((p) => p.purpose === "analytics_engagement");
    expect(engagement).toMatchObject({ granted: null, source: null, allowed: false });

    const notice = await json<{ dwell: boolean; consent: { shouldAsk: boolean } }>(
      await request("acme", "/api/v1/analytics/notice", { cookie: ada.cookie }),
    );
    expect(notice.dwell).toBe(false);
    expect(notice.consent.shouldAsk).toBe(true);
  });

  it("recording a grant flips `dwell` on the analytics notice", async () => {
    const put = await request("acme", "/api/v1/compliance/consent", {
      method: "PUT",
      cookie: ada.cookie,
      body: JSON.stringify({ purpose: "analytics_engagement", granted: true, source: "settings" }),
    });
    expect(put.status).toBe(200);
    const state = await json<ConsentState>(put);
    expect(state.purposes.find((p) => p.purpose === "analytics_engagement")).toMatchObject({
      granted: true,
      source: "settings",
      allowed: true,
    });

    const notice = await json<{ dwell: boolean }>(
      await request("acme", "/api/v1/analytics/notice", { cookie: ada.cookie }),
    );
    expect(notice.dwell).toBe(true);
  });

  it("Global Privacy Control overrides a stored grant, everywhere — and is recorded", async () => {
    const state = await json<ConsentState>(
      await request("acme", "/api/v1/compliance/consent", { cookie: ada.cookie, gpc: true }),
    );
    expect(state.gpc).toBe(true);
    // The signal is made durable before the handler reads: a `gpc` refusal is now the newest
    // answer for both purposes, so facts arriving later with no browser attached are refused too.
    expect(state.purposes.find((p) => p.purpose === "analytics_engagement")).toMatchObject({
      granted: false,
      source: "gpc",
      allowed: false,
    });
    expect(state.purposes.find((p) => p.purpose === "email_tracking")).toMatchObject({
      granted: false,
      source: "gpc",
      allowed: false,
    });
    const notice = await json<{ dwell: boolean }>(
      await request("acme", "/api/v1/analytics/notice", { cookie: ada.cookie, gpc: true }),
    );
    expect(notice.dwell).toBe(false);
    // …and without the header too: the refusal is stored.
    const later = await json<{ dwell: boolean }>(
      await request("acme", "/api/v1/analytics/notice", { cookie: ada.cookie }),
    );
    expect(later.dwell).toBe(false);
  });

  it("an answer sent with `Sec-GPC: 1` is recorded as having come from the browser signal", async () => {
    const before = await consentRows(ada.membershipId);
    const put = await request("acme", "/api/v1/compliance/consent", {
      method: "PUT",
      cookie: ada.cookie,
      gpc: true,
      body: JSON.stringify({ purpose: "analytics_engagement", granted: false }),
    });
    expect(put.status).toBe(200);
    const events = await consentRows(ada.membershipId);
    expect(events[0]).toMatchObject({ source: "gpc", granted: false });
    // Append-only: the explicit answer is one new row; the grant is still on record, and the
    // middleware did not append again (the newest answers were already GPC refusals).
    expect(events).toHaveLength(before.length + 1);
    expect(events.some((e) => e.granted && e.source === "settings")).toBe(true);

    // A grant sent with GPC contradicts itself: refused, nothing written.
    const grant = await request("acme", "/api/v1/compliance/consent", {
      method: "PUT",
      cookie: ada.cookie,
      gpc: true,
      body: JSON.stringify({ purpose: "email_tracking", granted: true, source: "settings" }),
    });
    expect(grant.status).toBe(409);
    expect(await json<{ error: { reason?: string } }>(grant)).toMatchObject({
      error: { reason: "gpc" },
    });
    expect(await consentRows(ada.membershipId)).toHaveLength(before.length + 1);
  });

  it("GPC is durable: later `allowsPurpose(email_tracking)` without signals says no in opt-out and notice-only", async () => {
    const legal = createLegalPort({
      db: running.container.db,
      audit: running.container.audit,
      bookingSuppressionKeys: running.container.envelope,
    });
    const allows = (membershipId: string, purpose: "email_tracking" | "analytics_engagement") => {
      const ctx = systemContext(acmeId);
      return running.container.db.withTenant(ctx, (tx) =>
        legal.allowsPurpose(tx, ctx, membershipId, purpose),
      );
    };
    const setMode = async (consentMode: string) => {
      const res = await request("acme", "/api/v1/compliance/settings", {
        method: "PATCH",
        cookie: owner.cookie,
        body: JSON.stringify({ consentMode }),
      });
      expect(res.status).toBe(200);
    };
    const carol = await member("acme", acmeId, "carol@investor.test", "external", "investor");
    try {
      await setMode("opt_out");
      // Never asked: allowed in this mode (an ESP open would be recorded).
      expect(await allows(carol.membershipId, "email_tracking")).toBe(true);
      // Any signed-in request carrying the signal — not a consent route, and even one the
      // acceptance gate refuses — makes it durable.
      await request("acme", "/api/v1/access/my", { cookie: carol.cookie, gpc: true });
      for (const mode of ["opt_out", "notice_only"] as const) {
        await setMode(mode);
        expect(await allows(carol.membershipId, "email_tracking")).toBe(false);
        expect(await allows(carol.membershipId, "analytics_engagement")).toBe(false);
      }
      const recorded = await consentRows(carol.membershipId);
      expect(recorded).toHaveLength(2);
      expect(recorded.every((r) => r.source === "gpc" && !r.granted)).toBe(true);

      // Once: more GPC requests append nothing (cached in-process, and re-checked cold too).
      await request("acme", "/api/v1/access/my", { cookie: carol.cookie, gpc: true });
      resetGpcRefusalCache();
      await request("acme", "/api/v1/access/my", { cookie: carol.cookie, gpc: true });
      expect(await consentRows(carol.membershipId)).toHaveLength(2);

      // A later explicit grant from a browser without GPC is a newer fact and wins…
      const grant = await request("acme", "/api/v1/compliance/consent", {
        method: "PUT",
        cookie: carol.cookie,
        body: JSON.stringify({ purpose: "email_tracking", granted: true, source: "settings" }),
      });
      expect(grant.status).toBe(200);
      expect(await allows(carol.membershipId, "email_tracking")).toBe(true);
      // …until the GPC browser is back, which records a newer refusal (the grant made the
      // cached "already refused" fact stale, so it was dropped).
      await request("acme", "/api/v1/access/my", { cookie: carol.cookie, gpc: true });
      expect(await allows(carol.membershipId, "email_tracking")).toBe(false);
      const after = await consentRows(carol.membershipId);
      expect(after).toHaveLength(4);
      expect(after[0]).toMatchObject({ purpose: "email_tracking", source: "gpc", granted: false });
    } finally {
      await setMode("opt_in");
    }
  });
});

/** A member's consent rows, newest first. */
async function consentRows(membershipId: string) {
  return rows<{ purpose: string; source: string; granted: boolean }>(
    `SELECT purpose, source, granted FROM core.consent_event
     WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${membershipId}'::uuid
     ORDER BY recorded_at DESC, id DESC`,
  );
}

describe("the pre-existing relationship on the People screen", () => {
  it("warns about a 506(b) membership with nothing recorded, and stops once it is", async () => {
    const before = await json<{ person: { relationship: { warning: { code: string } | null } } }>(
      await request("acme", `/api/v1/access/people/${ada.membershipId}`, { cookie: owner.cookie }),
    );
    expect(before.person.relationship.warning?.code).toBe("no_source");

    const patched = await request("acme", `/api/v1/access/people/${ada.membershipId}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({
        relationship: {
          source: "intro",
          establishedAt: "2024-01-15T00:00:00.000Z",
          note: "Introduced by a mutual portfolio founder.",
        },
      }),
    });
    expect(patched.status).toBe(200);
    const person = await json<{
      relationship: { source: string; note: string; warning: { code: string } | null };
    }>(patched);
    expect(person.relationship).toMatchObject({ source: "intro", warning: null });
    expect(person.relationship.note).toContain("portfolio founder");

    const audit = await rows<{ action: string }>(
      `SELECT action FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'membership.relationship_recorded'`,
    );
    expect(audit.length).toBe(1);
  });

  it("never warns about staff, whatever the offering status", async () => {
    const staff = await json<{ person: { relationship: { warning: unknown } } }>(
      await request("acme", `/api/v1/access/people/${owner.membershipId}`, {
        cookie: owner.cookie,
      }),
    );
    expect(staff.person.relationship.warning).toBeNull();
  });
});

describe("isolation", () => {
  it("a legal document is invisible from another workspace", async () => {
    const res = await request("globex", `/api/v1/compliance/documents/${noticeId}`, {
      cookie: globexOwner.cookie,
    });
    expect(res.status).toBe(404);
    const list = await json<{ documents: unknown[] }>(
      await request("globex", "/api/v1/compliance/documents", { cookie: globexOwner.cookie }),
    );
    expect(list.documents).toEqual([]);
    // Acme's periods are Acme's: Globex opens its own on first read.
    const state = await json<OfferingState>(
      await request("globex", "/api/v1/compliance/offering", { cookie: globexOwner.cookie }),
    );
    expect(state.history).toHaveLength(1);
    expect(state.status).toBe("none");
  });

  it("an external member cannot read another member's attestations or consent (0006 RLS)", async () => {
    // Both rows exist and staff can see them.
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM core.attestation
           WHERE workspace_id = '${acmeId}'::uuid AND membership_id = '${bob.membershipId}'::uuid`,
        )
      )[0]?.n,
    ).toBe(1);

    // Ada, as herself, sees only her own — `core.attestation` shipped in 0001 with a permissive
    // `FOR ALL` policy that let any member read another member's legal facts.
    const bobsAttestations = await rowsAsExternal<{ n: number }>(
      acmeId,
      ada.membershipId,
      `SELECT count(*)::int AS n FROM core.attestation
       WHERE membership_id = '${bob.membershipId}'::uuid`,
    );
    expect(bobsAttestations[0]?.n).toBe(0);
    const ownAttestations = await rowsAsExternal<{ n: number }>(
      acmeId,
      ada.membershipId,
      `SELECT count(*)::int AS n FROM core.attestation
       WHERE membership_id = '${ada.membershipId}'::uuid`,
    );
    expect(ownAttestations[0]?.n).toBe(2);

    const bobsConsent = await rowsAsExternal<{ n: number }>(
      acmeId,
      bob.membershipId,
      `SELECT count(*)::int AS n FROM core.consent_event
       WHERE membership_id = '${ada.membershipId}'::uuid`,
    );
    expect(bobsConsent[0]?.n).toBe(0);

    // Offering periods are staff evidence and are never exposed to investors at all.
    const periods = await rowsAsExternal<{ n: number }>(
      acmeId,
      ada.membershipId,
      `SELECT count(*)::int AS n FROM core.offering_period`,
    );
    expect(periods[0]?.n).toBe(0);
  });
});

describe("accessibility statement (E2.8)", () => {
  interface Statement {
    source: string;
    title: string;
    bodyMarkdown: string;
    effectiveDate: string;
    version: number | null;
  }
  const INITECH_BODY = "# Accessibility at Initech\n\nOur own words, reviewed by counsel.";

  it("is public and falls back to the shipped template rendered with the workspace's facts", async () => {
    const res = await request("globex", "/api/v1/compliance/accessibility-statement");
    expect(res.status).toBe(200);
    const body = await json<Statement>(res);
    expect(body.source).toBe("default");
    expect(body.version).toBeNull();
    expect(body.title).toBe("Accessibility statement");
    expect(body.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(body.bodyMarkdown).toContain("Globex wants everyone to be able to use");
    expect(body.bodyMarkdown).toContain("http://globex.portal.example.test/");
    expect(body.bodyMarkdown).not.toContain("{{");
  });

  it("dates the default statement by the workspace's creation, not by the request", async () => {
    // A workspace created on 2025-03-14 (UUIDv7 ids carry their minting instant; the row's
    // created_at agrees). "Today" would be any day but this one.
    const created = new Date("2025-03-14T23:30:00.000Z");
    const hex = created.getTime().toString(16).padStart(12, "0");
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-${randomBytes(6).toString("hex")}`;
    await running.container.db.withHost(async (tx) => {
      await tx.execute(
        `INSERT INTO core.workspace (id, slug, name, created_at)
           VALUES ('${id}'::uuid, 'hooli', 'Hooli', '${created.toISOString()}'::timestamptz)`,
      );
    });
    const first = await json<Statement>(
      await request("hooli", "/api/v1/compliance/accessibility-statement"),
    );
    expect(first.source).toBe("default");
    expect(first.effectiveDate).toBe("2025-03-14");
    expect(first.bodyMarkdown).toContain("**Effective date:** 2025-03-14");
    expect(first.bodyMarkdown).toContain("**Version:** 1");

    // And for a workspace made the ordinary way: its created_at day (UTC), on every request.
    const [globex] = await rows<{ day: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
         FROM core.workspace WHERE id = '${globexId}'::uuid`,
      globexId,
    );
    const again = await json<Statement>(
      await request("globex", "/api/v1/compliance/accessibility-statement"),
    );
    expect(again.effectiveDate).toBe(globex?.day);
  });

  it("serves the workspace's published statement, and never another workspace's", async () => {
    const created = await request("initech", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: initechOwner.cookie,
      body: JSON.stringify({ slug: "accessibility", from: "accessibility-statement" }),
    });
    expect(created.status).toBe(200);
    const detail = await json<DocumentDetail>(created);
    const second = await request(
      "initech",
      `/api/v1/compliance/documents/${detail.document.id}/versions`,
      { method: "POST", cookie: initechOwner.cookie, body: JSON.stringify({ body: INITECH_BODY }) },
    );
    expect(second.status).toBe(200);

    const mine = await json<Statement>(
      await request("initech", "/api/v1/compliance/accessibility-statement"),
    );
    expect(mine).toMatchObject({ source: "published", version: 2, bodyMarkdown: INITECH_BODY });
    expect(mine.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/u);

    // Globex (and Acme) still get their own default text: nothing of Initech's leaks across.
    for (const slug of ["globex", "acme"]) {
      const other = await json<Statement>(
        await request(slug, "/api/v1/compliance/accessibility-statement"),
      );
      expect(other.source).toBe("default");
      expect(other.bodyMarkdown).not.toContain("Initech");
      expect(other.bodyMarkdown).not.toContain("Our own words");
    }
  });
});

describe("erasure and a concurrent owner revocation never leave the workspace ownerless (E3.2 L-1)", () => {
  it("the erasure waits for the revocation's owner lock and then refuses the last owner", async () => {
    // Revoking owner B and erasing owner A at once each used to count the other as the surviving
    // owner: the revoke locks the owner rows (R1-A5) but the erasure counted without the lock, so
    // it read B as still active and went on to revoke A. Made deterministic: the revocation holds
    // its lock uncommitted until the erasure is blocked on a lock, then commits. (Here, not in
    // dsar.integration.test.ts: that file runs on a one-connection pool, which cannot interleave.)
    const db = running.container.db;
    const deps = running.container.identityDeps;
    const wsId = (await createWorkspace(db, { slug: "l1-owners", name: "Two Owners" })).id;
    const owner = async (email: string) => {
      const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
      return (
        await provisionMembership(deps, {
          workspaceId: wsId,
          userId: user.userId,
          kind: "staff",
          role: "owner",
          source: "test",
        })
      ).id;
    };
    const a = await owner("a@l1-owners.test");
    const b = await owner("b@l1-owners.test");
    const ctx = systemContext(wsId);

    let release: () => void = () => {};
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => {};
    const revokeLocked = new Promise<void>((r) => {
      locked = r;
    });
    // Exactly what `memberships.revoke` does for an owner: lock, check the floor, revoke.
    const revokeB = db.withTenant(ctx, async (tx) => {
      const repo = new MembershipRepo(ctx, tx);
      await repo.lockOwners();
      expect(await repo.countActiveOwners(new Date(), { excluding: b })).toBe(1);
      await repo.revoke(b, { reason: "test" });
      locked();
      await hold;
    });
    await revokeLocked;
    const eraseA = db
      .withTenant(ctx, (tx) =>
        createErasureService({
          db,
          audit: running.container.audit,
          bookingSuppressionKeys: running.container.envelope,
        }).request(ctx, tx, {
          membershipId: a,
          expectedModules: [],
          actor: { membershipId: a },
        }),
      )
      .then(
        () => "erased" as const,
        (error: unknown) => (error as { details?: { reason?: string } }).details?.reason ?? error,
      );
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        // The pool's login role (not `seedhost_app`) is what may read other sessions' state.
        const waiting = await db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active'`,
        );
        if ((waiting.rows[0]?.n ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("the erasure never blocked on the revocation");
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      release();
    }
    await revokeB;
    expect(await eraseA).toBe("last_owner");
    const live = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.membership
        WHERE workspace_id = '${wsId}'::uuid AND role = 'owner' AND status = 'active'`,
      wsId,
    );
    expect(live[0]?.n).toBe(1);
  });
});
