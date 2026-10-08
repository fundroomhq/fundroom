-- 0001_metrics — KPIs: metric definitions, an append-only series of points with restatement
-- revisions, CSV/Sheets provenance and a per-workspace Google Sheets connection
-- (EXECUTION_PLAN §15 E2.4, design/03 §157, design/06 §7, ADR-0042).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/metrics.ts. Runs inside one
-- transaction. Tenant tables declare the standard fence inline so nothing can read a row
-- before the runner's core.apply_tenant_fence() pass.
--
-- Model:
--  * definition       what a number *is*: a stable machine `key` (CSV columns and formulas
--                     address it), unit and currency, how it aggregates across periods, which
--                     way is good, how many decimals to render, and the `audience` that
--                     decides who may see it. A definition with a `formula` is derived: its
--                     points are computed from other definitions' points, never typed in.
--  * source           provenance of a write: the CSV import, the Sheets sync or the formula
--                     that produced it. One row per import/sync/recompute, not per point.
--  * point            one (definition, period) value. **Append only**: a correction writes a
--                     new `revision` and points the old row's `superseded_by` at it, so the
--                     number an investor saw last quarter is still on disk with the timestamp
--                     that proves when it changed (E2.4 D3). Enforced by a trigger, not by
--                     convention — audit.event can REVOKE UPDATE, we cannot, because
--                     superseding *is* an update.
--  * point_current    the live series: the points nothing has superseded. `security_invoker`
--                     so the reader's RLS applies, not the view owner's.
--  * import           a CSV run and its per-row outcome, modelled on core.invite_import.
--  * sheet_connection the workspace's Google Sheets link: the service-account key
--                     envelope-encrypted under the workspace DEK, plus sync health.
--
-- `btree_gist` is the second extension this product requires after `ltree` (plan §19 q12).
-- The exclusion constraint on `point` needs uuid equality *inside* a GiST index, next to the
-- range overlap test, and only btree_gist supplies that operator class. Without it two live
-- points could claim the same period for the same definition, which is the one thing a
-- restatement model must never allow.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS metrics;
GRANT USAGE ON SCHEMA metrics TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA metrics GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA metrics GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA metrics GRANT EXECUTE ON FUNCTIONS TO seedhost_app;

-- Postgres enums, not text + CHECK (design/06 §1): these are code-owned vocabularies that
-- change with a migration and a release, never with a row a tenant writes.
CREATE TYPE metrics.unit_kind AS ENUM ('currency', 'count', 'percent', 'ratio', 'days', 'months');
CREATE TYPE metrics.aggregation AS ENUM ('sum', 'last', 'avg');
CREATE TYPE metrics.direction AS ENUM ('up_good', 'down_good', 'neutral');
CREATE TYPE metrics.period_kind AS ENUM ('month', 'quarter', 'year', 'custom');
CREATE TYPE metrics.source_kind AS ENUM ('manual', 'csv', 'sheets', 'derived');
CREATE TYPE metrics.sync_status AS ENUM ('idle', 'syncing', 'ok', 'failed');
CREATE TYPE metrics.import_status AS ENUM ('pending', 'running', 'done', 'failed');

