import type { Database } from "@fundroom/db";
import {
  JOB_NAME_RE,
  type JobDefinition,
  type JobQueuePort,
  type JsonObject,
} from "@fundroom/ports";
import { sweepIdempotencyKeys } from "./idempotency.js";
import { sweepProcessedOutboxRows } from "./repos/outbox-repo.js";

/*
 * Job registration (§5.3 `jobs`, design/07 §6.2). Every process ensures the queues (so any
 * role may enqueue); only `worker` processes attach handlers; cron schedules are idempotent
 * per name, so every process may install them.
 */
export interface RegisterJobsOptions {
  readonly queue: JobQueuePort;
  readonly definitions: readonly JobDefinition[];
  /** Attach handlers (this process has the `worker` role). */
  readonly worker: boolean;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export async function registerJobs(options: RegisterJobsOptions): Promise<void> {
  const seen = new Set<string>();
  for (const def of options.definitions) {
    if (!JOB_NAME_RE.test(def.name)) {
      throw new Error(`job name ${JSON.stringify(def.name)} must match <module>.<verb>`);
    }
    if (seen.has(def.name)) throw new Error(`job ${def.name} defined twice`);
    seen.add(def.name);
    await options.queue.ensureQueue(def.name, def.queue);
    if (options.worker) {
      await options.queue.work(def.name, def.handler, def.work);
    }
    if (def.cron !== undefined) {
      await options.queue.schedule(def.name, def.cron, def.cronData ?? {});
    }
    options.log?.("jobs.registered", {
      name: def.name,
      worker: options.worker,
      cron: def.cron ?? null,
    });
  }
}

export interface MaintenanceJobOptions {
  readonly db: Database;
  /** Keep processed outbox rows this long. Default 7 days. */
  readonly outboxRetentionMs?: number;
  readonly now?: () => Date;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

/** Sweeps the kernel's own tables: processed outbox rows and expired idempotency keys. */
export function createEventMaintenanceJobs(options: MaintenanceJobOptions): JobDefinition[] {
  const now = options.now ?? (() => new Date());
  const retention = options.outboxRetentionMs ?? 7 * 24 * 3600_000;
  return [
    {
      name: "outbox.sweep",
      cron: "45 3 * * *",
      handler: async () => {
        const before = new Date(now().getTime() - retention);
        const n = await options.db.withHost((tx) => sweepProcessedOutboxRows(tx, before));
        options.log?.("outbox.swept", { deleted: n });
      },
    },
    {
      name: "idempotency.sweep",
      cron: "50 3 * * *",
      handler: async () => {
        const n = await sweepIdempotencyKeys(options.db, now());
        options.log?.("idempotency.swept", { deleted: n });
      },
    },
  ] satisfies JobDefinition<JsonObject>[];
}
