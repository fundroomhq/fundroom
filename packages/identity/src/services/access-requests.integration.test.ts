import { randomBytes } from "node:crypto";
import { createAuditService } from "@fundroom/audit";
import { parseKeyRing } from "@fundroom/config";
import {
  createDatabase,
  createWorkspace,
  type Database,
  type OfferingStatus,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { OutboundEmail, RateLimiterPort } from "@fundroom/ports";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAuthError } from "../errors.js";
import { AccessRequestRepo } from "../repos/access-request-repo.js";
import { GroupRepo, MembershipRepo } from "../repos/membership-repo.js";
import {
  ACCESS_REQUEST_CODE_MAX_ATTEMPTS,
  ACCESS_REQUEST_CODE_TTL_MS,
  ACCESS_REQUEST_RETENTION_DAYS,
  type AccessRequestService,
  type AccessRequestWorkspace,
  createAccessRequestService,
} from "./access-requests.js";
import { createGroupService } from "./groups.js";
import { writeInvite } from "./invites.js";
import { establishMembership } from "./login.js";
import { provisionMembership, provisionUser } from "./provision.js";
import { createPostgresRateLimiter } from "./rate-limiter.js";
import type { IdentityDeps, RelationshipRecorder } from "./types.js";

/*
 * E3.1 access requests against real Postgres (RLS on, role switch on), on a pool of ONE
 * connection: any code path that asks for a second connection while it holds a transaction
 * (the pool-deadlock trap) hangs here instead of passing.
 */
let pg: TestPostgres;
let db: Database;
let deps: IdentityDeps;
let service: AccessRequestService;
let clock = new Date("2026-09-25T12:00:00Z");
const sent: OutboundEmail[] = [];
const recorded: {
  membershipId: string;
  source: unknown;
  actor: string | null;
  inTx: boolean;
}[] = [];
/** Every service log line, serialised (checked for PII at the end). */
const logLines: string[] = [];
/** Every rate-limit key hit, in order (the invitation cap is `invite:ws:<id>`). */
const hits: string[] = [];
/** Set to make the next mails of this kind fail (the invite mail after an approval). */
let failTemplates: ReadonlySet<string> = new Set();

const keyRing = (() => {
  const r = parseKeyRing(`v1:${randomBytes(32).toString("base64")}`);
  if (!r.ok) throw new Error("bad ring");
  return r.ring;
})();

const relationships: RelationshipRecorder = {
  async record(_ctx: TenantContext, tx: Tx, membershipId, input) {
    // Proves the recorder is handed the live acceptance transaction (it can see the new row).
    const r = await tx.execute(
      sql`SELECT count(*)::int AS n FROM core.membership WHERE id = ${membershipId}::uuid`,
    );
    recorded.push({
      membershipId,
      source: input.source,
      actor: input.actor === null ? null : input.actor.membershipId,
      inTx: Number((r.rows[0] as { n: number }).n) === 1,
    });
    return {};
  },
};

function tick(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

function codesFor(email: string): string[] {
  return sent
    .filter((x) => x.to === email && x.template?.name === "auth.access_request_code")
    .map((m) => /^\s{4}(\d{6})$/mu.exec(m.text)?.[1] ?? "");
}

function codeFor(email: string): string {
  const c = codesFor(email).at(-1);
  if (c === undefined) throw new Error(`no code mailed to ${email}`);
  return c;
}

function otherCode(code: string): string {
  return code === "000000" ? "000001" : "000000";
}

async function expectAuthError(
  p: Promise<unknown>,
  code: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await p;
  } catch (error) {
    if (isAuthError(error)) {
      expect(error.code).toBe(code);
      if (details !== undefined) expect(error.details).toMatchObject(details);
      return;
    }
    throw error;
  }
  throw new Error(`expected AuthError ${code}`);
}

/**
 * A workspace whose settings and offering status are STORED (the service reads both fresh from
 * the database, S8b); the returned object is what a resolver would have cached.
 */
async function workspace(
  slug: string,
  requests: Record<string, unknown> = {},
  offeringStatus: OfferingStatus = "none",
): Promise<AccessRequestWorkspace> {
  const ws = await createWorkspace(db, { slug, name: `Workspace ${slug}` });
  const settings = { access: { requests: { enabled: true, ...requests } } };
  await store(ws.id, settings, offeringStatus);
  return { id: ws.id, name: ws.name, offeringStatus, settings };
}

async function store(workspaceId: string, settings: unknown, offeringStatus?: OfferingStatus) {
  await pg.pool.query(
    `UPDATE core.workspace SET settings = $2::jsonb,
       offering_status = coalesce($3::core.offering_status, offering_status) WHERE id = $1`,
    [workspaceId, JSON.stringify(settings), offeringStatus ?? null],
  );
}

async function rows(workspaceId: string, email?: string) {
  const r = await pg.pool.query<{
    id: string;
    status: string;
    invite_id: string | null;
    membership_id: string | null;
    auto_approved: boolean;
    suggested_group_ids: string[];
    email: string;
    name: string;
    firm: string | null;
    reason: string | null;
    decided_at: Date | null;
    decided_by: string | null;
    verified_at: Date | null;
    client_ip_hash: Buffer | null;
  }>(
    `SELECT * FROM core.access_request WHERE workspace_id = $1 ${email ? "AND email = $2" : ""}
     ORDER BY created_at`,
    email ? [workspaceId, email] : [workspaceId],
  );
  return r.rows;
}

