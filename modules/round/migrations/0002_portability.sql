-- 0002_portability — what a workspace export/import (E2.8) needs from the round schema: forward
-- references that can be resolved at COMMIT, and an evidence object that says which key sealed it.
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/round.ts. Runs inside one
-- transaction. Adding a column and altering constraints on tables this module already owns needs
-- no new grants or policy: the tenant fence and the `seedhost_app` privileges cover them.
--
-- 1. Deferrable forward references. The import inserts every row of a workspace in one
--    transaction, table by table in primary-key order, and three references here point at a row
--    that may not exist yet when the referencing row is inserted:
--      * `terms.superseded_by` names the NEXT revision of the same round (a later uuidv7, so a
--        later row of the same table);
--      * `interest_submission.verification_id` / `.commitment_id` name rows of tables that are
--        themselves created from the submission (and so reference it back).
--    `DEFERRABLE INITIALLY DEFERRED` moves the check to COMMIT, where the invariant belongs; the
--    application's own writes always name an existing row, so for them nothing changes except
--    *when* a (never-seen) violation would be reported. `terms_one_current` is already deferred,
--    and the append-only trigger fires on UPDATE only, so inserting a superseded revision as it
--    was exported is legal.
ALTER TABLE round.terms ALTER CONSTRAINT terms_superseded_by_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE round.interest_submission
  ALTER CONSTRAINT interest_verification_fk DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE round.interest_submission
  ALTER CONSTRAINT interest_commitment_fk DEFERRABLE INITIALLY DEFERRED;

-- 2. The evidence envelope descriptor. Evidence objects are SHE1 under the workspace's
--    `round-evidence` DEK, and until now the row did not say which key: the reader asked for the
--    *current* one, which a rotation would silently break and which an export cannot follow (it
--    has to decrypt with the source key and re-seal under the target's). `{format:"she1", keyId,
--    keyRef}`, the shape data-room and metrics already store. NULL on rows written before this
--    migration (and on rows without a file); the reader falls back to the current key for those.
ALTER TABLE round.verification
  ADD COLUMN evidence_encryption jsonb,
  ADD COLUMN evidence_encryption_schema_version integer NOT NULL DEFAULT 1;

-- Backfill: the only key such an object can have been sealed with is the workspace's active
-- `round-evidence` key (it has never been rotated — nothing rotates it). A migrating role without
-- BYPASSRLS sees zero rows here (the runner warns); those rows keep the current-key fallback and
-- the export leaves their file behind (see src/portability.ts).
UPDATE round.verification v SET
  evidence_encryption = jsonb_build_object('format', 'she1', 'keyId', k.id, 'keyRef', k.kms_key_ref)
FROM core.workspace_key k
WHERE k.workspace_id = v.workspace_id
  AND k.purpose = 'round-evidence'
  AND k.retired_at IS NULL
  AND v.evidence_key IS NOT NULL
  AND v.evidence_encryption IS NULL;
