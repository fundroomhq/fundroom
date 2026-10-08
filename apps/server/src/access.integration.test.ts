import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EffectiveAccessRepo } from "@fundroom/authz";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Access management end to end (E1.1) in multi-tenant mode: two workspaces, staff with
 * MFA-grade sessions, invitations that carry groups and grants, the investor's view of what
 * they can reach, "who has access / why", the §13.2 revocation cascade, RBAC and MFA gates,
 * and the cross-tenant replay fuzz that expects 404 for every id-bearing access route.
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

async function request(
  slug: string,
  path: string,
  init: RequestInit & { cookie?: string; host?: string } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("host", init.host ?? `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
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
  const body = await json<{ session: { userId: string }; membership: { id: string } | null }>(
    verify,
  );
  return {
    cookie: cookiesOf(verify),
    membershipId: body.membership?.id ?? "",
    userId: body.session.userId,
  };
}

/** Enrols TOTP on the session so it reaches auth level 2 (owners/admins need it). */
async function stepUpToMfa(slug: string, cookie: string): Promise<string> {
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  expect(enrol.status).toBe(200);
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

async function staff(
  slug: string,
  workspaceId: string,
  email: string,
  role: "owner" | "admin" | "editor" | "legal",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, {
    workspaceId,
    userId: user.userId,
    kind: "staff",
    role,
    source: "test",
  });
  const actor = await signIn(slug, email);
  if (role === "owner" || role === "admin") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

let acmeId: string;
let globexId: string;
let owner: Actor;
let admin: Actor;
let legal: Actor;
let editor: Actor;
let globexOwner: Actor;
const FOLDER = { kind: "folder", id: randomUUID(), path: "root.dd" };
const SUBFOLDER = { kind: "folder", id: randomUUID(), path: "root.dd.legal" };
const DOC = { kind: "folder", id: randomUUID(), path: "root.dd.legal.nda" };
/** A Globex folder: another tenant's real resource, for the P1-03 no-oracle checks. */
const GLOBEX_FOLDER = { kind: "folder", id: randomUUID(), path: "root.gx" };
let globexNdaId = "";

/**
 * Grants and gates name resources that must exist in the workspace (P1-03), so the folders these
 * tests grant on are real `dataroom.folder` rows — inserted directly, because the data room's own
 * routes are not what this file is about. `ON CONFLICT` keeps an existing root.
 */
async function seedFolders(
  workspaceId: string,
  folders: readonly { id: string; path: string }[],
): Promise<void> {
  await running.container.db.withTenant(systemContext(workspaceId), async (tx) => {
    await tx.execute(
      `INSERT INTO dataroom.folder (workspace_id, name, path)
         VALUES ('${workspaceId}'::uuid, 'Root', 'root') ON CONFLICT DO NOTHING`,
    );
    for (const f of folders) {
      const parentPath = f.path.split(".").slice(0, -1).join(".");
      await tx.execute(
        `INSERT INTO dataroom.folder (id, workspace_id, parent_id, name, path)
           SELECT '${f.id}'::uuid, '${workspaceId}'::uuid, p.id, '${f.path}', '${f.path}'
             FROM dataroom.folder p
            WHERE p.workspace_id = '${workspaceId}'::uuid AND p.deleted_at IS NULL
              AND (p.path = '${parentPath}' OR ('${parentPath}' = 'root' AND p.parent_id IS NULL))
            LIMIT 1`,
      );
    }
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
  owner = await staff("acme", acmeId, "owner@example.com", "owner");
  admin = await staff("acme", acmeId, "admin@example.com", "admin");
  legal = await staff("acme", acmeId, "legal@example.com", "legal");
  editor = await staff("acme", acmeId, "editor@example.com", "editor");
  globexOwner = await staff("globex", globexId, "boss@example.org", "owner");
  // DOC too: invitation grants are now checked like direct ones (review R1-A1/A2).
  await seedFolders(acmeId, [FOLDER, SUBFOLDER, DOC]);
  await seedFolders(globexId, [GLOBEX_FOLDER]);
  globexNdaId = await running.container.db.withTenant(systemContext(globexId), async (tx) => {
    const r = await tx.execute(
      `INSERT INTO core.legal_document (workspace_id, kind, slug, title)
         VALUES ('${globexId}'::uuid, 'nda', 'globex-nda', 'Globex NDA') RETURNING id::text AS id`,
    );
    return (r.rows as { id: string }[])[0]?.id ?? "";
  });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("timed out");
}

describe("RBAC and MFA gates", () => {
  it("an owner without MFA gets step_up_required (reason level) on every access route", async () => {
    const deps = running.container.identityDeps;
    const user = await provisionUser(deps, { email: "weak@example.com" });
    await provisionMembership(deps, {
      workspaceId: acmeId,
      userId: user.userId,
      kind: "staff",
      role: "admin",
      source: "test",
    });
    const weak = await signIn("acme", "weak@example.com");
    const res = await request("acme", "/api/v1/access/people", { cookie: weak.cookie });
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({
      error: { code: "step_up_required", reason: "level", requiredLevel: 2, currentLevel: 1 },
    });
  });

  it("the modules bootstrap reports matrix permissions per role", async () => {
    const o = await json<{ permissions: string[] }>(
      await request("acme", "/api/v1/modules", { cookie: owner.cookie }),
    );
    expect(o.permissions).toEqual([
      // Deleting the workspace is owner-only (E2.7 danger zone).
      "access.delete_workspace",
      "access.manage",
      "access.manage_staff",
      "access.read",
      "access.settings",
      "access.transfer",
      // Accreditation vendor connections (E3.7) are owner/admin; counsel reads them.
      "accreditation.manage",
      "accreditation.read",
      // AI assist (E3.12): every staff role reads; owner/admin turn it on and acknowledge the provider.
      "ai.manage",
      "ai.read",
      "analytics.read",
      "analytics.settings",
      // Workspace API keys (E3.4) are owner/admin: a key acts with its creator's permissions.
      "api-keys.manage",
      "api-keys.read",
      // The audit log (E2.7): owner/admin/legal read it, owner/legal export it.
      "audit.export",
      "audit.read",
      // Billing (E3.10): owner reads and pays; the pinned list follows the kernel manifest.
      "billing.manage",
      "billing.read",
      // Branding is owner/admin only (E1.7): the company's identity to every investor, not a
      // document-management task.
      "branding.manage",
      "branding.read",
      "compliance.manage",
      "compliance.offering",
      "compliance.read",
      "content.manage",
      "content.publish",
      "content.read",
      "content.settings",
      "data-room.download",
      // Forensic watermark detection (E3.13): owner/admin/legal trace a leaked page.
      "data-room.forensics",
      "data-room.legal_hold",
      "data-room.manage",
      // Data-room Q&A (E3.3): answering, running the inbox, approving answers.
      "data-room.qa_answer",
      "data-room.qa_approve",
      "data-room.qa_manage",
      "data-room.read",
      "data-room.settings",
      // Custom portal domains are owner/admin only too (E2.1): the hostname the portal answers
      // on decides where every investor's session cookie lives.
      "domains.manage",
      "domains.read",
      // Embed is owner/admin only (E2.2), on domains' reasoning: the origin allow-list becomes
      // `frame-ancestors`, so it decides whose page may wrap the portal in its own chrome.
      "embed.manage",
      "embed.read",
      // E-signature (E3.5) is owner/admin to manage: the vendor credentials and callback secret.
      "esign.manage",
      "esign.read",
      // Integrations (E3.6) are owner/admin to manage: vendor tokens and keys.
      "integrations.manage",
      "integrations.read",
      // Workspace Slack channels (E2.6) are owner/admin: a webhook URL is a credential.
      "notify.manage",
      "notify.read",
      // Jobs and health (E2.7) are owner/admin: dead letters name workspace events.
      "ops.manage",
      "ops.read",
      // Exporting the whole workspace (E2.8) is owner-only: all of the company's data at once.
      "portability.export",
      // Staff SSO + SCIM (E3.8): admins read, only the owner manages (who can sign in as staff).
      "sso.manage",
      "sso.read",
      "updates.manage",
      "updates.read",
      "updates.send",
      "updates.settings",
      // Outbound webhooks (E3.4) are owner/admin: an endpoint receives workspace events.
      "webhooks.manage",
      "webhooks.read",
    ]);
    const l = await json<{ permissions: string[] }>(
      await request("acme", "/api/v1/modules", { cookie: legal.cookie }),
    );
    expect(l.permissions).toEqual([
      "access.read",
      "accreditation.read",
      "ai.read",
      "analytics.read",
      // Counsel reads and exports the audit log (E2.7): it is their evidence.
      "audit.export",
      "audit.read",
      // Counsel owns the legal texts (E1.6) but not the company's reliance on an exemption.
      "compliance.manage",
      "compliance.read",
      "content.read",
      "data-room.download",
      "data-room.forensics",
      "data-room.legal_hold",
      // Counsel answers investor questions and approves answers before release (E3.3).
      "data-room.qa_answer",
      "data-room.qa_approve",
      "data-room.read",
      // Counsel reads the e-sign register and its signed copies (E3.5), without the credentials.
      "esign.read",
      "notify.read",
      "updates.read",
    ]);
    const e = await json<{ permissions: string[]; modules: { id: string; enabled: boolean }[] }>(
      await request("acme", "/api/v1/modules", { cookie: editor.cookie }),
    );
    expect(e.permissions).toEqual([
      "ai.read",
      "analytics.read",
      "content.manage",
      "content.publish",
      "content.read",
      "data-room.download",
      "data-room.manage",
      "data-room.qa_answer",
      "data-room.read",
      "notify.read",
      "updates.manage",
      "updates.read",
      "updates.send",
    ]);
    expect(e.modules.find((m) => m.id === "access")?.enabled).toBe(true);
    expect(e.modules.find((m) => m.id === "content")?.enabled).toBe(true);
  });

  it("legal reads people but cannot manage; editor sees nothing", async () => {
    expect((await request("acme", "/api/v1/access/people", { cookie: legal.cookie })).status).toBe(
      200,
    );
    const denied = await request("acme", "/api/v1/access/groups", {
      method: "POST",
      cookie: legal.cookie,
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(denied.status).toBe(403);
    expect((await json(denied))["error"]).toMatchObject({
      code: "forbidden",
      permission: "access.manage",
    });
    expect((await request("acme", "/api/v1/access/people", { cookie: editor.cookie })).status).toBe(
      403,
    );
    expect((await request("acme", "/api/v1/access/people")).status).toBe(401);
  });

  it("an admin cannot make or unmake an owner, and the last owner cannot be demoted", async () => {
    const promote = await request("acme", `/api/v1/access/people/${admin.membershipId}`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: JSON.stringify({ role: "owner" }),
    });
    expect(promote.status).toBe(403);
    const demote = await request("acme", `/api/v1/access/people/${owner.membershipId}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ role: "admin" }),
    });
    expect(demote.status).toBe(400);
    expect((await json(demote))["error"]).toMatchObject({ code: "invalid_request" });
    const ok = await request("acme", `/api/v1/access/people/${editor.membershipId}`, {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ role: "viewer", profile: { title: "Analyst" } }),
    });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ role: "viewer", profile: { title: "Analyst" } });
  });
});

