# @fundroom/module-notify

Staff notifications: per-member preferences for what a founder wants to hear about —
an investor viewed or downloaded a document, replied to an update, indicated interest,
requested accreditation verification, committed to the round, or became a hot lead —
delivered as an in-app inbox entry plus an instant email, a daily digest or a weekly digest;
and workspace Slack channels for the workspace-level events. Optional module (`notify` schema,
`/api/v1/notify`) with no investor surface at all: investors receive only emails about
themselves (a new delegate, the answer to their data-room question) and every route
answers them 404.

## Model

- `notify.preference` — `(workspace, membership, event_type) → cadence`. `notify.cadence` is
  `instant | daily | weekly | off`; a missing row means the default for that event type (views
  and downloads `daily`, everything else `instant`), which is why the API returns `isDefault`
  alongside the effective value instead of writing defaults on read.
- `notify.member_settings` — one row per member: `timezone` (IANA, validated through `Intl`),
  `digest_hour` (local 0–23), `weekly_day` (0 = Sunday), `quiet_start` / `quiet_end` (local
  hours, both or neither, `end < start` wraps midnight), `email_enabled` (the master switch; the
  inbox still fills) and `last_daily_digest_at` / `last_weekly_digest_at`.
- `notify.notification` — one row per recipient per event. `dedupe_key` is UNIQUE per
  workspace and carries a bucket (an hour for views/downloads, a day for hot leads, the id of
  the fact for everything deliberate), so a viewer re-opening the same document does not
  produce a second alert within the hour. The row snapshots the cadence it was created under,
  so changing preferences never rewrites pending work. `sent_at` says a row was processed and
  `email_outcome` how (`emailed | digested | suppressed | email_off | no_address | failed`);
  `deferred_until` holds an instant email back for quiet hours; `attempts` / `next_attempt_at` /
  `last_error` (an error *code*, never provider text) drive bounded instant-email retries; `read_at` / `archived_at` are the
  inbox state; `payload` is ids and numbers only (jsonb with a `payload_schema_version`).
- `notify.digest` — one row per digest (`kind` daily or weekly), written as a *claim* before the
  email is sent (`sent_at` NULL until it is) and unique per (member, kind, `slot`) — the
  schedule slot served, from which the ESP idempotency key is derived.
