-- 0006_compliance — offering-status history, the versioned legal-document library, consent
-- events and the relationship evidence fields (EXECUTION_PLAN §11, ADR-0019, ADR-0037, E1.6).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/compliance.ts. Runs inside one
-- transaction. Every table here is a plain tenant table: the standard fence is declared inline
-- so nothing can read a row before the runner's core.apply_tenant_fence() pass.
--
-- Model (design/04 §1.6, §3.2, §7; requirements R2, R5, R9, R11, R13, R18):
--  * offering_period       append-only history of core.workspace.offering_status. The column on
--                          the workspace stays the fast read; this table is the evidence, and it
--                          answers "which status was in force when this document was viewed".
--                          One open period per workspace; rows are immutable apart from closing.
--  * legal_document        one tenant legal text per slug (privacy notice, NDA, a disclaimer,
--                          the self-certification form). Seeded from @seed-host/compliance
--                          templates, then editable. `requires_acceptance` makes it a gate.
--  * legal_document_version  immutable published versions. Acceptance is recorded against a
--                          version, never against the document, so a later edit cannot change
--                          what somebody agreed to. `body_sha256` is the click-wrap evidence
--                          that design/04 §4 requires.
--  * consent_event         append-only consent record, separate from notice acceptance because
--                          GDPR requires consent to be unbundled (design/04 §3.2, R13). The
--                          effective answer is the newest row per (membership, purpose).
--
-- Acceptances themselves reuse core.attestation (kind '<slug>:v<n>'), which already feeds the
-- nda/accredited policy gates from ADR-0032 — an accepted NDA settles its gate with no new
-- plumbing. This migration also tightens that table's RLS: it shipped in 0001 with a permissive
-- FOR ALL policy, which let any member of a workspace read another member's legal facts.

CREATE TYPE core.legal_document_kind AS ENUM (
  'privacy_notice', 'nda', 'terms', 'disclaimer', 'accreditation', 'cookie_notice'
);
CREATE TYPE core.legal_audience AS ENUM ('external', 'staff', 'all');
CREATE TYPE core.legal_source AS ENUM ('template', 'custom');
CREATE TYPE core.consent_purpose AS ENUM ('analytics_engagement', 'email_tracking');
CREATE TYPE core.consent_source AS ENUM ('gate', 'settings', 'gpc', 'host_cmp', 'admin');

--> statement-breakpoint
-- The relationship evidence Rule 506(b) needs (design/04 §1.6, R5). The first two columns
-- shipped unused in 0001; `relationship_note` carries the free text counsel asked for and
-- `first_exposure_at` is stamped the first time a member is served offering material, so the
-- warning heuristic can compare "when did we meet" against "when did they first see the deck".
ALTER TABLE core.membership ADD COLUMN relationship_note text;
ALTER TABLE core.membership ADD COLUMN first_exposure_at timestamptz;

CREATE TABLE core.offering_period (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  status core.offering_status NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  changed_by uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offering_period_window CHECK (ended_at IS NULL OR ended_at >= started_at)
);
-- At most one open period per workspace: the open row is the current status by construction.
CREATE UNIQUE INDEX offering_period_open_idx ON core.offering_period (workspace_id) WHERE ended_at IS NULL;
CREATE INDEX offering_period_workspace_idx ON core.offering_period (workspace_id, started_at DESC);

