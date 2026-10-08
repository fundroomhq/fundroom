# @fundroom/queue-pgboss

`JobQueuePort` over [pg-boss](https://github.com/timgit/pg-boss) 12. Postgres is the only datastore: jobs live in the `pgboss` schema
of the application database, fetched with `SKIP LOCKED`.

```ts
import { createPgBossQueue } from "@fundroom/queue-pgboss";

const queue = createPgBossQueue({ pool: db.pool, log });
await queue.start();                       // migrates the pgboss schema, grants seedhost_app
await queue.ensureQueue("updates.send", { retryLimit: 5 });
await queue.work("updates.send", async (job) => { /* … */ });
await db.withTenant(ctx, async (tx) => {
  // committed together with the domain change
  await queue.sendInTransaction(tx, "updates.send", { postId }, { idempotencyKey: `send:${postId}` });
});
```

- Every queue created with `deadLetter: true` (the default) routes exhausted jobs to the
  shared `dead-letter` queue; `queue.deadLetters.list() / count() / get(id) / retry(id) /
  discard(id)` back the admin jobs page and `fundroom jobs dlq`.
- The dead-letter reads are our own parameterised SQL over pg-boss 12's `<schema>.job` table
  (the partition root, or the plain table when partitioning is off), `WHERE name =
  'dead-letter' AND state < 'active'` — not `findJobs`, which can neither filter by payload
  nor count without loading every row. `list({ workspaceId, limit })` and
  `count({ workspaceId })` filter on `data->>'workspaceId'` in SQL; a job whose payload names
  no workspace matches no filter (it is instance work). `list` is newest first, `limit`
  defaults to 100 and is capped at 1000. `get(id)` answers null for an unknown, already
  handled or non-uuid id, and `retry` / `discard` answer false for a non-uuid id rather than
  surfacing a Postgres cast error. There is no index on the payload key: the dead-letter queue
  is expected to stay small, and the scan is confined to its partition.
- `retry(id)` is idempotent under concurrency: on one pooled client it runs `BEGIN; DELETE …
  WHERE name = 'dead-letter' AND id = $id AND state < 'active' RETURNING source_name, data;`
  then `send()` into the source queue on the same client, then `COMMIT`. The DELETE's row lock
  makes a concurrent second retry wait and then claim nothing (it answers false), so a double
  click re-runs the job once; a failed send rolls the dead letter back. (A pool without
  `connect()` does the claim and the send as two statements: still never twice, but a crash
  in between loses the job.)
- `schedule: false` keeps pg-boss's cron timekeeper off (the operator CLI's one-shot commands).
- `idempotencyKey` maps to pg-boss's `singletonKey`; how duplicates are treated depends on
  the queue `policy` (`short` = one queued job per key, which is what the outbox relay uses).
- Transactional enqueues run as `seedhost_app` inside `withTenant()`/`withHost()`;
  `start()` and `ensureQueue()` grant that role access to the pg-boss tables. The grant batch
  is one transaction behind pg-boss's own install and `create-queue` advisory locks, so
  processes starting together on a fresh database (`app` and `worker`) take turns instead of
  failing one side with "tuple concurrently updated"; that error (and the `pg_default_acl`
  unique violation of two concurrent first ALTER DEFAULT PRIVILEGES) is also retried a few
  times, for a replica still running a build without the lock. The wait for the locks
  is bounded by `lock_timeout` (`grantLockTimeoutMs`, per lock, default 30 s like pg-boss's
  own); past it the start fails with an error naming the lock. A pool that cuts queries
  client-side should pass `grantLockTimeoutWithin({ clientTimeoutMs, graceMs })`, so both waits
  end inside its bound (the server does).
- `start()` is all or nothing: if pg-boss's own `start()` or anything after it fails, pg-boss
  is stopped again (its `stop()` also clears a partial start; the stop gets 5 s, then is
  abandoned with a log line) before the error surfaces, so its timers cannot keep a failed process alive.
- LISTEN/NOTIFY is disabled (PgBouncer-safe); workers poll (2 s default).
