# Integrations — operator and admin setup

FundRoom connects to a few third-party services. Each workspace connects its own
accounts from **Settings → Integrations** (`/admin/integrations`); the operator of the install only
registers the OAuth apps once, for everyone.

| Provider | What it is for | How it connects | Operator setup |
|---|---|---|---|
| QuickBooks Online | KPI source (revenue, expenses, net income, cash) | OAuth | register an Intuit app |
| Xero | KPI source (revenue, expenses, net income, cash) | OAuth (PKCE) | register a Xero app |
| Stripe | KPI source (gross/net volume, new customers, MRR, active subscriptions) | pasted **restricted** key | none |
| Slack | notification channel kind `slack_app` (posts as a bot) | OAuth | register a Slack app |
| Calendly | records meetings booked through the workspace's Calendly links | pasted personal access token; webhook subscribed automatically | none |
| Cal.com | records meetings booked through the workspace's Cal.com links | webhook URL + secret pasted into Cal.com | none |

Booking **links** shown on the investor portal (the "Book time" card) need no connection at all:
an admin adds `https://calendly.com/…` or `https://cal.com/…` / `https://app.cal.com/…` URLs under
**Settings → Integrations → Booking links** (at most 10, each for everyone or for chosen groups).
A connection only adds the record of who booked.

Two other kinds of vendor connection live on their own settings pages, not here: e-signature
vendors (**Settings → E-signature**, [docs/esign](../esign/README.md)) and accredited-investor
verification vendors — VerifyInvestor.com and Parallel Markets — (**Settings → Accreditation**,
[docs/accreditation](../accreditation/README.md)).

## How the connections behave

- **Credentials are write-only.** Tokens and keys are encrypted with the workspace key and never
  shown again, returned by the API, logged or put in a URL. A webhook secret is shown once, when
  it is created or rotated.
- **One connection per provider per workspace.** Connecting again replaces the old connection.
  Disconnecting always works; features that used it (metrics sync, Slack channels) then report
  "not connected".
- **Health.** A connection is `active`, `degraded` (three vendor failures in a row; retried, and
  back to `active` on the next success) or `reauth_required` (the vendor refused the token —
  reconnect). Owners and admins are notified when a connection turns unhealthy; the daily health
  check (05:15 UTC) verifies every connection.
- **Every credential-bearing action** (connect, choose account, rotate a secret, disconnect) asks
  the admin to confirm their identity if their sign-in is not fresh.
- All vendor traffic goes through a dedicated outbound client: 15 s per call, 2 MiB per answer, no
  redirects followed, no private addresses (`INTEGRATIONS_ALLOW_PRIVATE_HOSTS` exists for tests
  only; production refuses loopback and wildcards in it).

## The redirect URI (all OAuth providers)

Every OAuth app is registered with exactly one redirect URI, the same for every workspace:

```
${BASE_URL}/oauth/integrations/callback
```

where `BASE_URL` is taken as configured, path included (`https://example.com/portal/oauth/integrations/callback`
on a path-mounted install); it is never rebuilt from `BASE_URL`'s origin plus `BASE_PATH`.
It must be the **canonical** host (`BASE_URL`), never a workspace subdomain or custom domain: the
handshake is answered only there, and the browser-binding cookie (`__Host-sh_intg`) lives on that
origin. After consent the admin is sent back to their workspace's **operator-controlled** address —
`https://<slug>.<your host>/…` in multi-tenant mode, the base URL otherwise — **never its custom
domain**, even when one is active: a custom domain's DNS belongs to the workspace owner, who could
point it at their own server and read the one-time confirmation token. So the admin may be asked
to sign in on that address to confirm (they confirm their identity there anyway).

The flow: the admin clicks **Connect**; the browser is sent to `${BASE_URL}/oauth/integrations/start?ticket=…`
(single use, 2 minutes), which sets a short-lived cookie binding the handshake to that browser and
forwards to the vendor; the vendor returns to the callback, which accepts the answer only from the
same browser. The callback does **not** connect anything yet: it verifies the account and sends
the admin back to their workspace with a one-time confirmation token in the URL fragment, and the
admin confirms there ("Connect this account to this workspace?"). Only the admin who started it,
signed in to that workspace and still allowed to manage integrations, can confirm, within 10
minutes. So a start link forwarded to someone else — even one who consents at the vendor — can
never put their vendor account into the sender's workspace. A handshake that never reaches the
callback expires 10 minutes after it began; a grant waiting for confirmation lives 10 minutes
after the callback. The hourly sweep revokes (at the vendor) only grants that are past that
point and unconfirmed, and never touches one a confirmation is holding.

