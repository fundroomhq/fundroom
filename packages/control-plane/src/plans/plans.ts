import type { AuditRecorder } from "@fundroom/audit";
import {
  PLATFORM_WORKSPACE_ID,
  type PlanLimitsRow,
  type PlanRow,
  platformContext,
  type Tx,
} from "@fundroom/db";
import { PLAN_FEATURES, type PlanFeature, parseEntitlementList } from "@fundroom/domain";
import type { JsonObject } from "@fundroom/ports";
import {
  archivePlanRow,
  countWorkspacesByPlan,
  enterSystemContextFor,
  findPriceRefClash,
  insertPlan,
  readPlanTxContext,
  restorePlanTxContext,
  selectPlan,
  selectPlans,
  selectWorkspacePlanId,
  updatePlanAtVersion,
} from "./repos/plan-repo.js";

/*
 * Plans (E3.10, ADR-0058; owner: agent M). `core.plan` is host-written (operator API, CLI
 * `fundroom plan list|upsert`) and readable in any context. `limits` absent keys are unlimited;
 * archived plans stay on the workspaces that have them but cannot be assigned. `version` is the
 * optimistic-concurrency token of `PATCH /platform/plans/{id}` (409 `version_conflict`).
 *
 * Consumers outside M: billing (B) reads `getPlan` / `listPlans({ publicOnly: true })` for the
 * price and the billing page; provisioning (A) checks a plan is assignable (`isPlanAssignable`).
 *
 * Writes (`createPlan`, `updatePlan`, `archivePlan`) run on a HOST transaction (the table's write
 * policy) and audit `plan.create` / `plan.update` / `plan.archive` on the platform chain in the
 * same transaction: the plan row first, then the chain (the global lock order). The caller's
 * context is restored before they return.
 *
 * Entitlements (A-3, ADR-0063): `limits.modules` / `limits.features` say which optional modules
 * and features a workspace on the plan may turn on (absent = all, `[]` = none); the pure reading is
 * `entitlementsOf` in `@fundroom/domain`. Writes store `limits_schema_version` 2 (version 1 rows
 * have no lists and read the same). `modules` may name only optional modules compiled into this
 * build — the caller passes that list (`PlanWriteDeps.optionalModules`), since what is compiled in
 * is the server's knowledge, not this package's.
 */

export interface PlanLimits {
  readonly staffSeats?: number | undefined;
  readonly investorSeats?: number | undefined;
  readonly storageBytes?: number | undefined;
  readonly customDomains?: number | undefined;
  readonly emailsPerMonth?: number | undefined;
  /**
   * Optional modules a workspace on this plan may have on. Absent = all, `[]` = none. Sorted.
   * (Mutable array types so the value drops straight into an API body; `parsePlanLimits` always
   * returns fresh arrays.)
   */
  readonly modules?: string[] | undefined;
  /** Features a workspace on this plan may turn on. Absent = all, `[]` = none. Sorted. */
  readonly features?: PlanFeature[] | undefined;
}

/** The `limits_schema_version` every write stores (2: A-3 added the entitlement lists). */
export const PLAN_LIMITS_SCHEMA_VERSION = 2;

/** The numeric (quota) keys of `PlanLimits`. */
export const PLAN_LIMIT_KEYS = [
  "staffSeats",
  "investorSeats",
  "storageBytes",
  "customDomains",
  "emailsPerMonth",
] as const satisfies readonly (keyof PlanLimits)[];

