# @fundroom/module-analytics

Engagement analytics: who opened a document or an update, how long they
read, how far they got, plus the per-contact timeline and the "who viewed this" list behind the
admin views. Optional module (`analytics` schema, `/api/v1/analytics`). E2.6 added email opens
and clicks, the aggregate page heatmap, the hot list (with CSV export and hot-lead alerts),
per-workspace retention under legal hold and the DSAR erasure subscriber.

Privacy is the model, not a setting bolted on: no email, no IP, no user-agent string is ever
stored — a sha256 of the session id, a browser *family* and an HMAC of the address under the
workspace's `analytics-ip` data key. One workspace setting (`analytics.mode`) decides how much is written at all, and `off`
silences every writer in the module.

## Model

- `analytics.view_session` — one row per (workspace, hashed session key): `membership_id`,
  `ip_hash`, `ua_family`, `embed`, first/last seen. Server-side facts that arrive without a
  session get a synthetic key, one per member per UTC day.
- `analytics.event` — the fact table, RANGE-partitioned by month on `occurred_at`, PK
  `(workspace_id, occurred_at, id)`. Types: `document_viewed`, `document_downloaded`,
  `update_viewed` (from the outbox), `page_viewed` (dwell, from the heartbeats) and, since
  E2.6, `email_opened` / `email_clicked` (resource kind `post`; `props.messageRef`,
  `props.automated`, `props.link` for clicks). `props` is jsonb with a `props_schema_version`
  sibling.
- `analytics.page_open` — the live dwell accumulator, one row per (session, resource, page);
  flushed into `page_viewed` events on close or by the idle timeout. Never read by the API.
- `analytics.viewer_resource_rollup` — per (member, resource): views, downloads, total dwell,
  `max_page_reached`, `pages_seen`. The "who viewed" list and the drill-down read this.
- `analytics.daily_resource_rollup` — per (UTC day, resource): views, unique viewers, dwell,
  downloads. Carries counts only, so it survives a DSAR erasure.
- `analytics.rollup_cursor` — the keyset the rollup job walks (`last_occurred_at`,
  `last_event_id`).
- `analytics.page_rollup` — the page heatmap: per (resource, version, page) total dwell,
  page reads and distinct readers. `version_key` is the version id, or the zero uuid when the
  viewer reported none. Counts only; kept indefinitely.
- `analytics.page_viewer` — the distinct-reader set behind `page_rollup.viewers`; a row is
  inserted once per (resource, version, page, member) and only a new row raises the count, so a
  DSAR erasure deletes these without rewriting the totals. `last_at` (migration 0003) is touched
  on every re-read and is what retention trims on. Consequence, accepted and deliberate: once a
  member's reader row is gone (erasure or retention), a later read of that page by the same
  member counts them as a new reader, so `viewers` can exceed the true number of distinct
  people. The alternative — keeping an identifying row to prevent it — is the thing erasure and
  retention exist to remove.
- `analytics.hot_lead_alert` — when a member was last announced as a hot lead.

RLS: staff and system actors only, always inside the workspace fence — an investor's session
never reads or writes these tables directly, so the member-facing routes run in a `system`
transaction with the caller's membership id travelling as data.

## Flows

- **Server-side facts.** Outbox subscribers on `document.viewed`, `document.downloaded` and
  `update.viewed` upsert the view session and insert the event, stamped with the *source* fact's
  time. Idempotent: the insert dedupes on the outbox row id and on (session, type, resource,
  version) within a minute of the same instant, so a retried or delayed delivery neither
  duplicates nor lands at `now()`.
