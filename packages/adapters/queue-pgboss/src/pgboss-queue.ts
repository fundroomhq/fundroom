import type {
  ActiveJob,
  DeadLetterJob,
  DeadLetterQueue,
  JobHandler,
  JobQueuePort,
  JsonObject,
  JsonValue,
  QueueOptions,
  QueueStats,
  SendOptions,
  TransactionHandle,
  WorkOptions,
} from "@fundroom/ports";
import { JOB_NAME_RE } from "@fundroom/ports";
import type { SendOptions as BossSendOptions, Job } from "pg-boss";
import { PgBoss } from "pg-boss";
import { pgBossDbFor } from "./repos/drizzle-tx.js";

/*
 * `JobQueuePort` over pg-boss 12 (EXECUTION_PLAN §5.2, design/07 §6.2, ADR-0005).
 *
 *  - Shares the application's pg pool through pg-boss's `db` seam (one pool per process).
 *    pg-boss owns the `pgboss` schema and migrates it on `start()`; that runs as the pool
 *    user (the table owner), never through withTenant().
 *  - Transactional enqueue: `sendInTransaction(tx, …)` wraps the drizzle transaction with
 *    pg-boss's own adapter, so the INSERT into the job table is part of the caller's
 *    transaction. Those transactions run as `seedhost_app`, hence the grants below.
 *  - One shared dead-letter queue (`dead-letter`) for every queue created with
 *    `deadLetter: true` (the default). `deadLetters` lists/retries/discards for the admin
 *    jobs page (E2.7). The reads (`list`, `count`, `get`) are our own SQL over pg-boss's
 *    `<schema>.job` table rather than `findJobs`, because the admin page must filter by the
 *    payload's `workspaceId` and count without loading every row — `findJobs` does neither.
 *    `job` is the partition root in pg-boss 12 (`PARTITION BY LIST (name)`) and the physical
 *    table when partitioning is off, so `WHERE name = 'dead-letter'` is correct, and pruned,
 *    under both install shapes. Only the queued states count (`state < 'active'`, the enum's
 *    order — what `findJobs({ queued: true })` means): a dead letter is never worked, so it
 *    stays `created` until retried or discarded.
 *  - LISTEN/NOTIFY is off: it needs a session-pinned connection and is incompatible with
 *    PgBouncer transaction pooling; polling is the correctness floor anyway.
 */
export const DEAD_LETTER_QUEUE = "dead-letter";
export const DEFAULT_PGBOSS_SCHEMA = "pgboss";

export interface PgBossQueueOptions {
  /** The application pool (`Database.pool`) or anything with `query(text, values)`. */
  readonly pool: {
    query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
    /**
     * A dedicated client (`pg.Pool#connect`), used to make a dead-letter retry one transaction.
     * Without it a retry still never sends twice, but a crash between delete and send loses it.
     */
    connect?(): Promise<PooledClient>;
  };
  readonly schema?: string;
  /** Role that runs transactional enqueues (`withTenant`); granted access to the schema. */
  readonly appRole?: string;
  /** Default poll interval for workers. Default 2000 ms; tests use 500. */
  readonly pollIntervalMs?: number;
  /** Run pg-boss maintenance/supervision in this process. Default true; set false on api-only nodes. */
  readonly supervise?: boolean;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
  /** Queue defaults applied by `ensureQueue` when the caller gives none. */
  readonly queueDefaults?: QueueOptions;
  /**
   * Run pg-boss's cron timekeeper in this process. Default true. The operator CLI
   * (`fundroom jobs dlq …`) sets it false: a one-shot command must not start firing schedules.
   */
  readonly schedule?: boolean;
  /**
   * The most local workers one `work()` call may run — the size of the pool the handlers draw
   * from (`DATABASE_POOL_MAX`). Every local worker is its own poller on `pool`, and every running
   * handler holds one of its connections, so a concurrency above the pool size buys no
   * parallelism: the extra workers only queue fetches ahead of the requests sharing the pool.
   * On a one-connection pool the ~250 pollers of an embedded worker (37 event topics × 5) kept
   * the connection's wait queue ~250 deep, and a request waited behind all of it. Default: no cap.
   */
  readonly maxConcurrency?: number;
  /**
   * How long the start-up grant waits for EACH of pg-boss's two advisory locks before it fails
   * the start (server-side `lock_timeout`). Default 30 s, pg-boss's own value for its locked
   * statements. A pool that cuts queries client-side must fit both waits inside that bound:
   * see `grantLockTimeoutWithin`.
   */
  readonly grantLockTimeoutMs?: number;
}

