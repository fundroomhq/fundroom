-- 0004_access — grants, policy gates, the materialised effective_access table, CSV invite
-- imports and the workspace access settings (EXECUTION_PLAN §6.4, ADR-0014, ADR-0032, E1.1).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/access.ts. Runs inside one
-- transaction. Every table here is a plain tenant table: the standard fence is declared
-- inline so nothing can read a row before the runner's core.apply_tenant_fence() pass.
--
-- Model (ADR-0014, mechanics in ADR-0032):
--  * access_grant      subject (membership | group | role | link) → resource (kind + id + optional
--                      ltree path) → one capability, effect allow | exclude, validity window.
--  * access_policy     a gate (nda | accredited | min_auth_level | ip_allowlist) attached to the
--                      workspace, a group, a membership or a resource; gates are ANDed.
--  * effective_access  what the rebuild job materialises per (membership, granted node): the
--                      resolved capabilities and the gates still pending. Module RLS policies
--                      for investors read this table through core.has_access(); staff never
--                      go through it (RBAC).
--  * effective_access_state  which acl_version a workspace's rows were built for.
--  * invite_import     a CSV import job: per-row status kept in jsonb.

CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TYPE core.grant_subject_kind AS ENUM ('membership', 'group', 'role', 'link');
CREATE TYPE core.grant_effect AS ENUM ('allow', 'exclude');
CREATE TYPE core.access_capability AS ENUM ('view', 'download', 'comment', 'edit');
CREATE TYPE core.policy_kind AS ENUM ('nda', 'accredited', 'min_auth_level', 'ip_allowlist');
CREATE TYPE core.policy_target_kind AS ENUM ('workspace', 'group', 'membership', 'resource');
CREATE TYPE core.invite_import_status AS ENUM ('queued', 'running', 'done', 'failed');

--> statement-breakpoint
-- Invitations learn a profile (display name, firm, …) that becomes the membership profile on
-- acceptance, so a CSV import's "name" and "firm" columns land somewhere.
ALTER TABLE core.invite ADD COLUMN profile jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE core.invite ADD COLUMN profile_schema_version integer NOT NULL DEFAULT 1;

CREATE TABLE core.access_grant (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  subject_kind core.grant_subject_kind NOT NULL,
  -- membership / group / link id; NULL for role subjects
  subject_id uuid,
  -- staff role for role subjects; NULL otherwise
  subject_role core.membership_role,
  resource_kind text NOT NULL,
  resource_id uuid NOT NULL,
  -- materialised path for hierarchical resources (folders); NULL for flat ones
  resource_path ltree,
  capability core.access_capability NOT NULL,
  effect core.grant_effect NOT NULL DEFAULT 'allow',
  validity tstzrange NOT NULL DEFAULT tstzrange(now(), NULL, '[)'),
  max_views integer,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT access_grant_subject_shape CHECK (
    (subject_kind = 'role' AND subject_role IS NOT NULL AND subject_id IS NULL)
    OR (subject_kind <> 'role' AND subject_id IS NOT NULL AND subject_role IS NULL)
  ),
  CONSTRAINT access_grant_resource_kind_format CHECK (resource_kind ~ '^[a-z][a-z0-9_-]*$'),
  CONSTRAINT access_grant_max_views_positive CHECK (max_views IS NULL OR max_views > 0),
  CONSTRAINT access_grant_validity_nonempty CHECK (NOT isempty(validity))
);
-- One live rule per (subject, resource, capability); a repeat is an update, not a duplicate.
-- Two partial indexes because an enum→text cast is not IMMUTABLE and cannot be indexed.
CREATE UNIQUE INDEX access_grant_live_rule_idx ON core.access_grant (
  workspace_id, subject_kind, subject_id, resource_kind, resource_id, capability
) WHERE revoked_at IS NULL AND subject_id IS NOT NULL;
CREATE UNIQUE INDEX access_grant_live_role_rule_idx ON core.access_grant (
  workspace_id, subject_role, resource_kind, resource_id, capability
) WHERE revoked_at IS NULL AND subject_role IS NOT NULL;
CREATE INDEX access_grant_resource_idx ON core.access_grant (workspace_id, resource_kind, resource_id)
  WHERE revoked_at IS NULL;
CREATE INDEX access_grant_subject_idx ON core.access_grant (workspace_id, subject_kind, subject_id)
  WHERE revoked_at IS NULL;

