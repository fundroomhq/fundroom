-- 0009_qa_event_types — admit the data-room Q&A alerts to the notification vocabulary, and the
-- new-question alert to workspace chat channels (EXECUTION_PLAN §15 E3.3, ADR-0051).
--
-- Hand-written (ADR-0004). The TypeScript view is src/rules.ts (`NOTIFY_EVENT_TYPES`,
-- `CHANNEL_EVENT_TYPES`), which this must agree with exactly: a disagreement shows up as a
-- constraint violation inside an event handler — an outbox row that retries for ever.
--
-- All six are instant by default, `resource_kind = 'qa_question'`, `resource_id` = the question:
--  - `qa.question_asked`    staff holding `data-room.qa_manage`; actor = the asker. A channel event
--                           (the post names nobody and quotes nothing);
--  - `qa.question_assigned` the assignee only;
--  - `qa.answer_submitted`  staff holding `data-room.qa_approve`, never the submitter;
--  - `qa.answer_released`   the asker only (an external recipient, by email);
--  - `qa.question_declined` the asker only, by email, when staff close it as declined and choose
--                           to tell them;
--  - `qa.question_due`      the assignee and staff holding `data-room.qa_manage`, once per phase
--                           per deadline.
-- The copy never quotes a question or an answer: that text lives in the `dataroom` schema.
--
-- Each CHECK is dropped and recreated with the full list (the last definitions are 0008's for the
-- two event-type CHECKs and 0007's for the channel one). Existing rows are unaffected: every value
-- they hold is still in the list.

ALTER TABLE notify.preference DROP CONSTRAINT preference_event_type;
ALTER TABLE notify.preference ADD CONSTRAINT preference_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added', 'qa.question_asked', 'qa.question_assigned', 'qa.answer_submitted', 'qa.answer_released', 'qa.question_declined', 'qa.question_due'));

--> statement-breakpoint
ALTER TABLE notify.notification DROP CONSTRAINT notification_event_type;
ALTER TABLE notify.notification ADD CONSTRAINT notification_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added', 'qa.question_asked', 'qa.question_assigned', 'qa.answer_submitted', 'qa.answer_released', 'qa.question_declined', 'qa.question_due'));

--> statement-breakpoint
ALTER TABLE notify.channel DROP CONSTRAINT channel_event_types;
ALTER TABLE notify.channel ADD CONSTRAINT channel_event_types CHECK (event_types <@ ARRAY['analytics.hot_lead', 'round.interest_submitted', 'round.commitment_created', 'round.verification_requested', 'access_request.submitted', 'access_review.overdue', 'qa.question_asked']::text[]);

SELECT core.apply_tenant_fence();
