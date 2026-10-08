# @fundroom/module-crm

CRM-lite: the
relationships behind a raise — who the company has spoken to, which firm they are from, where
each conversation stands, and what was said. Contacts that need no login, organisations, a
per-round pipeline with a ladder the tenant owns, notes and tasks.

Optional module (`crm` schema, `/api/v1/crm`): `defaultEnabled: false`, `dependsOn: ["access"]`.

## Why this is not part of `round`

The obvious packaging would put the board inside the round module, since it exists to run a
raise. It is the wrong cut, and the offering rules show it immediately: `round` declares
`disabledWhen: ["none", "informational"]` — a workspace that is not raising must not have a round
page at all — while a CRM is exactly what a founder uses *before* there is anything to offer.
Tracking a relationship is not soliciting one, so this manifest carries **no**
`offeringStatusRules`, and an `informational` workspace runs the whole board with the round
module switched off underneath it.

The coupling that remains is one-way and runs entirely over the outbox. This module does not
`dependsOn: ["round"]`, never imports it, never reads `round.*`, and holds `commitment_id` as a
bare uuid — which is what lets `round.commitment` stay the single system of record for money while a card's `amount` is only ever a **forecast**.

## Model

- `crm.organization` — a fund, angel group, corporate or family office. `domain` is `citext`, so
  "Sequoia.com" and "sequoia.com" are one firm. Named once per workspace among live rows;
  soft-deleted, so a card that named it keeps its subject.
- `crm.contact` — a person, and **not a login**. `membership_id` is an optional link to
  `core.membership` (never on the global user), at
  most one live contact per member. The display name and email on this row are the CRM's own
  copy: staff correct a misspelt name without touching identity, and no later event overwrites
  what they typed. `search_tsv` is a generated `tsvector` with a GIN index, so the search index
  cannot drift from the columns it indexes.
- `crm.pipeline_stage` — the tenant's ladder, with stable `key`s. Seeded **lazily**
  on the first CRM read of a workspace, never by the migration: stages are tenant data, and a
  migration would write them for workspaces that never switch the module on.
- `crm.pipeline_item` — one card: a contact and/or an organisation, optionally against a round,
  in a stage, with a forecast `amount` and an optional `commitment_id`. One live card per
  `(round, contact)`.
- `crm.note` / `crm.task` — polymorphic over the three subjects. A note is soft-deleted; a task
  is not, because a task is a reminder and a tombstoned reminder still shows up in the count.
- `crm.stage_transition` — every move, with its cause (`staff`, `interest_submitted`,
  `interest_decided`, `commitment_created`, `commitment_changed`) and both stage **keys**. This
  is what "stage transitions are audited" means in the database rather than only
  in `audit.event`.

RLS: the tenant fence plus staff-or-system, on every table, with no external arm anywhere.
"Only company staff see CRM" is a row-security fact here, not a route-level one. `citext` is the
only extension needed and `packages/db/migrations/core/0000` already creates it.

### Two constraints worth knowing about

`pipeline_stage (workspace_id, position)` is `DEFERRABLE INITIALLY DEFERRED`. `PUT /crm/stages`
renumbers the ladder 1..n in one pass per row, and any reordering passes through a state where
two rows briefly claim one position — swapping two neighbours cannot be expressed otherwise.
The invariant is "a workspace never *has* two stages at one position", not "no transaction ever
passes through a state where it would".

`pipeline_item.stage_id` is `ON DELETE RESTRICT`, and that restriction does not know about
`deleted_at`. Removing a stage therefore re-points **archived** cards onto the first surviving
stage first; live cards are refused outright (`stage_in_use`). The tombstone keeps its row, and
`crm.stage_transition` still holds the key it was actually in.

## The ladder

`prospect, contacted, meeting, diligence, soft_committed, committed, docs_sent, signed, wired,
passed` — the standard ladder, with `wired` and `passed` terminal. A tenant may rename,
reorder and add (`PUT /crm/stages`; custom stages get `custom_<slug>` keys so they can never
collide with a key a later release wants). The key of an existing stage is not patchable, for
the same reason a metric key is not: the event handlers address `soft_committed` by it, so
renaming one is a migration of other people's stored data rather than a field edit.

`wired` and `passed` cannot be removed at all. The commitment-status mapping lands on them, the
handlers no-op rather than throw when a stage is missing, and a silent no-op is not something an
admin would ever notice.

## Events it subscribes to

