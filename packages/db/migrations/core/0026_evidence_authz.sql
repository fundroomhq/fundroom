-- 0026_evidence_authz — external audit anchoring and the optional authz engine's sync state
-- (EXECUTION_PLAN §15 E3.13, ADR-0061).
--
-- Hand-written (ADR-0004). The TypeScript views are src/schema/audit.ts (anchor_batch,
-- anchor_receipt, the new audit.anchor columns) and src/schema/authz-engine.ts. Runs inside one
-- transaction; tenant tables declare their fence inline.
--
--  * audit.anchor_batch    one anchoring run: an RFC 6962 Merkle tree over the leaf hashes of every
--                          checkpoint that had no anchor yet (all workspaces plus the platform
--                          chain). Only the 32-byte root leaves the install. GLOBAL (no
--                          workspace_id): a root and a leaf count say nothing about any tenant.
--  * audit.anchor_receipt  what one anchor driver (`rfc3161`, `rekor`) returned for a batch root:
--                          a human locator plus the offline-verifiable proof (`receipt`). At most
--                          one per (batch, driver); drivers that failed are retried on later runs
--                          by INSERTing then. GLOBAL like the batch.
--  * audit.anchor          (existing, 0002) gains the checkpoint's place in a batch: `batch_id`,
--                          `leaf_index` and `proof` ({ leafHash, path: [hex…], treeSize }). New rows
--                          use kind 'merkle' and reference = the batch id; one per checkpoint.
--  * core.authz_engine_state  per workspace: which store/model the external relationship engine
--                          holds and the acl_version it was last synced to. Instance-local
--                          (a projection the app can rebuild at any time); system context only.
--  * core.share_link_forced_watermark(ws, membership)
--                          whether a membership is bound (a non-revoked share_link_visit) to a
--                          non-revoked link whose policy forces the visible watermark. The data
--                          room enforces it on delivery (E3.13 fixes the E2.3 gap: the flag was
--                          stored but never applied). SECURITY DEFINER with row security off: the
--                          viewer's own (external) context cannot read core.share_link. It answers
--                          one boolean for the CURRENT workspace only and refuses any other. Paused
--                          and expired links still force (the safe direction); revoked ones do not.
--
-- Evidence rules (all three audit tables): append-only (audit.reject_change on UPDATE/DELETE,
-- seedhost_app has SELECT/INSERT only by the audit schema's default privileges), and the
-- break-glass role may not write them (core.break_glass_refuse, 0015). Inserts come from the
-- system (anchoring job / CLI) or host context only; staff and system read (the workspace's own
-- proofs embed the batch root and receipts anyway).

--> statement-breakpoint
CREATE TABLE audit.anchor_batch (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  merkle_root bytea NOT NULL,
  leaf_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anchor_batch_root_length CHECK (octet_length(merkle_root) = 32),
  CONSTRAINT anchor_batch_leaf_count CHECK (leaf_count > 0)
);
CREATE INDEX anchor_batch_created_idx ON audit.anchor_batch (created_at DESC);
REVOKE UPDATE, DELETE, TRUNCATE ON audit.anchor_batch FROM seedhost_app;

CREATE TABLE audit.anchor_receipt (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  batch_id uuid NOT NULL REFERENCES audit.anchor_batch (id),
  kind text NOT NULL,
  reference text NOT NULL,
  anchored_at timestamptz NOT NULL,
  receipt jsonb NOT NULL,
  receipt_schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT anchor_receipt_kind_format CHECK (kind ~ '^[a-z][a-z0-9_-]*$'),
  CONSTRAINT anchor_receipt_reference_length CHECK (char_length(reference) BETWEEN 1 AND 2000),
  CONSTRAINT anchor_receipt_object CHECK (jsonb_typeof(receipt) = 'object'),
  CONSTRAINT anchor_receipt_batch_kind UNIQUE (batch_id, kind)
);
REVOKE UPDATE, DELETE, TRUNCATE ON audit.anchor_receipt FROM seedhost_app;

--> statement-breakpoint
ALTER TABLE audit.anchor
  ADD COLUMN batch_id uuid REFERENCES audit.anchor_batch (id),
  ADD COLUMN leaf_index integer,
  ADD COLUMN proof jsonb,
  ADD COLUMN proof_schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE audit.anchor
  ADD CONSTRAINT anchor_merkle_shape CHECK (
    kind <> 'merkle'
    OR (batch_id IS NOT NULL AND leaf_index IS NOT NULL AND proof IS NOT NULL)
  ),
  ADD CONSTRAINT anchor_leaf_index_non_negative CHECK (leaf_index IS NULL OR leaf_index >= 0),
  ADD CONSTRAINT anchor_proof_object CHECK (proof IS NULL OR jsonb_typeof(proof) = 'object');
CREATE UNIQUE INDEX anchor_merkle_checkpoint_idx ON audit.anchor (checkpoint_id)
  WHERE kind = 'merkle';
CREATE INDEX anchor_batch_idx ON audit.anchor (batch_id) WHERE batch_id IS NOT NULL;
-- An anchor row names a checkpoint OF ITS OWN workspace (E3.13 FIX1 A4): the FK check bypasses
-- RLS, so with a plain FK on checkpoint_id a row fenced to workspace A could squat on workspace
-- B's checkpoint in the global merkle index and wedge every anchoring run.
ALTER TABLE audit.checkpoint
  ADD CONSTRAINT checkpoint_workspace_id_unique UNIQUE (workspace_id, id);
ALTER TABLE audit.anchor
  ADD CONSTRAINT anchor_checkpoint_same_workspace FOREIGN KEY (workspace_id, checkpoint_id)
    REFERENCES audit.checkpoint (workspace_id, id);
-- Only the anchoring job (system) or host may insert; every tenant context still reads its own
-- rows through tenant_fence (0002's permissive FOR ALL policy is replaced).
DROP POLICY anchor_access ON audit.anchor;
CREATE POLICY anchor_read ON audit.anchor FOR SELECT USING (true);
CREATE POLICY anchor_insert ON audit.anchor FOR INSERT
  WITH CHECK (core.current_actor_kind() IN ('system', 'host'));

--> statement-breakpoint
CREATE TRIGGER anchor_batch_immutable BEFORE UPDATE OR DELETE ON audit.anchor_batch
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER anchor_batch_no_truncate BEFORE TRUNCATE ON audit.anchor_batch
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER anchor_receipt_immutable BEFORE UPDATE OR DELETE ON audit.anchor_receipt
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER anchor_receipt_no_truncate BEFORE TRUNCATE ON audit.anchor_receipt
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
CREATE TRIGGER break_glass_refuse BEFORE INSERT OR UPDATE OR DELETE ON audit.anchor_batch
  FOR EACH ROW EXECUTE FUNCTION core.break_glass_refuse();
CREATE TRIGGER break_glass_refuse BEFORE INSERT OR UPDATE OR DELETE ON audit.anchor_receipt
  FOR EACH ROW EXECUTE FUNCTION core.break_glass_refuse();

-- Global tables: no workspace fence. Staff, system and host read; only system and host insert.
ALTER TABLE audit.anchor_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.anchor_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY anchor_batch_read ON audit.anchor_batch FOR SELECT
  USING (core.current_actor_kind() IN ('staff', 'system', 'host'));
CREATE POLICY anchor_batch_insert ON audit.anchor_batch FOR INSERT
  WITH CHECK (core.current_actor_kind() IN ('system', 'host'));

ALTER TABLE audit.anchor_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.anchor_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY anchor_receipt_read ON audit.anchor_receipt FOR SELECT
  USING (core.current_actor_kind() IN ('staff', 'system', 'host'));
CREATE POLICY anchor_receipt_insert ON audit.anchor_receipt FOR INSERT
  WITH CHECK (core.current_actor_kind() IN ('system', 'host'));

--> statement-breakpoint
CREATE TABLE core.authz_engine_state (
  workspace_id uuid PRIMARY KEY REFERENCES core.workspace (id) ON DELETE CASCADE,
  driver text NOT NULL,
  store_ref text,
  model_ref text,
  synced_acl_version bigint NOT NULL DEFAULT 0,
  synced_at timestamptz,
  last_error_code text,
  -- The sync lease (E3.13 FIX2 C9): one sync per workspace at a time across processes, pooler-safe
  -- (PgBouncer transaction pooling) unlike a session advisory lock. Claimed by a conditional
  -- UPDATE, taken over once expired, released by its owner; a sync records only while it owns it.
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authz_engine_state_driver CHECK (driver ~ '^[a-z][a-z0-9_-]{0,31}$'),
  CONSTRAINT authz_engine_state_error_code CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,64}$'
  ),
  CONSTRAINT authz_engine_state_version CHECK (synced_acl_version >= 0),
  CONSTRAINT authz_engine_state_lease CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CONSTRAINT authz_engine_state_lease_owner CHECK (
    lease_owner IS NULL OR lease_owner ~ '^[A-Za-z0-9_-]{1,64}$'
  )
);

