-- 0004_vault — vaulting signed e-signature documents into the data room (EXECUTION_PLAN §15
-- E3.5, ADR-0053).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/dataroom.ts. Runs inside one
-- transaction. Columns on tables this module already owns need no new grants or policy: the
-- tenant fence and the `seedhost_app` privileges cover them.
--
--  * document.esign_envelope_id  the kernel envelope (`core.esign_envelope`, a soft reference) a
--                                vaulted document was created from. Partial unique per workspace:
--                                a redelivered `esign.envelope_completed` event cannot vault the
--                                same envelope twice (the vault job treats 23505 on this index as
--                                "already done"). The certificate travels as a second document of
--                                the same envelope, so it is NOT stamped here (see the job).
--  * folder.staff_only           a folder whose contents no external member can reach through an
--                                inherited grant. The semantics (how the authz rebuild/evaluate
--                                path honours it) belong to the vaulting work, not this migration.

--> statement-breakpoint
ALTER TABLE dataroom.document ADD COLUMN esign_envelope_id uuid;
CREATE UNIQUE INDEX document_esign_envelope_idx ON dataroom.document (workspace_id, esign_envelope_id)
  WHERE esign_envelope_id IS NOT NULL;

--> statement-breakpoint
ALTER TABLE dataroom.folder ADD COLUMN staff_only boolean NOT NULL DEFAULT false;

SELECT core.apply_tenant_fence();
