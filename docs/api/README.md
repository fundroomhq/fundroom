# API keys

FundRoom's REST API (`/api/v1`, described by the OpenAPI 3.1 document in [`packages/sdk/openapi.json`](../../packages/sdk/openapi.json)) is the same API the portal's own web app uses. A browser signs in with a session cookie; a script, a finance system or an automation platform uses a **workspace API key** instead. This page covers keys. For events pushed *to* you, see [webhooks](webhooks.md); for no-code recipes, see [Zapier and Make](zapier-make.md).

- **Base URL**: `https://<your portal>/api/v1` — the same host investors use (a custom domain works too).
- **Auth**: `Authorization: Bearer frk_…`. No cookie, no CSRF token.
- **Server-side only.** A key in a browser bundle, a mobile app or a public repository is a leaked key. Call the API from a server, a scheduled job or an automation platform.

## Creating a key

Owners and admins (permission `api-keys.manage`) create keys under **Settings → API keys** (`/admin/api-keys`). Creating, renaming, rotating and revoking a key are step-up actions: if you signed in more than a few minutes ago the portal asks you to confirm your identity again first.

1. Choose a **name** (1–80 characters, e.g. "Finance KPI sync") and optionally a **note** (up to 500 characters: who owns the integration, where the key is stored).
2. Tick the **scopes** the integration needs — nothing more. You can only grant scopes you hold yourself.
3. Optionally set an **expiry** (in the future, at most two years out). Without one the key lives until it is revoked.
4. Copy the key from the confirmation panel. **It is shown once.** FundRoom stores only a SHA-256 hash of it; nobody, including the operator, can show it again. Lost it? Rotate or create a new one.

A key looks like `frk_` followed by 43 URL-safe base64 characters (47 characters in total). The list shows only its first 12 characters (e.g. `frk_Ab3dE6gH`) so you can tell keys apart. Keys created before the FundRoom rename start `shk_` instead; they keep working unchanged until they expire or are revoked, and rotating one returns an `frk_` key. A workspace can have at most **50 live keys** (not revoked, not expired — a rotated key still in its grace period counts); creating or rotating past that is refused with `409 conflict` (reason `too_many_keys`).

The same operations exist on the API (`GET/POST /api-keys`, `PATCH /api-keys/{id}`, `POST /api-keys/{id}/rotate`, `POST /api-keys/{id}/revoke`, `GET /api-keys/scopes`), but only for a signed-in owner or admin: **a key can never list, create or rotate keys.**

## Using a key

```sh
curl -sS https://investors.acme.com/api/v1/crm/contacts?limit=20 \
  -H "Authorization: Bearer $FUNDROOM_API_KEY"
```

With the typed SDK (`@fundroom/sdk`, Node ≥ 20, Deno, Bun or an edge runtime):

```ts
import { createFundRoomClient, unwrap, FundRoomApiError } from "@fundroom/sdk";

const api = createFundRoomClient({
  origin: "https://investors.acme.com",
  apiKey: process.env.FUNDROOM_API_KEY, // sends Authorization: Bearer, credentials: "omit"
});

const contacts = unwrap(await api.GET("/crm/contacts", { params: { query: { limit: 20 } } }));

// Push this month's KPIs from a finance system (needs the metrics.manage scope).
await api.PUT("/metrics/definitions/{id}/points", {
  params: { path: { id: mrrDefinitionId } },
  // Decimals travel as strings, never JSON numbers.
  body: { periodKind: "month", points: [{ periodKey: "2026-09", value: "184000.00" }] },
});
```

The SDK refuses an `apiKey` when it detects a browser (`window` and `document` defined) unless you pass `dangerouslyAllowBrowser: true`, and it never sends cookies with a key. `unwrap()` throws `FundRoomApiError` with `code`, `status`, `requestId` and the error `body`.

Never send a session cookie and a key on the same request: that is refused with `400 validation_failed` (reason `ambiguous_credentials`) rather than guessing which one you meant. An `Authorization: Bearer` value that does not start with `frk_` (or the pre-rename `shk_`) is ignored (it is not an API key).

## What a key can do

**A key acts as the member who created it, capped by its scopes.** On every request the effective permissions are

```
the key's scopes  ∩  the permissions of the creator's CURRENT role
```

and the creator's membership must still be live. Everything the key does is audited as that member, with the key's id recorded on each audit entry (`meta.apiKeyId`), so the audit log shows both *who* and *which integration*.

Consequences worth planning for:

- **The creator is demoted** (e.g. admin → viewer): scopes the new role lacks stop working at once (`403 forbidden`, reason `scope_missing`); the rest keep working.
- **The creator leaves, is suspended or their membership expires**: the key stops working at once (`401 unauthenticated`, reason `invalid_api_key`), and an hourly sweep revokes it (status "revoked", reason `creator_inactive`). If you erase a member's personal data, their keys are revoked too (`erased`).
- So create long-lived integration keys from an account that will stay, and rotate a departing colleague's keys *before* removing them: the rotated key belongs to whoever rotates it.

### Scopes

Scopes are permission names from the RBAC catalogue — the same ones listed in [`docs/authz-matrix.md`](../authz-matrix.md) ("Permissions by staff role"). Only permissions that at least one key-callable route requires can be chosen; `GET /api-keys/scopes` returns them with `held: true|false` for the signed-in member. Scopes are fixed when the key is created: to change them, create a new key and revoke the old one.

