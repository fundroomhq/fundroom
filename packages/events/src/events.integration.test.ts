import {
  createDatabase,
  createWorkspace,
  type Database,
  HOST_CONTEXT,
  systemContext,
} from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { JobDefinition } from "@fundroom/ports";
import { createPgBossQueue, type PgBossQueue } from "@fundroom/queue-pgboss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerEventWorkers } from "./dispatcher.js";
import { claimIdempotencyKey, onceByKey, sweepIdempotencyKeys } from "./idempotency.js";
import { createEventMaintenanceJobs, registerJobs } from "./jobs.js";
import { publish } from "./outbox.js";
import { createOutboxRelay, prepareEventQueues } from "./relay.js";
import { countPendingOutboxRows } from "./repos/outbox-repo.js";
import { createSubscriptionRegistry, type EventEnvelope } from "./subscriptions.js";

/*
 * Outbox → relay → pg-boss → subscriber, end to end on Postgres 18 with RLS on:
 * transactional publish, per-subscriber fan-out in the relay's transaction, handlers
 * running in the event's workspace context, retries into the dead-letter queue and
 * redrive, idempotency keys, cron-registered jobs, and poison-row isolation.
 */
let pg: TestPostgres;
let db: Database;
let queue: PgBossQueue;
let wsA: string;
let wsB: string;
const handled: { subscriber: string; ws: string | null; outboxId: number; payload: unknown }[] = [];
let failuresLeft = 0;

const subscriptions = createSubscriptionRegistry();

async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitForAsync(pred: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  pg = await startPostgres();
  db = createDatabase({ connectionString: pg.connectionString, poolMax: 10 });
  wsA = (await createWorkspace(db, { slug: "alpha", name: "Alpha" })).id;
  wsB = (await createWorkspace(db, { slug: "beta", name: "Beta" })).id;
  queue = createPgBossQueue({ pool: db.pool, pollIntervalMs: 500, supervise: false });
  await queue.start();

  subscriptions.subscribe("membership.revoked", "data-room.purge", async (event, { ctx }) => {
    handled.push({
      subscriber: "data-room.purge",
      ws: ctx.actorKind === "host" ? null : ctx.workspaceId,
      outboxId: event.outboxId,
      payload: event.payload,
    });
  });
  subscriptions.subscribe("membership.revoked", "analytics.close", async (event, { tx, ctx }) => {
    // Runs in the event's workspace: a fenced read proves the context is right.
    const rows = await tx.execute(
      (await import("drizzle-orm")).sql`SELECT count(*)::int AS n FROM core.outbox`,
    );
    handled.push({
      subscriber: "analytics.close",
      ws: ctx.actorKind === "host" ? null : ctx.workspaceId,
      outboxId: event.outboxId,
      payload: { visibleOutboxRows: (rows.rows[0] as { n: number }).n },
    });
  });
  subscriptions.subscribe("user.created", "crm.link-contact", async (event, { ctx }) => {
    handled.push({
      subscriber: "crm.link-contact",
      ws: ctx.actorKind === "host" ? null : ctx.workspaceId,
      outboxId: event.outboxId,
      payload: event.payload,
    });
  });
  subscriptions.subscribe("acl.changed", "access.rebuild", async (event: EventEnvelope) => {
    if (failuresLeft > 0) {
      failuresLeft--;
      throw new Error(`transient failure for outbox ${event.outboxId}`);
    }
    handled.push({
      subscriber: "access.rebuild",
      ws: null,
      outboxId: event.outboxId,
      payload: event.payload,
    });
  });

  await prepareEventQueues(queue, subscriptions);
  // Fast retries so the dead-letter path is testable.
  await queue.ensureQueue("event.acl.changed", {
    policy: "short",
    retryLimit: 1,
    retryDelaySeconds: 1,
    retryBackoff: false,
  });
  await registerEventWorkers({ db, queue, subscriptions, work: { pollIntervalMs: 500 } });
});

afterAll(async () => {
  await queue?.stop({ timeoutMs: 5_000 });
  await db?.close();
  await pg?.stop();
});

