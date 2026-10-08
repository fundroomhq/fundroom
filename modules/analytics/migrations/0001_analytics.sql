-- 0001_analytics — engagement analytics: view sessions, monthly-partitioned engagement
-- events, the page-dwell heartbeat table, per-viewer and per-day rollups
-- (EXECUTION_PLAN §15 E1.5, design/03 C2/G2, design/04 analytics modes, design/06 §6).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/analytics.ts. Runs inside one
-- transaction. Tenant tables declare the standard fence inline so nothing can read a row
-- before the runner's core.apply_tenant_fence() pass.
--
-- Model:
--  * view_session            one row per (workspace, kernel session): `session_key` is the
--                            sha256 of the session id (never the id itself), `ip_hash` an
--                            HMAC-SHA256 of the client IP under the workspace key for the
--                            purpose `analytics-ip`, `ua_family` a browser family only. No
--                            raw IP, no raw user agent, no email, no name — ids only.
--  * event                   the raw engagement event, PARTITION BY RANGE (occurred_at)
--                            monthly (analytics.ensure_partitions). Types: document_viewed,
--                            page_viewed (coalesced dwell), document_downloaded, update_viewed.
--                            Retained `analytics.retentionMonths` months, then the partition
--                            is dropped; rows of a member can be deleted (DSAR), so unlike
--                            audit.event UPDATE/DELETE are not revoked.
--  * page_open               heartbeat coalescing: one row per (session, resource, page) with
--                            the summed dwell; flushed to a `page_viewed` event on close or
--                            after two minutes of silence.
--  * viewer_resource_rollup  "who viewed the deck, how long, which pages": per (member,
--                            resource) counts, dwell, furthest page, pages seen.
--  * daily_resource_rollup   per (day, resource) counts for dashboards; kept indefinitely
--                            (counts only, no identity).
--  * rollup_cursor           keyset position of the incremental rollup job per workspace.
--
-- Access: staff and system actors only. Investors never read analytics tables (their own
-- heartbeats are written by the API as `system`); the portal's transparency notice is
-- derived from the workspace setting, not from these rows.

CREATE SCHEMA IF NOT EXISTS analytics;
GRANT USAGE ON SCHEMA analytics TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT EXECUTE ON FUNCTIONS TO seedhost_app;

--> statement-breakpoint
CREATE TABLE analytics.view_session (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  -- sha256(kernel session id) or, for server-side facts without a session, a synthetic
  -- per-(membership, day) key; the raw session id is never stored here
  session_key bytea NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- HMAC-SHA256(client ip) under the workspace `analytics-ip` key; NULL for server-side facts
  ip_hash bytea,
  -- chrome | safari | firefox | edge | other
  ua_family text,
  embed boolean NOT NULL DEFAULT false,
  CONSTRAINT view_session_key_unique UNIQUE (workspace_id, session_key),
  CONSTRAINT view_session_key_length CHECK (octet_length(session_key) = 32),
  CONSTRAINT view_session_ua_family CHECK (ua_family IS NULL OR ua_family IN ('chrome', 'safari', 'firefox', 'edge', 'other'))
);
CREATE INDEX view_session_membership_idx ON analytics.view_session (workspace_id, membership_id, last_seen_at DESC);

CREATE TABLE analytics.event (
  id uuid NOT NULL DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  view_session_id uuid,
  membership_id uuid NOT NULL,
  type text NOT NULL,
  resource_kind text NOT NULL,
  resource_id uuid NOT NULL,
  version_id uuid,
  page_no integer,
  duration_ms integer,
  props jsonb NOT NULL DEFAULT '{}'::jsonb,
  props_schema_version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, occurred_at, id),
  CONSTRAINT event_type CHECK (type IN ('document_viewed', 'page_viewed', 'document_downloaded', 'update_viewed')),
  CONSTRAINT event_resource_kind CHECK (resource_kind IN ('document', 'post')),
  CONSTRAINT event_page_no_positive CHECK (page_no IS NULL OR page_no >= 1),
  CONSTRAINT event_duration_nonnegative CHECK (duration_ms IS NULL OR duration_ms >= 0)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX event_resource_idx ON analytics.event (workspace_id, resource_id, occurred_at DESC);
CREATE INDEX event_membership_idx ON analytics.event (workspace_id, membership_id, occurred_at DESC);

CREATE TABLE analytics.page_open (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  view_session_id uuid NOT NULL REFERENCES analytics.view_session (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  resource_kind text NOT NULL,
  resource_id uuid NOT NULL,
  version_id uuid,
  page_no integer NOT NULL,
  duration_ms integer NOT NULL DEFAULT 0,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, view_session_id, resource_id, page_no),
  CONSTRAINT page_open_resource_kind CHECK (resource_kind IN ('document', 'post')),
  CONSTRAINT page_open_page_no_positive CHECK (page_no >= 1)
);
CREATE INDEX page_open_last_at_idx ON analytics.page_open (workspace_id, last_at);

