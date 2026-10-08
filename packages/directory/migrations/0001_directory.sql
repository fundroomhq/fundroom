-- 0001_directory — the shared cell directory (EXECUTION_PLAN §15 E3.11, ADR-0059).
--
-- Hand-written (ADR-0004). Applied by `runMigrations` (source id `directory`) against the
-- DIRECTORY database (DIRECTORY_DATABASE_URL), never against a cell's database. The runner keeps
-- its journal in that database's `core.schema_migration` and finds no `core.apply_tenant_fence()`
-- there, so no fence pass runs. The TypeScript side is @seed-host/directory.
--
-- The only thing shared between cells. No personal data: no emails, names or content — cells,
-- slugs, verified hostnames, workspace ids and move bookkeeping only. No RLS: the directory
-- database is operator infrastructure and every cell connects with the same role (cells trust
-- each other and the directory; same operator, same software — a stated deviation, not defended
-- against).
--
--  * cell       every cell of the deployment: region facts, public origin, status, heartbeat and
--               the public half of its export signing key (a move's target verifies the bundle
--               against the SOURCE cell's key from here, never a key inside the bundle).
--  * workspace  one entry per workspace ever placed: slug → cell. `workspace_id` is the CURRENT
--               cell-local id (an import remaps ids, so a move rewrites it at switchover). A slug
--               is unique among entries that are not deleted.
--  * hostname   VERIFIED custom hostnames only (a pending claim must not squat a rival's domain).
--  * move       one row per move between cells; at most one live move per entry.

--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS directory;

CREATE TABLE directory.cell (
  id text PRIMARY KEY,
  region text NOT NULL,
  region_label text NOT NULL DEFAULT '',
  jurisdiction text,
  -- the https origin an edge routes this cell's workspaces to
  public_origin text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  export_public_key text,
  -- every export public key of the cell's key ring, current first: [{ keyId, publicKey }]; a
  -- target matches a bundle's signerKeyFingerprint (= the manifest's keyId) against it
  export_public_keys jsonb NOT NULL DEFAULT '[]',
  export_public_keys_schema_version integer NOT NULL DEFAULT 1,
  heartbeat_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cell_id_format CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,30}$'),
  CONSTRAINT cell_region_length CHECK (char_length(region) BETWEEN 1 AND 64),
  CONSTRAINT cell_region_label_length CHECK (char_length(region_label) <= 120),
  CONSTRAINT cell_jurisdiction CHECK (
    jurisdiction IS NULL OR jurisdiction IN ('eu', 'uk', 'ch', 'us', 'ca', 'au', 'other')
  ),
  CONSTRAINT cell_public_origin_shape CHECK (
    public_origin = '' OR public_origin ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'
  ),
  CONSTRAINT cell_status CHECK (status IN ('active', 'draining', 'closed')),
  CONSTRAINT cell_export_public_key_length CHECK (
    export_public_key IS NULL OR char_length(export_public_key) BETWEEN 1 AND 4096
  ),
  CONSTRAINT cell_export_public_keys_array CHECK (
    jsonb_typeof(export_public_keys) = 'array' AND jsonb_array_length(export_public_keys) <= 64
  )
);

--> statement-breakpoint
CREATE TABLE directory.workspace (
  entry_id uuid PRIMARY KEY,
  -- the current cell-local `core.workspace.id`
  workspace_id uuid NOT NULL UNIQUE,
  slug text NOT NULL,
  cell_id text NOT NULL REFERENCES directory.cell (id),
  state text NOT NULL DEFAULT 'reserved',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  -- dormant: soft-deleted inside its restore window — holds the slug and hostnames, never routed
  CONSTRAINT workspace_state CHECK (state IN ('reserved', 'active', 'moving', 'dormant', 'deleted'))
);

CREATE UNIQUE INDEX workspace_slug_live_idx ON directory.workspace (slug) WHERE state <> 'deleted';
CREATE INDEX workspace_cell_idx ON directory.workspace (cell_id, state);
-- The reconcile sweep's stale reservations.
CREATE INDEX workspace_reserved_idx ON directory.workspace (created_at) WHERE state = 'reserved';

--> statement-breakpoint
CREATE TABLE directory.hostname (
  -- lower case
  hostname text PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES directory.workspace (entry_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hostname_lower CHECK (hostname = lower(hostname)),
  CONSTRAINT hostname_length CHECK (char_length(hostname) BETWEEN 1 AND 253)
);

CREATE INDEX hostname_entry_idx ON directory.hostname (entry_id);

--> statement-breakpoint
CREATE TABLE directory.move (
  id uuid PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES directory.workspace (entry_id),
  source_workspace_id uuid NOT NULL,
  slug text NOT NULL,
  source_cell_id text NOT NULL,
  target_cell_id text NOT NULL,
  state text NOT NULL DEFAULT 'requested',
  -- MoveBundle (@seed-host/ports): { url, sha256, bytes, expiresAt, signerKeyFingerprint }
  bundle jsonb,
  bundle_schema_version integer NOT NULL DEFAULT 1,
  -- MoveCarried (@seed-host/ports): { planId, legalName, country, holds, … }
  carried jsonb,
  carried_schema_version integer NOT NULL DEFAULT 1,
  target_workspace_id uuid,
  lease_owner text,
  lease_expires_at timestamptz,
  -- when the switchover rebound the entry (a carried hostname's keep window starts here)
  switched_at timestamptz,
  -- { stage, code }
  error jsonb,
  error_schema_version integer NOT NULL DEFAULT 1,
  -- an opaque operator reference, never an email
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT move_state CHECK (
    state IN ('requested', 'exporting', 'exported', 'importing', 'imported', 'switched', 'retired',
              'failed', 'cancelled')
  ),
  CONSTRAINT move_cells_differ CHECK (source_cell_id <> target_cell_id),
  CONSTRAINT move_bundle_object CHECK (bundle IS NULL OR jsonb_typeof(bundle) = 'object'),
  CONSTRAINT move_carried_object CHECK (carried IS NULL OR jsonb_typeof(carried) = 'object'),
  CONSTRAINT move_error_object CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  CONSTRAINT move_lease_shape CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT move_requested_by_length CHECK (char_length(requested_by) BETWEEN 1 AND 200)
);

-- One live move per workspace entry.
CREATE UNIQUE INDEX move_live_entry_idx ON directory.move (entry_id)
  WHERE state NOT IN ('retired', 'failed', 'cancelled');
CREATE INDEX move_source_idx ON directory.move (source_cell_id, state);
CREATE INDEX move_target_idx ON directory.move (target_cell_id, state);
CREATE INDEX move_source_workspace_idx ON directory.move (source_workspace_id, created_at DESC);
