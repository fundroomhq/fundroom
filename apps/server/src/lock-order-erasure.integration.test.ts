import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryESignAdapter } from "@fundroom/esign/testing";
import { isAuthError } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { expireExports } from "@fundroom/portability";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  deadlocks,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
} from "./test/esign-harness.js";
import { purgeDeletedWorkspaces } from "./workspace/lifecycle.js";

/*
 * E3.5 R3B: the erasure paths against the global lock order (lock-order.integration.test.ts,
 * contract LX): entity rows → workspace row → chain.
 *
 * An erasure completion (`DsarRequestRepo.lockById` → the kernel identity step) took the
 * workspace row and the chain first and only then the rows the identity step writes — the owner
 * rows (`identityBlockedBy` → `lockOwners`), the member's access requests and the address's
 * challenges, … — which ownership transfer, access-request deny and verify lock BEFORE the
 * workspace row. Now `prelockErasureSubject` takes them all up front. Verify itself consumed the
 * challenges before locking the pending request (the reverse of erasure's order), and the export
 * expiry sweep wrote export rows before the workspace row a purge holds FOR UPDATE while it
 * deletes them.
 *
 * Each case is a deterministic interleave: holder transactions pin the lock the contenders queue
 * on, the contenders are started one at a time and waited for until they block, then the holders
 * let go. With the old orders each case ends in a 40P01 (`pg_stat_database.deadlocks` moves).
 */
let pg0: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const mem = createMemoryESignAdapter("docuseal");
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql } = h;

// pg_stat counters reach the view at most once a second
const settle = () => new Promise((r) => setTimeout(r, 1_300));

interface Ws {
  id: string;
  slug: string;
  owner: Actor;
}

let seq = 0;
async function workspace(prefix: string): Promise<Ws> {
  seq += 1;
  const slug = `${prefix}${seq}`;
  const id = (await createWorkspace(running.container.db, { slug, name: `Ws ${slug}` })).id;
  const owner = await member(slug, id, `owner@${slug}.test`, "staff", "owner");
  return { id, slug, owner };
}

type Outcome = { ok: true; status: number; text: string } | { ok: false; error: string };

async function outcome(p: Promise<unknown>): Promise<Outcome> {
  try {
    const r = await p;
    if (!(r instanceof Response)) return { ok: true, status: 200, text: "" };
    return { ok: true, status: r.status, text: r.status >= 300 ? await r.text() : "" };
  } catch (error) {
    return { ok: false, error: String((error as Error).message ?? error) };
  }
}

/** Distinct backends (other than the holders) waiting on an ungranted lock. */
async function blocked(holders: readonly number[]): Promise<number> {
  const { rows } = await pg0.pool.query<{ n: number }>(
    "SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted AND NOT (pid = ANY($1))",
    [holders],
  );
  return rows[0]?.n ?? 0;
}

