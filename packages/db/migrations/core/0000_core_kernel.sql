-- 0000_core_kernel — tenancy kernel: schema, uuidv7 shim, tenant-context functions,
-- app role, workspace / module_enablement / outbox, RLS fence helper.
--
-- Hand-written (ADR-0004). The TypeScript view of these tables is src/schema/core.ts.
-- Runs inside one transaction. The journal table core.schema_migration is created by
-- the runner before this file is applied.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS core;

--> statement-breakpoint
-- uuidv7(): native on PostgreSQL 18; RFC 9562 shim on 16/17 with the same bit layout
-- (48-bit unix ms, ver=7, 74 random bits, RFC variant). Callers always use core.uuidv7().
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pg_catalog' AND p.proname = 'uuidv7' AND p.pronargs = 0
  ) THEN
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION core.uuidv7() RETURNS uuid
      LANGUAGE sql VOLATILE PARALLEL SAFE AS 'SELECT pg_catalog.uuidv7()'
    $f$;
  ELSE
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION core.uuidv7() RETURNS uuid
      LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $body$
      DECLARE
        ts_ms bytea;
        rnd bytea;
        b bytea;
      BEGIN
        -- 48-bit big-endian unix timestamp in milliseconds
        ts_ms := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3);
        -- 10 fully random bytes: take the bytes of a v4 uuid that carry no fixed bits
        rnd := uuid_send(gen_random_uuid());
        b := ts_ms || substring(rnd FROM 1 FOR 6) || substring(rnd FROM 11 FOR 4);
        -- version 7 in the high nibble of byte 6, RFC variant (10xx) in byte 8
        b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);
        b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);
        RETURN encode(b, 'hex')::uuid;
      END
      $body$
    $f$;
  END IF;
END
$do$;

--> statement-breakpoint
-- Transaction-local tenant context. set_config(..., true) from withTenant(); unset => NULL.
CREATE OR REPLACE FUNCTION core.current_workspace() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION core.current_membership() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.membership_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION core.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- 'staff' | 'external' | 'system' | 'host'; NULL when unset.
CREATE OR REPLACE FUNCTION core.current_actor_kind() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE AS
$$ SELECT NULLIF(current_setting('app.actor_kind', true), '') $$;

CREATE OR REPLACE FUNCTION core.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

--> statement-breakpoint
-- The application role. Queries run as this NOLOGIN role via `SET LOCAL ROLE` inside every
-- withTenant()/withHost() transaction, so RLS applies even when DATABASE_URL is the table
-- owner or a superuser (ADR-0025). The migrating user becomes a member so it can switch.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seedhost_app') THEN
    CREATE ROLE seedhost_app NOLOGIN NOINHERIT NOBYPASSRLS;
  END IF;
END
$do$;
GRANT seedhost_app TO CURRENT_USER;

GRANT USAGE ON SCHEMA core TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT EXECUTE ON FUNCTIONS TO seedhost_app;

--> statement-breakpoint
CREATE TYPE core.offering_status AS ENUM ('none', 'informational', '506b', '506c', 'non_us');

CREATE TABLE core.workspace (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  slug citext NOT NULL,
  name text NOT NULL,
  offering_status core.offering_status NOT NULL DEFAULT 'none',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings_schema_version integer NOT NULL DEFAULT 1,
  acl_version bigint NOT NULL DEFAULT 0,
  kms_key_ref text,
  data_region text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT workspace_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
);
CREATE UNIQUE INDEX workspace_slug_active_idx ON core.workspace (slug) WHERE deleted_at IS NULL;
CREATE TRIGGER workspace_set_updated_at BEFORE UPDATE ON core.workspace
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE core.module_enablement (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  module text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_schema_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, module),
  CONSTRAINT module_enablement_module_format CHECK (module ~ '^[a-z][a-z0-9-]*$')
);
CREATE TRIGGER module_enablement_set_updated_at BEFORE UPDATE ON core.module_enablement
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE core.outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid REFERENCES core.workspace (id) ON DELETE CASCADE,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  payload_schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX outbox_pending_idx ON core.outbox (available_at, id) WHERE processed_at IS NULL;
CREATE INDEX outbox_workspace_idx ON core.outbox (workspace_id, id);

-- The journal is created by the runner (IF NOT EXISTS) so it exists before any file runs;
-- this keeps the schema declared here too. Only the migrator writes it.
CREATE TABLE IF NOT EXISTS core.schema_migration (
  module text NOT NULL,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL,
  PRIMARY KEY (module, name)
);
REVOKE INSERT, UPDATE, DELETE ON core.schema_migration FROM seedhost_app;

--> statement-breakpoint
-- Row-level security.
--
-- core.apply_tenant_fence(): every table with a workspace_id column in a non-system schema
-- gets ENABLE + FORCE ROW LEVEL SECURITY and a RESTRICTIVE policy named tenant_fence
-- (workspace_id = core.current_workspace()). Unset context => zero rows, never all rows.
-- A table that needs a different fence creates its own policy *named tenant_fence* in its
-- migration; the helper leaves existing policies alone. The runner calls this after every
-- migration run; core.check_tenant_fence() is the CI catalog assertion.
CREATE OR REPLACE FUNCTION core.apply_tenant_fence() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  t record;
  n integer := 0;
BEGIN
  FOR t IN
    SELECT n.nspname AS schema_name, c.relname AS table_name, c.oid AS oid,
           c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
      AND n.nspname NOT LIKE 'pg_%'
    ORDER BY 1, 2
  LOOP
    IF NOT t.relrowsecurity THEN
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schema_name, t.table_name);
    END IF;
    IF NOT t.relforcerowsecurity THEN
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', t.schema_name, t.table_name);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = t.oid AND p.polname = 'tenant_fence') THEN
      EXECUTE format(
        'CREATE POLICY tenant_fence ON %I.%I AS RESTRICTIVE FOR ALL '
        'USING (workspace_id = core.current_workspace()) '
        'WITH CHECK (workspace_id = core.current_workspace())',
        t.schema_name, t.table_name);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Returns one row per problem; empty result = catalog is clean.
CREATE OR REPLACE FUNCTION core.check_tenant_fence()
RETURNS TABLE (schema_name text, table_name text, problem text)
LANGUAGE sql STABLE AS $$
  WITH tenant_tables AS (
    SELECT n.nspname, c.relname, c.oid, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
      AND n.nspname NOT LIKE 'pg_%'
  ),
  app_tables AS (
    SELECT n.nspname, c.relname, c.oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
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

--> statement-breakpoint
-- Custom fences for the kernel tables that are not the plain workspace_id shape.
--
-- workspace is a global table (no workspace_id) but must not enumerate tenants: a tenant
-- context sees only its own row; the host context (tenant resolution, setup) sees all.
ALTER TABLE core.workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.workspace FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.workspace AS RESTRICTIVE FOR ALL
  USING (id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (id = core.current_workspace() OR core.current_actor_kind() = 'host');
CREATE POLICY workspace_access ON core.workspace FOR ALL USING (true) WITH CHECK (true);

-- outbox: tenant context sees its own rows; the relay runs in host context and sees all.
ALTER TABLE core.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.outbox AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host');
CREATE POLICY outbox_access ON core.outbox FOR ALL USING (true) WITH CHECK (true);

-- module_enablement gets the standard fence from the helper, plus a permissive policy so
-- that the RESTRICTIVE fence has something to AND with (RLS with only restrictive policies
-- denies everything).
CREATE POLICY module_enablement_access ON core.module_enablement FOR ALL USING (true) WITH CHECK (true);

SELECT core.apply_tenant_fence();
