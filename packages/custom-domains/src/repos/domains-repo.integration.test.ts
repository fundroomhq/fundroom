import {
  createDatabase,
  createWorkspace,
  type Database,
  pgErrorCode,
  type TenantContext,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uniqueViolationOf } from "../service/domains.js";
import { nextState, VERIFY_DEADLINE_MS } from "../state.js";
import {
  CustomDomainRepo,
  findIssuableByHostname,
  isHostnameHeld,
  listDomainsForSweep,
  lockHostname,
} from "./domains-repo.js";

/*
 * `core.custom_domain` against real Postgres with RLS and the role switch on. Four things only a
 * database can prove:
 *
 *  - the columns come back as `Date`s (the query builder, not `tx.execute` — ADR-0036);
 *  - `demote()` resets `first_attempt_at`, so a row demoted today is not `failed` tomorrow;
 *  - the three unique indexes fire where they should and `uniqueViolationOf` tells them apart,
 *    all three being SQLSTATE 23505 (E2.1 §7);
 *  - the fence: a workspace sees only its own rows, so the hostname lookup has to run in host
 *    context — under `withTenant` it answers "no such domain" for every hostname but that one
 *    workspace's, which is the mistake that would 404 every custom domain.
 */

let pg: TestPostgres;
let db: Database;
let acme: string;
let beta: string;

const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);

function staff(workspaceId: string): TenantContext {
  return {
    workspaceId,
    actorKind: "staff",
    membershipId: "01920000-0000-7000-8000-0000000000b1",
  };
}

beforeAll(async () => {
  pg = await startPostgres();
  db = createDatabase({ connectionString: pg.connectionString, poolMax: 4 });
  acme = (await createWorkspace(db, { slug: "acme", name: "Acme" })).id;
  beta = (await createWorkspace(db, { slug: "beta", name: "Beta" })).id;
});

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

function repo<T>(workspaceId: string, fn: (r: CustomDomainRepo) => Promise<T>): Promise<T> {
  const ctx = staff(workspaceId);
  return db.withTenant(ctx, (tx) => fn(new CustomDomainRepo(ctx, tx)));
}

