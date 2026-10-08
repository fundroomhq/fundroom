import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, PLATFORM_WORKSPACE_ID, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { completeLogin, provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Membership expiry is enforced everywhere (E2.10 pen test P1-01), and an owner's membership
 * cannot be expired or edited by an admin (P1-02).
 *
 * P1-01: `membership.expires_at` used to be honoured only by the effective-access rebuild, so a
 * session held by an expired investor still reached member-only routes and an expired staff
 * member kept every RBAC permission. Now the session → membership step treats an expired
 * membership like a revoked one (no tenant context → 404), `authz.hasPermission` refuses it, and
 * the workspace switcher drops it. The expiry is written straight to the row (in the past, from
 * the test's clock) so nothing waits on time.
 *
 * P1-02: the owner-protection rule covered role changes only, so an admin could set an owner's
 * `expiresAt` — with P1-01 fixed, a way to expire every owner.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;

interface Actor {
  cookie: string;
  membershipId: string;
  userId: string;
}

async function request(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `acme.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://acme.${CANON}`);
  return running.app.request(`http://acme.${CANON}${path}`, { ...init, headers });
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

async function signIn(email: string): Promise<string> {
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
  return cookiesOf(verify);
}

async function stepUpToMfa(cookie: string): Promise<string> {
  const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
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
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  const m = await provisionMembership(deps, {
    workspaceId,
    userId: user.userId,
    kind,
    role,
    source: "test",
  });
  let cookie = await signIn(email);
  if (kind === "staff") cookie = await stepUpToMfa(cookie);
  return { cookie, membershipId: m.id, userId: user.userId };
}

/** Superuser write, around RLS and the service: the expiry lands with no ACL bump. */
async function sql<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const r = await running.container.db.pool.query(query, params);
  return r.rows as T[];
}

async function setExpiry(actor: Actor, at: Date | null): Promise<void> {
  await sql("UPDATE core.membership SET expires_at = $2 WHERE id = $1::uuid", [
    actor.membershipId,
    at,
  ]);
}

const past = () => new Date(Date.now() - 60_000);
const future = () => new Date(Date.now() + 3600_000);

async function workspacesOf(actor: Actor): Promise<string[]> {
  const res = await request("/api/v1/me", { cookie: actor.cookie });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    membership: { id: string } | null;
    workspaces: { membershipId: string }[];
  };
  return body.workspaces.map((w) => w.membershipId);
}

