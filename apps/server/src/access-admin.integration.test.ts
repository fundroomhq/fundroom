import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConfig, loadConfig } from "@fundroom/config";
import { createWorkspace, platformContext, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWorkspaceRestore } from "./cli-commands/workspace-restore.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";
import {
  purgeDeletedWorkspaces,
  restoreWorkspace,
  WorkspaceLifecycleError,
} from "./workspace/lifecycle.js";

/*
 * Access administration end to end (E2.7 package B1), multi-tenant: the access review report
 * (flags, accreditation divergence, CSV with the formula guard, completion digest), member
 * sessions scoped to this workspace, the danger zone (ownership transfer, revoke-all, delete with
 * legal hold and typed confirmation), the operator restore and the purge job's crypto-shred.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let config: AppConfig;

interface Actor {
  cookie: string;
  membershipId: string;
  userId: string;
}
interface ErrorBody {
  error: { code: string; reason?: string };
}

async function request(
  slug: string,
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
  return running.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
}

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");

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
  // One authenticated request pins the session to the workspace (`last_workspace_id`).
  const cookie = cookiesOf(verify);
  expect((await request(slug, "/api/v1/me", { cookie })).status).toBe(200);
  return { cookie, membershipId: body.membership?.id ?? "", userId: body.session.userId };
}

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

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "editor" | "investor",
  userId?: string,
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const uid =
    userId ?? (await provisionUser(deps, { email, displayName: email.split("@")[0] })).userId;
  await provisionMembership(deps, { workspaceId, userId: uid, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (role === "owner" || role === "admin") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

async function rows<T>(query: string, workspaceId: string): Promise<T[]> {
  const ctx = systemContext(workspaceId);
  return running.container.db.withTenant(ctx, async (tx) => (await tx.execute(query)).rows as T[]);
}

async function hostRows<T>(query: string): Promise<T[]> {
  return running.container.db.withHost(async (tx) => (await tx.execute(query)).rows as T[]);
}

async function auditCount(action: string, workspaceId: string): Promise<number> {
  const r = await rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = '${workspaceId}'::uuid AND action = '${action}'`,
    workspaceId,
  );
  return r[0]?.n ?? 0;
}

/** Ages (or refreshes) the step-up clock of every live session of the actor. */
async function authAge(actor: Actor, ageMs: number): Promise<void> {
  await hostRows(
    `UPDATE core.session SET auth_time = now() - interval '${ageMs} milliseconds'
       WHERE user_id = '${actor.userId}'::uuid AND revoked_at IS NULL RETURNING id`,
  );
}

async function setLegalHold(workspaceId: string, on: boolean): Promise<void> {
  await hostRows(
    `UPDATE core.workspace SET settings = jsonb_set(settings, '{legal}',
       coalesce(settings->'legal', '{}'::jsonb) || '{"legalHold": ${on}}'::jsonb)
     WHERE id = '${workspaceId}'::uuid RETURNING id`,
  );
}

const post = (slug: string, path: string, cookie: string, body: unknown = {}) =>
  request(slug, path, { method: "POST", cookie, body: JSON.stringify(body) });
