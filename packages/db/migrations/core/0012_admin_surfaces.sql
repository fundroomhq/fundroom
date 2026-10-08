-- 0012_admin_surfaces — view-as sessions, workspace soft-delete clock, DSAR kinds, access
-- reviews and identity erasure (EXECUTION_PLAN §15 E2.7 "Admin surfaces").
--
-- Hand-written (ADR-0004). The TypeScript views are src/schema/identity.ts (session),
-- src/schema/core.ts (workspace), src/schema/dsar.ts (dsar_request, dsar_step) and
-- src/schema/access-review.ts. Runs inside one transaction; new tables declare their fences
-- inline so nothing can read a row between CREATE TABLE and the runner's
-- core.apply_tenant_fence() pass.
--
--  * session         view_as_* — a staff session currently viewing the portal as one external
--                    member of one workspace. All four columns are set together or not at all.
--  * workspace       purge_after / purged_at — the 30-day clock a soft delete starts, and the
--                    moment the purge job crypto-shredded the workspace's keys.
--  * dsar_request    kind (erasure | access | rectification), the note written on completion,
--                    and the sha256 of the subject export that answered an access request.
--  * dsar_step       may now be reported by `core.identity`, the kernel's own identity step.
--  * access_review   one row per completed periodic access review; append-only evidence.
--  * erase_user_identity / user_other_live_memberships — the only two ways a tenant context
--                    may learn or change anything about a user's *other* workspaces.

--> statement-breakpoint
-- 1. View as investor (E2.7 package B2). `view_as_membership_id` has no foreign key: the
-- middleware re-reads the target membership on every request and ends the view when it is no
-- longer an active external member, so a dangling id is a stale view, never a wrong one.
ALTER TABLE core.session
  ADD COLUMN view_as_membership_id uuid,
  ADD COLUMN view_as_workspace_id uuid REFERENCES core.workspace (id) ON DELETE CASCADE,
  ADD COLUMN view_as_until timestamptz,
  ADD COLUMN view_as_started_at timestamptz;
ALTER TABLE core.session ADD CONSTRAINT session_view_as_shape CHECK (
  num_nulls(view_as_membership_id, view_as_workspace_id, view_as_until, view_as_started_at) IN (0, 4)
) NOT VALID;
ALTER TABLE core.session VALIDATE CONSTRAINT session_view_as_shape;

--> statement-breakpoint
-- 2. Workspace deletion (E2.7 package B1). `deleted_at` (0000) is the soft delete; the purge
-- clock only exists on a deleted workspace, and a workspace is purged at most once.
ALTER TABLE core.workspace
  ADD COLUMN purge_after timestamptz,
  ADD COLUMN purged_at timestamptz;
ALTER TABLE core.workspace ADD CONSTRAINT workspace_purge_shape CHECK (
  (purge_after IS NULL OR deleted_at IS NOT NULL)
  AND (purged_at IS NULL OR (deleted_at IS NOT NULL AND purge_after IS NOT NULL))
) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_purge_shape;
-- The daily purge job's scan: deleted, not yet purged, clock running.
CREATE INDEX workspace_purge_due_idx ON core.workspace (purge_after)
  WHERE purge_after IS NOT NULL AND purged_at IS NULL;

--> statement-breakpoint
-- 3. DSAR kinds (E2.7 package C). Every existing request was an erasure request.
CREATE TYPE core.dsar_kind AS ENUM ('erasure', 'access', 'rectification');

ALTER TABLE core.dsar_request
  ADD COLUMN kind core.dsar_kind NOT NULL DEFAULT 'erasure',
  -- free text from the admin when completing an access/rectification request; staff-only
  ADD COLUMN completion_note text,
  -- sha256 (hex) of the subject export zip that answered an access request
  ADD COLUMN export_sha256 text;
ALTER TABLE core.dsar_request ADD CONSTRAINT dsar_request_completion_note_length CHECK (
  completion_note IS NULL OR char_length(completion_note) <= 1000
) NOT VALID;
ALTER TABLE core.dsar_request VALIDATE CONSTRAINT dsar_request_completion_note_length;
ALTER TABLE core.dsar_request ADD CONSTRAINT dsar_request_export_sha256_shape CHECK (
  export_sha256 IS NULL OR export_sha256 ~ '^[0-9a-f]{64}$'
) NOT VALID;
ALTER TABLE core.dsar_request VALIDATE CONSTRAINT dsar_request_export_sha256_shape;
-- Both are facts about a completion: absent on an open or cancelled request.
ALTER TABLE core.dsar_request ADD CONSTRAINT dsar_request_completion_shape CHECK (
  status = 'completed' OR (completion_note IS NULL AND export_sha256 IS NULL)
) NOT VALID;
ALTER TABLE core.dsar_request VALIDATE CONSTRAINT dsar_request_completion_shape;

-- At most one open request per member *and kind*: an erasure request and an access request
-- for the same person are two clocks and may run side by side. Same index name as 0011, so the
-- 23505 → 409 mapping keyed on it keeps working.
DROP INDEX core.dsar_request_open_idx;
CREATE UNIQUE INDEX dsar_request_open_idx ON core.dsar_request (workspace_id, membership_id, kind)
  WHERE status = 'requested';