let acmeId: string;
let owner: Actor;
let admin: Actor;
let expiringAdmin: Actor;
let investor: Actor;
let expiringInvestor: Actor;

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
      ROLES: "api",
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
  const ctx = systemContext(acmeId);
  await db.withTenant(ctx, async (tx) => {
    for (const id of running.container.registry.ids)
      await new ModuleEnablementRepo(ctx, tx).set(id, true);
  });
  running.container.enablement.invalidate(acmeId);
  running.container.resolver.invalidate();

  owner = await member(acmeId, "owner@example.com", "staff", "owner");
  admin = await member(acmeId, "admin@example.com", "staff", "admin");
  expiringAdmin = await member(acmeId, "leaving-admin@example.com", "staff", "admin");
  investor = await member(acmeId, "ada@investor.test", "external", "investor");
  expiringInvestor = await member(acmeId, "bob@investor.test", "external", "investor");
}, 180_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("membership expiry is enforced on every request (P1-01)", () => {
  const memberRoutes = ["/api/v1/access/my", "/api/v1/data-room/tree"];
  const adminRoutes = ["/api/v1/access/people", "/api/v1/access/invites"];

  it("admits everyone while their memberships are unexpired", async () => {
    await setExpiry(expiringInvestor, future());
    await setExpiry(expiringAdmin, future());
    for (const a of [investor, expiringInvestor]) {
      for (const path of memberRoutes) {
        const res = await request(path, { cookie: a.cookie });
        expect(res.status, `${path} ${await res.clone().text()}`).toBe(200);
      }
    }
    for (const a of [admin, expiringAdmin]) {
      for (const path of adminRoutes) {
        const res = await request(path, { cookie: a.cookie });
        expect(res.status, `${path} ${await res.clone().text()}`).toBe(200);
      }
    }
    expect(await workspacesOf(expiringInvestor)).toEqual([expiringInvestor.membershipId]);
  });

  it("an investor past expires_at gets 404 on member routes and loses the workspace", async () => {
    await setExpiry(expiringInvestor, past());
    for (const path of memberRoutes) {
      const res = await request(path, { cookie: expiringInvestor.cookie });
      expect(res.status, path).toBe(404);
      expect(await codeOf(res)).toBe("not_found");
    }
    // Still signed in (the session is the user's, not the membership's), but a member of nothing.
    const me = await request("/api/v1/me", { cookie: expiringInvestor.cookie });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { membership: unknown; workspaces: unknown[] };
    expect(body.membership).toBeNull();
    expect(body.workspaces).toEqual([]);
    // The unexpired investor is unaffected.
    for (const path of memberRoutes) {
      expect((await request(path, { cookie: investor.cookie })).status, path).toBe(200);
    }
  });

  it("a staff admin past expires_at loses the admin routes; another admin keeps them", async () => {
    await setExpiry(expiringAdmin, past());
    for (const path of adminRoutes) {
      const res = await request(path, { cookie: expiringAdmin.cookie });
      expect(res.status, path).toBe(404);
    }
    const patch = await request(`/api/v1/access/people/${investor.membershipId}`, {
      method: "PATCH",
      cookie: expiringAdmin.cookie,
      body: JSON.stringify({ profile: { title: "nope" } }),
    });
    expect(patch.status).toBe(404);
    for (const path of adminRoutes) {
      expect((await request(path, { cookie: admin.cookie })).status, path).toBe(200);
    }
  });

  it("authz.hasPermission refuses an expired staff membership row", () => {
    const authz = running.container.authz;
    const row = { kind: "staff" as const, role: "admin", status: "active" };
    expect(authz.hasPermission({ ...row, expiresAt: null }, "access.read")).toBe(true);
    expect(authz.hasPermission({ ...row, expiresAt: future() }, "access.read")).toBe(true);
    expect(authz.hasPermission({ ...row, expiresAt: past() }, "access.read")).toBe(false);
  });

  it("clearing the expiry restores access on the next request", async () => {
    await setExpiry(expiringInvestor, null);
    await setExpiry(expiringAdmin, null);
    expect((await request("/api/v1/access/my", { cookie: expiringInvestor.cookie })).status).toBe(
      200,
    );
    expect((await request("/api/v1/access/people", { cookie: expiringAdmin.cookie })).status).toBe(
      200,
    );
  });
});

