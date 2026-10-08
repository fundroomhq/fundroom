-- 0011_slack_app_channels — Slack app channels and the integration-health alert (EXECUTION_PLAN
-- §15 E3.6, ADR-0054).
--
-- Hand-written (ADR-0004). The TypeScript views are src/schema/notify.ts and src/rules.ts
-- (`NOTIFY_EVENT_TYPES`, `CHANNEL_EVENT_TYPES`), which the event-type CHECKs must agree with
-- exactly: a disagreement shows up as a constraint violation inside an event handler — an outbox
-- row that retries for ever.
--
-- channel
--  * A second kind, `slack_app`: a channel of the workspace's Slack app connection (the kernel's
--    `core.integration_connection`, provider `slack`), addressed by Slack's channel id. It holds
--    no credential at all — the bot token is the kernel's, and posting goes through
--    `ModuleServices.integrations.slackPost` — so `url_enc` / `url_hint` become NULL-able and the
--    kind decides which half of the row is filled: an incoming webhook has a sealed URL and no
--    Slack channel id, an app channel the reverse. `encryption` stays NOT NULL with its `{}`
--    default (an app channel simply carries the empty descriptor).
--  * `slack_channel_name` is a display copy taken from the channel list when the channel was
--    chosen (Slack renames do not reach it until an admin re-picks the channel).
--  * At most one app channel per Slack channel per workspace: two would post every alert twice.
--  * `disabled_reason` gains `not_connected`: the Slack app was disconnected (or never connected
--    in a workspace copy) — reconnect Slack, then switch the channel back on.
--
-- event types
--  * `integration.connection_unhealthy` (instant, staff holding `integrations.manage` — owners and
--    admins): a KPI source, the Slack app or a booking connection needs re-authorising
--    (`reauth_required`) or keeps failing (`degraded`). A workspace event — no actor — and a
--    channel event: the post names the vendor and the state, nobody's data.
--
-- Existing rows are unaffected: every channel is `slack` with a URL, and every stored event type
-- is still in the lists (the last definitions are 0010's for preference/notification and 0009's
-- for the channel).

ALTER TABLE notify.channel
  ALTER COLUMN url_enc DROP NOT NULL,
  ALTER COLUMN url_hint DROP NOT NULL,
  ADD COLUMN slack_channel_id text,
  ADD COLUMN slack_channel_name text;

ALTER TABLE notify.channel DROP CONSTRAINT channel_kind;
ALTER TABLE notify.channel DROP CONSTRAINT channel_disabled_reason;
ALTER TABLE notify.channel
  ADD CONSTRAINT channel_kind CHECK (kind IN ('slack', 'slack_app')),
  ADD CONSTRAINT channel_kind_webhook CHECK ((kind = 'slack') = (url_enc IS NOT NULL)),
  ADD CONSTRAINT channel_kind_webhook_hint CHECK ((kind = 'slack') = (url_hint IS NOT NULL)),
  ADD CONSTRAINT channel_kind_slack_app CHECK ((kind = 'slack_app') = (slack_channel_id IS NOT NULL)),
  ADD CONSTRAINT channel_slack_channel_id_format CHECK (slack_channel_id IS NULL OR slack_channel_id ~ '^[A-Z0-9]{1,40}$'),
  ADD CONSTRAINT channel_slack_channel_name_length CHECK (slack_channel_name IS NULL OR char_length(slack_channel_name) <= 200),
  ADD CONSTRAINT channel_disabled_reason CHECK (disabled_reason IS NULL OR disabled_reason IN ('not_found', 'rejected', 'invalid_url', 'not_connected'));

CREATE UNIQUE INDEX channel_slack_app_idx ON notify.channel (workspace_id, slack_channel_id)
  WHERE kind = 'slack_app';

--> statement-breakpoint
ALTER TABLE notify.preference DROP CONSTRAINT preference_event_type;
ALTER TABLE notify.preference ADD CONSTRAINT preference_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added', 'qa.question_asked', 'qa.question_assigned', 'qa.answer_submitted', 'qa.answer_released', 'qa.question_declined', 'qa.question_due', 'esign.envelope_attention', 'round.signature_completed', 'round.commitment_confirmed', 'integration.connection_unhealthy'));

--> statement-breakpoint
ALTER TABLE notify.notification DROP CONSTRAINT notification_event_type;
ALTER TABLE notify.notification ADD CONSTRAINT notification_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added', 'qa.question_asked', 'qa.question_assigned', 'qa.answer_submitted', 'qa.answer_released', 'qa.question_declined', 'qa.question_due', 'esign.envelope_attention', 'round.signature_completed', 'round.commitment_confirmed', 'integration.connection_unhealthy'));

--> statement-breakpoint
ALTER TABLE notify.channel DROP CONSTRAINT channel_event_types;
ALTER TABLE notify.channel ADD CONSTRAINT channel_event_types CHECK (event_types <@ ARRAY['analytics.hot_lead', 'round.interest_submitted', 'round.commitment_created', 'round.verification_requested', 'access_request.submitted', 'access_review.overdue', 'qa.question_asked', 'integration.connection_unhealthy']::text[]);

SELECT core.apply_tenant_fence();
