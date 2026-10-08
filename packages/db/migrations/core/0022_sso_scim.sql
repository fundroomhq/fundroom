-- 0022_sso_scim — per-workspace staff SSO (OIDC + SAML) and SCIM 2.0 provisioning
-- (EXECUTION_PLAN §15 E3.8, ADR-0056).
--
-- Hand-written (ADR-0004). The TypeScript views are src/schema/sso.ts (the new tables),
-- src/schema/core.ts (workspace.sso_enforced) and src/schema/identity.ts (session.sso_*). The
-- services are @seed-host/sso (connections, domains, the login flow) and @seed-host/scim (tokens,
-- the SCIM protocol, group → role mapping). Runs inside one transaction; every table declares its
-- fence inline so nothing can read a row between CREATE TABLE and the runner's
-- core.apply_tenant_fence() pass.
--
-- Kernel, not a module: enforcement is read on every staff request during tenant resolution, and
-- the login flow runs before module enablement is knowable.
--
--  * auth_challenge_kind  + 'saml' (a pending AuthnRequest bound to one browser) and
--                         + 'sso_handoff' (the canonical host's verified facts, handed to the
--                         workspace origin; single use, two minutes). Added last and not used
--                         anywhere in this file: Postgres allows ADD VALUE inside a transaction but
--                         a new label cannot be used until it commits (see 0009).
--  * workspace            sso_enforced — the connection's `enforce = 'staff'` mirrored onto the row
--                         the tenant resolver already reads, so enforcement costs no query.
--  * session              sso_workspace_id + sso_connection_id — an SSO session is bound to the
--                         workspace whose IdP asserted it and is ignored everywhere else.
--  * sso_connection       at most one live row per workspace, protocol oidc | saml. The OIDC client
--                         secret is sealed (SHE1) under the workspace key of purpose
--                         `sso-credentials`; `encryption` holds one SealedRef per sealed column.
--  * sso_domain           DNS-TXT-proven email domains; a verified domain belongs to one workspace.
--  * sso_assertion_replay SAML assertion ids already consumed, per connection, until they expire.
--  * scim_token           per-workspace SCIM bearer tokens (sha256 stored; its own principal, not an
--                         API key; the creator is kept only as a reference).
--  * scim_user / scim_group / scim_group_member
--                         the IdP's per-workspace provisioning projection. SCIM never writes global
--                         user fields; the membership is the only thing it changes outside these.
--
-- RLS: the fence plus a permissive staff/system policy on every table. The host actor may SELECT
-- sso_connection, sso_domain and scim_token (the ops routes find a connection or a token before
-- they know the workspace; domain exclusivity is checked across workspaces), and may INSERT/SELECT
-- sso_assertion_replay (the SAML ACS). External members read nothing here.

--> statement-breakpoint
-- 1. Enforcement mirror on the workspace row.
ALTER TABLE core.workspace ADD COLUMN sso_enforced boolean NOT NULL DEFAULT false;
-- The live ENABLED connection's id and version, mirrored in the same transaction as every
-- connection write (NULL when none is enabled). Session resolution ignores a bound session whose
-- connection id or version differs, so a disable, delete or security-relevant save takes effect on
-- the next request whether or not the post-commit revoke succeeds. No FK: the connection table
-- references the workspace, and the service nulls the mirror on delete.
ALTER TABLE core.workspace
  ADD COLUMN sso_connection_id uuid,
  ADD COLUMN sso_connection_version integer;
ALTER TABLE core.workspace ADD CONSTRAINT workspace_sso_connection_shape CHECK (
  num_nulls(sso_connection_id, sso_connection_version) IN (0, 2)
) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_sso_connection_shape;

