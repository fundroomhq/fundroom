import { randomUUID } from "node:crypto";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgBossQueue, DEAD_LETTER_QUEUE, type PgBossQueue } from "./pgboss-queue.js";

/*
 * The dead-letter reads the admin jobs page stands on (E2.7): `list` / `count` filtered by the
 * payload's `workspaceId` in SQL over pg-boss's own job table, `get` by id, and `retry` /
 * `discard` still behaving after the reads moved off `findJobs`. Jobs reach the dead-letter
 * queue the real way — a handler throws with `retryLimit: 0` — so the row shape (`source_name`,
 * `output`, `source_retry_count`) is whatever pg-boss 12 actually writes, not a fixture's guess.
 */
let pg: TestPostgres;
let queue: PgBossQueue;
const WS_A = randomUUID();
const WS_B = randomUUID();
const QUEUE = "opstest.fail";
let runs = 0;
let failing = true;

async function waitForAsync(pred: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  // pg-boss grants its schema to the app role; the bare test database has none.
  await pg.pool.query(
    "DO $$ BEGIN CREATE ROLE seedhost_app NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$",
  );
  queue = createPgBossQueue({ pool: pg.pool, pollIntervalMs: 500, supervise: false });
  await queue.start();
  await queue.ensureQueue(QUEUE, { retryLimit: 0, retryBackoff: false });
  await queue.work(QUEUE, async () => {
    runs++;
    if (failing) throw new Error("boom: carol@example.com could not be reached");
  });
  await queue.send(QUEUE, { workspaceId: WS_A, email: "carol@example.com", n: 1 });
  await queue.send(QUEUE, { workspaceId: WS_A, email: "dave@example.com", n: 2 });
  await queue.send(QUEUE, { workspaceId: WS_B, n: 3 });
  await queue.send(QUEUE, { n: 4 });
  await waitForAsync(async () => (await queue.deadLetters.count()) === 4);
}, 180_000);

afterAll(async () => {
  await queue?.stop({ timeoutMs: 1_000 });
  await pg?.stop();
});

