import { listActiveWorkspaceIds, systemContext } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import type { JobDefinition, JsonObject } from "@fundroom/ports";
import { PostRepo, SendRepo } from "./repos/updates-repo.js";
import { createDeliveryService } from "./service/delivery.js";
import { JOB_DISPATCH, JOB_SEND, SEND_STALE_MINUTES } from "./service/names.js";
import { createPostService } from "./service/posts.js";

export { JOB_DISPATCH, JOB_SEND } from "./service/names.js";

/*
 * `updates.send` fans one send out (stately: one active job per send id, retried with
 * backoff; a retry resumes from the recipient rows). `updates.dispatch` runs every minute:
 * scheduled posts whose time has come are sent, and sends that never finished (a worker
 * died mid-batch past the retry budget) are re-enqueued.
 */
export function createUpdatesJobs(services: ModuleServices): JobDefinition<JsonObject>[] {
  const delivery = createDeliveryService(services);
  const posts = createPostService(services);
  return [
    {
      name: JOB_SEND,
      queue: { policy: "stately", retryLimit: 5, retryDelaySeconds: 30, expireInSeconds: 60 * 60 },
      work: { concurrency: 2 },
      handler: async (job) => {
        const data = job.data as { workspaceId?: string; sendId?: string; testTo?: unknown };
        if (!data.workspaceId || !data.sendId)
          throw new Error("updates.send: workspaceId and sendId are required");
        const testTo = Array.isArray(data.testTo)
          ? data.testTo.filter((x): x is string => typeof x === "string")
          : [];
        await delivery.run(data.workspaceId, data.sendId, testTo, job.signal);
      },
    },
    {
      name: JOB_DISPATCH,
      cron: "* * * * *",
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 5 * 60 },
      handler: async (job) => {
        const only = (job.data as { workspaceId?: string }).workspaceId;
        const ids = only === undefined ? await listActiveWorkspaceIds(services.db) : [only];
        const now = services.now();
        for (const workspaceId of ids) {
          const ctx = systemContext(workspaceId);
          const due = await services.db.withTenant(ctx, (tx) => new PostRepo(ctx, tx).due(now));
          for (const p of due) {
            try {
              await posts.send(ctx, p.id, null);
              services.log("updates.dispatched", { workspaceId, postId: p.id });
            } catch (error) {
              services.log("updates.dispatch_failed", {
                level: "warn",
                workspaceId,
                postId: p.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          const stale = await services.db.withTenant(ctx, (tx) =>
            new SendRepo(ctx, tx).stale(new Date(now.getTime() - SEND_STALE_MINUTES * 60_000)),
          );
          for (const s of stale) {
            await services.queue.send(
              JOB_SEND,
              { workspaceId, sendId: s.id, testTo: [] },
              { idempotencyKey: `send:${s.id}:retry:${Math.floor(now.getTime() / 3_600_000)}` },
            );
            services.log("updates.send_requeued", { level: "warn", workspaceId, sendId: s.id });
          }
        }
      },
    },
  ];
}