describe("invite → groups → grants → investor access → revoke", () => {
  let boardId: string;
  let seedId: string;
  let investor: Actor;
  let inviteId: string;

  it("creates groups (names unique) and lists them with counts", async () => {
    const board = await request("acme", "/api/v1/access/groups", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ name: "Board", kind: "board" }),
    });
    expect(board.status).toBe(200);
    boardId = (await json<{ id: string }>(board)).id;
    const seed = await request("acme", "/api/v1/access/groups", {
      method: "POST",
      cookie: admin.cookie,
      body: JSON.stringify({ name: "Seed investors" }),
    });
    seedId = (await json<{ id: string }>(seed)).id;
    const dup = await request("acme", "/api/v1/access/groups", {
      method: "POST",
      cookie: admin.cookie,
      body: JSON.stringify({ name: "board" }),
    });
    expect(dup.status).toBe(400);
    const list = await json<{ groups: { name: string; memberCount: number }[] }>(
      await request("acme", "/api/v1/access/groups", { cookie: legal.cookie }),
    );
    expect(list.groups.map((g) => [g.name, g.memberCount])).toEqual([
      ["Board", 0],
      ["Seed investors", 0],
    ]);
  });

  it("grants the Board group the data room and excludes it from the legal subfolder", async () => {
    const grant = await request("acme", "/api/v1/access/grants", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        subject: { kind: "group", id: boardId },
        resource: FOLDER,
        capabilities: ["view", "download"],
      }),
    });
    expect(grant.status).toBe(200);
    expect((await json<{ grants: unknown[] }>(grant)).grants).toHaveLength(2);
    const exclude = await request("acme", "/api/v1/access/grants", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        subject: { kind: "group", id: boardId },
        resource: SUBFOLDER,
        capabilities: ["download"],
        effect: "exclude",
      }),
    });
    expect(exclude.status).toBe(200);
    const listed = await json<{ grants: { effect: string; capability: string }[] }>(
      await request(
        "acme",
        `/api/v1/access/grants?resourceKind=folder&resourceId=${DOC.id}&resourcePath=${DOC.path}`,
        { cookie: legal.cookie },
      ),
    );
    expect(listed.grants.map((g) => `${g.effect}:${g.capability}`).sort()).toEqual([
      "allow:download",
      "allow:view",
      "exclude:download",
    ]);
  });

  it("invites an investor into Board with a direct grant; the invite email carries the link", async () => {
    const res = await request("acme", "/api/v1/access/invites", {
      method: "POST",
      cookie: admin.cookie,
      body: JSON.stringify({
        invites: [
          { email: "ada@investor.test", displayName: "Ada Lovelace", firm: "Analytical Ventures" },
          { email: "legal@example.com" },
        ],
        groupIds: [boardId],
        grants: [{ resource: DOC, capabilities: ["view"] }],
        message: "Welcome aboard",
      }),
    });
    expect(res.status).toBe(200);
    const body = await json<{
      created: { id: string; email: string }[];
      failed: { email: string; code: string }[];
    }>(res);
    expect(body.created.map((i) => i.email)).toEqual(["ada@investor.test"]);
    expect(body.failed).toEqual([{ email: "legal@example.com", code: "conflict" }]);
    inviteId = body.created[0]?.id ?? "";
    const inviteMail = mailer.sent.find((m) => m.to === "ada@investor.test");
    expect(inviteMail?.text).toContain("/invite/");
    // E1.7: the invitation is workspace-scoped, so it names the workspace the mailer's brand
    // resolver must look up.
    expect(inviteMail?.workspaceId).toBe(acmeId);
    const invited = await json<{ items: { email: string; status: string; kind: string }[] }>(
      await request("acme", "/api/v1/access/invites?status=pending", { cookie: legal.cookie }),
    );
    expect(invited).toMatchObject({ invites: [{ email: "ada@investor.test", status: "pending" }] });
  });

  it("resends with a fresh link and lists the pending invite in People once accepted", async () => {
    const before = mailer.sent.length;
    const resend = await request("acme", `/api/v1/access/invites/${inviteId}/resend`, {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(resend.status).toBe(200);
    expect(mailer.sent.length).toBe(before + 1);

    investor = await signIn("acme", "ada@investor.test");
    const me = await json<{ membership: { kind: string; role: string } }>(
      await request("acme", "/api/v1/me", { cookie: investor.cookie }),
    );
    expect(me.membership).toMatchObject({ kind: "external", role: "investor" });
    const person = await json<{
      person: { groups: { name: string }[]; profile: Record<string, unknown> };
      grants: unknown[];
    }>(
      await request("acme", `/api/v1/access/people/${investor.membershipId}`, {
        cookie: legal.cookie,
      }),
    );
    expect(person.person.groups.map((g) => g.name)).toEqual(["Board"]);
    expect(person.person.profile).toMatchObject({
      displayName: "Ada Lovelace",
      firm: "Analytical Ventures",
    });
    expect(person.grants).toHaveLength(1);
  });

  it("materialises effective access and answers the investor's /access/my", async () => {
    const my = await waitFor(async () => {
      const r = await json<{
        permissions: string[];
        resources: { id: string; capabilities: string[] }[];
      }>(await request("acme", "/api/v1/access/my", { cookie: investor.cookie }));
      return r.resources.length >= 3 ? r : undefined;
    });
    expect(my.permissions).toEqual([]);
    const byId = new Map(my.resources.map((r) => [r.id, r.capabilities]));
    expect(byId.get(FOLDER.id)).toEqual(["view", "download"]);
    expect(byId.get(SUBFOLDER.id)).toEqual(["view"]);
    expect(byId.get(DOC.id)).toEqual(["view"]);

    const ctx = systemContext(acmeId);
    const state = await running.container.db.withTenant(ctx, (tx) =>
      new EffectiveAccessRepo(ctx, tx).state(),
    );
    expect(state?.rowCount).toBeGreaterThanOrEqual(3);
    const decision = await running.container.authz.check(
      { workspaceId: acmeId, membershipId: investor.membershipId },
      { kind: "folder", id: randomUUID(), path: "root.dd.legal.other" },
      "download",
    );
    expect(decision).toMatchObject({ allowed: false, reason: "no_grant", capabilities: ["view"] });
    const staffDecision = await running.container.authz.check(
      { workspaceId: acmeId, membershipId: owner.membershipId },
      DOC,
      "view",
    );
    // The data room registers `folder` for staff RBAC (E1.3): owners hold every capability by role.
    expect(staffDecision).toMatchObject({
      allowed: true,
      reason: "granted",
      capabilities: ["view", "download", "edit"],
    });
  });

  it("explains who has access and why, with labels", async () => {
    const who = await json<{
      holders: {
        membershipId: string;
        displayName: string;
        capabilities: string[];
        via: { subject: { kind: string; label: string }; decisive: boolean; inherited: boolean }[];
      }[];
    }>(
      await request("acme", `/api/v1/access/resources/folder/${DOC.id}/who?path=${DOC.path}`, {
        cookie: legal.cookie,
      }),
    );
    expect(who.holders).toHaveLength(1);
    const ada = who.holders[0];
    expect(ada).toMatchObject({
      membershipId: investor.membershipId,
      displayName: "Ada Lovelace",
      capabilities: ["view"],
    });
    expect(
      ada?.via.map(
        (v) =>
          `${v.subject.kind}:${v.subject.label}:${v.decisive ? "D" : "-"}${v.inherited ? "i" : ""}`,
      ),
    ).toEqual(["membership:Ada Lovelace:D", "group:Board:Di", "group:Board:-i", "group:Board:-i"]);
    const explain = await json<{
      decision: { allowed: boolean; reason: string };
      rules: unknown[];
    }>(
      await request(
        "acme",
        `/api/v1/access/resources/folder/${SUBFOLDER.id}/explain?membershipId=${investor.membershipId}&path=${SUBFOLDER.path}`,
        { cookie: legal.cookie },
      ),
    );
    expect(explain.decision).toMatchObject({ allowed: true, reason: "granted" });
    expect(explain.rules).toHaveLength(3);
  });

  it("gates by NDA version: pending until the attestation exists", async () => {
    const policy = await request("acme", "/api/v1/access/policies", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        kind: "nda",
        target: { kind: "group", id: boardId },
        config: { version: "v2" },
      }),
    });
    expect(policy.status).toBe(200);
    const gated = await waitFor(async () => {
      const d = await running.container.authz.check(
        { workspaceId: acmeId, membershipId: investor.membershipId },
        DOC,
        "view",
        { authLevel: 1 },
      );
      return d.reason === "gated" ? d : undefined;
    });
    // The policy above carries a legacy `{ version }` config and no `documentId`, which is the
    // backward-compatibility arm D4 requires a test for. `detail` carries all three keys
    // (contract §10 A2): `stamp` is what the evaluator compares against, `version` is kept so the
    // web app's `gateLabel()` keeps working, and `documentId` is null because a legacy config
    // names no document. Assert the three exactly — a widened assertion would not notice one going
    // missing, and each of the three has a named consumer.
    expect(gated.pendingGates).toEqual([
      {
        kind: "nda",
        detail: { stamp: "nda:v2", version: "v2", documentId: null },
        source: `group:${boardId}`,
      },
    ]);
    const policies = await json<{ policies: { id: string }[] }>(
      await request("acme", "/api/v1/access/policies", { cookie: legal.cookie }),
    );
    const del = await request("acme", `/api/v1/access/policies/${policies.policies[0]?.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(200);
    await waitFor(async () => {
      const d = await running.container.authz.check(
        { workspaceId: acmeId, membershipId: investor.membershipId },
        DOC,
        "view",
      );
      return d.allowed ? d : undefined;
    });
  });

  it("group membership changes flow through: removing Ada from Board drops the folder", async () => {
    const put = await request("acme", `/api/v1/access/people/${investor.membershipId}/groups`, {
      method: "PUT",
      cookie: admin.cookie,
      body: JSON.stringify({ groupIds: [seedId] }),
    });
    expect(put.status).toBe(200);
    expect(await json(put)).toEqual({ added: [seedId], removed: [boardId] });
    const my = await waitFor(async () => {
      const r = await json<{ resources: { id: string }[] }>(
        await request("acme", "/api/v1/access/my", { cookie: investor.cookie }),
      );
      return r.resources.length === 1 ? r : undefined;
    });
    expect(my.resources[0]?.id).toBe(DOC.id);
    const detail = await json<{
      group: { memberCount: number };
      members: { membershipId: string }[];
    }>(await request("acme", `/api/v1/access/groups/${seedId}`, { cookie: legal.cookie }));
    expect(detail.group.memberCount).toBe(1);
    expect(detail.members[0]?.membershipId).toBe(investor.membershipId);
  });

  it("CSV dry run validates rows; import invites the good ones through the job", async () => {
    const csv = [
      "email,name,firm,groups,expires_at,note",
      'grace@investor.test,"Hopper, Grace",Compilers Inc,Board;Seed investors,,',
      "ada@investor.test,Ada,,,,",
      "bad-email,,,,,",
      "linus@investor.test,Linus,,Nope,,",
      "grace@investor.test,Again,,,,",
      "ken@investor.test,Ken,,,2027-01-01,Via CSV",
    ].join("\n");
    const dry = await request("acme", "/api/v1/access/invites/csv/dry-run", {
      method: "POST",
      cookie: admin.cookie,
      body: JSON.stringify({ csv, groupIds: [] }),
    });
    expect(dry.status).toBe(200);
    const r = await json<{
      rows: { line: number; status: string; reason?: string; groupIds: string[] }[];
      summary: Record<string, number>;
    }>(dry);
    expect(r.summary).toEqual({ ok: 2, skipped: 2, error: 2 });
    expect(r.rows.map((x) => [x.line, x.status, x.reason ?? ""])).toEqual([
      [2, "ok", ""],
      [3, "skipped", "already_member"],
      [4, "error", "invalid_email"],
      [5, "error", "unknown_group:Nope"],
      [6, "skipped", "duplicate_in_file"],
      [7, "ok", ""],
    ]);
    expect(r.rows[0]?.groupIds).toEqual([boardId, seedId]);

    const before = mailer.sent.length;
    const imp = await request("acme", "/api/v1/access/invites/csv/import", {
      method: "POST",
      cookie: admin.cookie,
      body: JSON.stringify({ csv, groupIds: [] }),
    });
    expect(imp.status).toBe(200);
    const { id } = await json<{ id: string; status: string }>(imp);
    const done = await waitFor(async () => {
      const s = await json<{
        status: string;
        invited: number;
        skipped: number;
        failed: number;
        rows: { status: string }[];
      }>(
        await request("acme", `/api/v1/access/invites/csv/imports/${id}`, { cookie: legal.cookie }),
      );
      return s.status === "done" ? s : undefined;
    }, 30_000);
    expect(done).toMatchObject({ invited: 2, skipped: 4, failed: 0 });
    expect(mailer.sent.length).toBe(before + 2);
    const grace = await signIn("acme", "grace@investor.test");
    const person = await json<{
      person: { groups: { name: string }[]; profile: Record<string, unknown> };
    }>(
      await request("acme", `/api/v1/access/people/${grace.membershipId}`, {
        cookie: legal.cookie,
      }),
    );
    expect(person.person.groups.map((g) => g.name).sort()).toEqual(["Board", "Seed investors"]);
    expect(person.person.profile).toMatchObject({
      displayName: "Hopper, Grace",
      firm: "Compilers Inc",
    });
  });

  it("revokes Ada: sessions die, grants and group rows are revoked, delegates cascade, audit + outbox written", async () => {
    const res = await request("acme", `/api/v1/access/people/${investor.membershipId}/revoke`, {
      method: "POST",
      cookie: admin.cookie,
      body: JSON.stringify({ reason: "left the fund" }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      membershipIds: [investor.membershipId],
      sessionsRevoked: 1,
      grantsRevoked: 1,
    });
    expect((await request("acme", "/api/v1/me", { cookie: investor.cookie })).status).toBe(401);
    const gone = await request("acme", "/api/v1/auth/otp/start", {
      method: "POST",
      body: JSON.stringify({ email: "ada@investor.test" }),
    });
    expect(gone.status).toBe(200); // anti-enumeration: same answer, but no eligible login
    const people = await json<{ items: { membershipId: string; status: string }[] }>(
      await request("acme", "/api/v1/access/people?status=revoked", { cookie: legal.cookie }),
    );
    expect(people.items.map((p) => p.membershipId)).toContain(investor.membershipId);
    const grants = await json<{ grants: unknown[] }>(
      await request("acme", `/api/v1/access/grants?resourceKind=folder&resourceId=${DOC.id}`, {
        cookie: legal.cookie,
      }),
    );
    expect(grants.grants).toHaveLength(0);
    // The test pool is the superuser: it reads the chain without a tenant context.
    const chain = (
      await pg.pool.query<{ action: string }>(
        "SELECT action FROM audit.event WHERE workspace_id = $1 AND subject_membership_id = $2 ORDER BY seq",
        [acmeId, investor.membershipId],
      )
    ).rows.map((r) => r.action);
    expect(chain).toContain("membership.revoked");
    expect(chain).toContain("group.member_removed");
  });

  it("self-revocation and revoking the last owner are refused; deleting a group revokes its grants", async () => {
    const self = await request("acme", `/api/v1/access/people/${admin.membershipId}/revoke`, {
      method: "POST",
      cookie: admin.cookie,
      body: JSON.stringify({}),
    });
    expect(self.status).toBe(400);
    const lastOwner = await request("acme", `/api/v1/access/people/${owner.membershipId}/revoke`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({}),
    });
    expect(lastOwner.status).toBe(400);
    const del = await request("acme", `/api/v1/access/groups/${boardId}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(200);
    expect(await json(del)).toMatchObject({ grants: 3 });
    const groups = await json<{ groups: { name: string }[] }>(
      await request("acme", "/api/v1/access/groups", { cookie: legal.cookie }),
    );
    expect(groups.groups.map((g) => g.name)).toEqual(["Seed investors"]);
  });

  it("settings: owner changes invite expiry (fresh session) and the next invite honours it", async () => {
    const patch = await request("acme", "/api/v1/access/settings", {
      method: "PATCH",
      cookie: owner.cookie,
      body: JSON.stringify({ inviteExpiryDays: 3 }),
    });
    expect(patch.status).toBe(200);
    expect(await json(patch)).toMatchObject({ inviteExpiryDays: 3, requireMfaForExternal: false });
    const inv = await request("acme", "/api/v1/access/invites", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ invites: [{ email: "later@investor.test" }] }),
    });
    const created = await json<{ created: { expiresAt: string; createdAt: string }[] }>(inv);
    const days =
      (new Date(created.created[0]?.expiresAt ?? 0).getTime() -
        new Date(created.created[0]?.createdAt ?? 0).getTime()) /
      86_400_000;
    expect(Math.round(days)).toBe(3);
  });
});

