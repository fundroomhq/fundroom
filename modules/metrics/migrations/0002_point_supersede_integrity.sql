-- 0002_point_supersede_integrity — make `superseded_by` mean what the append-only trigger's
-- messages already promise: the *next revision of the same cell* (E2.4 D3, §12 FIX-A finding 21).
--
-- Hand-written (ADR-0004). A separate file rather than an edit to 0001 because an applied
-- migration is journaled by checksum and forward-only: editing it is an error the runner
-- reports, not a fix.
--
-- What 0001 enforced was that an UPDATE changes only `superseded_by`, once, from NULL. What its
-- exception text tells a developer who hits it is something stronger — "supersede it with a new
-- revision", "supersede the newest revision instead" — and the column did not carry that at all.
-- `superseded_by` is a bare `REFERENCES metrics.point (id)`, so a row could be superseded by a
-- point of a *different definition*, or of a *different workspace*, or by a lower revision of
-- its own cell; and two rows pointing at each other made the period disappear from
-- `metrics.point_current` entirely, because that view is `WHERE superseded_by IS NULL`. A
-- restatement register that can lose a published figure is not a register.
--
-- Nothing in the service layer can do any of this (`PointRepo.supersede` is called once, with
-- the row the same `applyCells` loop has just inserted for that cell), so this closes a schema
-- gap rather than a live defect: it is the invariant the message claims, stated where a future
-- writer — a backfill script, a repair by hand, a second implementation — also has to obey it.
--
-- A CHECK cannot express it (it would have to read another row), so it lives in the same
-- BEFORE trigger, which already runs on exactly the statements that could break it. The lookup
-- is by primary key and only on the supersede path, which is once per restatement.
CREATE OR REPLACE FUNCTION metrics.point_is_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'metrics.point % cannot be deleted: the series is append-only, supersede it with a new revision', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- `period_start` is excluded alongside `superseded_by` because it is GENERATED ALWAYS …
  -- STORED and Postgres fills generated columns *after* BEFORE triggers run, so NEW.period_start
  -- is NULL here on every UPDATE while OLD.period_start is set. `period` itself is compared and
  -- `period_start` is a pure function of it, so nothing is lost.
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
  -- The new rule. A superseding row must be a *higher revision of the same cell*: same
  -- workspace, same definition, same period. That is what makes `superseded_by` a revision
  -- chain instead of an arbitrary edge, and the strict `revision >` is what makes a cycle
  -- unrepresentable rather than merely unlikely — A cannot outrank B while B outranks A.
  IF NOT EXISTS (
    SELECT 1 FROM metrics.point n
    WHERE n.id = NEW.superseded_by
      AND n.workspace_id = OLD.workspace_id
      AND n.definition_id = OLD.definition_id
      AND n.period = OLD.period
      AND n.revision > OLD.revision
  ) THEN
    RAISE EXCEPTION 'metrics.point % cannot be superseded by %: a superseding point must be a higher revision of the same (workspace, definition, period)', OLD.id, NEW.superseded_by
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
