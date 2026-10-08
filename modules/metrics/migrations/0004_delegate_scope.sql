-- 0004_delegate_scope — metrics are `all`-scope content for a delegate (E3.2, core migration 0017).
--
-- Hand-written (ADR-0004). Function body only; src/schema is unchanged. Runs inside one transaction.
--
-- A delegate acts for an investor with a scope (`all` | `data_room` | `updates`). A KPI is neither
-- data room nor updates content, so a narrow delegate reads no metric at all — not those published
-- to every member, and not those addressed to a group it belongs to (review round 1, F3). An `all`
-- delegate reads what any member reads, through its OWN groups: the principal's metric group
-- audiences are not inherited. `core.current_delegation_admits` is also false for a delegate whose
-- principal is not live. The TypeScript twin is `audienceAdmits` (src/model.ts), which the
-- hydrator applies for a system-context render (an email) where this function admits everything.

CREATE OR REPLACE FUNCTION metrics.audience_admits_current(p_audience jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT (SELECT core.current_delegation_admits('metrics')) AND CASE COALESCE(p_audience->>'kind', 'staff_only')
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

SELECT core.apply_tenant_fence();
