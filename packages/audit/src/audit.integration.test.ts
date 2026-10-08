import { randomBytes } from "node:crypto";
import { parseKeyRing } from "@fundroom/config";
import {
  createDatabase,
  createWorkspace,
  type Database,
  PLATFORM_WORKSPACE_ID,
  pgErrorMessage,
  platformContext,
  systemContext,
  type TenantContext,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex, verifyExportedChain } from "./canonical.js";
import { writeAllCheckpoints, writeCheckpoint } from "./checkpoint.js";
import { runAuditMaintenance } from "./maintenance.js";
import { exportRows, listCheckpoints } from "./repos/audit-repo.js";
import { type AuditService, createAuditService } from "./service.js";
import { verifyWorkspace } from "./verify.js";

/*
 * The audit log against real Postgres with RLS and the role switch on: chaining under
 * concurrency, immutability for the app role, partition routing and lazy creation,
 * offline verification of exported rows, checkpoints + signatures, tamper detection by
 * the verifier, and the tenant fence on audit tables.
 */
let pg: TestPostgres;
let db: Database;
let audit: AuditService;
let clock = new Date("2026-09-11T10:00:00Z");
let wsA: string;
let wsB: string;
const keyRing = (() => {
  const r = parseKeyRing(`v1:${randomBytes(32).toString("base64")}`);
  if (!r.ok) throw new Error("bad ring");
  return r.ring;
})();

const M_A = "01920000-0000-7000-8000-00000000000a";
const U_A = "01920000-0000-7000-8000-00000000000b";

beforeAll(async () => {
  pg = await startPostgres();
  db = createDatabase({ connectionString: pg.connectionString, poolMax: 8 });
  audit = createAuditService({ db, now: () => clock });
  wsA = (await createWorkspace(db, { slug: "alpha", name: "Alpha" })).id;
  wsB = (await createWorkspace(db, { slug: "beta", name: "Beta" })).id;
});

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

function staffCtx(ws: string): TenantContext {
  return { workspaceId: ws, actorKind: "staff", membershipId: M_A, userId: U_A };
}

function rowsOf(ws: string) {
  return db.withTenant(systemContext(ws), (tx) => exportRows(tx, ws));
}

