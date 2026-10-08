import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELEGATE_SCOPE_KINDS, DELEGATE_SCOPE_MODULES } from "@fundroom/authz";
import { loadConfig } from "@fundroom/config";
import {
  createWorkspace,
  systemContext,
  type TenantContext,
  updateOfferingStatus,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { MembershipRepo, provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import dataRoomModule from "@fundroom/module-data-room";
import { ModuleEnablementRepo } from "@fundroom/module-kit";
import updatesModule from "@fundroom/module-updates";
import { makeOwner } from "@fundroom/portability";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { INVITE_DAILY_CAP } from "./routes/access.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Delegates end to end (E3.2, design/05 §4.2, §5, §7). One principal investor, three delegates —
 * `data_room`, `updates` and `all` — and every evaluation path asked the same questions: the
 * TypeScript evaluator (`authz.check`, `/access/my`), row-level security (`core.has_access` through
 * the data room's policies, the updates audience function) and search. Then the refusals, the
 * principal's gates, and what happens to a delegate when its principal is suspended, expires or is
 * revoked: it loses everything at once, with no rebuild in between.
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
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", `acme.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://acme.${CANON}`);
  return running.app.request(`http://acme.${CANON}${path}`, { ...init, headers });
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

async function signIn(email: string): Promise<Actor> {
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
  const body = await json<{ session: { userId: string }; membership: { id: string } | null }>(
    verify,
  );
  return {
    cookie: cookiesOf(verify),
    membershipId: body.membership?.id ?? "",
    userId: body.session.userId,
  };
}

async function stepUpToMfa(cookie: string): Promise<string> {
  const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie });
  expect(enrol.status).toBe(200);
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request("/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

async function staff(email: string, role: "owner" | "editor"): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, {
    workspaceId: acmeId,
    userId: user.userId,
    kind: "staff",
    role,
    source: "test",
  });
  const actor = await signIn(email);
  if (role === "owner") actor.cookie = await stepUpToMfa(actor.cookie);
  return actor;
}

async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  return running.container.db.withTenant(
    systemContext(acmeId),
    async (tx) => (await tx.execute(query)).rows as T[],
  );
}

/** Raw SQL setup does not bump the ACL version; a service would. */
async function bump(): Promise<void> {
  await sql(`UPDATE core.workspace SET acl_version = acl_version + 1 WHERE id = '${acmeId}'`);
  running.container.authz.invalidate(acmeId);
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Reads as the member would, under their own RLS context (not the superuser pool). */
async function asMember<T = Record<string, unknown>>(a: Actor, query: string): Promise<T[]> {
  const ctx: TenantContext = {
    workspaceId: acmeId,
    actorKind: "external",
    membershipId: a.membershipId,
    userId: a.userId,
  };
  return running.container.db.withTenant(ctx, async (tx) => (await tx.execute(query)).rows as T[]);
}

const check = (a: Actor, resource: { kind: string; id: string; path?: string }) =>
  running.container.authz.check(
    { workspaceId: acmeId, membershipId: a.membershipId },
    resource,
    "view",
  );

async function folderIdsVisibleTo(a: Actor): Promise<string[]> {
  const rows = await asMember<{ id: string }>(
    a,
    "SELECT id FROM dataroom.folder WHERE parent_id IS NOT NULL ORDER BY path",
  );
  return rows.map((r) => r.id);
}

async function postIdsVisibleTo(a: Actor): Promise<string[]> {
  const rows = await asMember<{ id: string }>(a, "SELECT id FROM updates.post ORDER BY title");
  return rows.map((r) => r.id);
}

async function searchTitles(a: Actor, q: string): Promise<string[]> {
  const res = await request(`/api/v1/search?q=${q}`, { cookie: a.cookie });
  expect(res.status).toBe(200);
  return (await json<{ hits: { title: string }[] }>(res)).hits.map((h) => h.title);
}

async function addMine(a: Actor, email: string, scope: string): Promise<Response> {
  return request("/api/v1/access/my/delegates", {
    method: "POST",
    cookie: a.cookie,
    body: JSON.stringify({ email, scope, displayName: email.split("@")[0] }),
  });
}

async function patchSettings(body: Record<string, unknown>): Promise<void> {
  const res = await request("/api/v1/access/settings", {
    method: "PATCH",
    cookie: owner.cookie,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

/** A fresh external investor, invited by the owner and signed in. */
async function investor(email: string, displayName: string): Promise<Actor> {
  const res = await request("/api/v1/access/invites", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({ kind: "external", role: "investor", invites: [{ email, displayName }] }),
  });
  expect(res.status).toBe(200);
  return signIn(email);
}

/** What is left of the workspace's shared daily invitation cap (not spending any). */
async function inviteCapLeft(): Promise<number> {
  return (await running.container.rateLimiter.peek(`invite:ws:${acmeId}`, INVITE_DAILY_CAP))
    .remaining;
}

async function myDelegates(a: Actor): Promise<{ kind: string; id: string; email: string }[]> {
  return (
    await json<{ delegates: { kind: string; id: string; email: string }[] }>(
      await request("/api/v1/access/my/delegates", { cookie: a.cookie }),
    )
  ).delegates;
}

let acmeId: string;
let owner: Actor;
let editor: Actor;
let pat: Actor; // the principal
let dan: Actor; // data_room
let uma: Actor; // updates
let al: Actor; // all
let boardId: string;
const DR = { kind: "folder", id: randomUUID(), path: "root.dr" };
const BOARD_FOLDER = { kind: "folder", id: randomUUID(), path: "root.board" };
const DOC = { kind: "document", id: randomUUID() };
const POST_BOARD = { kind: "post", id: randomUUID() };
const POST_ALL = { kind: "post", id: randomUUID() };
/** A post the principal holds a direct grant on (an `updates`-kind rule). */
const POST_GRANTED = { kind: "post", id: randomUUID() };

async function seed(): Promise<void> {
  await sql(`INSERT INTO dataroom.folder (workspace_id, name, path)
             VALUES ('${acmeId}', 'Root', 'root') ON CONFLICT DO NOTHING`);
  for (const f of [DR, BOARD_FOLDER]) {
    await sql(`INSERT INTO dataroom.folder (id, workspace_id, parent_id, name, path)
               SELECT '${f.id}', '${acmeId}', p.id, '${f.path}', '${f.path}' FROM dataroom.folder p
                WHERE p.workspace_id = '${acmeId}' AND p.parent_id IS NULL LIMIT 1`);
  }
  await sql(`INSERT INTO dataroom.document (id, workspace_id, folder_id, folder_path, title)
             VALUES ('${DOC.id}', '${acmeId}', '${DR.id}', '${DR.path}', 'Model')`);
  const group = await sql<{ id: string }>(
    `INSERT INTO core."group" (workspace_id, name) VALUES ('${acmeId}', 'Board') RETURNING id`,
  );
  boardId = group[0]?.id as string;
  await sql(`INSERT INTO core.group_member (workspace_id, group_id, membership_id)
             VALUES ('${acmeId}', '${boardId}', '${pat.membershipId}')`);
  const grants = [
    ["membership", pat.membershipId, DR],
    ["group", boardId, BOARD_FOLDER],
    ["membership", pat.membershipId, POST_GRANTED],
  ] as const;
  for (const [kind, id, r] of grants) {
    await sql(`INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, resource_kind, resource_id, resource_path, capability)
               VALUES ('${acmeId}', '${kind}', '${id}', '${r.kind}', '${r.id}', ${"path" in r ? `'${r.path}'` : "NULL"}, 'view')`);
  }
  const posts = [
    [POST_BOARD, "board-post", `{"kind":"groups","groupIds":["${boardId}"]}`],
    [POST_ALL, "all-post", `{"kind":"all"}`],
  ] as const;
  for (const [p, slug, audience] of posts) {
    const version = randomUUID();
    await sql(`INSERT INTO updates.post (id, workspace_id, slug, title, state, doc, audience, sent_at)
               VALUES ('${p.id}', '${acmeId}', '${slug}', '${slug}', 'sent', '{}', '${audience}', now())`);
    await sql(`INSERT INTO updates.post_version (id, workspace_id, post_id, version_no, title, doc, audience)
               VALUES ('${version}', '${acmeId}', '${p.id}', 1, '${slug}', '{}', '${audience}')`);
    await sql(`UPDATE updates.post SET published_version_id = '${version}' WHERE id = '${p.id}'`);
  }
  // Search entries, one per ACL arm and module: a data-room resource, a Board-only update, and a
  // Board-only data-room entry (the `groups` arm keyed on the entry's module).
  const entries = [
    [
      "data-room",
      "folder",
      DR.id,
      "alphaword",
      "resource",
      "NULL",
      `'folder', '${DR.id}', '${DR.path}'`,
    ],
    [
      "updates",
      "post",
      POST_BOARD.id,
      "bravoword",
      "groups",
      `ARRAY['${boardId}']::uuid[]`,
      "NULL, NULL, NULL",
    ],
    [
      "data-room",
      "folder",
      BOARD_FOLDER.id,
      "charlieword",
      "groups",
      `ARRAY['${boardId}']::uuid[]`,
      "NULL, NULL, NULL",
    ],
  ] as const;
  for (const [module, kind, ref, title, acl, groups, res] of entries) {
    await sql(`INSERT INTO core.search_entry (workspace_id, module, kind, ref_id, title, href, acl_kind, acl_groups, acl_resource_kind, acl_resource_id, acl_path, source_updated_at)
               VALUES ('${acmeId}', '${module}', '${kind}', '${ref}', '${title}', '/x', '${acl}', ${groups}, ${res}, now())`);
  }
  await bump();
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
  owner = await staff("owner@acme.test", "owner");
  editor = await staff("editor@acme.test", "editor");
  const invited = await request("/api/v1/access/invites", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      kind: "external",
      role: "investor",
      invites: [{ email: "pat@fund.test", displayName: "Pat Principal", firm: "Fund LP" }],
    }),
  });
  expect(invited.status).toBe(200);
  pat = await signIn("pat@fund.test");
  expect(pat.membershipId).not.toBe("");
  await seed();
}, 180_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("scope kinds", () => {
  it("are the data-room and updates manifests' resource kinds", () => {
    expect(DELEGATE_SCOPE_MODULES).toEqual({ data_room: "data-room", updates: "updates" });
    expect([...DELEGATE_SCOPE_KINDS.data_room].sort()).toEqual(
      Object.keys(dataRoomModule.resourceKinds ?? {}).sort(),
    );
    expect([...DELEGATE_SCOPE_KINDS.updates].sort()).toEqual(
      Object.keys(updatesModule.resourceKinds ?? {}).sort(),
    );
    expect(dataRoomModule.id).toBe("data-room");
    expect(updatesModule.id).toBe("updates");
  });
});

