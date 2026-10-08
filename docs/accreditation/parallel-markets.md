# Parallel Markets

Connect [Parallel Markets](https://parallelmarkets.com) (iCapital Identity Solutions) as the
workspace's accredited-investor verification vendor. FundRoom uses Parallel's API v2 with a
partner API key, Parallel's **browser SDK** for the investor's part (Parallel has no server-side
way to start a verification), and Parallel's webhooks for wake-ups. General behaviour is in the
[accreditation guide](README.md); endpoint-level detail is in the adapter's
[README](../../packages/adapters/accred-parallel-markets/README.md).

Start in Parallel's **demo** environment (`demo-api.parallelmarkets.com`); production has its own
keys and client, and Parallel bills the partner per production record.

## 1. Partner account, API key and client

Parallel's API is partner-gated: ask Parallel for a partner account. Then, in the Parallel partner
dashboard (demo and production each have their own):

1. **Developer → API keys**: create an **API key** (it is shown once).
2. Create or open the **client** your investors will sign in through and note its **client id**.
3. Add the FundRoom **handoff URL** as the client's **redirect URI** (step 3 below; it appears on
   the connection after the first save — you can save first and add it right after).

## 2. Connect in FundRoom

**Settings → Accreditation** → vendor **Parallel Markets**:

| Field | Key | Value |
|---|---|---|
| Environment | `environment` | `demo` (`https://demo-api.parallelmarkets.com/v2`) or `production` (`https://api.parallelmarkets.com/v2`) |
| API key | `apiKey` | the key for that environment (sent as `Authorization: Bearer <key>`) |
| Client ID | `clientId` | the client the SDK signs investors in through |
| Webhook signing key | `webhookSigningKey` | optional; from the webhook you create in step 4. Without it callbacks are refused and FundRoom polls only |

Save. FundRoom checks the key with a cheap authenticated read (`GET /partner-records/file-types`)
before storing anything.

## 3. Redirect URI = the handoff URL

The investor's part runs on a FundRoom page that loads Parallel's SDK
(`https://app.parallelmarkets.com/sdk/v2/parallel.js`). Parallel only lets the SDK sign an investor
in from a page whose address is registered on the client, **exactly**. Copy the **handoff URL**
from the connection:

```
<workspace URL>/api/v1/round/current/verification/handoff
```

— the workspace's active custom domain if it has one, else `https://<slug>.<BASE_URL host>` in
multi-tenant mode, else `BASE_URL` (path included) — and add it as a redirect URI on the client.
If the workspace's address changes later (a custom domain goes live), add the new URL too.

## 4. Webhook (optional but recommended)

In the Parallel dashboard, **Webhooks**: create a webhook whose URL is the callback URL FundRoom shows on the
connection:

```
<BASE_URL>/webhooks/accreditation/<connectionId>
```

and paste its **signing key** (base64, as Parallel shows it) into *Webhook signing key* in FundRoom (leave the other secret
blank to keep it). Parallel signs each webhook with the headers `Parallel-Timestamp` (Unix seconds)
and `Parallel-Signature` = base64 HMAC-SHA256, keyed with the base64-decoded signing key, of the
timestamp followed by the raw body. FundRoom refuses a signature whose timestamp is more than **5 minutes**
from its own clock, so a captured webhook cannot be replayed later — and a badly skewed app-host
clock makes every callback fail.

Parallel expects a 200 within 5 seconds and retries three times a minute apart; FundRoom answers
at once. The body only names the record (`entity.id`) and what changed; FundRoom re-reads the
accreditation over the API.