The binding cookie is `__Host-sh_intg` (Secure) on an https install or `localhost`;
`__Secure-sh_intg` with the base path on a path-mounted install; and a plain `sh_intg` without
`Secure` only when `BASE_URL` is plain `http://` on another host (browsers would drop a Secure
cookie there). Run production over https.

## Environment

| Variable | Meaning |
|---|---|
| `INTEGRATIONS_QUICKBOOKS_CLIENT_ID` / `_SECRET` | the Intuit app's keys; both or neither |
| `INTEGRATIONS_QUICKBOOKS_ENVIRONMENT` | `production` (default) or `sandbox` (Intuit development keys and sandbox companies) |
| `INTEGRATIONS_XERO_CLIENT_ID` / `_SECRET` | the Xero app's keys; both or neither |
| `INTEGRATIONS_SLACK_CLIENT_ID` / `_SECRET` | the Slack app's keys; both or neither |
| `INTEGRATIONS_ALLOW_PRIVATE_HOSTS` | tests only: hosts the integrations client may reach on private addresses |

Each `*_SECRET` may also be given as `*_SECRET_FILE` (a path). A provider whose pair is unset is
shown to workspaces as "not configured by the operator" and cannot be connected; setting only one
half of a pair is a startup configuration error.

## QuickBooks Online

