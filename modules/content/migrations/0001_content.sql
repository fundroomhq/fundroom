-- 0001_content — the investor overview page: pages, immutable revisions, section visibility
-- (EXECUTION_PLAN §7 "content", design/06 §8, ADR-0033, E1.2).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/content.ts. Runs inside one
-- transaction. Tenant tables declare the standard fence inline so nothing can read a row
-- before the runner's core.apply_tenant_fence() pass.
--
-- Model:
--  * page                one row per page; `home` is the investor landing page (one per
--                        workspace), `custom` pages are addressed by slug. The draft and the
--                        published revision are pointers into page_revision.
--  * page_revision       the whole page tree as jsonb. The draft row is edited in place
--                        (autosaves collapse); publishing copies it into a new row with
--                        `published_at` set, and a trigger makes published rows immutable.
--                        `visibility` snapshots the section rules at publish for auditability.
--  * section_visibility  the live audience rule per section key, stored apart from the doc
--                        so changing an audience does not create a content revision.

CREATE SCHEMA IF NOT EXISTS content;
GRANT USAGE ON SCHEMA content TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA content GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA content GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA content GRANT EXECUTE ON FUNCTIONS TO seedhost_app;

CREATE TYPE content.page_kind AS ENUM ('home', 'custom');

--> statement-breakpoint
CREATE TABLE content.page (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  slug citext NOT NULL,
  kind content.page_kind NOT NULL DEFAULT 'custom',
  title text NOT NULL,
  published_revision_id uuid,
  draft_revision_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT page_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  CONSTRAINT page_title_length CHECK (char_length(title) BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX page_slug_idx ON content.page (workspace_id, slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX page_home_idx ON content.page (workspace_id) WHERE kind = 'home' AND deleted_at IS NULL;
CREATE TRIGGER page_set_updated_at BEFORE UPDATE ON content.page
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE content.page_revision (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES content.page (id) ON DELETE CASCADE,
  revision_no integer NOT NULL,
  doc jsonb NOT NULL,
  doc_schema_version integer NOT NULL DEFAULT 1,
  -- section key → rule, snapshotted at publish; NULL on the draft row
  visibility jsonb,
  visibility_schema_version integer NOT NULL DEFAULT 1,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- last autosave of the draft row; equals created_at on published rows
  saved_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT page_revision_no_positive CHECK (revision_no >= 0),
  CONSTRAINT page_revision_note_length CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT page_revision_unique_no UNIQUE (page_id, revision_no)
);
CREATE INDEX page_revision_page_idx ON content.page_revision (workspace_id, page_id, revision_no DESC);

ALTER TABLE content.page
  ADD CONSTRAINT page_published_revision_fk FOREIGN KEY (published_revision_id)
    REFERENCES content.page_revision (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT page_draft_revision_fk FOREIGN KEY (draft_revision_id)
    REFERENCES content.page_revision (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE content.section_visibility (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  page_id uuid NOT NULL REFERENCES content.page (id) ON DELETE CASCADE,
  section_key text NOT NULL,
  rule jsonb NOT NULL,
  rule_schema_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (workspace_id, page_id, section_key),
  CONSTRAINT section_visibility_key_format CHECK (section_key ~ '^[a-z0-9][a-z0-9-]{0,39}$')
);

--> statement-breakpoint
-- Published revisions are immutable: the row that investors saw is the row counsel can
-- audit (design/04 "records and evidence"). Only the draft row (published_at IS NULL) may
-- change. Deletes ride the page/workspace cascade and are not blocked.
CREATE OR REPLACE FUNCTION content.forbid_published_revision_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'content.page_revision % is published and immutable', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER page_revision_immutable BEFORE UPDATE ON content.page_revision
  FOR EACH ROW EXECUTE FUNCTION content.forbid_published_revision_update();

--> statement-breakpoint
-- Row-level security. Staff and system actors work on everything in their workspace; an
-- external actor (investor, delegate) reads published pages and published revisions only,
-- and never the live visibility rules (the published snapshot carries what they need).
ALTER TABLE content.page ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.page FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON content.page AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY page_staff ON content.page FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY page_external_read ON content.page FOR SELECT
  USING (core.current_actor_kind() = 'external' AND deleted_at IS NULL AND published_revision_id IS NOT NULL);

ALTER TABLE content.page_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.page_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON content.page_revision AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY page_revision_staff ON content.page_revision FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY page_revision_external_read ON content.page_revision FOR SELECT
  USING (core.current_actor_kind() = 'external' AND published_at IS NOT NULL);

ALTER TABLE content.section_visibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE content.section_visibility FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON content.section_visibility AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY section_visibility_staff ON content.section_visibility FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

SELECT core.apply_tenant_fence();