async function challenges(workspaceId: string, email?: string) {
  const r = await pg.pool.query<{
    id: string;
    email: string;
    name: string;
    firm: string | null;
    reason: string | null;
    code_hash: Buffer;
    client_ip_hash: Buffer | null;
    expires_at: Date;
  }>(
    `SELECT * FROM core.access_request_challenge
     WHERE workspace_id = $1 ${email ? "AND email = $2" : ""} ORDER BY created_at`,
    email ? [workspaceId, email] : [workspaceId],
  );
  return r.rows;
}

async function audits(workspaceId: string, resourceId: string) {
  const r = await pg.pool.query<{
    action: string;
    actor_kind: string;
    meta: Record<string, unknown>;
  }>(
    `SELECT action, actor_kind, meta FROM audit.event WHERE workspace_id = $1 AND resource_id = $2
     ORDER BY seq`,
    [workspaceId, resourceId],
  );
  return r.rows;
}

async function auditActions(workspaceId: string, resourceId: string): Promise<string[]> {
  return (await audits(workspaceId, resourceId)).map((x) => `${x.action}:${x.actor_kind}`);
}

async function events(workspaceId: string, topic: string): Promise<Record<string, unknown>[]> {
  const r = await pg.pool.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM core.outbox WHERE workspace_id = $1 AND topic = $2 ORDER BY id",
    [workspaceId, topic],
  );
  return r.rows.map((x) => x.payload);
}

async function staff(ws: AccessRequestWorkspace, email: string): Promise<string> {
  const u = await provisionUser(deps, { email, displayName: "Dana Admin" });
  const m = await provisionMembership(deps, {
    workspaceId: ws.id,
    userId: u.userId,
    kind: "staff",
    role: "admin",
    source: "setup",
  });
  return m.id;
}

async function group(ws: AccessRequestWorkspace, name: string): Promise<string> {
  const ctx = systemContext(ws.id);
  return (await db.withTenant(ctx, (tx) => new GroupRepo(ctx, tx).create({ name }))).id;
}

/** An ordinary invitation, as POST /access/invites would write it. */
async function invite(ws: AccessRequestWorkspace, email: string) {
  const ctx = systemContext(ws.id);
  return db.withTenant(ctx, (tx) =>
    writeInvite(
      deps,
      ctx,
      tx,
      { workspaceId: ws.id, email, kind: "external", role: "investor" },
      undefined,
    ),
  );
}

/** start → mailed code → verify: a pending (or auto-approved) request; returns its id. */
async function submit(ws: AccessRequestWorkspace, email: string, name = "Pat Investor") {
  await service.start({ workspace: ws, email, name, firm: "Fund LP" });
  const r = await service.verify({ workspace: ws, email, code: codeFor(email) });
  expect(r).toEqual({ ok: true });
  const [row] = await rows(ws.id, email);
  if (row === undefined) throw new Error("no request row");
  return (await rows(ws.id, email)).at(-1)?.id ?? row.id;
}

function invitationCapHits(ws: AccessRequestWorkspace): number {
  return hits.filter((k) => k === `invite:ws:${ws.id}`).length;
}

beforeAll(async () => {
  pg = await startPostgres();
  db = createDatabase({ connectionString: pg.connectionString, poolMax: 1 });
  const limiter = createPostgresRateLimiter(db, { now: () => clock });
  const counting: RateLimiterPort = {
    hit: (key, rule) => {
      hits.push(key);
      return limiter.hit(key, rule);
    },
    peek: (key, rule) => limiter.peek(key, rule),
    reset: (key) => limiter.reset(key),
  };
  deps = {
    db,
    keyRing,
    mailer: {
      driver: "test",
      async send(m) {
        if (m.template !== undefined && failTemplates.has(m.template.name))
          throw new Error("smtp down");
        sent.push(m);
        return { messageId: `<${sent.length}@test>`, acceptedAt: clock };
      },
      async healthCheck() {},
    },
    rateLimiter: counting,
    audit: createAuditService({ db, now: () => clock }),
    baseUrl: new URL("https://investors.acme.test"),
    productName: "FundRoom",
    now: () => clock,
    relationships,
    log: (event, fields) => {
      logLines.push(JSON.stringify({ event, fields }));
    },
  };
  service = createAccessRequestService(deps, {
    requestAutoApprove: (s) => s !== "506b",
    inviteDailyCap: { max: 200, windowMs: 24 * 3600_000 },
  });
});

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

