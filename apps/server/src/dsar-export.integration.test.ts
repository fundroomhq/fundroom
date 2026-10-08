import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCanonical, sha256Hex } from "@fundroom/audit";
import { sha256OfBytes, verifySubjectExport } from "@fundroom/compliance";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ERASED_CONTACT_NAME } from "@fundroom/module-crm";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * E2.7 DSAR end to end (contract §5), against every compiled-in module with its real exporter
 * and its real `member.erasure_requested` subscriber:
 *
 *  - access requests: the subject export (every module's file, the audit lines about the subject
 *    and nobody else, a manifest whose hashes verify) completes the open access request with the
 *    zip's sha256;
 *  - rectification: recorded, completed by hand with a note, never twice;
 *  - one open request per member *and kind*;
 *  - erasure: after every module step the kernel's `core.identity` step runs — membership
 *    scrubbed and revoked, this workspace's sessions revoked, the global identity pseudonymised
 *    only when no other live membership exists — and the CRM still found the address;
 *  - RBAC, step-up and legal hold.
 *
 * The main pool has **one** connection (DATABASE_POOL_MAX=1): the export runs one system
 * transaction per module, and the erasure's identity step runs inside a module's outbox
 * transaction, so any nested connection taken on either path would hang this file rather than
 * pass it.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
const EXPORTING_MODULES = [
  "analytics",
  "captable",
  "content",
  "crm",
  "data-room",
  "metrics",
  "notify",
  "round",
  "updates",
];

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

interface Actor {
  cookie: string;
  membershipId: string;
}

