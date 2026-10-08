# Runbook: queue backlog and stuck jobs

Everything the install does in the background runs as a job on pg-boss, in the same Postgres as everything else: scanning and rendering uploads, sending investor updates, notifications and digests, erasure steps, exports, search rebuilds, nightly maintenance. Domain events reach those jobs through a transactional outbox. This runbook is for whoever operates the install: how to tell a slow queue from a stuck one, where the backlog is (outbox, queue or dead letters), what `WORKER_CONCURRENCY` does and does not change, and what to do with a dead letter.

## What has to be true first

- **You know which processes have the `worker` role.** Jobs are only *worked* by a process whose roles include `worker`; every process can *enqueue*. The reference Compose stack runs one `app` process with `ROLES=api,web,worker` and `WORKER_MODE=embedded` — so the worker is inside `app`. With a separate worker, `app` runs `WORKER_MODE=external` (or `ROLES=api,web`) and a second process runs `ROLES=worker` with `WORKER_MODE` unset. (`ROLES=worker` together with `WORKER_MODE=external` is refused at boot: it describes a worker process that is told another process is the worker.)
- **You can run the CLI:** `docker compose run --rm app <command>`. The image's entrypoint is the CLI and it has no shell.
- **You can reach Postgres as the owner:** `docker compose exec db psql -U seedhost -d seedhost`. The queries below read the `pgboss` and `core` schemas directly; they are read-only.
- **Instance-wide queue numbers exist only in single-tenant mode** on the admin screens. With `TENANCY_MODE=multi`, the **Jobs** page shows each workspace its own dead letters and nothing else — queue depths are every customer's traffic — so the operator's tools are the CLI and SQL.

## How work flows

```
domain write ──same transaction──▶ core.outbox row
                                        │  outbox relay (every OUTBOX_POLL_INTERVAL_MS, 100 rows per batch)
                                        ▼
                         pgboss.job on event.<topic>, one per subscriber
                                        │  worker (WORKER_CONCURRENCY per topic)
                                        ▼
                              handler ── throws ──▶ retry with backoff ── exhausted ──▶ dead-letter
```

Jobs that are not events — `data-room.ingest`, `updates.send`, `notify.send`, `portability.export`, `search.reindex`, and the cron jobs such as `crypto.rewrap`, `workspace.purge` and `audit.checkpoint` — are enqueued directly (usually in the same transaction as the write that caused them) and skip the outbox.

The relay runs in every process with the `api` role, and in a process whose only role is `worker`. Several relays coexist safely (`FOR UPDATE SKIP LOCKED`).

| Queue | Retries | First retry after | Worked at once, per process |
|---|---|---|---|
| `event.<topic>` | 5, exponential backoff | 10 s | `WORKER_CONCURRENCY` (default 5), per topic |
| `data-room.ingest` | 5, exponential backoff | 15 s | 2 |
| `updates.send` | 5, exponential backoff | 30 s | 2 |
| `notify.send` | 3, exponential backoff | 15 s | 4 |
| `search.reindex` | 3, exponential backoff | 5 s | 2 |
| `portability.export` | none, and **no dead letter** — a failed export is marked failed on its row and the owner starts another | | 1 |
| everything else | 3 by default, exponential backoff | 5 s | 1 |
| `dead-letter` | never worked | | — |

A job that exhausts its retries lands in the one shared `dead-letter` queue, with its source queue, payload and last error. It stays there until someone retries or discards it.

## Where is the backlog?

**1. Is anything working the queues at all?** A backlog with nothing active is a missing worker, not a slow one.

```
docker compose ps
docker compose logs app 2>&1 | grep '"event":"container.started"' | tail -n 3
```

`container.started` is logged once per process start and lists its `roles` and the `jobs` it registered; one of the running processes must include `worker` (with a separate worker, read `docker compose logs worker` the same way). The common causes of "no worker": `WORKER_MODE=external` on `app` with no worker process running (in Compose, the `worker` profile is not enabled: `COMPOSE_PROFILES=worker` in `.env`, then `docker compose up -d`), or `WORKER_MODE=off`.

