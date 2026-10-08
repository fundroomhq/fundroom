# @fundroom/integration-xero

`IntegrationAdapter` for the **Xero Accounting API**: monthly revenue, expenses,
net profit and cash for Metrics. Exports: `createXeroAdapter` (`IntegrationAdapterFactory`),
`xeroMeta`, `xeroMetrics`, `XERO_SCOPES`. Depends only on `@fundroom/ports` and Node builtins.
Stateless: the kernel `@fundroom/integrations` owns the connection, refreshes and decrypts the
token and passes it per call; the adapter uses only `deps.fetch` and never follows a redirect.

## OAuth

| | value |
|---|---|
| authorize | `https://login.xero.com/identity/connect/authorize` |
| token | `POST https://identity.xero.com/connect/token` (client_secret_basic, form; `code_verifier` when PKCE) |
| revoke | `POST https://identity.xero.com/connect/revocation` form `token=` (client_secret_basic; Xero revokes **refresh** tokens) |
| scopes | `openid offline_access accounting.reports.profitandloss.read accounting.reports.balancesheet.read accounting.settings.read` |
| PKCE | on (S256, minted by the kernel) |

**Scope change (deviation from the original plan):** Xero replaced the broad `accounting.reports.read`
(and `accounting.transactions`) with granular scopes. Apps created on or after **2026-03-02**
cannot request the broad scopes at all; older apps must migrate by September 2027, and existing
tokens do not gain new scopes until the user re-consents. A deployment registering its Xero app
now therefore needs the granular `accounting.reports.profitandloss.read` +
`accounting.reports.balancesheet.read`. `accounting.settings.read` (Organisation: name, base
currency) is unchanged. `offline_access` yields the refresh token (required — a grant without one
is `malformed`). `openid` is Xero's baseline; no profile/email is requested or read.

**Multi-org:** after the code exchange the adapter calls `GET https://api.xero.com/connections`
and returns the `ORGANISATION` tenants in `OAuthTokenSet.extra.accounts` as a JSON string
`[{"id":"<tenantId>","name":"<tenantName>"}]` (≤ 50, uuid ids only, de-duplicated). The tenants
authorised in *this* consent (matching the access token's `authentication_event_id` claim, read
without verification purely for ordering) come first; `externalAccountId` = the first one, or
`null` when the grant covers none. If the connections call fails, the fresh refresh token is
revoked best-effort and the failure returned. `refresh` does not re-list (no `extra`) and answers
`externalAccountId: null` — the kernel keeps the stored one.

Access tokens last 30 min; refresh tokens **rotate** (the old one has a short grace period).
Token errors map like the QuickBooks adapter: `invalid_grant` → `unauthorized`,
`invalid_client`/`unauthorized_client`/bare 401 → `unavailable`, 429 → `rate_limited`,
5xx → `unavailable`, other 4xx → `malformed`.

## What is read

All accounting calls send `Authorization: Bearer …` and `xero-tenant-id: <tenantId>` (uuid-checked).

| call | endpoint |
|---|---|
| verify / currency | `GET https://api.xero.com/api.xro/2.0/Organisation` → `Organisations[0].Name`, `.BaseCurrency` |
| P&L | `GET …/api.xro/2.0/Reports/ProfitAndLoss?fromDate=<1st of newest month>&toDate=<its last day>&periods=<n-1>&timeframe=MONTH&standardLayout=true` |
| cash | `GET …/api.xro/2.0/Reports/BalanceSheet?date=<last day of newest month>&periods=<n-1>&timeframe=MONTH&standardLayout=true` |

**Xero limitation: comparison periods keep the anchor's DAY NUMBER.** A report anchored on
the 30th (`toDate=2026-09-30&periods=2`) produces columns "30 Sep 2026 / 30 Aug 2026 /
30 Jul 2026". July and August are cut short by a day, and a balance sheet `date=` comes back
"as at the 30th". An anchor in February cuts up to three days from every comparison month. The
adapter works around this in two layers:

1. **Planning.** A multi-month request (≤ 12 months, `periods=n-1&timeframe=MONTH`) is anchored
   only on a **31-day month** (`toDate`/`date` = the 31st). A 28-, 29- or 30-day month is
   requested **on its own** (`fromDate`=1st, `toDate`=last day; balance sheet `date`=last day; no
   `periods`).
