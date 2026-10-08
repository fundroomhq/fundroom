import { randomUUID } from "node:crypto";
import { verifySubjectExport } from "@fundroom/compliance";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import {
  cookieName,
  isAuthError,
  provisionMembership,
  provisionUser,
  type SystemActor,
} from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  BASE,
  CANON,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
} from "./test/esign-harness.js";

/*
 * Staff SSO sessions and SCIM-facing membership lifecycle (E3.8, ADR-0056), below the IdP flows
 * (A's `sso-flow.integration.test.ts` drives those end to end). Sessions carrying an SSO binding
 * are minted straight through the identity services here, exactly as the finish route does.
 *
 *  - decision 5: a bound session is treated as no session on any other workspace and on the
 *    canonical host — never revoked;
 *  - decision 8: enforced SSO holds staff out (403 `sso_required`) unless the session is bound to
 *    this workspace; an owner at auth level 2 is the break-glass; investors are never affected;
 *    the bootstrap still answers and says so;
 *  - `provisionStaff` / `suspend` / `unsuspend` / `revokeSessionsForSsoConnection`;
 *  - decision 12: erasure scrubs the member's SCIM projection and this workspace's SSO identities.
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, signIn, stepUp, sql } = h;

const SCIM: SystemActor = { kind: "system", label: "scim:01920000-0000-7000-8000-0000000000e1" };
const SESSION_COOKIE = cookieName("session", "first_party");

interface Ws {
  id: string;
  slug: string;
  owner: Actor;
  connectionId: string;
}

let seq = 0;
async function workspace(prefix: string): Promise<Ws> {
  seq += 1;
  const slug = `${prefix}${seq}`;
  const id = (await createWorkspace(running.container.db, { slug, name: `Ws ${slug}` })).id;
  const owner = await member(slug, id, `owner@${slug}.test`, "staff", "owner");
  const { rows } = await pg.pool.query<{ id: string }>(
    `INSERT INTO core.sso_connection (workspace_id, protocol, name, enabled, oidc_issuer, oidc_client_id)
     VALUES ($1, 'oidc', 'Acme IdP', true, 'https://idp.example.test', $2) RETURNING id`,
    [id, `client-${slug}`],
  );
  // What the SSO service mirrors onto the workspace for a live, enabled connection (E3.8 FR3):
  // session admission compares a bound session's connection id + version with it.
  await pg.pool.query(
    "UPDATE core.workspace SET sso_connection_id = $2, sso_connection_version = 1 WHERE id = $1",
    [id, rows[0]?.id],
  );
  running.container.resolver.invalidate();
  return { id, slug, owner, connectionId: rows[0]?.id as string };
}

async function enforce(ws: Ws, on: boolean): Promise<void> {
  await pg.pool.query("UPDATE core.workspace SET sso_enforced = $2 WHERE id = $1", [ws.id, on]);
  running.container.resolver.invalidate();
}

async function userOf(ws: Ws, membershipId: string): Promise<string> {
  const [row] = await sql<{ user_id: string }>(
    ws.id,
    `SELECT user_id FROM core.membership WHERE id = '${membershipId}'`,
  );
  return row?.user_id as string;
}

/** A session the finish route would mint: bound to `ws`'s connection. */
async function ssoSession(ws: Ws, userId: string, authLevel: 1 | 2 = 1): Promise<string> {
  const started = await running.container.auth.sessions.startSession({
    userId,
    population: "staff",
    context: "first_party",
    authLevel,
    workspaceId: ws.id,
    // As the finish route does: bound to the connection's current version.
    sso: { workspaceId: ws.id, connectionId: ws.connectionId, connectionVersion: 1 },
  });
  expect(started.session.sso).toMatchObject({
    workspaceId: ws.id,
    connectionId: ws.connectionId,
  });
  return `${SESSION_COOKIE}=${started.token}`;
}

/** A request on the canonical host (no workspace, or `/w/<slug>` path-based). */
async function canonical(path: string, cookie: string): Promise<Response> {
  return await running.app.request(`${BASE}${path}`, { headers: { host: CANON, cookie } });
}

/** A staff member without a session yet: user + membership, returns both ids. */
async function staffMember(
  ws: Ws,
  email: string,
  role: string,
  status: "active" | "invited" = "active",
): Promise<{ userId: string; membershipId: string }> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  const m = await provisionMembership(deps, {
    workspaceId: ws.id,
    userId,
    kind: "staff",
    role: role as never,
    source: "test",
    status,
  });
  return { userId, membershipId: m.id };
}

