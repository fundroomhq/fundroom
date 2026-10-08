import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import {
  checkRlsCatalog,
  createWorkspace,
  pgErrorMessage,
  systemContext,
  type TenantContext,
  updateOfferingStatus,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import { EVIDENCE_PURGE_CRON, JOB_EVIDENCE_PURGE } from "@fundroom/module-round";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * The round, end to end (E2.5): a module that is **off by default and disabled outright while
 * nothing is being offered** → append-only terms with a disclaimer stamp, provable from the
 * database alone → one open round per workspace → the investor's page, the exposure stamp it
 * writes and the throttled `round.terms_viewed` row it leaves → the offering-mode-aware
 * eligibility table → an interest submission that records the two attestation rows E2.3 froze,
 * *through the kernel* → the 506(c) refusal that makes "verified before acceptance" true → the
 * evidence lifecycle (raw upload, scan, envelope encryption, decision, nightly purge) →
 * commitments, the one allocation roll-up and the step-up CSV → RLS from an investor's own
 * connection → the `round_summary` block for staff, a member and the public.
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

const codeFromRes = async (res: Response): Promise<string> =>
  (await json<{ error: { code: string } }>(res)).error.code;

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

async function stepUpToMfa(slug: string, email: string, cookie: string): Promise<string> {
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

/**
 * Stamps an actor's sessions as having just proved themselves — what `sessions.stepUp` writes.
 *
 * Five round routes declare `+fresh` and the window is ten minutes, so a suite that signs in
 * once in `beforeAll` and reaches the CSV export thirty tests later would fail on the clock
 * rather than on the behaviour. What is under test in those places is the *route*; the ceremony
 * has its own test below and identity's own suite.
 */
async function markFresh(actor: Actor, ageMs = 0): Promise<void> {
  const userId = (
    await rows<{ userId: string }>(
      `SELECT user_id AS "userId" FROM core.membership WHERE id = '${actor.membershipId}'::uuid`,
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

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "editor" | "viewer" | "finance" | "legal" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (role === "owner" || role === "admin")
    actor.cookie = await stepUpToMfa(slug, email, actor.cookie);
  return actor;
}

/** Rows read as the `system` actor of a workspace (RLS admits staff and system on round.*). */
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
 * This is the half a TypeScript filter cannot stand in for. The routes decide what the API
 * returns; the policies decide what a `SELECT` returns, and a suite that only exercised the
 * first would pass on a build whose RLS had been dropped.
 */
async function rowsAsExternal<T>(membershipId: string, query: string): Promise<T[]> {
  const ctx: TenantContext = { workspaceId: acmeId, actorKind: "external", membershipId };
  return running.container.db.withTenant(ctx, async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

const auditCount = async (action: string, workspaceId?: string): Promise<number> =>
  (
    await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event WHERE action = '${action}'`,
      workspaceId,
    )
  )[0]?.n ?? 0;

const outboxCount = async (topic: string): Promise<number> =>
  running.container.db.withHost(async (tx) => {
    const r = await tx.execute(
      `SELECT count(*)::int AS n FROM core.outbox WHERE topic = '${topic}'`,
    );
    return (r.rows as { n: number }[])[0]?.n ?? 0;
  });

async function setOffering(workspaceId: string, status: string): Promise<void> {
  const ctx = systemContext(workspaceId);
  await running.container.db.withTenant(ctx, (tx) =>
    updateOfferingStatus(tx, workspaceId, status as never),
  );
  running.container.resolver.invalidate();
}

async function enableRound(workspaceId: string): Promise<void> {
  const ctx = systemContext(workspaceId);
  await running.container.db.withTenant(ctx, (tx) =>
    new ModuleEnablementRepo(ctx, tx).set("round", true),
  );
  running.container.enablement.invalidate(workspaceId);
}

interface RoundBody {
  id: string;
  name: string;
  status: string;
  currency: string;
  targetAmount: string;
  minimumInvestment: string | null;
  showProgress: boolean;
}

interface TermsBody {
  id: string;
  revision: number;
  currency: string;
  disclaimerStamp: string | null;
  supersededBy: string | null;
  terms: Record<string, unknown>;
}

interface InvestorBody {
  round: RoundBody | null;
  terms: TermsBody | null;
  disclaimer: { stamp: string; title: string; body: string } | null;
  progress: { currency: string; target: string; committed: string; soft: string } | null;
  calculatorDefaults: { amount: string; currency: string };
  mySubmissions: { id: string; status: string; accreditationPath: string }[];
  eligibilityHint: { path: string; accredited: boolean } | null;
}

interface SubmissionBody {
  id: string;
  amount: string;
  currency: string;
  status: string;
  accreditationPath: string;
  nonAccredited: boolean;
  accreditationStamp: string | null;
  disclaimerStamp: string | null;
  offeringStatus: string;
  verificationId: string | null;
  commitmentId: string | null;
}

interface AllocationBody {
  currency: string;
  target: string;
  soft: string;
  committed: string;
  total: string;
  remaining: string;
  percent: { soft: string; committed: string; wired: string };
  commitments: { id: string; amount: string; status: string; membershipId: string | null }[];
}

interface VerificationBody {
  id: string;
  membershipId: string;
  status: string;
  method: string | null;
  hasEvidence: boolean;
  evidenceSha256: string | null;
  expiresAt: string | null;
  requires: { evidenceUpload: boolean; adminDecision: boolean };
}

let acmeId: string;
let globexId: string;
let owner: Actor;
let financeUser: Actor;
let viewer: Actor;
let ada: Actor;
let bob: Actor;
let globexOwner: Actor;

/** The round every later test works against. */
let roundId = "";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25]);

async function createRound(over: Record<string, unknown> = {}): Promise<RoundBody> {
  const res = await request("acme", "/api/v1/round/rounds", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      name: "Seed 2026",
      stage: "seed",
      instrumentKind: "safe",
      targetAmount: "2000000",
      currency: "USD",
      ...over,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return json<RoundBody>(res);
}

const SAFE_TERMS = {
  kind: "safe",
  variant: "post_money",
  valuationCap: "10000000",
  discountPercent: "20",
} as const;

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
      ACCREDITATION_DRIVER: "manual",
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
  financeUser = await member("acme", acmeId, "cfo@example.com", "staff", "finance");
  viewer = await member("acme", acmeId, "viewer@example.com", "staff", "viewer");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  bob = await member("acme", acmeId, "bob@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "boss@example.org", "staff", "owner");
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("schema, registry and the two switches", () => {
  it("round.* tables pass the RLS catalog check", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
  });

  it("the forward references a workspace import inserts out of order are deferred (E2.8)", async () => {
    const r = await running.container.db.pool.query(
      `SELECT conname, condeferrable, condeferred FROM pg_constraint
       WHERE conname IN ('terms_superseded_by_fkey', 'interest_verification_fk', 'interest_commitment_fk')
       ORDER BY conname`,
    );
    expect(r.rows).toEqual([
      { conname: "interest_commitment_fk", condeferrable: true, condeferred: true },
      { conname: "interest_verification_fk", condeferrable: true, condeferred: true },
      { conname: "terms_superseded_by_fkey", condeferrable: true, condeferred: true },
    ]);
  });

  it("registers its permissions, its job, its nav slots and the round_summary hydrator", () => {
    const registry = running.container.registry;
    for (const p of ["round.read", "round.manage", "round.publish", "round.settings"]) {
      expect(registry.permissions.has(p)).toBe(true);
    }
    const jobs = registry.resolveJobs(running.container.moduleServices);
    const purge = jobs.find((j) => j.name === JOB_EVIDENCE_PURGE);
    expect(purge?.cron).toBe(EVIDENCE_PURGE_CRON);
    expect(registry.blockHydrators.get("round_summary")?.module).toBe("round");
  });

  it("is off until a workspace turns it on, and answers 404 rather than 403 until then", async () => {
    const boot = await json<{ modules: { id: string; enabled: boolean }[] }>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    expect(boot.modules.find((m) => m.id === "round")?.enabled).toBe(false);

    for (const path of ["/api/v1/round/rounds", "/api/v1/round/verifications"]) {
      const res = await request("acme", path, { cookie: owner.cookie });
      expect(res.status, path).toBe(404);
      expect(await codeFromRes(res)).toBe("module_disabled");
    }
    // `GET /round/current` is `member`, so an investor's refusal is the same 404, not a 403.
    const investor = await request("acme", "/api/v1/round/current", { cookie: ada.cookie });
    expect(investor.status).toBe(404);
    expect(await codeFromRes(investor)).toBe("module_disabled");
  });

  it("stays 404 for staff while the offering status says nothing is being offered", async () => {
    /*
     * The pin `src/index.test.ts` cannot make without importing `@fundroom/compliance`:
     * `permits(s).roundAndTerms` is false for `none` and `informational`, and `disabledWhen`
     * has to agree — for **staff too** (ADR-0037 §3). A compliance control an admin can walk
     * around is no control.
     */
    await enableRound(acmeId);
    for (const status of ["none", "informational"]) {
      await setOffering(acmeId, status);
      const res = await request("acme", "/api/v1/round/rounds", { cookie: owner.cookie });
      expect(res.status, status).toBe(404);
      expect(await codeFromRes(res)).toBe("module_disabled");
      const boot = await json<{ modules: { id: string; enabled: boolean }[] }>(
        await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
      );
      expect(boot.modules.find((m) => m.id === "round")?.enabled, status).toBe(false);
    }
  });

  it("opens up once the workspace is offering under Rule 506(b)", async () => {
    await setOffering(acmeId, "506b");
    const res = await request("acme", "/api/v1/round/rounds", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const boot = await json<{ modules: { id: string; slots: Record<string, unknown[]> }[] }>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    const mod = boot.modules.find((m) => m.id === "round");
    expect(mod?.slots["admin.nav"]).toHaveLength(1);
    expect(mod?.slots["content.blocks"]).toEqual(["round_summary"]);
  });
});

describe("rounds and terms", () => {
  it("creates a round in `planning`, invisible to investors", async () => {
    const created = await createRound({ minimumInvestment: "25000", summary: "18 months." });
    roundId = created.id;
    expect(created.status).toBe("planning");
    expect(created.targetAmount).toBe("2000000.00");
    expect(created.minimumInvestment).toBe("25000.00");

    const investor = await json<InvestorBody>(
      await request("acme", "/api/v1/round/current", { cookie: ada.cookie }),
    );
    expect(investor.round).toBeNull();
    // And RLS says the same thing from the investor's own connection.
    expect(await rowsAsExternal(ada.membershipId, "SELECT id FROM round.round")).toEqual([]);
  });

  it("refuses to open a round with no terms", async () => {
    await markFresh(owner);
    const res = await request("acme", `/api/v1/round/rounds/${roundId}/open`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: { code: string; reason: string } }>(res);
    expect(body.error.reason).toBe("terms_missing");
  });

  it("stamps the terms with the disclaimer in force and refuses a mismatched instrument", async () => {
    // Publish a disclaimer and point the workspace at it, so the stamp is a real one.
    const doc = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ slug: "offering-legends", from: "legends", audience: "external" }),
    });
    expect(doc.status).toBe(200);
    await markFresh(owner);
    expect(
      (
        await request("acme", "/api/v1/compliance/settings", {
          method: "PATCH",
          cookie: owner.cookie,
          body: JSON.stringify({ defaultDisclaimerSlug: "offering-legends" }),
        })
      ).status,
    ).toBe(200);

    const bad = await request("acme", `/api/v1/round/rounds/${roundId}/terms`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({
        terms: { kind: "note", interestRatePercent: "5", maturityMonths: 24 },
      }),
    });
    // A note body on a SAFE round is a field error, not a row that disagrees with its column.
    expect(bad.status).toBe(400);

    const res = await request("acme", `/api/v1/round/rounds/${roundId}/terms`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ terms: SAFE_TERMS }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const written = await json<TermsBody>(res);
    expect(written.revision).toBe(1);
    expect(written.currency).toBe("USD");
    expect(written.disclaimerStamp).toBe("offering-legends:v1");
  });

  it("supersedes rather than edits, and the database proves it", async () => {
    const res = await request("acme", `/api/v1/round/rounds/${roundId}/terms`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ terms: { ...SAFE_TERMS, valuationCap: "12000000" } }),
    });
    expect(res.status).toBe(201);
    expect((await json<TermsBody>(res)).revision).toBe(2);

    const stored = await rows<{ revision: number; supersededBy: string | null }>(
      `SELECT revision, superseded_by::text AS "supersededBy" FROM round.terms
         WHERE round_id = '${roundId}'::uuid ORDER BY revision`,
    );
    expect(stored).toHaveLength(2);
    expect(stored[0]?.supersededBy).not.toBeNull();
    expect(stored[1]?.supersededBy).toBeNull();

    const history = await json<{ terms: TermsBody[] }>(
      await request("acme", `/api/v1/round/rounds/${roundId}/terms`, { cookie: owner.cookie }),
    );
    expect(history.terms.map((t) => t.revision)).toEqual([2, 1]);
    expect(await outboxCount("round.terms_changed")).toBe(2);
  });

  it("refuses to edit a terms revision in place, at the database", async () => {
    // The trigger, not the service: `audit.event` can REVOKE UPDATE, this table cannot, because
    // superseding *is* an update.
    const live = (
      await rows<{ id: string }>(
        `SELECT id::text AS id FROM round.terms WHERE round_id = '${roundId}'::uuid AND superseded_by IS NULL`,
      )
    )[0];
    const refusal = await rows(
      `UPDATE round.terms SET as_of = now() WHERE id = '${live?.id}'::uuid`,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeDefined();
    // drizzle wraps the driver error; the trigger's sentence is on the cause.
    expect(pgErrorMessage(refusal)).toMatch(/immutable/u);
  });

  it("opens the round, publishes and audits", async () => {
    await markFresh(owner);
    const res = await request("acme", `/api/v1/round/rounds/${roundId}/open`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await json<RoundBody>(res)).status).toBe("open");
    expect(await outboxCount("round.opened")).toBe(1);
    expect(await auditCount("round.opened")).toBe(1);
  });

  it("allows only one open round per workspace", async () => {
    const second = await createRound({ name: "Bridge" });
    await request("acme", `/api/v1/round/rounds/${second.id}/terms`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ terms: { ...SAFE_TERMS, variant: "pre_money" } }),
    });
    await markFresh(owner);
    const res = await request("acme", `/api/v1/round/rounds/${second.id}/open`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(409);
    expect((await json<{ error: { reason: string } }>(res)).error.reason).toBe(
      "round_already_open",
    );
    // Tidy up: a second `planning` round with no commitments may be removed outright.
    await markFresh(owner);
    expect(
      (
        await request("acme", `/api/v1/round/rounds/${second.id}`, {
          method: "DELETE",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(200);
  });

  it("refuses to delete a round that has been open", async () => {
    await markFresh(owner);
    const res = await request("acme", `/api/v1/round/rounds/${roundId}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(409);
  });

  it("asks for step-up on open, close, delete and the export", async () => {
    // Ten minutes and one millisecond ago: authenticated, but not freshly.
    await markFresh(owner, 10 * 60_000 + 1);
    for (const [method, path] of [
      ["POST", `/api/v1/round/rounds/${roundId}/close`],
      ["DELETE", `/api/v1/round/rounds/${roundId}`],
      ["GET", `/api/v1/round/rounds/${roundId}/export.csv`],
      ["PATCH", "/api/v1/round/settings"],
    ] as const) {
      const res = await request("acme", path, {
        method,
        cookie: owner.cookie,
        ...(method === "GET" ? {} : { body: JSON.stringify({}) }),
      });
      expect(res.status, path).toBe(403);
      expect(await codeFromRes(res), path).toBe("step_up_required");
    }
    await markFresh(owner);
  });

  it("gives a viewer read access and refuses them every write", async () => {
    expect((await request("acme", "/api/v1/round/rounds", { cookie: viewer.cookie })).status).toBe(
      200,
    );
    const res = await request("acme", "/api/v1/round/rounds", {
      method: "POST",
      cookie: viewer.cookie,
      body: JSON.stringify({
        name: "No",
        stage: "seed",
        instrumentKind: "safe",
        targetAmount: "1",
        currency: "USD",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("answers 404 across tenants rather than 403", async () => {
    await enableRound(globexId);
    await setOffering(globexId, "506b");
    const res = await request("globex", `/api/v1/round/rounds/${roundId}`, {
      cookie: globexOwner.cookie,
    });
    expect(res.status).toBe(404);
  });
});

describe("the investor's page", () => {
  it("shows the open round, its terms, the disclaimer and the progress bar", async () => {
    const body = await json<InvestorBody>(
      await request("acme", "/api/v1/round/current", { cookie: ada.cookie }),
    );
    expect(body.round?.id).toBe(roundId);
    expect(body.terms?.revision).toBe(2);
    expect(body.terms?.currency).toBe("USD");
    expect(body.disclaimer?.stamp).toBe("offering-legends:v1");
    expect(body.progress).toMatchObject({ currency: "USD", target: "2000000.00" });
    // The calculator opens on the minimum when there is one.
    expect(body.calculatorDefaults).toEqual({ amount: "25000.00", currency: "USD" });
    expect(body.eligibilityHint?.path).toBe("self_attested");
  });

  it("stamps first_exposure_at once and never overwrites it", async () => {
    /*
     * Under 506(b) what matters is whether the relationship *pre-dated* the offer, so a later
     * view overwriting the column would destroy exactly that evidence (E1.6).
     */
    const first = (
      await rows<{ at: string | null }>(
        `SELECT first_exposure_at AS at FROM core.membership WHERE id = '${ada.membershipId}'::uuid`,
      )
    )[0]?.at;
    expect(first).not.toBeNull();
    await request("acme", "/api/v1/round/current", { cookie: ada.cookie });
    const again = (
      await rows<{ at: string | null }>(
        `SELECT first_exposure_at AS at FROM core.membership WHERE id = '${ada.membershipId}'::uuid`,
      )
    )[0]?.at;
    expect(again).toEqual(first);
  });

  it("records one round.terms_viewed row per session per revision, not one per refresh", async () => {
    const before = await auditCount("round.terms_viewed");
    expect(before).toBeGreaterThan(0);
    await request("acme", "/api/v1/round/current", { cookie: ada.cookie });
    await request("acme", "/api/v1/round/current", { cookie: ada.cookie });
    expect(await auditCount("round.terms_viewed")).toBe(before);

    const meta = await rows<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE action = 'round.terms_viewed' ORDER BY occurred_at LIMIT 1`,
    );
    // Plan §11: every view of offering material logs the versions it showed.
    expect(meta[0]?.meta).toMatchObject({
      roundId,
      revision: 2,
      offeringStatus: "506b",
      disclaimerStamp: "offering-legends:v1",
    });
  });

  it("computes the ownership estimate from the live terms", async () => {
    const res = await request("acme", "/api/v1/round/current/calculate?amount=100000", {
      cookie: ada.cookie,
    });
    expect(res.status).toBe(200);
    const body = await json<{
      kind: string;
      currency: string;
      ownershipPercentLow: string | null;
      assumptions: string[];
    }>(res);
    expect(body.kind).toBe("safe");
    expect(body.currency).toBe("USD");
    // $100,000 at a $12,000,000 post-money cap.
    expect(body.ownershipPercentLow).toBe("0.83");
    expect(body.assumptions.at(-1)).toContain("not investment advice");
  });

  it("answers the eligibility table per offering mode", async () => {
    const ask = async (subject: string, amount: string) =>
      json<{ path: string; questionnaire: boolean; thresholdMet: boolean; accredited: boolean }>(
        await request(
          "acme",
          `/api/v1/round/current/eligibility?subject=${subject}&amount=${amount}`,
          { cookie: ada.cookie },
        ),
      );

    expect(await ask("individual", "50000")).toMatchObject({
      path: "self_attested",
      questionnaire: true,
      accredited: false,
    });

    await setOffering(acmeId, "506c");
    expect(await ask("individual", "200000")).toMatchObject({
      path: "self_certified",
      thresholdMet: true,
    });
    expect(await ask("individual", "199999")).toMatchObject({
      path: "verification_required",
      thresholdMet: false,
    });
    expect(await ask("entity", "999999")).toMatchObject({ path: "verification_required" });
    expect(await ask("entity", "1000000")).toMatchObject({ path: "self_certified" });

    await setOffering(acmeId, "non_us");
    expect(await ask("individual", "1000000")).toMatchObject({
      path: "none",
      questionnaire: false,
    });
    await setOffering(acmeId, "506b");
  });
});

describe("indicating interest under Rule 506(b)", () => {
  let submissionId = "";

  it("publishes the accreditation questionnaire the self-certification is recorded against", async () => {
    const res = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        slug: "accreditation",
        from: "accreditation-self-certification",
        requiresAcceptance: false,
        audience: "external",
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const detail = await json<{ document: { id: string; kind: string } }>(res);
    expect(detail.document.kind).toBe("accreditation");
  });

  it("records the submission with its path, its stamps and the offering status of the moment", async () => {
    const res = await request("acme", "/api/v1/round/current/interest", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({
        amount: "250000",
        subject: "individual",
        note: "Happy to lead.",
        consent: true,
        accreditation: { categories: ["us.income"], section: "us", questionnaireVersion: 1 },
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = await json<SubmissionBody>(res);
    submissionId = body.id;
    expect(body).toMatchObject({
      amount: "250000.00",
      currency: "USD",
      status: "submitted",
      accreditationPath: "self_attested",
      nonAccredited: false,
      offeringStatus: "506b",
      disclaimerStamp: "offering-legends:v1",
    });
    expect(body.accreditationStamp).toMatch(/^accreditation:v\d+$/u);
    // No verification under 506(b): self-certification is the whole of it.
    expect(body.verificationId).toBeNull();
    expect(await outboxCount("round.interest_submitted")).toBe(1);
  });

  it("writes the two attestation rows E2.3 froze, through the kernel", async () => {
    /*
     * D5: the round module never touches `core.attestation`. One row is the click-wrap record
     * of agreeing to *this text* (`<slug>:v<n>`, never expires); the other is the dated,
     * expiring `accredited` fact the policy gate reads.
     */
    const attestations = await rows<{
      kind: string;
      expiresAt: string | null;
      data: Record<string, unknown>;
    }>(
      `SELECT kind, expires_at AS "expiresAt", data FROM core.attestation
         WHERE membership_id = '${ada.membershipId}'::uuid ORDER BY kind`,
    );
    expect(attestations.map((a) => a.kind).sort()).toEqual(["accreditation:v1", "accredited"]);
    const accredited = attestations.find((a) => a.kind === "accredited");
    expect(accredited?.expiresAt).not.toBeNull();
    expect(accredited?.data).toMatchObject({ method: "self_certified" });
    expect(attestations.find((a) => a.kind === "accreditation:v1")?.expiresAt).toBeNull();
  });

  it("refuses an amount below the round's minimum", async () => {
    const res = await request("acme", "/api/v1/round/current/interest", {
      method: "POST",
      cookie: bob.cookie,
      body: JSON.stringify({ amount: "1000", subject: "individual" }),
    });
    expect(res.status).toBe(409);
    const body = await json<{ error: { reason: string; minimum: string; currency: string } }>(res);
    expect(body.error).toMatchObject({
      reason: "below_minimum",
      minimum: "25000.00",
      currency: "USD",
    });
  });

  it("shows the member their own submission and nobody else's", async () => {
    const mine = await json<{ submissions: SubmissionBody[] }>(
      await request("acme", "/api/v1/round/current/interest", { cookie: ada.cookie }),
    );
    expect(mine.submissions.map((s) => s.id)).toEqual([submissionId]);
    const theirs = await json<{ submissions: SubmissionBody[] }>(
      await request("acme", "/api/v1/round/current/interest", { cookie: bob.cookie }),
    );
    expect(theirs.submissions).toEqual([]);
    // And RLS says the same from Bob's own connection.
    expect(
      await rowsAsExternal(bob.membershipId, "SELECT id FROM round.interest_submission"),
    ).toEqual([]);
  });

  it("rate-limits an investor to five submissions an hour", async () => {
    // Four more (one is already spent), then the sixth is refused.
    for (let i = 0; i < 4; i++) {
      const res = await request("acme", "/api/v1/round/current/interest", {
        method: "POST",
        cookie: ada.cookie,
        body: JSON.stringify({ amount: "26000", subject: "individual" }),
      });
      // The partial unique index allows one *open* submission per member per round, so these
      // are refused by the database rather than by the limiter — both are 409s, and the limit
      // is what the sixth call proves.
      expect([201, 409]).toContain(res.status);
    }
    const sixth = await request("acme", "/api/v1/round/current/interest", {
      method: "POST",
      cookie: ada.cookie,
      body: JSON.stringify({ amount: "26000", subject: "individual" }),
    });
    expect(sixth.status).toBe(429);
    expect(await codeFromRes(sixth)).toBe("rate_limited");
  });

  it("accepts a submission, creates the commitment and moves the allocation", async () => {
    const res = await request("acme", `/api/v1/round/interest/${submissionId}/accept`, {
      method: "POST",
      cookie: financeUser.cookie,
      body: JSON.stringify({ note: "allocated in full" }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<{
      submission: SubmissionBody;
      commitment: { id: string; amount: string; currency: string; status: string };
      warnings: string[];
    }>(res);
    expect(body.submission.status).toBe("accepted");
    expect(body.commitment).toMatchObject({ amount: "250000.00", currency: "USD", status: "soft" });
    expect(body.warnings).toEqual([]);

    const allocation = await json<AllocationBody>(
      await request("acme", `/api/v1/round/rounds/${roundId}/allocation`, {
        cookie: owner.cookie,
      }),
    );
    expect(allocation).toMatchObject({
      currency: "USD",
      soft: "250000.00",
      committed: "0.00",
      total: "250000.00",
      remaining: "1750000.00",
    });
    expect(allocation.percent.soft).toBe("12.50");
    // The rows travel with the buckets so the CRM board can join its cards to them by id.
    expect(allocation.commitments).toHaveLength(1);
    expect(allocation.commitments[0]).toMatchObject({
      amount: "250000.00",
      status: "soft",
      membershipId: ada.membershipId,
    });
    expect(await outboxCount("round.interest_decided")).toBe(1);
    expect(await outboxCount("round.commitment_created")).toBe(1);
  });

  it("refuses to decide the same submission twice", async () => {
    const res = await request("acme", `/api/v1/round/interest/${submissionId}/decline`, {
      method: "POST",
      cookie: financeUser.cookie,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  it("names the investor in the staff queue and nowhere in their own list", async () => {
    const queue = await json<{
      submissions: { id: string; displayName: string | null; email: string | null }[];
    }>(
      await request("acme", `/api/v1/round/rounds/${roundId}/interest?status=accepted`, {
        cookie: owner.cookie,
      }),
    );
    expect(queue.submissions).toHaveLength(1);
    expect(queue.submissions[0]?.email).toBe("ada@investor.test");
    const mine = await request("acme", "/api/v1/round/current/interest", { cookie: ada.cookie });
    expect(await mine.text()).not.toContain("ada@investor.test");
  });
});

describe("Rule 506(c): verification before acceptance", () => {
  let verificationId = "";
  let bobSubmissionId = "";

  it("opens a verification for an investor below the minimum-investment threshold", async () => {
    await setOffering(acmeId, "506c");
    const res = await request("acme", "/api/v1/round/current/interest", {
      method: "POST",
      cookie: bob.cookie,
      body: JSON.stringify({
        amount: "50000",
        subject: "individual",
        consent: true,
        accreditation: { categories: [], section: "us", note: "Sophisticated purchaser." },
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const body = await json<SubmissionBody>(res);
    bobSubmissionId = body.id;
    expect(body.accreditationPath).toBe("verification_required");
    // "None of these apply" is a real answer, and the one the 35-purchaser count acts on.
    expect(body.nonAccredited).toBe(true);
    expect(body.verificationId).not.toBeNull();
    verificationId = body.verificationId as string;
    expect(await outboxCount("round.verification_requested")).toBe(1);
  });

  it("refuses to accept that submission while the investor is unverified", async () => {
    const res = await request("acme", `/api/v1/round/interest/${bobSubmissionId}/accept`, {
      method: "POST",
      cookie: financeUser.cookie,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect((await json<{ error: { reason: string } }>(res)).error.reason).toBe(
      "accreditation_required",
    );
  });

  it("refuses `verified` without the evidence the method implies", async () => {
    const noMethod = await request("acme", `/api/v1/round/verifications/${verificationId}/decide`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ status: "verified" }),
    });
    expect(noMethod.status).toBe(400);

    const noFile = await request("acme", `/api/v1/round/verifications/${verificationId}/decide`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ status: "verified", method: "document_review", note: "saw it" }),
    });
    expect(noFile.status).toBe(400);
    expect((await json<{ error: { reason: string } }>(noFile)).error.reason).toBe(
      "evidence_required",
    );
  });

  it("takes the investor's own upload, scans it and stores only ciphertext", async () => {
    const res = await request("acme", `/api/v1/round/verifications/${verificationId}/evidence`, {
      method: "PUT",
      cookie: bob.cookie,
      headers: { "content-type": "application/pdf" },
      body: PDF,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<{
      hasEvidence: boolean;
      evidenceBytes: number;
      evidenceSha256: string;
    }>(res);
    expect(body.hasEvidence).toBe(true);
    expect(body.evidenceBytes).toBe(PDF.byteLength);

    const stored = await rows<{ key: string; sha: string }>(
      `SELECT evidence_key AS key, evidence_sha256 AS sha FROM round.verification
         WHERE id = '${verificationId}'::uuid`,
    );
    expect(stored[0]?.key).toBe(`round/verification/${acmeId}/${verificationId}`);
    const object = await running.container.storage.get(stored[0]?.key as string);
    const bytes = new Uint8Array(await new Response(object?.body).arrayBuffer());
    // Envelope-encrypted under the workspace key: the plaintext PDF header is not on disk.
    expect(bytes.slice(0, 4)).not.toEqual(PDF.slice(0, 4));
    expect(await auditCount("round.evidence_uploaded")).toBe(1);
  });

  it("refuses the wrong content type and somebody else's verification", async () => {
    const wrongType = await request(
      "acme",
      `/api/v1/round/verifications/${verificationId}/evidence`,
      {
        method: "PUT",
        cookie: bob.cookie,
        headers: { "content-type": "image/svg+xml" },
        body: PDF,
      },
    );
    expect(wrongType.status).toBe(415);

    // Ada is a member of the same workspace and the row is not hers: a 404, never a 403.
    const notOwner = await request(
      "acme",
      `/api/v1/round/verifications/${verificationId}/evidence`,
      {
        method: "PUT",
        cookie: ada.cookie,
        headers: { "content-type": "application/pdf" },
        body: PDF,
      },
    );
    expect(notOwner.status).toBe(404);
  });

  it("the raw upload route sits behind the legal-acceptance gate like its OpenAPI twin (E3.2 SWEEP-2)", async () => {
    const created = await request("acme", "/api/v1/compliance/documents", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        slug: "privacy-notice",
        from: "privacy-notice",
        audience: "external",
        requiresAcceptance: true,
      }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const docId = (await json<{ document: { id: string } }>(created)).document.id;
    try {
      const blocked = await request(
        "acme",
        `/api/v1/round/verifications/${verificationId}/evidence`,
        {
          method: "PUT",
          cookie: bob.cookie,
          headers: { "content-type": "application/pdf" },
          body: PDF,
        },
      );
      expect(blocked.status).toBe(403);
      expect((await json<{ error: { code: string } }>(blocked)).error.code).toBe(
        "legal_acceptance_required",
      );
    } finally {
      const off = await request("acme", `/api/v1/compliance/documents/${docId}`, {
        method: "PATCH",
        cookie: owner.cookie,
        body: JSON.stringify({ requiresAcceptance: false }),
      });
      expect(off.status).toBe(200);
    }
    // The API app's gate is the raw mount's too: lifting the requirement opens both at once.
    const open = await request("acme", `/api/v1/round/verifications/${verificationId}/evidence`, {
      method: "PUT",
      cookie: bob.cookie,
      headers: { "content-type": "image/svg+xml" },
      body: PDF,
    });
    expect(open.status).toBe(415);
  });

  it("lets staff read the evidence back, decrypted, and audits the read", async () => {
    const res = await request("acme", `/api/v1/round/verifications/${verificationId}/evidence`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect(await auditCount("round.evidence_viewed")).toBe(1);
  });

  it("the row names the key that sealed the object (E2.8: rotation and export follow it)", async () => {
    const ctx = systemContext(acmeId);
    const row = await running.container.db.withTenant(ctx, async (tx) => {
      const r = await tx.execute(
        `SELECT v.evidence_encryption AS enc, k.id AS key_id, k.kms_key_ref AS key_ref
         FROM round.verification v
         JOIN core.workspace_key k ON k.workspace_id = v.workspace_id AND k.purpose = 'round-evidence'
         WHERE v.id = '${verificationId}'`,
      );
      return r.rows[0] as { enc: unknown; key_id: string; key_ref: string };
    });
    expect(row.enc).toEqual({ format: "she1", keyId: row.key_id, keyRef: row.key_ref });
  });

  it("records the decision as a kernel attestation with the evidence reference", async () => {
    const res = await request("acme", `/api/v1/round/verifications/${verificationId}/decide`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ status: "verified", method: "document_review", note: "2025 return" }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<VerificationBody>(res);
    expect(body.status).toBe("verified");
    expect(body.expiresAt).not.toBeNull();
    expect(body.requires).toEqual({ evidenceUpload: true, adminDecision: true });

    /*
     * The *newest* `accredited` row. Bob has two: the self-certification he made with the form
     * (`method: "self_certified"`) and this one — which is the whole point of the `verified:`
     * prefix, since a register six years from now has to be able to tell them apart.
     */
    const attestation = await rows<{ data: Record<string, unknown>; ref: string | null }>(
      `SELECT data, evidence_ref AS ref FROM core.attestation
         WHERE membership_id = '${bob.membershipId}'::uuid AND kind = 'accredited'
         ORDER BY signed_at DESC, created_at DESC LIMIT 1`,
    );
    expect(attestation[0]?.data).toMatchObject({ method: "verified:document_review" });
    expect(String(attestation[0]?.data["evidenceRef"])).toBe(
      `storage:round/verification/${acmeId}/${verificationId}`,
    );
    expect(await outboxCount("round.verification_decided")).toBe(1);
  });

  it("accepts the submission once the investor is verified", async () => {
    const res = await request("acme", `/api/v1/round/interest/${bobSubmissionId}/accept`, {
      method: "POST",
      cookie: financeUser.cookie,
      body: JSON.stringify({ amount: "40000" }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<{ commitment: { amount: string }; warnings: string[] }>(res);
    // The override is an allocation, not a negotiation: the figure the company wrote is stored.
    expect(body.commitment.amount).toBe("40000.00");
    await setOffering(acmeId, "506b");
  });

  it("purges the evidence once the decision is older than the retention window", async () => {
    /*
     * design/04 §102: the file auto-expires after the decision. The decision, its method and
     * the sha256 of what was read survive; the file does not.
     */
    await markFresh(owner);
    expect(
      (
        await request("acme", "/api/v1/round/settings", {
          method: "PATCH",
          cookie: owner.cookie,
          body: JSON.stringify({ evidenceRetentionDays: 1 }),
        })
      ).status,
    ).toBe(200);
    // Age the decision past the window.
    await rows(
      `UPDATE round.verification SET decided_at = now() - interval '3 days'
         WHERE id = '${verificationId}'::uuid`,
    );
    const key = `round/verification/${acmeId}/${verificationId}`;
    expect(await running.container.storage.head(key)).toBeDefined();

    /*
     * The registered job definition, driven directly rather than through the queue: what is
     * under test is the sweep, and pg-boss's cron scheduler is `@fundroom/jobs-pgboss`'s own
     * suite. `data.workspaceId` narrows it to this workspace, which is the repo convention.
     */
    const purge = running.container.registry
      .resolveJobs(running.container.moduleServices)
      .find((j) => j.name === JOB_EVIDENCE_PURGE);
    expect(purge).toBeDefined();
    await purge?.handler({
      id: "test",
      name: JOB_EVIDENCE_PURGE,
      data: { workspaceId: acmeId },
      signal: new AbortController().signal,
    });

    const purged = (
      await rows<{ key: string | null; purgedAt: string | null }>(
        `SELECT evidence_key AS key, evidence_purged_at AS "purgedAt" FROM round.verification
           WHERE id = '${verificationId}'::uuid`,
      )
    )[0];
    expect(purged?.purgedAt).not.toBeNull();
    expect(purged?.key).toBeNull();
    expect(await running.container.storage.head(key)).toBeUndefined();
    // The decision survives the file.
    const after = await json<VerificationBody>(
      await request("acme", `/api/v1/round/verifications/${verificationId}`, {
        cookie: owner.cookie,
      }),
    );
    expect(after.status).toBe("verified");
    expect(after.method).toBe("document_review");
    expect(after.evidenceSha256).not.toBeNull();
    expect(after.hasEvidence).toBe(false);
    expect(await auditCount("round.evidence_purged")).toBe(1);

    const gone = await request("acme", `/api/v1/round/verifications/${verificationId}/evidence`, {
      cookie: owner.cookie,
    });
    expect(gone.status).toBe(404);
  });
});

describe("commitments, the export and RLS", () => {
  it("moves a commitment's status and publishes the change", async () => {
    const list = await json<{ commitments: { id: string; amount: string }[] }>(
      await request("acme", `/api/v1/round/rounds/${roundId}/commitments`, {
        cookie: owner.cookie,
      }),
    );
    expect(list.commitments.length).toBeGreaterThanOrEqual(1);
    const first = list.commitments[0]?.id as string;
    const res = await request("acme", `/api/v1/round/commitments/${first}`, {
      method: "PATCH",
      cookie: financeUser.cookie,
      body: JSON.stringify({ status: "wired" }),
    });
    expect(res.status).toBe(200);
    expect((await json<{ status: string; wiredAt: string | null }>(res)).status).toBe("wired");
    expect(await outboxCount("round.commitment_changed")).toBeGreaterThan(0);
  });

  it("records a commitment for somebody with no portal identity", async () => {
    const res = await request("acme", `/api/v1/round/rounds/${roundId}/commitments`, {
      method: "POST",
      cookie: financeUser.cookie,
      body: JSON.stringify({ displayName: "Lovelace, Ada", amount: "100000", status: "verbal" }),
    });
    expect(res.status).toBe(201);
    const withdrawn = await request("acme", `/api/v1/round/rounds/${roundId}/commitments`, {
      method: "POST",
      cookie: financeUser.cookie,
      body: JSON.stringify({ displayName: "=SUM(A1)", amount: "999999", status: "withdrawn" }),
    });
    expect(withdrawn.status).toBe(201);

    const allocation = await json<AllocationBody>(
      await request("acme", `/api/v1/round/rounds/${roundId}/allocation`, {
        cookie: owner.cookie,
      }),
    );
    // The withdrawal counts for nothing — it is in the rows and in none of the buckets — while
    // the verbal commitment counts as committed.
    expect(allocation.commitments.some((c) => c.status === "withdrawn")).toBe(true);
    expect(Number.parseFloat(allocation.committed)).toBeGreaterThanOrEqual(100_000);
    expect(Number.parseFloat(allocation.total)).toBeLessThan(999_999);
    const counted = allocation.commitments
      .filter((c) => c.status !== "withdrawn")
      .reduce((sum, c) => sum + Number.parseFloat(c.amount), 0);
    expect(Number.parseFloat(allocation.total)).toBeCloseTo(counted, 2);
  });

  it("exports the commitments as CSV, audited and step-up guarded", async () => {
    await markFresh(owner);
    const res = await request("acme", `/api/v1/round/rounds/${roundId}/export.csv`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("seed-2026-commitments.csv");
    const csv = await res.text();
    expect(csv.split("\r\n")[0]).toBe("id,name,status,amount,currency,created_at,wired_at");
    expect(csv).toContain('"Lovelace, Ada"');
    // A display name a spreadsheet would run as a formula is defused.
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain(",withdrawn,");
    expect(await auditCount("round.commitments_exported")).toBe(1);
  });

  it("gives an investor no path to the commitments at all", async () => {
    // Not "an empty list": the table has no external policy, which is what the query proves.
    expect(await rowsAsExternal(ada.membershipId, "SELECT id FROM round.commitment")).toEqual([]);
    expect(await rowsAsExternal(ada.membershipId, "SELECT id FROM round.closing_task")).toEqual([]);
    const res = await request("acme", `/api/v1/round/rounds/${roundId}/commitments`, {
      cookie: ada.cookie,
    });
    expect(res.status).toBe(404);
  });

  it("lets an investor read the open round and its terms, and nothing in `planning`", async () => {
    const visible = await rowsAsExternal<{ status: string }>(
      ada.membershipId,
      "SELECT status::text AS status FROM round.round",
    );
    expect(visible.map((r) => r.status)).toEqual(["open"]);
    expect(await rowsAsExternal(ada.membershipId, "SELECT id FROM round.terms")).toHaveLength(2);
  });

  it("replaces the closing checklist and keeps the instant a task was first ticked", async () => {
    const put = async (tasks: unknown[]) =>
      json<{ tasks: { id: string; title: string; done: boolean; doneAt: string | null }[] }>(
        await request("acme", `/api/v1/round/rounds/${roundId}/closing-tasks`, {
          method: "PUT",
          cookie: owner.cookie,
          body: JSON.stringify({ tasks }),
        }),
      );
    const first = await put([
      { title: "Counsel sign-off", done: true },
      { title: "Wire instructions", done: false },
    ]);
    expect(first.tasks.map((t) => t.title)).toEqual(["Counsel sign-off", "Wire instructions"]);
    const ticked = first.tasks[0]?.doneAt;
    expect(ticked).not.toBeNull();

    const second = await put([
      { id: first.tasks[0]?.id, title: "Counsel sign-off", done: true },
      { title: "File Form D", done: false },
    ]);
    expect(second.tasks.map((t) => t.title)).toEqual(["Counsel sign-off", "File Form D"]);
    expect(second.tasks[0]?.doneAt).toBe(ticked);
  });
});

describe("the round_summary block", () => {
  let pageSlug = "";
  let pageId = "";

  const saveAndPublish = async (mode: "authenticated" | "public") => {
    const draft = await request("acme", `/api/v1/content/pages/${pageId}/draft`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({
        doc: {
          sections: [
            {
              key: "round",
              title: "The round",
              blocks: [{ id: "rs", type: "round_summary", schemaVersion: 1, data: {} }],
            },
          ],
        },
      }),
    });
    expect(draft.status, await draft.clone().text()).toBe(200);
    const visibility = await request("acme", `/api/v1/content/pages/${pageId}/visibility`, {
      method: "PUT",
      cookie: owner.cookie,
      body: JSON.stringify({ rules: { round: { mode } } }),
    });
    expect(visibility.status, await visibility.clone().text()).toBe(200);
    const published = await request("acme", `/api/v1/content/pages/${pageId}/publish`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({}),
    });
    expect(published.status, await published.clone().text()).toBe(200);
  };

  interface RenderedPage {
    sections: {
      key: string;
      blocks: { type: string; data: Record<string, unknown>; unavailable?: string }[];
    }[];
  }

  const hydratedOf = (page: RenderedPage): Record<string, unknown> | undefined =>
    page.sections[0]?.blocks[0]?.data["hydrated"] as Record<string, unknown> | undefined;

  it("puts the block on a published page", async () => {
    pageSlug = `round-${randomUUID().slice(0, 8)}`;
    const created = await request("acme", "/api/v1/content/pages", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ slug: pageSlug, title: "The round" }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    pageId = (await json<{ page: { id: string } } & { id?: string }>(created)).page?.id ?? "";
    expect(pageId).not.toBe("");
    await saveAndPublish("authenticated");
  });

  it("hydrates it for a member, with the terms and the progress", async () => {
    const page = await json<RenderedPage>(
      await request("acme", `/api/v1/content/render/${pageSlug}`, { cookie: ada.cookie }),
    );
    const block = page.sections[0]?.blocks[0];
    expect(block?.type).toBe("round_summary");
    expect(block?.unavailable).toBeUndefined();
    const hydrated = hydratedOf(page);
    expect(hydrated).toMatchObject({ round: expect.objectContaining({ id: roundId }) });
    expect(hydrated?.["terms"]).toMatchObject({ kind: "safe" });
    expect(hydrated?.["progress"]).toMatchObject({ currency: "USD" });
    // The disclaimer travels with it so a page can carry the legend the terms were published
    // beside, without the editor having to remember a second block.
    expect(hydrated?.["disclaimer"]).toMatchObject({ stamp: "offering-legends:v1" });
  });

  it("hydrates it for staff too", async () => {
    const page = await json<RenderedPage>(
      await request("acme", `/api/v1/content/render/${pageSlug}`, { cookie: owner.cookie }),
    );
    expect(hydratedOf(page)).toMatchObject({ round: expect.objectContaining({ id: roundId }) });
  });

  it("gives an anonymous reader nothing, even in a public section", async () => {
    /*
     * EXECUTION_PLAN §47: no offering content is reachable anonymously. A `round_summary` on a
     * public page would be a general solicitation the workspace did not choose to make, and
     * under 506(b) that is not a UI mistake — it is the thing that breaks the exemption.
     */
    await markFresh(owner);
    const settings = await request("acme", "/api/v1/content/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ allowPublicSections: true }),
    });
    expect(settings.status, await settings.clone().text()).toBe(200);
    await saveAndPublish("public");

    const page = await json<RenderedPage>(
      await request("acme", `/api/v1/content/render/${pageSlug}`),
    );
    // The section is visible to the public — and the block inside it carries nothing.
    expect(page.sections[0]?.key).toBe("round");
    expect(hydratedOf(page)).toEqual({});

    // A signed-in member reading the same public section still sees the round: they are
    // entitled to, and that is not the leak §47 is about.
    const member = await json<RenderedPage>(
      await request("acme", `/api/v1/content/render/${pageSlug}`, { cookie: ada.cookie }),
    );
    expect(hydratedOf(member)).toMatchObject({ round: expect.objectContaining({ id: roundId }) });
  });
});

describe("settings", () => {
  it("reads and writes the module's two fields, and invalidates the workspace", async () => {
    const before = await json<{ evidenceRetentionDays: number; defaultCurrency: string }>(
      await request("acme", "/api/v1/round/settings", { cookie: owner.cookie }),
    );
    expect(before.defaultCurrency).toBe("USD");

    await markFresh(owner);
    const res = await request("acme", "/api/v1/round/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ evidenceRetentionDays: 120, defaultCurrency: "EUR" }),
    });
    expect(res.status).toBe(200);
    expect(await json<{ evidenceRetentionDays: number }>(res)).toMatchObject({
      evidenceRetentionDays: 120,
      defaultCurrency: "EUR",
    });
    const after = await json<{ evidenceRetentionDays: number }>(
      await request("acme", "/api/v1/round/settings", { cookie: owner.cookie }),
    );
    expect(after.evidenceRetentionDays).toBe(120);
    expect(await auditCount("round.settings_changed")).toBe(2);
  });

  it("refuses the settings to anybody but an owner or an admin", async () => {
    expect(
      (await request("acme", "/api/v1/round/settings", { cookie: financeUser.cookie })).status,
    ).toBe(403);
  });

  it("closes the round, and the investor page keeps showing it", async () => {
    await markFresh(owner);
    const res = await request("acme", `/api/v1/round/rounds/${roundId}/close`, {
      method: "POST",
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    expect((await json<RoundBody>(res)).status).toBe("closed");
    expect(await outboxCount("round.closed")).toBe(1);

    // A round that closed a moment ago is still the thing an investor came to read about.
    const body = await json<InvestorBody>(
      await request("acme", "/api/v1/round/current", { cookie: ada.cookie }),
    );
    expect(body.round?.id).toBe(roundId);
    expect(body.round?.status).toBe("closed");
    expect(body.eligibilityHint).toBeNull();

    // And the form is closed.
    const submit = await request("acme", "/api/v1/round/current/interest", {
      method: "POST",
      cookie: bob.cookie,
      body: JSON.stringify({ amount: "30000", subject: "individual" }),
    });
    expect(submit.status).toBe(409);
    expect((await json<{ error: { reason: string } }>(submit)).error.reason).toBe("round_not_open");
  });
});
