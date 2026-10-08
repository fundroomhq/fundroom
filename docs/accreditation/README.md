# Accredited-investor verification

A company raising under **Rule 506(c)** has to take reasonable steps to verify that each purchaser
is accredited, and keep the proof. FundRoom opens a **verification** for every investor whose
interest needs one (the eligibility table in [`modules/round/README.md`](../../modules/round/README.md#the-eligibility-table)).
It can be settled two ways:

- **Manual review** (the default): the investor uploads evidence, a staff member reads it and
  records a decision.
- **A verification vendor** the workspace connects: **VerifyInvestor.com** or **Parallel
  Markets**. The vendor collects the documents, reviews them and issues its own letter; FundRoom
  follows the verification to its outcome, records the decision and keeps a copy of the vendor's
  certificate.

This guide is for the workspace admin who connects a vendor and for the operator who runs the
install. Step-by-step vendor setup is on one page per vendor ([VerifyInvestor](verifyinvestor.md),
[Parallel Markets](parallel-markets.md)); what to do when something goes wrong in production is in
the [accreditation runbook](../runbooks/accreditation.md).

FundRoom never decides that anybody is accredited on its own: with manual review a person decides,
and with a vendor the vendor does. It talks to the vendor's HTTP API with the workspace's own
credentials — the vendor account, and its per-verification fee, belong to the company.

## Read this first: what a vendor verification is, legally

> **Not legal advice.** Have your securities counsel confirm how you rely on a vendor before you
> accept 506(c) money on the strength of one.

- A vendor's "accredited" answer is **evidence of the reasonable steps you took**, typically in the
  form Rule 506(c)(2)(ii)(C) describes — a written confirmation from a registered broker-dealer,
  SEC-registered investment adviser, licensed attorney or CPA that it verified the purchaser within
  the prior three months. It does not move the obligation to the vendor: **the issuer remains
  responsible** for verification, for not accepting a purchaser it has reason to believe is not
  accredited, and for keeping the record.
- FundRoom records such a decision with method `third_party`, no staff decider, and the vendor as
  the decider (`decidedByProvider`). The kernel's `accredited` attestation carries the same facts.
  Anyone reviewing the round later can see that a vendor, not a colleague, made the call.
- The vendor's certificate PDF is kept **only as long as the workspace keeps verification evidence**
  (`evidenceRetentionDays`, 90 days after the decision by default; see [What is stored](#what-is-stored)).
  If your counsel wants the letter kept longer, raise that setting or file the letter elsewhere; the
  vendor also keeps its own copy under its own retention.
- A vendor's expiry date is not a legal safe harbour. FundRoom uses it to decide when a verification
  stops counting (below); whether a verification that is still "valid" here is recent enough for a
  particular sale is a question for counsel.

## How it works

```
investor submits interest (506(c), verification needed)
        │
        ▼  in the same transaction
verification `pending`  ── provider = the workspace's live vendor, else `manual`
        │
        ▼  round.verification_start (job, after commit)
vendor start ──▶ handoff: VerifyInvestor emails the investor │ Parallel: widget page in the portal
        │
        ▼  round.verification_sync — after every callback, and on a schedule
vendor status re-read over the API
        │
        ├── accredited      ──▶ certificate downloaded, scanned, encrypted ──▶ `verified`
        ├── not accredited  ──▶ `rejected`
        └── still working   ──▶ next check later (5 min, 15 min, 1 h, 6 h, 1 day, then daily)
```

1. **Start.** When an investor's interest needs verification, the verification row is created in the
   same transaction as the interest, with the provider the workspace uses *at that moment*: its
   live vendor connection, or `manual` without one. A vendor is never called inside a database
   transaction; a job (`round.verification_start`) starts the vendor verification right after
   commit and stores the vendor's reference and **handoff** (how the investor continues):
   - **VerifyInvestor** emails the investor an invitation (the portal says "check your email");
   - **Parallel Markets** has no server-side start: the portal sends the investor to a
     FundRoom page that loads Parallel's JavaScript SDK (the [handoff page](#the-handoff-page-parallel-markets)).

   A start that keeps failing gives up: after 3 failed attempts, at once for an error retrying
   cannot fix, and after one more try when the vendor was unreachable or timed out twice in a row
   (a timed-out VerifyInvestor call may still have sent the invitation, and FundRoom cannot look
   it up, so the investor is not invited three times). Each attempt holds a 10-minute lease so a
   redelivered job cannot start the vendor twice; a start that never ran (a stalled queue) is
   re-queued by the 15-minute sweep, and after 5 attempts in all it gives up with `start_timeout`.
   A start for a member who is no longer active (revoked, suspended) gives up at once
   (`member_inactive`), without calling the vendor. A verification that gave up stays `pending`
   with vendor status `start_failed` and the reason as its vendor error; it is not polled, and the
   investor is told the company will be in touch. Fix the cause, then **Check now** on that
   verification runs the start again — or decide it manually.

   An investor has at most one pending verification: a second interest submission under 506(c)
   reuses the pending one instead of opening another.
2. **Poll and callback.** FundRoom re-reads the vendor's status on a schedule — 5 minutes after
   the start or the last change, then 15 minutes, 1 hour, 6 hours, 1 day, and daily after that —
   and **immediately** when the vendor sends a callback. A callback is only a wake-up: its body is
   never believed, only the status read back over the authenticated API. A verification still
   pending after **120 days** stops being polled; an admin decides it. **Check now** on the
   verification (admin, `round.manage`) queues a status read at once.
3. **Decide.** The vendor's answer is applied only to a verification that is still `pending`:
   - **accredited** → `verified`, method `third_party`, decided by the vendor. The decision time
     (`decidedAt`, which starts the evidence-retention clock) is when FundRoom recorded it; the
     vendor's own certification date is kept as `vendor_decided_at` and in the audit entry's
     `vendorDecidedAt`, and bounds the expiry. FundRoom downloads
     the vendor's certificate PDF at that moment (Parallel's download links expire within seconds),
     virus-scans it and stores it encrypted exactly like an uploaded document. When no certificate
     is available the decision records the note `vendor:<driver>:<reference>` instead, so the
     "verified needs evidence" rule still holds. The kernel's `accredited` attestation is written in
     the same transaction.
   - **not accredited** → `rejected`, with the vendor's rejection reason (if it gives one) as the
     decision note. A request the vendor **cancelled or let lapse** (VerifyInvestor: the investor
     declined or never answered; Parallel: `canceled`, `expired`) is also closed as `rejected` — it
     says nothing about the investor, who can simply start again.
   - an answer that needs the investor (documents requested, invitation not yet accepted) or the
     vendor's reviewers keeps it `pending`; the admin screen shows the vendor's own status word
     (`vendorStatus`, verbatim).

   Every vendor decision is audited as `round.verification_synced` (system actor) and published as
   `round.verification_decided`. Any decision — vendor or staff — strips the stored handoff down
   to its kind (a Parallel widget configuration holds the investor's email and name). Uploading
   evidence to a vendor verification is refused (`409`).

   **A renewal must be a new certification.** A vendor may answer a renewal with the accreditation
   it already reported. When the new verification shares the vendor reference of an earlier
   verified or expired one with the same vendor, an "accredited" answer is accepted only if the
   vendor certified it **after** the earlier decision (or, with no certification date, if the
   vendor's own expiry is later than the earlier one's). When it renews a verification of another
   provider or reference (manual → Parallel, VerifyInvestor → Parallel), it is accepted outright
   if the earlier one has lapsed, else only if it stands until later. Otherwise the answer is held:
   the verification stays `pending` with vendor error `renewal_not_recertified` and polling goes on.

   **A staff decision always wins.** An admin can decide a vendor verification by hand at any time
   (for example when the investor went through the vendor for another issuer and sent you the
   letter); a vendor answer that arrives later is ignored.
4. **Expiry.** The expiry date comes from the vendor. It is kept within (decision, decision + 12
   months]; a vendor that gives none gets **90 days**; a vendor answer whose expiry has already
   passed is not recorded as verified (the verification becomes `expired`). A verified row whose
   date passes turns `expired` in the nightly lifecycle job. The investor is told
   (`round.verification_decided` with status `expired`) only when the row ran out within the last
   **7 days** and no other **verified** verification of theirs stands at least as long — so the
   backlog of old rows the first run after an upgrade expires sends no mail, and a pending
   (auto-started) renewal does not stop the notice. Silent expiries are still audited
   (`round.verification_expired`, meta `superseded`, `notified`).

Investors are emailed when their verification is decided and before it expires (next section);
staff holding `round.manage` are alerted when a verification is requested, as before.

### Re-verification

Accredited status is a point-in-time fact, so verifications expire. The nightly job
`round.verification_lifecycle` (05:10 UTC) does four things for every workspace:

- **Re-check before expiry (renew in place).** A vendor verification inside the reminder window
  (and not read from the vendor in the last 20 hours; at most 50 per workspace per run; never for
  an erased investor) is read again. If the vendor still says accredited and names its **own**
  expiry, later than the current one (after the same clamping), the same verification is
  extended, a fresh kernel attestation with the new expiry is recorded, and it is audited
  `round.verification_renewed` — Parallel Markets renews income-based accreditation quietly
  within a calendar year and sends no callback for it, so this is how FundRoom notices.
- **One reminder** per verification, **`reminderDays` before expiry** (default 14): the investor
  gets an email that their verification expires soon (`round.verification_expiring`; the email
  gives no date), with a link to the portal, where they can renew. No reminder is sent for a
  verification superseded by another of the same investor that is newer and pending or verified,
  or verified until the same or a later date.
- **Expire** verified rows past their date (above).
- **Auto-start** (off by default): when `autoStart` is on *and* the workspace has a vendor
  connection, the job opens a new vendor verification for every reminded, not-superseded,
  verified row inside the reminder window that no verification renews yet — so an investor who
  was busy on the night, or a workspace that turned auto-start on after the reminder, still gets
  one — linked to the old one (`reverificationOf`). It skips investors who have one pending, are
  erased or are not active members, and never starts from a renewal whose expiry was not later
  than the verification it renewed. Auto-started verifications count against the workspace's
  **50 vendor verifications an hour** (below); the job stops at the budget (log
  `round.verification_autostart_budget`), and an investor start racing it can overshoot by a few.
  Manual-review workspaces never auto-start.

> **Auto-start costs money.** The vendor bills the company for every verification it starts,
> whether or not the investor still intends to invest. With auto-start on, every investor whose
> verification is nearing expiry gets a new one — including investors who have long since invested
> or walked away. Leave it off unless you are running a long raise and want everyone kept current;
> otherwise let investors renew themselves from the portal when they next commit.

Both settings are in **Settings → Round** (`/admin/round/settings`), **Re-verification** card
(`round.reverification.reminderDays`, 1–60; `round.reverification.autoStart`). Changing them is a
step-up action, like every round setting.

**Renewing from the portal.** The round page's **Accreditation verification** card offers a new
verification (`canRenew`) when the investor has none pending and their latest one is absent,
rejected, expired, or verified but within `reminderDays` of its expiry. It opens a verification with
the workspace's current provider (`POST /round/current/verification`). While one is pending,
starting another is refused with `409 conflict` (`reason: verification_pending`, the pending one in
the body); while the latest is verified and not yet near expiry, with `409 conflict`
(`reason: conflict`, its `expiresAt`) — a vendor would bill for a verification nobody needs.

Starts are budgeted, because each vendor verification is billed: **5 an hour and 10 a day per
member**, spent only when a verification is actually opened (a refused or conflicting request costs
nothing), and **50 vendor verifications an hour per workspace**, counted over every vendor
verification opened in the last hour (interest submissions, portal starts and auto-start alike).
Past either, `429 rate_limited` with `Retry-After`.

## Choosing a vendor

From each adapter's declared metadata (`GET /accreditation/providers`):

| | VerifyInvestor.com | Parallel Markets |
|---|---|---|
| Operator | VerifyInvestor.com, LLC (a tZERO Group company) | Parallel Markets (iCapital Identity Solutions) |
| How the investor starts | an **email invitation** from VerifyInvestor, with your portal name | a **widget** from Parallel's JavaScript SDK, opened from the portal |
| Entities (LLCs, trusts, funds) | yes — the same invitation; the investor chooses on VerifyInvestor | yes — a business record, the entity's legal name required |
| Certificate PDF kept | yes (verification letter) | yes (certification letter) |
| Callback signature | `X-Signature-SHA256` HMAC of the body, no timestamp | `Parallel-Signature` HMAC over timestamp + body |
| Environments | `staging`, `production` | `demo`, `production` |
| Account | request API access from VerifyInvestor | partner account with Parallel (partner-gated) |

Both bill the issuer per verification; prices are a matter between you and the vendor.

The operator decides which vendors workspaces may connect with `ACCREDITATION_DRIVERS`
([below](#operator-settings)).

## Connecting a vendor

Owners and admins (`accreditation.manage`) connect under **Settings → Accreditation**
(`/admin/accreditation`); `accreditation.read` (owner, admin, legal) can see the connection. Saving,
re-verifying and disconnecting are step-up actions.

1. Pick the vendor. The form shows that vendor's credential fields (listed on its page).
2. Save. The credentials are **verified live** against the vendor before anything is stored. A
   missing or malformed field is `422 accreditation_credentials_invalid` naming the `fields`; a
   vendor that refuses the credentials is the same code with the vendor's `reason`
   (`unauthorized`, `invalid_request`, `not_found`); a vendor that cannot be reached or fails is
   `502 accreditation_provider_error` (`providerCode`). Credentials are sealed (encrypted with a
   per-workspace key, purpose `accreditation-credentials`) and never shown again: the screen shows
   only hints. Re-saving the **same** vendor keeps a secret left blank and a plain field left out;
   an optional field (the webhook secret, the portal name) is removed only by clearing it
   explicitly.
3. Copy the **callback URL** into the vendor's webhook settings, and — for Parallel Markets — the
   **handoff URL** into the Parallel client's redirect URIs (both are shown on the connection).
4. **Verify** re-checks the credentials at any time and records the result (`lastVerifiedAt`,
   `lastError`, status `active` / `error`); a vendor that cannot be reached answers `502` and leaves
   the connection as it was. A vendor call refused as unauthorised during normal work also sets the
   connection to `error`, and so do credentials FundRoom can no longer unseal (`lastError` asks
   you to save them again). A connection in `error` is still the one new verifications use — fix
   its credentials rather than expecting FundRoom to fall back to manual review.

A workspace has **at most one** live connection. From the moment it is saved, **new**
verifications use that vendor; verifications already open keep the provider they were opened with.
At most 10 save attempts per workspace per hour, refused ones included — each is a live vendor
call (`429 rate_limited` with `Retry-After`).

### Switching vendors or disconnecting strands pending verifications

A verification belongs to the vendor it was started with. When the workspace's live connection
changes to another vendor, or is disconnected:

- **pending vendor verifications stop being followed** at their next status read: the vendor error
  shows `connection_changed` and polling stops. An admin decides each one by hand (**Round →
  Verifications**) — for example after asking the investor for the old vendor's letter. The
  investor cannot open another verification while that one is pending; once it is decided (say,
  rejected with a note), they can, and the new one uses the current provider;
- verifications already decided are not touched: their decisions, dates and kept certificates
  stay.

Re-keying the **same** vendor (a new API key, a new webhook secret) keeps the connection, its id
and its callback URL. Moving the same vendor from its sandbox to production is also a re-key, but
verifications started in the sandbox cannot be followed with production credentials — the vendor
will not know them. Finish or decide them first.

Disconnecting (`DELETE /accreditation/connection`) makes new verifications manual again.

### The callback URL

```
<BASE_URL>/webhooks/accreditation/<connectionId>
```

It is per connection, outside `/api/v1`, and served on the install's canonical `BASE_URL` (as
configured, path included, without a trailing slash; not a workspace custom domain). It must be
reachable from the vendor's servers. Paste it into the vendor's dashboard as its page describes,
together with the webhook secret the vendor gives you (VerifyInvestor) or the signing key it generates (Parallel), which you paste back into FundRoom.

**Callbacks are optional.** Without a webhook secret in the connection, FundRoom refuses every
callback (it cannot tell a real one from a forged one) and relies on polling alone: decisions
arrive within the polling schedule instead of within seconds.

| Answer | When |
|---|---|
| `200` | authentic — including for a verification FundRoom does not know (the URL reveals nothing) |
| `401` | not authentic, unsigned, no secret configured, or the connection is unknown or deleted — one answer for all, and every refusal costs the same HMAC over the body, so the answer and (approximately) its timing do not reveal which. Counted as `fundroom_security_events_total{event="accreditation_callback_rejected"}` |
| `413` | body over 256 KiB |
| `200`, nothing queued | over budget: more than 120 authenticated callbacks a minute for one connection, or 6,000 for all connections together (per process), or past the pre-authentication ceiling (30,000 a minute). Never a 429, so a vendor does not give up on the URL; polling picks the verification up |
| `500` | ingestion failed; the vendor retries |

### The handoff page (Parallel Markets)

Parallel Markets starts a verification only from its browser SDK. FundRoom serves a small page
for that, on the workspace's own address:

```
<workspace URL>/api/v1/round/current/verification/handoff
```

where the workspace URL is its active custom domain if it has one, else
`https://<slug>.<BASE_URL host>` in multi-tenant mode, else `BASE_URL` (path included). The
connection shows the exact value as **handoff URL**. **Register it in the Parallel client as a
redirect URI, exactly** — Parallel refuses a login from a page whose address is not registered. If
the workspace's address changes (a custom domain is activated or moved), register the new handoff
URL too.

The page is signed-in only (the investor's own pending verification; `404` otherwise), is never
cached, sends no referrer, and has its own content security policy that admits only Parallel's
SDK, frames and styles. It opens Parallel's overlay with `force_accreditation_check`, so a
returning Parallel user is asked to confirm a current accreditation. It refuses to be framed
(`frame-ancestors 'none'`), so it does not load inside an embedded portal; an investor in an embed
completes a Parallel verification from the portal's own address. When Parallel reports the
investor is done, the page links back to the portal; it tells FundRoom nothing — the result
arrives by callback or polling.

## What is stored

| What | Where | For how long |
|---|---|---|
| Vendor credentials (API key/token, client id, webhook secret) | `core.accreditation_connection`, sealed under the workspace's key; only hints are ever returned | until disconnected (soft delete) or the workspace is deleted (crypto-shredded) |
| The verification: provider, vendor reference, vendor status word, vendor error, last check, next check, decision (when recorded, and the vendor's own date `vendor_decided_at`), method, decider (`decidedByProvider`), expiry, reminder sent, the verification it renews | `round.verification` | kept with the round's records; the vendor reference is the key to the vendor's own file |
| How the investor continues (handoff: invitation sent, or the widget's client id, environment, pre-created record id, the investor's email and name) | `round.verification.handoff` | while the verification is pending: any decision, and the investor's erasure, cut it down to its kind (`widget`, `invite_sent`); left out of access requests and workspace exports |
| The vendor's certificate PDF | object storage, envelope-encrypted under the round evidence key, with its SHA-256 on the row | deleted by the nightly evidence purge `evidenceRetentionDays` after the decision (default 90); the SHA-256 and the decision stay |
| The kernel attestation (`accredited`, method, provider, expiry) | `core.attestation` | per the kernel's attestation rules |

Nothing the vendor sends in a callback is stored beyond the time it arrived (`lastCallbackAt`).

- **Access requests (DSAR)** include the member's verifications (status, method, decision,
  evidence metadata, and the vendor reference — the investor's own fact, also named in a
  `vendor:` evidence note) — not the handoff. The vendor holds its own copy of the investor's
  documents and identity; handle access and erasure requests there too, under the vendor's DPA.
- **Erasure** (`member.erasure_requested`): the verification rows stay as legal evidence, but
  every one keeps only its handoff kind, and a pending vendor verification stops being polled
  (vendor error `member_erased`, audited `round.verification_member_erased`). A vendor answer that
  arrives afterwards is dropped — no decision, attestation or stored certificate — and staff can
  no longer record `verified` for that member (`409 conflict`, `reason: member_erased`);
  `rejected` stays allowed so the queue can be cleared.
- **Workspace export** carries verifications without the handoff and without a next check, and
  never the connection or its credentials. On import every vendor verification is marked with
  vendor error `imported` and is never started, polled, woken or re-checked again (its reference
  belongs to the other install's vendor connection); decide pending ones by hand and reconnect the
  vendor.

## The API

Connection routes (signed-in admin only): `GET /accreditation/providers`,
`GET|PUT|DELETE /accreditation/connection`, `POST /accreditation/connection/verify`. Investor:
`GET|POST /round/current/verification`, `GET /round/current/verification/handoff`. Staff:
`POST /round/verifications/{id}/check` (`round.manage`; `202 {queued: true}`, `409` when the row is
not a pending vendor verification), alongside the existing `GET /round/verifications[/{id}]` and
`POST /round/verifications/{id}/decide`. None of these is callable with an API key. Webhook
topics `round.verification_requested` and `round.verification_decided` are listed in
[webhooks.md](../api/webhooks.md#topics).

| Status | `code` | Meaning |
|---|---|---|
| 400 | `validation_failed` | an unknown credential field, or clearing a required one |
| 422 | `accreditation_credentials_invalid` | a field is missing or invalid (`fields`), or the vendor refused the credentials when saving (`reason`) |
| 422 | `accreditation_driver_not_offered` | the vendor is not in the operator's `ACCREDITATION_DRIVERS` |
| 502 | `accreditation_provider_error` | the vendor could not be reached or failed while saving or verifying (`providerCode`) |
| 404 | `not_found` | verify or disconnect with no connection (`reason: no_connection`) |
| 409 | `conflict` | `reason: verification_pending` (a verification is already pending; `details.verification`), `verification_not_vendor` (check on a manual or decided row) |
| 409 | `conflict` | `reason: member_erased` — recording `verified` for an erased member |
| 429 | `rate_limited` | 10 connection saves an hour per workspace; verification starts: 5 an hour and 10 a day per member, 50 vendor verifications an hour per workspace |

## Operator settings

| Key | Default | Meaning |
|---|---|---|
| `ACCREDITATION_DRIVERS` | `verifyinvestor,parallel-markets` | Comma list of vendors workspace admins may connect. **`none` turns vendors off** (every workspace verifies manually). An **empty** value does *not* — the configuration loader treats an empty variable as unset, i.e. the default. Removing a vendor keeps existing connections following the verifications already open with it (polling, callbacks, decisions) and still lets a workspace re-key its live connection (a leaked key must stay rotatable), but **new verifications in those workspaces go to manual review**, and no workspace can connect it anew or switch to it (`422 accreditation_driver_not_offered`). The admin screen marks such a connection as no longer offered. |
| `ACCREDITATION_ALLOW_PRIVATE_HOSTS` | empty | Hosts the accreditation client may reach on a private address — test rigs and a sandbox proxy only; the vendors' APIs are public. Independent of `OUTBOUND_HTTP_ALLOW_PRIVATE[_HOSTS]`. With `APP_ENV=prod` or `staging` the server refuses to start if it lists `localhost`, a loopback or unspecified address, or a wildcard. |
| `ACCREDITATION_DRIVER` | `manual` | Unchanged; `manual` is its only value. Kept so existing `.env` files still load. |

The accreditation client is its own guarded HTTP client: https only (except listed hosts), no
redirects, 15-second timeout, 12 MiB per answer (certificates are capped at 10 MiB). The vendors'
API addresses are fixed by each adapter, not typed by the admin.

## Sub-processors

The vendor a workspace connects processes investors' identity, contact details, financial
documents and accreditation outcome on the company's behalf, so it belongs on the workspace's
sub-processor list (`packages/compliance/templates/sub-processors.md`). The adapters declare:

| Provider | Purpose | Location | More |
|---|---|---|---|
| VerifyInvestor.com, LLC (a tZERO Group company) | Accredited-investor verification under Rule 506(c): investor invitation email, document review by licensed reviewers, verification certificate | United States | <https://www.verifyinvestor.com> |
| Parallel Markets (iCapital Identity Solutions, Institutional Capital Network, Inc.) | Accredited-investor verification under Rule 506(c): investor identity and accreditation flow, reviewer decision, certification letter | United States | <https://parallelmarkets.com> |

The list is not filled in automatically: add the row for the vendor you connect when you publish
the sub-processor list, and give the 30-day notice the template describes before switching
vendors. **Settings → Accreditation** shows each vendor's declared facts before you connect.