describe("CustomDomainRepo", () => {
  it("writes a pending row and reads every timestamp back as a Date", async () => {
    const at = new Date("2026-09-13T10:00:00Z");
    const row = await repo(acme, (r) =>
      r.create({ hostname: "investors.acme.com", token: TOKEN_A, firstAttemptAt: at }),
    );
    expect(row.status).toBe("pending");
    expect(row.workspaceId).toBe(acme);
    // Not `toEqual(at)` but the type: the raw `tx.execute` path returns timestamptz as *text*,
    // and a string here would pass every unit test while breaking the 72 h deadline.
    expect(row.firstAttemptAt).toBeInstanceOf(Date);
    expect(row.firstAttemptAt.getTime()).toBe(at.getTime());
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.lastCheckedAt).toBeNull();
    expect(row.consecutiveFailures).toBe(0);

    // citext: the lookup is case-insensitive in the database, not in JavaScript.
    expect((await repo(acme, (r) => r.byHostname("INVESTORS.ACME.COM")))?.id).toBe(row.id);
    expect(await repo(beta, (r) => r.byId(row.id))).toBeUndefined();
  });

  it("clamps a long detail rather than tripping custom_domain_detail_length", async () => {
    const row = await repo(acme, (r) => r.byHostname("investors.acme.com"));
    if (row === undefined) throw new Error("missing row");
    const updated = await repo(acme, (r) =>
      r.recordAttempt(row.id, {
        checkedAt: new Date("2026-09-13T10:05:00Z"),
        detail: "x".repeat(2_000),
        consecutiveFailures: 1,
      }),
    );
    expect(updated?.lastDetail).toHaveLength(1_000);
    expect(updated?.consecutiveFailures).toBe(1);
    expect(updated?.status).toBe("pending");
  });

  it("recordProvider replaces last_answer.provider only, keeping the DNS answers (E3.10)", async () => {
    const row = await repo(acme, (r) =>
      r.create({
        hostname: "cf.acme.com",
        token: TOKEN_A,
        firstAttemptAt: new Date("2026-09-13T10:00:00Z"),
      }),
    );
    const checkedAt = new Date("2026-09-13T10:10:00Z");
    const cname = {
      name: "cf.acme.com",
      type: "CNAME" as const,
      values: ["edge.test"],
      rcode: "ok" as const,
      resolver: "r1",
    };
    await repo(acme, (r) => r.markDnsOk(row.id, { checkedAt, answer: { cname } }));
    const facts = {
      state: "pending" as const,
      detail: null,
      records: [{ type: "TXT" as const, name: "_cf.cf.acme.com", value: "v", required: false }],
      registered: true,
      checkedAt: "2026-09-13T10:10:01.000Z",
    };
    const once = await repo(acme, (r) => r.recordProvider(row.id, facts));
    expect(once?.lastAnswer).toEqual({ cname, provider: facts });
    expect(once?.lastAnswerSchemaVersion).toBe(2);
    // No DNS was resolved: last_checked_at is the verifier's, not this write's.
    expect(once?.lastCheckedAt?.getTime()).toBe(checkedAt.getTime());
    const again = await repo(acme, (r) =>
      r.recordProvider(row.id, { ...facts, state: "active", records: [] }),
    );
    expect(again?.lastAnswer).toEqual({
      cname,
      provider: { ...facts, state: "active", records: [] },
    });
    expect(again?.status).toBe("dns_ok");
    const swept = await db.withHost((tx) =>
      listDomainsForSweep(tx, { statuses: ["dns_ok"], limit: 10, workspaceId: acme }),
    );
    expect(swept.find((s) => s.id === row.id)?.dnsOkAt).toBeInstanceOf(Date);
    await repo(acme, (r) => r.softDelete(row.id, new Date()));
  });

  it("demotes with a fresh first_attempt_at, so the next sweep retries instead of failing", async () => {
    const long = new Date("2026-01-01T00:00:00Z");
    const row = await repo(acme, (r) =>
      r.create({ hostname: "old.acme.com", token: TOKEN_A, firstAttemptAt: long }),
    );
    await repo(acme, (r) => r.markDnsOk(row.id, { checkedAt: long }));
    const active = await repo(acme, (r) => r.markActive(row.id, { checkedAt: long }));
    expect(active?.status).toBe("active");
    expect(active?.activatedAt).toBeInstanceOf(Date);

    const demotedAt = new Date("2026-09-13T00:00:00Z");
    const demoted = await repo(acme, (r) =>
      r.demote(row.id, { checkedAt: demotedAt, detail: "the CNAME stopped resolving" }),
    );
    expect(demoted?.status).toBe("pending");
    expect(demoted?.firstAttemptAt.getTime()).toBe(demotedAt.getTime());
    expect(demoted?.consecutiveFailures).toBe(0);
    expect(demoted?.dnsOkAt).toBeNull();
    expect(demoted?.activatedAt).toBeNull();
    // The trigger moved updated_at, which is how the admin list sorts recent activity.
    expect(demoted && demoted.updatedAt.getTime() >= demotedAt.getTime()).toBe(true);

    // The whole point: tomorrow's sweep sees a row inside its window, not one months past it.
    if (demoted === undefined) throw new Error("missing row");
    const tomorrow = new Date(demotedAt.getTime() + 24 * 3600_000);
    expect(
      nextState({
        status: demoted.status,
        ok: false,
        firstAttemptAt: demoted.firstAttemptAt,
        now: tomorrow,
        consecutiveFailures: demoted.consecutiveFailures,
      }).status,
    ).toBe("pending");
    // Had the reset been dropped, the same sweep would have read this instead:
    expect(
      nextState({
        status: "pending",
        ok: false,
        firstAttemptAt: long,
        now: tomorrow,
        consecutiveFailures: 0,
      }).status,
    ).toBe("failed");
    expect(tomorrow.getTime() - long.getTime()).toBeGreaterThan(VERIFY_DEADLINE_MS);

    await repo(acme, (r) => r.softDelete(row.id, new Date()));
  });

  it("tells the three unique violations apart, which all arrive as 23505", async () => {
    // Same workspace, same hostname: one live row only.
    const dup = await repo(acme, (r) =>
      r.create({ hostname: "investors.acme.com", token: TOKEN_A, firstAttemptAt: new Date() }),
    ).catch((e: unknown) => e);
    expect(pgErrorCode(dup)).toBe("23505");
    expect(uniqueViolationOf(dup)).toBe("custom_domain_ws_host_idx");

    // Two workspaces may both hold a *pending* row: one of them is a typo, and a global claim
    // over pending rows would let a squatter block a rival forever.
    const rival = await repo(beta, (r) =>
      r.create({ hostname: "investors.acme.com", token: TOKEN_B, firstAttemptAt: new Date() }),
    );
    expect(rival.status).toBe("pending");

    // First verified wins: acme verifies, and beta's promotion is refused by the claim index.
    const mine = await repo(acme, (r) => r.byHostname("investors.acme.com"));
    if (mine === undefined) throw new Error("missing row");
    await repo(acme, (r) => r.markDnsOk(mine.id, { checkedAt: new Date() }));
    const claimed = await repo(beta, (r) => r.markDnsOk(rival.id, { checkedAt: new Date() })).catch(
      (e: unknown) => e,
    );
    expect(uniqueViolationOf(claimed)).toBe("custom_domain_claim_idx");

    // One verified hostname per workspace: a second is a second `__Host-` cookie jar, not an alias.
    const second = await repo(acme, (r) =>
      r.create({ hostname: "ir.acme.com", token: TOKEN_A, firstAttemptAt: new Date() }),
    );
    const mineToo = await repo(acme, (r) =>
      r.markDnsOk(second.id, { checkedAt: new Date() }),
    ).catch((e: unknown) => e);
    expect(uniqueViolationOf(mineToo)).toBe("custom_domain_one_per_workspace_idx");
    expect((await repo(acme, (r) => r.verified()))?.hostname).toBe("investors.acme.com");

    // Soft-deleting releases the claim: both indexes are `WHERE deleted_at IS NULL`.
    await repo(acme, (r) => r.softDelete(mine.id, new Date()));
    const freed = await repo(beta, (r) => r.markDnsOk(rival.id, { checkedAt: new Date() }));
    expect(freed?.status).toBe("dns_ok");
    await repo(beta, (r) => r.softDelete(rival.id, new Date()));
    await repo(acme, (r) => r.softDelete(second.id, new Date()));
  });
});