**Parallel sends no webhook when it renews an income-based accreditation within the calendar
year.** FundRoom's pre-expiry re-check catches that and extends the verification in place
([Re-verification](README.md#re-verification)).

## How a verification runs

1. FundRoom pre-creates a Parallel **partner record** ("profile-first") and stores its id as the
   verification's reference; the vendor status starts as `record_created`:
   - an individual: `POST /partner-records/individuals` with the investor's email and name. If
     Parallel refuses a second record for the same email (`409`/`422`), FundRoom reuses the
     existing record with exactly that email and the vendor status starts as `record_reused` —
     that record may already hold a current accreditation, which is then accepted only under the
     [renewal rule](README.md#how-it-works) (it must be certified after any earlier verification
     it would repeat);
   - an entity: `POST /partner-records/businesses` with the entity's legal name (required — a start
     without one fails with `invalid_request`).
2. The portal sends the investor to the handoff page. It starts Parallel's SDK with the client id,
   the environment, the record id (`required_entity_id`), the investor's email and name, and the
   entity type (`self` or `business`); Parallel's own flow takes over: the investor signs in or
   creates a Parallel account and submits their accreditation. For an individual, Parallel requires
   the email to match the pre-created record.
3. When Parallel reports the investor is connected, the page links back to the portal. FundRoom
   learns the outcome by callback or polling (`GET /partner-records/<id>/accreditations`, up to 5
   pages).
4. For an accredited investor, FundRoom downloads Parallel's **certification letter** (the
   `certification-letter` document of the accreditation) at once — Parallel's download links are
   valid for only about 30 seconds — without the API key, over https, at most 10 MiB, and stores it.
   A download that fails is retried with a fresh link.

### Status mapping

A record can hold several accreditation attempts. If any is `current`, the **most recently
certified** one answers (`certified_at`, else `created_at`) — even when an older one would last
longer, so a renewal certified on a shorter-lived basis is reported with its own, earlier expiry;
otherwise the most recently created attempt answers. Its `status` is kept verbatim as
the verification's **vendor status**:

| Parallel status | Port status | What FundRoom does |
|---|---|---|
| (no attempt yet: `no_accreditation`), `unsubmitted` | in progress | keeps it pending |
| `submitter_pending`, `third_party_pending` | needs investor action | keeps it pending |
| `pending` | under review | keeps it pending |
| `current` | accredited | **verified**; expiry = `expires_at`, decided at `certified_at` |
| `rejected` | not accredited (with Parallel's `rejection_reason`) | **rejected** |
| (no submitted attempt, and the record has `indicated_unaccredited_at`: `indicated_unaccredited`) | not accredited — the investor told Parallel they are not accredited | **rejected** |
| `expired` | expired | **rejected** (the attempt lapsed; the investor can start again) |
| `canceled` | canceled | **rejected** (nothing was decided about the investor) |
| anything else | unknown | keeps it pending; the vendor status shows the new word |

The accreditation's `assertion_type` (individuals: `income`, `net-worth`, `evaluator-assertion`,
`professional-license`; businesses: `worth`, `evaluator-assertion`, `accredited-owners`) is kept
with the decision as the vendor's method.

## Testing in demo

In Parallel's demo environment a last name ending in `+` is certified automatically, and one ending
in `-` is rejected, within about 10 minutes — use test investors named that way to exercise both
outcomes end to end.

## Good to know

- **Expiry**: from the accreditation's `expires_at` (Parallel's accreditations are typically valid
  for about 90 days); income-based accreditations are re-issued quietly within the calendar year,
  which the pre-expiry re-check picks up.
- **Renewal** is a new verification: the investor renews from the portal (the handoff page forces
  Parallel to re-check accreditation), or auto-start opens one — and Parallel bills per production
  record.
- **The verification id is not sent to Parallel**: the record-create API has no external id, so the
  record id is the only link between the two. Find a verification in Parallel's dashboard by the
  investor's email or the record id (`providerRef` in `GET /api/v1/round/verifications/{id}`; the admin screen does
  not show it).
- Several details were inferred from Parallel's documentation and not yet exercised against a live
  account — the answer to a duplicate email, accreditation-list pagination, the entity (business)
  flow in the SDK, and the letter download host. The adapter README lists them; run both demo
  outcomes (`+` and `-` last names), for an individual and an entity, before going live.
