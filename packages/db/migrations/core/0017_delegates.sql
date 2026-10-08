-- 0017_delegates — delegates act for a principal investor with a chosen subset of what the
-- principal can see (EXECUTION_PLAN §15 E3.2; design/05 §4.2, §5 "Delegates", §7 "Delegate abuse").
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/identity.ts (membership.delegateScope,
-- invite.principalMembershipId, invite.delegateScope); function bodies and triggers are not part of
-- the drizzle snapshot. Runs inside one transaction.
--
--  * membership.delegate_scope   `all` | `data_room` | `updates`; set iff role = 'delegate'. What the
--                                delegate inherits from its principal (packages/authz evaluate.ts
--                                `rulesFor`): the principal's membership and group subjects, allow
--                                rules filtered by resource kind for a narrow scope.
--  * invite.principal_membership_id + invite.delegate_scope
--                                a delegate is created as an ordinary invitation naming its principal;
--                                acceptance copies both onto the membership. Cascades with the
--                                principal's row.
--  * core.current_delegation_live()
--                                false for a delegate whose principal is not live (not `active`, or
--                                past its expires_at) — the instant it happens, with no rebuild.
--  * core.current_delegation_principal(module)
--                                the principal a live delegate may borrow group audiences from, for a
--                                module its scope admits (data room and updates only); NULL otherwise.
--  * core.current_delegation_admits(module), core.current_membership_is_delegate()
--                                whether the current actor may read a module's member-wide content
--                                (round, metrics: `all` scope only); whether it is a delegate at all.
--                                A delegate's principal must be an external investor everywhere.
--  * core.has_access()           now also false (a) for a row past its own expires_at, the answer the
--                                TypeScript evaluator's `rowExpired` gives, and (b) for a delegate
--                                whose principal is not live.
--  * search_entry_external_read  the `groups` arm admits a delegate through its principal's groups
--                                when its scope admits the entry's module; the `members` arm only
--                                when `current_delegation_admits(module)`.

--> statement-breakpoint
-- 1. Columns and their shape.
ALTER TABLE core.membership ADD COLUMN delegate_scope text;
UPDATE core.membership SET delegate_scope = 'all' WHERE role = 'delegate';
ALTER TABLE core.membership ADD CONSTRAINT membership_delegate_scope CHECK (
  (role = 'delegate') = (delegate_scope IS NOT NULL)
  AND (delegate_scope IS NULL OR delegate_scope IN ('all', 'data_room', 'updates'))
);

-- A `delegate` invitation written before this migration names no principal and could never be
-- accepted (membership_delegate_principal refuses the row it would create); it is dead weight.
DELETE FROM core.invite WHERE role = 'delegate';
ALTER TABLE core.invite ADD COLUMN principal_membership_id uuid
  CONSTRAINT invite_principal_membership_id_membership_id_fk REFERENCES core.membership (id) ON DELETE CASCADE;
ALTER TABLE core.invite ADD COLUMN delegate_scope text;
ALTER TABLE core.invite ADD CONSTRAINT invite_delegate CHECK (
  (principal_membership_id IS NULL) = (delegate_scope IS NULL)
  AND (role = 'delegate') = (principal_membership_id IS NOT NULL)
  AND (delegate_scope IS NULL OR delegate_scope IN ('all', 'data_room', 'updates'))
);
CREATE INDEX invite_principal_idx ON core.invite (principal_membership_id)
  WHERE principal_membership_id IS NOT NULL;
CREATE INDEX membership_principal_idx ON core.membership (principal_membership_id)
  WHERE principal_membership_id IS NOT NULL;

--> statement-breakpoint
-- 2. A principal is an external investor of the same workspace (never a delegate: delegates
-- cannot add delegates, design/05 §7). The FK alone would accept another workspace's membership.
CREATE OR REPLACE FUNCTION core.check_delegate_principal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.principal_membership_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.membership p
    WHERE p.id = NEW.principal_membership_id
      AND p.workspace_id = NEW.workspace_id
      AND p.kind = 'external'
      AND p.role = 'investor'
  ) THEN
    RAISE EXCEPTION 'a delegate''s principal must be an external investor of the same workspace'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'delegate_principal_investor';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER membership_delegate_principal_investor
  BEFORE INSERT OR UPDATE OF principal_membership_id, workspace_id ON core.membership
  FOR EACH ROW EXECUTE FUNCTION core.check_delegate_principal();
CREATE TRIGGER invite_delegate_principal_investor
  BEFORE INSERT OR UPDATE OF principal_membership_id, workspace_id ON core.invite
  FOR EACH ROW EXECUTE FUNCTION core.check_delegate_principal();

