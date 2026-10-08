import {
  createMemoryAccreditationAdapter,
  memoryCertificatePdf,
} from "@fundroom/accreditation/testing";
import { createWorkspace, systemContext, updateOfferingStatus } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import {
  handoffCsp,
  JOB_VERIFICATION_LIFECYCLE,
  JOB_VERIFICATION_SYNC,
  JOB_VERIFICATION_SYNC_DUE,
  roundDsar,
} from "@fundroom/module-round";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  BASE,
  CANON,
  deadlocks,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
  waitFor,
} from "./test/esign-harness.js";

/*
 * Vendor-settled accreditation verification in the round module (E3.7, ADR-0055, contract §0/§5),
 * end to end on a real server and database, the kernel's in-memory vendor standing in for
 * VerifyInvestor and Parallel Markets:
 *
 *  - a 506(c) submission opens a vendor verification; the start runs as a job after the commit
 *    and hands off (`invite_sent`); a manual workspace still gets `upload`;
 *  - the vendor accredits → a sync verifies: `third_party`, no person, the provider named, the
 *    attestation written with a provider actor, the certificate stored encrypted, the outbox told —
 *    and 506(c) acceptance then succeeds;
 *  - a vendor callback is only a wake-up: POST → `accreditation.provider_updated` → a sync;
 *  - rejection; an admin who decided first wins (also mid-call); a driver switch stops polling;
 *  - the lifecycle job: renew in place, one reminder, expiry, auto-start of the renewal;
 *  - the investor's routes (GET/POST, 409 pending, the 5/h budget), the Parallel handoff page
 *    (its own CSP, 404s, no script injection through a name), the admin's check-now;
 *  - lock order (a sync decision racing an admin decision and a settings PATCH: no deadlocks) and a
 *    one-connection pool (no transaction held while the vendor is called).
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let env: ReturnType<typeof freshSecrets>;
const vi = createMemoryAccreditationAdapter("verifyinvestor");
const pm = createMemoryAccreditationAdapter("parallel-markets");
const adapters = { verifyinvestor: vi.definition, "parallel-markets": pm.definition };
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql, runJob, signIn } = h;

const TOKEN = "vi-api-token-0123456789-wxyz";
const HOOK = "vi-webhook-secret-abcdef-9876";
const PM_KEY = "pm-api-key-0123456789-qrst";
const PM_HOOK = "pm-signing-key-0123456789-lmno";
const DAY = 86_400_000;

let acmeId: string;
let owner: Actor;
let viConnectionId = "";
let roundId = "";

interface VerificationRow {
  id: string;
  status: string;
  provider: string;
  provider_ref: string | null;
  method: string | null;
  decided_by: string | null;
  decided_by_provider: string | null;
  vendor_status: string | null;
  vendor_error: string | null;
  next_check_at: Date | null;
  handoff: Record<string, unknown> | null;
  evidence_key: string | null;
  evidence_note: string | null;
  evidence_sha256: string | null;
  evidence_encryption: Record<string, unknown> | null;
  expires_at: Date | null;
  reminder_sent_at: Date | null;
  reverification_of: string | null;
  decided_at: Date | null;
  created_at: Date;
}

/** `tx.execute` hands timestamptz back as text: the three this file compares become Dates. */
const hydrate = (r: VerificationRow): VerificationRow => {
  const d = (v: unknown) => (v === null || v === undefined ? null : new Date(String(v)));
  return {
    ...r,
    next_check_at: d(r.next_check_at),
    expires_at: d(r.expires_at),
    reminder_sent_at: d(r.reminder_sent_at),
    decided_at: d(r.decided_at),
    created_at: d(r.created_at) as Date,
  };
};

async function vrow(id: string): Promise<VerificationRow> {
  const [row] = await sql<VerificationRow>(
    acmeId,
    `SELECT * FROM round.verification WHERE id = '${id}'::uuid`,
  );
  if (row === undefined) throw new Error(`no verification ${id}`);
  return hydrate(row);
}

async function rowsFor(membershipId: string): Promise<VerificationRow[]> {
  return (
    await sql<VerificationRow>(
      acmeId,
      `SELECT * FROM round.verification WHERE membership_id = '${membershipId}'::uuid
        ORDER BY created_at, id`,
    )
  ).map(hydrate);
}

const count = async (query: string): Promise<number> =>
  Number((await pg.pool.query<{ n: string }>(query)).rows[0]?.n ?? 0);

const outboxCount = (topic: string, extra = "") =>
  count(`SELECT count(*)::text AS n FROM core.outbox WHERE topic = '${topic}' ${extra}`);

const auditCount = (action: string, resourceId?: string) =>
  count(
    `SELECT count(*)::text AS n FROM audit.event WHERE action = '${action}'${
      resourceId === undefined ? "" : ` AND resource_id = '${resourceId}'`
    }`,
  );

const attestations = async (membershipId: string) =>
  (
    await pg.pool.query<{ data: Record<string, unknown>; expires_at: Date; evidence_ref: string }>(
      `SELECT data, expires_at, evidence_ref FROM core.attestation
        WHERE membership_id = $1 AND kind = 'accredited' ORDER BY signed_at, id`,
      [membershipId],
    )
  ).rows;

/** Every session of `actor` authenticated just now (routes that declare `+fresh`). */
async function fresh(actor: Actor): Promise<void> {
  await pg.pool.query(
    `UPDATE core.session SET auth_time = now()
      WHERE user_id = (SELECT user_id FROM core.membership WHERE id = $1) AND revoked_at IS NULL`,
    [actor.membershipId],
  );
}

let investorSeq = 0;
/** A fresh investor (their own rate-limit budget, no history). */
async function investor(displayName?: string): Promise<Actor> {
  investorSeq += 1;
  const email = `inv${investorSeq}@investor.test`;
  if (displayName === undefined) return member("acme", acmeId, email, "external", "investor");
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName });
  const m = await provisionMembership(deps, {
    workspaceId: acmeId,
    userId,
    kind: "external",
    role: "investor",
    source: "test",
  });
  return { membershipId: m.id, cookie: await signIn("acme", email) };
}