export interface Plan {
  readonly id: string;
  readonly name: string;
  readonly limits: PlanLimits;
  readonly billingPriceRef: string | null;
  /** Metered prices (quantity-less checkout line items), at most 10. */
  readonly billingMeteredPriceRefs: readonly string[];
  readonly trialDays: number;
  readonly public: boolean;
  readonly archivedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The stored `limits` jsonb as `PlanLimits`: known keys holding a non-negative safe integer, and
 * nothing else. The API validates on the way in (`PlanLimitsSchema`); this is the backstop for a
 * row written by hand, so a stray string never reads as "unlimited" by accident of a comparison
 * — it reads as absent, which IS unlimited, and the operator sees exactly that on the plan.
 *
 * The entitlement lists follow the same rule (`parseEntitlementList`): a non-array reads as absent
 * (= all); inside an array, non-strings and unknown feature ids are dropped; the result is sorted
 * and unique. Module ids are not checked against the build here (a module removed from the build
 * stays listed, harmlessly) — only writes are (`optionalModules`).
 */
export function parsePlanLimits(raw: unknown): PlanLimits {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof PlanLimits]: PlanLimits[K] } = {};
  for (const key of PLAN_LIMIT_KEYS) {
    const v = record[key];
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[key] = v;
  }
  const modules = parseEntitlementList(record["modules"]);
  if (modules !== undefined) out.modules = modules;
  const features = parseEntitlementList(record["features"], PLAN_FEATURES);
  if (features !== undefined) out.features = features as PlanFeature[];
  return out;
}

function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    name: row.name,
    limits: parsePlanLimits(row.limits),
    billingPriceRef: row.billingPriceRef,
    billingMeteredPriceRefs: [...(row.billingMeteredPriceRefs ?? [])],
    trialDays: row.trialDays,
    public: row.public,
    archivedAt: row.archivedAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Only a live (unarchived) plan may be put on a workspace or offered. */
export function isPlanAssignable(plan: Pick<Plan, "archivedAt">): boolean {
  return plan.archivedAt === null;
}

/** One plan by id, archived or not. Any context. */
export async function getPlan(tx: Tx, id: string): Promise<Plan | undefined> {
  const row = await selectPlan(tx, id);
  return row === undefined ? undefined : toPlan(row);
}

/** Plans, oldest first. `publicOnly` also excludes archived ones. Any context. */
export async function listPlans(
  tx: Tx,
  options: { readonly publicOnly?: boolean; readonly includeArchived?: boolean } = {},
): Promise<readonly Plan[]> {
  const rows = await selectPlans(tx, {
    publicOnly: options.publicOnly ?? false,
    includeArchived: options.includeArchived ?? true,
  });
  return rows.map(toPlan);
}

/** Live workspaces per plan (plans nobody is on are absent). Host context. */
export async function planWorkspaceCounts(tx: Tx): Promise<ReadonlyMap<string, number>> {
  return countWorkspacesByPlan(tx);
}

/**
 * A live workspace's plan id: `null` = no plan (unlimited), `undefined` = no such live workspace.
 * Host context, or the workspace's own.
 */
export async function workspacePlanId(
  tx: Tx,
  workspaceId: string,
): Promise<string | null | undefined> {
  return selectWorkspacePlanId(tx, workspaceId);
}

/** Who changed the catalogue: an operator (API) or the CLI. Both audit as the `host` actor. */
export type PlanActor =
  | {
      readonly kind: "operator";
      readonly userId: string;
      readonly sessionId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly ip?: string | undefined;
      readonly userAgent?: string | undefined;
    }
  | { readonly kind: "cli"; readonly osUser: string };

export interface PlanWriteDeps {
  readonly audit: AuditRecorder;
  /**
   * The optional (non-`required`) module ids compiled into this build — what `limits.modules` may
   * name (A-3). Not narrowed by `MODULES`: a plan is catalogue data shared by every cell, and a
   * cell that runs without a module must still be able to save a plan that lists it.
   */
  readonly optionalModules: readonly string[];
  readonly now?: (() => Date) | undefined;
}

export interface PlanCreateInput {
  readonly id: string;
  readonly name: string;
  readonly limits: PlanLimits;
  readonly billingPriceRef?: string | null | undefined;
  readonly billingMeteredPriceRefs?: readonly string[] | undefined;
  readonly trialDays?: number | undefined;
  readonly public?: boolean | undefined;
}

export interface PlanPatch {
  readonly name?: string | undefined;
  readonly limits?: PlanLimits | undefined;
  readonly billingPriceRef?: string | null | undefined;
  readonly billingMeteredPriceRefs?: readonly string[] | undefined;
  readonly trialDays?: number | undefined;
  readonly public?: boolean | undefined;
}