describe("cross-tenant replay fuzz", () => {
  it("every id-bearing access route answers 404 for another tenant's ids", async () => {
    // Globex fixtures the Acme owner will try to reach.
    const g = await json<{ id: string }>(
      await request("globex", "/api/v1/access/groups", {
        method: "POST",
        cookie: globexOwner.cookie,
        body: JSON.stringify({ name: "Globex board" }),
      }),
    );
    const inv = await json<{ created: { id: string }[] }>(
      await request("globex", "/api/v1/access/invites", {
        method: "POST",
        cookie: globexOwner.cookie,
        body: JSON.stringify({ invites: [{ email: "hank@investor.test" }] }),
      }),
    );
    const grant = await json<{ grants: { id: string }[] }>(
      await request("globex", "/api/v1/access/grants", {
        method: "POST",
        cookie: globexOwner.cookie,
        body: JSON.stringify({
          subject: { kind: "group", id: g.id },
          resource: GLOBEX_FOLDER,
          capabilities: ["view"],
        }),
      }),
    );
    const pol = await json<{ id: string }>(
      await request("globex", "/api/v1/access/policies", {
        method: "POST",
        cookie: globexOwner.cookie,
        body: JSON.stringify({
          kind: "nda",
          target: { kind: "workspace" },
          config: { version: "v1" },
        }),
      }),
    );
    const ids: Record<string, string> = {
      "/access/people/{id}": globexOwner.membershipId,
      "/access/groups/{id}": g.id,
      "/access/invites/{id}": inv.created[0]?.id ?? "",
      "/access/grants/{id}": grant.grants[0]?.id ?? "",
      "/access/policies/{id}": pol.id,
      "/access/invites/csv/imports/{id}": randomUUID(),
    };
    // A real session of the other tenant's owner (E2.7 member-sessions routes): a guessable
    // session id from somebody else's workspace must read exactly like an unknown one.
    const globexSessions = await json<{ sessions: { id: string }[] }>(
      await request("globex", "/api/v1/me/sessions", { cookie: globexOwner.cookie }),
    );
    const globexSessionId = globexSessions.sessions[0]?.id ?? randomUUID();
    const doc = JSON.parse(await (await request("acme", "/api/v1/openapi.json")).text()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const bodyFor = (method: string, path: string): unknown => {
      if (path.endsWith("/revoke")) return { reason: "fuzz" };
      if (path.endsWith("/view-as")) return { reason: "fuzz replay" };
      if (path.endsWith("/members")) return { membershipIds: [globexOwner.membershipId] };
      if (path.endsWith("/delegates") && method === "POST")
        return { email: "fuzz@example.test", scope: "all" };
      if (path.endsWith("/groups") && method === "PUT") return { groupIds: [g.id] };
      if (path.startsWith("/access/groups/") && method === "PATCH") return { name: "Renamed" };
      if (method === "PATCH") return { profile: { x: 1 } };
      return {};
    };
    const tried: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      if (!path.startsWith("/access/") || !path.includes("{")) continue;
      for (const method of Object.keys(item)) {
        let concrete = path;
        for (const [tpl, id] of Object.entries(ids))
          if (path.startsWith(tpl)) concrete = path.replace(tpl, tpl.replace("{id}", id));
        concrete = concrete
          .replace("{membershipId}", globexOwner.membershipId)
          .replace("{sessionId}", globexSessionId)
          .replace("{delegateId}", randomUUID())
          .replace("{kind}", "folder")
          .replace("{id}", FOLDER.id);
        const query = path.includes("/explain") ? `?membershipId=${globexOwner.membershipId}` : "";
        const m = method.toUpperCase();
        const res = await request("acme", `/api/v1${concrete}${query}`, {
          method: m,
          cookie: owner.cookie,
          ...(m === "GET" ? {} : { body: JSON.stringify(bodyFor(m, path)) }),
        });
        tried.push(`${m} ${concrete}`);
        if (path.startsWith("/access/resources/")) {
          // Resource routes are keyed by (kind, id): another tenant's resource id just has no holders.
          expect(res.status, `${m} ${path}`).toBe(200);
          const body = await json<{ holders?: unknown[]; decision?: { reason: string } }>(res);
          if (body.holders) expect(body.holders).toEqual([]);
          if (body.decision) expect(body.decision.reason).toBe("not_member");
        } else {
          expect(res.status, `${m} ${path}`).toBe(404);
        }
      }
    }
    expect(tried.length).toBeGreaterThanOrEqual(12);
    // And Globex's owner still sees their own rows.
    expect(
      (await request("globex", `/api/v1/access/groups/${g.id}`, { cookie: globexOwner.cookie }))
        .status,
    ).toBe(200);
  });
});

