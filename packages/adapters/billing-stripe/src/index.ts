import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type BillingAdapterDeps,
  type BillingCheckoutInput,
  type BillingEvent,
  type BillingPort,
  BillingProviderError,
  BillingSignatureError,
  type BillingSubscriptionFact,
  type SubscriptionStatus,
} from "@fundroom/ports";

/*
 * `@fundroom/billing-stripe` (E3.10, ADR-0058; owner: agent B). Stripe over its REST API with
 * the guarded fetch in `deps` (no SDK): `Stripe-Version: 2026-08-26.dahlia`, form-encoded
 * bodies, `Idempotency-Key` on every create, webhook signatures verified against every `v1=`
 * value with a 300 s tolerance. See the contract's §7b for the API-version specifics.
 *
 * Wire facts this file depends on (e310-vendors §1):
 *
 *  - v1 bodies are `application/x-www-form-urlencoded` with bracket keys; the secret key goes in
 *    `Authorization: Bearer`. Every POST carries an `Idempotency-Key` derived from the caller's key
 *    (GET and DELETE never do: Stripe refuses them there).
 *  - Since basil, `current_period_end` lives on the subscription ITEM
 *    (`items.data[0].current_period_end`), not on the subscription.
 *  - Checkout's `ui_mode` is never sent (the default is the hosted page; `hosted` fails on dahlia).
 *  - Errors: 429 is retryable whether or not it is a rate limit (without `Stripe-Rate-Limited-Reason`
 *    it is a `lock_timeout`); so are 409 (an idempotent request still executing), 5xx and network
 *    failures. Every other 4xx is not. An error's message names Stripe's `type`/`code` and the
 *    HTTP status, never Stripe's prose (it can quote parameters) and never the key.
 *  - Signatures: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…][,v0=…]`. Only `v1` counts (a
 *    downgrade to `v0` is ignored); the HMAC-SHA256 of `"<t>.<raw body>"` under the `whsec_…`
 *    string is compared in constant time against EVERY `v1` (two during a secret roll), and
 *    `|now - t|` must be within 300 s.
 *
 * Webhook events are wake-ups (the service re-reads the subscription): `checkout.session.completed`
 * and `customer.subscription.*` are mapped, everything else is `ignored`. Invoice events add
 * nothing — a failed or recovered payment moves the subscription's status, which Stripe announces
 * as `customer.subscription.updated`.
 */

/** The API version every request pins. */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";

/** Signature timestamp tolerance (seconds); Stripe's own libraries use 300. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** Subscription events that wake the service up. */
const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
]);

const STATUS_MAP: Readonly<Record<string, SubscriptionStatus>> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "unpaid",
  canceled: "canceled",
  incomplete: "incomplete",
  // The first payment never happened; Stripe will not bill it again. For us it is over.
  incomplete_expired: "canceled",
  paused: "paused",
};

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
/** An id field that may be expanded (`{ id }`) or not (`"cus_…"`). */
const idOf = (v: unknown): string | undefined => str(v) ?? (isObject(v) ? str(v["id"]) : undefined);
const unixDate = (v: unknown): Date | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null;

/** A form body with bracket keys, skipping undefined values. */
export function formBody(params: Readonly<Record<string, string | number | undefined>>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) body.append(key, String(value));
  }
  return body.toString();
}

/**
 * Verifies a `Stripe-Signature` header over the raw body. Throws `BillingSignatureError` for a
 * missing/garbled header, no `v1` signature, no match, or a timestamp outside the tolerance.
 * Exported for the unit tests.
 */