describe("owner memberships: only owners edit them, and they never expire (P1-02)", () => {
  const patchPerson = (actor: Actor, id: string, body: unknown) =>
    request(`/api/v1/access/people/${id}`, {
      method: "PATCH",
      cookie: actor.cookie,
      body: JSON.stringify(body),
    });

  async function ownerRow() {
    return (
      await sql<{ expires_at: Date | null; profile: Record<string, unknown> }>(
        "SELECT expires_at, profile FROM core.membership WHERE id = $1::uuid",
        [owner.membershipId],
      )
    )[0];
  }

  it("refuses an admin setting an owner's expiry or profile", async () => {
    const before = await ownerRow();
    const exp = await patchPerson(admin, owner.membershipId, {
      expiresAt: future().toISOString(),
    });
    expect(exp.status).toBe(403);
    expect(await codeOf(exp)).toBe("forbidden");
    const prof = await patchPerson(admin, owner.membershipId, { profile: { title: "pwned" } });
    expect(prof.status).toBe(403);
    expect(await ownerRow()).toEqual(before);
  });

  it("refuses an expiry on an owner even from an owner", async () => {
    const res = await patchPerson(owner, owner.membershipId, {
      expiresAt: future().toISOString(),
    });
    expect(res.status).toBe(400);
    expect((await ownerRow())?.expires_at).toBeNull();
    // Clearing (null) is always fine, and an owner may still edit an owner's profile.
    expect((await patchPerson(owner, owner.membershipId, { expiresAt: null })).status).toBe(200);
    expect(
      (await patchPerson(owner, owner.membershipId, { profile: { title: "Founder" } })).status,
    ).toBe(200);
  });

  it("still lets an admin expire a non-owner, and promotion to owner clears the expiry", async () => {
    const exp = future();
    expect(
      (await patchPerson(admin, expiringAdmin.membershipId, { expiresAt: exp.toISOString() }))
        .status,
    ).toBe(200);
    // Promotion with an expiry in the same request is refused …
    const both = await patchPerson(owner, expiringAdmin.membershipId, {
      role: "owner",
      expiresAt: exp.toISOString(),
    });
    expect(both.status).toBe(400);
    // … and a plain promotion drops the expiry the member had.
    expect((await patchPerson(owner, expiringAdmin.membershipId, { role: "owner" })).status).toBe(
      200,
    );
    const row = (
      await sql<{ role: string; expires_at: Date | null }>(
        "SELECT role, expires_at FROM core.membership WHERE id = $1::uuid",
        [expiringAdmin.membershipId],
      )
    )[0];
    expect(row).toEqual({ role: "owner", expires_at: null });
    // Now an owner: the admin can no longer touch it at all.
    expect(
      (await patchPerson(admin, expiringAdmin.membershipId, { profile: { title: "x" } })).status,
    ).toBe(403);
  });

  it("an expired owner does not count towards keeping the workspace owned", async () => {
    // Two owners, one of them expired (a row from before this rule): demoting the live one would
    // leave no live owner, so it is refused.
    await setExpiry(expiringAdmin, past());
    const res = await patchPerson(owner, owner.membershipId, { role: "admin" });
    expect(res.status).toBe(400);
    await setExpiry(expiringAdmin, null);
  });

  it("an invited or dormant co-owner does not satisfy the last-owner floor (E3.2)", async () => {
    // `expiringAdmin` is a second owner since the promotion above. Only an active one counts.
    const setStatus = (status: string) =>
      sql("UPDATE core.membership SET status = $2 WHERE id = $1::uuid", [
        expiringAdmin.membershipId,
        status,
      ]);
    for (const status of ["invited", "dormant"]) {
      await setStatus(status);
      const res = await patchPerson(owner, owner.membershipId, { role: "admin" });
      expect(res.status, status).toBe(400);
      expect(await codeOf(res)).toBe("invalid_request");
    }
    // The floor is "somebody else still owns it", not "two rows say owner": the one active owner
    // may still step the dormant co-owner down.
    const down = await patchPerson(owner, expiringAdmin.membershipId, { role: "admin" });
    expect(down.status, await down.clone().text()).toBe(200);
    await setStatus("active");
    const roles = await sql<{ id: string; role: string }>(
      "SELECT id::text, role::text FROM core.membership WHERE id = ANY($1::uuid[])",
      [[owner.membershipId, expiringAdmin.membershipId]],
    );
    expect(Object.fromEntries(roles.map((r) => [r.id, r.role]))).toEqual({
      [owner.membershipId]: "owner",
      [expiringAdmin.membershipId]: "admin",
    });
  });
});

