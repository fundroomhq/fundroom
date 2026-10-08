-- 0003_delegate_scope — content pages are `updates`-scope content for a delegate (E3.2, core
-- migration 0017; review round 1, F3).
--
-- Hand-written (ADR-0004). Policies only; src/schema is unchanged. Runs inside one transaction.
--
-- A page's `authenticated` sections are addressed to every member, which for a delegate is
-- "updates" content: a delegate with scope `all` or `updates` reads published pages as any member
-- does, one with scope `data_room` (or whose principal is not live) reads none under its own
-- context. The render route shows such a delegate what a signed-out visitor would see (the public
-- sections, when the workspace allows them) through a system context, so this is the floor under
-- that route, not the only lock.

--> statement-breakpoint
DROP POLICY page_external_read ON content.page;
CREATE POLICY page_external_read ON content.page FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND deleted_at IS NULL
    AND published_revision_id IS NOT NULL
    AND (SELECT core.current_delegation_admits('content'))
  );

DROP POLICY page_revision_external_read ON content.page_revision;
CREATE POLICY page_revision_external_read ON content.page_revision FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND published_at IS NOT NULL
    AND (SELECT core.current_delegation_admits('content'))
  );

SELECT core.apply_tenant_fence();