- **Page dwell.** `POST /heartbeat` every few seconds while a page is on screen; each beat is
  capped at 15 s server-side and accumulates in `page_open`. A beat is honoured only where the
  server already recorded this session opening that resource (`reason: "unopened"` otherwise):
  the route that emitted `document.viewed` did the authorisation, so a member cannot write
  themselves into the "who viewed" list of a document they never opened. A beat that overtakes
  its own outbox event is refused and the next one, seconds later, is not. `POST /close` (a beacon) flushes
  that session's rows into `page_viewed` events; `analytics.flush` (every minute) does the same
  for rows silent for two minutes, for the tab that closed without a beacon. Both are no-ops
  unless the mode is `engagement`.
- **Rollups.** `analytics.rollup` (every five minutes) walks `event` from the cursor, ignores
  anything younger than 10 s (in-flight transactions), folds the batch (`foldBatch`) and adds
  the deltas onto both rollup tables, then recomputes unique viewers for the touched days.
  The admin views therefore lag by up to five minutes; the recent strip and the timeline read
  raw events and do not.
- **Email opens and clicks.** The kernel's ESP webhook publishes
  `mail.delivery_recorded`; the subscriber keeps `open`/`click` facts on a post that name a
  member, re-checks the gate (mode `engagement` and `legal.allowsPurpose(member,
  "email_tracking")` — the outbox may deliver after a withdrawal) and inserts an
  `email_opened`/`email_clicked` event. Idempotent on (message ref, type, the provider's own
  timestamp — kept verbatim in `props.providerAt`) under an advisory lock; the *stored* time is
  that timestamp clamped to when the kernel recorded the webhook, a function of the fact alone,
  so a redelivered future-dated event is never mistaken for a new one (skipped when its month
  has no partition). Clicks on `/unsubscribe` or any `/api/` path are the email's mechanics, not
  engagement: dropped at ingest (the kernel drops them too) and excluded from scoring.
  Apple MPP prefetches and link scanners arrive flagged `automated` and are stored, reported
  separately and never scored. `GET /posts/{id}/email` reports unique human opens, automated
  opens and human clicks per link, independently of delivery status (the updates module owns
  that). Email events are not reads: the rollups skip them, so an open never puts a member on
  "who viewed" the update.
- **Page heatmap.** The rollup folds `page_viewed` into `page_rollup` per (resource,
  version, page); `GET /{kind}/{id}/heatmap` returns one heatmap per version (two versions'
  page 3 are different pages), optionally filtered by `versionId`.
- **Hot list.** `hotScore` (`src/service/scoring.ts`, pure) weighs views 3, dwell 2 per
  minute (capped at 30 min per member-day), downloads 5, human opens 2 and human clicks 4, each
  halving every `days / 2` days and worth nothing past the window, squashed onto 0–100 as
  `100·(1 − e^(−raw/30))`. Automated opens and clicks score zero. The list ranks **external**
  members only, only under `engagement` (behavioural scoring is not strictly-necessary logging) and only while `legal.allowsPurpose(member, "analytics_engagement")` holds;
  it is capped at 200 rows and every row carries its points and counts. The CSV is RFC 4180 +
  BOM, frozen columns, formula-injection guarded (`=`, `+`, `-`, `@`, tab, CR get an
  apostrophe), `no-store`, and audited (`analytics.hot_list_exported`).
- **Hot-lead alerts.** After each walk, `analytics.rollup` scores every member active in
  the window (not only the walked ones: an email open stamped with the provider's time often
  lands behind the cursor) and publishes `analytics.hot_lead {membershipId, score}` for each at
  or above `hotLeadThreshold`, at most once per member per `hotListWindowDays` (the claim and
  the outbox row share a transaction). Nothing while the threshold is `null` or the mode is not
  `engagement`. Latency is the rollup cadence, ≤ 5 minutes.