1. At [developer.intuit.com](https://developer.intuit.com) create an app with the **Accounting**
   scope (`com.intuit.quickbooks.accounting`).
2. Under **Keys & credentials** (development and production each have their own): add the redirect
   URI above.
3. Set `INTEGRATIONS_QUICKBOOKS_CLIENT_ID` / `_SECRET`. Use `INTEGRATIONS_QUICKBOOKS_ENVIRONMENT=sandbox`
   with the development keys (sandbox companies only). Production keys need Intuit's app
   assessment.
4. PKCE is **off** for QuickBooks (a confidential client with a secret). Refresh tokens rotate on
   every refresh; FundRoom stores each new one before using it (one refresh at a time per
   connection). If the process dies between the vendor issuing a new refresh token and FundRoom
   storing it, the stored (old) token is only still usable within the vendor's grace period for
   a rotated token (Intuit and Xero both honour the previous refresh token for a while — Xero
   30 minutes); past that the connection turns `reauth_required` and must be reconnected.

What FundRoom reads: the Profit and Loss and Balance Sheet reports, by month. It never writes.

## Xero

1. At [developer.xero.com](https://developer.xero.com/app/manage) create a **Web app**.
2. Add the redirect URI above.
3. Set `INTEGRATIONS_XERO_CLIENT_ID` / `_SECRET`.
4. Scopes requested: `openid offline_access accounting.reports.profitandloss.read
   accounting.reports.balancesheet.read accounting.settings.read` — the **granular** report scopes
   (apps created after 2 March 2026 cannot request the old broad `accounting.reports.read`).
   PKCE is **on** for Xero.
5. Xero has no separate sandbox: use the **Demo Company** to try it.

A Xero grant may cover several organisations. After connecting, the admin picks one under
**Choose organisation** (FundRoom lists the ones the grant covers and accepts only those). Refresh
tokens rotate, as for QuickBooks.

## Slack

1. At [api.slack.com/apps](https://api.slack.com/apps) create an app (from scratch).
2. **OAuth & Permissions** → Redirect URLs: add the redirect URI above. Bot token scopes:
   `chat:write`, `chat:write.public`, `channels:read`.
3. **Basic Information** → App credentials: set `INTEGRATIONS_SLACK_CLIENT_ID` / `_SECRET`.
4. For workspaces other than your own, enable **Manage distribution** (public distribution) so other
   Slack workspaces can install it.
5. PKCE is **off** (Slack PKCE makes the app a public client; FundRoom is a confidential client).

A connected Slack app appears as a notification channel kind in **Settings → Notifications**; the
incoming-webhook kind stays available and needs no app. Posts carry the same fixed text as the
webhook kind.

## Stripe (per workspace)

Stripe connects with a **restricted key** only — a full secret key (`sk_…`) is refused, because
FundRoom needs to read a handful of objects and must never be able to move money.

1. Stripe Dashboard → **Developers → API keys → Create restricted key**.
2. Grant **Read** on: Balance, Balance transactions, Customers, Subscriptions, Prices, and account
   details (Connect/Account read). Leave everything else at **None**. (Gross and net volume are
   computed from balance transactions, so the Charges resource is not needed.)
3. Paste the key (`rk_live_…`, or `rk_test_…` for test mode — the environment follows the prefix)
   into **Settings → Integrations → Stripe**. FundRoom checks it against Stripe before storing it.

## Calendly (per workspace)

1. Calendly → **Integrations & apps → API and webhooks → Personal access tokens**: create a token
   with the scopes `users:read`, `scheduled_events:read`, `webhooks:write`. Webhooks need a paid
   Calendly plan.
2. Paste it into **Settings → Integrations → Calendly**. FundRoom verifies it and creates the
   webhook subscription itself (events `invitee.created` and `invitee.canceled`, signed with a key
   FundRoom generates). Nothing to paste into Calendly.
3. Rotating the webhook secret re-subscribes with the new key and removes the old subscription.
   Calendly allows only one subscription per callback URL, so FundRoom removes the old one first
   when Calendly says the URL is taken (and, if it lost track of which one is ours, finds ours by
   URL and removes those); if Calendly then refuses the new one too, the connection turns
   **degraded** with the error "webhook_subscription_lost" (bookings are not recorded until you
   rotate again or reconnect) — never a silently stale secret. One rotation runs at a time per
   connection: a second click while one is running answers "rotation in progress, try again". A
rotation that takes longer than its lease (a slow Calendly) and is overtaken by another stops
without writing anything, so the newer rotation's result stands.
   Deliveries Calendly signs with the new key in the second or so before the rotation is stored
   are refused once (Calendly retries them). Disconnecting removes the subscription.

Deliveries older than 5 minutes (by their signed timestamp) are refused, so a captured delivery
cannot be replayed later.

## Cal.com (per workspace)

Cal.com needs no credential in FundRoom: the connection is our webhook secret.

1. **Settings → Integrations → Cal.com → Connect**. Copy the **webhook URL**
   (`${BASE_URL}/webhooks/integrations/<id>`) and the **secret** shown once.
2. In Cal.com: **Settings → Developer → Webhooks → New**: paste the URL as the subscriber URL and
   the secret as the secret; enable the triggers **Booking created**, **Booking cancelled** and
   **Booking rescheduled**; save.
3. If the secret is lost, **Rotate webhook secret** in FundRoom and paste the new one into Cal.com
   (the old one stops working at once).

## What is recorded about bookings

For a verified booking webhook FundRoom keeps the meeting's start and end, its name, the
invitee's email and name, and the status (booked, rescheduled, cancelled), matched to a member
when the invitee's email is one of a member's addresses. The CRM module logs it as contact
activity.

**The match is informational, not proof of identity.** The invitee's address is whatever the
person typed on the vendor's booking page; the vendor does not verify it, so anyone can book "as"
a member's address. Nothing in FundRoom grants access or trust because of a booking.

Records are kept 400 days after the meeting. When a member is erased, their bookings — by
membership and by every email address they had — are pseudonymised (the address becomes an
`erased+…@erased.invalid` tombstone, name and meeting title are dropped); the row stays so that a
vendor's retry of the same event is recognised instead of recording the person again. Each of
their addresses is also added to a suppression list (a keyed hash under the workspace's key — the
address itself is not kept), and any later booking event for a suppressed address, even a brand-new
meeting, is dropped rather than stored. The suppression is **permanent** for that workspace: if the
person is invited again later and books with the same address, those bookings are not recorded
either (there is no un-suppress; use a different address). Suppressions are **not carried** by a
workspace export/import (they are keyed hashes under the source workspace's key), so an imported
workspace starts without them. Until erasure, bookings are in the member's data export
(`integration-bookings.json`).

The webhook answers `401` to an unknown connection or a bad signature (one answer for both), `413`
past 256 KiB, and `200` otherwise — including when a burst exceeds the budget, so the vendor never
disables the subscription. The budgets are 120 authenticated deliveries a minute per connection
and 6,000 a minute per process across all connections. **Accepted limitation:** one tenant's
genuine deliveries (for example a mass reschedule on a busy Calendly account) can use up the
process-wide budget for the rest of that minute; other tenants' deliveries in that window are
answered 200 and dropped. The per-connection cap keeps any single connection to 2% of it, and
booking records are informational (nothing depends on them in real time), so no per-tenant
fairness queue was added.

## Sub-processors

Each provider's page in **Settings → Integrations** shows its sub-processor facts (name, purpose,
region, DPA link) before connecting; a workspace that connects one should list it in its own
sub-processor register.