describe("hash chain", () => {
  it("assigns seq/prev_hash/hash per workspace and never lets the app role change a row", async () => {
    const first = await db.withTenant(staffCtx(wsA), (tx) =>
      audit.record(tx, staffCtx(wsA), {
        action: "workspace.created",
        resourceKind: "workspace",
        resourceId: wsA,
        ip: "203.0.113.77",
        userAgent: "test",
        meta: { slug: "alpha" },
      }),
    );
    expect(first).toMatchObject({
      workspaceId: wsA,
      seq: 1,
      prevHash: null,
      actorKind: "staff",
      actorMembershipId: M_A,
      actorUserId: U_A,
      ip: "203.0.113.0/24",
      outcome: "success",
    });
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/u);

    const second = await audit.recordDetached(systemContext(wsA), {
      action: "invite.created",
      resourceKind: "invite",
      actorKind: "staff",
      actorMembershipId: M_A,
    });
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);

    // Another workspace starts its own chain.
    const other = await audit.recordDetached(systemContext(wsB), {
      action: "workspace.created",
      resourceKind: "workspace",
    });
    expect(other).toMatchObject({ seq: 1, prevHash: null, actorKind: "system" });

    // The app role can neither update nor delete, whatever the context.
    const asApp = (q: ReturnType<typeof sql>) =>
      db
        .withTenant(systemContext(wsA), (tx) => tx.execute(q))
        .then(
          () => "no error",
          (e: unknown) => pgErrorMessage(e),
        );
    expect(await asApp(sql`UPDATE audit.event SET action = 'x.y' WHERE seq = 1`)).toMatch(
      /permission denied|append-only/u,
    );
    expect(await asApp(sql`DELETE FROM audit.event`)).toMatch(/permission denied|append-only/u);
    // Even the owner is stopped by the trigger (a superuser can drop it; that is what checkpoints are for).
    await expect(
      pg.pool.query("UPDATE audit.event SET action = 'x.y' WHERE seq = 1"),
    ).rejects.toThrow(/append-only/u);
    await expect(pg.pool.query("DELETE FROM audit.event WHERE seq = 1")).rejects.toThrow(
      /append-only/u,
    );
    await expect(pg.pool.query("TRUNCATE audit.event")).rejects.toThrow(/append-only/u);
  });

  it("serialises concurrent inserts into one unforked chain", async () => {
    const before = (await rowsOf(wsA)).length;
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        audit.recordDetached(systemContext(wsA), {
          action: "document.viewed",
          resourceKind: "document",
          meta: { i },
        }),
      ),
    );
    const rows = await rowsOf(wsA);
    expect(rows.length).toBe(before + 25);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    const v = verifyExportedChain(rows);
    expect(v).toMatchObject({ ok: true, checked: before + 25 });
    expect(await verifyWorkspace({ db }, wsA)).toMatchObject({ ok: true, headSeq: before + 25 });
  });

  it("exported canonical text hashes offline exactly as Postgres hashed it", async () => {
    const rows = await rowsOf(wsA);
    for (const r of rows) expect(sha256Hex(r.canonical)).toBe(r.hash.toString("hex"));
    const parsed = JSON.parse(rows[0]?.canonical ?? "{}") as Record<string, unknown>;
    expect(parsed).toMatchObject({
      seq: 1,
      action: "workspace.created",
      actor_kind: "staff",
      ip: "203.0.113.0/24",
      prev_hash: null,
      meta: { slug: "alpha" },
      occurred_at: "2026-09-11T10:00:00.000000Z",
    });
  });

  it("routes by month and creates partitions lazily for backdated and future events", async () => {
    const parts = async () =>
      (
        await pg.pool.query<{ relname: string }>(
          "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'event' ORDER BY 1",
        )
      ).rows.map((r) => r.relname);
    const initial = await parts();
    expect(initial.length).toBeGreaterThanOrEqual(4); // migration: current month + 3
    await audit.recordDetached(systemContext(wsB), {
      action: "document.viewed",
      resourceKind: "document",
      occurredAt: new Date("2019-02-14T00:00:00Z"),
    });
    await audit.recordDetached(systemContext(wsB), {
      action: "document.viewed",
      resourceKind: "document",
      occurredAt: new Date("2031-07-01T00:00:00Z"),
    });
    const after = await parts();
    expect(after).toContain("event_201902");
    expect(after).toContain("event_203107");
    const placed = await pg.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit.event_201902 WHERE workspace_id = $1",
      [wsB],
    );
    expect(placed.rows[0]?.n).toBe(1);
    // New partitions are fenced like the parent.
    const pol = await pg.pool.query<{ polname: string; polpermissive: boolean }>(
      "SELECT polname, polpermissive FROM pg_policy WHERE polrelid = 'audit.event_203107'::regclass ORDER BY 1",
    );
    expect(pol.rows).toEqual([
      { polname: "event_203107_access", polpermissive: true },
      { polname: "tenant_fence", polpermissive: false },
    ]);
    // Chain order is seq, not time: the backdated rows verify fine.
    expect(await verifyWorkspace({ db }, wsB)).toMatchObject({ ok: true, headSeq: 3 });
  });

  it("rejects malformed actions before touching the database", async () => {
    await expect(
      audit.recordDetached(systemContext(wsA), { action: "nodots", resourceKind: "x" }),
    ).rejects.toThrow(/resource\.verb/u);
    await expect(
      audit.recordDetached(systemContext(wsA), { action: "a.b", resourceKind: "Bad Kind" }),
    ).rejects.toThrow(/resourceKind/u);
  });
});

describe("tenant fence on audit tables", () => {
  it("a tenant sees only its chain; the platform chain is invisible to tenants", async () => {
    await audit.recordDetached(platformContext(), {
      action: "host.break_glass",
      resourceKind: "workspace",
      meta: { ticket: "OPS-1" },
    });
    const seen = await db.withTenant(systemContext(wsA), (tx) => exportRows(tx, wsB));
    expect(seen).toEqual([]);
    const seenPlatform = await db.withTenant(systemContext(wsA), (tx) =>
      exportRows(tx, PLATFORM_WORKSPACE_ID),
    );
    expect(seenPlatform).toEqual([]);
    const own = await db.withTenant(systemContext(wsB), (tx) => exportRows(tx, wsB));
    expect(own.length).toBe(3);
    const platform = await db.withTenant(platformContext(), (tx) =>
      exportRows(tx, PLATFORM_WORKSPACE_ID),
    );
    expect(platform.map((r) => JSON.parse(r.canonical).action)).toEqual(["host.break_glass"]);
    // Host context (no workspace) sees nothing either: audit rows are never enumerable.
    const host = await db.withHost((tx) => exportRows(tx, wsA));
    expect(host).toEqual([]);
  });
});