- **Retention.** `analytics.maintain` (daily) creates partitions three months ahead; then, per
  workspace, deletes that workspace's raw events and view sessions older than its own
  `retentionMonths` (on the same month boundary the partition drop uses: rows older than
  `retention + 1` months before the start of the current month), and the per-member rollups
  whose last activity is older (`viewer_resource_rollup.last_at`, `page_viewer.last_at`,
  `hot_lead_alert.alerted_at`) — **skipped while `legal.legalHold` is set**; then drops the
  shared partitions older than the *longest* retention among **all** workspaces, soft-deleted
  ones included (their rows stay in the partitions until purge), **unless any of them is on
  legal hold**. A partition holds every tenant's rows, so the drop only reclaims what no
  workspace may keep; shorter retentions are the per-workspace trim's job. The anonymous
  rollups (`daily_resource_rollup`, `page_rollup`) are never dropped.
- **Transparency.** `GET /notice` tells the caller what this workspace records under the current
  mode (`tracksFor`; `engagement` adds `email_opens`, `email_clicks` and `engagement_score` — the
  hot list) and, as `emailTracking {granted, active}`, their own `email_tracking` answer and
  whether opens/clicks are recorded for them now; the portal shows it whether or not the mode is
  `engagement`.
- **DSAR.** `POST /members/{membershipId}/anonymise` deletes that member's events, open pages,
  view sessions, per-viewer rollups, heatmap reader rows and hot-lead marker; the daily and page
  counts stay because they name nobody. The kernel's erasure request publishes
  `member.erasure_requested`; the subscriber runs the same erasure in the dispatcher's
  transaction, audits `analytics.anonymised` (actor `system`, `meta.requestId`) and reports the
  counts through `legal.completeErasureStep(…, "analytics", counts)` — so a failed report rolls
  the erasure back rather than leaving a request that says "done" over rows that are not. The
  staff route is refused with 409 `conflict` + `reason: "legal_hold"` under legal hold, like the
  kernel request.
