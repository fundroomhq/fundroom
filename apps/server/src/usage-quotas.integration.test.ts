import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import {
  addDays,
  isPlanLimitError,
  USAGE_ROLLUP_JOB,
  USAGE_ROLLUP_TODAY_JOB,
  utcDay,
} from "@fundroom/control-plane";
import {
  createWorkspace,
  findWorkspaceById,
  PLATFORM_WORKSPACE_ID,
  systemContext,
  type Tx,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser, writeInvite } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { UNLIMITED_QUOTA } from "@fundroom/module-kit";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsageWiring } from "./control-plane/usage-wiring.js";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Plans, usage and quotas (E3.10, agent M): the operator's plan catalogue (optimistic version,
 * archive, platform-chain audit), the four enforced quotas at every call site that adds a seat,
 * a domain or bytes (402 `plan_limit` `{ limit, max }`), the seat race at the limit (the check
 * takes the workspace row, so the second of two concurrent invitations counts the first), the
 * usage rollup (seats, domains, mail, the modules' hooks whether or not the module is enabled,
 * 400-day retention) and the two usage reads. A workspace without a plan — every self-hosted one —
 * is limited nowhere, and CONTROL_PLANE=off wires the pass-through quota and no jobs.
 *
 * `FUNDROOM_TEST_POOL_MAX=1` runs the file on a one-connection pool (the lock-order / pool
 * deadlock check); the two race tests need a second connection and skip there.
 */
const BASE = "https://portal.example.test";
const CANON = "portal.example.test";
const POOL_MAX = process.env["FUNDROOM_TEST_POOL_MAX"];
const ONE_CONNECTION = POOL_MAX === "1";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const ids: Record<string, string> = {};

interface Actor {
  cookie: string;
  membershipId: string;
  userId: string;
}

async function request(
  host: string,
  path: string,
  init: RequestInit & { cookie?: string | undefined } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", host);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `https://${host}`);
  return running.app.request(`https://${host}${path}`, { ...init, headers });
}

const tenant = (slug: string, path: string, init: Parameters<typeof request>[2] = {}) =>
  request(`${slug}.${CANON}`, path, init);

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type ErrorBody = { error: { code: string; limit?: string; max?: number } };

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");

async function q<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  return (await pg.pool.query(text, values)).rows as T[];
}

async function signIn(
  slug: string,
  email: string,
): Promise<{ cookie: string; membershipId: string }> {
  const since = mailer.sent.length;
  const start = await tenant(slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await tenant(slug, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "" };
}

async function stepUpToMfa(slug: string, cookie: string): Promise<string> {
  const enrol = await tenant(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await tenant(slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

/** A member provisioned directly (host provisioning is not a quota call site), signed in. */
async function member(
  slug: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "viewer" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, {
    workspaceId: ids[slug] as string,
    userId,
    kind,
    role,
    source: "test",
  });
  const signed = await signIn(slug, email);
  const cookie = kind === "staff" ? await stepUpToMfa(slug, signed.cookie) : signed.cookie;
  return { cookie, membershipId: signed.membershipId, userId };
}

/** An operator session on the canonical host (the operator routes' guard is foundation's). */
async function operatorCookie(email: string): Promise<string> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: "Op" });
  await q("INSERT INTO core.platform_operator (user_id, created_by) VALUES ($1, 'cli:test')", [
    userId,
  ]);
  const minted = await running.container.auth.sessions.startSession({
    userId,
    population: "operator",
    context: "first_party",
    authLevel: 2,
  });
  return `__Host-op_sid=${minted.token}`;
}

/** Puts a plan on a workspace the way the control plane does (host context). */
async function assignPlan(slug: string, planId: string | null): Promise<void> {
  await running.container.db.withHost((tx) =>
    tx.execute(
      `UPDATE core.workspace SET plan_id = ${planId === null ? "NULL" : `'${planId}'`} WHERE id = '${ids[slug]}'`,
    ),
  );
  running.container.resolver.invalidate();
}

function invite(slug: string, email: string, kind: "staff" | "external", role: string) {
  return running.container.auth.invites.create({
    workspaceId: ids[slug] as string,
    email,
    kind,
    role: role as never,
    send: false,
  });
}

async function expectPlanLimit(p: Promise<unknown>, limit: string, max: number): Promise<void> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isPlanLimitError(error), String(error)).toBe(true);
  expect((error as { details: unknown }).details).toEqual({ limit, max });
}

