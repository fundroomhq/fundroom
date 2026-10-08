import { z } from "@hono/zod-openapi";
import { PlanIdSchema, PlanLimitsSchema, SubscriptionStatusSchema } from "./platform.js";
import { TimestampSchema } from "./schemas.js";

/*
 * The tenant's billing page (E3.10, ADR-0058): `/api/v1/billing*`, handlers in
 * `apps/server/src/routes/billing.ts` behind the required `billing` kernel manifest
 * (`billing.read`: owner, finance; `billing.manage`: owner). Every route answers 404 unless
 * CONTROL_PLANE=on and BILLING_DRIVER is not `none` — checked after the permission guard, so the
 * authz answer comes first.
 *
 * Checkout and portal URLs are the provider's; the success/cancel/return URLs we hand the
 * provider are built from BASE_URL (`<slug>.<canonical>` or `/w/<slug>`), never a custom domain.
 */

export const BillingSubscriptionSchema = z
  .object({
    planId: PlanIdSchema,
    planName: z.string(),
    status: SubscriptionStatusSchema,
    currentPeriodEnd: z.union([TimestampSchema, z.null()]),
    trialEnd: z.union([TimestampSchema, z.null()]),
    cancelAtPeriodEnd: z.boolean(),
    graceUntil: z.union([TimestampSchema, z.null()]).openapi({
      description: "Past due / unpaid: the workspace is suspended after this instant",
    }),
  })
  .openapi("BillingSubscription");

export const BillingPlanSchema = z
  .object({
    id: PlanIdSchema,
    name: z.string(),
    limits: PlanLimitsSchema,
    trialDays: z.number().int().min(0).max(90),
  })
  .openapi("BillingPlan");

export const BillingOverviewSchema = z
  .object({
    driver: z.enum(["manual", "stripe"]),
    subscription: z.union([BillingSubscriptionSchema, z.null()]),
    plans: z.array(BillingPlanSchema).openapi({ description: "Public, unarchived plans" }),
    canManage: z.boolean().openapi({ description: "The caller holds `billing.manage`" }),
  })
  .openapi("BillingOverview");

export const BillingCheckoutBody = z.strictObject({ planId: PlanIdSchema });

export const BillingRedirectSchema = z
  .object({
    url: z.url().openapi({ description: "The provider's hosted page; navigate the top window" }),
  })
  .openapi("BillingRedirect");
