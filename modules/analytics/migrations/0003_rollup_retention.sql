-- 0003_rollup_retention — retention for the per-member heatmap reader rows (E2.6 fix).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/analytics.ts.
--
-- `analytics.maintain` trims every per-member rollup whose last activity is older than the
-- workspace's `retentionMonths` (skipped under legal hold): `viewer_resource_rollup.last_at`,
-- `hot_lead_alert.alerted_at` and — new here — `page_viewer.last_at`, which the rollup touches
-- every time the member reads the page again. Existing rows start at the migration time.

ALTER TABLE analytics.page_viewer ADD COLUMN last_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX page_viewer_last_at_idx ON analytics.page_viewer (workspace_id, last_at);