describe("checkpoints", () => {
  it("writes a signed checkpoint when the head moved, skips otherwise", async () => {
    const first = await writeCheckpoint({ db, keyRing }, wsA);
    expect(first.status).toBe("written");
    expect(await writeCheckpoint({ db, keyRing }, wsA)).toMatchObject({ status: "unchanged" });
    await audit.recordDetached(systemContext(wsA), {
      action: "acl.changed",
      resourceKind: "grant",
    });
    const all = await writeAllCheckpoints({ db, keyRing });
    expect(all.find((r) => r.workspaceId === wsA)?.status).toBe("written");
    expect(all.find((r) => r.workspaceId === PLATFORM_WORKSPACE_ID)?.status).toBe("written");
    const cps = await db.withTenant(systemContext(wsA), (tx) => listCheckpoints(tx, wsA));
    expect(cps).toHaveLength(2);
    expect(cps[1]?.previousCheckpointId).toBe(cps[0]?.id);
    expect(cps[1]?.keyId).toBe("v1");
    expect(Number(cps[1]?.seq)).toBe(first.seq + 1);
    const v = await verifyWorkspace({ db, keyRing }, wsA);
    expect(v).toMatchObject({ ok: true, checkpoints: 2 });
    // Checkpoints are append-only too.
    await expect(pg.pool.query("DELETE FROM audit.checkpoint")).rejects.toThrow(/append-only/u);
  });

  it("verification catches tampering by a superuser who bypasses the triggers", async () => {
    // Simulate an attacker with DDL rights: disable the trigger, rewrite a row, re-enable.
    await pg.pool.query("ALTER TABLE audit.event DISABLE TRIGGER event_immutable");
    try {
      await pg.pool.query(
        "UPDATE audit.event SET meta = '{\"i\": 999}'::jsonb WHERE workspace_id = $1 AND seq = 5",
        [wsA],
      );
    } finally {
      await pg.pool.query("ALTER TABLE audit.event ENABLE TRIGGER event_immutable");
    }
    const v = await verifyWorkspace({ db, keyRing }, wsA);
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/hash mismatch \(row altered\) at seq 5/u);
    expect(verifyExportedChain(await rowsOf(wsA)).problem).toMatchObject({ seq: 5 });

    // Re-chaining every row after the edit fools the chain walk but not the signed checkpoint.
    await pg.pool.query("ALTER TABLE audit.event DISABLE TRIGGER event_immutable");
    try {
      await pg.pool.query(
        `WITH RECURSIVE fixed AS (
           SELECT e.seq, e.prev_hash, audit.digest(audit.canonical(to_jsonb(e), e.prev_hash)) AS hash
           FROM audit.event e WHERE e.workspace_id = $1 AND e.seq = 5
           UNION ALL
           SELECT e.seq, f.hash,
                  audit.digest(audit.canonical(to_jsonb(e), f.hash))
           FROM audit.event e JOIN fixed f ON e.workspace_id = $1 AND e.seq = f.seq + 1
         )
         UPDATE audit.event e SET prev_hash = f.prev_hash, hash = f.hash
         FROM fixed f WHERE e.workspace_id = $1 AND e.seq = f.seq`,
        [wsA],
      );
      await pg.pool.query(
        "UPDATE audit.chain_head h SET hash = e.hash FROM audit.event e WHERE e.workspace_id = h.workspace_id AND e.seq = h.seq AND h.workspace_id = $1",
        [wsA],
      );
    } finally {
      await pg.pool.query("ALTER TABLE audit.event ENABLE TRIGGER event_immutable");
    }
    const rechained = await verifyWorkspace({ db, keyRing }, wsA);
    expect(rechained.ok).toBe(false);
    expect(rechained.problems.some((p) => /chain:/u.test(p))).toBe(false);
    expect(
      rechained.problems.some((p) => /checkpoint .* differs from the checkpointed hash/u.test(p)),
    ).toBe(true);
  });
});

describe("maintenance", () => {
  it("creates partitions ahead and drops only those past retention, recording the drop", async () => {
    clock = new Date("2026-09-11T02:30:00Z");
    const r = await runAuditMaintenance({ db, audit, retentionMonths: 84, monthsAhead: 4 });
    expect(r.dropped).toEqual(["event_201902"]); // 2019 is well past 84 months
    expect(r.created).toBeGreaterThanOrEqual(1);
    const parts = await pg.pool.query<{ relname: string }>(
      "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'event' ORDER BY 1",
    );
    expect(parts.rows.map((p) => p.relname)).not.toContain("event_201902");
    expect(parts.rows.map((p) => p.relname)).toContain("event_202701");
    const platform = await db.withTenant(platformContext(), (tx) =>
      exportRows(tx, PLATFORM_WORKSPACE_ID),
    );
    const last = JSON.parse(platform.at(-1)?.canonical ?? "{}") as Record<string, unknown>;
    expect(last).toMatchObject({
      action: "audit.partition_dropped",
      meta: { partitions: ["event_201902"], retentionMonths: 84 },
    });
    // Retention below the floor is clamped, never honoured.
    const r2 = await runAuditMaintenance({ db, audit, retentionMonths: 1, monthsAhead: 0 });
    expect(r2.dropped).toEqual([]);
  });
});
