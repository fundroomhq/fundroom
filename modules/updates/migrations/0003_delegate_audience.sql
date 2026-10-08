-- 0003_delegate_audience — a delegate reads updates addressed to its principal's groups (E3.2,
-- design/05 §4.2) when its scope admits updates (`all` or `updates`) and its principal is live.
--
-- Hand-written (ADR-0004). core.current_delegation_principal('updates') (core migration 0017)
-- names that principal, or NULL; the TypeScript twin is identity's
-- `GroupRepo.audienceGroupIdsFor(membershipId, "updates")`, which the post routes use for the
-- reader's group ids. An `all` audience admits every external member except a delegate whose
-- scope does not admit updates (`data_room`) or whose principal is not live
-- (`core.current_delegation_admits('updates')`, review round 1 F3); the TypeScript twin is
-- `audienceIncludes` with the reader's `delegateScope`. The same holds for group audiences, the
-- delegate's own groups included (review round 2, matching the search `groups` arm): a delegate
-- reads nothing of a module its scope does not admit.

CREATE OR REPLACE FUNCTION updates.audience_includes_current(p_audience jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT (SELECT core.current_delegation_admits('updates')) AND (
    COALESCE(p_audience->>'kind', 'all') = 'all'
    OR EXISTS (
      SELECT 1 FROM core.group_member gm
      WHERE gm.workspace_id = core.current_workspace()
        AND gm.membership_id IN (core.current_membership(), core.current_delegation_principal('updates'))
        AND gm.revoked_at IS NULL
        AND gm.group_id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_audience->'groupIds', '[]'::jsonb)))
    ))
$$;

SELECT core.apply_tenant_fence();
