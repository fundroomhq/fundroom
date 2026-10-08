-- 0001_captable — read-only cap-table snapshots imported from CSV (our template), a Carta export
-- or a Pulley export (EXECUTION_PLAN §15 E3.6, ADR-0054).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/captable.ts. Runs inside one
-- transaction. Tenant tables declare the standard fence inline so nothing can read a row before
-- the runner's core.apply_tenant_fence() pass.
--
-- Model:
--  * snapshot        one import, as of a date. `draft` until a finance/admin user publishes it;
--                    publishing supersedes the previous published one, so at most one snapshot
--                    per workspace is `published` (partial unique index). `totals` is the
--                    summary computed at import (numeric strings, never floats).
--  * security_class  the classes of the snapshot (common, preferred series, option pool,
--                    options, warrants, SAFEs, notes), in display order.
--  * holding         one line of the ledger: a holder, a class, shares and/or an amount
--                    (SAFE/note principal). `membership_id` links a holder to a member (matched
--                    by email at import, relinkable by staff); it is what the investor's own
--                    "your holdings" card reads.
--
-- Immutability: a snapshot is a record. After insert only `status`/`published_at` of a
-- snapshot may change (draft → published → superseded); a class never changes; a holding may be
-- relinked (`membership_id`) and pseudonymised by erasure (`holder_name`/`holder_email`, only
-- together with setting `erased_at`). Only a draft snapshot (and its rows) may be deleted.
--
-- RLS: staff/system on everything. An external member may SELECT their own holding lines of the
-- published snapshot (defence in depth; the route filters too) and nothing else.
CREATE SCHEMA IF NOT EXISTS captable;
GRANT USAGE ON SCHEMA captable TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA captable GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA captable GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA captable GRANT EXECUTE ON FUNCTIONS TO seedhost_app;

--> statement-breakpoint
CREATE TABLE captable.snapshot (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  as_of date NOT NULL,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  note text,
  -- the summary computed at import: fully diluted by class, option pool, SAFEs/notes outstanding
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  totals_schema_version integer NOT NULL DEFAULT 1,
  imported_by uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT snapshot_source CHECK (source IN ('csv', 'carta', 'pulley')),
  CONSTRAINT snapshot_status CHECK (status IN ('draft', 'published', 'superseded')),
  CONSTRAINT snapshot_note_length CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT snapshot_totals_object CHECK (jsonb_typeof(totals) = 'object'),
  CONSTRAINT snapshot_published_shape CHECK ((status = 'draft') = (published_at IS NULL))
);

-- At most one published snapshot per workspace.
CREATE UNIQUE INDEX snapshot_published_idx ON captable.snapshot (workspace_id)
  WHERE status = 'published';
CREATE INDEX snapshot_ws_created_idx ON captable.snapshot (workspace_id, created_at DESC, id DESC);
CREATE INDEX snapshot_imported_by_idx ON captable.snapshot (imported_by)
  WHERE imported_by IS NOT NULL;

CREATE TABLE captable.security_class (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  snapshot_id uuid NOT NULL REFERENCES captable.snapshot (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  CONSTRAINT security_class_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT security_class_kind CHECK (
    kind IN ('common', 'preferred', 'option_pool', 'option', 'warrant', 'safe', 'note')
  ),
  CONSTRAINT security_class_position_nonnegative CHECK (position >= 0)
);

CREATE UNIQUE INDEX security_class_name_idx ON captable.security_class (snapshot_id, name);
CREATE INDEX security_class_ws_idx ON captable.security_class (workspace_id, snapshot_id, position);

CREATE TABLE captable.holding (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  snapshot_id uuid NOT NULL REFERENCES captable.snapshot (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  class_id uuid NOT NULL REFERENCES captable.security_class (id) ON DELETE CASCADE,
  holder_name text NOT NULL,
  holder_email citext,
  membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  shares numeric(24, 6),
  -- SAFE / note principal
  amount numeric(20, 6),
  currency char(3),
  issued_on date,
  -- set when erasure pseudonymised this line (the numbers stay: it is a record)
  erased_at timestamptz,
  CONSTRAINT holding_holder_name_length CHECK (char_length(holder_name) BETWEEN 1 AND 200),
  CONSTRAINT holding_holder_email_length CHECK (
    holder_email IS NULL OR char_length(holder_email) BETWEEN 3 AND 320
  ),
  CONSTRAINT holding_quantity_present CHECK (shares IS NOT NULL OR amount IS NOT NULL),
  CONSTRAINT holding_shares_nonnegative CHECK (shares IS NULL OR shares >= 0),
  CONSTRAINT holding_amount_nonnegative CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT holding_currency_shape CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT holding_amount_currency CHECK (amount IS NULL OR currency IS NOT NULL)
);

CREATE INDEX holding_snapshot_idx ON captable.holding (workspace_id, snapshot_id, class_id);
-- The investor's own lines, erasure and DSAR.
CREATE INDEX holding_member_idx ON captable.holding (workspace_id, membership_id)
  WHERE membership_id IS NOT NULL;
CREATE INDEX holding_email_idx ON captable.holding (workspace_id, holder_email)
  WHERE holder_email IS NOT NULL;
CREATE INDEX holding_class_idx ON captable.holding (class_id);

--> statement-breakpoint
-- Immutability.
CREATE FUNCTION captable.snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'captable.snapshot % is %: only a draft may be deleted', OLD.id, OLD.status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF to_jsonb(NEW) - 'status' - 'published_at' IS DISTINCT FROM to_jsonb(OLD) - 'status' - 'published_at' THEN
    RAISE EXCEPTION 'captable.snapshot % is immutable: import a new snapshot instead', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'published')
    OR (OLD.status = 'published' AND NEW.status = 'superseded')
  ) THEN
    RAISE EXCEPTION 'captable.snapshot % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER snapshot_guard BEFORE UPDATE OR DELETE ON captable.snapshot
  FOR EACH ROW EXECUTE FUNCTION captable.snapshot_guard();

