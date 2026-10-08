import type { AuditRecorder } from "@fundroom/audit";
import { setWorkspaceHold } from "@fundroom/control-plane";
import type { Database } from "@fundroom/db";
import type {
  BillingEvent,
  BillingPort,
  BillingSubscriptionFact,
  JobQueuePort,
} from "@fundroom/ports";
import { enqueueBillingCancel } from "./cancel.js";
import { decideGrace, factPrices, isStale, priceChanged } from "./effects.js";
import {
  billingEventSeen,
  claimBillingEvent,
  enterSystemContext,
  findPlanIdByPriceRefs,
  findWorkspace,
  lockByProviderCustomer,
  lockByProviderSubscription,
  onlyBillingHolds,
  planPriceRef,
  readTxContext,
  restoreTxContext,
  type SubscriptionRow,
  setBillingEventWorkspace,
  setWorkspacePlan,
  updateSubscription,
} from "./repos/billing-repo.js";

/*
 * Provider webhook ingest (E3.10, ADR-0058; owner: agent B): verify (`BillingPort.parseWebhook`,
 * 300 s tolerance) → dedupe on `core.billing_event.id` → re-read (`getSubscription`) → upsert the
 * subscription under `SELECT … FOR UPDATE` before any audit, ignoring facts older than
 * `last_event_at`. The workspace is mapped only from ids we stored.
 *
 * The route (`apps/server/src/routes/billing-webhook.ts`) verifies; this file starts from a
 * verified event and never trusts what it says beyond "look at subscription X":
 *
 *  1. **Dedupe.** A cheap look first (a replay costs no Stripe read), then the claim — an insert
 *     into `core.billing_event` in the SAME transaction as the upsert, so an event we failed to
 *     apply is not marked done and Stripe's retry gets another go. A concurrent duplicate waits on
 *     the primary key and then sees it taken.
 *  2. **Re-read.** `getSubscription` outside any transaction (network), then everything is taken
 *     from that authoritative object. The event's customer must equal the re-read's.
 *  3. **Map from our own ids only.** The row holding that subscription id; else the ONE row
 *     holding that customer id — a customer only our checkout created and stored before anybody
 *     could pay. Metadata (`workspace_id` on the subscription, `client_reference_id` on the
 *     session) is never used to FIND a workspace, only cross-checked: when present it must name
 *     the workspace the ids mapped to, else the event is dropped as forged or confused. A row that
 *     already carries a different live subscription does not adopt a second one.
 *  4. **Order.** A fact whose event is older than `last_event_at` is ignored (Stripe does not
 *     deliver in order).
 *  5. **Apply** under the row lock taken in 3 (before any audit — lock order): status, periods,
 *     plan — only when the price CHANGED (none of the fact's item prices is the price of the plan
 *     the row is on), to the unarchived plan carrying one of them when exactly one does, and the
 *     workspace moves with it; an event about anything else never reverts an operator's plan
 *     override — grace (`effects.ts`). Good standing clears the `billing` hold through
 *     `setWorkspaceHold`, which can never lift an operator or sanctions one.
 *     Then the audit rows on the workspace's chain.
 *
 * Accept and drop: the answer to the provider is 200 whatever the workspace's state (it must not
 * learn it, and a retry would change nothing). The subscription record is still kept current for a
 * held or operator/sanctions-suspended workspace — that is bookkeeping about money, not tenant
 * activity, and dropping it would leave the record wrong once the hold lifts (a subscription
 * canceled meanwhile would never be enforced) — but nothing acts on such a workspace: no mail, and
 * clearing the `billing` hold leaves every other hold in place.
 */

/** Largest webhook body read (bytes). */
export const BILLING_WEBHOOK_MAX_BYTES = 256 * 1024;
/** Signature timestamp tolerance (seconds). */
export const BILLING_WEBHOOK_TOLERANCE_SECONDS = 300;

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export type BillingIngestOutcome =
  /** Applied to the workspace's subscription. */
  | "applied"
  /** Seen before (dedupe). */
  | "duplicate"
  /** An event type we do not act on, or a checkout without a subscription. */
  | "ignored"
  /** Maps to no workspace of ours (logged). */
  | "unknown"
  /** Maps, but a cross-check failed (forged/confused metadata, another customer); logged. */
  | "dropped"
  /** Older than the last fact applied. */
  | "stale";

export interface BillingIngestResult {
  readonly outcome: BillingIngestOutcome;
  readonly workspaceId: string | null;
  /** Drop the resolver caches (a suspension was lifted); run after commit. */
  readonly afterCommit?: (() => void) | undefined;
  /** Grace started with this event: the owners get the past-due mail (active workspaces). */
  readonly pastDue?: Date | undefined;
}

export interface BillingIngestDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly port: BillingPort;
  readonly provider: "stripe";
  readonly graceDays: number;
  readonly now: () => Date;
  readonly invalidate: () => void;
  readonly log: Log;
  /** For the `billing.cancel` re-enqueue (sanctioned or deleted workspace, live subscription). */
  readonly queue: Pick<JobQueuePort, "sendInTransaction">;
}

