-- 0001_dataroom — the data room: folders (ltree), content-addressed blobs, documents with
-- immutable versions, derived renditions, extracted page text, staged uploads
-- (EXECUTION_PLAN §7 "dataroom", §8, design/06 §2.2 + §4, design/02 §4, ADR-0034, E1.3).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/dataroom.ts. Runs inside one
-- transaction. Tenant tables declare the standard fence inline so nothing can read a row
-- before the runner's core.apply_tenant_fence() pass.
--
-- Model:
--  * folder            one root per workspace (parent_id NULL), then a tree. `path` is the
--                      materialised ltree path (root label `r`, then the folder id without
--                      hyphens per level) that grants inherit along (core.has_access).
--  * blob              bytes live in object storage under `ws/<ws>/blobs/<sha256>` encrypted
--                      as SHE1 under the workspace DEK; this row is metadata + the scan
--                      state machine. Content-addressed within the workspace only.
--  * document          a titled node in a folder; `folder_path` mirrors the folder's path so
--                      RLS and the evaluator can resolve inherited grants without a join.
--  * document_version  immutable; `current_version_id` on the document points at the live one.
--  * rendition         regenerable artefacts (thumbnail, page images, sanitised PDF).
--  * page_text         extracted text per page for in-document search.
--  * upload            a staged upload: the app names the quarantine key, the client streams
--                      bytes to it (tus or presigned multipart), `complete` turns it into
--                      blob + version and the ingest job scans, sanitises and promotes it.

CREATE SCHEMA IF NOT EXISTS dataroom;
GRANT USAGE ON SCHEMA dataroom TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA dataroom GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA dataroom GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA dataroom GRANT EXECUTE ON FUNCTIONS TO seedhost_app;

CREATE TYPE dataroom.scan_status AS ENUM ('pending', 'scanning', 'clean', 'infected', 'error', 'skipped');
CREATE TYPE dataroom.render_status AS ENUM ('pending', 'ready', 'unsupported', 'failed');
CREATE TYPE dataroom.upload_status AS ENUM ('pending', 'stored', 'completed', 'aborted', 'expired', 'failed');

--> statement-breakpoint
CREATE TABLE dataroom.folder (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  parent_id uuid REFERENCES dataroom.folder (id) ON DELETE CASCADE,
  name text NOT NULL,
  path ltree NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  purge_after timestamptz,
  CONSTRAINT folder_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT folder_root_shape CHECK ((parent_id IS NULL) = (nlevel(path) = 1))
);
CREATE UNIQUE INDEX folder_root_idx ON dataroom.folder (workspace_id) WHERE parent_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX folder_name_idx ON dataroom.folder (workspace_id, parent_id, lower(name)) WHERE deleted_at IS NULL AND parent_id IS NOT NULL;
CREATE UNIQUE INDEX folder_path_idx ON dataroom.folder (workspace_id, path);
CREATE INDEX folder_path_gist_idx ON dataroom.folder USING gist (path);
CREATE INDEX folder_parent_idx ON dataroom.folder (workspace_id, parent_id, sort_order) WHERE deleted_at IS NULL;
CREATE TRIGGER folder_set_updated_at BEFORE UPDATE ON dataroom.folder
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE dataroom.blob (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  sha256 bytea NOT NULL,
  size_bytes bigint NOT NULL,
  content_type text NOT NULL,
  -- ws/<ws>/blobs/<sha256>; the object is SHE1 ciphertext (ADR-0028)
  storage_key text NOT NULL,
  -- { format: "she1", keyId, keyRef, header (base64, 21 bytes) }
  encryption jsonb NOT NULL DEFAULT '{}',
  encryption_schema_version integer NOT NULL DEFAULT 1,
  scan_status dataroom.scan_status NOT NULL DEFAULT 'pending',
  scanned_at timestamptz,
  scan_engine text,
  scan_detail text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- two-phase purge: set first, object deleted, then the row goes
  purge_after timestamptz,
  CONSTRAINT blob_sha256_length CHECK (octet_length(sha256) = 32),
  CONSTRAINT blob_size_nonnegative CHECK (size_bytes >= 0),
  CONSTRAINT blob_sha256_unique UNIQUE (workspace_id, sha256)
);
CREATE INDEX blob_scan_idx ON dataroom.blob (workspace_id, scan_status);

