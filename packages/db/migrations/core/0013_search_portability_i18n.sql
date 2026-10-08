-- 0013_search_portability_i18n — workspace search, workspace export/import, per-user and
-- per-workspace locale, and the accessibility statement (EXECUTION_PLAN §15 E2.8 "Search,
-- export, a11y, i18n").
--
-- Hand-written (ADR-0004). The TypeScript views are src/schema/search.ts,
-- src/schema/portability.ts, src/schema/identity.ts (user.locale), src/schema/core.ts
-- (workspace.default_locale) and src/schema/compliance.ts (legal_document_kind). Runs inside one
-- transaction; new tables declare their fences inline so nothing can read a row between
-- CREATE TABLE and the runner's core.apply_tenant_fence() pass.
--
--  * search_entry      one row per searchable (module, kind, ref, part) of a workspace: title +
--                      plain-text body, a generated tsvector, the SPA path a hit opens and the
--                      ACL the row is readable under. Written by modules through
--                      `services.search`; rebuilt wholesale by the `search.reindex` job.
--  * search_state      which provider version a workspace's entries were built with, and whether
--                      a rebuild was asked for (the `search.sweep` cron's work list).
--  * workspace_export  one row per requested export: status machine, the encrypted zip's object
--                      key, its checksum, and the 7-day expiry.
--  * workspace_import  one row per imported workspace: where it came from (source workspace,
--                      manifest checksum, signature status) and the archived source audit trail.
--  * user.locale / workspace.default_locale — UI and email language.
--  * legal_document_kind gains `accessibility_statement`.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

--> statement-breakpoint
-- 1. Search (E2.8 package S). `ref_id` has no foreign key: it names a row in whichever module
-- schema owns the kind. The body is capped by the engine (200 000 characters) and here.
--
-- acl_kind:
--  * members   any live member of the workspace
--  * groups    members of any of `acl_groups` (live group membership in a live group)
--  * staff     staff only
--  * resource  readable where core.has_access(kind, id, path, 'view') is; the query path also
--              runs authz.check so a gated resource shows its title only.
CREATE TABLE core.search_entry (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  module text NOT NULL,
  kind text NOT NULL,
  ref_id uuid NOT NULL,
  part text NOT NULL DEFAULT '',
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  href text NOT NULL,
  acl_kind text NOT NULL,
  acl_groups uuid[],
  acl_resource_kind text,
  acl_resource_id uuid,
  acl_path ltree,
  tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig, title), 'A')
    || setweight(to_tsvector('simple'::regconfig, body), 'C')
  ) STORED,
  source_updated_at timestamptz NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_entry_acl_kind CHECK (acl_kind IN ('members', 'groups', 'staff', 'resource')),
  CONSTRAINT search_entry_acl_shape CHECK (
    (acl_kind = 'groups') = (acl_groups IS NOT NULL)
    AND (acl_kind = 'resource') = (acl_resource_kind IS NOT NULL AND acl_resource_id IS NOT NULL)
    AND (acl_path IS NULL OR acl_kind = 'resource')
  ),
  CONSTRAINT search_entry_href_shape CHECK (href ~ '^/'),
  CONSTRAINT search_entry_body_length CHECK (char_length(body) <= 200000)
);
CREATE UNIQUE INDEX search_entry_ref_idx ON core.search_entry (workspace_id, module, kind, ref_id, part);
CREATE INDEX search_entry_tsv_idx ON core.search_entry USING gin (tsv);
CREATE INDEX search_entry_title_trgm_idx ON core.search_entry USING gin (title gin_trgm_ops);

CREATE TABLE core.search_state (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  module text NOT NULL,
  version integer NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  requested_at timestamptz,
  PRIMARY KEY (workspace_id, module)
);