async function pendingInvites(slug: string, kind: "staff" | "external"): Promise<number> {
  const r = await q<{ n: number }>(
    "SELECT count(*)::int AS n FROM core.invite WHERE workspace_id = $1 AND kind = $2 AND status = 'pending'",
    [ids[slug], kind],
  );
  return r[0]?.n ?? 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let op: string;
let acmeOwner: Actor;
let freeOwner: Actor;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      CONTROL_PLANE: "on",
      ROLES: "api,web",
      UPDATE_CHECK: "false",
      ...(POOL_MAX === undefined ? {} : { DATABASE_POOL_MAX: POOL_MAX }),
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  const db = running.container.db;
  for (const slug of ["acme", "free", "meter"]) {
    ids[slug] = (await createWorkspace(db, { slug, name: slug.toUpperCase() })).id;
  }
  op = await operatorCookie("op@platform.test");
  acmeOwner = await member("acme", "owner@acme.test", "staff", "owner");
  freeOwner = await member("free", "owner@free.test", "staff", "owner");
}, 300_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("plans (operator API)", () => {
  it("is no path at all without an operator session", async () => {
    for (const cookie of [undefined, acmeOwner.cookie]) {
      const res = await request(CANON, "/api/v1/platform/plans", { cookie });
      expect(res.status).toBe(404);
    }
  });

  it("creates, lists, changes at a version, archives — each audited on the platform chain", async () => {
    const created = await request(CANON, "/api/v1/platform/plans", {
      method: "POST",
      cookie: op,
      body: JSON.stringify({
        id: "starter",
        name: "Starter",
        limits: { staffSeats: 3, investorSeats: 2, customDomains: 1, storageBytes: 1_000 },
        trialDays: 14,
        public: true,
      }),
    });
    expect(created.status).toBe(201);
    const plan = await json<{ id: string; version: number; workspaces: number }>(created);
    expect(plan).toMatchObject({ id: "starter", version: 1, workspaces: 0 });

    const dup = await request(CANON, "/api/v1/platform/plans", {
      method: "POST",
      cookie: op,
      body: JSON.stringify({ id: "starter", name: "Again", limits: {} }),
    });
    expect(dup.status).toBe(409);

    const stale = await request(CANON, "/api/v1/platform/plans/starter", {
      method: "PATCH",
      cookie: op,
      body: JSON.stringify({ version: 7, name: "Nope" }),
    });
    expect(stale.status).toBe(409);
    expect((await json<ErrorBody>(stale)).error.code).toBe("version_conflict");

    const renamed = await request(CANON, "/api/v1/platform/plans/starter", {
      method: "PATCH",
      cookie: op,
      body: JSON.stringify({ version: 1, name: "Starter plan" }),
    });
    expect(renamed.status).toBe(200);
    expect(await json(renamed)).toMatchObject({ name: "Starter plan", version: 2 });

    const legacy = await request(CANON, "/api/v1/platform/plans", {
      method: "POST",
      cookie: op,
      body: JSON.stringify({ id: "legacy", name: "Legacy", limits: { staffSeats: 1 } }),
    });
    expect(legacy.status).toBe(201);
    const archived = await request(CANON, "/api/v1/platform/plans/legacy/archive", {
      method: "POST",
      cookie: op,
    });
    expect(archived.status).toBe(200);
    expect((await json<{ archivedAt: string | null }>(archived)).archivedAt).not.toBeNull();
    const missing = await request(CANON, "/api/v1/platform/plans/nosuch/archive", {
      method: "POST",
      cookie: op,
    });
    expect(missing.status).toBe(404);

    await assignPlan("acme", "starter");
    const list = await json<{ plans: { id: string; workspaces: number; archivedAt: unknown }[] }>(
      await request(CANON, "/api/v1/platform/plans", { cookie: op }),
    );
    expect(list.plans.map((p) => [p.id, p.workspaces, p.archivedAt === null])).toEqual([
      ["starter", 1, true],
      ["legacy", 0, false],
    ]);

    const audit = await q<{ action: string; actor_kind: string; meta: Record<string, unknown> }>(
      "SELECT action, actor_kind, meta FROM audit.event WHERE workspace_id = $1 AND action LIKE 'plan.%' ORDER BY seq",
      [PLATFORM_WORKSPACE_ID],
    );
    expect(audit.map((a) => [a.action, a.meta["planId"]])).toEqual([
      ["plan.create", "starter"],
      ["plan.update", "starter"],
      ["plan.create", "legacy"],
      ["plan.archive", "legacy"],
    ]);
    expect(audit.every((a) => a.actor_kind === "host" && a.meta["operator"] === true)).toBe(true);
  });

  it("keeps a plan's metered prices (create, patch, list); the database refuses a bad list", async () => {
    const created = await request(CANON, "/api/v1/platform/plans", {
      method: "POST",
      cookie: op,
      body: JSON.stringify({
        id: "metered",
        name: "Metered",
        limits: {},
        billingPriceRef: "price_base",
        billingMeteredPriceRefs: ["price_seats", "price_gb"],
      }),
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      billingMeteredPriceRefs: ["price_seats", "price_gb"],
    });
    const dup = await request(CANON, "/api/v1/platform/plans/metered", {
      method: "PATCH",
      cookie: op,
      body: JSON.stringify({ version: 1, billingMeteredPriceRefs: ["a", "a"] }),
    });
    expect(dup.status).toBe(400);
    const patched = await request(CANON, "/api/v1/platform/plans/metered", {
      method: "PATCH",
      cookie: op,
      body: JSON.stringify({ version: 1, billingMeteredPriceRefs: ["price_seats"] }),
    });
    expect(await json(patched)).toMatchObject({ billingMeteredPriceRefs: ["price_seats"] });
    const list = await json<{ plans: { id: string; billingMeteredPriceRefs: string[] }[] }>(
      await request(CANON, "/api/v1/platform/plans", { cookie: op }),
    );
    expect(list.plans.find((p) => p.id === "metered")?.billingMeteredPriceRefs).toEqual([
      "price_seats",
    ]);
    await expect(
      q("UPDATE core.plan SET billing_metered_price_refs = '{x,x}' WHERE id = 'metered'"),
    ).rejects.toThrow(/plan_metered_price_refs/u);
    await q("DELETE FROM core.plan WHERE id = 'metered'");
  });

  it("a price is a base price or a metered price, never both (fix round 3)", async () => {
    const make = (id: string, body: Record<string, unknown>) =>
      request(CANON, "/api/v1/platform/plans", {
        method: "POST",
        cookie: op,
        body: JSON.stringify({ id, name: id, limits: {}, ...body }),
      });
    expect((await make("base-a", { billingPriceRef: "price_A" })).status).toBe(201);
    // Another plan may not meter price_A …
    const clash = await make("meter-b", { billingMeteredPriceRefs: ["price_A"] });
    expect(clash.status).toBe(409);
    expect(await json(clash)).toMatchObject({
      error: { code: "conflict", reason: "price_ref_conflict", priceRef: "price_A" },
    });
    // … nor its own base price.
    expect(
      (await make("self-c", { billingPriceRef: "price_C", billingMeteredPriceRefs: ["price_C"] }))
        .status,
    ).toBe(409);
    // And the other way round: a metered price cannot become another plan's base.
    expect((await make("meter-d", { billingMeteredPriceRefs: ["price_D"] })).status).toBe(201);
    const patch = await request(CANON, "/api/v1/platform/plans/base-a", {
      method: "PATCH",
      cookie: op,
      body: JSON.stringify({ version: 1, billingPriceRef: "price_D" }),
    });
    expect(patch.status).toBe(409);
    await q("DELETE FROM core.plan WHERE id IN ('base-a', 'meter-d')");
  });
});

