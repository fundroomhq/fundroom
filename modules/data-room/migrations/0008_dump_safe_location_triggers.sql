-- 0008_dump_safe_location_triggers — the 0006 location triggers, rewritten so a logical dump of
-- the database restores as written (E-UP-12).
--
-- Hand-written (ADR-0004). Runs inside one transaction.
--
-- Why: 0006 guarded both commit-time triggers with `WHEN (OLD.<ltree> IS DISTINCT FROM
-- NEW.<ltree>)`. `IS DISTINCT FROM` resolves the type's `=` operator by name, and `pg_dump` can
-- only print it bare (there is no `IS DISTINCT FROM OPERATOR(schema.=)` syntax). Every dump
-- restores with `search_path = ''`, where ltree's `=` (in `public`, with the extension) is not
-- visible, so `pg_restore --exit-on-error` and the runbook's `psql -v ON_ERROR_STOP=1` both
-- stopped at `operator does not exist: public.ltree = public.ltree` on the first trigger.
--
-- Fix: compare the paths as text. An ltree's text form is its labels joined by `.`, and a label
-- cannot contain `.`, so two paths are equal exactly when their texts are; text's operator lives
-- in `pg_catalog`, which every search path includes. This also does not hard-code the schema
-- the ltree extension was installed into, which `OPERATOR(public.=)` would. `staff_only` is a
-- boolean and was never affected. Same trigger names, timing, columns and function as 0006.
--
-- `DROP TRIGGER IF EXISTS`: a database restored from a pre-0008 dump WITHOUT stopping on errors
-- (plain `psql`, or `pg_restore` without `--exit-on-error`) has every object except these two
-- triggers. This migration is what puts them back, so it must not require them to be there.
--
-- Any other `IS DISTINCT FROM` / `NULLIF` over an extension type (ltree, citext) in a trigger
-- condition, CHECK, index, policy, view or default would fail the same way; there is none
-- (checked by restoring a dump of every module, apps/server/src/dump-restore.integration.test.ts).

--> statement-breakpoint
DROP TRIGGER IF EXISTS document_location_acl ON dataroom.document;
CREATE CONSTRAINT TRIGGER document_location_acl
  AFTER UPDATE OF folder_path ON dataroom.document
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.folder_path::text IS DISTINCT FROM NEW.folder_path::text)
  EXECUTE FUNCTION dataroom.bump_acl_on_location_change();

DROP TRIGGER IF EXISTS folder_location_acl ON dataroom.folder;
CREATE CONSTRAINT TRIGGER folder_location_acl
  AFTER UPDATE OF path, staff_only ON dataroom.folder
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.path::text IS DISTINCT FROM NEW.path::text OR OLD.staff_only IS DISTINCT FROM NEW.staff_only)
  EXECUTE FUNCTION dataroom.bump_acl_on_location_change();