- `notify.channel` — a workspace Slack incoming webhook. The URL is a bearer credential: it is
  **validated through `services.chat.validateUrl` before it is stored**, kept envelope-encrypted
  under the workspace data key purpose `notify-chat` (like metrics' sheet credential), and never
  returned, logged or audited — responses carry `urlHint` (its last four characters) only.
  `event_types` ⊆ `analytics.hot_lead`, `round.interest_submitted`, `round.commitment_created`,
  `round.verification_requested`, `access_request.submitted`, `access_review.overdue`,
  `qa.question_asked`. `failure_count` / `disabled_reason` track a revoked webhook.
- `notify.channel_delivery` — the post log and retry queue: one row per (channel, fact),
  `source_key` = `<event type>:<id>` so a redelivered outbox event cannot post twice.

Migrations: `0001_notify`, `0002_round_event_types`, `0003_weekly_cadence` (the enum label on
its own: `ALTER TYPE … ADD VALUE` cannot be used in the transaction that adds it, and the runner
wraps each file in one), `0004_schedule_channels`, `0005_delivery_attempts`,
`0006_access_request_event_types`, `0007_access_review_event_types`, `0008_delegate_event_type`,
`0009_qa_event_types`. `src/rules.test.ts` pins the newest file's CHECK lists to the TypeScript
vocabularies.

RLS: the tenant fence plus staff/system policies, and a member may read and update only its
*own* notification rows (`notification_staff_own_read` / `notification_staff_own_update`). One
admin cannot read another's inbox.

## Flows

- **Fan-out.** `document.viewed`, `document.downloaded`, `update.replied`,
  `round.interest_submitted`, `round.verification_requested`, `round.commitment_created` and
  `analytics.hot_lead` arrive on the outbox. Views, downloads, replies and hot leads ignore
  anything an internal actor did. Recipients are resolved through the authz engine — paged, with
  the actor excluded — holding `notify.read` (documents, replies), `round.manage` (round events:
  a `viewer` who may not open the round must not learn who wants into it) or `analytics.read`
  (hot leads: whoever may already see the score). A commitment may name no member; its alert
  then says "a new commitment was recorded". Instant rows publish `notification.created`.
- **Access requests.** `access_request.submitted` (a non-member verified a request for
  access) is re-read from `core.access_request` inside the handler's transaction and skipped
  unless still `pending` — an auto-approved, decided, expired or deleted request never alerts.
  Recipients hold `access.manage`; there is no actor (`actor_membership_id` NULL, resource kind
  `access_request`, payload `{accessRequestId}`). The email and digest name the requester, read
  from the request at render time (never stored in `notify.*`); a channel post never does — it
  says only that a new access request is waiting, with a link to `/admin/access-requests`.
- **Overdue access review.** Identity's daily `access-review.overdue` job publishes
  `access_review.overdue {dueAt, lastReviewId|null}` (last review + 90 days, or workspace creation
  + 90 days if never reviewed) at most once per ISO week per workspace. Recipients hold
  `access.manage`; no actor, resource kind `workspace` (the workspace id), bucket = the event's
  ISO week, so a redelivery collapses. The email, digest line and channel post are sentences about
  the workspace ("The access review is overdue"), linking to `/admin/access-review`.
- **Data-room Q&A.** Six `qa.*` events, all instant, `resource_kind =
  'qa_question'`, `resource_id` = the question. Payloads are ids only and this module may not read
  the `dataroom` schema, so every email is a fixed sentence plus a link — never the question or
  the answer (an investor's own words). `qa.question_asked` → staff holding `data-room.qa_manage`
  (actor = the asker), and a channel post that names nobody ("A new data-room question is waiting
  in Acme."); `qa.question_assigned` → the assignee alone (`permission: null` — no staff by role —
  plus `alsoNotify`), skipped for an unassignment or when the payload's optional
  `actorMembershipId` is the assignee; `qa.answer_submitted` → `data-room.qa_approve` holders
  except that actor (the author); `qa.answer_released` → the asker alone, an external recipient,
  by email with a link to the portal's `/data-room/questions/<id>`; `qa.question_declined` (staff
  closed it as declined and ticked "tell the asker") → the asker alone, the same way;
  `qa.question_due` → the
  assignee and `data-room.qa_manage`, worded for `due_soon` or `overdue`. Buckets: per question
  (asked), per question + phase + due date (due: a moved deadline re-arms the job's stamps, and
  that reminder is delivered), + visibility (released: answered to the asker, then
  published, are two facts), + outbox id (assigned, submitted, declined: a reassignment, a
  resubmission or a re-decline is news again; a redelivery keeps its outbox id and collapses). Staff links go to
  `/admin/data-room/questions/<id>`. An erased asker drops both the new-question alert (actor)
  and the release or decline notice (recipient). The staff preferences form has no toggle for
  `qa.answer_released` or `qa.question_declined`, which never reach staff.
- **E-signature and round closing.** Three instant types, none a channel event.
  `esign.envelope_attention` ← `esign.envelope_changed` with status `declined`, `voided`,
  `expired` or `error` on **any** envelope (NDA or subscription agreement): staff holding
  `esign.read`, no actor, `resource_kind = 'esign_envelope'`, bucket envelope + status (each
  status is reached once), a sentence per status linking `/admin/esign`.
  `round.signature_completed` → `round.manage` holders, actor = the commitment's member (from the
  payload's optional `membershipId`; "A subscription agreement was signed" without one), bucket =
  the envelope, linking the admin round page. `round.commitment_confirmed` → the investor alone
  (`permission: null` + `alsoNotify`), by email in the second person ("Acme confirmed your
  commitment") linking the portal's `/round`; skipped when the commitment names no member; an
  erased investor is dropped by `fanOut`; one per commitment.
- **Instant.** The `notification.created` handler runs inside the outbox dispatcher's
  transaction, so it does not send: it enqueues `notify.send` in that transaction, and the job
  delivers with **no transaction open during the ESP call** (`deliverNotification`): a short
  transaction locks the row and claims it (`attempts` + 1, `next_attempt_at` = now + backoff,
  which doubles as the claim's lease), the mail goes out with `stream: "notification"`,
  `ref: {kind: "notification", id, membershipId}` and idempotency key `notify:<id>`, then a
  second short transaction marks it. Latency is one queue poll (seconds). Email off, no address,
  or `MailSuppressedError` (any `reason` — bounce, complaint or `provider`; the reason is only
  logged) → processed without mail, never retried. Any other mailer error is recorded as
  `last_error` and retried by `notify.deliver` after 2, 4, 8, 16 min; the 5th failure
  (`NOTIFY_MAX_ATTEMPTS`) closes the row as `failed`. Inside the recipient's **quiet hours** the
  row gets `deferred_until` (the next local end of the window) and stays unsent; the inbox row
  is visible immediately. `notify.deliver` (every minute) sends what is due — missed subscribers
  after a 30 s grace, retries whose backoff ended, and deferred rows whose hold has ended
  (re-checking the window) — **fewest attempts first**, so a pile of permanently failing rows
  can never fill its 200-row batch and starve fresh alerts.
- **Digests.** `notify.digest` (hourly, singleton) serves daily and weekly digests at each
  member's own local hour (weekly: on `weekly_day`). A member is due when a slot has passed since
  their last digest — or, never served, since their oldest waiting row — so an hour the job
  missed is caught up on the next run rather than a day later. The pure rules (`isDigestDue`,
  `latestSlot`, `inQuietHours`, `nextQuietEnd`) live in `src/schedule.ts`: a local time inside a
  spring-forward gap resolves to just after it, one in a fall-back overlap to its first
  occurrence. Each digest is **claim → send → mark**: the digest row and its rows are claimed
  and committed first, the mail is sent outside any transaction under
  `notify:digest:<member>:<kind>:<slot>`, then marked. A failed send or a failed commit leaves
  the claim, and the next run finishes the *same* digest under the same key (the ESP drops the
  duplicate) instead of a second, differently keyed email; after 5 attempts its rows close as
  `failed`.
- **Channels.** The four workspace-level handlers also queue one `channel_delivery` per enabled
  subscribed channel inside the outbox transaction and enqueue `notify.channels`, which claims
  rows (`FOR UPDATE SKIP LOCKED`), posts through `services.chat` outside any transaction and
  records the answer. `rate_limited` / `unavailable` retry with backoff (honouring
  `retryAfterMs`, at most 6 attempts, swept by `notify.deliver`); `not_found` / `rejected` /
  `invalid_url` fail the post and, after 3 in a row, disable the channel
  (`disabled_reason`, `notify.channel_disabled` audit). Re-enabling or re-pointing clears it.
- **Slack app channels.** A channel of `kind = 'slack_app'` points at a channel of the
  workspace's Slack app connection (the kernel integrations hub) by Slack's channel id and holds
  no credential (`url_enc` / `url_hint` NULL — the bot token is the kernel's). It is created from
  `GET /notify/slack/channels` (the bot's channel list; unknown id → 422
  `slack_channel_unknown`, no connection → 404 `integration_not_connected`, one app channel per
  Slack channel). Delivery is the same queue: the post goes through
  `services.integrations.slackPost` outside any transaction, with the webhook's fixed sentence as
  escaped Slack mrkdwn plus the link inline — no more personal data than a webhook post.
  `not_connected` / `unauthorized` / `forbidden` / `not_found` are permanent (disable after 3,
  `disabled_reason` `not_connected` / `rejected` / `not_found`); `rate_limited` and remote trouble
  retry.
- **Integration health.** `integration.connection_unhealthy` → staff holding
  `integrations.manage` (owners, admins), instant by default, no actor, one alert per outbox
  event ("The QuickBooks connection of Acme needs to be reconnected"), linking
  `/admin/integrations`; and every channel that opted in — except `slack_app` channels when the
  unhealthy provider is Slack itself (those posts could only fail).
- **Accreditation verification.** `round.verification_decided` (status
  `verified`, `rejected` or `expired`; `pending` is ignored) and `round.verification_expiring` →
  the investor in the payload alone (`permission: null` + `alsoNotify`; staff are never told), no
  actor, `resource_kind = 'verification'`, instant, never a channel event. Bucket: the
  verification (expiring) or verification + status (decided: verified-then-expired is two facts;
  a redelivery collapses). Neutral second-person copy with no amounts, method, evidence or vendor
  ("Your accreditation verification is complete" / "could not be completed" / "has expired" /
  "expires soon" — the payload has no expiry date and the round schema is not this module's to
  read), linking the portal's `/round`. `fanOut` drops an erased or non-active investor and
  honours their cadence.
- **Inbox.** `GET /notify/inbox` is keyset-paged on `(created_at, id)` — the cursor carries
  Postgres' microsecond timestamp text, so rows sharing a millisecond are neither skipped nor
  repeated — with `archived` / `unread` filters and an unread count. `POST /inbox/read` (ids or
  all), `POST /inbox/read-all` (`upTo` = when the screen was drawn), `POST /inbox/archive`.
- **Retention.** `notify.retention` (nightly) deletes notifications, digests and finished
  channel posts older than the workspace's `notify.retentionDays` (default 180); nothing while
  `legal.legalHold` is on.
- **Erasure.** `member.erasure_requested` deletes the notifications addressed to *or caused by*
  the member, their digests, preferences, settings and channel posts about them, forgets them as
  a channel's creator, and reports `completeErasureStep(…, "notify", counts)`. It runs whether
  or not the module is enabled for the workspace. Afterwards the fan-out and the channel queue
  drop any event whose actor — or any recipient — `services.legal.isErased`, so an event emitted
  before the request but dispatched after it cannot write the rows back.

## Permissions, audit, events

`notify.read` (every staff role) guards the self-service routes; RLS, not a permission, keeps
one member out of another's inbox. `notify.manage` (owner, admin) guards the channel routes —
`GET/POST /notify/channels`, `PATCH/DELETE /notify/channels/{id}`, `POST
/notify/channels/{id}/test`, `GET /notify/slack/channels` — because a channel posts into a room
the whole team reads and its URL is a credential. Creating and deleting a channel need a fresh
session; `PATCH` needs one when the body carries `url` or `slackChannelId` (checked in the
handler; renaming and toggling do not). Audit
actions: `notification.sent`, `notification.digest_sent`, `notify.preferences_changed`,
`notify.channel_created|updated|deleted|tested|disabled` (never the URL). Events handled: the
event types above, `member.erasure_requested` and `notification.created`; emitted:
`notification.created`. The module declares no `webhooks:` and no `resourceKinds:`.

## Testing

`src/schedule.test.ts` covers the time rules (timezones, DST gap/overlap, wrap-around quiet
hours, weekly slots, catch-up); `src/rules.test.ts` the vocabulary.
`apps/server/src/notify.integration.test.ts` runs fan-out, instant mail, digests and inbox
isolation against `MemoryMailer`, and — in a workspace of its own — channels against a fake
`ChatWebhookPort` (`startServer({ chat })`), local-time and weekly digests, quiet hours, a
suppressed address, keyset paging, retention and erasure. The digest and retention jobs accept
`{ workspaceId, at }` so a test evaluates the schedule at a chosen instant.
`src/service/slot.ts` is a module-local singleton that hands `ModuleServices` to the outbox
handlers (which the manifest calls without them); it is populated by `createNotifyJobs()` with
live services only.

## Portability

`src/portability.ts` (`notifyPortability`) — how notify travels in a workspace export/import.
All six tables move as rows, in FK order; a copy never sends mail or chat posts about the
source's past and never receives a webhook credential.

| table | moves | on import |
|---|---|---|
| `preference`, `member_settings` | rows | as-is (`membership_id` remapped by the engine) |
| `digest` | rows — the record of what was emailed | a claimed-but-unsent digest (`sent_at` NULL) is closed with `sent_at = now`, never sent from the copy |
| `notification` | rows — the inbox | unsent rows get `sent_at = now`, `deferred_until`/`next_attempt_at` NULL (no instant email, no retry); `dedupe_key` uuids remapped |
| `channel` | rows **without `url_enc` / `encryption`** | arrives disabled, `disabled_reason = 'invalid_url'`, empty `url_enc`, `last_error` saying a reconnect is required; the admin re-enters the webhook URL (PATCH `url`), which clears the reason. `url_hint` is kept |
| `channel_delivery` | rows — the post log is a data-egress record | `pending`/`sending` → `dropped` (as when a channel is disabled); `source_key` uuids remapped |

`src/portability.test.ts` covers every `importRow`, the secret omission, and parses
`migrations/` for every `CREATE TABLE notify.*` so a new table without a decision fails it.
