-- 0003_workspace_key — per-workspace data-encryption keys for envelope encryption
-- (EXECUTION_PLAN §10, ADR-0016, design/02 §4, design/06 §4, E0.5).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/crypto.ts. Runs inside one
-- transaction. The runner calls core.apply_tenant_fence() afterwards; the standard fence is
-- also declared here so the table is fenced before anything can read it.
--
-- One active row per (workspace, purpose). `wrapped_dek` is the 32-byte DEK wrapped by the
-- KMS adapter named in `kms_key_ref` (`local:v2`, `aws:arn:…`); plaintext keys never reach
-- the database. Rotation retires a row and links the successor through `rotated_from_id`;
-- every blob records the id of the key it was written under, so retired keys keep
-- decrypting. Rows are never deleted by the application role: keys are retired, and
-- crypto-shredding a workspace is deleting the workspace (ON DELETE CASCADE).

CREATE TABLE core.workspace_key (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  purpose text NOT NULL DEFAULT 'workspace-dek',
  kms_key_ref text NOT NULL,
  wrapped_dek bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  rotated_from_id uuid REFERENCES core.workspace_key (id),
  CONSTRAINT workspace_key_purpose_format CHECK (purpose ~ '^[a-z][a-z0-9-]*$')
);
CREATE UNIQUE INDEX workspace_key_active_idx ON core.workspace_key (workspace_id, purpose)
  WHERE retired_at IS NULL;
CREATE INDEX workspace_key_workspace_idx ON core.workspace_key (workspace_id, purpose, created_at);

--> statement-breakpoint
-- Keys are retired (UPDATE retired_at), never removed. The default privileges of the core
-- schema grant DELETE; take it back for this table.
REVOKE DELETE ON core.workspace_key FROM seedhost_app;

ALTER TABLE core.workspace_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.workspace_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.workspace_key AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY workspace_key_access ON core.workspace_key FOR ALL USING (true) WITH CHECK (true);
