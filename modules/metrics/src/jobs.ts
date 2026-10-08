import { listActiveWorkspaceIds, systemContext } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import type { JobDefinition, JsonObject } from "@fundroom/ports";
import { KPI_PROVIDERS, type KpiProvider } from "./model.js";
import { SheetConnectionRepo } from "./repos/metrics-repo.js";
import { createImportService, JOB_IMPORT } from "./service/import.js";
import {
  createKpiSourcesService,
  JOB_KPI_SYNC_PROVIDER,
  kpiSyncKey,
} from "./service/kpi-sources.js";
import { createSheetsService } from "./service/sheets.js";

/*
 * The module's jobs (E2.4 §8, §9; E3.6 §5 adds `metrics.kpi_sync`, below).
 *
 *  - `metrics.import` fans one CSV run out. Retried, and a retry resumes: the worker claims
 *    each line with `metrics.import:<importId>:<line>` in the transaction that writes its
 *    points, so a crash halfway through costs the lines it had not reached and nothing else.
 *  - `metrics.sheets_sync` is the nightly pull, 04:35 UTC. The slot is free by inspection of
 *    the schedule table (`40 4 * * 1` is `domains.reverify`, nothing else is near) and fixed by
 *    the contract, so it is not ours to move.
 *
 * The sweep's shape follows `packages/custom-domains/src/service/jobs.ts:7-29` and
 * `modules/updates/src/jobs.ts`: enumerate the workspaces, then act on each in its **own**
 * tenant transaction, because the write and its audit row have to commit inside that
 * workspace's own fence. `data.workspaceId` narrows the sweep to one workspace, which is the
 * repo convention and what an integration test drives it with.
 */

export { JOB_IMPORT };
export const JOB_SHEETS_SYNC = "metrics.sheets_sync";

/** 04:35 UTC daily (§8). */
export const SHEETS_SYNC_CRON = "35 4 * * *";

/*
 * `metrics.kpi_sync` (E3.6 §5): the nightly pull from QuickBooks, Xero and Stripe, 04:55 UTC —
 * twenty minutes after the sheets sync, so a workspace with both does not run them at once. It
 * fans out to `metrics.kpi_sync_workspace`, one job per workspace. Workspaces with the module
 * switched off are skipped: a disabled module does not reach out to a vendor on their behalf.
 */
export const JOB_KPI_SYNC = "metrics.kpi_sync";
export const KPI_SYNC_CRON = "55 4 * * *";
export { JOB_KPI_SYNC_PROVIDER, kpiSyncKey };

export function createMetricsJobs(services: ModuleServices): JobDefinition<JsonObject>[] {
  const imports = createImportService(services);
  const sheets = createSheetsService(services);
  const kpi = createKpiSourcesService(services);
  return [
    {
      name: JOB_IMPORT,
      queue: { policy: "stately", retryLimit: 3, expireInSeconds: 30 * 60 },
      handler: async (job) => {
        const data = job.data as { importId?: unknown; workspaceId?: unknown };
        if (typeof data.importId !== "string" || typeof data.workspaceId !== "string") return;
        await imports.run(data.importId, data.workspaceId);
      },
    },
    {
      name: JOB_SHEETS_SYNC,
      cron: SHEETS_SYNC_CRON,
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 30 * 60 },
      handler: async (job) => {
        const only = (job.data as { workspaceId?: string }).workspaceId;
        const ids = only === undefined ? await listActiveWorkspaceIds(services.db) : [only];
        for (const workspaceId of ids) {
          // A sweep that keeps going after the adapter has asked it to stop is what turns a
          // rolling deploy into a half-finished sync (`packages/custom-domains` does the same).
          if (job.signal.aborted) return;
          const ctx = systemContext(workspaceId);
          const connection = await services.db.withTenant(ctx, (tx) =>
            new SheetConnectionRepo(ctx, tx).find(),
          );
          if (connection === undefined || !connection.enabled) continue;
          try {
            const outcome = await sheets.sync(ctx);
            services.log("metrics.sheets_swept", {
              workspaceId,
              status: outcome.status,
              written: outcome.written,
              restated: outcome.restated,
              needsReview: outcome.needsReview,
            });
          } catch (error) {
            /*
             * A typed refusal from the port is already recorded on the connection row by
             * `sync` (status, last_error, consecutive_failures, an audit row and a warn log),
             * and it sends no mail — there is no admin-alert channel in the product yet and
             * inventing one here would be E2.6's decision taken in the wrong place. This catch
             * is for the *untyped* failure: one workspace's bad row must not stop the sweep.
             */
            services.log("metrics.sheets_sweep_failed", {
              level: "warn",
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    },
    {
      /*
       * The nightly fan-out only **enqueues**: one `metrics.kpi_sync_provider` job per
       * (workspace, bound provider) with the module on, under `kpiSyncKey(ws, provider)` — the
       * key sync-now uses too — so at most one sync of a provider per workspace runs at a time.
       * Per provider because a Stripe backfill can take many minutes: in one job per workspace
       * it would spend the expiry and starve Xero, which sorts after it, every night.
       */
      name: JOB_KPI_SYNC,
      cron: KPI_SYNC_CRON,
      queue: { policy: "singleton", retryLimit: 1, expireInSeconds: 10 * 60 },
      handler: async (job) => {
        const only = (job.data as { workspaceId?: string }).workspaceId;
        const ids = only === undefined ? await listActiveWorkspaceIds(services.db) : [only];
        for (const workspaceId of ids) {
          if (job.signal.aborted) return;
          try {
            const ctx = systemContext(workspaceId);
            const { enabled } = await services.enablement.get(services.db, ctx);
            if (!enabled.has("metrics")) continue;
            for (const provider of await kpi.boundProviders(ctx)) {
              await services.queue.send(
                JOB_KPI_SYNC_PROVIDER,
                { workspaceId, provider },
                { idempotencyKey: kpiSyncKey(workspaceId, provider) },
              );
            }
          } catch (error) {
            services.log("metrics.kpi_fanout_failed", {
              level: "warn",
              workspaceId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    },
    {
      name: JOB_KPI_SYNC_PROVIDER,
      /*
       * 30 minutes, and the sync stops starting vendor reads after 20 (`KPI_READ_BUDGET_MS`),
       * passing `job.signal` into every read, so an expired job does not keep reading while its
       * retry starts.
       */
      queue: { policy: "stately", retryLimit: 1, expireInSeconds: 30 * 60 },
      // Up to three of these jobs run at once in this worker process (per process, across all
      // workspaces and providers), so one slow Stripe job does not by itself hold up the rest.
      work: { concurrency: KPI_PROVIDERS.length },
      handler: async (job) => {
        const data = job.data as { workspaceId?: unknown; provider?: unknown };
        const { workspaceId, provider } = data;
        if (typeof workspaceId !== "string") return;
        if (!(KPI_PROVIDERS as readonly unknown[]).includes(provider)) return;
        const ctx = systemContext(workspaceId);
        const { enabled } = await services.enablement.get(services.db, ctx);
        if (!enabled.has("metrics")) return;
        // Typed failures are recorded on the bindings (no mail); an untyped one throws, and the
        // queue retries this one (workspace, provider).
        const outcome = await kpi.syncProvider(ctx, provider as KpiProvider, {
          signal: job.signal,
        });
        services.log("metrics.kpi_swept", {
          workspaceId,
          provider: outcome.provider,
          status: outcome.status,
          written: outcome.written,
          restated: outcome.restated,
          needsReview: outcome.needsReview,
          deferred: outcome.deferredBindings,
        });
      },
    },
  ];
}