export function verifyStripeSignature(input: {
  readonly header: string | null;
  readonly rawBody: Uint8Array;
  readonly secret: string;
  readonly now: Date;
  readonly toleranceSeconds?: number | undefined;
}): void {
  if (input.header === null || input.header.length === 0 || input.header.length > 4096) {
    throw new BillingSignatureError("missing Stripe-Signature");
  }
  let timestamp: string | undefined;
  const v1: string[] = [];
  for (const part of input.header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") v1.push(value);
    // Every other scheme (v0 test signatures included) is ignored: no downgrade.
  }
  if (timestamp === undefined || !/^\d{1,12}$/u.test(timestamp)) {
    throw new BillingSignatureError("no signature timestamp");
  }
  if (v1.length === 0) throw new BillingSignatureError("no v1 signature");
  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.`, "utf8")
    .update(input.rawBody)
    .digest();
  let matched = false;
  for (const candidate of v1) {
    if (!/^[0-9a-f]{64}$/u.test(candidate)) continue;
    // Compare every candidate (no early exit), each in constant time.
    if (timingSafeEqual(expected, Buffer.from(candidate, "hex"))) matched = true;
  }
  if (!matched) throw new BillingSignatureError("signature mismatch");
  const tolerance = input.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  const age = Math.abs(Math.floor(input.now.getTime() / 1000) - Number(timestamp));
  if (age > tolerance) throw new BillingSignatureError("signature timestamp outside tolerance");
}

/** A Stripe subscription object → the port's fact. Exported for the unit tests. */
export function subscriptionFact(object: Json, eventCreatedAt: Date): BillingSubscriptionFact {
  const id = str(object["id"]);
  const customer = idOf(object["customer"]);
  const status = STATUS_MAP[String(object["status"])];
  if (id === undefined || customer === undefined || status === undefined) {
    throw new BillingProviderError("stripe: malformed subscription object", false);
  }
  const items = isObject(object["items"]) ? object["items"]["data"] : undefined;
  const first = Array.isArray(items) && isObject(items[0]) ? items[0] : undefined;
  const priceRefs = Array.isArray(items)
    ? items.flatMap((item) => {
        const price = isObject(item) ? idOf(item["price"]) : undefined;
        return price === undefined || price === "" ? [] : [price];
      })
    : [];
  const metadata = isObject(object["metadata"]) ? object["metadata"] : {};
  return {
    providerCustomerId: customer,
    providerSubscriptionId: id,
    workspaceId: str(metadata["workspace_id"]) ?? "",
    priceRef: first === undefined ? "" : (idOf(first["price"]) ?? ""),
    // A metered price may sit next to the base one, in any order: the plan is found by any.
    priceRefs,
    status,
    // basil+: the period lives on the item.
    currentPeriodEnd: first === undefined ? null : unixDate(first["current_period_end"]),
    trialEnd: unixDate(object["trial_end"]),
    cancelAtPeriodEnd: object["cancel_at_period_end"] === true,
    eventCreatedAt,
  };
}

/** A verified event body → the port's event. Exported for the unit tests. */
export function parseStripeEvent(body: Json): BillingEvent {
  const eventId = str(body["id"]);
  const type = str(body["type"]);
  const created = unixDate(body["created"]);
  const data = isObject(body["data"]) ? body["data"] : undefined;
  const object = data !== undefined && isObject(data["object"]) ? data["object"] : undefined;
  if (eventId === undefined || type === undefined || created === null || object === undefined) {
    throw new BillingSignatureError("malformed event");
  }
  if (type === "checkout.session.completed") {
    const metadata = isObject(object["metadata"]) ? object["metadata"] : {};
    const workspaceId = str(object["client_reference_id"]) ?? str(metadata["workspace_id"]);
    const customer = idOf(object["customer"]);
    if (object["mode"] !== "subscription" || workspaceId === undefined || customer === undefined) {
      return { kind: "ignored", eventId, type };
    }
    return {
      kind: "checkout_completed",
      eventId,
      workspaceId,
      providerCustomerId: customer,
      providerSubscriptionId: idOf(object["subscription"]) ?? null,
      eventCreatedAt: created,
    };
  }
  if (SUBSCRIPTION_EVENTS.has(type) && object["object"] === "subscription") {
    try {
      return { kind: "subscription", eventId, fact: subscriptionFact(object, created) };
    } catch {
      return { kind: "ignored", eventId, type };
    }
  }
  return { kind: "ignored", eventId, type };
}

/** Pages of subscription items read beyond the embedded list (Stripe caps a subscription at 20). */
const MAX_ITEM_PAGES = 5;

/** The Stripe billing adapter. */
export function createStripeBilling(deps: BillingAdapterDeps): BillingPort {
  const base = deps.apiBase.replace(/\/+$/u, "");
  /** Meter id → event name (immutable at Stripe). */
  const meterEvents = new Map<string, string>();

  function secretKey(): string {
    if (deps.secretKey === undefined)
      throw new BillingProviderError("stripe: no secret key", false);
    return deps.secretKey;
  }

  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options: { body?: string; idempotencyKey?: string } = {},
  ): Promise<Json> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${secretKey()}`,
      "stripe-version": STRIPE_API_VERSION,
      accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    if (method === "POST" && options.idempotencyKey !== undefined) {
      headers["idempotency-key"] = options.idempotencyKey.slice(0, 255);
    }
    let res: Response;
    try {
      res = await deps.fetch(`${base}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: "manual",
      });
    } catch (error) {
      // Network, timeout, a refused address: all worth another try later.
      throw new BillingProviderError(
        `stripe: ${method} ${path.split("?")[0]} failed (${error instanceof Error ? error.name : "error"})`,
        true,
        { cause: error },
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const err = isObject(json) && isObject(json["error"]) ? json["error"] : {};
      const detail = [str(err["type"]), str(err["code"])].filter(Boolean).join("/");
      const retryable = res.status === 429 || res.status === 409 || res.status >= 500;
      throw new BillingProviderError(
        `stripe: ${method} ${path.split("?")[0]} → ${res.status}${detail ? ` ${detail}` : ""}`,
        retryable,
      );
    }
    if (!isObject(json)) {
      throw new BillingProviderError(`stripe: ${method} ${path} returned no object`, true);
    }
    return json;
  }

  /**
   * A subscription with ALL its items. `items` is an embedded list object; when it says
   * `has_more` (a plan with many metered prices), the rest is paged from
   * `GET /v1/subscription_items?subscription=…` (100 per page, `starting_after`) and the object's
   * `items.data` is the complete list — the plan and the billed meters may be on any item.
   */
  async function readSubscription(id: string): Promise<Json> {
    const object = await call("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
    const items = isObject(object["items"]) ? object["items"] : undefined;
    if (items === undefined || items["has_more"] !== true || !Array.isArray(items["data"])) {
      return object;
    }
    const data: unknown[] = [...items["data"]];
    for (let page = 0; page < MAX_ITEM_PAGES; page++) {
      const last = data.at(-1);
      const after = isObject(last) ? str(last["id"]) : undefined;
      if (after === undefined) break;
      const next = await call(
        "GET",
        `/v1/subscription_items?subscription=${encodeURIComponent(id)}&limit=100&starting_after=${encodeURIComponent(after)}`,
      );
      const more = Array.isArray(next["data"]) ? next["data"] : [];
      data.push(...more);
      if (next["has_more"] !== true || more.length === 0) {
        return { ...object, items: { ...items, data, has_more: false } };
      }
    }
    throw new BillingProviderError("stripe: subscription items did not end", false);
  }

  async function createCustomer(input: BillingCheckoutInput): Promise<string> {
    const customer = await call("POST", "/v1/customers", {
      body: formBody({
        email: input.email,
        name: input.legalName,
        "metadata[workspace_id]": input.workspaceId,
      }),
      idempotencyKey: `${input.idempotencyKey}:customer`,
    });
    const id = str(customer["id"]);
    if (id === undefined) throw new BillingProviderError("stripe: customer without id", false);
    return id;
  }

  return {
    driver: "stripe",
    meta: {
      subProcessor: {
        name: "Stripe, Inc.",
        purpose: "Subscription billing and payment processing",
        location: "United States",
        url: "https://stripe.com/legal/dpa",
        jurisdiction: "us",
      },
    },

    async createCheckout(input) {
      const customerRef = input.customerRef ?? (await createCustomer(input));
      const session = await call("POST", "/v1/checkout/sessions", {
        body: formBody({
          mode: "subscription",
          customer: customerRef,
          client_reference_id: input.workspaceId,
          "line_items[0][price]": input.priceRef,
          "line_items[0][quantity]": 1,
          // Metered prices bill on meter events: a quantity is refused for them.
          ...Object.fromEntries(
            (input.meteredPriceRefs ?? []).map((ref, i) => [`line_items[${i + 1}][price]`, ref]),
          ),
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
          "metadata[workspace_id]": input.workspaceId,
          "subscription_data[metadata][workspace_id]": input.workspaceId,
          "subscription_data[trial_period_days]": input.trialDays > 0 ? input.trialDays : undefined,
        }),
        idempotencyKey: `${input.idempotencyKey}:checkout`,
      });
      const url = str(session["url"]);
      if (url === undefined) throw new BillingProviderError("stripe: checkout without url", false);
      return { url, customerRef };
    },

    async createPortalSession(input) {
      const session = await call("POST", "/v1/billing_portal/sessions", {
        body: formBody({ customer: input.customerRef, return_url: input.returnUrl }),
        idempotencyKey: `portal:${randomUUID()}`,
      });
      const url = str(session["url"]);
      if (url === undefined) throw new BillingProviderError("stripe: portal without url", false);
      return { url };
    },

    parseWebhook(input) {
      if (deps.webhookSecret === undefined) {
        throw new BillingSignatureError("no webhook secret configured");
      }
      verifyStripeSignature({
        header: input.headers.get("stripe-signature"),
        rawBody: input.rawBody,
        secret: deps.webhookSecret,
        now: input.now,
      });
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.rawBody));
      } catch {
        throw new BillingSignatureError("malformed event");
      }
      if (!isObject(body)) throw new BillingSignatureError("malformed event");
      return parseStripeEvent(body);
    },

    async getSubscription(providerSubscriptionId) {
      const object = await readSubscription(providerSubscriptionId);
      // A re-read is as fresh as the moment we made it.
      return subscriptionFact(object, deps.now());
    },

    async reportUsage(input) {
      await call("POST", "/v1/billing/meter_events", {
        body: formBody({
          event_name: input.meter,
          "payload[value]": input.value,
          "payload[stripe_customer_id]": input.customerRef,
          identifier: input.identifier.slice(0, 100),
          timestamp: Math.floor(input.timestamp.getTime() / 1000),
        }),
        idempotencyKey: `meter:${input.identifier}`,
      });
    },

    async cancel(providerSubscriptionId) {
      await call("DELETE", `/v1/subscriptions/${encodeURIComponent(providerSubscriptionId)}`);
    },

    /*
     * The subscription's items carry their price objects; a metered one names its meter
     * (`recurring.meter`, an id). The meter's `event_name` is what meter events are sent under —
     * read once per meter id and kept (a meter's event name cannot change).
     */
    async meteredEvents(providerSubscriptionId) {
      const object = await readSubscription(providerSubscriptionId);
      const items = isObject(object["items"]) ? object["items"]["data"] : undefined;
      const meters = new Set<string>();
      for (const item of Array.isArray(items) ? items : []) {
        const price = isObject(item) && isObject(item["price"]) ? item["price"] : undefined;
        const recurring =
          price !== undefined && isObject(price["recurring"]) ? price["recurring"] : undefined;
        const meter = recurring === undefined ? undefined : str(recurring["meter"]);
        if (recurring?.["usage_type"] === "metered" && meter !== undefined) meters.add(meter);
      }
      const events: string[] = [];
      for (const meter of meters) {
        let name = meterEvents.get(meter);
        if (name === undefined) {
          const found = await call("GET", `/v1/billing/meters/${encodeURIComponent(meter)}`);
          name = str(found["event_name"]);
          if (name === undefined) continue;
          meterEvents.set(meter, name);
        }
        events.push(name);
      }
      return events;
    },
  };
}
