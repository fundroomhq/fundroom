import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { api, call } from "./api.js";
import type { WebConfig } from "./config.js";
import { useWebConfig } from "./config-context.js";
import { type Bootstrap, useBootstrap } from "./queries.js";

/*
 * The tenant's billing page and the banners that hang off it (E3.10, ADR-0058). Two reads —
 * `GET /billing` (plan, subscription, public plans) and `GET /usage` (the daily rollup against
 * the plan's limits) — and two mutations that hand back a provider URL the top window goes to.
 * Both reads need `billing.read` and answer 404 unless the install runs a billing driver, which
 * is what `config.billing` says; nothing here is asked for when it is false.
 */
export type BillingOverview = FundRoomSchemas["BillingOverview"];
export type BillingSubscription = FundRoomSchemas["BillingSubscription"];
export type BillingPlan = FundRoomSchemas["BillingPlan"];
export type SubscriptionStatus = FundRoomSchemas["SubscriptionStatus"];
export type PlanLimits = FundRoomSchemas["PlanLimits"];
export type WorkspaceUsage = FundRoomSchemas["WorkspaceUsage"];
export type UsageDay = FundRoomSchemas["UsageDay"];

export const BILLING_KEY = ["billing"] as const;

export const billingQuery = queryOptions({
  queryKey: BILLING_KEY,
  queryFn: () => call(api().GET("/billing")),
});

export const usageQuery = queryOptions({
  queryKey: [...BILLING_KEY, "usage"] as const,
  queryFn: () => call(api().GET("/usage")),
});

/** Test seam: the top-level navigation to the provider's checkout or portal page. */
export const billingNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/**
 * Whether this viewer gets billing at all: the install bills (`config.billing`) and they hold
 * `billing.read`. Both, because either alone is a link to a page that 404s.
 */
export function canSeeBilling(
  config: Pick<WebConfig, "billing">,
  bootstrap: Pick<Bootstrap, "permissions"> | undefined,
): boolean {
  return config.billing === true && (bootstrap?.permissions ?? []).includes("billing.read");
}

/** `canSeeBilling` for the signed-in viewer: whether a "Go to billing" link would lead anywhere. */
export function useCanSeeBilling(): boolean {
  const config = useWebConfig();
  const bootstrap = useBootstrap();
  return canSeeBilling(config, bootstrap.data);
}

/**
 * A-3: the modules that are on but outside the workspace's plan — staff can read them and switch
 * them off, nothing else (investors are unaffected). Ids, in bootstrap order.
 */
export function readOnlyModules(bootstrap: Pick<Bootstrap, "modules"> | undefined): string[] {
  return (bootstrap?.modules ?? [])
    .filter((mod) => mod.enabled && mod.readOnly)
    .map((mod) => mod.id);
}

const DAY_MS = 86_400_000;

/**
 * Whole days left before a past-due workspace is suspended, rounded up (so "1" until the last
 * moment rather than "0" for most of the final day); `0` once the instant has passed.
 */
export function graceDaysLeft(graceUntil: string, now: Date = new Date()): number {
  const until = Date.parse(graceUntil);
  if (Number.isNaN(until)) return 0;
  return Math.max(0, Math.ceil((until - now.getTime()) / DAY_MS));
}

/** Past due or unpaid with a grace deadline: the one state the admin shell nags about. */
export function isInGrace(
  subscription: BillingSubscription | null | undefined,
): subscription is BillingSubscription & { graceUntil: string } {
  return (
    subscription !== null &&
    subscription !== undefined &&
    subscription.graceUntil !== null &&
    (subscription.status === "past_due" || subscription.status === "unpaid")
  );
}

export function subscriptionStatusLabel(status: SubscriptionStatus): string {
  switch (status) {
    case "trialing":
      return m.billing_status_trialing();
    case "active":
      return m.billing_status_active();
    case "past_due":
      return m.billing_status_past_due();
    case "unpaid":
      return m.billing_status_unpaid();
    case "canceled":
      return m.billing_status_canceled();
    case "incomplete":
      return m.billing_status_incomplete();
    case "paused":
      return m.billing_status_paused();
  }
}

export function subscriptionStatusVariant(
  status: SubscriptionStatus,
): "success" | "warning" | "destructive" | "secondary" {
  switch (status) {
    case "active":
    case "trialing":
      return "success";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "warning";
    case "canceled":
      return "destructive";
    default:
      return "secondary";
  }
}

/** The limits the usage table shows, in the order it shows them. */
export const LIMIT_KINDS = [
  "staffSeats",
  "investorSeats",
  "storageBytes",
  "customDomains",
  "emailsPerMonth",
] as const satisfies readonly (keyof PlanLimits)[];
export type LimitKind = (typeof LIMIT_KINDS)[number];

export function limitLabel(kind: LimitKind): string {
  switch (kind) {
    case "staffSeats":
      return m.billing_limit_staff_seats();
    case "investorSeats":
      return m.billing_limit_investor_seats();
    case "storageBytes":
      return m.billing_limit_storage();
    case "customDomains":
      return m.billing_limit_custom_domains();
    case "emailsPerMonth":
      return m.billing_limit_emails_per_month();
  }
}

/**
 * What the workspace uses now, per limit. The rollup keeps one row per day, so seats, storage
 * and domains are the latest row's counters; emails are a monthly limit, so they are summed over
 * the latest row's calendar month (the 30-day series always covers it back to the 1st).
 */
export function usedOf(usage: WorkspaceUsage, kind: LimitKind): number | null {
  const today = usage.today ?? usage.last30.at(-1) ?? null;
  if (today === null) return null;
  switch (kind) {
    case "staffSeats":
      return today.staffSeats;
    case "investorSeats":
      return today.investorSeats;
    case "storageBytes":
      return today.storageBytes;
    case "customDomains":
      return today.customDomains;
    case "emailsPerMonth": {
      const month = today.day.slice(0, 7);
      const days = new Map(usage.last30.map((d) => [d.day, d.emailsSent]));
      days.set(today.day, today.emailsSent);
      let sum = 0;
      for (const [day, sent] of days) if (day.startsWith(month)) sum += sent;
      return sum;
    }
  }
}
