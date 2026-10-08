-- 0001_crm — CRM-lite: organisations and contacts that need no login, a per-round pipeline
-- with tenant-editable stages, polymorphic notes and tasks, and the stage history that makes
-- a move provable (EXECUTION_PLAN §15 E2.5, design/03 §82, design/06 §7 lines 224-227,
-- ADR-0024, ADR-0043).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/crm.ts. Runs inside one
-- transaction. Tenant tables declare the standard fence inline so nothing can read a row
-- before the runner's core.apply_tenant_fence() pass.
--
-- Model:
--  * organization     a fund, angel group, corporate or family office. Named once per
--                     workspace among live rows, soft-deleted so a pipeline card that
--                     referenced it keeps its subject.
--  * contact          a person. **A contact is not a login** (design/06: "contact may exist
--                     without portal access"): `membership_id` is the optional link to
--                     core.membership, at most one live contact per member, and the name and
--                     email on this row are the CRM's own copy — staff edit them freely
--                     without touching identity. `search_tsv` is generated, so the search
--                     index cannot drift from the columns it indexes.
--  * pipeline_stage   the tenant's ladder. Stable `key`s (E2.5 D10) seeded lazily on the
--                     first CRM read, renameable and reorderable, with `position` unique
--                     *deferrably* — see the constraint's own comment.
--  * pipeline_item    one card: a contact and/or an organisation, optionally against a round,
--                     in a stage, with a **forecast** amount. The committed figure lives on
--                     round.commitment and is reached through `commitment_id` (E2.5 D2);
--                     nothing here is the system of record for money.
--  * note / task      polymorphic over the three subjects, `subject_kind` + `subject_id`.
--  * stage_transition every move, with its cause — staff, or one of the three round events
--                     the module subscribes to. This is what "stage transitions audited"
--                     (design/03 §82) means in the database rather than only in audit.event.
--
-- Extensions: `citext` only, and it is already created by packages/db/migrations/core/0000.
-- No RLS arm admits an external actor anywhere in this schema: "only company staff see CRM"
-- (design/03 §82) is a row-security fact here, not a route-level one.
CREATE SCHEMA IF NOT EXISTS crm;
GRANT USAGE ON SCHEMA crm TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA crm GRANT EXECUTE ON FUNCTIONS TO seedhost_app;

--> statement-breakpoint
CREATE TABLE crm.organization (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  name text NOT NULL,
  -- citext: "sequoia.com" and "Sequoia.com" are one firm, and the admin who typed the second
  -- one should not end up with a duplicate organisation a month later.
  domain citext,
  website text,
  kind text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT organization_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT organization_kind_known CHECK (
    kind IS NULL OR kind IN ('fund', 'angel_group', 'corporate', 'family_office', 'other')
  ),
  CONSTRAINT organization_website_length CHECK (website IS NULL OR char_length(website) <= 2000),
  CONSTRAINT organization_domain_length CHECK (domain IS NULL OR char_length(domain) <= 253),
  CONSTRAINT organization_notes_length CHECK (notes IS NULL OR char_length(notes) <= 4000)
);
-- Live rows only: a deleted "Acme Ventures" must not block a new one, and the deleted row has
-- to stay so the cards that named it keep their subject.
CREATE UNIQUE INDEX organization_name_active_idx ON crm.organization (workspace_id, lower(name))
  WHERE deleted_at IS NULL;
-- The keyset the list route pages on (ids are uuidv7, i.e. creation order).
CREATE INDEX organization_page_idx ON crm.organization (workspace_id, id) WHERE deleted_at IS NULL;
CREATE TRIGGER organization_set_updated_at BEFORE UPDATE ON crm.organization
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE crm.contact (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  organization_id uuid REFERENCES crm.organization (id) ON DELETE SET NULL,
  -- The link to a portal login, and nullable by construction: most contacts never have one.
  -- ADR-0011 put the linkage on the membership rather than on the global user, so a contact in
  -- one workspace says nothing about the same human in another.
  membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  display_name text NOT NULL,
  email citext,
  title text,
  tags text[] NOT NULL DEFAULT '{}',
  notes text,
  owner_membership_id uuid,
  -- Generated, not maintained by a trigger or by the application: the index and the columns
  -- cannot drift, and a row written by a psql session is searchable like any other.
  -- `simple` rather than `english`: these are names and email addresses, and stemming
  -- "Harrison" is not a service anybody asked for.
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(display_name, '') || ' ' || coalesce(email::text, '') || ' ' || coalesce(title, '')
    )
  ) STORED,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT contact_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT contact_email_length CHECK (email IS NULL OR char_length(email::text) <= 320),
  CONSTRAINT contact_title_length CHECK (title IS NULL OR char_length(title) <= 120),
  CONSTRAINT contact_notes_length CHECK (notes IS NULL OR char_length(notes) <= 4000),
  CONSTRAINT contact_tags_bounded CHECK (cardinality(tags) <= 50)
);
-- One live contact per member. The handlers upsert by `membership_id` on every round event, so
-- without this a redelivered event could mint a second card for the same person.
CREATE UNIQUE INDEX contact_membership_active_idx ON crm.contact (workspace_id, membership_id)
  WHERE membership_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX contact_page_idx ON crm.contact (workspace_id, id) WHERE deleted_at IS NULL;