| Scope | Lets a key |
|---|---|
| `access.read` | list people and groups, read one person (`/access/people`, `/access/people/{id}`, `/access/groups`) |
| `audit.read` | search the audit log (`/audit/events`) |
| `crm.read` / `crm.manage` | list and read contacts / create and update contacts |
| `data-room.read` | read a document's versions, the Q&A inbox and one question |
| `data-room.qa_manage` | log a question into the Q&A inbox (e.g. one that arrived by email) |
| `esign.read` | list e-signature envelopes and read one (`/esign/envelopes`, `/esign/envelopes/{id}`): status, purpose, signer name and email, what they are about (`subject`) and whether a signed copy exists. Signed PDFs themselves are not key-callable ([e-signature guide](../esign/README.md#the-api)) |
| `metrics.read` / `metrics.manage` | read metric definitions, points, the grid and import status / write points, write the grid, run an import |
| `round.read` | list rounds, a round's commitments and its indications of interest, and a round's closing checklist (`/round/rounds/{id}/closing`: per commitment, documents sent / signed / wired / confirmed and its signature request) |
| `updates.read` | list investor updates and read one |
| `webhooks.read` | read the webhook delivery log and one delivery with its payload (`/webhooks/deliveries`, `/webhooks/deliveries/{id}`) — useful to reconcile missed events from a poller |

### Which routes accept a key

A key can call **only** routes whose matrix row is marked `apiKey: true` — the "API key" column in [`docs/authz-matrix.md`](../authz-matrix.md), which is generated from `packages/authz/matrix/authz-matrix.yaml` and is the authoritative list. In the OpenAPI document those operations list both security schemes (`session` **or** `apiKey`), and their `x-requires` ends in `+apikey` (e.g. `crm.read+apikey`); every other operation lists `session` only.

A key never:

- calls a route that is not marked, including every route that needs a signed-in member, a step-up confirmation, or owner/admin status (`401`, reason `api_key_not_allowed`);
- sees or manages API keys or webhook endpoints (it can read the delivery log with `webhooks.read`, but not redeliver);
- counts as a "fresh" sign-in, so nothing that needs step-up is reachable with one.

Payloads of [webhooks](webhooks.md) carry ids only; a key with the matching read scope is how you turn an id into details.

## Rate limits

Each key may make **600 requests per 60 seconds**. Over that, the API answers `429 rate_limited` (reason `api_key_rate_limited`) with a `Retry-After` header (seconds) — wait that long and retry. Per-route limits that apply to everyone (imports, exports, …) apply to keys as well. Batch where the API offers it (`PUT /metrics/grid`, `POST /metrics/import`) instead of writing one point per request.

## Errors

Every error has the usual envelope, `{ "error": { "code", "message", "requestId", …details } }`; key-specific causes are in `error.reason`. Branch on `code` and `reason`, never on `message`.

| Status | `code` | `reason` | Meaning |
|---|---|---|---|
| 401 | `unauthenticated` | `invalid_api_key` | The key is malformed, unknown, revoked or expired, belongs to another workspace, or its creator is no longer a live member. Nothing distinguishes these cases on purpose. |
| 401 | `unauthenticated` | `api_key_not_allowed` | The route does not accept API keys (not marked `apiKey: true`, or it needs a signed-in member or step-up), or the request went to the embed rather than the API. |
| 400 | `validation_failed` | `ambiguous_credentials` | The request carried both a session cookie and an API key. Send one. |
| 403 | `forbidden` | `scope_missing` | The route accepts keys, but this key lacks the scope, or its creator no longer holds that permission. |
| 429 | `rate_limited` | `api_key_rate_limited` | More than 600 requests in 60 seconds from this key. Honour `Retry-After` (also `error.retryAfterMs`). |

Quote the `requestId` (also the `X-Request-Id` response header) in a support request.

## Rotation, expiry and revocation

- **Rotate** (`Settings → API keys → Rotate`, or `POST /api-keys/{id}/rotate { "graceHours": 24 }`) mints a new key with the same name, scopes, note and expiry, and shows it once. The old key keeps working for the **grace period** (0–168 hours, default 24) so you can deploy the new one without downtime; with `graceHours: 0` it stops at once. The new key's creator is the member who rotated it, so they must hold every scope it carries. The old key counts toward the 50-live-key limit until its grace period ends, so a workspace at the limit must revoke a key (or rotate with `graceHours: 0`) before rotating.
- **Expiry** is checked on every request: an expired key fails with `invalid_api_key`. The list shows each key's status (`live`, `expired`, `revoked`).
- **Revoke** takes effect immediately and cannot be undone. Revoke a key the moment you suspect it leaked, then create a new one.
- **Last used**: the list shows when each key was last used and from which network (IP truncated to /24 for IPv4, /48 for IPv6), updated at most once a minute. A key unused for months is a key to revoke.

Every create, rename, rotation and revocation (and the sweep's automatic revocations) is in the audit log (`api_key.*`).

## Keeping keys secret

- Store keys in a secret manager or your platform's encrypted variables, never in source control, a URL or a log line.
- The `frk_` prefix exists so secret scanners can recognise a key: this repository's [`.gitleaks.toml`](../../.gitleaks.toml) has a rule for it (`frk_`, or the pre-rename `shk_`, + 43 URL-safe base64 characters), and you can add the same pattern to your own scanner. Webhook signing secrets (`whsec_…`) have one too.
- One key per integration, with the fewest scopes that work, makes revocation cheap and the audit log readable.