interface WakeUp {
  readonly eventId: string;
  readonly type: string;
  readonly subscriptionId: string;
  readonly customerId: string;
  /** Metadata naming a workspace, to cross-check (never to look up). Empty strings are absent. */
  readonly claimedWorkspaceIds: readonly string[];
  readonly createdAt: Date;
}

function wakeUpOf(event: BillingEvent): WakeUp | undefined {
  switch (event.kind) {
    case "subscription":
      return {
        eventId: event.eventId,
        type: "customer.subscription",
        subscriptionId: event.fact.providerSubscriptionId,
        customerId: event.fact.providerCustomerId,
        claimedWorkspaceIds: [event.fact.workspaceId].filter((id) => id !== ""),
        createdAt: event.fact.eventCreatedAt,
      };
    case "checkout_completed":
      if (event.providerSubscriptionId === null) return undefined;
      return {
        eventId: event.eventId,
        type: "checkout.session.completed",
        subscriptionId: event.providerSubscriptionId,
        customerId: event.providerCustomerId,
        claimedWorkspaceIds: [event.workspaceId].filter((id) => id !== ""),
        createdAt: event.eventCreatedAt,
      };
    case "ignored":
      return undefined;
  }
}

type Mapping =
  | { readonly row: SubscriptionRow }
  | {
      readonly outcome: "unknown" | "dropped";
      readonly reason: string;
      readonly row?: undefined;
      /** `second_subscription`: the row of OUR customer that already has a live subscription. */
      readonly holder?: SubscriptionRow | undefined;
    };

/** Step 3: the one row our own ids lead to, locked. */
async function mapToRow(
  tx: Parameters<Parameters<Database["withHost"]>[0]>[0],
  fact: BillingSubscriptionFact,
): Promise<Mapping> {
  const bySubscription = await lockByProviderSubscription(tx, fact.providerSubscriptionId);
  if (bySubscription !== undefined) {
    if (
      bySubscription.providerCustomerId !== null &&
      bySubscription.providerCustomerId !== fact.providerCustomerId
    ) {
      return { outcome: "dropped", reason: "customer_mismatch" };
    }
    return { row: bySubscription };
  }
  const byCustomer = await lockByProviderCustomer(tx, fact.providerCustomerId);
  if (byCustomer.length !== 1) {
    return {
      outcome: "unknown",
      reason: byCustomer.length === 0 ? "no_such_customer" : "shared_customer",
    };
  }
  const row = byCustomer[0] as SubscriptionRow;
  if (row.provider !== "stripe") return { outcome: "dropped", reason: "not_stripe" };
  if (
    row.providerSubscriptionId !== null &&
    row.providerSubscriptionId !== fact.providerSubscriptionId &&
    row.status !== "canceled"
  ) {
    return { outcome: "dropped", reason: "second_subscription", holder: row };
  }
  return { row };
}