**2. What is queued, and how old is it?**

```
docker compose exec db psql -U seedhost -d seedhost -c "
  SELECT name, state, count(*), min(created_on) AS oldest
    FROM pgboss.job
   WHERE state IN ('created', 'retry', 'active')
   GROUP BY 1, 2 ORDER BY 3 DESC;"
```

On a single-tenant install the same numbers are on **Jobs → Queues** in the admin, and on `GET /api/v1/ops/jobs` (`queues[].queued/active/failed`; needs `ops.read`).

Read it like this:

- **Many `created`, few or no `active`** on a queue: nothing is taking work — question 1 — or the queue's per-process concurrency is saturated by long jobs (see question 5).
- **Many `retry`**: a dependency is failing and the jobs are backing off. The queue name says which: `data-room.ingest` is usually the virus scanner ([av-failure.md](av-failure.md)); `updates.send` and `notify.send` are mail; `event.*` depends on the subscriber. Fix the dependency; do not raise concurrency, which only spends retries faster.
- **`active` rows older than the queue's expiry** (15 minutes by default, 30 for ingest): a worker died holding them. pg-boss expires them and they come back as retries on their own; a restart does not lose them.

**3. Is the outbox draining?** A backlog *before* the queue looks like events that never happen at all — no notifications, erasure requests that never progress — while `pgboss.job` looks healthy.

```
docker compose exec db psql -U seedhost -d seedhost -c "
  SELECT count(*) AS pending, min(created_at) AS oldest, max(attempts) AS max_attempts
    FROM core.outbox WHERE processed_at IS NULL;"
```

A handful of pending rows younger than a few seconds is the relay's poll interval. A growing count means no relay is running (no process with the `api` role, and no worker-only process) or the database is refusing it. Rows that failed to enqueue carry `last_error` and back off exponentially up to an hour each, on their own, without blocking the rows behind them:

```
docker compose exec db psql -U seedhost -d seedhost -c "
  SELECT id, topic, attempts, available_at, left(last_error, 200)
    FROM core.outbox WHERE processed_at IS NULL AND last_error IS NOT NULL
   ORDER BY id LIMIT 20;"
```

The logs say the same thing as `outbox.row_failed` with the outbox id and topic. An unknown topic or a payload that no longer parses after an upgrade is a bug to report with that line; it will not heal by waiting.

**4. What is in the dead-letter queue?**

```
docker compose run --rm app jobs dlq list --limit 50
```

One line per dead letter, tab-separated: id, failure time, source queue, the workspace its payload names (`-` for instance work), retry count, event topic (`-` if not an event) and the first line of the error. The payload is never printed. `--workspace <uuid>` narrows it to one workspace. A workspace's owner or admin sees the same list for their own workspace under **Jobs → Failed jobs**.

**5. Is it just slow?** Look at the rate, not the depth: run question 2 twice, five minutes apart. A queue that drains is a capacity question — the next section. The usual reason is a burst that is working as designed: a bulk upload is one `data-room.ingest` job per file, worked two at a time per process, and each scan and render takes seconds.

`/metrics` does not help here. It carries HTTP request duration and in-flight requests (`http_server_request_duration`, `http_server_active_requests`) and nothing about jobs or the outbox; alert on the SQL above instead, for example `min(created_on)` of `created` jobs older than 15 minutes.

## Add capacity

**`WORKER_CONCURRENCY` sets how many jobs of each `event.*` topic one process works at once, and nothing else.** The job queues in the table above have their concurrency fixed in code — raising `WORKER_CONCURRENCY` does not make uploads scan faster or updates send faster. Those scale with **more worker processes**: each one works its own two ingests, two sends and so on.