describe("dead letters", () => {
  it("counts per workspace in SQL, and a job without a workspaceId matches no filter", async () => {
    expect(await queue.deadLetters.count()).toBe(4);
    expect(await queue.deadLetters.count({ workspaceId: WS_A })).toBe(2);
    expect(await queue.deadLetters.count({ workspaceId: WS_B })).toBe(1);
    expect(await queue.deadLetters.count({ workspaceId: randomUUID() })).toBe(0);
  });

  it("lists only the workspace's own dead letters, newest first, honouring limit", async () => {
    const a = await queue.deadLetters.list({ workspaceId: WS_A });
    expect(a).toHaveLength(2);
    expect(a.every((j) => j.data["workspaceId"] === WS_A)).toBe(true);
    expect(a[0]?.failedAt).toBeInstanceOf(Date);
    expect(a[0]?.failedAt.getTime()).toBeGreaterThanOrEqual(a[1]?.failedAt.getTime() ?? 0);
    expect(a[0]).toMatchObject({ sourceQueue: QUEUE, retries: 0 });
    expect(JSON.stringify(a[0]?.error)).toContain("boom");
    expect(await queue.deadLetters.list({ workspaceId: WS_A, limit: 1 })).toHaveLength(1);
    expect(await queue.deadLetters.list({ limit: 2 })).toHaveLength(2);
    expect(await queue.deadLetters.list()).toHaveLength(4);
  });

  it("gets one by id, and answers null for an unknown or malformed id", async () => {
    const [first] = await queue.deadLetters.list({ workspaceId: WS_B });
    const got = await queue.deadLetters.get(first?.id as string);
    expect(got).toMatchObject({ id: first?.id, sourceQueue: QUEUE, data: { workspaceId: WS_B } });
    expect(await queue.deadLetters.get(randomUUID())).toBeNull();
    expect(await queue.deadLetters.get("not-a-uuid")).toBeNull();
    expect(await queue.deadLetters.retry("not-a-uuid")).toBe(false);
    expect(await queue.deadLetters.discard("not-a-uuid")).toBe(false);
  });

  it("a job still active on its source queue is not a dead letter", async () => {
    // Every row `get` can answer lives on the dead-letter queue; a source-queue job id is not one.
    const { rows } = await pg.pool.query(
      `SELECT id::text AS id FROM pgboss.job WHERE name = $1 LIMIT 1`,
      [QUEUE],
    );
    const sourceId = (rows[0] as { id: string } | undefined)?.id;
    if (sourceId !== undefined) expect(await queue.deadLetters.get(sourceId)).toBeNull();
    const { rows: dlq } = await pg.pool.query(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1`,
      [DEAD_LETTER_QUEUE],
    );
    expect((dlq[0] as { n: number }).n).toBe(4);
  });

  it("discard removes one; retry re-runs it on its source queue and removes it", async () => {
    const [b] = await queue.deadLetters.list({ workspaceId: WS_B });
    expect(await queue.deadLetters.discard(b?.id as string)).toBe(true);
    expect(await queue.deadLetters.get(b?.id as string)).toBeNull();
    expect(await queue.deadLetters.count({ workspaceId: WS_B })).toBe(0);

    failing = false;
    const before = runs;
    const [a] = await queue.deadLetters.list({ workspaceId: WS_A, limit: 1 });
    expect(await queue.deadLetters.retry(a?.id as string)).toBe(true);
    expect(await queue.deadLetters.retry(a?.id as string)).toBe(false);
    await waitForAsync(async () => runs > before);
    expect(await queue.deadLetters.count({ workspaceId: WS_A })).toBe(1);
    expect(await queue.deadLetters.count()).toBe(2);
  });

  it("concurrent retries of one dead letter re-send it exactly once (E2.7 L3)", async () => {
    const [a] = await queue.deadLetters.list({ workspaceId: WS_A, limit: 1 });
    const n = a?.data["n"];
    const results = await Promise.all(
      Array.from({ length: 4 }, () => queue.deadLetters.retry(a?.id as string)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    // The original failed row stays `failed`; every re-send is a new, non-failed row.
    const { rows } = await pg.pool.query(
      `SELECT count(*)::int AS n FROM pgboss.job
        WHERE name = $1 AND data->>'n' = $2 AND state <> 'failed'`,
      [QUEUE, String(n)],
    );
    expect((rows[0] as { n: number }).n).toBe(1);
    expect(await queue.deadLetters.count({ workspaceId: WS_A })).toBe(0);
  });
});

describe("a transactional enqueue on a one-connection pool", () => {
  it("never needs a second connection, also right after ensureQueue re-applied a queue's options", async () => {
    // pg-boss resolves a queue through its in-memory cache and, on a miss, through ITS OWN pool
    // query. `updateQueue` (every restart's `ensureQueue` of an existing queue) evicts the entry,
    // so the next `sendInTransaction` — whose caller holds the pool's only connection in its
    // transaction — waited for a second connection until the pool timed out.
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({
      connectionString: pg.connectionString,
      max: 1,
      connectionTimeoutMillis: 3_000,
    });
    const single = createPgBossQueue({ pool, pollIntervalMs: 500, supervise: false });
    try {
      await single.start();
      await single.ensureQueue("opstest.cold", { retryLimit: 1 });
      // A restart: the queue exists, so its options are re-applied (updateQueue).
      await single.ensureQueue("opstest.cold", { retryLimit: 2 });
      const db = drizzle(pool);
      const id = await db.transaction((tx) =>
        single.sendInTransaction(tx, "opstest.cold", { n: 1 }),
      );
      expect(id).toEqual(expect.any(String));
    } finally {
      await single.stop({ timeoutMs: 1_000 });
      await pool.end();
    }
  }, 60_000);
});

describe("worker concurrency and the pool size", () => {
  /** Runs `jobs` jobs through `work(…, { concurrency })` and answers how many ran at once. */
  async function peakOf(q: PgBossQueue, name: string, concurrency: number, jobs: number) {
    await q.ensureQueue(name, { retryLimit: 0, retryBackoff: false });
    for (let n = 0; n < jobs; n++) await q.send(name, { n });
    let running = 0;
    let peak = 0;
    let done = 0;
    await q.work(
      name,
      async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 1_500));
        running--;
        done++;
      },
      { concurrency },
    );
    await waitForAsync(async () => done === jobs);
    return peak;
  }

  it("runs no more handlers at once than maxConcurrency (the pool size): every extra local worker is only another poller", async () => {
    // Uncapped, three local workers do run three jobs at once — so the capped run below is
    // measuring the cap, not a queue that never parallelises.
    expect(await peakOf(queue, "opstest.uncapped", 3, 3)).toBeGreaterThan(1);
    const capped = createPgBossQueue({
      pool: pg.pool,
      pollIntervalMs: 500,
      supervise: false,
      schedule: false,
      maxConcurrency: 1,
    });
    try {
      await capped.start();
      expect(await peakOf(capped, "opstest.capped", 3, 3)).toBe(1);
    } finally {
      await capped.stop({ timeoutMs: 1_000 });
    }
  }, 60_000);
});