describe("staff seats", () => {
  it("counts live staff and pending staff invitations, and answers 402 plan_limit at the limit", async () => {
    // owner (1) + one invitation (2)
    const first = await tenant("acme", "/api/v1/access/invites", {
      method: "POST",
      cookie: acmeOwner.cookie,
      body: JSON.stringify({ kind: "staff", role: "viewer", invites: [{ email: "v1@acme.test" }] }),
    });
    expect(first.status).toBe(200);
    expect((await json<{ created: unknown[] }>(first)).created).toHaveLength(1);
    // Re-inviting the same address supersedes the pending invitation: no second seat.
    await invite("acme", "v1@acme.test", "staff", "viewer");
    expect(await pendingInvites("acme", "staff")).toBe(1);
  });

  it.skipIf(ONE_CONNECTION)(
    "serialises two invitations at the limit: the second counts the first",
    async () => {
      // One seat left (owner + v1 = 2 of 3). T1 writes an invitation and holds its transaction
      // open; T2 starts while T1 is open. Without the quota lock T2 would count 2, pass, and wait
      // only at its audit — both would commit and the workspace would hold 4 seats.
      const deps = running.container.identityDeps;
      const ctx = systemContext(ids["acme"] as string);
      let written!: () => void;
      const t1Written = new Promise<void>((r) => {
        written = r;
      });
      const t1 = running.container.db.withTenant(ctx, async (tx) => {
        await writeInvite(
          deps,
          ctx,
          tx,
          {
            workspaceId: ctx.workspaceId,
            email: "race-a@acme.test",
            kind: "staff",
            role: "viewer",
          },
          undefined,
        );
        written();
        await sleep(400);
      });
      await t1Written;
      const t2 = invite("acme", "race-b@acme.test", "staff", "viewer");
      await t1;
      await expectPlanLimit(t2, "staffSeats", 3);
      expect(await pendingInvites("acme", "staff")).toBe(2);
    },
  );

  it.skipIf(ONE_CONNECTION)(
    "lets exactly one of two concurrent invitations take the last seat",
    async () => {
      // Free a seat, then race for it.
      await q(
        "UPDATE core.invite SET status = 'revoked', revoked_at = now() WHERE email = 'race-a@acme.test'",
      );
      const results = await Promise.allSettled([
        invite("acme", "race-c@acme.test", "staff", "viewer"),
        invite("acme", "race-d@acme.test", "staff", "viewer"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected");
      expect(isPlanLimitError((rejected as PromiseRejectedResult).reason)).toBe(true);
    },
  );

  it("refuses over HTTP with the error envelope, and refuses SCIM/SSO provisioning", async () => {
    if (ONE_CONNECTION) {
      // The race tests did not run: fill the last seat here.
      await invite("acme", "fill@acme.test", "staff", "viewer");
    }
    const res = await tenant("acme", "/api/v1/access/invites", {
      method: "POST",
      cookie: acmeOwner.cookie,
      body: JSON.stringify({ kind: "staff", role: "viewer", invites: [{ email: "v9@acme.test" }] }),
    });
    expect(res.status).toBe(402);
    expect((await json<ErrorBody>(res)).error).toMatchObject({
      code: "plan_limit",
      limit: "staffSeats",
      max: 3,
    });
    await expectPlanLimit(
      running.container.auth.memberships.provisionStaff(
        systemContext(ids["acme"] as string),
        { email: "scim@acme.test", role: "viewer", source: "scim", status: "active" },
        { kind: "system", label: "scim:test" },
      ),
      "staffSeats",
      3,
    );
    // A deactivated SCIM user holds no seat, so provisioning one is not refused.
    const suspended = await running.container.auth.memberships.provisionStaff(
      systemContext(ids["acme"] as string),
      { email: "gone@acme.test", role: "viewer", source: "scim", status: "suspended" },
      { kind: "system", label: "scim:test" },
    );
    expect(suspended.adopted).toBe(false);
    // Nothing was written by the refusals: no membership, no invitation, no audit row.
    const leaked = await q(
      "SELECT 1 FROM core.invite WHERE email IN ('v9@acme.test') UNION ALL SELECT 1 FROM core.membership m JOIN core.user_identity i ON i.user_id = m.user_id WHERE i.identifier = 'scim@acme.test'",
    );
    expect(leaked).toEqual([]);
  });

  /*
   * FR1 (R3-M3): a suspended member holds no seat, so reactivating one takes a seat back and is
   * checked like an invitation. The workspace is at its limit here (the tests above filled it)
   * and holds the suspended `gone@acme.test`.
   */
  const goneMembership = async (): Promise<string> => {
    const r = await q<{ id: string }>(
      "SELECT m.id FROM core.membership m JOIN core.user_identity i ON i.user_id = m.user_id WHERE i.identifier = 'gone@acme.test' AND m.workspace_id = $1",
      [ids["acme"]],
    );
    return r[0]?.id as string;
  };
  const unsuspendGone = async (options: { tx?: Tx } = {}) =>
    running.container.auth.memberships.unsuspend(
      systemContext(ids["acme"] as string),
      { membershipId: await goneMembership() },
      { kind: "system", label: "scim:test" },
      options,
    );
  const goneStatus = async () =>
    (
      await q<{ status: string }>("SELECT status FROM core.membership WHERE id = $1", [
        await goneMembership(),
      ])
    )[0]?.status;
  /** Frees one staff seat (withdraws one pending staff invitation of the tests above). */
  const freeOneSeat = () =>
    q(
      `UPDATE core.invite SET status = 'revoked', revoked_at = now()
        WHERE id = (SELECT id FROM core.invite WHERE workspace_id = $1 AND kind = 'staff'
                      AND status = 'pending' ORDER BY created_at LIMIT 1)`,
      [ids["acme"]],
    );

  it("refuses to reactivate a suspended member at the seat limit (R3-M3)", async () => {
    await expectPlanLimit(unsuspendGone(), "staffSeats", 3);
    expect(await goneStatus()).toBe("suspended");
  });

  it.skipIf(ONE_CONNECTION)(
    "serialises a reactivation against an invitation for the last seat, in either order, without deadlock",
    async () => {
      const deps = running.container.identityDeps;
      const ctx = systemContext(ids["acme"] as string);
      const hold = async (first: (tx: Tx) => Promise<unknown>, second: () => Promise<unknown>) => {
        let written!: () => void;
        const t1Written = new Promise<void>((r) => {
          written = r;
        });
        const t1 = running.container.db.withTenant(ctx, async (tx) => {
          await first(tx);
          written();
          await sleep(400);
        });
        await t1Written;
        const t2 = second();
        await t1;
        return t2;
      };

      // Invitation first, held open: the reactivation waits on the workspace row, then counts it.
      await freeOneSeat();
      await expectPlanLimit(
        hold(
          (tx) =>
            writeInvite(
              deps,
              ctx,
              tx,
              {
                workspaceId: ctx.workspaceId,
                email: "last-a@acme.test",
                kind: "staff",
                role: "viewer",
              },
              undefined,
            ),
          () => unsuspendGone(),
        ),
        "staffSeats",
        3,
      );
      expect(await goneStatus()).toBe("suspended");

      // Reactivation first (membership row, then the workspace row), held open: the invitation
      // waits and counts the member. Opposite order of the two paths' first locks — a deadlock
      // here would surface as 40P01, not plan_limit.
      await freeOneSeat();
      await expectPlanLimit(
        hold(
          (tx) => unsuspendGone({ tx }),
          () => invite("acme", "last-b@acme.test", "staff", "viewer"),
        ),
        "staffSeats",
        3,
      );
      expect(await goneStatus()).toBe("active");

      // Both at once for one free seat: exactly one wins, the other is plan_limit (not 40P01).
      await running.container.auth.memberships.suspend(
        ctx,
        { membershipId: await goneMembership(), reason: "test" },
        { kind: "system", label: "scim:test" },
      );
      const results = await Promise.allSettled([
        unsuspendGone(),
        invite("acme", "last-c@acme.test", "staff", "viewer"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(isPlanLimitError(rejected.reason), String(rejected.reason)).toBe(true);
    },
  );
});

describe("investor seats", () => {
  it("counts investor invitations, access-request approvals and share-link visitors", async () => {
    // 1 of 2: an ordinary investor invitation.
    await invite("acme", "inv1@fund.test", "external", "investor");
    // 2 of 2: an approved access request (the same invitation code path, on the approval's tx).
    const [req] = await q<{ id: string }>(
      "INSERT INTO core.access_request (workspace_id, email, name, status, verified_at, expires_at) VALUES ($1, 'req@fund.test', 'Req', 'pending', now(), now() + interval '7 days') RETURNING id",
      [ids["acme"]],
    );
    const ws = await findWorkspaceById(running.container.db, ids["acme"] as string);
    if (ws === undefined) throw new Error("no workspace");
    const approve = (id: string) =>
      running.container.accessRequests.approve(systemContext(ids["acme"] as string), {
        id,
        actorMembershipId: acmeOwner.membershipId,
        workspace: ws,
        groupIds: [],
      });
    await approve(req?.id as string);
    expect(await pendingInvites("acme", "external")).toBe(2);
    // 3 of 2: another approval is refused, and the request stays pending.
    const [req2] = await q<{ id: string }>(
      "INSERT INTO core.access_request (workspace_id, email, name, status, verified_at, expires_at) VALUES ($1, 'req2@fund.test', 'Req2', 'pending', now(), now() + interval '7 days') RETURNING id",
      [ids["acme"]],
    );
    await expectPlanLimit(approve(req2?.id as string), "investorSeats", 2);
    expect(
      (
        await q<{ status: string }>("SELECT status FROM core.access_request WHERE id = $1", [
          req2?.id,
        ])
      )[0]?.status,
    ).toBe("pending");
    // And so is a plain third investor invitation.
    await expectPlanLimit(
      invite("acme", "inv3@fund.test", "external", "investor"),
      "investorSeats",
      2,
    );
  });

  it("refuses a share-link redemption that would create an investor membership", async () => {
    // Share links need an offering mode that permits them (a precondition, not this epic's).
    const offering = await tenant("acme", "/api/v1/compliance/offering", {
      method: "PATCH",
      cookie: acmeOwner.cookie,
      body: JSON.stringify({ status: "506c", confirm: "506c", reason: "raising" }),
    });
    expect(offering.status).toBe(200);
    const minted = await tenant("acme", "/api/v1/links", {
      method: "POST",
      cookie: acmeOwner.cookie,
      body: JSON.stringify({ label: "Deck" }),
    });
    expect(minted.status, await minted.clone().text()).toBe(200);
    const { token } = await json<{ token: string }>(minted);
    const email = "visitor@fund.test";
    const since = mailer.sent.length;
    const start = await tenant("acme", `/api/v1/links/${token}/start`, {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    expect(start.status).toBe(200);
    const code = await awaitSignInCode(mailer, email, since);
    const verified = await tenant("acme", `/api/v1/links/${token}/verify`, {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    expect(verified.status).toBe(402);
    expect((await json<ErrorBody>(verified)).error).toMatchObject({
      code: "plan_limit",
      limit: "investorSeats",
    });
    const rows = await q(
      "SELECT 1 FROM core.membership m JOIN core.user_identity i ON i.user_id = m.user_id WHERE m.workspace_id = $1 AND i.identifier = $2",
      [ids["acme"], email],
    );
    expect(rows).toEqual([]);
  });
});

describe("custom domains and storage", () => {
  it("refuses a custom domain past the plan's count", async () => {
    const add = (hostname: string) =>
      tenant("acme", "/api/v1/domains", {
        method: "POST",
        cookie: acmeOwner.cookie,
        body: JSON.stringify({ hostname }),
      });
    expect((await add("invest.acme-example.com")).status).toBe(201);
    const second = await add("ir.acme-example.com");
    expect(second.status).toBe(402);
    expect((await json<ErrorBody>(second)).error).toMatchObject({
      code: "plan_limit",
      limit: "customDomains",
      max: 1,
    });
    // A failed row claims nothing.
    await q(
      "UPDATE core.custom_domain SET status = 'failed' WHERE hostname = 'invest.acme-example.com'",
    );
    expect((await add("ir.acme-example.com")).status).toBe(201);

    // E3.10 FR1 (R3-L3): "Verify now" on the failed row would reopen it into a counted state —
    // the same quota, refused the same way, and the row stays failed.
    const [failed] = await q<{ id: string }>(
      "SELECT id FROM core.custom_domain WHERE hostname = 'invest.acme-example.com'",
    );
    const reopen = await tenant("acme", `/api/v1/domains/${failed?.id}/verify`, {
      method: "POST",
      cookie: acmeOwner.cookie,
    });
    expect(reopen.status).toBe(402);
    expect((await json<ErrorBody>(reopen)).error).toMatchObject({
      code: "plan_limit",
      limit: "customDomains",
    });
    const [still] = await q<{ status: string }>(
      "SELECT status FROM core.custom_domain WHERE hostname = 'invest.acme-example.com'",
    );
    expect(still?.status).toBe("failed");
  });

  it("refuses an upload whose declared size would pass the stored bytes of the latest usage row", async () => {
    const today = utcDay(new Date());
    await q(
      "INSERT INTO core.tenant_usage_daily (workspace_id, day, storage_bytes, computed_at) VALUES ($1, $2, 600, now())",
      [ids["acme"], today],
    );
    const tree = await json<{ rootId: string }>(
      await tenant("acme", "/api/v1/data-room/tree", { cookie: acmeOwner.cookie }),
    );
    const folder = await tenant("acme", "/api/v1/data-room/folders", {
      method: "POST",
      cookie: acmeOwner.cookie,
      body: JSON.stringify({ parentId: tree.rootId, name: "Quota" }),
    });
    expect(folder.status).toBe(201);
    const folderId = (await json<{ folders: { id: string; name: string }[] }>(folder)).folders.find(
      (f) => f.name === "Quota",
    )?.id;
    const start = (size: number) =>
      tenant("acme", "/api/v1/data-room/uploads", {
        method: "POST",
        cookie: acmeOwner.cookie,
        body: JSON.stringify({ fileName: "a.pdf", size, contentType: "application/pdf", folderId }),
      });
    expect((await start(400)).status).toBe(201);
    // R3-L4: the open (unfinished) upload's declared 400 counts: 600 + 400 + 1 > 1 000.
    const over = await start(1);
    expect(over.status).toBe(402);
    expect((await json<ErrorBody>(over)).error).toMatchObject({
      code: "plan_limit",
      limit: "storageBytes",
      max: 1_000,
    });
    // Once it is no longer open (failed, expired), its bytes are free again.
    await q("UPDATE dataroom.upload SET status = 'failed' WHERE workspace_id = $1", [ids["acme"]]);
    expect((await start(400)).status).toBe(201);
    await q(
      "UPDATE dataroom.upload SET expires_at = now() - interval '1 minute' WHERE workspace_id = $1",
      [ids["acme"]],
    );
    expect((await start(400)).status).toBe(201);
    await q("UPDATE dataroom.upload SET status = 'failed' WHERE workspace_id = $1", [ids["acme"]]);

    // Two parallel starts for the last 400 bytes: the quota lock (the workspace row) serialises
    // them, so the second counts the first's open upload.
    if (!ONE_CONNECTION) {
      const raced = await Promise.all([start(400), start(400)]);
      expect(raced.map((r) => r.status).sort()).toEqual([201, 402]);
      await q("UPDATE dataroom.upload SET status = 'failed' WHERE workspace_id = $1", [
        ids["acme"],
      ]);
    }
  });
});

describe("a workspace without a plan (self-host)", () => {
  it("is limited nowhere, whatever it adds", async () => {
    for (let i = 0; i < 5; i++) await invite("free", `s${i}@free.test`, "staff", "viewer");
    for (let i = 0; i < 4; i++) await invite("free", `i${i}@fund.test`, "external", "investor");
    for (const h of ["a.free-example.com", "b.free-example.com"]) {
      const res = await tenant("free", "/api/v1/domains", {
        method: "POST",
        cookie: freeOwner.cookie,
        body: JSON.stringify({ hostname: h }),
      });
      expect(res.status).toBe(201);
    }
    await q(
      "INSERT INTO core.tenant_usage_daily (workspace_id, day, storage_bytes, computed_at) VALUES ($1, $2, 1000000000, now())",
      [ids["free"], utcDay(new Date())],
    );
    const tree = await json<{ rootId: string }>(
      await tenant("free", "/api/v1/data-room/tree", { cookie: freeOwner.cookie }),
    );
    const up = await tenant("free", "/api/v1/data-room/uploads", {
      method: "POST",
      cookie: freeOwner.cookie,
      body: JSON.stringify({
        fileName: "big.pdf",
        size: 5_000_000,
        contentType: "application/pdf",
        folderId: tree.rootId,
      }),
    });
    expect(up.status).toBe(201);
  });

  it("CONTROL_PLANE=off wires the pass-through quota and no jobs, even for a workspace with a plan", async () => {
    const off = createUsageWiring({
      db: running.container.db,
      registry: running.container.registry,
      controlPlaneEnabled: false,
      now: () => new Date(),
      log: () => () => {},
    } as unknown as Parameters<typeof createUsageWiring>[0]);
    expect(off.quota).toBe(UNLIMITED_QUOTA);
    expect(off.jobs).toEqual([]);
    await running.container.db.withTenant(systemContext(ids["acme"] as string), (tx) =>
      off.quota.check(tx, { workspaceId: ids["acme"] as string, kind: "staffSeats", delta: 100 }),
    );
    // The control-plane install registers both schedules.
    expect(running.container.controlPlane.usage.jobs.map((j) => j.name)).toEqual([
      USAGE_ROLLUP_JOB,
      USAGE_ROLLUP_TODAY_JOB,
    ]);
  });
});

describe("usage rollup", () => {
  it("meters seats, domains, mail and the modules' hooks, and drops rows past 400 days", async () => {
    const ws = ids["meter"] as string;
    const today = utcDay(new Date());
    await member("meter", "owner@meter.test", "staff", "owner");
    const deps = running.container.identityDeps;
    const people: [string, "staff" | "external", string, string][] = [
      ["viewer@meter.test", "staff", "viewer", "active"],
      ["susp@meter.test", "staff", "viewer", "suspended"],
      ["inv1@meter.test", "external", "investor", "active"],
      ["inv2@meter.test", "external", "investor", "invited"],
      ["gone@meter.test", "external", "investor", "active"],
    ];
    for (const [email, kind, role] of people) {
      const { userId } = await provisionUser(deps, { email });
      await provisionMembership(deps, {
        workspaceId: ws,
        userId,
        kind,
        role: role as never,
        source: "test",
      });
    }
    await q(
      "UPDATE core.membership m SET status = 'suspended' FROM core.user_identity i WHERE i.user_id = m.user_id AND i.identifier = 'susp@meter.test'",
    );
    await q(
      "UPDATE core.membership m SET status = 'invited' FROM core.user_identity i WHERE i.user_id = m.user_id AND i.identifier = 'inv2@meter.test'",
    );
    await q(
      "UPDATE core.membership m SET status = 'revoked', revoked_at = now() FROM core.user_identity i WHERE i.user_id = m.user_id AND i.identifier = 'gone@meter.test'",
    );
    // Domains: one pending, one failed (not counted), one deleted (not counted).
    await q(
      `INSERT INTO core.custom_domain (workspace_id, hostname, token, status, deleted_at) VALUES
         ($1, 'a.meter-example.com', 'tttttttttttttttttttt', 'pending', NULL),
         ($1, 'b.meter-example.com', 'tttttttttttttttttttt', 'failed', NULL),
         ($1, 'c.meter-example.com', 'tttttttttttttttttttt', 'pending', now())`,
      [ws],
    );
    // Mail: two today, one yesterday.
    await q(
      `INSERT INTO core.mail_message (workspace_id, provider, provider_message_id, stream, sent_at) VALUES
         ($1, 'meter-test', 'meter-1', 'transactional', now()),
         ($1, 'meter-test', 'meter-2', 'notification', now()),
         ($1, 'meter-test', 'meter-3', 'transactional', now() - interval '1 day')`,
      [ws],
    );
    // Data room bytes (the module disabled here: its stored bytes still count) and views.
    await q(
      "INSERT INTO core.module_enablement (workspace_id, module, enabled) VALUES ($1, 'data-room', false) ON CONFLICT (workspace_id, module) DO UPDATE SET enabled = false",
      [ws],
    );
    await q(
      `INSERT INTO dataroom.blob (workspace_id, sha256, size_bytes, content_type, storage_key) VALUES
         ($1, decode(repeat('01', 32), 'hex'), 1000, 'application/pdf', 'k1'),
         ($1, decode(repeat('02', 32), 'hex'), 234, 'application/pdf', 'k2')`,
      [ws],
    );
    const resource = "00000000-0000-7000-8000-00000000abcd";
    await q(
      `INSERT INTO analytics.event (workspace_id, occurred_at, membership_id, type, resource_kind, resource_id) VALUES
         ($1, now(), $2, 'document_viewed', 'document', $2),
         ($1, now(), $2, 'document_viewed', 'document', $2),
         ($1, now(), $2, 'document_downloaded', 'document', $2),
         ($1, now() - interval '1 day', $2, 'document_viewed', 'document', $2)`,
      [ws, resource],
    );
    // Retention: 401 days old goes, 399 stays.
    await q(
      "INSERT INTO core.tenant_usage_daily (workspace_id, day, computed_at) VALUES ($1, $2, now()), ($1, $3, now())",
      [ws, addDays(today, -401), addDays(today, -399)],
    );

    const result = await running.container.controlPlane.usage.rollup();
    expect(result.failed).toBe(0);
    expect(result.workspaces).toBeGreaterThanOrEqual(3);
    expect(result.deleted).toBe(1);

    const [row] = await q<Record<string, unknown>>(
      "SELECT storage_bytes::int AS storage, docs_viewed, emails_sent, staff_seats, investor_seats, custom_domains FROM core.tenant_usage_daily WHERE workspace_id = $1 AND day = $2",
      [ws, today],
    );
    expect(row).toEqual({
      storage: 1_234,
      docs_viewed: 2,
      emails_sent: 2 + (await mailToday(ws)),
      staff_seats: 2,
      investor_seats: 2,
      custom_domains: 1,
    });
    const days = await q<{ day: string }>(
      "SELECT day::text AS day FROM core.tenant_usage_daily WHERE workspace_id = $1 ORDER BY day",
      [ws],
    );
    expect(days.map((d) => d.day)).toEqual([addDays(today, -399), today]);

    // Re-running overwrites the same (workspace, day) row rather than adding one.
    await running.container.controlPlane.usage.rollup({ workspaceId: ws });
    expect(
      (
        await q("SELECT 1 FROM core.tenant_usage_daily WHERE workspace_id = $1 AND day = $2", [
          ws,
          today,
        ])
      ).length,
    ).toBe(1);
  });

  it("serves the usage to the tenant's billing readers and to operators", async () => {
    const mine = await tenant("acme", "/api/v1/usage", { cookie: acmeOwner.cookie });
    expect(mine.status).toBe(200);
    const body = await json<{
      plan: { id: string; limits: Record<string, number> } | null;
      today: { day: string; staffSeats: number } | null;
      last30: { day: string }[];
    }>(mine);
    expect(body.plan).toMatchObject({ id: "starter", limits: { staffSeats: 3 } });
    expect(body.today?.day).toBe(utcDay(new Date()));
    expect(body.last30.at(-1)?.day).toBe(utcDay(new Date()));

    const noPlan = await json<{ plan: unknown }>(
      await tenant("free", "/api/v1/usage", { cookie: freeOwner.cookie }),
    );
    expect(noPlan.plan).toBeNull();

    const viaOperator = await request(CANON, `/api/v1/platform/workspaces/${ids["acme"]}/usage`, {
      cookie: op,
    });
    expect(viaOperator.status).toBe(200);
    expect(await json(viaOperator)).toEqual(body);
    const unknown = await request(
      CANON,
      "/api/v1/platform/workspaces/00000000-0000-7000-8000-00000000ffff/usage",
      { cookie: op },
    );
    expect(unknown.status).toBe(404);

    // Not a billing reader: the permission answer comes first.
    const investor = await member("acme", "reader@fund.test", "external", "investor");
    expect((await tenant("acme", "/api/v1/usage", { cookie: investor.cookie })).status).toBe(404);

    // CONTROL_PLANE=off: the route is not there (after the permission guard).
    const cp = running.container.controlPlane as { enabled: boolean };
    cp.enabled = false;
    try {
      const res = await tenant("acme", "/api/v1/usage", { cookie: acmeOwner.cookie });
      expect(res.status).toBe(404);
      // The gate's own message, not the authz guard's "no such path" (the sweep's distinction).
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
        "usage is not tracked on this install",
      );
    } finally {
      cp.enabled = true;
    }
  });
});

/** Mail the kernel itself recorded for `workspaceId` today (sign-in codes of the setup). */
async function mailToday(workspaceId: string): Promise<number> {
  const r = await q<{ n: number }>(
    "SELECT count(*)::int AS n FROM core.mail_message WHERE workspace_id = $1 AND sent_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND provider <> 'meter-test'",
    [workspaceId],
  );
  return r[0]?.n ?? 0;
}

// E3.10 FR1 (R1-L2), here because this file runs with CONTROL_PLANE=on: the canonical host is the
// operator console's origin and serves no tenant content under `/w/<slug>`.
describe("the canonical host with the control plane on", () => {
  it("308s a /w/<slug> page to the slug host (path and query kept) and 404s its API", async () => {
    const page = await request(CANON, "/w/acme/documents?tab=2", {
      headers: { accept: "text/html" },
    });
    expect(page.status).toBe(308);
    expect(page.headers.get("location")).toBe(`https://acme.${CANON}/documents?tab=2`);
    // FR3: the path goes across as it came, still percent-encoded (an encoded `/` or `?` is not
    // decoded into a separator on the way).
    const encoded = await request(CANON, "/w/acme/docs/a%2Fb%3Fc%20d?x=1", {
      headers: { accept: "text/html" },
    });
    expect(encoded.status).toBe(308);
    expect(encoded.headers.get("location")).toBe(`https://acme.${CANON}/docs/a%2Fb%3Fc%20d?x=1`);
    // Same answer for a slug that does not exist: no lookup, no oracle.
    const unknown = await request(CANON, "/w/no-such-ws/", { headers: { accept: "text/html" } });
    expect(unknown.status).toBe(308);
    expect(unknown.headers.get("location")).toBe(`https://no-such-ws.${CANON}/`);
    // The API never answers there, even for a signed-in member.
    const api = await request(CANON, "/w/acme/api/v1/me", { cookie: acmeOwner.cookie });
    expect(api.status).toBe(404);
    // The slug host itself serves as always.
    expect((await tenant("acme", "/api/v1/me", { cookie: acmeOwner.cookie })).status).toBe(200);
  });
});
