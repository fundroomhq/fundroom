-- 0001_updates — investor updates: posts with immutable published versions, sends and
-- per-recipient status, reply threads, unsubscribes, per-workspace sending domains
-- (EXECUTION_PLAN §7 "updates", §13.3, design/03 C1, design/04 §2, design/06 §2.3, E1.4, ADR-0035).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/updates.ts. Runs inside one
-- transaction. Tenant tables declare the standard fence inline so nothing can read a row
-- before the runner's core.apply_tenant_fence() pass.
--
-- Model:
--  * post            the editable draft (title, block doc, per-section audience rules, the
--                    audience) and the lifecycle state. `published_version_id` points at the
--                    version investors see; the draft keeps being editable after a send only
--                    through a new version.
--  * post_version    immutable snapshot taken by publish/send: doc + visibility + audience +
--                    the disclaimer version in force (design/04 "provable history").
--  * send            one row per fan-out (live or test), with counts.
--  * recipient       one row per address per send: queued → sent | failed | skipped.
--  * reply           thread per (post, investor): the investor and staff talk privately; no
--                    reply-all leakage between investors (design/04 MNPI).
--  * unsubscribe     members who opted out of update mail (still see the web archive).
--  * sending_domain  the workspace's own sender domain: DKIM key pair (private key
--                    envelope-encrypted under the workspace DEK), DNS verification state.

CREATE SCHEMA IF NOT EXISTS updates;
GRANT USAGE ON SCHEMA updates TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA updates GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA updates GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA updates GRANT EXECUTE ON FUNCTIONS TO seedhost_app;

CREATE TYPE updates.post_state AS ENUM ('draft', 'scheduled', 'sending', 'sent', 'archived');
CREATE TYPE updates.send_kind AS ENUM ('live', 'test');
CREATE TYPE updates.send_status AS ENUM ('queued', 'running', 'finished', 'failed');
CREATE TYPE updates.recipient_status AS ENUM ('queued', 'sent', 'failed', 'skipped', 'bounced', 'complained');
CREATE TYPE updates.domain_status AS ENUM ('pending', 'verified', 'failed');
CREATE TYPE updates.unsubscribe_source AS ENUM ('link', 'one_click', 'portal', 'staff');