CREATE TABLE core.access_policy (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  target_kind core.policy_target_kind NOT NULL,
  -- group / membership id, or the resource id; NULL for workspace-wide gates
  target_id uuid,
  resource_kind text,
  resource_path ltree,
  kind core.policy_kind NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_schema_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  CONSTRAINT access_policy_target_shape CHECK (
    (target_kind = 'workspace' AND target_id IS NULL AND resource_kind IS NULL)
    OR (target_kind IN ('group', 'membership') AND target_id IS NOT NULL AND resource_kind IS NULL)
    OR (target_kind = 'resource' AND target_id IS NOT NULL AND resource_kind IS NOT NULL)
  ),
  CONSTRAINT access_policy_resource_kind_format CHECK (resource_kind IS NULL OR resource_kind ~ '^[a-z][a-z0-9_-]*$')
);
CREATE INDEX access_policy_target_idx ON core.access_policy (workspace_id, target_kind, target_id)
  WHERE revoked_at IS NULL;

CREATE TABLE core.effective_access (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  resource_kind text NOT NULL,
  resource_id uuid NOT NULL,
  resource_path ltree,
  capabilities core.access_capability[] NOT NULL,
  pending_gates jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_gates_schema_version integer NOT NULL DEFAULT 1,
  -- earliest end of validity among the rules that granted something; the reconciler re-checks then
  expires_at timestamptz,
  acl_version bigint NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, membership_id, resource_kind, resource_id)
);
CREATE INDEX effective_access_resource_idx ON core.effective_access (workspace_id, resource_kind, resource_id);
CREATE INDEX effective_access_path_idx ON core.effective_access USING GIST (resource_path);

CREATE TABLE core.effective_access_state (
  workspace_id uuid PRIMARY KEY REFERENCES core.workspace (id) ON DELETE CASCADE,
  acl_version bigint NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now(),
  row_count integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0
);

CREATE TABLE core.invite_import (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  status core.invite_import_status NOT NULL DEFAULT 'queued',
  defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  defaults_schema_version integer NOT NULL DEFAULT 1,
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  rows_schema_version integer NOT NULL DEFAULT 1,
  total integer NOT NULL DEFAULT 0,
  invited integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text
);
CREATE INDEX invite_import_workspace_idx ON core.invite_import (workspace_id, created_at);

--> statement-breakpoint
-- Row-level security: the standard fence on every table above.
ALTER TABLE core.access_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.access_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.access_grant AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY access_grant_access ON core.access_grant FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE core.access_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.access_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.access_policy AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY access_policy_access ON core.access_policy FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE core.effective_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.effective_access FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.effective_access AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY effective_access_access ON core.effective_access FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE core.effective_access_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.effective_access_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.effective_access_state AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY effective_access_state_access ON core.effective_access_state FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE core.invite_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.invite_import FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.invite_import AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY invite_import_access ON core.invite_import FOR ALL USING (true) WITH CHECK (true);

--> statement-breakpoint
-- core.has_access(kind, id, path, capability): the investor-side RLS predicate for module
-- tables (§6.4 "RLS investor policies read this table"). Answers from the nearest materialised
-- node for the acting membership: the resource itself when it has a row, else the deepest
-- ancestor by ltree path. Gates are *not* evaluated here on purpose: a listing may show a
-- document that still needs an NDA ("sign to view"); the serving path calls AuthzPort.check(),
-- which does evaluate them. Staff never reach this predicate: their access is RBAC and the
-- module policy admits `core.current_actor_kind() = 'staff'` directly.
CREATE OR REPLACE FUNCTION core.has_access(
  p_kind text, p_id uuid, p_path ltree, p_capability core.access_capability
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE((
    SELECT p_capability = ANY (ea.capabilities)
    FROM core.effective_access ea
    WHERE ea.workspace_id = core.current_workspace()
      AND ea.membership_id = core.current_membership()
      AND ea.resource_kind = p_kind
      AND (
        ea.resource_id = p_id
        OR (p_path IS NOT NULL AND ea.resource_path IS NOT NULL AND ea.resource_path @> p_path)
      )
    ORDER BY (ea.resource_id = p_id) DESC, nlevel(ea.resource_path) DESC NULLS LAST
    LIMIT 1
  ), false)
$$;

-- Workspace-level access settings (MFA requirement for externals, invite expiry) live in
-- core.workspace.settings under the "access" key; no new column. The Zod schema is in
-- @seed-host/domain (workspaceSettings).

SELECT core.apply_tenant_fence();
