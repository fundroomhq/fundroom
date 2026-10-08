-- 0007_custom_domains — the portal hostname claim, its DNS challenge and the state machine
-- behind on-demand TLS (EXECUTION_PLAN §9.2, ADR-0004, ADR-0039, E2.1).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/custom-domains.ts. Runs inside one
-- transaction. The fence here is *not* the plain tenant shape (see the RLS block), and it is
-- declared inline so nothing can read a row before the runner's core.apply_tenant_fence() pass.
--
-- Model (EXECUTION_PLAN §9.2, design/07 §2.2; design/02 §78 for the step-up on mutations):
--  * custom_domain   one row per hostname a workspace wants its portal served on, plus the
--                    verification state that gates it. Kernel, not a module table: the
--                    hostname -> workspace lookup runs in the tenant classifier before tenant
--                    context or module enablement exists, and disabling a module must never
--                    404 a workspace's own portal.
--
-- This is the *portal* domain. The *sending* (DKIM) domain is updates.sending_domain and stays
-- there: a different state machine, a different record set, a different owner (E1.4).
--
-- Only the challenge token is stored. The CNAME/TXT instructions shown to the admin are derived
-- from the token plus the configured edge host at render time: a stored copy of the instructions
-- goes stale the day the edge host changes.

CREATE TYPE core.custom_domain_status AS ENUM ('pending', 'dns_ok', 'active', 'failed');

--> statement-breakpoint
CREATE TABLE core.custom_domain (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  hostname citext NOT NULL,
  status core.custom_domain_status NOT NULL DEFAULT 'pending',
  -- base32(HMAC(secret, workspace || hostname)), reproducible and carrying no secret of its own
  token text NOT NULL,
  -- the last resolver answer, surfaced verbatim in the UI (§9.2 "last resolver answer shown in UI")
  last_answer jsonb,
  last_answer_schema_version integer NOT NULL DEFAULT 1,
  -- one operator-facing sentence naming what DNS actually said
  last_detail text,
  -- consecutive re-verify failures; an active domain is only demoted after the grace count
  consecutive_failures integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  dns_ok_at timestamptz,
  activated_at timestamptz,
  -- membership id of the admin who added it; nullable like the other core tables
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  -- A backstop against a direct SQL write, not the product rule: normalizeHostname() in
  -- @seed-host/custom-domains is the real validator (IDNA -> punycode, label and total length,
  -- public-suffix, reserved names, and the canonical host itself). Deliberately permissive
  -- enough to accept any punycode label, including an `xn--` TLD, so the application stays the
  -- one place that decides what a customer may claim.
  CONSTRAINT custom_domain_hostname_format CHECK (
    char_length(hostname) <= 253
    AND hostname ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  ),
  -- length only: the token's encoding belongs to challengeToken(), not to the schema
  CONSTRAINT custom_domain_token_length CHECK (char_length(token) BETWEEN 16 AND 128),
  CONSTRAINT custom_domain_detail_length CHECK (last_detail IS NULL OR char_length(last_detail) <= 1000),
  CONSTRAINT custom_domain_failures_nonnegative CHECK (consecutive_failures >= 0)
);

-- One live row per workspace+hostname; a soft-deleted row may be re-added. Workspace-leading, so
-- it is also the admin list index.
CREATE UNIQUE INDEX custom_domain_ws_host_idx
  ON core.custom_domain (workspace_id, hostname) WHERE deleted_at IS NULL;

-- THE claim, and the `ask` lookup, in one index.
--
-- A hostname may be *verified* for only one workspace at a time, but two workspaces may both
-- hold a `pending` row — one of them is a typo, or a customer moving between installs. A global
-- unique index that also covered `pending` rows would let a squatter park one on a rival's
-- hostname and block them forever, so the constraint is restricted to the verified states. That
-- is what makes "first verified wins" the rule, and it is what implements §9.2's "domain moves to
-- another workspace -> pending": the losing row is demoted back to `pending`, which frees the
-- claim for whoever can prove control next.
--
-- It doubles as the lookup index design/07 §2.2 step 4 asks for — `WHERE status IN
-- ('dns_ok','active')` is exactly the predicate the Caddy `ask` endpoint and the tenant
-- classifier query on — so there is deliberately no second index on (hostname).
CREATE UNIQUE INDEX custom_domain_claim_idx
  ON core.custom_domain (hostname) WHERE deleted_at IS NULL AND status IN ('dns_ok', 'active');

-- The other half of the exclusivity: one *verified* hostname per workspace.
--
-- A second verified hostname would not be an alias, it would be a second cookie jar. `__Host-`
-- cookies are host-scoped, so an investor who bookmarked the second hostname gets a different
-- session from one who used the first, and is logged out for no visible reason. Serving one
-- portal from two origins needs a redirect-to-primary story and a canonical-origin rule that
-- this epic does not own, so the schema says one.
--
-- Multiple *pending* rows in the same workspace stay legal: a founder fixing a typo needs to add
-- the corrected hostname before removing the wrong one. Only the verified state is exclusive.
CREATE UNIQUE INDEX custom_domain_one_per_workspace_idx
  ON core.custom_domain (workspace_id) WHERE deleted_at IS NULL AND status IN ('dns_ok', 'active');

-- ResolvedWorkspace.primaryHost reads the active domain on every resolved workspace, so that
-- lookup gets its own partial index instead of filtering the whole per-workspace list.
CREATE INDEX custom_domain_active_idx
  ON core.custom_domain (workspace_id, activated_at) WHERE deleted_at IS NULL AND status = 'active';

-- The verify / re-verify sweeps: least-recently-checked first, never-checked first of all.
CREATE INDEX custom_domain_check_idx
  ON core.custom_domain (status, last_checked_at NULLS FIRST) WHERE deleted_at IS NULL;

CREATE TRIGGER custom_domain_set_updated_at BEFORE UPDATE ON core.custom_domain
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

--> statement-breakpoint
-- Row-level security.
--
-- This table is read outside a tenant context by design: the Caddy `ask` endpoint and the tenant
-- classifier answer from the hostname alone, before any workspace is known, and the verify /
-- re-verify jobs sweep every workspace. So the fence admits the host actor as well as the owning
-- workspace — the core.workspace / core.outbox precedent in 0000_core_kernel.sql — and every one
-- of those callers must run under db.withHost(...).
--
-- core.apply_tenant_fence() would otherwise install the plain workspace-only fence here (the
-- table has a workspace_id), and it leaves an existing policy named tenant_fence alone, which is
-- why this one is declared inline. A restrictive-only table denies everything, so the permissive
-- policy below is what actually grants: staff and system within the workspace (the admin screen,
-- the jobs), host across all workspaces. An external member never sees a domain row — which
-- hostname it arrived on is not its business, and the token is a control proof.
ALTER TABLE core.custom_domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.custom_domain FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.custom_domain AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host');
CREATE POLICY custom_domain_access ON core.custom_domain FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system', 'host'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system', 'host'));

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

SELECT core.apply_tenant_fence();
