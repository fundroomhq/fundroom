import { type Database, systemContext, type TenantUsageDailyRow, type Tx } from "@fundroom/db";
import type { ModuleManifest, ModuleUsage } from "@fundroom/module-kit";
import type { JobDefinition, JsonObject } from "@fundroom/ports";
import {
  countCustomDomains,
  countInvestorSeats,
  countStaffSeats,
} from "../quotas/repos/quota-repo.js";
import {
  countEmailsSent,
  deleteUsageBefore,
  selectLatestUsage,
  selectUsageSince,
  selectWorkspaceIdsPage,
  type UsageRowValues,
  upsertUsageRow,
} from "./repos/usage-repo.js";

/*
 * Usage metering (E3.10, ADR-0058; owner: agent M). The `control-plane.usage-rollup` job (daily
 * `15 0 * * *` UTC for yesterday, hourly `5 * * * *` for today so far — the latter as
 * `control-plane.usage-rollup-today`, since a job has one cron; both singleton) pages through
 * workspaces one short transaction each and upserts `core.tenant_usage_daily`: staff and investor
 * seats, custom domains, emails sent (`core.mail_message` rows of the day — see the contract's
 * Corrections), and every module's `ModuleManifest.usage` hook (storage bytes, documents viewed).
 * Rows older than 400 days are deleted in the same job.
 *
 * Each workspace's row is computed in ONE transaction in that workspace's `system` context (the
 * module hooks' contract, and the table's write policy), so a row is internally consistent; the
 * page of ids comes from a separate short host transaction. Every compiled-in module's hook is
 * called whether or not the module is enabled for the workspace: a disabled data room's bytes are
 * still stored. A hook that throws contributes nothing (under a savepoint, logged) rather than
 * losing the workspace's whole row. Seats here are memberships only; the quota check adds pending
 * invitations on top (see `quotas.ts`).
 */

/** Retention of `core.tenant_usage_daily`. */
export const USAGE_RETENTION_DAYS = 400;

export const USAGE_ROLLUP_JOB = "control-plane.usage-rollup";
export const USAGE_ROLLUP_TODAY_JOB = "control-plane.usage-rollup-today";

/** Workspaces per page of the rollup's id scan. */
const PAGE_SIZE = 200;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 86_400_000;

/** The UTC calendar day of `at`, `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `day` moved by `n` days (UTC). */
export function addDays(day: string, n: number): string {
  if (!DAY_RE.test(day)) throw new RangeError(`not a YYYY-MM-DD day: ${day}`);
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
}

/** The first day retention keeps when running on `today`: rows before it are deleted. */
export function retentionCutoff(today: string, days = USAGE_RETENTION_DAYS): string {
  return addDays(today, -days);
}

/** A non-negative safe integer from whatever a module returned (junk and negatives count 0). */
function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0
    ? Math.min(Math.floor(v), Number.MAX_SAFE_INTEGER)
    : 0;
}

/** The modules' answers, summed (absent fields contribute nothing). */
export function sumModuleUsage(parts: readonly ModuleUsage[]): {
  readonly storageBytes: number;
  readonly docsViewed: number;
} {
  let storageBytes = 0;
  let docsViewed = 0;
  for (const p of parts) {
    storageBytes = Math.min(storageBytes + count(p.storageBytes), Number.MAX_SAFE_INTEGER);
    docsViewed += count(p.docsViewed);
  }
  // `docs_viewed` is an int4 column.
  return { storageBytes, docsViewed: Math.min(docsViewed, 2_147_483_647) };
}

/** The newest usage row of a workspace. Host or the workspace's staff/system context. */
export async function latestUsage(
  tx: Tx,
  workspaceId: string,
): Promise<TenantUsageDailyRow | undefined> {
  return selectLatestUsage(tx, workspaceId);
}

/**
 * The last `days` usage rows ending today (UTC, per `now`), oldest first. A day the rollup has not
 * reached (or a workspace younger than that) simply has no row.
 */
export async function usageSeries(
  tx: Tx,
  workspaceId: string,
  days: number,
  now: Date = new Date(),
): Promise<readonly TenantUsageDailyRow[]> {
  const span = Math.max(1, Math.floor(days));
  return selectUsageSince(tx, workspaceId, addDays(utcDay(now), -(span - 1)));
}

export type UsageLog = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface UsageRollupDeps {
  readonly db: Database;
  /** Every compiled-in module (the registry's boot order), enabled or not. */
  readonly modules: () => readonly Pick<ModuleManifest, "id" | "usage">[];
  readonly now?: (() => Date) | undefined;
  readonly log?: UsageLog | undefined;
}

