import type { ModuleServices } from "@fundroom/module-kit";
import type { JobDefinition, JsonObject } from "@fundroom/ports";
import { JOB_QA_SLA, runQaSla } from "./qa/jobs.js";
import { createIngestService, type IngestInput } from "./service/ingest.js";
import { createMaintenanceService } from "./service/maintenance.js";
import { createVaultService, JOB_VAULT } from "./service/vault.js";

/*
 * Jobs (§5.3 `jobs`): ingest per uploaded version (queued from `complete` in the same
 * transaction), the hourly purge / expiry sweep, the weekly storage reconciler and the Q&A SLA
 * reminders every 15 minutes (E3.3), and vaulting of signed e-signature documents (E3.5).
 */
export const JOB_INGEST = "data-room.ingest";
export const JOB_PURGE = "data-room.purge";
export const JOB_RECONCILE = "data-room.reconcile";
export { JOB_QA_SLA, JOB_VAULT };

export function createDataRoomJobs(services: ModuleServices): JobDefinition<JsonObject>[] {
  const ingest = createIngestService(services);
  const maintenance = createMaintenanceService(services);
  const vault = createVaultService(services);
  return [
    {
      name: JOB_INGEST,
      queue: { policy: "stately", retryLimit: 5, retryDelaySeconds: 15, expireInSeconds: 30 * 60 },
      work: { concurrency: 2 },
      handler: async (job) => {
        const data = job.data as unknown as Partial<IngestInput>;
        if (!data.workspaceId || !data.versionId || !data.blobId) {
          throw new Error("data-room.ingest: workspaceId, versionId and blobId are required");
        }
        await ingest.ingest({
          workspaceId: data.workspaceId,
          versionId: data.versionId,
          blobId: data.blobId,
          uploadId: data.uploadId,
          rederive: data.rederive === true,
        });
      },
    },
    {
      // E3.5: file a completed e-signature envelope's artifacts (queued by the
      // `esign.envelope_completed` handler). Skips rather than fails when there is nothing to do.
      name: JOB_VAULT,
      queue: { policy: "stately", retryLimit: 5, retryDelaySeconds: 30, expireInSeconds: 15 * 60 },
      work: { concurrency: 2 },
      handler: async (job) => {
        const data = job.data as { workspaceId?: unknown; envelopeId?: unknown };
        if (typeof data.workspaceId !== "string" || typeof data.envelopeId !== "string") {
          throw new Error("data-room.vault: workspaceId and envelopeId are required");
        }
        await vault.vault({ workspaceId: data.workspaceId, envelopeId: data.envelopeId });
      },
    },
    {
      name: JOB_PURGE,
      cron: "40 * * * *",
      queue: { policy: "singleton", retryLimit: 1 },
      handler: async (job) => {
        const ws = (job.data as { workspaceId?: string }).workspaceId;
        await maintenance.purge(ws);
      },
    },
    {
      name: JOB_RECONCILE,
      cron: "50 3 * * 0",
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 60 * 60 },
      handler: async (job) => {
        const ws = (job.data as { workspaceId?: string }).workspaceId;
        await maintenance.reconcile(ws);
      },
    },
    {
      name: JOB_QA_SLA,
      cron: "*/15 * * * *",
      queue: { policy: "singleton", retryLimit: 1 },
      handler: async (job) => {
        const data = job.data as { workspaceId?: string; at?: string };
        await runQaSla(services, {
          workspaceId: typeof data.workspaceId === "string" ? data.workspaceId : undefined,
          at: typeof data.at === "string" ? new Date(data.at) : undefined,
        });
      },
    },
  ];
}
