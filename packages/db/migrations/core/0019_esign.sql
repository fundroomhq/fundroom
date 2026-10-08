-- 0019_esign — e-signature connections and envelopes, and the legal-document ceremony choice
-- (EXECUTION_PLAN §15 E3.5, ADR-0053).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/esign.ts; the service (connection
-- sealing, envelope pipeline, sync/collect jobs, the NDA ceremony) is @seed-host/esign and the
-- vendor adapters are @seed-host/esign-<vendor> behind ESignPort. Runs inside one transaction;
-- every table declares its fence inline so nothing can read a row between CREATE TABLE and the
-- runner's core.apply_tenant_fence() pass.
--
-- Kernel, not a module: an e-sign NDA ceremony closes the NDA gate that requireMember enforces
-- before module enablement is knowable (ADR-0041/0032), and round closing and data-room vaulting
-- (two modules) both reach it through ModuleServices.esign.
--
--  * esign_connection  at most one live row per workspace. Credentials, the base URL of a
--                      self-hosted vendor and our callback secret are sealed (SHE1) under the
--                      workspace key of purpose `esign-credentials`; `encryption` holds one
--                      SealedRef per sealed column (`credentials`, `baseUrl`, `callbackSecret`).
--                      Only the host (`base_url_host`) and per-field hints are stored in clear.
--  * esign_envelope    one row per envelope we asked a vendor to create. `provider_ref` is the
--                      vendor's id, set after create. Signed records are retained under legal
--                      hold; erasure pseudonymises signer_name/signer_email and never deletes
--                      artifacts. Status is monotonic out of a terminal state (trigger below).
--  * legal_document.ceremony  'clickwrap' (the E2.3 engine) or 'esign' (a vendor envelope).
--
-- RLS: the fence plus a permissive staff/system policy on both tables. An external member may
-- SELECT their own envelopes (membership_id = theirs) and nothing on esign_connection.

--> statement-breakpoint
-- 1. Connections.
CREATE TABLE core.esign_connection (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  driver text NOT NULL,
  -- SHE1(base URL) for a self-hosted vendor; NULL = the vendor's cloud default
  base_url_enc bytea,
  -- display only: the base URL's host
  base_url_host text,
  -- SHE1(JSON of the credential values keyed by ESignCredentialField.key)
  credentials_enc bytea NOT NULL,
  -- SHE1(our callback secret) for vendors whose meta.callbackSecret = 'ours'
  callback_secret_enc bytea,
  -- { credentials: SealedRef, baseUrl?: SealedRef, callbackSecret?: SealedRef }
  encryption jsonb NOT NULL DEFAULT '{}'::jsonb,
  encryption_schema_version integer NOT NULL DEFAULT 1,
  -- display only, e.g. { "apiToken": "••••ab12" }; never a whole value
  credential_hints jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_hints_schema_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  last_verified_at timestamptz,
  -- never a credential; a short, vendor-neutral reason
  last_error text,
  created_by_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT esign_connection_driver CHECK (
    driver IN ('documenso', 'docuseal', 'docusign', 'dropbox-sign')
  ),
  CONSTRAINT esign_connection_status CHECK (status IN ('active', 'error')),
  CONSTRAINT esign_connection_base_url_shape CHECK (
    (base_url_enc IS NULL) = (base_url_host IS NULL)
  ),
  CONSTRAINT esign_connection_base_url_host_length CHECK (
    base_url_host IS NULL OR char_length(base_url_host) BETWEEN 1 AND 300
  ),
  CONSTRAINT esign_connection_last_error_length CHECK (
    last_error IS NULL OR char_length(last_error) <= 500
  ),
  CONSTRAINT esign_connection_encryption_object CHECK (jsonb_typeof(encryption) = 'object'),
  CONSTRAINT esign_connection_hints_object CHECK (jsonb_typeof(credential_hints) = 'object')
);

