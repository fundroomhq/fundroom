# @fundroom/integration-stripe

`IntegrationAdapter` for the **Stripe API** over a pasted **restricted key**:
monthly gross and net volume, new customers, and current MRR / active subscriptions for Metrics.
Exports: `createStripeAdapter` (`IntegrationAdapterFactory`), `stripeMeta`, `stripeMetrics`,
`STRIPE_API_VERSION`, `currencyExponent`. Depends only on `@fundroom/ports` and Node builtins.
Stateless; uses only `deps.fetch`; never follows a redirect.

## Credentials (connection form)

| key | kind | notes |
|---|---|---|
| `restrictedKey` | secret | `rk_live_…` or `rk_test_…`; the kernel refuses `sk_…` (422 `integration_secret_key_refused`) and derives the environment from the prefix; the adapter also answers `forbidden` for an `sk_` key without calling Stripe |

Suggested restricted-key permissions (all **Read**): Balance, Balance transaction sources /
balance transactions, Customers, Subscriptions, Prices, and account details. The exact
permission names in Stripe's key editor are listed as a sandbox check below.

## What is read

Every call: `Authorization: Bearer rk_…`, `Stripe-Version: 2025-03-31.basil` (pinned, so a
dashboard API upgrade cannot change the parsed shapes), `GET https://api.stripe.com/…`.

| call | endpoint |
|---|---|
| verify / currency | `GET /v1/account` → `settings.dashboard.display_name` ▸ `business_profile.name` ▸ `id`, `default_currency`; on **403** falls back to `GET /v1/balance` (`available[0].currency`, label "Stripe account", `externalAccountId: null`) |
| volumes | per month `GET /v1/balance_transactions?created[gte]&created[lt]&limit=100[&starting_after]` |
| new customers | per month `GET /v1/customers/search?query=created>=…%20AND%20created<…&limit=1&expand[]=total_count`; fallback `GET /v1/customers?created[gte]&created[lt]&limit=100[&starting_after]` |
| MRR / subscriptions | `GET /v1/subscriptions?status=active&limit=100`; a subscription whose `items.has_more` is true → `GET /v1/subscription_items?subscription=<id>&limit=100` |

A test-mode key gets " (test mode)" appended to its account label.

| metric | kind | historical | definition |
|---|---|---|---|
| `gross_volume` | flow | yes | Σ `amount` of balance transactions of type `charge`/`payment` (exists only for succeeded charges) |
| `net_volume` | flow | yes | Σ `net` (after Stripe fees) of `charge`, `payment`, `refund`, `payment_refund`, `payment_failure_refund` |
| `new_customers` | flow (count) | yes | customers whose `created` falls in the month |
| `mrr` | stock | **no** | active subscriptions, current month only (see below) |
| `active_subscriptions` | stock (count) | **no** | `status=active` subscriptions, current month only |