async function submitInterest(who: Actor): Promise<{ id: string; verificationId: string }> {
  const res = await request("acme", "/api/v1/round/current/interest", {
    method: "POST",
    cookie: who.cookie,
    body: JSON.stringify({ amount: "50000", subject: "individual" }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = await json<{ id: string; verificationId: string | null; accreditationPath: string }>(
    res,
  );
  expect(body.accreditationPath).toBe("verification_required");
  expect(body.verificationId).not.toBeNull();
  return { id: body.id, verificationId: body.verificationId as string };
}

async function startVerification(who: Actor, subject = "individual"): Promise<Response> {
  return request("acme", "/api/v1/round/current/verification", {
    method: "POST",
    cookie: who.cookie,
    body: JSON.stringify({ subject }),
  });
}

/** The vendor start job has run (it runs on the worker after the row's transaction commits). */
async function started(id: string): Promise<VerificationRow> {
  return waitFor(`start of ${id}`, async () => {
    const row = await vrow(id);
    return row.provider_ref !== null || row.vendor_status === "start_failed" ? row : undefined;
  });
}

const sync = (verificationId: string, via?: RunningServer) =>
  runJob(JOB_VERIFICATION_SYNC, { workspaceId: acmeId, verificationId }, via);

const lifecycle = () => runJob(JOB_VERIFICATION_LIFECYCLE, { workspaceId: acmeId });

async function decideAsAdmin(id: string): Promise<Response> {
  return request("acme", `/api/v1/round/verifications/${id}/decide`, {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({ status: "verified", method: "third_party", note: "Checked by counsel" }),
  });
}

async function connect(driver: "verifyinvestor" | "parallel-markets"): Promise<string> {
  await fresh(owner);
  const res = await request("acme", "/api/v1/accreditation/connection", {
    method: "PUT",
    cookie: owner.cookie,
    body: JSON.stringify(
      driver === "verifyinvestor"
        ? {
            driver,
            credentials: { apiToken: TOKEN, webhookSecret: HOOK, environment: "staging" },
          }
        : {
            driver,
            credentials: {
              apiKey: PM_KEY,
              clientId: "client-acme",
              webhookSigningKey: PM_HOOK,
              environment: "demo",
            },
          },
    ),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ connection: { id: string } }>(res)).connection.id;
}

async function patchSettings(body: Record<string, unknown>): Promise<Response> {
  await fresh(owner);
  return request("acme", "/api/v1/round/settings", {
    method: "PATCH",
    cookie: owner.cookie,
    body: JSON.stringify(body),
  });
}

interface MyVerification {
  id: string;
  status: string;
  provider: string;
  providerLabel: string;
  handoff: { kind: string; url?: string } | null;
  vendorStatus: string | null;
  vendorError: string | null;
  canRenew: boolean;
}

async function myVerification(who: Actor): Promise<MyVerification | null> {
  const res = await request("acme", "/api/v1/round/current/verification", { cookie: who.cookie });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await json<{ verification: MyVerification | null }>(res)).verification;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  env = freshSecrets(pg.connectionString);
  running = await startServer({
    config: esignTestConfig(env),
    logger: createLogger({ level: "error" }),
    mailer,
    accreditationAdapters: adapters,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme Robotics" }))
    .id;
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");

  const ctx = systemContext(acmeId);
  await running.container.db.withTenant(ctx, async (tx) => {
    await new ModuleEnablementRepo(ctx, tx).set("round", true);
    await updateOfferingStatus(tx, acmeId, "506c" as never);
  });
  running.container.enablement.invalidate(acmeId);
  running.container.resolver.invalidate();

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
  roundId = (await json<{ id: string }>(created)).id;
  const terms = await request("acme", `/api/v1/round/rounds/${roundId}/terms`, {
    method: "PUT",
    cookie: owner.cookie,
    body: JSON.stringify({
      terms: { kind: "safe", variant: "post_money", valuationCap: "10000000" },
    }),
  });
  expect(terms.status, await terms.clone().text()).toBeLessThan(300);
  await fresh(owner);
  const opened = await request("acme", `/api/v1/round/rounds/${roundId}/open`, {
    method: "POST",
    cookie: owner.cookie,
  });
  expect(opened.status, await opened.clone().text()).toBe(200);
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

// Shared across the ordered describes below.
let mo: Actor; // manual verification (before any vendor connection)
let moVerification = "";
let ada: Actor; // vendor verified (sync), then renewed, reminded, expired
let adaSubmission = "";
let adaVerification = "";
let cy: Actor; // admin decided first; later auto-renewed
let cyVerification = "";
let dee: Actor; // pending VerifyInvestor row when the driver switches
let deeVerification = "";

describe("without a vendor connection", () => {
  it("opens a manual verification with the upload handoff and no vendor start", async () => {
    mo = await investor();
    const res = await startVerification(mo);
    expect(res.status, await res.clone().text()).toBe(201);
    const body = await json<MyVerification>(res);
    moVerification = body.id;
    expect(body).toMatchObject({
      status: "pending",
      provider: "manual",
      providerLabel: "Manual review",
      handoff: { kind: "upload" },
      canRenew: false,
    });
    expect((await vrow(moVerification)).handoff).toEqual({ kind: "upload" });
    expect(vi.vendor.started()).toEqual([]);
  });

  it("serves the reverification settings block with its defaults, merged field by field", async () => {
    const got = await request("acme", "/api/v1/round/settings", { cookie: owner.cookie });
    expect((await json<{ reverification: unknown }>(got)).reverification).toEqual({
      reminderDays: 14,
      autoStart: false,
    });
    const patched = await patchSettings({ reverification: { reminderDays: 20 } });
    expect(patched.status).toBe(200);
    expect((await json<{ reverification: unknown }>(patched)).reverification).toEqual({
      reminderDays: 20,
      autoStart: false,
    });
    await patchSettings({ reverification: { reminderDays: 14 } });
  });
});

describe("a 506(c) submission with VerifyInvestor connected", () => {
  it("opens a vendor verification; the start job hands it off after the commit", async () => {
    viConnectionId = await connect("verifyinvestor");
    ada = await investor();
    const sub = await submitInterest(ada);
    adaSubmission = sub.id;
    adaVerification = sub.verificationId;
    const row = await started(adaVerification);
    expect(row).toMatchObject({
      provider: "verifyinvestor",
      status: "pending",
      handoff: { kind: "invite_sent" },
      vendor_status: "in_progress",
      vendor_error: null,
    });
    expect(row.provider_ref).toMatch(/^mem:/u);
    expect(row.next_check_at?.getTime()).toBeGreaterThan(Date.now() + 3 * 60_000);
    const input = vi.vendor.started().at(-1);
    expect(input).toMatchObject({
      verificationId: adaVerification,
      subject: "individual",
      email: expect.stringMatching(/@investor\.test$/u),
      portalName: "Acme Robotics",
    });
    expect(await auditCount("round.verification_started", adaVerification)).toBe(1);
    expect(
      await outboxCount(
        "round.verification_requested",
        `AND payload->>'verificationId' = '${adaVerification}'`,
      ),
    ).toBe(1);
  });

  it("shows the investor how to continue, never the vendor's ref", async () => {
    const mine = await myVerification(ada);
    expect(mine).toMatchObject({
      id: adaVerification,
      status: "pending",
      provider: "verifyinvestor",
      providerLabel: "VerifyInvestor.com",
      handoff: { kind: "invite_sent" },
      vendorStatus: "in_progress",
      canRenew: false,
    });
    expect(JSON.stringify(mine)).not.toContain("mem:");
  });

  it("refuses the investor's own evidence upload for a vendor verification", async () => {
    const res = await request("acme", `/api/v1/round/verifications/${adaVerification}/evidence`, {
      method: "PUT",
      cookie: ada.cookie,
      headers: { "content-type": "application/pdf" },
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46]) as Uint8Array<ArrayBuffer>,
    });
    expect(res.status).toBe(409);
    expect((await vrow(adaVerification)).evidence_key).toBeNull();
  });

  it("refuses to accept the submission while the vendor has not answered", async () => {
    const res = await request("acme", `/api/v1/round/interest/${adaSubmission}/accept`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  it("an answer that settles nothing keeps the row pending and backs off", async () => {
    await sync(adaVerification);
    const row = await vrow(adaVerification);
    expect(row.status).toBe("pending");
    expect(row.vendor_status).toBe("in_progress");
    expect(row.next_check_at?.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
  });

  it("the vendor accredits → a sync verifies with a provider actor and stores the certificate", async () => {
    const ref = (await vrow(adaVerification)).provider_ref as string;
    vi.vendor.accredit(ref);
    await sync(adaVerification);
    const row = await vrow(adaVerification);
    const key = `round/verification/${acmeId}/${adaVerification}`;
    expect(row).toMatchObject({
      status: "verified",
      method: "third_party",
      decided_by: null,
      decided_by_provider: "verifyinvestor",
      vendor_status: "accredited",
      next_check_at: null,
      evidence_key: key,
      evidence_note: null,
    });
    expect(row.evidence_encryption).toMatchObject({ format: "she1" });
    // Recorded when we decided (the certificate's retention clock runs from here), never the
    // vendor's earlier certification date.
    expect(row.decided_at?.getTime()).toBeGreaterThanOrEqual(row.created_at.getTime());
    expect(row.decided_at?.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(row.expires_at?.getTime()).toBeGreaterThan(Date.now() + 85 * DAY);

    // Encrypted at rest: the stored object is not the certificate.
    const certificate = memoryCertificatePdf(`certificate ${ref}`);
    const stored = await running.container.storage.get(key);
    const ciphertext = new Uint8Array(await new Response(stored?.body).arrayBuffer());
    expect(Buffer.from(ciphertext).equals(Buffer.from(certificate))).toBe(false);
    // …and staff read back exactly what the vendor issued.
    const read = await request("acme", `/api/v1/round/verifications/${adaVerification}/evidence`, {
      cookie: owner.cookie,
    });
    expect(read.status).toBe(200);
    expect(Buffer.from(await read.arrayBuffer()).equals(Buffer.from(certificate))).toBe(true);

    const [att] = await attestations(ada.membershipId);
    expect(att?.data).toMatchObject({
      method: "verified:third_party",
      provider: "verifyinvestor",
      decidedBy: null,
      evidenceRef: `storage:${key}`,
    });
    expect(att?.expires_at.getTime()).toBe(row.expires_at?.getTime());
    expect(
      await outboxCount(
        "round.verification_decided",
        `AND payload->>'verificationId' = '${adaVerification}' AND payload->>'status' = 'verified'`,
      ),
    ).toBe(1);
    expect(await auditCount("round.verification_synced", adaVerification)).toBe(1);
  });

  it("a second sync of a decided row changes nothing", async () => {
    await sync(adaVerification);
    expect(await attestations(ada.membershipId)).toHaveLength(1);
    expect(await auditCount("round.verification_synced", adaVerification)).toBe(1);
  });

  it("506(c) acceptance succeeds once the vendor has verified", async () => {
    const res = await request("acme", `/api/v1/round/interest/${adaSubmission}/accept`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({}),
    });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  });

  it("the admin view carries the vendor columns", async () => {
    const res = await request("acme", `/api/v1/round/verifications/${adaVerification}`, {
      cookie: owner.cookie,
    });
    expect(await json(res)).toMatchObject({
      providerLabel: "VerifyInvestor.com",
      vendorStatus: "accredited",
      decidedByProvider: "verifyinvestor",
      requires: { evidenceUpload: false, adminDecision: false },
      hasEvidence: true,
    });
  });
});

describe("the vendor callback is a wake-up", () => {
  it("an authentic callback → provider_updated → a sync that settles the row (rejected)", async () => {
    const bob = await investor();
    const { verificationId } = await submitInterest(bob);
    const ref = (await started(verificationId)).provider_ref as string;
    vi.vendor.reject(ref, "insufficient income");
    const req = vi.vendor.callbackRequest([ref], HOOK);
    const headers = new Headers(req.headers);
    headers.set("host", CANON);
    const res = await running.app.request(`${BASE}/webhooks/accreditation/${viConnectionId}`, {
      method: "POST",
      headers,
      body: req.rawBody as Uint8Array<ArrayBuffer>,
    });
    expect(res.status).toBe(200);
    const row = await waitFor("callback-driven sync", async () => {
      const r = await vrow(verificationId);
      return r.status !== "pending" ? r : undefined;
    });
    expect(row).toMatchObject({
      status: "rejected",
      vendor_status: "not_accredited",
      decided_by_provider: "verifyinvestor",
      method: null,
    });
    expect(await attestations(bob.membershipId)).toEqual([]);
    expect(
      await outboxCount(
        "round.verification_decided",
        `AND payload->>'verificationId' = '${verificationId}' AND payload->>'status' = 'rejected'`,
      ),
    ).toBe(1);
  });

  it("a forged callback wakes nothing", async () => {
    const before = await outboxCount("accreditation.provider_updated");
    const req = vi.vendor.callbackRequest(["mem:1"], "not-the-secret");
    const headers = new Headers(req.headers);
    headers.set("host", CANON);
    const res = await running.app.request(`${BASE}/webhooks/accreditation/${viConnectionId}`, {
      method: "POST",
      headers,
      body: req.rawBody as Uint8Array<ArrayBuffer>,
    });
    expect(res.status).toBe(401);
    expect(await outboxCount("accreditation.provider_updated")).toBe(before);
  });
});

describe("an admin who decides first wins", () => {
  it("over a later vendor answer", async () => {
    cy = await investor();
    cyVerification = (await submitInterest(cy)).verificationId;
    const ref = (await started(cyVerification)).provider_ref as string;
    const decided = await decideAsAdmin(cyVerification);
    expect(decided.status, await decided.clone().text()).toBe(200);
    expect((await vrow(cyVerification)).next_check_at).toBeNull();
    vi.vendor.accredit(ref);
    await sync(cyVerification);
    const row = await vrow(cyVerification);
    expect(row.decided_by).toBe(owner.membershipId);
    expect(row.decided_by_provider).toBeNull();
    expect(row.evidence_key).toBeNull();
    expect(await attestations(cy.membershipId)).toHaveLength(1);
    expect(await auditCount("round.verification_synced", cyVerification)).toBe(0);
  });

  it("even while the vendor call is in flight (and the certificate is not left behind)", async () => {
    const who = await investor();
    const id = (await submitInterest(who)).verificationId;
    const ref = (await started(id)).provider_ref as string;
    vi.vendor.accredit(ref);
    const held = vi.vendor.hold();
    const job = sync(id);
    await held.reached;
    expect((await decideAsAdmin(id)).status).toBe(200);
    held.release();
    await job;
    const row = await vrow(id);
    expect(row).toMatchObject({ status: "verified", decided_by: owner.membershipId });
    expect(row.decided_by_provider).toBeNull();
    expect(await attestations(who.membershipId)).toHaveLength(1);
    expect(
      await running.container.storage.get(`round/verification/${acmeId}/${id}`),
    ).toBeUndefined();
  });
});

describe("the lifecycle job", () => {
  it("renews a vendor verification in place when the vendor still says accredited, until later", async () => {
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = now() + interval '5 days',
          vendor_checked_at = now() - interval '2 days', reminder_sent_at = NULL
        WHERE id = '${adaVerification}'::uuid`,
    );
    await lifecycle();
    const row = await vrow(adaVerification);
    expect(row.status).toBe("verified");
    expect(row.expires_at?.getTime()).toBeGreaterThan(Date.now() + 80 * DAY);
    expect(row.reminder_sent_at).toBeNull();
    const atts = await attestations(ada.membershipId);
    expect(atts).toHaveLength(2);
    expect(atts[1]?.data).toMatchObject({ provider: "verifyinvestor", decidedBy: null });
    expect(await auditCount("round.verification_renewed", adaVerification)).toBe(1);
  });

  it("reminds the investor once, reminderDays before expiry", async () => {
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = now() + interval '5 days',
          vendor_checked_at = now() WHERE id = '${adaVerification}'::uuid`,
    );
    const where = `AND payload->>'verificationId' = '${adaVerification}'`;
    await lifecycle();
    expect(await outboxCount("round.verification_expiring", where)).toBe(1);
    expect((await vrow(adaVerification)).reminder_sent_at).not.toBeNull();
    await lifecycle();
    expect(await outboxCount("round.verification_expiring", where)).toBe(1);
    expect(await auditCount("round.verification_reminder_sent", adaVerification)).toBe(1);
    // autoStart is off: nothing new was opened for her.
    expect(await rowsFor(ada.membershipId)).toHaveLength(1);
    // Inside the window the investor may renew.
    expect((await myVerification(ada))?.canRenew).toBe(true);
  });

  it("moves a verification past its expiry to expired, and says so on the outbox", async () => {
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = now() - interval '1 minute'
        WHERE id = '${adaVerification}'::uuid`,
    );
    await lifecycle();
    expect((await vrow(adaVerification)).status).toBe("expired");
    expect(
      await outboxCount(
        "round.verification_decided",
        `AND payload->>'verificationId' = '${adaVerification}' AND payload->>'status' = 'expired'`,
      ),
    ).toBe(1);
    expect(await auditCount("round.verification_expired", adaVerification)).toBe(1);
    expect(await myVerification(ada)).toMatchObject({ status: "expired", canRenew: true });
  });

  it("with autoStart, opens the renewal with the vendor at reminder time", async () => {
    expect((await patchSettings({ reverification: { autoStart: true } })).status).toBe(200);
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = now() + interval '3 days', reminder_sent_at = NULL
        WHERE id = '${cyVerification}'::uuid`,
    );
    await lifecycle();
    const rows = await rowsFor(cy.membershipId);
    expect(rows).toHaveLength(2);
    const renewal = rows[1] as VerificationRow;
    expect(renewal).toMatchObject({
      status: "pending",
      provider: "verifyinvestor",
      reverification_of: cyVerification,
    });
    expect((await started(renewal.id)).handoff).toEqual({ kind: "invite_sent" });
    // Once: the next run neither reminds nor opens again.
    await lifecycle();
    expect(await rowsFor(cy.membershipId)).toHaveLength(2);
    expect(await auditCount("round.verification_reminder_sent", cyVerification)).toBe(1);
    expect((await patchSettings({ reverification: { autoStart: false } })).status).toBe(200);
  });

  it("an expiry is still announced while the auto-started renewal is only pending", async () => {
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = now() - interval '1 minute'
        WHERE id = '${cyVerification}'::uuid`,
    );
    await lifecycle();
    expect((await vrow(cyVerification)).status).toBe("expired");
    expect(
      await outboxCount(
        "round.verification_decided",
        `AND payload->>'verificationId' = '${cyVerification}' AND payload->>'status' = 'expired'`,
      ),
    ).toBe(1);
  });

  it("the sync sweep claims due rows (leased) and hands them to the sync job", async () => {
    dee = await investor();
    deeVerification = (await submitInterest(dee)).verificationId;
    await started(deeVerification);
    await sql(
      acmeId,
      `UPDATE round.verification SET next_check_at = now() - interval '1 minute'
        WHERE id = '${deeVerification}'::uuid`,
    );
    await runJob(JOB_VERIFICATION_SYNC_DUE, { workspaceId: acmeId });
    // Leased: pushed into the future so the next sweep does not claim it again.
    await waitFor("sweep-driven sync", async () => {
      const r = await vrow(deeVerification);
      return r.next_check_at !== null && r.next_check_at.getTime() > Date.now() ? r : undefined;
    });
    expect((await vrow(deeVerification)).status).toBe("pending");
  });
});

describe("renewals the vendor answers with the old accreditation (fix round 1)", () => {
  let hal: Actor;
  let first = "";
  let renewal = "";
  let ref = "";

  it("a renewal is not verified by the accreditation it renews; a fresh certification is", async () => {
    hal = await investor();
    first = (await submitInterest(hal)).verificationId;
    ref = (await started(first)).provider_ref as string;
    const oldExpiry = new Date(Date.now() + 5 * DAY);
    vi.vendor.setStatus(ref, {
      status: "accredited",
      vendorStatus: "accredited",
      decidedAt: new Date(Date.now() - 85 * DAY),
      expiresAt: oldExpiry,
    });
    await sync(first);
    expect((await vrow(first)).status).toBe("verified");
    expect((await vrow(first)).expires_at?.getTime()).toBe(oldExpiry.getTime());

    // Inside the reminder window the investor renews; the vendor reuses its record (Parallel).
    const res = await startVerification(hal);
    expect(res.status, await res.clone().text()).toBe(201);
    renewal = (await json<MyVerification>(res)).id;
    await started(renewal);
    await sql(
      acmeId,
      `UPDATE round.verification SET provider_ref = '${ref}' WHERE id = '${renewal}'::uuid`,
    );
    await sync(renewal);
    const stale = await vrow(renewal);
    expect(stale).toMatchObject({
      status: "pending",
      vendor_status: "accredited",
      vendor_error: "renewal_not_recertified",
    });
    expect((await myVerification(hal))?.vendorError).toBe("renewal_not_recertified");
    expect(stale.next_check_at).not.toBeNull();
    expect(await attestations(hal.membershipId)).toHaveLength(1);

    // The investor re-certifies: a certification dated after the renewal was opened.
    vi.vendor.accredit(ref);
    await sync(renewal);
    expect((await vrow(renewal)).status).toBe("verified");
    expect(await attestations(hal.membershipId)).toHaveLength(2);
  });

  it("an expiry superseded by a newer verification (or long past) is marked, never mailed", async () => {
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = now() - interval '1 minute'
        WHERE id = '${first}'::uuid`,
    );
    const backlog = await investor();
    const old = (await submitInterest(backlog)).verificationId;
    expect((await decideAsAdmin(old)).status).toBe(200);
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = now() - interval '30 days'
        WHERE id = '${old}'::uuid`,
    );
    await lifecycle();
    for (const id of [first, old]) {
      expect((await vrow(id)).status).toBe("expired");
      expect(await auditCount("round.verification_expired", id)).toBe(1);
      expect(
        await outboxCount(
          "round.verification_decided",
          `AND payload->>'verificationId' = '${id}' AND payload->>'status' = 'expired'`,
        ),
      ).toBe(0);
    }
  });

  it("autoStart never renews a renewal that stands no later than what it renewed", async () => {
    expect((await patchSettings({ reverification: { autoStart: true } })).status).toBe(200);
    await sql(
      acmeId,
      `UPDATE round.verification SET status = 'verified', expires_at = now() + interval '3 days',
          reminder_sent_at = NULL WHERE id = '${first}'::uuid;
       UPDATE round.verification SET expires_at = now() + interval '3 days', reminder_sent_at = NULL
        WHERE id = '${renewal}'::uuid`,
    );
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = (SELECT expires_at FROM round.verification
          WHERE id = '${first}'::uuid) WHERE id = '${renewal}'::uuid`,
    );
    await lifecycle();
    await lifecycle();
    expect(await rowsFor(hal.membershipId)).toHaveLength(2);
    // The older of two equal verifications is superseded: one reminder, for the renewal.
    expect(await auditCount("round.verification_reminder_sent", first)).toBe(0);
    expect(await auditCount("round.verification_reminder_sent", renewal)).toBe(1);
  });

  it("autoStart still opens a renewal missed at reminder time (enabled after the reminder)", async () => {
    // Enabled only after the reminder went out: the next run still opens the renewal.
    const kim = await investor();
    const id = (await submitInterest(kim)).verificationId;
    expect((await decideAsAdmin(id)).status).toBe(200);
    expect((await patchSettings({ reverification: { autoStart: false } })).status).toBe(200);
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = now() + interval '3 days', reminder_sent_at = NULL
        WHERE id = '${id}'::uuid`,
    );
    await lifecycle();
    expect((await vrow(id)).reminder_sent_at).not.toBeNull();
    expect(await rowsFor(kim.membershipId)).toHaveLength(1);
    expect((await patchSettings({ reverification: { autoStart: true } })).status).toBe(200);
    await lifecycle();
    const rows = await rowsFor(kim.membershipId);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.reverification_of).toBe(id);
    expect((await patchSettings({ reverification: { autoStart: false } })).status).toBe(200);
  });

  it("the lifecycle never asks the vendor about an erased member", async () => {
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = now() + interval '5 days',
          vendor_checked_at = now() - interval '2 days' WHERE id = '${renewal}'::uuid`,
    );
    vi.vendor.accredit(ref);
    await fresh(owner);
    const res = await request("acme", "/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ membershipId: hal.membershipId }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const before = vi.vendor.calls()["check"] ?? 0;
    await lifecycle();
    expect(vi.vendor.calls()["check"] ?? 0).toBe(before);
    expect(await auditCount("round.verification_renewed", renewal)).toBe(0);
  });
});

describe("start budgets and stale starts (fix round 1)", () => {
  it("never renews in place on an answer without a vendor expiry", async () => {
    const nia = await investor();
    const id = (await submitInterest(nia)).verificationId;
    const r = (await started(id)).provider_ref as string;
    vi.vendor.accredit(r, { expiresAt: new Date(Date.now() + 60 * DAY) });
    await sync(id);
    expect((await vrow(id)).status).toBe("verified");
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = now() + interval '5 days',
          vendor_checked_at = now() - interval '2 days' WHERE id = '${id}'::uuid`,
    );
    vi.vendor.setStatus(r, { status: "accredited", vendorStatus: "accredited" });
    await lifecycle();
    expect(await auditCount("round.verification_renewed", id)).toBe(0);
    expect((await vrow(id)).expires_at?.getTime()).toBeLessThan(Date.now() + 6 * DAY);
  });

  it("re-queues a start that never recorded anything, then gives up", async () => {
    const lou = await investor();
    const res = await startVerification(lou);
    const id = (await json<MyVerification>(res)).id;
    await started(id);
    // As if every start attempt had crashed: no ref, nothing recorded, opened long ago.
    await sql(
      acmeId,
      `UPDATE round.verification SET provider_ref = NULL, handoff = NULL, vendor_status = NULL,
          next_check_at = NULL, check_attempts = 0, created_at = now() - interval '1 hour'
        WHERE id = '${id}'::uuid`,
    );
    await runJob(JOB_VERIFICATION_SYNC_DUE, { workspaceId: acmeId });
    const restarted = await started(id);
    expect(restarted.provider_ref).toMatch(/^mem:/u);
    // Bounded: with the attempts spent, the sweep gives up instead.
    await sql(
      acmeId,
      `UPDATE round.verification SET provider_ref = NULL, next_check_at = NULL, check_attempts = 5
        WHERE id = '${id}'::uuid`,
    );
    await runJob(JOB_VERIFICATION_SYNC_DUE, { workspaceId: acmeId });
    expect(await vrow(id)).toMatchObject({
      vendor_status: "start_failed",
      vendor_error: "start_timeout",
    });
    expect((await myVerification(lou))?.vendorError).toBe("start_failed");
  });

  it("an imported vendor row is never synced, woken or checked", async () => {
    const mia = await investor();
    const id = (await submitInterest(mia)).verificationId;
    const r = (await started(id)).provider_ref as string;
    await sql(
      acmeId,
      `UPDATE round.verification SET vendor_error = 'imported', next_check_at = now() - interval '1 minute'
        WHERE id = '${id}'::uuid`,
    );
    vi.vendor.accredit(r);
    const before = vi.vendor.calls()["check"] ?? 0;
    await sync(id);
    await runJob(JOB_VERIFICATION_SYNC_DUE, { workspaceId: acmeId });
    const check = await request("acme", `/api/v1/round/verifications/${id}/check`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(check.status).toBe(409);
    expect(vi.vendor.calls()["check"] ?? 0).toBe(before);
    expect((await vrow(id)).status).toBe("pending");
    expect((await myVerification(mia))?.vendorError).toBe("imported");
  });
});

describe("the investor's routes", () => {
  it("POST answers 409 with the pending verification, spending no budget on it", async () => {
    const fay = await investor();
    const first = await startVerification(fay);
    expect(first.status).toBe(201);
    const id = (await json<MyVerification>(first)).id;
    for (let i = 0; i < 6; i++) {
      const again = await startVerification(fay);
      expect(again.status).toBe(409);
      expect(await json(again)).toMatchObject({
        error: { code: "conflict", reason: "verification_pending", verification: { id } },
      });
    }
    expect(await rowsFor(fay.membershipId)).toHaveLength(1);
  });

  it("five opened verifications an hour per member, then 429", async () => {
    const gil = await investor();
    for (let i = 0; i < 5; i++) {
      const res = await startVerification(gil);
      expect(res.status, await res.clone().text()).toBe(201);
      const id = (await json<MyVerification>(res)).id;
      const rejected = await request("acme", `/api/v1/round/verifications/${id}/decide`, {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ status: "rejected" }),
      });
      expect(rejected.status).toBe(200);
    }
    expect((await startVerification(gil)).status).toBe(429);
    expect(await rowsFor(gil.membershipId)).toHaveLength(5);
  });

  it("refuses a renewal far from expiry (a vendor bills per verification)", async () => {
    const res = await startVerification(cy);
    // cy has a pending auto-started renewal: that one answers first.
    expect(res.status).toBe(409);
    const gus = await investor();
    const gusId = (await submitInterest(gus)).verificationId;
    expect((await decideAsAdmin(gusId)).status).toBe(200);
    const again = await startVerification(gus);
    expect(again.status).toBe(409);
    expect((await json<{ error: { reason: string } }>(again)).error.reason).toBe("conflict");
    expect((await myVerification(gus))?.canRenew).toBe(false);
  });

  it("GET answers null for somebody with no verification", async () => {
    expect(await myVerification(await investor())).toBeNull();
  });

  it("staff routes stay closed to an investor", async () => {
    const res = await request("acme", `/api/v1/round/verifications/${deeVerification}/check`, {
      method: "POST",
      cookie: dee.cookie,
    });
    expect(res.status).toBe(404);
  });
});

describe("check now", () => {
  it("queues a sync of a pending vendor verification (202)", async () => {
    const res = await request("acme", `/api/v1/round/verifications/${deeVerification}/check`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ queued: true });
  });

  it("refuses a manual verification and a decided one (409)", async () => {
    const manual = await request("acme", `/api/v1/round/verifications/${moVerification}/check`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(manual.status).toBe(409);
    expect((await json<{ error: { reason: string } }>(manual)).error.reason).toBe(
      "verification_not_vendor",
    );
    const decided = await request("acme", `/api/v1/round/verifications/${adaVerification}/check`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(decided.status).toBe(409);
  });
});

describe("switching the vendor", () => {
  let eve: Actor;
  let eveVerification = "";

  it("a pending row of the old vendor stops polling (connection_changed); an admin decides it", async () => {
    await connect("parallel-markets");
    await sync(deeVerification);
    const row = await vrow(deeVerification);
    expect(row).toMatchObject({
      status: "pending",
      vendor_error: "connection_changed",
      next_check_at: null,
    });
    const listed = await request("acme", "/api/v1/round/verifications?status=pending", {
      cookie: owner.cookie,
    });
    const list = await json<{ verifications: { id: string; vendorError: string | null }[] }>(
      listed,
    );
    expect(list.verifications.find((v) => v.id === deeVerification)?.vendorError).toBe(
      "connection_changed",
    );
    // The investor is told why, in the round's own words.
    expect((await myVerification(dee))?.vendorError).toBe("connection_changed");
    expect((await decideAsAdmin(deeVerification)).status).toBe(200);
  });

  it("new verifications use Parallel's widget; the investor gets a link, never the config", async () => {
    eve = await investor("Eve </script><script>alert(1)</script>");
    const res = await startVerification(eve);
    expect(res.status).toBe(201);
    eveVerification = (await json<MyVerification>(res)).id;
    const row = await started(eveVerification);
    expect(row.handoff).toMatchObject({
      kind: "widget",
      sdk: "parallel-markets",
      config: { clientId: "client-acme", requiredEntityId: row.provider_ref },
    });
    const mine = await myVerification(eve);
    // A path: the SPA prefixes its own API base (`/w/<slug>` in path tenancy).
    expect(mine?.handoff).toEqual({
      kind: "widget",
      url: "/api/v1/round/current/verification/handoff",
    });
    expect(JSON.stringify(mine)).not.toContain("client-acme");
  });

  it("the handoff page carries its own CSP (exactly the contract's), a fresh nonce, no-store", async () => {
    const page = await request("acme", "/api/v1/round/current/verification/handoff", {
      cookie: eve.cookie,
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/u);
    const html = await page.text();
    const nonce = /<script nonce="([^"]+)">/u.exec(html)?.[1] ?? "";
    expect(nonce.length).toBeGreaterThan(10);
    // The global security-header middleware must not have replaced it with the API's CSP.
    expect(page.headers.get("content-security-policy")).toBe(handoffCsp(nonce));
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain(`"requiredEntityId":"${(await vrow(eveVerification)).provider_ref}"`);
    // The name cannot close the config element or become code.
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)");
    const again = await request("acme", "/api/v1/round/current/verification/handoff", {
      cookie: eve.cookie,
    });
    const nonce2 = /<script nonce="([^"]+)">/u.exec(await again.text())?.[1];
    expect(nonce2).not.toBe(nonce);
  });

  it("the handoff page is 404 unless the latest pending verification is a widget one", async () => {
    for (const who of [ada, mo, cy]) {
      const res = await request("acme", "/api/v1/round/current/verification/handoff", {
        cookie: who.cookie,
      });
      expect(res.status).toBe(404);
    }
    const anonymous = await request("acme", "/api/v1/round/current/verification/handoff");
    expect(anonymous.status).toBe(401);
  });

  it("a DSAR export carries the vendor columns but never the handoff config", async () => {
    const ctx = systemContext(acmeId);
    const out = await running.container.db.withTenant(ctx, (tx) =>
      roundDsar.export({ tx, ctx, membershipId: eve.membershipId, related: {} }),
    );
    const [v] = (out as { verifications: Record<string, unknown>[] }).verifications;
    expect(v).toMatchObject({ provider: "parallel-markets", vendorStatus: "in_progress" });
    // The vendor reference is the investor's own fact (and `evidenceNote` names it once decided).
    expect(v?.["providerRef"]).toBe((await vrow(eveVerification)).provider_ref);
    expect(v).not.toHaveProperty("handoff");
    expect(JSON.stringify(out)).not.toContain("client-acme");
  });

  it("erasure reduces the handoff to its kind and stops polling (the record stays)", async () => {
    await fresh(owner);
    const res = await request("acme", "/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ membershipId: eve.membershipId }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const row = await waitFor("round's erasure step", async () => {
      const r = await vrow(eveVerification);
      return r.vendor_error === "member_erased" ? r : undefined;
    });
    expect(row).toMatchObject({
      status: "pending",
      handoff: { kind: "widget" },
      next_check_at: null,
    });
    expect(JSON.stringify(row)).not.toContain("investor.test");
  });
});

describe("erasure while a vendor call is in flight (fix round 2)", () => {
  async function erase(who: Actor): Promise<void> {
    await fresh(owner);
    const res = await request("acme", "/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ membershipId: who.membershipId }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
  }

  it("a start answered after the erasure stores none of the handoff and is never polled", async () => {
    const who = await investor("Ivy Held");
    const held = pm.vendor.hold();
    const res = await startVerification(who);
    const id = (await json<MyVerification>(res)).id;
    await held.reached;
    await erase(who);
    held.release();
    const row = await started(id);
    expect(row).toMatchObject({
      provider_ref: null,
      handoff: null,
      vendor_status: "start_failed",
      vendor_error: "member_erased",
      next_check_at: null,
    });
  });

  it("a decision answered after the erasure writes nothing and removes the certificate", async () => {
    const who = await investor();
    const id = (await json<MyVerification>(await startVerification(who))).id;
    const ref = (await started(id)).provider_ref as string;
    pm.vendor.accredit(ref);
    const held = pm.vendor.hold();
    const job = sync(id);
    await held.reached;
    await erase(who);
    held.release();
    await job;
    const row = await vrow(id);
    expect(row).toMatchObject({
      status: "pending",
      vendor_error: "member_erased",
      next_check_at: null,
    });
    expect(await attestations(who.membershipId)).toEqual([]);
    expect(
      await running.container.storage.get(`round/verification/${acmeId}/${id}`),
    ).toBeUndefined();
    expect(
      await outboxCount("round.verification_decided", `AND payload->>'verificationId' = '${id}'`),
    ).toBe(0);
    // Staff cannot record an accreditation for them either; rejecting clears the queue.
    const verify = await decideAsAdmin(id);
    expect(verify.status).toBe(409);
    expect((await json<{ error: { reason: string } }>(verify)).error.reason).toBe("member_erased");
    expect(await attestations(who.membershipId)).toEqual([]);
    const reject = await request("acme", `/api/v1/round/verifications/${id}/decide`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ status: "rejected" }),
    });
    expect(reject.status).toBe(200);
  });

  it("a check that settles nothing, answered after the erasure, does not re-enable polling", async () => {
    const who = await investor();
    const id = (await json<MyVerification>(await startVerification(who))).id;
    const ref = (await started(id)).provider_ref as string;
    const held = pm.vendor.hold();
    const job = sync(id);
    await held.reached;
    await erase(who);
    await waitFor("round's erasure step", async () =>
      (await vrow(id)).vendor_error === "member_erased" ? true : undefined,
    );
    held.release();
    await job;
    expect(await vrow(id)).toMatchObject({
      status: "pending",
      vendor_error: "member_erased",
      next_check_at: null,
      provider_ref: ref,
    });
  });

  it("a renew-in-place answered after the erasure writes no attestation", async () => {
    const who = await investor();
    const id = (await json<MyVerification>(await startVerification(who))).id;
    const ref = (await started(id)).provider_ref as string;
    pm.vendor.accredit(ref, { expiresAt: new Date(Date.now() + 80 * DAY) });
    await sync(id);
    expect((await vrow(id)).status).toBe("verified");
    await sql(
      acmeId,
      `UPDATE round.verification SET expires_at = now() + interval '5 days',
          vendor_checked_at = now() - interval '2 days' WHERE id = '${id}'::uuid`,
    );
    const held = pm.vendor.hold();
    const run = lifecycle();
    await held.reached;
    await erase(who);
    held.release();
    await run;
    expect(await auditCount("round.verification_renewed", id)).toBe(0);
    expect(await attestations(who.membershipId)).toHaveLength(1);
    expect((await vrow(id)).expires_at?.getTime()).toBeLessThan(Date.now() + 6 * DAY);
  });
});

describe("lock order and the pool", () => {
  it("a sync decision racing an admin decision and a settings PATCH never deadlocks", async () => {
    const before = await deadlocks(pg.pool);
    for (let i = 0; i < 4; i++) {
      const who = await investor();
      const res = await startVerification(who);
      const id = (await json<MyVerification>(res)).id;
      const ref = (await started(id)).provider_ref as string;
      pm.vendor.accredit(ref);
      await fresh(owner);
      const [, decided, patched] = await Promise.all([
        sync(id),
        request("acme", `/api/v1/round/verifications/${id}/decide`, {
          method: "POST",
          cookie: owner.cookie,
          body: JSON.stringify({ status: "verified", method: "third_party", note: "race" }),
        }),
        request("acme", "/api/v1/round/settings", {
          method: "PATCH",
          cookie: owner.cookie,
          body: JSON.stringify({ reverification: { reminderDays: 10 + i } }),
        }),
      ]);
      expect([200, 409]).toContain(decided.status);
      expect(patched.status).toBe(200);
      const row = await vrow(id);
      expect(row.status).toBe("verified");
      // Decided (by either path): the widget config — the investor's email and name — is gone.
      expect(row.handoff).toEqual({ kind: "widget" });
      // Exactly one decider, and exactly one attestation for it.
      expect(Number(row.decided_by !== null) + Number(row.decided_by_provider !== null)).toBe(1);
      expect(await attestations(who.membershipId)).toHaveLength(1);
    }
    expect(await deadlocks(pg.pool)).toBe(before);
    await patchSettings({ reverification: { reminderDays: 14 } });
  });

  it("a one-connection pool: the sync job holds no transaction while the vendor is called", async () => {
    const single = await startServer({
      config: esignTestConfig(env, { DATABASE_POOL_MAX: "1", ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      accreditationAdapters: adapters,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    try {
      await single.container.relay.stop();
      const who = await investor();
      const id = (await json<MyVerification>(await startVerification(who))).id;
      const ref = (await started(id)).provider_ref as string;
      pm.vendor.accredit(ref);
      const held = pm.vendor.hold();
      const job = sync(id, single);
      await held.reached;
      // While the vendor call hangs, the ONLY pool connection must be free.
      const probe = single.container.db.withTenant(systemContext(acmeId), async (tx) => {
        const r = await tx.execute("SELECT 1 AS one");
        return r.rows.length;
      });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pool held during the vendor call")), 5_000),
      );
      expect(await Promise.race([probe, timeout])).toBe(1);
      held.release();
      await Promise.race([
        job,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("sync hung on a one-connection pool")), 15_000),
        ),
      ]);
      expect((await vrow(id)).status).toBe("verified");
    } finally {
      await single.stop();
    }
  });
});
