# @fundroom/integrations

The kernel integrations hub: third-party connections
(`core.integration_connection`), the OAuth 2.0 authorization-code handshake
(`core.integration_oauth_state`), refresh-token rotation, connection health, booking links
(`core.booking_link`) and verified booking webhooks (`core.integration_booking`), and the port
modules use, `ModuleServices.integrations`. The HTTP surface lives in `apps/server`
(`routes/integrations.ts`, `routes/integrations-oauth.ts`, `routes/integrations-webhook.ts`); the
operator guide is [`docs/integrations/README.md`](../../docs/integrations/README.md). The vendors are
stateless adapters behind `IntegrationAdapter` (`@fundroom/ports`), one package each:
`@fundroom/integration-quickbooks`, `-xero`, `-stripe` (KPI sources), `-slack` (chat app),
`-calendly`, `-calcom` (booking).

It is a kernel package and not a module: a connection holds vendor credentials that need the
workspace key and the kernel-only guarded outbound client, the OAuth handshake and the booking
webhook run in the ops tree (no tenant, no session), and turning the hub off would strand live
vendor tokens with nobody able to disconnect them.

## The rules everything else follows from

**No vendor call inside a transaction.** Every path is short tx (read / claim) → vendor call →
short tx that re-locks the connection row *by id* and re-checks it is still live before writing.
A disconnect that lands while the vendor answers therefore wins: the late answer writes nothing
(`tokens.ts` `record`, `store`). A one-connection pool test proves a refresh + read cannot
deadlock.

**Credentials never leave.** Tokens, pasted keys and our webhook signing keys are sealed (SHE1)
under the workspace key of purpose `integration-credentials`, with one `SealedRef` per column in
`encryption`. They are unsealed only into the stack of one vendor call. No view, error, audit row,
log line or redirect carries one; `last_error` is a fixed, vendor-neutral sentence per failure
reason (`policy.failureText`), never a vendor's text. A webhook signing secret is returned once, in
the response that minted it.

**One live connection per (workspace, provider)**, serialised by the advisory lock
`integration.connection:<ws>:<provider>` taken first by connect, the OAuth confirm step, account
choice, secret rotation and disconnect. A reconnect soft-deletes the old row (bookings keep
pointing at it) and, after commit, revokes the old grant best effort — **unless it is the same
vendor account**, whose reconnect usually hands back the same grant (Intuit and Slack would revoke
the new token with the old one).

Lock order: singleton advisory lock → connection row → audit chain (workspace row) → outbox.
Booking ingest: booking advisory lock `integration.bookings:<ws>` → booking rows → outbox. Booking
links: link advisory lock → link rows → audit → outbox.

## OAuth (browser-bound)

1. `beginOAuth` (API, `integrations.manage` + fresh session) inserts a state row with only the
   sha256 of a 32-byte **ticket** (2 minutes) and answers `startUrl =
   ${BASE_URL}/oauth/integrations/start?ticket=…`; the SPA navigates the top-level window there.
   At most 10 open handshakes per member.
2. `startOAuth` (ops route, canonical host only) burns the ticket through the SECURITY DEFINER
   `core.integration_oauth_ticket_claim` (host transaction — the host has no policy on the table),
   mints the OAuth `state`, a **browser nonce** and (PKCE providers) a verifier, stores their
   hashes / the sealed verifier in the workspace's system context, and the route sets the nonce as
   `__Host-sh_intg` (HttpOnly, Secure, SameSite=Lax, 10 minutes; `__Secure-` + `Path=<BASE_PATH>`
   on a path-mounted install).
3. `completeOAuth` consumes the state through `core.integration_oauth_state_claim` (single use,
   10 minutes) and **requires sha256(cookie nonce) = browser_hash** (`browser_mismatch`
   otherwise). That binds start and callback to ONE BROWSER — not to the member who began: the
   start route needs no session, so a start URL mailed to a victim runs start, consent and
   callback in the victim's browser with the victim's vendor account (fix round 1, R1-H1). So the
   callback connects nothing: after the vendor's `error` (`access_denied` → `denied`), the code
   exchange and a `verify` (outside any tx) it seals the grant on the handshake row as PENDING
   (`pending_hash`, `pending_enc`, 10 minutes) and redirects to the workspace's
   `returnPath?integration=<p>&result=pending#pending=<one-time token>` — the token in the
   FRAGMENT (no Referer, no access log) — on the workspace's OPERATOR-controlled origin
   (`workspaceUrl({slug, primaryHost: null})`: tenant subdomain or base URL), never its custom
   domain, whose DNS the workspace owner controls and could point at a server that reads the
   fragment (fix round 2, R2-A1). Error redirects too. Failures redirect with `result=error&reason=…`, audited
   as `integration.oauth_failed`; an unknown/expired state lands on
   `${BASE_URL}/admin/integrations?result=error&reason=expired`.
