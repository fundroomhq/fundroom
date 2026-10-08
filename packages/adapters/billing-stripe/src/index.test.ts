import { createHmac } from "node:crypto";
import { BillingProviderError, BillingSignatureError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  createStripeBilling,
  formBody,
  parseStripeEvent,
  STRIPE_API_VERSION,
  subscriptionFact,
  verifyStripeSignature,
} from "./index.js";

const SECRET = "whsec_test_secret";
const NOW = new Date("2026-09-27T12:00:00Z");
const T = Math.floor(NOW.getTime() / 1000);
const enc = (s: string) => new TextEncoder().encode(s);
const sign = (t: number, body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: URLSearchParams | undefined;
}

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? new URLSearchParams(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function adapter(respond: (call: Call) => Response, options: { noKey?: boolean } = {}) {
  const f = fakeFetch(respond);
  const port = createStripeBilling({
    fetch: f.fetch,
    apiBase: "https://stripe.fake/",
    secretKey: options.noKey === true ? undefined : "sk_test_x",
    webhookSecret: SECRET,
    now: () => NOW,
  });
  return { port, calls: f.calls };
}

const SUB = {
  id: "sub_1",
  object: "subscription",
  customer: "cus_1",
  status: "past_due",
  metadata: { workspace_id: "ws-1" },
  cancel_at_period_end: true,
  trial_end: null,
  // basil+: no current_period_end on the subscription itself.
  current_period_end: 1,
  items: { data: [{ price: { id: "price_1" }, current_period_end: T + 3600 }] },
};

describe("verifyStripeSignature", () => {
  const body = '{"id":"evt_1"}';
  const verify = (header: string | null, now = NOW, raw = body) =>
    verifyStripeSignature({ header, rawBody: enc(raw), secret: SECRET, now });

  it("accepts a v1 signature over `t.body` within the tolerance", () => {
    expect(() => verify(`t=${T},v1=${sign(T, body)}`)).not.toThrow();
    expect(() => verify(`t=${T - 299},v1=${sign(T - 299, body)}`)).not.toThrow();
    // A future timestamp within the window is accepted too (clock skew).
    expect(() => verify(`t=${T + 299},v1=${sign(T + 299, body)}`)).not.toThrow();
  });

  it("accepts any of several v1 values (secret roll) and ignores v0", () => {
    const header = `t=${T},v1=${"0".repeat(64)},v0=${sign(T, body)},v1=${sign(T, body)}`;
    expect(() => verify(header)).not.toThrow();
  });

  it("refuses a missing header, no timestamp, no v1, a v0-only downgrade", () => {
    expect(() => verify(null)).toThrow(BillingSignatureError);
    expect(() => verify("")).toThrow(BillingSignatureError);
    expect(() => verify(`v1=${sign(T, body)}`)).toThrow(/timestamp/u);
    expect(() => verify(`t=${T}`)).toThrow(/v1/u);
    expect(() => verify(`t=${T},v0=${sign(T, body)}`)).toThrow(/v1/u);
  });

  it("refuses a wrong secret, a changed body, a changed timestamp", () => {
    expect(() => verify(`t=${T},v1=${sign(T, body, "whsec_other")}`)).toThrow(/mismatch/u);
    expect(() => verify(`t=${T},v1=${sign(T, body)}`, NOW, '{"id":"evt_2"}')).toThrow(/mismatch/u);
    expect(() => verify(`t=${T + 1},v1=${sign(T, body)}`)).toThrow(/mismatch/u);
  });

  it("refuses a timestamp older (or newer) than 300 s even when the signature matches", () => {
    expect(() => verify(`t=${T - 301},v1=${sign(T - 301, body)}`)).toThrow(/tolerance/u);
    expect(() => verify(`t=${T + 301},v1=${sign(T + 301, body)}`)).toThrow(/tolerance/u);
  });

  it("refuses a garbled signature value without throwing anything else", () => {
    expect(() => verify(`t=${T},v1=zz`)).toThrow(BillingSignatureError);
    expect(() => verify(`t=abc,v1=${sign(T, body)}`)).toThrow(BillingSignatureError);
  });
});

describe("parseStripeEvent / subscriptionFact", () => {
  it("reads current_period_end from the first item (basil+), not the subscription", () => {
    const fact = subscriptionFact(SUB, NOW);
    expect(fact).toEqual({
      providerCustomerId: "cus_1",
      providerSubscriptionId: "sub_1",
      workspaceId: "ws-1",
      priceRef: "price_1",
      priceRefs: ["price_1"],
      status: "past_due",
      currentPeriodEnd: new Date((T + 3600) * 1000),
      trialEnd: null,
      cancelAtPeriodEnd: true,
      eventCreatedAt: NOW,
    });
  });

  it("lists every item's price (a metered price may come first)", () => {
    const fact = subscriptionFact(
      {
        ...SUB,
        items: {
          data: [
            { price: { id: "price_meter" }, current_period_end: T + 60 },
            { price: "price_base", current_period_end: T + 60 },
            { price: null },
          ],
        },
      },
      NOW,
    );
    expect(fact.priceRef).toBe("price_meter");
    expect(fact.priceRefs).toEqual(["price_meter", "price_base"]);
  });

  it("maps incomplete_expired to canceled and an expanded customer to its id", () => {
    const fact = subscriptionFact(
      { ...SUB, status: "incomplete_expired", customer: { id: "cus_9" } },
      NOW,
    );
    expect(fact.status).toBe("canceled");
    expect(fact.providerCustomerId).toBe("cus_9");
  });

  it("maps subscription events with the event's created time", () => {
    const event = parseStripeEvent({
      id: "evt_1",
      type: "customer.subscription.updated",
      created: T - 10,
      data: { object: SUB },
    });
    expect(event.kind).toBe("subscription");
    if (event.kind === "subscription") {
      expect(event.fact.eventCreatedAt).toEqual(new Date((T - 10) * 1000));
    }
  });

  it("maps a subscription-mode checkout, and ignores the rest", () => {
    const session = {
      object: "checkout.session",
      mode: "subscription",
      customer: "cus_1",
      subscription: "sub_1",
      client_reference_id: "ws-1",
    };
    expect(
      parseStripeEvent({
        id: "evt_2",
        type: "checkout.session.completed",
        created: T,
        data: { object: session },
      }),
    ).toEqual({
      kind: "checkout_completed",
      eventId: "evt_2",
      workspaceId: "ws-1",
      providerCustomerId: "cus_1",
      providerSubscriptionId: "sub_1",
      eventCreatedAt: NOW,
    });
    expect(
      parseStripeEvent({
        id: "evt_3",
        type: "checkout.session.completed",
        created: T,
        data: { object: { ...session, mode: "payment" } },
      }).kind,
    ).toBe("ignored");
    expect(
      parseStripeEvent({ id: "evt_4", type: "invoice.paid", created: T, data: { object: {} } }),
    ).toEqual({ kind: "ignored", eventId: "evt_4", type: "invoice.paid" });
  });

  it("refuses an event without id, type, created or object", () => {
    expect(() => parseStripeEvent({ type: "x", created: T, data: { object: {} } })).toThrow(
      BillingSignatureError,
    );
    expect(() => parseStripeEvent({ id: "evt", type: "x", data: { object: {} } })).toThrow(
      BillingSignatureError,
    );
  });
});

describe("createStripeBilling", () => {
  it("parseWebhook verifies the raw bytes before parsing them", () => {
    const { port } = adapter(() => json(200, {}));
    const body = JSON.stringify({
      id: "evt_1",
      type: "customer.subscription.updated",
      created: T,
      data: { object: SUB },
    });
    const ok = port.parseWebhook({
      rawBody: enc(body),
      headers: new Headers({ "stripe-signature": `t=${T},v1=${sign(T, body)}` }),
      now: NOW,
    });
    expect(ok.kind).toBe("subscription");
    expect(() =>
      port.parseWebhook({
        rawBody: enc(body),
        headers: new Headers({ "stripe-signature": `t=${T},v1=${sign(T, `${body} `)}` }),
        now: NOW,
      }),
    ).toThrow(BillingSignatureError);
    // A signed non-JSON body is still refused as malformed, never thrown as a SyntaxError.
    expect(() =>
      port.parseWebhook({
        rawBody: enc("not json"),
        headers: new Headers({ "stripe-signature": `t=${T},v1=${sign(T, "not json")}` }),
        now: NOW,
      }),
    ).toThrow(BillingSignatureError);
  });

  it("creates the customer then a subscription-mode checkout, form-encoded, pinned, idempotent", async () => {
    const { port, calls } = adapter((call) =>
      call.url.endsWith("/v1/customers")
        ? json(200, { id: "cus_new" })
        : json(200, { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" }),
    );
    const out = await port.createCheckout({
      workspaceId: "ws-1",
      customerRef: null,
      email: "owner@example.test",
      legalName: "Acme Ltd",
      priceRef: "price_1",
      trialDays: 7,
      successUrl: "https://acme.portal.test/admin/billing?checkout=success",
      cancelUrl: "https://acme.portal.test/admin/billing?checkout=cancel",
      idempotencyKey: "fundroom:checkout:k1",
    });
    expect(out).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1", customerRef: "cus_new" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://stripe.fake/v1/customers",
      "POST https://stripe.fake/v1/checkout/sessions",
    ]);
    for (const call of calls) {
      expect(call.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
      expect(call.headers.get("authorization")).toBe("Bearer sk_test_x");
      expect(call.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    }
    expect(calls[0]?.headers.get("idempotency-key")).toBe("fundroom:checkout:k1:customer");
    expect(calls[1]?.headers.get("idempotency-key")).toBe("fundroom:checkout:k1:checkout");
    const session = calls[1]?.body as URLSearchParams;
    expect(Object.fromEntries(session)).toEqual({
      mode: "subscription",
      customer: "cus_new",
      client_reference_id: "ws-1",
      "line_items[0][price]": "price_1",
      "line_items[0][quantity]": "1",
      success_url: "https://acme.portal.test/admin/billing?checkout=success",
      cancel_url: "https://acme.portal.test/admin/billing?checkout=cancel",
      "metadata[workspace_id]": "ws-1",
      "subscription_data[metadata][workspace_id]": "ws-1",
      "subscription_data[trial_period_days]": "7",
    });
    // Never `ui_mode` (dahlia refuses `hosted`; the default is the hosted page).
    expect(session.has("ui_mode")).toBe(false);
  });

  it("adds the plan's metered prices as line items without a quantity", async () => {
    const { port, calls } = adapter(() => json(200, { url: "https://checkout.stripe.com/x" }));
    await port.createCheckout({
      workspaceId: "ws-1",
      customerRef: "cus_old",
      email: "o@example.test",
      legalName: "Acme",
      priceRef: "price_base",
      meteredPriceRefs: ["price_seats", "price_gb"],
      trialDays: 0,
      successUrl: "https://a.test/s",
      cancelUrl: "https://a.test/c",
      idempotencyKey: "k",
    });
    const form = calls[0]?.body as URLSearchParams;
    expect([...form.keys()].filter((k) => k.startsWith("line_items"))).toEqual([
      "line_items[0][price]",
      "line_items[0][quantity]",
      "line_items[1][price]",
      "line_items[2][price]",
    ]);
    expect(form.get("line_items[1][price]")).toBe("price_seats");
    expect(form.get("line_items[2][price]")).toBe("price_gb");
  });

  it("pages the subscription's items when the embedded list has more (plan on a later item)", async () => {
    const first = {
      ...SUB,
      items: {
        object: "list",
        has_more: true,
        data: [{ id: "si_1", price: { id: "price_meter_a" }, current_period_end: T + 3600 }],
      },
    };
    const { port, calls } = adapter((call) =>
      call.url.includes("/v1/subscription_items")
        ? json(200, {
            object: "list",
            has_more: false,
            data: [
              {
                id: "si_2",
                price: { id: "price_x", recurring: { usage_type: "metered", meter: "mtr_9" } },
              },
              { id: "si_3", price: { id: "price_base" } },
            ],
          })
        : call.url.includes("/v1/billing/meters/")
          ? json(200, { event_name: "fundroom_storage_gb" })
          : json(200, first),
    );
    const fact = await port.getSubscription("sub_1");
    expect(fact.priceRefs).toEqual(["price_meter_a", "price_x", "price_base"]);
    expect(calls[1]?.url).toBe(
      "https://stripe.fake/v1/subscription_items?subscription=sub_1&limit=100&starting_after=si_1",
    );
    expect(await port.meteredEvents?.("sub_1")).toEqual(["fundroom_storage_gb"]);
  });

  it("names the meter events the subscription's metered prices bill on (meters read once)", async () => {
    const sub = {
      ...SUB,
      items: {
        data: [
          { price: { id: "price_base", recurring: { usage_type: "licensed", meter: null } } },
          { price: { id: "price_seats", recurring: { usage_type: "metered", meter: "mtr_1" } } },
        ],
      },
    };
    const { port, calls } = adapter((call) =>
      call.url.includes("/v1/billing/meters/")
        ? json(200, { id: "mtr_1", event_name: "fundroom_staff_seats" })
        : json(200, sub),
    );
    expect(await port.meteredEvents?.("sub_1")).toEqual(["fundroom_staff_seats"]);
    expect(await port.meteredEvents?.("sub_1")).toEqual(["fundroom_staff_seats"]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://stripe.fake/v1/subscriptions/sub_1",
      "GET https://stripe.fake/v1/billing/meters/mtr_1",
      "GET https://stripe.fake/v1/subscriptions/sub_1",
    ]);
  });

  it("reuses a stored customer and sends no trial of zero days", async () => {
    const { port, calls } = adapter(() => json(200, { url: "https://checkout.stripe.com/x" }));
    await port.createCheckout({
      workspaceId: "ws-1",
      customerRef: "cus_old",
      email: "o@example.test",
      legalName: "Acme",
      priceRef: "price_1",
      trialDays: 0,
      successUrl: "https://a.test/s",
      cancelUrl: "https://a.test/c",
      idempotencyKey: "k",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body?.get("customer")).toBe("cus_old");
    expect(calls[0]?.body?.has("subscription_data[trial_period_days]")).toBe(false);
  });

  it("re-reads a subscription with GET (no idempotency key) and reports meter events", async () => {
    const { port, calls } = adapter((call) =>
      call.method === "GET" ? json(200, SUB) : json(200, { object: "billing.meter_event" }),
    );
    const fact = await port.getSubscription("sub_1");
    expect(fact.eventCreatedAt).toEqual(NOW);
    expect(calls[0]?.url).toBe("https://stripe.fake/v1/subscriptions/sub_1");
    expect(calls[0]?.headers.has("idempotency-key")).toBe(false);
    await port.reportUsage({
      customerRef: "cus_1",
      meter: "fundroom_staff_seats",
      value: 4,
      timestamp: new Date("2026-09-26T23:59:59Z"),
      identifier: "ws-1:2026-09-26:fundroom_staff_seats",
    });
    const meter = calls[1] as Call;
    expect(meter.url).toBe("https://stripe.fake/v1/billing/meter_events");
    expect(meter.headers.get("idempotency-key")).toBe("meter:ws-1:2026-09-26:fundroom_staff_seats");
    expect(Object.fromEntries(meter.body as URLSearchParams)).toEqual({
      event_name: "fundroom_staff_seats",
      "payload[value]": "4",
      "payload[stripe_customer_id]": "cus_1",
      identifier: "ws-1:2026-09-26:fundroom_staff_seats",
      timestamp: String(Math.floor(Date.parse("2026-09-26T23:59:59Z") / 1000)),
    });
  });

  it("maps errors: 429 (rate limit or lock timeout), 409, 5xx and network are retryable", async () => {
    const cases: [Response | Error, boolean][] = [
      [json(429, { error: { type: "invalid_request_error", code: "rate_limit" } }), true],
      [json(429, { error: { code: "lock_timeout" } }), true],
      [json(409, { error: { type: "idempotency_error" } }), true],
      [json(503, {}), true],
      [json(400, { error: { type: "invalid_request_error", message: "cus_secret bad" } }), false],
      [json(404, { error: { type: "invalid_request_error", code: "resource_missing" } }), false],
      [new TypeError("fetch failed"), true],
    ];
    for (const [answer, retryable] of cases) {
      const { port } = adapter(() => {
        if (answer instanceof Error) throw answer;
        return answer.clone();
      });
      const error = await port.getSubscription("sub_1").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BillingProviderError);
      expect((error as BillingProviderError).retryable).toBe(retryable);
      // Stripe's prose (which can quote parameters) and the key never reach the message.
      expect((error as Error).message).not.toMatch(/cus_secret|sk_test/u);
    }
  });

  it("refuses to call without a secret key", async () => {
    const { port, calls } = adapter(() => json(200, SUB), { noKey: true });
    await expect(port.getSubscription("sub_1")).rejects.toBeInstanceOf(BillingProviderError);
    expect(calls).toHaveLength(0);
  });

  it("formBody drops undefined values and encodes brackets", () => {
    expect(formBody({ "a[b]": "x y", c: undefined, d: 1 })).toBe("a%5Bb%5D=x+y&d=1");
  });
});
