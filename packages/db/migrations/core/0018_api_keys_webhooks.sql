-- 0018_api_keys_webhooks — workspace API keys and outbound webhooks (EXECUTION_PLAN §15 E3.4,
-- ADR-0052).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/api.ts; the key/token rules live in
-- @seed-host/api-keys and the signer, fan-out and delivery in @seed-host/webhooks. Runs inside one
-- transaction; every table declares its fence inline so nothing can read a row between CREATE
-- TABLE and the runner's core.apply_tenant_fence() pass.
--
-- Kernel, not a module: an API key *authenticates* a request, and the bearer lookup runs right
-- after tenant resolution, before module enablement is knowable ("anything read during tenant
-- resolution cannot be a module"). Webhook delivery needs the guarded outbound HTTP agent, which
-- is kernel-only on purpose, and fans out events from every module.
--
--  * api_key           one row per key. The plaintext token (`shk_` + 43 base64url chars) is
--                      returned once and never stored: `token_hash` is sha256(token), globally
--                      unique, and deliberately NOT partial — a revoked or expired key must still
--                      be *found* so the answer is the same 401 an unknown key gets after the same
--                      work. A key acts as its creator's membership capped by `scopes`; the creator
--                      row cascades, so erasing a member removes their keys with them (erasure
--                      revokes first and counts; the cascade is the backstop).
--  * webhook_endpoint  one row per receiver. The URL and the signing secrets are sealed under the
--                      workspace key of purpose `webhook-secret` (SHE1); only scheme+host
--                      (`url_host`) and the last ≤4 characters (`url_hint`) are stored in clear.
--                      `encryption` holds one `{format, keyId, keyRef}` per sealed column
--                      (`url`, `secret`, `secretPrev`), so a secret rotated after a key rotation
--                      does not force re-sealing the URL.
--  * webhook_delivery  one row per (endpoint, event) plus manual re-sends and pings. `id` is the
--                      Standard Webhooks `webhook-id`, stable across retries. Fan-out dedupes on
--                      (endpoint_id, event_id) for non-manual rows so an outbox redelivery cannot
--                      double-send. Retention 30 days (webhooks.retention).
--
-- RLS: the fence plus one permissive policy for `staff` and `system` on all three tables. An
-- external member matches no permissive policy and sees zero rows: a key hash, a sealed URL and a
-- delivery payload are all staff-only facts, and there is no column-level RLS to carve out less.

--> statement-breakpoint
-- 1. API keys.
CREATE TABLE core.api_key (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  name text NOT NULL,
  -- sha256(token); the plaintext is returned once by create/rotate and stored nowhere
  token_hash bytea NOT NULL,
  -- display only: the token's first 12 characters (`shk_` + 8), e.g. shk_Ab3dE6gH
  prefix text NOT NULL,
  -- permission names from the authz catalogue, ⊆ API_KEY_SCOPES and ⊆ the creator's own at mint
  scopes text[] NOT NULL,
  -- the key acts as this membership (capped by scopes); gone with it
  created_by_membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  -- rotation link: the key minted to replace this one
  replaced_by_id uuid REFERENCES core.api_key (id) ON DELETE SET NULL,
  -- written at most once a minute per key, outside the request's transaction
  last_used_at timestamptz,
  -- truncated like audit (/24 for IPv4, /48 for IPv6)
  last_used_ip text,
  note text,
  CONSTRAINT api_key_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  -- A backstop against a direct SQL write: a short value means somebody stored a prefix.
  CONSTRAINT api_key_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT api_key_prefix_shape CHECK (prefix ~ '^shk_[A-Za-z0-9_-]{8}$'),
  CONSTRAINT api_key_scopes_nonempty CHECK (cardinality(scopes) >= 1),
  CONSTRAINT api_key_revoked_shape CHECK (
    (revoked_at IS NULL) = (revoked_reason IS NULL)
    AND (revoked_reason IS NULL
      OR revoked_reason IN ('revoked', 'rotated', 'creator_inactive', 'erased'))
  ),
  CONSTRAINT api_key_note_length CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT api_key_last_used_ip_length CHECK (
    last_used_ip IS NULL OR char_length(last_used_ip) <= 64
  ),
  CONSTRAINT api_key_not_self_replaced CHECK (replaced_by_id IS NULL OR replaced_by_id <> id)
);

-- THE lookup. Global (a 256-bit token is globally unique; a collision across workspaces would
-- be a cross-tenant resolve) and not partial (a revoked key must not be a faster miss).
CREATE UNIQUE INDEX api_key_token_hash_idx ON core.api_key (token_hash);
-- The admin list, newest first.
CREATE INDEX api_key_ws_created_idx ON core.api_key (workspace_id, created_at DESC);
-- The hourly sweep and erasure: the unrevoked keys one member created (also covers the
-- membership cascade).
CREATE INDEX api_key_creator_idx ON core.api_key (workspace_id, created_by_membership_id)
  WHERE revoked_at IS NULL;
CREATE INDEX api_key_replaced_by_idx ON core.api_key (replaced_by_id)
  WHERE replaced_by_id IS NOT NULL;

ALTER TABLE core.api_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.api_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.api_key AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY api_key_staff ON core.api_key FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
-- 2. Webhook endpoints.
CREATE TABLE core.webhook_endpoint (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  description text,
  -- SHE1(url) under the `webhook-secret` workspace key; never returned by any route
  url_enc bytea NOT NULL,
  -- { url: {format,keyId,keyRef}, secret: {…}, secretPrev?: {…} }
  encryption jsonb NOT NULL DEFAULT '{}'::jsonb,
  encryption_schema_version integer NOT NULL DEFAULT 1,
  -- display: scheme + host (e.g. https://hooks.example.com)
  url_host text NOT NULL,
  -- display: the URL's last ≤4 characters
  url_hint text NOT NULL,
  -- SHE1(`whsec_…`); the plaintext is returned once by create/rotate-secret
  secret_enc bytea NOT NULL,
  -- the previous secret while its overlap window lasts (signatures carry both)
  secret_prev_enc bytea,
  secret_prev_expires_at timestamptz,
  -- topics subscribed; each a webhook topic declared by some manifest
  events text[] NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  disabled_reason text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_by_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_endpoint_description_length CHECK (
    description IS NULL OR char_length(description) <= 200
  ),
  CONSTRAINT webhook_endpoint_url_host_length CHECK (char_length(url_host) BETWEEN 1 AND 300),
  CONSTRAINT webhook_endpoint_url_hint_length CHECK (char_length(url_hint) <= 4),
  CONSTRAINT webhook_endpoint_secret_prev_shape CHECK (
    (secret_prev_enc IS NULL) = (secret_prev_expires_at IS NULL)
  ),
  CONSTRAINT webhook_endpoint_events_nonempty CHECK (cardinality(events) >= 1),
  -- a disabled endpoint always says why; an enabled one never carries a stale reason
  CONSTRAINT webhook_endpoint_disabled_shape CHECK (
    enabled = (disabled_reason IS NULL)
    AND (disabled_reason IS NULL OR disabled_reason IN ('gone', 'failing', 'manual'))
  ),
  CONSTRAINT webhook_endpoint_failures_nonnegative CHECK (consecutive_failures >= 0)
);

CREATE INDEX webhook_endpoint_ws_idx ON core.webhook_endpoint (workspace_id);
CREATE INDEX webhook_endpoint_creator_idx ON core.webhook_endpoint (created_by_membership_id)
  WHERE created_by_membership_id IS NOT NULL;

CREATE TRIGGER webhook_endpoint_set_updated_at BEFORE UPDATE ON core.webhook_endpoint
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.webhook_endpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.webhook_endpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.webhook_endpoint AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY webhook_endpoint_staff ON core.webhook_endpoint FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
-- 3. Webhook deliveries (the queue, the log and the DLQ in one table).
CREATE TABLE core.webhook_delivery (
  -- the Standard Webhooks `webhook-id`, stable across retries
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES core.webhook_endpoint (id) ON DELETE CASCADE,
  topic text NOT NULL,
  -- the outbox event id as text, or `ping:<uuid>` for a test send
  event_id text NOT NULL,
  -- the body sent (ids only, as in EVENT_CATALOGUE); fixed at fan-out
  payload jsonb NOT NULL,
  payload_schema_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  -- when a pending row is due; NULL once terminal
  next_attempt_at timestamptz,
  -- lease of a `sending` row (stale after 5 minutes)
  claimed_at timestamptz,
  last_status_code integer,
  -- never the URL
  last_error text,
  last_duration_ms integer,
  -- printable characters only
  last_response_excerpt text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  -- a redelivery or a ping: outside the fan-out dedupe
  manual boolean NOT NULL DEFAULT false,
  CONSTRAINT webhook_delivery_status CHECK (
    status IN ('pending', 'sending', 'succeeded', 'failed', 'cancelled')
  ),
  CONSTRAINT webhook_delivery_topic_length CHECK (char_length(topic) BETWEEN 1 AND 100),
  CONSTRAINT webhook_delivery_event_id_length CHECK (char_length(event_id) BETWEEN 1 AND 100),
  CONSTRAINT webhook_delivery_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT webhook_delivery_pending_due CHECK (status <> 'pending' OR next_attempt_at IS NOT NULL),
  CONSTRAINT webhook_delivery_status_code_range CHECK (
    last_status_code IS NULL OR last_status_code BETWEEN 100 AND 599
  ),
  CONSTRAINT webhook_delivery_last_error_length CHECK (
    last_error IS NULL OR char_length(last_error) <= 300
  ),
  CONSTRAINT webhook_delivery_duration_nonnegative CHECK (
    last_duration_ms IS NULL OR last_duration_ms >= 0
  ),
  CONSTRAINT webhook_delivery_excerpt_length CHECK (
    last_response_excerpt IS NULL OR char_length(last_response_excerpt) <= 512
  )
);

-- The due sweep: pending rows by due time (across workspaces).
CREATE INDEX webhook_delivery_due_idx ON core.webhook_delivery (next_attempt_at)
  WHERE status = 'pending';
-- The stale-claim lease check.
CREATE INDEX webhook_delivery_sending_idx ON core.webhook_delivery (claimed_at)
  WHERE status = 'sending';
-- The deliveries list (keyset on created_at desc, id desc) and retention.
CREATE INDEX webhook_delivery_ws_created_idx
  ON core.webhook_delivery (workspace_id, created_at DESC, id DESC);
-- One endpoint's deliveries (detail page, 24 h counts, the endpoint cascade).
CREATE INDEX webhook_delivery_endpoint_idx
  ON core.webhook_delivery (endpoint_id, created_at DESC);
-- Fan-out dedupe: an outbox redelivery inserts ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX webhook_delivery_event_uq ON core.webhook_delivery (endpoint_id, event_id)
  WHERE NOT manual;

ALTER TABLE core.webhook_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.webhook_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.webhook_delivery AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY webhook_delivery_staff ON core.webhook_delivery FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

SELECT core.apply_tenant_fence();
