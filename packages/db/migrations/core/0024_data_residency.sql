-- 0024_data_residency — per-tenant data residency: declared cell regions, the derived workspace
-- data region and the `relocation` hold (EXECUTION_PLAN §15 E3.11, ADR-0059).
--
-- Hand-written (ADR-0004). The TypeScript views are src/schema/control-plane.ts (the cell
-- columns) and src/schema/core.ts (the workspace constraints). Runs inside one transaction.
--
-- A cell is a shared-nothing deployment: its own database, object store, queue and key ring. One
-- database = one region: several cells MAY share a database (E3.10 label cells) but then they
-- share a region, enforced here. The region is operator-declared (DATA_REGION) and adopted onto
-- the placeholder cells at boot; the product cannot verify where a database physically is.
--
--  * cell                  + region_label (human text, 0-120) and jurisdiction (eu|uk|ch|us|ca|au|
--                          other, null = not declared). Single-region rule: every non-placeholder
--                          region in this database is the same; a declared region never changes
--                          (only the placeholder `default` may be replaced).
--  * workspace.data_region DERIVED from the cell (since 0000, never written until now): a BEFORE
--                          trigger sets it on every insert and update, a cell's region change
--                          cascades to its workspaces, and the control-plane guard pins it against
--                          tenant actors. Nothing can desync it.
--  * workspace.holds       + `relocation`: set while a workspace moves between cells (E3.11 moves);
--                          suspends like the others (reason precedence sanctions > operator >
--                          relocation > billing).

--> statement-breakpoint
-- 1. Refuse to continue with an ambiguous region: more than one distinct declared region in one
-- database contradicts the rule this migration installs, and picking one would be a guess.
DO $$
DECLARE
  regions text;
BEGIN
  SELECT string_agg(DISTINCT region, ', ' ORDER BY region) INTO regions
  FROM core.cell WHERE region <> 'default';
  IF (SELECT count(DISTINCT region) FROM core.cell WHERE region <> 'default') > 1 THEN
    RAISE EXCEPTION 'core.cell holds more than one region (%): one database serves one region (E3.11). Move the other cells'' workspaces to their own databases, or set every cell to one region, before upgrading.', regions
      USING ERRCODE = '23514';
  END IF;
END $$;

--> statement-breakpoint
-- 2. Cell facts.
ALTER TABLE core.cell
  ADD COLUMN region_label text NOT NULL DEFAULT '',
  ADD COLUMN jurisdiction text;
ALTER TABLE core.cell ADD CONSTRAINT cell_region_label_length CHECK (
  char_length(region_label) <= 120
) NOT VALID;
ALTER TABLE core.cell VALIDATE CONSTRAINT cell_region_label_length;
ALTER TABLE core.cell ADD CONSTRAINT cell_jurisdiction CHECK (
  jurisdiction IS NULL OR jurisdiction IN ('eu', 'uk', 'ch', 'us', 'ca', 'au', 'other')
) NOT VALID;
ALTER TABLE core.cell VALIDATE CONSTRAINT cell_jurisdiction;

-- Single region per database, and a declared region is immutable. `default` is the placeholder a
-- fresh install (and every E3.10 install) seeds; it is ignored by the rule and may be replaced
-- once. Serialised by an advisory lock so two concurrent inserts cannot both pass.
CREATE FUNCTION core.cell_single_region() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  other text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.region <> 'default' AND NEW.region IS DISTINCT FROM OLD.region THEN
    RAISE EXCEPTION 'cell % already declares region %; a declared region never changes (move its workspaces instead)', OLD.id, OLD.region
      USING ERRCODE = '23514', CONSTRAINT = 'cell_single_region';
  END IF;
  IF NEW.region <> 'default' THEN
    PERFORM pg_advisory_xact_lock(hashtext('core.cell_single_region'));
    SELECT c.region INTO other FROM core.cell c
    WHERE c.id <> NEW.id AND c.region <> 'default' AND c.region <> NEW.region
    LIMIT 1;
    IF other IS NOT NULL THEN
      RAISE EXCEPTION 'this database serves region %; cell % cannot declare region % (one database = one region)', other, NEW.id, NEW.region
        USING ERRCODE = '23514', CONSTRAINT = 'cell_single_region';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cell_single_region BEFORE INSERT OR UPDATE ON core.cell
  FOR EACH ROW EXECUTE FUNCTION core.cell_single_region();

--> statement-breakpoint
-- 3. The workspace's data region, derived from its cell. Set on every insert and update (not only
-- when cell_id changes), so a direct write of data_region is simply overwritten.
CREATE FUNCTION core.workspace_derive_region() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.data_region := (SELECT c.region FROM core.cell c WHERE c.id = NEW.cell_id);
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_derive_region BEFORE INSERT OR UPDATE ON core.workspace
  FOR EACH ROW EXECUTE FUNCTION core.workspace_derive_region();

