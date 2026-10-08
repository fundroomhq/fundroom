-- 0004_schedule_channels — digests in the member's own timezone, weekly digests, quiet hours,
-- two more event types, inbox archive + keyset paging, and workspace chat channels
-- (EXECUTION_PLAN §15 E2.6, design/03 C2 "full", ADR-0036 follow-up).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/notify.ts; the event-type lists
-- must agree exactly with src/rules.ts (`NOTIFY_EVENT_TYPES`, `CHANNEL_EVENT_TYPES`). Runs in one
-- transaction, after 0003 has committed the `weekly` cadence label.
--
-- member_settings
--  * `timezone` (IANA name, validated by the API through Intl — Postgres has no cheap check that
--    agrees with Node's tz database) and `digest_hour` (local 0–23) replace `digest_hour_utc`.
--    Existing rows were UTC by construction, so the old hour carries over unchanged.
--  * `weekly_day` 0 = Sunday … 6 = Saturday (the JavaScript convention).
--  * `quiet_start` / `quiet_end`: local hours, both or neither, never equal; `end < start` wraps
--    midnight. Quiet hours defer instant *email* only — the inbox row appears immediately.
--  * `last_daily_digest_at` / `last_weekly_digest_at`: when this member was last served, which is
--    what lets a digest run that missed an hour catch up instead of waiting a day.
--
-- notification
--  * `deferred_until`: an instant email held back by quiet hours; `notify.deliver` sends it then.
--  * `email_outcome`: what processing did with the row (`sent_at` says only *that* it was
--    processed). `suppressed` = the kernel's suppression list refused the address (hard bounce or
--    complaint) — terminal, never retried.
--  * `archived_at`: hidden from the default inbox view, still counted nowhere as unread.
--
-- channel / channel_delivery
--  * A channel is a workspace-level incoming webhook (Slack). The URL is a bearer credential:
--    it is stored envelope-encrypted under the workspace data key purpose `notify-chat`, exactly
--    like metrics' sheet credential, with only its last four characters kept in the clear as a
--    hint. Nothing ever returns or logs it.
--  * `channel_delivery` is the post log and the retry queue in one. `source_key` names the fact
--    being announced (`<event type>:<id>`) so a redelivered outbox event cannot post twice.

--> statement-breakpoint
ALTER TABLE notify.member_settings
  ADD COLUMN timezone text NOT NULL DEFAULT 'UTC',
  ADD COLUMN digest_hour integer NOT NULL DEFAULT 8,
  ADD COLUMN weekly_day integer NOT NULL DEFAULT 1,
  ADD COLUMN quiet_start integer,
  ADD COLUMN quiet_end integer,
  ADD COLUMN last_daily_digest_at timestamptz,
  ADD COLUMN last_weekly_digest_at timestamptz;

UPDATE notify.member_settings SET digest_hour = digest_hour_utc;

ALTER TABLE notify.member_settings DROP CONSTRAINT member_settings_digest_hour;
ALTER TABLE notify.member_settings DROP COLUMN digest_hour_utc;
ALTER TABLE notify.member_settings
  ADD CONSTRAINT member_settings_timezone_length CHECK (char_length(timezone) BETWEEN 1 AND 64),
  ADD CONSTRAINT member_settings_digest_hour CHECK (digest_hour BETWEEN 0 AND 23),
  ADD CONSTRAINT member_settings_weekly_day CHECK (weekly_day BETWEEN 0 AND 6),
  ADD CONSTRAINT member_settings_quiet_hours CHECK (
    (quiet_start IS NULL AND quiet_end IS NULL)
    OR (quiet_start BETWEEN 0 AND 23 AND quiet_end BETWEEN 0 AND 23 AND quiet_start <> quiet_end)
  );

--> statement-breakpoint
ALTER TABLE notify.preference DROP CONSTRAINT preference_event_type;
ALTER TABLE notify.preference ADD CONSTRAINT preference_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead'));

ALTER TABLE notify.notification DROP CONSTRAINT notification_event_type;
ALTER TABLE notify.notification ADD CONSTRAINT notification_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead'));