describe("adding delegates", () => {
  it("refuses self-service while the workspace does not allow delegates", async () => {
    const res = await addMine(pat, "dan@helper.test", "data_room");
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("delegates_disabled");
    await patchSettings({ allowDelegates: true });
  });

  it("lets the principal add three, each an invitation acting for them; notifies them and staff", async () => {
    for (const [email, scope] of [
      ["dan@helper.test", "data_room"],
      ["uma@helper.test", "updates"],
      ["al@helper.test", "all"],
    ] as const) {
      const res = await addMine(pat, email, scope);
      expect(res.status).toBe(202);
      expect(await json(res)).toEqual({ status: "sent" });
    }
    // F5: the invitation names the investor the invitee would act for.
    const invitation = mailer.sent.find(
      (m) => m.to === "dan@helper.test" && m.text.includes("delegate"),
    );
    expect(invitation?.text).toContain(
      "Pat Principal invited you to act as their delegate for Acme.",
    );
    const list = await json<{
      delegates: { kind: string; email: string; scope: string; status: string }[];
      limit: number;
      selfService: boolean;
    }>(await request("/api/v1/access/my/delegates", { cookie: pat.cookie }));
    expect(list.limit).toBe(3);
    expect(list.selfService).toBe(true);
    expect(list.delegates.map((d) => [d.kind, d.email, d.scope, d.status]).sort()).toEqual([
      ["invite", "al@helper.test", "all", "pending"],
      ["invite", "dan@helper.test", "data_room", "pending"],
      ["invite", "uma@helper.test", "updates", "pending"],
    ]);
    const invites = await sql<{ role: string; principal: string; scope: string }>(
      `SELECT role::text AS role, principal_membership_id AS principal, delegate_scope AS scope
         FROM core.invite WHERE email = 'dan@helper.test'`,
    );
    expect(invites).toEqual([
      { role: "delegate", principal: pat.membershipId, scope: "data_room" },
    ]);
    const audit = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event
        WHERE action = 'membership.delegate_added' AND subject_membership_id = '${pat.membershipId}'`,
    );
    expect(audit[0]?.n).toBe(3);
    // design/05 §7: the principal and the admins are both told.
    const told = await waitFor(async () => {
      const r = await pg.pool.query<{ membership_id: string }>(
        `SELECT DISTINCT membership_id FROM notify.notification
          WHERE workspace_id = $1 AND event_type = 'membership.delegate_added'`,
        [acmeId],
      );
      const ids = r.rows.map((x) => x.membership_id);
      return ids.includes(pat.membershipId) && ids.includes(owner.membershipId) ? ids : undefined;
    });
    expect(told).not.toContain(editor.membershipId); // editors do not hold access.manage
  });

  it("accepting makes a delegate membership naming the principal and its scope", async () => {
    dan = await signIn("dan@helper.test");
    uma = await signIn("uma@helper.test");
    al = await signIn("al@helper.test");
    const rows = await sql<{ id: string; role: string; principal: string; scope: string }>(
      `SELECT id, role::text AS role, principal_membership_id AS principal, delegate_scope AS scope
         FROM core.membership WHERE id IN ('${dan.membershipId}', '${uma.membershipId}', '${al.membershipId}')
        ORDER BY delegate_scope`,
    );
    expect(rows.map((r) => [r.role, r.principal, r.scope])).toEqual([
      ["delegate", pat.membershipId, "all"],
      ["delegate", pat.membershipId, "data_room"],
      ["delegate", pat.membershipId, "updates"],
    ]);
    // Display: "Dan (for Fund LP — Pat Principal)" — the People API carries the principal.
    const person = await json<{
      person: { delegateScope: string; principal: { displayName: string; firm: string } };
    }>(await request(`/api/v1/access/people/${dan.membershipId}`, { cookie: owner.cookie }));
    expect(person.person.delegateScope).toBe("data_room");
    expect(person.person.principal).toMatchObject({
      displayName: "Pat Principal",
      firm: "Fund LP",
    });
  });

  it("refuses: a delegate adding delegates, staff, the limit, members and pending addresses", async () => {
    const byDelegate = await addMine(dan, "x@helper.test", "all");
    expect(byDelegate.status).toBe(403);
    expect(await json(byDelegate)).toMatchObject({
      error: { code: "forbidden", reason: "delegate_cannot_delegate" },
    });
    const byStaff = await addMine(editor, "x@helper.test", "all");
    expect(byStaff.status).toBe(403);
    const full = await addMine(pat, "x@helper.test", "all");
    expect(full.status).toBe(409);
    expect((await json<{ error: { code: string } }>(full)).error.code).toBe(
      "delegate_limit_reached",
    );
    await patchSettings({ maxDelegatesPerPrincipal: 6 });
    // F1: an address that is already a member is not refused — it is skipped, with the answer
    // every address gets, so the route is not a membership oracle.
    const member = await addMine(pat, "editor@acme.test", "all");
    expect(member.status).toBe(202);
    expect(await json(member)).toEqual({ status: "sent" });
    expect(
      await sql(
        `SELECT id FROM core.invite WHERE email = 'editor@acme.test' AND role = 'delegate'`,
      ),
    ).toEqual([]);
    // An admin's pending invitation to an address cannot be hijacked into a delegate invitation.
    const inv = await request("/api/v1/access/invites", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ invites: [{ email: "pending@fund.test" }] }),
    });
    expect(inv.status).toBe(200);
    const pending = await addMine(pat, "pending@fund.test", "all");
    expect(pending.status).toBe(202);
    const stillInvestor = await sql<{ role: string }>(
      `SELECT role::text AS role FROM core.invite WHERE email = 'pending@fund.test' AND status = 'pending'`,
    );
    expect(stillInvestor).toEqual([{ role: "investor" }]);
    const skipped = await sql<{ reason: string }>(
      `SELECT meta->>'reason' AS reason FROM audit.event
        WHERE action = 'membership.delegate_add_skipped' AND actor_membership_id = '${pat.membershipId}'
        ORDER BY occurred_at`,
    );
    expect(skipped.map((r) => r.reason)).toEqual(["member", "pending_invite"]);
    // The admin path keeps its precise answer.
    const adminMember = await request(`/api/v1/access/people/${pat.membershipId}/delegates`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ email: "editor@acme.test", scope: "all" }),
    });
    expect(adminMember.status).toBe(409);
    expect((await json<{ error: { code: string } }>(adminMember)).error.code).toBe("conflict");
    // The plain invitation route still refuses role=delegate (it names no principal).
    const plain = await request("/api/v1/access/invites", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ role: "delegate", invites: [{ email: "y@helper.test" }] }),
    });
    expect(plain.status).toBe(400);
    // Admin path: not an investor → 400; nobody → 404.
    const forStaff = await request(`/api/v1/access/people/${editor.membershipId}/delegates`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ email: "z@helper.test", scope: "all" }),
    });
    expect(forStaff.status).toBe(400);
    expect(await json(forStaff)).toMatchObject({ error: { reason: "principal_not_investor" } });
    const forNobody = await request(`/api/v1/access/people/${randomUUID()}/delegates`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ email: "z@helper.test", scope: "all" }),
    });
    expect(forNobody.status).toBe(404);
    // The editor holds access.read but not access.manage.
    const editorAdds = await request(`/api/v1/access/people/${pat.membershipId}/delegates`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ email: "z@helper.test", scope: "all" }),
    });
    expect(editorAdds.status).toBe(403);
  });
});

describe("scope isolation, on every evaluation path", () => {
  it("TypeScript evaluator: a delegate gets exactly its scope of the principal's grants", async () => {
    const expected: [Actor, boolean, boolean, boolean][] = [
      // actor, data-room folder, board folder (via group), post the principal holds a grant on
      [pat, true, true, true],
      [dan, true, true, false],
      [uma, false, false, true],
      [al, true, true, true],
    ];
    for (const [a, dr, board, post] of expected) {
      expect((await check(a, DR)).allowed).toBe(dr);
      expect((await check(a, BOARD_FOLDER)).allowed).toBe(board);
      expect((await check(a, POST_GRANTED)).allowed).toBe(post);
      // A document inside the folder follows the folder (ADR-0034).
      expect((await check(a, { ...DOC, path: DR.path })).allowed).toBe(dr);
    }
    const my = await json<{ resources: { kind: string; id: string }[] }>(
      await request("/api/v1/access/my?kind=folder", { cookie: dan.cookie }),
    );
    expect(my.resources.map((r) => r.id).sort()).toEqual([DR.id, BOARD_FOLDER.id].sort());
    const umaMy = await json<{ resources: unknown[] }>(
      await request("/api/v1/access/my?kind=folder", { cookie: uma.cookie }),
    );
    expect(umaMy.resources).toEqual([]);
  });

  it("row-level security (core.has_access): folders and documents follow the same scope", async () => {
    expect(await folderIdsVisibleTo(pat)).toEqual([BOARD_FOLDER.id, DR.id]);
    expect(await folderIdsVisibleTo(dan)).toEqual([BOARD_FOLDER.id, DR.id]);
    expect(await folderIdsVisibleTo(al)).toEqual([BOARD_FOLDER.id, DR.id]);
    expect(await folderIdsVisibleTo(uma)).toEqual([]);
    const docs = async (a: Actor) =>
      (await asMember<{ id: string }>(a, "SELECT id FROM dataroom.document")).map((r) => r.id);
    expect(await docs(dan)).toEqual([DOC.id]);
    expect(await docs(uma)).toEqual([]);
  });

  it("update audiences: the principal's groups count for `updates` and `all`, not `data_room`", async () => {
    const both = [POST_ALL.id, POST_BOARD.id];
    expect((await postIdsVisibleTo(pat)).sort()).toEqual(both.sort());
    expect((await postIdsVisibleTo(uma)).sort()).toEqual(both.sort());
    expect((await postIdsVisibleTo(al)).sort()).toEqual(both.sort());
    // F3: an update to every member is "updates" content — not a `data_room` delegate's to read.
    expect(await postIdsVisibleTo(dan)).toEqual([]);
    // The TypeScript reader agrees (the archive route).
    const archive = async (a: Actor) =>
      (
        await json<{ posts: { slug: string }[] }>(
          await request("/api/v1/updates/archive", { cookie: a.cookie }),
        )
      ).posts
        .map((p) => p.slug)
        .sort();
    expect(await archive(uma)).toEqual(["all-post", "board-post"]);
    expect(await archive(dan)).toEqual([]);
  });

  it("search: resource and group entries follow the scope and the entry's module", async () => {
    expect(await searchTitles(pat, "alphaword")).toEqual(["alphaword"]);
    expect(await searchTitles(dan, "alphaword")).toEqual(["alphaword"]);
    expect(await searchTitles(uma, "alphaword")).toEqual([]);
    expect(await searchTitles(dan, "bravoword")).toEqual([]);
    expect(await searchTitles(uma, "bravoword")).toEqual(["bravoword"]);
    expect(await searchTitles(al, "bravoword")).toEqual(["bravoword"]);
    expect(await searchTitles(dan, "charlieword")).toEqual(["charlieword"]);
    expect(await searchTitles(uma, "charlieword")).toEqual([]);
  });
});

describe("member-wide content follows the scope", () => {
  let roundId: string;

  beforeAll(async () => {
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, async (tx) => {
      await new ModuleEnablementRepo(ctx, tx).set("round", true);
      await updateOfferingStatus(tx, acmeId, "506b" as never);
    });
    running.container.enablement.invalidate(acmeId);
    running.container.resolver.invalidate();
    const r = await sql<{ id: string }>(
      `INSERT INTO round.round (workspace_id, name, stage, instrument_kind, status, target_amount, currency, opened_at)
       VALUES ('${acmeId}', 'Seed', 'seed', 'safe', 'open', 1000000, 'USD', now()) RETURNING id`,
    );
    roundId = r[0]?.id as string;
    await sql(`INSERT INTO metrics.definition (workspace_id, key, name, unit, audience)
               VALUES ('${acmeId}', 'mrr', 'MRR', 'count', '{"kind":"all"}')`);
    for (const [module, title] of [
      ["updates", "quokka"],
      ["round", "narwhal"],
    ] as const) {
      await sql(`INSERT INTO core.search_entry (workspace_id, module, kind, ref_id, title, href, acl_kind, source_updated_at)
                 VALUES ('${acmeId}', '${module}', 'x', '${randomUUID()}', '${title}', '/x', 'members', now())`);
    }
  });

  it("the round: `all` delegates read it, narrower ones get 404, and no delegate writes to it", async () => {
    const rounds = async (a: Actor) =>
      (await asMember<{ id: string }>(a, "SELECT id FROM round.round")).map((r) => r.id);
    expect(await rounds(pat)).toEqual([roundId]);
    expect(await rounds(al)).toEqual([roundId]);
    expect(await rounds(dan)).toEqual([]);
    expect(await rounds(uma)).toEqual([]);
    const terms = await asMember(dan, "SELECT id FROM round.terms");
    expect(terms).toEqual([]);

    expect((await request("/api/v1/round/current", { cookie: pat.cookie })).status).toBe(200);
    expect((await request("/api/v1/round/current", { cookie: al.cookie })).status).toBe(200);
    for (const a of [dan, uma]) {
      for (const path of ["/api/v1/round/current", "/api/v1/round/current/interest"]) {
        const res = await request(path, { cookie: a.cookie });
        expect(res.status, path).toBe(404);
      }
    }
    // Writes: 403 for every delegate, `all` included — interest is the investor's own statement.
    for (const a of [al, dan]) {
      const res = await request("/api/v1/round/current/interest", {
        method: "POST",
        cookie: a.cookie,
        body: JSON.stringify({ amount: "50000", subject: "individual" }),
      });
      expect(res.status).toBe(403);
      expect(await json(res)).toMatchObject({
        error: { code: "forbidden", reason: "delegate_read_only" },
      });
    }
    const withdraw = await request(`/api/v1/round/current/interest/${randomUUID()}/withdraw`, {
      method: "POST",
      cookie: al.cookie,
    });
    expect(withdraw.status).toBe(403);
    const evidence = await request(`/api/v1/round/verifications/${randomUUID()}/evidence`, {
      method: "PUT",
      cookie: al.cookie,
      headers: { "content-type": "application/pdf" },
      body: "%PDF-1.4",
    });
    expect(evidence.status).toBe(403);
  });

  it("metrics: an `all`-audience KPI is read by investors and `all` delegates only", async () => {
    const kpis = async (a: Actor) =>
      (await asMember<{ key: string }>(a, "SELECT key::text AS key FROM metrics.definition")).map(
        (r) => r.key,
      );
    expect(await kpis(pat)).toEqual(["mrr"]);
    expect(await kpis(al)).toEqual(["mrr"]);
    expect(await kpis(dan)).toEqual([]);
    expect(await kpis(uma)).toEqual([]);
  });

  it("search: `members` entries follow the entry's module", async () => {
    expect(await searchTitles(pat, "quokka")).toEqual(["quokka"]);
    expect(await searchTitles(uma, "quokka")).toEqual(["quokka"]);
    expect(await searchTitles(al, "quokka")).toEqual(["quokka"]);
    expect(await searchTitles(dan, "quokka")).toEqual([]);
    expect(await searchTitles(pat, "narwhal")).toEqual(["narwhal"]);
    expect(await searchTitles(al, "narwhal")).toEqual(["narwhal"]);
    expect(await searchTitles(uma, "narwhal")).toEqual([]);
    expect(await searchTitles(dan, "narwhal")).toEqual([]);
  });

  it("a delegate's OWN group admits it only to a module its scope admits (round 2: search, updates)", async () => {
    const own = await sql<{ id: string }>(
      `INSERT INTO core."group" (workspace_id, name) VALUES ('${acmeId}', 'Helpers') RETURNING id`,
    );
    const ownId = own[0]?.id as string;
    await sql(`INSERT INTO core.group_member (workspace_id, group_id, membership_id)
               VALUES ('${acmeId}', '${ownId}', '${dan.membershipId}')`);
    for (const [module, title] of [
      ["updates", "wombat"],
      ["data-room", "koala"],
    ] as const) {
      await sql(`INSERT INTO core.search_entry (workspace_id, module, kind, ref_id, title, href, acl_kind, acl_groups, source_updated_at)
                 VALUES ('${acmeId}', '${module}', 'x', '${randomUUID()}', '${title}', '/x', 'groups', ARRAY['${ownId}']::uuid[], now())`);
    }
    const post = randomUUID();
    const version = randomUUID();
    const audience = `{"kind":"groups","groupIds":["${ownId}"]}`;
    await sql(`INSERT INTO updates.post (id, workspace_id, slug, title, state, doc, audience, sent_at)
               VALUES ('${post}', '${acmeId}', 'helpers-post', 'helpers-post', 'sent', '{}', '${audience}', now())`);
    await sql(`INSERT INTO updates.post_version (id, workspace_id, post_id, version_no, title, doc, audience)
               VALUES ('${version}', '${acmeId}', '${post}', 1, 'helpers-post', '{}', '${audience}')`);
    await sql(`UPDATE updates.post SET published_version_id = '${version}' WHERE id = '${post}'`);
    await bump();
    try {
      expect(await searchTitles(dan, "koala")).toEqual(["koala"]);
      expect(await searchTitles(dan, "wombat")).toEqual([]);
      expect(await postIdsVisibleTo(dan)).toEqual([]);
    } finally {
      await sql(`DELETE FROM core.search_entry WHERE title IN ('wombat', 'koala')`);
      await sql(`UPDATE core.group_member SET revoked_at = now() WHERE group_id = '${ownId}'`);
      await bump();
    }
  });

  it("content pages: member sections are `updates` content", async () => {
    const render = async (a: Actor) => {
      const res = await request("/api/v1/content/render/home", { cookie: a.cookie });
      expect(res.status).toBe(200);
      return (await json<{ sections: { key: string }[] }>(res)).sections.map((x) => x.key);
    };
    const full = await render(pat);
    expect(full.length).toBeGreaterThan(0);
    expect(await render(uma)).toEqual(full);
    expect(await render(al)).toEqual(full);
    // No public sections are allowed here, so a `data_room` delegate sees an empty page.
    expect(await render(dan)).toEqual([]);
    const pages = async (a: Actor) => (await asMember(a, "SELECT id FROM content.page")).length;
    expect(await pages(uma)).toBeGreaterThan(0);
    expect(await pages(dan)).toBe(0);
  });
});

describe("a delegate's own excludes beat everything it borrows", () => {
  const F = { kind: "folder", id: randomUUID(), path: "root.ffour" };
  const G = { kind: "folder", id: randomUUID(), path: "root.gee" };
  const X = { kind: "document", id: randomUUID(), path: "root.gee" };
  const H = { kind: "folder", id: randomUUID(), path: "root.aitch" };
  const Y = { kind: "document", id: randomUUID(), path: "root.aitch" };

  beforeAll(async () => {
    for (const f of [F, G, H]) {
      await sql(`INSERT INTO dataroom.folder (id, workspace_id, parent_id, name, path)
                 SELECT '${f.id}', '${acmeId}', p.id, '${f.path}', '${f.path}' FROM dataroom.folder p
                  WHERE p.workspace_id = '${acmeId}' AND p.parent_id IS NULL LIMIT 1`);
    }
    await sql(`INSERT INTO dataroom.document (id, workspace_id, folder_id, folder_path, title)
               VALUES ('${X.id}', '${acmeId}', '${G.id}', '${G.path}', 'X')`);
    await sql(`INSERT INTO dataroom.document (id, workspace_id, folder_id, folder_path, title)
               VALUES ('${Y.id}', '${acmeId}', '${H.id}', '${H.path}', 'Y')`);
    const grant = (
      subject: string,
      r: { kind: string; id: string; path: string },
      effect: string,
    ) =>
      sql(`INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, subject_role, resource_kind, resource_id, resource_path, capability, effect)
           VALUES ('${acmeId}', ${subject}, '${r.kind}', '${r.id}', '${r.path}', 'view', '${effect}')`);
    // Repro 1: the principal's group allows F; an admin excludes every delegate from F.
    await grant(`'group', '${boardId}', NULL`, F, "allow");
    await grant(`'role', NULL, 'delegate'`, F, "exclude");
    // Repro 2: the principal holds a direct grant on X; an admin excludes al's own membership on
    // X's folder.
    await grant(`'membership', '${pat.membershipId}', NULL`, X, "allow");
    await grant(`'membership', '${al.membershipId}', NULL`, G, "exclude");
    // Round 2: al's own allow on H does not beat the principal's exclude on Y inside it.
    await grant(`'membership', '${al.membershipId}', NULL`, H, "allow");
    await grant(`'membership', '${pat.membershipId}', NULL`, Y, "exclude");
    await sql(`INSERT INTO core.search_entry (workspace_id, module, kind, ref_id, title, href, acl_kind, acl_resource_kind, acl_resource_id, acl_path, source_updated_at)
               VALUES ('${acmeId}', 'data-room', 'document', '${X.id}', 'pangolin', '/x', 'resource', 'document', '${X.id}', '${X.path}', now())`);
    await bump();
  });

  afterAll(async () => {
    await sql(`DELETE FROM core.search_entry WHERE ref_id = '${X.id}'`);
    await sql(
      `DELETE FROM core.access_grant WHERE resource_id IN ('${F.id}', '${G.id}', '${X.id}', '${H.id}', '${Y.id}')`,
    );
    await sql(`DELETE FROM dataroom.document WHERE id IN ('${X.id}', '${Y.id}')`);
    await sql(`DELETE FROM dataroom.folder WHERE id IN ('${F.id}', '${G.id}', '${H.id}')`);
    await bump();
  });

  it("repro 1: an exclude on role:delegate beats the principal's group allow (evaluator, RLS)", async () => {
    expect((await check(pat, F)).capabilities).toContain("view");
    expect((await check(al, F)).capabilities).not.toContain("view");
    expect((await check(dan, F)).capabilities).not.toContain("view");
    expect(await folderIdsVisibleTo(pat)).toContain(F.id);
    expect(await folderIdsVisibleTo(al)).not.toContain(F.id);
    expect(await folderIdsVisibleTo(dan)).not.toContain(F.id);
  });

  it("repro 2: an exclude on the delegate's own membership beats the principal's grant below it (evaluator, RLS, search)", async () => {
    expect((await check(pat, X)).capabilities).toContain("view");
    expect((await check(al, X)).capabilities).not.toContain("view");
    // dan is not excluded: the principal's document grant still reaches it through its scope.
    expect((await check(dan, X)).capabilities).toContain("view");
    const docs = async (a: Actor) =>
      (
        await asMember<{ id: string }>(a, `SELECT id FROM dataroom.document WHERE id = '${X.id}'`)
      ).map((r) => r.id);
    expect(await docs(pat)).toEqual([X.id]);
    expect(await docs(al)).toEqual([]);
    expect(await searchTitles(pat, "pangolin")).toEqual(["pangolin"]);
    expect(await searchTitles(al, "pangolin")).toEqual([]);
  });

  it("round 2: the delegate's own allow does not beat the principal's exclude on a document inside it (evaluator, RLS)", async () => {
    expect((await check(al, H)).capabilities).toContain("view");
    expect((await check(al, Y)).capabilities).not.toContain("view");
    const docs = async (a: Actor) =>
      (
        await asMember<{ id: string }>(
          a,
          `SELECT id FROM dataroom.document WHERE id IN ('${Y.id}')`,
        )
      ).map((r) => r.id);
    expect(await docs(al)).toEqual([]);
  });
});

describe("gates are the delegate's own", () => {
  it("an NDA on the principal's group binds the delegate, and only its own signature opens it", async () => {
    await sql(`INSERT INTO core.access_policy (workspace_id, target_kind, target_id, kind, config)
               VALUES ('${acmeId}', 'group', '${boardId}', 'nda', '{"version": "v9"}')`);
    await sql(`INSERT INTO core.attestation (workspace_id, membership_id, kind, signed_at)
               VALUES ('${acmeId}', '${pat.membershipId}', 'nda:v9', now())`);
    await bump();
    expect((await check(pat, BOARD_FOLDER)).allowed).toBe(true);
    const gated = await check(al, BOARD_FOLDER);
    expect(gated.reason).toBe("gated");
    expect(gated.pendingGates.map((g) => g.kind)).toEqual(["nda"]);
    await sql(`INSERT INTO core.attestation (workspace_id, membership_id, kind, signed_at)
               VALUES ('${acmeId}', '${al.membershipId}', 'nda:v9', now())`);
    await bump();
    expect((await check(al, BOARD_FOLDER)).allowed).toBe(true);
    expect((await check(dan, BOARD_FOLDER)).reason).toBe("gated");
  });
});

describe("a delegate is only as live as its principal", () => {
  async function everythingClosed(a: Actor): Promise<void> {
    // No rebuild has run: these must hold from the membership rows alone.
    expect((await request("/api/v1/access/my", { cookie: a.cookie })).status).toBe(404);
    expect(await folderIdsVisibleTo(a)).toEqual([]);
    expect((await check(a, DR)).reason).toBe("not_member");
  }

  it("suspending the principal closes every door at once, and restoring reopens them", async () => {
    expect(await folderIdsVisibleTo(dan)).toEqual([BOARD_FOLDER.id, DR.id]);
    await sql(`UPDATE core.membership SET status = 'suspended' WHERE id = '${pat.membershipId}'`);
    running.container.authz.invalidate(acmeId);
    await everythingClosed(dan);
    await everythingClosed(al);
    // And once a rebuild does run, it materialises nothing for them.
    await bump();
    await running.container.authz.rebuild(acmeId);
    const rows = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.effective_access WHERE membership_id IN ('${dan.membershipId}', '${al.membershipId}')`,
    );
    expect(rows[0]?.n).toBe(0);
    await sql(`UPDATE core.membership SET status = 'active' WHERE id = '${pat.membershipId}'`);
    await bump();
    // Capability, not `allowed`: the Board NDA above binds dan too (on every resource).
    expect((await check(dan, DR)).capabilities).toContain("view");
    expect(await folderIdsVisibleTo(dan)).toEqual([BOARD_FOLDER.id, DR.id]);
  });

  it("the principal's expiry is the delegate's: rows carry it, and passing it closes everything", async () => {
    const soon = new Date(Date.now() + 3_600_000);
    await sql(
      `UPDATE core.membership SET expires_at = '${soon.toISOString()}' WHERE id = '${pat.membershipId}'`,
    );
    await bump();
    // Capability, not `allowed`: the Board NDA above binds dan too (on every resource).
    expect((await check(dan, DR)).capabilities).toContain("view");
    const rows = await sql<{ ms: string }>(
      `SELECT (extract(epoch FROM expires_at) * 1000)::bigint::text AS ms
         FROM core.effective_access WHERE membership_id = '${dan.membershipId}'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Number(r.ms)).toBe(soon.getTime());
    // Now it has passed — with no write that would bump the ACL version.
    await sql(
      `UPDATE core.membership SET expires_at = now() - interval '1 minute' WHERE id = '${pat.membershipId}'`,
    );
    running.container.authz.invalidate(acmeId);
    await everythingClosed(dan);
    await sql(`UPDATE core.membership SET expires_at = NULL WHERE id = '${pat.membershipId}'`);
    await bump();
    // Capability, not `allowed`: the Board NDA above binds dan too (on every resource).
    expect((await check(dan, DR)).capabilities).toContain("view");
  });

  it("a delegate invitation accepted after its principal was suspended is withdrawn, not accepted", async () => {
    const res = await addMine(pat, "late@helper.test", "all");
    expect(res.status).toBe(202);
    await sql(`UPDATE core.membership SET status = 'suspended' WHERE id = '${pat.membershipId}'`);
    const since = mailer.sent.length;
    const start = await request("/api/v1/auth/otp/start", {
      method: "POST",
      body: JSON.stringify({ email: "late@helper.test" }),
    });
    expect(start.status).toBe(200);
    const code = await awaitSignInCode(mailer, "late@helper.test", since);
    const verify = await request("/api/v1/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ email: "late@helper.test", code }),
    });
    expect(verify.status).toBe(403);
    const made = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.membership WHERE role = 'delegate' AND status <> 'revoked'
          AND principal_membership_id = '${pat.membershipId}'`,
    );
    expect(made[0]?.n).toBe(3); // dan, uma and al; late was refused
    const inv = await sql<{ status: string }>(
      `SELECT status::text AS status FROM core.invite WHERE email = 'late@helper.test'`,
    );
    expect(inv).toEqual([{ status: "revoked" }]);
    await sql(`UPDATE core.membership SET status = 'active' WHERE id = '${pat.membershipId}'`);
    await bump();
  });
});

