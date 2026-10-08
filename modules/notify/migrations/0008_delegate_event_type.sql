-- 0008_delegate_event_type — admit the new-delegate alert to the notification vocabulary
-- (EXECUTION_PLAN §15 E3.2; design/05 §7 "Delegate abuse": principal and admin both notified).
--
-- Hand-written (ADR-0004). The TypeScript view is src/rules.ts (`NOTIFY_EVENT_TYPES`), which this
-- must agree with exactly: a disagreement shows up as a constraint violation inside an event
-- handler — an outbox row that retries for ever.
--
-- `membership.delegate_added` — a delegate invitation acting for an investor was issued, by the
-- investor or by staff. Instant by default, addressed to staff holding `access.manage` and to the
-- principal (the only external recipient). One row per invitation (`bucket` = invite id). Not a
-- channel event: it names a person, so `notify.channel`'s CHECK is left as 0007 wrote it.
--
-- Each CHECK is dropped and recreated with the full list (the last definitions are 0007's).
-- Existing rows are unaffected: every value they hold is still in the list.

ALTER TABLE notify.preference DROP CONSTRAINT preference_event_type;
ALTER TABLE notify.preference ADD CONSTRAINT preference_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added'));

--> statement-breakpoint
ALTER TABLE notify.notification DROP CONSTRAINT notification_event_type;
ALTER TABLE notify.notification ADD CONSTRAINT notification_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added'));

SELECT core.apply_tenant_fence();