-- Class and holding rows may be deleted only with (or inside) a draft snapshot. During the
-- cascade from a draft's DELETE the parent is already gone, which also admits the row.
CREATE FUNCTION captable.snapshot_row_deletable(p_snapshot_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM captable.snapshot s WHERE s.id = p_snapshot_id AND s.status <> 'draft'
  )
$$;

CREATE FUNCTION captable.security_class_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT captable.snapshot_row_deletable(OLD.snapshot_id) THEN
      RAISE EXCEPTION 'captable.security_class % belongs to a published snapshot', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'captable.security_class % is immutable', OLD.id
    USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER security_class_guard BEFORE UPDATE OR DELETE ON captable.security_class
  FOR EACH ROW EXECUTE FUNCTION captable.security_class_guard();

CREATE FUNCTION captable.holding_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT captable.snapshot_row_deletable(OLD.snapshot_id) THEN
      RAISE EXCEPTION 'captable.holding % belongs to a published snapshot', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  -- Staff relink a holder to a member; erasure pseudonymises the name/email (with erased_at).
  IF to_jsonb(NEW) - 'membership_id' - 'holder_name' - 'holder_email' - 'erased_at'
     IS DISTINCT FROM to_jsonb(OLD) - 'membership_id' - 'holder_name' - 'holder_email' - 'erased_at' THEN
    RAISE EXCEPTION 'captable.holding % is immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.holder_name IS DISTINCT FROM OLD.holder_name
      OR NEW.holder_email IS DISTINCT FROM OLD.holder_email)
     AND (NEW.erased_at IS NULL OR NEW.holder_email IS NOT NULL) THEN
    RAISE EXCEPTION 'captable.holding % holder may change only by erasure (erased_at set, email cleared)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.erased_at IS NOT NULL AND NEW.erased_at IS DISTINCT FROM OLD.erased_at THEN
    RAISE EXCEPTION 'captable.holding % is already erased', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER holding_guard BEFORE UPDATE OR DELETE ON captable.holding
  FOR EACH ROW EXECUTE FUNCTION captable.holding_guard();

--> statement-breakpoint
-- Whether a snapshot of the current workspace is the published one. SECURITY DEFINER with row
-- security off: an external caller has no policy on captable.snapshot (the summary is not
-- theirs), yet their holding arm must know whether the line's snapshot is published. It reads
-- the current workspace only and answers a boolean about an id the row already carries.
CREATE FUNCTION captable.snapshot_is_published(p_snapshot_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public SET row_security = off AS $$
  SELECT EXISTS (
    SELECT 1 FROM captable.snapshot s
    WHERE s.id = p_snapshot_id
      AND s.workspace_id = core.current_workspace()
      AND s.status = 'published'
  )
$$;
REVOKE ALL ON FUNCTION captable.snapshot_is_published(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION captable.snapshot_is_published(uuid) TO seedhost_app;

--> statement-breakpoint
-- Row-level security.
ALTER TABLE captable.snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE captable.snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON captable.snapshot AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY snapshot_staff ON captable.snapshot FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE captable.security_class ENABLE ROW LEVEL SECURITY;
ALTER TABLE captable.security_class FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON captable.security_class AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY security_class_staff ON captable.security_class FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE captable.holding ENABLE ROW LEVEL SECURITY;
ALTER TABLE captable.holding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON captable.holding AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY holding_staff ON captable.holding FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
-- A member reads their own lines of the published snapshot; never writes. A delegate whose
-- scope admits the cap table (`all` only, core.current_delegation_admits) reads its live
-- principal's lines instead — it acts for that investor (E3.2).
CREATE POLICY holding_external_own ON captable.holding FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND membership_id IS NOT NULL
    AND captable.snapshot_is_published(snapshot_id)
    AND (
      membership_id = core.current_membership()
      OR (
        core.current_delegation_admits('captable')
        AND membership_id = (
          SELECT d.principal_membership_id FROM core.membership d
          WHERE d.workspace_id = core.current_workspace()
            AND d.id = core.current_membership()
            AND d.role = 'delegate'
        )
      )
    )
  );

SELECT core.apply_tenant_fence();