-- At most one live connection per workspace (a replaced or deleted one keeps its row for the
-- envelopes that reference it).
CREATE UNIQUE INDEX esign_connection_live_idx ON core.esign_connection (workspace_id)
  WHERE deleted_at IS NULL;
CREATE INDEX esign_connection_creator_idx ON core.esign_connection (created_by_membership_id)
  WHERE created_by_membership_id IS NOT NULL;

CREATE TRIGGER esign_connection_set_updated_at BEFORE UPDATE ON core.esign_connection
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.esign_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.esign_connection FORCE ROW LEVEL SECURITY;
-- The inbound vendor callback (`/webhooks/esign/{connectionId}`) arrives with no tenant: it must
-- find the connection by id before it knows the workspace. As for core.mail_message (0010), the
-- fence admits the host actor for SELECT only — the fence's WITH CHECK names the workspace alone and
-- the host's only permissive policy is FOR SELECT, so a host transaction can read, never write.
CREATE POLICY tenant_fence ON core.esign_connection AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY esign_connection_staff ON core.esign_connection FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY esign_connection_host_read ON core.esign_connection FOR SELECT
  USING (core.current_actor_kind() = 'host');

--> statement-breakpoint
-- 2. Envelopes.
CREATE TABLE core.esign_envelope (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES core.esign_connection (id),
  driver text NOT NULL,
  -- the vendor's envelope id; NULL while `draft` (before the vendor answered)
  provider_ref text,
  purpose text NOT NULL,
  -- soft reference to what this envelope is about, e.g. round/commitment/<id> or
  -- compliance/legal_document/<id>
  subject_module text NOT NULL,
  subject_kind text NOT NULL,
  subject_id uuid NOT NULL,
  -- the NDA's document and version (purpose = 'nda' only)
  legal_document_id uuid,
  legal_version_no integer,
  -- the signer's membership; NULL for a signer who is not a member
  membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  signer_name text NOT NULL,
  signer_email citext NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  signer_status text,
  embedded boolean NOT NULL DEFAULT false,
  error_code text,
  error_detail text,
  sent_at timestamptz,
  completed_at timestamptz,
  terminal_at timestamptz,
  -- when the sync sweep next pulls status(); NULL = not scheduled
  next_sync_at timestamptz,
  sync_attempts integer NOT NULL DEFAULT 0,
  -- { signed: {key, sha256, size, keyRef}, certificate?: {…} } once collected
  artifacts jsonb,
  artifacts_schema_version integer NOT NULL DEFAULT 1,
  -- data-room folder path hint for vaulting, e.g. `Signed documents/Seed round`
  vault_folder text,
  -- soft reference to dataroom.document, set on document.vaulted
  vaulted_document_id uuid,
  requested_by_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  signer_pseudonymised_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT esign_envelope_driver CHECK (
    driver IN ('documenso', 'docuseal', 'docusign', 'dropbox-sign')
  ),
  CONSTRAINT esign_envelope_purpose CHECK (purpose IN ('nda', 'round_closing')),
  CONSTRAINT esign_envelope_status CHECK (
    status IN ('draft', 'sent', 'delivered', 'completed', 'declined', 'voided', 'expired', 'error')
  ),
  CONSTRAINT esign_envelope_signer_status CHECK (
    signer_status IS NULL OR signer_status IN ('pending', 'viewed', 'signed', 'declined')
  ),
  CONSTRAINT esign_envelope_nda_shape CHECK (
    (purpose = 'nda') = (legal_document_id IS NOT NULL AND legal_version_no IS NOT NULL)
  ),
  CONSTRAINT esign_envelope_provider_ref_length CHECK (
    provider_ref IS NULL OR char_length(provider_ref) BETWEEN 1 AND 200
  ),
  CONSTRAINT esign_envelope_subject_shape CHECK (
    subject_module ~ '^[a-z][a-z0-9-]{0,63}$' AND subject_kind ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  CONSTRAINT esign_envelope_signer_name_length CHECK (char_length(signer_name) BETWEEN 1 AND 300),
  CONSTRAINT esign_envelope_signer_email_length CHECK (
    char_length(signer_email) BETWEEN 1 AND 320
  ),
  CONSTRAINT esign_envelope_title_length CHECK (char_length(title) BETWEEN 1 AND 300),
  CONSTRAINT esign_envelope_error_code_length CHECK (
    error_code IS NULL OR char_length(error_code) <= 100
  ),
  CONSTRAINT esign_envelope_error_detail_length CHECK (
    error_detail IS NULL OR char_length(error_detail) <= 500
  ),
  CONSTRAINT esign_envelope_vault_folder_length CHECK (
    vault_folder IS NULL OR char_length(vault_folder) BETWEEN 1 AND 500
  ),
  CONSTRAINT esign_envelope_sync_attempts_nonnegative CHECK (sync_attempts >= 0),
  CONSTRAINT esign_envelope_artifacts_object CHECK (
    artifacts IS NULL OR jsonb_typeof(artifacts) = 'object'
  )
);

-- One envelope per vendor id in a workspace (callback lookup; a vendor id can never name two rows).
CREATE UNIQUE INDEX esign_envelope_provider_ref_idx
  ON core.esign_envelope (workspace_id, driver, provider_ref)
  WHERE provider_ref IS NOT NULL;
-- The sync sweep and status tabs.
CREATE INDEX esign_envelope_status_sync_idx
  ON core.esign_envelope (workspace_id, status, next_sync_at);
-- A member's own envelopes (portal, erasure, DSAR).
CREATE INDEX esign_envelope_member_idx ON core.esign_envelope (workspace_id, membership_id);
-- What a module's subject has been sent for signature.
CREATE INDEX esign_envelope_subject_idx
  ON core.esign_envelope (workspace_id, subject_module, subject_kind, subject_id);
-- The admin list (keyset on created_at desc, id desc).
CREATE INDEX esign_envelope_ws_created_idx
  ON core.esign_envelope (workspace_id, created_at DESC, id DESC);
CREATE INDEX esign_envelope_connection_idx ON core.esign_envelope (connection_id);
CREATE INDEX esign_envelope_requested_by_idx ON core.esign_envelope (requested_by_membership_id)
  WHERE requested_by_membership_id IS NOT NULL;

-- A terminal envelope stays terminal, and artifacts exist only on a completed one.
CREATE FUNCTION core.esign_envelope_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('completed', 'declined', 'voided', 'expired')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'e-sign envelope % is already %', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.artifacts IS NOT NULL AND NEW.artifacts IS DISTINCT FROM OLD.artifacts
     AND NEW.status <> 'completed' THEN
    RAISE EXCEPTION 'e-sign envelope % artifacts may only be set when completed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER esign_envelope_guard BEFORE UPDATE ON core.esign_envelope
  FOR EACH ROW EXECUTE FUNCTION core.esign_envelope_guard();

CREATE TRIGGER esign_envelope_set_updated_at BEFORE UPDATE ON core.esign_envelope
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.esign_envelope ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.esign_envelope FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.esign_envelope AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY esign_envelope_staff ON core.esign_envelope FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
-- A member reads their own envelopes; they never write one (the service writes as system).
CREATE POLICY esign_envelope_external_own ON core.esign_envelope FOR SELECT
  USING (core.current_actor_kind() = 'external' AND membership_id = core.current_membership());

--> statement-breakpoint
-- 3. The legal-document ceremony (click-wrap or a vendor e-signature).
ALTER TABLE core.legal_document
  ADD COLUMN ceremony text NOT NULL DEFAULT 'clickwrap',
  ADD CONSTRAINT legal_document_ceremony CHECK (ceremony IN ('clickwrap', 'esign'));

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

SELECT core.apply_tenant_fence();