describe("start and verify", () => {
  it("a start is a challenge, not a request; proving its code queues the request with its text", async () => {
    const ws0 = await workspace("ar-basic");
    const ctx = systemContext(ws0.id);
    const g = await group(ws0, "LPs");
    const ws = {
      ...ws0,
      settings: { access: { requests: { enabled: true, defaultGroupIds: [g] } } },
    };
    await store(ws.id, ws.settings);
    const started = await service.start({
      workspace: ws,
      email: "Pat@Fund.test",
      name: "  Pat  ",
      firm: "",
      reason: "Met at demo day",
      clientIp: "203.0.113.7",
    });
    expect(Object.keys(started).sort()).toEqual(["expiresAt", "throttled"]);
    expect(started.expiresAt.getTime()).toBe(clock.getTime() + ACCESS_REQUEST_CODE_TTL_MS);
    // Nothing in the queue: a challenge row carrying this submission's text.
    expect(await rows(ws.id)).toEqual([]);
    const [ch] = await challenges(ws.id);
    expect(ch).toMatchObject({ email: "pat@fund.test", name: "Pat", firm: null });
    expect(ch?.expires_at.getTime()).toBe(started.expiresAt.getTime());
    expect(ch?.client_ip_hash).not.toBeNull();
    expect(ch?.client_ip_hash?.toString("utf8")).not.toContain("203.0.113");
    const mail = sent.at(-1);
    expect(mail?.to).toBe("pat@fund.test");
    expect(mail?.template?.name).toBe("auth.access_request_code");
    expect(mail?.text).toContain("in the name of Pat.");

    const before = await db.withTenant(ctx, (tx) => service.list(ctx, tx, { status: "pending" }));
    expect(before.items).toEqual([]);

    expect(
      await service.verify({
        workspace: ws,
        email: "PAT@fund.test ",
        code: codeFor("pat@fund.test"),
      }),
    ).toEqual({ ok: true });
    const [pending] = await rows(ws.id);
    expect(pending?.status).toBe("pending");
    expect(pending?.name).toBe("Pat");
    expect(pending?.reason).toBe("Met at demo day");
    expect(pending?.suggested_group_ids).toEqual([g]);
    expect(pending?.client_ip_hash).not.toBeNull();
    // The address's challenges are consumed.
    expect(await challenges(ws.id)).toEqual([]);
    const id = pending?.id ?? "";
    expect(await auditActions(ws.id, id)).toEqual(["access_request.submitted:system"]);
    expect(await events(ws.id, "access_request.submitted")).toEqual([{ accessRequestId: id }]);

    const page = await db.withTenant(ctx, (tx) => service.list(ctx, tx, { status: "pending" }));
    expect(page.items.map((i) => i.id)).toEqual([id]);

    // The code is single use.
    expect(
      await service.verify({
        workspace: ws,
        email: "pat@fund.test",
        code: codeFor("pat@fund.test"),
      }),
    ).toEqual({ ok: false });
  });

  it("a member's address and a stranger's get the same answer, again and again (S1)", async () => {
    const ws = await workspace("ar-oracle");
    await staff(ws, "member@fund.test");
    const member: unknown[] = [];
    const stranger: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      member.push(await service.start({ workspace: ws, email: "member@fund.test", name: "M" }));
      stranger.push(await service.start({ workspace: ws, email: "new@fund.test", name: "N" }));
    }
    // Identical bodies, and nothing in them that repeats for one address but not the other.
    expect(member).toEqual(stranger);
    expect(await challenges(ws.id, "member@fund.test")).toEqual([]);
    expect(await challenges(ws.id, "new@fund.test")).toHaveLength(3);
    expect(sent.at(-2)?.template?.name).toBe("auth.access_request_existing");
  });

  it("parallel guesses spend the address's budget before any comparison; the budget is per address", async () => {
    const ws = await workspace("ar-guess");
    await service.start({ workspace: ws, email: "g@fund.test", name: "G" });
    const right = codeFor("g@fund.test");
    const answers = await Promise.all(
      Array.from({ length: 12 }, () =>
        service.verify({ workspace: ws, email: "g@fund.test", code: otherCode(right) }),
      ),
    );
    expect(answers.every((a) => a.ok === false)).toBe(true);
    // Budget spent: even the right code is refused now, like any other "no".
    expect(await service.verify({ workspace: ws, email: "g@fund.test", code: right })).toEqual({
      ok: false,
    });
    expect(ACCESS_REQUEST_CODE_MAX_ATTEMPTS).toBe(5);
    // Somebody else's verification in the same workspace is untouched (S3: no shared bucket).
    await service.start({ workspace: ws, email: "h@fund.test", name: "H" });
    expect(
      await service.verify({ workspace: ws, email: "h@fund.test", code: codeFor("h@fund.test") }),
    ).toEqual({ ok: true });
    // Once the sliding window has let go of the guesses, a new code gets the owner through.
    tick(31 * 60_000);
    await service.start({ workspace: ws, email: "g@fund.test", name: "G" });
    expect(
      await service.verify({ workspace: ws, email: "g@fund.test", code: codeFor("g@fund.test") }),
    ).toEqual({ ok: true });
  });

  it("an expired code, an unknown address and a honeypot submission all answer the same", async () => {
    const ws = await workspace("ar-expired");
    await service.start({ workspace: ws, email: "e@fund.test", name: "E" });
    const code = codeFor("e@fund.test");
    const honey = await service.start({
      workspace: ws,
      email: "f@fund.test",
      name: "F",
      honeypot: "x",
    });
    expect(honey.throttled).toBeNull();
    expect(await challenges(ws.id, "f@fund.test")).toEqual([]);
    expect(await service.verify({ workspace: ws, email: "nobody@fund.test", code })).toEqual({
      ok: false,
    });
    expect(await service.verify({ workspace: ws, email: "f@fund.test", code })).toEqual({
      ok: false,
    });
    tick(ACCESS_REQUEST_CODE_TTL_MS + 1000);
    expect(await service.verify({ workspace: ws, email: "e@fund.test", code })).toEqual({
      ok: false,
    });
  });

  it("a stranger's later start neither kills the owner's code nor replaces the owner's text (S6, C2)", async () => {
    const ws = await workspace("ar-overwrite");
    await service.start({
      workspace: ws,
      email: "owner@fund.test",
      name: "Olivia Owner",
      firm: "Real Fund",
      reason: "genuine",
    });
    const ownersCode = codeFor("owner@fund.test");
    await service.start({
      workspace: ws,
      email: "owner@fund.test",
      name: "Mallory",
      firm: "Evil LP",
      reason: "call 555-0100",
    });
    // The owner's mailbox now also holds a code that names the stranger.
    expect(sent.at(-1)?.text).toContain("in the name of Mallory (Evil LP)");
    expect(await challenges(ws.id, "owner@fund.test")).toHaveLength(2);
    // The owner's (earlier) code still works, and the queue shows what the owner wrote.
    expect(
      await service.verify({ workspace: ws, email: "owner@fund.test", code: ownersCode }),
    ).toEqual({
      ok: true,
    });
    const [row] = await rows(ws.id, "owner@fund.test");
    expect(row).toMatchObject({ name: "Olivia Owner", firm: "Real Fund", reason: "genuine" });
    // Every challenge of the address went with the proof: the stranger's code is dead.
    expect(await challenges(ws.id, "owner@fund.test")).toEqual([]);
  });

  it("proving a code again while pending replaces the text with the proven submission's", async () => {
    const ws = await workspace("ar-restart");
    const id = await submit(ws, "again@fund.test", "Original");
    tick(60_000);
    await service.start({ workspace: ws, email: "again@fund.test", name: "Changed" });
    // Unproven: nothing changes.
    expect((await rows(ws.id))[0]?.name).toBe("Original");
    expect(
      await service.verify({
        workspace: ws,
        email: "again@fund.test",
        code: codeFor("again@fund.test"),
      }),
    ).toEqual({ ok: true });
    const all = await rows(ws.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id, status: "pending", name: "Changed" });
    expect(all[0]?.verified_at?.getTime()).toBe(clock.getTime());
    // Still exactly one submitted audit row (no second staff alert).
    expect(await auditActions(ws.id, id)).toEqual(["access_request.submitted:system"]);
  });

  it("the suggested groups are the default groups that still exist (C1)", async () => {
    const ws0 = await workspace("ar-live-groups");
    const keep = await group(ws0, "Keep");
    const gone = await group(ws0, "Gone");
    const ws = {
      ...ws0,
      settings: { access: { requests: { enabled: true, defaultGroupIds: [keep, gone] } } },
    };
    await store(ws.id, ws.settings);
    // Deleted behind the settings' back (as before the C1 fix, or by a raw write).
    await pg.pool.query("UPDATE core.group SET deleted_at = now() WHERE id = $1", [gone]);
    await submit(ws, "live@fund.test");
    expect((await rows(ws.id))[0]?.suggested_group_ids).toEqual([keep]);
  });

  it("deleting a group takes it out of the default groups in the same transaction (C1)", async () => {
    const ws = await workspace("ar-group-delete");
    const admin = await staff(ws, "admin@gd.test");
    const a = await group(ws, "A");
    const b = await group(ws, "B");
    await store(ws.id, {
      access: { requests: { enabled: true, defaultGroupIds: [a, b] }, inviteExpiryDays: 9 },
      legal: { legalHold: false },
    });
    await createGroupService(deps).delete(systemContext(ws.id), a, admin);
    const r = await pg.pool.query<{
      settings: {
        access: { requests: { defaultGroupIds: string[] }; inviteExpiryDays: number };
        legal: unknown;
      };
    }>("SELECT settings FROM core.workspace WHERE id = $1", [ws.id]);
    expect(r.rows[0]?.settings.access.requests.defaultGroupIds).toEqual([b]);
    // Everything else in the document is untouched.
    expect(r.rows[0]?.settings.access.inviteExpiryDays).toBe(9);
    expect(r.rows[0]?.settings.legal).toEqual({ legalHold: false });
    const [row] = (await audits(ws.id, a)).filter((x) => x.action === "group.deleted");
    expect(row?.meta).toMatchObject({ accessRequestDefault: true });
  });
});