const me = (ws: Ws, cookie: string) => request(ws.slug, "/api/v1/me", { cookie });
const people = (ws: Ws, cookie: string) => request(ws.slug, "/api/v1/access/people", { cookie });
const bootstrap = async (ws: Ws, cookie: string) =>
  json<{ membership: unknown; ssoRequired: boolean; ssoBreakGlass: boolean }>(
    await request(ws.slug, "/api/v1/modules", { cookie }),
  );

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  running = await startServer({
    // TRUST_PROXY: the per-IP step-up test names its client address with X-Forwarded-For.
    config: esignTestConfig(freshSecrets(pg.connectionString), {
      ROLES: "api",
      TRUST_PROXY: "true",
    }),
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("an SSO-bound session serves its own workspace only (decision 5)", () => {
  it("is ignored — not revoked — on another workspace and on the canonical host", async () => {
    const a = await workspace("ssa");
    const b = await workspace("ssb");
    const email = `admin@${a.slug}.test`;
    const inA = await staffMember(a, email, "admin");
    // The same person is staff in B too: an unbound session of theirs works there.
    const deps = running.container.identityDeps;
    await provisionMembership(deps, {
      workspaceId: b.id,
      userId: inA.userId,
      kind: "staff",
      role: "admin",
      source: "test",
    });
    const cookie = await ssoSession(a, inA.userId, 2);

    const home = await me(a, cookie);
    expect(home.status).toBe(200);
    const homeBody = await json<{
      membership: { id: string } | null;
      workspaces: { workspaceId: string }[];
      session: { sso: unknown };
    }>(home);
    expect(homeBody.session.sso).toMatchObject({ workspaceId: a.id, connectionId: a.connectionId });
    expect(homeBody.membership?.id).toBe(inA.membershipId);
    // Fix round 1 (L1): a bound session learns nothing about the person's other workspaces.
    expect(homeBody.workspaces.map((w) => w.workspaceId)).toEqual([a.id]);
    expect((await people(a, cookie)).status).toBe(200);

    // Another workspace (host-based and /w/<slug>): as if no cookie had been sent.
    expect((await me(b, cookie)).status).toBe(401);
    expect((await people(b, cookie)).status).toBe(401);
    expect((await canonical(`/w/${b.slug}/api/v1/me`, cookie)).status).toBe(401);
    const boot = await json<{ membership: unknown; permissions: string[] }>(
      await request(b.slug, "/api/v1/modules", { cookie }),
    );
    expect(boot.membership).toBeNull();
    expect(boot.permissions).toEqual([]);
    // The canonical host with no workspace at all.
    expect((await canonical("/api/v1/me", cookie)).status).toBe(401);
    // Path-based access to its own workspace still works.
    expect((await canonical(`/w/${a.slug}/api/v1/me`, cookie)).status).toBe(200);

    // Nothing was revoked on the way.
    expect((await me(a, cookie)).status).toBe(200);
    const [row] = (
      await pg.pool.query<{ revoked_at: Date | null }>(
        "SELECT revoked_at FROM core.session WHERE sso_workspace_id = $1 AND user_id = $2",
        [a.id, inA.userId],
      )
    ).rows;
    expect(row?.revoked_at).toBeNull();

    // An ordinary session of the same person serves both workspaces as before.
    const plain = await running.container.auth.sessions.startSession({
      userId: inA.userId,
      population: "staff",
      context: "first_party",
      authLevel: 2,
    });
    const plainCookie = `${SESSION_COOKIE}=${plain.token}`;
    const plainMe = await me(a, plainCookie);
    expect(plainMe.status).toBe(200);
    const plainBody = await json<{
      workspaces: { workspaceId: string }[];
      session: { sso: unknown };
    }>(plainMe);
    expect(plainBody.session.sso).toBeNull();
    expect(plainBody.workspaces.map((w) => w.workspaceId).sort()).toEqual([a.id, b.id].sort());
    expect((await me(b, plainCookie)).status).toBe(200);
    expect((await canonical("/api/v1/me", plainCookie)).status).toBe(200);
  }, 120_000);

  it("refuses to start a binding for another workspace", async () => {
    const a = await workspace("ssc");
    const b = await workspace("ssd");
    const { userId } = await staffMember(a, `x@${a.slug}.test`, "editor");
    const err = await running.container.auth.sessions
      .startSession({
        userId,
        population: "staff",
        context: "first_party",
        authLevel: 1,
        workspaceId: b.id,
        sso: { workspaceId: a.id, connectionId: a.connectionId },
      })
      .catch((e: unknown) => e);
    expect(isAuthError(err, "invalid_request")).toBe(true);
  });

  it("revokeSessionsForSsoConnection ends that connection's sessions and nothing else", async () => {
    const ws = await workspace("sse");
    const one = await staffMember(ws, `one@${ws.slug}.test`, "admin");
    const two = await staffMember(ws, `two@${ws.slug}.test`, "admin");
    const c1 = await ssoSession(ws, one.userId, 2);
    const c2 = await ssoSession(ws, two.userId, 2);
    const plain = await running.container.auth.sessions.startSession({
      userId: one.userId,
      population: "staff",
      context: "first_party",
      authLevel: 2,
      workspaceId: ws.id,
    });
    const n = await running.container.auth.sessions.revokeSessionsForSsoConnection(
      ws.connectionId,
      "sso_connection_deleted",
    );
    expect(n).toBe(2);
    expect((await me(ws, c1)).status).toBe(401);
    expect((await me(ws, c2)).status).toBe(401);
    expect((await me(ws, `${SESSION_COOKIE}=${plain.token}`)).status).toBe(200);
    expect(
      await running.container.auth.sessions.revokeSessionsForSsoConnection(
        ws.connectionId,
        "sso_connection_deleted",
      ),
    ).toBe(0);
  }, 120_000);
});

describe("E3.10 FR4: bulk revocation cascades to derived sessions", () => {
  it("revoking an SSO connection's sessions revokes the sessions minted from them", async () => {
    const ws = await workspace("ssd");
    const one = await staffMember(ws, `one@${ws.slug}.test`, "admin");
    const sso = await running.container.auth.sessions.startSession({
      userId: one.userId,
      population: "staff",
      context: "first_party",
      authLevel: 2,
      workspaceId: ws.id,
      sso: { workspaceId: ws.id, connectionId: ws.connectionId, connectionVersion: 1 },
    });
    // A session recorded as derived from the SSO one (a shape the mint paths never produce;
    // the cascade must not depend on that).
    const derived = await running.container.auth.sessions.startSession({
      userId: one.userId,
      population: "staff",
      context: "first_party",
      authLevel: 1,
      sourceSessionId: sso.session.sessionId,
    });
    expect(await running.container.auth.resolveSession(derived.token)).toBeDefined();
    expect(
      await running.container.auth.sessions.revokeSessionsForSsoConnection(
        ws.connectionId,
        "sso_connection_deleted",
      ),
    ).toBe(1);
    expect(await running.container.auth.resolveSession(sso.token)).toBeUndefined();
    expect(await running.container.auth.resolveSession(derived.token)).toBeUndefined();
  });
});

describe("E3.10 FR1: an SSO sign-in to a held or suspended workspace (R1-M1)", () => {
  it("fails closed: the session the finish route mints gets 423 on tenant APIs, 200 on sign-in surfaces", async () => {
    const ws = await workspace("held");
    const { userId } = await staffMember(ws, `held@${ws.slug}.test`, "admin");
    await running.container.db.withHost((tx) =>
      tx.execute(`UPDATE core.workspace SET holds = '{operator}' WHERE id = '${ws.id}'`),
    );
    running.container.resolver.invalidate();
    const cookie = await ssoSession(ws, userId, 2);
    expect((await people(ws, cookie)).status).toBe(423);
    expect((await me(ws, cookie)).status).toBe(200);
    expect((await request(ws.slug, "/api/v1/modules", { cookie })).status).toBe(200);
  });
});

describe("enforced SSO (decision 8)", () => {
  it("holds staff out without a session from this workspace's SSO; the bootstrap says so", async () => {
    const ws = await workspace("ssf");
    const admin = await member(ws.slug, ws.id, `admin@${ws.slug}.test`, "staff", "admin");
    const inv = await member(ws.slug, ws.id, `inv@${ws.slug}.test`, "external", "investor");
    expect((await people(ws, admin.cookie)).status).toBe(200);

    await enforce(ws, true);
    const refused = await people(ws, admin.cookie);
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({
      error: { code: "sso_required", reason: "enforced" },
    });
    expect(
      (await json<{ error: Record<string, unknown> }>(await people(ws, admin.cookie))).error[
        "breakGlass"
      ],
    ).toBeUndefined();
    // The bootstrap and /me still answer, with no membership.
    const boot = await bootstrap(ws, admin.cookie);
    expect(boot).toMatchObject({ membership: null, ssoRequired: true, ssoBreakGlass: false });
    const self = await me(ws, admin.cookie);
    expect(self.status).toBe(200);
    expect((await json<{ membership: unknown }>(self)).membership).toBeNull();

    // A session this workspace's SSO minted is admitted.
    const bound = await ssoSession(ws, await userOf(ws, admin.membershipId), 2);
    expect((await people(ws, bound)).status).toBe(200);
    expect(await bootstrap(ws, bound)).toMatchObject({ ssoRequired: false });

    // Investors are never affected.
    const invBoot = await bootstrap(ws, inv.cookie);
    expect(invBoot.ssoRequired).toBe(false);
    expect(invBoot.membership).not.toBeNull();
    expect(
      (await json<{ membership: unknown }>(await me(ws, inv.cookie))).membership,
    ).not.toBeNull();

    // Switching it off lets the ordinary session straight back in.
    await enforce(ws, false);
    expect((await people(ws, admin.cookie)).status).toBe(200);
    expect((await bootstrap(ws, admin.cookie)).ssoRequired).toBe(false);
  }, 120_000);

  it("break-glass: an owner is admitted at auth level 2, refused at level 1", async () => {
    const ws = await workspace("ssg");
    await enforce(ws, true);
    // The workspace's first owner is stepped up (TOTP) by the harness: level 2.
    expect((await people(ws, ws.owner.cookie)).status).toBe(200);
    expect((await bootstrap(ws, ws.owner.cookie)).ssoRequired).toBe(false);

    // A co-owner signed in with a code only (level 1).
    const email = `co@${ws.slug}.test`;
    await staffMember(ws, email, "owner");
    const level1 = await signIn(ws.slug, email);
    const refused = await people(ws, level1);
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({
      error: { code: "sso_required", reason: "enforced", breakGlass: true },
    });
    expect(await bootstrap(ws, level1)).toMatchObject({
      membership: null,
      ssoRequired: true,
      ssoBreakGlass: true,
    });
    // Step-up needs only a session: the owner proves a second factor and is let in.
    const level2 = await stepUp(ws.slug, level1);
    expect((await people(ws, level2)).status).toBe(200);
  }, 120_000);
});

describe("provisionStaff", () => {
  const svc = () => running.container.auth.memberships;

  it("creates a new user with a verified email and a staff membership", async () => {
    const ws = await workspace("ssh");
    const sys = systemContext(ws.id);
    const email = `New.Person@${ws.slug}.test`;
    const r = await svc().provisionStaff(
      sys,
      { email, displayName: "New Person", role: "editor", source: "scim" },
      SCIM,
    );
    expect(r).toMatchObject({ created: true, adopted: false });
    const [m] = await sql<{ kind: string; role: string; status: string; source: string }>(
      ws.id,
      `SELECT kind, role, status, source FROM core.membership WHERE id = '${r.membershipId}'`,
    );
    expect(m).toEqual({ kind: "staff", role: "editor", status: "active", source: "scim" });
    const { rows: ids } = await pg.pool.query<{ identifier: string; verified: boolean }>(
      `SELECT identifier::text, verified_at IS NOT NULL AS verified FROM core.user_identity
        WHERE user_id = $1`,
      [r.userId],
    );
    expect(ids).toEqual([{ identifier: email.toLowerCase(), verified: true }]);
    const [audit] = await sql<{
      actor_kind: string;
      actor_membership_id: string | null;
      meta: Record<string, unknown>;
    }>(
      ws.id,
      `SELECT actor_kind, actor_membership_id, meta FROM audit.event
        WHERE action = 'membership.created' AND resource_id = '${r.membershipId}'`,
    );
    expect(audit).toMatchObject({
      actor_kind: "system",
      actor_membership_id: null,
      meta: { source: "scim", role: "editor", actor: SCIM.label },
    });
    // Again: the membership is adopted, nothing new.
    const again = await svc().provisionStaff(sys, { email, role: "viewer", source: "scim" }, SCIM);
    expect(again).toEqual({
      userId: r.userId,
      membershipId: r.membershipId,
      created: false,
      adopted: true,
    });
  }, 120_000);

  it("adopts an existing staff membership (activating an invitation) and never edits the user", async () => {
    const ws = await workspace("ssi");
    const other = await workspace("ssj");
    const email = `invited@${ws.slug}.test`;
    const { userId, membershipId } = await staffMember(ws, email, "finance", "invited");
    await pg.pool.query(
      "UPDATE core.\"user\" AS u SET display_name = 'Kept Name' WHERE u.id = $1",
      [userId],
    );
    const r = await svc().provisionStaff(
      systemContext(ws.id),
      { email, displayName: "IdP Name", role: "viewer", source: "sso" },
      { kind: "system", label: `sso:${ws.connectionId}` },
    );
    expect(r).toEqual({ userId, membershipId, created: false, adopted: true });
    const [m] = await sql<{ role: string; status: string }>(
      ws.id,
      `SELECT role, status FROM core.membership WHERE id = '${membershipId}'`,
    );
    expect(m).toEqual({ role: "finance", status: "active" });
    // Staff elsewhere already: a new membership here, the global user untouched.
    const elsewhere = await svc().provisionStaff(
      systemContext(other.id),
      { email, displayName: "Another Name", role: "legal", source: "scim" },
      SCIM,
    );
    expect(elsewhere).toMatchObject({ userId, created: false, adopted: false });
    const { rows } = await pg.pool.query<{ display_name: string }>(
      'SELECT display_name FROM core."user" WHERE id = $1',
      [userId],
    );
    expect(rows[0]?.display_name).toBe("Kept Name");
  }, 120_000);

  it("refuses an external member (conflict) and an owner role (owner_protected)", async () => {
    const ws = await workspace("ssk");
    const inv = await member(ws.slug, ws.id, `inv@${ws.slug}.test`, "external", "investor");
    void inv;
    const conflict = await svc()
      .provisionStaff(
        systemContext(ws.id),
        { email: `inv@${ws.slug}.test`, role: "viewer", source: "scim" },
        SCIM,
      )
      .catch((e: unknown) => e);
    expect(isAuthError(conflict, "conflict")).toBe(true);
    expect((conflict as { details: Record<string, unknown> }).details["reason"]).toBe(
      "external_member",
    );
    const owner = await svc()
      .provisionStaff(
        systemContext(ws.id),
        { email: `boss@${ws.slug}.test`, role: "owner", source: "scim" },
        SCIM,
      )
      .catch((e: unknown) => e);
    expect(isAuthError(owner, "forbidden")).toBe(true);
    expect((owner as { details: Record<string, unknown> }).details["reason"]).toBe(
      "owner_protected",
    );
    // A suspended creation is possible (SCIM `active: false`).
    const off = await svc().provisionStaff(
      systemContext(ws.id),
      { email: `off@${ws.slug}.test`, role: "viewer", source: "scim", status: "suspended" },
      SCIM,
    );
    const [m] = await sql<{ status: string }>(
      ws.id,
      `SELECT status FROM core.membership WHERE id = '${off.membershipId}'`,
    );
    expect(m?.status).toBe("suspended");
  }, 120_000);
});

describe("suspend / unsuspend", () => {
  const svc = () => running.container.auth.memberships;

  it("suspends: sessions revoked, idempotent, the member cannot use the workspace", async () => {
    const ws = await workspace("ssl");
    const admin = await member(ws.slug, ws.id, `admin@${ws.slug}.test`, "staff", "admin");
    const userId = await userOf(ws, admin.membershipId);
    const bound = await ssoSession(ws, userId, 2);
    // A session serving another workspace survives (that tenant's fact).
    const other = await workspace("ssm");
    await provisionMembership(running.container.identityDeps, {
      workspaceId: other.id,
      userId,
      kind: "staff",
      role: "admin",
      source: "test",
    });
    const elsewhere = await running.container.auth.sessions.startSession({
      userId,
      population: "staff",
      context: "first_party",
      authLevel: 2,
      workspaceId: other.id,
    });
    const sys = systemContext(ws.id);
    const r = await svc().suspend(
      sys,
      { membershipId: admin.membershipId, reason: "scim_deactivated" },
      SCIM,
    );
    expect(r.changed).toBe(true);
    expect(r.membership.status).toBe("suspended");
    expect(r.sessionsRevoked).toBe(2);
    expect((await me(ws, admin.cookie)).status).toBe(401);
    expect((await me(ws, bound)).status).toBe(401);
    expect((await me(other, `${SESSION_COOKIE}=${elsewhere.token}`)).status).toBe(200);

    const again = await svc().suspend(
      sys,
      { membershipId: admin.membershipId, reason: "scim_deactivated" },
      SCIM,
    );
    expect(again).toMatchObject({ changed: false, sessionsRevoked: 0 });

    // A new session (however minted) gets no membership here.
    const fresh = await ssoSession(ws, userId, 2);
    expect((await json<{ membership: unknown }>(await me(ws, fresh))).membership).toBeNull();
    expect((await people(ws, fresh)).status).toBe(404);

    const events = await sql<{ action: string; meta: Record<string, unknown>; actor_kind: string }>(
      ws.id,
      `SELECT action, meta, actor_kind FROM audit.event
        WHERE subject_membership_id = '${admin.membershipId}'
          AND action IN ('membership.suspended', 'membership.reactivated') ORDER BY seq`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "membership.suspended",
      actor_kind: "system",
      meta: { reason: "scim_deactivated", actor: SCIM.label, sessionsRevoked: 2 },
    });

    const back = await svc().unsuspend(sys, { membershipId: admin.membershipId }, SCIM);
    expect(back).toMatchObject({ changed: true, membership: { status: "active" } });
    expect((await svc().unsuspend(sys, { membershipId: admin.membershipId }, SCIM)).changed).toBe(
      false,
    );
    expect((await people(ws, fresh)).status).toBe(200);
  }, 120_000);

  it("never suspends an owner, and the system never changes or revokes one", async () => {
    const ws = await workspace("ssn");
    const sys = systemContext(ws.id);
    const refused = await svc()
      .suspend(sys, { membershipId: ws.owner.membershipId, reason: "scim_deactivated" }, SCIM)
      .catch((e: unknown) => e);
    expect(isAuthError(refused, "forbidden")).toBe(true);
    expect((refused as { details: Record<string, unknown> }).details["reason"]).toBe(
      "owner_protected",
    );
    const demote = await svc()
      .update(sys, ws.owner.membershipId, { role: "viewer" }, SCIM)
      .catch((e: unknown) => e);
    expect(isAuthError(demote, "forbidden")).toBe(true);
    const revoke = await svc()
      .revoke(sys, { membershipId: ws.owner.membershipId, reason: "scim_deprovisioned" }, SCIM)
      .catch((e: unknown) => e);
    expect(isAuthError(revoke, "forbidden")).toBe(true);
    // Nor promotes anybody to owner.
    const { membershipId } = await staffMember(ws, `ed@${ws.slug}.test`, "editor");
    const promote = await svc()
      .update(sys, membershipId, { role: "owner" }, SCIM)
      .catch((e: unknown) => e);
    expect(isAuthError(promote, "forbidden")).toBe(true);
    // A non-owner role change by the system is audited as the system.
    await svc().update(sys, membershipId, { role: "admin" }, SCIM);
    const [ev] = await sql<{ actor_kind: string; meta: Record<string, unknown> }>(
      ws.id,
      `SELECT actor_kind, meta FROM audit.event
        WHERE action = 'membership.role_changed' AND resource_id = '${membershipId}'`,
    );
    expect(ev).toMatchObject({
      actor_kind: "system",
      meta: { from: "editor", to: "admin", actor: SCIM.label },
    });
  }, 120_000);

  it("revoke by the system on the caller's transaction revokes sessions in it", async () => {
    const ws = await workspace("sso");
    const ed = await member(ws.slug, ws.id, `ed@${ws.slug}.test`, "staff", "editor");
    const sys = systemContext(ws.id);
    const r = await running.container.db.withTenant(sys, (tx) =>
      svc().revoke(sys, { membershipId: ed.membershipId, reason: "scim_deprovisioned" }, SCIM, {
        tx,
      }),
    );
    expect(r.membershipIds).toEqual([ed.membershipId]);
    expect(r.sessionsRevoked).toBe(1);
    expect((await me(ws, ed.cookie)).status).toBe(401);
  }, 120_000);
});

describe("an SSO-bound session cannot change the global account (fix round 1, H1)", () => {
  it("refuses every factor, password, session and device change; the victim's other workspace is untouched", async () => {
    // R1's chain: the victim owns `beta` (TOTP enrolled) and holds a legal seat in `acme`, whose
    // owner runs an IdP that asserts the victim's address with amr=mfa (a level-2 bound session).
    const acme = await workspace("sss");
    const beta = await workspace("sst");
    const victim = beta.owner;
    const victimUser = await userOf(beta, victim.membershipId);
    await provisionMembership(running.container.identityDeps, {
      workspaceId: acme.id,
      userId: victimUser,
      kind: "staff",
      role: "legal",
      source: "test",
    });
    const bound = await ssoSession(acme, victimUser, 2);
    const boundId = (
      await pg.pool.query<{ id: string }>(
        "SELECT id FROM core.session WHERE sso_workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL",
        [acme.id, victimUser],
      )
    ).rows[0]?.id as string;
    const otherSession = (
      await pg.pool.query<{ id: string }>(
        `SELECT id FROM core.session WHERE user_id = $1 AND sso_workspace_id IS NULL
           AND revoked_at IS NULL LIMIT 1`,
        [victimUser],
      )
    ).rows[0]?.id as string;
    const [dev] = (
      await pg.pool.query<{ id: string }>("SELECT id FROM core.device WHERE user_id = $1", [
        victimUser,
      ])
    ).rows;
    const call = (method: string, path: string, body?: unknown) =>
      request(acme.slug, path, {
        method,
        cookie: bound,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const attempts: [string, string, unknown?][] = [
      ["PUT", "/api/v1/auth/password", { password: "correct horse battery staple 42!" }],
      ["DELETE", "/api/v1/auth/password"],
      ["POST", "/api/v1/auth/totp/enrol"],
      ["POST", "/api/v1/auth/totp/enrol/confirm", { code: "123456" }],
      ["DELETE", "/api/v1/auth/totp"],
      ["POST", "/api/v1/auth/totp/recovery-codes"],
      ["POST", "/api/v1/auth/passkeys/register/begin", {}],
      ["PATCH", `/api/v1/auth/passkeys/${randomUUID()}`, { name: "mine now" }],
      ["DELETE", `/api/v1/auth/passkeys/${randomUUID()}`],
      ["POST", "/api/v1/auth/logout-everywhere", {}],
      ["GET", "/api/v1/me/sessions"],
      ["DELETE", `/api/v1/me/sessions/${otherSession}`],
      ["GET", "/api/v1/me/devices"],
      ["PATCH", `/api/v1/me/devices/${dev?.id ?? randomUUID()}`, { name: "x" }],
      ["DELETE", `/api/v1/me/devices/${dev?.id ?? randomUUID()}`],
      ["PUT", "/api/v1/me/locale", { locale: "en" }],
      // Fix round 2 (L1): nor may it read the global sign-in setup.
      ["GET", "/api/v1/auth/totp"],
      ["GET", "/api/v1/auth/passkeys"],
      ["GET", "/api/v1/auth/password"],
    ];
    const answers: string[] = [];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, body);
      const code =
        res.status === 403 ? (await json<{ error: { code: string } }>(res)).error.code : "";
      answers.push(`${method} ${path.replace(/[0-9a-f-]{36}/gu, ":id")} ${res.status} ${code}`);
    }
    expect(answers.filter((a) => !a.endsWith(" 403 sso_session_restricted"))).toEqual([]);

    // Step-up with an already-enrolled factor is still offered (only this session would rise).
    const verify = await call("POST", "/api/v1/auth/totp/verify", { code: "000000" });
    expect(verify.status).not.toBe(403);
    // Signing itself out is always allowed.
    expect((await call("DELETE", `/api/v1/me/sessions/${boundId}`)).status).toBeLessThan(300);

    // Nothing changed for the victim: their beta session works, TOTP is still theirs alone.
    expect((await me(beta, victim.cookie)).status).toBe(200);
    const { rows: creds } = await pg.pool.query<{ kind: string }>(
      "SELECT kind::text FROM core.credential WHERE user_id = $1 ORDER BY kind",
      [victimUser],
    );
    expect(creds.map((c) => c.kind)).not.toContain("password");
    expect(creds.map((c) => c.kind)).toContain("totp");
  }, 120_000);
});

describe("step-up budgets of a bound session (fix rounds 2–4)", () => {
  /** A user with TOTP enrolled through the service; returns the authenticator. */
  async function withTotp(
    userId: string,
  ): Promise<OTPAuth.TOTP & { recoveryCodes?: readonly string[] }> {
    const totpFlow = running.container.auth.totp;
    const { secretBase32 } = await totpFlow.beginEnrolment({ userId });
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
    const { recoveryCodes } = await totpFlow.confirmEnrolment({ userId, code: totp.generate() });
    return Object.assign(totp, { recoveryCodes });
  }
  /** The next step's code (the enrolment spent the current one; replays are refused). */
  const nextCode = (totp: OTPAuth.TOTP) => totp.generate({ timestamp: Date.now() + 30_000 });

  it("a hostile workspace's wrong codes lock only its own bucket, nothing the victim uses elsewhere", async () => {
    const hostile = await workspace("ssw");
    const own = await workspace("ssx");
    const beta = await workspace("ssy");
    const email = `victim@${beta.slug}.test`;
    const { userId } = await staffMember(beta, email, "owner");
    for (const ws of [hostile, own]) {
      await provisionMembership(running.container.identityDeps, {
        workspaceId: ws.id,
        userId,
        kind: "staff",
        role: "legal",
        source: "test",
      });
    }
    const totp = await withTotp(userId);
    const boundHostile = await ssoSession(hostile, userId, 1);
    const boundOwn = await ssoSession(own, userId, 1);
    const post = (ws: Ws, cookie: string, path: string, code: string) =>
      request(ws.slug, path, { method: "POST", cookie, body: JSON.stringify({ code }) });

    // Fix round 3: password reverify is refused outright (a global-password oracle otherwise).
    const reverify = await request(hostile.slug, "/api/v1/auth/password/reverify", {
      method: "POST",
      cookie: boundHostile,
      body: JSON.stringify({ password: "guess-number-one-1!" }),
    });
    expect(reverify.status).toBe(403);
    expect((await json<{ error: { code: string } }>(reverify)).error.code).toBe(
      "sso_session_restricted",
    );

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++)
      statuses.push(
        (await post(hostile, boundHostile, "/api/v1/auth/totp/verify", "000000")).status,
      );
    statuses.push(
      (await post(hostile, boundHostile, "/api/v1/auth/totp/recovery", "aaaaa-bbbbb")).status,
    );
    statuses.push((await post(hostile, boundHostile, "/api/v1/auth/totp/verify", "000000")).status);
    // The hostile workspace's own bucket is spent …
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429]);
    // … but the victim's own SSO workspace still takes their code (FR4: no shared bucket) …
    const ownStep = await post(own, boundOwn, "/api/v1/auth/totp/verify", nextCode(totp));
    expect(ownStep.status, await ownStep.clone().text()).toBe(200);
    // No recovery code was consumed by the failed guesses …
    expect((await running.container.auth.totp.status(userId)).recoveryCodesLeft).toBe(10);
    // … and their ordinary sign-in on beta passes its second factor (a recovery code: it spends
    // the same global `totp:user:<id>` budget, which the hostile guesses never touched).
    const fresh = await signIn(beta.slug, email);
    const login = await request(beta.slug, "/api/v1/auth/totp/recovery", {
      method: "POST",
      cookie: fresh,
      body: JSON.stringify({ code: totp.recoveryCodes?.[0] }),
    });
    expect(login.status, await login.clone().text()).toBe(200);
  }, 120_000);

  it("the per-IP step-up cap counts failures only: 21 users behind one address with good codes pass", async () => {
    const ws = await workspace("ssz");
    const ip = "203.0.113.77";
    const results: number[] = [];
    for (let i = 0; i < 21; i++) {
      const { userId } = await staffMember(ws, `nat${i}@${ws.slug}.test`, "editor");
      const totp = await withTotp(userId);
      const bound = await ssoSession(ws, userId, 1);
      const res = await request(ws.slug, "/api/v1/auth/totp/verify", {
        method: "POST",
        cookie: bound,
        headers: { "x-forwarded-for": ip },
        body: JSON.stringify({ code: nextCode(totp) }),
      });
      results.push(res.status);
    }
    expect(results.filter((st) => st !== 200)).toEqual([]);
    // Wrong codes from that address still hit the cap (20 failures / 15 min), across users.
    const failures: number[] = [];
    for (let i = 0; i < 21; i++) {
      const { userId } = await staffMember(ws, `bad${i}@${ws.slug}.test`, "editor");
      await withTotp(userId);
      const bound = await ssoSession(ws, userId, 1);
      const res = await request(ws.slug, "/api/v1/auth/totp/verify", {
        method: "POST",
        cookie: bound,
        headers: { "x-forwarded-for": ip },
        body: JSON.stringify({ code: "000000" }),
      });
      failures.push(res.status);
    }
    expect(failures.slice(0, 20).every((st) => st === 400)).toBe(true);
    expect(failures[20]).toBe(429);
  }, 180_000);
});