const del = (slug: string, path: string, cookie: string, body?: unknown) =>
  request(slug, path, {
    method: "DELETE",
    cookie,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

let revId: string;
let otherId: string;
let zoneId: string;
let heldId: string;
let owner: Actor;
let admin: Actor;
let editor: Actor;
let investor: Actor;
let stale: Actor;
/** One person, external in both `rev` and `other`, signed in to each. */
let sharedRev: Actor;
let sharedOther: Actor;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  config = loadConfig({
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
  const db = running.container.db;
  revId = (await createWorkspace(db, { slug: "rev", name: "Review Co" })).id;
  otherId = (await createWorkspace(db, { slug: "other", name: "Other Co" })).id;
  zoneId = (await createWorkspace(db, { slug: "zone", name: "Danger Co" })).id;
  heldId = (await createWorkspace(db, { slug: "held", name: "Held Co" })).id;
  owner = await member("rev", revId, "owner@rev.test", "staff", "owner");
  admin = await member("rev", revId, "admin@rev.test", "staff", "admin");
  editor = await member("rev", revId, "editor@rev.test", "staff", "editor");
  investor = await member("rev", revId, "inv@rev.test", "external", "investor");
  stale = await member("rev", revId, "stale@rev.test", "external", "investor");
  sharedRev = await member("rev", revId, "shared@both.test", "external", "investor");
  sharedOther = await member(
    "other",
    otherId,
    "shared@both.test",
    "external",
    "investor",
    sharedRev.userId,
  );
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("RBAC", () => {
  const readRoutes = (id: string) => [
    ["GET", "/api/v1/access/review"],
    ["GET", "/api/v1/access/reviews"],
    ["GET", `/api/v1/access/people/${id}/sessions`],
  ];
  const writeRoutes = (id: string, sessionId: string) =>
    [
      ["POST", "/api/v1/access/reviews", {}],
      ["DELETE", `/api/v1/access/people/${id}/sessions/${sessionId}`, undefined],
      ["POST", `/api/v1/access/people/${id}/sessions/revoke`, {}],
      // A confirmation that is not the slug: if a guard ever let one of these through, nothing
      // would be transferred, revoked or deleted and the later tests would still stand.
      ["POST", "/api/v1/access/ownership/transfer", { toMembershipId: id, confirm: "nope" }],
      ["POST", "/api/v1/access/sessions/revoke-all", { confirm: "nope", includeStaff: false }],
      ["DELETE", "/api/v1/workspace", { confirm: "nope" }],
    ] as const;
  const call = (actor: Actor, [method, path, body]: readonly [string, string, unknown?]) =>
    request("rev", path, {
      method,
      cookie: actor.cookie,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const fakeSession = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";

  it("an editor gets 403 and an investor 404 on every route", async () => {
    for (const r of [
      ...readRoutes(stale.membershipId),
      ...writeRoutes(stale.membershipId, fakeSession),
    ]) {
      const ed = await call(editor, r as never);
      expect(ed.status, `editor ${r[0]} ${r[1]}`).toBe(403);
      const inv = await call(investor, r as never);
      expect(inv.status, `investor ${r[0]} ${r[1]}`).toBe(404);
    }
  });

  it("an admin cannot transfer ownership, revoke everyone or delete the workspace", async () => {
    for (const r of writeRoutes(editor.membershipId, fakeSession).slice(3)) {
      const res = await call(admin, r as never);
      expect(res.status, `${r[0]} ${r[1]}`).toBe(403);
      expect((await json<ErrorBody>(res)).error.code).toBe("forbidden");
    }
  });

  it("every mutation needs step-up; reads do not", async () => {
    await authAge(owner, 20 * 60_000);
    try {
      for (const r of writeRoutes(stale.membershipId, fakeSession)) {
        const res = await call(owner, r as never);
        expect(res.status, `${r[0]} ${r[1]}`).toBe(403);
        expect((await json<ErrorBody>(res)).error.code).toBe("step_up_required");
      }
      for (const r of readRoutes(stale.membershipId))
        expect((await call(owner, r as never)).status, r[1]).toBe(200);
    } finally {
      await authAge(owner, 0);
    }
  });
});

describe("access review report", () => {
  beforeAll(async () => {
    // `stale`: last active 120 days ago everywhere.
    await rows(
      `UPDATE core.membership SET last_seen_at = now() - interval '120 days' WHERE id = '${stale.membershipId}'::uuid`,
      revId,
    );
    await hostRows(
      `UPDATE core.session SET last_seen_at = now() - interval '120 days' WHERE user_id = '${stale.userId}'::uuid RETURNING id`,
    );
    // `investor`: self-certified 100 days ago (expires 12 months after), under a 90-day gate.
    await rows(
      `INSERT INTO core.attestation (workspace_id, membership_id, kind, signed_at, expires_at)
       VALUES ('${revId}', '${investor.membershipId}', 'accredited', now() - interval '100 days',
               now() - interval '100 days' + interval '12 months')`,
      revId,
    );
    await rows(
      `INSERT INTO core.access_policy (workspace_id, target_kind, kind, config)
       VALUES ('${revId}', 'workspace', 'accredited', '{"maxAgeDays": 90}')`,
      revId,
    );
    await rows(
      `UPDATE core.membership SET expires_at = now() + interval '3 days' WHERE id = '${sharedRev.membershipId}'::uuid`,
      revId,
    );
    await hostRows(
      `UPDATE core."user" AS u SET display_name = '=HYPERLINK("http://evil","x")' WHERE id = '${investor.userId}'::uuid RETURNING id`,
    );
  });

  interface Row {
    membershipId: string;
    name: string | null;
    flags: string[];
    activeSessions: number;
    accreditation: { gateMaxAgeDays: number | null; diverges: boolean } | null;
  }
  const rowOf = (members: Row[], id: string) => members.find((m) => m.membershipId === id);

  it("lists every member with flags, sessions and the accreditation divergence", async () => {
    const res = await request("rev", "/api/v1/access/review", { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await json<{
      members: Row[];
      summary: { members: number; flagged: number; byFlag: Record<string, number> };
      lastReview: unknown;
      nextReviewDueAt: string | null;
    }>(res);
    expect(body.summary.members).toBe(6);
    expect(body.lastReview).toBeNull();
    // Never reviewed: due 90 days after the workspace was created, the same instant the
    // `access-review.overdue` job reminds at (E3.2).
    const created = await rows<{ at: string }>(
      `SELECT to_json(created_at)#>>'{}' AS at FROM core.workspace WHERE id = '${revId}'::uuid`,
      revId,
    );
    expect(body.nextReviewDueAt).not.toBeNull();
    expect(Date.parse(body.nextReviewDueAt ?? "") - Date.parse(created[0]?.at ?? "")).toBe(
      90 * 86_400_000,
    );

    expect(rowOf(body.members, stale.membershipId)?.flags).toContain("stale");
    const inv = rowOf(body.members, investor.membershipId);
    expect(inv?.accreditation).toMatchObject({ gateMaxAgeDays: 90, diverges: true });
    expect(inv?.flags).toEqual(
      expect.arrayContaining(["accreditation_lapsed", "accreditation_diverges"]),
    );
    expect(rowOf(body.members, sharedRev.membershipId)?.flags).toContain("expiring");
    // Only the session serving *this* workspace counts, not the one serving `other`.
    expect(rowOf(body.members, sharedRev.membershipId)?.activeSessions).toBe(1);
    expect(rowOf(body.members, owner.membershipId)?.flags).toEqual([]);
    expect(body.summary.byFlag["accreditation_diverges"]).toBe(1);
  });

  it("downloads the same rows as CSV with formula cells neutralised, and audits it", async () => {
    const before = await auditCount("access.review_exported", revId);
    const res = await request("rev", "/api/v1/access/review?format=csv", { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const text = await res.text();
    const lines = text.replace(/^﻿/u, "").trimEnd().split("\r\n");
    expect(lines[0]?.startsWith("membership_id,name,email,")).toBe(true);
    expect(lines).toHaveLength(7);
    const line = lines.find((l) => l.startsWith(investor.membershipId)) ?? "";
    expect(line).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(await auditCount("access.review_exported", revId)).toBe(before + 1);
  });

  it("completing a review stores the report digest and sets the next due date", async () => {
    const res = await post("rev", "/api/v1/access/reviews", admin.cookie, { note: "Q3" });
    expect(res.status).toBe(201);
    const rec = await json<{
      id: string;
      reportSha256: string;
      memberCount: number;
      completedAt: string;
    }>(res);
    expect(rec.reportSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(rec.memberCount).toBe(6);
    const stored = await rows<{ sha: string }>(
      `SELECT report_sha256 AS sha FROM core.access_review WHERE id = '${rec.id}'::uuid`,
      revId,
    );
    expect(stored[0]?.sha).toBe(rec.reportSha256);
    expect(await auditCount("access.review_completed", revId)).toBe(1);

    const list = await json<{ items: { id: string; note: string }[] }>(
      await request("rev", "/api/v1/access/reviews", { cookie: admin.cookie }),
    );
    expect(list.items.map((i) => i.id)).toEqual([rec.id]);
    expect(list.items[0]?.note).toBe("Q3");
    const report = await json<{ lastReview: { id: string }; nextReviewDueAt: string }>(
      await request("rev", "/api/v1/access/review", { cookie: admin.cookie }),
    );
    expect(report.lastReview.id).toBe(rec.id);
    expect(Date.parse(report.nextReviewDueAt) - Date.parse(rec.completedAt)).toBe(90 * 86_400_000);
  });
});

describe("access review attestation (evidence)", () => {
  interface Report {
    generatedAt: string;
    reportSha256: string;
    summary: { members: number };
  }
  const load = async () =>
    json<Report>(await request("rev", "/api/v1/access/review", { cookie: admin.cookie }));

  it("completing with the shown report's digest stores exactly that report, downloadable", async () => {
    const shown = await load();
    expect(shown.reportSha256).toMatch(/^[0-9a-f]{64}$/u);
    // Things that move without anybody's access changing must not change the digest: a session
    // touched after the report was generated, and a brand-new sign-in after it.
    await hostRows(
      `UPDATE core.session SET last_seen_at = now() WHERE user_id = '${admin.userId}'::uuid AND revoked_at IS NULL RETURNING id`,
    );
    await signIn("rev", "inv@rev.test");

    const res = await post("rev", "/api/v1/access/reviews", admin.cookie, {
      note: "attested",
      reportSha256: shown.reportSha256,
      generatedAt: shown.generatedAt,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const rec = await json<{ id: string; reportSha256: string }>(res);
    expect(rec.reportSha256).toBe(shown.reportSha256);

    const dl = await request("rev", `/api/v1/access/reviews/${rec.id}/report`, {
      cookie: admin.cookie,
    });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.headers.get("x-content-sha256")).toBe(rec.reportSha256);
    const body = await dl.text();
    expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(rec.reportSha256);
    const evidence = JSON.parse(body) as Record<string, unknown> & { members: unknown[] };
    expect(Object.keys(evidence).sort()).toEqual([
      "generatedAt",
      "members",
      "schemaVersion",
      "summary",
    ]);
    expect(evidence["generatedAt"]).toBe(shown.generatedAt);
    expect(evidence.members).toHaveLength(shown.summary.members);
    const [stored] = await rows<{ v: number }>(
      `SELECT report_schema_version AS v FROM core.access_review WHERE id = '${rec.id}'::uuid`,
      revId,
    );
    expect(stored?.v).toBe(1);
    // Another workspace's review is not there; nor is a made-up one.
    expect(
      (
        await request("rev", "/api/v1/access/reviews/0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a/report", {
          cookie: admin.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it("a report that changed since it was shown is report_changed, and nothing is stored", async () => {
    const shown = await load();
    const before = await auditCount("access.review_completed", revId);
    await rows(
      `UPDATE core.membership SET expires_at = now() + interval '2 days' WHERE id = '${stale.membershipId}'::uuid`,
      revId,
    );
    try {
      for (const body of [
        { reportSha256: shown.reportSha256, generatedAt: shown.generatedAt },
        { reportSha256: "0".repeat(64), generatedAt: shown.generatedAt },
        {
          reportSha256: shown.reportSha256,
          generatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        },
      ]) {
        const res = await post("rev", "/api/v1/access/reviews", admin.cookie, body);
        expect(res.status).toBe(409);
        expect(await json<ErrorBody>(res)).toMatchObject({
          error: { code: "conflict", reason: "report_changed" },
        });
      }
      expect(await auditCount("access.review_completed", revId)).toBe(before);
      // Reloading and attesting to the new report works.
      const fresh = await load();
      expect(fresh.reportSha256).not.toBe(shown.reportSha256);
      const ok = await post("rev", "/api/v1/access/reviews", admin.cookie, {
        reportSha256: fresh.reportSha256,
        generatedAt: fresh.generatedAt,
      });
      expect(ok.status).toBe(201);
    } finally {
      await rows(
        `UPDATE core.membership SET expires_at = NULL WHERE id = '${stale.membershipId}'::uuid`,
        revId,
      );
    }
  });

  it("the digest and its timestamp go together", async () => {
    const shown = await load();
    const res = await post("rev", "/api/v1/access/reviews", admin.cookie, {
      reportSha256: shown.reportSha256,
    });
    expect(res.status).toBe(400);
  });
});

describe("member sessions", () => {
  interface Sessions {
    sessions: { id: string; device: string; authLevel: number }[];
  }

  it("lists only sessions serving this workspace; another workspace's session is 404", async () => {
    const [otherSession] = await hostRows<{ id: string }>(
      `SELECT id FROM core.session WHERE user_id = '${sharedRev.userId}'::uuid
         AND last_workspace_id = '${otherId}'::uuid AND revoked_at IS NULL`,
    );
    expect(otherSession).toBeDefined();
    const list = await json<Sessions>(
      await request("rev", `/api/v1/access/people/${sharedRev.membershipId}/sessions`, {
        cookie: admin.cookie,
      }),
    );
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions.map((s) => s.id)).not.toContain(otherSession?.id);

    const res = await del(
      "rev",
      `/api/v1/access/people/${sharedRev.membershipId}/sessions/${otherSession?.id}`,
      admin.cookie,
    );
    expect(res.status).toBe(404);
    // Still signed in to `other`.
    expect((await request("other", "/api/v1/me", { cookie: sharedOther.cookie })).status).toBe(200);
  });

  it("revokes one session of an external member", async () => {
    const list = await json<Sessions>(
      await request("rev", `/api/v1/access/people/${sharedRev.membershipId}/sessions`, {
        cookie: admin.cookie,
      }),
    );
    const id = list.sessions[0]?.id ?? "";
    const res = await del(
      "rev",
      `/api/v1/access/people/${sharedRev.membershipId}/sessions/${id}`,
      admin.cookie,
    );
    expect(res.status).toBe(204);
    expect((await request("rev", "/api/v1/me", { cookie: sharedRev.cookie })).status).toBe(401);
    expect((await request("other", "/api/v1/me", { cookie: sharedOther.cookie })).status).toBe(200);
    expect(await auditCount("access.session_revoked", revId)).toBe(1);
    // Revoked is gone from the list, and revoking it again is 404.
    const again = await del(
      "rev",
      `/api/v1/access/people/${sharedRev.membershipId}/sessions/${id}`,
      admin.cookie,
    );
    expect(again.status).toBe(404);
  });

  it("an admin cannot revoke an owner's sessions; the owner can revoke all of an admin's", async () => {
    const ownerSessions = await json<Sessions>(
      await request("rev", `/api/v1/access/people/${owner.membershipId}/sessions`, {
        cookie: admin.cookie,
      }),
    );
    expect(ownerSessions.sessions.length).toBeGreaterThan(0);
    const one = await del(
      "rev",
      `/api/v1/access/people/${owner.membershipId}/sessions/${ownerSessions.sessions[0]?.id}`,
      admin.cookie,
    );
    expect(one.status).toBe(403);
    const all = await post(
      "rev",
      `/api/v1/access/people/${owner.membershipId}/sessions/revoke`,
      admin.cookie,
    );
    expect(all.status).toBe(403);
    expect((await request("rev", "/api/v1/me", { cookie: owner.cookie })).status).toBe(200);

    // A second admin session to revoke, so the one we act with survives in `admin`.
    const admin2 = await signIn("rev", "admin@rev.test");
    const res = await post(
      "rev",
      `/api/v1/access/people/${admin.membershipId}/sessions/revoke`,
      owner.cookie,
    );
    expect(res.status).toBe(200);
    expect((await json<{ revoked: number }>(res)).revoked).toBeGreaterThanOrEqual(2);
    expect((await request("rev", "/api/v1/me", { cookie: admin2.cookie })).status).toBe(401);
    expect((await request("rev", "/api/v1/me", { cookie: admin.cookie })).status).toBe(401);
    expect(await auditCount("access.sessions_revoked", revId)).toBe(1);
  });

  it("an unknown member is 404", async () => {
    const res = await request(
      "rev",
      "/api/v1/access/people/0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a/sessions",
      {
        cookie: owner.cookie,
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("revoking a session that is viewing as an investor", () => {
  it("ends the view with access.view_as_ended (session_revoked)", async () => {
    const viewer = await member("rev", revId, "viewer-admin@rev.test", "staff", "admin");
    const start = await post(
      "rev",
      `/api/v1/access/people/${investor.membershipId}/view-as`,
      viewer.cookie,
      { reason: "checking what they see" },
    );
    expect(start.ok, await start.clone().text()).toBe(true);
    const [held] = await hostRows<{ id: string }>(
      `SELECT id FROM core.session WHERE user_id = '${viewer.userId}'::uuid
         AND revoked_at IS NULL AND view_as_workspace_id IS NOT NULL`,
    );
    expect(held).toBeDefined();
    const endedBefore = await auditCount("access.view_as_ended", revId);
    await authAge(owner, 0);
    const res = await del(
      "rev",
      `/api/v1/access/people/${viewer.membershipId}/sessions/${held?.id}`,
      owner.cookie,
    );
    expect(res.status).toBe(204);
    expect(await auditCount("access.view_as_ended", revId)).toBe(endedBefore + 1);
    const [ended] = await rows<{ reason: string; session_id: string; actor: string }>(
      `SELECT meta->>'reason' AS reason, session_id::text AS session_id, actor_user_id::text AS actor
         FROM audit.event WHERE workspace_id = '${revId}'::uuid AND action = 'access.view_as_ended'
         ORDER BY seq DESC LIMIT 1`,
      revId,
    );
    expect(ended).toEqual({
      reason: "session_revoked",
      session_id: held?.id,
      actor: viewer.userId,
    });
  });
});

describe("danger zone", () => {
  let zOwner: Actor;
  let zEditor: Actor;
  let zInvestor: Actor;
  let hOwner: Actor;

  beforeAll(async () => {
    zOwner = await member("zone", zoneId, "owner@zone.test", "staff", "owner");
    zEditor = await member("zone", zoneId, "editor@zone.test", "staff", "editor");
    zInvestor = await member("zone", zoneId, "inv@zone.test", "external", "investor");
    hOwner = await member("held", heldId, "owner@held.test", "staff", "owner");
    // A data key for the purge to shred.
    const ctx = systemContext(zoneId);
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.envelope.currentKey(tx, ctx),
    );
  });

  it("a typed confirmation that is not the slug is refused before anything changes", async () => {
    for (const [method, path, body] of [
      [
        "POST",
        "/api/v1/access/ownership/transfer",
        { toMembershipId: zEditor.membershipId, confirm: "Zone" },
      ],
      ["POST", "/api/v1/access/sessions/revoke-all", { confirm: "zone ", includeStaff: false }],
      ["DELETE", "/api/v1/workspace", { confirm: "rev" }],
    ] as const) {
      const res = await request("zone", path, {
        method,
        cookie: zOwner.cookie,
        body: JSON.stringify(body),
      });
      expect(res.status, path).toBe(400);
      expect(await json<ErrorBody>(res)).toMatchObject({
        error: { code: "validation_failed", reason: "confirmation_mismatch" },
      });
    }
    expect(await auditCount("access.ownership_transferred", zoneId)).toBe(0);
  });

  it("transfer: the target must be active staff; then roles flip", async () => {
    const bad = await post("zone", "/api/v1/access/ownership/transfer", zOwner.cookie, {
      toMembershipId: zInvestor.membershipId,
      confirm: "zone",
    });
    expect(bad.status).toBe(404);
    const res = await post("zone", "/api/v1/access/ownership/transfer", zOwner.cookie, {
      toMembershipId: zEditor.membershipId,
      confirm: "zone",
    });
    expect(res.status).toBe(200);
    const roles = await rows<{ id: string; role: string }>(
      `SELECT id, role FROM core.membership WHERE workspace_id = '${zoneId}'::uuid AND kind = 'staff'`,
      zoneId,
    );
    expect(Object.fromEntries(roles.map((r) => [r.id, r.role]))).toEqual({
      [zOwner.membershipId]: "admin",
      [zEditor.membershipId]: "owner",
    });
    expect(await auditCount("access.ownership_transferred", zoneId)).toBe(1);
    // The former owner is now an admin: the owner-only routes are closed to them.
    const again = await post("zone", "/api/v1/access/ownership/transfer", zOwner.cookie, {
      toMembershipId: zEditor.membershipId,
      confirm: "zone",
    });
    expect(again.status).toBe(403);
    // Hand it back so the remaining tests have an owner with MFA.
    zEditor.cookie = await stepUpToMfa("zone", zEditor.cookie);
    const back = await post("zone", "/api/v1/access/ownership/transfer", zEditor.cookie, {
      toMembershipId: zOwner.membershipId,
      confirm: "zone",
      keepOwner: true,
    });
    expect(back.status).toBe(200);
  });

  it("revoke-all signs every investor out and keeps the caller in", async () => {
    const res = await post("zone", "/api/v1/access/sessions/revoke-all", zOwner.cookie, {
      confirm: "zone",
      includeStaff: false,
    });
    expect(res.status).toBe(200);
    expect((await json<{ revoked: number }>(res)).revoked).toBe(1);
    expect((await request("zone", "/api/v1/me", { cookie: zInvestor.cookie })).status).toBe(401);
    expect((await request("zone", "/api/v1/me", { cookie: zEditor.cookie })).status).toBe(200);
    expect((await request("zone", "/api/v1/me", { cookie: zOwner.cookie })).status).toBe(200);
    expect(await auditCount("access.sessions_revoked_all", zoneId)).toBe(1);
  });

  it("delete is refused under legal hold", async () => {
    await setLegalHold(heldId, true);
    const res = await del("held", "/api/v1/workspace", hOwner.cookie, { confirm: "held" });
    expect(res.status).toBe(409);
    expect(await json<ErrorBody>(res)).toMatchObject({
      error: { code: "conflict", reason: "legal_hold" },
    });
    expect((await request("held", "/api/v1/me", { cookie: hOwner.cookie })).status).toBe(200);
  });

  it("delete: the portal stops resolving, sessions end, purge_after is 30 days out", async () => {
    const res = await del("zone", "/api/v1/workspace", zOwner.cookie, { confirm: "zone" });
    expect(res.status).toBe(202);
    const { purgeAfter } = await json<{ purgeAfter: string }>(res);
    expect(Math.abs(Date.parse(purgeAfter) - Date.now() - 30 * 86_400_000)).toBeLessThan(60_000);
    const [ws] = await hostRows<{ deleted: boolean; purge_after: string }>(
      `SELECT deleted_at IS NOT NULL AS deleted, purge_after FROM core.workspace WHERE id = '${zoneId}'::uuid`,
    );
    expect(ws?.deleted).toBe(true);
    expect(ws?.purge_after).not.toBeNull();
    expect((await request("zone", "/api/v1/me", { cookie: zEditor.cookie })).status).toBe(404);
    const live = await hostRows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.session WHERE last_workspace_id = '${zoneId}'::uuid AND revoked_at IS NULL`,
    );
    expect(live[0]?.n).toBe(0);
    expect(await auditCount("workspace.deleted", zoneId)).toBe(1);
  });

  it("an operator can restore it while the window is open", async () => {
    expect(await runWorkspaceRestore(["restore", "zone"], config)).toBe(0);
    const [ws] = await hostRows<{ deleted_at: string | null; purge_after: string | null }>(
      `SELECT deleted_at, purge_after FROM core.workspace WHERE id = '${zoneId}'::uuid`,
    );
    expect(ws).toEqual({ deleted_at: null, purge_after: null });
    expect(
      (
        await request("zone", "/api/v1/auth/otp/start", {
          method: "POST",
          body: JSON.stringify({ email: "owner@zone.test" }),
        })
      ).status,
    ).toBe(200);
    const restored = await running.container.db.withTenant(
      platformContext(),
      async (tx) =>
        (
          await tx.execute(
            `SELECT count(*)::int AS n FROM audit.event WHERE action = 'workspace.restored' AND resource_id = '${zoneId}'`,
          )
        ).rows,
    );
    expect((restored[0] as { n: number }).n).toBe(1);
    expect(await runWorkspaceRestore(["restore", "zone"], config)).toBe(1);
    expect(await runWorkspaceRestore(["bogus"], config)).toBe(2);
  });
});

describe("workspace.purge", () => {
  async function deletedWorkspace(slug: string, purgeAfterSql: string, hold = false) {
    const id = (await createWorkspace(running.container.db, { slug, name: slug })).id;
    const ctx = systemContext(id);
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.envelope.currentKey(tx, ctx),
    );
    if (hold) await setLegalHold(id, true);
    await hostRows(
      `UPDATE core.workspace SET deleted_at = now() - interval '31 days', purge_after = ${purgeAfterSql}
       WHERE id = '${id}'::uuid RETURNING id`,
    );
    return id;
  }
  const keys = (id: string) =>
    rows<{ ref: string; len: number }>(
      `SELECT kms_key_ref AS ref, octet_length(wrapped_dek) AS len FROM core.workspace_key WHERE workspace_id = '${id}'::uuid`,
      id,
    );

  it("a restore racing the purge waits for it: never a restored workspace with shredded keys", async () => {
    // Restorable now (window open until tomorrow), due for a purge run that believes it is later.
    const id = await deletedWorkspace("race", "now() + interval '1 day'");
    let restoring: Promise<string> | undefined;
    const result = await purgeDeletedWorkspaces({
      db: running.container.db,
      audit: running.container.audit,
      now: () => new Date(Date.now() + 2 * 86_400_000),
      hooks: {
        afterRecheck: async (wsId) => {
          if (wsId !== id) return;
          // The operator restores after the purge re-checked the row, on another connection.
          restoring = restoreWorkspace(
            { db: running.container.db, audit: running.container.audit },
            id,
          ).then(
            () => "restored",
            (e: unknown) => (e instanceof WorkspaceLifecycleError ? e.code : String(e)),
          );
          await new Promise((r) => setTimeout(r, 400));
        },
      },
    });
    const restoreOutcome = await restoring;
    const [ws] = await hostRows<{ deleted: boolean; purged: boolean }>(
      `SELECT deleted_at IS NOT NULL AS deleted, purged_at IS NOT NULL AS purged
         FROM core.workspace WHERE id = '${id}'::uuid`,
    );
    const k = await keys(id);
    // The invariant: a live workspace never has shredded keys.
    if (ws?.deleted === false) expect(k.every((x) => x.ref !== "shredded")).toBe(true);
    // And with the row lock, the restore waited for the purge and found nothing to restore.
    expect(result.purged).toContain(id);
    expect(restoreOutcome).toBe("not_found");
    expect(ws).toEqual({ deleted: true, purged: true });
    expect(k).toEqual([{ ref: "shredded", len: 0 }]);
  });

  it("shreds the keys of an expired deletion and skips held and unexpired ones", async () => {
    const due = await deletedWorkspace("gone", "now() - interval '1 day'");
    const early = await deletedWorkspace("early", "now() + interval '1 day'");
    const held = await deletedWorkspace("kept", "now() - interval '1 day'", true);
    const result = await purgeDeletedWorkspaces({
      db: running.container.db,
      audit: running.container.audit,
    });
    expect(result.purged).toEqual([due]);
    expect(result.held).toEqual([held]);
    expect(await keys(due)).toEqual([{ ref: "shredded", len: 0 }]);
    for (const id of [early, held]) {
      const k = await keys(id);
      expect(k).toHaveLength(1);
      expect(k[0]?.ref).not.toBe("shredded");
      expect(k[0]?.len).toBeGreaterThan(0);
    }
    const [row] = await hostRows<{ purged: boolean }>(
      `SELECT purged_at IS NOT NULL AS purged FROM core.workspace WHERE id = '${due}'::uuid`,
    );
    expect(row?.purged).toBe(true);
    const audited = await running.container.db.withTenant(
      platformContext(),
      async (tx) =>
        (
          await tx.execute(
            `SELECT count(*)::int AS n FROM audit.event WHERE action = 'workspace.purged' AND resource_id = '${due}'`,
          )
        ).rows,
    );
    expect((audited[0] as { n: number }).n).toBe(1);
    // Idempotent, and a purged workspace can no longer be restored.
    expect(
      (await purgeDeletedWorkspaces({ db: running.container.db, audit: running.container.audit }))
        .purged,
    ).toEqual([]);
    expect(await runWorkspaceRestore(["restore", due], config)).toBe(1);
  });
});
