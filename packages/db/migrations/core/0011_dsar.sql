-- 0011_dsar — DSAR erasure requests and the per-module steps that answer them
-- (EXECUTION_PLAN §15 E2.6 "DSAR anonymisation path"; design/04 §3.2).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/dsar.ts. Runs inside one
-- transaction; the fences are declared inline so nothing can read a row between CREATE TABLE
-- and the runner's core.apply_tenant_fence() pass.
--
-- Model (E2.6 decision 5): the kernel owns the request — who asked, when, the statutory clock,
-- the legal hold that refuses it — and publishes `member.erasure_requested`. Each module holding
-- personal data about the member erases or pseudonymises its own rows and reports back through
-- `LegalServices.completeErasureStep`, which writes one dsar_step row. The request is `completed`
-- when every module named in `expected_modules` (frozen when the request was made: every
-- compiled-in module whose manifest handles the topic, enabled for the workspace or not — a
-- disabled module's old rows are still personal data) has reported.
--
--  * dsar_request  one row per request. Its state moves exactly once, requested → completed or
--                  requested → cancelled, and nothing else about it is ever rewritten: it is the
--                  evidence that the workspace answered, and when.
--  * dsar_step     one row per (request, module), insert-only. The primary key *is* the
--                  idempotency: a redelivered event reports twice and the first report stands.
--
-- `membership_id` deliberately has no foreign key. The request is the record that a person was
-- erased; it must outlive the membership row it names (E2.7's identity erasure may delete it),
-- the same way audit.event keeps a bare membership id. The route checks the membership exists
-- when the request is made.

CREATE TYPE core.dsar_status AS ENUM ('requested', 'completed', 'cancelled');

--> statement-breakpoint
CREATE TABLE core.dsar_request (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- the member to be erased (no FK, see above)
  membership_id uuid NOT NULL,
  -- the staff membership that recorded the request
  requested_by uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- statutory deadline: +30 days (EU/UK/other/unset) or +45 days (US) from requested_at
  due_at timestamptz NOT NULL,
  status core.dsar_status NOT NULL DEFAULT 'requested',
  -- module ids expected to report, frozen at request time
  expected_modules text[] NOT NULL DEFAULT '{}',
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid,
  -- free text from the admin (how the request arrived); never shown to anybody but staff
  note text,
  CONSTRAINT dsar_request_due_after_request CHECK (due_at > requested_at),
  CONSTRAINT dsar_request_note_length CHECK (note IS NULL OR char_length(note) <= 1000),
  CONSTRAINT dsar_request_state_shape CHECK (
    (status = 'requested' AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
  )
);

-- At most one open request per member. The route answers 409 when it trips (23505 on this
-- constraint name), so two admins pressing the button at once cannot open two clocks.
CREATE UNIQUE INDEX dsar_request_open_idx ON core.dsar_request (workspace_id, membership_id)
  WHERE status = 'requested';

-- The admin list: newest first, keyset on (requested_at, id).
CREATE INDEX dsar_request_ws_idx ON core.dsar_request (workspace_id, requested_at DESC, id DESC);

-- A request changes state once and is otherwise immutable.
CREATE OR REPLACE FUNCTION core.dsar_request_transition_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'erasure request % is already %', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at
     OR NEW.expected_modules IS DISTINCT FROM OLD.expected_modules
     OR NEW.note IS DISTINCT FROM OLD.note THEN
    RAISE EXCEPTION 'an erasure request may only be completed or cancelled, not rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dsar_request_transition_only BEFORE UPDATE ON core.dsar_request
  FOR EACH ROW EXECUTE FUNCTION core.dsar_request_transition_only();

--> statement-breakpoint
CREATE TABLE core.dsar_step (
  request_id uuid NOT NULL REFERENCES core.dsar_request (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- the reporting module's id
  module text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  -- rows removed or pseudonymised, by table: numbers only, never values
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  counts_schema_version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (request_id, module),
  CONSTRAINT dsar_step_module_shape CHECK (module ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT dsar_step_counts_object CHECK (jsonb_typeof(counts) = 'object')
);

CREATE TRIGGER dsar_step_immutable BEFORE UPDATE ON core.dsar_step
  FOR EACH ROW EXECUTE FUNCTION core.freeze_evidence_row();

--> statement-breakpoint
-- Row-level security. Staff (the compliance screen) and the system (the step reports, which
-- run in module subscribers) only. An external member matches no permissive policy: the request
-- is about them, but it is the workspace's record of how it answered, and the person gets their
-- answer from the company, not from a table. Neither table has a DELETE policy — a request is
-- cancelled, never removed; the workspace cascade is referential and bypasses RLS.
ALTER TABLE core.dsar_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.dsar_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.dsar_request AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY dsar_request_read ON core.dsar_request FOR SELECT
  USING (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY dsar_request_insert ON core.dsar_request FOR INSERT
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY dsar_request_update ON core.dsar_request FOR UPDATE
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE core.dsar_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.dsar_step FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.dsar_step AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY dsar_step_read ON core.dsar_step FOR SELECT
  USING (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY dsar_step_insert ON core.dsar_step FOR INSERT
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

SELECT core.apply_tenant_fence();
