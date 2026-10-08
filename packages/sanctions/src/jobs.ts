import { type JobDefinition, type JsonObject, SanctionsProviderError } from "@fundroom/ports";
import {
  JOB_REFRESH,
  JOB_RESCREEN,
  JOB_SCREEN,
  type SanctionsService,
  type ScreenReason,
  UnscreenableNameError,
} from "./service.js";

/*
 * Sanctions jobs (E3.10, ADR-0058; owner: agent S): `sanctions.screen` (one workspace; enqueued
 * by `onWorkspaceCreated`, the operator's rescreen and the re-screen fan-out), `sanctions.refresh`
 * (`0 6 * * *`: list version check) and `sanctions.rescreen` (on a new list version: one screen
 * job per non-deleted workspace not yet screened against it, singleton per version).
 *
 * `sanctions.screen` failing with a provider error throws AFTER the error row is written, so
 * pg-boss retries with exponential backoff (1 min, 2, 4 … ~4 h in total) and then dead-letters;
 * the workspace stays as it was (a new one stays held) and the error sits in the operator queue.
 * The queue policy `short` keeps at most one queued screen per workspace.
 */

/** How long a screening row is kept (legal record; not deleted with the workspace). */
export const SANCTIONS_RETENTION_YEARS = 5;

export const SANCTIONS_REFRESH_CRON = "0 6 * * *";

const SCREEN_REASONS: ReadonlySet<string> = new Set(["created", "rescreen", "operator"]);

export function createSanctionsJobs(
  service: Pick<SanctionsService, "screenWorkspace" | "refresh" | "rescreenAll">,
): JobDefinition<JsonObject>[] {
  return [
    {
      name: JOB_SCREEN,
      queue: {
        policy: "short",
        retryLimit: 8,
        retryDelaySeconds: 60,
        retryBackoff: true,
        expireInSeconds: 600,
      },
      handler: async (job) => {
        const workspaceId = job.data["workspaceId"];
        if (typeof workspaceId !== "string") return;
        const reason = job.data["reason"];
        const result = await service.screenWorkspace({
          workspaceId,
          reason:
            typeof reason === "string" && SCREEN_REASONS.has(reason)
              ? (reason as ScreenReason)
              : undefined,
          signal: job.signal,
        });
        // A name nothing can be screened against is recorded (held, queued); retrying cannot help.
        if (result.outcome === "error" && !(result.error instanceof UnscreenableNameError)) {
          throw result.error instanceof Error
            ? result.error
            : new SanctionsProviderError("sanctions provider failed");
        }
      },
    },
    {
      name: JOB_REFRESH,
      cron: SANCTIONS_REFRESH_CRON,
      queue: { retryLimit: 5, retryDelaySeconds: 300, retryBackoff: true, expireInSeconds: 1800 },
      handler: async (job) => {
        await service.refresh(job.signal);
      },
    },
    {
      name: JOB_RESCREEN,
      queue: { policy: "singleton", retryLimit: 3, retryDelaySeconds: 60, expireInSeconds: 3600 },
      handler: async (job) => {
        const listVersion = job.data["listVersion"];
        if (typeof listVersion !== "string") return;
        await service.rescreenAll({ listVersion, signal: job.signal });
      },
    },
  ];
}