describe("self-service adds say nothing about the address and are budgeted", () => {
  let quinn: Actor;

  beforeAll(async () => {
    quinn = await investor("quinn@fund.test", "Quinn Principal");
    // A revoked member of this workspace.
    const ex = await staff("ex@acme.test", "editor");
    await sql(
      `UPDATE core.membership SET status = 'revoked', revoked_at = now() WHERE id = '${ex.membershipId}'`,
    );
  });

  it("answers the same for a new address, a member, a revoked member and an invited address", async () => {
    // F2: a message is not the investor's to put in the company's branded email — the field does
    // not exist on this route.
    const withMessage = await request("/api/v1/access/my/delegates", {
      method: "POST",
      cookie: quinn.cookie,
      body: JSON.stringify({
        email: "fresh1@helper.test",
        scope: "all",
        message: "Urgent: wire funds to 12345",
      }),
    });
    expect(withMessage.status).toBe(400);
    const answers: [number, unknown][] = [];
    const capSpent: number[] = [];
    for (const email of [
      "fresh1@helper.test",
      "editor@acme.test",
      "ex@acme.test",
      "pending@fund.test",
    ]) {
      const before = await inviteCapLeft();
      const res = await addMine(quinn, email, "all");
      answers.push([res.status, await json(res)]);
      capSpent.push(before - (await inviteCapLeft()));
    }
    // Round 2: only the add that really sent an invitation spent the workspace's shared cap.
    expect(capSpent).toEqual([1, 0, 0, 0]);
    for (const a of answers) expect(a).toEqual([202, { status: "sent" }]);
    expect((await myDelegates(quinn)).map((d) => d.email)).toEqual(["fresh1@helper.test"]);
    const rows = await sql<{ message: string | null }>(
      `SELECT message FROM core.invite WHERE email = 'fresh1@helper.test'`,
    );
    expect(rows).toEqual([{ message: null }]);
    const mail = mailer.sent.find((m) => m.to === "fresh1@helper.test");
    expect(mail?.text).not.toContain("wire funds");
    expect(mail?.text).toContain("Quinn Principal invited you to act as their delegate for Acme.");
  });

  it("spends a daily budget of ten adds per investor, withdrawn and skipped ones included", async () => {
    // Four spent above (one sent, three skipped); six more, each withdrawn at once.
    for (let i = 2; i <= 7; i += 1) {
      const res = await addMine(quinn, `fresh${i}@helper.test`, "updates");
      expect(res.status, `add ${i}`).toBe(202);
      const invite = (await myDelegates(quinn)).find((d) => d.email === `fresh${i}@helper.test`);
      const drop = await request(`/api/v1/access/my/delegates/${invite?.id}`, {
        method: "DELETE",
        cookie: quinn.cookie,
      });
      expect(drop.status).toBe(200);
    }
    const capBefore = await inviteCapLeft();
    const over = await addMine(quinn, "fresh8@helper.test", "updates");
    expect(over.status).toBe(429);
    // The principal's budget is checked before the workspace's cap, which is left untouched.
    expect(await inviteCapLeft()).toBe(capBefore);
    expect((await json<{ error: { code: string } }>(over)).error.code).toBe("rate_limited");
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await sql(`SELECT id FROM core.invite WHERE email = 'fresh8@helper.test'`)).toEqual([]);
    // The budget is the investor's: another investor, and staff, are unaffected.
    const staffAdd = await request(`/api/v1/access/people/${quinn.membershipId}/delegates`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ email: "qd@helper.test", scope: "all" }),
    });
    expect(staffAdd.status).toBe(200);
  });

  it("promoting an investor to owner revokes its delegates and withdraws their invitations (F6)", async () => {
    const qd = await signIn("qd@helper.test");
    const before = await sql<{ role: string; status: string }>(
      `SELECT role::text AS role, status::text AS status FROM core.membership WHERE id = '${qd.membershipId}'`,
    );
    expect(before).toEqual([{ role: "delegate", status: "active" }]);
    await running.container.db.withTenant(systemContext(acmeId), (tx) =>
      makeOwner(tx, quinn.membershipId),
    );
    const after = await sql<{ status: string }>(
      `SELECT status::text AS status FROM core.membership WHERE id = '${qd.membershipId}'`,
    );
    expect(after).toEqual([{ status: "revoked" }]);
    const invites = await sql<{ status: string }>(
      `SELECT status::text AS status FROM core.invite WHERE email = 'fresh1@helper.test'`,
    );
    expect(invites).toEqual([{ status: "revoked" }]);
  });
});

