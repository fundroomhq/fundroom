# @fundroom/accred-parallel-markets

`AccreditationVendorPort` over the [Parallel Markets](https://parallelmarkets.com) (iCapital
Identity Solutions) Server API v2. The issuer (workspace) holds the Parallel
partner account; one port per workspace connection, stateless. Runtime dependency:
`@fundroom/ports` only. Every call goes through the injected, SSRF-guarded `deps.fetch` (no
redirects followed).

Exports `parallelMarketsAdapter` (`AccreditationAdapterDefinition`). `./testing` exports a scripted
fake (`createFakeParallelMarkets` + `fakeFetch`) and the same fake as a real HTTP server
(`startFakeParallelMarkets()` → `{ url, vendor, close }`; pass `url` as `deps.apiBaseUrl`;
letter downloads are served from the same origin under `/secure-files/`).

## Credentials

| key | kind | notes |
|---|---|---|
| `apiKey` | secret, required | `Authorization: Bearer <apiKey>` |
| `clientId` | text, required | JS SDK `client_id`; its redirect URI must be the handoff URL |
| `webhookSigningKey` | secret, optional | base64 key; without it `parseCallback` refuses everything |
| `environment` | `demo` \| `production` | `https://demo-api.parallelmarkets.com/v2` / `https://api.parallelmarkets.com/v2` |

## Endpoints used (OpenAPI v2.1.1 unless noted)

| Port method | Parallel call |
|---|---|
| `verifyCredentials` | `GET /partner-records/file-types` (small static enumeration) |
| `start` (individual) | `POST /partner-records/individuals` `{email, first_name?, last_name?}` → record id |
| `start` (entity) | `POST /partner-records/businesses` `{name: legalName}` → record id |
| `check` | `GET /partner-records/{id}/accreditations` (follows `pagination.next_cursor`, ≤5 pages); `GET /partner-records/{id}` only when there is no submitted attempt |
| `fetchEvidence` | the chosen `current` attempt's `documents[type=certification-letter].download_url`, fetched at once **without** the API key, ≤10 MiB, `%PDF` checked |
| `parseCallback` | `Parallel-Timestamp` + `Parallel-Signature` = base64(HMAC-SHA256(base64decode(key), timestamp + rawBody)); refs `[entity.id]` |

`start` answers `{ kind: "widget", sdk: "parallel-markets", config: { clientId, environment,
requiredEntityId: <record id>, email, firstName?, lastName?, entityType: "self" | "business" } }`;
the round handoff page initialises the JS SDK with it. Status table and attempt selection are in
`src/adapter.ts`.

## Inferred — check against the demo environment before production

1. **`external_id`**: the record-create request schema has no `external_id` (only the JS SDK
   `login()` takes one), so the verification id is not sent to Parallel; correlation is the record id.
2. **Duplicate records**: no conflict answer is documented. On 409/422 for an individual the adapter
   looks up `GET /partner-records/individuals?email=` (wildcard search) and reuses an exact
   case-insensitive email match; otherwise the error surfaces (`conflict` / `invalid_request`).
   That path answers `vendorStatus: "record_reused"` (a fresh record answers `"record_created"`), so
   round can tell a renewal landed on a record that may already hold a current accreditation.
3. **Accreditation pagination**: the endpoint documents `pagination.next_cursor` but no `cursor`
   parameter; `?cursor=<next_cursor>` is assumed as on every other list endpoint.
4. **Which attempt answers**: the most recently certified current attempt (`certified_at`, else
   `created_at`), else the newest by `created_at`. A renewal in progress does not hide a still-valid
   accreditation, and a re-certification with an EARLIER expiry than the old one still wins (it is the
   vendor's latest decision; picking by latest expiry would hide it from round forever).
5. **`indicated_unaccredited_at`** on the record (newer than the latest attempt) is reported as
   `not_accredited` (`vendorStatus: "indicated_unaccredited"`).
6. **Letter host**: `download_url` is assumed to be a storage host with the token in the URL (~30 s);
   no Authorization header is ever sent to it. Plain `http` is refused unless the API base itself is
   `http` (tests). A failed download is `unavailable` and retryable (the retry lists again and gets a
   fresh URL).
7. **Timestamp window**: Parallel says "within the last few seconds"; we allow ±5 minutes. Their 3
   retries run 60 s apart, so even an un-re-signed retry stays inside the window.
8. `decidedAt` = `certified_at` (current) / `rejected_at` (rejected) / `canceled_at` (canceled);
   `expiresAt` reported for current and expired attempts only.
9. The widget for a business record: `required_entity_id` = the business record id with
   `expected_entity_type` from `entityType` — the SDK docs describe this for individuals; the
   business case needs a demo check.

## Errors

401/403 `unauthorized`; 404 `not_found`; 409 `conflict`; 429 `rate_limited` (retryable, vendor limit
100 rps); 5xx / network / timeout `unavailable` (retryable); other 4xx `invalid_request` (vendor
`error` text, sanitised); guard refusals, redirects, non-JSON or oversize bodies `unavailable` (not
retryable). Messages never contain the API key, signing key or a download URL.