describe("grant and gate targets must exist in this workspace (P1-03)", () => {
  let groupId = "";
  const post = (path: string, body: unknown) =>
    request("acme", `/api/v1/access/${path}`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify(body),
    });
  /** The error body without the per-request id, so two refusals can be compared whole. */
  const refusal = async (res: Response) => {
    const body = await json<{ error: Record<string, unknown> }>(res);
    const { requestId: _drop, ...rest } = body.error;
    return { status: res.status, ...rest };
  };
  const grantOn = (resource: unknown) =>
    post("grants", { subject: { kind: "group", id: groupId }, resource, capabilities: ["view"] });

  it("sets up a group to grant to", async () => {
    const g = await post("groups", { name: "P1-03 probe" });
    expect(g.status).toBe(200);
    groupId = (await json<{ id: string }>(g)).id;
  });

  it("refuses a grant on another tenant's folder exactly as on a folder that never existed", async () => {
    const foreign = await refusal(await grantOn(GLOBEX_FOLDER));
    const unknown = await refusal(
      await grantOn({ kind: "folder", id: randomUUID(), path: GLOBEX_FOLDER.path }),
    );
    expect(foreign).toEqual({
      status: 404,
      code: "not_found",
      message: "no such resource",
      reason: "unknown_resource",
    });
    // Same status, same body: the answer is no oracle for another workspace's ids.
    expect(unknown).toEqual(foreign);
    // Nothing was written.
    const listed = await json<{ grants: unknown[] }>(
      await request(
        "acme",
        `/api/v1/access/grants?resourceKind=folder&resourceId=${GLOBEX_FOLDER.id}`,
        { cookie: owner.cookie },
      ),
    );
    expect(listed.grants).toEqual([]);
  });

  it("refuses a real folder filed under another path, and a kind no module owns", async () => {
    const wrongPath = await grantOn({ ...FOLDER, path: "root.elsewhere" });
    expect(await refusal(wrongPath)).toMatchObject({
      status: 400,
      reason: "resource_path_mismatch",
    });
    const kind = await grantOn({ kind: "spaceship", id: randomUUID() });
    expect(await refusal(kind)).toMatchObject({ status: 400, code: "unsupported" });
    // The right path, or none, is still fine.
    expect((await grantOn(FOLDER)).status).toBe(200);
    expect((await grantOn({ kind: "folder", id: SUBFOLDER.id })).status).toBe(200);
  });

  it("refuses a gate on a foreign or unknown resource, and an NDA gate naming a foreign document", async () => {
    const onForeign = await refusal(
      await post("policies", {
        kind: "nda",
        target: { kind: "resource", resource: GLOBEX_FOLDER },
        config: { version: "v1" },
      }),
    );
    const onUnknown = await refusal(
      await post("policies", {
        kind: "nda",
        target: { kind: "resource", resource: { kind: "folder", id: randomUUID() } },
        config: { version: "v1" },
      }),
    );
    expect(onForeign).toMatchObject({ status: 404, reason: "unknown_resource" });
    expect(onUnknown).toEqual(onForeign);

    const foreignNda = await refusal(
      await post("policies", {
        kind: "nda",
        target: { kind: "resource", resource: FOLDER },
        config: { documentId: globexNdaId },
      }),
    );
    const unknownNda = await refusal(
      await post("policies", {
        kind: "nda",
        target: { kind: "resource", resource: FOLDER },
        config: { documentId: randomUUID() },
      }),
    );
    expect(foreignNda).toMatchObject({ status: 404, reason: "unknown_resource" });
    expect(unknownNda).toEqual(foreignNda);

    // A gate on a foreign group or member is refused like the grant subject beside it.
    const foreignGroup = await post("policies", {
      kind: "nda",
      target: { kind: "membership", id: globexOwner.membershipId },
      config: { version: "v1" },
    });
    expect(foreignGroup.status).toBe(404);

    // None of them was written.
    const live = await json<{ policies: { config: { documentId?: string } }[] }>(
      await request("acme", "/api/v1/access/policies", { cookie: owner.cookie }),
    );
    expect(live.policies.some((p) => p.config.documentId === globexNdaId)).toBe(false);
  });
});

