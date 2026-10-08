import type { Tx } from "@fundroom/db";
import type { PlanFeature } from "@fundroom/domain";
import type { QuotaCheckInput, QuotaKind, QuotaServices } from "@fundroom/module-kit";
import { type PlanLimits, parsePlanLimits } from "../plans/plans.js";
import {
  countCustomDomains,
  countInvestorSeats,
  countStaffSeats,
  latestStorageBytes,
  lockWorkspaceForQuota,
  selectWorkspaceQuota,
} from "./repos/quota-repo.js";

/*
 * Plan quotas (E3.10, ADR-0058; owner: agent M). `checkQuota` is pure; the service around it
 * (`ModuleServices.quota`, wired by `apps/server/src/control-plane/usage-wiring.ts`) reads the
 * workspace's plan and current usage inside the caller's transaction and throws `PlanLimitError`.
 * Enforced only when `workspace.plan_id` is set, so a self-hosted install is never limited — and
 * the wiring hands out the pass-through `UNLIMITED_QUOTA` unless CONTROL_PLANE=on.
 *
 * What "usage now" is, per kind:
 *  - `staffSeats`: live staff memberships + pending staff invitations (an invitation holds its
 *    seat until it is accepted, revoked or expires, so accepting one never needs a check).
 *  - `investorSeats`: the same for `role = 'investor'` (delegates are capped per investor).
 *  - `customDomains`: rows that are not deleted and not `failed`.
 *  - `storageBytes`: the latest usage row's `storage_bytes` (at most an hour old) — approximate by
 *    design: counting every object on each upload start would cost a scan of the data room. The
 *    caller adds what is in flight to `delta`: the data room passes this upload's declared size
 *    plus the declared sizes of its open (unfinished) uploads, counted after the lock (below), so
 *    parallel uploads cannot each fit the same headroom. The overshoot left is what completed
 *    between two hourly rollups.
 *  - `emailsPerMonth`: reported by the rollup, never enforced (v1).
 *
 * Races: every check takes the workspace row (`lockWorkspaceForQuota`, see there) before
 * counting, so two concurrent invitations (or upload starts) at the limit serialise and the
 * second one counts the first. The data room calls the storage check twice in one transaction —
 * once with `delta: 0` to take the lock, then with its open uploads counted under it.
 *
 * `delta` is what the caller is about to add. A caller that has ALREADY written its row (the
 * share-link redemption, which must lock its access-request rows before the workspace row) passes
 * `delta: 0`: the count then includes its own row and the check is "not over the limit".
 */

export interface QuotaUsage {
  readonly staffSeats: number;
  readonly investorSeats: number;
  readonly storageBytes: number;
  readonly customDomains: number;
}

export type QuotaVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly limit: QuotaKind; readonly max: number };

/** Whether adding `delta` of `kind` to `usage` stays within `limits`. An absent limit is unlimited. */
export function checkQuota(
  limits: PlanLimits,
  usage: QuotaUsage,
  kind: QuotaKind,
  delta: number,
): QuotaVerdict {
  const max = limits[kind];
  if (max === undefined) return { ok: true };
  const add = Number.isFinite(delta) && delta > 0 ? delta : 0;
  const now = Number.isFinite(usage[kind]) && usage[kind] > 0 ? usage[kind] : 0;
  return now + add <= max ? { ok: true } : { ok: false, limit: kind, max };
}

/**
 * 402 `plan_limit`, shaped like the API error envelope (`code`, `status`, `details`) so a route
 * that lets it escape answers `{ error: { code: "plan_limit", limit, max } }` without a mapping.
 */
export class PlanLimitError extends Error {
  override readonly name = "PlanLimitError";
  readonly code = "plan_limit";
  readonly status = 402;
  readonly details: { readonly limit: QuotaKind; readonly max: number };
  constructor(limit: QuotaKind, max: number) {
    super(`the workspace's plan allows at most ${max} (${limit})`);
    this.details = { limit, max };
  }
}

export function isPlanLimitError(error: unknown): error is PlanLimitError {
  return error instanceof PlanLimitError;
}

/** `details` of an entitlement refusal (A-3, ADR-0063): no `max`, the id instead. */
export type PlanEntitlementDetails =
  | { readonly limit: "module"; readonly module: string }
  | { readonly limit: "feature"; readonly feature: PlanFeature };

/**
 * PlanLimitError's sibling for entitlements (A-3): the same 402 `plan_limit` envelope, with
 * `details.limit` `module` | `feature` and the id. A separate class rather than a widened
 * `PlanLimitError` so a quota caller that reads `details.max` keeps a type that always has it.
 */
export class PlanEntitlementError extends Error {
  override readonly name = "PlanEntitlementError";
  readonly code = "plan_limit";
  readonly status = 402;
  constructor(readonly details: PlanEntitlementDetails) {
    super(
      details.limit === "module"
        ? `the workspace's plan does not include the ${details.module} module`
        : `the workspace's plan does not include the ${details.feature} feature`,
    );
  }
}

/** The 402 `plan_limit` for a module or feature outside the workspace's plan. */
export function planLimitError(details: PlanEntitlementDetails): PlanEntitlementError {
  return new PlanEntitlementError(details);
}

export function isPlanEntitlementError(error: unknown): error is PlanEntitlementError {
  return error instanceof PlanEntitlementError;
}

const EMPTY_USAGE: QuotaUsage = {
  staffSeats: 0,
  investorSeats: 0,
  storageBytes: 0,
  customDomains: 0,
};

async function usageOf(tx: Tx, workspaceId: string, kind: QuotaKind): Promise<number> {
  switch (kind) {
    case "staffSeats":
      return countStaffSeats(tx, workspaceId, { withInvites: true });
    case "investorSeats":
      return countInvestorSeats(tx, workspaceId, { withInvites: true });
    case "customDomains":
      return countCustomDomains(tx, workspaceId);
    case "storageBytes":
      return latestStorageBytes(tx, workspaceId);
  }
}

/** `ModuleServices.quota` for a control-plane install (see the header). */
export function createQuotaService(): QuotaServices {
  return {
    async check(tx: Tx, input: QuotaCheckInput): Promise<void> {
      const ws = await selectWorkspaceQuota(tx, input.workspaceId);
      // No plan (every self-hosted workspace), or no such workspace: nothing to enforce here.
      if (ws === undefined || ws.planId === null) return;
      const limits = parsePlanLimits(ws.limits);
      if (limits[input.kind] === undefined) return;
      await lockWorkspaceForQuota(tx, input.workspaceId);
      const used = await usageOf(tx, input.workspaceId, input.kind);
      const verdict = checkQuota(
        limits,
        { ...EMPTY_USAGE, [input.kind]: used },
        input.kind,
        input.delta,
      );
      if (!verdict.ok) throw new PlanLimitError(verdict.limit, verdict.max);
    },
  };
}