describe("decisions", () => {
  it("under 506(b) an approval needs the relationship; with it, the invite carries the request and the relationship reaches the membership on acceptance", async () => {
    const ws = await workspace("ar-506b", {}, "506b");
    const admin = await staff(ws, "admin@506b.test");
    const id = await submit(ws, "lp@fund.test");
    const ctx = systemContext(ws.id);

    await expectAuthError(
      service.approve(ctx, { id, actorMembershipId: admin, workspace: ws, groupIds: [] }),
      "relationship_attestation_required",
    );
    const established = new Date("2025-01-15T00:00:00Z");
    const {
      request,
      invite: inv,
      mailSent,
    } = await service.approve(ctx, {
      id,
      actorMembershipId: admin,
      actorName: "Dana",
      workspace: ws,
      groupIds: [],
      note: "known from the seed round",
      relationship: { source: "prior_investor", establishedAt: established, note: "via Sam" },
    });
    expect(mailSent).toBe(true);
    expect(request.status).toBe("approved");
    expect(request.decidedBy).toEqual({ membershipId: admin, displayName: "Dana Admin" });
    expect(request.relationship).toEqual({
      source: "prior_investor",
      establishedAt: established,
      note: "via Sam",
    });
    expect(request.inviteId).toBe(inv.id);
    expect(inv.accessRequestId).toBe(id);
    expect(inv.message).toBe(`Your request to access ${ws.name} was approved.`);
    const inviteMail = sent.at(-1);
    expect(inviteMail?.template?.name).toBe("auth.invite");
    expect(inviteMail?.text).not.toContain("known from the seed round");
    expect(await auditActions(ws.id, id)).toEqual([
      "access_request.submitted:system",
      "access_request.approved:staff",
    ]);
    expect(await events(ws.id, "access_request.decided")).toEqual([
      { accessRequestId: id, decision: "approved", auto: false },
    ]);
    // Decided once.
    await expectAuthError(
      service.deny(ctx, { id, actorMembershipId: admin, workspace: ws, notifyRequester: false }),
      "conflict",
    );

    // Acceptance: the ordinary invite flow.
    const user = await provisionUser(deps, { email: "lp@fund.test" });
    const m = await establishMembership(deps, {
      workspaceId: ws.id,
      userId: user.userId,
      email: "lp@fund.test",
      source: "invite",
    });
    expect(m).toBeDefined();
    const member = await db.withTenant(ctx, (tx) => new MembershipRepo(ctx, tx).byId(m?.id ?? ""));
    expect(member?.source).toBe("request");
    const [row] = await rows(ws.id);
    expect(row?.membership_id).toBe(m?.id);
    expect(recorded.at(-1)).toEqual({
      membershipId: m?.id,
      source: "prior_investor",
      actor: admin,
      inTx: true,
    });
  });

  it("the offering mode is read fresh, never from the cached workspace (S8b)", async () => {
    // The cache says `none`; the database says 506(b).
    const stale = await workspace("ar-stale-506b");
    await store(stale.id, stale.settings, "506b");
    const admin = await staff(stale, "admin@stale.test");
    const id = await submit(stale, "stale@fund.test");
    await expectAuthError(
      service.approve(systemContext(stale.id), {
        id,
        actorMembershipId: admin,
        workspace: stale,
        groupIds: [],
      }),
      "relationship_attestation_required",
    );
    // Auto-approval too: a 506(b) switch the cache has not seen yet keeps the request pending.
    const auto = await workspace("ar-stale-auto", { autoApproveDomains: ["fund.test"] });
    await store(auto.id, auto.settings, "506b");
    await submit(auto, "domain@fund.test");
    expect((await rows(auto.id))[0]?.status).toBe("pending");
  });

  it("a relationship dated in the future is refused (C8), a day of slack is not", async () => {
    const ws = await workspace("ar-future");
    const admin = await staff(ws, "admin@future.test");
    const id = await submit(ws, "future@fund.test");
    const ctx = systemContext(ws.id);
    const spent: number[] = [];
    await expectAuthError(
      service.approve(ctx, {
        id,
        actorMembershipId: admin,
        workspace: ws,
        groupIds: [],
        relationship: {
          source: "other",
          establishedAt: new Date(clock.getTime() + 3 * 86_400_000),
        },
        beforeWrite: async () => {
          spent.push(1);
        },
      }),
      "validation_failed",
      { reason: "relationship_in_future" },
    );
    expect(spent).toEqual([]);
    const ok = await service.approve(ctx, {
      id,
      actorMembershipId: admin,
      workspace: ws,
      groupIds: [],
      relationship: { source: "other", establishedAt: new Date(clock.getTime() + 12 * 3600_000) },
    });
    expect(ok.request.status).toBe("approved");
  });

  it("a waiting invitation for the address is a 409 invite_pending, and nothing is spent or written (C4, C7)", async () => {
    const ws = await workspace("ar-invite-pending");
    const admin = await staff(ws, "admin@ip.test");
    const id = await submit(ws, "twice@fund.test");
    const manual = await invite(ws, "twice@fund.test");
    let spent = 0;
    await expectAuthError(
      service.approve(systemContext(ws.id), {
        id,
        actorMembershipId: admin,
        workspace: ws,
        groupIds: [],
        beforeWrite: async () => {
          spent += 1;
        },
      }),
      "conflict",
      { reason: "invite_pending" },
    );
    expect(spent).toBe(0);
    expect((await rows(ws.id))[0]?.status).toBe("pending");
    // The admin's own invitation was not revoked behind their back.
    const inv = await pg.pool.query<{ status: string }>(
      "SELECT status FROM core.invite WHERE id = $1",
      [manual.invite.id],
    );
    expect(inv.rows[0]?.status).toBe("pending");
  });

  it("every refusal comes before the invitation slot is spent; a success spends it once (C7)", async () => {
    const ws = await workspace("ar-cap", {}, "506b");
    const admin = await staff(ws, "admin@cap.test");
    const id = await submit(ws, "cap@fund.test");
    const ctx = systemContext(ws.id);
    let spent = 0;
    const beforeWrite = async () => {
      spent += 1;
    };
    await expectAuthError(
      service.approve(ctx, {
        id,
        actorMembershipId: admin,
        workspace: ws,
        groupIds: [],
        beforeWrite,
      }),
      "relationship_attestation_required",
    );
    const relationship = { source: "other", establishedAt: new Date("2024-01-01T00:00:00Z") };
    await expectAuthError(
      service.approve(ctx, {
        id,
        actorMembershipId: admin,
        workspace: ws,
        groupIds: [crypto.randomUUID()],
        relationship,
        beforeWrite,
      }),
      "not_found",
    );
    expect(spent).toBe(0);
    // A refusal from the slot itself aborts before anything is written.
    await expect(
      service.approve(ctx, {
        id,
        actorMembershipId: admin,
        workspace: ws,
        groupIds: [],
        relationship,
        beforeWrite: async () => {
          throw new Error("cap reached");
        },
      }),
    ).rejects.toThrow("cap reached");
    expect((await rows(ws.id))[0]?.status).toBe("pending");
    await service.approve(ctx, {
      id,
      actorMembershipId: admin,
      workspace: ws,
      groupIds: [],
      relationship,
      beforeWrite,
    });
    expect(spent).toBe(1);
  });

  it("a failed invitation mail after commit is `mailSent: false`, not an error (C3)", async () => {
    const ws = await workspace("ar-mail-down");
    const admin = await staff(ws, "admin@md.test");
    const id = await submit(ws, "nomail@fund.test");
    failTemplates = new Set(["auth.invite"]);
    try {
      const r = await service.approve(systemContext(ws.id), {
        id,
        actorMembershipId: admin,
        workspace: ws,
        groupIds: [],
      });
      expect(r.mailSent).toBe(false);
      expect(r.request.status).toBe("approved");
      const inv = await pg.pool.query<{ status: string }>(
        "SELECT status FROM core.invite WHERE id = $1",
        [r.invite.id],
      );
      expect(inv.rows[0]?.status).toBe("pending");
    } finally {
      failTemplates = new Set();
    }
  });

  it("an approval for an address that became a member meanwhile is a conflict", async () => {
    const ws = await workspace("ar-conflict");
    const admin = await staff(ws, "admin@conflict.test");
    const id = await submit(ws, "late@fund.test");
    await staff(ws, "late@fund.test");
    await expectAuthError(
      service.approve(systemContext(ws.id), {
        id,
        actorMembershipId: admin,
        workspace: ws,
        groupIds: [],
      }),
      "conflict",
    );
  });

  it("joining by another route closes the waiting request, decided now (C5, C11)", async () => {
    const ws = await workspace("ar-joined");
    const id = await submit(ws, "joiner@fund.test");
    tick(60_000);
    await invite(ws, "joiner@fund.test");
    const user = await provisionUser(deps, { email: "joiner@fund.test" });
    const m = await establishMembership(deps, {
      workspaceId: ws.id,
      userId: user.userId,
      email: "joiner@fund.test",
      source: "invite",
    });
    expect(m).toBeDefined();
    const [row] = await rows(ws.id);
    expect(row?.status).toBe("expired");
    expect(row?.decided_at?.getTime()).toBe(clock.getTime());
    const expired = (await audits(ws.id, id)).filter((a) => a.action === "access_request.expired");
    expect(expired).toEqual([
      { action: "access_request.expired", actor_kind: "system", meta: { reason: "joined" } },
    ]);
  });

  it("an attestation with no approver left is recorded by the system, not dropped (S8a)", async () => {
    const ws = await workspace("ar-no-approver", {}, "506b");
    const admin = await staff(ws, "admin@na.test");
    const id = await submit(ws, "orphan@fund.test");
    await service.approve(systemContext(ws.id), {
      id,
      actorMembershipId: admin,
      workspace: ws,
      groupIds: [],
      relationship: { source: "prior_investor", establishedAt: new Date("2024-06-01T00:00:00Z") },
    });
    // The approver's membership is gone (decided_by is ON DELETE SET NULL).
    await pg.pool.query("UPDATE core.access_request SET decided_by = NULL WHERE id = $1", [id]);
    const user = await provisionUser(deps, { email: "orphan@fund.test" });
    const m = await establishMembership(deps, {
      workspaceId: ws.id,
      userId: user.userId,
      email: "orphan@fund.test",
      source: "invite",
    });
    expect(recorded.at(-1)).toEqual({
      membershipId: m?.id,
      source: "prior_investor",
      actor: null,
      inTx: true,
    });
  });

  it("another workspace's request is not found", async () => {
    const ws = await workspace("ar-fence-a");
    const other = await workspace("ar-fence-b");
    const admin = await staff(other, "admin@fence.test");
    const id = await submit(ws, "fence@fund.test");
    const octx = systemContext(other.id);
    await expectAuthError(
      service.approve(octx, { id, actorMembershipId: admin, workspace: other, groupIds: [] }),
      "not_found",
    );
    await expectAuthError(
      service.deny(octx, { id, actorMembershipId: admin, workspace: other, notifyRequester: true }),
      "not_found",
    );
    expect(await db.withTenant(octx, (tx) => service.get(octx, tx, id))).toBeNull();
  });

  it("a denial mails a neutral answer, and a new request inside the cooldown never reaches the queue", async () => {
    const ws = await workspace("ar-deny");
    const admin = await staff(ws, "admin@deny.test");
    const id = await submit(ws, "no@fund.test");
    const ctx = systemContext(ws.id);
    const { request } = await service.deny(ctx, {
      id,
      actorMembershipId: admin,
      workspace: ws,
      note: "competitor",
      notifyRequester: true,
    });
    expect(request.status).toBe("denied");
    expect(request.decisionNote).toBe("competitor");
    const mail = sent.at(-1);
    expect(mail?.template?.name).toBe("auth.access_request_denied");
    expect(`${mail?.subject}${mail?.text}`).not.toContain("competitor");
    expect(await events(ws.id, "access_request.decided")).toEqual([
      { accessRequestId: id, decision: "denied", auto: false },
    ]);

    tick(24 * 3600_000);
    await service.start({ workspace: ws, email: "no@fund.test", name: "No" });
    expect(
      await service.verify({ workspace: ws, email: "no@fund.test", code: codeFor("no@fund.test") }),
    ).toEqual({ ok: true });
    const all = await rows(ws.id);
    expect(all.map((r) => r.status)).toEqual(["denied"]);
    expect(await challenges(ws.id)).toEqual([]);
  });

  it("auto-approves an exact domain match (system, live default groups, no grants), but never under 506(b)", async () => {
    const ws0 = await workspace("ar-auto", { autoApproveDomains: ["fund.test"] });
    const g = await group(ws0, "LPs");
    const ws = {
      ...ws0,
      settings: {
        access: {
          requests: { enabled: true, autoApproveDomains: ["fund.test"], defaultGroupIds: [g] },
        },
      },
    };
    await store(ws.id, ws.settings);
    const capBefore = invitationCapHits(ws);
    const id = await submit(ws, "auto@fund.test");
    expect(invitationCapHits(ws)).toBe(capBefore + 1);
    const [row] = await rows(ws.id);
    expect(row?.status).toBe("approved");
    expect(row?.auto_approved).toBe(true);
    expect(row?.invite_id).not.toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.at(-1)?.template?.name).toBe("auth.invite");
    expect(await auditActions(ws.id, id)).toEqual([
      "access_request.submitted:system",
      "access_request.approved:system",
    ]);
    expect(await events(ws.id, "access_request.decided")).toEqual([
      { accessRequestId: id, decision: "approved", auto: true },
    ]);
    const inv = await pg.pool.query<{
      group_ids: string[];
      grants: unknown[];
      invited_by: string | null;
    }>("SELECT group_ids, grants, invited_by FROM core.invite WHERE id = $1", [row?.invite_id]);
    expect(inv.rows[0]).toEqual({ group_ids: [g], grants: [], invited_by: null });

    // A look-alike domain waits for a person, and spends no invitation slot.
    const lookAlike = invitationCapHits(ws);
    await submit(ws, "pat@evil-fund.test");
    expect((await rows(ws.id, "pat@evil-fund.test"))[0]?.status).toBe("pending");
    expect(invitationCapHits(ws)).toBe(lookAlike);

    const b = await workspace("ar-auto-506b", { autoApproveDomains: ["fund.test"] }, "506b");
    await submit(b, "auto@fund.test");
    expect((await rows(b.id))[0]?.status).toBe("pending");
    expect(invitationCapHits(b)).toBe(0);
  });

  it("no invitation slot is spent when the auto-approval would not be attempted (C7)", async () => {
    const ws = await workspace("ar-auto-nocap", { autoApproveDomains: ["fund.test"] });
    const admin = await staff(ws, "admin@nocap.test");
    // Denied within the cooldown: "received", nothing queued, nothing approved, no slot.
    await pg.pool.query(
      `INSERT INTO core.access_request (workspace_id, email, name, status, decided_at, decided_by, expires_at)
       VALUES ($1, 'denied@fund.test', 'D', 'denied', $2, $3, $2)`,
      [ws.id, clock, admin],
    );
    const before = invitationCapHits(ws);
    await service.start({ workspace: ws, email: "denied@fund.test", name: "D" });
    expect(
      await service.verify({
        workspace: ws,
        email: "denied@fund.test",
        code: codeFor("denied@fund.test"),
      }),
    ).toEqual({ ok: true });
    expect((await rows(ws.id, "denied@fund.test")).map((r) => r.status)).toEqual(["denied"]);
    expect(invitationCapHits(ws)).toBe(before);
    // Invited between start and verify (moot): "received", no slot.
    await service.start({ workspace: ws, email: "invited@fund.test", name: "I" });
    await invite(ws, "invited@fund.test");
    expect(
      await service.verify({
        workspace: ws,
        email: "invited@fund.test",
        code: codeFor("invited@fund.test"),
      }),
    ).toEqual({ ok: true });
    expect(await rows(ws.id, "invited@fund.test")).toEqual([]);
    expect(invitationCapHits(ws)).toBe(before);
  });

  it("list pages newest first with a keyset cursor", async () => {
    const ws = await workspace("ar-page");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await submit(ws, `p${i}@fund.test`));
      tick(1000);
    }
    const ctx = systemContext(ws.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await db.withTenant(ctx, (tx) =>
        service.list(ctx, tx, { status: "pending", limit: 2, cursor }),
      );
      seen.push(...page.items.map((i) => i.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([...ids].reverse());
    await expectAuthError(
      db.withTenant(ctx, (tx) => service.list(ctx, tx, { status: "pending", cursor: "garbage" })),
      "validation_failed",
    );
  });
});

