/**
 * Background jobs (EXECUTION_PLAN §5.2 `JobQueuePort`, design/07 §6.2). Default adapter is
 * `@fundroom/queue-pgboss` (pg-boss on the application database); graphile-worker or
 * BullMQ could implement the same surface later.
 *
 * Semantics every adapter must honour:
 *  - at-least-once delivery; handlers are idempotent (claim an idempotency key, upsert);
 *  - `sendInTransaction` enqueues inside the caller's database transaction (the outbox
 *    relay uses it so "mark processed" and "job created" commit or roll back together);
 *  - a queue's `retryLimit` exhausted → the job lands in the dead-letter queue, which the
 *    admin UI (E2.7) lists, retries and discards through `deadLetters`.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/** Something that can run SQL inside an open transaction; `@fundroom/db`'s `Tx` satisfies it. */
export interface TransactionHandle {
  execute(query: unknown): Promise<unknown>;
}

/**
 * Storage policy for duplicates of the same `idempotencyKey` (pg-boss terminology):
 *  - standard: keys are informational, duplicates allowed;
 *  - short: at most one *queued* job per key (dedupes bursts, the outbox relay's choice);
 *  - singleton: at most one *active* job per key;
 *  - stately: at most one job per key per state (queued, active).
 */
export type QueuePolicy = "standard" | "short" | "singleton" | "stately";

export interface QueueOptions {
  readonly policy?: QueuePolicy;
  /** Retries before dead-lettering. Default 3. */
  readonly retryLimit?: number;
  /** Base delay between retries. Default 5 s. */
  readonly retryDelaySeconds?: number;
  /** Exponential backoff from `retryDelaySeconds`. Default true. */
  readonly retryBackoff?: boolean;
  /** A job active longer than this is retried. Default 15 min. */
  readonly expireInSeconds?: number;
  /** Route exhausted jobs to the dead-letter queue. Default true. */
  readonly deadLetter?: boolean;
}

export interface SendOptions {
  /** Dedupe key; behaviour depends on the queue's `policy`. Never PII in the clear. */
  readonly idempotencyKey?: string;
  /** Run no earlier than this. */
  readonly startAfter?: Date;
  /** Higher runs first. Default 0. */
  readonly priority?: number;
}

export interface ActiveJob<T extends JsonObject = JsonObject> {
  readonly id: string;
  readonly name: string;
  readonly data: T;
  /** Fires when the adapter is stopping or the job expired; long handlers should honour it. */
  readonly signal: AbortSignal;
}

export type JobHandler<T extends JsonObject = JsonObject> = (job: ActiveJob<T>) => Promise<void>;

export interface WorkOptions {
  /** Concurrent handler invocations for this queue in this process. Default 1. */
  readonly concurrency?: number;
  /** Poll interval when idle. Adapter default (pg-boss: 2 s). */
  readonly pollIntervalMs?: number;
}

export interface DeadLetterJob {
  readonly id: string;
  /** Queue the job originally failed on. */
  readonly sourceQueue: string;
  readonly data: JsonObject;
  /** Last failure detail recorded by the adapter. */
  readonly error: JsonValue;
  readonly failedAt: Date;
  readonly retries: number;
}

/**
 * Narrows the dead-letter views to one tenant's work (E2.7). A job belongs to a workspace when
 * its payload's top-level `workspaceId` names it — the shape the outbox relay's event jobs and
 * every kernel/module job that runs in tenant context already carry. A job without one is
 * instance work and matches no workspace filter. Adapters must apply the filter in the store,
 * never by loading every dead letter and filtering in memory.
 */
export interface DeadLetterFilter {
  readonly workspaceId?: string | undefined;
}

export interface DeadLetterQueue {
  /** Newest failure first. `limit` defaults to 100 and is capped at 1000 by adapters. */
  list(
    options?: DeadLetterFilter & { readonly limit?: number | undefined },
  ): Promise<readonly DeadLetterJob[]>;
  count(options?: DeadLetterFilter): Promise<number>;
  /** One dead letter by id, or null (unknown, already retried/discarded, or not a job id). */
  get(id: string): Promise<DeadLetterJob | null>;
  /** Re-enqueues the job on its source queue. */
  retry(id: string): Promise<boolean>;
  /** Drops the job for good. */
  discard(id: string): Promise<boolean>;
}

export interface QueueStats {
  readonly name: string;
  readonly queued: number;
  readonly active: number;
  readonly failed: number;
}

export interface JobQueuePort {
  /** Idempotent: creates the queue or updates its policy. Must precede `send`/`work`. */
  ensureQueue(name: string, options?: QueueOptions): Promise<void>;
  /** Returns the job id, or null when the queue policy deduplicated it. */
  send(name: string, data: JsonObject, options?: SendOptions): Promise<string | null>;
  sendInTransaction(
    tx: TransactionHandle,
    name: string,
    data: JsonObject,
    options?: SendOptions,
  ): Promise<string | null>;
  /** Cron (5-field, UTC). Idempotent per queue name. */
  schedule(name: string, cron: string, data?: JsonObject): Promise<void>;
  unschedule(name: string): Promise<void>;
  work<T extends JsonObject = JsonObject>(
    name: string,
    handler: JobHandler<T>,
    options?: WorkOptions,
  ): Promise<void>;
  start(): Promise<void>;
  /** Graceful: lets active handlers finish up to `timeoutMs` (design/07 §6.2). */
  stop(options?: { readonly timeoutMs?: number }): Promise<void>;
  readonly deadLetters: DeadLetterQueue;
  stats(): Promise<readonly QueueStats[]>;
}

/**
 * A job a kernel package or module contributes (`defineModule({ jobs })`, §5.3). The
 * composition root ensures the queue, registers the worker when this process has the
 * `worker` role, and installs the cron schedule when present.
 */
export interface JobDefinition<T extends JsonObject = JsonObject> {
  /** `<module>.<verb>` e.g. `audit.checkpoint`. */
  readonly name: string;
  readonly handler: JobHandler<T>;
  readonly queue?: QueueOptions;
  readonly work?: WorkOptions;
  /** 5-field cron in UTC; the scheduled job's `data` is `cronData` (default `{}`). */
  readonly cron?: string;
  readonly cronData?: T;
}

export const JOB_NAME_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9_-]*)+$/u;
