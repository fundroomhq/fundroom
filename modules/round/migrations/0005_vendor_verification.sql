-- 0005_vendor_verification — accreditation verifications settled by a vendor (VerifyInvestor.com,
-- Parallel Markets) and the re-verification lifecycle (EXECUTION_PLAN §15 E3.7, ADR-0055).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/round.ts. Runs inside one
-- transaction.
--
--  * verification  gains the vendor side of an attempt. The workspace's vendor connection is kernel
--                  (`core.accreditation_connection`); this row stays the record of the attempt.
--                  `provider` is the driver (`manual` | `verifyinvestor` | `parallel-markets`) and
--                  `provider_ref` the vendor's handle. A vendor never writes here directly: its
--                  callback only wakes a sync job that re-reads the vendor API.
--                    vendor_status / vendor_error / vendor_checked_at  the last vendor answer, raw
--                    vendor_decided_at                                 when the vendor certified
--                                                                     (a renewal must be newer)
--                    next_check_at / check_attempts                   the polling schedule (NULL =
--                                                                     not polled)
--                    handoff (+ schema version)                        what the investor is shown to
--                                                                     continue with the vendor
--                    decided_by_provider                               the driver that decided (a
--                                                                     vendor decision has no
--                                                                     decided_by membership)
--                    reverification_of                                 the verification this one
--                                                                     renews
--                    reminder_sent_at                                  the one pre-expiry reminder
--                  The verified-has-evidence floor now admits a vendor decision: a method, a
--                  decider (a person, or a provider with its ref) and something that was read.
--
-- RLS unchanged: staff/system write, an external member reads their own rows (0001) and writes
-- none of them, so none of the new columns.

--> statement-breakpoint
ALTER TABLE round.verification
  ADD COLUMN vendor_status text,
  ADD COLUMN vendor_error text,
  ADD COLUMN vendor_checked_at timestamptz,
  ADD COLUMN vendor_decided_at timestamptz,
  ADD COLUMN next_check_at timestamptz,
  ADD COLUMN check_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN handoff jsonb,
  ADD COLUMN handoff_schema_version integer NOT NULL DEFAULT 1,
  ADD COLUMN decided_by_provider text,
  ADD COLUMN reverification_of uuid REFERENCES round.verification (id) ON DELETE SET NULL,
  ADD COLUMN reminder_sent_at timestamptz,
  ADD CONSTRAINT verification_vendor_status_length CHECK (
    vendor_status IS NULL OR char_length(vendor_status) <= 100
  ),
  ADD CONSTRAINT verification_vendor_error_length CHECK (
    vendor_error IS NULL OR char_length(vendor_error) <= 500
  ),
  ADD CONSTRAINT verification_provider_ref_length CHECK (
    provider_ref IS NULL OR char_length(provider_ref) <= 200
  ),
  ADD CONSTRAINT verification_decided_by_provider_length CHECK (
    decided_by_provider IS NULL OR char_length(decided_by_provider) BETWEEN 1 AND 50
  ),
  ADD CONSTRAINT verification_check_attempts_nonnegative CHECK (check_attempts >= 0),
  ADD CONSTRAINT verification_handoff_object CHECK (handoff IS NULL OR jsonb_typeof(handoff) = 'object');

--> statement-breakpoint
ALTER TABLE round.verification DROP CONSTRAINT verification_verified_has_evidence;
ALTER TABLE round.verification ADD CONSTRAINT verification_verified_has_evidence CHECK (
  status <> 'verified'
  OR (
    method IS NOT NULL
    AND (
      decided_by IS NOT NULL
      OR (decided_by_provider IS NOT NULL AND provider_ref IS NOT NULL)
    )
    AND (evidence_key IS NOT NULL OR evidence_note IS NOT NULL OR evidence_sha256 IS NOT NULL)
  )
);

--> statement-breakpoint
-- The sync sweep: pending vendor rows whose next check is due.
CREATE INDEX verification_sync_idx ON round.verification (next_check_at)
  WHERE next_check_at IS NOT NULL AND status = 'pending';
-- Callback wake-up: find the row a vendor ref names.
CREATE INDEX verification_provider_ref_idx ON round.verification (workspace_id, provider, provider_ref)
  WHERE provider_ref IS NOT NULL;
-- The lifecycle job: verified rows by expiry.
CREATE INDEX verification_expiry_idx ON round.verification (workspace_id, expires_at)
  WHERE status = 'verified';
CREATE INDEX verification_reverification_of_idx ON round.verification (reverification_of)
  WHERE reverification_of IS NOT NULL;

SELECT core.apply_tenant_fence();
