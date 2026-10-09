---
"@fundroom/module-analytics": minor
"@fundroom/module-notify": minor
"@fundroom/module-updates": minor
"@fundroom/module-kit": patch
"@fundroom/authz": minor
"@fundroom/sdk": minor
"@fundroom/server": minor
"@fundroom/web": minor
---

Engagement analytics and staff notifications. Two new module packages. `@fundroom/module-analytics` (`analytics` schema: `view_session`, `event` RANGE-partitioned by month, the `page_open` dwell accumulator, per-viewer and per-day rollups behind a keyset cursor; `/api/v1/analytics/*`: the page-dwell heartbeat and close beacon, the investor transparency notice, the staff overview, per-document "who viewed", per-viewer page dwell, the keyset-paged per-contact timeline, mode/retention settings and DSAR erasure; jobs `analytics.flush`, `analytics.rollup` and `analytics.maintain` for partition creation and retention drops). `@fundroom/module-notify` (`notify` schema: per-member cadence preferences, member settings, the inbox and digests; `/api/v1/notify/*`; fan-out from `document.viewed`, `document.downloaded` and `update.replied` deduped on a UNIQUE hour-bucket key, instant email marked sent by compare-and-set, one daily digest per member; jobs `notify.deliver` and `notify.digest`). `modules/updates` now publishes `update.viewed` from the archive read for external readers — the topic was catalogued and consumed but never emitted. Matrix permissions `analytics.read` / `analytics.settings` (`notify.read` was already present) and ten new analytics routes. Web: `/admin/analytics` (overview, who-viewed, per-page dwell, contact timeline, settings with the `fresh` step-up, DSAR erase), `/admin/notify` (inbox and preferences), the dwell heartbeat wired into the data-room viewer, and the investor "what this workspace records" notice on the portal settings page.

Privacy is in the schema rather than in a setting: no email address, IP address or User-Agent string is stored — a hashed session id, a browser family and an IP HMAC under the workspace's `analytics-ip` data key — and `analytics.mode` (`off | essential | engagement`) silences the writers. A heartbeat is accepted only when the caller's session already carries a server-recorded view of that resource, so a member cannot record dwell against — or appear in the "who viewed" list of — a document they never opened.