-- Staff and the system (the indexer, the reindex job) read and write everything. An external
-- member may only read, and only the rows their ACL admits. Group membership is live when
-- neither the group nor the member's place in it has been removed.
ALTER TABLE core.search_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.search_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.search_entry AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY search_entry_staff ON core.search_entry FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY search_entry_external_read ON core.search_entry FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND (
      acl_kind = 'members'
      OR (
        acl_kind = 'groups'
        AND EXISTS (
          SELECT 1 FROM core.group_member gm
          JOIN core."group" g ON g.id = gm.group_id
          WHERE gm.membership_id = core.current_membership()
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

ALTER TABLE core.search_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.search_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.search_state AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY search_state_staff ON core.search_state FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
-- 2. Workspace export (E2.8 package P). `requested_by` is the requesting membership (no foreign
-- key, like the audit log's actor ids; NULL for an operator export from the CLI). The zip is
-- stored SHE1-encrypted under `storage_key`; `sha256` is over the zip plaintext and
-- `manifest_sha256` over its manifest.json. At most one export per workspace is queued or
-- running (the 409 `export_running` answer is keyed on the index name).
CREATE TABLE core.workspace_export (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  requested_by uuid,
  status text NOT NULL DEFAULT 'queued',
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  options_schema_version integer NOT NULL DEFAULT 1,
  storage_key text,
  encryption jsonb,
  encryption_schema_version integer NOT NULL DEFAULT 1,
  size_bytes bigint,
  sha256 bytea,
  manifest_sha256 bytea,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  downloaded_at timestamptz,
  CONSTRAINT workspace_export_status CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  CONSTRAINT workspace_export_size CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT workspace_export_sha256_shape CHECK (
    (sha256 IS NULL OR octet_length(sha256) = 32)
    AND (manifest_sha256 IS NULL OR octet_length(manifest_sha256) = 32)
  ),
  CONSTRAINT workspace_export_error_length CHECK (error IS NULL OR char_length(error) <= 2000)
);
CREATE INDEX workspace_export_ws_idx ON core.workspace_export (workspace_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX workspace_export_active_idx ON core.workspace_export (workspace_id)
  WHERE status IN ('queued', 'running');
-- The hourly expiry cron's scan.
CREATE INDEX workspace_export_expiry_idx ON core.workspace_export (expires_at)
  WHERE status = 'ready';

-- `workspace_id` is the NEW workspace. `imported_by` is the operator label the CLI records.
CREATE TABLE core.workspace_import (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  source jsonb NOT NULL,
  source_schema_version integer NOT NULL DEFAULT 1,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  counts_schema_version integer NOT NULL DEFAULT 1,
  audit_archive_key text,
  audit_archive_encryption jsonb,
  audit_archive_encryption_schema_version integer NOT NULL DEFAULT 1,
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by text NOT NULL
);
CREATE INDEX workspace_import_ws_idx ON core.workspace_import (workspace_id);

-- Staff and the system only. An external member matches no permissive policy.
ALTER TABLE core.workspace_export ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.workspace_export FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.workspace_export AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY workspace_export_staff ON core.workspace_export FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE core.workspace_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.workspace_import FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.workspace_import AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY workspace_import_staff ON core.workspace_import FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
-- 3. Locale (E2.8 package I). The user is global (ADR-0011), so their language is too; NULL
-- means "follow the workspace / the browser". The workspace default is a column, not a key in
-- `settings` (updateWorkspaceSettings replaces the whole jsonb and would race). BCP 47-ish shape.
ALTER TABLE core."user" ADD COLUMN locale text;
ALTER TABLE core."user" ADD CONSTRAINT user_locale_shape CHECK (
  locale IS NULL OR locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
) NOT VALID;
ALTER TABLE core."user" VALIDATE CONSTRAINT user_locale_shape;

ALTER TABLE core.workspace ADD COLUMN default_locale text NOT NULL DEFAULT 'en';
ALTER TABLE core.workspace ADD CONSTRAINT workspace_default_locale_shape CHECK (
  default_locale ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'
) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_default_locale_shape;

--> statement-breakpoint
-- 4. Accessibility statement (E2.8 package WS). Postgres 12+ allows ADD VALUE inside the
-- migration's transaction; the new value is not *used* here (it could not be until commit).
ALTER TYPE core.legal_document_kind ADD VALUE IF NOT EXISTS 'accessibility_statement';

SELECT core.apply_tenant_fence();
