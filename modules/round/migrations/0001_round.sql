-- 0001_round — the round a company is raising: its append-only terms, the offering-mode-aware
-- interest form, accreditation verifications and their evidence, the commitments that are the
-- system of record for the money, and the closing checklist
-- (EXECUTION_PLAN §15 E2.5 and :336, design/03 §49 and §83, design/04 §1.6 and §183,
-- design/06 §219-221, ADR-0024, ADR-0043).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/round.ts. Runs inside one
-- transaction. Tenant tables declare the standard fence inline so nothing can read a row
-- before the runner's core.apply_tenant_fence() pass.
--
-- Model:
--  * round               one raise: stage, instrument, target, currency, minimum, the window
--                        it is open for, and whether investors see the progress bar. At most
--                        one round per workspace is `open` (a partial unique index says so);
--                        the rest are history, and history is never deleted.
--  * terms               what the round *is*, as data rather than prose: a jsonb body chosen by
--                        the round's `instrument_kind` and validated by zod
--                        (`@seed-host/round-terms`). **Append only** (E2.5 D3, like
--                        metrics.point): an edit inserts a new `revision` and points the old
--                        row's `superseded_by` at it, so the text an investor was shown last
--                        month is still on disk with the timestamp that proves when it changed.
--                        `disclaimer_stamp` is the `<slug>:v<n>` in force at the moment the
--                        revision was written — a string, never a foreign key, so it stays
--                        readable after the document is gone.
--  * interest_submission an investor saying "I would put in X". Not an order and not a
--                        commitment: it carries the offering status at the moment it was made,
--                        the accreditation path that status implied, and the click-wrap stamp of
--                        the questionnaire they answered. Staff accept or decline it.
--  * verification        the 506(c) second step (design/04 §183): a method, an evidence
--                        reference, a verifier and an expiry. The evidence blob itself lives in
--                        object storage, envelope-encrypted, and is purged
--                        `round.evidenceRetentionDays` after the decision — the decision
--                        survives the purge, the file does not.
--  * commitment          the money. One row per commitment against a round, bucketed by status,
--                        and the only place the allocation tracker adds anything up (E2.5 D2).
--                        A commitment names a member, a CRM contact, an organisation or simply
--                        a display name — at least one of the four.
--  * closing_task        the closing checklist. Deliberately the smallest table here: E2.5 ships
--                        a list and a toggle, not a workflow.

-- `btree_gist` supplies uuid equality *inside* a GiST index, which the deferrable exclusion
-- constraint on `round.terms` needs (see it below). `modules/metrics` already requires the
-- extension for the same reason; `CREATE EXTENSION IF NOT EXISTS` makes the order of the two
-- migrations irrelevant.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS round;
GRANT USAGE ON SCHEMA round TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA round GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA round GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA round GRANT EXECUTE ON FUNCTIONS TO seedhost_app;

-- Postgres enums, not text + CHECK (design/06 §1): every one of these is a code-owned
-- vocabulary that moves with a migration and a release, never with a row a tenant writes. The
-- TypeScript halves live in src/model.ts and in `@seed-host/round-terms`, and the column types
-- are derived from them so the two cannot drift.
CREATE TYPE round.stage AS ENUM ('pre_seed', 'seed', 'series_a', 'series_b', 'bridge', 'other');
CREATE TYPE round.instrument_kind AS ENUM ('safe', 'note', 'priced');
CREATE TYPE round.status AS ENUM ('planning', 'open', 'closed');
CREATE TYPE round.commitment_status AS ENUM ('soft', 'verbal', 'signed', 'wired', 'withdrawn');
CREATE TYPE round.interest_status AS ENUM ('submitted', 'accepted', 'declined', 'withdrawn');
CREATE TYPE round.accreditation_path AS ENUM ('none', 'self_attested', 'self_certified', 'verification_required');
CREATE TYPE round.verification_status AS ENUM ('pending', 'verified', 'rejected', 'expired');
CREATE TYPE round.verification_method AS ENUM ('document_review', 'third_party', 'professional_letter', 'minimum_investment');

