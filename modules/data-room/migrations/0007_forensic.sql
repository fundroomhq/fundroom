-- 0007_forensic — forensic (invisible) watermark marks (EXECUTION_PLAN §15 E3.13, ADR-0061).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/forensic.ts. Runs inside one
-- transaction; the table declares the standard fence inline so nothing can read a row before the
-- runner's core.apply_tenant_fence() pass.
--
--  * forensic_mark  one row per (viewer membership, document version) that was served at least
--                   once with an invisible mark. `token` (8 random bytes) is what the page pattern
--                   is keyed on: seed = HMAC(pattern key of `key_id`, "mark\0" || token). Rows
--                   hold no PII (a membership id only) and are kept on erasure: they are the
--                   evidence a leak investigation tests against. `membership_id` has no FK for
--                   the same reason (the membership row is pseudonymised, never deleted, but the
--                   evidence must not depend on that). Purging a document or version cascades.
--                   `last_view_as_at` / `view_as_membership_id` record that the mark was served
--                   while its member (staff) viewed as that investor (E2.7 view-as): such a copy
--                   shows the investor's visible line over the staff member's invisible mark.
--                   Instance-local: not exported (the pattern keys come from this install's key
--                   ring), so portability skips the table.
--
-- RLS: the fence; staff read (the recipients list and detection run as staff); only the system
-- context writes (marks are issued for every viewer kind, so delivery issues them as system).
-- External actors see nothing.

--> statement-breakpoint
CREATE TABLE dataroom.forensic_mark (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES dataroom.document (id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES dataroom.document_version (id) ON DELETE CASCADE,
  token bytea NOT NULL,
  key_id text NOT NULL,
  first_served_at timestamptz NOT NULL DEFAULT now(),
  last_served_at timestamptz NOT NULL DEFAULT now(),
  -- Set when this (staff) member was last served the version while viewing as an investor: the
  -- page then showed the investor's VISIBLE line over this member's invisible mark.
  last_view_as_at timestamptz,
  view_as_membership_id uuid,
  CONSTRAINT forensic_mark_token_length CHECK (octet_length(token) = 8),
  CONSTRAINT forensic_mark_key_id_length CHECK (char_length(key_id) BETWEEN 1 AND 64),
  CONSTRAINT forensic_mark_served_order CHECK (last_served_at >= first_served_at),
  CONSTRAINT forensic_mark_view_as_pair CHECK ((last_view_as_at IS NULL) = (view_as_membership_id IS NULL)),
  CONSTRAINT forensic_mark_viewer_version UNIQUE (workspace_id, membership_id, version_id),
  CONSTRAINT forensic_mark_token_unique UNIQUE (token)
);

CREATE INDEX forensic_mark_version_idx ON dataroom.forensic_mark (workspace_id, version_id, id);
CREATE INDEX forensic_mark_document_idx ON dataroom.forensic_mark (document_id);

ALTER TABLE dataroom.forensic_mark ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataroom.forensic_mark FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON dataroom.forensic_mark AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY forensic_mark_staff_read ON dataroom.forensic_mark FOR SELECT
  USING (core.current_actor_kind() = 'staff');
CREATE POLICY forensic_mark_system ON dataroom.forensic_mark FOR ALL
  USING (core.current_actor_kind() = 'system')
  WITH CHECK (core.current_actor_kind() = 'system');

SELECT core.apply_tenant_fence();