| Topic | What the board does |
| --- | --- |
| `round.interest_submitted` | Ensure a contact for the member, and a card on that round in `contacted` if there is none. An existing card is **not** moved. |
| `round.commitment_created` | Ensure the contact and the card, set `commitment_id`, move to `soft_committed`. |
| `round.commitment_changed` | Move by status: `soft`→`soft_committed`, `verbal`→`committed`, `signed`→`signed`, `wired`→`wired`, `withdrawn`→`passed`. |
| `round.interest_decided` | On `declined`, move to `passed`. An acceptance is left to `round.commitment_created`, or the card would move twice for one decision. |
| `member.erasure_requested` | DSAR erasure: pseudonymise and detach the member's contact(s), delete notes, tasks and meeting activities about them, keep the board, then `legal.completeErasureStep(…, "crm", {contacts, notes, tasks, activities})`. See below. |
| `integration.booking_recorded` | A verified Calendly / Cal.com booking webhook recorded a meeting: add a `crm.activity` row (`meeting_booked` / `meeting_rescheduled` / `meeting_cancelled`, from the **event's** status) on the contact it is about. See below. |

It emits nothing. Three properties hold and each is load-bearing: **idempotent** (the contact is
upserted on `membership_id`, the card on `(round_id, contact_id)`, and a move to the stage a card
is already in writes nothing at all — so redelivery produces no second history row);
**tolerant of a disabled module** (`services.enablement` decides, so a workspace that never
switched the CRM on does not acquire rows because somebody indicated interest); and **tolerant of
a missing stage** (no-op rather than a retry loop on an event that can never succeed).

### Erasure

`ErasureRepo` takes every contact linked to the membership — soft-deleted ones too, because a
deleted row still holds the name — **plus every unlinked contact whose email equals
(case-insensitively, `citext`) the member's current address or an address on one of their
linked contacts** (a contact typed in by hand before the investor joined is the same person's
data; a contact linked to a *different* membership is never matched by email), and, in one
transaction:

- **deletes** (hard) every note and task whose subject is that contact or one of its cards: what
  staff wrote *about* the person is the most personal data in the module, and a soft delete
  keeps the words;
- **pseudonymises the contact in place**: `display_name` → `Erased contact`, `email`, `title`,
  `notes`, `tags` and `organization_id` cleared, and `membership_id` set NULL (**detached**, so the
  pseudonym cannot be joined back to a person, and a later round event for the same membership
  starts a fresh contact from identity rather than reviving this one);
- **keeps** the pipeline cards (forecast, stage, round, commitment id) and their
  `stage_transition` history: they are the workspace's record of its raise, and the card's
  subject constraint needs the contact row to exist.

One `crm.contact_erased` audit row per contact (membership id, request id and counts — never a
name). Idempotent: a redelivered request finds no linked contact and reports zeros (the kernel
keeps the first report). **Not gated on enablement** (decision 5, amended) — the only handler
here that is not: a workspace that switched the CRM off still has the contacts it made while it
was on, and the kernel waits for a `crm` step from every workspace, zeros included.

After a request, the round handlers drop events about a member for whom `legal.isErased` is
true (`round.interest_submitted`, `round.interest_decided`, and the member half of
`round.commitment_created`), so an event emitted before the request but dispatched after it
cannot re-create the contact the erasure just detached.

### Contact activity

`crm.activity` (migration `0002_activity.sql`) is the contact's meeting timeline: one row per
(booking, kind) — unique `(workspace_id, booking_id, kind)`, so a redelivered event, the vendor
repeating a status or a second reschedule refreshes the row (times, title) instead of adding one.
`booking_id` is a soft reference to the kernel's `core.integration_booking` (no FK: the kernel
sweeps bookings after 400 days, the CRM's record of a meeting stays); `title` is the vendor's
event-type name only — the invitee's name and address live on the contact row.

The `integration.booking_recorded` handler reads the booking through
`services.integrations.booking(tx, …)` on the dispatcher's transaction and:

- **a live member's booking** (the kernel matched the invitee's address at ingest) → their
  contact, created on first sight exactly like a round event would (audited
  `crm.contact_created` with `cause: "booking"`);
- **anybody else's** → the oldest live contact staff already hold for that address (citext), or
  **nothing** — a booking link is public, and a stranger never becomes a contact;
- does nothing while the CRM is off (`enter()`), or for a booking the kernel no longer holds.