describe("a principal that stops being an external investor lends nothing", () => {
  it("closes the delegate's door at once, in the middleware and in SQL, with no rebuild", async () => {
    expect(await folderIdsVisibleTo(dan)).toEqual([BOARD_FOLDER.id, DR.id]);
    await sql(
      `UPDATE core.membership SET kind = 'staff', role = 'admin' WHERE id = '${pat.membershipId}'`,
    );
    running.container.authz.invalidate(acmeId);
    try {
      expect((await request("/api/v1/access/my", { cookie: dan.cookie })).status).toBe(404);
      expect(await folderIdsVisibleTo(dan)).toEqual([]);
      expect(await postIdsVisibleTo(uma)).toEqual([]);
    } finally {
      await sql(
        `UPDATE core.membership SET kind = 'external', role = 'investor' WHERE id = '${pat.membershipId}'`,
      );
      // Reopening does rest on the materialised rows, and a rebuild may have run while pat was
      // staff: dan's request finds the table behind an earlier test's API bump, or that bump's
      // `acl.changed` arrives through the outbox relay and queue (seconds later on a slow runner).
      // Either drops dan's rows, and a bare version bump rebuilds nothing for the SQL read below.
      await bump();
      await running.container.authz.rebuild(acmeId);
    }
    expect(await folderIdsVisibleTo(dan)).toEqual([BOARD_FOLDER.id, DR.id]);
  });
});