export interface PooledClient {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

const DEFAULT_QUEUE: Required<QueueOptions> = {
  policy: "standard",
  retryLimit: 3,
  retryDelaySeconds: 5,
  retryBackoff: true,
  expireInSeconds: 15 * 60,
  deadLetter: true,
};

const ROLE_RE = /^[a-z_][a-z0-9_]*$/u;
const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/u;

export interface PgBossQueue extends JobQueuePort {
  /** The underlying instance, for tests and the admin page; not for application code. */
  readonly boss: PgBoss;
}

export function createPgBossQueue(options: PgBossQueueOptions): PgBossQueue {
  const schema = options.schema ?? DEFAULT_PGBOSS_SCHEMA;
  const appRole = options.appRole ?? "seedhost_app";
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid pg-boss schema ${JSON.stringify(schema)}`);
  if (!ROLE_RE.test(appRole)) throw new Error(`invalid appRole ${JSON.stringify(appRole)}`);
  const log = options.log ?? (() => {});
  const pollingIntervalSeconds = Math.max(0.5, (options.pollIntervalMs ?? 2000) / 1000);
  const maxConcurrency = Math.max(
    1,
    Math.floor(options.maxConcurrency ?? Number.POSITIVE_INFINITY),
  );
  const defaults = { ...DEFAULT_QUEUE, ...stripUndefined(options.queueDefaults ?? {}) };

  const boss = new PgBoss({
    db: {
      executeSql: (text, values) =>
        options.pool.query(text, values) as Promise<{ rows: unknown[] }>,
    },
    schema,
    supervise: options.supervise ?? true,
    schedule: options.schedule ?? true,
    useListenNotify: false,
    application_name: "fundroom",
  });
  boss.on("error", (error) => log("jobs.error", { error: String(error) }));
  boss.on("warning", (warning) => log("jobs.warning", { message: warning.message }));

  let started = false;
  const ensured = new Set<string>();

  /*
   * E-UP-10: `app` and `worker` both run this at boot, and on a fresh database they run it at
   * the same moment. GRANT and ALTER DEFAULT PRIVILEGES rewrite catalog rows (`pg_namespace`,
   * every `pg_class` row in the schema, `pg_default_acl`) without taking a lock that makes a
   * second writer wait, so two concurrent batches fail one side with "tuple concurrently
   * updated" (XX000). The batch is therefore one transaction (a multi-statement simple query is
   * one implicit transaction) that first takes two transaction-scoped advisory locks, always in
   * this order:
   *  - pg-boss's own install/migrate lock (key ''), so a grant never interleaves with a schema
   *    migration another process is running;
   *  - pg-boss's `create-queue` lock, so a grant never interleaves with `create_queue` creating
   *    and attaching a partition table in another process — and every one of our grants waits
   *    for every other.
   * pg-boss takes each of those locks alone, never both, so taking them in a fixed order cannot
   * deadlock with it. The keys are pg-boss's own expression (`advisoryLockKey` in its
   * plans.js) for a bare lowercase schema, which is the only kind SCHEMA_RE admits. A replica
   * still running a build without the lock (a rolling deploy) can race us anyway, so a
   * "tuple concurrently updated" — or the unique violation a concurrent first ALTER DEFAULT
   * PRIVILEGES raises on `pg_default_acl` — is retried a few times as well. The wait for the
   * locks is bounded server-side (`lock_timeout`, pg-boss's own 30 s by default), so a process
   * stuck holding one fails this start with a message naming the lock instead of hanging it.
   */
  const grantLockTimeoutMs = Math.max(
    1,
    Math.floor(options.grantLockTimeoutMs ?? DEFAULT_GRANT_LOCK_TIMEOUT_MS),
  );
  const grantSql = [
    `SET LOCAL lock_timeout = ${grantLockTimeoutMs}`,
    `SELECT pg_advisory_xact_lock(${pgBossLockKey(schema, "")})`,
    `SELECT pg_advisory_xact_lock(${pgBossLockKey(schema, "create-queue")})`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${appRole}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${appRole}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${appRole}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${appRole}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${appRole}`,
  ].join(";\n");

  async function grantAppRole(): Promise<void> {
    // pg-boss inserts into each queue's partition table directly, so a blanket grant on the
    // schema (plus default privileges for tables it creates later) is what the app role needs.
    for (let attempt = 1; ; attempt++) {
      try {
        await options.pool.query(grantSql);
        return;
      } catch (error) {
        if (isLockTimeout(error)) {
          throw new Error(
            `granting ${appRole} access to schema ${schema} gave up after ${grantLockTimeoutMs} ms waiting for a lock (most likely pg-boss's install/create-queue advisory lock, held by another process): ${String(error)}`,
            { cause: error },
          );
        }
        if (attempt >= GRANT_ATTEMPTS || !isConcurrentCatalogUpdate(error)) throw error;
        log("jobs.grant_retry", { attempt, error: String(error) });
        await new Promise((r) => setTimeout(r, 50 * attempt + Math.floor(Math.random() * 50)));
      }
    }
  }