- **Compose, embedded worker:** set `WORKER_CONCURRENCY` in `deploy/compose/.env` and `docker compose up -d`; it reaches `app` and, if you run one, `worker` (empty means the default, 5).
- **Compose, separate worker:** put both `COMPOSE_PROFILES=worker` and `WORKER_MODE=external` in `.env`, then `docker compose up -d`. The profile starts the `worker` service (`ROLES=worker`); `WORKER_MODE=external` stops `app` from consuming jobs as well. For more than one worker process, `docker compose up -d --scale worker=2`. **A second process needs `STORAGE_DRIVER=s3`**: the default `fs` storage is a volume on one node, and a worker that cannot see the file an upload wrote cannot scan it.
- **Kubernetes and PaaS templates** run a separate worker deployment or service already; scale its replica count.

Every worker holds database connections (`DATABASE_POOL_MAX`, default 10 per process). Before adding processes, check that Postgres's `max_connections` (100 in the reference Compose stack) covers every process's pool plus headroom.

## Dead letters: retry or discard

Handlers are idempotent by construction — every job carries an idempotency key and the work it records is claimed in the same transaction — so **retrying a dead letter whose cause is fixed is always safe**, including one that half-ran.

```
docker compose run --rm app jobs dlq retry <id>
docker compose run --rm app jobs dlq discard <id>
```

`retry` puts the job back on its source queue with a fresh retry budget; `discard` deletes it for good. Both are recorded on the platform audit trail as `ops.dead_letter_retried` / `ops.dead_letter_discarded` with `via: cli`. Exit status: 0 done, 1 no such dead letter, 2 usage. In the admin the same actions are on **Jobs → Failed jobs**, scoped to the workspace, and discarding there asks for a fresh sign-in.

Retry only after fixing what the error line names; otherwise the job spends another full set of retries and comes straight back. Discard only when the work must not happen any more — an update send to a recipient who has since been erased, an export nobody wants — because a discarded job is the last copy of that work. When in doubt, leave it: a dead letter costs nothing while it waits.

There is no bulk retry. For a large incident, retry one, confirm it succeeds, then loop over the ids from `jobs dlq list`:

```
docker compose run --rm -T app jobs dlq list --limit 1000 2>/dev/null \
  | awk -F'\t' '$3 == "data-room.ingest" { print $1 }' \
  | while read -r id; do docker compose run --rm -T app jobs dlq retry "$id" </dev/null; done
```

(`-T` keeps the list on stdout and the summary line on stderr, which a terminal would otherwise merge. Each `run` starts a container; for hundreds of ids this takes a while, and that is fine.)

## Things that look like a stuck queue and are not

- **Scheduled jobs are UTC.** `crypto.rewrap` 03:20, `workspace.purge` 04:20, `audit.checkpoint` 02:10, the data room's reconcile on Sundays. Nothing runs them early.
- **A cron job that runs while the previous run is still going** is skipped or queued behind it by its queue policy; it is not lost.
- **An erasure request that sits at "waiting for modules"** is a chain of `event.member.erasure_requested` jobs, one per module; check that queue and the dead letters before assuming the request is stuck.
- **After an upgrade**, the search index rebuilds itself through `search.reindex` (enqueued by the 10-minute `search.sweep`). A burst of those is expected.

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `ROLES` | app | `api,web,worker` |
| `WORKER_MODE` | app | unset (`embedded` in the reference Compose `app` service) |
| `WORKER_CONCURRENCY` | worker | `5`, 1–64; applies to `event.*` queues |
| `JOBS_POLL_INTERVAL_MS` | worker | `2000` |
| `OUTBOX_POLL_INTERVAL_MS` | api (and a worker-only process) | `1000` |
| `SHUTDOWN_TIMEOUT_MS` | every process | `25000` — how long `SIGTERM` waits for running jobs |
| `DATABASE_POOL_MAX` | every process | `10` |
| `STORAGE_DRIVER` | every process | `fs` (single node only) |
| `TENANCY_MODE` | app | `single` |
