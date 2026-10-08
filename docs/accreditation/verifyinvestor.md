# VerifyInvestor.com

Connect [VerifyInvestor.com](https://www.verifyinvestor.com) (a tZERO company) as the workspace's
accredited-investor verification vendor. FundRoom uses VerifyInvestor's REST API (`/api/v1`) with
an API token, the **Invitation API** to start verifications (VerifyInvestor emails the investor),
and VerifyInvestor's webhook for wake-ups. General behaviour is in the
[accreditation guide](README.md); endpoint-level detail is in the adapter's
[README](../../packages/adapters/accred-verifyinvestor/README.md).

Start on VerifyInvestor's **staging** environment; production has its own token.

## 1. Get API access

API access is gated: ask VerifyInvestor for it (their API documentation names
`accounts@verifyinvestor.com`). You then find the **API token** under **Settings → API Info** in
your VerifyInvestor account — the private API token, not the *User Authorization Token*. Staging
and production are separate accounts with separate tokens. Verifications created through the API
are billed to your (the issuer's) account.

## 2. Connect in FundRoom

**Settings → Accreditation** → vendor **VerifyInvestor.com**:

| Field | Key | Value |
|---|---|---|
| Environment | `environment` | `staging` (`https://verifyinvestor-staging.herokuapp.com/api/v1`) or `production` (`https://www.verifyinvestor.com/api/v1`) |
| API token | `apiToken` | the token for that environment (sent as `Authorization: Token <token>`) |
| Webhook secret | `webhookSecret` | optional; generated under **Settings → API Info** (step 3). Without it callbacks are refused and FundRoom polls only |
| Portal name | `portalName` | optional; the requesting party VerifyInvestor names to the investor. Empty = the workspace's display name |

Save. FundRoom checks the token with a cheap authenticated read (the billing counter for today,
or the API root on accounts without it) before storing anything.

## 3. Webhook (optional but recommended)

In VerifyInvestor, **Settings → API Info**: set the **Webhook URL** to the callback URL FundRoom
shows on the connection

```
<BASE_URL>/webhooks/accreditation/<connectionId>
```

(it appears after the first save), generate a **webhook secret**, and paste it into *Webhook
secret* in FundRoom (leave the API token blank to keep it) and save again.

VerifyInvestor signs each webhook with `X-Signature-SHA256`, an HMAC-SHA256 of the raw body under
that secret; FundRoom accepts the hex or base64 form (an optional `sha256=` prefix is ignored).
The signature carries no timestamp, so a captured webhook could be replayed — harmless here: a
webhook only makes FundRoom re-read the verification from the API. The webhook names a
verification request (`verification_request_id`); FundRoom wakes the verification with that
reference, or, when none matches yet (the investor only just accepted an invitation), the
workspace's verifications still waiting on an invitation.

VerifyInvestor does **not** guarantee webhook delivery. FundRoom polls regardless; the webhook only
makes decisions arrive sooner.

## How a verification runs

1. FundRoom creates an **invitation** for the investor's email (`POST /verification_request_invitations`,
   investor type `ai` — accredited investor — with the portal name and the investor's legal or full
   name as the suggested legal name). The verification's reference is `inv:<invitation id>`, or
   `vr:<request id>` straight away when the investor already has a VerifyInvestor account. Its
   vendor status starts as `invitation_sent`.
2. VerifyInvestor emails the investor; it re-sends on days 3 and 10, and an unanswered invitation
   expires after **30 days**. The portal tells the investor to look for that email.
3. Once the investor has an account and the invitation carries a verification request, FundRoom
   switches the reference to `vr:<request id>` on the next status read.
4. When VerifyInvestor finishes, FundRoom reads the result and, for an accredited investor,
   downloads the **verification certificate** (`GET /users/<investor id>/verification_requests/<id>/certificate`,
   a PDF of at most 10 MiB). A 404 there means "no certificate"; the decision then records the note
   `vendor:verifyinvestor:vr:<id>` instead.

### Status mapping

VerifyInvestor's status word is kept verbatim as the verification's **vendor status**
(`GET /verification_requests/<id>`, field `status`):

| VerifyInvestor status | Port status | What FundRoom does |
|---|---|---|
| (invitation not yet accepted: `invitation_sent`) | needs investor action | keeps it pending |
| `waiting_for_investor_acceptance`, `waiting_for_information_from_investor` | needs investor action | keeps it pending |
| `accepted_by_investor` | in progress | keeps it pending |
| `waiting_for_review`, `in_review` | under review (needs investor action when `waiting_for_info` is set) | keeps it pending |
| `accredited` | accredited | **verified**; expiry = the end (UTC) of `verified_expires_at`, decided at `completed_at` |
| `not_accredited` | not accredited | **rejected** |
| (invitation gone — `404` — or older than 30 days with no request: `invitation_expired`) | canceled | **rejected** — the investor never took it up; they can start again |
| `accepted_expire`, `declined_expire`, `declined_by_investor`, `self_not_accredited` | canceled — the request lapsed or the investor withdrew; no reviewer decided anything about the investor | **rejected** — nothing was decided about the investor, who can start again |
| anything else | unknown | keeps it pending; the vendor status shows the new word |

## Good to know

- **Expiry**: VerifyInvestor returns `verified_expires_at` (a date). A verification letter is
  generally good for about 90 days; FundRoom uses the date VerifyInvestor gives.
- **Renewal** is a new verification request (VerifyInvestor has no in-place renewal): the investor
  renews from the portal, or auto-start opens one (billed).
- **Method**: VerifyInvestor's API does not say *how* it verified (income, net worth, letter); the
  decision records method `third_party`, and the letter says the rest.
- **Production IPs**: VerifyInvestor documents its production webhook source addresses
  (54.173.229.200, 54.175.230.252) if you want to allow-list them at your edge.
- **Entities**: FundRoom sends the same invitation for an individual and for an entity; which
  one the investor is verifying is chosen on VerifyInvestor's side. Check this on staging with an
  entity investor before relying on it.
- Several details were inferred from VerifyInvestor's documentation and not yet exercised against
  a live account — the webhook signature's encoding (hex or base64, both accepted), which lapsed
  statuses mean "cancelled", `verified_expires_at` being a date, the billing read used to check the
  token, and a lapsed invitation answering 404 (FundRoom also treats an invitation older than 30
  days with no request as lapsed). The adapter README lists them; run one
  verification end to end on staging (accredited and not accredited) before going live.
