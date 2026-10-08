-- 0006_kpi_bindings — a metric definition bound to one KPI series of a connected integration
-- (E3.6 §5, ADR-0054).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/metrics.ts. Runs inside one
-- transaction.
--
-- A binding says "the monthly `revenue` metric is QuickBooks' Total Income". It carries no
-- credential and no connection id: the connection is the kernel's (`core.integration_connection`,
-- one live row per workspace and provider), read through `ModuleServices.integrations` at sync
-- time, so a reconnect — which replaces the connection row — keeps every binding working and a
-- disconnect turns the next sync into a recorded "not connected" rather than a dangling FK.
--
-- At most one binding per definition (`definition_id` UNIQUE): two sources writing one series
-- would restate each other every night. Only a `month`, non-formula definition may be bound;
-- that rule needs the definition row and is enforced in src/service/kpi-sources.ts (422
-- `binding_period_unsupported`) and re-checked at every sync, not by a CHECK here.
--
-- Health mirrors metrics.sheet_connection: `status`, `last_sync_at`, `last_error`,
-- `consecutive_failures`. `last_success_at` is the one addition, and it is what decides the
-- sync window: a binding that has never synced successfully backfills 24 months, one that has
-- reads the trailing 3. Keying that on `last_sync_at` would let a first sync that failed
-- ("not connected") cost the binding its backfill for ever.

CREATE TABLE metrics.source_binding (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  definition_id uuid NOT NULL REFERENCES metrics.definition (id) ON DELETE CASCADE,
  provider text NOT NULL,
  -- A key of the provider's frozen KPI catalogue (`revenue`, `mrr`, …; contract §1).
  source_metric text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  status metrics.sync_status NOT NULL DEFAULT 'idle',
  last_sync_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  -- The earliest month a sync has written for this binding (YYYY-MM), and why the history is
  -- shorter than the 24-month backfill when it is ("history too large to backfill"). The note
  -- survives later 3-month successes — truncated history must stay visible — and is cleared
  -- only by a later backfill that succeeds in full. Re-pointing the binding resets both.
  history_from text,
  history_note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_binding_definition_unique UNIQUE (definition_id),
  CONSTRAINT source_binding_provider CHECK (provider IN ('quickbooks', 'xero', 'stripe')),
  CONSTRAINT source_binding_metric_format CHECK (source_metric ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT source_binding_failures_nonnegative CHECK (consecutive_failures >= 0),
  CONSTRAINT source_binding_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 1000),
  CONSTRAINT source_binding_history_from_format CHECK (history_from IS NULL OR history_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT source_binding_history_note_length CHECK (history_note IS NULL OR char_length(history_note) <= 500)
);
CREATE INDEX source_binding_workspace_idx ON metrics.source_binding (workspace_id, provider);
CREATE TRIGGER source_binding_set_updated_at BEFORE UPDATE ON metrics.source_binding
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Staff and system only, like sheet_connection: which accounting system a figure came from is
-- configuration, not something the workspace published.
ALTER TABLE metrics.source_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.source_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON metrics.source_binding AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY source_binding_staff ON metrics.source_binding FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

SELECT core.apply_tenant_fence();