interface DataRequest {
  id: string;
  kind: "erasure" | "access" | "rectification";
  membershipId: string;
  subjectName: string | null;
  status: "requested" | "completed" | "cancelled";
  requestedAt: string;
  dueAt: string;
  completedAt: string | null;
  note: string | null;
  completionNote: string | null;
  exportSha256: string | null;
  expectedModules: string[];
  pendingModules: string[];
  steps: { module: string; completedAt: string; counts: Record<string, number> }[];
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
  role: "owner" | "admin" | "legal" | "editor" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

/** Rows read (or written) as the `system` actor of a workspace. */
async function rows<T>(query: string, workspaceId: string): Promise<T[]> {
  return running.container.db.withTenant(systemContext(workspaceId), async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

/** Global rows, read as the host. */
async function hostRows<T>(query: string): Promise<T[]> {
  return running.container.db.withHost(async (tx) => (await tx.execute(query)).rows as T[]);
}

async function userIdOf(membershipId: string, workspaceId: string): Promise<string> {
  const [row] = await rows<{ userId: string }>(
    `SELECT user_id AS "userId" FROM core.membership WHERE id = '${membershipId}'::uuid`,
    workspaceId,
  );
  if (!row) throw new Error("no membership");
  return row.userId;
}

async function createDataRequest(
  actor: Actor,
  body: Record<string, unknown>,
  slug = "acme",
): Promise<Response> {
  return request(slug, "/api/v1/compliance/data-requests", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify(body),
  });
}

async function listRequests(actor: Actor, query = ""): Promise<DataRequest[]> {
  const res = await request("acme", `/api/v1/compliance/data-requests${query}`, {
    cookie: actor.cookie,
  });
  expect(res.status).toBe(200);
  return (await json<{ items: DataRequest[] }>(res)).items;
}

async function requestById(actor: Actor, id: string): Promise<DataRequest> {
  const found = (await listRequests(actor, "?limit=100")).find((r) => r.id === id);
  if (!found) throw new Error(`no request ${id}`);
  return found;
}

async function exportOf(actor: Actor, membershipId: string): Promise<Response> {
  return request("acme", `/api/v1/compliance/subjects/${membershipId}/export`, {
    cookie: actor.cookie,
  });
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

let acmeId: string;
let globexId: string;
let owner: Actor;
let counsel: Actor;
let editor: Actor;
let stale: Actor;
let ada: Actor;
let bob: Actor;
let dan: Actor;
let eve: Actor;
let danGlobex: Actor;
const adaEmail = "ada@investor.test";
const adaDoc = randomUUID();
const bobDoc = randomUUID();
const shareLinkId = randomUUID();
const adaViewSession = randomUUID();
const VIEW_AS_REASON = "checking what the investor portal shows";

/**
 * One row per module table the exporters read, for ada and for bob, so the export can be shown
 * to carry ada's rows and none of bob's.
 */
async function seedModuleData(): Promise<void> {
  const a = ada.membershipId;
  const b = bob.membershipId;
  const roundId = randomUUID();
  const statements = [
    `INSERT INTO analytics.event (workspace_id, membership_id, type, resource_kind, resource_id)
       VALUES ('${acmeId}', '${a}', 'document_viewed', 'document', '${adaDoc}'),
              ('${acmeId}', '${b}', 'document_viewed', 'document', '${bobDoc}')`,
    `INSERT INTO notify.notification (workspace_id, membership_id, event_type, dedupe_key, cadence, actor_membership_id)
       VALUES ('${acmeId}', '${a}', 'document.viewed', 'k-ada', 'instant', NULL),
              ('${acmeId}', '${b}', 'document.viewed', 'k-bob', 'instant', '${a}')`,
    `INSERT INTO notify.member_settings (workspace_id, membership_id, timezone)
       VALUES ('${acmeId}', '${a}', 'Europe/Paris'), ('${acmeId}', '${b}', 'America/New_York')`,
    `INSERT INTO updates.unsubscribe (workspace_id, membership_id, email, source)
       VALUES ('${acmeId}', '${a}', '${adaEmail}', 'portal'),
              ('${acmeId}', '${b}', 'bob@investor.test', 'link')`,
    `INSERT INTO crm.contact (workspace_id, membership_id, display_name, email, notes)
       VALUES ('${acmeId}', '${a}', 'Ada Linked', NULL, 'met at demo day'),
              ('${acmeId}', NULL, 'Ada By Hand', '${adaEmail}', 'intro from a friend'),
              ('${acmeId}', '${b}', 'Bob Linked', 'bob@investor.test', 'bob notes')`,
    `INSERT INTO crm.note (workspace_id, subject_kind, subject_id, body, author_membership_id)
       SELECT '${acmeId}', 'contact', id, 'note about ' || display_name, '${owner.membershipId}'
       FROM crm.contact WHERE workspace_id = '${acmeId}'`,
    `INSERT INTO round.round (id, workspace_id, name, stage, instrument_kind, target_amount, currency)
       VALUES ('${roundId}', '${acmeId}', 'Seed', 'seed', 'safe', 1000000, 'USD')`,
    `INSERT INTO round.interest_submission (workspace_id, round_id, membership_id, amount, currency,
         subject, accreditation_path, offering_status)
       VALUES ('${acmeId}', '${roundId}', '${a}', 25000, 'USD', 'individual', 'none', 'open'),
              ('${acmeId}', '${roundId}', '${b}', 50000, 'USD', 'individual', 'none', 'open')`,
    // Commitments staff recorded against a CRM contact, not the membership: ada's hand-made
    // contact (found by her address) and bob's linked one.
    `INSERT INTO round.commitment (workspace_id, round_id, contact_id, display_name, amount, status,
         note, wired_at)
       SELECT '${acmeId}', '${roundId}', c.id, c.display_name,
              CASE WHEN c.display_name = 'Ada By Hand' THEN 10000 ELSE 70000 END, 'wired',
              'wire from ' || c.display_name, '2026-09-01T00:00:00Z'
       FROM crm.contact c WHERE c.workspace_id = '${acmeId}'
         AND c.display_name IN ('Ada By Hand', 'Bob Linked')`,
    // Kernel facts about ada the export must carry (M4) — and one of each about bob.
    `INSERT INTO core.share_link (id, workspace_id, label, token_hash)
       VALUES ('${shareLinkId}', '${acmeId}', 'deck link', sha256(convert_to('${shareLinkId}', 'UTF8')))`,
    `INSERT INTO core.share_link_visit (workspace_id, link_id, membership_id, views)
       VALUES ('${acmeId}', '${shareLinkId}', '${a}', 3), ('${acmeId}', '${shareLinkId}', '${b}', 1)`,
    `INSERT INTO core.share_link_view (workspace_id, link_id, membership_id, session_id)
       VALUES ('${acmeId}', '${shareLinkId}', '${a}', '${adaViewSession}'),
              ('${acmeId}', '${shareLinkId}', '${b}', '${randomUUID()}')`,
    `INSERT INTO core.mail_message (workspace_id, provider, provider_message_id, stream, ref_kind,
         ref_id, membership_id)
       VALUES ('${acmeId}', 'memory', 'msg-ada-1', 'notification', 'update', '${adaDoc}', '${a}'),
              ('${acmeId}', 'memory', 'msg-bob-1', 'notification', 'update', '${bobDoc}', '${b}')`,
    `INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, resource_kind,
         resource_id, capability, note)
       VALUES ('${acmeId}', 'membership', '${a}', 'document', '${adaDoc}', 'view', 'granted after call'),
              ('${acmeId}', 'membership', '${b}', 'document', '${bobDoc}', 'view', NULL)`,
    `UPDATE core.membership SET relationship_note = 'staff-only: met through a friend'
       WHERE id = '${a}'`,
  ];
  for (const sql of statements) await rows(sql, acmeId);
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
    modules: COMPILED_IN_MODULES,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(running.container.db, { slug: "globex", name: "Globex" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  counsel = await member("acme", acmeId, "counsel@example.com", "staff", "legal");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  stale = await member("acme", acmeId, "stale@example.com", "staff", "legal");
  ada = await member("acme", acmeId, adaEmail, "external", "investor");
  bob = await member("acme", acmeId, "bob@investor.test", "external", "investor");
  dan = await member("acme", acmeId, "dan@investor.test", "external", "investor");
  eve = await member("acme", acmeId, "eve@investor.test", "external", "investor");
  await member("globex", globexId, "boss@example.org", "staff", "owner");
  // Dan also belongs to globex: erasing him in acme must not touch his login there.
  danGlobex = await member("globex", globexId, "dan@investor.test", "external", "investor");
  await seedModuleData();
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("access requests and the subject export", () => {
  let access: DataRequest;
  let exportSha: string;

  it("records an access request with the statutory clock", async () => {
    const res = await createDataRequest(counsel, {
      kind: "access",
      membershipId: ada.membershipId,
      note: "email of 2026-09-22",
    });
    expect(res.status).toBe(201);
    access = await json<DataRequest>(res);
    expect(access).toMatchObject({
      kind: "access",
      membershipId: ada.membershipId,
      subjectName: "ada",
      status: "requested",
      note: "email of 2026-09-22",
      completionNote: null,
      exportSha256: null,
      expectedModules: [],
      steps: [],
    });
    expect(Date.parse(access.dueAt) - Date.parse(access.requestedAt)).toBe(30 * 86_400_000);
  });

  it("a second open request of the same kind is refused; another kind coexists", async () => {
    const again = await createDataRequest(owner, {
      kind: "access",
      membershipId: ada.membershipId,
    });
    expect(again.status).toBe(409);
    expect((await json<{ error: Record<string, unknown> }>(again)).error).toMatchObject({
      code: "conflict",
      reason: "request_open",
      kind: "access",
      dataRequestId: access.id,
    });
    const rect = await createDataRequest(owner, {
      kind: "rectification",
      membershipId: ada.membershipId,
    });
    expect(rect.status).toBe(201);
    // An erasure request is a third clock and may run beside both (bob, so ada keeps her data
    // for the export below).
  });

  it("an access request does not make the member read as erased", async () => {
    const sys = systemContext(acmeId);
    const erased = await running.container.db.withTenant(sys, (tx) =>
      running.container.moduleServices.legal.isErased(tx, sys, ada.membershipId),
    );
    expect(erased).toBe(false);
  });

  it("exports every module's file and only the subject's rows, and verifies against its manifest", async () => {
    // A staff member views the portal as ada first: that audit row is about her, but its
    // session, ip, user agent and typed reason are the staff member's (R1#2).
    const start = await request("acme", `/api/v1/access/people/${ada.membershipId}/view-as`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ reason: VIEW_AS_REASON }),
    });
    expect(start.status).toBe(200);
    expect(
      (await request("acme", "/api/v1/me/view-as", { method: "DELETE", cookie: owner.cookie }))
        .status,
    ).toBe(204);
    const ownerUserId = await userIdOf(owner.membershipId, acmeId);
    const ownerSessions = await hostRows<{ id: string }>(
      `SELECT id FROM core.session WHERE user_id = '${ownerUserId}'::uuid`,
    );
    expect(ownerSessions.length).toBeGreaterThan(0);

    const res = await exportOf(counsel, ada.membershipId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    exportSha = sha256OfBytes(bytes);
    expect(res.headers.get("x-content-sha256")).toBe(exportSha);

    const check = verifySubjectExport(bytes);
    expect(check.problems).toEqual([]);
    expect(check.manifest).toMatchObject({
      version: 1,
      kind: "seed-host.dsar-export",
      workspace: { id: acmeId, slug: "acme", name: "Acme" },
      subject: { membershipId: ada.membershipId },
    });
    const names = Object.keys(check.files).sort();
    expect(names).toEqual(
      [
        "README.txt",
        "acceptances.json",
        "attestations.json",
        "audit.jsonl",
        "consent.json",
        "profile.json",
        "sessions.json",
        "share-links.json",
        "mail.json",
        "access.json",
        "requests.json",
        // E3.5: her e-sign envelopes (metadata; none here, so no esign/<id>-signed.pdf).
        "esign.json",
        // E3.6: meetings she booked through Calendly / Cal.com (none here).
        "integration-bookings.json",
        ...EXPORTING_MODULES.map((m) => `modules/${m}.json`),
      ].sort(),
    );
    const file = (n: string) => JSON.parse(check.files[n] ?? "null");

    const profile = file("profile.json");
    expect(profile.membership).toMatchObject({ id: ada.membershipId, kind: "external" });
    expect(profile.identity).toEqual({ email: adaEmail, displayName: "ada" });
    // The staff-only relationship note is the workspace's working note, not ada's data.
    expect(profile.membership).not.toHaveProperty("relationshipNote");
    expect(check.files["profile.json"]).not.toContain("met through a friend");

    // Kernel facts (M4): her sessions here, share-link visits and counted views, the mail sent
    // to her, grants naming her, and her own data requests — none of bob's.
    const adaUserId = await userIdOf(ada.membershipId, acmeId);
    const adaSessions = await hostRows<{ id: string }>(
      `SELECT id FROM core.session WHERE user_id = '${adaUserId}'::uuid ORDER BY created_at, id`,
    );
    const sessions = file("sessions.json").sessions as { id: string; authLevel: number }[];
    expect(sessions.map((x) => x.id)).toEqual(adaSessions.map((x) => x.id));
    expect(sessions[0]).toHaveProperty("userAgent");
    expect(sessions[0]).toHaveProperty("ip");
    expect(sessions[0]).toHaveProperty("deviceName");
    const links = file("share-links.json");
    expect(links.visits).toEqual([expect.objectContaining({ linkId: shareLinkId, views: 3 })]);
    expect(links.views).toEqual([
      expect.objectContaining({ linkId: shareLinkId, sessionId: adaViewSession }),
    ]);
    const mail = file("mail.json").messages as { refId: string }[];
    expect(mail.map((x) => x.refId)).toEqual([adaDoc]);
    const grants = file("access.json").grants as Record<string, unknown>[];
    expect(grants).toEqual([
      expect.objectContaining({ resourceId: adaDoc, capability: "view", effect: "allow" }),
    ]);
    expect(grants[0]).not.toHaveProperty("note");
    const requests = file("requests.json").requests as { id: string; kind: string }[];
    expect(requests.map((x) => x.kind).sort()).toEqual(["access", "rectification"]);
    expect(requests.map((x) => x.id)).toContain(access.id);
    for (const f of ["sessions.json", "share-links.json", "mail.json", "access.json"]) {
      expect(check.files[f]).not.toContain(bob.membershipId);
      expect(check.files[f]).not.toContain(bobDoc);
    }

    const analytics = file("modules/analytics.json");
    expect(analytics.events.map((e: { resourceId: string }) => e.resourceId)).toEqual([adaDoc]);
    expect(JSON.stringify(analytics)).not.toContain(bobDoc);

    const notify = file("modules/notify.json");
    expect(notify.notificationsReceived).toHaveLength(1);
    expect(notify.settings).toMatchObject({ timezone: "Europe/Paris" });
    // Ada caused bob's notification: that she did is hers; to whom, and what it said, is not.
    expect(notify.notificationsCaused).toHaveLength(1);
    expect(notify.notificationsCaused[0]).not.toHaveProperty("membershipId");
    expect(notify.notificationsCaused[0]).not.toHaveProperty("payload");

    const updates = file("modules/updates.json");
    expect(updates.unsubscribe).toMatchObject({ email: adaEmail, source: "portal" });

    const crm = file("modules/crm.json");
    expect(crm.contacts.map((c: { displayName: string }) => c.displayName).sort()).toEqual([
      "Ada By Hand",
      "Ada Linked",
    ]);
    expect(crm.notes.map((n: { body: string }) => n.body).sort()).toEqual([
      "note about Ada By Hand",
      "note about Ada Linked",
    ]);
    expect(JSON.stringify(crm)).not.toContain("Bob");

    const round = file("modules/round.json");
    expect(round.interestSubmissions).toHaveLength(1);
    expect(round.interestSubmissions[0]).toMatchObject({ amount: "25000.000000" });
    expect(round.rounds).toEqual([expect.objectContaining({ name: "Seed" })]);
    // The commitment recorded against her hand-made CRM contact (ids from the CRM's export),
    // with the money facts; bob's is not there.
    expect(round.contactCommitments).toEqual([
      expect.objectContaining({
        displayName: "Ada By Hand",
        amount: "10000.000000",
        status: "wired",
        note: "wire from Ada By Hand",
        wiredAt: expect.stringMatching(/^2026-09-01T00:00:00/u),
      }),
    ]);
    expect(JSON.stringify(round)).not.toContain("Bob");

    for (const m of ["metrics", "content"]) {
      expect(file(`modules/${m}.json`)).toMatchObject({ version: 1, heldAboutMember: false });
    }

    // audit.jsonl: every line is about ada. Her own lines re-hash to their chain hash; lines
    // somebody else wrote carry none of that person's user id, session, ip, user agent or typed
    // text, and say what was removed (R1#2). Bob's own events (his sign-in) are not there.
    const lines = (check.files["audit.jsonl"] ?? "").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const chain = new Map(
      (
        await rows<{ seq: string; hash: string }>(
          `SELECT seq::text, encode(hash, 'hex') AS hash FROM audit.event
             WHERE workspace_id = '${acmeId}'::uuid`,
          acmeId,
        )
      ).map((r) => [Number(r.seq), r.hash]),
    );
    let own = 0;
    let redacted = 0;
    for (const line of lines) {
      const parsed = JSON.parse(line) as {
        seq: number;
        canonical: string;
        hash: string;
        redacted?: string[];
      };
      expect(chain.get(parsed.seq)).toBe(parsed.hash);
      const f = JSON.parse(parsed.canonical) as Record<string, unknown>;
      expect([
        f["actor_membership_id"],
        f["subject_membership_id"],
        f["on_behalf_of_membership_id"],
      ]).toContain(ada.membershipId);
      if (f["actor_membership_id"] === ada.membershipId) {
        own++;
        expect(parsed.redacted).toBeUndefined();
        expect(sha256Hex(parsed.canonical)).toBe(parsed.hash);
        expect(parseCanonical(parsed.canonical)["actor_membership_id"]).toBe(ada.membershipId);
      } else {
        for (const k of ["actor_user_id", "session_id", "ip", "user_agent"]) {
          expect(f[k], `${k} of seq ${parsed.seq}`).toBeNull();
        }
        if (parsed.redacted !== undefined) redacted++;
      }
    }
    expect(own).toBeGreaterThan(0);
    expect(redacted).toBeGreaterThan(0);
    const viewAsLine = lines
      .map((l) => JSON.parse(l) as { canonical: string; redacted?: string[] })
      .find((l) => l.canonical.includes("access.view_as_started"));
    expect(viewAsLine?.redacted).toEqual(expect.arrayContaining(["session_id", "meta.reason"]));
    const audit = check.files["audit.jsonl"] ?? "";
    expect(audit).not.toContain(VIEW_AS_REASON);
    expect(audit).not.toContain(ownerUserId);
    for (const x of ownerSessions) expect(audit).not.toContain(x.id);
    const bobEvents = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND actor_membership_id = '${bob.membershipId}'::uuid`,
      acmeId,
    );
    expect(bobEvents[0]?.n).toBeGreaterThan(0);
    expect(check.files["audit.jsonl"]).not.toContain(bob.membershipId);
  });

  it("the export changes nothing but its audit row; completing the request takes the sha256 it sent", async () => {
    // M6: a GET that closed a statutory request on bytes that may never have arrived is gone.
    const still = await requestById(counsel, access.id);
    expect(still).toMatchObject({ status: "requested", exportSha256: null });
    const [audit] = await rows<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'compliance.dsar_exported' ORDER BY seq DESC LIMIT 1`,
      acmeId,
    );
    expect(audit?.meta).toMatchObject({ requestId: access.id, sha256: exportSha });
    expect(audit?.meta["files"]).toContain("modules/crm.json");

    const complete = (body: Record<string, unknown>) =>
      request("acme", `/api/v1/compliance/data-requests/${access.id}/complete`, {
        method: "POST",
        cookie: counsel.cookie,
        body: JSON.stringify(body),
      });
    // A digest no export of ada produced — or an export of somebody else — is refused.
    const bobExport = await exportOf(counsel, bob.membershipId);
    const bobSha = bobExport.headers.get("x-content-sha256") ?? "";
    expect(bobSha).toMatch(/^[0-9a-f]{64}$/u);
    for (const sha of ["0".repeat(64), bobSha]) {
      const refused = await complete({ exportSha256: sha });
      expect(refused.status).toBe(409);
      expect((await json<{ error: Record<string, unknown> }>(refused)).error).toMatchObject({
        code: "conflict",
        reason: "export_unknown",
      });
    }
    expect((await complete({ exportSha256: "not-a-digest" })).status).toBe(400);
    expect((await requestById(counsel, access.id)).status).toBe("requested");

    const done = await complete({ exportSha256: exportSha, note: "sent by email" });
    expect(done.status).toBe(200);
    expect(await json<DataRequest>(done)).toMatchObject({
      status: "completed",
      exportSha256: exportSha,
      completionNote: "sent by email",
    });
    const [completed] = await rows<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'compliance.dsar_completed' AND resource_id = '${access.id}'`,
      acmeId,
    );
    expect(completed?.meta).toMatchObject({ kind: "access", exportSha256: exportSha });

    // A second export has no open request to point at; it is still audited.
    const again = await exportOf(counsel, ada.membershipId);
    expect(again.status).toBe(200);
    const [second] = await rows<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'compliance.dsar_exported' ORDER BY seq DESC LIMIT 1`,
      acmeId,
    );
    expect(second?.meta["requestId"]).toBeNull();
  });

  it("an unknown member is 404", async () => {
    expect((await exportOf(counsel, randomUUID())).status).toBe(404);
  });
});

describe("rectification requests", () => {
  it("are completed by hand, with a note, exactly once", async () => {
    const [rect] = await listRequests(
      counsel,
      `?kind=rectification&membershipId=${ada.membershipId}`,
    );
    expect(rect).toMatchObject({ kind: "rectification", status: "requested" });
    const id = rect?.id ?? "";
    const done = await request("acme", `/api/v1/compliance/data-requests/${id}/complete`, {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ note: "corrected the surname on the People screen" }),
    });
    expect(done.status).toBe(200);
    expect(await json<DataRequest>(done)).toMatchObject({
      status: "completed",
      completionNote: "corrected the surname on the People screen",
      exportSha256: null,
    });
    const twice = await request("acme", `/api/v1/compliance/data-requests/${id}/complete`, {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({}),
    });
    expect(twice.status).toBe(409);
    expect((await json<{ error: Record<string, unknown> }>(twice)).error).toMatchObject({
      reason: "request_closed",
    });
    const [audit] = await rows<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'compliance.dsar_completed' AND resource_id = '${id}'`,
      acmeId,
    );
    // The note stays on the request; the chain only says there was one.
    expect(audit?.meta).toMatchObject({ kind: "rectification", hasNote: true });
    expect(JSON.stringify(audit?.meta)).not.toContain("surname");
  });

  it("a completed request frees the slot for a new one of the same kind", async () => {
    const res = await createDataRequest(counsel, {
      kind: "rectification",
      membershipId: ada.membershipId,
    });
    expect(res.status).toBe(201);
  });
});

describe("access control", () => {
  it("legal may list and act; an editor gets 403; an investor gets 404 everywhere", async () => {
    expect(
      (await request("acme", "/api/v1/compliance/data-requests", { cookie: counsel.cookie }))
        .status,
    ).toBe(200);
    const id = randomUUID();
    const calls: [string, string, Record<string, unknown> | undefined][] = [
      ["GET", "/api/v1/compliance/data-requests", undefined],
      [
        "POST",
        "/api/v1/compliance/data-requests",
        { kind: "access", membershipId: bob.membershipId },
      ],
      ["POST", `/api/v1/compliance/data-requests/${id}/complete`, {}],
      ["GET", `/api/v1/compliance/subjects/${bob.membershipId}/export`, undefined],
    ];
    for (const [who, expected] of [
      [editor, 403],
      [bob, 404],
    ] as const) {
      for (const [method, path, body] of calls) {
        const res = await request("acme", path, {
          method,
          cookie: who.cookie,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        expect(res.status, `${method} ${path}`).toBe(expected);
      }
    }
  });

  it("creating, completing and exporting need a fresh session; listing does not", async () => {
    const userId = await userIdOf(stale.membershipId, acmeId);
    await hostRows(
      `UPDATE core.session SET auth_time = now() - interval '30 minutes'
         WHERE user_id = '${userId}'::uuid AND revoked_at IS NULL RETURNING id`,
    );
    expect(
      (await request("acme", "/api/v1/compliance/data-requests", { cookie: stale.cookie })).status,
    ).toBe(200);
    for (const res of [
      await createDataRequest(stale, { kind: "access", membershipId: bob.membershipId }),
      await exportOf(stale, bob.membershipId),
      await request("acme", `/api/v1/compliance/data-requests/${randomUUID()}/complete`, {
        method: "POST",
        cookie: stale.cookie,
        body: "{}",
      }),
    ]) {
      expect(res.status).toBe(403);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("step_up_required");
    }
  });

  it("an erasure request cannot be completed by hand", async () => {
    const res = await request("acme", "/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ membershipId: eve.membershipId }),
    });
    expect(res.status).toBe(201);
    const erasure = await json<{ id: string }>(res);
    const done = await request("acme", `/api/v1/compliance/data-requests/${erasure.id}/complete`, {
      method: "POST",
      cookie: owner.cookie,
      body: "{}",
    });
    expect(done.status).toBe(409);
    // `self_completing` while a module is pending; `request_closed` if every module (and the
    // identity step) already ran in the few hundred milliseconds since.
    expect(["self_completing", "request_closed"]).toContain(
      (await json<{ error: Record<string, unknown> }>(done)).error["reason"],
    );
    // Eve's erasure runs to completion in the background; nothing below depends on her.
  });
});

describe("erasure with the kernel's identity step", () => {
  let adaUserId: string;

  it("refuses under legal hold, and refuses the last owner", async () => {
    const hold = await request("acme", "/api/v1/compliance/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ legalHold: true }),
    });
    expect(hold.status).toBe(200);
    const held = await request("acme", "/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ membershipId: ada.membershipId }),
    });
    expect(held.status).toBe(409);
    expect((await json<{ error: Record<string, unknown> }>(held)).error).toMatchObject({
      reason: "legal_hold",
    });
    await request("acme", "/api/v1/compliance/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ legalHold: false }),
    });

    const lastOwner = await request("acme", "/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ membershipId: owner.membershipId }),
    });
    expect(lastOwner.status).toBe(409);
    expect((await json<{ error: Record<string, unknown> }>(lastOwner)).error).toMatchObject({
      reason: "last_owner",
    });
  });

  it("runs every module step, then scrubs the membership and pseudonymises the identity globally", async () => {
    adaUserId = await userIdOf(ada.membershipId, acmeId);
    // Ada is signed in right now.
    expect((await request("acme", "/api/v1/me", { cookie: ada.cookie })).status).toBe(200);
    const res = await request("acme", "/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ membershipId: ada.membershipId }),
    });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string; expectedModules: string[] }>(res);

    const done = await waitFor("ada's erasure", async () => {
      const r = await requestById(counsel, id);
      return r.status === "completed" ? r : undefined;
    });
    expect(done.expectedModules).toEqual([
      "analytics",
      "captable",
      "crm",
      "data-room",
      "notify",
      // E3.7: the vendor handoff (email, name) on a verification is erased; the record stays.
      "round",
      "updates",
    ]);
    // The identity step is recorded last, after every module step.
    const order = done.steps.map((s) => s.module);
    expect(order.at(-1)).toBe("core.identity");
    expect(order.slice(0, -1).sort()).toEqual([
      "analytics",
      "captable",
      "crm",
      "data-room",
      "notify",
      "round",
      "updates",
    ]);
    const identity = done.steps.find((s) => s.module === "core.identity");
    expect(identity?.counts).toMatchObject({ profiles: 1, memberships: 1, global: 1 });
    expect(identity?.counts["sessions"]).toBeGreaterThan(0);
    expect(done.subjectName).toBeNull();

    const [m] = await rows<{ status: string; reason: string; profile: unknown; note: unknown }>(
      `SELECT status, revoke_reason AS reason, profile, relationship_note AS note
         FROM core.membership WHERE id = '${ada.membershipId}'::uuid`,
      acmeId,
    );
    expect(m).toEqual({ status: "revoked", reason: "erased", profile: {}, note: null });

    const [u] = await hostRows<{ displayName: string; deleted: boolean }>(
      `SELECT display_name AS "displayName", deleted_at IS NOT NULL AS deleted
         FROM core."user" WHERE id = '${adaUserId}'::uuid`,
    );
    expect(u).toEqual({ displayName: "", deleted: true });
    const ids = await hostRows<{ identifier: string }>(
      `SELECT identifier::text FROM core.user_identity WHERE user_id = '${adaUserId}'::uuid`,
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const i of ids) expect(i.identifier).toMatch(/^erased\+[0-9a-f]{32}@erased\.invalid$/u);

    const live = await hostRows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.session WHERE user_id = '${adaUserId}'::uuid
         AND (revoked_at IS NULL OR ip IS NOT NULL OR user_agent <> '')`,
    );
    expect(live[0]?.n).toBe(0);
    expect((await request("acme", "/api/v1/me", { cookie: ada.cookie })).status).toBe(401);

    // isErased still answers from the (completed) request.
    const sys = systemContext(acmeId);
    expect(
      await running.container.db.withTenant(sys, (tx) =>
        running.container.moduleServices.legal.isErased(tx, sys, ada.membershipId),
      ),
    ).toBe(true);

    const [audit] = await rows<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'compliance.identity_erased' AND resource_id = '${id}'`,
      acmeId,
    );
    expect(audit?.meta).toMatchObject({ global: true });
  });

  it("the CRM still found the address: the hand-made contact carrying it was erased too", async () => {
    const contacts = await rows<{ name: string; email: string | null; linked: boolean }>(
      `SELECT display_name AS name, email::text, membership_id IS NOT NULL AS linked
         FROM crm.contact WHERE workspace_id = '${acmeId}'::uuid ORDER BY created_at, id`,
      acmeId,
    );
    const erased = contacts.filter((c) => c.name === ERASED_CONTACT_NAME);
    // Both of ada's, not bob's. The hand-made one carries her address and nothing else links
    // it to her (the linked contact has no email), so it is only found if the CRM step read her
    // address before the identity step pseudonymised it.
    expect(erased).toHaveLength(2);
    expect(contacts.some((c) => c.email === adaEmail)).toBe(false);
  });

  it("a member who belongs elsewhere is erased here only: the login and other sessions live on", async () => {
    const danUserId = await userIdOf(dan.membershipId, acmeId);
    const res = await request("acme", "/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: counsel.cookie,
      body: JSON.stringify({ membershipId: dan.membershipId }),
    });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);
    const done = await waitFor("dan's erasure", async () => {
      const r = await requestById(counsel, id);
      return r.status === "completed" ? r : undefined;
    });
    expect(done.steps.find((s) => s.module === "core.identity")?.counts).toMatchObject({
      memberships: 1,
      global: 0,
    });

    const [u] = await hostRows<{ displayName: string; deleted: boolean }>(
      `SELECT display_name AS "displayName", deleted_at IS NOT NULL AS deleted
         FROM core."user" WHERE id = '${danUserId}'::uuid`,
    );
    expect(u).toEqual({ displayName: "dan", deleted: false });
    const [email] = await hostRows<{ identifier: string }>(
      `SELECT identifier::text FROM core.user_identity WHERE user_id = '${danUserId}'::uuid`,
    );
    expect(email?.identifier).toBe("dan@investor.test");
    // His acme session is gone; his globex session is untouched.
    expect((await request("acme", "/api/v1/me", { cookie: dan.cookie })).status).toBe(401);
    expect((await request("globex", "/api/v1/me", { cookie: danGlobex.cookie })).status).toBe(200);
    const [audit] = await rows<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE workspace_id = '${acmeId}'::uuid
         AND action = 'compliance.identity_erased' AND resource_id = '${id}'`,
      acmeId,
    );
    expect(audit?.meta).toMatchObject({ global: false });
  });

  it("the list shows every kind, and filters by kind", async () => {
    const all = await listRequests(counsel, "?limit=100");
    expect(new Set(all.map((r) => r.kind))).toEqual(
      new Set(["access", "rectification", "erasure"]),
    );
    const erasures = await listRequests(counsel, "?kind=erasure&limit=100");
    expect(erasures.length).toBeGreaterThan(0);
    expect(erasures.every((r) => r.kind === "erasure")).toBe(true);
    // The E2.6 erasure list shows erasure requests only.
    const legacy = await json<{ items: { id: string }[] }>(
      await request("acme", "/api/v1/compliance/erasure-requests?limit=100", {
        cookie: counsel.cookie,
      }),
    );
    expect(legacy.items.map((r) => r.id).sort()).toEqual(erasures.map((r) => r.id).sort());
  });
});