export class PlanError extends Error {
  override readonly name = "PlanError";
  constructor(
    readonly reason:
      | "not_found"
      | "exists"
      | "version_conflict"
      | "price_ref_conflict"
      | "unknown_module",
    message: string,
    readonly current?: Plan | undefined,
    /** `price_ref_conflict`: the ref used both as a base and as a metered price. */
    readonly priceRef?: string | undefined,
    /** `unknown_module`: the `limits.modules` entry that is not an optional module of this build. */
    readonly module?: string | undefined,
  ) {
    super(message);
  }
}

/** Only the keys that are set, so `limits` stays a closed object in the row. */
function limitsRow(limits: PlanLimits): PlanLimitsRow {
  return parsePlanLimits(limits);
}

/** `limitsRow` as audit meta (numbers and the two lists — all JSON already). */
function limitsMeta(limits: PlanLimits): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(limitsRow(limits))) {
    if (value !== undefined) out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

/**
 * Refuses a `limits.modules` entry that is not an optional module compiled into this build: a
 * required module (always on) or a typo would otherwise sit in the plan meaning nothing — or, for a
 * typo of a real id, silently leave the real module outside the plan.
 */
function assertKnownModules(limits: PlanLimits, deps: PlanWriteDeps): void {
  if (limits.modules === undefined) return;
  const known = new Set(deps.optionalModules);
  const unknown = limits.modules.find((m) => !known.has(m));
  if (unknown !== undefined) {
    throw new PlanError(
      "unknown_module",
      `${unknown} is not an optional module of this build`,
      undefined,
      undefined,
      unknown,
    );
  }
}

async function auditPlatform(
  tx: Tx,
  deps: Pick<PlanWriteDeps, "audit" | "now">,
  actor: PlanActor,
  input: { readonly action: "plan.create" | "plan.update" | "plan.archive"; readonly plan: Plan },
  meta: JsonObject,
): Promise<void> {
  const saved = await readPlanTxContext(tx);
  await enterSystemContextFor(tx, PLATFORM_WORKSPACE_ID);
  const operator = actor.kind === "operator" ? actor : undefined;
  await deps.audit.record(tx, platformContext(), {
    action: input.action,
    resourceKind: "plan",
    // `audit.event.resource_id` is a uuid; a plan id is a slug, so it rides in `meta.planId`.
    resourceId: null,
    actorKind: "host",
    actorMembershipId: null,
    actorUserId: operator?.userId ?? null,
    requestId: operator?.requestId ?? null,
    sessionId: operator?.sessionId ?? null,
    ip: operator?.ip ?? null,
    userAgent: operator?.userAgent ?? null,
    occurredAt: (deps.now ?? (() => new Date()))(),
    meta: {
      ...meta,
      planId: input.plan.id,
      version: input.plan.version,
      ...(operator !== undefined
        ? { operator: true }
        : { source: `cli:${(actor as { osUser: string }).osUser}`.slice(0, 200) }),
    },
  });
  await restorePlanTxContext(tx, saved);
}

/** Adds a plan. `exists` when the id is taken (archived or not). HOST transaction. */
/** Refuses a price ref used as a base price and a metered price (see `findPriceRefClash`). */
async function assertPriceRoles(
  tx: Tx,
  planId: string,
  base: string | null,
  metered: readonly string[],
): Promise<void> {
  if (base === null && metered.length === 0) return;
  const clash = await findPriceRefClash(tx, planId, base, metered);
  if (clash !== undefined) {
    throw new PlanError(
      "price_ref_conflict",
      `price ${clash} cannot be both a base price and a metered price`,
      undefined,
      clash,
    );
  }
}

export async function createPlan(
  tx: Tx,
  input: PlanCreateInput,
  actor: PlanActor,
  deps: PlanWriteDeps,
): Promise<Plan> {
  assertKnownModules(input.limits, deps);
  await assertPriceRoles(
    tx,
    input.id,
    input.billingPriceRef ?? null,
    input.billingMeteredPriceRefs ?? [],
  );
  const row = await insertPlan(tx, {
    id: input.id,
    name: input.name,
    limits: limitsRow(input.limits),
    limitsSchemaVersion: PLAN_LIMITS_SCHEMA_VERSION,
    billingPriceRef: input.billingPriceRef ?? null,
    billingMeteredPriceRefs: [...new Set(input.billingMeteredPriceRefs ?? [])],
    trialDays: input.trialDays ?? 0,
    public: input.public ?? false,
  });
  if (row === undefined) throw new PlanError("exists", `a plan ${input.id} already exists`);
  const plan = toPlan(row);
  await auditPlatform(
    tx,
    deps,
    actor,
    { action: "plan.create", plan },
    { limits: limitsMeta(plan.limits), public: plan.public, trialDays: plan.trialDays },
  );
  return plan;
}

/**
 * Changes a plan at `version` (optimistic). `version_conflict` carries the current plan; an
 * archived plan may still be edited (its workspaces keep it, so its limits still matter).
 */
export async function updatePlan(
  tx: Tx,
  id: string,
  version: number,
  patch: PlanPatch,
  actor: PlanActor,
  deps: PlanWriteDeps,
): Promise<Plan> {
  if (patch.limits !== undefined) assertKnownModules(patch.limits, deps);
  const set: Parameters<typeof updatePlanAtVersion>[3] = {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.limits === undefined ? {} : { limits: limitsRow(patch.limits) }),
    ...(patch.billingPriceRef === undefined ? {} : { billingPriceRef: patch.billingPriceRef }),
    ...(patch.billingMeteredPriceRefs === undefined
      ? {}
      : { billingMeteredPriceRefs: [...new Set(patch.billingMeteredPriceRefs)] }),
    ...(patch.trialDays === undefined ? {} : { trialDays: patch.trialDays }),
    ...(patch.public === undefined ? {} : { public: patch.public }),
  };
  if (patch.billingPriceRef !== undefined || patch.billingMeteredPriceRefs !== undefined) {
    // The roles after the patch: what it sets, else what the plan has.
    const current = await getPlan(tx, id);
    if (current !== undefined) {
      await assertPriceRoles(
        tx,
        id,
        patch.billingPriceRef === undefined ? current.billingPriceRef : patch.billingPriceRef,
        patch.billingMeteredPriceRefs ?? current.billingMeteredPriceRefs,
      );
    }
  }
  // Every write stores the current shape's version; version 1 rows are a subset of it.
  const row = await updatePlanAtVersion(tx, id, version, {
    ...set,
    limitsSchemaVersion: PLAN_LIMITS_SCHEMA_VERSION,
  });
  if (row === undefined) {
    const current = await getPlan(tx, id);
    if (current === undefined) throw new PlanError("not_found", "no such plan");
    throw new PlanError("version_conflict", "the plan changed since it was read", current);
  }
  const plan = toPlan(row);
  await auditPlatform(
    tx,
    deps,
    actor,
    { action: "plan.update", plan },
    {
      fields: Object.keys(set),
      ...(patch.limits === undefined ? {} : { limits: limitsMeta(plan.limits) }),
    },
  );
  return plan;
}

/** Archives a plan (idempotent: an archived plan comes back unchanged and is not re-audited). */
export async function archivePlan(
  tx: Tx,
  id: string,
  actor: PlanActor,
  deps: Pick<PlanWriteDeps, "audit" | "now">,
): Promise<Plan> {
  const before = await selectPlan(tx, id);
  if (before === undefined) throw new PlanError("not_found", "no such plan");
  if (before.archivedAt !== null) return toPlan(before);
  const row = await archivePlanRow(tx, id, (deps.now ?? (() => new Date()))());
  if (row === undefined) throw new PlanError("not_found", "no such plan");
  const plan = toPlan(row);
  await auditPlatform(tx, deps, actor, { action: "plan.archive", plan }, {});
  return plan;
}
