-- 0013_document_scan_infected — the virus scanner flagged an upload (E-UP-25 25.5).
--
-- Hand-written (ADR-0004). The TypeScript views are src/schema/notify.ts and src/rules.ts
-- (`NOTIFY_EVENT_TYPES`, `CHANNEL_EVENT_TYPES`), which the event-type CHECKs must agree with
-- exactly: a disagreement shows up as a constraint violation inside an event handler — an outbox
-- row that retries for ever.
--
-- event type (instant, a security matter; never a channel event):
--  * `document.scan_infected`: the data room's ingest job found malware in an upload. The file stays
--    quarantined. Addressed to staff holding `data-room.manage` and to the uploader, no actor,
--    `resource_kind = 'document'` (or `'blob'` when no document version points at it), one alert
--    per blob.
--
-- The channel CHECK is unchanged (0011's definition stays in force).

--> statement-breakpoint
ALTER TABLE notify.preference DROP CONSTRAINT preference_event_type;
ALTER TABLE notify.preference ADD CONSTRAINT preference_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added', 'qa.question_asked', 'qa.question_assigned', 'qa.answer_submitted', 'qa.answer_released', 'qa.question_declined', 'qa.question_due', 'esign.envelope_attention', 'round.signature_completed', 'round.commitment_confirmed', 'integration.connection_unhealthy', 'round.verification_expiring', 'round.verification_decided', 'document.scan_infected'));

--> statement-breakpoint
ALTER TABLE notify.notification DROP CONSTRAINT notification_event_type;
ALTER TABLE notify.notification ADD CONSTRAINT notification_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested', 'round.commitment_created', 'analytics.hot_lead', 'access_request.submitted', 'access_review.overdue', 'membership.delegate_added', 'qa.question_asked', 'qa.question_assigned', 'qa.answer_submitted', 'qa.answer_released', 'qa.question_declined', 'qa.question_due', 'esign.envelope_attention', 'round.signature_completed', 'round.commitment_confirmed', 'integration.connection_unhealthy', 'round.verification_expiring', 'round.verification_decided', 'document.scan_infected'));

SELECT core.apply_tenant_fence();
