-- 0002_delivery_feedback — delivery feedback from ESP webhooks (E2.6): a `delivered` recipient
-- status, per-send delivered/bounced/complained counters, and the index the
-- `mail.delivery_recorded` subscriber finds a recipient by.
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/updates.ts. Runs inside one
-- transaction. `ALTER TYPE … ADD VALUE` is legal inside a transaction block (PostgreSQL 12+) as
-- long as nothing in the same transaction *uses* the new label, and nothing here does.
--
-- Adding columns and an index to tables this module already owns needs no new grants or policy:
-- the tenant fence and the `seedhost_app` privileges on updates.* cover them.
--
-- The recipient ladder is monotonic (see src/service/feedback.ts): queued → sent → delivered →
-- bounced → complained. A bounce or a complaint is never downgraded by a later `delivered`, and
-- opens/clicks never touch this table (they are analytics' business, not delivery's).

ALTER TYPE updates.recipient_status ADD VALUE IF NOT EXISTS 'delivered' AFTER 'sent';

-- Maintained by the subscriber in the same transaction as the recipient row it moves, as
-- deltas (the row lock on the recipient serialises two events for one address), so a send's
-- stats never need a GROUP BY over its recipients to read.
ALTER TABLE updates.send
  ADD COLUMN delivered integer NOT NULL DEFAULT 0,
  ADD COLUMN bounced integer NOT NULL DEFAULT 0,
  ADD COLUMN complained integer NOT NULL DEFAULT 0;

-- The provider message id is the only thing a delivery event carries that names the recipient.
-- Partial: queued/skipped/failed rows have none and there is nothing to find them by.
CREATE INDEX recipient_message_idx ON updates.recipient (workspace_id, message_id)
  WHERE message_id IS NOT NULL;
