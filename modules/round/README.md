# `@fundroom/module-round`

The raise. A company's current round — its instrument and terms, the form an investor uses to
say they are interested, the accreditation step Rule 506(c) requires, the commitments that are
the record of the money, and the checklist for closing it.

**Off by default**, and disabled outright while the workspace's `offering_status` is `none` or
`informational` — the two statuses where `permits(status).roundAndTerms` is false. That gate
applies to staff as well: every route answers 404, the bootstrap reports the
module off, and its nav slots are not emitted. A compliance control an admin can walk around is
no control.

---

## The model

Seven tables in the `round` schema. The migrations are authoritative;
`src/schema/round.ts` is the typed view and `src/repos/` (`round-repo.ts`, `closing-repo.ts`)
is the only place in the module that touches drizzle or SQL.

| table | what it is |
|---|---|
| `round` | one raise: stage, instrument, target, currency, minimum, the window it is open for, and whether investors see the progress bar. A partial unique index allows **one `open` round per workspace**. |
| `terms` | what the round *is*, as data rather than prose: a jsonb body chosen by the round's `instrument_kind` and validated by `@fundroom/round-terms`. **Append only** — a change inserts revision *n* + 1 and supersedes the old row, stamped with the disclaimer version in force at that moment. |
| `interest_submission` | an investor saying "I would put in X". Not an order and not a commitment. Carries the offering status at the moment it was made, the accreditation path that status implied, and the click-wrap stamp of the questionnaire they answered. |
| `verification` | the 506(c) second step: a method, an evidence reference, a verifier and an expiry. The file itself lives in object storage, envelope-encrypted, and is purged after the decision. |
| `commitment` | the money. The system of record, and the only thing `allocation()` adds up. A commitment names a member, a CRM contact, an organisation or simply a display name — at least one of the four. |
| `closing_task` | the manual closing tasks. The smallest table here on purpose: E2.5 ships a list and a toggle, not a workflow. |
| `signature_request` | (`0004_closing.sql`) a subscription agreement sent for e-signature for one commitment: the round's mirror of a kernel `core.esign_envelope` (soft reference `envelope_id`), its status, and the vaulted signed copy (`signed_document_id`, soft reference into the data room). At most one open (`pending`/`sent`/`delivered`) per commitment. `commitment` gains `signed_at`, `confirmed_at`, `confirmed_by`. |

## The closing workflow

`src/closing/rules.ts` holds every decision as a pure function; `src/service/closing.ts` does the
I/O; `src/closing-routes.ts` shapes responses; `src/closing/handlers.ts` are the outbox
subscribers.

- **Send for signature** (`POST /round/commitments/{id}/signature-request`, `round.manage` +
  step-up). Preconditions, in this order: the round is `open` or `closed` (409 reason
  `round_not_open`), the commitment is `soft` or `verbal` (`commitment_not_signable`), an e-sign
  connection exists (409 `esign_not_configured`) whose vendor supports templates (422
  `esign_template_unsupported`), `round.closing.subscriptionTemplateRef` is set
  (`subscription_template_missing`), no request is open and no earlier request in `error` still
  has a live envelope at the vendor (`signature_request_open` — void it first). The signer is
  the commitment's member (name + primary email; an erased member or one without an address is
  422 `signer_email_missing`); for a commitment naming no member the body's `signer` is used,
  else 422. The template is prefilled per `round.closing.prefill` (vendor field → `investor_name`,
  `investor_email`, `amount` — formatted in the round currency from the decimal string,
  `round_name`, `company_name`, `valuation_cap` — the current terms' cap, or the priced
  pre-money, `date` — UTC calendar date). The envelope is vaulted to `Signed documents/<round>`;
  `embedded: false` (the vendor emails the link). The signer is addressed to the template role
  `round.closing.templateRole` (default `Signer`; DocuSign and multi-role DocuSeal templates match
  the signer by that role name, so it must equal the role in the vendor template).
