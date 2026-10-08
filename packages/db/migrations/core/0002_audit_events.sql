-- 0002_audit_events — append-only hash-chained audit log, checkpoints, anchors, idempotency
-- keys (EXECUTION_PLAN §7, §10, ADR-0017, ADR-0027, E0.4).
--
-- Hand-written (ADR-0004). The TypeScript view of these tables is src/schema/audit.ts and
-- src/schema/core.ts. Runs inside one transaction. The runner calls core.apply_tenant_fence()
-- afterwards; every table here carries workspace_id and gets the standard fence. Host-level
-- (platform) audit rows use the reserved workspace id 00000000-0000-7000-8000-000000000000
-- and are written from a `system` context for that pseudo-workspace, so no custom fence is
-- needed and no tenant can ever read them.

CREATE SCHEMA audit;
GRANT USAGE ON SCHEMA audit TO seedhost_app;
-- Narrower than core on purpose: the application role appends and reads, never changes.
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT SELECT, INSERT ON TABLES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit GRANT EXECUTE ON FUNCTIONS TO seedhost_app;

--> statement-breakpoint
CREATE TYPE audit.outcome AS ENUM ('success', 'denied', 'failure');

-- The log. Monthly range partitions on occurred_at (audit.ensure_partitions creates them);
-- per-workspace chain position `seq`, previous hash and own hash assigned by audit.chain().
-- No FK to core.workspace: audit rows outlive the workspace (design/06 §10).
CREATE TABLE audit.event (
  id uuid NOT NULL DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL,
  seq bigint NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_kind text NOT NULL,
  actor_membership_id uuid,
  actor_user_id uuid,
  on_behalf_of_membership_id uuid,
  action text NOT NULL,
  resource_kind text NOT NULL,
  resource_id uuid,
  subject_membership_id uuid,
  outcome audit.outcome NOT NULL DEFAULT 'success',
  ip inet,
  user_agent text,
  request_id uuid,
  session_id uuid,
  diff jsonb,
  diff_schema_version integer NOT NULL DEFAULT 1,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  meta_schema_version integer NOT NULL DEFAULT 1,
  prev_hash bytea,
  hash bytea NOT NULL DEFAULT '\x'::bytea,
  PRIMARY KEY (workspace_id, occurred_at, id),
  CONSTRAINT event_action_format CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT event_resource_kind_format CHECK (resource_kind ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT event_actor_kind CHECK (actor_kind IN ('staff', 'external', 'system', 'host'))
) PARTITION BY RANGE (occurred_at);
CREATE INDEX event_workspace_seq_idx ON audit.event (workspace_id, seq);
CREATE INDEX event_workspace_action_idx ON audit.event (workspace_id, action, occurred_at);
CREATE INDEX event_workspace_resource_idx ON audit.event (workspace_id, resource_kind, resource_id, occurred_at)
  WHERE resource_id IS NOT NULL;
CREATE INDEX event_workspace_subject_idx ON audit.event (workspace_id, subject_membership_id, occurred_at)
  WHERE subject_membership_id IS NOT NULL;
CREATE INDEX event_workspace_actor_idx ON audit.event (workspace_id, actor_membership_id, occurred_at)
  WHERE actor_membership_id IS NOT NULL;
REVOKE UPDATE, DELETE, TRUNCATE ON audit.event FROM seedhost_app;

-- Chain head per workspace: O(1) lookup for the trigger and the next `seq`. Written only by
-- audit.chain() (SECURITY DEFINER); the app role may read it.
CREATE TABLE audit.chain_head (
  workspace_id uuid PRIMARY KEY,
  seq bigint NOT NULL,
  hash bytea NOT NULL,
  event_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit.chain_head FROM seedhost_app;

-- Daily snapshot of the chain head, HMAC-signed with a key that lives outside the database
-- (the config key ring), so a database superuser cannot silently rewrite history.
CREATE TABLE audit.checkpoint (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL,
  seq bigint NOT NULL,
  hash bytea NOT NULL,
  event_id uuid NOT NULL,
  head_occurred_at timestamptz NOT NULL,
  previous_checkpoint_id uuid REFERENCES audit.checkpoint (id),
  key_id text,
  signature bytea,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkpoint_workspace_idx ON audit.checkpoint (workspace_id, seq DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON audit.checkpoint FROM seedhost_app;

-- External anchors of a checkpoint (S3 object lock, RFC 3161, …); adapters land in Phase 2.
CREATE TABLE audit.anchor (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL,
  checkpoint_id uuid NOT NULL REFERENCES audit.checkpoint (id),
  kind text NOT NULL,
  reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anchor_kind_format CHECK (kind ~ '^[a-z][a-z0-9_-]*$')
);
CREATE INDEX anchor_checkpoint_idx ON audit.anchor (workspace_id, checkpoint_id);
REVOKE UPDATE, DELETE, TRUNCATE ON audit.anchor FROM seedhost_app;

--> statement-breakpoint
-- Canonical form of an event: a jsonb object with a fixed key set, rendered as text.
-- jsonb output is deterministic (keys sorted by length then bytes, fixed spacing), so this
-- text is what gets hashed and what an offline verifier receives verbatim in an export.
-- timestamptz is rendered in UTC with microseconds regardless of the session time zone;
-- bytea (prev_hash) is passed separately because its jsonb rendering depends on bytea_output.
CREATE FUNCTION audit.canonical(r jsonb, prev_hash bytea) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT jsonb_build_object(
    'id', r->>'id',
    'workspace_id', r->>'workspace_id',
    'seq', (r->>'seq')::bigint,
    'occurred_at', to_char((r->>'occurred_at')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_kind', r->>'actor_kind',
    'actor_membership_id', r->>'actor_membership_id',
    'actor_user_id', r->>'actor_user_id',
    'on_behalf_of_membership_id', r->>'on_behalf_of_membership_id',
    'action', r->>'action',
    'resource_kind', r->>'resource_kind',
    'resource_id', r->>'resource_id',
    'subject_membership_id', r->>'subject_membership_id',
    'outcome', r->>'outcome',
    'ip', r->>'ip',
    'user_agent', r->>'user_agent',
    'request_id', r->>'request_id',
    'session_id', r->>'session_id',
    'diff', r->'diff',
    'diff_schema_version', (r->>'diff_schema_version')::integer,
    'meta', r->'meta',
    'meta_schema_version', (r->>'meta_schema_version')::integer,
    'prev_hash', encode(prev_hash, 'hex')
  )::text
$$;

CREATE FUNCTION audit.digest(canonical text) RETURNS bytea
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT sha256(convert_to(canonical, 'UTF8'))
$$;

-- BEFORE INSERT: serialise per workspace on an advisory lock so concurrent inserts cannot
-- fork the chain, assign seq/prev_hash from the head, compute the hash, advance the head.
-- SECURITY DEFINER so the app role (which cannot write chain_head) can still append.
CREATE FUNCTION audit.chain() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, audit AS $$
DECLARE
  head audit.chain_head%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(24301, hashtext(NEW.workspace_id::text));
  SELECT * INTO head FROM audit.chain_head WHERE workspace_id = NEW.workspace_id FOR UPDATE;
  IF FOUND THEN
    NEW.seq := head.seq + 1;
    NEW.prev_hash := head.hash;
  ELSE
    NEW.seq := 1;
    NEW.prev_hash := NULL;
  END IF;
  NEW.hash := audit.digest(audit.canonical(to_jsonb(NEW), NEW.prev_hash));
  INSERT INTO audit.chain_head (workspace_id, seq, hash, event_id, occurred_at, updated_at)
  VALUES (NEW.workspace_id, NEW.seq, NEW.hash, NEW.id, NEW.occurred_at, now())
  ON CONFLICT (workspace_id) DO UPDATE SET seq = EXCLUDED.seq, hash = EXCLUDED.hash,
    event_id = EXCLUDED.event_id, occurred_at = EXCLUDED.occurred_at, updated_at = now();
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION audit.chain() FROM PUBLIC, seedhost_app;

CREATE FUNCTION audit.reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.% is append-only (%)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER event_chain BEFORE INSERT ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.chain();
CREATE TRIGGER event_immutable BEFORE UPDATE OR DELETE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER event_no_truncate BEFORE TRUNCATE ON audit.event
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER checkpoint_immutable BEFORE UPDATE OR DELETE ON audit.checkpoint
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER anchor_immutable BEFORE UPDATE OR DELETE ON audit.anchor
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();

--> statement-breakpoint
-- Partition maintenance. Creates audit.event_YYYYMM for `from_month` .. +months_ahead and
-- fences each partition like the parent (rows reached through a partition directly must be
-- fenced too). SECURITY DEFINER: the recorder calls it from the app role when its in-process
-- horizon is stale, the daily job calls it too. Serialised on an advisory lock.
CREATE FUNCTION audit.ensure_partitions(months_ahead integer DEFAULT 3, from_month date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, audit, core AS $$
DECLARE
  start_month date := COALESCE(date_trunc('month', from_month)::date, date_trunc('month', now())::date);
  m date;
  part text;
  n integer := 0;
BEGIN
  IF months_ahead < 0 OR months_ahead > 120 THEN
    RAISE EXCEPTION 'months_ahead must be between 0 and 120';
  END IF;
  PERFORM pg_advisory_xact_lock(24301, 2);
  FOR i IN 0..months_ahead LOOP
    m := (start_month + make_interval(months => i))::date;
    part := 'event_' || to_char(m, 'YYYYMM');
    IF to_regclass('audit.' || part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE audit.%I PARTITION OF audit.event FOR VALUES FROM (%L) TO (%L)',
        part, m, (m + interval '1 month')::date);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON audit.%I FROM seedhost_app', part);
      EXECUTE format('ALTER TABLE audit.%I ENABLE ROW LEVEL SECURITY', part);
      EXECUTE format('ALTER TABLE audit.%I FORCE ROW LEVEL SECURITY', part);
      EXECUTE format(
        'CREATE POLICY tenant_fence ON audit.%I AS RESTRICTIVE FOR ALL '
        'USING (workspace_id = core.current_workspace()) '
        'WITH CHECK (workspace_id = core.current_workspace())', part);
      EXECUTE format('CREATE POLICY %I ON audit.%I FOR ALL USING (true) WITH CHECK (true)',
        part || '_access', part);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Partitions whose upper bound is older than the retention window. Returns their names;
-- never touches rows. Legal-hold interplay (E1.3/E2.7) is enforced by the caller.
CREATE FUNCTION audit.expired_partitions(retention_months integer)
RETURNS TABLE (partition_name text, upper_bound date)
LANGUAGE sql STABLE AS $$
  SELECT c.relname::text,
         to_date(substring(c.relname FROM 'event_(\d{6})') || '01', 'YYYYMMDD') + interval '1 month'
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  JOIN pg_namespace n ON n.oid = p.relnamespace
  WHERE n.nspname = 'audit' AND p.relname = 'event' AND c.relname ~ '^event_\d{6}$'
    AND to_date(substring(c.relname FROM 'event_(\d{6})') || '01', 'YYYYMMDD') + interval '1 month'
        < date_trunc('month', now()) - make_interval(months => retention_months)
  ORDER BY 1
$$;

CREATE FUNCTION audit.drop_partition(partition_name text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, audit AS $$
BEGIN
  IF partition_name !~ '^event_\d{6}$' THEN
    RAISE EXCEPTION 'not an audit partition name: %', partition_name;
  END IF;
  IF to_regclass('audit.' || partition_name) IS NULL THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(24301, 2);
  EXECUTE format('DROP TABLE audit.%I', partition_name);
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION audit.drop_partition(text) FROM PUBLIC;

-- Walks one workspace's chain in seq order and recomputes every hash. Empty result = OK.
-- Stops at the first problem. Used by `seedhost-audit verify`; runs as the caller.
CREATE FUNCTION audit.verify_chain(ws uuid, from_seq bigint DEFAULT 1, to_seq bigint DEFAULT NULL)
RETURNS TABLE (checked bigint, bad_seq bigint, problem text)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  e record;
  expected_seq bigint := from_seq;
  expected_prev bytea := NULL;
  n bigint := 0;
BEGIN
  IF from_seq > 1 THEN
    SELECT hash INTO expected_prev FROM audit.event
    WHERE workspace_id = ws AND seq = from_seq - 1;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 0::bigint, from_seq - 1, 'predecessor missing';
      RETURN;
    END IF;
  END IF;
  FOR e IN
    SELECT * FROM audit.event
    WHERE workspace_id = ws AND seq >= from_seq AND (to_seq IS NULL OR seq <= to_seq)
    ORDER BY seq, occurred_at, id
  LOOP
    IF e.seq <> expected_seq THEN
      RETURN QUERY SELECT n, e.seq,
        CASE WHEN e.seq < expected_seq THEN 'duplicate seq' ELSE 'gap before seq' END;
      RETURN;
    END IF;
    IF e.prev_hash IS DISTINCT FROM expected_prev THEN
      RETURN QUERY SELECT n, e.seq, 'prev_hash does not match previous hash';
      RETURN;
    END IF;
    IF e.hash <> audit.digest(audit.canonical(to_jsonb(e), e.prev_hash)) THEN
      RETURN QUERY SELECT n, e.seq, 'hash mismatch (row altered)';
      RETURN;
    END IF;
    expected_prev := e.hash;
    expected_seq := e.seq + 1;
    n := n + 1;
  END LOOP;
  RETURN;
END $$;

-- Rows with their canonical text, for signed exports and offline verification.
CREATE FUNCTION audit.export_rows(ws uuid, from_seq bigint DEFAULT 1, to_seq bigint DEFAULT NULL)
RETURNS TABLE (seq bigint, canonical text, hash bytea)
LANGUAGE sql STABLE AS $$
  SELECT e.seq, audit.canonical(to_jsonb(e), e.prev_hash), e.hash
  FROM audit.event e
  WHERE e.workspace_id = ws AND e.seq >= from_seq AND (to_seq IS NULL OR e.seq <= to_seq)
  ORDER BY e.seq
$$;

SELECT audit.ensure_partitions(3);

--> statement-breakpoint
-- Idempotency keys (design/07 §6.2): a handler with side effects claims its key inside the
-- transaction that records the effect; a second delivery of the same job finds the key and
-- skips. workspace_id NULL = host-level, hence the outbox-style fence.
CREATE TABLE core.idempotency_key (
  key text PRIMARY KEY,
  workspace_id uuid REFERENCES core.workspace (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_key_format CHECK (length(key) BETWEEN 1 AND 512)
);
CREATE INDEX idempotency_key_expires_idx ON core.idempotency_key (expires_at);
ALTER TABLE core.idempotency_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.idempotency_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.idempotency_key AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host');
CREATE POLICY idempotency_key_access ON core.idempotency_key FOR ALL USING (true) WITH CHECK (true);

-- Outbox: the relay records dispatch facts; index for the processed-row sweep.
ALTER TABLE core.outbox ADD COLUMN dispatched integer NOT NULL DEFAULT 0;
CREATE INDEX outbox_processed_idx ON core.outbox (processed_at) WHERE processed_at IS NOT NULL;

--> statement-breakpoint
-- Fences for the audit tables: the standard workspace fence, declared here (rather than left
-- to the runner's post-step) so the tables are fenced before the partitions above exist and
-- before anything can read them. Platform rows live under PLATFORM_WORKSPACE_ID and are
-- reached through a system context for that pseudo-workspace; no context sees another's.
ALTER TABLE audit.event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON audit.event AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY event_access ON audit.event FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE audit.chain_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.chain_head FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON audit.chain_head AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY chain_head_access ON audit.chain_head FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE audit.checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.checkpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON audit.checkpoint AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY checkpoint_access ON audit.checkpoint FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE audit.anchor ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.anchor FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON audit.anchor AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY anchor_access ON audit.anchor FOR ALL USING (true) WITH CHECK (true);

--> statement-breakpoint
-- The catalog check now ignores pg-boss's schema: third-party tables, no workspace_id,
-- jsonb columns with no *_schema_version sibling by design, and the app role only touches
-- them through the queue adapter's grants.
CREATE OR REPLACE FUNCTION core.check_tenant_fence()
RETURNS TABLE (schema_name text, table_name text, problem text)
LANGUAGE sql STABLE AS $$
  WITH tenant_tables AS (
    SELECT n.nspname, c.relname, c.oid, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'public', 'pgboss')
      AND n.nspname NOT LIKE 'pg_%'
  ),
  app_tables AS (
    SELECT n.nspname, c.relname, c.oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'public', 'pgboss')
      AND n.nspname NOT LIKE 'pg_%'
  )
  SELECT nspname::text, relname::text, 'row level security not enabled' FROM tenant_tables WHERE NOT relrowsecurity
  UNION ALL
  SELECT nspname::text, relname::text, 'row level security not forced' FROM tenant_tables WHERE NOT relforcerowsecurity
  UNION ALL
  SELECT nspname::text, relname::text, 'missing tenant_fence policy' FROM tenant_tables t
    WHERE NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid AND p.polname = 'tenant_fence')
  UNION ALL
  SELECT nspname::text, relname::text, 'tenant_fence policy is permissive, must be RESTRICTIVE' FROM tenant_tables t
    WHERE EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid AND p.polname = 'tenant_fence' AND p.polpermissive)
  UNION ALL
  SELECT nspname::text, relname::text, 'seedhost_app lacks SELECT privilege' FROM app_tables t
    WHERE t.relname <> 'schema_migration'
      AND NOT has_table_privilege('seedhost_app', t.oid, 'SELECT')
  UNION ALL
  SELECT nspname::text, relname::text, 'jsonb column ' || a.attname || ' has no *_schema_version sibling' FROM app_tables t
    JOIN pg_attribute a ON a.attrelid = t.oid AND NOT a.attisdropped AND a.atttypid = 'jsonb'::regtype
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_attribute s WHERE s.attrelid = t.oid AND NOT s.attisdropped
        AND s.attname = a.attname || '_schema_version'
    )
  ORDER BY 1, 2, 3
$$;