-- A request changes state once and is otherwise immutable. The completion facts
-- (completion_note, export_sha256) are written by that one transition to `completed` and by
-- nothing else; `kind` never changes.
CREATE OR REPLACE FUNCTION core.dsar_request_transition_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'data request % is already %', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at
     OR NEW.expected_modules IS DISTINCT FROM OLD.expected_modules
     OR NEW.note IS DISTINCT FROM OLD.note THEN
    RAISE EXCEPTION 'a data request may only be completed or cancelled, not rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> 'completed'
     AND (NEW.completion_note IS DISTINCT FROM OLD.completion_note
          OR NEW.export_sha256 IS DISTINCT FROM OLD.export_sha256) THEN
    RAISE EXCEPTION 'completion facts may only be written when the request is completed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- The kernel's identity-erasure step reports as `core.identity`, which the module-id shape of
-- 0011 does not admit. Widening only, so every existing row still satisfies it.
ALTER TABLE core.dsar_step DROP CONSTRAINT dsar_step_module_shape;
ALTER TABLE core.dsar_step ADD CONSTRAINT dsar_step_module_shape CHECK (
  module ~ '^[a-z][a-z0-9-]{0,63}$' OR module = 'core.identity'
) NOT VALID;
ALTER TABLE core.dsar_step VALIDATE CONSTRAINT dsar_step_module_shape;

--> statement-breakpoint
-- 4. Access reviews (E2.7 package B1). One row per "Mark review complete": who reviewed, when,
-- how many members and flags the report showed, and the sha256 of the report's canonical JSON,
-- so the evidence can be matched to an export later. `reviewer_membership_id` has no foreign
-- key, like audit.event's actor ids: the evidence outlives the reviewer's membership.
CREATE TABLE core.access_review (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  reviewer_membership_id uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  member_count integer NOT NULL,
  flagged_count integer NOT NULL,
  note text,
  report_sha256 text NOT NULL,
  -- The canonical report the hash is over, kept so the evidence can be produced later: the
  -- report cannot be regenerated (activity and sessions move on). Bounded by the report's own
  -- member cap.
  report jsonb NOT NULL,
  report_schema_version integer NOT NULL DEFAULT 1,
  CONSTRAINT access_review_counts CHECK (member_count >= 0 AND flagged_count BETWEEN 0 AND member_count),
  CONSTRAINT access_review_note_length CHECK (note IS NULL OR char_length(note) <= 1000),
  CONSTRAINT access_review_sha256_shape CHECK (report_sha256 ~ '^[0-9a-f]{64}$')
);
-- The history list and "next review due": newest first.
CREATE INDEX access_review_ws_idx ON core.access_review (workspace_id, completed_at DESC, id DESC);

-- Append-only evidence: the default privileges of the core schema grant UPDATE and DELETE;
-- take them back, and refuse an UPDATE from any role that still has it. (No DELETE trigger: the
-- workspace cascade must still be able to remove the rows.)
REVOKE UPDATE, DELETE ON core.access_review FROM seedhost_app;
CREATE TRIGGER access_review_immutable BEFORE UPDATE ON core.access_review
  FOR EACH ROW EXECUTE FUNCTION core.freeze_evidence_row();

