-- 0005_kpi_source_kinds — the three KPI integrations as point provenance (E3.6 §5, ADR-0054).
--
-- Hand-written (ADR-0004). A file of its own on purpose, the same rule as notify 0003: `ALTER
-- TYPE … ADD VALUE` may run inside the runner's per-file transaction, but a new label cannot be
-- *used* until that transaction commits. Nothing here uses them; 0006 and the sync code that
-- writes `metrics.source.kind = 'quickbooks' | 'xero' | 'stripe'` run after this commits.
-- `src/model.ts` SOURCE_KINDS is the TypeScript half and must list the same labels.

ALTER TYPE metrics.source_kind ADD VALUE IF NOT EXISTS 'quickbooks';
ALTER TYPE metrics.source_kind ADD VALUE IF NOT EXISTS 'xero';
ALTER TYPE metrics.source_kind ADD VALUE IF NOT EXISTS 'stripe';