--> statement-breakpoint
-- 3. Delegation helpers. SECURITY INVOKER: core.membership is readable inside the tenant fence.
CREATE OR REPLACE FUNCTION core.current_delegation_live() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM core.membership d
    WHERE d.workspace_id = core.current_workspace()
      AND d.id = core.current_membership()
      AND d.principal_membership_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM core.membership p
        WHERE p.id = d.principal_membership_id
          AND p.workspace_id = d.workspace_id
          AND p.kind = 'external'
          AND p.role = 'investor'
          AND p.status = 'active'
          AND (p.expires_at IS NULL OR p.expires_at > now())
      )
  )
$$;

CREATE OR REPLACE FUNCTION core.current_delegation_principal(p_module text) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT p.id
  FROM core.membership d
  JOIN core.membership p ON p.id = d.principal_membership_id AND p.workspace_id = d.workspace_id
  WHERE d.workspace_id = core.current_workspace()
    AND d.id = core.current_membership()
    AND d.role = 'delegate'
    AND p.kind = 'external'
    AND p.role = 'investor'
    AND p.status = 'active'
    AND (p.expires_at IS NULL OR p.expires_at > now())
    -- Group audiences are inherited for these two modules only: content-page and metrics group
    -- audiences are not (their TypeScript readers use the delegate's own groups).
    AND p_module IN ('data-room', 'updates')
    AND (
      d.delegate_scope = 'all'
      OR (d.delegate_scope = 'data_room' AND p_module = 'data-room')
      OR (d.delegate_scope = 'updates' AND p_module = 'updates')
    )
$$;

-- Whether the current membership is a delegate at all (whatever its principal's state).
CREATE OR REPLACE FUNCTION core.current_membership_is_delegate() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.membership d
    WHERE d.workspace_id = core.current_workspace()
      AND d.id = core.current_membership()
      AND d.role = 'delegate'
  )
$$;

-- Whether the current actor may read a module's member-wide content (review round 1, F3): true
-- for anyone who is not a delegate; for a delegate, only while its principal is live and its
-- scope names the module — `all` every module, `data_room` the data room, `updates` updates and
-- content pages (a page addressed to every member is "updates" content). Round and metrics are
-- therefore `all`-only. The TypeScript twin is `@seed-host/domain` `delegationAdmitsModule`.
CREATE OR REPLACE FUNCTION core.current_delegation_admits(p_module text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT core.current_delegation_live() AND COALESCE((
    SELECT CASE d.delegate_scope
      WHEN 'all' THEN true
      WHEN 'data_room' THEN p_module = 'data-room'
      WHEN 'updates' THEN p_module IN ('updates', 'content')
      ELSE false END
    FROM core.membership d
    WHERE d.workspace_id = core.current_workspace()
      AND d.id = core.current_membership()
      AND d.role = 'delegate'
  ), true)
$$;

--> statement-breakpoint
-- 4. core.has_access(): the 0005 body plus the row's own expiry and the delegation check.
CREATE OR REPLACE FUNCTION core.has_access(
  p_kind text, p_id uuid, p_path ltree, p_capability core.access_capability
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT core.current_delegation_live() AND COALESCE((
    SELECT p_capability = ANY (ea.capabilities)
      AND (ea.expires_at IS NULL OR ea.expires_at > now())
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

--> statement-breakpoint
-- 5. Search: the `groups` arm learns delegation (the other arms are unchanged).
DROP POLICY search_entry_external_read ON core.search_entry;
CREATE POLICY search_entry_external_read ON core.search_entry FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    -- Argument-free: a scalar subquery is evaluated once per query, not once per row.
    AND (SELECT core.current_delegation_live())
    AND (
      (acl_kind = 'members' AND core.current_delegation_admits(module))
      OR (
        acl_kind = 'groups'
        -- A delegate's OWN group matches only for a module its scope admits (review round 2).
        AND core.current_delegation_admits(module)
        AND EXISTS (
          SELECT 1 FROM core.group_member gm
          JOIN core."group" g ON g.id = gm.group_id
          WHERE gm.membership_id IN (core.current_membership(), core.current_delegation_principal(module))
            AND gm.group_id = ANY (acl_groups)
            AND gm.revoked_at IS NULL
            AND g.deleted_at IS NULL
        )
      )
      OR (
        acl_kind = 'resource'
        AND core.has_access(acl_resource_kind, acl_resource_id, acl_path, 'view')
      )
    )
  );

SELECT core.apply_tenant_fence();
