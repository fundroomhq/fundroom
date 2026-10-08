-- 0023_control_plane — the managed-host control plane: cells, platform operators, plans,
-- subscriptions, usage, sanctions screening, workspace status, central-auth sessions
-- (EXECUTION_PLAN §15 E3.10, ADR-0058).
--
-- Hand-written (ADR-0004). The TypeScript views are src/schema/control-plane.ts (the new tables),
-- src/schema/core.ts (the workspace columns) and src/schema/identity.ts (session.bound_workspace_id
-- and the challenge kinds). The services are @seed-host/control-plane (operators, workspaces,
-- cells, signup, plans, usage, quotas), @seed-host/billing and @seed-host/sanctions. Runs inside
-- one transaction; every table declares its fence inline so nothing can read a row between CREATE
-- TABLE and the runner's core.apply_tenant_fence() pass.
--
-- Kernel, not a module: the workspace status, cell and plan are read during tenant resolution, and
-- everything else here is install-level. Inert unless CONTROL_PLANE=on: every new workspace column
-- defaults to what a self-hosted install already means (cell `default`, `active`, no plan =
-- unlimited), so a self-hoster sees no behaviour change.
--
--  * cell                  where a workspace is served. One seeded row, `default` with an empty
--                          public origin ("this install"). Host writes; anybody may read.
--  * plan                  what a workspace may use (`limits`, absent key = unlimited), what it
--                          costs (`billing_price_ref`) and whether signup offers it. Host writes;
--                          anybody may read (a tenant's usage page names its plan).
--  * workspace             cell_id, holds (independent flags) and the status / suspended_reason /
--                          suspended_at derived from them by a trigger, legal_name, country,
--                          plan_id. A guard trigger pins the control-plane columns to the
--                          host and system actors: a tenant context may write its own row
--                          (settings, locale) but never lift its own suspension or change its plan.
--  * platform_operator     who may open an operator session. Host only; granted by the CLI.
--  * subscription          one per workspace; the billing provider's view, re-read on every webhook.
--                          Tenant staff may read their own; host and system write.
--  * billing_event         provider event ids already processed (dedupe), 90 days. Host only.
--  * tenant_usage_daily    the rollup job's per-day meter. Tenant staff may read their own; host
--                          and system write. 400 days.
--  * sanctions_screening   one row per screen of a tenant company. Host only: tenant staff never
--                          see it. No FK to the workspace — kept 5 years as a legal record, past
--                          the workspace's purge.
--  * session               bound_workspace_id — a session minted by a central-auth handoff serves
--                          that workspace only (like sso_workspace_id); source_session_id — the
--                          session a derived one was minted from (revoked with it).
--  * auth_challenge_kind   + central_request, central_handoff, signup (last; unused here).

--> statement-breakpoint
-- 1. Cells.
CREATE TABLE core.cell (
  id text PRIMARY KEY,
  region text NOT NULL,
  -- the https origin an edge routes this cell's workspaces to; '' = this install
  public_origin text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cell_id_format CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  CONSTRAINT cell_region_length CHECK (char_length(region) BETWEEN 1 AND 64),
  CONSTRAINT cell_public_origin_shape CHECK (
    public_origin = '' OR public_origin ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'
  ),
  CONSTRAINT cell_status CHECK (status IN ('active', 'draining', 'closed'))
);

CREATE TRIGGER cell_set_updated_at BEFORE UPDATE ON core.cell
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

INSERT INTO core.cell (id, region, public_origin, status)
VALUES ('default', 'default', '', 'active')
ON CONFLICT (id) DO NOTHING;

-- Tenant resolution reads the workspace row, not this table, so a tenant context never needs a
-- cell; reading the catalogue is harmless (regions and origins are public routing facts). Only the
-- host (the CLI, the operator API) writes.
ALTER TABLE core.cell ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.cell FORCE ROW LEVEL SECURITY;
CREATE POLICY cell_read ON core.cell FOR SELECT USING (true);
CREATE POLICY cell_host_write ON core.cell FOR ALL
  USING (core.current_actor_kind() = 'host')
  WITH CHECK (core.current_actor_kind() = 'host');

--> statement-breakpoint
-- 2. Plans.
-- A plan's metered prices: at most 10 distinct provider price ids of 1-255 characters each.
CREATE FUNCTION core.plan_price_refs_valid(a text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(a) <= 10
     AND cardinality(a) = (SELECT count(DISTINCT x) FROM unnest(a) AS x)
     AND NOT EXISTS (
       SELECT 1 FROM unnest(a) AS x WHERE x IS NULL OR char_length(x) NOT BETWEEN 1 AND 255
     )
$$;
CREATE TABLE core.plan (
  id text PRIMARY KEY,
  name text NOT NULL,
  -- PlanLimits (@seed-host/contracts): { staffSeats?, investorSeats?, storageBytes?,
  -- customDomains?, emailsPerMonth? }; an absent key is unlimited
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits_schema_version integer NOT NULL DEFAULT 1,
  -- the billing provider's price (a Stripe `price_…` id); null = not sold through a provider
  billing_price_ref text,
  -- the provider's METERED prices (Stripe `price_…` ids on meters `seedhost_staff_seats`,
  -- `seedhost_storage_gb`): added to a checkout as quantity-less line items; usage is reported
  -- only for meters whose price is on the subscription
  billing_metered_price_refs text[] NOT NULL DEFAULT '{}',
  trial_days integer NOT NULL DEFAULT 0,
  -- offered at self-service signup and on the tenant's billing page
  public boolean NOT NULL DEFAULT false,
  -- archived plans stay on the workspaces that have them but are not assignable
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- optimistic concurrency for PATCH /platform/plans/{id}
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT plan_id_format CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,40}$'),
  CONSTRAINT plan_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT plan_limits_object CHECK (jsonb_typeof(limits) = 'object'),
  CONSTRAINT plan_price_ref_length CHECK (
    billing_price_ref IS NULL OR char_length(billing_price_ref) BETWEEN 1 AND 255
  ),
  CONSTRAINT plan_metered_price_refs CHECK (core.plan_price_refs_valid(billing_metered_price_refs)),
  CONSTRAINT plan_trial_days_range CHECK (trial_days BETWEEN 0 AND 90),
  CONSTRAINT plan_version_positive CHECK (version >= 1)
);

