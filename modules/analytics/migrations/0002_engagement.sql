-- 0002_engagement — email opens/clicks, page heatmap rollup, hot-lead alert state
-- (EXECUTION_PLAN §15 E2.6, design/03 G2, design/04 §3.2, design/06 §6).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/analytics.ts.
--
--  * event.type gains `email_opened` and `email_clicked`. They arrive from the kernel's ESP
--    webhook as `mail.delivery_recorded` (resource_kind `post`, the update the email carried).
--    `props` carries `messageRef` (core.mail_message id, the dedupe key with type + time),
--    `automated` (Apple MPP prefetch or link scanner: stored, never scored) and, for clicks,
--    `link` (origin + path only). ALTER on the partitioned parent reaches every partition.
--  * page_rollup     the aggregate page heatmap: per (resource, version, page) total dwell,
--                    page reads and distinct readers, fed by `analytics.rollup` from
--                    `page_viewed`. `version_key` is the version id, or the zero uuid when the
--                    viewer did not report one (a primary key cannot hold NULL). Counts only.
--  * page_viewer     the distinct-reader set behind `page_rollup.viewers`: one row per
--                    (resource, version, page, member). The rollup increments `viewers` only
--                    when a row is new, so erasing a member (DSAR) deletes their rows here
--                    without rewriting the anonymous counts.
--  * hot_lead_alert  when a member was last announced as a hot lead: at most once per member
--                    per scoring window (`analytics.hotListWindowDays`).

ALTER TABLE analytics.event DROP CONSTRAINT event_type;
ALTER TABLE analytics.event ADD CONSTRAINT event_type CHECK (type IN (
  'document_viewed', 'page_viewed', 'document_downloaded', 'update_viewed',
  'email_opened', 'email_clicked'
));

-- The email dedupe probe: (resource, type, time) narrows to a handful of rows per message.
CREATE INDEX event_email_ref_idx ON analytics.event (workspace_id, resource_id, type, occurred_at)
  WHERE type IN ('email_opened', 'email_clicked');

--> statement-breakpoint
CREATE TABLE analytics.page_rollup (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  resource_kind text NOT NULL,
  resource_id uuid NOT NULL,
  -- the document version read, or '00000000-0000-0000-0000-000000000000' when unknown
  version_key uuid NOT NULL,
  page_no integer NOT NULL,
  total_ms bigint NOT NULL DEFAULT 0,
  views integer NOT NULL DEFAULT 0,
  viewers integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, resource_id, version_key, page_no),
  CONSTRAINT page_rollup_resource_kind CHECK (resource_kind IN ('document', 'post')),
  CONSTRAINT page_rollup_page_no_positive CHECK (page_no >= 1)
);

CREATE TABLE analytics.page_viewer (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  resource_id uuid NOT NULL,
  version_key uuid NOT NULL,
  page_no integer NOT NULL,
  membership_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, resource_id, version_key, page_no, membership_id)
);
CREATE INDEX page_viewer_membership_idx ON analytics.page_viewer (workspace_id, membership_id);

CREATE TABLE analytics.hot_lead_alert (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  alerted_at timestamptz NOT NULL DEFAULT now(),
  score integer NOT NULL,
  PRIMARY KEY (workspace_id, membership_id),
  CONSTRAINT hot_lead_alert_score CHECK (score BETWEEN 0 AND 100)
);

--> statement-breakpoint
ALTER TABLE analytics.page_rollup ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.page_rollup FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON analytics.page_rollup AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY page_rollup_staff ON analytics.page_rollup FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE analytics.page_viewer ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.page_viewer FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON analytics.page_viewer AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY page_viewer_staff ON analytics.page_viewer FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE analytics.hot_lead_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.hot_lead_alert FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON analytics.hot_lead_alert AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY hot_lead_alert_staff ON analytics.hot_lead_alert FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
SELECT core.apply_tenant_fence();