- **Why a `pending` row.** `services.esign.request()` calls the vendor and must run with no
  transaction open, so the claim comes first: tx1 locks the commitment's open request rows, then
  the commitment row, checks everything and INSERTs a `pending` request under the partial unique
  index (the loser of two concurrent sends gets 23505 → 409, so exactly one reaches the vendor);
  then the vendor call; then tx2 locks the request row, attaches the envelope and audits
  `round.signature_requested`. A vendor failure turns the claim into `error` with no envelope
  (final — the next send is free) and audits `round.signature_request_failed` (meta `errorCode`,
  `orphanRisk`). A process dying between the vendor call and tx2 is healed by the
  `esign.envelope_changed` handler adopting the envelope (only into a claim created no later than
  the envelope, for the same commitment); a claim older than 15 minutes is expired by the next
  send.
- **Orphans (fix C2).** If `request()` fails *after* the vendor created the envelope (the
  kernel's second transaction failed, or the vendor timed out / answered unreadably after
  creating it), the claim is released as `error` and the vendor may hold a live agreement we have
  no reference to. We never re-send on our own. `round.signature_request_failed` carries
  `orphanRisk: true` (and a warn log); the kernel's stale-draft sweep later marks the envelope
  `error`/`orphaned_draft`, which raises the staff `esign.envelope_attention` alert; and the
  round handler attaches that envelope (or any envelope for the commitment that reached the vendor
  after a released claim) to the newest released claim created before it and audits
  `round.signature_orphaned`. If that envelope is live at the vendor the mirror tracks it again
  (unless another request is already open — then it stays `error`). What staff do: check the
  vendor console; void the stray envelope there (an orphaned draft has no vendor reference, so our
  void only closes it locally) before deciding to send again.