Months are **UTC** calendar months (Stripe's `created` is a Unix timestamp; the dashboard shows
the account's timezone, so month-edge totals can differ from the dashboard). Ranges clamp to the
current month. `historical: false` metrics answer one point for the current month when the range
includes it, else no points (and no subscription calls are made).

**Money** is integer minor units summed as bigints and divided by the currency exponent:
zero-decimal (BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF VND VUV XAF XOF XPF) → 0; BHD JOD KWD OMR
TND → 3; everything else → 2 — including ISK and UGX, which Stripe still represents as
two-decimal in the API. Output is a plain decimal string in major units (`"12.345"`, `"5000"`,
`"-25.00"`). Currency = the account's `default_currency`, upper-cased; `null` when only count
metrics are read.

**MRR**: for each licensed item of each active subscription, `unit_amount_decimal` (or
`unit_amount`) × `quantity` normalised to a month — month ÷ `interval_count`, year ÷ 12, week ×
52 ÷ 12, day × 365 ÷ 12 — summed as exact fractions and rounded half-away-from-zero to the minor
unit. **Not included** (documented deviation, keep in the ADR): discounts/coupons, tax, trials
(trialing subscriptions are not `active`), `past_due` subscriptions, metered prices, tiered prices
(tiers are not expanded), `transform_quantity`, and prices in a currency other than the default.

**Multi-currency settlement**: balance transactions are in the settlement currency (Stripe
converts charges); transactions in a currency other than the default are skipped and counted in
the `integration.stripe.other_currency_skipped` log line (count only).

## Limits and failures

- **Budgets** (`STRIPE_PAGES_PER_MONTH`, `STRIPE_MAX_PAGES_PER_READ`): balance transactions and
  customers are read **month by month**, and each month has its own 50 pages (5,000 items). The
  active-subscription snapshot, including any `/v1/subscription_items` pages, has its own 50 as
  well. One read stops at **600 pages** overall, with every call counted, the account call included.
  Over a month's budget → `too_large` with the month in the detail
  (`more than 5000 balance transactions in 2026-03 (50 pages)`). Over the overall cap →
  `too_large` (`this read needs more than 600 Stripe pages`). So a 24-month backfill works up to
  about 2,400 balance transactions a month on average, or up to 5,000 in any single month. The
  earlier shared cap failed above about 205 a month. The metrics module retries a `too_large`
  with a 3-month window.
- **Time cost**: calls are sequential; a Stripe list page of 100 takes roughly 0.3–1 s, so a
  worst-case 600-page read takes about 3–10 minutes (well under Stripe's read rate limits of
  100 req/s live and 25 req/s test). Stripe's asynchronous Reporting API would lift the volume
  ceiling and is the follow-up if it bites.
- **New customers are counted cheaply**, with one Search API call per month:
  `GET /v1/customers/search?query=created>=<start> AND created<<end>&limit=1&expand[]=total_count`.
  `total_count` is accurate up to 10,000, and the search index lags writes by about a minute.
  Search is the only way a month with more than 5,000 new customers can be counted, so a search
  failure does **not** switch the read to listing:
  - **Temporary failure** (network error, 404, 5xx, or no `total_count`): the adapter
    retries once. If the retry also fails, the whole read returns `unavailable` with the month in
    the detail, and the nightly sync tries again.
  - **Count at the cap** (`total_count` ≥ 10,000): `too_large` naming the month. There is no
    retry and no listing, since listing could not fit the month's budget anyway.
  - **401 or 429**: returned as-is.
  - **403** (the key is not permitted to search) or **400** (search is unsupported for this
    account, e.g. a region without Search): the only cases that fall back to listing. The rest of the read then lists `/v1/customers` month by month within each month's
    budget, so a key without search permission can count at most 5,000 new customers a month.
    Grant the key Customers read, which includes search, to avoid this. The refused search call
    does not count against the month's budget.
- HTTP: 401 `unauthorized` (revoked/rolled key), 403 `forbidden` (key lacks a permission), 404
  `not_found`, 429 `rate_limited` (reported, never waited out), 5xx `unavailable`, other `transport`;
  guard/size errors as in `src/internal/http.ts`. A list without `data`/`has_more`, a cursor-less
  `has_more`, a non-integer amount, an unknown interval, a negative quantity, or an exponent in
  `unit_amount_decimal` → `malformed`.

- **Cancellation**: `KpiReadRequest.signal` is passed to every fetch and checked before every call. Paging therefore stops between pages, and an aborted read answers `{ok:false, reason:"unavailable", detail:"aborted"}`, never `transport`.

## Needs a live sandbox check (inferred, not observed)

1. Whether a restricted key can read `GET /v1/account` for its own account, and the exact
   permission names to request in the key editor (the `/v1/balance` fallback covers "no").
2. That `payment`/`payment_refund`/`payment_failure_refund` are the right non-card types to count
   alongside `charge`/`refund` under `2025-03-31.basil`.
3. That `subscription.items` is truncated at 10 with `has_more: true` (handled via
   `/v1/subscription_items`).
4. That customer search accepts `created>=N AND created<M` with `expand[]=total_count` for a
   restricted key with Customers read (the fallback covers "no").
5. Stripe's own "Gross volume"/"Net volume" dashboard definitions (disputes and their fees are not
   subtracted here).

## Sub-processor row

| name | purpose | region | DPA |
|---|---|---|---|
| Stripe, Inc. | Source of monthly payment volume, customer and subscription figures read into Metrics | United States | https://stripe.com/legal/dpa |

## Tests

`src/stripe.test.ts` (fake `fetch`, recorded-shape fixtures in `src/test/fixtures/`) plus the
shared contract suite `src/test/contract.ts` (copied verbatim into each KPI adapter, as are
`src/internal/{http,decimal,months}.ts` and `src/test/fake-fetch.ts`).