--> statement-breakpoint
CREATE TABLE metrics.definition (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- Stable machine key. A CSV column header and a formula's `ref` both name a metric by this,
  -- so renaming the human `name` never breaks an import or a derived metric.
  key citext NOT NULL,
  name text NOT NULL,
  description text,
  unit metrics.unit_kind NOT NULL,
  -- ISO 4217, and only for money. Storing a currency on a headcount would let two definitions
  -- that mean the same thing disagree about it.
  currency text,
  aggregation metrics.aggregation NOT NULL DEFAULT 'last',
  direction metrics.direction NOT NULL DEFAULT 'up_good',
  period_kind metrics.period_kind NOT NULL DEFAULT 'month',
  decimals smallint NOT NULL DEFAULT 0,
  -- NULL = the numbers are entered or imported. Non-NULL = derived; src/formula.ts is the
  -- evaluator and the only thing that may write this definition's points.
  formula jsonb,
  formula_schema_version integer NOT NULL DEFAULT 1,
  -- Chart kind, sparkline window, grid placement: presentation, never arithmetic.
  display jsonb NOT NULL DEFAULT '{}',
  display_schema_version integer NOT NULL DEFAULT 1,
  -- Who may see the number (E2.4 D2). `staff_only` is the default because a definition is
  -- created long before anybody decides to publish it, and an unpublished number must not
  -- leak in the window between the two decisions. src/model.ts is the TypeScript half.
  audience jsonb NOT NULL DEFAULT '{"kind":"staff_only"}',
  audience_schema_version integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT definition_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT definition_currency_iff_currency_unit CHECK ((unit = 'currency') = (currency IS NOT NULL)),
  CONSTRAINT definition_currency_format CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT definition_decimals_range CHECK (decimals BETWEEN 0 AND 6),
  -- A formula is evaluated *per period*, so summing or averaging its output across periods is
  -- arithmetic on a number that was never a quantity. `last` is the only honest aggregation.
  CONSTRAINT definition_derived_aggregation CHECK (formula IS NULL OR aggregation = 'last')
);
-- Unique among live definitions only: a deleted `burn_rate` must not block a new one, and the
-- deleted row has to stay so its points keep their foreign key.
CREATE UNIQUE INDEX definition_key_active_idx ON metrics.definition (workspace_id, key)
  WHERE deleted_at IS NULL;
CREATE INDEX definition_workspace_idx ON metrics.definition (workspace_id, sort_order, key)
  WHERE deleted_at IS NULL;
