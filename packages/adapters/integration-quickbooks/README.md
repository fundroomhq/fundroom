# @fundroom/integration-quickbooks

`IntegrationAdapter` for the **QuickBooks Online Accounting API v3**: monthly
revenue, expenses, net income and cash for Metrics. Exports: `createQuickbooksAdapter`
(`IntegrationAdapterFactory`), `quickbooksMeta`, `quickbooksMetrics`, `QUICKBOOKS_MINOR_VERSION`.
Depends only on `@fundroom/ports` and Node builtins. Stateless: the kernel
`@fundroom/integrations` owns the connection, refreshes and decrypts the token and passes it per
call; the adapter uses only `deps.fetch` (the guarded outbound client) and never follows a redirect.

## OAuth

| | value |
|---|---|
| authorize | `https://appcenter.intuit.com/connect/oauth2` |
| token | `POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` (client_secret_basic, form) |
| revoke | `POST https://developer.api.intuit.com/v2/oauth2/tokens/revoke` JSON `{token}` (client_secret_basic) |
| scope | `com.intuit.quickbooks.accounting` (Intuit has no narrower read-only scope) |
| PKCE | **off** — Intuit documents none; the client secret + single-use `state` + browser-binding cookie protect the code |
| account | `realmId` from the callback query (digits only, else `malformed`) → `externalAccountId` |

Access tokens last 1 h; refresh tokens **rotate** on every refresh (the new one is always
returned; if a response ever omits it, the current one is handed back). `x_refresh_token_expires_in`
is surfaced as `extra.refreshTokenExpiresAt`. Token-endpoint errors: `invalid_grant` →
`unauthorized` (kernel: reauth required); `invalid_client`/`unauthorized_client`/bare 401 →
`unavailable` (the operator's client credentials are wrong — reconnecting would not help);
429 → `rate_limited`; 5xx → `unavailable`; other 4xx → `malformed`. Details carry at most the RFC
error code, never Intuit's description.

## What is read

| call | endpoint |
|---|---|
| verify | `GET {api}/v3/company/{realmId}/companyinfo/{realmId}?minorversion=75` → `CompanyName` (fallback `LegalName`, then the realm id) |
| P&L | `GET {api}/v3/company/{realmId}/reports/ProfitAndLoss?start_date&end_date&summarize_column_by=Month&minorversion=75` |
| cash | `GET {api}/v3/company/{realmId}/reports/BalanceSheet?start_date&end_date&summarize_column_by=Month&minorversion=75` |

`{api}` = `https://quickbooks.api.intuit.com`, or `https://sandbox-quickbooks.api.intuit.com` for a
connection whose environment is `sandbox`. Minor version 75 is Intuit's base version since
2025-08-01 (lower values are ignored). Nothing is ever written.

| metric | kind | source |
|---|---|---|
| `revenue` | flow | P&L section `group: "Income"` → `Summary` ("Total Income") |
| `expenses` | flow | P&L `group: "Expenses"` → `Summary` ("Total Expenses"; excludes Cost of Goods Sold and Other Expenses) |
| `net_income` | flow | P&L `group: "NetIncome"` → `Summary` |
| `cash` | stock | Balance Sheet `group: "BankAccounts"` → `Summary` ("Total Bank Accounts") at each month end |

All `historical: true`. Currency = the report `Header.Currency` (the company's home currency).
Accounting basis = the company's report default (not forced to accrual or cash).

## Parsing rules

- Rows are found by `group`, anywhere in the tree (depth-first), never by position. A missing
  Income/Expenses/BankAccounts section is 0 (nothing booked); a report with rows but no NetIncome
  section is `malformed`; `Header.Option NoReportData=true` (or no rows) is all zeros.
- Columns are mapped to months from `MetaData` `StartDate`/`EndDate`; a column spanning two
  months (the "Total" column) is skipped; without dates, a `ColTitle` of "Mon YYYY" is used. A
  requested month with no column is `malformed`.
- Cells: `""` = 0; otherwise only `-?digits(.digits)?` is accepted (no exponent, no separators) —
  values are carried as exact decimals, never floats.
- A 200 carrying `Fault` is a failure: `AUTHENTICATION` → `unauthorized`, `Authorization…` →
  `forbidden`, anything else → `malformed`.
- Ranges are clamped to the current (UTC) month and fetched 12 months per report, sequentially;
  more than 50 report calls → `too_large` before any call is made.
- HTTP: 401 `unauthorized`, 403 `forbidden`, 404 `not_found`, 429 `rate_limited` (reported, never
  waited out), 5xx `unavailable`, 3xx/other `transport`, guard `response_too_large` / body > 2 MiB
  `too_large`, other guard errors `transport`, non-JSON `malformed`.

- **Cancellation**: `KpiReadRequest.signal` is passed to every fetch and checked before every call. Paging therefore stops between pages, and an aborted read answers `{ok:false, reason:"unavailable", detail:"aborted"}`, never `transport`.

## Needs a live sandbox check (inferred from documentation, not observed)

1. That monthly BalanceSheet columns carry `StartDate`/`EndDate` metadata exactly like the P&L's
   (the title fallback covers "Mon YYYY" only).
2. That `NoReportData=true` is how an empty company answers, and that such a report may omit
   month columns (we read it as zeros without checking columns).
3. That a P&L with activity always has a `NetIncome` group (we refuse the report otherwise).
4. That a partial first/last month is never produced for whole-month `start_date`/`end_date`.
5. The 200-with-`Fault` `type` spellings (`AUTHENTICATION`, `AuthorizationFault`, `ValidationFault`).
6. Refresh-token rotation cadence and `x_refresh_token_expires_in` presence after Intuit's
   2025 token-policy changes.
7. That the revoke endpoint accepts a refresh token *or* an access token (the kernel may send either).

## Operator setup

Create an app at developer.intuit.com (Accounting scope), add the redirect URI
`${BASE_URL}/oauth/integrations/callback`, and set `INTEGRATIONS_QUICKBOOKS_CLIENT_ID/_SECRET`
(`INTEGRATIONS_QUICKBOOKS_ENVIRONMENT=sandbox` for development keys). Production keys require
Intuit's app assessment. See `docs/integrations/README.md`.

## Sub-processor row

| name | purpose | region | DPA |
|---|---|---|---|
| Intuit Inc. (QuickBooks Online) | Source of monthly revenue, expenses, net income and cash figures read into Metrics | United States | https://www.intuit.com/privacy/statement/ (Intuit publishes no developer-facing DPA; the workspace's own QuickBooks subscription terms govern the data at Intuit) |

## Tests

`src/quickbooks.test.ts` (fake `fetch`, recorded-shape fixtures in `src/test/fixtures/`) plus the
shared contract suite `src/test/contract.ts` (copied verbatim into each KPI adapter package, as
are `src/internal/{http,decimal,months}.ts` and `src/test/fake-fetch.ts` — change one, change all).
