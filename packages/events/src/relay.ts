import type { Database, OutboxRow } from "@fundroom/db";
import type { JobQueuePort, JsonObject, QueueOptions } from "@fundroom/ports";
import {
  claimPendingOutboxRows,
  markOutboxFailed,
  markOutboxProcessed,
} from "./repos/outbox-repo.js";
import {
  type EventJobData,
  eventJobIdempotencyKey,
  eventQueueName,
  type SubscriptionRegistry,
} from "./subscriptions.js";

/*
 * Outbox relay (design/06 §1, design/07 §6.2). Runs in the `api` role next to the writers
 * (or anywhere; several relays coexist thanks to SKIP LOCKED):
 *
 *   loop: withHost { claim ≤ batch pending rows FOR UPDATE SKIP LOCKED
 *                    for each row: one job per subscriber, enqueued *in this transaction*
 *                    mark processed }
 *
 * Commit = jobs exist and the row is done; rollback = neither. Exactly-once enqueue,
 * at-least-once delivery. A row whose enqueue throws (unknown queue, bad payload) is retried
 * on its own with backoff so one poison row cannot stall the batch; `attempts`/`last_error`
 * on the row are the operator's breadcrumbs. Topics with no subscriber are marked processed
 * with `dispatched = 0` (the row stays as a record until the sweep).
 */
export interface OutboxRelayOptions {
  readonly db: Database;
  readonly queue: JobQueuePort;
  readonly subscriptions: SubscriptionRegistry;
  /** Rows per transaction. Default 100. */
  readonly batchSize?: number;
  /** Idle poll interval. Default 1000 ms. */
  readonly pollIntervalMs?: number;
  readonly now?: () => Date;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export interface OutboxRelay {
  /** Processes up to one batch; returns the number of rows marked processed. */
  runOnce(): Promise<number>;
  /** Drains until a batch comes back short. */
  drain(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
  readonly running: boolean;
}

/** Queue policy for `event.<topic>` queues: one queued job per (outbox row, subscriber). */
export const EVENT_QUEUE_OPTIONS: QueueOptions = {
  policy: "short",
  retryLimit: 5,
  retryDelaySeconds: 10,
  retryBackoff: true,
  deadLetter: true,
};

/** Both the relay process and the worker process call this at boot. */
export async function prepareEventQueues(
  queue: JobQueuePort,
  subscriptions: SubscriptionRegistry,
): Promise<void> {
  for (const topic of subscriptions.topics()) {
    await queue.ensureQueue(eventQueueName(topic), EVENT_QUEUE_OPTIONS);
  }
}

export function createOutboxRelay(options: OutboxRelayOptions): OutboxRelay {
  const { db, queue, subscriptions } = options;
  const batchSize = options.batchSize ?? 100;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function dispatchRow(
    tx: Parameters<Parameters<Database["withHost"]>[0]>[0],
    row: OutboxRow,
    at: Date,
  ): Promise<number> {
    const subs = subscriptions.subscribersFor(row.topic);
    let dispatched = 0;
    for (const sub of subs) {
      const data: EventJobData = {
        outboxId: row.id,
        topic: row.topic,
        workspaceId: row.workspaceId,
        payload: row.payload as JsonObject,
        schemaVersion: row.payloadSchemaVersion,
        createdAt: row.createdAt.toISOString(),
        subscriber: sub.id,
      };
      const id = await queue.sendInTransaction(tx, eventQueueName(row.topic), data, {
        idempotencyKey: eventJobIdempotencyKey(row.id, sub.id),
      });
      if (id !== null) dispatched++;
    }
    await markOutboxProcessed(tx, row.id, dispatched, at);
    return dispatched;
  }

  async function runBatch(): Promise<{ processed: number; claimed: number }> {
    const at = now();
    try {
      return await db.withHost(async (tx) => {
        const rows = await claimPendingOutboxRows(tx, batchSize, at);
        for (const row of rows) await dispatchRow(tx, row, at);
        return { processed: rows.length, claimed: rows.length };
      });
    } catch (error) {
      // Fall back to row-at-a-time so the poison row is isolated and recorded.
      log("outbox.batch_failed", { error: String(error) });
      return runRowByRow(at);
    }
  }

  async function runRowByRow(at: Date): Promise<{ processed: number; claimed: number }> {
    let processed = 0;
    let claimed = 0;
    for (;;) {
      const outcome = await db
        .withHost(async (tx) => {
          const [row] = await claimPendingOutboxRows(tx, 1, at);
          if (!row) return "none" as const;
          claimed++;
          try {
            await dispatchRow(tx, row, at);
            processed++;
            return "ok" as const;
          } catch (error) {
            // The transaction is poisoned; record the failure in a fresh one after rollback.
            throw new RowFailure(row, error);
          }
        })
        .catch(async (error: unknown) => {
          if (!(error instanceof RowFailure)) throw error;
          const backoffMs = Math.min(3_600_000, 1000 * 2 ** Math.min(20, error.row.attempts));
          await db.withHost((tx) =>
            markOutboxFailed(
              tx,
              error.row.id,
              String(error.cause),
              new Date(at.getTime() + backoffMs),
            ),
          );
          log("outbox.row_failed", {
            outboxId: error.row.id,
            topic: error.row.topic,
            attempts: error.row.attempts + 1,
            error: String(error.cause),
          });
          return "failed" as const;
        });
      if (outcome === "none" || claimed >= batchSize) return { processed, claimed };
    }
  }

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      let r = await runBatch();
      while (running && r.claimed >= batchSize) r = await runBatch();
    } catch (error) {
      log("outbox.relay_error", { error: String(error) });
    }
    if (running) {
      timer = setTimeout(() => {
        inFlight = tick();
      }, pollIntervalMs);
    }
  }

  return {
    get running() {
      return running;
    },
    async runOnce() {
      return (await runBatch()).processed;
    },
    async drain() {
      let total = 0;
      for (;;) {
        const r = await runBatch();
        total += r.processed;
        if (r.claimed < batchSize) return total;
      }
    },
    start() {
      if (running) return;
      running = true;
      inFlight = tick();
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}

class RowFailure extends Error {
  constructor(
    readonly row: OutboxRow,
    override readonly cause: unknown,
  ) {
    super("outbox row failed");
  }
}