async function until(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const blockedAtLeast = (holders: readonly number[], n: number) =>
  until(`${n} blocked backends`, async () => (await blocked(holders)) >= n);

/** A holder transaction on its own connection. */
const connect = () => pg0.pool.connect();
type Client = Awaited<ReturnType<typeof connect>>;

async function holder(): Promise<{ c: Client; pid: number }> {
  const c = await connect();
  await c.query("BEGIN");
  await c.query("SET LOCAL lock_timeout = '30s'");
  const [{ pid }] = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows as [
    { pid: number },
  ];
  return { c, pid };
}

async function release(hd: { c: Client }): Promise<void> {
  try {
    await hd.c.query("COMMIT");
  } finally {
    hd.c.release();
  }
}

/**
 * Pins the erasure request's own row in a holder transaction, starts the erasure completion —
 * which takes the workspace row and the chain (`lockById`) and then queues on that row — and
 * then each other contender in turn, waiting until each one blocks; then lets go. So the
 * completion is guaranteed to hold the workspace row while the others line up behind whatever
 * they lock first (the workspace row itself is not pinned: a contender that already holds a
 * `KEY SHARE` on it from a foreign-key insert would skip the tuple-lock queue and could win it).
 * Returns every outcome and asserts no deadlock was detected meanwhile.
 */
async function lineUp(
  erasure: { id: string; complete: () => Promise<unknown> },
  others: readonly (() => Promise<unknown>)[],
): Promise<Outcome[]> {
  await settle();
  const before = await deadlocks(pg0.pool);
  const hd = await holder();
  const pending: Promise<Outcome>[] = [];
  try {
    await hd.c.query("SELECT 1 FROM core.dsar_request WHERE id = $1 FOR UPDATE", [erasure.id]);
    for (const [i, start] of [erasure.complete, ...others].entries()) {
      pending.push(outcome(start()));
      await blockedAtLeast([hd.pid], i + 1);
    }
  } finally {
    await release(hd);
  }
  const out = await Promise.all(pending);
  await settle();
  expect(await deadlocks(pg0.pool), "a deadlock was detected").toBe(before);
  return out;
}

function expectOk(o: Outcome | undefined, allowed: readonly number[] = []): void {
  if (o === undefined) throw new Error("no outcome");
  if (!o.ok) throw new Error(o.error);
  if (!allowed.includes(o.status)) expect(o.status, o.text).toBeLessThan(300);
}

/**
 * An erasure request for `membershipId` with every expected module but the last one reported;
 * returns the last module's report — the call that completes the request and runs the kernel's
 * identity step (`completeStep` → `lockById` → `complete`), exactly as that module's subscriber
 * would.
 */
async function erasureReadyToComplete(ws: Ws, membershipId: string) {
  const res = await request(ws.slug, "/api/v1/compliance/erasure-requests", {
    method: "POST",
    cookie: ws.owner.cookie,
    body: JSON.stringify({ membershipId }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  const { id, expectedModules } = await json<{ id: string; expectedModules: string[] }>(res);
  expect(expectedModules.length).toBeGreaterThan(0);
  const ctx = systemContext(ws.id);
  const report = (module: string) =>
    running.container.db.withTenant(ctx, (tx) =>
      running.container.moduleServices.legal.completeErasureStep(tx, ctx, id, module, {}),
    );
  for (const m of expectedModules.slice(0, -1)) await report(m);
  const last = expectedModules.at(-1) as string;
  return {
    id: id as string,
    complete: () => report(last),
    status: async () =>
      (
        await sql<{ status: string }>(
          ws.id,
          `SELECT status FROM core.dsar_request WHERE id = '${id}'`,
        )
      )[0]?.status,
  };
}

beforeAll(async () => {
  pg0 = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  running = await startServer({
    // No worker: the outbox is not dispatched, so no module subscriber reports on its own.
    config: esignTestConfig(freshSecrets(pg0.connectionString), { ROLES: "api" }),
    logger: createLogger({ level: "error" }),
    mailer,
    esignAdapters: { docuseal: mem.definition },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg0?.stop();
});

describe("erasure completion vs the paths that lock the identity step's rows first", () => {
  it("vs ownership transfer (the owner rows)", async () => {
    const ws = await workspace("rea");
    const admin = await member(ws.slug, ws.id, `admin@${ws.slug}.test`, "staff", "admin");
    const inv = await member(ws.slug, ws.id, `inv@${ws.slug}.test`, "external", "investor");
    const erasure = await erasureReadyToComplete(ws, inv.membershipId);
    const transfer = () =>
      request(ws.slug, "/api/v1/access/ownership/transfer", {
        method: "POST",
        cookie: ws.owner.cookie,
        body: JSON.stringify({ toMembershipId: admin.membershipId, confirm: ws.slug }),
      });
    // Before R3B the completion held the workspace row and the chain with none of the owner rows,
    // then waited for the owner rows the transfer held while the transfer waited for the
    // workspace row (its audit). Now the completion takes the owner rows first.
    const [done, moved] = await lineUp(erasure, [transfer]);
    expectOk(done);
    expectOk(moved);
    expect(await erasure.status()).toBe("completed");
    const [row] = await sql<{ role: string }>(
      ws.id,
      `SELECT role FROM core.membership WHERE id = '${admin.membershipId}'`,
    );
    expect(row?.role).toBe("owner");
  }, 120_000);

  it("vs access-request deny (the address's pending request)", async () => {
    const ws = await workspace("reb");
    const email = `inv@${ws.slug}.test`;
    const inv = await member(ws.slug, ws.id, email, "external", "investor");
    const [ar] = await sql<{ id: string }>(
      ws.id,
      `INSERT INTO core.access_request (workspace_id, email, name, status, verified_at, expires_at)
       VALUES ('${ws.id}', '${email}', 'Inv', 'pending', now(), now() + interval '30 days')
       RETURNING id`,
    );
    const erasure = await erasureReadyToComplete(ws, inv.membershipId);
    const deny = () =>
      request(ws.slug, `/api/v1/access/requests/${ar?.id}/deny`, {
        method: "POST",
        cookie: ws.owner.cookie,
        body: JSON.stringify({}),
      });
    // Before R3B the completion held the workspace row and then wanted the request row the deny
    // held while the deny waited for the workspace row (its audit).
    const [done, denied] = await lineUp(erasure, [deny]);
    expectOk(done);
    // The erasure went first and closed the request (`expired`): the deny then answers 409.
    expectOk(denied, [409]);
    expect(await erasure.status()).toBe("completed");
    const [row] = await sql<{ status: string; email: string }>(
      ws.id,
      `SELECT status, email::text AS email FROM core.access_request WHERE id = '${ar?.id}'`,
    );
    expect(row?.status).toBe("expired");
    expect(row?.email).toMatch(/^erased\+[0-9a-f]{32}@erased\.invalid$/u);
  }, 120_000);

  it("vs access-request verify (the pending request and the address's challenges)", async () => {
    const ws = await workspace("rec");
    const email = `inv@${ws.slug}.test`;
    const enable = await request(ws.slug, "/api/v1/access/settings", {
      method: "PATCH",
      cookie: ws.owner.cookie,
      body: JSON.stringify({
        requests: {
          enabled: true,
          autoApproveDomains: [],
          defaultGroupIds: [],
          pendingExpiryDays: 30,
        },
      }),
    });
    expect(enable.status, await enable.clone().text()).toBe(200);
    running.container.moduleServices.workspaces.invalidate(ws.id);
    // A code mailed while the address was not yet a member (a member gets a sign-in hint), then
    // the person joins; the queue also holds a pending request for the address.
    const since = mailer.sent.length;
    const start = await request(ws.slug, "/api/v1/access-requests/start", {
      method: "POST",
      body: JSON.stringify({ email, name: "Inv" }),
    });
    expect(start.status, await start.clone().text()).toBe(202);
    await until("the access-request code mail", async () =>
      mailer.sent
        .slice(since)
        .some((m) => m.to === email && m.template?.name === "auth.access_request_code"),
    );
    const mail = mailer.sent
      .slice(since)
      .find((m) => m.to === email && m.template?.name === "auth.access_request_code");
    const code = String(mail?.template?.props?.["code"] ?? "");
    expect(code).toMatch(/^\d{6}$/u);
    const [challenge] = await sql<{ id: string }>(
      ws.id,
      `SELECT id FROM core.access_request_challenge WHERE email = '${email}'`,
    );
    expect(challenge).toBeDefined();
    await sql(
      ws.id,
      `INSERT INTO core.access_request (workspace_id, email, name, status, verified_at, expires_at)
       VALUES ('${ws.id}', '${email}', 'Inv', 'pending', now(), now() + interval '30 days')`,
    );
    const inv = await member(ws.slug, ws.id, email, "external", "investor");
    // Every transaction that can complete the erasure consumes the address's challenges up
    // front (`prelockForErasure`: they cannot be row-locked), the request and the earlier
    // module reports included — so the code is put back as it was, as if mailed just now.
    const { rows: saved } = await pg0.pool.query<{ r: unknown }>(
      "SELECT to_jsonb(c) AS r FROM core.access_request_challenge c WHERE id = $1",
      [challenge?.id],
    );
    const erasure = await erasureReadyToComplete(ws, inv.membershipId);
    await pg0.pool.query(
      `INSERT INTO core.access_request_challenge
       SELECT * FROM jsonb_populate_record(NULL::core.access_request_challenge, $1::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(saved[0]?.r)],
    );

    await settle();
    const before = await deadlocks(pg0.pool);
    // H1 pins the challenge row: verify's write transaction queues on it (after its read-only
    // steps, which do not touch it).
    const h1 = await holder();
    await h1.c.query("SELECT 1 FROM core.access_request_challenge WHERE id = $1 FOR UPDATE", [
      challenge?.id,
    ]);
    const verify = outcome(
      request(ws.slug, "/api/v1/access-requests/verify", {
        method: "POST",
        body: JSON.stringify({ email, code }),
      }),
    );
    await blockedAtLeast([h1.pid], 1).catch(async (error: unknown) => {
      await release(h1);
      throw new Error(`${String(error)}; verify: ${JSON.stringify(await verify)}`);
    });
    // H2 pins the workspace row: the erasure completion queues behind it (or, with the pre-lock,
    // on the request row verify holds).
    const h2 = await holder();
    await h2.c.query("SELECT 1 FROM core.workspace WHERE id = $1 FOR NO KEY UPDATE", [ws.id]);
    const done = outcome(erasure.complete());
    await blockedAtLeast([h1.pid, h2.pid], 2);
    // Let verify have the challenges: it goes on to the workspace row (`freshWorkspace`).
    await release(h1);
    await until("verify waiting for the workspace row", async () => {
      const { rows } = await pg0.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%offering_status%'
            AND query ILIKE '%"core"."workspace"%'`,
      );
      return (rows[0]?.n ?? 0) >= 1;
    }).catch(async (error: unknown) => {
      // With verify's old order and the pre-lock, the two meet at the challenges instead.
      await release(h2);
      throw error;
    });
    await release(h2);
    const [v, d] = await Promise.all([verify, done]);
    await settle();
    expect(await deadlocks(pg0.pool), "a deadlock was detected").toBe(before);
    expectOk(v);
    expectOk(d);
    expect(await erasure.status()).toBe("completed");
    const [left] = await sql<{ n: number }>(
      ws.id,
      `SELECT count(*)::int AS n FROM core.access_request
        WHERE workspace_id = '${ws.id}' AND lower(email::text) = '${email}'`,
    );
    expect(left?.n).toBe(0);
  }, 120_000);
});

describe("erasure completion vs SCIM deprovisioning (E3.8)", () => {
  it("vs suspend, plain and on a SCIM transaction holding the member's scim_user row", async () => {
    const ws = await workspace("ree");
    const email = `staff@${ws.slug}.test`;
    const staff = await member(ws.slug, ws.id, email, "staff", "editor");
    const sys = systemContext(ws.id);
    const [su] = await sql<{ id: string }>(
      ws.id,
      `INSERT INTO core.scim_user (workspace_id, membership_id, user_id, user_name, email,
         display_name, external_id)
       SELECT '${ws.id}', m.id, m.user_id, '${email}', '${email}', 'Staff Person', 'ext-1'
         FROM core.membership m WHERE m.id = '${staff.membershipId}'
       RETURNING id`,
    );
    const erasure = await erasureReadyToComplete(ws, staff.membershipId);
    const scim = { kind: "system", label: "scim:lock-order" } as const;
    const memberships = running.container.auth.memberships;
    const suspended = (p: Promise<unknown>) =>
      p.then(
        () => "suspended",
        (error: unknown) => {
          // The erasure went first: the membership is revoked by the time the suspend reads it.
          if (isAuthError(error, "not_found")) return "not_found";
          throw error;
        },
      );
    // What SCIM's PATCH active:false does: its scim_user row first, then the membership (same tx).
    const scimPatch = () =>
      suspended(
        running.container.db.withTenant(sys, async (tx) => {
          await tx.execute(
            `SELECT id FROM core.scim_user WHERE id = '${su?.id}' FOR NO KEY UPDATE`,
          );
          await memberships.suspend(
            sys,
            { membershipId: staff.membershipId, reason: "scim_deactivated" },
            scim,
            { tx },
          );
        }),
      );
    const plain = () =>
      suspended(
        memberships.suspend(sys, { membershipId: staff.membershipId, reason: "admin" }, scim),
      );
    const [done, viaScim, direct] = await lineUp(erasure, [scimPatch, plain]);
    expectOk(done);
    expectOk(viaScim);
    expectOk(direct);
    expect(await erasure.status()).toBe("completed");
    const [row] = await sql<{ user_name: string; email: string | null; active: boolean }>(
      ws.id,
      `SELECT user_name::text, email::text, active FROM core.scim_user WHERE id = '${su?.id}'`,
    );
    expect(row).toEqual({ user_name: `erased-${su?.id}@invalid`, email: null, active: false });
  }, 120_000);
});

describe("workspace purge vs the export expiry sweep", () => {
  it("the sweep holds no export row while it waits for the purge's workspace row", async () => {
    const ws = await workspace("red");
    const [stale] = await sql<{ id: string }>(
      ws.id,
      `INSERT INTO core.workspace_export (workspace_id, status, created_at)
       VALUES ('${ws.id}', 'queued', now() - interval '3 days') RETURNING id`,
    );
    expect(stale).toBeDefined();
    await pg0.pool.query(
      `UPDATE core.workspace SET deleted_at = now() - interval '31 days',
         purge_after = now() - interval '1 day' WHERE id = $1`,
      [ws.id],
    );
    await settle();
    const before = await deadlocks(pg0.pool);
    const c = running.container;
    let sweep: Promise<Outcome> | undefined;
    const purge = await purgeDeletedWorkspaces({
      db: c.db,
      audit: c.audit,
      storage: c.storage,
      hooks: {
        // The purge holds the workspace row FOR UPDATE here and deletes the export rows next.
        afterRecheck: async (id) => {
          if (id !== ws.id) return;
          sweep = outcome(expireExports({ db: c.db, storage: c.storage, audit: c.audit }));
          await blockedAtLeast([], 1);
        },
      },
    });
    const swept = await (sweep as Promise<Outcome>);
    await settle();
    expect(await deadlocks(pg0.pool), "a deadlock was detected").toBe(before);
    expectOk(swept);
    expect(purge.purged).toContain(ws.id);
    const [left] = (
      await pg0.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM core.workspace_export WHERE workspace_id = $1",
        [ws.id],
      )
    ).rows;
    expect(left?.n).toBe(0);
  }, 120_000);
});
