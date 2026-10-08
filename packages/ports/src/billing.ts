import type { OutboundFetch } from "./http.js";
import type { Jurisdiction } from "./residency.js";

/**
 * Collecting payment for a managed host's workspaces (EXECUTION_PLAN §15 E3.10, ADR-0058).
 * Adapters: `@fundroom/billing-stripe` (Checkout, Customer Portal, webhooks, meter events) and
 * `@fundroom/billing-manual` (the operator records the subscription by hand). The kernel service
 * `@fundroom/billing` owns `core.subscription`; an adapter never touches the database.
 *
 * Webhooks are wake-ups, not facts: the service re-reads the authoritative subscription with
 * `getSubscription` before it changes anything, and maps a workspace only from ids it stored
 * itself (a checkout it created, a subscription or customer id already on a row).
 */
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "paused";

export interface BillingCheckoutInput {
  readonly workspaceId: string;
  /** The provider customer already stored for this workspace, if any. */
  readonly customerRef: string | null;
  /** The billing contact (the owner starting checkout). */
  readonly email: string;
  readonly legalName: string;
  /** The plan's `billing_price_ref`. */
  readonly priceRef: string;
  /**
   * The plan's `billing_metered_price_refs`: extra line items billed on usage (meter events), sent
   * without a quantity. Absent or empty: none.
   */
  readonly meteredPriceRefs?: readonly string[] | undefined;
  readonly trialDays: number;
  /** Built from BASE_URL (`workspaceUrl(... primaryHost: null)`), never a custom domain. */
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
}

export interface BillingSubscriptionFact {
  readonly providerCustomerId: string;
  readonly providerSubscriptionId: string;
  /** From the subscription metadata the checkout set; verified against stored ids by the service. */
  readonly workspaceId: string;
  /** The first item's price (`""` when there is none). */
  readonly priceRef: string;
  /**
   * Every item's price, in item order (a subscription can carry a metered price next to the base
   * one; the plan is found by any of them). Absent: `[priceRef]`.
   */
  readonly priceRefs?: readonly string[] | undefined;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date | null;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  /** When the provider created the event (or read) this fact came from; older facts are ignored. */
  readonly eventCreatedAt: Date;
}

export type BillingEvent =
  | {
      readonly kind: "subscription";
      readonly eventId: string;
      readonly fact: BillingSubscriptionFact;
    }
  | {
      readonly kind: "checkout_completed";
      readonly eventId: string;
      readonly workspaceId: string;
      readonly providerCustomerId: string;
      readonly providerSubscriptionId: string | null;
      readonly eventCreatedAt: Date;
    }
  | { readonly kind: "ignored"; readonly eventId: string; readonly type: string };

export interface BillingSubProcessor {
  readonly name: string;
  readonly purpose: string;
  readonly location: string;
  readonly url: string;
  /** E3.11: machine jurisdiction for out-of-region flags (`@fundroom/compliance` normalises). */
  readonly jurisdiction?: Jurisdiction | "varies" | undefined;
}

export interface BillingPort {
  readonly driver: "manual" | "stripe";
  readonly meta: { readonly subProcessor: BillingSubProcessor | null };
  createCheckout(input: BillingCheckoutInput): Promise<{ url: string; customerRef: string }>;
  createPortalSession(input: { customerRef: string; returnUrl: string }): Promise<{ url: string }>;
  /** Verify signature + parse. Throws `BillingSignatureError` on a bad signature or timestamp. */
  parseWebhook(input: { rawBody: Uint8Array; headers: Headers; now: Date }): BillingEvent;
  /** Re-read the authoritative subscription (webhooks are wake-ups). */
  getSubscription(providerSubscriptionId: string): Promise<BillingSubscriptionFact>;
  /** Usage reporting (Stripe billing meter events). No-op for manual. */
  reportUsage(input: {
    customerRef: string;
    meter: string;
    value: number;
    timestamp: Date;
    identifier: string;
  }): Promise<void>;
  cancel(providerSubscriptionId: string): Promise<void>;
  /**
   * The meter event names the subscription's metered prices bill on (usage reporting sends only
   * those). Absent for a driver without usage billing (manual).
   */
  meteredEvents?(providerSubscriptionId: string): Promise<readonly string[]>;
}

/** What the composition root hands a billing adapter factory. */
export interface BillingAdapterDeps {
  /** A guarded outbound fetch (no redirects, bounded time and size). */
  readonly fetch: OutboundFetch;
  /** `STRIPE_API_BASE` (a test seam; refused in prod when not the default). */
  readonly apiBase: string;
  readonly secretKey: string | undefined;
  readonly webhookSecret: string | undefined;
  readonly now: () => Date;
}

/** A webhook whose signature or timestamp does not verify (answered 400, never processed). */
export class BillingSignatureError extends Error {
  override readonly name = "BillingSignatureError";
}

/** A provider call that failed (network, 4xx/5xx); `retryable` for 429/5xx/timeouts. */
export class BillingProviderError extends Error {
  override readonly name = "BillingProviderError";
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