CREATE TRIGGER plan_set_updated_at BEFORE UPDATE ON core.plan
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Like core.cell: a tenant's usage and billing pages name their plan and its limits, so any
-- context may read the catalogue; only the host (operator API, CLI) writes it.
ALTER TABLE core.plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.plan FORCE ROW LEVEL SECURITY;
CREATE POLICY plan_read ON core.plan FOR SELECT USING (true);
CREATE POLICY plan_host_write ON core.plan FOR ALL
  USING (core.current_actor_kind() = 'host')
  WITH CHECK (core.current_actor_kind() = 'host');

--> statement-breakpoint
-- 3. Workspace placement, status and plan. Fast defaults on PG 18: no table rewrite.
ALTER TABLE core.workspace
  ADD COLUMN cell_id text NOT NULL DEFAULT 'default',
  -- independent flags (below); status / suspended_reason / suspended_at are derived from them
  ADD COLUMN holds text[] NOT NULL DEFAULT '{}',
  ADD COLUMN status text NOT NULL DEFAULT 'active',
  ADD COLUMN suspended_reason text,
  ADD COLUMN suspended_at timestamptz,
  -- the tenant's company, for sanctions screening and billing
  ADD COLUMN legal_name text,
  ADD COLUMN country text,
  -- null = unlimited (every self-hosted workspace)
  ADD COLUMN plan_id text;
ALTER TABLE core.workspace ADD CONSTRAINT workspace_cell_fk
  FOREIGN KEY (cell_id) REFERENCES core.cell (id) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_cell_fk;
ALTER TABLE core.workspace ADD CONSTRAINT workspace_plan_fk
  FOREIGN KEY (plan_id) REFERENCES core.plan (id) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_plan_fk;
