# @fundroom/accred-verifyinvestor

`AccreditationVendorPort` over the [VerifyInvestor.com](https://www.verifyinvestor.com) Regular
API v1. The issuer (workspace) holds the VerifyInvestor account; one port per
workspace connection, stateless. Runtime dependency: `@fundroom/ports` only. Every call goes
through the injected, SSRF-guarded `deps.fetch` (no redirects followed).

Exports `verifyInvestorAdapter` (`AccreditationAdapterDefinition`). `./testing` exports a scripted
fake (`createFakeVerifyInvestor` + `fakeFetch`) and the same fake as a real HTTP server
(`startFakeVerifyInvestor()` → `{ url, vendor, close }`; pass `url` as `deps.apiBaseUrl`).

## Credentials

| key | kind | notes |
|---|---|---|
| `apiToken` | secret, required | sent as `Authorization: Token <apiToken>` |
| `webhookSecret` | secret, optional | without it `parseCallback` refuses everything (polling only) |
| `environment` | `staging` \| `production` | `https://verifyinvestor-staging.herokuapp.com/api/v1` / `https://www.verifyinvestor.com/api/v1` |
| `portalName` | text, optional | requesting party shown to investors; else the workspace name |

## Endpoints used

| Port method | VerifyInvestor call | Confidence |
|---|---|---|
| `verifyCredentials` | `GET /billing?from_date=<today>&to_date=<today>`; on 404 falls back to `GET /api/v1` | inferred (see below) |
| `start` | `POST /verification_request_invitations` `{portal_name?, investors:[{email, suggested_legal_name?, type:"ai"}]}` → `inv:<id>`, or `vr:<verification_request_id>` when already set | documented |
| `check` (`inv:`) | `GET /verification_request_invitations/:id`; once a request exists → `GET /verification_requests/:id`, answer carries `providerRef: "vr:<id>"` | documented |
| `check` (`vr:`) | `GET /verification_requests/:id` | documented |
| `fetchEvidence` | status read as above, then `GET /users/:investor_id/verification_requests/:id/certificate` (`application/pdf`, ≤10 MiB, `%PDF` checked; 404 → `null`) | documented |
| `parseCallback` | `X-Signature-SHA256` = HMAC-SHA256(webhookSecret, raw body); refs `["vr:<verification_request_id>"]` | documented (encoding inferred) |

Handoff is always `{ kind: "invite_sent" }`: VerifyInvestor emails the investor (and re-sends on
days 3 and 10). Status table and date rules are in `src/adapter.ts`.

## Inferred — check against the live staging API before production

1. **Signature encoding**: the docs say "compute the HMAC … and compare" without naming hex or
   base64. The adapter accepts either (and an optional `sha256=` prefix), compared in constant time.
2. **No timestamp** is signed, so a captured callback can be replayed. Harmless by design: a callback
   is only a wake-up and the status is always re-read over the authenticated API.
3. **`verifyCredentials`** uses the billing counter (cheapest authenticated read). If an account lacks
   it (404), the API root is used; whether the root rejects a bad token is undocumented.
4. **Status mapping of lapses**: `accepted_expire` / `declined_expire` (the *request* expired) and
   `self_not_accredited` (the vendor describes it as "accepted then canceled") map to `canceled`, not
   `expired`/`not_accredited` — nothing was decided about the investor.
5. **`verified_expires_at`** is a calendar date; treated as valid through 23:59:59.999 UTC that day.
   This is deliberately conservative: for US investors that moment is still the afternoon/evening
   of the expiry date locally (e.g. 19:59 EDT, 16:59 PDT), so a verification lapses a few hours
   before the vendor's own calendar day ends. Never late, at most ~one business evening early.
6. **`completed_at`** is used as `decidedAt` for accredited / not accredited.
7. **Invitation → request**: the nested `verification_request` of `GET /verification_request_invitations/:id`
   has no investor id, so the adapter re-reads `GET /verification_requests/:id` (which does).
8. **Lapsed invitations**: the docs say invitations expire after 30 days and that the list endpoint
   returns "all active invitations", but document no status/expiry field. `check()` on an `inv:` ref
   therefore answers `canceled` / vendorStatus `invitation_expired` when the invitation answers 404,
   or when it is older than 30 days (`created_at`) with no verification request behind it — so a
   never-answered row stops polling instead of staying pending for 120 days. `fetchEvidence` answers
   `null` for it.
9. `waiting_for_info: true` while under review is reported as `needs_investor_action`.
10. The investor id from the status response is the `:id` in the certificate path (docs example agrees).

## Errors

401/403 `unauthorized`; 404 `not_found`; 409 `conflict`; 429 `rate_limited` (retryable);
5xx / network / timeout `unavailable` (retryable); other 4xx `invalid_request` (with the vendor's
`error` text, sanitised); guard refusals, redirects, non-JSON or oversize bodies `unavailable`
(not retryable). Messages never contain the token, webhook secret or a vendor body we did not bound.
