-- 0003_delegates — what a delegate (E3.2, core migration 0017) may do with the round.
--
-- Hand-written (ADR-0004). Policies only; no table changes, so src/schema/round.ts is unchanged.
-- Runs inside one transaction.
--
-- A delegate acts for an investor with a scope (`all` | `data_room` | `updates`). The round is
-- neither data room nor updates content, so only an `all` delegate reads it
-- (`core.current_delegation_admits('round')`, which is also false for a delegate whose principal
-- is not live). No delegate writes round data at all: an indication of interest, its eligibility
-- answers and its accreditation evidence are the investor's own statements, and a delegate's
-- membership is not the investor (review round 1, F3). The routes refuse the same things first
-- (`403 forbidden` for writes, `404` for reads a narrow scope does not admit); these policies are
-- the floor under them.

--> statement-breakpoint
DROP POLICY round_external_read ON round.round;
CREATE POLICY round_external_read ON round.round FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND status IN ('open', 'closed')
    AND (SELECT core.current_delegation_admits('round'))
  );

DROP POLICY terms_external_read ON round.terms;
CREATE POLICY terms_external_read ON round.terms FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND (SELECT core.current_delegation_admits('round'))
    AND EXISTS (
      SELECT 1 FROM round.round r
      WHERE r.id = terms.round_id AND r.status IN ('open', 'closed')
    )
  );

DROP POLICY interest_external_insert ON round.interest_submission;
CREATE POLICY interest_external_insert ON round.interest_submission FOR INSERT
  WITH CHECK (
    core.current_actor_kind() = 'external'
    AND membership_id = core.current_membership()
    AND NOT (SELECT core.current_membership_is_delegate())
  );

DROP POLICY interest_external_update ON round.interest_submission;
CREATE POLICY interest_external_update ON round.interest_submission FOR UPDATE
  USING (
    core.current_actor_kind() = 'external'
    AND membership_id = core.current_membership()
    AND NOT (SELECT core.current_membership_is_delegate())
  )
  WITH CHECK (
    core.current_actor_kind() = 'external'
    AND membership_id = core.current_membership()
    AND NOT (SELECT core.current_membership_is_delegate())
  );

SELECT core.apply_tenant_fence();