--> statement-breakpoint
CREATE TABLE round.round (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  name text NOT NULL,
  stage round.stage NOT NULL,
  instrument_kind round.instrument_kind NOT NULL,
  status round.status NOT NULL DEFAULT 'planning',
  -- numeric(20, 6) everywhere money appears (§7). `pg` hands it back as text and the repos
  -- turn it into a fixed-point bigint; nothing in this module puts it through Number().
  target_amount numeric(20, 6) NOT NULL,
  -- ISO 4217, one currency per round (E2.5 open question 11). A bridge in EUR after a seed in
  -- USD is two rounds, which is what the table already models.
  currency text NOT NULL,
  minimum_investment numeric(20, 6),
  -- The window the company *intends* to be open for. `opened_at`/`closed_at` are what actually
  -- happened; both pairs are kept because a round that opened late is a fact and the plan for
  -- it was a different fact.
  opens_at timestamptz,
  closes_at timestamptz,
  opened_at timestamptz,
  closed_at timestamptz,
  -- E2.5 D8: whether investors see the progress bar at all. Staff always see every bucket.
  show_progress boolean NOT NULL DEFAULT true,
  -- Use of funds and timeline, as Markdown. Prose belongs here and not in `terms`, which is
  -- structured data the calculator reads.
  summary text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT round_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT round_target_positive CHECK (target_amount > 0),
  CONSTRAINT round_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT round_minimum_positive CHECK (minimum_investment IS NULL OR minimum_investment > 0),
  CONSTRAINT round_window_ordered CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at),
  CONSTRAINT round_summary_length CHECK (summary IS NULL OR char_length(summary) <= 4000)
);
-- One open round per workspace (§R). The uniqueness is here rather than in the service because
-- two concurrent `POST /open` calls would both pass a SELECT-then-INSERT check; the service
-- turns the 23505 into a 409 `round_already_open`.
CREATE UNIQUE INDEX round_one_open_idx ON round.round (workspace_id) WHERE status = 'open';
CREATE INDEX round_workspace_idx ON round.round (workspace_id, created_at DESC);
CREATE TRIGGER round_set_updated_at BEFORE UPDATE ON round.round
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE round.terms (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES round.round (id) ON DELETE CASCADE,
  revision integer NOT NULL,
  -- One of SafeTerms | NoteTerms | PricedTerms, discriminated by `kind` and parsed against the
  -- round's own `instrument_kind` (`parseTerms`), so a note body can never be stored on a SAFE.
  terms jsonb NOT NULL,
  terms_schema_version integer NOT NULL DEFAULT 1,
  -- The date the terms are *as of*, which is not the date the row was written: a term sheet
  -- signed on the 1st and entered on the 5th is as of the 1st.
  as_of timestamptz NOT NULL DEFAULT now(),
  -- `<slug>:v<n>` of the disclaimer in force when this revision was written (EXECUTION_PLAN
  -- :471 "mandatory versioned disclaimer blocks").
  disclaimer_stamp text,
  superseded_by uuid REFERENCES round.terms (id) ON DELETE SET NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT terms_revision_positive CHECK (revision >= 1),
  CONSTRAINT terms_not_self_superseding CHECK (superseded_by IS NULL OR superseded_by <> id),
  CONSTRAINT terms_revision_unique UNIQUE (round_id, revision)
);
-- Exactly one live revision per round, by construction rather than by convention — and
-- **deferrable**, which is the whole reason it is an exclusion constraint rather than a partial
-- unique index. Writing a revision inserts the new row and *then* points the old row's
-- `superseded_by` at it, so there are two live rows for the width of one statement; a partial
-- unique index is checked per statement and would refuse every edit a round's terms ever had.
-- A UNIQUE constraint cannot be partial, so it cannot be the answer either. `metrics.point`
-- reaches the same shape for the same reason.
ALTER TABLE round.terms ADD CONSTRAINT terms_one_current
  EXCLUDE USING gist (round_id WITH =) WHERE (superseded_by IS NULL)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX terms_current_idx ON round.terms (round_id) WHERE superseded_by IS NULL;