CREATE TRIGGER definition_set_updated_at BEFORE UPDATE ON metrics.definition
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE metrics.source (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  kind metrics.source_kind NOT NULL,
  -- csv:     {importId, columnMap, fileSha256, line}
  -- sheets:  {connectionId, spreadsheetId, range, syncId}
  -- derived: {formulaSha256, inputs: [definitionId…]}
  -- manual:  {}
  ref jsonb NOT NULL DEFAULT '{}',
  ref_schema_version integer NOT NULL DEFAULT 1,
  -- The membership that ran it; NULL for sheets and derived, which the system does unattended.
  imported_by uuid,
  imported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_workspace_idx ON metrics.source (workspace_id, imported_at DESC);

CREATE TABLE metrics.point (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  definition_id uuid NOT NULL REFERENCES metrics.definition (id) ON DELETE CASCADE,
  -- Half-open [start, end) in UTC. A range rather than a label because a label is derived from
  -- the range and a range is not derivable from a label: there is no fiscal-year setting, and
  -- there must not be one, or every stored history would be re-bucketed by a settings change
  -- long after the fact (E2.4 D1).
  period tstzrange NOT NULL,
  period_start timestamptz GENERATED ALWAYS AS (lower(period)) STORED,
  -- numeric, never float: a rate to six places has to come back out as it went in. The
  -- TypeScript side carries it as a fixed-point bigint (src/decimal.ts), never a JS number.
  value numeric(20, 6) NOT NULL,
  -- When the value was asserted to be true — which is not when the row was written. A chart in
  -- an email that went out on the 3rd renders the revisions that existed on the 3rd.
  as_of timestamptz NOT NULL DEFAULT now(),
  source_id uuid REFERENCES metrics.source (id),
  revision integer NOT NULL DEFAULT 1,
  superseded_by uuid REFERENCES metrics.point (id),
  -- A sync found a different number for a period a human had typed in. We do not overwrite a
  -- human silently (design/06 §7); the new revision lands flagged and the admin screen says so.
  needs_review boolean NOT NULL DEFAULT false,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT point_period_bounded CHECK (lower(period) IS NOT NULL AND upper(period) IS NOT NULL),
  CONSTRAINT point_period_nonempty CHECK (NOT isempty(period)),
  CONSTRAINT point_revision_positive CHECK (revision >= 1),
  CONSTRAINT point_not_self_superseded CHECK (superseded_by IS DISTINCT FROM id),
  CONSTRAINT point_revision_unique UNIQUE (workspace_id, definition_id, period, revision),
  -- At most one *live* point per definition per period, and overlapping custom ranges are
  -- caught too — which a unique index on the range could not do.
  --
  -- DEFERRABLE INITIALLY DEFERRED, and not as a convenience: an immediate version makes a
  -- restatement literally unwritable. Superseding is two statements — insert the new revision,
  -- then point the old row's `superseded_by` at it — and between them both rows are live and
  -- claim the same period. Reversing the order does not help, because `superseded_by` has to
  -- name an id that does not exist yet. Deferring moves the check to COMMIT, which is where
  -- the invariant actually belongs: the rule is "no workspace ever *has* two live points for
  -- one period", not "no transaction ever passes through a state where it would".
  CONSTRAINT point_one_live_per_period EXCLUDE USING gist (
    workspace_id WITH =, definition_id WITH =, period WITH &&
  ) WHERE (superseded_by IS NULL) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX point_series_idx ON metrics.point (workspace_id, definition_id, period_start DESC)
  WHERE superseded_by IS NULL;
-- The `asOf` read behind an emailed chart (§9.1) walks every revision of a period, not just
-- the live one, so it needs its own index.
CREATE INDEX point_history_idx ON metrics.point (workspace_id, definition_id, period_start, created_at);

CREATE TABLE metrics.import (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  source_id uuid REFERENCES metrics.source (id),
  status metrics.import_status NOT NULL DEFAULT 'pending',
  -- Column mapping and the period kind the uploader chose, applied to every row.
  defaults jsonb NOT NULL DEFAULT '{}',
  defaults_schema_version integer NOT NULL DEFAULT 1,
  -- Per-row outcome, so a dry run and the run that follows it show the same table.
  rows jsonb NOT NULL DEFAULT '[]',
  rows_schema_version integer NOT NULL DEFAULT 1,
  total integer NOT NULL DEFAULT 0,
  applied integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  CONSTRAINT import_counts_nonnegative CHECK (total >= 0 AND applied >= 0 AND skipped >= 0 AND failed >= 0),
  CONSTRAINT import_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 1000)
);
CREATE INDEX import_workspace_idx ON metrics.import (workspace_id, created_at DESC);

CREATE TABLE metrics.sheet_connection (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  spreadsheet_id text NOT NULL,
  range text NOT NULL,
  mapping jsonb NOT NULL DEFAULT '{}',
  mapping_schema_version integer NOT NULL DEFAULT 1,
  -- The service account's private key, envelope-encrypted under the workspace DEK exactly as
  -- updates.sending_domain keeps its DKIM key (purpose string `metrics-sheets`). `encryption`
  -- carries the envelope metadata; a row whose key is missing degrades to "cannot sync",
  -- never to an exception on a read path.
  credential_enc bytea NOT NULL,
  encryption jsonb NOT NULL DEFAULT '{}',
  encryption_schema_version integer NOT NULL DEFAULT 1,
  -- Shown to the admin: the address they must share the spreadsheet with. There is no OAuth
  -- dance, because a self-hoster has nowhere to register a client (E2.4 §8).
  service_account_email text NOT NULL,
  status metrics.sync_status NOT NULL DEFAULT 'idle',
  enabled boolean NOT NULL DEFAULT true,
  last_sync_at timestamptz,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One connection per workspace in v1: the nightly sweep's Google quota is per project, and a
  -- workspace with five sheets would spend everybody else's.
  CONSTRAINT sheet_connection_one_per_workspace UNIQUE (workspace_id),
  CONSTRAINT sheet_connection_failures_nonnegative CHECK (consecutive_failures >= 0),
  CONSTRAINT sheet_connection_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 1000)
);
CREATE TRIGGER sheet_connection_set_updated_at BEFORE UPDATE ON metrics.sheet_connection
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