CREATE TRIGGER authz_engine_state_set_updated_at BEFORE UPDATE ON core.authz_engine_state
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE core.authz_engine_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.authz_engine_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.authz_engine_state AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY authz_engine_state_system ON core.authz_engine_state FOR ALL
  USING (core.current_actor_kind() = 'system')
  WITH CHECK (core.current_actor_kind() = 'system');

--> statement-breakpoint
CREATE FUNCTION core.share_link_forced_watermark(p_workspace uuid, p_membership uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public SET row_security = off AS $$
BEGIN
  IF p_workspace IS DISTINCT FROM core.current_workspace() THEN
    RAISE EXCEPTION 'share_link_forced_watermark: workspace is not the current workspace'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM core.share_link_visit v
    JOIN core.share_link l ON l.id = v.link_id AND l.workspace_id = v.workspace_id
    WHERE v.workspace_id = p_workspace
      AND v.membership_id = p_membership
      AND v.revoked_at IS NULL
      AND l.revoked_at IS NULL
      AND l.status <> 'revoked'
      AND l.policy -> 'forceWatermark' = 'true'::jsonb
  );
END $$;
REVOKE ALL ON FUNCTION core.share_link_forced_watermark(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.share_link_forced_watermark(uuid, uuid) TO seedhost_app;

-- No per-table GRANT: the default privileges of the core (0000) and audit (0002) schemas already
-- cover new tables.

SELECT core.apply_tenant_fence();