ALTER TABLE core.workspace ADD CONSTRAINT workspace_status CHECK (
  status IN ('active', 'pending_review', 'suspended')
) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_status;
ALTER TABLE core.workspace ADD CONSTRAINT workspace_suspended_reason CHECK (
  suspended_reason IS NULL OR suspended_reason IN ('operator', 'billing', 'sanctions')
) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_suspended_reason;
-- A suspension always says why and since when; nothing else carries either.
ALTER TABLE core.workspace ADD CONSTRAINT workspace_suspension_shape CHECK (
  (status = 'suspended') = (suspended_reason IS NOT NULL)
  AND (status = 'suspended') = (suspended_at IS NOT NULL)
) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_suspension_shape;
-- The holds a workspace carries, each set and cleared by its own owner, independently: a new
-- workspace's sanctions review (`sanctions_review` → pending_review), and the three suspensions
-- (`operator`, `billing`, `sanctions`). One flag per owner means lifting one never lifts another
-- (an operator's unsuspend cannot release a sanctions review; a paid invoice cannot lift an
-- operator suspension). Kept sorted and duplicate-free by the trigger below.
CREATE FUNCTION core.text_array_is_set(a text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT cardinality(a) = (SELECT count(DISTINCT x) FROM unnest(a) AS x)
$$;
ALTER TABLE core.workspace ADD CONSTRAINT workspace_holds CHECK (
  holds <@ ARRAY['sanctions_review', 'operator', 'billing', 'sanctions']::text[]
  AND array_position(holds, NULL) IS NULL
  AND core.text_array_is_set(holds)
) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_holds;
ALTER TABLE core.workspace ADD CONSTRAINT workspace_legal_name_length CHECK (
  legal_name IS NULL OR char_length(legal_name) BETWEEN 1 AND 200
) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_legal_name_length;
ALTER TABLE core.workspace ADD CONSTRAINT workspace_country_format CHECK (
  country IS NULL OR country ~ '^[A-Z]{2}$'
) NOT VALID;
ALTER TABLE core.workspace VALIDATE CONSTRAINT workspace_country_format;

-- status, suspended_reason and suspended_at are the holds' DERIVED mirror (tenant resolution and
-- the status guard read them): suspended while any of operator / billing / sanctions is set (the
-- reason is the highest: sanctions > operator > billing), pending_review while only
-- sanctions_review is, else active; suspended_at is when it last became suspended (kept while it
-- stays suspended for another reason). Derived here, not by the writer, so nothing can desync
-- them; a writer that sets status or suspended_reason to anything but the derived value is
-- refused (a bug, not a race).
CREATE FUNCTION core.workspace_derive_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  derived_status text;
  derived_reason text;
BEGIN
  NEW.holds := ARRAY(SELECT DISTINCT h FROM unnest(NEW.holds) AS h WHERE h IS NOT NULL ORDER BY h);
  derived_reason := CASE
    WHEN 'sanctions' = ANY (NEW.holds) THEN 'sanctions'
    WHEN 'operator' = ANY (NEW.holds) THEN 'operator'
    WHEN 'billing' = ANY (NEW.holds) THEN 'billing'
  END;
  derived_status := CASE
    WHEN derived_reason IS NOT NULL THEN 'suspended'
    WHEN 'sanctions_review' = ANY (NEW.holds) THEN 'pending_review'
    ELSE 'active'
  END;
  IF TG_OP = 'INSERT' THEN
    -- the column defaults (active, no reason) are fine: an INSERT names holds only
    IF (NEW.status, NEW.suspended_reason) IS DISTINCT FROM (derived_status, derived_reason)
       AND (NEW.status, NEW.suspended_reason) IS DISTINCT FROM ('active'::text, NULL::text) THEN
      RAISE EXCEPTION 'workspace status is derived from holds'
        USING ERRCODE = '23514', CONSTRAINT = 'workspace_holds';
    END IF;
  ELSIF (NEW.status, NEW.suspended_reason) IS DISTINCT FROM (OLD.status, OLD.suspended_reason)
        AND (NEW.status, NEW.suspended_reason) IS DISTINCT FROM (derived_status, derived_reason) THEN
    RAISE EXCEPTION 'workspace status is derived from holds'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_holds';
  END IF;
  NEW.status := derived_status;
  NEW.suspended_reason := derived_reason;
  NEW.suspended_at := CASE
    WHEN derived_status <> 'suspended' THEN NULL
    WHEN TG_OP = 'UPDATE' AND OLD.status = 'suspended' THEN OLD.suspended_at
    ELSE coalesce(NEW.suspended_at, now())
  END;
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_derive_status BEFORE INSERT OR UPDATE ON core.workspace
  FOR EACH ROW EXECUTE FUNCTION core.workspace_derive_status();