describe("retention", () => {
  it("drops approved requests that never became a member once their invitation is dead (S7)", async () => {
    const ws = await workspace("ar-sweep-approved");
    const admin = await staff(ws, "admin@sa.test");
    const ctx = systemContext(ws.id);
    const approve = (id: string) =>
      service.approve(ctx, { id, actorMembershipId: admin, workspace: ws, groupIds: [] });
    // Its invitation lapsed and was never accepted.
    const lapsed = await submit(ws, "lapsed@fund.test");
    const l = await approve(lapsed);
    await pg.pool.query("UPDATE core.invite SET expires_at = $2 WHERE id = $1", [
      l.invite.id,
      new Date(clock.getTime() - 1000),
    ]);
    // Its invitation was revoked.
    const revoked = await submit(ws, "revoked@fund.test");
    const r = await approve(revoked);
    await pg.pool.query("UPDATE core.invite SET status = 'revoked' WHERE id = $1", [r.invite.id]);
    // Accepted: that member's history, kept.
    const joined = await submit(ws, "joined@fund.test");
    await approve(joined);
    const user = await provisionUser(deps, { email: "joined@fund.test" });
    await establishMembership(deps, {
      workspaceId: ws.id,
      userId: user.userId,
      email: "joined@fund.test",
      source: "invite",
    });
    // Its invitation is still waiting: kept however old the decision.
    const live = await submit(ws, "live@fund.test");
    await approve(live);
    const age = async (days: number) =>
      pg.pool.query(
        `UPDATE core.access_request SET decided_at = $2::timestamptz - make_interval(days => $3)
         WHERE workspace_id = $1`,
        [ws.id, clock, days],
      );

    // Inside retention nothing goes.
    await age(ACCESS_REQUEST_RETENTION_DAYS - 1);
    await service.sweep(clock);
    expect(await rows(ws.id)).toHaveLength(4);
    // Past it, legal hold still stops the trim.
    await age(ACCESS_REQUEST_RETENTION_DAYS + 1);
    await store(ws.id, { access: { requests: { enabled: true } }, legal: { legalHold: true } });
    await service.sweep(clock);
    expect(await rows(ws.id)).toHaveLength(4);
    await store(ws.id, { access: { requests: { enabled: true } } });
    await service.sweep(clock);
    expect((await rows(ws.id)).map((x) => x.email).sort()).toEqual([
      "joined@fund.test",
      "live@fund.test",
    ]);
  });

  it("erasure scrubs the address's requests, closes a pending one decided now, and deletes its challenges (C11)", async () => {
    const ws = await workspace("ar-erase");
    const id = await submit(ws, "erase@fund.test");
    await service.start({ workspace: ws, email: "erase@fund.test", name: "E" });
    expect(await challenges(ws.id, "erase@fund.test")).toHaveLength(1);
    const ctx = systemContext(ws.id);
    const m = await staff(ws, "someone@else.test");
    await db.withTenant(ctx, (tx) =>
      new AccessRequestRepo(ctx, tx).scrubForSubject(m, "erase@fund.test", clock),
    );
    const [row] = await rows(ws.id);
    expect(row).toMatchObject({ id, status: "expired", name: "[erased]" });
    expect(row?.decided_at?.getTime()).toBe(clock.getTime());
    expect(await challenges(ws.id)).toEqual([]);
  });
});

