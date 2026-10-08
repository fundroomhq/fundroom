-- 0001_identity — identity, credentials, sessions, devices, login challenges, rate limits,
-- memberships, groups, invites, attestations (EXECUTION_PLAN §6.1, ADR-0011/0012/0013, E0.3).
--
-- Hand-written (ADR-0004). The TypeScript view of these tables is src/schema/identity.ts.
-- Runs inside one transaction. The runner calls core.apply_tenant_fence() afterwards, which
-- fences every workspace_id table below except auth_challenge, whose custom fence is here.

CREATE TYPE core.identity_type AS ENUM ('email', 'oidc', 'saml', 'host');
CREATE TYPE core.credential_kind AS ENUM ('passkey', 'totp', 'password', 'recovery_codes');
CREATE TYPE core.session_context AS ENUM ('first_party', 'partitioned', 'bearer');
CREATE TYPE core.auth_population AS ENUM ('external', 'staff', 'operator');
CREATE TYPE core.auth_challenge_kind AS ENUM ('email_otp', 'magic_link', 'webauthn_register', 'webauthn_login', 'oidc');
CREATE TYPE core.membership_kind AS ENUM ('staff', 'external');
CREATE TYPE core.membership_role AS ENUM ('owner', 'admin', 'editor', 'viewer', 'finance', 'legal', 'investor', 'delegate');
CREATE TYPE core.membership_status AS ENUM ('invited', 'active', 'dormant', 'suspended', 'revoked');
CREATE TYPE core.invite_status AS ENUM ('pending', 'accepted', 'expired', 'revoked');