CREATE INDEX terms_workspace_idx ON round.terms (workspace_id, round_id, revision DESC);

-- Append-only, the same shape metrics.point uses and for the same reason: superseding *is* an
-- update, so REVOKE UPDATE is not available and a trigger has to tell the one legal update from
-- every other one. DELETE is deliberately **not** blocked — `round.round` cascades, and a
-- planning round with nothing attached may be removed outright.
CREATE OR REPLACE FUNCTION round.terms_are_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF to_jsonb(NEW) - 'superseded_by' IS DISTINCT FROM to_jsonb(OLD) - 'superseded_by' THEN
    RAISE EXCEPTION 'round.terms % is immutable: a change is a new revision, not an edit', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'round.terms % is already superseded by %: supersede the newest revision instead', OLD.id, OLD.superseded_by
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.superseded_by IS NULL THEN
    RAISE EXCEPTION 'round.terms % cannot be un-superseded: restore the wording with a further revision', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER terms_append_only BEFORE UPDATE ON round.terms
  FOR EACH ROW EXECUTE FUNCTION round.terms_are_append_only();

CREATE TABLE round.interest_submission (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES round.round (id) ON DELETE CASCADE,
  -- NOT NULL: an attestation is per-membership (ADR-0011), so a stranger has to become a
  -- membership before they can indicate interest at all.
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  amount numeric(20, 6) NOT NULL,
  currency text NOT NULL,
  subject text NOT NULL,
  entity_name text,
  note text,
  -- What `eligibility()` decided from (offering status, subject, amount, currency). Stored
  -- rather than recomputed: the status can move afterwards, and what matters six years later is
  -- the rule that applied on the day (E2.5 D4).
  accreditation_path round.accreditation_path NOT NULL,
  -- The questionnaire came back with no category: a real answer, and the one the 506(b)
  -- 35-purchaser count acts on (E2.5 D7).
  non_accredited boolean NOT NULL DEFAULT false,
  accreditation_stamp text,
  disclaimer_stamp text,
  -- Snapshot of `core.workspace.offering_status` at submission. Plain text, not the kernel
  -- enum: a status this release does not know must still be readable here.
  offering_status text NOT NULL,
  status round.interest_status NOT NULL DEFAULT 'submitted',
  verification_id uuid,
  commitment_id uuid,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT interest_amount_positive CHECK (amount > 0),
  CONSTRAINT interest_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT interest_subject_known CHECK (subject IN ('individual', 'entity')),
  CONSTRAINT interest_entity_name_length CHECK (entity_name IS NULL OR char_length(entity_name) BETWEEN 1 AND 200),
  CONSTRAINT interest_note_length CHECK (note IS NULL OR char_length(note) <= 4000),
  CONSTRAINT interest_decision_note_length CHECK (decision_note IS NULL OR char_length(decision_note) <= 2000),
  CONSTRAINT interest_decided_together CHECK ((decided_by IS NULL) = (decided_at IS NULL))
);
-- One *open* submission per member per round. A member whose submission was declined may try
-- again; a member with one already in the queue may not queue a second.
CREATE UNIQUE INDEX interest_open_per_member_idx ON round.interest_submission (round_id, membership_id)
  WHERE status = 'submitted';