- **Mirror** (`esign.envelope_changed`, `esign.envelope_completed`, round subjects only): the
  request row lock first, then a forward-only transition (`nextMirrorStatus`; completed,
  declined, voided and expired never move), so redelivery and reordering are no-ops. **The
  kernel's `error` is recoverable** (fix C1): a permanent pull failure keeps polling and heals, and
  a permanent collect failure publishes `error` for an envelope whose row stays `completed`. So an
  `error` mirror carrying an envelope id may move again (to sent/delivered/completed/…), every move
  into or out of `error` is checked against the kernel row as it is now (a stale `sent` cannot
  mask a real error; an `error` for a completed row mirrors `completed`), and `completed` always
  wins. Only a claim released before it reached the vendor (`error`, no envelope) is final. The transition into `completed` moves the
  commitment `soft`/`verbal` → `signed` (never regresses `wired`, never resurrects `withdrawn`),
  stamps `signed_at` once, audits, and publishes `round.commitment_changed` +
  `round.signature_completed` exactly once. `document.vaulted` links the signed copy onto the
  request and the commitment (first writer wins). None of these writes personal data (ids and
  statuses; the signer's name and email live on the kernel envelope, which erasure pseudonymises),
  so no `legal.isErased` check is needed here.
- **Void** (`POST /round/signature-requests/{id}/void`, step-up) voids at the vendor through the
  kernel, then mirrors; an `error` request with an envelope is voidable too (it may be live at
  the vendor); 409 `envelope_not_open` once final, 409 reason
  `signature_request_pending` while its envelope is still being created.
- **Confirm** (`POST /round/commitments/{id}/confirm`, step-up): `wired` only (reason
  `commitment_not_wired`), idempotent, audits and publishes `round.commitment_confirmed` → notify
  mails the investor once.
- **Checklist** (derived, never stored): per commitment `documentsSent` (a request that reached
  the vendor, or signed anyway), `signed` (signed_at, status signed/wired, or a completed
  request — paper signed outside the product counts), `wired`, `confirmed`, each with a timestamp,
  and a `stage`; the round summary counts and sums per stage in fixed point.
  `GET /round/rounds/{id}/closing` (`round.read`, key-callable) returns it with the manual tasks.
- **The investor's card** (`GET /round/current/closing`, member): their own commitments to the
  round `/round/current` shows, read in a system context narrowed to the membership
  (`commitment` has no external RLS path). `canSign` = an open request (the link is in their
  mailbox); `signedDocumentAvailable` = the kernel holds the signed copy **and the viewer is the
  signer** (download at `/esign/me/envelopes/{envelopeId}/signed.pdf`). A delegate with scope
  `all` acts for their principal and already reads the round, so they see the **principal's**
  card with `readOnly: true`, never `canSign`, never a download (the kernel serves the signed
  copy to the signer only); a narrower delegate gets the same 404 as every `/current*` read.
- Lock order everywhere: signature_request row(s) → commitment row → audit chain → outbox. The
  kernel's envelope row is only locked inside the kernel's own transactions.
- Deferred (not this epic): wire instructions page and wire-change alerts.

### Terms are revisions, never edits

Terms are append-only with `as_of` dates and versioned
disclaimer blocks, because the question an auditor asks three years later is *what was this
investor shown on the day they subscribed*. An `UPDATE` would delete the answer. A trigger in
the migration refuses every update except setting `superseded_by` from `NULL`, so this is not a
convention the next caller can forget — the same shape `metrics.point` uses for a restatement.

The body is parsed against the round's **own** `instrument_kind` rather than against the union,
so a note body can never be stored on a SAFE round.

### One roll-up

`allocation()` in `@fundroom/round-terms` is the only thing that adds up `round.commitment`.
The admin tracker, the investor progress bar, the CRM reconciliation panel and the commitments
CSV all read the same buckets from the same function; a second roll-up written closer to one of
those screens would eventually disagree with this one in front of an investor. Withdrawn
commitments are excluded from every bucket (the row stays for the audit trail) and `total` is
never capped, so an oversubscribed round reads as one.

---

## The eligibility table

Computed server-side from four facts — the offering status, whether the investor subscribes as a
person or through an entity, the amount, and the round's currency. The browser runs
the same pure function so the form's copy can change as somebody types, but **the browser never
decides**: the path stored on a submission is the one the server computed.

| offering status | amount | path | questionnaire | what happens |
|---|---|---|---|---|
| `none`, `informational` | — | — | — | the module is disabled; every route 404s |
| `506b` | any | `self_attested` | yes | self-certification only; "none of these apply" is a real answer and feeds the 35-purchaser count |
| `506c`, USD | ≥ $200,000 individual / ≥ $1,000,000 entity | `self_certified` | yes | the minimum-investment safe harbour (SEC no-action letter, 12 March 2025): written representations instead of documents |
| `506c`, USD | below the threshold | `verification_required` | yes | a `round.verification` is opened and the company has to settle it before it can accept |
| `506c`, other currency | any | `verification_required` | yes | the safe harbour is a dollar figure, so it does not apply |
| `non_us` | any | `none` | no | neutral copy, no US prompts, nothing to confirm |

Two refinements the table does not show:

- a member the kernel already holds a **live `accredited` attestation** for gets no verification
  row: re-verifying them would ask for a tax return the company has already decided it does not
  need. The path is still stored as computed — what rule applied on the day is the fact worth
  keeping;
- **accepting** under 506(c) is refused unless that attestation exists, or the submission took
  the safe-harbour path *and carries the stamp* of the representations that go with it. This is
  the refusal that makes "every purchaser must pass accreditation before acceptance" true rather
  than aspirational.

Rule 506(b)'s 35 non-accredited purchasers is a **warning**, never a block: it is
counted over accepted submissions whose questionnaire named no category, surfaced on the accept
response as `warnings: ["non_accredited_limit"]` and badged on the admin screen. The rule counts
purchasers in an offering, and only the company and its counsel know whether this portal holds
all of them.

Everything this module knows about accreditation it learns from `ModuleServices.legal`. It never
touches `core.attestation` (D5): that row's expiry, its revocation and the policy gate that
reads it belong to the kernel.

---

## The evidence lifecycle

1. **Upload** — `PUT /round/verifications/{id}/evidence`, owner only, raw bytes.
   `Content-Type` must be `application/pdf`, `image/png` or `image/jpeg`; the ceiling is 10 MiB
   or the deployment's `uploadMaxBytes`, whichever is smaller.
2. **Scan** — `services.scanner.scan`. `infected` and `error` are both refusals, and the
   signature stays in the log rather than in the response.
3. **Encrypt** — envelope-encrypted under the workspace's own DEK (purpose `round.evidence`)
   before a byte reaches object storage, at `round/verification/<workspaceId>/<verificationId>`.
   The object's declared content type is `application/octet-stream`, so nothing downstream can
   be tempted to serve it to a browser as a PDF.
4. **Read** — `GET /round/verifications/{id}/evidence`, `round.manage`, decrypted on the way
   out, `no-store`, audited with the sha256 rather than with anything that names the document.
5. **Decide** — `verified` needs a method *and* the evidence that method implies: a **file** for
   `document_review` and `professional_letter`, a **note** for `third_party` and
   `minimum_investment`. The decision writes
   the kernel's `accredited` attestation through the legal seam with
   `evidenceRef = storage:<key>` or `note:<sha256 of the note>` — either names what was read
   without copying a private document into a kernel table. Expiry: **90 days** for a
   professional letter, **twelve calendar months** otherwise.
6. **Purge** — `round.evidence_purge`, nightly at 04:50 UTC. Deletes the object for every
   decided verification whose `decided_at` is older than `round.evidenceRetentionDays` (90 by
   default) and clears `evidence_key`. The clock is the *decision*, not the upload: a file
   uploaded in January against a decision taken in June has to be readable while the decision is
   being made.

The decision, its method and `evidence_sha256` survive the purge. The file does not. That is
what keeps the verification provable once somebody's tax return is gone.

---

## Routes that are not in the OpenAPI document

`PUT /api/v1/round/verifications/{id}/evidence` is served by `src/raw-routes.ts`, mounted in
front of the OpenAPI app's 1 MiB JSON body limit — a scan of a brokerage statement is routinely
larger than that. It is also *declared* in `src/routes.ts` so that it appears in the contract
and in `packages/authz/matrix/authz-matrix.yaml`, and the declared handler delegates to the same
function, so the documented behaviour and the served behaviour cannot drift. In a running server
the raw mount is routed first and wins.

The raw mount checks per-workspace enablement but **not** `offeringStatusRules`, which the
OpenAPI mount does. The raw handler therefore re-checks the offering status itself; without that
line this one route would stay reachable in a workspace whose status had switched the rest of
the module off.

---

## The `round_summary` block

`kind: "reference"`, schema `z.object({}).strict()` — the block carries **no data at all**, not
even a round id. A page says "show the round" and this module decides which one (the open round,
or the most recently closed one), so an editor never has to move the block when a raise closes.

An **anonymous viewer gets `{}`**: not a redacted payload, not a marker, nothing.
No offering content is reachable anonymously, and a `round_summary` on
a page the public can read would be a general solicitation the workspace did not choose to make.
`BlockHydrationContext` does not carry the section's visibility rule, so the anonymous viewer is
the proxy — an exact one for the case that matters, because a section is only reachable
anonymously when its rule is `public` and the workspace allows public sections. The refusal is
logged (`round.summary_refused`).

`showProgress` is honoured for members and ignored for staff, whose admin preview is where the
decision is checked. The buckets are folded in a **system** context because `round.commitment`
is staff-only in RLS, and only the three aggregate figures cross back.

---

## What is audited

Every mutation, with ids-only meta — amounts are allowed on an audit row, which is fenced to the
workspace and exists so somebody can prove what was recorded, and are deliberately absent from
every outbox event, which every subscriber reads.

`round.created`, `round.updated`, `round.deleted`, `round.opened`, `round.closed`,
`round.terms_changed`, `round.terms_viewed` (investor views, throttled to once per session per
revision), `round.interest_submitted`, `round.interest_withdrawn`, `round.interest_accepted`,
`round.interest_declined`, `round.commitment_created`, `round.commitment_changed`,
`round.verification_requested`, `round.verification_decided`, `round.evidence_uploaded`,
`round.evidence_viewed`, `round.evidence_purged`, `round.commitments_exported`,
`round.closing_tasks_changed`, `round.settings_changed`; E3.5: `round.signature_requested`,
`round.signature_voided`, `round.signature_completed` (system), `round.commitment_confirmed`, and
`round.commitment_changed` with `meta.source = "esign"` when a signature moves a commitment;
fixes C1/C2: `round.signature_request_failed` (meta `errorCode`, `orphanRisk`) and
`round.signature_orphaned` (system; meta `envelopeId`, `envelopeStatus`, `errorCode`).

## What is published

`round.opened`, `round.closed`, `round.terms_changed`, `round.interest_submitted`,
`round.interest_decided`, `round.commitment_created`, `round.commitment_changed`,
`round.verification_requested`, `round.verification_decided`, and
`round.signature_completed` and `round.commitment_confirmed` (both carry the commitment's
`membershipId` when it names one, for notify) — all inside the write transaction, all ids only.
`modules/crm` is what listens, and it does so without ever reading a `round.*` table. Webhook
topics: `round.opened`, `round.closed`, `round.interest_submitted`, `round.commitment_created`,
`round.commitment_changed`, `round.signature_completed`, `round.commitment_confirmed`.

**Handled:** `esign.envelope_changed`, `esign.envelope_completed` (only
`purpose = round_closing` with a `round/commitment` subject) and `document.vaulted` — see the
closing workflow above.

## Settings

`round` in workspace settings: `evidenceRetentionDays` (1–3650, default 90) and
`defaultCurrency`, and `closing: { subscriptionTemplateRef, templateRole, prefill }`
(`templateRole` 1–100 chars, default `Signer`) — a PATCH merges
`closing` field by field (`prefill`, when sent, replaces the map). What is *not* there is the point — the target, the currency, the minimum and
`showProgress` all live on the round itself, because a workspace can run a bridge in EUR after a
seed in USD and a workspace-level answer would be wrong for one of them.

## Step-up

`DELETE /round/rounds/{id}`, `POST .../open`, `POST .../close`, `GET .../export.csv`,
`PATCH /round/settings`, and sending for signature, voiding a signature request and
confirming a commitment. The round export is the textbook case for step-up; opening a round is the moment a company starts offering securities.

## Portability

`src/portability.ts`: every table travels as rows — `round`, `terms`, `interest_submission`,
`verification`, `commitment`, `closing_task` (FK order). Migration `0002_portability.sql` makes
the three forward references (`terms.superseded_by`, `interest_submission.verification_id` /
`.commitment_id`) `DEFERRABLE INITIALLY DEFERRED` so a one-transaction import resolves them at
COMMIT; `terms` is append-only to UPDATE only, so inserting its history as exported is legal.

The accreditation evidence travels as a blob: key `round/verification/<ws>/<id>` (outside `ws/`;
the engine's `remapKey` rewrites both uuids), SHE1 under the `round-evidence` DEK, described by
the new `verification.evidence_encryption` (`{format:"she1", keyId, keyRef}`, written on upload,
backfilled by 0002 when the migrator bypasses RLS; readers fall back to the current key when it
is NULL). `optional`: a purged or missing object keeps the row. A legacy object with no descriptor
is left behind by `exportRow` (key nulled, `evidence_purged_at` set) — `evidence_sha256` keeps the
decision provable. `evidence_sha256` is hex text, not a verified `sha256Column`.
