import { listActiveWorkspaceIds, listLiveWorkspaceIds, systemContext } from "@fundroom/db";
import { isLiveModuleServices, type ModuleServices } from "@fundroom/module-kit";
import type { JobDefinition, JsonObject } from "@fundroom/ports";
import {
  DELIVER_GRACE_MS,
  JOB_CHANNELS,
  JOB_DELIVER,
  JOB_DIGEST,
  JOB_RETENTION,
  JOB_SEND,
} from "./names.js";
import { postDueDeliveries } from "./service/channels.js";
import { applyRetention } from "./service/lifecycle.js";
import {
  deliverNotification,
  deliverPending,
  digestDueMembers,
  loadWorkspace,
  sendDigestFor,
} from "./service/notify.js";
import { setNotifyServices } from "./service/slot.js";

export {
  DELIVER_GRACE_MS,
  JOB_CHANNELS,
  JOB_DELIVER,
  JOB_DIGEST,
  JOB_RETENTION,
  JOB_SEND,
} from "./names.js";

interface JobData {
  readonly workspaceId?: string;
  /** Tests: evaluate the schedule at this instant (ISO) instead of the clock. */
  readonly at?: string;
  /** `notify.send`: the row to email. */
  readonly notificationId?: string;
}

function dataOf(data: unknown): JobData {
  return (data ?? {}) as JobData;
}

function nowOf(services: ModuleServices, data: JobData): Date {
  if (typeof data.at === "string") {
    const d = new Date(data.at);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return services.now();
}

/**
 * The workspaces one run walks: `{ workspaceId }` narrows it; else the sending jobs walk active
 * workspaces only (E3.10 FR1 — a held or suspended one keeps its queue until it is active again;
 * the send paths re-check at send time) and retention every live one.
 */
async function workspaces(
  services: ModuleServices,
  data: JobData,
  scope: "sending" | "all" = "sending",
): Promise<string[]> {
  if (data.workspaceId !== undefined) return [data.workspaceId];
  return scope === "all" ? listLiveWorkspaceIds(services.db) : listActiveWorkspaceIds(services.db);
}

/*
 * - `notify.send` (enqueued by the `notification.created` subscriber): emails one instant row
 *   outside any transaction. A mailer failure is recorded on the row (backoff, then `failed`),
 *   not thrown, so the queue's own retries only cover database trouble.
 * - `notify.deliver` (every minute): the retry loop for failed sends, the safety net for instant alerts whose
 *   `notification.created` subscriber never ran or kept failing, the exit for emails held back
 *   by quiet hours, and a sweep of channel posts that are due for a retry.
 * - `notify.digest` (hourly): daily and weekly digests, each member at their own local hour.
 *   A member is due when a slot has passed since their last digest, so an hour this job missed
 *   is caught up on the next run.
 * - `notify.channels` (enqueued by the fan-out): posts queued channel deliveries.
 * - `notify.retention` (nightly): drops rows older than the workspace's `notify.retentionDays`.
 *
 * Every job accepts `{ workspaceId }` in `job.data`; the digest also takes `{ at }` so a test
 * can evaluate the schedule at a chosen instant.
 */
export function createNotifyJobs(services: ModuleServices): JobDefinition<JsonObject>[] {
  if (isLiveModuleServices(services)) setNotifyServices(services);
  return [
    {
      name: JOB_SEND,
      queue: {
        policy: "short",
        retryLimit: 3,
        retryDelaySeconds: 15,
        expireInSeconds: 5 * 60,
      },
      work: { concurrency: 4 },
      handler: async (job) => {
        const data = dataOf(job.data);
        if (data.workspaceId === undefined || data.notificationId === undefined) return;
        await deliverNotification(services, systemContext(data.workspaceId), data.notificationId);
      },
    },
    {
      name: JOB_DELIVER,
      cron: "* * * * *",
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 5 * 60 },
      handler: async (job) => {
        const data = dataOf(job.data);
        const before = new Date(services.now().getTime() - DELIVER_GRACE_MS);
        for (const workspaceId of await workspaces(services, data)) {
          if (job.signal.aborted) return;
          const ctx = systemContext(workspaceId);
          const sent = await deliverPending(services, ctx, before);
          if (sent > 0) services.log("notify.delivered", { workspaceId, sent });
          const posted = await postDueDeliveries(services, ctx);
          if (posted.sent + posted.failed + posted.retried + posted.dropped > 0)
            services.log("notify.channels_posted", { workspaceId, ...posted });
        }
      },
    },
    {
      name: JOB_CHANNELS,
      queue: { retryLimit: 2, retryDelaySeconds: 30, expireInSeconds: 5 * 60 },
      handler: async (job) => {
        const data = dataOf(job.data);
        for (const workspaceId of await workspaces(services, data)) {
          if (job.signal.aborted) return;
          const posted = await postDueDeliveries(services, systemContext(workspaceId));
          services.log("notify.channels_posted", { workspaceId, ...posted });
        }
      },
    },
    {
      name: JOB_DIGEST,
      cron: "0 * * * *",
      queue: {
        policy: "singleton",
        retryLimit: 2,
        retryDelaySeconds: 60,
        expireInSeconds: 15 * 60,
      },
      handler: async (job) => {
        const data = dataOf(job.data);
        const now = nowOf(services, data);
        for (const workspaceId of await workspaces(services, data)) {
          if (job.signal.aborted) return;
          const ctx = systemContext(workspaceId);
          for (const kind of ["daily", "weekly"] as const) {
            const due = await digestDueMembers(services, ctx, now, kind);
            if (due.length === 0) continue;
            const ws = await loadWorkspace(services, workspaceId);
            for (const membershipId of due) {
              try {
                const r = await sendDigestFor(services, ctx, membershipId, kind, ws, now);
                if (r)
                  services.log("notify.digest_sent", {
                    workspaceId,
                    kind,
                    count: r.count,
                    emailed: r.emailed,
                    suppressed: r.suppressed,
                  });
              } catch (error) {
                services.log("notify.digest_failed", {
                  level: "warn",
                  workspaceId,
                  membershipId,
                  kind,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        }
      },
    },
    {
      name: JOB_RETENTION,
      cron: "40 3 * * *",
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 30 * 60 },
      handler: async (job) => {
        const data = dataOf(job.data);
        const now = nowOf(services, data);
        for (const workspaceId of await workspaces(services, data, "all")) {
          if (job.signal.aborted) return;
          const r = await applyRetention(services, systemContext(workspaceId), now);
          if (r.skipped !== null || r.notifications + r.digests + r.channelDeliveries > 0)
            services.log("notify.retention", { workspaceId, ...r });
        }
      },
    },
  ];
}
