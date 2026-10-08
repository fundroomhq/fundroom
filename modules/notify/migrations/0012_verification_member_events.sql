-- 0012_verification_member_events — accreditation verification alerts to the investor (EXECUTION_PLAN
-- §15 E3.7, ADR-0055).
--
-- Hand-written (ADR-0004). The TypeScript views are src/schema/notify.ts and src/rules.ts
-- (`NOTIFY_EVENT_TYPES`, `CHANNEL_EVENT_TYPES`), which the event-type CHECKs must agree with
-- exactly: a disagreement shows up as a constraint violation inside an event handler — an outbox
-- row that retries for ever.
--
-- event types (both instant, addressed to the investor the verification belongs to, by email;
-- neither is a channel event — each is about one person's accreditation):
--  * `round.verification_expiring`: the investor's verified accreditation expires soon (the round
--    lifecycle job publishes it once per verification, `reverification.reminderDays` ahead).
--  * `round.verification_decided`: the investor's verification was settled — verified, rejected or
--    expired. Neutral copy, no amounts, a link to the portal.
--
-- The channel CHECK is unchanged (0011's definition stays in force).

--> statement-breakpoint
ALTER TABLE notify.preference DROP CONSTRAINT preference_event_type;
ALTER TABLE notify.preference ADD CONSTRAINT preference_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added', 'qa.question_asked', 'qa.question_assigned', 'qa.answer_submitted', 'qa.answer_released', 'qa.question_declined', 'qa.question_due', 'esign.envelope_attention', 'round.signature_completed', 'round.commitment_confirmed', 'integration.connection_unhealthy', 'round.verification_expiring', 'round.verification_decided'));

--> statement-breakpoint
ALTER TABLE notify.notification DROP CONSTRAINT notification_event_type;
ALTER TABLE notify.notification ADD CONSTRAINT notification_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added', 'qa.question_asked', 'qa.question_assigned', 'qa.answer_submitted', 'qa.answer_released', 'qa.question_declined', 'qa.question_due', 'esign.envelope_attention', 'round.signature_completed', 'round.commitment_confirmed', 'integration.connection_unhealthy', 'round.verification_expiring', 'round.verification_decided'));

SELECT core.apply_tenant_fence();
