import type { platform } from "@fundroom/contracts";
import { planLimitError } from "@fundroom/control-plane";
import { readWorkspacePlanLimits, type Tx } from "@fundroom/db";
import {
  ALL_ENTITLEMENTS,
  type Entitlements,
  entitlementsOf,
  PLAN_FEATURES,
  type PlanFeature,
} from "@fundroom/domain";
import type { EntitlementsPort } from "@fundroom/ports";
import { COMPILED_IN_MODULES } from "./modules.js";

/*
 * Plan entitlements (A-3 / E-UP-2, ADR-0063): the server's `EntitlementsPort` — `deps.entitlements`
 * for kernel routes, `ModuleServices.entitlements` for modules.
 *
 * Enforced exactly when quotas are (`usage-wiring.ts`): CONTROL_PLANE=on and a workspace with a
 * plan. The decision itself is the pure `entitlementsOf` over the plan's raw `limits`, which every
 * request already carries on its `ResolvedWorkspace` — no query, no cache, so a plan change takes
 * effect on the next request. Jobs that hold only an id read the same two facts on the transaction
 * they already have (`forWorkspace`), never a second pool connection (the pool-deadlock rule).
 *
 * The refusal is 402 `plan_limit` with `details.limit` `module` | `feature` (`planLimitError`); a
 * gate runs after the route's own authentication and authorization, so it is never an oracle.
 */

/**
 * The optional (non-`required`) modules compiled into this build, sorted: what a plan's
 * `limits.modules` may name, and the operator UI's module checklist. Deliberately not narrowed by
 * the `MODULES` env — plans are catalogue data, and one cell running without a module must not make
 * a plan that lists it unsaveable.
 */
export const OPTIONAL_MODULE_IDS: readonly string[] = Object.freeze(
  COMPILED_IN_MODULES.filter((m) => m.required !== true)
    .map((m) => m.id)
    .sort(),
);

/** `GET /platform/plans` `entitlementCatalog`: what a plan's lists may contain on this build. */
export function entitlementCatalog(): {
  modules: string[];
  features: PlanFeature[];
} {
  return { modules: [...OPTIONAL_MODULE_IDS], features: [...PLAN_FEATURES] };
}

// The contract spells the feature enum out (it keeps no `@fundroom/*` dependencies); this pins it to
// the domain list in both directions, so a feature added on one side only fails the build.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const featuresAgree: Same<PlanFeature, (typeof platform.PlanFeatureSchema.options)[number]> = true;
void featuresAgree;

export interface EntitlementsOptions {
  /** CONTROL_PLANE=on. Off: everything is allowed everywhere (every self-hosted install). */
  readonly enforced: boolean;
}

export function createEntitlements(options: EntitlementsOptions): EntitlementsPort {
  const { enforced } = options;
  return {
    of: (workspace) =>
      entitlementsOf({ enforced, planId: workspace.planId, limits: workspace.planLimits }),
    async forWorkspace(tx, workspaceId): Promise<Entitlements> {
      // Off: no read at all — the answer cannot depend on it.
      if (!enforced) return ALL_ENTITLEMENTS;
      // `TransactionHandle` is the port's spelling of `@fundroom/db`'s `Tx` (see the port).
      const row = await readWorkspacePlanLimits(tx as Tx, workspaceId);
      if (row === undefined) return ALL_ENTITLEMENTS;
      return entitlementsOf({ enforced, planId: row.planId, limits: row.planLimits });
    },
    assertFeature(e, feature) {
      if (!e.allowsFeature(feature)) throw planLimitError({ limit: "feature", feature });
    },
    assertModule(e, moduleId) {
      if (!e.allowsModule(moduleId)) throw planLimitError({ limit: "module", module: moduleId });
    },
  };
}
