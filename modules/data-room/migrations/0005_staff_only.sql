-- 0005_staff_only — the staff-only veil over vaulted e-signature documents (EXECUTION_PLAN §15
-- E3.5, ADR-0053; modules/data-room README "Vaulting (E3.5)").
--
-- Hand-written (ADR-0004). Runs inside one transaction. `dataroom.folder.staff_only` arrived with
-- 0004_vault; this migration gives it its meaning at the storage layer. The rule, in every layer
-- that decides access (this RLS, the authz rebuild in packages/authz, the module's own checks in
-- src/service/access.ts, and the `staff` search ACL):
--
--   nothing at or below a staff-only folder is visible to an external actor (investor, delegate,
--   share-link visitor), whatever grant they hold — inherited from the root, on the folder
--   itself, on a folder inside it or on the document. The flag dominates; a grant does not
--   lift it. Staff share a signed document on purpose by MOVING it out (audited).
--
--  * dataroom.under_staff_only(path)  whether `path` lies at or below a staff-only folder of the
--                                     current workspace. SECURITY DEFINER with row security off:
--                                     an external caller's own folder RLS hides exactly the
--                                     staff-only folders it must find (and a policy on
--                                     dataroom.folder cannot query dataroom.folder under RLS
--                                     without recursing). It reads the current workspace only
--                                     and answers a boolean about a path the caller supplied.
--  * folder_external_read / document_external_read
--                                     gain `NOT dataroom.under_staff_only(…)`. Versions,
--                                     renditions and page text are readable externally only
--                                     through a readable document, so they follow.
--  * folder_staff_only_sticky         `staff_only` may be set, never cleared: no application path
--                                     clears it, and an UPDATE that tries raises. Exposing a
--                                     signed document is a move, not a flag flip.

--> statement-breakpoint
CREATE FUNCTION dataroom.under_staff_only(p_path ltree) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public SET row_security = off AS $$
  SELECT p_path IS NOT NULL AND EXISTS (
    SELECT 1 FROM dataroom.folder f
    WHERE f.workspace_id = core.current_workspace()
      AND f.staff_only
      AND f.path @> p_path
  )
$$;
REVOKE ALL ON FUNCTION dataroom.under_staff_only(ltree) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dataroom.under_staff_only(ltree) TO seedhost_app;

CREATE INDEX folder_staff_only_idx ON dataroom.folder USING gist (path) WHERE staff_only;

--> statement-breakpoint
DROP POLICY folder_external_read ON dataroom.folder;
CREATE POLICY folder_external_read ON dataroom.folder FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND deleted_at IS NULL
    AND NOT dataroom.under_staff_only(path)
    AND core.has_access('folder', id, path, 'view')
  );

DROP POLICY document_external_read ON dataroom.document;
CREATE POLICY document_external_read ON dataroom.document FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND deleted_at IS NULL
    AND NOT dataroom.under_staff_only(folder_path)
    AND core.has_access('document', id, folder_path, 'view')
  );

--> statement-breakpoint
CREATE OR REPLACE FUNCTION dataroom.folder_staff_only_sticky() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.staff_only AND NOT NEW.staff_only THEN
    RAISE EXCEPTION 'dataroom.folder % is staff-only; the flag cannot be cleared', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER folder_staff_only_sticky BEFORE UPDATE OF staff_only ON dataroom.folder
  FOR EACH ROW EXECUTE FUNCTION dataroom.folder_staff_only_sticky();

SELECT core.apply_tenant_fence();
