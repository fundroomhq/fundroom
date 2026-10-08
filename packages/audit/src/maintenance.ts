import type { Database } from "@fundroom/db";
import { platformContext } from "@fundroom/db";
import type { JobDefinition } from "@fundroom/ports";
import { dropPartition, ensureAuditPartitions, listExpiredPartitions } from "./repos/audit-repo.js";
import type { AuditRecorder } from "./service.js";

/*
 * Partition maintenance (ADR-0017 "7-year default retention via partition drops"): keep
 * partitions ahead, drop whole months past the retention window, and record what was
 * dropped as a platform audit event (counts and names, never contents). Legal holds
 * (E1.3) will veto drops for held workspaces; until then the default of 84 months means
 * nothing is eligible before 2033.
 */
export const DEFAULT_AUDIT_RETENTION_MONTHS = 84;
export const MIN_AUDIT_RETENTION_MONTHS = 12;

export interface AuditMaintenanceOptions {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly retentionMonths?: number;
  readonly monthsAhead?: number;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export interface MaintenanceResult {
  readonly created: number;
  readonly dropped: readonly string[];
}

export async function runAuditMaintenance(
  options: AuditMaintenanceOptions,
): Promise<MaintenanceResult> {
  const retention = Math.max(
    MIN_AUDIT_RETENTION_MONTHS,
    options.retentionMonths ?? DEFAULT_AUDIT_RETENTION_MONTHS,
  );
  const created = await options.db.withHost((tx) =>
    ensureAuditPartitions(tx, options.monthsAhead ?? 3),
  );
  const expired = await options.db.withHost((tx) => listExpiredPartitions(tx, retention));
  const dropped: string[] = [];
  for (const p of expired) {
    const ok = await options.db.withHost((tx) => dropPartition(tx, p.name));
    if (ok) dropped.push(p.name);
  }
  if (dropped.length > 0) {
    await options.audit.recordDetached(platformContext(), {
      action: "audit.partition_dropped",
      resourceKind: "audit",
      meta: { partitions: dropped, retentionMonths: retention },
    });
  }
  options.log?.("audit.maintenance", { created, dropped: dropped.length });
  return { created, dropped };
}

/** Daily at 02:30 UTC. */
export function createAuditMaintenanceJob(options: AuditMaintenanceOptions): JobDefinition {
  return {
    name: "audit.maintenance",
    cron: "30 2 * * *",
    queue: { retryLimit: 2, retryDelaySeconds: 300 },
    handler: async () => {
      await runAuditMaintenance(options);
    },
  };
}
