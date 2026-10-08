import { BillingError, type BillingOverview } from "@fundroom/billing";
import {
  ApiError,
  billing as b,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  platform as p,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import type { ResolvedWorkspace } from "@fundroom/db";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import { platformOperatorOf, requirePlatformOperator } from "../middleware/platform.js";
import { type ApiDeps, clientIp, workspaceUrl } from "./deps.js";

/*
 * Billing (E3.10, ADR-0058; owner: agent B): the tenant's `/api/v1/billing*` (kernel manifest
 * `billing`: `billing.read` owner/admin/finance, `billing.manage` owner + step-up) and the manual
 * driver's operator write `POST /platform/workspaces/{id}/subscription`. Every tenant route 404s
 * unless CONTROL_PLANE=on and BILLING_DRIVER is not `none` — checked after the permission guard.
 * Checkout success/cancel and portal return URLs come from BASE_URL, never a custom domain.
 * The provider webhook is `billing-webhook.ts`.
 */

type Api = OpenAPIHono<AppEnv>;

/** `BillingError` onto the API vocabulary (`reason` rides in `error.reason`). */
function rethrow(error: unknown): never {
  if (error instanceof BillingError) {
    throw new ApiError(
      error.code,
      error.message,
      error.reason === undefined ? undefined : { reason: error.reason },
    );
  }
  throw error;
}

const iso = (at: Date | null) => (at === null ? null : at.toISOString());

function overviewBody(overview: BillingOverview, canManage: boolean) {
  const s = overview.subscription;
  return {
    driver: overview.driver,
    subscription:
      s === null
        ? null
        : {
            planId: s.planId,
            planName: s.planName,
            status: s.status,
            currentPeriodEnd: iso(s.currentPeriodEnd),
            trialEnd: iso(s.trialEnd),
            cancelAtPeriodEnd: s.cancelAtPeriodEnd,
            graceUntil: iso(s.graceUntil),
          },
    plans: overview.plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      limits: { ...plan.limits },
      trialDays: plan.trialDays,
    })),
    canManage,
  };
}

interface Member {
  readonly workspace: NonNullable<AppEnv["Variables"]["workspace"]>;
  readonly tenant: NonNullable<AppEnv["Variables"]["tenant"]>;
  readonly membership: NonNullable<AppEnv["Variables"]["membership"]>;
  readonly session: NonNullable<AppEnv["Variables"]["session"]>;
}

function memberOf(c: Context<AppEnv>): Member {
  const workspace = c.get("workspace");
  const tenant = c.get("tenant");
  const membership = c.get("membership");
  const session = c.get("session");
  if (!workspace || !tenant || !membership || !session) throw new ApiError("unauthenticated");
  return { workspace, tenant, membership, session };
}

const TAGS = ["billing"];
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 502, 503);