CREATE INDEX workspace_cell_idx ON core.workspace (cell_id);
CREATE INDEX workspace_plan_idx ON core.workspace (plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX workspace_unavailable_idx ON core.workspace (status) WHERE status <> 'active';
-- The operator list's keyset (`ORDER BY created_at, id`).
CREATE INDEX workspace_created_idx ON core.workspace (created_at, id);

-- The workspace fence lets a tenant context update its own row (settings, locale, offering
-- status). These columns are the control plane's: a tenant that could write them could lift its
-- own suspension, pick a plan or rename the legal entity a sanctions screen cleared. Only the host
-- (operator API, signup, CLI) and system (jobs, `setWorkspaceStatus`) actors may change them.
CREATE OR REPLACE FUNCTION core.workspace_control_plane_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.cell_id, NEW.holds, NEW.status, NEW.suspended_reason, NEW.suspended_at,
      NEW.legal_name, NEW.country, NEW.plan_id)
     IS DISTINCT FROM
     (OLD.cell_id, OLD.holds, OLD.status, OLD.suspended_reason, OLD.suspended_at,
      OLD.legal_name, OLD.country, OLD.plan_id)
     AND coalesce(core.current_actor_kind(), '') NOT IN ('host', 'system') THEN
    RAISE EXCEPTION 'workspace control-plane columns are written by the host or system actor only'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER workspace_control_plane_guard BEFORE UPDATE ON core.workspace
  FOR EACH ROW EXECUTE FUNCTION core.workspace_control_plane_guard();

