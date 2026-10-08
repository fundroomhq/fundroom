-- 0016_access_requests — the public "request access" form and its admin approval queue
-- (EXECUTION_PLAN §15 E3.1; design/05 §5 row 198; design/03:182 for the 506(b) attestation).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/identity.ts (accessRequest,
-- invite.accessRequestId). Runs inside one transaction; the new table declares its fence
-- inline so nothing can read a row between CREATE TABLE and the runner's
-- core.apply_tenant_fence() pass.
--
--  * access_request_challenge
--                     one row per public submission (`POST /access-requests/start`): the text
--                     THAT submission carried and its emailed code (keyed hash). Short-lived
--                     (10 min); deleted when a code for the address is proven, or by the sweeper.
--                     Never exported. Several may exist per address at once: every unexpired
--                     code mailed to it is accepted, so a stranger's later submission can neither
--                     overwrite the owner's text nor invalidate the owner's code.
--  * access_request   created only when a code is proven: `pending` in the admin queue until
--                     approved (an ordinary invite is created), denied, or expired (by the
--                     sweeper, or because the address joined). Its text is the proven
--                     submission's. Not the GDPR "access request" (core.dsar_request).
--  * invite           access_request_id — the request an invite answers; on acceptance the
--                     membership's source becomes `request`.

--> statement-breakpoint
-- 1. The request (the admin queue).
CREATE TYPE core.access_request_status AS ENUM ('pending', 'approved', 'denied', 'expired');

CREATE TABLE core.access_request (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  email citext NOT NULL,
  name text NOT NULL,
  firm text,
  reason text,
  status core.access_request_status NOT NULL DEFAULT 'pending',
  -- When a code for the address was last proven (a later proof refreshes the text).
  verified_at timestamptz,
  -- Copied from settings.access.requests.defaultGroupIds at verification: the "suggested group".
  suggested_group_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  auto_approved boolean NOT NULL DEFAULT false,
  decided_at timestamptz,
  decided_by uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  -- Staff-only; never mailed to the requester.
  decision_note text,
  -- The pre-existing relationship an approver attested (required under 506(b)); copied onto the
  -- membership through the relationship service when the invite is accepted.
  relationship_established_at timestamptz,
  relationship_source text,
  relationship_note text,
  invite_id uuid REFERENCES core.invite (id) ON DELETE SET NULL,
  membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  -- Keyed hash of the submitting client's address, for abuse review only. Never exported.
  client_ip_hash bytea,
  -- pending: verification + settings pendingExpiryDays.
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_request_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT access_request_firm_length CHECK (firm IS NULL OR char_length(firm) <= 160),
  CONSTRAINT access_request_reason_length CHECK (reason IS NULL OR char_length(reason) <= 2000),
  CONSTRAINT access_request_decision_note_length CHECK (
    decision_note IS NULL OR char_length(decision_note) <= 2000
  ),
  CONSTRAINT access_request_relationship_note_length CHECK (
    relationship_note IS NULL OR char_length(relationship_note) <= 2000
  )
);

-- One pending request per address and workspace; decided rows are history and may repeat.
CREATE UNIQUE INDEX access_request_open_email_uq ON core.access_request (workspace_id, email)
  WHERE status = 'pending';
-- The admin queue (status tab, newest first) and the sweeper's scans.
CREATE INDEX access_request_ws_status_idx
  ON core.access_request (workspace_id, status, created_at DESC);

CREATE TRIGGER access_request_set_updated_at BEFORE UPDATE ON core.access_request
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

-- Staff (the approval queue) and the system (the public verify route runs under
-- systemContext(workspace.id), the sweeper, erasure, invite acceptance) only. An external member
-- matches no permissive policy.
ALTER TABLE core.access_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.access_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.access_request AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY access_request_read ON core.access_request FOR SELECT
  USING (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY access_request_insert ON core.access_request FOR INSERT
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY access_request_update ON core.access_request FOR UPDATE
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY access_request_delete ON core.access_request FOR DELETE
  USING (core.current_actor_kind() IN ('staff', 'system'));

-- No per-table GRANT: ALTER DEFAULT PRIVILEGES in 0000 already gives seedhost_app
-- SELECT/INSERT/UPDATE/DELETE on new tables in core.

--> statement-breakpoint
-- 2. The emailed challenges. The id is generated by the application (the code's HMAC is scoped
-- to it), hence no default.
CREATE TABLE core.access_request_challenge (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  email citext NOT NULL,
  name text NOT NULL,
  firm text,
  reason text,
  -- HMAC of the code under the key ring, scoped to (workspace, challenge id). Never exported.
  code_hash bytea NOT NULL,
  -- Keyed hash of the submitting client's address, for abuse review only. Never exported.
  client_ip_hash bytea,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_request_challenge_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT access_request_challenge_firm_length CHECK (firm IS NULL OR char_length(firm) <= 160),
  CONSTRAINT access_request_challenge_reason_length CHECK (
    reason IS NULL OR char_length(reason) <= 2000
  )
);

-- Verification reads every live challenge of one address; the sweeper deletes by expiry.
CREATE INDEX access_request_challenge_email_idx
  ON core.access_request_challenge (workspace_id, email, expires_at);
CREATE INDEX access_request_challenge_expiry_idx
  ON core.access_request_challenge (workspace_id, expires_at);

-- The system actor creates and reads them: the public routes run under
-- systemContext(workspace.id), and so does the sweeper. Staff may only find-and-delete, because
-- an erasure (which must remove the subject's pending challenges with the rest of their data)
-- can complete on the requesting admin's own transaction; a DELETE that filters on a column
-- needs the SELECT policy too. No route ever returns a challenge to anyone.
ALTER TABLE core.access_request_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.access_request_challenge FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.access_request_challenge AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace())
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY access_request_challenge_read ON core.access_request_challenge FOR SELECT
  USING (core.current_actor_kind() IN ('staff', 'system'));
CREATE POLICY access_request_challenge_insert ON core.access_request_challenge FOR INSERT
  WITH CHECK (core.current_actor_kind() = 'system');
CREATE POLICY access_request_challenge_delete ON core.access_request_challenge FOR DELETE
  USING (core.current_actor_kind() IN ('staff', 'system'));
-- Challenges are never updated: a new submission is a new row.
REVOKE UPDATE ON core.access_request_challenge FROM seedhost_app;

--> statement-breakpoint
-- 3. The invite an approval creates points back at its request.
ALTER TABLE core.invite
  ADD COLUMN access_request_id uuid REFERENCES core.access_request (id) ON DELETE SET NULL;
CREATE INDEX invite_access_request_idx ON core.invite (access_request_id)
  WHERE access_request_id IS NOT NULL;

SELECT core.apply_tenant_fence();