export function registerBillingRoutes(api: Api, deps: ApiDeps): void {
  const perm = (permission: string, extra: { readonly fresh?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, permission, extra);

  api.openapi(
    createRoute({
      method: "get",
      path: "/billing",
      tags: TAGS,
      summary: "The workspace's plan and subscription",
      security: sessionSecurity,
      "x-requires": "billing.read",
      middleware: [perm("billing.read")] as const,
      responses: { 200: jsonResponse(b.BillingOverviewSchema, "Billing"), ...ERRORS },
    }),
    async (c) => {
      const service = enabledService(deps);
      const m = memberOf(c);
      const overview = await service.overview(m.tenant).catch(rethrow);
      return c.json(
        overviewBody(overview, deps.authz.hasPermission(m.membership, "billing.manage")),
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/billing/checkout",
      tags: TAGS,
      summary: "Start a checkout for a plan",
      description:
        "Returns the provider's hosted checkout URL. 409 `billing_manual` with the manual driver, `billing_unavailable` when the plan has no price. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "billing.manage+fresh",
      middleware: [perm("billing.manage", { fresh: true })] as const,
      request: { body: jsonBody(b.BillingCheckoutBody) },
      responses: { 200: jsonResponse(b.BillingRedirectSchema, "Checkout"), ...ERRORS },
    }),
    async (c) => {
      const service = enabledService(deps);
      const m = memberOf(c);
      const { planId } = c.req.valid("json");
      if (deps.billing.driver !== "stripe") throw manualRefusal();
      const email = await deps.auth.primaryEmail(m.session.userId);
      if (email === undefined) {
        throw new ApiError("billing_unavailable", "your account has no email address", {
          reason: "no_email",
        });
      }
      const page = (outcome: string) => billingPage(deps, m.workspace, `?checkout=${outcome}`);
      const result = await service
        .startCheckout({
          workspaceId: m.workspace.id,
          planId,
          email,
          successUrl: page("success"),
          cancelUrl: page("cancel"),
          actor: {
            membershipId: m.membership.id,
            userId: m.session.userId,
            sessionId: m.session.sessionId,
            requestId: requestIdOf(c),
          },
        })
        .catch(rethrow);
      return c.json({ url: result.url }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/billing/portal",
      tags: TAGS,
      summary: "Open the billing provider's customer portal",
      description: "409 `billing_manual` with the manual driver. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "billing.manage+fresh",
      middleware: [perm("billing.manage", { fresh: true })] as const,
      responses: { 200: jsonResponse(b.BillingRedirectSchema, "Portal"), ...ERRORS },
    }),
    async (c) => {
      const service = enabledService(deps);
      const m = memberOf(c);
      if (deps.billing.driver !== "stripe") throw manualRefusal();
      const result = await service
        .openPortal({
          workspaceId: m.workspace.id,
          returnUrl: billingPage(deps, m.workspace, ""),
          actor: {
            membershipId: m.membership.id,
            userId: m.session.userId,
            sessionId: m.session.sessionId,
            requestId: requestIdOf(c),
          },
        })
        .catch(rethrow);
      return c.json({ url: result.url }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/workspaces/{id}/subscription",
      tags: ["platform"],
      summary: "Record a manual subscription",
      description: "BILLING_DRIVER=manual only (else 409 `billing_unavailable`).",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [requirePlatformOperator(deps)] as const,
      request: {
        params: p.PlatformWorkspaceIdParam,
        body: jsonBody(p.PlatformSubscriptionBody),
      },
      responses: {
        200: jsonResponse(p.PlatformSubscriptionSummarySchema, "Subscription"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const service = enabledService(deps);
      const op = platformOperatorOf(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await service
        .recordManual({
          workspaceId: id,
          status: body.status,
          planId: body.planId,
          currentPeriodEnd:
            body.currentPeriodEnd === undefined
              ? undefined
              : body.currentPeriodEnd === null
                ? null
                : new Date(body.currentPeriodEnd),
          actor: {
            userId: op.userId,
            sessionId: op.sessionId,
            requestId: requestIdOf(c),
            ip: clientIp(c, deps.trustProxy),
            userAgent: c.req.header("user-agent"),
          },
        })
        .catch(rethrow);
      return c.json(
        {
          status: result.status,
          provider: result.provider,
          currentPeriodEnd: iso(result.currentPeriodEnd),
        },
        200,
      );
    },
  );
}

/**
 * The billing service when billing is on (CONTROL_PLANE=on and BILLING_DRIVER is not `none`),
 * else a plain 404 `not_found`. Called first thing in every handler — after the route's guard
 * middleware, so the authz answer comes before the feature gate's. The message is the gate's own
 * (like "this workspace does not take access requests"), never the authz guard's "no such path":
 * only somebody the guard already admitted sees it, and the authz sweep tells the two apart.
 */
export const BILLING_OFF_MESSAGE = "billing is not enabled on this install";

function enabledService(deps: ApiDeps) {
  const kernel = deps.billing;
  if (!kernel.enabled || kernel.service === null)
    throw new ApiError("not_found", BILLING_OFF_MESSAGE);
  return kernel.service;
}

function manualRefusal(): ApiError {
  return new ApiError("billing_manual", "the operator manages this workspace's billing");
}

/**
 * `…/admin/billing<query>` on the workspace's BASE_URL host (`<slug>.<canonical>` or
 * `/w/<slug>`), NEVER its custom domain: the provider redirects the browser here, and a hostname
 * whose DNS the tenant controls must not be where a payment flow returns to.
 */
function billingPage(
  deps: ApiDeps,
  workspace: Pick<ResolvedWorkspace, "slug" | "primaryHost">,
  query: string,
): string {
  const url = workspaceUrl(
    deps.baseUrl,
    deps.tenancy,
    { slug: workspace.slug, primaryHost: null },
    "/admin/billing",
    deps.basePath,
  );
  return `${url.href}${query}`;
}