  function assertName(name: string): void {
    if (name !== DEAD_LETTER_QUEUE && !JOB_NAME_RE.test(name)) {
      throw new Error(`job/queue name ${JSON.stringify(name)} must match <module>.<verb>`);
    }
  }

  function requireStarted(): void {
    if (!started) throw new Error("job queue not started; call start() first");
  }

  function toSendOptions(o: SendOptions | undefined): BossSendOptions {
    const out: BossSendOptions = {};
    if (o?.idempotencyKey !== undefined) out.singletonKey = o.idempotencyKey;
    if (o?.startAfter !== undefined) out.startAfter = o.startAfter;
    if (o?.priority !== undefined) out.priority = o.priority;
    return out;
  }

  /**
   * Puts the queue into pg-boss's in-memory queue cache, here, on the pool, outside any
   * transaction. pg-boss resolves a queue through that cache on every send and, on a miss,
   * through its OWN pool query — and `updateQueue` (every restart's re-apply below) evicts the
   * entry, while `createQueue` never adds one. A miss inside `sendInTransaction` therefore asks
   * the pool for a second connection while the caller holds one in its transaction: on a small
   * pool, under load, or on a one-connection pool that waits until the pool times out (the E3.4
   * one-connection regression). There is no public "cache this queue" call; `complete` on a
   * nil id resolves the queue through the cache and matches no job. A failure is only logged —
   * the periodic refresh (`queueCacheIntervalSeconds`) repopulates the cache anyway.
   */
  async function warmQueueCache(name: string): Promise<void> {
    try {
      await boss.complete(name, "00000000-0000-0000-0000-000000000000");
    } catch (error) {
      log("jobs.queue_cache_warm_failed", {
        name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function ensureQueue(name: string, queue?: QueueOptions): Promise<void> {
    requireStarted();
    assertName(name);
    const q = { ...defaults, ...stripUndefined(queue ?? {}) };
    if (name !== DEAD_LETTER_QUEUE && q.deadLetter && !ensured.has(DEAD_LETTER_QUEUE)) {
      await ensureQueue(DEAD_LETTER_QUEUE, {
        deadLetter: false,
        retryLimit: 0,
        policy: "standard",
      });
    }
    const spec = {
      policy: q.policy,
      retryLimit: q.retryLimit,
      retryDelay: q.retryDelaySeconds,
      retryBackoff: q.retryBackoff,
      expireInSeconds: q.expireInSeconds,
      ...(name !== DEAD_LETTER_QUEUE && q.deadLetter ? { deadLetter: DEAD_LETTER_QUEUE } : {}),
    };
    const existing = await boss.getQueue(name);
    if (existing) {
      // createQueue is ON CONFLICT DO NOTHING; apply retry/expiry changes explicitly. The
      // storage policy is fixed at creation (pg-boss), so a mismatch is reported, not applied.
      const { policy, ...mutable } = spec;
      if ((existing.policy ?? "standard") !== policy) {
        log("jobs.queue_policy_mismatch", { name, existing: existing.policy, wanted: policy });
      }
      await boss.updateQueue(name, mutable);
    } else {
      await boss.createQueue(name, spec);
      await grantAppRole();
    }
    await warmQueueCache(name);
    ensured.add(name);
  }

  // `$1` is always the dead-letter queue name; `$2` the workspace filter (NULL = every job).
  const DLQ_WHERE = `name = $1 AND state < 'active' AND ($2::text IS NULL OR data->>'workspaceId' = $2::text)`;
  const DLQ_COLUMNS = `id::text AS id, source_name, data, output, created_on, source_retry_count`;

  const deadLetters: DeadLetterQueue = {
    async list(o) {
      requireStarted();
      const limit = clampLimit(o?.limit);
      const { rows } = await options.pool.query(
        `SELECT ${DLQ_COLUMNS} FROM ${schema}.job WHERE ${DLQ_WHERE}
          ORDER BY created_on DESC, id DESC LIMIT $3`,
        [DEAD_LETTER_QUEUE, o?.workspaceId ?? null, limit],
      );
      return (rows as DeadLetterRow[]).map(toDeadLetter);
    },
    async count(o) {
      requireStarted();
      const { rows } = await options.pool.query(
        `SELECT count(*)::int AS n FROM ${schema}.job WHERE ${DLQ_WHERE}`,
        [DEAD_LETTER_QUEUE, o?.workspaceId ?? null],
      );
      return Number((rows[0] as { n: number | string } | undefined)?.n ?? 0);
    },
    async get(id) {
      requireStarted();
      // Not a uuid → not a job; answering null keeps a malformed id from becoming a 500.
      if (!UUID_RE.test(id)) return null;
      const { rows } = await options.pool.query(
        `SELECT ${DLQ_COLUMNS} FROM ${schema}.job WHERE ${DLQ_WHERE} AND id = $3::uuid`,
        [DEAD_LETTER_QUEUE, null, id],
      );
      const row = rows[0] as DeadLetterRow | undefined;
      return row === undefined ? null : toDeadLetter(row);
    },
    async retry(id) {
      requireStarted();
      if (!UUID_RE.test(id)) return false;
      // Claim first, then send, in one transaction: the DELETE … RETURNING takes the row lock,
      // so a concurrent second retry (a double click, two admins) waits and then deletes
      // nothing — exactly one job is re-sent. The send joins the same transaction, so a failed
      // send puts the dead letter back.
      const claim = `DELETE FROM ${schema}.job WHERE name = $1 AND id = $2::uuid AND state < 'active'
        RETURNING source_name, data`;
      const connect = options.pool.connect?.bind(options.pool);
      if (connect === undefined) {
        const { rows } = await options.pool.query(claim, [DEAD_LETTER_QUEUE, id]);
        const row = rows[0] as { source_name: string | null; data: JsonObject | null } | undefined;
        if (!row?.source_name) return false;
        await boss.send(row.source_name, row.data ?? {});
        log("jobs.dead_letter_retried", { id, source: row.source_name });
        return true;
      }
      const client = await connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(claim, [DEAD_LETTER_QUEUE, id]);
        const row = rows[0] as { source_name: string | null; data: JsonObject | null } | undefined;
        if (!row?.source_name) {
          await client.query("ROLLBACK");
          return false;
        }
        await boss.send(row.source_name, row.data ?? {}, {
          db: { executeSql: (text, values) => client.query(text, values) },
        });
        await client.query("COMMIT");
        log("jobs.dead_letter_retried", { id, source: row.source_name });
        return true;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async discard(id) {
      requireStarted();
      if (!UUID_RE.test(id)) return false;
      const [job] = await boss.findJobs(DEAD_LETTER_QUEUE, { id, queued: true });
      if (!job) return false;
      await boss.deleteJob(DEAD_LETTER_QUEUE, id);
      log("jobs.dead_letter_discarded", { id, source: job.sourceName });
      return true;
    },
  };

  return {
    boss,
    deadLetters,

    async start() {
      if (started) return;
      try {
        // Inside the try: pg-boss arms its cache, wip and supervision timers part-way through
        // its own start, and a later step (the timekeeper's clock-skew query, its queue) can
        // still fail; its `stop()` clears a partial start.
        await boss.start();
        await grantAppRole();
        started = true;
        await ensureQueue(DEAD_LETTER_QUEUE, { deadLetter: false, retryLimit: 0 });
      } catch (error) {
        // All or nothing (E-UP-10): `boss.start()` has armed (some of) pg-boss's maintenance,
        // supervision and cron timers. Left running, they keep a process whose start failed
        // alive forever, and `stop()` would skip them because `started` is false.
        started = false;
        ensured.clear();
        // Bounded: on a wedged database pg-boss's stop can wait for an in-flight query forever
        // (with no statement timeout nothing cuts it), and the start error must still surface.
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<"expired">((resolve) => {
          timer = setTimeout(() => resolve("expired"), FAILED_START_STOP_MS);
          timer.unref();
        });
        const outcome = await Promise.race([
          boss.stop({ graceful: false, close: false }).catch(() => "failed" as const),
          expired,
        ]);
        clearTimeout(timer);
        if (outcome === "expired") {
          log("jobs.stop_after_failed_start_timeout", { level: "error", ms: FAILED_START_STOP_MS });
        }
        throw error;
      }
      log("jobs.started", { schema });
    },

    async stop(o) {
      if (!started) return;
      started = false;
      await boss.stop({ graceful: true, timeout: o?.timeoutMs ?? 25_000, close: false });
      log("jobs.stopped");
    },

    ensureQueue,

    async send(name, data, o) {
      requireStarted();
      assertName(name);
      return boss.send(name, data, toSendOptions(o));
    },

    async sendInTransaction(tx: TransactionHandle, name, data, o) {
      requireStarted();
      assertName(name);
      return boss.send(name, data, { ...toSendOptions(o), db: pgBossDbFor(tx) });
    },

    async schedule(name, cron, data) {
      requireStarted();
      assertName(name);
      await boss.schedule(name, cron, data ?? {}, { tz: "UTC" });
    },

    async unschedule(name) {
      requireStarted();
      await boss.unschedule(name);
    },

    async work<T extends JsonObject>(name: string, handler: JobHandler<T>, o?: WorkOptions) {
      requireStarted();
      assertName(name);
      await boss.work<T>(
        name,
        {
          batchSize: 1,
          localConcurrency: Math.min(Math.max(1, o?.concurrency ?? 1), maxConcurrency),
          pollingIntervalSeconds:
            o?.pollIntervalMs !== undefined
              ? Math.max(0.5, o.pollIntervalMs / 1000)
              : pollingIntervalSeconds,
        },
        async (jobs: Job<T>[]) => {
          for (const job of jobs) {
            const active: ActiveJob<T> = {
              id: job.id,
              name: job.name,
              data: job.data,
              signal: job.signal,
            };
            await handler(active);
          }
        },
      );
    },

    async stats() {
      requireStarted();
      const queues = await boss.getQueues();
      return queues.map(
        (q): QueueStats => ({
          name: q.name,
          queued: q.queuedCount,
          active: q.activeCount,
          failed: q.failedCount,
        }),
      );
    },
  };
}

const GRANT_ATTEMPTS = 5;
/** How long a failed `start()` waits for pg-boss's own stop before giving up on it. */
const FAILED_START_STOP_MS = 5_000;
const DEFAULT_GRANT_LOCK_TIMEOUT_MS = 30_000;

/**
 * The `grantLockTimeoutMs` for a pool that abandons a query client-side after
 * `clientTimeoutMs` (0 = never), of which `graceMs` is the grace past the server's statement
 * timeout. The grant batch is one query that may wait on two locks in turn, so each wait gets
 * half of what is left after the grace (which stays for the grants themselves). Otherwise the
 * client's timeout fires first and hides the lock-timeout error that names the lock.
 */
export function grantLockTimeoutWithin(bound: {
  readonly clientTimeoutMs: number;
  readonly graceMs: number;
}): number {
  if (!(bound.clientTimeoutMs > 0)) return DEFAULT_GRANT_LOCK_TIMEOUT_MS;
  const perLock = Math.floor((bound.clientTimeoutMs - Math.max(0, bound.graceMs)) / 2);
  return Math.min(DEFAULT_GRANT_LOCK_TIMEOUT_MS, Math.max(1, perLock));
}

/** pg-boss's advisory lock key expression (`advisoryLockKey` in pg-boss 12's plans.js). */
function pgBossLockKey(schema: string, key: string): string {
  return `('x' || encode(sha224((current_database() || '.pgboss.${schema}${key}')::bytea), 'hex'))::bit(64)::bigint`;
}

/**
 * Two writers raced on one catalog row: "tuple concurrently updated" (XX000), or the unique
 * violation (23505) of two concurrent first ALTER DEFAULT PRIVILEGES inserting the same
 * `pg_default_acl` row.
 */
function isConcurrentCatalogUpdate(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; constraint?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  if (message.includes("tuple concurrently updated")) {
    return e?.code === undefined || e.code === "XX000";
  }
  return (
    e?.code === "23505" &&
    (e.constraint === "pg_default_acl_role_nsp_obj_index" ||
      message.includes("pg_default_acl_role_nsp_obj_index"))
  );
}

/** `lock_timeout` expired (55P03 lock_not_available). */
function isLockTimeout(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "55P03";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DEFAULT_DLQ_LIMIT = 100;
const MAX_DLQ_LIMIT = 1000;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_DLQ_LIMIT;
  return Math.min(MAX_DLQ_LIMIT, Math.max(1, Math.trunc(limit)));
}

/** A dead-letter row as `DLQ_COLUMNS` selects it, straight off `pg`. */
interface DeadLetterRow {
  readonly id: string;
  readonly source_name: string | null;
  readonly data: JsonObject | null;
  readonly output: JsonValue | null;
  readonly created_on: Date | string;
  readonly source_retry_count: number | string | null;
}

function toDeadLetter(row: DeadLetterRow): DeadLetterJob {
  return {
    id: row.id,
    sourceQueue: row.source_name ?? "",
    data: row.data ?? {},
    error: row.output ?? null,
    // `pg` parses timestamptz to Date on a plain pool; a driver that hands back text is coerced.
    failedAt: row.created_on instanceof Date ? row.created_on : new Date(row.created_on),
    retries: Number(row.source_retry_count ?? 0),
  };
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
