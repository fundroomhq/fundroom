# @fundroom/sheets-google

`SpreadsheetPort` over the Google Sheets v4 REST API. The default driver
for the `metrics` module's nightly KPI sync, plus a `noop` driver that switches the integration
off entirely.

```ts
const sheets = createGoogleSheetsAdapter({ fetch: sheetsHttp.fetch });
const result = await sheets.read(credential, spreadsheetId, "KPIs!A1:D100");
if (!result.ok) recordFailure(result.reason, result.detail);
```

## Service account, not OAuth

The admin pastes the service-account JSON Google already generated for them, and we show them
`client_email` so they can share the sheet with that address. That is the whole flow.

An authorization-code flow would need a registered OAuth client with a redirect URI, and a
self-hoster has nobody to register one with — the product would have to ship a client id owned by
us, through which every self-hosted install's sheet access would run. A service account needs no
registration and no consent screen, sharing *is* the grant, and un-sharing is the revocation, in a
UI the founder already uses every day.

Only two fields of that JSON are read, and both are validated (`parseServiceAccountJson`):
`client_email` must look like an address, `private_key` must be a PEM `crypto.createPrivateKey`
accepts. `token_uri` is deliberately **ignored** — honouring a field from a pasted file would
point a *signed assertion* at whatever host it named.

## Two HTTP calls, no SDK

1. RS256-sign a JWT (`iss` = client_email, `scope` = `spreadsheets.readonly`, `aud` = the token
   endpoint, one-hour `exp`) with `node:crypto`.
2. Exchange it at `https://oauth2.googleapis.com/token` for an access token, cached in process for
   its lifetime minus a minute, keyed by `client_email` + scope. A sweep over a year of periods is
   one token, not one per read; Google meters the token endpoint separately from the data one.
3. `GET /v4/spreadsheets/{id}/values/{range}` with the bearer token.

`googleapis` would bring a dependency tree, an auth library that probes the cloud metadata server
by design (the exact SSRF shape `@fundroom/outbound-http` exists to refuse), and a global
`fetch`. Both calls here go through the **injected** guarded fetch; this package never touches
global `fetch` and never imports `undici`.

The scope is `spreadsheets.readonly` and nothing else. A KPI sync pulls a rectangle of cells once
a night: it does not write, and it does not enumerate a Drive.

## It never throws for a remote-side problem

Every refusal is a typed `SpreadsheetFailure` the nightly sweep can record against the connection
row and show to an admin:

| condition | reason |
|---|---|
| token endpoint 400/401/403 (key revoked, API disabled) | `unauthorized` |
| values endpoint 401/403 (the sheet was never shared) | `unauthorized` |
| values endpoint 404 | `not_found` |
| either endpoint 429/503 | `rate_limited` |
| values endpoint 400 (Google could not parse the range) | `malformed` |
| body over the cap, or the guard's `response_too_large` | `too_large` |
| any other `OutboundHttpError`, a connection failure, 5xx | `transport` |
| unparseable JSON, no `values` key, a non-scalar cell, a bad PEM, a refused id or range | `malformed` |

The two `unauthorized` cases carry **different** details on purpose. "Google refused the
assertion" and "Google gave us a token and then refused the sheet" are different jobs for the
admin, and the second one is the common case: the detail names the service-account address and
says to share the spreadsheet with it.

`healthCheck()` checks configuration only and performs no I/O. `/readyz` must not go red because
Google is having an afternoon — nothing on a request path talks to Sheets — and an
unauthenticated probe of the token endpoint is a 400 by design, so it would assert nothing.

## Inputs are validated before they reach a URL

The spreadsheet id and the range come from an admin and are interpolated into a path. The id must
match Google's own alphabet (`[A-Za-z0-9_-]{20,100}`) and the range must be A1 notation; anything
else is refused as `malformed` with an actionable detail, before a token is even requested. A
pasted full sheet URL, a `../`, or a second path segment therefore cannot address a different API
method.

## Logging

Ids, counts and HTTP statuses. Never the private key, never the assertion, never the access token,
never a URL carrying one, and never a cell of the sheet.

## Wiring

Give it its **own** `createOutboundHttp` — `{ timeoutMs: 10_000, maxResponseBytes: 2 * 1024 * 1024,
maxRedirects: 0 }` — rather than the general-purpose 5 s / 1 MiB one, following the `dnsOutbound`
precedent in `apps/server/src/container.ts`. A sheet read is a slower, fatter call than a webhook
and Google has no business redirecting a request that carries a bearer token.

`SPREADSHEET_DRIVER` selects the driver: `sheets-google` (default) or `noop`, which answers
`{ ok: false, reason: "not_found" }` for every read. `noop` is for an operator who does not want
this process talking to Google at all; `not_found` is chosen over a throw so the sweep records a
typed failure and the admin screen shows the row it already shows for a deleted spreadsheet.