CREATE TABLE dataroom.document (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  folder_id uuid NOT NULL REFERENCES dataroom.folder (id),
  folder_path ltree NOT NULL,
  title text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  current_version_id uuid,
  -- { download: bool, watermark: bool, print: bool } (design/06 §2.2)
  protection jsonb NOT NULL DEFAULT '{"download": false, "watermark": true, "print": false}',
  protection_schema_version integer NOT NULL DEFAULT 1,
  legal_hold boolean NOT NULL DEFAULT false,
  legal_hold_reason text,
  legal_hold_set_by uuid,
  legal_hold_set_at timestamptz,
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', title)) STORED,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  purge_after timestamptz,
  CONSTRAINT document_title_length CHECK (char_length(title) BETWEEN 1 AND 300)
);
CREATE INDEX document_folder_idx ON dataroom.document (workspace_id, folder_id, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX document_path_gist_idx ON dataroom.document USING gist (folder_path);
CREATE INDEX document_search_idx ON dataroom.document USING gin (search_tsv);
CREATE INDEX document_trash_idx ON dataroom.document (workspace_id, purge_after) WHERE deleted_at IS NOT NULL;
CREATE TRIGGER document_set_updated_at BEFORE UPDATE ON dataroom.document
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE dataroom.document_version (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES dataroom.document (id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  blob_id uuid NOT NULL REFERENCES dataroom.blob (id),
  file_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  page_count integer,
  render_status dataroom.render_status NOT NULL DEFAULT 'pending',
  render_detail text,
  change_note text,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_version_no_positive CHECK (version_no >= 1),
  CONSTRAINT document_version_unique_no UNIQUE (document_id, version_no),
  CONSTRAINT document_version_file_name_length CHECK (char_length(file_name) BETWEEN 1 AND 255),
  CONSTRAINT document_version_note_length CHECK (change_note IS NULL OR char_length(change_note) <= 500)
);
CREATE INDEX document_version_blob_idx ON dataroom.document_version (workspace_id, blob_id);

ALTER TABLE dataroom.document
  ADD CONSTRAINT document_current_version_fk FOREIGN KEY (current_version_id)
    REFERENCES dataroom.document_version (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE dataroom.rendition (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES dataroom.document_version (id) ON DELETE CASCADE,
  kind text NOT NULL,
  page_no integer,
  width integer,
  height integer,
  content_type text NOT NULL,
  storage_key text NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rendition_kind CHECK (kind IN ('thumbnail', 'page', 'pdf')),
  CONSTRAINT rendition_page_shape CHECK ((kind = 'page') = (page_no IS NOT NULL)),
  CONSTRAINT rendition_unique UNIQUE NULLS NOT DISTINCT (version_id, kind, page_no)
);

CREATE TABLE dataroom.page_text (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES dataroom.document_version (id) ON DELETE CASCADE,
  page_no integer NOT NULL,
  text text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED,
  PRIMARY KEY (workspace_id, version_id, page_no)
);
CREATE INDEX page_text_tsv_idx ON dataroom.page_text USING gin (tsv);

CREATE TABLE dataroom.upload (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  folder_id uuid REFERENCES dataroom.folder (id) ON DELETE SET NULL,
  document_id uuid REFERENCES dataroom.document (id) ON DELETE SET NULL,
  file_name text NOT NULL,
  declared_size bigint NOT NULL,
  declared_type text NOT NULL,
  change_note text,
  method text NOT NULL,
  -- ws/<ws>/quarantine/<upload id>
  storage_key text NOT NULL,
  multipart_upload_id text,
  status dataroom.upload_status NOT NULL DEFAULT 'pending',
  blob_id uuid REFERENCES dataroom.blob (id) ON DELETE SET NULL,
  version_id uuid REFERENCES dataroom.document_version (id) ON DELETE SET NULL,
  error text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT upload_method CHECK (method IN ('tus', 'multipart')),
  -- a target while the bytes are in flight; afterwards the document may be purged (FK SET NULL)
  CONSTRAINT upload_target CHECK (num_nonnulls(folder_id, document_id) >= 1 OR status <> 'pending'),
  CONSTRAINT upload_declared_size CHECK (declared_size >= 0),
  CONSTRAINT upload_file_name_length CHECK (char_length(file_name) BETWEEN 1 AND 255)
);
CREATE INDEX upload_status_idx ON dataroom.upload (workspace_id, status, expires_at);

--> statement-breakpoint
-- Legal hold (design/06 §4): a held document cannot be soft-deleted, hard-deleted, nor lose
-- versions until the hold is cleared (an audited action with a reason).
CREATE OR REPLACE FUNCTION dataroom.forbid_delete_under_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.legal_hold THEN
    RAISE EXCEPTION 'dataroom.document % is under legal hold', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER document_hold_delete BEFORE DELETE ON dataroom.document
  FOR EACH ROW EXECUTE FUNCTION dataroom.forbid_delete_under_hold();

CREATE OR REPLACE FUNCTION dataroom.forbid_soft_delete_under_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.legal_hold AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    RAISE EXCEPTION 'dataroom.document % is under legal hold', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_hold_soft_delete BEFORE UPDATE ON dataroom.document
  FOR EACH ROW EXECUTE FUNCTION dataroom.forbid_soft_delete_under_hold();

CREATE OR REPLACE FUNCTION dataroom.forbid_version_delete_under_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM dataroom.document d WHERE d.id = OLD.document_id AND d.legal_hold) THEN
    RAISE EXCEPTION 'dataroom.document_version % belongs to a document under legal hold', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER document_version_hold_delete BEFORE DELETE ON dataroom.document_version
  FOR EACH ROW EXECUTE FUNCTION dataroom.forbid_version_delete_under_hold();

--> statement-breakpoint
-- Row-level security. Staff and system actors work on every row of their workspace. An
-- external actor (investor, delegate) reads live folders and documents it holds `view` on
-- through core.effective_access (direct rows by id; folder rows by path, ADR-0034), the
-- current version of those documents, and their renditions and page text. Blobs and
-- uploads are staff/system only: bytes are always served by the app after `AuthzPort.check()`.
ALTER TABLE dataroom.folder ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataroom.folder FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON dataroom.folder AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY folder_staff ON dataroom.folder FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY folder_external_read ON dataroom.folder FOR SELECT
  USING (core.current_actor_kind() = 'external' AND deleted_at IS NULL AND core.has_access('folder', id, path, 'view'));

ALTER TABLE dataroom.blob ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataroom.blob FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON dataroom.blob AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY blob_staff ON dataroom.blob FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE dataroom.document ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataroom.document FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON dataroom.document AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY document_staff ON dataroom.document FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY document_external_read ON dataroom.document FOR SELECT
  USING (core.current_actor_kind() = 'external' AND deleted_at IS NULL AND core.has_access('document', id, folder_path, 'view'));

ALTER TABLE dataroom.document_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataroom.document_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON dataroom.document_version AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY document_version_staff ON dataroom.document_version FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY document_version_external_read ON dataroom.document_version FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND EXISTS (SELECT 1 FROM dataroom.document d WHERE d.id = document_version.document_id AND d.current_version_id = document_version.id)
  );

ALTER TABLE dataroom.rendition ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataroom.rendition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON dataroom.rendition AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY rendition_staff ON dataroom.rendition FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY rendition_external_read ON dataroom.rendition FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND EXISTS (SELECT 1 FROM dataroom.document_version v WHERE v.id = rendition.version_id)
  );

ALTER TABLE dataroom.page_text ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataroom.page_text FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON dataroom.page_text AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY page_text_staff ON dataroom.page_text FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY page_text_external_read ON dataroom.page_text FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND EXISTS (SELECT 1 FROM dataroom.document_version v WHERE v.id = page_text.version_id)
  );

ALTER TABLE dataroom.upload ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataroom.upload FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON dataroom.upload AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY upload_staff ON dataroom.upload FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

SELECT core.apply_tenant_fence();