--> statement-breakpoint
-- 2. Connections.
CREATE TABLE core.sso_connection (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  protocol text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  enforce text NOT NULL DEFAULT 'off',
  -- bumped on every save; the discovery / metadata caches are keyed by (id, version)
  version integer NOT NULL DEFAULT 1,
  oidc_issuer text,
  oidc_client_id text,
  -- SHE1(JSON { clientSecret }) under the `sso-credentials` workspace key; OIDC only
  credentials_enc bytea,
  -- { credentials: SealedRef }
  encryption jsonb,
  encryption_schema_version integer NOT NULL DEFAULT 1,
  saml_idp_entity_id text,
  -- the IdP's HTTP-Redirect SingleSignOnService location
  saml_idp_sso_url text,
  -- PEM signing certificates (several during a rollover)
  saml_idp_certs text[],
  -- { trustMfa: boolean, mfaValues: string[] }
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  options_schema_version integer NOT NULL DEFAULT 1,
  jit_enabled boolean NOT NULL DEFAULT false,
  jit_role core.membership_role NOT NULL DEFAULT 'viewer',
  status text NOT NULL DEFAULT 'active',
  -- never a secret or an IdP claim; a short reason
  last_error text,
  last_verified_at timestamptz,
  last_tested_at timestamptz,
  last_login_at timestamptz,
  created_by_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT sso_connection_protocol CHECK (protocol IN ('oidc', 'saml')),
  CONSTRAINT sso_connection_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT sso_connection_enforce CHECK (enforce IN ('off', 'staff')),
  CONSTRAINT sso_connection_version_positive CHECK (version >= 1),
  CONSTRAINT sso_connection_jit_role CHECK (jit_role IN ('editor', 'viewer', 'finance', 'legal')),
  CONSTRAINT sso_connection_status CHECK (status IN ('active', 'error')),
  CONSTRAINT sso_connection_last_error_length CHECK (
    last_error IS NULL OR char_length(last_error) <= 500
  ),
  CONSTRAINT sso_connection_options_object CHECK (jsonb_typeof(options) = 'object'),
  CONSTRAINT sso_connection_sealed_shape CHECK (
    (credentials_enc IS NULL) = (encryption IS NULL)
    AND (encryption IS NULL OR jsonb_typeof(encryption) = 'object')
  ),
  CONSTRAINT sso_connection_protocol_shape CHECK (
    (protocol = 'oidc' AND oidc_issuer IS NOT NULL AND oidc_client_id IS NOT NULL)
    OR (
      protocol = 'saml'
      AND saml_idp_entity_id IS NOT NULL
      AND saml_idp_sso_url IS NOT NULL
      AND saml_idp_certs IS NOT NULL
      AND cardinality(saml_idp_certs) >= 1
    )
  )
);

-- At most one live connection per workspace (a replaced or deleted one keeps its row).
CREATE UNIQUE INDEX sso_connection_live_idx ON core.sso_connection (workspace_id)
  WHERE deleted_at IS NULL;
CREATE INDEX sso_connection_creator_idx ON core.sso_connection (created_by_membership_id)
  WHERE created_by_membership_id IS NOT NULL;

CREATE TRIGGER sso_connection_set_updated_at BEFORE UPDATE ON core.sso_connection
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.sso_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sso_connection FORCE ROW LEVEL SECURITY;
-- The IdP returns to `/sso/{oidc,saml}/{connectionId}/…` on the canonical host with no tenant: the
-- ops route must find the connection by id before it knows the workspace. As for
-- core.accreditation_connection (0021), the host may SELECT only — the fence's WITH CHECK names the
-- workspace alone and the host's only permissive policy is FOR SELECT.
CREATE POLICY tenant_fence ON core.sso_connection AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY sso_connection_staff ON core.sso_connection FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY sso_connection_host_read ON core.sso_connection FOR SELECT
  USING (core.current_actor_kind() = 'host');

--> statement-breakpoint
-- 3. Session binding: both or neither. A bound session is honoured only in its own workspace.
ALTER TABLE core.session
  ADD COLUMN sso_workspace_id uuid REFERENCES core.workspace (id) ON DELETE CASCADE,
  ADD COLUMN sso_connection_id uuid REFERENCES core.sso_connection (id) ON DELETE CASCADE;
