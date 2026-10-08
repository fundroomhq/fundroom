-- 0003_weekly_cadence — a weekly digest cadence (EXECUTION_PLAN §15 E2.6, design/03 C2).
--
-- Hand-written (ADR-0004). A file of its own on purpose: `ALTER TYPE … ADD VALUE` may run inside
-- a transaction (the runner wraps each file in one), but the new label cannot be *used* until
-- that transaction commits. Keeping it alone means nothing in the same transaction can trip on
-- it, and 0004 — which does refer to it — runs in a transaction of its own after this commits.

ALTER TYPE notify.cadence ADD VALUE IF NOT EXISTS 'weekly' AFTER 'daily';