CREATE INDEX contact_organization_idx ON crm.contact (workspace_id, organization_id)
  WHERE deleted_at IS NULL AND organization_id IS NOT NULL;
CREATE INDEX contact_search_idx ON crm.contact USING gin (search_tsv);
CREATE INDEX contact_tags_idx ON crm.contact USING gin (tags);
CREATE TRIGGER contact_set_updated_at BEFORE UPDATE ON crm.contact
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE crm.pipeline_stage (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- Stable machine key (E2.5 D10). The event handlers address a stage by this and never by
  -- name, so a tenant may rename "Soft-committed" to "Circled" without breaking the mapping
  -- from a commitment status onto a column.
  key text NOT NULL,
  name text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  is_terminal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pipeline_stage_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT pipeline_stage_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT pipeline_stage_position_positive CHECK (position >= 0),
  CONSTRAINT pipeline_stage_key_unique UNIQUE (workspace_id, key),
  -- DEFERRABLE INITIALLY DEFERRED, and not as a convenience. `PUT /crm/stages` renumbers the
  -- whole ladder 1..n in one statement per row, and any reordering passes through a state
  -- where two rows briefly claim the same position — swapping two neighbours cannot be
  -- expressed otherwise without a temporary out-of-range number nobody asked for. The
  -- invariant is "a workspace never *has* two stages at one position", not "no transaction
  -- ever passes through a state where it would", so the check belongs at COMMIT.
  CONSTRAINT pipeline_stage_position_unique UNIQUE (workspace_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX pipeline_stage_order_idx ON crm.pipeline_stage (workspace_id, position);
CREATE TRIGGER pipeline_stage_set_updated_at BEFORE UPDATE ON crm.pipeline_stage
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE crm.pipeline_item (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- Soft reference into the round module's schema (ADR-0007: modules never join across
  -- schemas). NULL means a card the workspace is tracking outside any particular raise.
  round_id uuid,
  -- CASCADE rather than SET NULL on both subjects, because `pipeline_item_subject` below
  -- requires at least one of them: a SET NULL that emptied the last one would leave a row the
  -- CHECK forbids. Neither is ever hard-deleted by the application (both are soft-deleted), so
  -- this only fires when the workspace itself goes.
  contact_id uuid REFERENCES crm.contact (id) ON DELETE CASCADE,
  organization_id uuid REFERENCES crm.organization (id) ON DELETE CASCADE,
  stage_id uuid NOT NULL REFERENCES crm.pipeline_stage (id) ON DELETE RESTRICT,
  -- A **forecast** — what staff expect — never the committed figure (E2.5 D2). The committed
  -- amount is on round.commitment and is reached through `commitment_id`.
  amount numeric(20, 6),
  currency text,
  owner_membership_id uuid,
  commitment_id uuid,
  position integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT pipeline_item_subject CHECK (contact_id IS NOT NULL OR organization_id IS NOT NULL),
  CONSTRAINT pipeline_item_amount_positive CHECK (amount IS NULL OR amount > 0),
  CONSTRAINT pipeline_item_currency_format CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CONSTRAINT pipeline_item_position_positive CHECK (position >= 0)
);
-- One card per (round, contact) among live rows: the event handlers are idempotent *because*
-- of this index, not merely by convention — a redelivered `round.interest_submitted` finds the
-- card it created the first time.
CREATE UNIQUE INDEX pipeline_item_round_contact_idx ON crm.pipeline_item (round_id, contact_id)
  WHERE deleted_at IS NULL AND round_id IS NOT NULL AND contact_id IS NOT NULL;
CREATE INDEX pipeline_item_board_idx ON crm.pipeline_item (workspace_id, stage_id, position, id)
  WHERE deleted_at IS NULL;
CREATE INDEX pipeline_item_round_idx ON crm.pipeline_item (workspace_id, round_id)
  WHERE deleted_at IS NULL;
CREATE INDEX pipeline_item_commitment_idx ON crm.pipeline_item (workspace_id, commitment_id)
  WHERE deleted_at IS NULL AND commitment_id IS NOT NULL;
CREATE TRIGGER pipeline_item_set_updated_at BEFORE UPDATE ON crm.pipeline_item
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE crm.note (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  subject_kind text NOT NULL,
  -- Polymorphic by design (design/06 §7): a note hangs off whichever of the three subjects it
  -- was written against, so there is no FK here and the service checks the subject exists.
  subject_id uuid NOT NULL,
  body text NOT NULL,
  author_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT note_subject_kind_known CHECK (
    subject_kind IN ('contact', 'organization', 'pipeline_item')
  ),
  CONSTRAINT note_body_length CHECK (char_length(body) BETWEEN 1 AND 20000)
);
CREATE INDEX note_subject_idx ON crm.note (workspace_id, subject_kind, subject_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE crm.task (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  subject_kind text NOT NULL,
  subject_id uuid NOT NULL,
  title text NOT NULL,
  due_at timestamptz,
  assignee_membership_id uuid,
  done_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_subject_kind_known CHECK (
    subject_kind IN ('contact', 'organization', 'pipeline_item')
  ),
  CONSTRAINT task_title_length CHECK (char_length(title) BETWEEN 1 AND 200)
);
CREATE INDEX task_subject_idx ON crm.task (workspace_id, subject_kind, subject_id, created_at DESC);
CREATE INDEX task_open_idx ON crm.task (workspace_id, due_at) WHERE done_at IS NULL;
CREATE TRIGGER task_set_updated_at BEFORE UPDATE ON crm.task
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE crm.stage_transition (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  pipeline_item_id uuid NOT NULL REFERENCES crm.pipeline_item (id) ON DELETE CASCADE,
  -- Deliberately **not** foreign keys, and this is the one place in the schema where that is
  -- the right answer. `pipeline_item.stage_id` is ON DELETE RESTRICT, which is what stops a
  -- tenant removing a stage a live card sits in. History is the opposite case: a stage that
  -- nothing occupies any more may be removed, and the moves that once passed through it still
  -- happened. A REFERENCES here would make every stage a workspace has ever used permanently
  -- undeletable, so the keys are kept alongside the ids and the history reads without a join.
  from_stage_id uuid,
  from_stage_key text,
  to_stage_id uuid NOT NULL,
  to_stage_key text NOT NULL,
  actor_membership_id uuid,
  cause text NOT NULL DEFAULT 'staff',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stage_transition_cause_known CHECK (
    cause IN ('staff', 'interest_submitted', 'interest_decided', 'commitment_created', 'commitment_changed')
  )
);
CREATE INDEX stage_transition_item_idx ON crm.stage_transition (workspace_id, pipeline_item_id, created_at DESC);

--> statement-breakpoint
-- Row-level security. Every table takes the same two policies and no third: the tenant fence,
-- and staff-or-system full access. There is no external arm anywhere in this schema, and that
-- absence is the requirement rather than an omission — design/03 §82 says "only company staff
-- see CRM", and an investor who could read `crm.note` would read what the company says about
-- them and about every other investor in the round.
ALTER TABLE crm.organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.organization FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON crm.organization AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY organization_staff ON crm.organization FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE crm.contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.contact FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON crm.contact AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY contact_staff ON crm.contact FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE crm.pipeline_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.pipeline_stage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON crm.pipeline_stage AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY pipeline_stage_staff ON crm.pipeline_stage FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE crm.pipeline_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.pipeline_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON crm.pipeline_item AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY pipeline_item_staff ON crm.pipeline_item FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE crm.note ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.note FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON crm.note AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY note_staff ON crm.note FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE crm.task ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.task FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON crm.task AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY task_staff ON crm.task FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE crm.stage_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.stage_transition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON crm.stage_transition AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY stage_transition_staff ON crm.stage_transition FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

SELECT core.apply_tenant_fence();