CREATE TABLE analytics.viewer_resource_rollup (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  resource_kind text NOT NULL,
  resource_id uuid NOT NULL,
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  views integer NOT NULL DEFAULT 0,
  downloads integer NOT NULL DEFAULT 0,
  total_ms bigint NOT NULL DEFAULT 0,
  max_page_reached integer,
  pages_seen integer[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (workspace_id, membership_id, resource_id),
  CONSTRAINT viewer_rollup_resource_kind CHECK (resource_kind IN ('document', 'post'))
);
CREATE INDEX viewer_rollup_resource_idx ON analytics.viewer_resource_rollup (workspace_id, resource_id, last_at DESC);

CREATE TABLE analytics.daily_resource_rollup (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  day date NOT NULL,
  resource_kind text NOT NULL,
  resource_id uuid NOT NULL,
  views integer NOT NULL DEFAULT 0,
  unique_viewers integer NOT NULL DEFAULT 0,
  total_ms bigint NOT NULL DEFAULT 0,
  downloads integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, resource_id),
  CONSTRAINT daily_rollup_resource_kind CHECK (resource_kind IN ('document', 'post'))
);
CREATE INDEX daily_rollup_resource_idx ON analytics.daily_resource_rollup (workspace_id, resource_id, day DESC);

CREATE TABLE analytics.rollup_cursor (
  workspace_id uuid PRIMARY KEY REFERENCES core.workspace (id) ON DELETE CASCADE,
  last_occurred_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  last_event_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER rollup_cursor_set_updated_at BEFORE UPDATE ON analytics.rollup_cursor
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

--> statement-breakpoint
-- Partition maintenance, cloned from audit.ensure_partitions (0002_audit_events.sql):
-- creates analytics.event_YYYYMM for `from_month` .. +months_ahead and fences each
-- partition like the parent. SECURITY DEFINER so the daily job can run it from the app role.
-- Unlike audit, UPDATE/DELETE stay granted: analytics rows are deleted on a DSAR request.
CREATE FUNCTION analytics.ensure_partitions(months_ahead integer DEFAULT 3, from_month date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, analytics, core AS $$
DECLARE
  start_month date := COALESCE(date_trunc('month', from_month)::date, date_trunc('month', now())::date);
  m date;
  part text;
  n integer := 0;
BEGIN
  IF months_ahead < 0 OR months_ahead > 120 THEN
    RAISE EXCEPTION 'months_ahead must be between 0 and 120';
  END IF;
  PERFORM pg_advisory_xact_lock(24302, 2);
  FOR i IN 0..months_ahead LOOP
    m := (start_month + make_interval(months => i))::date;
    part := 'event_' || to_char(m, 'YYYYMM');
    IF to_regclass('analytics.' || part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE analytics.%I PARTITION OF analytics.event FOR VALUES FROM (%L) TO (%L)',
        part, m, (m + interval '1 month')::date);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.%I TO seedhost_app', part);
      EXECUTE format('ALTER TABLE analytics.%I ENABLE ROW LEVEL SECURITY', part);
      EXECUTE format('ALTER TABLE analytics.%I FORCE ROW LEVEL SECURITY', part);
      EXECUTE format(
        'CREATE POLICY tenant_fence ON analytics.%I AS RESTRICTIVE FOR ALL '
        'USING (workspace_id = core.current_workspace()) '
        'WITH CHECK (workspace_id = core.current_workspace())', part);
      EXECUTE format(
        'CREATE POLICY %I ON analytics.%I FOR ALL '
        'USING (core.current_actor_kind() IN (''staff'', ''system'')) '
        'WITH CHECK (core.current_actor_kind() IN (''staff'', ''system''))',
        part || '_staff', part);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Partitions whose upper bound is older than the retention window. Returns their names;
-- never touches rows. Partitions are shared by every workspace, so the caller passes the
-- shortest retention among workspaces (analytics.maintain).
CREATE FUNCTION analytics.expired_partitions(retention_months integer)
RETURNS TABLE (partition_name text, upper_bound date)
LANGUAGE sql STABLE AS $$
  SELECT c.relname::text,
         (to_date(substring(c.relname FROM 'event_(\d{6})') || '01', 'YYYYMMDD') + interval '1 month')::date
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  JOIN pg_namespace n ON n.oid = p.relnamespace
  WHERE n.nspname = 'analytics' AND p.relname = 'event' AND c.relname ~ '^event_\d{6}$'
    AND to_date(substring(c.relname FROM 'event_(\d{6})') || '01', 'YYYYMMDD') + interval '1 month'
        < date_trunc('month', now()) - make_interval(months => retention_months)
  ORDER BY 1
$$;

CREATE FUNCTION analytics.drop_partition(partition_name text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, analytics AS $$
BEGIN
  IF partition_name !~ '^event_\d{6}$' THEN
    RAISE EXCEPTION 'not an analytics partition name: %', partition_name;
  END IF;
  IF to_regclass('analytics.' || partition_name) IS NULL THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(24302, 2);
  EXECUTE format('DROP TABLE analytics.%I', partition_name);
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION analytics.drop_partition(text) FROM PUBLIC;

--> statement-breakpoint
-- Row-level security: staff and system actors only, always inside the workspace fence.
ALTER TABLE analytics.view_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.view_session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON analytics.view_session AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY view_session_staff ON analytics.view_session FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE analytics.event ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON analytics.event AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY event_staff ON analytics.event FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE analytics.page_open ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.page_open FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON analytics.page_open AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY page_open_staff ON analytics.page_open FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE analytics.viewer_resource_rollup ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.viewer_resource_rollup FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON analytics.viewer_resource_rollup AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY viewer_rollup_staff ON analytics.viewer_resource_rollup FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE analytics.daily_resource_rollup ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.daily_resource_rollup FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON analytics.daily_resource_rollup AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY daily_rollup_staff ON analytics.daily_resource_rollup FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE analytics.rollup_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics.rollup_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON analytics.rollup_cursor AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY rollup_cursor_staff ON analytics.rollup_cursor FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
SELECT analytics.ensure_partitions(3);

SELECT core.apply_tenant_fence();
