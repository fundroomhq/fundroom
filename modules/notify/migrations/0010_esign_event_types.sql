-- 0010_esign_event_types — admit the e-signature and round-closing alerts to the notification
-- vocabulary (EXECUTION_PLAN §15 E3.5, ADR-0053).
--
-- Hand-written (ADR-0004). The TypeScript view is src/rules.ts (`NOTIFY_EVENT_TYPES`,
-- `CHANNEL_EVENT_TYPES`), which this must agree with exactly: a disagreement shows up as a
-- constraint violation inside an event handler — an outbox row that retries for ever.
--
-- All three are instant by default:
--  - `esign.envelope_attention`   staff: an envelope was declined, voided, expired or failed
--                                 (`resource_kind = 'esign_envelope'`, `resource_id` = the envelope);
--  - `round.signature_completed`  staff: a commitment's subscription agreement was signed
--                                 (`resource_kind = 'commitment'`);
--  - `round.commitment_confirmed` the investor (an external recipient, by email): the company
--                                 confirmed their commitment (`resource_kind = 'commitment'`).
-- None is a channel event: each names a person's signature or money. The channel CHECK is
-- therefore unchanged (0007's definition, re-stated by 0009, stays in force).
--
-- The two event-type CHECKs are dropped and recreated with the full list (the last definitions are
-- 0009's). Existing rows are unaffected: every value they hold is still in the list.

ALTER TABLE notify.preference DROP CONSTRAINT preference_event_type;
ALTER TABLE notify.preference ADD CONSTRAINT preference_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added', 'qa.question_asked', 'qa.question_assigned', 'qa.answer_submitted', 'qa.answer_released', 'qa.question_declined', 'qa.question_due', 'esign.envelope_attention', 'round.signature_completed', 'round.commitment_confirmed'));

--> statement-breakpoint
ALTER TABLE notify.notification DROP CONSTRAINT notification_event_type;
ALTER TABLE notify.notification ADD CONSTRAINT notification_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added', 'qa.question_asked', 'qa.question_assigned', 'qa.answer_submitted', 'qa.answer_released', 'qa.question_declined', 'qa.question_due', 'esign.envelope_attention', 'round.signature_completed', 'round.commitment_confirmed'));

SELECT core.apply_tenant_fence();