ALTER TABLE core.session ADD CONSTRAINT session_sso_shape CHECK (
  num_nulls(sso_workspace_id, sso_connection_id) IN (0, 2)
) NOT VALID;
ALTER TABLE core.session VALIDATE CONSTRAINT session_sso_shape;
-- The connection version the session was minted under (compared with the workspace mirror).
ALTER TABLE core.session ADD COLUMN sso_connection_version integer;
ALTER TABLE core.session ADD CONSTRAINT session_sso_version_shape CHECK (
  sso_connection_version IS NULL OR sso_connection_id IS NOT NULL
) NOT VALID;
ALTER TABLE core.session VALIDATE CONSTRAINT session_sso_version_shape;
-- Deleting a connection revokes the sessions it minted.
CREATE INDEX session_sso_connection_idx ON core.session (sso_connection_id)
  WHERE sso_connection_id IS NOT NULL;

--> statement-breakpoint
-- 4. Verified email domains (JIT and account linking only ever trust these).
CREATE TABLE core.sso_domain (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  domain citext NOT NULL,
  -- the TXT value's random part (`seedhost-sso=<token>` at `_seedhost-sso.<domain>`)
  token text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sso_domain_format CHECK (
    char_length(domain) <= 253
    AND domain::text = lower(domain::text)
    AND domain ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  CONSTRAINT sso_domain_token_length CHECK (char_length(token) BETWEEN 16 AND 128),
  CONSTRAINT sso_domain_status CHECK (status IN ('pending', 'verified')),
  CONSTRAINT sso_domain_verified_shape CHECK (status <> 'verified' OR verified_at IS NOT NULL),
  CONSTRAINT sso_domain_last_error_length CHECK (
    last_error IS NULL OR char_length(last_error) <= 500
  )
);

CREATE UNIQUE INDEX sso_domain_workspace_domain_idx ON core.sso_domain (workspace_id, domain);
-- A verified domain belongs to exactly one workspace on this install; pending claims are not
-- exclusive (ADR-0039: a squatter's pending row must not block the real owner).
CREATE UNIQUE INDEX sso_domain_verified_idx ON core.sso_domain (domain)
  WHERE status = 'verified';

ALTER TABLE core.sso_domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sso_domain FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.sso_domain AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY sso_domain_staff ON core.sso_domain FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY sso_domain_host_read ON core.sso_domain FOR SELECT
  USING (core.current_actor_kind() = 'host');

--> statement-breakpoint
-- 5. SAML assertion replay cache (backs the single-use InResponseTo; swept after expires_at).
CREATE TABLE core.sso_assertion_replay (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES core.sso_connection (id) ON DELETE CASCADE,
  assertion_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, assertion_id),
  CONSTRAINT sso_assertion_replay_id_length CHECK (char_length(assertion_id) BETWEEN 1 AND 512)
);

CREATE INDEX sso_assertion_replay_expires_idx ON core.sso_assertion_replay (expires_at);

ALTER TABLE core.sso_assertion_replay ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sso_assertion_replay FORCE ROW LEVEL SECURITY;
-- The ACS runs on the canonical host before a tenant context exists, so the host may insert and
-- read here (like core.auth_challenge); a tenant context still sees only its own workspace's rows.
CREATE POLICY tenant_fence ON core.sso_assertion_replay AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host');
CREATE POLICY sso_assertion_replay_access ON core.sso_assertion_replay FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system', 'host'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system', 'host'));