/** Steps 1–5 for one verified event. */
export async function ingestBillingEvent(
  deps: BillingIngestDeps,
  event: BillingEvent,
): Promise<BillingIngestResult> {
  const wake = wakeUpOf(event);
  if (wake === undefined) {
    const type = event.kind === "ignored" ? event.type : "checkout.session.completed";
    await deps.db.withHost((tx) =>
      claimBillingEvent(tx, {
        id: event.eventId,
        provider: deps.provider,
        type,
        workspaceId: null,
      }),
    );
    return { outcome: "ignored", workspaceId: null };
  }
  if (await deps.db.withHost((tx) => billingEventSeen(tx, wake.eventId))) {
    return { outcome: "duplicate", workspaceId: null };
  }
  // Step 2, outside any transaction. A failure throws: the route answers 5xx and Stripe retries.
  const fact = await deps.port.getSubscription(wake.subscriptionId);
  const now = deps.now();

  const result = await deps.db.withHost(async (tx): Promise<BillingIngestResult> => {
    const claimed = await claimBillingEvent(tx, {
      id: wake.eventId,
      provider: deps.provider,
      type: wake.type,
      workspaceId: null,
    });
    if (!claimed) return { outcome: "duplicate", workspaceId: null };
    if (fact.providerCustomerId !== wake.customerId) {
      deps.log("billing.webhook_dropped", {
        level: "warn",
        eventId: wake.eventId,
        reason: "event_customer_mismatch",
      });
      return { outcome: "dropped", workspaceId: null };
    }
    const mapping = await mapToRow(tx, fact);
    if (mapping.row === undefined) {
      deps.log(
        mapping.outcome === "unknown" ? "billing.webhook_unknown" : "billing.webhook_dropped",
        {
          level: mapping.outcome === "unknown" ? "info" : "warn",
          eventId: wake.eventId,
          reason: mapping.reason,
        },
      );
      // A second subscription on the customer of a deleted or sanctioned workspace is never
      // adopted, but it must not keep charging until it renews either (FR4-1): cancel it.
      if (mapping.holder !== undefined && fact.status !== "canceled") {
        const holderWs = await findWorkspace(tx, mapping.holder.workspaceId);
        if (
          holderWs !== undefined &&
          (holderWs.deletedAt !== null || holderWs.holds.includes("sanctions"))
        ) {
          await enqueueBillingCancel(
            deps.queue,
            tx,
            holderWs.id,
            holderWs.deletedAt !== null ? "deleted" : "sanctions",
            fact.providerSubscriptionId,
          );
        }
      }
      return { outcome: mapping.outcome, workspaceId: null };
    }
    const row = mapping.row;
    const workspaceId = row.workspaceId;
    await setBillingEventWorkspace(tx, wake.eventId, workspaceId);
    const claims = [...wake.claimedWorkspaceIds, fact.workspaceId].filter((id) => id !== "");
    if (claims.some((id) => id !== workspaceId)) {
      deps.log("billing.webhook_dropped", {
        level: "warn",
        eventId: wake.eventId,
        workspaceId,
        reason: "workspace_mismatch",
      });
      return { outcome: "dropped", workspaceId };
    }
    if (isStale(wake.createdAt, row.lastEventAt)) {
      return { outcome: "stale", workspaceId };
    }
    const ws = await findWorkspace(tx, workspaceId);
    if (ws === undefined || ws.deletedAt !== null) {
      // A live provider subscription of a deleted workspace: cancel it (again — idempotent).
      if (ws !== undefined && fact.status !== "canceled") {
        await enqueueBillingCancel(
          deps.queue,
          tx,
          workspaceId,
          "deleted",
          fact.providerSubscriptionId,
        );
      }
      return { outcome: "dropped", workspaceId };
    }
    const grace = decideGrace({
      graceUntil: row.graceUntil,
      status: fact.status,
      currentPeriodEnd: fact.currentPeriodEnd,
      now,
      graceDays: deps.graceDays,
    });
    // The plan moves only when the price did (see `priceChanged`); any item's price may name it.
    // The first fact (none applied yet: the checkout's row) always sets it — workspace included.
    const prices = factPrices(fact);
    const storedPrice = row.lastEventAt === null ? null : await planPriceRef(tx, row.planId);
    const mappedPlan = priceChanged(prices, storedPrice)
      ? await findPlanIdByPriceRefs(tx, prices)
      : undefined;
    const planId = mappedPlan ?? row.planId;
    await updateSubscription(tx, workspaceId, {
      planId,
      provider: "stripe",
      status: fact.status,
      providerCustomerId: fact.providerCustomerId,
      providerSubscriptionId: fact.providerSubscriptionId,
      currentPeriodEnd: fact.currentPeriodEnd,
      trialEnd: fact.trialEnd,
      cancelAtPeriodEnd: fact.cancelAtPeriodEnd,
      graceUntil: grace.graceUntil,
      lastEventAt: wake.createdAt,
    });
    const planChanged = mappedPlan !== undefined && ws.planId !== mappedPlan;
    if (planChanged) await setWorkspacePlan(tx, workspaceId, mappedPlan);
    // Before our own first audit (lock order): workspace row, its chain, the platform chain.
    const change = grace.recovered
      ? await setWorkspaceHold(
          tx,
          {
            workspaceId,
            hold: "billing",
            on: false,
            actor: { kind: "system", source: "billing" },
            meta: { subscriptionStatus: fact.status, eventId: wake.eventId },
          },
          { audit: deps.audit, invalidate: deps.invalidate, now: deps.now },
        )
      : undefined;
    const saved = await readTxContext(tx);
    await enterSystemContext(tx, workspaceId);
    const common = {
      resourceKind: "subscription",
      resourceId: workspaceId,
      actorKind: "system",
      actorMembershipId: null,
      actorUserId: null,
    } as const;
    await deps.audit.record(
      tx,
      { workspaceId, actorKind: "system" },
      {
        ...common,
        action: "subscription.update",
        meta: {
          provider: "stripe",
          eventId: wake.eventId,
          eventType: wake.type,
          from: row.status,
          to: fact.status,
          planId,
        },
      },
    );
    if (planChanged) {
      await deps.audit.record(
        tx,
        { workspaceId, actorKind: "system" },
        {
          ...common,
          action: "workspace.plan_change",
          resourceKind: "workspace",
          meta: { source: "billing", from: ws.planId, to: planId, eventId: wake.eventId },
        },
      );
    }
    await restoreTxContext(tx, saved);
    // A live subscription under a confirmed sanctions match (a checkout that completed around the
    // decision, a cancel that has not landed yet): cancel it — the outbox job, last (RR1-M1).
    if (ws.holds.includes("sanctions") && fact.status !== "canceled") {
      await enqueueBillingCancel(
        deps.queue,
        tx,
        workspaceId,
        "sanctions",
        fact.providerSubscriptionId,
      );
    }
    // Only a workspace that is running (or suspended for billing) hears about money.
    const acting = onlyBillingHolds(ws);
    return {
      outcome: "applied",
      workspaceId,
      ...(change === undefined ? {} : { afterCommit: () => change.afterCommit() }),
      ...(grace.entered && acting && grace.graceUntil !== null
        ? { pastDue: grace.graceUntil }
        : {}),
    };
  });
  // Unknown and dropped events are claimed too (their claim committed): Stripe gets a 200 and a
  // redelivery of the same event would change nothing.
  return result;
}
