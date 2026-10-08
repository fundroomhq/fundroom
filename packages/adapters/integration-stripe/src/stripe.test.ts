import { readFileSync } from "node:fs";
import type { IntegrationAuth } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  createStripeAdapter,
  currencyExponent,
  STRIPE_API_VERSION,
  stripeMeta,
  stripeMetrics,
} from "./index.js";
import { runAdapterContract } from "./test/contract.js";
import { fakeFetch, type Handler, json, type RecordedRequest, router } from "./test/fake-fetch.js";

type Json = Record<string, unknown>;
const fixture = (name: string): Json =>
  JSON.parse(
    readFileSync(new URL(`./test/fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Json;

const NOW = new Date("2026-04-15T12:00:00Z");
const auth: IntegrationAuth = {
  accessToken: "rk_test_51Acme",
  externalAccountId: "acct_1NqRoboticsAcme",
  environment: "sandbox",
};
const FEB_APR = { fromMonth: "2026-02", toMonth: "2026-04" };
const ALL = ["gross_volume", "net_volume", "new_customers", "mrr", "active_subscriptions"] as const;
const unix = (iso: string) => String(Date.parse(iso) / 1000);

type Item = Json & { id: string; created: number };
const items = (...names: string[]): Item[] => names.flatMap((n) => fixture(n)["data"] as Item[]);
const ALL_TXNS = items("balance-transactions-1", "balance-transactions-2");
const ALL_CUSTOMERS = items("customers");

/**
 * Stripe list semantics over recorded items: `created[gte]`/`created[lt]` filter, newest first,
 * `starting_after` cursor, `has_more`. `pageSize` defaults small so paging is always exercised.
 */
function stripeList(all: readonly Item[], req: RecordedRequest, pageSize = 2): Response {
  const gte = Number(req.url.searchParams.get("created[gte]") ?? "-Infinity");
  const lt = Number(req.url.searchParams.get("created[lt]") ?? "Infinity");
  const matching = all
    .filter((i) => i.created >= gte && i.created < lt)
    .sort((a, b) => b.created - a.created);
  const after = req.url.searchParams.get("starting_after");
  const start = after === null ? 0 : matching.findIndex((i) => i.id === after) + 1;
  const data = matching.slice(start, start + pageSize);
  return json({
    object: "list",
    data,
    has_more: start + pageSize < matching.length,
    url: req.url.pathname,
  });
}

/** Stripe customer search with `expand[]=total_count`, over the recorded customers. */
function customerSearch(req: RecordedRequest): Response {
  const query = req.url.searchParams.get("query") ?? "";
  const match = /^created>=(\d+) AND created<(\d+)$/u.exec(query);
  if (match === null) return json({ error: { type: "invalid_request_error" } }, 400);
  const total = ALL_CUSTOMERS.filter(
    (c) => c.created >= Number(match[1]) && c.created < Number(match[2]),
  ).length;
  return json({
    object: "search_result",
    data: [],
    has_more: total > 1,
    next_page: null,
    total_count: total,
    url: "/v1/customers/search",
  });
}

const happy: Handler = router({
  "GET /v1/account": () => json(fixture("account")),
  "GET /v1/balance": () => json(fixture("balance")),
  "GET /v1/balance_transactions": (req) => stripeList(ALL_TXNS, req),
  "GET /v1/customers": (req) => stripeList(ALL_CUSTOMERS, req),
  "GET /v1/customers/search": customerSearch,
  "GET /v1/subscriptions": () => json(fixture("subscriptions")),
});

function adapter(handler: Handler, now = NOW) {
  const fake = fakeFetch(handler);
  return { fake, adapter: createStripeAdapter({ fetch: fake.fetch, now: () => now }) };
}

/** A router that answers `overrides` first and the recorded fixtures otherwise. */
const withRoutes = (overrides: Record<string, Handler>): Handler => {
  const base = happy;
  return (req) => {
    const handler = overrides[`${req.method} ${req.url.pathname}`];
    return handler === undefined ? base(req) : handler(req);
  };
};

runAdapterContract({
  provider: "stripe",
  metrics: [
    {
      key: "gross_volume",
      label: "Gross volume",
      kind: "flow",
      unit: "currency",
      historical: true,
    },
    {
      key: "net_volume",
      label: "Net volume (after refunds and fees)",
      kind: "flow",
      unit: "currency",
      historical: true,
    },
    { key: "new_customers", label: "New customers", kind: "flow", unit: "count", historical: true },
    {
      key: "mrr",
      label: "MRR (monthly recurring revenue)",
      kind: "stock",
      unit: "currency",
      historical: false,
    },
    {
      key: "active_subscriptions",
      label: "Active subscriptions",
      kind: "stock",
      unit: "count",
      historical: false,
    },
  ],
  create: (fetch, now) => createStripeAdapter({ fetch, now: () => now }),
  auth,
  now: NOW,
  kpiRequest: { metrics: [...ALL], ...FEB_APR },
  hosts: ["api.stripe.com"],
  happy,
});

describe("stripeMeta", () => {
  it("is a secret-auth provider asking for one restricted key", () => {
    expect(stripeMeta.auth).toBe("secret");
    expect(stripeMeta.credentialFields).toEqual([
      expect.objectContaining({ key: "restrictedKey", kind: "secret", required: true }),
    ]);
    expect(stripeMetrics.map((m) => [m.key, m.historical])).toEqual([
      ["gross_volume", true],
      ["net_volume", true],
      ["new_customers", true],
      ["mrr", false],
      ["active_subscriptions", false],
    ]);
  });
});

describe("currencyExponent", () => {
  it.each([
    ["usd", 2],
    ["EUR", 2],
    ["jpy", 0],
    ["KRW", 0],
    ["xof", 0],
    ["kwd", 3],
    ["bhd", 3],
    // Stripe's special cases: two-decimal in the API although the currency has no minor unit in use.
    ["isk", 2],
    ["ugx", 2],
    ["huf", 2],
    ["twd", 2],
  ])("%s → %i", (code, exponent) => {
    expect(currencyExponent(code)).toBe(exponent);
  });
});

describe("verify", () => {
  it("labels the account from the dashboard name, pins Stripe-Version, marks test mode", async () => {
    const { fake, adapter: stripe } = adapter(happy);
    expect(await stripe.verify(auth)).toEqual({
      ok: true,
      value: {
        accountLabel: "Acme Robotics Inc. (test mode)",
        externalAccountId: "acct_1NqRoboticsAcme",
      },
    });
    const [call] = fake.calls;
    expect(call?.url.href).toBe("https://api.stripe.com/v1/account");
    expect(call?.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(call?.headers.get("authorization")).toBe("Bearer rk_test_51Acme");
  });

  it("falls back to the business name, then the id", async () => {
    const noDashboard = { ...fixture("account"), settings: {} };
    const { adapter: a } = adapter(() => json(noDashboard));
    expect(await a.verify({ ...auth, environment: "production" })).toMatchObject({
      value: { accountLabel: "Acme Robotics" },
    });
    const { adapter: b } = adapter(() => json({ id: "acct_123", object: "account" }));
    expect(await b.verify({ ...auth, environment: "production" })).toMatchObject({
      value: { accountLabel: "acct_123" },
    });
  });

  it("falls back to the balance when the key may not read the account", async () => {
    const { fake, adapter: stripe } = adapter(
      withRoutes({
        "GET /v1/account": () => json({ error: { type: "invalid_request_error" } }, 403),
      }),
    );
    expect(await stripe.verify({ ...auth, environment: "production" })).toEqual({
      ok: true,
      value: { accountLabel: "Stripe account", externalAccountId: null },
    });
    expect(fake.calls.map((c) => c.url.pathname)).toEqual(["/v1/account", "/v1/balance"]);
  });

  it("refuses a full secret key without calling Stripe", async () => {
    const { fake, adapter: stripe } = adapter(happy);
    expect(await stripe.verify({ ...auth, accessToken: "sk_live_abc" })).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    expect(
      await stripe.kpi?.read(
        { ...auth, accessToken: "sk_test_abc" },
        { metrics: ["mrr"], ...FEB_APR },
      ),
    ).toMatchObject({ ok: false, reason: "forbidden" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("kpi.read", () => {
  it("totals the recorded balance transactions, customers and subscriptions", async () => {
    const { fake, adapter: stripe } = adapter(happy);
    const result = await stripe.kpi?.read(auth, { metrics: [...ALL], ...FEB_APR });
    expect(result).toEqual({
      ok: true,
      value: {
        currency: "USD",
        series: [
          {
            metric: "gross_volume",
            points: [
              { month: "2026-02", value: "200.00" },
              { month: "2026-03", value: "149.99" },
              { month: "2026-04", value: "0.00" },
            ],
          },
          {
            metric: "net_volume",
            points: [
              { month: "2026-02", value: "183.90" },
              { month: "2026-03", value: "120.04" },
              { month: "2026-04", value: "0.00" },
            ],
          },
          {
            metric: "new_customers",
            points: [
              { month: "2026-02", value: "1" },
              { month: "2026-03", value: "2" },
              { month: "2026-04", value: "1" },
            ],
          },
          // 3×49 + 1200/12 + 300/3 + 10×52/12 + 0.005×7 = 390.368… → 390.37 (metered, tiered and EUR items skipped)
          { metric: "mrr", points: [{ month: "2026-04", value: "390.37" }] },
          { metric: "active_subscriptions", points: [{ month: "2026-04", value: "5" }] },
        ],
      },
    });
    // One month at a time: Feb (4 txns → 2 pages), Mar (4 → 2 pages), Apr (none → 1 page).
    const bt = fake.calls.filter((c) => c.url.pathname === "/v1/balance_transactions");
    expect(
      bt.map((c) => [
        c.url.searchParams.get("created[gte]"),
        c.url.searchParams.get("created[lt]"),
      ]),
    ).toEqual([
      [unix("2026-02-01T00:00:00Z"), unix("2026-03-01T00:00:00Z")],
      [unix("2026-02-01T00:00:00Z"), unix("2026-03-01T00:00:00Z")],
      [unix("2026-03-01T00:00:00Z"), unix("2026-04-01T00:00:00Z")],
      [unix("2026-03-01T00:00:00Z"), unix("2026-04-01T00:00:00Z")],
      [unix("2026-04-01T00:00:00Z"), unix("2026-05-01T00:00:00Z")],
    ]);
    expect(bt[0]?.url.searchParams.get("limit")).toBe("100");
    expect(bt[1]?.url.searchParams.get("starting_after")).toBe("txn_3Pq0006AcmeTxn");
    // new_customers: one search call per month, no listing.
    const searches = fake.calls.filter((c) => c.url.pathname === "/v1/customers/search");
    expect(searches.map((c) => c.url.searchParams.get("query"))).toEqual([
      `created>=${unix("2026-02-01T00:00:00Z")} AND created<${unix("2026-03-01T00:00:00Z")}`,
      `created>=${unix("2026-03-01T00:00:00Z")} AND created<${unix("2026-04-01T00:00:00Z")}`,
      `created>=${unix("2026-04-01T00:00:00Z")} AND created<${unix("2026-05-01T00:00:00Z")}`,
    ]);
    expect(searches[0]?.url.searchParams.getAll("expand[]")).toEqual(["total_count"]);
    expect(searches[0]?.url.searchParams.get("limit")).toBe("1");
    expect(fake.calls.some((c) => c.url.pathname === "/v1/customers")).toBe(false);
    expect(
      fake.calls
        .find((c) => c.url.pathname === "/v1/subscriptions")
        ?.url.searchParams.get("status"),
    ).toBe("active");
    for (const call of fake.calls)
      expect(call.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
  });

  it("writes zero-decimal currencies without a fraction", async () => {
    const txns = {
      object: "list",
      has_more: false,
      data: [
        {
          id: "txn_1",
          created: Number(unix("2026-03-03T00:00:00Z")),
          type: "charge",
          amount: 5000,
          net: 4820,
          currency: "jpy",
        },
        {
          id: "txn_2",
          created: Number(unix("2026-03-04T00:00:00Z")),
          type: "refund",
          amount: -7000,
          net: -7000,
          currency: "jpy",
        },
      ],
    };
    const { adapter: stripe } = adapter(
      withRoutes({
        "GET /v1/account": () => json({ ...fixture("account"), default_currency: "jpy" }),
        "GET /v1/balance_transactions": () => json(txns),
      }),
    );
    const result = await stripe.kpi?.read(auth, {
      metrics: ["gross_volume", "net_volume"],
      fromMonth: "2026-03",
      toMonth: "2026-03",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        currency: "JPY",
        series: [
          { metric: "gross_volume", points: [{ month: "2026-03", value: "5000" }] },
          { metric: "net_volume", points: [{ month: "2026-03", value: "-2180" }] },
        ],
      },
    });
  });

  it("writes three-decimal currencies with three places", async () => {
    const txns = {
      object: "list",
      has_more: false,
      data: [
        {
          id: "txn_1",
          created: Number(unix("2026-03-03T00:00:00Z")),
          type: "charge",
          amount: 12345,
          net: 12005,
          currency: "kwd",
        },
      ],
    };
    const { adapter: stripe } = adapter(
      withRoutes({
        "GET /v1/account": () => json({ ...fixture("account"), default_currency: "kwd" }),
        "GET /v1/balance_transactions": () => json(txns),
      }),
    );
    const result = await stripe.kpi?.read(auth, {
      metrics: ["gross_volume"],
      fromMonth: "2026-03",
      toMonth: "2026-03",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { series: [{ points: [{ value: "12.345" }] }] },
    });
  });

  it("answers a negative month for refunds only", async () => {
    const txns = {
      object: "list",
      has_more: false,
      data: [
        {
          id: "txn_1",
          created: Number(unix("2026-03-03T00:00:00Z")),
          type: "refund",
          amount: -2500,
          net: -2500,
          currency: "usd",
        },
      ],
    };
    const { adapter: stripe } = adapter(
      withRoutes({ "GET /v1/balance_transactions": () => json(txns) }),
    );
    const result = await stripe.kpi?.read(auth, {
      metrics: ["gross_volume", "net_volume"],
      fromMonth: "2026-03",
      toMonth: "2026-03",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { series: [{ points: [{ value: "0.00" }] }, { points: [{ value: "-25.00" }] }] },
    });
  });

  it("has no MRR point and does not list subscriptions when the range ends before this month", async () => {
    const { fake, adapter: stripe } = adapter(happy);
    const result = await stripe.kpi?.read(auth, {
      metrics: ["mrr", "active_subscriptions"],
      fromMonth: "2026-01",
      toMonth: "2026-03",
    });
    expect(result).toEqual({
      ok: true,
      value: {
        currency: null,
        series: [
          { metric: "mrr", points: [] },
          { metric: "active_subscriptions", points: [] },
        ],
      },
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("reads counts without asking for the account currency", async () => {
    const { fake, adapter: stripe } = adapter(happy);
    const result = await stripe.kpi?.read(auth, {
      metrics: ["new_customers", "active_subscriptions"],
      ...FEB_APR,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { currency: null, series: [{}, { points: [{ month: "2026-04", value: "5" }] }] },
    });
    expect(fake.calls.map((c) => c.url.pathname)).toEqual([
      "/v1/customers/search",
      "/v1/customers/search",
      "/v1/customers/search",
      "/v1/subscriptions",
    ]);
  });

  it("pages a subscription's items when Stripe truncates them", async () => {
    const sub = {
      id: "sub_Big",
      status: "active",
      items: { object: "list", data: [], has_more: true },
    };
    const price = {
      currency: "usd",
      unit_amount: 1000,
      unit_amount_decimal: "1000",
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    };
    let itemPages = 0;
    const { fake, adapter: stripe } = adapter(
      withRoutes({
        "GET /v1/subscriptions": () => json({ object: "list", data: [sub], has_more: false }),
        "GET /v1/subscription_items": (req) => {
          itemPages += 1;
          const first = !req.url.searchParams.has("starting_after");
          return json({
            object: "list",
            data: [{ id: first ? "si_a" : "si_b", price, quantity: 2 }],
            has_more: first,
          });
        },
      }),
    );
    const result = await stripe.kpi?.read(auth, {
      metrics: ["mrr"],
      fromMonth: "2026-04",
      toMonth: "2026-04",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { series: [{ points: [{ value: "40.00" }] }] },
    });
    expect(itemPages).toBe(2);
    expect(
      fake.calls
        .find((c) => c.url.pathname === "/v1/subscription_items")
        ?.url.searchParams.get("subscription"),
    ).toBe("sub_Big");
  });

  /** `pagesPerMonth` full pages of synthetic transactions for every month asked. */
  const busy =
    (pagesPerMonth: (month: string) => number): Handler =>
    (req) => {
      const gte = Number(req.url.searchParams.get("created[gte]"));
      const month = new Date(gte * 1000).toISOString().slice(0, 7);
      const page = req.url.searchParams.has("starting_after")
        ? Number(req.url.searchParams.get("starting_after")?.split("_")[2]) + 1
        : 1;
      const data = Array.from({ length: 100 }, (_, i) => ({
        id: `txn_${month}_${page}_${i}`,
        created: gte + 60,
        type: "charge",
        amount: 100,
        net: 97,
        currency: "usd",
      }));
      // The cursor carries the page number in its third segment.
      const last = data[99];
      if (last !== undefined) last.id = `txn_${month}_${page}`;
      return json({ object: "list", data, has_more: page < pagesPerMonth(month) });
    };

  it("gives every month its own page budget (a 24-month backfill of 2,400 txns/month works)", async () => {
    const { fake, adapter: stripe } = adapter(
      withRoutes({ "GET /v1/balance_transactions": busy(() => 24) }),
    );
    const result = await stripe.kpi?.read(auth, {
      metrics: ["gross_volume"],
      fromMonth: "2024-05",
      toMonth: "2026-04",
    });
    expect(result?.ok).toBe(true);
    if (!result?.ok) return;
    expect(result.value.series[0]?.points).toHaveLength(24);
    expect(result.value.series[0]?.points[0]).toEqual({ month: "2024-05", value: "2400.00" });
    expect(fake.calls).toHaveLength(1 + 24 * 24);
  });

  it("answers too_large naming the month that is over its 5,000-item budget", async () => {
    const { fake, adapter: stripe } = adapter(
      withRoutes({ "GET /v1/balance_transactions": busy((m) => (m === "2026-03" ? 60 : 3)) }),
    );
    const result = await stripe.kpi?.read(auth, { metrics: ["net_volume"], ...FEB_APR });
    expect(result).toEqual({
      ok: false,
      reason: "too_large",
      detail: "more than 5000 balance transactions in 2026-03 (50 pages)",
    });
    // account + Feb (3 pages) + Mar (50 pages, the 51st refused before sending)
    expect(fake.calls).toHaveLength(1 + 3 + 50);
  });

  it("stops one read at 600 pages overall", async () => {
    const { fake, adapter: stripe } = adapter(
      withRoutes({ "GET /v1/balance_transactions": busy(() => 26) }),
    );
    const result = await stripe.kpi?.read(auth, {
      metrics: ["gross_volume"],
      fromMonth: "2024-05",
      toMonth: "2026-04",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "too_large",
      detail: "this read needs more than 600 Stripe pages",
    });
    expect(fake.calls).toHaveLength(600);
  });

  const searchCalls = (calls: RecordedRequest[]) =>
    calls.filter((c) => c.url.pathname === "/v1/customers/search").length;
  const listCalls = (calls: RecordedRequest[]) =>
    calls.filter((c) => c.url.pathname === "/v1/customers").length;

  it.each([[403], [400]])(
    "falls back to listing only on a definitive search refusal (HTTP %i), and stops trying search",
    async (status) => {
      const { fake, adapter: stripe } = adapter(
        withRoutes({
          "GET /v1/customers/search": () =>
            json({ error: { type: "invalid_request_error" } }, status),
        }),
      );
      const result = await stripe.kpi?.read(auth, { metrics: ["new_customers"], ...FEB_APR });
      expect(result).toMatchObject({
        ok: true,
        value: { series: [{ points: [{ value: "1" }, { value: "2" }, { value: "1" }] }] },
      });
      expect(searchCalls(fake.calls)).toBe(1);
      expect(listCalls(fake.calls)).toBe(3);
    },
  );

  it.each([
    ["HTTP 404", () => json({}, 404)],
    ["HTTP 500", () => json({}, 500)],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["no total_count", () => json({ object: "search_result", data: [], has_more: false })],
  ])("retries search once after %s, then uses the answer", async (_name, first) => {
    let n = 0;
    const { fake, adapter: stripe } = adapter(
      withRoutes({
        "GET /v1/customers/search": (req) => (++n === 1 ? first() : customerSearch(req)),
      }),
    );
    const result = await stripe.kpi?.read(auth, { metrics: ["new_customers"], ...FEB_APR });
    expect(result).toMatchObject({
      ok: true,
      value: { series: [{ points: [{ value: "1" }, { value: "2" }, { value: "1" }] }] },
    });
    expect(searchCalls(fake.calls)).toBe(4);
    expect(listCalls(fake.calls)).toBe(0);
  });

  it.each([
    ["HTTP 503", () => json({}, 503)],
    ["no total_count", () => json({ object: "search_result", data: [], has_more: false })],
  ])("answers unavailable (never lists) when search fails twice with %s", async (_name, search) => {
    const { fake, adapter: stripe } = adapter(withRoutes({ "GET /v1/customers/search": search }));
    const result = await stripe.kpi?.read(auth, { metrics: ["new_customers"], ...FEB_APR });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(result?.ok === false && result.detail).toContain("2026-02");
    expect(searchCalls(fake.calls)).toBe(2);
    expect(listCalls(fake.calls)).toBe(0);
  });

  it("answers too_large naming the month at Stripe's 10,000 search cap, without listing or retrying", async () => {
    const { fake, adapter: stripe } = adapter(
      withRoutes({
        "GET /v1/customers/search": () =>
          json({ object: "search_result", data: [], has_more: true, total_count: 10_000 }),
      }),
    );
    const result = await stripe.kpi?.read(auth, { metrics: ["new_customers"], ...FEB_APR });
    expect(result).toEqual({
      ok: false,
      reason: "too_large",
      detail: "10000 or more customers created in 2026-02 (Stripe search counts up to 10,000)",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("stops paging when the signal aborts between pages", async () => {
    const controller = new AbortController();
    let pages = 0;
    const base = busy(() => 10);
    const { fake, adapter: stripe } = adapter(
      withRoutes({
        "GET /v1/balance_transactions": async (req) => {
          pages += 1;
          if (pages === 3) controller.abort();
          return base(req);
        },
      }),
    );
    const result = await stripe.kpi?.read(auth, {
      metrics: ["gross_volume"],
      ...FEB_APR,
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, reason: "unavailable", detail: "aborted" });
    expect(fake.calls).toHaveLength(1 + 3);
  });

  it("does not retry or list on a revoked key or a rate limit on search", async () => {
    for (const [status, reason] of [
      [401, "unauthorized"],
      [429, "rate_limited"],
    ] as const) {
      const { fake, adapter: stripe } = adapter(
        withRoutes({ "GET /v1/customers/search": () => json({}, status) }),
      );
      expect(
        await stripe.kpi?.read(auth, { metrics: ["new_customers"], ...FEB_APR }),
      ).toMatchObject({ ok: false, reason });
      expect(fake.calls).toHaveLength(1);
    }
  });

  it("answers too_large for a month with more than 5,000 new customers when the key may not search", async () => {
    let n = 0;
    const { fake, adapter: stripe } = adapter(
      withRoutes({
        "GET /v1/customers/search": () => json({}, 403),
        "GET /v1/customers": () => {
          n += 1;
          return json({
            object: "list",
            has_more: true,
            data: [{ id: `cus_${n}`, created: Number(unix("2026-02-03T00:00:00Z")) }],
          });
        },
      }),
    );
    const result = await stripe.kpi?.read(auth, { metrics: ["new_customers"], ...FEB_APR });
    expect(result).toMatchObject({
      ok: false,
      reason: "too_large",
      detail: "more than 5000 customers created in 2026-02 (50 pages)",
    });
    expect(fake.calls).toHaveLength(1 + 50);
  });

  it("answers malformed when the account names no currency", async () => {
    const { adapter: stripe } = adapter(
      withRoutes({
        "GET /v1/account": () => json({ ...fixture("account"), default_currency: null }),
      }),
    );
    expect(await stripe.kpi?.read(auth, { metrics: ["gross_volume"], ...FEB_APR })).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  const btList =
    (item: Json, hasMore = false) =>
    () =>
      json({ object: "list", has_more: hasMore, data: [item] });
  const goodBt = {
    id: "txn_1",
    created: Number(unix("2026-03-03T00:00:00Z")),
    type: "charge",
    amount: 100,
    net: 90,
    currency: "usd",
  };
  const subList = (item: Json) => () =>
    json({
      object: "list",
      has_more: false,
      data: [
        { id: "sub_1", status: "active", items: { object: "list", has_more: false, data: [item] } },
      ],
    });
  const goodPrice = {
    currency: "usd",
    unit_amount: 1000,
    recurring: { interval: "month", interval_count: 1 },
  };

  it.each([
    [
      "a list without data",
      { "GET /v1/balance_transactions": () => json({ object: "list", has_more: false }) },
    ],
    [
      "a list without has_more",
      { "GET /v1/balance_transactions": () => json({ object: "list", data: [] }) },
    ],
    [
      "a transaction without net",
      { "GET /v1/balance_transactions": btList({ ...goodBt, net: undefined }) },
    ],
    [
      "a fractional amount",
      { "GET /v1/balance_transactions": btList({ ...goodBt, amount: 10.5 }) },
    ],
    [
      "an amount as a string",
      { "GET /v1/balance_transactions": btList({ ...goodBt, amount: "100" }) },
    ],
    [
      "more pages but no cursor",
      { "GET /v1/balance_transactions": btList({ ...goodBt, id: undefined }, true) },
    ],
    [
      "a customer without created",
      {
        "GET /v1/customers/search": () => json({}, 403),
        "GET /v1/customers": () =>
          json({ object: "list", has_more: false, data: [{ id: "cus_1" }] }),
      },
    ],
    ["an item without price", { "GET /v1/subscriptions": subList({ id: "si_1", quantity: 1 }) }],
    [
      "an unknown interval",
      {
        "GET /v1/subscriptions": subList({
          id: "si_1",
          price: { ...goodPrice, recurring: { interval: "fortnight" } },
        }),
      },
    ],
    [
      "a negative quantity",
      { "GET /v1/subscriptions": subList({ id: "si_1", quantity: -1, price: goodPrice }) },
    ],
    [
      "a zero interval_count",
      {
        "GET /v1/subscriptions": subList({
          id: "si_1",
          price: { ...goodPrice, recurring: { interval: "month", interval_count: 0 } },
        }),
      },
    ],
    [
      "an exponent unit_amount_decimal",
      {
        "GET /v1/subscriptions": subList({
          id: "si_1",
          price: { ...goodPrice, unit_amount_decimal: "1e3" },
        }),
      },
    ],
    [
      "a subscription without items",
      {
        "GET /v1/subscriptions": () =>
          json({ object: "list", has_more: false, data: [{ id: "sub_1", status: "active" }] }),
      },
    ],
  ] as const)("answers malformed for %s", async (_name, overrides) => {
    const { adapter: stripe } = adapter(withRoutes(overrides as Record<string, Handler>));
    const result = await stripe.kpi?.read(auth, { metrics: [...ALL], ...FEB_APR });
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("skips balance transactions in other currencies (and logs a count, not the data)", async () => {
    const events: [string, Record<string, unknown>][] = [];
    const fake = fakeFetch(happy);
    const stripe = createStripeAdapter({
      fetch: fake.fetch,
      now: () => NOW,
      log: (e, f) => events.push([e, f]),
    });
    const result = await stripe.kpi?.read(auth, {
      metrics: ["gross_volume"],
      fromMonth: "2026-02",
      toMonth: "2026-02",
    });
    expect(result).toMatchObject({
      ok: true,
      value: { series: [{ points: [{ value: "200.00" }] }] },
    });
    expect(events).toContainEqual([
      "integration.stripe.other_currency_skipped",
      { count: 1, level: "warn" },
    ]);
  });
});