-- A cell's region change (the placeholder adopting DATA_REGION at boot) reaches its workspaces.
-- Cells are written by the host actor only (0023 RLS), which the workspace fence and guard admit.
CREATE FUNCTION core.cell_cascade_region() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE core.workspace w SET data_region = NEW.region
  WHERE w.cell_id = NEW.id AND w.data_region IS DISTINCT FROM NEW.region;
  RETURN NULL;
END $$;

CREATE TRIGGER cell_cascade_region AFTER UPDATE OF region ON core.cell
  FOR EACH ROW WHEN (OLD.region IS DISTINCT FROM NEW.region)
  EXECUTE FUNCTION core.cell_cascade_region();

-- Backfill as the host actor (the workspace fence is FORCEd); restored below.
SELECT set_config('app.actor_kind', 'host', true);
UPDATE core.workspace w SET data_region = c.region
FROM core.cell c
WHERE c.id = w.cell_id AND w.data_region IS DISTINCT FROM c.region;
SELECT set_config('app.actor_kind', '', true);

--> statement-breakpoint
-- 4. The `relocation` hold.
ALTER TABLE core.workspace DROP CONSTRAINT workspace_holds;
ALTER TABLE core.workspace ADD CONSTRAINT workspace_holds CHECK (
  holds <@ ARRAY['sanctions_review', 'operator', 'billing', 'sanctions', 'relocation']::text[]
  AND array_position(holds, NULL) IS NULL
  AND core.text_array_is_set(holds)
) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_holds;
ALTER TABLE core.workspace DROP CONSTRAINT workspace_suspended_reason;
ALTER TABLE core.workspace ADD CONSTRAINT workspace_suspended_reason CHECK (
  suspended_reason IS NULL OR suspended_reason IN ('operator', 'billing', 'sanctions', 'relocation')
) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_suspended_reason;

-- 0023's derivation with `relocation` ranked right below `operator`.
CREATE OR REPLACE FUNCTION core.workspace_derive_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  derived_status text;
  derived_reason text;
BEGIN
  NEW.holds := ARRAY(SELECT DISTINCT h FROM unnest(NEW.holds) AS h WHERE h IS NOT NULL ORDER BY h);
  derived_reason := CASE
    WHEN 'sanctions' = ANY (NEW.holds) THEN 'sanctions'
    WHEN 'operator' = ANY (NEW.holds) THEN 'operator'
    WHEN 'relocation' = ANY (NEW.holds) THEN 'relocation'
    WHEN 'billing' = ANY (NEW.holds) THEN 'billing'
  END;
  derived_status := CASE
    WHEN derived_reason IS NOT NULL THEN 'suspended'
    WHEN 'sanctions_review' = ANY (NEW.holds) THEN 'pending_review'
    ELSE 'active'
  END;
  IF TG_OP = 'INSERT' THEN
    -- the column defaults (active, no reason) are fine: an INSERT names holds only
    IF (NEW.status, NEW.suspended_reason) IS DISTINCT FROM (derived_status, derived_reason)
       AND (NEW.status, NEW.suspended_reason) IS DISTINCT FROM ('active'::text, NULL::text) THEN
      RAISE EXCEPTION 'workspace status is derived from holds'
        USING ERRCODE = '23514', CONSTRAINT = 'workspace_holds';
    END IF;
  ELSIF (NEW.status, NEW.suspended_reason) IS DISTINCT FROM (OLD.status, OLD.suspended_reason)
        AND (NEW.status, NEW.suspended_reason) IS DISTINCT FROM (derived_status, derived_reason) THEN
    RAISE EXCEPTION 'workspace status is derived from holds'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_holds';
  END IF;
  NEW.status := derived_status;
  NEW.suspended_reason := derived_reason;
  NEW.suspended_at := CASE
    WHEN derived_status <> 'suspended' THEN NULL
    WHEN TG_OP = 'UPDATE' AND OLD.status = 'suspended' THEN OLD.suspended_at
    ELSE coalesce(NEW.suspended_at, now())
  END;
  RETURN NEW;
END $$;

--> statement-breakpoint
-- 5. The guard (0023) also pins data_region against tenant actors. BEFORE triggers fire in name
-- order: this guard sees the tenant's own NEW.data_region before workspace_derive_region
-- overwrites it, so a tenant attempt is refused rather than silently corrected.
CREATE OR REPLACE FUNCTION core.workspace_control_plane_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.cell_id, NEW.holds, NEW.status, NEW.suspended_reason, NEW.suspended_at,
      NEW.legal_name, NEW.country, NEW.plan_id, NEW.data_region)
     IS DISTINCT FROM
     (OLD.cell_id, OLD.holds, OLD.status, OLD.suspended_reason, OLD.suspended_at,
      OLD.legal_name, OLD.country, OLD.plan_id, OLD.data_region)
     AND coalesce(core.current_actor_kind(), '') NOT IN ('host', 'system') THEN
    RAISE EXCEPTION 'workspace control-plane columns are written by the host or system actor only'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- No new table: no GRANT and no fence pass needed; kept for the runner's convention.
SELECT core.apply_tenant_fence();