CREATE INDEX interest_queue_idx ON round.interest_submission (workspace_id, round_id, status, created_at DESC);
CREATE INDEX interest_member_idx ON round.interest_submission (workspace_id, membership_id, created_at DESC);
CREATE TRIGGER interest_submission_set_updated_at BEFORE UPDATE ON round.interest_submission
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE round.verification (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  interest_submission_id uuid REFERENCES round.interest_submission (id) ON DELETE SET NULL,
  -- `AccreditationVerificationPort.driver`; `manual` is the only adapter today (E2.5 D6).
  provider text NOT NULL DEFAULT 'manual',
  provider_ref text,
  method round.verification_method,
  status round.verification_status NOT NULL DEFAULT 'pending',
  -- The storage key, never the bytes. The object is envelope-encrypted under the workspace DEK
  -- before it is written, scanned before it is encrypted, and deleted by round.evidence_purge.
  evidence_key text,
  evidence_sha256 text,
  evidence_content_type text,
  evidence_bytes integer,
  evidence_note text,
  evidence_uploaded_at timestamptz,
  evidence_purged_at timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  -- When the decision stops standing: 90 days for a professional letter (design/04 §183),
  -- twelve months otherwise, matching ACCREDITATION_VALID_MONTHS.
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_note_length CHECK (evidence_note IS NULL OR char_length(evidence_note) <= 2000),
  CONSTRAINT verification_decision_note_length CHECK (decision_note IS NULL OR char_length(decision_note) <= 2000),
  CONSTRAINT verification_bytes_positive CHECK (evidence_bytes IS NULL OR evidence_bytes > 0),
  -- design/04 §1.6: "block `verified` without evidence". The column CHECK is the floor — a
  -- method, something that was read, and a person who read it. The service is stricter still:
  -- document_review and professional_letter need a *file*, because a note saying "I saw a bank
  -- statement" is not the bank statement.
  --
  -- `evidence_sha256` counts, and it has to: the nightly purge clears `evidence_key` once the
  -- decision is old enough (design/04 §102), and a CHECK that named only the key and the note
  -- would make the purge impossible on exactly the verifications it exists for. What survives is
  -- the *reference* — the digest of the file that was read, or the text of the note — which is
  -- what keeps the decision provable after the document itself is gone.
  CONSTRAINT verification_verified_has_evidence CHECK (
    status <> 'verified'
    OR (
      method IS NOT NULL
      AND decided_by IS NOT NULL
      AND (evidence_key IS NOT NULL OR evidence_note IS NOT NULL OR evidence_sha256 IS NOT NULL)
    )
  )
);
CREATE INDEX verification_queue_idx ON round.verification (workspace_id, status, created_at DESC);
CREATE INDEX verification_member_idx ON round.verification (workspace_id, membership_id, created_at DESC);
-- The purge job's access path: decided, with a file still on disk.
CREATE INDEX verification_purge_idx ON round.verification (workspace_id, decided_at)
  WHERE evidence_key IS NOT NULL AND evidence_purged_at IS NULL;
CREATE TRIGGER verification_set_updated_at BEFORE UPDATE ON round.verification
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE round.interest_submission
  ADD CONSTRAINT interest_verification_fk FOREIGN KEY (verification_id)
  REFERENCES round.verification (id) ON DELETE SET NULL;

CREATE TABLE round.commitment (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES round.round (id) ON DELETE CASCADE,
  membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  -- Soft references into `crm`: a uuid and no foreign key, because modules never read each
  -- other's tables (ADR-0007) and a constraint across schemas would be exactly that read.
  organization_id uuid,
  contact_id uuid,
  -- For the commitment that has no portal identity at all — the angel who signed on paper.
  display_name text,
  amount numeric(20, 6) NOT NULL,
  status round.commitment_status NOT NULL DEFAULT 'soft',
  note text,
  interest_submission_id uuid REFERENCES round.interest_submission (id) ON DELETE SET NULL,
  signed_document_id uuid,
  wired_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commitment_amount_positive CHECK (amount > 0),
  CONSTRAINT commitment_note_length CHECK (note IS NULL OR char_length(note) <= 4000),
  CONSTRAINT commitment_display_name_length CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 200),
  -- A commitment with no subject at all is a number nobody can chase.
  CONSTRAINT commitment_has_subject CHECK (
    membership_id IS NOT NULL OR display_name IS NOT NULL
    OR organization_id IS NOT NULL OR contact_id IS NOT NULL
  )
);
CREATE INDEX commitment_round_idx ON round.commitment (workspace_id, round_id, status, created_at DESC);
CREATE INDEX commitment_member_idx ON round.commitment (workspace_id, membership_id) WHERE membership_id IS NOT NULL;
CREATE TRIGGER commitment_set_updated_at BEFORE UPDATE ON round.commitment
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE round.interest_submission
  ADD CONSTRAINT interest_commitment_fk FOREIGN KEY (commitment_id)
  REFERENCES round.commitment (id) ON DELETE SET NULL;