-- Staff (the access review screen) and the system only. An external member matches no
-- permissive policy.
ALTER TABLE core.access_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.access_review FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.access_review AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY access_review_read ON core.access_review FOR SELECT
  USING (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY access_review_insert ON core.access_review FOR INSERT
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
-- 5. Identity erasure (E2.7 package C).
--
-- A user is global (0001: core."user", user_identity, credential, device, session carry no
-- workspace); a workspace's erasure request may only erase them globally when this workspace
-- is the last place they belong. A tenant context cannot see the user's other memberships —
-- no policy lets it (§6.1) — so the question has to be answered by a SECURITY DEFINER function,
-- and a definer function any tenant could call on any user would be a cross-tenant erase
-- primitive. Hence the guard, which both public functions run first:
--
--  * the transaction's tenant context must be exactly p_workspace_id, as staff or system;
--  * the user must hold a membership (any status — the erasure path revokes it before calling)
--    in p_workspace_id.
--
-- "Other live membership" = a membership in any *other* workspace whose status is not
-- 'revoked' (invited, active, dormant and suspended all count: each is a relationship the
-- other workspace may still act on, and erasing the login under it would silently break it).
-- A membership in a soft-deleted workspace also counts — it may still be restored.
--
-- The definer runs as the migration owner. When that role is subject to RLS (FORCE ROW LEVEL
-- SECURITY applies to table owners that are not superusers or BYPASSRLS), the global tables'
-- fences are satisfied by switching the transaction-local context to `host` for this user for
-- the duration of the call and restoring it afterwards. The switch never outlives the call: an
-- error aborts the transaction (or rolls back to the caller's savepoint), which reverts it.
CREATE FUNCTION core.identity_erasure_guard(p_user_id uuid, p_workspace_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, core AS $$
BEGIN
  IF p_user_id IS NULL OR p_workspace_id IS NULL
     OR core.current_workspace() IS DISTINCT FROM p_workspace_id
     OR core.current_actor_kind() IS NULL
     OR core.current_actor_kind() NOT IN ('staff', 'system') THEN
    RAISE EXCEPTION 'identity erasure needs a staff or system context of the workspace itself'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Read under the caller's own tenant context: only this workspace's rows are visible.
  IF NOT EXISTS (
    SELECT 1 FROM core.membership m
    WHERE m.user_id = p_user_id AND m.workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'identity erasure needs a membership of the user in this workspace'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;
-- Internal: reachable only from the two definer functions below (which run as the owner).
REVOKE EXECUTE ON FUNCTION core.identity_erasure_guard(uuid, uuid) FROM PUBLIC, seedhost_app;

CREATE FUNCTION core.user_other_live_memberships(p_user_id uuid, p_workspace_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core AS $$
DECLARE
  saved_actor text := current_setting('app.actor_kind', true);
  saved_user text := current_setting('app.user_id', true);
  n integer;
BEGIN
  PERFORM core.identity_erasure_guard(p_user_id, p_workspace_id);
  PERFORM set_config('app.actor_kind', 'host', true);
  PERFORM set_config('app.user_id', p_user_id::text, true);
  SELECT count(*)::integer INTO n FROM core.membership m
  WHERE m.user_id = p_user_id AND m.workspace_id <> p_workspace_id AND m.status <> 'revoked';
  PERFORM set_config('app.actor_kind', coalesce(saved_actor, ''), true);
  PERFORM set_config('app.user_id', coalesce(saved_user, ''), true);
  RETURN n;
END;
$$;
REVOKE EXECUTE ON FUNCTION core.user_other_live_memberships(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.user_other_live_memberships(uuid, uuid) TO seedhost_app;

-- Returns true when the user was pseudonymised globally, false when another live membership
-- keeps the identity (the caller's per-workspace erasure is then all there is). Idempotent.
-- Per-workspace facts (membership profile, invites, this workspace's sessions) are the caller's
-- job, in the same transaction, before calling this.
CREATE FUNCTION core.erase_user_identity(p_user_id uuid, p_workspace_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core AS $$
DECLARE
  saved_actor text := current_setting('app.actor_kind', true);
  saved_user text := current_setting('app.user_id', true);
  others integer;
BEGIN
  PERFORM core.identity_erasure_guard(p_user_id, p_workspace_id);
  PERFORM set_config('app.actor_kind', 'host', true);
  PERFORM set_config('app.user_id', p_user_id::text, true);

  SELECT count(*)::integer INTO others FROM core.membership m
  WHERE m.user_id = p_user_id AND m.workspace_id <> p_workspace_id AND m.status <> 'revoked';

  IF others = 0 THEN
    -- Sessions first: revoke every live one and scrub the network facts of all of them. The
    -- device rows go next; session.device_id is ON DELETE SET NULL.
    UPDATE core.session SET revoked_at = coalesce(revoked_at, now()),
        revoked_reason = coalesce(revoked_reason, 'erased'),
        ip = NULL,
        user_agent = ''
    WHERE user_id = p_user_id;
    DELETE FROM core.device WHERE user_id = p_user_id;
    DELETE FROM core.credential WHERE user_id = p_user_id;
    -- Outstanding login challenges carry the address in clear; drop them before it is replaced.
    DELETE FROM core.auth_challenge
    WHERE user_id = p_user_id
       OR email IN (
         SELECT ui.identifier FROM core.user_identity ui
         WHERE ui.user_id = p_user_id AND ui.type = 'email'
       );
    -- Every identifier (email, OIDC/SAML subject, host id) becomes an unroutable pseudonym
    -- keyed on the identity ROW, never on the old value: a hash of the address would collide
    -- when a person erased once signs up again with the same address and is erased a second
    -- time (unique index on type+identifier → the step fails forever), and a short unsalted
    -- hash of an email is reversible with a dictionary. Already-erased identifiers are left
    -- alone so the call is idempotent.
    UPDATE core.user_identity SET identifier = 'erased+' || replace(id::text, '-', '')
          || '@erased.invalid'
    WHERE user_id = p_user_id AND identifier::text NOT LIKE 'erased+%@erased.invalid';
    -- display_name is NOT NULL (0001): '' is its empty value. Bumping session_version signs
    -- the user out everywhere even if a session row was missed.
    UPDATE core."user" AS u SET display_name = '',
        avatar_url = NULL,
        deleted_at = coalesce(u.deleted_at, now()),
        session_version = u.session_version + 1
    WHERE u.id = p_user_id;
  END IF;

  PERFORM set_config('app.actor_kind', coalesce(saved_actor, ''), true);
  PERFORM set_config('app.user_id', coalesce(saved_user, ''), true);
  RETURN others = 0;
END;
$$;
REVOKE EXECUTE ON FUNCTION core.erase_user_identity(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.erase_user_identity(uuid, uuid) TO seedhost_app;

SELECT core.apply_tenant_fence();