--> statement-breakpoint
-- Global tables: no workspace_id. Emails live in user_identity (ADR-0011).
CREATE TABLE core."user" (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  display_name text NOT NULL DEFAULT '',
  avatar_url text,
  session_version integer NOT NULL DEFAULT 1,
  mfa_enrolled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TRIGGER user_set_updated_at BEFORE UPDATE ON core."user"
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE core.user_identity (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  user_id uuid NOT NULL REFERENCES core."user" (id) ON DELETE CASCADE,
  type core.identity_type NOT NULL,
  identifier citext NOT NULL,
  verified_at timestamptz,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_identity_type_identifier_idx ON core.user_identity (type, identifier);
CREATE UNIQUE INDEX user_identity_primary_idx ON core.user_identity (user_id) WHERE is_primary;
CREATE INDEX user_identity_user_idx ON core.user_identity (user_id);

CREATE TABLE core.credential (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  user_id uuid NOT NULL REFERENCES core."user" (id) ON DELETE CASCADE,
  kind core.credential_kind NOT NULL,
  label text NOT NULL DEFAULT '',
  external_id text,
  public_key bytea,
  sign_count bigint,
  transports text[],
  backup_eligible boolean,
  backed_up boolean,
  aaguid text,
  secret text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_schema_version integer NOT NULL DEFAULT 1,
  confirmed_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT credential_kind_shape CHECK (
    (kind <> 'passkey' OR (external_id IS NOT NULL AND public_key IS NOT NULL AND sign_count IS NOT NULL))
    AND (kind NOT IN ('totp', 'password') OR secret IS NOT NULL)
  )
);
CREATE UNIQUE INDEX credential_external_id_idx ON core.credential (kind, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX credential_user_kind_idx ON core.credential (user_id, kind) WHERE revoked_at IS NULL;

CREATE TABLE core.device (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  user_id uuid NOT NULL REFERENCES core."user" (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL,
  name text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  trusted_until timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX device_token_hash_idx ON core.device (token_hash);
CREATE INDEX device_user_idx ON core.device (user_id) WHERE revoked_at IS NULL;

CREATE TABLE core.session (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  token_hash bytea NOT NULL,
  user_id uuid NOT NULL REFERENCES core."user" (id) ON DELETE CASCADE,
  device_id uuid REFERENCES core.device (id) ON DELETE SET NULL,
  population core.auth_population NOT NULL,
  context core.session_context NOT NULL,
  auth_level smallint NOT NULL,
  auth_time timestamptz NOT NULL,
  session_version integer NOT NULL,
  top_site text,
  ip inet,
  user_agent text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  last_workspace_id uuid REFERENCES core.workspace (id) ON DELETE SET NULL,
  revoke_token_hash bytea,
  CONSTRAINT session_auth_level_range CHECK (auth_level BETWEEN 0 AND 2)
);
CREATE UNIQUE INDEX session_token_hash_idx ON core.session (token_hash);
CREATE INDEX session_user_active_idx ON core.session (user_id, last_seen_at) WHERE revoked_at IS NULL;
CREATE INDEX session_absolute_expires_idx ON core.session (absolute_expires_at);

CREATE TABLE core.rate_limit (
  key text NOT NULL,
  bucket bigint NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, bucket)
);

--> statement-breakpoint
-- Tenant tables.
CREATE TABLE core.auth_challenge (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  kind core.auth_challenge_kind NOT NULL,
  workspace_id uuid REFERENCES core.workspace (id) ON DELETE CASCADE,
  email citext,
  user_id uuid REFERENCES core."user" (id) ON DELETE CASCADE,
  secret_hash bytea NOT NULL,
  binding_hash bytea,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_schema_version integer NOT NULL DEFAULT 1,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE UNIQUE INDEX auth_challenge_secret_hash_idx ON core.auth_challenge (kind, secret_hash);
CREATE INDEX auth_challenge_email_idx ON core.auth_challenge (kind, email, created_at) WHERE consumed_at IS NULL;
CREATE INDEX auth_challenge_expires_idx ON core.auth_challenge (expires_at);

CREATE TABLE core.membership (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES core."user" (id) ON DELETE RESTRICT,
  kind core.membership_kind NOT NULL,
  role core.membership_role NOT NULL,
  status core.membership_status NOT NULL DEFAULT 'invited',
  source text NOT NULL,
  principal_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  profile_schema_version integer NOT NULL DEFAULT 1,
  relationship_established_at timestamptz,
  relationship_source text,
  expires_at timestamptz,
  reverify_due_at timestamptz,
  last_seen_at timestamptz,
  activated_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT membership_kind_role CHECK (
    (kind = 'staff' AND role IN ('owner', 'admin', 'editor', 'viewer', 'finance', 'legal'))
    OR (kind = 'external' AND role IN ('investor', 'delegate'))
  ),
  CONSTRAINT membership_delegate_principal CHECK ((role = 'delegate') = (principal_membership_id IS NOT NULL))
);
CREATE UNIQUE INDEX membership_active_user_idx ON core.membership (workspace_id, user_id) WHERE status <> 'revoked';
CREATE INDEX membership_workspace_status_idx ON core.membership (workspace_id, status, kind);
CREATE INDEX membership_user_idx ON core.membership (user_id);
CREATE TRIGGER membership_set_updated_at BEFORE UPDATE ON core.membership
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE core."group" (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'custom',
  default_policies jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_policies_schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX group_workspace_name_idx ON core."group" (workspace_id, name) WHERE deleted_at IS NULL;
CREATE TRIGGER group_set_updated_at BEFORE UPDATE ON core."group"
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE core.group_member (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES core."group" (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  added_by uuid,
  added_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (group_id, membership_id)
);
CREATE INDEX group_member_workspace_membership_idx ON core.group_member (workspace_id, membership_id);

CREATE TABLE core.invite (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  email citext NOT NULL,
  token_hash bytea NOT NULL,
  kind core.membership_kind NOT NULL,
  role core.membership_role NOT NULL,
  group_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  grants_schema_version integer NOT NULL DEFAULT 1,
  message text,
  status core.invite_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  invited_by uuid,
  accepted_membership_id uuid,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_kind_role CHECK (
    (kind = 'staff' AND role IN ('owner', 'admin', 'editor', 'viewer', 'finance', 'legal'))
    OR (kind = 'external' AND role IN ('investor', 'delegate'))
  )
);
CREATE UNIQUE INDEX invite_token_hash_idx ON core.invite (token_hash);
CREATE INDEX invite_workspace_email_idx ON core.invite (workspace_id, email) WHERE status = 'pending';

CREATE TABLE core.attestation (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  kind text NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  evidence_ref text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_schema_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attestation_membership_kind_idx ON core.attestation (workspace_id, membership_id, kind) WHERE revoked_at IS NULL;

--> statement-breakpoint
-- Row-level security.
--
-- Global tables get a RESTRICTIVE `global_fence` (plus the permissive `<table>_access` that RLS
-- needs to have something to AND with). The host context (login, session lookup, setup) sees
-- everything; a tenant context sees the acting user's own rows, and for user/user_identity
-- also the people who hold a membership in the current workspace (People screens). No policy
-- lets a tenant context see which *other* workspaces a user belongs to (§6.1).
CREATE OR REPLACE FUNCTION core.is_workspace_member(p_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.membership m
    WHERE m.user_id = p_user_id AND m.workspace_id = core.current_workspace()
  )
$$;

ALTER TABLE core."user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE core."user" FORCE ROW LEVEL SECURITY;
CREATE POLICY global_fence ON core."user" AS RESTRICTIVE FOR ALL
  USING (core.current_actor_kind() = 'host' OR id = core.current_user_id() OR core.is_workspace_member(id))
  WITH CHECK (core.current_actor_kind() = 'host' OR id = core.current_user_id());
CREATE POLICY user_access ON core."user" FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE core.user_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.user_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY global_fence ON core.user_identity AS RESTRICTIVE FOR ALL
  USING (core.current_actor_kind() = 'host' OR user_id = core.current_user_id() OR core.is_workspace_member(user_id))
  WITH CHECK (core.current_actor_kind() = 'host' OR user_id = core.current_user_id());
CREATE POLICY user_identity_access ON core.user_identity FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE core.credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.credential FORCE ROW LEVEL SECURITY;
CREATE POLICY global_fence ON core.credential AS RESTRICTIVE FOR ALL
  USING (core.current_actor_kind() = 'host' OR user_id = core.current_user_id())
  WITH CHECK (core.current_actor_kind() = 'host' OR user_id = core.current_user_id());
CREATE POLICY credential_access ON core.credential FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE core.device ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.device FORCE ROW LEVEL SECURITY;
CREATE POLICY global_fence ON core.device AS RESTRICTIVE FOR ALL
  USING (core.current_actor_kind() = 'host' OR user_id = core.current_user_id())
  WITH CHECK (core.current_actor_kind() = 'host' OR user_id = core.current_user_id());
CREATE POLICY device_access ON core.device FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE core.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.session FORCE ROW LEVEL SECURITY;
CREATE POLICY global_fence ON core.session AS RESTRICTIVE FOR ALL
  USING (core.current_actor_kind() = 'host' OR user_id = core.current_user_id())
  WITH CHECK (core.current_actor_kind() = 'host' OR user_id = core.current_user_id());
CREATE POLICY session_access ON core.session FOR ALL USING (true) WITH CHECK (true);

-- rate_limit holds hashed keys and counters only; the limiter runs in host context.
ALTER TABLE core.rate_limit ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.rate_limit FORCE ROW LEVEL SECURITY;
CREATE POLICY global_fence ON core.rate_limit AS RESTRICTIVE FOR ALL
  USING (core.current_actor_kind() = 'host') WITH CHECK (core.current_actor_kind() = 'host');
CREATE POLICY rate_limit_access ON core.rate_limit FOR ALL USING (true) WITH CHECK (true);

-- auth_challenge: login runs in host context before a membership exists, so the fence admits
-- the host like core.outbox does. A tenant context still only sees its own workspace's rows.
ALTER TABLE core.auth_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.auth_challenge FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.auth_challenge AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host');
CREATE POLICY auth_challenge_access ON core.auth_challenge FOR ALL USING (true) WITH CHECK (true);

-- membership: the standard fence, plus the host context may read the *acting user's own*
-- rows when app.user_id is set (workspace switcher, "which workspaces can I enter"). Writes
-- always need a workspace context. Nothing else ever lists memberships across tenants.
ALTER TABLE core.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.membership AS RESTRICTIVE FOR ALL
  USING (
    workspace_id = core.current_workspace()
    OR (core.current_actor_kind() = 'host' AND user_id = core.current_user_id())
  )
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY membership_access ON core.membership FOR ALL USING (true) WITH CHECK (true);

-- Remaining tenant tables: the fence comes from core.apply_tenant_fence() after this run;
-- each needs its permissive policy declared here.
CREATE POLICY group_access ON core."group" FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY group_member_access ON core.group_member FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY invite_access ON core.invite FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY attestation_access ON core.attestation FOR ALL USING (true) WITH CHECK (true);

SELECT core.apply_tenant_fence();
