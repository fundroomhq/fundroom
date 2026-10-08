-- 0021_accreditation — accreditation-vendor connections (EXECUTION_PLAN §15 E3.7, ADR-0055).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/accreditation.ts; the service
-- (connection sealing, the vendor calls behind ModuleServices.accreditation, the ops callback) is
-- @seed-host/accreditation and the vendor adapters are @seed-host/accred-<vendor> behind
-- AccreditationVendorPort. Runs inside one transaction; the table declares its fence inline so
-- nothing can read a row between CREATE TABLE and the runner's core.apply_tenant_fence() pass.
--
-- Kernel, not a module: like e-sign (0019), a vendor account belongs to the issuer, its credentials
-- are sealed under the workspace key and an ops callback route must find the connection before it
-- knows the tenant. The verification *record* stays in the round module (round.verification).
--
--  * accreditation_connection  at most one live row per workspace. The credentials are sealed
--                              (SHE1) under the workspace key of purpose `accreditation-credentials`;
--                              `encryption` holds one SealedRef per sealed column (`credentials`).
--                              Only per-field hints and the vendor environment are stored in clear.
--
-- RLS: the fence plus a permissive staff/system policy; the host actor may SELECT (callback lookup).
-- External members read nothing here.

--> statement-breakpoint
CREATE TABLE core.accreditation_connection (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  driver text NOT NULL,
  -- the vendor environment the credentials belong to, e.g. 'staging' / 'demo' / 'production'
  environment text NOT NULL,
  -- SHE1(JSON of the credential values keyed by AccreditationCredentialField.key)
  credentials_enc bytea NOT NULL,
  -- { credentials: SealedRef }
  encryption jsonb NOT NULL,
  encryption_schema_version integer NOT NULL DEFAULT 1,
  -- display only, e.g. { "apiToken": "••••ab12" }; never a whole value
  credential_hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_hints_schema_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  last_verified_at timestamptz,
  -- never a credential; a short, vendor-neutral reason
  last_error text,
  -- the last authentic vendor callback
  last_callback_at timestamptz,
  created_by_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT accreditation_connection_driver CHECK (
    driver IN ('verifyinvestor', 'parallel-markets')
  ),
  CONSTRAINT accreditation_connection_environment_length CHECK (
    char_length(environment) BETWEEN 1 AND 50
  ),
  CONSTRAINT accreditation_connection_status CHECK (status IN ('active', 'error')),
  CONSTRAINT accreditation_connection_last_error_length CHECK (
    last_error IS NULL OR char_length(last_error) <= 500
  ),
  CONSTRAINT accreditation_connection_encryption_object CHECK (
    jsonb_typeof(encryption) = 'object'
  ),
  CONSTRAINT accreditation_connection_hints_object CHECK (
    jsonb_typeof(credential_hints) = 'object'
  )
);

-- At most one live connection per workspace (a replaced or deleted one keeps its row).
CREATE UNIQUE INDEX accreditation_connection_live_idx ON core.accreditation_connection (workspace_id)
  WHERE deleted_at IS NULL;
CREATE INDEX accreditation_connection_creator_idx
  ON core.accreditation_connection (created_by_membership_id)
  WHERE created_by_membership_id IS NOT NULL;

CREATE TRIGGER accreditation_connection_set_updated_at BEFORE UPDATE
  ON core.accreditation_connection
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.accreditation_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.accreditation_connection FORCE ROW LEVEL SECURITY;
-- The inbound vendor callback (`/webhooks/accreditation/{connectionId}`) arrives with no tenant: it
-- must find the connection by id before it knows the workspace. As for core.esign_connection (0019),
-- the fence admits the host actor for SELECT only — the fence's WITH CHECK names the workspace alone
-- and the host's only permissive policy is FOR SELECT, so a host transaction can read, never write.
CREATE POLICY tenant_fence ON core.accreditation_connection AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY accreditation_connection_staff ON core.accreditation_connection FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY accreditation_connection_host_read ON core.accreditation_connection FOR SELECT
  USING (core.current_actor_kind() = 'host');

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

SELECT core.apply_tenant_fence();
