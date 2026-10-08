import { randomUUID } from "node:crypto";
import type { AuditRecorder } from "@fundroom/audit";
import { getPlan, listPlans, type Plan, setWorkspaceHold } from "@fundroom/control-plane";
import {
  type Database,
  PLATFORM_WORKSPACE_ID,
  platformContext,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import type {
  BillingEvent,
  BillingPort,
  ControlPlaneHooks,
  JobQueuePort,
  JsonObject,
  SubscriptionStatus,
} from "@fundroom/ports";
import { decideGrace, remainingTrialDays, trialUsed } from "./effects.js";
import {
  enterSystemContext,
  findSubscription,
  findWorkspace,
  insertSubscription,
  insertSubscriptionIfAbsent,
  lockSubscription,
  onlyBillingHolds,
  readTxContext,
  restoreTxContext,
  type SubscriptionRow,
  setWorkspacePlan,
  updateSubscription,
} from "./repos/billing-repo.js";
import { type BillingIngestResult, ingestBillingEvent } from "./webhook.js";

/*
 * The billing service (E3.10, ADR-0058; owner: agent B). Owns `core.subscription` (host/system
 * writes) and `core.billing_event` (dedupe, 90 days). Routes: `apps/server/src/routes/billing.ts`
 * (tenant `/api/v1/billing*`, the manual driver's operator `POST
 * /platform/workspaces/{id}/subscription`) and `routes/billing-webhook.ts` (`POST
 * /webhooks/billing/stripe`). Status effects go through `setWorkspaceHold` from
 * `@fundroom/control-plane` (the `billing` hold: set after grace, cleared in good standing).
 *
 * A new workspace with a plan (`onWorkspaceCreated`, in the provisioning transaction):
 *
 *   manual  trial days > 0 → `trialing` until now + trial days; else `active` (the operator
 *           invoices by hand and records changes through the operator route)
 *   stripe  plan without a price → no subscription (a free plan: nothing to collect);
 *           trial days > 0 → a LOCAL `trialing` row (no provider ids) until now + trial days;
 *           else `incomplete` with the grace period running from now
 *
 * A local trial that ends without a provider subscription behind it becomes `incomplete` with the
 * grace period running (the enforcement job, which mails the owners), so a workspace that never
 * pays is suspended `trial + grace` after it was created. Checkout grants the REST of a local
 * trial as Stripe's `trial_period_days`, so paying early does not cost trial days, and a trial is
 * never granted twice. The hook writes no audit row: it runs inside provisioning, whose
 * `workspace.created` entry is the record, and an audit here would take the workspace's chain
 * before the provisioning path's own first audit.
 *
 * The checkout creates the Stripe customer and STORES it on the row (an `incomplete` row when the
 * workspace had none) before the customer can pay, so the webhook maps the customer — and only a
 * customer we created — back to the workspace (see `webhook.ts`).
 */

/** After-commit mail to the workspace's owners (`billing-past-due`, `billing-suspended`). */
export type BillingNotifier = (input: {
  readonly kind: "past_due" | "suspended";
  readonly workspaceId: string;
  readonly graceUntil: Date | null;
}) => Promise<void>;

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface BillingServiceDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly queue: Pick<JobQueuePort, "send" | "sendInTransaction">;
  /** `null` with BILLING_DRIVER=none (or CONTROL_PLANE=off). */
  readonly port: BillingPort | null;
  readonly graceDays: number;
  /**
   * The Stripe meter event names usage is reported under (`BILLING_METER_*_EVENT`). Omitted =
   * `BILLING_METERS`, the config defaults.
   */
  readonly meters?: { readonly staffSeats: string; readonly storageGb: string } | undefined;
  readonly now: () => Date;
  /** Drops cached resolved workspaces after a status change commits (`resolver.invalidate`). */
  readonly invalidate?: (() => void) | undefined;
  readonly notify?: BillingNotifier | undefined;
  readonly log?: Log | undefined;
}

/** A refusal the routes map onto the API vocabulary. */
export class BillingError extends Error {
  override readonly name = "BillingError";
  constructor(
    readonly code: "billing_manual" | "billing_unavailable" | "not_found" | "invalid_request",
    message: string,
    readonly reason?: string | undefined,
  ) {
    super(message);
  }
}