CREATE TABLE core.legal_document (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  kind core.legal_document_kind NOT NULL,
  slug citext NOT NULL,
  title text NOT NULL,
  -- which template this was seeded from, so an upstream template bump is diffable
  template_id text,
  template_version integer,
  -- the member must accept the current version before being served anything else
  requires_acceptance boolean NOT NULL DEFAULT false,
  audience core.legal_audience NOT NULL DEFAULT 'external',
  current_version_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT legal_document_slug_format CHECK (slug ~ '^[a-z][a-z0-9-]{0,62}$')
);
CREATE UNIQUE INDEX legal_document_slug_idx ON core.legal_document (workspace_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX legal_document_kind_idx ON core.legal_document (workspace_id, kind) WHERE deleted_at IS NULL;
CREATE TRIGGER legal_document_set_updated_at BEFORE UPDATE ON core.legal_document
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

CREATE TABLE core.legal_document_version (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES core.legal_document (id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  -- the rendered Markdown exactly as it was shown; the hash is the click-wrap evidence
  body text NOT NULL,
  body_sha256 bytea NOT NULL,
  source core.legal_source NOT NULL DEFAULT 'custom',
  template_id text,
  template_version integer,
  summary text,
  effective_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_document_version_no CHECK (version_no >= 1),
  CONSTRAINT legal_document_version_unique UNIQUE (document_id, version_no),
  CONSTRAINT legal_document_version_sha CHECK (octet_length(body_sha256) = 32)
);
CREATE INDEX legal_document_version_doc_idx ON core.legal_document_version (workspace_id, document_id, version_no DESC);

ALTER TABLE core.legal_document
  ADD CONSTRAINT legal_document_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES core.legal_document_version (id) ON DELETE SET NULL;

CREATE TABLE core.consent_event (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES core.membership (id) ON DELETE CASCADE,
  purpose core.consent_purpose NOT NULL,
  granted boolean NOT NULL,
  source core.consent_source NOT NULL,
  -- the notice version in force when the answer was given, when there was one
  notice_document_id uuid REFERENCES core.legal_document (id) ON DELETE SET NULL,
  notice_version_no integer,
  -- the same privacy discipline as analytics (ADR-0036): a browser family, never a UA string,
  -- and a keyed HMAC of the address, never the address
  ua_family text,
  ip_hash bytea,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_event_member_idx
  ON core.consent_event (workspace_id, membership_id, purpose, recorded_at DESC);

--> statement-breakpoint
-- An offering period and a consent event are evidence: closing a period is the only legal
-- update, and neither table may be deleted from. A published legal version is immutable for
-- the same reason acceptance names a version — so nobody can rewrite what was agreed to.
CREATE OR REPLACE FUNCTION core.freeze_evidence_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence rows in % are append-only', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RAISE EXCEPTION 'evidence rows in % are immutable', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE OR REPLACE FUNCTION core.close_offering_period_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'offering period % is already closed', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     OR NEW.started_at IS DISTINCT FROM OLD.started_at
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.changed_by IS DISTINCT FROM OLD.changed_by THEN
    RAISE EXCEPTION 'an offering period may only be closed, not rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER offering_period_close_only BEFORE UPDATE ON core.offering_period
  FOR EACH ROW EXECUTE FUNCTION core.close_offering_period_only();
CREATE TRIGGER offering_period_no_delete BEFORE DELETE ON core.offering_period
  FOR EACH ROW EXECUTE FUNCTION core.freeze_evidence_row();
CREATE TRIGGER legal_document_version_immutable BEFORE UPDATE OR DELETE ON core.legal_document_version
  FOR EACH ROW EXECUTE FUNCTION core.freeze_evidence_row();
CREATE TRIGGER consent_event_immutable BEFORE UPDATE OR DELETE ON core.consent_event
  FOR EACH ROW EXECUTE FUNCTION core.freeze_evidence_row();

--> statement-breakpoint
-- Row-level security. Staff and the system see everything; an external member reads the legal
-- texts it may be asked to accept and its own consent history, and writes only its own consent.
-- Offering periods are staff evidence and are never exposed to investors.
ALTER TABLE core.offering_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.offering_period FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.offering_period AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY offering_period_staff ON core.offering_period FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

ALTER TABLE core.legal_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.legal_document FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.legal_document AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY legal_document_staff ON core.legal_document FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY legal_document_external_read ON core.legal_document FOR SELECT
  USING (
    core.current_actor_kind() = 'external' AND deleted_at IS NULL
    AND audience IN ('external', 'all') AND current_version_id IS NOT NULL
  );

ALTER TABLE core.legal_document_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.legal_document_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.legal_document_version AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY legal_document_version_staff ON core.legal_document_version FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
-- An external member reads any version of a document it can see: it must be able to re-read the
-- version it accepted, not only the current one.
CREATE POLICY legal_document_version_external_read ON core.legal_document_version FOR SELECT
  USING (
    core.current_actor_kind() = 'external'
    AND EXISTS (
      SELECT 1 FROM core.legal_document d
      WHERE d.id = legal_document_version.document_id AND d.deleted_at IS NULL
        AND d.audience IN ('external', 'all')
    )
  );

ALTER TABLE core.consent_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.consent_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.consent_event AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY consent_event_staff ON core.consent_event FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY consent_event_external_own ON core.consent_event FOR SELECT
  USING (core.current_actor_kind() = 'external' AND membership_id = core.current_membership());
CREATE POLICY consent_event_external_insert ON core.consent_event FOR INSERT
  WITH CHECK (core.current_actor_kind() = 'external' AND membership_id = core.current_membership());

--> statement-breakpoint
-- core.attestation shipped in 0001 with a permissive `FOR ALL USING (true)` policy, which left
-- one member's legal facts (NDA, accreditation, privacy notice) readable by any other member of
-- the same workspace once a query reached the table. Replace it with the same shape the rest of
-- the kernel uses: staff and system full, an external member its own rows only.
DROP POLICY attestation_access ON core.attestation;
CREATE POLICY attestation_staff ON core.attestation FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY attestation_external_own ON core.attestation FOR SELECT
  USING (core.current_actor_kind() = 'external' AND membership_id = core.current_membership());
CREATE POLICY attestation_external_insert ON core.attestation FOR INSERT
  WITH CHECK (core.current_actor_kind() = 'external' AND membership_id = core.current_membership());

-- Workspace-level compliance settings (consent mode, the relationship warning window, the
-- default disclaimer) live in core.workspace.settings under the "legal" key; no new column.
-- The Zod schema is in @seed-host/domain (workspaceSettings).

SELECT core.apply_tenant_fence();