--> statement-breakpoint
CREATE TABLE updates.post (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  slug citext NOT NULL,
  title text NOT NULL,
  state updates.post_state NOT NULL DEFAULT 'draft',
  doc jsonb NOT NULL,
  doc_schema_version integer NOT NULL DEFAULT 1,
  -- section key → rule (`authenticated` | `groups` | `staff_only`); never `public`
  visibility jsonb NOT NULL DEFAULT '{}',
  visibility_schema_version integer NOT NULL DEFAULT 1,
  -- {"kind":"all"} | {"kind":"groups","groupIds":[…]}
  audience jsonb NOT NULL DEFAULT '{"kind": "all"}',
  audience_schema_version integer NOT NULL DEFAULT 1,
  template_key text,
  scheduled_for timestamptz,
  published_version_id uuid,
  sent_at timestamptz,
  author_membership_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- last autosave; the editor's optimistic-concurrency token
  saved_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', title)) STORED,
  CONSTRAINT post_slug_format CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  CONSTRAINT post_title_length CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT post_template_key_length CHECK (template_key IS NULL OR char_length(template_key) <= 40),
  CONSTRAINT post_scheduled_state CHECK (state <> 'scheduled' OR scheduled_for IS NOT NULL)
);
CREATE UNIQUE INDEX post_slug_idx ON updates.post (workspace_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX post_state_idx ON updates.post (workspace_id, state, scheduled_for);
CREATE INDEX post_sent_idx ON updates.post (workspace_id, sent_at DESC) WHERE state = 'sent' AND deleted_at IS NULL;
CREATE INDEX post_search_idx ON updates.post USING gin (search_tsv);
CREATE TRIGGER post_set_updated_at BEFORE UPDATE ON updates.post
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE updates.post_version (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES updates.post (id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  title text NOT NULL,
  doc jsonb NOT NULL,
  doc_schema_version integer NOT NULL DEFAULT 1,
  visibility jsonb NOT NULL DEFAULT '{}',
  visibility_schema_version integer NOT NULL DEFAULT 1,
  audience jsonb NOT NULL,
  audience_schema_version integer NOT NULL DEFAULT 1,
  -- the legal disclaimer version in force when this version was published (E1.6 fills it)
  disclaimer_version text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_version_no_positive CHECK (version_no >= 1),
  CONSTRAINT post_version_unique_no UNIQUE (post_id, version_no)
);
CREATE INDEX post_version_post_idx ON updates.post_version (workspace_id, post_id, version_no DESC);

ALTER TABLE updates.post
  ADD CONSTRAINT post_published_version_fk FOREIGN KEY (published_version_id)
    REFERENCES updates.post_version (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE updates.send (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES updates.post (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES updates.post_version (id) ON DELETE CASCADE,
  kind updates.send_kind NOT NULL,
  status updates.send_status NOT NULL DEFAULT 'queued',
  requested_by uuid,
  total integer NOT NULL DEFAULT 0,
  sent integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT send_error_length CHECK (error IS NULL OR char_length(error) <= 1000)
);
CREATE INDEX send_post_idx ON updates.send (workspace_id, post_id, created_at DESC);

CREATE TABLE updates.recipient (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  send_id uuid NOT NULL REFERENCES updates.send (id) ON DELETE CASCADE,
  membership_id uuid,
  email citext NOT NULL,
  status updates.recipient_status NOT NULL DEFAULT 'queued',
  message_id text,
  error text,
  sent_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recipient_unique UNIQUE (send_id, email),
  CONSTRAINT recipient_error_length CHECK (error IS NULL OR char_length(error) <= 1000)
);
CREATE INDEX recipient_send_idx ON updates.recipient (workspace_id, send_id, status);

CREATE TABLE updates.reply (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES updates.post (id) ON DELETE CASCADE,
  -- the investor whose private thread this is
  thread_membership_id uuid NOT NULL,
  author_membership_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT reply_body_length CHECK (char_length(body) BETWEEN 1 AND 5000)
);
CREATE INDEX reply_thread_idx ON updates.reply (workspace_id, post_id, thread_membership_id, created_at);

CREATE TABLE updates.unsubscribe (
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  email citext NOT NULL,
  source updates.unsubscribe_source NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, membership_id)
);

CREATE TABLE updates.sending_domain (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  domain citext NOT NULL,
  selector text NOT NULL,
  public_key text NOT NULL,
  private_key_enc bytea NOT NULL,
  encryption jsonb NOT NULL DEFAULT '{}',
  encryption_schema_version integer NOT NULL DEFAULT 1,
  status updates.domain_status NOT NULL DEFAULT 'pending',
  -- last verification pass: {dkim, spf, dmarc} each {ok, found}
  checks jsonb NOT NULL DEFAULT '{}',
  checks_schema_version integer NOT NULL DEFAULT 1,
  last_checked_at timestamptz,
  last_error text,
  verified_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sending_domain_one_per_workspace UNIQUE (workspace_id),
  CONSTRAINT sending_domain_format CHECK (domain ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  CONSTRAINT sending_domain_selector_format CHECK (selector ~ '^[a-z0-9]{1,40}$'),
  CONSTRAINT sending_domain_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 1000)
);
CREATE TRIGGER sending_domain_set_updated_at BEFORE UPDATE ON updates.sending_domain
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

--> statement-breakpoint
-- Published versions are immutable: what an investor received is what counsel can audit.
CREATE OR REPLACE FUNCTION updates.forbid_version_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'updates.post_version % is immutable', OLD.id USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER post_version_immutable BEFORE UPDATE ON updates.post_version
  FOR EACH ROW EXECUTE FUNCTION updates.forbid_version_update();

-- Whether the current (external) actor is in an audience: everyone, or a member of one of
-- the listed groups. Group membership is read through core.group_member's own policy.
CREATE OR REPLACE FUNCTION updates.audience_includes_current(p_audience jsonb) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(p_audience->>'kind', 'all') = 'all'
    OR EXISTS (
      SELECT 1 FROM core.group_member gm
      WHERE gm.workspace_id = core.current_workspace()
        AND gm.membership_id = core.current_membership()
        AND gm.revoked_at IS NULL
        AND gm.group_id::text IN (SELECT jsonb_array_elements_text(COALESCE(p_audience->'groupIds', '[]'::jsonb)))
    )
$$;

--> statement-breakpoint
-- Row-level security. Staff and system actors work on everything in their workspace. An
-- external actor reads sent posts whose audience includes them, the published version of
-- those posts, its own reply thread and its own unsubscribe row; sends, recipients and the
-- sending domain are staff-only.
ALTER TABLE updates.post ENABLE ROW LEVEL SECURITY;
ALTER TABLE updates.post FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON updates.post AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY post_staff ON updates.post FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY post_external_read ON updates.post FOR SELECT
  USING (
    core.current_actor_kind() = 'external' AND deleted_at IS NULL AND state = 'sent'
    AND published_version_id IS NOT NULL AND updates.audience_includes_current(audience)
  );

ALTER TABLE updates.post_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE updates.post_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON updates.post_version AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY post_version_staff ON updates.post_version FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY post_version_external_read ON updates.post_version FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND EXISTS (SELECT 1 FROM updates.post p WHERE p.id = post_version.post_id AND p.published_version_id = post_version.id)
  );

ALTER TABLE updates.send ENABLE ROW LEVEL SECURITY;
ALTER TABLE updates.send FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON updates.send AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY send_staff ON updates.send FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE updates.recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE updates.recipient FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON updates.recipient AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY recipient_staff ON updates.recipient FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE updates.reply ENABLE ROW LEVEL SECURITY;
ALTER TABLE updates.reply FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON updates.reply AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY reply_staff ON updates.reply FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY reply_external_read ON updates.reply FOR SELECT
  USING (core.current_actor_kind() = 'external' AND deleted_at IS NULL AND thread_membership_id = core.current_membership());
CREATE POLICY reply_external_insert ON updates.reply FOR INSERT
  WITH CHECK (
    core.current_actor_kind() = 'external'
    AND thread_membership_id = core.current_membership()
    AND author_membership_id = core.current_membership()
  );

ALTER TABLE updates.unsubscribe ENABLE ROW LEVEL SECURITY;
ALTER TABLE updates.unsubscribe FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON updates.unsubscribe AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY unsubscribe_staff ON updates.unsubscribe FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY unsubscribe_external_own ON updates.unsubscribe FOR ALL
  USING (core.current_actor_kind() = 'external' AND membership_id = core.current_membership())
  WITH CHECK (core.current_actor_kind() = 'external' AND membership_id = core.current_membership());

ALTER TABLE updates.sending_domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE updates.sending_domain FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON updates.sending_domain AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY sending_domain_staff ON updates.sending_domain FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

SELECT core.apply_tenant_fence();