describe("sign-in refuses an expired membership (E3.2)", () => {
  /** An OTP ceremony against `host`; returns the verify response. The start always sends. */
  async function otpAt(host: string, email: string): Promise<Response> {
    const at = (path: string, body: unknown) =>
      running.app.request(`http://${host}${path}`, {
        method: "POST",
        headers: { host, "content-type": "application/json", origin: `http://${host}` },
        body: JSON.stringify(body),
      });
    const sentBefore = mailer.sent.length;
    const start = await at("/api/v1/auth/otp/start", { email });
    expect(start.status).toBe(200);
    // Start is unchanged: an expired member is still sent a code (the refusal comes after proof).
    const code = await awaitSignInCode(mailer, email, sentBefore);
    expect(mailer.sent.length).toBe(sentBefore + 1);
    return at("/api/v1/auth/otp/verify", { email, code });
  }

  async function loginFailures(workspaceId: string, userId: string) {
    return sql<{ reason: string; method: string }>(
      `SELECT meta->>'reason' AS reason, meta->>'method' AS method FROM audit.event
        WHERE action = 'auth.login_failed' AND actor_user_id = $1::uuid
          AND workspace_id = $2::uuid`,
      [userId, workspaceId],
    );
  }

  it("OTP into the workspace: the right code is refused with membership_expired, audited", async () => {
    await setExpiry(expiringInvestor, past());
    const res = await otpAt(`acme.${CANON}`, "bob@investor.test");
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("membership_expired");
    expect(res.headers.getSetCookie()).toEqual([]);
    const failures = await loginFailures(acmeId, expiringInvestor.userId);
    expect(failures).toContainEqual({ reason: "membership_expired", method: "email_otp" });
    // A live membership is unaffected, and clearing the expiry lets the same person back in.
    expect((await otpAt(`acme.${CANON}`, "ada@investor.test")).status).toBe(200);
    await setExpiry(expiringInvestor, null);
    expect((await otpAt(`acme.${CANON}`, "bob@investor.test")).status).toBe(200);
  });

  it("every credential kind is refused on the shared completeLogin path", async () => {
    await setExpiry(expiringInvestor, past());
    const methods = ["email_otp", "magic_link", "passkey", "password", "oidc", "host"] as const;
    for (const method of methods) {
      const attempt = completeLogin(
        running.container.identityDeps,
        running.container.auth.sessions,
        {
          userId: expiringInvestor.userId,
          method,
          authLevel: 1,
          workspaceId: acmeId,
        },
      );
      await expect(attempt, method).rejects.toMatchObject({
        code: "membership_expired",
        status: 403,
      });
    }
    const reasons = await loginFailures(acmeId, expiringInvestor.userId);
    for (const method of methods)
      expect(reasons).toContainEqual({ reason: "membership_expired", method });
    await setExpiry(expiringInvestor, null);
  });

  it("the canonical host refuses a user whose every membership has expired, not one with a live one", async () => {
    const db = running.container.db;
    const globexId = (await createWorkspace(db, { slug: "globex", name: "Globex" })).id;
    const deps = running.container.identityDeps;
    // Carol: one membership, expired. Dan: expired in Acme, live in Globex. Erin: no memberships.
    const carol = await provisionUser(deps, { email: "carol@investor.test", displayName: "Carol" });
    const carolM = await provisionMembership(deps, {
      workspaceId: acmeId,
      userId: carol.userId,
      kind: "external",
      role: "investor",
      source: "test",
    });
    const dan = await provisionUser(deps, { email: "dan@investor.test", displayName: "Dan" });
    const danAcme = await provisionMembership(deps, {
      workspaceId: acmeId,
      userId: dan.userId,
      kind: "external",
      role: "investor",
      source: "test",
    });
    await provisionMembership(deps, {
      workspaceId: globexId,
      userId: dan.userId,
      kind: "external",
      role: "investor",
      source: "test",
    });
    await provisionUser(deps, { email: "erin@example.test", displayName: "Erin" });
    const expire = (id: string) =>
      sql("UPDATE core.membership SET expires_at = $2 WHERE id = $1::uuid", [id, past()]);
    await expire(carolM.id);
    await expire(danAcme.id);

    const refused = await otpAt(CANON, "carol@investor.test");
    expect(refused.status).toBe(403);
    expect(await codeOf(refused)).toBe("membership_expired");
    expect(await loginFailures(PLATFORM_WORKSPACE_ID, carol.userId)).toContainEqual({
      reason: "membership_expired",
      method: "email_otp",
    });
    expect((await otpAt(CANON, "dan@investor.test")).status).toBe(200);
    // Zero memberships behaves as before: a host-level account signs in.
    expect((await otpAt(CANON, "erin@example.test")).status).toBe(200);
  });
});
