import type {
  IntegrationAdapter,
  IntegrationAdapterDeps,
  IntegrationAdapterFactory,
  IntegrationAuth,
  IntegrationProviderMeta,
  IntegrationResult,
  KpiReadRequest,
  KpiReadValue,
  KpiSourceMetric,
} from "@fundroom/ports";
import { type Dec, formatDec, fromMinorUnits, parseDecimal } from "./internal/decimal.js";
import {
  abortedFailure,
  type Failure,
  fail,
  isRecord,
  MAX_PAGES,
  send,
  statusFailure,
  withSignal,
} from "./internal/http.js";
import {
  addMonths,
  compareMonths,
  currentMonth,
  formatMonth,
  monthOfUnix,
  monthStartUnix,
  requestedMonths,
  type Ym,
} from "./internal/months.js";

/*
 * Stripe API over a pasted **restricted** key (`rk_live_…` / `rk_test_…`), read-only (E3.6,
 * ADR-0054). What is read: the account (name, default currency), balance transactions, customers
 * (creation dates only) and active subscriptions (their items' prices and quantities).
 *
 * Money: Stripe amounts are integers in the currency's minor unit. They are summed as bigints and
 * turned into a major-unit decimal string by the currency's exponent (zero-decimal currencies such
 * as JPY have exponent 0, BHD/JOD/KWD/OMR/TND have 3; ISK and UGX are two-decimal *in the API*
 * for backwards compatibility — Stripe's currencies page). No float ever touches a value.
 *
 * Metrics (months are UTC calendar months):
 * - `gross_volume` = Σ `amount` of balance transactions of type `charge`/`payment` (the settled
 *   gross of succeeded charges — a balance transaction exists only for a succeeded charge);
 * - `net_volume` = Σ `net` (after Stripe fees) of `charge`, `payment`, `refund`, `payment_refund`,
 *   `payment_failure_refund` balance transactions;
 *   both count only balance transactions in the account's default currency (Stripe already converts
 *   charges into the settlement currency; an account settling in several currencies has the others
 *   skipped — see README);
 * - `new_customers` = customers created in the month (deleted customers are not listed by Stripe);
 * - `mrr` / `active_subscriptions` (current month only, `historical: false`): subscriptions with
 *   `status=active`; each licensed item's price × quantity normalised to a month
 *   (year ÷ 12, week × 52 ÷ 12, day × 365 ÷ 12, each ÷ `interval_count`). Discounts, coupons, tax,
 *   metered and tiered prices, and prices in another currency are NOT included (documented).
 */

const API_BASE = "https://api.stripe.com";
/** Pinned so a dashboard API upgrade can never change the shapes parsed here. */
export const STRIPE_API_VERSION = "2025-03-31.basil";
const PAGE_SIZE = "100";

