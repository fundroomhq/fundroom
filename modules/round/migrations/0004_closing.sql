-- 0004_closing — the round closing workflow: subscription agreements sent for e-signature and the
-- per-commitment closing checklist (EXECUTION_PLAN §15 E3.5, ADR-0053).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/round.ts. Runs inside one
-- transaction. New tables in `round` inherit the `seedhost_app` default privileges from 0001.
--
--  * signature_request  one row per subscription agreement sent for signature for a commitment.
--                       `envelope_id` is a soft reference to `core.esign_envelope` (the kernel
--                       e-sign service owns the envelope; this module mirrors its status from the
--                       `esign.envelope_changed` / `esign.envelope_completed` events).
--                       `signed_document_id` is a soft reference to the vaulted data-room document,
--                       set on `document.vaulted`. At most one open (pending/sent/delivered)
--                       request per commitment.
--
--                       `pending` is the claim taken BEFORE the vendor call (E3.5 package D): the
--                       route inserts the row under the partial unique index in a short
--                       transaction, calls the kernel e-sign service with no transaction open
--                       (the vendor round trip must never hold a pooled connection), then fills
--                       in `envelope_id` in a second short transaction. Two concurrent "send for
--                       signature" requests for one commitment therefore race on the index, not
--                       on the vendor: exactly one reaches the vendor, the other gets 409. A
--                       `pending` row has no envelope yet (the only status besides `error` that
--                       may lack one); a crash between the vendor call and the second
--                       transaction is healed by the envelope-changed handler adopting the
--                       envelope, and a claim older than 15 minutes is expired by the next send.
--  * commitment         gains the confirmation (`confirmed_at`/`confirmed_by`: the company has
--                       received and reconciled the money) and `signed_at` (the agreement was
--                       signed, set when a signature request completes).
--
-- RLS: staff/system only, like `commitment` (0001): an investor reads their own closing checklist
-- through the round routes, which scope a staff/system transaction to their membership.

--> statement-breakpoint
CREATE TABLE round.signature_request (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  round_id uuid NOT NULL REFERENCES round.round (id) ON DELETE CASCADE,
  commitment_id uuid NOT NULL REFERENCES round.commitment (id) ON DELETE CASCADE,
  -- soft reference to core.esign_envelope (kernel); NULL only while `pending` (or a failed claim)
  envelope_id uuid,
  status text NOT NULL DEFAULT 'pending',
  -- the vendor template the agreement was generated from
  template_ref text,
  sent_by_membership_id uuid REFERENCES core.membership (id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  terminal_at timestamptz,
  -- soft reference to dataroom.document, set on document.vaulted
  signed_document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signature_request_status CHECK (
    status IN ('pending', 'sent', 'delivered', 'completed', 'declined', 'voided', 'expired', 'error')
  ),
  CONSTRAINT signature_request_envelope_present CHECK (
    envelope_id IS NOT NULL OR status IN ('pending', 'error')
  ),
  CONSTRAINT signature_request_template_ref_length CHECK (
    template_ref IS NULL OR char_length(template_ref) BETWEEN 1 AND 200
  )
);

-- One open request per commitment (the route answers 409 `signature_request_open` on 23505).
CREATE UNIQUE INDEX signature_request_open_idx ON round.signature_request (workspace_id, commitment_id)
  WHERE status IN ('pending', 'sent', 'delivered');
-- The event handlers find the mirror by envelope.
CREATE UNIQUE INDEX signature_request_envelope_idx ON round.signature_request (workspace_id, envelope_id);
-- The closing view: a round's requests, newest first per commitment.
CREATE INDEX signature_request_round_idx
  ON round.signature_request (workspace_id, round_id, commitment_id, created_at DESC);
CREATE INDEX signature_request_commitment_idx ON round.signature_request (commitment_id);
CREATE INDEX signature_request_sent_by_idx ON round.signature_request (sent_by_membership_id)
  WHERE sent_by_membership_id IS NOT NULL;

CREATE TRIGGER signature_request_set_updated_at BEFORE UPDATE ON round.signature_request
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE round.signature_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE round.signature_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON round.signature_request AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY signature_request_staff ON round.signature_request FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

--> statement-breakpoint
ALTER TABLE round.commitment
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN confirmed_by uuid,
  ADD COLUMN signed_at timestamptz;

SELECT core.apply_tenant_fence();
