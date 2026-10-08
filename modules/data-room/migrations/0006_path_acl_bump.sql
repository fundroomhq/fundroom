-- 0006_path_acl_bump — every change of where a data-room node sits moves `acl_version`, in the
-- same transaction (E3.5 review R3A).
--
-- Hand-written (ADR-0004). Runs inside one transaction.
--
-- Why: the authz rebuild (packages/authz `computeEffectiveRows`) resolves some effective-access
-- rows from the node's LOCATION at rebuild time — a gated document's or folder's own row carries
-- the capabilities its ancestors' rules grant there (review AZ), a delegate's document row the
-- delegate's own ancestor excludes (F4), the staff-only veil (E3.5). `check()` and
-- `core.has_access()` answer from a node's own row first, so once the node moves the old row keeps
-- granting what the OLD ancestors allowed until something rebuilds. The service code bumped on a
-- move and a folder restore but not on a document restored to the root out of a binned folder —
-- and nothing in the reconciler notices a stale row whose version is current. A rule per call
-- site is how that was missed; this makes it structural.
--
--  * dataroom.bump_acl_on_location_change()
--        `acl_version + 1` on the workspace and `acl.changed` {aclVersion, cause:"data-room.path"}
--        on the outbox (the same two writes `bumpAcl` in packages/authz makes) — once per
--        transaction and workspace: skipped when the transaction already bumped. `bumpAcl` marks
--        that with the transaction-local setting `authz.acl_bumped` (= the workspace id), and so
--        does this function. Fails closed (raises) when the workspace row is not visible.
--  * document_location_acl / folder_location_acl
--        CONSTRAINT triggers, DEFERRABLE INITIALLY DEFERRED: they fire at COMMIT, after every
--        statement of the transaction, for a row whose `folder_path` (document) or `path` /
--        `staff_only` (folder) changed. Deferred on purpose — the global lock order (E3.5 LX) is
--        entity rows → workspace row → search → audit chain → outbox. At commit a transaction
--        that audited or wrote search already holds the workspace row (`lockAuditChain` and every
--        search write take it first), so the bump waits for nothing; one that did not has taken
--        only entity rows, so the workspace row comes after them. An IMMEDIATE row trigger would
--        take the workspace row in the middle of a subtree rewrite, before the document and rule
--        rows the same transaction goes on to lock.
--
-- The application still bumps explicitly where it moves things (it also drops the in-process
-- authz cache, which a trigger cannot); the trigger is the backstop for every writer, present or
-- future. Inserts need nothing: a node that did not exist has no row to go stale.

--> statement-breakpoint
CREATE FUNCTION dataroom.bump_acl_on_location_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v bigint;
BEGIN
  IF current_setting('authz.acl_bumped', true) = NEW.workspace_id::text THEN
    RETURN NULL;
  END IF;
  UPDATE core.workspace SET acl_version = acl_version + 1
   WHERE id = NEW.workspace_id
  RETURNING acl_version INTO v;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dataroom: cannot bump acl_version of workspace % after a location change',
      NEW.workspace_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO core.outbox (workspace_id, topic, payload)
  VALUES (NEW.workspace_id, 'acl.changed',
          jsonb_build_object('aclVersion', v, 'cause', 'data-room.path'));
  PERFORM set_config('authz.acl_bumped', NEW.workspace_id::text, true);
  RETURN NULL;
END $$;

--> statement-breakpoint
CREATE CONSTRAINT TRIGGER document_location_acl
  AFTER UPDATE OF folder_path ON dataroom.document
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.folder_path IS DISTINCT FROM NEW.folder_path)
  EXECUTE FUNCTION dataroom.bump_acl_on_location_change();

CREATE CONSTRAINT TRIGGER folder_location_acl
  AFTER UPDATE OF path, staff_only ON dataroom.folder
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.path IS DISTINCT FROM NEW.path OR OLD.staff_only IS DISTINCT FROM NEW.staff_only)
  EXECUTE FUNCTION dataroom.bump_acl_on_location_change();

SELECT core.apply_tenant_fence();