2. **Validation.** A column counts for a month only if its header names that month **and** its
   day is the month's last day, e.g. "31 Aug 2026" or "28 Feb 2026". A day-less header ("Aug
   2026"), or one unlabelled column, is accepted only in a single-month request. In that case
   the month is exact by construction, and an unlabelled column additionally needs every row to
   have exactly one value cell. Any month whose column is refused is **re-requested alone**. If
   the single-month answer still does not end on the month's last day, the read fails as
   `malformed` naming the month. Re-requests count toward the 50-call cap (`too_large`
   names the month).

`standardLayout=true` makes a custom report layout unable to rename rows.

| metric | kind | source row |
|---|---|---|
| `revenue` | flow | SummaryRow "Total Income" (also Total Trading Income / Revenue / Turnover / Sales, or the SummaryRow of an Income/Revenue/Turnover section) |
| `expenses` | flow | SummaryRow "Total Operating Expenses" (also Total Expenses / Overheads / Administrative Costs; excludes Cost of Sales) |
| `net_income` | flow | Row "Net Profit" (also Net Income; a "Net Loss" label is negated) |
| `cash` | stock | SummaryRow "Total Bank" of the Balance Sheet (0 when the org has no bank accounts) |

All `historical: true`. Currency = the organisation's `BaseCurrency`.

## Parsing rules

- Columns come from the `Header` row. Labels such as "31 Mar 2026", "Mar 2026", "Mar-26" or
  "March 2026" are parsed to a month and, when present, a day. Columns are never mapped by
  position. See the whole-month rules above.
- Sections/rows are walked recursively (`Section` → `Rows[]` → `Row`/`SummaryRow` → `Cells[]`);
  any other shape is `malformed`. A report with no rows at all (a new organisation) is all zeros;
  a P&L with rows but no net-profit line is `malformed`.
- Cells: `""` = 0; only `-?digits(.digits)?` accepted; exact decimals, no floats.
- Ranges clamp to the current UTC month. If the planned `1 + groups × reports` calls exceed 50,
  the read returns `too_large` up front. A typical 25-month read plans about 7–9 calls: the
  Organisation call, plus one or two groups and a lone 30-day month per report.
- HTTP mapping as in `src/internal/http.ts`; a 429 names Xero's `X-Rate-Limit-Problem`
  (`minute`/`day`/`concurrent`/`appminute` only) in the detail. Xero's limits (60 calls/min and
  5 000/day per organisation, 5 concurrent) are reported, never waited out.

- **Cancellation**: `KpiReadRequest.signal` is passed to every fetch and checked before every call. Paging therefore stops between pages, and an aborted read answers `{ok:false, reason:"unavailable", detail:"aborted"}`, never `transport`.

## Needs a live sandbox check (inferred, not observed)

1. **P&L month header format** with `timeframe=MONTH`. An early probe saw "30 Sep 2026"-style
   end dates. Day-less headers still work, but cost one single-month re-request per month.
2. Whether a 31st anchor clamps each comparison month to its own last day ("30 Sep", "28 Feb"),
   or carries a clamped day forward ("31 Mar → 28 Feb → 28 Jan"). The latter is detected and
   repaired by re-requests, but costs calls.
3. That `periods=11` (12 columns) is accepted for both reports (the OpenAPI spec says 1..12 for P&L).
4. Row labels under `standardLayout=true` in non-US/AU editions (UK "Turnover", "Administrative
   Costs" are guessed variants), and whether a loss is ever labelled "Net Loss".
5. That an empty organisation answers only a header and empty sections.
6. That the Balance Sheet `date` + `periods` yields true month-end columns (the documented example
   shows 30 Apr / 31 Mar / 28 Feb).
7. That tokens minted for an app registered before 2026-03-02 but consented with the granular
   scopes behave identically (Xero says they do).

## Operator setup

Create a *Web app* at developer.xero.com, add the redirect URI
`${BASE_URL}/oauth/integrations/callback`, and set `INTEGRATIONS_XERO_CLIENT_ID/_SECRET`. Xero has
no separate sandbox environment — use the Demo Company. See `docs/integrations/README.md`.

## Sub-processor row

| name | purpose | region | DPA |
|---|---|---|---|
| Xero Limited | Source of monthly revenue, expenses, net profit and cash figures read into Metrics | United States / Australia (Xero-hosted) | https://www.xero.com/us/legal/terms/data-processing/ |

## Tests

`src/xero.test.ts` (fake `fetch`, recorded-shape fixtures in `src/test/fixtures/`, a dynamic
report builder for paging) plus the shared contract suite `src/test/contract.ts` (copied verbatim
into each KPI adapter, as are `src/internal/{http,decimal,months,oauth}.ts` and
`src/test/fake-fetch.ts`).