/** Who asked, for the audit row: a workspace member or a platform operator. */
export interface MemberActor {
  readonly membershipId: string;
  readonly userId: string;
  readonly sessionId?: string | undefined;
  readonly requestId?: string | undefined;
}

export interface OperatorActor {
  readonly userId: string;
  readonly sessionId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface BillingPlanView {
  readonly id: string;
  readonly name: string;
  readonly limits: Plan["limits"];
  readonly trialDays: number;
}

export interface BillingOverview {
  readonly driver: "manual" | "stripe";
  readonly subscription: {
    readonly planId: string;
    readonly planName: string;
    readonly status: SubscriptionStatus;
    readonly currentPeriodEnd: Date | null;
    readonly trialEnd: Date | null;
    readonly cancelAtPeriodEnd: boolean;
    readonly graceUntil: Date | null;
  } | null;
  readonly plans: readonly BillingPlanView[];
}

export interface BillingService {
  /** `onWorkspaceCreated`: the manual / trialing subscription for a new workspace with a plan. */
  readonly hooks: ControlPlaneHooks;
  /** The billing page, read as the member (`tenant`: the request's own context). */
  overview(tenant: TenantContext): Promise<BillingOverview>;
  startCheckout(input: {
    readonly workspaceId: string;
    readonly planId: string;
    readonly email: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
    readonly actor: MemberActor;
  }): Promise<{ url: string }>;
  openPortal(input: {
    readonly workspaceId: string;
    readonly returnUrl: string;
    readonly actor: MemberActor;
  }): Promise<{ url: string }>;
  /** The manual driver's operator write (`POST /platform/workspaces/{id}/subscription`). */
  recordManual(input: {
    readonly workspaceId: string;
    readonly status: SubscriptionStatus;
    readonly planId?: string | undefined;
    readonly currentPeriodEnd?: Date | null | undefined;
    readonly actor: OperatorActor;
  }): Promise<{ status: SubscriptionStatus; provider: "manual"; currentPeriodEnd: Date | null }>;
  /** A verified provider event (see `webhook.ts`). */
  ingest(event: BillingEvent): Promise<BillingIngestResult>;
}

const DAY_MS = 86_400_000;

/** Records one audit row on the workspace's chain from a transaction in any context. */
export async function auditOnWorkspace(
  tx: Tx,
  audit: AuditRecorder,
  workspaceId: string,
  input: Parameters<AuditRecorder["record"]>[2],
): Promise<void> {
  const saved = await readTxContext(tx);
  await enterSystemContext(tx, workspaceId);
  await audit.record(tx, systemContext(workspaceId), input);
  await restoreTxContext(tx, saved);
}

/** Same, on the platform chain (after every tenant-chain row of the transaction: lock order). */
async function auditOnPlatform(
  tx: Tx,
  audit: AuditRecorder,
  input: Parameters<AuditRecorder["record"]>[2],
): Promise<void> {
  const saved = await readTxContext(tx);
  await enterSystemContext(tx, PLATFORM_WORKSPACE_ID);
  await audit.record(tx, platformContext(), input);
  await restoreTxContext(tx, saved);
}

/**
 * No money moves for a workspace suspended for a confirmed sanctions match (RR1-M1): its provider
 * subscription is being canceled (`billing.cancel`), and a new checkout or a portal session would
 * start or resume paying a sanctioned party. 409 `billing_unavailable`, reason `sanctions`.
 */
function refuseUnderSanctions(ws: { readonly holds: readonly string[] }): void {
  if (ws.holds.includes("sanctions")) {
    throw new BillingError(
      "billing_unavailable",
      "billing is unavailable for this workspace",
      "sanctions",
    );
  }
}

function planView(plan: Plan): BillingPlanView {
  return { id: plan.id, name: plan.name, limits: plan.limits, trialDays: plan.trialDays };
}

/** Builds the service. With no port (BILLING_DRIVER=none) the hook does nothing. */
export function createBillingService(deps: BillingServiceDeps): BillingService {
  const log = deps.log ?? (() => {});
  const invalidate = deps.invalidate ?? (() => {});

  function stripePort(): BillingPort {
    if (deps.port === null || deps.port.driver !== "stripe") {
      throw new BillingError("billing_manual", "the operator manages this workspace's billing");
    }
    return deps.port;
  }

  async function notify(
    kind: "past_due" | "suspended",
    workspaceId: string,
    graceUntil: Date | null,
  ): Promise<void> {
    if (deps.notify === undefined) return;
    try {
      await deps.notify({ kind, workspaceId, graceUntil });
    } catch (error) {
      // The state change committed; a lost mail is a log line, not a failed request.
      log("billing.notify_failed", {
        level: "warn",
        kind,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const hooks: ControlPlaneHooks = {
    async onWorkspaceCreated(handle, ws) {
      const port = deps.port;
      if (port === null || ws.planId === null) return;
      const tx = handle as Tx;
      const plan = await getPlan(tx, ws.planId);
      if (plan === undefined) return;
      const now = deps.now();
      const trialEnd =
        plan.trialDays > 0 ? new Date(now.getTime() + plan.trialDays * DAY_MS) : null;
      if (port.driver === "stripe" && plan.billingPriceRef === null) return;
      const status: SubscriptionStatus =
        trialEnd !== null ? "trialing" : port.driver === "manual" ? "active" : "incomplete";
      await insertSubscription(tx, ws.id, {
        planId: plan.id,
        provider: port.driver,
        status,
        providerCustomerId: null,
        providerSubscriptionId: null,
        currentPeriodEnd: null,
        trialEnd,
        cancelAtPeriodEnd: false,
        // Stripe without a trial: pay within the grace period.
        graceUntil:
          status === "incomplete" ? new Date(now.getTime() + deps.graceDays * DAY_MS) : null,
        lastEventAt: null,
      });
    },
  };

  return {
    hooks,

    async overview(tenant) {
      const port = deps.port;
      if (port === null) throw new BillingError("not_found", "billing is off");
      return deps.db.withTenant(tenant, async (tx) => {
        const row = await findSubscription(tx, tenant.workspaceId);
        const plans = await listPlans(tx, { publicOnly: true });
        let subscription: BillingOverview["subscription"] = null;
        if (row !== undefined) {
          const plan = plans.find((p) => p.id === row.planId) ?? (await getPlan(tx, row.planId));
          subscription = {
            planId: row.planId,
            planName: plan?.name ?? row.planId,
            status: row.status,
            currentPeriodEnd: row.currentPeriodEnd,
            trialEnd: row.trialEnd,
            cancelAtPeriodEnd: row.cancelAtPeriodEnd,
            graceUntil: row.graceUntil,
          };
        }
        return { driver: port.driver, subscription, plans: plans.map(planView) };
      });
    },

    async startCheckout(input) {
      const port = stripePort();
      const ctx = systemContext(input.workspaceId);
      const now = deps.now();
      const facts = await deps.db.withTenant(ctx, async (tx) => {
        const plan = await getPlan(tx, input.planId);
        if (plan === undefined || !plan.public || plan.archivedAt !== null) {
          throw new BillingError("not_found", "no such plan");
        }
        if (plan.billingPriceRef === null) {
          throw new BillingError("billing_unavailable", "this plan has no price", "no_price");
        }
        const ws = await findWorkspace(tx, input.workspaceId);
        if (ws === undefined) throw new BillingError("not_found", "no such workspace");
        refuseUnderSanctions(ws);
        const row = await findSubscription(tx, input.workspaceId);
        if (
          row?.provider === "stripe" &&
          row.providerSubscriptionId !== null &&
          row.status !== "canceled"
        ) {
          // A second subscription on one customer is never what anybody wants: change plans in
          // the provider's portal instead.
          throw new BillingError(
            "billing_unavailable",
            "this workspace already has a subscription; use the billing portal",
            "subscription_exists",
          );
        }
        return { plan, ws, row };
      });
      const { plan, ws, row } = facts;
      const stripeRow = row?.provider === "stripe" ? row : undefined;
      const trialDays = remainingTrialDays({
        planTrialDays: plan.trialDays,
        localTrialEnd:
          stripeRow !== undefined &&
          stripeRow.status === "trialing" &&
          stripeRow.providerSubscriptionId === null
            ? stripeRow.trialEnd
            : null,
        // An earlier subscription or a trial that ran had its trial; an abandoned checkout did not.
        hadSubscription: trialUsed(row),
        now,
      });
      const checkout = await port.createCheckout({
        workspaceId: input.workspaceId,
        customerRef: stripeRow?.providerCustomerId ?? null,
        email: input.email,
        legalName: ws.legalName ?? ws.name,
        priceRef: plan.billingPriceRef as string,
        meteredPriceRefs: plan.billingMeteredPriceRefs,
        trialDays,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        idempotencyKey: `fundroom:checkout:${randomUUID()}`,
      });
      await deps.db.withTenant(ctx, async (tx) => {
        const locked = await lockSubscription(tx, input.workspaceId);
        if (locked === undefined) {
          const inserted = await insertSubscriptionIfAbsent(tx, input.workspaceId, {
            planId: plan.id,
            provider: "stripe",
            status: "incomplete",
            providerCustomerId: checkout.customerRef,
            providerSubscriptionId: null,
            currentPeriodEnd: null,
            trialEnd: null,
            cancelAtPeriodEnd: false,
            graceUntil: null,
            lastEventAt: null,
          });
          if (!inserted) {
            // A concurrent first checkout inserted the row (with its own customer) between our
            // look and our insert: the same answer as a stored customer that differs, not a 500.
            throw new BillingError(
              "billing_unavailable",
              "another checkout is in progress; try again",
              "customer_changed",
            );
          }
        } else if (locked.provider !== "stripe" || locked.providerCustomerId === null) {
          await updateSubscription(tx, input.workspaceId, {
            provider: "stripe",
            providerCustomerId: checkout.customerRef,
          });
        } else if (locked.providerCustomerId !== checkout.customerRef) {
          // A concurrent checkout stored another customer first; this session's customer is not
          // ours to map, so its URL must not be handed out.
          throw new BillingError(
            "billing_unavailable",
            "another checkout is in progress; try again",
            "customer_changed",
          );
        }
        await deps.audit.record(tx, ctx, {
          action: "billing.checkout_start",
          resourceKind: "subscription",
          resourceId: input.workspaceId,
          actorKind: "staff",
          actorMembershipId: input.actor.membershipId,
          actorUserId: input.actor.userId,
          sessionId: input.actor.sessionId ?? null,
          requestId: input.actor.requestId ?? null,
          meta: { planId: plan.id, trialDays, provider: "stripe" },
        });
      });
      return { url: checkout.url };
    },

    async openPortal(input) {
      const port = stripePort();
      const ctx = systemContext(input.workspaceId);
      const row = await deps.db.withTenant(ctx, async (tx) => {
        const ws = await findWorkspace(tx, input.workspaceId);
        if (ws === undefined) throw new BillingError("not_found", "no such workspace");
        refuseUnderSanctions(ws);
        return findSubscription(tx, input.workspaceId);
      });
      if (row?.provider !== "stripe" || row.providerCustomerId === null) {
        throw new BillingError(
          "billing_unavailable",
          "this workspace has no billing account yet; start a checkout first",
          "no_customer",
        );
      }
      const session = await port.createPortalSession({
        customerRef: row.providerCustomerId,
        returnUrl: input.returnUrl,
      });
      await deps.db.withTenant(ctx, (tx) =>
        deps.audit.record(tx, ctx, {
          action: "billing.portal_open",
          resourceKind: "subscription",
          resourceId: input.workspaceId,
          actorKind: "staff",
          actorMembershipId: input.actor.membershipId,
          actorUserId: input.actor.userId,
          sessionId: input.actor.sessionId ?? null,
          requestId: input.actor.requestId ?? null,
          meta: { provider: "stripe" },
        }),
      );
      return { url: session.url };
    },

    async recordManual(input) {
      if (deps.port?.driver !== "manual") {
        throw new BillingError(
          "billing_unavailable",
          "subscriptions are recorded by hand only with BILLING_DRIVER=manual",
          "not_manual",
        );
      }
      const now = deps.now();
      const outcome = await deps.db.withHost(async (tx) => {
        const ws = await findWorkspace(tx, input.workspaceId);
        if (ws === undefined || ws.deletedAt !== null) {
          throw new BillingError("not_found", "no such workspace");
        }
        const planId = input.planId ?? ws.planId;
        if (planId === null) {
          throw new BillingError("billing_unavailable", "the workspace has no plan", "no_plan");
        }
        const plan = await getPlan(tx, planId);
        if (plan === undefined || (plan.archivedAt !== null && planId !== ws.planId)) {
          throw new BillingError("not_found", "no such plan");
        }
        // Lock order: our row, then (through setWorkspaceHold / the audit) the workspace row.
        const row = await lockSubscription(tx, input.workspaceId);
        const currentPeriodEnd =
          input.currentPeriodEnd === undefined
            ? (row?.currentPeriodEnd ?? null)
            : input.currentPeriodEnd;
        const grace = decideGrace({
          graceUntil: row?.graceUntil ?? null,
          status: input.status,
          currentPeriodEnd,
          now,
          graceDays: deps.graceDays,
        });
        const write = {
          planId,
          provider: "manual" as const,
          status: input.status,
          providerCustomerId: null,
          providerSubscriptionId: null,
          currentPeriodEnd,
          trialEnd: row?.trialEnd ?? null,
          cancelAtPeriodEnd: false,
          graceUntil: grace.graceUntil,
          lastEventAt: row?.lastEventAt ?? null,
        };
        if (row === undefined) await insertSubscription(tx, input.workspaceId, write);
        else await updateSubscription(tx, input.workspaceId, write);
        const planChanged = ws.planId !== planId;
        if (planChanged) await setWorkspacePlan(tx, input.workspaceId, planId);
        const change = grace.recovered
          ? await setWorkspaceHold(
              tx,
              {
                workspaceId: input.workspaceId,
                hold: "billing",
                on: false,
                actor: { kind: "operator", ...input.actor },
                meta: { subscriptionStatus: input.status },
              },
              { audit: deps.audit, invalidate, now: deps.now },
            )
          : undefined;
        const facts: JsonObject = {
          operator: true,
          provider: "manual",
          planId,
          from: row?.status ?? null,
          to: input.status,
        };
        const common = {
          resourceKind: "subscription",
          resourceId: input.workspaceId,
          actorKind: "host",
          actorMembershipId: null,
          actorUserId: input.actor.userId,
          requestId: input.actor.requestId ?? null,
        } as const;
        // The tenant's chain names no operator (R1-L5): `meta.operator` only; who it was is on the
        // platform chain.
        const tenantCommon = { ...common, actorUserId: null };
        await auditOnWorkspace(tx, deps.audit, input.workspaceId, {
          ...tenantCommon,
          action: "subscription.update",
          meta: facts,
        });
        if (planChanged) {
          await auditOnWorkspace(tx, deps.audit, input.workspaceId, {
            ...tenantCommon,
            action: "workspace.plan_change",
            resourceKind: "workspace",
            meta: { operator: true, from: ws.planId, to: planId },
          });
        }
        await auditOnPlatform(tx, deps.audit, {
          ...common,
          action: "subscription.update",
          ip: input.actor.ip ?? null,
          userAgent: input.actor.userAgent ?? null,
          sessionId: input.actor.sessionId ?? null,
          meta: { ...facts, workspaceId: input.workspaceId },
        });
        if (planChanged) {
          await auditOnPlatform(tx, deps.audit, {
            ...common,
            action: "workspace.plan_change",
            resourceKind: "workspace",
            ip: input.actor.ip ?? null,
            userAgent: input.actor.userAgent ?? null,
            sessionId: input.actor.sessionId ?? null,
            meta: { operator: true, from: ws.planId, to: planId, workspaceId: input.workspaceId },
          });
        }
        return { grace, change, currentPeriodEnd, acting: onlyBillingHolds(ws) };
      });
      outcome.change?.afterCommit();
      if (outcome.grace.entered && outcome.acting) {
        await notify("past_due", input.workspaceId, outcome.grace.graceUntil);
      }
      return {
        status: input.status,
        provider: "manual",
        currentPeriodEnd: outcome.currentPeriodEnd,
      };
    },

    async ingest(event) {
      const port = deps.port;
      if (port === null || port.driver !== "stripe") {
        return { outcome: "ignored", workspaceId: null };
      }
      const result = await ingestBillingEvent(
        { ...deps, port, log, invalidate, provider: "stripe" },
        event,
      );
      result.afterCommit?.();
      if (result.pastDue !== undefined && result.workspaceId !== null) {
        await notify("past_due", result.workspaceId, result.pastDue);
      }
      return result;
    },
  };
}

export type { SubscriptionRow };
