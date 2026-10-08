import type { FundRoomSchemas } from "@fundroom/sdk";
import { m } from "../paraglide/messages.js";

/*
 * Plan entitlements on the web (A-3, ADR-0063). A plan may list the optional modules a workspace
 * can have on and the features it can turn on; an absent list means "everything". Staff learn
 * the current plan's lists from the bootstrap (`entitlements`, `null` = all); investors never
 * see it. The server is the gate (402 `plan_limit`): the web only greys out what would be
 * refused and says why.
 *
 * Kept free of `api.ts` so the error sentences there can name a feature without an import cycle.
 */
export type PlanFeature = FundRoomSchemas["PlanFeature"];

/** The closed list, in display order (the same order as the server's `PLAN_FEATURES`). */
export const PLAN_FEATURES = [
  "qa",
  "api_keys",
  "webhooks",
  "integrations",
  "esign",
  "accreditation",
  "sso",
  "scim",
  "forensic",
  "anchoring",
  "ai",
  "access_reviews",
] as const satisfies readonly PlanFeature[];

/**
 * The features whose every use *is* the feature (contract §0): on a plan without them they stop,
 * rather than keep working as configured. The rest keep what is already set up. (`anchoring` is
 * not one: decision 20 — every workspace is anchored whatever its plan; only downloading a proof
 * needs it.)
 */
export const STOPPING_FEATURES: ReadonlySet<PlanFeature> = new Set<PlanFeature>([
  "ai",
  "access_reviews",
]);

export function isPlanFeature(value: unknown): value is PlanFeature {
  return typeof value === "string" && (PLAN_FEATURES as readonly string[]).includes(value);
}

export function planFeatureLabel(feature: PlanFeature): string {
  switch (feature) {
    case "qa":
      return m.plan_feature_qa();
    case "api_keys":
      return m.plan_feature_api_keys();
    case "webhooks":
      return m.plan_feature_webhooks();
    case "integrations":
      return m.plan_feature_integrations();
    case "esign":
      return m.plan_feature_esign();
    case "accreditation":
      return m.plan_feature_accreditation();
    case "sso":
      return m.plan_feature_sso();
    case "scim":
      return m.plan_feature_scim();
    case "forensic":
      return m.plan_feature_forensic();
    case "anchoring":
      return m.plan_feature_anchoring();
    case "ai":
      return m.plan_feature_ai();
    case "access_reviews":
      return m.plan_feature_access_reviews();
  }
}

/** The bootstrap's view of the plan: absent (investor, older server) or `null` = everything. */
interface EntitlementsLike {
  entitlements?: { modules: string[] | null; features: PlanFeature[] | null } | undefined;
}

/** Whether the workspace's plan lets staff turn `feature` on. */
export function planAllowsFeature(
  bootstrap: EntitlementsLike | undefined,
  feature: PlanFeature,
): boolean {
  const features = bootstrap?.entitlements?.features;
  return features === undefined || features === null || features.includes(feature);
}
