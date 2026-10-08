-- 0020_integrations — third-party connections, OAuth handshakes, booking links and recorded
-- bookings (EXECUTION_PLAN §15 E3.6, ADR-0054).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/integrations.ts; the service
-- (connection sealing, OAuth flow, token refresh lease, health, booking ingest) is
-- @seed-host/integrations and the vendor adapters are @seed-host/integration-<provider> behind
-- IntegrationAdapter. Runs inside one transaction; every table declares its fence inline so nothing
-- can read a row between CREATE TABLE and the runner's core.apply_tenant_fence() pass.
--
--  * integration_connection  at most one live row per (workspace, provider). The credentials
--                            (OAuth token set or pasted secret) and, for a booking provider, our
--                            webhook signing key are sealed (SHE1) under the workspace key of
--                            purpose `integration-credentials`; `encryption` holds one SealedRef
--                            per sealed column (`credentials`, `webhookSecret`).
--                            `refresh_lease_until` serialises refresh-token rotation across
--                            processes (claimed with a conditional UPDATE … RETURNING).
--  * integration_oauth_state one row per OAuth attempt: a one-time start ticket (2 min), the OAuth
--                            `state`, the browser-binding nonce (hashes only) and the sealed PKCE
--                            verifier. Single use, 10 minutes. The ops routes that see it arrive
--                            with no tenant, and the host actor gets NO policy here: they go
--                            through the two SECURITY DEFINER claim functions below, which admit
--                            only a caller holding the secret (its sha256) and burn it.
--  * integration_booking     meetings a Calendly / Cal.com webhook told us about (dedupe by the
--                            vendor's event id). Retained 400 days after `starts_at`; erasure
--                            pseudonymises the rows of a person (by membership or any of their
--                            email identities) and keeps them for dedupe (`erased_at`).
--  * booking_link            links shown on the investor portal, per audience. A link does not
--                            need a connection (it is just a URL); recording bookings does.
--
-- RLS: the fence plus a permissive staff/system policy on every table. integration_connection's
-- fence also admits the host actor for SELECT only (the booking webhook finds the connection by id
-- before it knows the workspace, like esign_connection in 0019). An external member may SELECT
-- enabled booking links (the service filters by audience); nothing else.

--> statement-breakpoint
-- 1. Connections.
CREATE TABLE core.integration_connection (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  provider text NOT NULL,
  auth_kind text NOT NULL,
  environment text NOT NULL DEFAULT 'production',
  -- SHE1(JSON { accessToken, refreshToken?, … })
  credentials_enc bytea NOT NULL,
  -- { credentials: SealedRef, webhookSecret?: SealedRef }
  encryption jsonb NOT NULL DEFAULT '{}'::jsonb,
  encryption_schema_version integer NOT NULL DEFAULT 1,
  access_expires_at timestamptz,
  scope text,
  -- QBO realmId, Xero tenantId, Slack team id, Calendly user uri, …
  external_account_id text,
  account_label text,
  -- SHE1(our webhook signing key), booking providers only
  webhook_secret_enc bytea,
  webhook_subscription_id text,
  status text NOT NULL DEFAULT 'active',
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  -- never a credential or vendor text verbatim; a short, vendor-neutral reason
  last_error text,
  refresh_lease_until timestamptz,
  -- serialises webhook-secret rotation (Calendly: one subscription per callback URL), like the
  -- refresh lease; never held across a vendor call as a DB lock (fix round 2)
  webhook_rotation_lease_until timestamptz,
  -- the rotation that holds the lease (fix round 3): every lease write/clear is conditional on it
  webhook_rotation_lease_token uuid,
  created_by_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT integration_connection_provider CHECK (
    provider IN ('quickbooks', 'xero', 'stripe', 'slack', 'calendly', 'calcom')
  ),
  CONSTRAINT integration_connection_auth_kind CHECK (auth_kind IN ('oauth2', 'secret')),
  CONSTRAINT integration_connection_environment CHECK (environment IN ('production', 'sandbox')),
  CONSTRAINT integration_connection_status CHECK (
    status IN ('active', 'degraded', 'reauth_required')
  ),
  CONSTRAINT integration_connection_failures_nonnegative CHECK (consecutive_failures >= 0),
  CONSTRAINT integration_connection_scope_length CHECK (
    scope IS NULL OR char_length(scope) <= 1000
  ),
  CONSTRAINT integration_connection_external_account_length CHECK (
    external_account_id IS NULL OR char_length(external_account_id) BETWEEN 1 AND 300
  ),
  CONSTRAINT integration_connection_account_label_length CHECK (
    account_label IS NULL OR char_length(account_label) <= 200
  ),
  CONSTRAINT integration_connection_subscription_length CHECK (
    webhook_subscription_id IS NULL OR char_length(webhook_subscription_id) BETWEEN 1 AND 300
  ),
  CONSTRAINT integration_connection_last_error_length CHECK (
    last_error IS NULL OR char_length(last_error) <= 500
  ),
  CONSTRAINT integration_connection_encryption_object CHECK (jsonb_typeof(encryption) = 'object')
);

-- At most one live connection per (workspace, provider); a replaced or disconnected one keeps its
-- row for the bookings that reference it.
CREATE UNIQUE INDEX integration_connection_live_idx
  ON core.integration_connection (workspace_id, provider)
  WHERE deleted_at IS NULL;
CREATE INDEX integration_connection_creator_idx
  ON core.integration_connection (created_by_membership_id)
  WHERE created_by_membership_id IS NOT NULL;

CREATE TRIGGER integration_connection_set_updated_at BEFORE UPDATE ON core.integration_connection
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.integration_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.integration_connection FORCE ROW LEVEL SECURITY;
-- The booking webhook (`/webhooks/integrations/{connectionId}`) arrives with no tenant. As for
-- core.esign_connection (0019) the fence admits the host actor, whose only permissive policy is
-- FOR SELECT, and the fence's WITH CHECK names the workspace alone: a host transaction can read,
-- never write.
CREATE POLICY tenant_fence ON core.integration_connection AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY integration_connection_staff ON core.integration_connection FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY integration_connection_host_read ON core.integration_connection FOR SELECT
  USING (core.current_actor_kind() = 'host');

--> statement-breakpoint
-- 2. OAuth handshakes.
CREATE TABLE core.integration_oauth_state (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  provider text NOT NULL,
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  -- sha256 of the one-time start ticket handed to the SPA
  ticket_hash bytea NOT NULL,
  ticket_expires_at timestamptz NOT NULL,
  -- set when GET /oauth/integrations/start claims the ticket
  ticket_claimed_at timestamptz,
  -- sha256 of the OAuth `state` (set at start)
  state_hash bytea,
  -- sha256 of the browser-binding cookie nonce (set at start)
  browser_hash bytea,
  -- SHE1(PKCE code verifier), providers with pkce only
  verifier_enc bytea,
  -- { verifier?: SealedRef }
  encryption jsonb NOT NULL DEFAULT '{}'::jsonb,
  encryption_schema_version integer NOT NULL DEFAULT 1,
  environment text NOT NULL DEFAULT 'production',
  return_path text NOT NULL DEFAULT '/admin/integrations',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  -- After the callback (E3.6 fix round 1): the exchanged, verified token set waits here, sealed,
  -- until the initiator confirms it in the workspace (POST /integrations/{provider}/oauth/complete
  -- with the one-time pending token from the redirect's URL fragment). sha256 of that token:
  pending_hash bytea,
  -- SHE1(JSON { tokens, accountLabel, externalAccountId, accounts })
  pending_enc bytea,
  pending_expires_at timestamptz,
  -- set by the confirm step (single use)
  completed_at timestamptz,
  CONSTRAINT integration_oauth_state_provider CHECK (
    provider IN ('quickbooks', 'xero', 'stripe', 'slack', 'calendly', 'calcom')
  ),
  CONSTRAINT integration_oauth_state_environment CHECK (environment IN ('production', 'sandbox')),
  CONSTRAINT integration_oauth_state_ticket_hash_length CHECK (octet_length(ticket_hash) = 32),
  CONSTRAINT integration_oauth_state_state_hash_length CHECK (
    state_hash IS NULL OR octet_length(state_hash) = 32
  ),
  CONSTRAINT integration_oauth_state_browser_hash_length CHECK (
    browser_hash IS NULL OR octet_length(browser_hash) = 32
  ),
  CONSTRAINT integration_oauth_state_pending_hash_length CHECK (
    pending_hash IS NULL OR octet_length(pending_hash) = 32
  ),
  -- the sealed grant is dropped when the confirm step uses it (fix round 3); hash + expiry stay
  CONSTRAINT integration_oauth_state_pending_shape CHECK (
    (pending_hash IS NULL) = (pending_expires_at IS NULL) AND (pending_enc IS NULL OR pending_hash IS NOT NULL)
  ),
  CONSTRAINT integration_oauth_state_return_path CHECK (
    return_path LIKE '/admin/%' AND char_length(return_path) <= 300
  ),
  CONSTRAINT integration_oauth_state_encryption_object CHECK (jsonb_typeof(encryption) = 'object')
);

CREATE UNIQUE INDEX integration_oauth_state_ticket_idx ON core.integration_oauth_state (ticket_hash);
CREATE UNIQUE INDEX integration_oauth_state_state_idx ON core.integration_oauth_state (state_hash)
  WHERE state_hash IS NOT NULL;
CREATE UNIQUE INDEX integration_oauth_state_pending_idx ON core.integration_oauth_state (pending_hash)
  WHERE pending_hash IS NOT NULL;
-- The hourly sweep.
CREATE INDEX integration_oauth_state_expires_idx ON core.integration_oauth_state (expires_at);
CREATE INDEX integration_oauth_state_member_idx
  ON core.integration_oauth_state (workspace_id, membership_id);

ALTER TABLE core.integration_oauth_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.integration_oauth_state FORCE ROW LEVEL SECURITY;
-- No host arm: the ops routes reach a row only through the claim functions below.
CREATE POLICY tenant_fence ON core.integration_oauth_state AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY integration_oauth_state_staff ON core.integration_oauth_state FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

-- Claim functions. SECURITY DEFINER with row security off for their own statements (the owner is
-- the migrating role, superuser or BYPASSRLS — 0014's rule; with an owner subject to RLS the
-- UPDATE raises 42501 instead of silently matching nothing). The capability is knowing the
-- 32-byte secret: each function matches on its sha256, burns it in the same statement and
-- returns the row (from which the caller learns the workspace) only while unexpired and unused.
-- Callable only by the host actor (the ops routes run withHost); anything else raises.
--
-- Ticket: GET /oauth/integrations/start. Marks the ticket claimed; the caller then writes
-- state_hash / browser_hash / verifier_enc in a system context of the returned workspace.
CREATE FUNCTION core.integration_oauth_ticket_claim(p_ticket_hash bytea)
RETURNS SETOF core.integration_oauth_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core SET row_security = off AS $$
BEGIN
  IF core.current_actor_kind() IS DISTINCT FROM 'host' THEN
    RAISE EXCEPTION 'integration OAuth ticket claims run as the host actor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    UPDATE core.integration_oauth_state s SET ticket_claimed_at = now()
    WHERE s.ticket_hash = p_ticket_hash
      AND s.ticket_claimed_at IS NULL
      AND s.consumed_at IS NULL
      AND s.ticket_expires_at > now()
      AND s.expires_at > now()
    RETURNING s.*;
END;
$$;
REVOKE ALL ON FUNCTION core.integration_oauth_ticket_claim(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.integration_oauth_ticket_claim(bytea) TO seedhost_app;

-- State: GET /oauth/integrations/callback. Consumes the handshake (single use).
CREATE FUNCTION core.integration_oauth_state_claim(p_state_hash bytea)
RETURNS SETOF core.integration_oauth_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, core SET row_security = off AS $$
BEGIN
  IF core.current_actor_kind() IS DISTINCT FROM 'host' THEN
    RAISE EXCEPTION 'integration OAuth state claims run as the host actor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    UPDATE core.integration_oauth_state s SET consumed_at = now()
    WHERE s.state_hash = p_state_hash
      AND s.ticket_claimed_at IS NOT NULL
      AND s.consumed_at IS NULL
      AND s.expires_at > now()
    RETURNING s.*;
END;
$$;
REVOKE ALL ON FUNCTION core.integration_oauth_state_claim(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.integration_oauth_state_claim(bytea) TO seedhost_app;

--> statement-breakpoint
-- 3. Recorded bookings.
CREATE TABLE core.integration_booking (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES core.integration_connection (id),
  provider text NOT NULL,
  -- the vendor's event uid
  external_id text NOT NULL,
  status text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  invitee_email citext NOT NULL,
  invitee_name text,
  event_name text,
  -- matched at ingest by the invitee email of a live membership's user
  membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  -- identity erasure (fix round 1): the invitee's address became a tombstone and the name was
  -- dropped; the row stays so a vendor retry of the same event dedupes instead of re-inserting
  -- the person. Ingest never rewrites an erased row's personal fields.
  erased_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_booking_provider CHECK (provider IN ('calendly', 'calcom')),
  CONSTRAINT integration_booking_status CHECK (status IN ('booked', 'cancelled', 'rescheduled')),
  CONSTRAINT integration_booking_external_id_length CHECK (
    char_length(external_id) BETWEEN 1 AND 300
  ),
  CONSTRAINT integration_booking_invitee_email_length CHECK (
    char_length(invitee_email) BETWEEN 1 AND 320
  ),
  CONSTRAINT integration_booking_invitee_name_length CHECK (
    invitee_name IS NULL OR char_length(invitee_name) <= 200
  ),
  CONSTRAINT integration_booking_event_name_length CHECK (
    event_name IS NULL OR char_length(event_name) <= 200
  )
);

CREATE UNIQUE INDEX integration_booking_external_idx
  ON core.integration_booking (workspace_id, provider, external_id);
CREATE INDEX integration_booking_member_idx
  ON core.integration_booking (workspace_id, membership_id);
-- Erasure by address.
CREATE INDEX integration_booking_email_idx ON core.integration_booking (workspace_id, invitee_email);
-- The staff register (keyset on starts_at desc, id desc) and the retention sweep.
CREATE INDEX integration_booking_starts_idx
  ON core.integration_booking (workspace_id, starts_at DESC, id DESC);
CREATE INDEX integration_booking_retention_idx ON core.integration_booking (starts_at);
CREATE INDEX integration_booking_connection_idx ON core.integration_booking (connection_id);

CREATE TRIGGER integration_booking_set_updated_at BEFORE UPDATE ON core.integration_booking
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.integration_booking ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.integration_booking FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.integration_booking AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY integration_booking_staff ON core.integration_booking FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
-- 3b. Booking suppressions (fix round 2). Identity erasure records a keyed hash of every email
-- address of the erased person; booking ingest drops (never stores) an event whose invitee address
-- hashes to one of them, so a NEW vendor event for an erased person cannot write their address
-- back. email_hash = HMAC-SHA256(workspace key of purpose `integration-booking-suppression`,
-- lower(email)): not reversible from a database copy alone, checked under every key the
-- workspace holds for that purpose (rotation-safe). No address is stored.
CREATE TABLE core.integration_booking_suppression (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  email_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, email_hash),
  CONSTRAINT integration_booking_suppression_hash_length CHECK (octet_length(email_hash) = 32)
);

ALTER TABLE core.integration_booking_suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.integration_booking_suppression FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.integration_booking_suppression AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY integration_booking_suppression_staff ON core.integration_booking_suppression FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
-- 4. Booking links.
CREATE TABLE core.booking_link (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  provider text NOT NULL,
  url text NOT NULL,
  label text NOT NULL,
  description text,
  -- {kind:"all"} | {kind:"groups", groupIds: uuid[1..50]}
  audience jsonb NOT NULL DEFAULT '{"kind":"all"}'::jsonb,
  audience_schema_version integer NOT NULL DEFAULT 1,
  position integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  created_by_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_link_provider CHECK (provider IN ('calendly', 'calcom')),
  CONSTRAINT booking_link_url_shape CHECK (
    url LIKE 'https://%' AND char_length(url) BETWEEN 9 AND 500
  ),
  CONSTRAINT booking_link_label_length CHECK (char_length(label) BETWEEN 1 AND 80),
  CONSTRAINT booking_link_description_length CHECK (
    description IS NULL OR char_length(description) <= 300
  ),
  CONSTRAINT booking_link_audience_object CHECK (
    jsonb_typeof(audience) = 'object' AND audience ->> 'kind' IN ('all', 'groups')
  ),
  CONSTRAINT booking_link_position_nonnegative CHECK (position >= 0)
);

CREATE INDEX booking_link_ws_position_idx ON core.booking_link (workspace_id, position, id);
CREATE INDEX booking_link_creator_idx ON core.booking_link (created_by_membership_id)
  WHERE created_by_membership_id IS NOT NULL;

CREATE TRIGGER booking_link_set_updated_at BEFORE UPDATE ON core.booking_link
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.booking_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.booking_link FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.booking_link AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY booking_link_staff ON core.booking_link FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
-- A member reads enabled links; the service filters by audience. Never writes.
CREATE POLICY booking_link_external_read ON core.booking_link FOR SELECT
  USING (core.current_actor_kind() = 'external' AND enabled);

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

SELECT core.apply_tenant_fence();
