-- 0002_activity — contact activity: meetings booked through Calendly / Cal.com (EXECUTION_PLAN §15
-- E3.6, ADR-0054).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/crm.ts. Runs inside one transaction.
--
-- One row per (booking, kind): the `integration.booking_recorded` subscriber writes
-- `meeting_booked` when a meeting is booked, `meeting_rescheduled` when it moves and
-- `meeting_cancelled` when it is called off. A redelivered event, or the vendor sending the same
-- status twice, lands on the unique key and refreshes the times instead of adding a row.
--
--  * `booking_id` is a soft reference to `core.integration_booking` (the kernel's register) — a
--    bare uuid, no foreign key: the kernel's retention sweep and erasure delete bookings on their
--    own schedule, and the CRM's record of "we met on the 3rd" outlives the vendor payload.
--  * `title` is the vendor's event-type name ("30 min intro"), never the invitee's name or address:
--    those stay on the contact row, which staff own and erasure pseudonymises.
--  * Erasure deletes a contact's activities with the rest of what the CRM holds about them
--    (`ErasureRepo.eraseContacts`); the contact itself is pseudonymised in place as before.
--  * RLS as every other `crm.*` table: the tenant fence plus staff-or-system, no external arm.

CREATE TABLE crm.activity (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES crm.contact (id) ON DELETE CASCADE,
  kind text NOT NULL,
  -- when the fact was recorded (the webhook's arrival), not when the meeting is
  occurred_at timestamptz NOT NULL DEFAULT now(),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  title text,
  booking_id uuid,
  provider text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_kind CHECK (kind IN ('meeting_booked', 'meeting_cancelled', 'meeting_rescheduled')),
  CONSTRAINT activity_title_length CHECK (title IS NULL OR char_length(title) <= 200),
  CONSTRAINT activity_provider CHECK (provider IS NULL OR provider IN ('calendly', 'calcom')),
  CONSTRAINT activity_booking_source CHECK ((booking_id IS NULL) = (provider IS NULL)),
  CONSTRAINT activity_ends_after_start CHECK (ends_at IS NULL OR ends_at >= starts_at),
  -- One activity per booking and kind: the subscriber upserts on it (NULLs stay distinct).
  CONSTRAINT activity_booking_kind UNIQUE (workspace_id, booking_id, kind)
);
-- The contact timeline, newest first.
CREATE INDEX activity_contact_idx ON crm.activity (workspace_id, contact_id, occurred_at DESC, id DESC);
CREATE TRIGGER activity_set_updated_at BEFORE UPDATE ON crm.activity
  FOR EACH ROW EXECUTE FUNCTION core.set_updated_at();

ALTER TABLE crm.activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm.activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON crm.activity AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace()) WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY activity_staff ON crm.activity FOR ALL
  USING (core.current_actor_kind() IN ('staff', 'system'))
  WITH CHECK (core.current_actor_kind() IN ('staff', 'system'));

SELECT core.apply_tenant_fence();