- **Erasure vs. the pipeline.** Facts about a member keep arriving after an erasure (a late ESP
  open, an outbox event in flight, an open tab's heartbeats, a batch the rollup already read).
  Every writer asks `legal.isErased` and drops them: the outbox subscribers, the heartbeat, both
  page_open flushes (an erased member's open pages are deleted, never flushed), the rollup fold
  (re-checked inside its transaction) and the hot list / hot-lead pass. The erasure, the rollup
  walk and both flushes also take one per-workspace advisory lock (`lockWorkspaceAnalytics`) so
  a rollup cannot upsert rows from a batch read before a concurrent erase committed; the erase
  deletes open pages before events either way.

## Routes

| Route | Requires |
| --- | --- |
| `POST /analytics/heartbeat` | `member` |
| `POST /analytics/close` | `member` |
| `GET /analytics/notice` | `member` |
| `GET /analytics/overview` | `analytics.read` |
| `GET /analytics/{kind}/{id}/viewers` | `analytics.read` |
| `GET /analytics/{kind}/{id}/viewers/{membershipId}/pages` | `analytics.read` |
| `GET /analytics/members/{membershipId}/timeline` | `analytics.read` |
| `GET /analytics/{kind}/{id}/heatmap` | `analytics.read` |
| `GET /analytics/hot-list` | `analytics.read` |
| `GET /analytics/hot-list.csv` | `analytics.read` (audited) |
| `GET /analytics/posts/{id}/email` | `analytics.read` |
| `GET /analytics/settings` | `analytics.read` |
| `PATCH /analytics/settings` | `analytics.settings` + fresh |
| `POST /analytics/members/{membershipId}/anonymise` | `analytics.settings` + fresh |

The staff routes answer an external caller with 404, not 403 (no oracle). The member-facing
three are open to every live member, investors included: they are how the portal reports its own
reading, and the transparency notice must be readable by the person being measured.

## Permissions, audit, settings

`analytics.read` (every staff role), `analytics.settings` (owner, admin). Audit actions:
`analytics.settings_changed`, `analytics.anonymised`, `analytics.hot_list_exported`. Workspace
settings (`core.workspace.settings.analytics`): `mode` (`off` | `essential` | `engagement`),
`retentionMonths` (1–120, default 13), `hotListWindowDays` (1–90, default 14) and
`hotLeadThreshold` (1–100 or `null` = alerts off, default 60). Retention and the staff erasure
also read `legal.legalHold`.

Events: handles `document.viewed`, `document.downloaded`, `update.viewed`,
`mail.delivery_recorded`, `member.erasure_requested`; emits `analytics.hot_lead`. The E2.6
subscribers need `ModuleServices`, captured (behind `isLiveModuleServices`) when the routes are
mounted or the jobs resolved.

## Testing

`foldBatch` incl. the heatmap fold and the email skip (`src/jobs.test.ts`), `hotScore` with
automated exclusion and recency decay (`src/service/scoring.test.ts`), the CSV escaping and
formula guard (`src/service/csv.test.ts`), the day window and keyset cursor
(`src/service/range.test.ts`) and the privacy helpers (`src/privacy.test.ts`) are pure and unit
tested. Everything else needs
Postgres: partitioning, RLS and the rollup walk belong in `*.integration.test.ts`.

## Known gaps

- The rollup's keyset walks `occurred_at`, and a fact stamped with its source time that commits
  more than the 10 s settle window late (a slow outbox relay) lands behind the cursor and is
  never folded into the rollups (raw reads still see it). Email events are unaffected — they are
  not folded, and the alert pass reads the raw window — but `document.viewed` et al. can be.
- Hot-list consent is checked per ranked member (bounded at 200 per read); a very large
  workspace would want the consent state joined in SQL.

- A beat is tied to an authorised open, not to a live access check: a member whose grant is
  revoked mid-read keeps beating until the tab closes. Revocation ends the *delivery* of pages
  at once (the data-room route re-checks); only the dwell tail is affected.
- Resource titles are not carried on any response — analytics stores ids for resources other
  modules own, and the admin screens resolve names client-side. A `title` on
  `AnalyticsTopResource` / `AnalyticsRecentEvent` would need a kernel seam that resolves a
  `ResourceRef` through the owning module (`blockHydrators` is the precedent).

## Portability

`src/portability.ts` (`analyticsPortability`) — how analytics travels in a workspace
export/import. Every table is declared as rows, in FK order.

- **Raw data only on request.** `view_session`, `event` and `page_open` carry
  `includeWhen: "rawAnalytics"`: they are exported only when the export was requested with
  `includeRawAnalytics` (per-member behavioural data is opt-in egress). Otherwise the manifest
  lists them as excluded.
  - `view_session.ip_hash` is an HMAC under the *source* workspace's `analytics-ip` key and
    cannot be re-keyed: omitted (NULL in the copy). `session_key` (sha256 of a kernel session id
    that does not exist on the target) is omitted and replaced by a fresh unique 32-byte value
    derived from the row's new id.
  - `event` is range-partitioned by month with no default partition. `beforeImport` creates the
    partitions for the whole retention window (120 months back — the `retentionMonths` maximum —
    through the usual months ahead) with `analytics.ensure_partitions`, only when events are
    being imported; empty ones are dropped by the next `analytics.maintain`. An event outside the
    window (only possible under a very long legal hold) is dropped rather than failing the import.
    As on any instance, the shared-partition drop in `maintain` follows the longest retention /
    legal hold across all workspaces on the target.
  - `page_open` (the heartbeat buffer) moves with its sessions; the target's flush job turns it
    into the `page_viewed` event it would have become.
- **Rollups always move**: `viewer_resource_rollup`, `daily_resource_rollup`, `page_rollup`,
  `page_viewer`, `hot_lead_alert` are the durable analytics record. Member, resource and
  version ids are remapped by the engine (the zero-uuid `version_key` is not an id and stays).
- **`rollup_cursor` moves too** — the rollups already contain every event up to it, so a fresh
  cursor would fold every imported raw event into them a second time.

`src/portability.test.ts` covers every `importRow`, the hash omission, the partition hook and
parses `migrations/` for every `CREATE TABLE analytics.*` (partitions excluded).
