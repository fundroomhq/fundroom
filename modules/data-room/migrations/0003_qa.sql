-- 0003_qa — data-room Q&A: an investor asks a question against a document or a folder, staff
-- answer it, and the answer is released to the asker or published to everyone who can see the
-- target (EXECUTION_PLAN §15 E3.3, design/03 B5, ADR-0051).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/qa.ts; the transition rules live in
-- src/qa/rules.ts. Runs inside one transaction. Tenant tables declare the standard fence inline
-- so nothing can read a row before the runner's core.apply_tenant_fence() pass.
--
-- Why inside the data room and not a module of its own (ADR-0051): a question's target is a
-- folder or document whose *path* (folder moves) and *liveness* (trash) are data-room facts. RLS
-- below joins the live `document.folder_path` / `folder.path`, so a moved or trashed target is
-- seen as it is now, never through a stale copy.
--
-- Model:
--  * qa_question  one question. `status` walks open → assigned → (awaiting_approval) → answered
--                 (released to the asker only) → published (released to everyone who can view
--                 the target); `closed` is declined, withdrawn or erased (a binned target
--                 only hides its questions).
--                 Exactly one of `document_id` / `folder_id` names the target. `source` says who
--                 wrote it: `portal` (an investor; `asker_membership_id` set), `import` (CSV) or
--                 `staff` (an FAQ entry with no asker). `public_text` is the wording everyone
--                 else sees once published — never the asker's own `body`. `visibility` is null
--                 until the answer is released. `due_soon_notified_at` / `overdue_notified_at`
--                 make the SLA job's reminders fire once each.
--  * qa_answer    0..1 per question: the staff answer, its author, submission and four-eyes
--                 approval. `approved_body_sha256` pins the approval to the exact text approved;
--                 editing the body clears it.
--
-- Thread visibility is per asker (design/03 B5: bidders never see each other). An external actor
-- reads its own questions (never as a delegate: a delegate does not see its principal's private
-- questions) and, of everybody else's, only `published` ones on a target it can view *now* that
-- is not in the recycle bin. Which columns of those it is shown (not the asker, not `body`, not
-- the internal note) is the service's projection; RLS decides only which rows.

CREATE TYPE dataroom.qa_status AS ENUM ('open', 'assigned', 'awaiting_approval', 'answered', 'published', 'closed');
CREATE TYPE dataroom.qa_target_kind AS ENUM ('document', 'folder');

