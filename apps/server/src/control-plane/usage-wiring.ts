import {
  createQuotaService,
  createUsageJobs,
  runUsageRollup,
  type UsageRollupDeps,
  type UsageRollupResult,
} from "@fundroom/control-plane";
import { type QuotaServices, UNLIMITED_QUOTA } from "@fundroom/module-kit";
import type { ControlPlaneWiringDeps, WiringKernel } from "./types.js";

/*
 * Plans, usage, quotas (E3.10; owner: agent M) → `container.controlPlane.usage`, read by
 * `routes/platform-plans.ts`. `quota` is `ModuleServices.quota` and what kernel routes (invites,
 * domains, uploads) call; the container reads it through a forwarding wrapper, so replacing the
 * field (M, or a test's `Object.assign`) takes effect everywhere at once.
 *
 * CONTROL_PLANE=off (every self-hosted install): the pass-through quota, no jobs — a plan id
 * written into a self-hosted database by hand still limits nothing. On: the real quota service
 * (still a no-op for a workspace without a plan) and the two usage-rollup schedules.
 */
export interface UsageKernel extends WiringKernel {
  quota: QuotaServices;
  /** One rollup run now (default: today, every workspace). For tests and operator one-offs. */
  rollup(input?: {
    readonly day?: string | undefined;
    readonly workspaceId?: string | undefined;
  }): Promise<UsageRollupResult>;
}

export function createUsageWiring(deps: ControlPlaneWiringDeps): UsageKernel {
  const log = deps.log("control-plane");
  const rollupDeps: UsageRollupDeps = {
    db: deps.db,
    modules: () => deps.registry.modules,
    now: deps.now,
    log: (event, fields) => log(event, fields),
  };
  return {
    quota: deps.controlPlaneEnabled ? createQuotaService() : UNLIMITED_QUOTA,
    jobs: deps.controlPlaneEnabled ? createUsageJobs(rollupDeps) : [],
    rollup: (input = {}) => runUsageRollup(rollupDeps, input),
    async close() {},
  };
}