ALTER TABLE notify.notification
  ADD COLUMN deferred_until timestamptz,
  ADD COLUMN email_outcome text,
  ADD COLUMN archived_at timestamptz,
  ADD CONSTRAINT notification_email_outcome CHECK (email_outcome IS NULL OR email_outcome IN ('emailed', 'digested', 'suppressed', 'email_off', 'no_address'));

-- Keyset paging walks (created_at, id) newest first; the old index had no tiebreak.
DROP INDEX notify.notification_inbox_idx;
CREATE INDEX notification_inbox_idx ON notify.notification (workspace_id, membership_id, created_at DESC, id DESC);
-- Erasure finds the rows a member *caused*, not only the ones addressed to them.
CREATE INDEX notification_actor_idx ON notify.notification (workspace_id, actor_membership_id) WHERE actor_membership_id IS NOT NULL;
-- Retention deletes by age.
CREATE INDEX notification_created_idx ON notify.notification (workspace_id, created_at);

ALTER TABLE notify.digest
  ADD COLUMN kind text NOT NULL DEFAULT 'daily',
  ADD CONSTRAINT digest_kind CHECK (kind IN ('daily', 'weekly'));

--> statement-breakpoint
CREATE TABLE notify.channel (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'slack',
  name text NOT NULL,
  url_enc bytea NOT NULL,
  encryption jsonb NOT NULL DEFAULT '{}',
  encryption_schema_version integer NOT NULL DEFAULT 1,
  url_hint text NOT NULL,
  event_types text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  last_success_at timestamptz,
  last_error text,
  failure_count integer NOT NULL DEFAULT 0,
  -- why the channel switched itself off (a revoked or refused webhook), null when an admin did
  disabled_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_kind CHECK (kind IN ('slack')),
  CONSTRAINT channel_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT channel_url_hint_length CHECK (char_length(url_hint) <= 4),
  CONSTRAINT channel_last_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  CONSTRAINT channel_failure_count CHECK (failure_count >= 0),
  CONSTRAINT channel_disabled_reason CHECK (disabled_reason IS NULL OR disabled_reason IN ('not_found', 'rejected', 'invalid_url')),
  CONSTRAINT channel_event_types CHECK (event_types <@ ARRAY['analytics.hot_lead', 'round.interest_submitted', 'round.commitment_created', 'round.verification_requested']::text[])
);
CREATE INDEX channel_workspace_idx ON notify.channel (workspace_id, created_at);
CREATE TRIGGER channel_set_updated_at BEFORE UPDATE ON notify.channel
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE notify.channel_delivery (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES notify.channel (id) ON DELETE CASCADE,
  source_key text NOT NULL,
  event_type text NOT NULL,
  -- the member the alert is about, when there is one (erasure deletes by it)
  actor_membership_id uuid,
  -- ids only, like notification.payload; names are resolved when the message is rendered
  payload jsonb NOT NULL DEFAULT '{}',
  payload_schema_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT channel_delivery_status CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dropped')),
  CONSTRAINT channel_delivery_source_key_length CHECK (char_length(source_key) BETWEEN 1 AND 200),
  CONSTRAINT channel_delivery_last_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 300),
  CONSTRAINT channel_delivery_dedupe UNIQUE (workspace_id, channel_id, source_key)
);
CREATE INDEX channel_delivery_due_idx ON notify.channel_delivery (workspace_id, next_attempt_at) WHERE status IN ('pending', 'sending');
CREATE INDEX channel_delivery_actor_idx ON notify.channel_delivery (workspace_id, actor_membership_id) WHERE actor_membership_id IS NOT NULL;
CREATE INDEX channel_delivery_created_idx ON notify.channel_delivery (workspace_id, created_at);

--> statement-breakpoint
-- Channels are workspace configuration: staff and system actors within the workspace (the
-- `notify.manage` permission decides which staff reach the routes). External actors see nothing.
ALTER TABLE notify.channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.channel FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON notify.channel AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY channel_staff ON notify.channel FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE notify.channel_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE notify.channel_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON notify.channel_delivery AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY channel_delivery_staff ON notify.channel_delivery FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

SELECT core.apply_tenant_fence();