/** Computes and upserts one workspace's row for `day`, in its system context. */
export async function rollupWorkspaceUsage(
  deps: UsageRollupDeps,
  workspaceId: string,
  day: string,
): Promise<UsageRowValues> {
  const now = deps.now ?? (() => new Date());
  const ctx = systemContext(workspaceId);
  return deps.db.withTenant(ctx, async (tx) => {
    const parts: ModuleUsage[] = [];
    for (const m of deps.modules()) {
      const hook = m.usage;
      if (hook === undefined) continue;
      try {
        parts.push(await tx.transaction((sp) => hook(sp, { workspaceId, day })));
      } catch (error) {
        deps.log?.("control-plane.usage_hook_failed", {
          level: "warn",
          workspaceId,
          module: m.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const fromModules = sumModuleUsage(parts);
    const values: UsageRowValues = {
      storageBytes: fromModules.storageBytes,
      docsViewed: fromModules.docsViewed,
      emailsSent: await countEmailsSent(tx, workspaceId, day),
      staffSeats: await countStaffSeats(tx, workspaceId, { withInvites: false }),
      investorSeats: await countInvestorSeats(tx, workspaceId, { withInvites: false }),
      customDomains: await countCustomDomains(tx, workspaceId),
    };
    await upsertUsageRow(tx, workspaceId, day, values, now());
    return values;
  });
}

export interface UsageRollupResult {
  readonly day: string;
  readonly workspaces: number;
  readonly failed: number;
  readonly deleted: number;
}

/**
 * The rollup: every live workspace's row for `day` (default: today, UTC), then retention. One
 * workspace's failure is logged and skipped; the job itself only fails when paging does.
 */
export async function runUsageRollup(
  deps: UsageRollupDeps,
  input: {
    readonly day?: string | undefined;
    readonly workspaceId?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<UsageRollupResult> {
  const now = deps.now ?? (() => new Date());
  const today = utcDay(now());
  const day = input.day ?? today;
  if (!DAY_RE.test(day)) throw new RangeError(`not a YYYY-MM-DD day: ${day}`);
  const aborted = () => input.signal?.aborted === true;
  let workspaces = 0;
  let failed = 0;
  const one = async (workspaceId: string) => {
    try {
      await rollupWorkspaceUsage(deps, workspaceId, day);
      workspaces++;
    } catch (error) {
      failed++;
      deps.log?.("control-plane.usage_rollup_failed", {
        level: "warn",
        workspaceId,
        day,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  if (input.workspaceId !== undefined) {
    await one(input.workspaceId);
  } else {
    let after: string | null = null;
    for (;;) {
      if (aborted()) break;
      const page: string[] = await deps.db.withHost((tx) =>
        selectWorkspaceIdsPage(tx, after, PAGE_SIZE),
      );
      for (const id of page) {
        if (aborted()) break;
        await one(id);
      }
      if (page.length < PAGE_SIZE) break;
      after = page[page.length - 1] ?? null;
    }
  }
  const deleted = await deps.db.withHost((tx) => deleteUsageBefore(tx, retentionCutoff(today)));
  deps.log?.("control-plane.usage_rolled_up", { day, workspaces, failed, deleted });
  return { day, workspaces, failed, deleted };
}

/**
 * The two schedules (see the header). `data.day` overrides the day (`YYYY-MM-DD`) and
 * `data.workspaceId` limits a run to one workspace — for an operator's one-off run.
 */
export function createUsageJobs(deps: UsageRollupDeps): JobDefinition<JsonObject>[] {
  const now = deps.now ?? (() => new Date());
  const handler =
    (which: "yesterday" | "today"): JobDefinition<JsonObject>["handler"] =>
    async (job) => {
      const data = job.data as { day?: unknown; workspaceId?: unknown };
      const day =
        typeof data.day === "string" && DAY_RE.test(data.day)
          ? data.day
          : which === "yesterday"
            ? addDays(utcDay(now()), -1)
            : utcDay(now());
      await runUsageRollup(deps, {
        day,
        ...(typeof data.workspaceId === "string" ? { workspaceId: data.workspaceId } : {}),
        signal: job.signal,
      });
    };
  return [
    {
      name: USAGE_ROLLUP_JOB,
      cron: "15 0 * * *",
      queue: { policy: "singleton", retryLimit: 2, expireInSeconds: 50 * 60 },
      handler: handler("yesterday"),
    },
    {
      name: USAGE_ROLLUP_TODAY_JOB,
      cron: "5 * * * *",
      queue: { policy: "singleton", retryLimit: 0, expireInSeconds: 50 * 60 },
      handler: handler("today"),
    },
  ];
}