describe("DSAR subject export (fix round 1, M4)", () => {
  it("includes the SCIM projection and this workspace's SSO identities only", async () => {
    const ws = await workspace("ssu");
    const other = await workspace("ssv");
    const email = `subject@${ws.slug}.test`;
    const { userId, membershipId } = await staffMember(ws, email, "viewer");
    await sql(
      ws.id,
      `INSERT INTO core.scim_user (workspace_id, membership_id, user_id, user_name, email,
         given_name, family_name, external_id)
       VALUES ('${ws.id}', '${membershipId}', '${userId}', '${email}', '${email}', 'Sub', 'Ject',
         'ext-7')`,
    );
    await pg.pool.query(
      `INSERT INTO core.user_identity (user_id, type, identifier, verified_at)
       VALUES ($1, 'oidc', $2, now()), ($1, 'saml', $3, now())`,
      [userId, `${ws.connectionId}|sub-here`, `${other.connectionId}|sub-there`],
    );
    const res = await request(ws.slug, `/api/v1/compliance/subjects/${membershipId}/export`, {
      cookie: ws.owner.cookie,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const check = verifySubjectExport(new Uint8Array(await res.arrayBuffer()));
    expect(check.problems).toEqual([]);
    const profile = JSON.parse(check.files["profile.json"] as string) as {
      scim: Record<string, unknown>[];
      ssoIdentities: Record<string, unknown>[];
    };
    expect(profile.scim).toEqual([
      expect.objectContaining({
        userName: email,
        email,
        givenName: "Sub",
        familyName: "Ject",
        externalId: "ext-7",
        active: true,
        deletedAt: null,
      }),
    ]);
    expect(profile.ssoIdentities).toEqual([
      expect.objectContaining({
        protocol: "oidc",
        connectionId: ws.connectionId,
        subject: "sub-here",
      }),
    ]);
  }, 120_000);
});

describe("identity erasure (decision 12)", () => {
  it("scrubs the SCIM projection and deletes this workspace's SSO identities only", async () => {
    const ws = await workspace("ssp");
    const other = await workspace("ssq");
    const email = `leaver@${ws.slug}.test`;
    const { userId, membershipId } = await staffMember(ws, email, "editor");
    // Still staff elsewhere: the erasure is per-workspace (global: false).
    await provisionMembership(running.container.identityDeps, {
      workspaceId: other.id,
      userId,
      kind: "staff",
      role: "editor",
      source: "test",
    });
    const [su] = await sql<{ id: string }>(
      ws.id,
      `INSERT INTO core.scim_user (workspace_id, membership_id, user_id, user_name, email,
         display_name, given_name, family_name, external_id)
       VALUES ('${ws.id}', '${membershipId}', '${userId}', '${email}', '${email}', 'Lea Ver',
         'Lea', 'Ver', 'ext-42') RETURNING id`,
    );
    const [grp] = await sql<{ id: string }>(
      ws.id,
      `INSERT INTO core.scim_group (workspace_id, display_name) VALUES ('${ws.id}', 'Eng')
       RETURNING id`,
    );
    await sql(
      ws.id,
      `INSERT INTO core.scim_group_member (workspace_id, group_id, scim_user_id)
       VALUES ('${ws.id}', '${grp?.id}', '${su?.id}')`,
    );
    await pg.pool.query(
      `INSERT INTO core.user_identity (user_id, type, identifier, verified_at)
       VALUES ($1, 'oidc', $2, now()), ($1, 'saml', $3, now())`,
      [userId, `${ws.connectionId}|sub-here`, `${other.connectionId}|sub-there`],
    );

    const res = await request(ws.slug, "/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: ws.owner.cookie,
      body: JSON.stringify({ membershipId }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { id, expectedModules } = await json<{ id: string; expectedModules: string[] }>(res);
    const ctx = systemContext(ws.id);
    for (const module of expectedModules) {
      await running.container.db.withTenant(ctx, (tx) =>
        running.container.moduleServices.legal.completeErasureStep(tx, ctx, id, module, {}),
      );
    }
    const [req] = await sql<{ status: string }>(
      ws.id,
      `SELECT status FROM core.dsar_request WHERE id = '${id}'`,
    );
    expect(req?.status).toBe("completed");

    const [row] = await sql<Record<string, unknown>>(
      ws.id,
      `SELECT user_name::text, email::text, display_name, given_name, family_name, external_id,
              active, deleted_at IS NOT NULL AS tombstoned
         FROM core.scim_user WHERE id = '${su?.id}'`,
    );
    expect(row).toEqual({
      user_name: `erased-${su?.id}@invalid`,
      email: null,
      display_name: null,
      given_name: null,
      family_name: null,
      external_id: null,
      active: false,
      // Fix round 1 (M1): tombstoned, so SCIM answers 404 and a late PATCH cannot re-add PII.
      tombstoned: true,
    });
    // Group edges carry ids only and are kept.
    const [edge] = await sql<{ n: number }>(
      ws.id,
      `SELECT count(*)::int AS n FROM core.scim_group_member WHERE scim_user_id = '${su?.id}'`,
    );
    expect(edge?.n).toBe(1);
    const { rows: left } = await pg.pool.query<{ type: string; identifier: string }>(
      `SELECT type::text, identifier FROM core.user_identity
        WHERE user_id = $1 AND type IN ('oidc', 'saml')`,
      [userId],
    );
    expect(left).toEqual([{ type: "saml", identifier: `${other.connectionId}|sub-there` }]);
    const [step] = await sql<{ counts: Record<string, number> }>(
      ws.id,
      `SELECT counts FROM core.dsar_step WHERE request_id = '${id}' AND module = 'core.identity'`,
    );
    expect(step?.counts).toMatchObject({ scimUsers: 1, ssoIdentities: 1, global: 0 });
  }, 120_000);
});

describe("a one-connection pool", () => {
  it("suspend, unsuspend, revoke-in-tx and provisionStaff never need a second connection", async () => {
    const ws = await workspace("ssr");
    const target = await staffMember(ws, `t@${ws.slug}.test`, "viewer");
    const bound = await ssoSession(ws, target.userId, 1);
    const single = await startServer({
      config: esignTestConfig(freshSecrets(pg.connectionString), {
        DATABASE_POOL_MAX: "1",
        ROLES: "api",
      }),
      logger: createLogger({ level: "error" }),
      mailer,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    const within = <T>(label: string, p: Promise<T>) =>
      Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} hung (pool exhausted?)`)), 10_000),
        ),
      ]);
    try {
      await single.container.relay.stop();
      const svc = single.container.auth.memberships;
      const sys = systemContext(ws.id);
      const s = await within(
        "suspend in tx",
        single.container.db.withTenant(sys, (tx) =>
          svc.suspend(sys, { membershipId: target.membershipId, reason: "t" }, SCIM, { tx }),
        ),
      );
      expect(s.sessionsRevoked).toBe(1);
      expect((await me(ws, bound)).status).toBe(401);
      await within("unsuspend", svc.unsuspend(sys, { membershipId: target.membershipId }, SCIM));
      const p = await within(
        "provisionStaff",
        svc.provisionStaff(
          sys,
          { email: `p@${ws.slug}.test`, role: "viewer", source: "scim" },
          SCIM,
        ),
      );
      expect(p.adopted).toBe(false);
      await within(
        "revoke in tx",
        single.container.db.withTenant(sys, (tx) =>
          svc.revoke(sys, { membershipId: p.membershipId }, SCIM, { tx }),
        ),
      );
    } finally {
      await single.stop();
    }
  }, 120_000);
});
