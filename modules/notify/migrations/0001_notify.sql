-- 0001_notify — staff notifications: per-member preferences and settings, the notification
-- inbox, and daily digests (EXECUTION_PLAN §15 E1.5, design/03 C2 "basic", design/06 §6).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/notify.ts. Runs inside one
-- transaction. Tenant tables declare the standard fence inline so nothing can read a row
-- before the runner's core.apply_tenant_fence() pass.
--
-- Model:
--  * preference       (membership, event_type) → cadence (instant | daily | off). No row means
--                     the module default: views/downloads daily, replies instant.
--  * member_settings  per staff member: the UTC hour their digest goes out, and the email
--                     switch (off = inbox only).
--  * notification     one row per recipient per interesting event. `dedupe_key` collapses
--                     bursts (one alert per viewer per document per hour); `cadence` is the
--                     snapshot taken at creation so a later preference change does not move
--                     rows between queues; `sent_at` = processed (emailed, bundled into a
--                     digest, or suppressed because email is off). Payload holds ids and counts
--                     only — names and addresses are resolved at render time.
--  * digest           one row per daily digest email actually sent.

CREATE SCHEMA IF NOT EXISTS notify;
GRANT USAGE ON SCHEMA notify TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA notify GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA notify GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA notify GRANT EXECUTE ON FUNCTIONS TO seedhost_app;

CREATE TYPE notify.cadence AS ENUM ('instant', 'daily', 'off');

--> statement-breakpoint
CREATE TABLE notify.preference (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  event_type text NOT NULL,
  cadence notify.cadence NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, membership_id, event_type),
  CONSTRAINT preference_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied'))
);
CREATE TRIGGER preference_set_updated_at BEFORE UPDATE ON notify.preference
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE notify.member_settings (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  digest_hour_utc integer NOT NULL DEFAULT 8,
  email_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, membership_id),
  CONSTRAINT member_settings_digest_hour CHECK (digest_hour_utc BETWEEN 0 AND 23)
);
CREATE TRIGGER member_settings_set_updated_at BEFORE UPDATE ON notify.member_settings
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE notify.digest (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  count integer NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  message_id text,
  CONSTRAINT digest_count_positive CHECK (count >= 1)
);
CREATE INDEX digest_member_idx ON notify.digest (workspace_id, membership_id, sent_at DESC);

CREATE TABLE notify.notification (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- the staff recipient
  membership_id uuid NOT NULL,
  event_type text NOT NULL,
  dedupe_key text NOT NULL,
  actor_membership_id uuid,
  resource_kind text,
  resource_id uuid,
  -- ids and counts only, e.g. {"documentId": …, "versionId": …} or {"postId": …, "replyId": …}
  payload jsonb NOT NULL DEFAULT '{}',
  payload_schema_version integer NOT NULL DEFAULT 1,
  -- the recipient's cadence when the row was written
  cadence notify.cadence NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  digest_id uuid REFERENCES notify.digest (id) ON DELETE SET NULL,
  read_at timestamptz,
  CONSTRAINT notification_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied')),
  CONSTRAINT notification_cadence_live CHECK (cadence <> 'off'),
  CONSTRAINT notification_dedupe_key_length CHECK (char_length(dedupe_key) BETWEEN 1 AND 300),
  CONSTRAINT notification_dedupe UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX notification_inbox_idx ON notify.notification (workspace_id, membership_id, created_at DESC);
CREATE INDEX notification_pending_idx ON notify.notification (workspace_id, cadence, sent_at) WHERE sent_at IS NULL;

--> statement-breakpoint
-- Row-level security. Preferences, settings and digests: staff and system actors within the
-- workspace. Notifications: the system actor (fan-out, delivery jobs) works on every row; a
-- staff member reads and updates (marks read) only their own inbox — one admin can never see
-- another admin's alerts. External actors see nothing in this schema.
ALTER TABLE notify.preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.preference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON notify.preference AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY preference_staff ON notify.preference FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE notify.member_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.member_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON notify.member_settings AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY member_settings_staff ON notify.member_settings FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE notify.digest ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.digest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON notify.digest AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY digest_staff ON notify.digest FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE notify.notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.notification FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON notify.notification AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY notification_system ON notify.notification FOR ALL
  USING (core.current_actor_kind() = 'system')
  WITH CHECK (core.current_actor_kind() = 'system');
CREATE POLICY notification_staff_own_read ON notify.notification FOR SELECT
  USING (core.current_actor_kind() = 'staff' AND membership_id = core.current_membership());
CREATE POLICY notification_staff_own_update ON notify.notification FOR UPDATE
  USING (core.current_actor_kind() = 'staff' AND membership_id = core.current_membership())
  WITH CHECK (core.current_actor_kind() = 'staff' AND membership_id = core.current_membership());

SELECT core.apply_tenant_fence();
