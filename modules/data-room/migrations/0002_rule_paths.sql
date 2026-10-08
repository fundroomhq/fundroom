-- 0002_rule_paths — a data-room rule's `resource_path` is a scope, and only a folder has one
-- (review E2.10 R1-A1/A2, ADR-0034 §4 + consequences).
--
-- A rule whose resource carries an ltree path covers every node at or below that path, whatever
-- its kind. Documents sit in their folder (`document.folder_path`) but are *leaves*: a rule on a
-- document is matched by id and must carry no path. Until this migration the web Share sheet
-- posted a document grant with the document's folder path, and the kernel stored it, so sharing
-- one document shared the folder, every sibling and every subfolder. Likewise any non-folder
-- rule (a `post`, a kind no module looks up) could be filed under a path inside the data room's
-- namespace (root label `r`) and cover that subtree.
--
-- The data room owns both its kinds and its namespace, so it owns this invariant:
--
--  1. A BEFORE INSERT OR UPDATE trigger on core.access_grant and core.access_policy clears the
--     path of every rule on a `document`, and of every non-`folder` rule whose path lies in `r`.
--     This is the storage-level backstop for every writer — the access routes (which now derive
--     the path from the resource row and refuse a mismatching one), invitations, share links,
--     and workspace imports of rows exported before this fix. Clearing is the canonical form,
--     not a loss: such a rule means exactly "this resource", which its id already says.
--  2. Remediation of rows already written: the same rule applied to existing live and revoked
--     rows, per workspace (the tenant fence needs `app.workspace_id`, so this works whether or
--     not the migrating role bypasses RLS). Every workspace that had one gets `acl_version`
--     bumped and its materialised `effective_access` rows and build state deleted, so both the
--     evaluator (`ensureFresh` sees no state → rebuild) and `core.has_access()` (no rows → deny)
--     stop honouring the over-grant at once: fail-closed until the first rebuild.
--
-- Folder rules keep their path: moving a folder rewrites them (GrantRepo/PolicyRepo.rewritePaths),
-- which this trigger leaves untouched.

CREATE OR REPLACE FUNCTION dataroom.canonical_rule_path() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.resource_path IS NOT NULL
     AND NEW.resource_kind IS DISTINCT FROM 'folder'
     AND (NEW.resource_kind = 'document' OR NEW.resource_path <@ 'r'::ltree) THEN
    NEW.resource_path := NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER dataroom_canonical_rule_path
  BEFORE INSERT OR UPDATE OF resource_kind, resource_path ON core.access_grant
  FOR EACH ROW EXECUTE FUNCTION dataroom.canonical_rule_path();

CREATE TRIGGER dataroom_canonical_rule_path
  BEFORE INSERT OR UPDATE OF resource_kind, resource_path ON core.access_policy
  FOR EACH ROW EXECUTE FUNCTION dataroom.canonical_rule_path();

-- The remediation, kept as a function so an operator can re-run it (docs: modules/data-room
-- README "Rule paths") after restoring an old backup or importing an old export — the trigger
-- already canonicalises imported rows; this also clears the materialised rows built from them.
-- Owner-only: the application role never needs it and must not be able to switch to `host`.
CREATE OR REPLACE FUNCTION dataroom.clear_overbroad_rule_paths() RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  ws uuid;
  fixed integer;
  n integer;
  total integer := 0;
BEGIN
  PERFORM set_config('app.actor_kind', 'host', true);
  FOR ws IN SELECT id FROM core.workspace ORDER BY id LOOP
    PERFORM set_config('app.workspace_id', ws::text, true);
    -- The trigger above does the clearing; naming the path column in SET is what fires it.
    UPDATE core.access_grant SET resource_path = resource_path
      WHERE workspace_id = ws AND resource_path IS NOT NULL AND resource_kind <> 'folder'
        AND (resource_kind = 'document' OR resource_path <@ 'r'::ltree);
    GET DIAGNOSTICS fixed = ROW_COUNT;
    UPDATE core.access_policy SET resource_path = resource_path
      WHERE workspace_id = ws AND resource_path IS NOT NULL AND resource_kind <> 'folder'
        AND (resource_kind = 'document' OR resource_path <@ 'r'::ltree);
    GET DIAGNOSTICS n = ROW_COUNT;
    fixed := fixed + n;
    IF fixed > 0 THEN
      UPDATE core.workspace SET acl_version = acl_version + 1 WHERE id = ws;
      DELETE FROM core.effective_access WHERE workspace_id = ws;
      DELETE FROM core.effective_access_state WHERE workspace_id = ws;
      RAISE NOTICE 'dataroom: cleared % over-broad rule path(s) in workspace %', fixed, ws;
      total := total + fixed;
    END IF;
  END LOOP;
  PERFORM set_config('app.workspace_id', '', true);
  PERFORM set_config('app.actor_kind', '', true);
  RETURN total;
END $$;
REVOKE ALL ON FUNCTION dataroom.clear_overbroad_rule_paths() FROM PUBLIC;
REVOKE ALL ON FUNCTION dataroom.clear_overbroad_rule_paths() FROM seedhost_app;

SELECT dataroom.clear_overbroad_rule_paths();
