import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  platform as p,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import {
  archivePlan,
  createPlan,
  getPlan,
  listPlans,
  type Plan,
  type PlanActor,
  PlanError,
  planWorkspaceCounts,
  updatePlan,
  usageSeries,
  utcDay,
  workspacePlanId,
} from "@fundroom/control-plane";
import type { TenantUsageDailyRow, Tx } from "@fundroom/db";
import type { Context } from "hono";
import { entitlementCatalog, OPTIONAL_MODULE_IDS } from "../entitlements.js";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import { platformOperatorOf, requirePlatformOperator } from "../middleware/platform.js";
import { type ApiDeps, clientIp } from "./deps.js";

/*
 * Plans and usage (E3.10, ADR-0058; owner: agent M): the operator's `/api/v1/platform/plans*` and
 * `/platform/workspaces/{id}/usage`, and the tenant's `GET /api/v1/usage` (`billing.read`; 404
 * unless CONTROL_PLANE=on — checked AFTER the permission guard so the authz answer comes first).
 */

type Api = OpenAPIHono<AppEnv>;

/** Days in the usage series both usage routes return (`last30`). */
const SERIES_DAYS = 30;
/** The tenant `GET /usage` gate's 404 message (CONTROL_PLANE=off). */
export const USAGE_OFF_MESSAGE = "usage is not tracked on this install";

function planBody(plan: Plan, workspaces: number) {
  return {
    id: plan.id,
    name: plan.name,
    limits: { ...plan.limits },
    billingPriceRef: plan.billingPriceRef,
    billingMeteredPriceRefs: [...plan.billingMeteredPriceRefs],
    trialDays: plan.trialDays,
    public: plan.public,
    archivedAt: plan.archivedAt === null ? null : plan.archivedAt.toISOString(),
    workspaces,
    version: plan.version,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

function usageDay(row: TenantUsageDailyRow) {
  return {
    day: row.day,
    storageBytes: Number(row.storageBytes),
    docsViewed: row.docsViewed,
    emailsSent: row.emailsSent,
    staffSeats: row.staffSeats,
    investorSeats: row.investorSeats,
    customDomains: row.customDomains,
    computedAt: row.computedAt.toISOString(),
  };
}

/** `WorkspaceUsage` for one workspace: its plan (if any), today's row and the last 30 days. */
async function workspaceUsage(tx: Tx, workspaceId: string, planId: string | null, now: Date) {
  const plan = planId === null ? undefined : await getPlan(tx, planId);
  const rows = await usageSeries(tx, workspaceId, SERIES_DAYS, now);
  const today = utcDay(now);
  const todayRow = rows.find((r) => r.day === today);
  return {
    plan: plan === undefined ? null : { id: plan.id, name: plan.name, limits: { ...plan.limits } },
    today: todayRow === undefined ? null : usageDay(todayRow),
    last30: rows.map(usageDay),
  };
}

function operatorActor(c: Context<AppEnv>, deps: ApiDeps): PlanActor {
  const op = platformOperatorOf(c);
  const ip = clientIp(c, deps.trustProxy);
  const userAgent = c.req.header("user-agent");
  return {
    kind: "operator",
    userId: op.userId,
    sessionId: op.sessionId,
    requestId: requestIdOf(c),
    ...(ip === undefined ? {} : { ip }),
    ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 500) }),
  };
}

function planError(error: unknown): never {
  if (error instanceof PlanError) {
    switch (error.reason) {
      case "not_found":
        throw new ApiError("not_found", "no such plan");
      case "exists":
        throw new ApiError("conflict", error.message, { reason: "plan_exists" });
      case "version_conflict":
        throw new ApiError("version_conflict", error.message, {
          currentVersion: error.current?.version ?? null,
        });
      case "price_ref_conflict":
        throw new ApiError("conflict", error.message, {
          reason: "price_ref_conflict",
          priceRef: error.priceRef ?? null,
        });
      // A-3: `limits.modules` named something that is not an optional module of this build.
      case "unknown_module":
        throw new ApiError("validation_failed", error.message, {
          reason: "unknown_module",
          module: error.module ?? null,
        });
    }
  }
  throw error;
}

const TAGS = ["platform"];
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);