/** Stripe's zero-decimal currencies (docs.stripe.com/currencies, checked 2026-09-26). */
const ZERO_DECIMAL = new Set([
  "bif",
  "clp",
  "djf",
  "gnf",
  "jpy",
  "kmf",
  "krw",
  "mga",
  "pyg",
  "rwf",
  "vnd",
  "vuv",
  "xaf",
  "xof",
  "xpf",
]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

export function currencyExponent(currency: string): number {
  const code = currency.toLowerCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

export const stripeMetrics: readonly KpiSourceMetric[] = [
  { key: "gross_volume", label: "Gross volume", kind: "flow", unit: "currency", historical: true },
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
];

export const stripeMeta: IntegrationProviderMeta = {
  provider: "stripe",
  displayName: "Stripe",
  capabilities: ["kpi"],
  auth: "secret",
  credentialFields: [
    {
      key: "restrictedKey",
      label: "Restricted API key",
      kind: "secret",
      required: true,
      help: "Create a restricted key (starts rk_live_ or rk_test_) in Stripe → Developers → API keys, with Read access to Balance, Balance transactions, Customers, Subscriptions and Prices, and to your account details. Secret keys (sk_…) are refused.",
    },
  ],
  scopeExplanation: [
    "Reads your balance transactions to total gross and net volume per month.",
    "Reads when customers were created, to count new customers per month (no names, emails or payment details are stored).",
    "Reads your active subscriptions' prices and quantities to compute this month's MRR and subscription count.",
    "Reads your account's name and default currency.",
    "A restricted key with read-only permissions is required: nothing in Stripe is ever created, changed, refunded or charged.",
  ],
  subProcessor: {
    name: "Stripe, Inc.",
    purpose:
      "Source of monthly payment volume, customer and subscription figures read into Metrics",
    region: "United States",
    dpaUrl: "https://stripe.com/legal/dpa",
    jurisdiction: "us",
  },
};

export interface StripeAdapterOptions {
  /** TESTS ONLY: replaces `https://api.stripe.com`. */
  apiBaseUrl?: string;
}

type Metric = "gross_volume" | "net_volume" | "new_customers" | "mrr" | "active_subscriptions";
const METRIC_KEYS = new Set<string>(stripeMetrics.map((m) => m.key));
const GROSS_TYPES = new Set(["charge", "payment"]);
const NET_TYPES = new Set([
  "charge",
  "payment",
  "refund",
  "payment_refund",
  "payment_failure_refund",
]);
/** Customer-search failures worth one retry; anything else is final or (403) a permission answer. */
const RETRYABLE_SEARCH = new Set<string>(["transport", "unavailable", "malformed", "not_found"]);
// (a 400 never reaches the retry: `countCustomersBySearch` reports it as `forbidden`.)
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{1,250}$/u;

/**
 * Page budgets. Each month (and the subscription snapshot) gets its own 50 pages = 5,000 items;
 * one read stops at 600 pages overall. Stripe list pages of 100 take roughly 0.3–1 s each, and
 * the adapter reads sequentially, so a worst-case 600-page read takes about 3–10 minutes — far
 * under Stripe's read rate limit (100 req/s live, 25 req/s test mode).
 */
export const STRIPE_PAGES_PER_MONTH = MAX_PAGES;
export const STRIPE_MAX_PAGES_PER_READ = 600;

interface Budget {
  total: number;
  /** The month (or snapshot) whose own page budget the next call counts against. */
  scope: { name: string; pages: number } | null;
  /** The caller's `KpiReadRequest.signal`: passed to every fetch, checked before every page. */
  signal?: AbortSignal;
  /** HTTP status of the last answered call (the customer-search fallback reads it). */
  lastStatus?: number;
}

const newBudget = (signal?: AbortSignal): Budget =>
  signal === undefined ? { total: 0, scope: null } : { total: 0, scope: null, signal };

/** An exact fraction, for MRR normalisation (week × 52 ÷ 12 is not a terminating decimal). */
interface Fraction {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

function addFraction(a: Fraction, b: Fraction): Fraction {
  const n = a.n * b.d + b.n * a.d;
  const d = a.d * b.d;
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

/** Round half away from zero to an integer. */
function roundFraction(f: Fraction): bigint {
  const negative = f.n < 0n;
  const n = negative ? -f.n : f.n;
  const q = n / f.d;
  const r = n % f.d;
  const rounded = r * 2n >= f.d ? q + 1n : q;
  return negative ? -rounded : rounded;
}

function safeInt(value: unknown): bigint | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null;
}

export function createStripeAdapter(
  deps: IntegrationAdapterDeps,
  options: StripeAdapterOptions = {},
): IntegrationAdapter {
  const log = deps.log;
  const apiBase = options.apiBaseUrl ?? API_BASE;

  function refuseSecretKey(auth: IntegrationAuth): Failure | null {
    return auth.accessToken.startsWith("sk_")
      ? fail("forbidden", "a secret key (sk_…) is refused; connect a restricted key (rk_…)")
      : null;
  }

  async function stripeGet(
    auth: IntegrationAuth,
    path: string,
    params: URLSearchParams,
    where: string,
    budget: Budget,
  ): Promise<{ ok: true; value: Record<string, unknown> } | Failure> {
    if (budget.signal?.aborted) return abortedFailure();
    delete budget.lastStatus;
    budget.total += 1;
    if (budget.total > STRIPE_MAX_PAGES_PER_READ) {
      return fail(
        "too_large",
        `this read needs more than ${STRIPE_MAX_PAGES_PER_READ} Stripe pages`,
      );
    }
    if (budget.scope !== null) {
      budget.scope.pages += 1;
      if (budget.scope.pages > STRIPE_PAGES_PER_MONTH) {
        return fail(
          "too_large",
          `more than ${STRIPE_PAGES_PER_MONTH * 100} ${budget.scope.name} (${STRIPE_PAGES_PER_MONTH} pages)`,
        );
      }
    }
    const query = params.toString();
    const sent = await send(
      deps.fetch,
      `${apiBase}${path}${query === "" ? "" : `?${query}`}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          "stripe-version": STRIPE_API_VERSION,
          accept: "application/json",
        },
        ...withSignal(budget.signal),
      },
      where,
      log,
    );
    if (!sent.ok) return sent;
    const { status, json } = sent.value;
    budget.lastStatus = status;
    if (status < 200 || status >= 300) return statusFailure(status, where);
    if (!isRecord(json)) return fail("malformed", `${where} did not answer a JSON object`);
    return { ok: true, value: json };
  }

  /** Walks a list endpoint with `starting_after`; `visit` may refuse an item. */
  async function listAll(
    auth: IntegrationAuth,
    path: string,
    params: Record<string, string>,
    where: string,
    budget: Budget,
    visit: (item: Record<string, unknown>) => Failure | undefined | Promise<Failure | undefined>,
  ): Promise<Failure | undefined> {
    let after: string | null = null;
    for (;;) {
      const query = new URLSearchParams({ ...params, limit: PAGE_SIZE });
      if (after !== null) query.set("starting_after", after);
      const page = await stripeGet(auth, path, query, where, budget);
      if (!page.ok) return page;
      const data = page.value["data"];
      const hasMore = page.value["has_more"];
      if (!Array.isArray(data) || typeof hasMore !== "boolean") {
        return fail("malformed", `${where} did not answer a Stripe list`);
      }
      for (const item of data) {
        if (!isRecord(item)) return fail("malformed", `${where} listed a non-object`);
        const refused = await visit(item);
        if (refused !== undefined) return refused;
      }
      if (!hasMore) return undefined;
      const last: unknown = data[data.length - 1];
      const id = isRecord(last) ? last["id"] : undefined;
      if (typeof id !== "string" || id.length === 0 || id.length > 255) {
        return fail("malformed", `${where} has more pages but no cursor`);
      }
      after = id;
    }
  }

  /**
   * `new_customers` for one month in ONE call: the Search API with `expand[]=total_count`
   * (accurate up to 10,000; the search index lags writes by about a minute). `ok: false` =
   * search cannot answer; the caller then lists pages instead.
   */
  async function countCustomersBySearch(
    auth: IntegrationAuth,
    ym: Ym,
    budget: Budget,
  ): Promise<{ ok: true; value: bigint } | Failure> {
    const query = new URLSearchParams({
      query: `created>=${monthStartUnix(ym)} AND created<${monthStartUnix(addMonths(ym, 1))}`,
      limit: "1",
    });
    query.append("expand[]", "total_count");
    const got = await stripeGet(
      auth,
      "/v1/customers/search",
      query,
      "Stripe customer search",
      budget,
    );
    if (!got.ok) {
      // 400 = the search endpoint/query is not supported for this account (e.g. a region without
      // Search): as definitive as a 403, so it is reported as `forbidden` → listing fallback.
      if (budget.lastStatus === 400) {
        return fail(
          "forbidden",
          "Stripe customer search is not supported for this account (HTTP 400)",
        );
      }
      return got;
    }
    const total = safeInt(got.value["total_count"]);
    if (got.value["object"] !== "search_result" || total === null || total < 0n) {
      return fail("malformed", "Stripe customer search answered without total_count");
    }
    if (total >= 10_000n) {
      return fail(
        "too_large",
        `10000 or more customers created in ${formatMonth(ym)} (Stripe search counts up to 10,000)`,
      );
    }
    return { ok: true, value: total };
  }

  async function account(
    auth: IntegrationAuth,
    budget: Budget,
  ): Promise<
    { ok: true; value: { id: string | null; label: string; currency: string | null } } | Failure
  > {
    const got = await stripeGet(
      auth,
      "/v1/account",
      new URLSearchParams(),
      "Stripe account",
      budget,
    );
    if (got.ok) {
      const body = got.value;
      const id =
        typeof body["id"] === "string" && /^acct_[A-Za-z0-9]{1,250}$/u.test(body["id"])
          ? body["id"]
          : null;
      const settings = isRecord(body["settings"]) ? body["settings"] : {};
      const dashboard = isRecord(settings["dashboard"]) ? settings["dashboard"] : {};
      const profile = isRecord(body["business_profile"]) ? body["business_profile"] : {};
      const name = [dashboard["display_name"], profile["name"]].find(
        (v): v is string => typeof v === "string" && v.trim() !== "",
      );
      const currency =
        typeof body["default_currency"] === "string" ? body["default_currency"] : null;
      return { ok: true, value: { id, label: name?.trim() ?? id ?? "Stripe account", currency } };
    }
    if (got.reason !== "forbidden") return got;
    // A restricted key without account-read permission can still read the balance's currency.
    const balance = await stripeGet(
      auth,
      "/v1/balance",
      new URLSearchParams(),
      "Stripe balance",
      budget,
    );
    if (!balance.ok) return balance;
    const available = balance.value["available"];
    const first: unknown = Array.isArray(available) ? available[0] : undefined;
    const currency =
      isRecord(first) && typeof first["currency"] === "string" ? first["currency"] : null;
    return { ok: true, value: { id: null, label: "Stripe account", currency } };
  }

  return {
    meta: stripeMeta,

    async verify(auth: IntegrationAuth) {
      const refused = refuseSecretKey(auth);
      if (refused !== null) return refused;
      const info = await account(auth, newBudget());
      if (!info.ok) return info;
      const suffix = auth.environment === "sandbox" ? " (test mode)" : "";
      return {
        ok: true as const,
        value: {
          accountLabel: `${info.value.label.slice(0, 180)}${suffix}`,
          externalAccountId: info.value.id,
        },
      };
    },

    kpi: {
      metrics: stripeMetrics,
      async read(
        auth: IntegrationAuth,
        req: KpiReadRequest,
      ): Promise<IntegrationResult<KpiReadValue>> {
        const unknown = req.metrics.find((m) => !METRIC_KEYS.has(m));
        if (unknown !== undefined) return fail("not_found", `unknown Stripe metric "${unknown}"`);
        const now = deps.now();
        const months = requestedMonths(req.fromMonth, req.toMonth, now);
        if (months === null) return fail("malformed", "the requested month range is invalid");
        const refused = refuseSecretKey(auth);
        if (refused !== null) return refused;
        const wanted = [...new Set(req.metrics)] as Metric[];
        const last = months[months.length - 1];
        const current = currentMonth(now);
        const currentKey = formatMonth(current);
        const coversCurrent = last !== undefined && compareMonths(last, current) === 0;

        const needGross = wanted.includes("gross_volume");
        const needNet = wanted.includes("net_volume");
        const needCustomers = wanted.includes("new_customers");
        const needMrr = wanted.includes("mrr") && coversCurrent;
        const needSubs = (needMrr || wanted.includes("active_subscriptions")) && coversCurrent;
        const budget = newBudget(req.signal);

        let currency: string | null = null;
        if ((needGross || needNet || needMrr) && months.length > 0) {
          budget.scope = null;
          const info = await account(auth, budget);
          if (!info.ok) return info;
          currency = info.value.currency;
          if (currency === null || !/^[a-z]{3}$/iu.test(currency)) {
            return fail("malformed", "Stripe did not name the account's default currency");
          }
          currency = currency.toLowerCase();
        }
        const exponent = currency === null ? 2 : currencyExponent(currency);

        const gross = new Map<string, bigint>();
        const net = new Map<string, bigint>();
        const customers = new Map<string, bigint>();
        let otherCurrency = 0;
        const monthRange = (ym: Ym) => ({
          "created[gte]": String(monthStartUnix(ym)),
          "created[lt]": String(monthStartUnix(addMonths(ym, 1))),
        });

        // Month by month, each with its own page budget, so one busy month cannot starve the rest.
        if (needGross || needNet) {
          for (const ym of months) {
            const month = formatMonth(ym);
            budget.scope = { name: `balance transactions in ${month}`, pages: 0 };
            const failed = await listAll(
              auth,
              "/v1/balance_transactions",
              monthRange(ym),
              "Stripe balance transactions",
              budget,
              (bt) => {
                const created = bt["created"];
                const type = bt["type"];
                const amount = safeInt(bt["amount"]);
                const netAmount = safeInt(bt["net"]);
                if (
                  typeof created !== "number" ||
                  !Number.isSafeInteger(created) ||
                  typeof type !== "string" ||
                  amount === null ||
                  netAmount === null ||
                  typeof bt["currency"] !== "string"
                ) {
                  return fail(
                    "malformed",
                    "a Stripe balance transaction is missing created/type/amount/net/currency",
                  );
                }
                if (bt["currency"].toLowerCase() !== currency) {
                  otherCurrency += 1;
                  return undefined;
                }
                // Bucket by the transaction's own timestamp (defensive against a sloppy filter).
                const at = monthOfUnix(created);
                if (GROSS_TYPES.has(type)) gross.set(at, (gross.get(at) ?? 0n) + amount);
                if (NET_TYPES.has(type)) net.set(at, (net.get(at) ?? 0n) + netAmount);
                return undefined;
              },
            );
            if (failed !== undefined) return failed;
          }
          if (otherCurrency > 0) {
            log?.("integration.stripe.other_currency_skipped", {
              count: otherCurrency,
              level: "warn",
            });
          }
        }

        if (needCustomers) {
          let searchUsable = true;
          for (const ym of months) {
            const month = formatMonth(ym);
            budget.scope = { name: `customers created in ${month}`, pages: 0 };
            if (searchUsable) {
              /*
               * Search is the only way a month with more than 5,000 new customers can be counted
               * (listing would blow the month's page budget), so a search failure is NOT a
               * reason to list: one retry, then `unavailable` for this read (the nightly sync
               * tries again). Only a definitive "no" — 403 (the key may not search) or 400
               * (search unsupported for this account) — switches this read to listing. `unauthorized`, `rate_limited` and `too_large`
               * (count at Stripe's 10,000 search cap, or the read's page ceiling) are returned
               * as they are.
               */
              let counted = await countCustomersBySearch(auth, ym, budget);
              if (budget.signal?.aborted) return abortedFailure();
              if (!counted.ok && RETRYABLE_SEARCH.has(counted.reason)) {
                log?.("integration.stripe.customer_search_retry", {
                  month,
                  reason: counted.reason,
                });
                counted = await countCustomersBySearch(auth, ym, budget);
                if (budget.signal?.aborted) return abortedFailure();
              }
              if (counted.ok) {
                customers.set(month, counted.value);
                continue;
              }
              if (counted.reason !== "forbidden") {
                if (!RETRYABLE_SEARCH.has(counted.reason)) return counted;
                return fail(
                  "unavailable",
                  `Stripe customer search failed twice for ${month} (${counted.reason}); try again later`,
                );
              }
              // 403 (key may not search) or 400 (search unsupported for this account): list pages
              // from here on; the refused search call does not eat into this month's budget.
              searchUsable = false;
              budget.scope.pages = 0;
              log?.("integration.stripe.customer_search_forbidden", { month });
            }
            const failed = await listAll(
              auth,
              "/v1/customers",
              monthRange(ym),
              "Stripe customers",
              budget,
              (customer) => {
                const created = customer["created"];
                if (typeof created !== "number" || !Number.isSafeInteger(created)) {
                  return fail("malformed", "a Stripe customer has no created timestamp");
                }
                const at = monthOfUnix(created);
                customers.set(at, (customers.get(at) ?? 0n) + 1n);
                return undefined;
              },
            );
            if (failed !== undefined) return failed;
          }
        }

        let activeSubscriptions = 0n;
        let mrr: Fraction = { n: 0n, d: 1n };
        if (needSubs) {
          budget.scope = { name: "active subscriptions and their items", pages: 0 };
          const addItem = (item: Record<string, unknown>): Failure | undefined => {
            if (!needMrr) return undefined;
            const price = item["price"];
            if (!isRecord(price))
              return fail("malformed", "a Stripe subscription item has no price");
            const recurring = price["recurring"];
            if (!isRecord(recurring)) return undefined; // a one-off price on a subscription: not recurring revenue
            if (recurring["usage_type"] === "metered") return undefined;
            if (
              typeof price["currency"] !== "string" ||
              price["currency"].toLowerCase() !== currency
            )
              return undefined;
            let unit: Dec | null = null;
            if (typeof price["unit_amount_decimal"] === "string")
              unit = parseDecimal(price["unit_amount_decimal"]);
            else if (price["unit_amount"] !== null && price["unit_amount"] !== undefined) {
              const whole = safeInt(price["unit_amount"]);
              unit = whole === null ? null : { units: whole, scale: 0 };
            } else if (price["billing_scheme"] === "tiered") {
              return undefined; // tier amounts are not expanded; documented
            }
            if (unit === null) return fail("malformed", "a Stripe price has no usable unit amount");
            const quantity =
              item["quantity"] === undefined || item["quantity"] === null
                ? 1n
                : safeInt(item["quantity"]);
            const count = safeInt(recurring["interval_count"] ?? 1);
            if (quantity === null || quantity < 0n || count === null || count < 1n) {
              return fail(
                "malformed",
                "a Stripe subscription item has an invalid quantity or interval_count",
              );
            }
            const factor: Record<string, Fraction> = {
              month: { n: 1n, d: 1n },
              year: { n: 1n, d: 12n },
              week: { n: 52n, d: 12n },
              day: { n: 365n, d: 12n },
            };
            const interval =
              typeof recurring["interval"] === "string" ? factor[recurring["interval"]] : undefined;
            if (interval === undefined)
              return fail("malformed", "a Stripe price has an unknown interval");
            mrr = addFraction(mrr, {
              n: unit.units * quantity * interval.n,
              d: 10n ** BigInt(unit.scale) * interval.d * count,
            });
            return undefined;
          };
          const failed = await listAll(
            auth,
            "/v1/subscriptions",
            { status: "active" },
            "Stripe subscriptions",
            budget,
            async (sub) => {
              if (sub["status"] !== "active") return undefined;
              activeSubscriptions += 1n;
              if (!needMrr) return undefined;
              const items = sub["items"];
              if (!isRecord(items) || !Array.isArray(items["data"])) {
                return fail("malformed", "a Stripe subscription has no items list");
              }
              if (items["has_more"] === true) {
                const id = sub["id"];
                if (typeof id !== "string" || !SUBSCRIPTION_ID.test(id)) {
                  return fail("malformed", "a Stripe subscription has an invalid id");
                }
                return listAll(
                  auth,
                  "/v1/subscription_items",
                  { subscription: id },
                  "Stripe subscription items",
                  budget,
                  addItem,
                );
              }
              for (const item of items["data"]) {
                if (!isRecord(item))
                  return fail("malformed", "a Stripe subscription item is not an object");
                const refusedItem = addItem(item);
                if (refusedItem !== undefined) return refusedItem;
              }
              return undefined;
            },
          );
          if (failed !== undefined) return failed;
        }

        const money = (units: bigint): string => formatDec(fromMinorUnits(units, exponent));
        const series = wanted.map((metric) => {
          switch (metric) {
            case "gross_volume":
            case "net_volume":
            case "new_customers": {
              const source =
                metric === "gross_volume" ? gross : metric === "net_volume" ? net : customers;
              return {
                metric,
                points: months.map((ym) => {
                  const month = formatMonth(ym);
                  const units = source.get(month) ?? 0n;
                  return {
                    month,
                    value: metric === "new_customers" ? units.toString() : money(units),
                  };
                }),
              };
            }
            case "mrr":
              return {
                metric,
                points: needMrr ? [{ month: currentKey, value: money(roundFraction(mrr)) }] : [],
              };
            case "active_subscriptions":
              return {
                metric,
                points: needSubs
                  ? [{ month: currentKey, value: activeSubscriptions.toString() }]
                  : [],
              };
          }
          return { metric, points: [] };
        });
        return {
          ok: true,
          value: { currency: currency === null ? null : currency.toUpperCase(), series },
        };
      },
    },
  };
}

// Compile-time proof that the extra (test-only) options parameter keeps the frozen factory shape.
const _factory: IntegrationAdapterFactory = createStripeAdapter;
void _factory;