describe("concurrency on a wider pool", () => {
  it("two different correct codes proven at once queue exactly one request", async () => {
    const wide = createDatabase({ connectionString: pg.connectionString, poolMax: 6 });
    const logs: string[] = [];
    try {
      const racing = createAccessRequestService(
        {
          ...deps,
          db: wide,
          rateLimiter: createPostgresRateLimiter(wide, { now: () => clock }),
          log: (event) => logs.push(event),
        },
        { requestAutoApprove: () => false },
      );
      const ws = await workspace("ar-wide-race");
      await Promise.all(
        ["A", "B", "C"].map((name) =>
          racing.start({ workspace: ws, email: "wide@fund.test", name }),
        ),
      );
      const codes = codesFor("wide@fund.test");
      expect(codes).toHaveLength(3);
      expect(await challenges(ws.id, "wide@fund.test")).toHaveLength(3);
      const answers = await Promise.all(
        codes.map((code) => racing.verify({ workspace: ws, email: "wide@fund.test", code })),
      );
      expect(answers.filter((a) => a.ok)).toHaveLength(1);
      expect(await rows(ws.id, "wide@fund.test")).toHaveLength(1);
      expect(await challenges(ws.id, "wide@fund.test")).toEqual([]);
      expect(logs).not.toContain("auth.access_request_verify_failed");
    } finally {
      await wide.close();
    }
  });
});