4. `confirmOAuth` (`POST /integrations/{provider}/oauth/complete`, `integrations.manage` + fresh
   session) burns the pending grant — only for the member who began, for the same provider and
   workspace, before `pending_expires_at`, and only if that member still holds
   `integrations.manage` NOW (re-checked in the kernel, not just the route) — and replaces the
   connection in one tx (`integration.connected`, `integration.connection_changed`). Every refusal
   is 404 `integration_oauth_pending_invalid`. Completing drops the sealed grant and the PKCE
   verifier from the row at once (R3-A1), so a used handshake holds no token material. The victim of a forwarded link has no session in
   the sender's workspace, and the sender never sees the fragment. The grant is marked completed
   only after it unsealed. The hourly sweep claims only unambiguously dead handshakes —
   completed and past `expires_at`, or unconfirmed past `pending_expires_at` (callback + 10 min;
   `expires_at`, begin + 10 min, when the callback never came) — `FOR UPDATE SKIP LOCKED` in the
   tx that deletes them (a confirm holding its row is skipped), and revokes their grants only
   after that commit (R2-A2).

The redirect URI is the same for every workspace: `${BASE_URL}${BASE_PATH}/oauth/integrations/callback`.

## Tokens, refresh and health

`readKpi` forwards `KpiReadRequest.signal` (R3-A2) to the adapter, which passes it to every fetch;
an already-aborted signal answers `{ok:false, reason:"unavailable", detail:"aborted"}` without a
vendor call, and an `aborted` answer never counts against connection health.

`withAuth(ctx, provider, fn)` (behind `readKpi`, `slackChannels`, `slackPost`, `verify`, the
health job): load + unseal in a short tx → refresh first if the access token expires within 60 s →
`fn` outside any tx → on `unauthorized`, one forced refresh and one retry → record the outcome.

Refresh tokens **rotate** (QuickBooks, Xero): a conditional `UPDATE … SET refresh_lease_until =
now() + 30 s WHERE lease free RETURNING` elects one refresher per connection; the vendor call runs
outside any tx; the new token set is stored — never dropping the rotated refresh token — and the
lease cleared in one short tx. Losers poll the row (250 ms, up to 5 s) and use the winner's token.
A crash between the vendor issuing the new refresh token and our store loses it: recovery then
relies on the vendor still honouring the previous refresh token for a grace period (Xero: 30
minutes; Intuit similar) — past that the connection turns `reauth_required`.
A refused refresh (`invalid_grant`, which adapters report as `unauthorized`) marks the connection
`reauth_required` in the tx that releases the lease.

Health (`policy.nextHealth`): success → `active`, 0 failures, `last_error` cleared;
`unauthorized` → `reauth_required` (only a reconnect lifts it); any other failure counts, and the
third in a row → `degraded`; `not_found` (a missing channel or record) is about the request and
changes nothing. Each status transition is audited (`integration.health_changed`), and a move to
`degraded` / `reauth_required` publishes `integration.connection_unhealthy` once.

## Booking

- **Links** (`bookingLinks`): `https://` on one of the adapter's `linkHosts` exactly (no userinfo,
  no port), at most 10 per workspace, audience everyone or 1–50 live groups. A link needs no
  connection. `forMember`: staff see every enabled link; an external member the ones whose
  audience admits one of their groups — a delegate adds its live principal's groups (links are
  workspace-level, not module-scoped). `GET /modules` reports `bookingLinksAvailable`.
