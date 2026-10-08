import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createErasureService } from "@fundroom/compliance";
import { loadConfig } from "@fundroom/config";
import { checkRlsCatalog, createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { EventEnvelope } from "@fundroom/events";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { defineModule, type ModuleManifest } from "@fundroom/module-kit";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * E2.6 decisions 4 and 5 end to end: consent tiers by region on the compliance settings route,
 * and the kernel-orchestrated DSAR erasure request.
 *
 * The compiled-in modules' own `member.erasure_requested` subscribers are stripped here and two
 * probe modules stand in for them, so `expected_modules` is a fact this file controls rather than
 * whatever the analytics/notify/updates/crm packages declare today (their subscribers have their
 * own tests). Both probes record every event they are handed, which proves the topic went through
 * the outbox. `probe-b` is off by default (`defaultEnabled: false`): erasure ignores enablement
 * (decision 5 as amended) — a disabled module's old rows are still personal data — so it is still
 * waited for and its subscriber still runs. Steps are reported through the container's real
 * `legal.completeErasureStep`.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
const TOPIC = "member.erasure_requested";
const DAY_MS = 24 * 60 * 60 * 1000;
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

const seenByProbe: EventEnvelope<typeof TOPIC>[] = [];
const seenByProbeB: EventEnvelope<typeof TOPIC>[] = [];

const probeA = defineModule({
  id: "probe-a",
  version: "1.0.0",
  events: {
    handles: {
      [TOPIC]: async (event) => {
        seenByProbe.push(event as EventEnvelope<typeof TOPIC>);
      },
    },
  },
});

const probeB = defineModule({
  id: "probe-b",
  version: "1.0.0",
  defaultEnabled: false,
  events: {
    handles: {
      [TOPIC]: async (event) => {
        seenByProbeB.push(event as EventEnvelope<typeof TOPIC>);
      },
    },
  },
});

/** The compiled-in modules minus their erasure subscribers (see the header). */
function withoutErasureHandlers(modules: readonly ModuleManifest[]): ModuleManifest[] {
  return modules.map((m) => {
    const handles = m.events?.handles;
    if (handles?.[TOPIC] === undefined) return m;
    const { [TOPIC]: _dropped, ...rest } = handles;
    return { ...m, events: { ...m.events, handles: rest } };
  });
}

interface Actor {
  cookie: string;
  membershipId: string;
}

interface Settings {
  consentMode: string;
  privacyRegion: string | null;
  legalHold: boolean;
  suggestedConsentMode: string;
  consentModeWeakerThanRegion: boolean;
}

interface Erasure {
  id: string;
  membershipId: string;
  memberName: string | null;
  requestedBy: string | null;
  requestedAt: string;
  dueAt: string;
  overdue: boolean;
  status: "requested" | "completed" | "cancelled";
  expectedModules: string[];
  completedModules: string[];
  pendingModules: string[];
  steps: {
    module: string;
    completedAt: string;
    counts: Record<string, number>;
    expected: boolean;
  }[];
  completedAt: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  note: string | null;
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
  role: "owner" | "admin" | "legal" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

/** Rows read as the `system` actor of a workspace. */
async function rows<T>(query: string, workspaceId: string): Promise<T[]> {
  return running.container.db.withTenant(systemContext(workspaceId), async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

async function backdateSession(actor: Actor, workspaceId: string, ageMs: number): Promise<void> {
  const userId = (
    await rows<{ userId: string }>(
      `SELECT user_id AS "userId" FROM core.membership WHERE id = '${actor.membershipId}'::uuid`,
      workspaceId,
    )
  )[0]?.userId;
  expect(userId).toBeDefined();
  const updated = await running.container.db.withHost(async (tx) => {
    const r = await tx.execute(
      `UPDATE core.session SET auth_time = now() - interval '${ageMs} milliseconds'
         WHERE user_id = '${userId}'::uuid AND revoked_at IS NULL RETURNING id`,
    );
    return r.rows.length;
  });
  expect(updated).toBeGreaterThan(0);
}

/** A module reporting its step, exactly as a subscriber would: the container's legal services. */
async function reportStep(
  workspaceId: string,
  requestId: string,
  module: string,
  counts: Record<string, number>,
): Promise<void> {
  const ctx = systemContext(workspaceId);
  await running.container.db.withTenant(ctx, (tx) =>
    running.container.moduleServices.legal.completeErasureStep(tx, ctx, requestId, module, counts),
  );
}

async function patchSettings(actor: Actor, body: Record<string, unknown>): Promise<Settings> {
  const res = await request("acme", "/api/v1/compliance/settings", {
    method: "PATCH",
    cookie: actor.cookie,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return json<Settings>(res);
}

async function createErasure(
  slug: string,
  actor: Actor,
  membershipId: string,
  note?: string,
): Promise<Response> {
  return request(slug, "/api/v1/compliance/erasure-requests", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify({ membershipId, ...(note === undefined ? {} : { note }) }),
  });
}

async function getErasure(slug: string, actor: Actor, id: string): Promise<Erasure> {
  const res = await request(slug, `/api/v1/compliance/erasure-requests/${id}`, {
    cookie: actor.cookie,
  });
  expect(res.status).toBe(200);
  return json<Erasure>(res);
}

async function auditActions(workspaceId: string, resourceId: string) {
  return rows<{ action: string; meta: Record<string, unknown> }>(
    `SELECT action, meta FROM audit.event WHERE workspace_id = '${workspaceId}'::uuid
       AND resource_id = '${resourceId}' ORDER BY occurred_at, seq`,
    workspaceId,
  );
}

let acmeId: string;
let globexId: string;
let owner: Actor;
let counsel: Actor;
let stale: Actor;
let ada: Actor;
let bob: Actor;
let carol: Actor;
let globexOwner: Actor;
let gina: Actor;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      // One connection: `LegalServices.isErased`/`allowsPurpose` are called inside a caller's
      // transaction (analytics tracking and ingest), and the identity step runs inside a
      // module's. Anything taking a second connection there hangs this file instead of passing.
      DATABASE_POOL_MAX: "1",
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
    modules: [...withoutErasureHandlers(COMPILED_IN_MODULES), probeA, probeB],
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(running.container.db, { slug: "globex", name: "Globex" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  counsel = await member("acme", acmeId, "counsel@example.com", "staff", "legal");
  stale = await member("acme", acmeId, "stale@example.com", "staff", "legal");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  bob = await member("acme", acmeId, "bob@investor.test", "external", "investor");
  carol = await member("acme", acmeId, "carol@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@example.org", "staff", "owner");
  gina = await member("globex", globexId, "gina@investor.test", "external", "investor");
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema", () => {
  it("the DSAR tables pass the RLS catalog check", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });

  it("only the two probes handle the topic", async () => {
    const handlers = running.container.registry.modules
      .filter((m) => m.events?.handles?.[TOPIC] !== undefined)
      .map((m) => m.id);
    expect(handlers.sort()).toEqual(["probe-a", "probe-b"]);
  });
});

describe("consent tiers by region (decision 4)", () => {
  it("reads the region, the hold and the suggestion", async () => {
    const res = await request("acme", "/api/v1/compliance/settings", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(await json<Settings>(res)).toMatchObject({
      consentMode: "opt_in",
      privacyRegion: null,
      legalHold: false,
      suggestedConsentMode: "opt_in",
      consentModeWeakerThanRegion: false,
    });
  });

  it("a region with no mode applies the region's suggestion, and the audit row records it", async () => {
    const uk = await patchSettings(owner, { privacyRegion: "uk" });
    expect(uk).toMatchObject({
      privacyRegion: "uk",
      consentMode: "opt_out",
      suggestedConsentMode: "opt_out",
      consentModeWeakerThanRegion: false,
    });
    const audit = await rows<{ meta: Record<string, unknown>; diff: Record<string, unknown> }>(
      `SELECT meta, diff FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'legal.settings_changed' ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
      acmeId,
    );
    expect(audit[0]?.meta).toMatchObject({
      privacyRegion: "uk",
      consentModeSource: "region_default",
      fields: ["privacyRegion"],
    });
  });

  it("a region sent with a mode keeps the admin's mode and warns when it is weaker", async () => {
    const eu = await patchSettings(owner, { privacyRegion: "eu", consentMode: "notice_only" });
    expect(eu).toMatchObject({
      privacyRegion: "eu",
      consentMode: "notice_only",
      suggestedConsentMode: "opt_in",
      consentModeWeakerThanRegion: true,
    });
    // The GET says the same: the warning is a read of stored facts, not a one-off response.
    const read = await json<Settings>(
      await request("acme", "/api/v1/compliance/settings", { cookie: owner.cookie }),
    );
    expect(read.consentModeWeakerThanRegion).toBe(true);
  });

  it("re-sending the same region never silently resets the admin's mode", async () => {
    const again = await patchSettings(owner, { privacyRegion: "eu", enforceAcceptance: true });
    expect(again.consentMode).toBe("notice_only");
    expect(again.consentModeWeakerThanRegion).toBe(true);
  });

  it("the stored mode is what consent reads — a region is never applied at read time", async () => {
    // eu region + notice_only: the effective decision must follow notice_only (permit until
    // objection), not the region's opt_in.
    const consent = await json<{ consentMode: string }>(
      await request("acme", "/api/v1/compliance/consent", { cookie: ada.cookie }),
    );
    expect(consent.consentMode).toBe("notice_only");
    await patchSettings(owner, { consentMode: "opt_in" });
  });

  it("an investor cannot read or change the settings", async () => {
    expect(
      (await request("acme", "/api/v1/compliance/settings", { cookie: ada.cookie })).status,
    ).toBe(404);
  });
});

describe("DSAR erasure (decision 5)", () => {
  let adaRequest: Erasure;

  it("records the request, freezes the expected modules and starts the 30-day clock (EU)", async () => {
    const res = await createErasure("acme", owner, ada.membershipId, "email of 2026-09-22");
    expect(res.status).toBe(201);
    adaRequest = await json<Erasure>(res);
    expect(adaRequest).toMatchObject({
      membershipId: ada.membershipId,
      memberName: "ada",
      requestedBy: owner.membershipId,
      status: "requested",
      // probe-b is not enabled here, and is waited for all the same.
      expectedModules: ["probe-a", "probe-b"],
      completedModules: [],
      pendingModules: ["probe-a", "probe-b"],
      steps: [],
      overdue: false,
      note: "email of 2026-09-22",
    });
    expect(Date.parse(adaRequest.dueAt) - Date.parse(adaRequest.requestedAt)).toBe(30 * DAY_MS);

    const audit = await auditActions(acmeId, adaRequest.id);
    expect(audit.map((a) => a.action)).toEqual(["dsar.erasure_requested"]);
    expect(audit[0]?.meta).toMatchObject({
      privacyRegion: "eu",
      expectedModules: ["probe-a", "probe-b"],
    });
  });

  it("publishes member.erasure_requested through the outbox to the modules", async () => {
    const outbox = await running.container.db.withHost(async (tx) => {
      const r = await tx.execute(
        `SELECT payload FROM core.outbox WHERE workspace_id = '${acmeId}'::uuid
           AND topic = '${TOPIC}'`,
      );
      return r.rows as { payload: { requestId: string; membershipId: string } }[];
    });
    expect(outbox.map((o) => o.payload)).toContainEqual({
      requestId: adaRequest.id,
      membershipId: ada.membershipId,
    });
    // Both subscribers run — including probe-b, which is disabled in this workspace: the
    // dispatcher does not gate on enablement, and erasure must not either.
    const deadline = Date.now() + 10_000;
    const got = (seen: EventEnvelope<typeof TOPIC>[]) =>
      seen.some((e) => e.payload.requestId === adaRequest.id);
    while (!got(seenByProbe) || !got(seenByProbeB)) {
      if (Date.now() > deadline) throw new Error("a probe never received the event");
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  it("refuses a second open request for the same member (409)", async () => {
    const res = await createErasure("acme", counsel, ada.membershipId);
    expect(res.status).toBe(409);
    const body = await json<{ error: Record<string, string> }>(res);
    expect(body.error).toMatchObject({
      code: "conflict",
      reason: "erasure_open",
      erasureRequestId: adaRequest.id,
    });
  });

  it("an unknown member is 404, and nothing is written", async () => {
    const res = await createErasure("acme", owner, randomUUID());
    expect(res.status).toBe(404);
  });

  it("completes only when every expected module has reported; reports are idempotent", async () => {
    await reportStep(acmeId, adaRequest.id, "probe-b", { rows: 2 });
    const half = await getErasure("acme", owner, adaRequest.id);
    expect(half).toMatchObject({
      status: "requested",
      completedModules: ["probe-b"],
      pendingModules: ["probe-a"],
      completedAt: null,
    });

    await reportStep(acmeId, adaRequest.id, "probe-a", { events: 12, sessions: 3 });
    const done = await getErasure("acme", owner, adaRequest.id);
    expect(done).toMatchObject({
      status: "completed",
      completedModules: ["probe-a", "probe-b"],
      pendingModules: [],
    });
    expect(done.steps.find((st) => st.module === "probe-a")).toMatchObject({
      counts: { events: 12, sessions: 3 },
      expected: true,
    });
    expect(done.completedAt).not.toBeNull();

    // A redelivered event reports again: the first report stands and nothing new is audited.
    await reportStep(acmeId, adaRequest.id, "probe-a", { events: 99 });
    const again = await getErasure("acme", owner, adaRequest.id);
    expect(again.steps).toEqual(done.steps);
    expect(again.completedAt).toBe(done.completedAt);

    // E2.7: the kernel's identity step runs last, in the same transaction, then the request
    // completes.
    expect((await auditActions(acmeId, adaRequest.id)).map((a) => a.action)).toEqual([
      "dsar.erasure_requested",
      "dsar.erasure_step_completed",
      "dsar.erasure_step_completed",
      "compliance.identity_erased",
      "dsar.erasure_completed",
    ]);
  });

  it("a late report from a module nobody waited for is kept as evidence and changes nothing", async () => {
    await reportStep(acmeId, adaRequest.id, "probe-c", { rows: 1 });
    const after = await getErasure("acme", owner, adaRequest.id);
    expect(after.status).toBe("completed");
    expect(after.steps.find((s) => s.module === "probe-c")?.expected).toBe(false);
  });

  it("an unknown request id is not an error for the reporting module", async () => {
    await expect(reportStep(acmeId, randomUUID(), "probe-a", {})).resolves.toBeUndefined();
  });

  it("waits for a module even when it is switched off for the workspace", async () => {
    // Both probes off here: enablement is an admin preference about screens, not a licence to
    // keep a person's rows after they asked for erasure.
    await rows(
      `INSERT INTO core.module_enablement (workspace_id, module, enabled)
         VALUES ('${acmeId}'::uuid, 'probe-a', false)`,
      acmeId,
    );
    running.container.enablement.invalidate(acmeId);
    const res = await createErasure("acme", owner, carol.membershipId);
    expect(res.status).toBe(201);
    const req = await json<Erasure>(res);
    expect(req).toMatchObject({ status: "requested", expectedModules: ["probe-a", "probe-b"] });

    await reportStep(acmeId, req.id, "probe-a", { rows: 5 });
    await reportStep(acmeId, req.id, "probe-b", { rows: 2 });
    expect((await getErasure("acme", owner, req.id)).status).toBe("completed");
    await rows(
      `DELETE FROM core.module_enablement WHERE workspace_id = '${acmeId}'::uuid
         AND module = 'probe-a'`,
      acmeId,
    );
    running.container.enablement.invalidate(acmeId);
  });

  it("uses the 45-day clock for a US workspace", async () => {
    await patchSettings(owner, { privacyRegion: "us", consentMode: "opt_in" });
    const res = await createErasure("acme", owner, bob.membershipId);
    expect(res.status).toBe(201);
    const req = await json<Erasure>(res);
    expect(Date.parse(req.dueAt) - Date.parse(req.requestedAt)).toBe(45 * DAY_MS);
  });

  it("cancels an open request once; a closed request cannot be cancelled again", async () => {
    const open = (
      await json<{ items: Erasure[] }>(
        await request(
          "acme",
          `/api/v1/compliance/erasure-requests?status=requested&membershipId=${bob.membershipId}`,
          { cookie: owner.cookie },
        ),
      )
    ).items;
    expect(open).toHaveLength(1);
    const id = open[0]?.id ?? "";

    const cancel = await request("acme", `/api/v1/compliance/erasure-requests/${id}/cancel`, {
      method: "POST",
      cookie: counsel.cookie,
    });
    expect(cancel.status).toBe(200);
    expect(await json<Erasure>(cancel)).toMatchObject({
      status: "cancelled",
      cancelledBy: counsel.membershipId,
      completedAt: null,
    });

    const twice = await request("acme", `/api/v1/compliance/erasure-requests/${id}/cancel`, {
      method: "POST",
      cookie: counsel.cookie,
    });
    expect(twice.status).toBe(409);

    // A module finishing after the cancel is recorded (it did erase), but the state stays.
    await reportStep(acmeId, id, "probe-a", { rows: 1 });
    expect((await getErasure("acme", owner, id)).status).toBe("cancelled");

    // Cancelling frees the member for a new request.
    const fresh = await createErasure("acme", owner, bob.membershipId);
    expect(fresh.status).toBe(201);
    expect((await auditActions(acmeId, id)).map((a) => a.action)).toContain(
      "dsar.erasure_cancelled",
    );
  });

  it("is refused with 409 legal_hold while the workspace is under legal hold", async () => {
    await patchSettings(owner, { legalHold: true });
    const before = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.dsar_request WHERE workspace_id = '${acmeId}'::uuid`,
      acmeId,
    );
    const res = await createErasure("acme", owner, carol.membershipId);
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string; reason: string } }>(res)).error).toMatchObject({
      code: "conflict",
      reason: "legal_hold",
    });
    const after = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.dsar_request WHERE workspace_id = '${acmeId}'::uuid`,
      acmeId,
    );
    expect(after[0]?.n).toBe(before[0]?.n);
    await patchSettings(owner, { legalHold: false });
  });

  it("lists newest first on a cursor that carries the whole key", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const res = await request("acme", `/api/v1/compliance/erasure-requests?limit=1${q}`, {
        cookie: owner.cookie,
      });
      expect(res.status).toBe(200);
      const page = await json<{ items: Erasure[]; nextCursor: string | null }>(res);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    const all = await rows<{ id: string }>(
      `SELECT id FROM core.dsar_request WHERE workspace_id = '${acmeId}'::uuid
         ORDER BY requested_at DESC, id DESC`,
      acmeId,
    );
    expect(seen).toEqual(all.map((r) => r.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("flags a still-open request past its due date as overdue", async () => {
    const res = await createErasure("acme", owner, carol.membershipId);
    expect(res.status).toBe(201);
    const req = await json<Erasure>(res);
    expect(req.overdue).toBe(false);
    // The row refuses a rewrite of its clock (next test), so the backdate goes around the
    // trigger as the harness's superuser — the only way to make forty days pass in a test.
    await pg.pool.query(
      `ALTER TABLE core.dsar_request DISABLE TRIGGER dsar_request_transition_only;
       UPDATE core.dsar_request SET requested_at = now() - interval '40 days',
         due_at = now() - interval '10 days' WHERE id = '${req.id}'::uuid;
       ALTER TABLE core.dsar_request ENABLE TRIGGER dsar_request_transition_only;`,
    );
    expect((await getErasure("acme", owner, req.id)).overdue).toBe(true);
  });

  it("a request's clock and a step's counts cannot be rewritten", async () => {
    await expect(
      rows(
        `UPDATE core.dsar_request SET due_at = due_at + interval '1 day'
           WHERE id = '${adaRequest.id}'::uuid`,
        acmeId,
      ),
    ).rejects.toThrow();
    await expect(
      rows(
        `UPDATE core.dsar_request SET status = 'requested', completed_at = NULL
           WHERE id = '${adaRequest.id}'::uuid`,
        acmeId,
      ),
    ).rejects.toThrow();
    // No UPDATE policy on the step table: through the app role the write matches nothing …
    const updated = await rows(
      `UPDATE core.dsar_step SET counts = '{}'::jsonb
         WHERE request_id = '${adaRequest.id}'::uuid RETURNING module`,
      acmeId,
    );
    expect(updated).toEqual([]);
    // … and even the table owner, past RLS, meets the insert-only trigger.
    await expect(
      pg.pool.query(
        `UPDATE core.dsar_step SET counts = '{}'::jsonb WHERE request_id = '${adaRequest.id}'::uuid`,
      ),
    ).rejects.toThrow(/immutable/u);
  });
});

describe("DSAR access control", () => {
  it("an investor gets 404 on every erasure route (no oracle)", async () => {
    const id = randomUUID();
    const calls: [string, string][] = [
      ["POST", "/api/v1/compliance/erasure-requests"],
      ["GET", "/api/v1/compliance/erasure-requests"],
      ["GET", `/api/v1/compliance/erasure-requests/${id}`],
      ["POST", `/api/v1/compliance/erasure-requests/${id}/cancel`],
    ];
    // Not ada: her erasure has completed, and its identity step (E2.7) revoked her sessions.
    // Bob's request was cancelled before it finished, so he is still signed in.
    for (const [method, path] of calls) {
      const res = await request("acme", path, {
        method,
        cookie: bob.cookie,
        ...(method === "POST" ? { body: JSON.stringify({ membershipId: bob.membershipId }) } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("an investor's own context sees no DSAR rows at all (RLS)", async () => {
    const ctx = {
      workspaceId: acmeId,
      actorKind: "external" as const,
      membershipId: ada.membershipId,
    };
    const seen = await running.container.db.withTenant(ctx, async (tx) => {
      const r = await tx.execute(
        "SELECT id FROM core.dsar_request UNION ALL SELECT request_id FROM core.dsar_step",
      );
      return r.rows;
    });
    expect(seen).toEqual([]);
  });

  it("recording and cancelling need a fresh session", async () => {
    await backdateSession(stale, acmeId, 30 * 60_000);
    // The read does not ask for freshness — the same cookie still lists.
    expect(
      (await request("acme", "/api/v1/compliance/erasure-requests", { cookie: stale.cookie }))
        .status,
    ).toBe(200);
    const res = await createErasure("acme", stale, carol.membershipId);
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string; reason: string } }>(res)).error).toMatchObject({
      code: "step_up_required",
      reason: "fresh",
    });
    const [any] = await rows<{ id: string }>(
      `SELECT id FROM core.dsar_request WHERE workspace_id = '${acmeId}'::uuid LIMIT 1`,
      acmeId,
    );
    const cancel = await request("acme", `/api/v1/compliance/erasure-requests/${any?.id}/cancel`, {
      method: "POST",
      cookie: stale.cookie,
    });
    expect(cancel.status).toBe(403);
  });
});

describe("tenant isolation", () => {
  it("another workspace cannot see, cancel or complete acme's requests", async () => {
    const [acmeReq] = await rows<{ id: string; status: string }>(
      `SELECT id, status FROM core.dsar_request WHERE workspace_id = '${acmeId}'::uuid
         AND status = 'requested' LIMIT 1`,
      acmeId,
    );
    expect(acmeReq).toBeDefined();
    const id = acmeReq?.id ?? "";
    expect(
      (
        await request("globex", `/api/v1/compliance/erasure-requests/${id}`, {
          cookie: globexOwner.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request("globex", `/api/v1/compliance/erasure-requests/${id}/cancel`, {
          method: "POST",
          cookie: globexOwner.cookie,
        })
      ).status,
    ).toBe(404);
    const list = await json<{ items: Erasure[] }>(
      await request("globex", "/api/v1/compliance/erasure-requests", {
        cookie: globexOwner.cookie,
      }),
    );
    expect(list.items).toEqual([]);
    // An acme member id named from globex is simply not a member there.
    expect((await createErasure("globex", globexOwner, ada.membershipId)).status).toBe(404);

    // A step reported under globex's context does not touch acme's row.
    await reportStep(globexId, id, "probe-a", { rows: 1 });
    await reportStep(globexId, id, "probe-b", { rows: 1 });
    const still = await getErasure("acme", owner, id);
    expect(still.status).toBe("requested");
    expect(still.steps).toEqual([]);
  });

  it("with no module to wait for, a request completes the moment it is recorded", async () => {
    // Every server in this file compiles in two handlers, so the empty expectation is driven
    // through the service the route calls, with the container's own database and audit.
    const ctx = systemContext(globexId);
    const detail = await running.container.db.withTenant(ctx, (tx) =>
      createErasureService({
        db: running.container.db,
        audit: running.container.audit,
        bookingSuppressionKeys: running.container.envelope,
      }).request(ctx, tx, {
        membershipId: gina.membershipId,
        expectedModules: [],
        actor: { membershipId: globexOwner.membershipId },
      }),
    );
    expect(detail.request.status).toBe("completed");
    expect(detail.request.completedAt).not.toBeNull();
    const req = await getErasure("globex", globexOwner, detail.request.id);
    expect(req).toMatchObject({ status: "completed", expectedModules: [], pendingModules: [] });
    const audit = await auditActions(globexId, req.id);
    expect(audit.map((a) => a.action)).toEqual([
      "dsar.erasure_requested",
      "compliance.identity_erased",
      "dsar.erasure_completed",
    ]);
    expect(audit[2]?.meta).toMatchObject({ immediate: true });
  });
});

describe("an erased member is never allowed anything (LegalServices.isErased)", () => {
  it("isErased tracks non-cancelled requests, and allowsPurpose follows it from any context", async () => {
    await patchSettings(owner, { legalHold: false, consentMode: "notice_only" });
    const erin = await member("acme", acmeId, "erin@investor.test", "external", "investor");
    const legal = running.container.moduleServices.legal;
    const sys = systemContext(acmeId);
    // Erin's own context cannot read `core.dsar_request` (RLS): the port must not fail open.
    const own = {
      workspaceId: acmeId,
      actorKind: "external" as const,
      membershipId: erin.membershipId,
    };
    const state = async () => ({
      erased: await running.container.db.withTenant(sys, (tx) =>
        legal.isErased(tx, sys, erin.membershipId),
      ),
      asSystem: await running.container.db.withTenant(sys, (tx) =>
        legal.allowsPurpose(tx, sys, erin.membershipId, "email_tracking"),
      ),
      asSelf: await running.container.db.withTenant(own, (tx) =>
        legal.allowsPurpose(tx, own, erin.membershipId, "analytics_engagement"),
      ),
    });

    // notice_only, never asked: allowed.
    expect(await state()).toEqual({ erased: false, asSystem: true, asSelf: true });

    const first = await json<Erasure>(await createErasure("acme", owner, erin.membershipId));
    expect(await state()).toEqual({ erased: true, asSystem: false, asSelf: false });

    // Cancelled: no longer tracked, so no longer "erased" for this check.
    const cancel = await request("acme", `/api/v1/compliance/erasure-requests/${first.id}/cancel`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(cancel.status).toBe(200);
    expect(await state()).toEqual({ erased: false, asSystem: true, asSelf: true });

    // Completed counts as erased too.
    const second = await json<Erasure>(await createErasure("acme", owner, erin.membershipId));
    await reportStep(acmeId, second.id, "probe-a", {});
    await reportStep(acmeId, second.id, "probe-b", {});
    expect((await getErasure("acme", owner, second.id)).status).toBe("completed");
    expect(await state()).toEqual({ erased: true, asSystem: false, asSelf: false });
  });
});

interface DataRequestRow {
  id: string;
  status: "requested" | "completed" | "cancelled";
  pendingModules: string[];
  steps: { module: string; counts: Record<string, number> }[];
  blockedReason: "last_owner" | null;
}

async function dataRequest(slug: string, actor: Actor, id: string): Promise<DataRequestRow> {
  const res = await request(slug, "/api/v1/compliance/data-requests?kind=erasure&limit=100", {
    cookie: actor.cookie,
  });
  expect(res.status).toBe(200);
  const found = (await json<{ items: DataRequestRow[] }>(res)).items.find((r) => r.id === id);
  if (!found) throw new Error(`no data request ${id}`);
  return found;
}

async function hostRows<T>(query: string): Promise<T[]> {
  return running.container.db.withHost(async (tx) => (await tx.execute(query)).rows as T[]);
}

describe("the identity step never erases the workspace's last owner (R1#1)", () => {
  let initechId: string;
  let o1: Actor;
  let o2: Actor;
  let lawyer: Actor;

  beforeAll(async () => {
    initechId = (await createWorkspace(running.container.db, { slug: "initech", name: "Initech" }))
      .id;
    o1 = await member("initech", initechId, "o1@initech.test", "staff", "owner");
    o2 = await member("initech", initechId, "o2@initech.test", "staff", "owner");
    lawyer = await member("initech", initechId, "lawyer@initech.test", "staff", "legal");
  }, 120_000);

  it("a co-owner stepping down after the request leaves it open and blocked, touching nothing", async () => {
    // Two owners: erasing O2 is allowed when it is asked for.
    const res = await createErasure("initech", o1, o2.membershipId);
    expect(res.status).toBe(201);
    const { id } = await json<Erasure>(res);
    // O1 steps down before the modules finish: O2 is now the only owner.
    await rows(
      `UPDATE core.membership SET role = 'admin' WHERE id = '${o1.membershipId}'::uuid`,
      initechId,
    );
    await reportStep(initechId, id, "probe-a", { rows: 1 });
    await reportStep(initechId, id, "probe-b", { rows: 1 });

    const blocked = await dataRequest("initech", lawyer, id);
    expect(blocked).toMatchObject({
      status: "requested",
      pendingModules: [],
      blockedReason: "last_owner",
    });
    expect(blocked.steps.map((st) => st.module).sort()).toEqual(["probe-a", "probe-b"]);

    // Nothing about O2's identity was touched: still an active owner, still signed in, the
    // login intact.
    const [m] = await rows<{ role: string; status: string }>(
      `SELECT role, status FROM core.membership WHERE id = '${o2.membershipId}'::uuid`,
      initechId,
    );
    expect(m).toEqual({ role: "owner", status: "active" });
    expect((await request("initech", "/api/v1/me", { cookie: o2.cookie })).status).toBe(200);
    const [o2User] = await rows<{ userId: string }>(
      `SELECT user_id AS "userId" FROM core.membership WHERE id = '${o2.membershipId}'::uuid`,
      initechId,
    );
    const [ident] = await hostRows<{ identifier: string; deleted: boolean }>(
      `SELECT ui.identifier::text, u.deleted_at IS NOT NULL AS deleted
         FROM core.user_identity ui JOIN core."user" u ON u.id = ui.user_id
        WHERE u.id = '${o2User?.userId}'::uuid`,
    );
    expect(ident).toEqual({ identifier: "o2@initech.test", deleted: false });
    expect(
      (await auditActions(initechId, id))
        .map((a) => a.action)
        .filter((a) => a.includes("identity")),
    ).toEqual([]);

    // Finishing it by hand is refused while O2 is still the last owner.
    const finish = () =>
      request("initech", `/api/v1/compliance/data-requests/${id}/complete`, {
        method: "POST",
        cookie: lawyer.cookie,
        body: "{}",
      });
    const refused = await finish();
    expect(refused.status).toBe(409);
    expect((await json<{ error: Record<string, unknown> }>(refused)).error).toMatchObject({
      reason: "last_owner",
    });

    // Ownership moves back to O1: now the identity step runs and the request completes.
    await rows(
      `UPDATE core.membership SET role = 'owner' WHERE id = '${o1.membershipId}'::uuid`,
      initechId,
    );
    const done = await finish();
    expect(done.status).toBe(200);
    const body = await json<DataRequestRow>(done);
    expect(body).toMatchObject({ status: "completed", blockedReason: null });
    expect(body.steps.map((st) => st.module)).toContain("core.identity");
    expect((await request("initech", "/api/v1/me", { cookie: o2.cookie })).status).toBe(401);
  });

  it("an erased address can register again and be erased again (R2 H1)", async () => {
    const email = "rex@investor.test";
    const deps = running.container.identityDeps;
    const erase = async (membershipId: string) => {
      await rows(
        `INSERT INTO core.invite (workspace_id, email, token_hash, kind, role, expires_at, status,
             accepted_membership_id, accepted_at)
           VALUES ('${initechId}', '${email}', sha256(convert_to(gen_random_uuid()::text, 'UTF8')),
                   'external', 'investor', now() + interval '7 days', 'accepted',
                   '${membershipId}', now()),
                  ('${initechId}', '${email}', sha256(convert_to(gen_random_uuid()::text, 'UTF8')),
                   'external', 'investor', now() + interval '7 days', 'pending', NULL, NULL)`,
        initechId,
      );
      const res = await createErasure("initech", o1, membershipId);
      expect(res.status).toBe(201);
      const { id } = await json<Erasure>(res);
      await reportStep(initechId, id, "probe-a", {});
      await reportStep(initechId, id, "probe-b", {});
      const done = await dataRequest("initech", lawyer, id);
      expect(done.status).toBe("completed");
      expect(done.steps.find((st) => st.module === "core.identity")?.counts).toMatchObject({
        global: 1,
        invites: 2,
      });
    };

    const first = await provisionUser(deps, { email, displayName: "rex" });
    const m1 = await provisionMembership(deps, {
      workspaceId: initechId,
      userId: first.userId,
      kind: "external",
      role: "investor",
      source: "test",
    });
    await erase(m1.id);

    // The address is free again: the same person registers anew in the same workspace …
    const second = await provisionUser(deps, { email, displayName: "rex again" });
    expect(second.userId).not.toBe(first.userId);
    const m2 = await provisionMembership(deps, {
      workspaceId: initechId,
      userId: second.userId,
      kind: "external",
      role: "investor",
      source: "test",
    });
    // … and is erased again, which must not collide with the first erasure's pseudonyms.
    await erase(m2.id);

    const ids = await hostRows<{ identifier: string; id: string }>(
      `SELECT identifier::text, replace(id::text, '-', '') AS id FROM core.user_identity
        WHERE user_id IN ('${first.userId}'::uuid, '${second.userId}'::uuid)`,
    );
    expect(ids).toHaveLength(2);
    for (const i of ids) expect(i.identifier).toBe(`erased+${i.id}@erased.invalid`);
    // Invites are pseudonymised by their own row id — never a digest of the address.
    const invites = await rows<{ email: string; id: string; status: string }>(
      `SELECT email::text, replace(id::text, '-', '') AS id, status::text FROM core.invite
        WHERE workspace_id = '${initechId}'::uuid AND kind = 'external'`,
      initechId,
    );
    expect(invites).toHaveLength(4);
    for (const i of invites) {
      expect(i.email).toBe(`erased+${i.id}@erased.invalid`);
      expect(i.status).not.toBe("pending");
    }
  });
});