--> statement-breakpoint
-- 6. SCIM bearer tokens.
CREATE TABLE core.scim_token (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- sha256 of the whole `shs_…` token
  token_hash bytea NOT NULL,
  -- the first characters of the token, for recognising it in the admin list
  display_prefix text NOT NULL,
  name text NOT NULL,
  created_by_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT scim_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT scim_token_prefix_length CHECK (char_length(display_prefix) BETWEEN 4 AND 32),
  CONSTRAINT scim_token_name_length CHECK (char_length(name) BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX scim_token_hash_idx ON core.scim_token (token_hash);
CREATE INDEX scim_token_live_idx ON core.scim_token (workspace_id) WHERE revoked_at IS NULL;
CREATE INDEX scim_token_creator_idx ON core.scim_token (created_by_membership_id)
  WHERE created_by_membership_id IS NOT NULL;

ALTER TABLE core.scim_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.scim_token FORCE ROW LEVEL SECURITY;
-- `/scim/v2/*` authenticates the bearer by hash before it knows the workspace: host SELECT only.
CREATE POLICY tenant_fence ON core.scim_token AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY scim_token_staff ON core.scim_token FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY scim_token_host_read ON core.scim_token FOR SELECT
  USING (core.current_actor_kind() = 'host');

--> statement-breakpoint
-- 7. SCIM users: the IdP's per-workspace view of a person. `id` is the SCIM id.
CREATE TABLE core.scim_user (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  user_id uuid REFERENCES core."user" (id) ON DELETE SET NULL,
  external_id text,
  user_name citext NOT NULL,
  email citext,
  display_name text,
  given_name text,
  family_name text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT scim_user_user_name_length CHECK (char_length(user_name) BETWEEN 1 AND 320),
  CONSTRAINT scim_user_email_length CHECK (email IS NULL OR char_length(email) <= 320),
  CONSTRAINT scim_user_external_id_length CHECK (
    external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 512
  ),
  CONSTRAINT scim_user_names_length CHECK (
    (display_name IS NULL OR char_length(display_name) <= 256)
    AND (given_name IS NULL OR char_length(given_name) <= 256)
    AND (family_name IS NULL OR char_length(family_name) <= 256)
  )
);

CREATE UNIQUE INDEX scim_user_user_name_idx ON core.scim_user (workspace_id, user_name)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX scim_user_external_id_idx ON core.scim_user (workspace_id, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX scim_user_membership_idx ON core.scim_user (membership_id)
  WHERE deleted_at IS NULL;
CREATE INDEX scim_user_user_idx ON core.scim_user (user_id) WHERE user_id IS NOT NULL;

CREATE TRIGGER scim_user_set_updated_at BEFORE UPDATE ON core.scim_user
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.scim_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.scim_user FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.scim_user AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY scim_user_staff ON core.scim_user FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
-- 8. SCIM groups (mapped to a staff role in our UI; never `owner`).
CREATE TABLE core.scim_group (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  display_name text NOT NULL,
  external_id text,
  role core.membership_role,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT scim_group_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 256),
  CONSTRAINT scim_group_external_id_length CHECK (
    external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 512
  ),
  CONSTRAINT scim_group_role CHECK (
    role IS NULL OR role IN ('admin', 'editor', 'viewer', 'finance', 'legal')
  )
);

CREATE UNIQUE INDEX scim_group_display_name_idx ON core.scim_group (workspace_id, lower(display_name))
  WHERE deleted_at IS NULL;

CREATE TRIGGER scim_group_set_updated_at BEFORE UPDATE ON core.scim_group
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.scim_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.scim_group FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.scim_group AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY scim_group_staff ON core.scim_group FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
-- 9. SCIM group membership.
CREATE TABLE core.scim_group_member (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES core.scim_group (id) ON DELETE CASCADE,
  scim_user_id uuid NOT NULL REFERENCES core.scim_user (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, scim_user_id)
);

CREATE INDEX scim_group_member_user_idx ON core.scim_group_member (scim_user_id);

ALTER TABLE core.scim_group_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.scim_group_member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.scim_group_member AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY scim_group_member_staff ON core.scim_group_member FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
-- 10. Challenge kinds for the SAML request and the canonical-host → workspace-origin handoff.
-- Last, and unused in this file (a new enum label cannot be used before the transaction commits).
ALTER TYPE core.auth_challenge_kind ADD VALUE IF NOT EXISTS 'saml';
ALTER TYPE core.auth_challenge_kind ADD VALUE IF NOT EXISTS 'sso_handoff';

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

SELECT core.apply_tenant_fence();
