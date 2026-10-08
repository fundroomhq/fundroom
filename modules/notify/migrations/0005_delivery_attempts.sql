-- 0005_delivery_attempts — bounded retries for instant email and crash-safe digests
-- (EXECUTION_PLAN §15 E2.6, review fixes).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/notify.ts. Runs in one transaction.
--
-- notification
--  * `attempts` / `next_attempt_at` / `last_error`: an instant email is *claimed* before it is
--    sent (attempts + 1, next_attempt_at pushed out by an exponential backoff that doubles as the
--    claim's lease), sent outside any transaction, then marked. A mailer failure that is not a
--    suppression leaves the row for the next attempt at `next_attempt_at`; after
--    NOTIFY_MAX_ATTEMPTS it is closed with `email_outcome = 'failed'`. The sweep orders by
--    (attempts, created_at) and skips rows whose next attempt is not due, so a pile of
--    permanently failing rows can no longer fill every batch and starve newer alerts.
--  * `last_error` holds an error *code* (e.g. `rejected`), never provider text — an SMTP
--    diagnostic routinely quotes the address.
--
-- digest
--  * A digest is claimed (its row written with `sent_at` NULL and the notifications attached via
--    `digest_id`) and committed *before* the email is sent. `slot` is the schedule slot being
--    served (ISO instant); the ESP idempotency key is derived from (member, kind, slot), so a
--    retry after a lost acknowledgement or a failed commit re-sends under the same key and the
--    provider drops the duplicate. `attempts` bounds the retries.

ALTER TABLE notify.notification
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_error text,
  ADD CONSTRAINT notification_attempts CHECK (attempts >= 0),
  ADD CONSTRAINT notification_last_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 100);

ALTER TABLE notify.notification DROP CONSTRAINT notification_email_outcome;
ALTER TABLE notify.notification ADD CONSTRAINT notification_email_outcome CHECK (email_outcome IS NULL OR email_outcome IN ('emailed', 'digested', 'suppressed', 'email_off', 'no_address', 'failed'));

ALTER TABLE notify.digest
  ALTER COLUMN sent_at DROP NOT NULL,
  ALTER COLUMN sent_at DROP DEFAULT,
  ADD COLUMN slot text,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT digest_slot_length CHECK (slot IS NULL OR char_length(slot) <= 40),
  ADD CONSTRAINT digest_attempts CHECK (attempts >= 0);

-- One digest per member, kind and slot: two runs racing for the same slot claim one row.
CREATE UNIQUE INDEX digest_slot_idx ON notify.digest (workspace_id, membership_id, kind, slot) WHERE slot IS NOT NULL;
-- Claimed but not yet sent: the next run finishes these first.
CREATE INDEX digest_unsent_idx ON notify.digest (workspace_id, membership_id, kind) WHERE sent_at IS NULL;