--> statement-breakpoint
CREATE TABLE dataroom.qa_question (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  target_kind dataroom.qa_target_kind NOT NULL,
  -- hard purge of the target deletes its Q&A; soft delete (trash) only hides it
  document_id uuid REFERENCES dataroom.document (id) ON DELETE CASCADE,
  folder_id uuid REFERENCES dataroom.folder (id) ON DELETE CASCADE,
  asker_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  source text NOT NULL,
  status dataroom.qa_status NOT NULL DEFAULT 'open',
  subject text NOT NULL,
  body text NOT NULL,
  public_text text,
  category text,
  assignee_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  due_at timestamptz,
  visibility text,
  internal_note text,
  closed_reason text,
  released_at timestamptz,
  published_at timestamptz,
  first_released_at timestamptz,
  closed_at timestamptz,
  due_soon_notified_at timestamptz,
  overdue_notified_at timestamptz,
  created_by uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qa_question_target CHECK (
    (target_kind = 'document' AND document_id IS NOT NULL AND folder_id IS NULL)
    OR (target_kind = 'folder' AND folder_id IS NOT NULL AND document_id IS NULL)
  ),
  CONSTRAINT qa_question_source CHECK (source IN ('portal', 'import', 'staff')),
  -- only an investor-asked question has an asker (and may lose it: membership delete SET NULL)
  CONSTRAINT qa_question_asker CHECK (source = 'portal' OR asker_membership_id IS NULL),
  CONSTRAINT qa_question_subject_length CHECK (char_length(subject) BETWEEN 1 AND 200),
  CONSTRAINT qa_question_body_length CHECK (char_length(body) BETWEEN 1 AND 5000),
  CONSTRAINT qa_question_public_text_length CHECK (public_text IS NULL OR char_length(public_text) BETWEEN 1 AND 6000),
  CONSTRAINT qa_question_category_length CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 60),
  CONSTRAINT qa_question_internal_note_length CHECK (internal_note IS NULL OR char_length(internal_note) <= 2000),
  CONSTRAINT qa_question_visibility CHECK (visibility IS NULL OR visibility IN ('asker', 'target')),
  -- a released answer says to whom: `answered` = the asker only, `published` = the target's audience
  CONSTRAINT qa_question_released_visibility CHECK (
    (status <> 'answered' OR visibility = 'asker')
    AND (status <> 'published' OR (visibility = 'target' AND public_text IS NOT NULL))
  ),
  CONSTRAINT qa_question_closed_reason CHECK (
    closed_reason IS NULL OR closed_reason IN ('declined', 'withdrawn', 'erased')
  ),
  CONSTRAINT qa_question_closed_shape CHECK ((status = 'closed') = (closed_reason IS NOT NULL))
);
CREATE INDEX qa_question_inbox_idx ON dataroom.qa_question (workspace_id, status, created_at DESC, id DESC);
CREATE INDEX qa_question_document_idx ON dataroom.qa_question (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX qa_question_folder_idx ON dataroom.qa_question (folder_id) WHERE folder_id IS NOT NULL;
-- "my questions", the open-per-asker budget and the asks-per-day rate limit
CREATE INDEX qa_question_asker_idx ON dataroom.qa_question (asker_membership_id, created_at DESC) WHERE asker_membership_id IS NOT NULL;
CREATE INDEX qa_question_assignee_idx ON dataroom.qa_question (assignee_membership_id) WHERE assignee_membership_id IS NOT NULL;
-- the SLA job's sweep
CREATE INDEX qa_question_due_idx ON dataroom.qa_question (due_at)
  WHERE status IN ('open', 'assigned', 'awaiting_approval') AND due_at IS NOT NULL;
CREATE TRIGGER qa_question_set_updated_at BEFORE UPDATE ON dataroom.qa_question
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE dataroom.qa_answer (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES dataroom.qa_question (id) ON DELETE CASCADE,
  body text NOT NULL,
  author_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  submitted_at timestamptz,
  approved_by uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  approved_at timestamptz,
  -- lower-case hex SHA-256 of the body that was approved (four-eyes, E3.3 D2)
  approved_body_sha256 text,
  rejected_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qa_answer_question_unique UNIQUE (question_id),
  CONSTRAINT qa_answer_body_length CHECK (char_length(body) BETWEEN 1 AND 20000),
  CONSTRAINT qa_answer_sha256_shape CHECK (approved_body_sha256 IS NULL OR approved_body_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT qa_answer_approval_shape CHECK ((approved_at IS NULL) = (approved_body_sha256 IS NULL)),
  CONSTRAINT qa_answer_rejected_note_length CHECK (rejected_note IS NULL OR char_length(rejected_note) BETWEEN 1 AND 2000)
);
CREATE INDEX qa_answer_workspace_idx ON dataroom.qa_answer (workspace_id);
CREATE INDEX qa_answer_author_idx ON dataroom.qa_answer (author_membership_id) WHERE author_membership_id IS NOT NULL;
CREATE TRIGGER qa_answer_set_updated_at BEFORE UPDATE ON dataroom.qa_answer
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- The schema's default privileges already cover these; stated so the grant survives a migration
-- run by a role other than the one that created the schema.
GRANT SELECT, INSERT, UPDATE, DELETE ON dataroom.qa_question, dataroom.qa_answer TO seedhost_app;

--> statement-breakpoint
-- Row-level security. Staff and system actors work on every row of their workspace.
--
-- External (investor, delegate):
--  * SELECT a question it asked itself (any status) — never as a delegate — or a `published`
--    question whose target is live and viewable now (core.has_access applies delegation, so a
--    `data_room`/`all` delegate sees published answers on targets it can view).
--  * INSERT only its own `portal` question, `open`, on a target it can view; never a delegate.
--    The qa_question_external_insert_guard trigger keeps every staff column empty and sets the
--    due time itself.
--  * UPDATE only its own question, never a delegate, and only from waiting-on-staff into
--    closed/withdrawn with nothing released; the qa_question_external_guard trigger refuses any
--    other transition and a change to any other column.
--  * SELECT an answer only through a visible question that has released it: the asker sees
--    `answered` and `published`, anyone else `published` only. No external write on answers.
-- The argument-free helpers are wrapped in scalar subqueries so they run once per query, not
-- once per row. qa_answer's policy reads qa_question (itself under RLS), whose policy reads
-- document/folder — never back to qa_answer, so there is no recursion.
ALTER TABLE dataroom.qa_question ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataroom.qa_question FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON dataroom.qa_question AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY qa_question_staff ON dataroom.qa_question FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY qa_question_external_read ON dataroom.qa_question FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND (
      (
        asker_membership_id = (SELECT core.current_membership())
        AND NOT (SELECT core.current_membership_is_delegate())
      )
      OR (
        status = 'published'
        AND (
          (
            target_kind = 'document'
            AND EXISTS (
              SELECT 1 FROM dataroom.document d
              WHERE d.id = qa_question.document_id
                AND d.deleted_at IS NULL
                AND core.has_access('document', d.id, d.folder_path, 'view')
            )
          )
          OR (
            target_kind = 'folder'
            AND EXISTS (
              SELECT 1 FROM dataroom.folder f
              WHERE f.id = qa_question.folder_id
                AND f.deleted_at IS NULL
                AND core.has_access('folder', f.id, f.path, 'view')
            )
          )
        )
      )
    )
  );
CREATE POLICY qa_question_external_insert ON dataroom.qa_question FOR INSERT
  WITH CHECK (
    core.current_actor_kind() = 'external'
    AND asker_membership_id = (SELECT core.current_membership())
    AND NOT (SELECT core.current_membership_is_delegate())
    AND source = 'portal'
    AND status = 'open'
    AND (
      (
        target_kind = 'document'
        AND EXISTS (
          SELECT 1 FROM dataroom.document d
          WHERE d.id = qa_question.document_id
            AND d.deleted_at IS NULL
            AND core.has_access('document', d.id, d.folder_path, 'view')
        )
      )
      OR (
        target_kind = 'folder'
        AND EXISTS (
          SELECT 1 FROM dataroom.folder f
          WHERE f.id = qa_question.folder_id
            AND f.deleted_at IS NULL
            AND core.has_access('folder', f.id, f.path, 'view')
        )
      )
    )
  );
CREATE POLICY qa_question_external_update ON dataroom.qa_question FOR UPDATE
  USING (
    core.current_actor_kind() = 'external'
    AND asker_membership_id = (SELECT core.current_membership())
    AND NOT (SELECT core.current_membership_is_delegate())
  )
  WITH CHECK (
    core.current_actor_kind() = 'external'
    AND asker_membership_id = (SELECT core.current_membership())
    AND NOT (SELECT core.current_membership_is_delegate())
    AND source = 'portal'
    -- the only external write is a withdrawal: the row must end closed/withdrawn and unreleased
    -- (`public_text` may be set: staff may word a question before or after taking a release
    -- offline for review; the guard below pins it unchanged)
    AND status = 'closed'
    AND closed_reason = 'withdrawn'
    AND visibility IS NULL
  );

-- A policy's WITH CHECK sees only the new row, so it cannot say "and nothing else changed" or
-- "from where". This trigger does: an external actor may only take a question still waiting on
-- staff (open, assigned, awaiting approval) to closed/withdrawn — never re-label a declined or
-- erased one — and may change only the status, the closed reason and time (and the
-- trigger-maintained updated_at): never the target, the text, the assignee, the due time, the
-- asker, the source, the reminder stamps or the release columns.
CREATE FUNCTION dataroom.qa_question_external_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF core.current_actor_kind() = 'external'
     AND (
       OLD.status NOT IN ('open', 'assigned', 'awaiting_approval')
       OR NEW.status IS DISTINCT FROM 'closed'
       OR NEW.closed_reason IS DISTINCT FROM 'withdrawn'
       OR (to_jsonb(NEW) - ARRAY['status', 'closed_reason', 'closed_at', 'updated_at'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'closed_reason', 'closed_at', 'updated_at'])
     )
  THEN
    RAISE EXCEPTION 'an external actor may only withdraw its question'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER qa_question_external_guard BEFORE UPDATE ON dataroom.qa_question
  FOR EACH ROW EXECUTE FUNCTION dataroom.qa_question_external_guard();

-- The INSERT policy checks who asks, on what and in which status; this trigger pins the rest of
-- an external INSERT: every staff-owned column (wording, triage, SLA, release, close, reminder
-- stamps) starts empty, the creator is the asker and `created_at` is now (±5 s). The due time is
-- set here — `created_at` + `settings.dataRoom.qa.slaHours` (the domain default, 72, when unset
-- or out of range: keep in step with WorkspaceSettingsSchema) — so the asker cannot pick it.
CREATE FUNCTION dataroom.qa_question_external_insert_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  sla jsonb;
  sla_hours integer := 72;
BEGIN
  IF core.current_actor_kind() = 'external' THEN
    IF NEW.public_text IS NOT NULL
       OR NEW.visibility IS NOT NULL
       OR NEW.assignee_membership_id IS NOT NULL
       OR NEW.internal_note IS NOT NULL
       OR NEW.category IS NOT NULL
       OR NEW.due_at IS NOT NULL
       OR NEW.released_at IS NOT NULL
       OR NEW.published_at IS NOT NULL
       OR NEW.first_released_at IS NOT NULL
       OR NEW.closed_at IS NOT NULL
       OR NEW.closed_reason IS NOT NULL
       OR NEW.due_soon_notified_at IS NOT NULL
       OR NEW.overdue_notified_at IS NOT NULL
       OR NEW.created_by IS DISTINCT FROM NEW.asker_membership_id
       OR abs(extract(epoch FROM NEW.created_at - now())) > 5
    THEN
      RAISE EXCEPTION 'an external actor may only ask a plain question'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT w.settings #> '{dataRoom,qa,slaHours}' INTO sla
      FROM core.workspace w WHERE w.id = NEW.workspace_id;
    IF jsonb_typeof(sla) = 'number'
       AND sla::numeric = trunc(sla::numeric)
       AND sla::numeric BETWEEN 1 AND 720
    THEN
      sla_hours := sla::integer;
    END IF;
    NEW.due_at := NEW.created_at + make_interval(hours => sla_hours);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER qa_question_external_insert_guard BEFORE INSERT ON dataroom.qa_question
  FOR EACH ROW EXECUTE FUNCTION dataroom.qa_question_external_insert_guard();

ALTER TABLE dataroom.qa_answer ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataroom.qa_answer FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON dataroom.qa_answer AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY qa_answer_staff ON dataroom.qa_answer FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY qa_answer_external_read ON dataroom.qa_answer FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND EXISTS (
      -- qa_question's own external policy has already narrowed this to visible questions
      SELECT 1 FROM dataroom.qa_question q
      WHERE q.id = qa_answer.question_id
        AND (
          q.status = 'published'
          OR (
            q.status = 'answered'
            AND q.asker_membership_id = (SELECT core.current_membership())
            AND NOT (SELECT core.current_membership_is_delegate())
          )
        )
    )
  );

SELECT core.apply_tenant_fence();