CREATE TABLE round.closing_task (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES round.round (id) ON DELETE CASCADE,
  title text NOT NULL,
  done_at timestamptz,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closing_task_title_length CHECK (char_length(title) BETWEEN 1 AND 200)
);
CREATE INDEX closing_task_round_idx ON round.closing_task (workspace_id, round_id, position);
CREATE TRIGGER closing_task_set_updated_at BEFORE UPDATE ON round.closing_task
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

--> statement-breakpoint
-- Row-level security. Staff and system actors work on everything in their own workspace.
--
-- What an *external* actor reaches is the interesting half, and it is deliberately narrow:
--  * a round, and its terms, once it is open or closed — never while it is `planning`, because
--    a draft target is not an offer and EXECUTION_PLAN §47 says no offering content is reachable
--    before somebody decides to publish it;
--  * their own interest submissions, which they may write (the form) and withdraw;
--  * their own verifications, read-only — the evidence upload is written by the service in a
--    system context after it has checked ownership itself, because an UPDATE policy wide enough
--    to admit the upload would be wide enough to admit `status = 'verified'`;
--  * nothing at all of `commitment` or `closing_task`. What another investor put in, and where
--    the company is in its own closing checklist, are not facts an investor is entitled to.
ALTER TABLE round.round ENABLE ROW LEVEL SECURITY;
ALTER TABLE round.round FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON round.round AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY round_staff ON round.round FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY round_external_read ON round.round FOR SELECT
  USING (core.current_actor_kind() = 'external' AND status IN ('open', 'closed'));

ALTER TABLE round.terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE round.terms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON round.terms AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY terms_staff ON round.terms FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
-- The round's own visibility governs its terms: there is no per-revision gating, and a
-- superseded revision stays readable because "what was I shown in March" is a question an
-- investor is entitled to answer for themselves.
CREATE POLICY terms_external_read ON round.terms FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND EXISTS (
      SELECT 1 FROM round.round r
      WHERE r.id = terms.round_id AND r.status IN ('open', 'closed')
    )
  );

ALTER TABLE round.interest_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE round.interest_submission FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON round.interest_submission AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY interest_staff ON round.interest_submission FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY interest_external_read ON round.interest_submission FOR SELECT
  USING (core.current_actor_kind() = 'external' AND membership_id = core.current_membership());
CREATE POLICY interest_external_insert ON round.interest_submission FOR INSERT
  WITH CHECK (core.current_actor_kind() = 'external' AND membership_id = core.current_membership());
-- Withdrawal only, in practice: the service is what decides which columns move, and an
-- external actor never reaches the accept/decline path, which needs `round.manage`.
CREATE POLICY interest_external_update ON round.interest_submission FOR UPDATE
  USING (core.current_actor_kind() = 'external' AND membership_id = core.current_membership())
  WITH CHECK (core.current_actor_kind() = 'external' AND membership_id = core.current_membership());

ALTER TABLE round.verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE round.verification FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON round.verification AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY verification_staff ON round.verification FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY verification_external_read ON round.verification FOR SELECT
  USING (core.current_actor_kind() = 'external' AND membership_id = core.current_membership());

ALTER TABLE round.commitment ENABLE ROW LEVEL SECURITY;
ALTER TABLE round.commitment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON round.commitment AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY commitment_staff ON round.commitment FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE round.closing_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE round.closing_task FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON round.closing_task AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY closing_task_staff ON round.closing_task FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

SELECT core.apply_tenant_fence();
