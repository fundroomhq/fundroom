import { listLiveWorkspaceIds } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import type { JobDefinition, JsonObject } from "@fundroom/ports";
import {
  createVendorVerificationService,
  JOB_VERIFICATION_LIFECYCLE,
  JOB_VERIFICATION_START,
  JOB_VERIFICATION_SYNC,
  JOB_VERIFICATION_SYNC_DUE,
  VERIFICATION_LIFECYCLE_CRON,
  VERIFICATION_SYNC_DUE_CRON,
  type VerificationJobData,
} from "./service/vendor.js";
import { createVerificationService } from "./service/verification.js";

/*
 * The module's one job (§R): nightly evidence expiry.
 *
 * Accreditation evidence is the most sensitive blob this product stores — a tax return, a
 * brokerage statement, a letter from somebody's accountant — and design/04 §102 is explicit that
 * it is minimised: encrypted per tenant, and auto-expired after the decision. The *decision*
 * has to survive for years; the file must not, and "we meant to delete it" is not a control.
 *
 * 04:50 UTC, after the metrics sheets sync (04:35) and clear of the weekly domain re-verify
 * (Monday 04:40), so three sweeps do not contend for the same worker minute.
 */
export const JOB_EVIDENCE_PURGE = "round.evidence_purge";
export const EVIDENCE_PURGE_CRON = "50 4 * * *";

export function createRoundJobs(services: ModuleServices): JobDefinition<JsonObject>[] {
  const verifications = createVerificationService(services);
  const vendor = createVendorVerificationService(services);
  /** A job payload is the queue's JSON; the ids are checked before anything reads them. */
  const jobData = (data: unknown): VerificationJobData | undefined => {
    const d = data as { workspaceId?: unknown; verificationId?: unknown; subject?: unknown };
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    const { workspaceId, verificationId } = d;
    if (typeof workspaceId !== "string" || !uuid.test(workspaceId)) return undefined;
    if (typeof verificationId !== "string" || !uuid.test(verificationId)) return undefined;
    const subject = d.subject === "entity" || d.subject === "individual" ? d.subject : undefined;
    return { workspaceId, verificationId, ...(subject === undefined ? {} : { subject }) };
  };
  const onlyWorkspace = (data: unknown): string | undefined => {
    const id = (data as { workspaceId?: unknown }).workspaceId;
    return typeof id === "string" ? id : undefined;
  };
  return [
    /*
     * E3.7 (ADR-0055): the vendor side of a verification. The start and the sync each make vendor
     * calls with no transaction open. `stately` keeps one queued and one active job per
     * verification (the idempotency key), so two syncs of one row never run at once.
     */
    {
      name: JOB_VERIFICATION_START,
      queue: {
        policy: "stately",
        retryLimit: 3,
        retryDelaySeconds: 30,
        retryBackoff: true,
        // ≥ the start's own lease (START_LEASE_MS): a redelivered start meets a live lease only
        // while the first may still be talking to the vendor.
        expireInSeconds: 10 * 60,
      },
      handler: async (job) => {
        const data = jobData(job.data);
        if (data !== undefined) await vendor.start(data, job.signal);
      },
    },
    {
      name: JOB_VERIFICATION_SYNC,
      queue: { policy: "stately", retryLimit: 2, retryDelaySeconds: 60, expireInSeconds: 10 * 60 },
      handler: async (job) => {
        const data = jobData(job.data);
        if (data !== undefined) await vendor.sync(data, job.signal);
      },
    },
    {
      name: JOB_VERIFICATION_SYNC_DUE,
      cron: VERIFICATION_SYNC_DUE_CRON,
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 10 * 60 },
      handler: async (job) => {
        const queued = await vendor.syncDue({
          workspaceId: onlyWorkspace(job.data),
          signal: job.signal,
        });
        if (queued > 0) services.log("round.verification_sync_queued", { queued });
      },
    },
    {
      name: JOB_VERIFICATION_LIFECYCLE,
      cron: VERIFICATION_LIFECYCLE_CRON,
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 30 * 60 },
      handler: async (job) => {
        const summary = await vendor.lifecycle({
          workspaceId: onlyWorkspace(job.data),
          signal: job.signal,
        });
        services.log("round.verification_lifecycle_ran", { ...summary });
      },
    },
    {
      name: JOB_EVIDENCE_PURGE,
      cron: EVIDENCE_PURGE_CRON,
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 30 * 60 },
      handler: async (job) => {
        // `data.workspaceId` narrows the sweep to one workspace, which is the repo convention
        // and what an integration test drives it with.
        const only = (job.data as { workspaceId?: string }).workspaceId;
        const ids = only === undefined ? await listLiveWorkspaceIds(services.db) : [only];
        for (const workspaceId of ids) {
          // A sweep that keeps going after the adapter has asked it to stop is what turns a
          // rolling deploy into a half-finished purge.
          if (job.signal.aborted) return;
          try {
            const purged = await verifications.purge(workspaceId);
            if (purged > 0) services.log("round.evidence_purged", { workspaceId, purged });
          } catch (error) {
            // One workspace's bad row must not stop the sweep; the rows it did not reach keep
            // their keys and tomorrow's run tries again.
            services.log("round.evidence_purge_sweep_failed", {
              level: "warn",
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    },
  ];
}
