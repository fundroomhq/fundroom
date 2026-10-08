-- 0007_access_review_event_types — admit the overdue access-review reminder to the notification
-- vocabulary and to workspace chat channels (EXECUTION_PLAN §15 E3.2).
--
-- Hand-written (ADR-0004). The TypeScript view is src/rules.ts (`NOTIFY_EVENT_TYPES`,
-- `CHANNEL_EVENT_TYPES`), which this must agree with exactly: a disagreement shows up as a
-- constraint violation inside an event handler — an outbox row that retries for ever.
--
-- `access_review.overdue` — identity's daily `access-review.overdue` job found the workspace's
-- next access review past due (last review + 90 days, or creation + 90 days if never reviewed).
-- Instant by default, addressed to staff holding `access.manage`, no actor (a fact about the
-- workspace: `resource_kind = 'workspace'`), and bucketed by ISO week so a workspace gets at most
-- one reminder a week. A channel post names nobody.
--
-- Each CHECK is dropped and recreated with the full list (the last definitions are 0006's).
-- Existing rows are unaffected: every value they hold is still in the list.

ALTER TABLE notify.preference DROP CONSTRAINT preference_event_type;
ALTER TABLE notify.preference ADD CONSTRAINT preference_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue'));

--> statement-breakpoint
ALTER TABLE notify.notification DROP CONSTRAINT notification_event_type;
ALTER TABLE notify.notification ADD CONSTRAINT notification_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue'));

--> statement-breakpoint
ALTER TABLE notify.channel DROP CONSTRAINT channel_event_types;
ALTER TABLE notify.channel ADD CONSTRAINT channel_event_types CHECK (event_types <@ ARRAY['analytics.hot_lead', 'round.interest_submitted', 'round.commitment_created', 'round.verification_requested', 'access_request.submitted', 'access_review.overdue']::text[]);

SELECT core.apply_tenant_fence();
