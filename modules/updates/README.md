# @fundroom/module-updates

Investor updates: block-editor drafts on the content block schema, templates,
audiences with per-section rules, test send, schedule, the send job with per-recipient status,
the gated web archive, private reply threads, unsubscribe compliance and per-workspace sending
domains (DKIM). Optional module (`updates` schema, `/api/v1/updates`); hidden from investors
while the workspace is `informational`.

## Model

- `updates.post` — the editable draft: title, `doc` (the content module's block document, no
  `hero`), `visibility` (section key → `authenticated | groups | staff_only`; never `public`),
  `audience` (`all` external members, or `groups`), state `draft → scheduled → sending → sent →
  archived`, `published_version_id`, `saved_at` (the editor's optimistic-concurrency token).
- `updates.post_version` — immutable snapshot (title, doc, rules, audience, disclaimer version)
  taken by send, test send and archive-only publish; a trigger refuses updates.
- `updates.send` / `updates.recipient` — one row per fan-out (live or test) and one per address:
  `queued → sent | failed | skipped` (`skipped` = unsubscribed, no email, or `suppressed` by the
  workspace after a hard bounce/complaint). ESP webhooks then move a sent row up a monotonic
  ladder `sent → delivered → bounced → complained` (E2.6, migration `0002`; only a *hard* bounce
  reaches `bounced`); the send keeps
  `delivered` / `bounced` / `complained` counters beside `sent` (= accepted by the provider).
- `updates.reply` — one private thread per (post, investor); staff see every thread.
- `updates.unsubscribe` — members who opted out of update mail (portal access is unaffected).
- `updates.sending_domain` — one per workspace: RSA-2048 DKIM key pair (private key
  envelope-encrypted under the workspace DEK), selector, DNS checks, status.

RLS: staff and system actors see everything in their workspace; an external actor reads sent
posts whose audience includes them (`updates.audience_includes_current`), the published version
of those posts, its own thread and its own unsubscribe row. Sends, recipients and the sending
domain are staff-only.

## Flows

- **Draft.** `POST /posts` from a template (`yc`, `minimal`, `board`, `blank`); `PUT
  /posts/{id}/draft` autosaves title, doc, audience and rules (`baseSavedAt` → 409 on a
  concurrent edit; rules of removed sections dropped, new sections `authenticated`).
- **Test send.** `POST /posts/{id}/test-send` → a version + a `test` send to the caller (or up
  to five addresses): every section, `[Test]` subject, banner, no unsubscribe link.
- **Send.** `POST /posts/{id}/send` (`updates.send` + fresh session) → `sending`, a new
  version, a `live` send, `updates.send` queued in the same transaction. `POST
  /posts/{id}/schedule` → `scheduled`; `updates.dispatch` (every minute) sends what is due and
  re-enqueues sends stuck for 30 min. `POST /posts/{id}/publish` publishes to the archive only.
- **The job** resolves the audience into recipient rows once (idempotent on retry), renders one
  email per reader (sections filtered by the reader's groups), hands it to `MailerPort` with
  `List-Unsubscribe` + `List-Unsubscribe-Post` (RFC 8058), `List-Id`, `Reply-To` (settings or
  the author), the workspace sender + DKIM signer when the sending domain is verified, then
  closes the send, moves the post to `sent`, audits `update.sent` and publishes it on the outbox.
  Every message is `stream: "broadcast"` with `ref: {kind: "post", id, membershipId}` (no
  membership on a test send). `tracking: {opens, clicks}` is set only when the workspace's
  `analytics.mode` is `engagement` **and** `legal.allowsPurpose(member, "email_tracking")`
  (E2.6 decision 1); a test send never tracks. A `MailSuppressedError` from the kernel's
  suppression wrapper (matched by class or by `code === "suppressed"`) marks the recipient
  `skipped` with error `suppressed` — never `failed`, never retried.
- **Unsubscribe link and click tracking.** The footer unsubscribe `<a>` carries
  `data-pm-no-track` (Postmark) and `ses:no-track` (Amazon SES), so an ESP with click tracking
  on never rewrites it through its redirector — the token is a capability, and "who clicked
  unsubscribe" is not engagement data. **Resend has no per-link opt-out**: with Resend click
  tracking enabled the footer link is rewritten like any other; the `List-Unsubscribe` header
  (RFC 8058 one-click), which no provider rewrites, remains the untracked path there.
- **Delivery feedback**. Subscriber on `mail.delivery_recorded` with `refKind: "post"`:
  finds the recipient by provider message id (row-locked; index `recipient_message_idx`),
  applies `nextRecipientStatus` (a late `delivered` never overwrites `bounced`/`complained`; a
  repeat is a no-op; `delay` only stamps `last_event_at`; opens/clicks are ignored here — they
  belong to analytics) and shifts the send's counters by delta. Only a **hard** bounce moves a
  row to `bounced`: a soft (or untyped) bounce is transient — the address is fine and the
  provider may still deliver — so it only records `error = bounce:soft` and `last_event_at` on a
  `sent`/`delivered` row, and never touches the counters (matching the kernel, which suppresses
  on hard bounces only). Bounce errors are stored as `bounce:hard|soft`, never the provider's
  text. Feedback about a member for whom `legal.isErased` is true (on the event or on the row)
  is dropped, so a late webhook cannot write news about an erased member back.
- **Erasure**. Subscriber on `member.erasure_requested`: the member's recipient
  addresses become `erased+<row id>@erased.invalid` (an error quoting an address becomes
  `redacted`), replies in their thread or by them are blanked to `[erased]` and soft-deleted,
  and the member's `updates.unsubscribe` row keeps the opt-out but its stored address becomes
  `erased@erased.invalid` — the send path looks opt-outs up by membership id only, so it stays
  exactly as effective — then `legal.completeErasureStep(…, "updates", {recipients, replies,
  unsubscribes})`. Rows, statuses and send counts are kept.
  Idempotent (already-erased rows are skipped). Erasure **ignores enablement** (decision 5,
  amended): with the module off it still erases what exists and reports its step, because the
  kernel waits for it; delivery feedback is a no-op where the module is off.
- **Archive.** `GET /archive`, `GET /archive/{slug}` for every member: sections filtered for the
  reader, reference blocks hydrated (document lists, KPI grids) like the overview page.
- **Replies.** `GET|POST /posts/{id}/replies`: investors write in their own thread; staff answer
  with `threadMembershipId`. `update.replied` on the outbox for E1.5 notifications.
- **Unsubscribe.** Footer link → `/unsubscribe?token=` page → `POST /updates/unsubscribe`
  (public, token HMAC-signed under the workspace key, purpose `updates-unsubscribe`); mail
  clients POST the same URL one-click. `GET|PUT /subscription` is the portal switch.
- **Settings / sending domain.** `GET|PATCH /settings` (sender name, local part, reply-to,
  postal address, footer note); `GET|PUT|DELETE /sending-domain`, `POST
  /sending-domain/verify` (DKIM TXT must match; SPF and DMARC advisory).

Email HTML and text are built from the same filtered sections through `@fundroom/markdown`
(inline styles, no web fonts, no tracking pixel of our own — open tracking, where consented, is
the ESP's).

## Delivery failures and retries

- **Transient or permanent** (`isTransientMailError`, `service/delivery.ts`). These are
  transient: a relay-level refusal, an adapter's `retryable` flag or `connection_failed` /
  `rate_limited`, a socket or DNS error in the `cause` chain, and an SMTP 4xx. An SMTP 5xx
  anywhere in the chain is permanent, and so is anything unrecognised. A transient failure leaves
  the row `queued` with `error = "retrying: …"`, and the run throws `DeliveryDeferredError` so
  pg-boss retries it. Past `SEND_STALE_MINUTES` the dispatcher re-enqueues it.
- **Retry window.** `SEND_RETRY_WINDOW_HOURS` = 24, counted from the send's creation. After that,
  a transient failure is final (`failed`).
- **Transport down.** A run stops early after `SEND_TRANSIENT_STREAK` = 5 transient failures in a
  row, instead of waiting out a timeout for every remaining name.
- **Exactly once per recipient.** Claim, send and record happen in one transaction on a row locked
  `FOR UPDATE SKIP LOCKED` while it is `queued`. A concurrent run of the same send skips it
  (`busy`). The remaining gap: if the provider accepted the message but the commit failed, the
  retry sends it again, with the same `idempotencyKey`.
- **Eligibility at send time.** `ineligibleReason` re-checks the member under the same row lock
  just before each message: revoked, expired, or no longer in the audience's groups. The row
  becomes `skipped` with the reason.
- **Archive does not wait for retries.** When every recipient has been tried and some mail went
  out, the post moves `sending → sent`, and is indexed, even while deferred addresses keep
  retrying. This does not happen when the run stopped on a transport streak.

## Permissions, audit, events

`updates.read` (every staff role), `updates.manage` / `updates.send` (owner, admin, editor),
`updates.settings` (owner, admin); resource kind `post` (`view → updates.read`, `edit →
updates.manage`). Audit actions: `update.created|updated|deleted|scheduled|unscheduled|published|
sent|test_sent|replied|unsubscribed|resubscribed`, `sending_domain.created|verified|deleted`,
`updates.settings_changed`. Events: `update.published`, `update.sent`, `update.replied`,
`update.viewed` (an external member opening an archive page — the engagement signal analytics
ingests; a staff preview of the same page emits nothing). Handles: `mail.delivery_recorded`,
`member.erasure_requested`.

## Testing

`verify` resolves TXT through `services.dns` — the kernel's shared DoH resolver, which replaced E1.4's `setDnsResolver()` module global. A test injects a fake
`DnsResolverPort`: the container's `dns` option (reachable from `startServer({ dns })`) for an
integration test publishing a fake zone, or a hand-rolled port for a unit test of `lookupTxt`.
`nxdomain` and an empty answer both mean "nothing published yet"; `servfail`/`refused`/`other`
mean "we could not look" and fail the verification instead. The send job runs against
`MemoryMailer` in `apps/server/src/updates.integration.test.ts`, wrapped by a port that throws
`MailSuppressedError` for chosen addresses; delivery feedback and erasure are driven by
publishing `mail.delivery_recorded` / `member.erasure_requested` into the real outbox.

## Search

`src/search.ts` is the module's `search` provider (`version` 1). One entry per (sent post,
section) of the **published version** — kind `post`, `refId` = post id, `part` = section key,
title = version title (+ ` — <section title>`), body = the section's static-block text (the
content module's `sectionText`), `href` `/updates/<slug>` (the archive resolves by slug). Draft,
scheduled, sending and archived posts are not indexed. The ACL is the archive's two gates
intersected — the post's live audience × the section's rule in the version snapshot:

| audience \ section | `authenticated` | `groups` R | `staff_only` |
|---|---|---|---|
| `all` | members | groups R | staff |
| `groups` A | groups A | groups A∩R (not indexed when empty) | staff |

`indexPost` runs on the writer's transaction at every state change: send (drops a re-send while
`sending`), the delivery job's `sending → sent`, publish-to-archive, archive/unarchive, delete,
and an audience edit of a sent post. `updatesSearch.entries` is the full rebuild.

## Portability

`src/portability.ts` — **an import never sends mail by itself**:

| Table | Mode | On import |
|---|---|---|
| `post` | rows | `scheduled` → `draft` (schedule cleared); `sending` → `sent` if it had been sent before, else `draft` |
| `post_version` | rows | as is (immutable to UPDATE only) |
| `send` | rows | `queued`/`running` → `failed` ("interrupted by a workspace export/import") |
| `recipient` | rows | `queued` → `failed`, same reason |
| `reply`, `unsubscribe` | rows | as is — opt-outs travel, so nobody who opted out is mailed again |
| `sending_domain` | skip (`secret`) | the DKIM private key is NOT NULL and sealed under the source key; re-add the domain (new key pair + DNS records) |

Unsubscribe links in mail sent before the export stop working against the imported workspace
(HMAC under the workspace key, naming the workspace id); the opt-outs themselves are carried.
`afterImport` requests a search rebuild.