describe("transactional outbox + relay", () => {
  it("publishes in the domain transaction: a rollback leaves no row", async () => {
    const ctx = systemContext(wsA);
    await expect(
      db.withTenant(ctx, async (tx) => {
        await publish(tx, ctx, "acl.changed", { aclVersion: 1, cause: "grant" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.withHost(countPendingOutboxRows)).toBe(0);
  });

  it("fans out one job per subscriber, in the relay transaction, and handlers run fenced", async () => {
    const ctxA = systemContext(wsA);
    const ctxB = systemContext(wsB);
    const M1 = "01920000-0000-7000-8000-000000000001";
    const M2 = "01920000-0000-7000-8000-000000000002";
    const idA = await db.withTenant(ctxA, (tx) =>
      publish(tx, ctxA, "membership.revoked", {
        membershipIds: [M1],
        byMembershipId: null,
        reason: "left",
      }),
    );
    const idB = await db.withTenant(ctxB, (tx) =>
      publish(tx, ctxB, "membership.revoked", {
        membershipIds: [M2],
        byMembershipId: null,
        reason: null,
      }),
    );
    const idHost = await db.withHost((tx) =>
      publish(tx, HOST_CONTEXT, "user.created", { userId: M1, method: "email_otp" }),
    );

    const relay = createOutboxRelay({ db, queue, subscriptions, batchSize: 10 });
    expect(await relay.runOnce()).toBe(3);
    expect(await relay.runOnce()).toBe(0);
    const rows = await pg.pool.query<{ id: string; dispatched: number; processed_at: Date | null }>(
      "SELECT id, dispatched, processed_at FROM core.outbox ORDER BY id",
    );
    expect(rows.rows.map((r) => [Number(r.id), r.dispatched, r.processed_at !== null])).toEqual([
      [idA, 2, true],
      [idB, 2, true],
      [idHost, 1, true],
    ]);

    await waitFor(() => handled.length >= 5);
    const forA = handled.filter((h) => h.outboxId === idA);
    expect(forA.map((h) => h.subscriber).sort()).toEqual(["analytics.close", "data-room.purge"]);
    expect(forA.every((h) => h.ws === wsA)).toBe(true);
    expect(forA.find((h) => h.subscriber === "data-room.purge")?.payload).toEqual({
      membershipIds: [M1],
      byMembershipId: null,
      reason: "left",
    });
    // The fenced read inside the handler saw only workspace A's outbox rows (1), not B's.
    expect(forA.find((h) => h.subscriber === "analytics.close")?.payload).toEqual({
      visibleOutboxRows: 1,
    });
    expect(handled.find((h) => h.outboxId === idHost)).toMatchObject({
      subscriber: "crm.link-contact",
      ws: null,
      payload: { userId: M1, method: "email_otp" },
    });
  });

  it("retries a failing subscriber, then dead-letters it; redrive from the DLQ succeeds", async () => {
    failuresLeft = 5; // more than retryLimit (1) + 1
    const ctx = systemContext(wsA);
    const id = await db.withTenant(ctx, (tx) =>
      publish(tx, ctx, "acl.changed", { aclVersion: 7, cause: "grant" }),
    );
    const relay = createOutboxRelay({ db, queue, subscriptions });
    expect(await relay.runOnce()).toBe(1);
    await waitForAsync(async () => (await queue.deadLetters.count()) === 1, 30_000);
    const [dead] = await queue.deadLetters.list();
    expect(dead).toMatchObject({
      sourceQueue: "event.acl.changed",
      data: { outboxId: id, subscriber: "access.rebuild", topic: "acl.changed" },
    });
    expect(dead?.retries).toBe(1);
    expect(JSON.stringify(dead?.error)).toContain("transient failure");
    const stats = await queue.stats();
    expect(stats.find((s) => s.name === "dead-letter")).toBeDefined();

    failuresLeft = 0;
    expect(await queue.deadLetters.retry(dead?.id as string)).toBe(true);
    expect(await queue.deadLetters.retry(dead?.id as string)).toBe(false);
    await waitFor(() =>
      handled.some((h) => h.subscriber === "access.rebuild" && h.outboxId === id),
    );
    expect(await queue.deadLetters.count()).toBe(0);
  });

  it("isolates a poison row: the batch falls back to row-at-a-time and records the error", async () => {
    // A topic with subscribers whose queue does not exist yet in pg-boss → send throws.
    const reg = createSubscriptionRegistry();
    reg.subscribe("document.viewed", "analytics.record", async () => {});
    reg.subscribe("membership.revoked", "data-room.purge", async () => {});
    const ctx = systemContext(wsB);
    const D = "01920000-0000-7000-8000-0000000000d1";
    const good = await db.withTenant(ctx, (tx) =>
      publish(tx, ctx, "membership.revoked", {
        membershipIds: [D],
        byMembershipId: null,
        reason: null,
      }),
    );
    const poison = await db.withTenant(ctx, (tx) =>
      publish(tx, ctx, "document.viewed", {
        documentId: D,
        versionId: D,
        membershipId: D,
        sessionId: null,
      }),
    );
    const logged: string[] = [];
    const relay = createOutboxRelay({
      db,
      queue,
      subscriptions: reg,
      log: (e) => void logged.push(e),
    });
    expect(await relay.runOnce()).toBe(1);
    expect(logged).toEqual(["outbox.batch_failed", "outbox.row_failed"]);
    const rows = await pg.pool.query<{
      id: string;
      processed_at: Date | null;
      attempts: number;
      last_error: string | null;
      available_at: Date;
    }>(
      "SELECT id, processed_at, attempts, last_error, available_at FROM core.outbox WHERE id IN ($1, $2) ORDER BY id",
      [good, poison],
    );
    expect(rows.rows[0]).toMatchObject({ attempts: 1, last_error: null });
    expect(rows.rows[0]?.processed_at).not.toBeNull();
    expect(rows.rows[1]).toMatchObject({ processed_at: null, attempts: 1 });
    expect(rows.rows[1]?.last_error).toMatch(/document\.viewed|queue|not found|exist/iu);
    expect(rows.rows[1]?.available_at.getTime()).toBeGreaterThan(Date.now());
    // Once the queue exists the row drains on its next availability.
    await queue.ensureQueue("event.document.viewed", { policy: "short" });
    await pg.pool.query("UPDATE core.outbox SET available_at = now() WHERE id = $1", [poison]);
    expect(await relay.runOnce()).toBe(1);
  });

  it("start()/stop() poll the outbox in the background", async () => {
    const ctx = systemContext(wsA);
    const relay = createOutboxRelay({ db, queue, subscriptions, pollIntervalMs: 100 });
    relay.start();
    try {
      await db.withTenant(ctx, (tx) =>
        publish(tx, ctx, "acl.changed", { aclVersion: 8, cause: "grant" }),
      );
      await waitForAsync(async () => (await db.withHost(countPendingOutboxRows)) === 0);
    } finally {
      await relay.stop();
    }
    expect(relay.running).toBe(false);
  });
});

describe("idempotency keys", () => {
  it("the first claim wins in its transaction; a redelivery skips; keys expire", async () => {
    const ctx = systemContext(wsA);
    let ran = 0;
    const work = () =>
      db.withTenant(ctx, (tx) =>
        onceByKey(tx, ctx, "updates.send:abc", async () => {
          ran++;
          return "sent";
        }),
      );
    expect(await work()).toEqual({ skipped: false, result: "sent" });
    expect(await work()).toEqual({ skipped: true });
    expect(ran).toBe(1);
    // A rolled-back claim frees the key.
    await expect(
      db.withTenant(ctx, async (tx) => {
        expect(await claimIdempotencyKey(tx, ctx, "updates.send:xyz")).toBe(true);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await db.withTenant(ctx, (tx) => claimIdempotencyKey(tx, ctx, "updates.send:xyz"))).toBe(
      true,
    );
    // Another workspace cannot see or reuse the key row, but the key is globally unique.
    expect(
      await db.withTenant(systemContext(wsB), (tx) =>
        claimIdempotencyKey(tx, systemContext(wsB), "updates.send:xyz"),
      ),
    ).toBe(false);
    await expect(
      db.withTenant(ctx, (tx) => claimIdempotencyKey(tx, ctx, "bad key")),
    ).rejects.toThrow(/must look like/u);
    // Host-level keys and expiry sweep.
    expect(
      await db.withHost((tx) => claimIdempotencyKey(tx, HOST_CONTEXT, "host.job:1", { ttlMs: -1 })),
    ).toBe(true);
    expect(await sweepIdempotencyKeys(db)).toBe(1);
  });
});

describe("job definitions", () => {
  it("registers cron jobs and the maintenance sweeps run", async () => {
    const seen: string[] = [];
    const defs: JobDefinition[] = [
      ...createEventMaintenanceJobs({ db, outboxRetentionMs: 0, log: (e) => void seen.push(e) }),
      {
        name: "test.echo",
        cron: "* * * * *",
        cronData: { hello: "world" },
        handler: async (job) => {
          seen.push(`echo:${JSON.stringify(job.data)}`);
        },
      },
    ];
    await registerJobs({ queue, definitions: defs, worker: true });
    const schedules = await queue.boss.getSchedules();
    expect(schedules.map((s) => s.name).sort()).toEqual([
      "idempotency.sweep",
      "outbox.sweep",
      "test.echo",
    ]);
    await queue.send("outbox.sweep", {});
    await queue.send("test.echo", { hello: "direct" });
    await waitFor(() => seen.includes("outbox.swept") && seen.includes('echo:{"hello":"direct"}'));
    expect(
      await pg.pool
        .query("SELECT count(*)::int AS n FROM core.outbox WHERE processed_at IS NOT NULL")
        .then((r) => r.rows[0]?.["n"]),
    ).toBe(0);
    await queue.unschedule("test.echo");
  });
});