export function registerPlatformPlanRoutes(api: Api, deps: ApiDeps): void {
  const operator = requirePlatformOperator(deps);

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/plans",
      tags: TAGS,
      summary: "Plans",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      responses: { 200: jsonResponse(p.PlanListSchema, "Plans"), ...ERRORS },
    }),
    async (c) => {
      const plans = await deps.db.withHost(async (tx) => {
        const [all, counts] = await Promise.all([
          listPlans(tx, { includeArchived: true }),
          planWorkspaceCounts(tx),
        ]);
        return all.map((plan) => planBody(plan, counts.get(plan.id) ?? 0));
      });
      return c.json({ plans, entitlementCatalog: entitlementCatalog() }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/plans",
      tags: TAGS,
      summary: "Create a plan",
      description:
        '400 `validation_failed` with `{ reason: "unknown_module", module }` when `limits.modules` names something other than an optional module of this build (`entitlementCatalog.modules`).',
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { body: jsonBody(p.PlanCreateBody) },
      responses: { 201: jsonResponse(p.PlanSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const actor = operatorActor(c, deps);
      try {
        const plan = await deps.db.withHost((tx) =>
          createPlan(
            tx,
            {
              id: body.id,
              name: body.name,
              limits: body.limits,
              billingPriceRef: body.billingPriceRef ?? null,
              billingMeteredPriceRefs: body.billingMeteredPriceRefs ?? [],
              trialDays: body.trialDays ?? 0,
              public: body.public ?? false,
            },
            actor,
            { audit: deps.audit, optionalModules: OPTIONAL_MODULE_IDS },
          ),
        );
        return c.json(planBody(plan, 0), 201);
      } catch (error) {
        planError(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/platform/plans/{id}",
      tags: TAGS,
      summary: "Change a plan",
      description:
        'Optimistic: send the `version` you read; 409 `version_conflict` when it moved. `limits` replaces the whole object, entitlement lists included: a `modules` / `features` key left out means "all" (unlike `fundroom plan upsert --limits`, which keeps lists it does not mention), so send the lists you read. 400 `unknown_module` as on create.',
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.PlanIdParam, body: jsonBody(p.PlanPatchBody) },
      responses: { 200: jsonResponse(p.PlanSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { version, ...patch } = c.req.valid("json");
      const actor = operatorActor(c, deps);
      try {
        const body = await deps.db.withHost(async (tx) => {
          const plan = await updatePlan(tx, id, version, patch, actor, {
            audit: deps.audit,
            optionalModules: OPTIONAL_MODULE_IDS,
          });
          return planBody(plan, (await planWorkspaceCounts(tx)).get(plan.id) ?? 0);
        });
        return c.json(body, 200);
      } catch (error) {
        planError(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/plans/{id}/archive",
      tags: TAGS,
      summary: "Archive a plan",
      description: "Workspaces keep it; it can no longer be assigned or offered.",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.PlanIdParam },
      responses: { 200: jsonResponse(p.PlanSchema, "Archived"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const actor = operatorActor(c, deps);
      try {
        const body = await deps.db.withHost(async (tx) => {
          const plan = await archivePlan(tx, id, actor, { audit: deps.audit });
          return planBody(plan, (await planWorkspaceCounts(tx)).get(plan.id) ?? 0);
        });
        return c.json(body, 200);
      } catch (error) {
        planError(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/workspaces/{id}/usage",
      tags: TAGS,
      summary: "A workspace's usage against its plan",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.PlatformWorkspaceIdParam },
      responses: { 200: jsonResponse(p.WorkspaceUsageSchema, "Usage"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = await deps.db.withHost(async (tx) => {
        const planId = await workspacePlanId(tx, id);
        if (planId === undefined) throw new ApiError("not_found", "no such workspace");
        return workspaceUsage(tx, id, planId, new Date());
      });
      return c.json(body, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/usage",
      tags: ["billing"],
      summary: "This workspace's usage against its plan",
      description: "Today so far and the last 30 days. 404 unless the control plane is on.",
      security: sessionSecurity,
      "x-requires": "billing.read",
      middleware: [requirePermission({ authz: () => deps.authz }, "billing.read")] as const,
      responses: { 200: jsonResponse(p.WorkspaceUsageSchema, "Usage"), ...ERRORS },
    }),
    async (c) => {
      // The feature gate comes after the permission guard (the authz sweep's order), with its own
      // message: "no such path" is the guard's, and the sweep must tell a denial from the gate.
      if (!deps.controlPlane.enabled) throw new ApiError("not_found", USAGE_OFF_MESSAGE);
      const tenant = c.get("tenant");
      const workspace = c.get("workspace");
      if (!tenant || !workspace) throw new ApiError("unauthenticated");
      const body = await deps.db.withTenant(tenant, (tx) =>
        workspaceUsage(tx, workspace.id, workspace.planId, new Date()),
      );
      return c.json(body, 200);
    },
  );
}