describe("resending a delegate invitation re-checks its principal and the limit", () => {
  it("refuses while the principal is not live or at the limit, and names the principal when it resends", async () => {
    const add = await request(`/api/v1/access/people/${pat.membershipId}/delegates`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ email: "resend@helper.test", scope: "updates" }),
    });
    expect(add.status).toBe(200);
    const id = (await json<{ delegates: { id: string; email: string }[] }>(add)).delegates.find(
      (d) => d.email === "resend@helper.test",
    )?.id as string;
    const resend = () =>
      request(`/api/v1/access/invites/${id}/resend`, { method: "POST", cookie: owner.cookie });

    await sql(`UPDATE core.membership SET status = 'suspended' WHERE id = '${pat.membershipId}'`);
    const suspended = await resend();
    expect(suspended.status).toBe(400);
    expect(await json(suspended)).toMatchObject({ error: { reason: "principal_not_investor" } });
    await sql(`UPDATE core.membership SET status = 'active' WHERE id = '${pat.membershipId}'`);
    await bump();

    // dan, uma and al are live: a limit of three leaves no room for this invitation.
    await patchSettings({ maxDelegatesPerPrincipal: 3 });
    const full = await resend();
    expect(full.status).toBe(409);
    expect((await json<{ error: { code: string } }>(full)).error.code).toBe(
      "delegate_limit_reached",
    );
    await patchSettings({ maxDelegatesPerPrincipal: 6 });

    const since = mailer.sent.length;
    expect((await resend()).status).toBe(200);
    const mail = mailer.sent.slice(since).find((m) => m.to === "resend@helper.test");
    expect(mail?.text).toContain("Pat Principal invited you to act as their delegate for Acme.");
    const drop = await request(`/api/v1/access/invites/${id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(drop.status).toBe(200);
  });
});

describe("a share link beats a pending delegate invitation, and only that", () => {
  let token: string;

  async function linkSignIn(email: string): Promise<void> {
    const since = mailer.sent.length;
    const start = await request(`/api/v1/links/${token}/start`, {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    expect(start.status).toBe(200);
    const code = await awaitSignInCode(mailer, email, since);
    const verify = await request(`/api/v1/links/${token}/verify`, {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    expect(verify.status).toBe(200);
  }

  async function membershipOf(email: string) {
    return sql<{ role: string; principal: string | null; source: string }>(
      `SELECT m.role::text AS role, m.principal_membership_id AS principal, m.source
         FROM core.membership m JOIN core.user_identity ui ON ui.user_id = m.user_id
        WHERE ui.identifier = '${email}' AND m.workspace_id = '${acmeId}'`,
    );
  }

  beforeAll(async () => {
    const minted = await request("/api/v1/links", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        label: "helpers",
        policy: { domains: ["helper.test"], emails: [], forceWatermark: false },
        grants: [{ resource: DR, capabilities: ["view"] }],
      }),
    });
    expect(minted.status).toBe(200);
    token = (await json<{ token: string }>(minted)).token;
  });

  it("signing in through the company's link makes an investor and withdraws the delegate invitation", async () => {
    const add = await addMine(pat, "linked@helper.test", "all");
    expect(add.status).toBe(202);
    await linkSignIn("linked@helper.test");
    const made = await membershipOf("linked@helper.test");
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ role: "investor", principal: null });
    expect(made[0]?.source.startsWith("link:")).toBe(true);
    const invite = await sql<{ id: string; status: string }>(
      `SELECT id, status::text AS status FROM core.invite WHERE email = 'linked@helper.test'`,
    );
    expect(invite.map((i) => i.status)).toEqual(["revoked"]);
    const audit = await sql<{ reason: string }>(
      `SELECT meta->>'reason' AS reason FROM audit.event
        WHERE action = 'invite.revoked' AND resource_id = '${invite[0]?.id}'`,
    );
    expect(audit).toEqual([{ reason: "link_sign_in" }]);
    // It no longer counts against the investor's limit.
    expect((await myDelegates(pat)).map((d) => d.email)).not.toContain("linked@helper.test");
  });

  it("any other pending invitation keeps its precedence over the link: it is accepted", async () => {
    const inv = await request("/api/v1/access/invites", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({
        kind: "external",
        role: "investor",
        invites: [{ email: "staffinvited@helper.test", displayName: "Invited By Staff" }],
      }),
    });
    expect(inv.status).toBe(200);
    await linkSignIn("staffinvited@helper.test");
    const invite = await sql<{ status: string }>(
      `SELECT status::text AS status FROM core.invite WHERE email = 'staffinvited@helper.test'`,
    );
    expect(invite).toEqual([{ status: "accepted" }]);
    const made = await membershipOf("staffinvited@helper.test");
    expect(made).toHaveLength(1);
    expect(made[0]?.source.startsWith("link:")).toBe(false);
  });
});

describe("the owner lock", () => {
  it("`lockOwners` does not block an insert that merely references an owner row", async () => {
    const ctx = systemContext(acmeId);
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = running.container.db.withTenant(ctx, async (tx) => {
      await new MembershipRepo(ctx, tx).lockOwners();
      locked();
      await held;
    });
    await isLocked;
    try {
      // The foreign-key check takes FOR KEY SHARE on the owner's row: FOR UPDATE would block it
      // (and a lock_timeout turns that into an error); FOR NO KEY UPDATE does not.
      await running.container.db.withTenant(ctx, async (tx) => {
        await tx.execute("SET LOCAL lock_timeout = '2s'");
        await tx.execute(`INSERT INTO core.group_member (workspace_id, group_id, membership_id)
                          VALUES ('${acmeId}', '${boardId}', '${owner.membershipId}')`);
      });
    } finally {
      release();
      await holder;
    }
    await sql(
      `DELETE FROM core.group_member WHERE group_id = '${boardId}' AND membership_id = '${owner.membershipId}'`,
    );
    await bump();
  });
});

describe("removing delegates", () => {
  it("the principal removes a pending invitation and a live delegate; staff can too", async () => {
    const add = await addMine(pat, "gone@helper.test", "updates");
    expect(add.status).toBe(202);
    const list = await json<{ delegates: { kind: string; id: string; email: string }[] }>(
      await request("/api/v1/access/my/delegates", { cookie: pat.cookie }),
    );
    const invite = list.delegates.find((d) => d.email === "gone@helper.test");
    expect(invite?.kind).toBe("invite");
    const drop = await request(`/api/v1/access/my/delegates/${invite?.id}`, {
      method: "DELETE",
      cookie: pat.cookie,
    });
    expect(drop.status).toBe(200);
    // Someone else's delegate is not the caller's to remove.
    const foreign = await request(`/api/v1/access/my/delegates/${uma.membershipId}`, {
      method: "DELETE",
      cookie: dan.cookie,
    });
    expect(foreign.status).toBe(404);
    const removeUma = await request(`/api/v1/access/my/delegates/${uma.membershipId}`, {
      method: "DELETE",
      cookie: pat.cookie,
    });
    expect(removeUma.status).toBe(200);
    expect((await request("/api/v1/me", { cookie: uma.cookie })).status).toBe(401);
    const staffAdd = await request(`/api/v1/access/people/${pat.membershipId}/delegates`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ email: "admin-added@helper.test", scope: "data_room" }),
    });
    expect(staffAdd.status).toBe(200);
    const staffList = await json<{ delegates: { id: string; email: string }[] }>(staffAdd);
    const added = staffList.delegates.find((d) => d.email === "admin-added@helper.test");
    const staffDrop = await request(
      `/api/v1/access/people/${pat.membershipId}/delegates/${added?.id}`,
      { method: "DELETE", cookie: owner.cookie },
    );
    expect(staffDrop.status).toBe(200);
    const removed = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event
        WHERE action = 'membership.delegate_removed' AND subject_membership_id = '${pat.membershipId}'`,
    );
    expect(removed[0]?.n).toBe(3);
  });

  it("revoking the principal revokes its delegates and withdraws their pending invitations", async () => {
    const add = await request(`/api/v1/access/people/${pat.membershipId}/delegates`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ email: "waiting@helper.test", scope: "all" }),
    });
    expect(add.status).toBe(200);
    const res = await request(`/api/v1/access/people/${pat.membershipId}/revoke`, {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ reason: "left" }),
    });
    expect(res.status).toBe(200);
    const body = await json<{ membershipIds: string[] }>(res);
    expect(body.membershipIds.sort()).toEqual(
      [pat.membershipId, dan.membershipId, al.membershipId].sort(),
    );
    const invite = await sql<{ status: string }>(
      `SELECT status::text AS status FROM core.invite WHERE email = 'waiting@helper.test'`,
    );
    expect(invite).toEqual([{ status: "revoked" }]);
    for (const a of [dan, al])
      expect((await request("/api/v1/me", { cookie: a.cookie })).status).toBe(401);
    expect(await folderIdsVisibleTo(dan)).toEqual([]);
  });
});