- **Webhook** (`ingestBookingWebhook`): the connection is found by id in a host transaction; the
  adapter verifies the signature in constant time with our key (Calendly: 5-minute timestamp
  tolerance; Cal.com signs no timestamp); after the route's post-auth budget, every event of the
  delivery (a reschedule is two) is upserted in one tx by `(provider, external_id)` — a status
  only moves forward (booked → rescheduled → cancelled), so a late `booked` never resurrects a
  cancelled meeting — the invitee is matched to a live member by any of their email identities,
  and `integration.booking_recorded` is published in the same tx. Unknown connection and bad
  signature are the same 401. **The invitee address is self-asserted** (typed on the vendor's
  page, unverified): the member match is informational and grants nothing.
- **Budgets**: per connection 120 authenticated deliveries a minute, 6,000 a minute process-wide.
  Accepted: one tenant's genuine burst can spend the process-wide budget for the rest of a minute
  (others are answered 200 and dropped); records are informational, so no fairness queue.
- **Calendly secret rotation** (R2-A3, R3-A1): serialised per connection by a lease
  (`webhook_rotation_lease_until`, 60 s, claimed like the refresh lease; a second rotation answers
  409 `conflict` `rotation_in_progress`; no DB lock across the vendor calls) with an OWNER
  (`webhook_rotation_lease_token`, a uuid per rotation): extend, clear and every write under the
  lease are conditional on the token; the lease is extended before each vendor call (worst case
  ~15 calls × 15 s outlives 60 s), and a rotation whose lease was taken over aborts (409) without
  writing — its `finally` cannot clear the taker's lease. Calendly allows one
  subscription per callback URL (409 on a duplicate), so on "already exists" the stored
  subscription — or, when none is stored, every one of ours on that URL (`listSubscriptions`) — is
  removed and the new one created; if that fails too, and only if the stored subscription id is
  unchanged since the rotation began, the connection is marked `degraded` with
  `webhook_subscription_lost` (and an unhealthy event), never left on a silently stale secret. A
  later successful rotation heals it.
- **Retention**: 400 days after the meeting (`integrations.retention`, daily 05:25).
- **Erasure** (`erasure.ts`, called from `@fundroom/compliance`): the booking advisory lock and the
  member's rows (by membership or ANY of the user's email identities) are pre-locked before the
  audit chain; the identity step PSEUDONYMISES them (address → `erased+<row hex>@erased.invalid`,
  name, title and membership dropped, `erased_at` set; `integrationBookings` count). The row and
  its `external_id` stay, so a vendor retry — or a Cal.com replay — dedupes against it; ingest
  only ever moves an erased row's status/times, never its personal fields. It also records a
  **suppression** per address (R2-A4, `core.integration_booking_suppression`:
  HMAC-SHA256(workspace key of purpose `integration-booking-suppression`, lower(email)), no
  address stored; lookups hash under every key of the purpose, so rotation is safe); ingest drops
  any event whose invitee address is suppressed, so a NEW booking uid cannot store the erased
  person's address. The suppression is permanent for the workspace (a re-invited member booking
  with the same address is dropped too; there is no un-suppress) and is not carried by
  portability (keyed under the source workspace's key). `@fundroom/compliance` requires the keys as `bookingSuppressionKeys` on
  `ErasureDeps` (`container.envelope`) — every service that can reach erasure takes them, so a
  construction site cannot forget them. **DSAR**:
  `integration-bookings.json`.

## Jobs

| Job | Cron | What |
|---|---|---|
| `integrations.health` | `15 5 * * *` | `verify` every live connection (records health) |
| `integrations.retention` | `25 5 * * *` | delete bookings that started > 400 days ago |
| `integrations.oauth-state-sweep` | `50 * * * *` | delete OAuth handshakes past their 10 minutes (revoking grants nobody confirmed) |

## Layout

- `types.ts` — `IntegrationsKernel`, the deps, views and constants.
- `policy.ts` — pure rules: link URLs, audiences, booking status order, credential checks, Stripe
  key prefixes, health transitions, cursors, PKCE. Unit-tested.
- `vault.ts` — seal / unseal.
- `tokens.ts` — `withAuth`, the refresh lease, health recording.
- `service.ts` — connect, OAuth, verify, account choice, disconnect, secret rotation, webhook
  ingest, links, the register, `services`, jobs.
- `erasure.ts` — the compliance hooks.
- `repos/` — drizzle stays here (`only-repos-touch-drizzle`).
- `testing/` (`@fundroom/integrations/testing`) — `createFakeVendor(provider)`: an in-memory vendor
  with rotating refresh tokens, call counters and a gate, for kernel tests. Never shipped.