--> statement-breakpoint
-- A point is a claim about what a number was, with a timestamp. Editing one in place destroys
-- the evidence that it ever said something else, which is the whole reason the table exists
-- (E2.4 D3). So: no DELETE at all, and an UPDATE may set `superseded_by` and nothing else,
-- once, from NULL. Comparing the rest of the row through jsonb rather than column by column
-- means a column added by a later migration is covered without anybody remembering to.
--
-- `period_start` is excluded alongside `superseded_by`, and the reason is a trap worth naming:
-- it is GENERATED ALWAYS … STORED, and Postgres fills generated columns *after* BEFORE
-- triggers run, so `NEW.period_start` is NULL here on every UPDATE while `OLD.period_start`
-- is set. Comparing it would make the function reject the one update it exists to allow —
-- which it did, on the first restatement anybody tried. `period` itself is compared, and
-- `period_start` is a pure function of it, so nothing is lost.
CREATE OR REPLACE FUNCTION metrics.point_is_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'metrics.point % cannot be deleted: the series is append-only, supersede it with a new revision', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF to_jsonb(NEW) - 'superseded_by' - 'period_start'
     IS DISTINCT FROM to_jsonb(OLD) - 'superseded_by' - 'period_start' THEN
    RAISE EXCEPTION 'metrics.point % is immutable: a correction is a new revision, not an edit', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'metrics.point % is already superseded by %: supersede the newest revision instead', OLD.id, OLD.superseded_by
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.superseded_by IS NULL THEN
    RAISE EXCEPTION 'metrics.point % cannot be un-superseded: restore the value with a further revision', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER point_append_only BEFORE UPDATE OR DELETE ON metrics.point
  FOR EACH ROW EXECUTE FUNCTION metrics.point_is_append_only();

-- The live series. `security_invoker` is not optional: a view without it runs with its owner's
-- privileges and the reader's RLS never bites, so an external actor would read every point in
-- the workspace through it.
CREATE VIEW metrics.point_current WITH (security_invoker = true) AS
  SELECT * FROM metrics.point WHERE superseded_by IS NULL;

-- Whether the current (external) actor may see a metric. updates.audience_includes_current
-- with a third arm: `staff_only`, which the updates model has no use for because an update's
-- audience is chosen at the moment it is sent, while a metric definition exists for weeks
-- before anybody decides to publish it.
--
-- Note the ELSE: an arm this function does not recognise — a jsonb hand-edited in psql, or a
-- shape a future release writes and this one reads — is closed, not open. src/model.ts's
-- parseAudience has the same bias, and an integration test pins both halves.
CREATE OR REPLACE FUNCTION metrics.audience_admits_current(p_audience jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE COALESCE(p_audience->>'kind', 'staff_only')
    WHEN 'all' THEN true
    WHEN 'staff_only' THEN false
    WHEN 'groups' THEN EXISTS (
      SELECT 1 FROM core.group_member gm
      WHERE gm.workspace_id = core.current_workspace()
        AND gm.membership_id = core.current_membership()
        AND gm.revoked_at IS NULL
        AND gm.group_id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_audience->'groupIds', '[]'::jsonb)))
    )
    ELSE false END
$$;

--> statement-breakpoint
-- Row-level security. Staff and system actors work on everything in their workspace. An
-- external actor reads live definitions whose audience admits them and the points of those
-- definitions — and nothing else: provenance, import runs and the Sheets credential are
-- staff-only, because an investor learning that a number came from a spreadsheet named
-- "runway_v3_FINAL" learns something the workspace did not publish.
ALTER TABLE metrics.definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.definition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON metrics.definition AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY definition_staff ON metrics.definition FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY definition_external_read ON metrics.definition FOR SELECT
  USING (
    core.current_actor_kind() = 'external' AND deleted_at IS NULL
    AND metrics.audience_admits_current(audience)
  );

ALTER TABLE metrics.source ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.source FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON metrics.source AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY source_staff ON metrics.source FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE metrics.point ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.point FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON metrics.point AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY point_staff ON metrics.point FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
-- The definition's audience governs its points: there is no per-point gating, and there must
-- not be, or one period of a series could be visible while its neighbour was not, which reads
-- to an investor as a gap in the company's history rather than a permission.
CREATE POLICY point_external_read ON metrics.point FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND EXISTS (
      SELECT 1 FROM metrics.definition d
      WHERE d.id = point.definition_id AND d.deleted_at IS NULL
        AND metrics.audience_admits_current(d.audience)
    )
  );

ALTER TABLE metrics.import ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.import FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON metrics.import AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY import_staff ON metrics.import FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE metrics.sheet_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE metrics.sheet_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON metrics.sheet_connection AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY sheet_connection_staff ON metrics.sheet_connection FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

SELECT core.apply_tenant_fence();