describe("invitation grants are re-derived at acceptance (E3.2)", () => {
  const MOVING = { kind: "folder", id: randomUUID(), path: "root.e32move" };
  const DEST = { kind: "folder", id: randomUUID(), path: "root.e32dest" };
  const TAMPERED = { kind: "folder", id: randomUUID(), path: "root.e32tamper" };
  const DOOMED = { kind: "folder", id: randomUUID(), path: "root.e32doomed" };

  const inviteWith = async (email: string, resource: unknown) => {
    const res = await request("acme", "/api/v1/access/invites", {
      method: "POST",
      cookie: admin.cookie,
      body: JSON.stringify({
        invites: [{ email }],
        grants: [{ resource, capabilities: ["view"] }],
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<{ created: { id: string }[] }>(res);
    return body.created[0]?.id ?? "";
  };

  /** Superuser SQL: the moves and tampering happen behind the service's back. */
  const sql = async <T>(query: string, params: unknown[] = []): Promise<T[]> =>
    (await running.container.db.pool.query(query, params)).rows as T[];

  const grantPathsOf = (membershipId: string) =>
    sql<{ resource_id: string; resource_path: string | null }>(
      `SELECT resource_id::text, resource_path::text FROM core.access_grant
        WHERE subject_kind = 'membership' AND subject_id = $1::uuid AND revoked_at IS NULL`,
      [membershipId],
    );

  it("sets up the folders", async () => {
    await seedFolders(acmeId, [MOVING, DEST, TAMPERED, DOOMED]);
  });

  it("a folder moved after the invitation is granted at its new path", async () => {
    await inviteWith("mover@investor.test", MOVING);
    // The folder moves under DEST before the invitation is accepted.
    await sql(
      `UPDATE dataroom.folder SET path = 'root.e32dest.e32move',
              parent_id = (SELECT id FROM dataroom.folder WHERE id = $2::uuid)
        WHERE id = $1::uuid`,
      [MOVING.id, DEST.id],
    );
    const mover = await signIn("acme", "mover@investor.test");
    expect(await grantPathsOf(mover.membershipId)).toEqual([
      { resource_id: MOVING.id, resource_path: "root.e32dest.e32move" },
    ]);
  });

  it("a pending invitation hand-edited to an over-broad path gets the folder's own path", async () => {
    const inviteId = await inviteWith("tampered@investor.test", TAMPERED);
    // The root: a grant carrying it would cover the whole data room.
    await sql(
      `UPDATE core.invite SET grants = jsonb_set(grants, '{0,resource,path}', '"root"')
        WHERE id = $1::uuid`,
      [inviteId],
    );
    const stored = await sql<{ path: string }>(
      "SELECT grants->0->'resource'->>'path' AS path FROM core.invite WHERE id = $1::uuid",
      [inviteId],
    );
    expect(stored).toEqual([{ path: "root" }]);
    const tampered = await signIn("acme", "tampered@investor.test");
    expect(await grantPathsOf(tampered.membershipId)).toEqual([
      { resource_id: TAMPERED.id, resource_path: "root.e32tamper" },
    ]);
  });

  it("a folder deleted before acceptance is skipped and counted as dropped", async () => {
    await inviteWith("dropped@investor.test", DOOMED);
    await sql("UPDATE dataroom.folder SET deleted_at = now() WHERE id = $1::uuid", [DOOMED.id]);
    const dropped = await signIn("acme", "dropped@investor.test");
    expect(await grantPathsOf(dropped.membershipId)).toEqual([]);
    const audit = await sql<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE workspace_id = $1::uuid AND action = 'membership.created'
          AND subject_membership_id = $2::uuid`,
      [acmeId, dropped.membershipId],
    );
    expect(audit[0]?.meta).toMatchObject({ grants: 0, grantsDropped: 1 });
  });

  it("refuses to invite a delegate: a plain invitation names no principal", async () => {
    const res = await request("acme", "/api/v1/access/invites", {
      method: "POST",
      cookie: admin.cookie,
      body: JSON.stringify({
        invites: [{ email: "deleg@investor.test" }],
        kind: "external",
        role: "delegate",
      }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string; reason?: string } }>(res);
    expect(body.error).toMatchObject({ code: "validation_failed", reason: "delegate_invite" });
    const pending = await sql<{ n: number }>(
      "SELECT count(*)::int AS n FROM core.invite WHERE email = 'deleg@investor.test'",
    );
    expect(pending[0]?.n).toBe(0);
  });
});
