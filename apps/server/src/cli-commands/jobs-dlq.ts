import type { AuditRecorder } from "@fundroom/audit";
import { createAuditService } from "@fundroom/audit";
import type { AppConfig } from "@fundroom/config";
import { createDatabase, platformContext } from "@fundroom/db";
import type { DeadLetterJob, DeadLetterQueue } from "@fundroom/ports";
import { createPgBossQueue } from "@fundroom/queue-pgboss";
import { deadLetterItem } from "../routes/ops-admin.js";

export const JOBS_DLQ_USAGE = `usage: fundroom jobs dlq list [--workspace <uuid>] [--limit <n>]
       fundroom jobs dlq retry <id>
       fundroom jobs dlq discard <id>`;

/*
 * fundroom jobs dlq list|retry|discard (E2.7) — the operator's view of the shared dead-letter
 * queue, across every workspace, for the multi-tenant host whose admin page shows each tenant
 * only its own dead letters.
 *
 * Like the page, it prints no payload: one line per dead letter with its id, failure time,
 * source queue, the workspace its payload names (`-` for instance work), retries, event topic
 * and the first line of the error. Retry and discard are recorded on the platform audit chain
 * (`ops.dead_letter_retried` / `ops.dead_letter_discarded`, `meta.via = "cli"`) — the operator
 * holds no membership, so the tenant chain has no actor to name; the workspace id rides in meta.
 *
 * Opens pg-boss with supervision and the cron timekeeper off: a one-shot command must neither
 * run maintenance nor fire schedules. Exit 0 ok, 1 not found, 2 usage.
 */
export interface JobsDlqDeps {
  readonly deadLetters: DeadLetterQueue;
  readonly audit: Pick<AuditRecorder, "recordDetached">;
  readonly out?: (line: string) => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function line(job: DeadLetterJob): string {
  const item = deadLetterItem(job);
  const ws = job.data["workspaceId"];
  const firstLine = item.error.split("\n")[0]?.slice(0, 160) ?? "";
  return [
    item.id,
    item.failedAt,
    item.sourceQueue,
    typeof ws === "string" ? ws : "-",
    `retries=${item.retries}`,
    item.topic ?? "-",
    firstLine,
  ].join("\t");
}

/** The command against an already-started queue; `runJobsDlq` wires the real one. */
export async function jobsDlqCommand(argv: readonly string[], deps: JobsDlqDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const [sub, ...args] = argv;
  if (sub === "list") {
    const workspaceId = flag(args, "--workspace");
    if (workspaceId !== undefined && !UUID_RE.test(workspaceId)) {
      console.error("--workspace must be a workspace uuid");
      return 2;
    }
    const limitArg = flag(args, "--limit");
    const limit = limitArg === undefined ? 100 : Number(limitArg);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error("--limit must be a positive integer");
      return 2;
    }
    const filter = workspaceId === undefined ? {} : { workspaceId };
    const [count, jobs] = await Promise.all([
      deps.deadLetters.count(filter),
      deps.deadLetters.list({ ...filter, limit }),
    ]);
    for (const job of jobs) out(line(job));
    console.error(`${jobs.length} of ${count} dead letter(s)`);
    return 0;
  }
  if (sub === "retry" || sub === "discard") {
    const id = args[0];
    if (id === undefined || !UUID_RE.test(id)) {
      console.error(JOBS_DLQ_USAGE);
      return 2;
    }
    const job = await deps.deadLetters.get(id);
    const done =
      job !== null &&
      (sub === "retry" ? await deps.deadLetters.retry(id) : await deps.deadLetters.discard(id));
    if (job === null || !done) {
      console.error(`no dead letter ${id}`);
      return 1;
    }
    const item = deadLetterItem(job);
    const ws = job.data["workspaceId"];
    await deps.audit.recordDetached(platformContext(), {
      action: sub === "retry" ? "ops.dead_letter_retried" : "ops.dead_letter_discarded",
      resourceKind: "job",
      resourceId: id,
      meta: {
        via: "cli",
        sourceQueue: item.sourceQueue,
        workspaceId: typeof ws === "string" ? ws : null,
        ...(item.topic === undefined ? {} : { topic: item.topic }),
        ...(item.eventId === undefined ? {} : { eventId: item.eventId }),
      },
    });
    out(`${sub === "retry" ? "retried" : "discarded"} ${id}`);
    return 0;
  }
  console.error(JOBS_DLQ_USAGE);
  return 2;
}

/** `fundroom jobs dlq …`; `argv` is everything after `dlq`. */
export async function runJobsDlq(
  argv: readonly string[],
  cfg: Pick<AppConfig, "raw">,
): Promise<number> {
  const sub = argv[0];
  if (sub !== "list" && sub !== "retry" && sub !== "discard") {
    console.error(JOBS_DLQ_USAGE);
    return 2;
  }
  const db = createDatabase({ connectionString: cfg.raw.DATABASE_URL, poolMax: 2 });
  const queue = createPgBossQueue({ pool: db.pool, supervise: false, schedule: false });
  try {
    await queue.start();
    return await jobsDlqCommand(argv, {
      deadLetters: queue.deadLetters,
      audit: createAuditService({ db, truncateIp: cfg.raw.AUDIT_IP_TRUNCATE }),
    });
  } finally {
    await queue.stop({ timeoutMs: 1_000 });
    await db.close();
  }
}