**Erasure race.** Before `isErased` is asked, the handler locks the member's `core.membership`
row `FOR NO KEY UPDATE` (and, for an address match, the contact row). An erasure request locks
the membership first (`prelockErasureSubject`) and the erasure step locks the contacts
`FOR UPDATE`, so the booking either commits first — and the erasure step then deletes its
activity — or waits and sees the request (drop) / the pseudonymised contact (no match). Without
the lock, a booking handled while a request was being written could re-create a contact that the
erasure step, running later, would never find. Pinned by
`apps/server/src/crm-activity.integration.test.ts`.

DSAR export lists the activities of the member's contacts (`activities`); portability exports
`activity` as rows (`booking_id` travels as a dangling soft reference).

## Routes

Every route is staff-only, behind `crm.read` or `crm.manage`. `requirePermission` answers 404
rather than 403 to a non-staff caller, so an investor probing these paths learns nothing.

```
GET    /crm/stages              crm.read     (lazy-seeds the defaults)
PUT    /crm/stages              crm.manage   (replace the ladder)
GET    /crm/organizations       crm.read     (q, cursor, limit ≤ 200)
POST   /crm/organizations       crm.manage
GET    /crm/organizations/{id}  crm.read
PATCH  /crm/organizations/{id}  crm.manage
DELETE /crm/organizations/{id}  crm.manage   (soft)
GET    /crm/contacts            crm.read     (q, organizationId, tag, cursor, limit ≤ 200)
POST   /crm/contacts            crm.manage   (optional membershipId link)
GET    /crm/contacts/{id}       crm.read     (contact + organisation + notes + tasks + cards)
GET    /crm/contacts/{id}/activity crm.read  (meetings, newest first, ≤ 100 — E3.6)
PATCH  /crm/contacts/{id}       crm.manage
DELETE /crm/contacts/{id}       crm.manage   (soft)
GET    /crm/pipeline            crm.read     (roundId? — see the sentinel below)
POST   /crm/pipeline            crm.manage
PATCH  /crm/pipeline/{id}       crm.manage   (a stage change writes the transition + audit)
DELETE /crm/pipeline/{id}       crm.manage   (soft)
POST   /crm/notes               crm.manage
DELETE /crm/notes/{id}          crm.manage   (soft)
POST   /crm/tasks               crm.manage
PATCH  /crm/tasks/{id}          crm.manage
DELETE /crm/tasks/{id}          crm.manage   (hard)
```

**The `roundId` sentinel.** `GET /crm/pipeline` with no `roundId` returns every card;
`?roundId=none` returns the cards attached to no round; `?roundId=<uuid>` returns that round's.
A query parameter cannot carry SQL NULL, and an empty string is indistinguishable from the
parameter being absent once a browser has serialised a form, so the third state is spelled as a
word. `none` is not a valid uuid, so it can never collide with a real round id.

Lists are keyset-paginated on `id` (uuidv7, i.e. creation order) with `limit ≤ 200`; `nextCursor`
is `null` on the last page.

## Audit

`crm.contact_created/updated/deleted`, `crm.organization_created/updated/deleted`,
`crm.pipeline_item_created/updated/moved/deleted`, `crm.note_created/deleted`,
`crm.task_created/updated/deleted`, `crm.stages_replaced`, `crm.contact_erased`. Meta is **ids, keys and counts only**
— never an email, never a name, never a note body. A CRM note is the most candid prose in the
product and `audit.event` is the one table exported wholesale to counsel and kept for six years;
copying the text into it would mean writing it twice and deleting it once. A move carries the two
stage keys and the cause.

## Portability

`src/portability.ts` (`crmPortability`) — how the CRM travels in a workspace export/import.
Every table moves as rows, in FK order: `organization`, `contact`, `pipeline_stage`,
`pipeline_item`, `note`, `task`, `stage_transition`. Nothing is dropped: the schema holds no
secret, keyed hash or blob.

- `contact.search_tsv` is `GENERATED ALWAYS … STORED`; the engine strips it on export and
  Postgres recomputes it on insert.
- Ids are remapped by the engine's generic pass: `contact.membership_id` and every
  `*_membership_id` / `created_by` (memberships are exported by the kernel), the polymorphic
  `subject_id`s, the history's stage ids, and the soft references into `round`
  (`pipeline_item.round_id`, `commitment_id`). A soft reference whose target was not exported
  (a removed stage, a deleted round) keeps its old value — dangling in the copy exactly as it
  was in the source.
- No `after`: the CRM has no FK into another module (`round` imports after the CRM).
- `src/portability.test.ts` parses `migrations/` for every `CREATE TABLE crm.*`, so a new table
  without a portability decision fails the module's own unit test.
