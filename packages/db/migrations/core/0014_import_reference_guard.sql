-- 0014_import_reference_guard — the cross-workspace reference check of a workspace import
-- (E2.8 fix C; EXECUTION_PLAN §15 E2.8 "workspace export zip + import").
--
-- Hand-written (ADR-0004). No tables, one function; nothing for drizzle to track.
--
-- The importer remaps every uuid that names an EXPORTED row and keeps every other uuid verbatim
-- (a reference to a row the export did not carry: a skipped table, a deleted row, another
-- instance's id). A crafted file can use that to plant the id of a row of ANOTHER workspace on
-- this instance: a foreign key accepts it (FK checks bypass RLS), and code that resolves ids
-- outside a tenant fence would follow it. So the importer asks, before inserting anything, which
-- of the verbatim uuids in the file are the `id` of a row of another workspace here, and clears
-- or refuses them (packages/portability/README.md "Import refusal rules").
--
-- A tenant context cannot answer that — every tenant table is fenced to one workspace — hence a
-- SECURITY DEFINER function with row security off for its own queries. That needs a function
-- owner that bypasses RLS (superuser or BYPASSRLS, which is what the migration runner expects;
-- it warns otherwise). With an owner subject to RLS the queries raise 42501 instead of silently
-- seeing nothing, and the import is refused rather than let through unchecked.
--
-- Guard (the function must not be a cross-tenant existence oracle for ordinary requests): the
-- caller must be the `system` actor of p_workspace_id, and that workspace must be mid-import —
-- no membership and no core.workspace_import row yet. It returns only ids the caller already
-- holds, the table they belong to and whether they belong to p_source_id; never which workspace.
CREATE FUNCTION core.import_foreign_references(p_workspace_id uuid, p_source_id uuid, p_ids uuid[])
RETURNS TABLE (ref_id uuid, table_name text, in_source boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core SET row_security = off AS $$
DECLARE
  t record;
BEGIN
  IF p_workspace_id IS NULL
     OR core.current_workspace() IS DISTINCT FROM p_workspace_id
     OR core.current_actor_kind() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'the import reference check needs the system context of the new workspace'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM core.membership m WHERE m.workspace_id = p_workspace_id)
     OR EXISTS (SELECT 1 FROM core.workspace_import i WHERE i.workspace_id = p_workspace_id) THEN
    RAISE EXCEPTION 'the import reference check runs only on a workspace that is being imported'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT w.id, 'core.workspace'::text, w.id = p_source_id
    FROM core.workspace w
    WHERE w.id = ANY (p_ids) AND w.id <> p_workspace_id;

  -- Every tenant table (a workspace_id column) whose rows are named by a uuid `id`.
  FOR t IN
    SELECT n.nspname AS schema_name, c.relname AS rel_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
      AND n.nspname NOT LIKE 'pg\_%'
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id'
                  AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'id'
                  AND a.atttypid = 'uuid'::regtype AND NOT a.attisdropped)
    ORDER BY 1, 2
  LOOP
    RETURN QUERY EXECUTE format(
      'SELECT x.id, %L::text, x.workspace_id = $2 FROM %I.%I x '
      'WHERE x.id = ANY ($1) AND x.workspace_id <> $3',
      t.schema_name || '.' || t.rel_name, t.schema_name, t.rel_name)
    USING p_ids, p_source_id, p_workspace_id;
  END LOOP;
END;
$$;
REVOKE EXECUTE ON FUNCTION core.import_foreign_references(uuid, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.import_foreign_references(uuid, uuid, uuid[]) TO seedhost_app;

SELECT core.apply_tenant_fence();
