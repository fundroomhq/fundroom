-- 0005_access_path_inheritance — a rule on an ancestor path covers every node under it,
-- whatever its kind (ADR-0034, E1.3). A data-room folder grant must reach the documents
-- inside the folder; documents carry their folder's ltree path and their own kind
-- (`document`), so the path branch of core.has_access() drops the kind equality that
-- 0004 required. Flat resources have no path and are still matched by id + kind only.
--
-- Hand-written (ADR-0004); function bodies are not part of the drizzle snapshot.

CREATE OR REPLACE FUNCTION core.has_access(
  p_kind text, p_id uuid, p_path ltree, p_capability core.access_capability
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((
    SELECT p_capability = ANY (ea.capabilities)
    FROM core.effective_access ea
    WHERE ea.workspace_id = core.current_workspace()
      AND ea.membership_id = core.current_membership()
      AND (
        (ea.resource_kind = p_kind AND ea.resource_id = p_id)
        OR (p_path IS NOT NULL AND ea.resource_path IS NOT NULL AND ea.resource_path @> p_path)
      )
    ORDER BY (ea.resource_kind = p_kind AND ea.resource_id = p_id) DESC,
             nlevel(ea.resource_path) DESC NULLS LAST
    LIMIT 1
  ), false)
$$;