--> statement-breakpoint
-- 4. Platform operators (granted and revoked only by `seedhost operator grant|revoke`).
CREATE TABLE core.platform_operator (
  user_id uuid PRIMARY KEY REFERENCES core."user" (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- `cli:<os user>` or the granting operator's user id
  created_by text NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT platform_operator_created_by_length CHECK (char_length(created_by) BETWEEN 1 AND 200)
);

-- Who the operators are is host business alone: a tenant context sees no row, not even its own
-- user's.
ALTER TABLE core.platform_operator ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.platform_operator FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_operator_host ON core.platform_operator FOR ALL
  USING (core.current_actor_kind() = 'host')
  WITH CHECK (core.current_actor_kind() = 'host');

--> statement-breakpoint
-- 5. Subscriptions (one per workspace).
CREATE TABLE core.subscription (
  workspace_id uuid PRIMARY KEY REFERENCES core.workspace (id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES core.plan (id),
  provider text NOT NULL,
  status text NOT NULL,
  provider_customer_id text,
  provider_subscription_id text,
  current_period_end timestamptz,
  trial_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  -- set when the status enters past_due / unpaid (or canceled at period end); the enforcement job
  -- suspends the workspace once it passes
  grace_until timestamptz,
  -- the provider event's creation time of the last fact applied; older facts are ignored
  last_event_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_provider CHECK (provider IN ('manual', 'stripe')),
  CONSTRAINT subscription_status CHECK (
    status IN ('trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'paused')
  ),
  CONSTRAINT subscription_customer_length CHECK (
    provider_customer_id IS NULL OR char_length(provider_customer_id) BETWEEN 1 AND 255
  ),
  CONSTRAINT subscription_subscription_length CHECK (
    provider_subscription_id IS NULL OR char_length(provider_subscription_id) BETWEEN 1 AND 255
  ),
  CONSTRAINT subscription_version_positive CHECK (version >= 1)
);

CREATE UNIQUE INDEX subscription_provider_subscription_idx
  ON core.subscription (provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
CREATE INDEX subscription_provider_customer_idx
  ON core.subscription (provider_customer_id) WHERE provider_customer_id IS NOT NULL;
CREATE INDEX subscription_plan_idx ON core.subscription (plan_id);
CREATE INDEX subscription_grace_idx ON core.subscription (grace_until)
  WHERE grace_until IS NOT NULL;

CREATE TRIGGER subscription_set_updated_at BEFORE UPDATE ON core.subscription
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- The webhook finds the row by provider id before it knows the workspace, so the fence admits the
-- host. Tenant staff read their own (the billing page); only host and system write.
ALTER TABLE core.subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.subscription AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host');
CREATE POLICY subscription_staff_read ON core.subscription FOR SELECT
  USING (core.current_actor_kind() = 'staff');
CREATE POLICY subscription_write ON core.subscription FOR ALL
  USING (core.current_actor_kind() IN ('system', 'host'))
  WITH CHECK (core.current_actor_kind() IN ('system', 'host'));

--> statement-breakpoint
-- 6. Provider events already processed (dedupe; 90 days).
CREATE TABLE core.billing_event (
  -- the provider's event id (`evt_…`)
  id text PRIMARY KEY,
  provider text NOT NULL,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  -- the workspace it was mapped to, when it was; no FK (kept for its 90 days either way)
  workspace_id uuid,
  CONSTRAINT billing_event_id_length CHECK (char_length(id) BETWEEN 1 AND 255),
  CONSTRAINT billing_event_provider CHECK (provider IN ('manual', 'stripe')),
  CONSTRAINT billing_event_type_length CHECK (char_length(type) BETWEEN 1 AND 128)
);

CREATE INDEX billing_event_received_idx ON core.billing_event (received_at);

ALTER TABLE core.billing_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.billing_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.billing_event AS RESTRICTIVE FOR ALL
  USING (core.current_actor_kind() = 'host')
  WITH CHECK (core.current_actor_kind() = 'host');
CREATE POLICY billing_event_host ON core.billing_event FOR ALL
  USING (core.current_actor_kind() = 'host')
  WITH CHECK (core.current_actor_kind() = 'host');

--> statement-breakpoint
-- 7. Daily usage (written by `control-plane.usage-rollup`; 400 days).
CREATE TABLE core.tenant_usage_daily (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  day date NOT NULL,
  storage_bytes bigint NOT NULL DEFAULT 0,
  docs_viewed integer NOT NULL DEFAULT 0,
  emails_sent integer NOT NULL DEFAULT 0,
  staff_seats integer NOT NULL DEFAULT 0,
  investor_seats integer NOT NULL DEFAULT 0,
  custom_domains integer NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, day),
  CONSTRAINT tenant_usage_daily_non_negative CHECK (
    storage_bytes >= 0 AND docs_viewed >= 0 AND emails_sent >= 0 AND staff_seats >= 0
    AND investor_seats >= 0 AND custom_domains >= 0
  )
);

CREATE INDEX tenant_usage_daily_day_idx ON core.tenant_usage_daily (day);

ALTER TABLE core.tenant_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.tenant_usage_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.tenant_usage_daily AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host');
CREATE POLICY tenant_usage_daily_staff_read ON core.tenant_usage_daily FOR SELECT
  USING (core.current_actor_kind() = 'staff');
CREATE POLICY tenant_usage_daily_write ON core.tenant_usage_daily FOR ALL
  USING (core.current_actor_kind() IN ('system', 'host'))
  WITH CHECK (core.current_actor_kind() IN ('system', 'host'));

--> statement-breakpoint
-- 8. Sanctions screenings.
CREATE TABLE core.sanctions_screening (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  -- no FK: the record outlives the workspace (5 years; see the header)
  workspace_id uuid NOT NULL,
  subject_name text NOT NULL,
  subject_country text,
  provider text NOT NULL,
  -- the list snapshot and matcher it was screened against (`ofac:<sha256-12>:jw1`)
  list_version text NOT NULL,
  outcome text NOT NULL,
  -- SanctionsMatch[] (@seed-host/ports)
  matches jsonb NOT NULL DEFAULT '[]'::jsonb,
  matches_schema_version integer NOT NULL DEFAULT 1,
  decision text,
  -- the operator's user id
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sanctions_screening_subject_length CHECK (char_length(subject_name) BETWEEN 1 AND 300),
  CONSTRAINT sanctions_screening_country_format CHECK (
    subject_country IS NULL OR subject_country ~ '^[A-Z]{2}$'
  ),
  CONSTRAINT sanctions_screening_provider CHECK (provider IN ('ofac', 'opensanctions')),
  CONSTRAINT sanctions_screening_list_version_length CHECK (
    char_length(list_version) BETWEEN 1 AND 200
  ),
  CONSTRAINT sanctions_screening_outcome CHECK (outcome IN ('clear', 'potential_match', 'error')),
  CONSTRAINT sanctions_screening_matches_array CHECK (jsonb_typeof(matches) = 'array'),
  CONSTRAINT sanctions_screening_decision CHECK (
    decision IS NULL OR decision IN ('cleared', 'confirmed')
  ),
  -- A decision is made on a hit or an error, by somebody, at a time, with a reason.
  CONSTRAINT sanctions_screening_decision_shape CHECK (
    (decision IS NULL) = (decided_at IS NULL)
    AND (decision IS NULL) = (decided_by IS NULL)
    AND (decision IS NULL) = (decision_note IS NULL)
    AND (decision IS NULL OR outcome <> 'clear')
  ),
  CONSTRAINT sanctions_screening_note_length CHECK (
    decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 2000
  )
);

CREATE INDEX sanctions_screening_workspace_idx
  ON core.sanctions_screening (workspace_id, created_at DESC);
-- The operator queue: hits and errors nobody has decided.
CREATE INDEX sanctions_screening_open_idx ON core.sanctions_screening (created_at)
  WHERE outcome <> 'clear' AND decision IS NULL;

-- Operator data about the tenant: the tenant's own staff never see it, so there is no tenant
-- policy at all — the host alone reads and writes.
ALTER TABLE core.sanctions_screening ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.sanctions_screening FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.sanctions_screening AS RESTRICTIVE FOR ALL
  USING (core.current_actor_kind() = 'host')
  WITH CHECK (core.current_actor_kind() = 'host');
CREATE POLICY sanctions_screening_host ON core.sanctions_screening FOR ALL
  USING (core.current_actor_kind() = 'host')
  WITH CHECK (core.current_actor_kind() = 'host');

--> statement-breakpoint
-- 9. Central-auth sessions: bound to the workspace whose host received the handoff, ignored
-- everywhere else. An operator session is never bound (it serves no workspace at all).
ALTER TABLE core.session
  ADD COLUMN bound_workspace_id uuid REFERENCES core.workspace (id) ON DELETE CASCADE;
ALTER TABLE core.session ADD CONSTRAINT session_bound_shape CHECK (
  bound_workspace_id IS NULL OR population <> 'operator'
) NOT VALID;
ALTER TABLE core.session VALIDATE CONSTRAINT session_bound_shape;
CREATE INDEX session_bound_workspace_idx ON core.session (bound_workspace_id)
  WHERE bound_workspace_id IS NOT NULL;
-- The session a derived session was minted from (a central-auth handoff's canonical session, an
-- operator session's canonical session): signing the source out revokes what it minted. SET NULL
-- when the source row is purged — the derived session has its own lifetimes by then.
ALTER TABLE core.session
  ADD COLUMN source_session_id uuid REFERENCES core.session (id) ON DELETE SET NULL;
CREATE INDEX session_source_session_idx ON core.session (source_session_id)
  WHERE source_session_id IS NOT NULL;

--> statement-breakpoint
-- 10. Challenge kinds: the workspace host's central-auth request, the canonical host's handoff
-- code, and the signup email code. Last, and unused in this file (a new enum label cannot be used
-- before the transaction commits).
ALTER TYPE core.auth_challenge_kind ADD VALUE IF NOT EXISTS 'central_request';
ALTER TYPE core.auth_challenge_kind ADD VALUE IF NOT EXISTS 'central_handoff';
ALTER TYPE core.auth_challenge_kind ADD VALUE IF NOT EXISTS 'signup';
-- A new operator's enrolment link (`seedhost operator enrol-link`) and, once the mailbox is
-- proven, its 15-minute enrolment-only session (a factor can be added, nothing else).
ALTER TYPE core.auth_challenge_kind ADD VALUE IF NOT EXISTS 'operator_enrol';

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

SELECT core.apply_tenant_fence();
