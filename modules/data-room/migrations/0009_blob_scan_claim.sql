-- 0009_blob_scan_claim — which version's ingest job holds a blob's scan (E-UP-25).
--
-- Hand-written (ADR-0004). Runs inside one transaction. The TypeScript view is
-- src/schema/dataroom.ts.
--
-- Several versions can share one blob (the same bytes uploaded twice), and each has its own
-- ingest job; one of them scans (`BlobRepo.claimScan`) and the others end and are handed on when
-- the verdict is in. Until now a `scanning` row did not say whose it was, so a retried job of
-- ANOTHER version could take over a scan still running. `scan_claimed_by` names the claiming
-- version: a `scanning` row is taken over only by that version's job (pg-boss redelivers the same
-- job) or once the claim is stale. A plain nullable column: no default, no rewrite, no backfill.
-- Rows `scanning` at upgrade time have no `scanned_at` (the old code never wrote one with the
-- claim), so they can be taken over at once, including by an old worker during a rolling deploy;
-- that is harmless, because the promotion is serialised on the blob row either way.
--
-- No FK to document_version: the column is a claim, not a relation, and a purge of the version
-- must not touch the blob row. Not exported (portability drops it): it names this install's jobs.

--> statement-breakpoint
ALTER TABLE dataroom.blob ADD COLUMN scan_claimed_by uuid;

--> statement-breakpoint
COMMENT ON COLUMN dataroom.blob.scan_claimed_by IS
  'Version whose ingest job claimed the scan (BlobRepo.claimScan); null before any claim or after a re-upload reset.';