describe("the host-context reads", () => {
  it("answer from the hostname alone — and return nothing in tenant context", async () => {
    const row = await repo(acme, (r) =>
      r.create({ hostname: "portal.acme.com", token: TOKEN_A, firstAttemptAt: new Date() }),
    );
    // `pending` is not issuable: `ask` answers 200 for dns_ok|active only.
    expect(
      await db.withHost((tx) => findIssuableByHostname(tx, "portal.acme.com")),
    ).toBeUndefined();
    await repo(acme, (r) => r.markDnsOk(row.id, { checkedAt: new Date() }));

    const hit = await db.withHost((tx) => findIssuableByHostname(tx, "PORTAL.acme.com"));
    expect(hit).toEqual({
      id: row.id,
      workspaceId: acme,
      slug: "acme",
      hostname: "portal.acme.com",
      status: "dns_ok",
    });

    // The mistake worth a test: in tenant context this query only ever sees the one workspace's
    // rows, so `ask` and the classifier — which have no workspace, that being the question —
    // would answer "no such domain" for every hostname but their own. Hence host context, which
    // the fence admits precisely for these two callers.
    const other = staff(beta);
    expect(
      await db.withTenant(other, (tx) => findIssuableByHostname(tx, "portal.acme.com")),
    ).toBeUndefined();
    const owner = staff(acme);
    expect(
      (await db.withTenant(owner, (tx) => findIssuableByHostname(tx, "portal.acme.com")))?.slug,
    ).toBe("acme");
  });

  it("sweeps every workspace, least-recently-checked first, and narrows to one on request", async () => {
    const older = await repo(beta, (r) =>
      r.create({ hostname: "one.beta.com", token: TOKEN_B, firstAttemptAt: new Date() }),
    );
    await repo(beta, (r) =>
      r.recordAttempt(older.id, {
        checkedAt: new Date("2026-09-01T00:00:00Z"),
        consecutiveFailures: 1,
      }),
    );
    const never = await repo(beta, (r) =>
      r.create({ hostname: "two.beta.com", token: TOKEN_B, firstAttemptAt: new Date() }),
    );

    const all = await db.withHost((tx) =>
      listDomainsForSweep(tx, { statuses: ["pending", "dns_ok"], limit: 50 }),
    );
    expect(all.map((r) => r.hostname)).toContain("portal.acme.com");
    // Never-checked first of all (`custom_domain_check_idx` is `last_checked_at NULLS FIRST`).
    expect(all[0]?.hostname).toBe("two.beta.com");
    expect(all.find((r) => r.id === older.id)?.lastCheckedAt).toBeInstanceOf(Date);

    const onlyBeta = await db.withHost((tx) =>
      listDomainsForSweep(tx, { statuses: ["pending"], limit: 50, workspaceId: beta }),
    );
    expect(onlyBeta.map((r) => r.id).sort()).toEqual([never.id, older.id].sort());
    expect(await db.withHost((tx) => listDomainsForSweep(tx, { statuses: [], limit: 50 }))).toEqual(
      [],
    );
  });
});

