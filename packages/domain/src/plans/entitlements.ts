/*
 * Plan entitlements (A-3 / E-UP-2, ADR-0063): which optional modules a workspace may have on and
 * which features it may turn on, read from its plan's `limits` jsonb (`modules`, `features`).
 *
 * The rule: an absent key is everything (today's behaviour) and `[]` is nothing. Enforcement
 * exists only when CONTROL_PLANE=on AND the workspace has a plan — exactly when quotas are
 * enforced — so a self-hosted install never meets a gate. A plan gates turning things on; a
 * downgrade never deletes and never breaks what already runs (the callers decide what "turn on"
 * means; this file only answers "allowed?").
 *
 * Pure on purpose: the resolved workspace already carries the raw `limits` on every request
 * (`ResolvedWorkspace.planLimits`), so the answer costs no query and has no cache to invalidate —
 * a plan change takes effect on the next request. The API validates lists on the way in
 * (`PlanLimitsSchema`); `parseEntitlementList` is the backstop for a row written by hand, read
 * the same way `parsePlanLimits` reads a stray numeric limit: malformed reads as absent, which is
 * unrestricted, and the operator sees exactly that on the plan.
 */

/**
 * The features a plan can gate, in display order. Closed: these names are part of the operator
 * API, the CLI and the marketing site's pricing table, so a rename is a breaking change.
 */
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
] as const;

export type PlanFeature = (typeof PLAN_FEATURES)[number];

const FEATURE_SET: ReadonlySet<string> = new Set(PLAN_FEATURES);

export function isPlanFeature(x: unknown): x is PlanFeature {
  return typeof x === "string" && FEATURE_SET.has(x);
}

/**
 * A stored `modules` / `features` list as the code reads it: `undefined` (= no restriction) unless
 * it is an array; otherwise its strings, de-duplicated and sorted, kept only when in `allowed`
 * (when given). Non-strings inside the array are dropped rather than voiding the list, so one bad
 * entry narrows nothing it did not name.
 */
export function parseEntitlementList(
  raw: unknown,
  allowed?: Iterable<string>,
): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const keep = allowed === undefined ? undefined : new Set(allowed);
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v === "string" && (keep === undefined || keep.has(v))) out.add(v);
  }
  return [...out].sort();
}

/** What one workspace may turn on, right now. */
export interface Entitlements {
  /** false when CONTROL_PLANE is off or the workspace has no plan: everything is allowed. */
  readonly enforced: boolean;
  /** The optional modules the plan allows, or `"all"` (no `modules` key, or not enforced). */
  readonly modules: ReadonlySet<string> | "all";
  /** The features the plan allows, or `"all"` (no `features` key, or not enforced). */
  readonly features: ReadonlySet<PlanFeature> | "all";
  /**
   * Whether the plan allows module `id`. Asks about optional modules only: a required module is
   * never listed, so the caller must not ask (it would read as "not allowed" on a restricted plan).
   */
  allowsModule(id: string): boolean;
  allowsFeature(f: PlanFeature): boolean;
}

function build(
  enforced: boolean,
  modules: ReadonlySet<string> | "all",
  features: ReadonlySet<PlanFeature> | "all",
): Entitlements {
  return Object.freeze({
    enforced,
    modules,
    features,
    allowsModule: (id: string) => modules === "all" || modules.has(id),
    allowsFeature: (f: PlanFeature) => features === "all" || features.has(f),
  });
}

/** Everything allowed: self-hosted installs, CONTROL_PLANE=off, a workspace without a plan. */
export const ALL_ENTITLEMENTS: Entitlements = build(false, "all", "all");

/**
 * The entitlements of a workspace on plan `planId` whose stored limits are `limits` (raw jsonb).
 * `enforced` is the install's switch (CONTROL_PLANE=on); without it, or without a plan, the answer
 * is `ALL_ENTITLEMENTS`. With both, a list that is absent or malformed is "all" and unknown feature
 * ids are dropped — so `enforced: true` with both lists absent still allows everything, and
 * `enforced` only says a restriction COULD apply.
 */
export function entitlementsOf(input: {
  readonly enforced: boolean;
  readonly planId: string | null;
  readonly limits: unknown;
}): Entitlements {
  if (!input.enforced || input.planId === null) return ALL_ENTITLEMENTS;
  const limits =
    input.limits !== null && typeof input.limits === "object" && !Array.isArray(input.limits)
      ? (input.limits as Record<string, unknown>)
      : {};
  const modules = parseEntitlementList(limits["modules"]);
  const features = parseEntitlementList(limits["features"], PLAN_FEATURES) as
    | PlanFeature[]
    | undefined;
  return build(
    true,
    modules === undefined ? "all" : new Set(modules),
    features === undefined ? "all" : new Set(features),
  );
}
