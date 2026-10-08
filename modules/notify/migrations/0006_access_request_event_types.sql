-- 0006_access_request_event_types — admit the access-request alert to the notification
-- vocabulary and to workspace chat channels (EXECUTION_PLAN §15 E3.1).
--
-- Hand-written (ADR-0004). The TypeScript view is src/rules.ts (`NOTIFY_EVENT_TYPES`,
-- `CHANNEL_EVENT_TYPES`), which this must agree with exactly: a disagreement shows up as a
-- constraint violation inside an event handler — an outbox row that retries for ever.
--
-- `access_request.submitted` — a prospective investor who is not a member verified their email
-- and their request is waiting in the approval queue. Instant by default, addressed to staff
-- holding `access.manage` (a fan-out decision; the permission is not stored). An auto-approved
-- request never produces a row: the handler re-reads the request and skips unless `pending`.
-- The requester's name is read from `core.access_request` when an alert is rendered and is never
-- stored here; a channel post names nobody at all.
--
-- Each CHECK is dropped and recreated with the full list (the last definitions are 0004's).
-- Existing rows are unaffected: every value they hold is still in the list.

ALTER TABLE notify.preference DROP CONSTRAINT preference_event_type;
ALTER TABLE notify.preference ADD CONSTRAINT preference_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted'));

--> statement-breakpoint
ALTER TABLE notify.notification DROP CONSTRAINT notification_event_type;
ALTER TABLE notify.notification ADD CONSTRAINT notification_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted'));

--> statement-breakpoint
ALTER TABLE notify.channel DROP CONSTRAINT channel_event_types;
ALTER TABLE notify.channel ADD CONSTRAINT channel_event_types CHECK (event_types <@ ARRAY['analytics.hot_lead', 'round.interest_submitted', 'round.commitment_created', 'round.verification_requested', 'access_request.submitted']::text[]);

SELECT core.apply_tenant_fence();