describe("the provider-release guards (E3.10 FR3)", () => {
  it("a verified hostname of a soft-deleted workspace is still held, though it no longer routes", async () => {
    const gamma = (await createWorkspace(db, { slug: "gamma", name: "Gamma" })).id;
    const host = "ir.gamma.com";
    const row = await repo(gamma, (r) =>
      r.create({ hostname: host, token: TOKEN_A, firstAttemptAt: new Date() }),
    );
    await repo(gamma, (r) => r.markDnsOk(row.id, { checkedAt: new Date() }));
    expect(await db.withHost((tx) => isHostnameHeld(tx, host))).toBe(true);
    await pg.pool.query("UPDATE core.workspace SET deleted_at = now() WHERE id = $1", [gamma]);
    // Routing forgets it (the lookup must not revive a closed portal)…
    expect(await db.withHost((tx) => findIssuableByHostname(tx, host))).toBeUndefined();
    // …but the provider must not: the workspace may be restored inside its window.
    expect(await db.withHost((tx) => isHostnameHeld(tx, host))).toBe(true);
    // A pending row, or a removed one, holds nothing.
    await pg.pool.query("UPDATE core.custom_domain SET deleted_at = now() WHERE id = $1", [row.id]);
    expect(await db.withHost((tx) => isHostnameHeld(tx, host))).toBe(false);
    expect(await db.withHost((tx) => isHostnameHeld(tx, "never.example.com"))).toBe(false);
  });

  it("lockHostname holds a per-hostname lock until the transaction ends", async () => {
    const host = "locked.example.com";
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked: () => void = () => {};
    const taken = new Promise<void>((r) => {
      locked = r;
    });
    const holder = db.withHost(async (tx) => {
      await lockHostname(tx, host);
      locked();
      await gate;
    });
    await taken;
    const probe = "SELECT pg_try_advisory_lock(24303, hashtext($1)) AS ok";
    expect((await pg.pool.query(probe, [host])).rows[0]?.ok).toBe(false);
    // Another hostname is not blocked.
    const other = await pg.pool.connect();
    try {
      expect((await other.query(probe, ["free.example.com"])).rows[0]?.ok).toBe(true);
      await other.query("SELECT pg_advisory_unlock_all()");
    } finally {
      other.release();
    }
    release();
    await holder;
    const after = await pg.pool.connect();
    try {
      expect((await after.query(probe, [host])).rows[0]?.ok).toBe(true);
      await after.query("SELECT pg_advisory_unlock_all()");
    } finally {
      after.release();
    }
  });
});
