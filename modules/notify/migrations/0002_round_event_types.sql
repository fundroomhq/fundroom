-- 0002_round_event_types — admit the two round events to the notification vocabulary
-- (EXECUTION_PLAN §15 E2.5, design/03 A4/E2, ADR-0043).
--
-- Hand-written (ADR-0004). The TypeScript view is src/rules.ts (`NOTIFY_EVENT_TYPES`), which
-- this must agree with exactly: the CHECKs are what stops a stored preference or notification
-- naming an event no handler answers to, and a disagreement shows up as a constraint violation
-- inside an event handler — i.e. as an outbox row that retries for ever.
--
-- `round.interest_submitted` — a member indicated interest in the open round.
-- `round.verification_requested` — a 506(c) accreditation verification was opened for a member.
--
-- Both are instant by default (src/rules.ts `DEFAULT_CADENCE`) and both are addressed to staff
-- holding `round.manage` rather than `notify.read`, which is a fan-out decision and needs no
-- schema: the event type is stored, the permission is not.
--
-- A CHECK cannot be extended in place, so each is dropped and recreated with the full list.
-- Existing rows are unaffected: every value they hold is still in it. NOT VALID is deliberately
-- not used — the constraint is widening, so there is nothing to skip validating.

ALTER TABLE notify.preference DROP CONSTRAINT preference_event_type;
ALTER TABLE notify.preference ADD CONSTRAINT preference_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested'));

--> statement-breakpoint
ALTER TABLE notify.notification DROP CONSTRAINT notification_event_type;
ALTER TABLE notify.notification ADD CONSTRAINT notification_event_type CHECK (event_type IN ('document.viewed', 'document.downloaded', 'update.replied', 'round.interest_submitted', 'round.verification_requested'));

SELECT core.apply_tenant_fence();