describe("sweep over time (last: it moves the clock by months)", () => {
  it("deletes expired challenges, expires overdue pending requests, and drops old decisions", async () => {
    const ws = await workspace("ar-sweep", { pendingExpiryDays: 1 });
    const admin = await staff(ws, "admin@sweep.test");
    await service.start({ workspace: ws, email: "stale@fund.test", name: "S" });
    const pendingId = await submit(ws, "wait@fund.test");
    const deniedId = await submit(ws, "old@fund.test");
    await service.deny(systemContext(ws.id), {
      id: deniedId,
      actorMembershipId: admin,
      workspace: ws,
      notifyRequester: false,
    });
    tick(2 * 24 * 3600_000);
    const first = await service.sweep();
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(await challenges(ws.id)).toEqual([]);
    const after = await rows(ws.id);
    expect(after.map((r) => [r.email, r.status]).sort()).toEqual([
      ["old@fund.test", "denied"],
      ["wait@fund.test", "expired"],
    ]);
    expect(await auditActions(ws.id, pendingId)).toEqual([
      "access_request.submitted:system",
      "access_request.expired:system",
    ]);
    tick((ACCESS_REQUEST_RETENTION_DAYS + 1) * 24 * 3600_000);
    await service.sweep();
    expect(await rows(ws.id)).toEqual([]);
  });
});

describe("hygiene", () => {
  it("no log line and no rate-limit key carries an address, a name or a client IP", () => {
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of [...logLines, ...hits]) {
      expect(line).not.toMatch(/@fund\.test|@evil-fund\.test|Mallory|Olivia|203\.0\.113/u);
    }
  });
});
