# @fundroom/module-data-room

The data room: folder tree with index numbering, the upload pipeline,
versions, protection, legal hold, recycle bin + purge, the secure viewer's page images and
watermarked downloads, and Q&A on documents and folders. Owns the `dataroom`
Postgres schema, mounts `/api/v1/data-room`, runs four jobs and hydrates the content page's
`document_list` block.

## Model

- `dataroom.folder` — one root per workspace (`parent_id NULL`, path `r`), then a tree. `path` is the
  ltree path (`r.<folder id without hyphens>…`) that grants inherit along. Index numbers (`1.2.3`)
  are computed on read: folders first, then documents, by `sort_order` then name. `staff_only`
  (E3.5) veils the folder's whole subtree from external members — see [Vaulting](#vaulting).
- `dataroom.blob` — metadata + scan state machine (`pending → scanning → clean | infected | error`,
  `skipped` when `AV_DRIVER=noop`). Bytes live in object storage as SHE1 ciphertext under the
  workspace DEK; `storage_key` is the quarantine key until ingest promotes it to
  `ws/<ws>/blobs/<sha256>`. Content-addressed within the workspace.
- `dataroom.document` — a titled node in a folder with `folder_path` mirrored from the folder,
  `protection` (`download`, `watermark`, `print`), legal hold fields, soft delete + `purge_after`,
  and `esign_envelope_id` (the kernel envelope a vaulted document came from, partial unique).
- `dataroom.document_version` — immutable; `current_version_id` on the document points at the live one.
- `dataroom.rendition` — `thumbnail`, `page` (rendered lazily at 1600 px), `pdf` (sanitised copy).
- `dataroom.page_text` — extracted text per page for in-document search (`simple` FTS).
- `dataroom.upload` — a staged upload: the app names the quarantine key, the client streams bytes.
- `dataroom.qa_question` / `dataroom.qa_answer` — Q&A; see [Q&A](#qa).

RLS: staff/system see every row of their workspace; external actors read live folders and
documents they hold `view` on through `core.effective_access` (by id, or by folder path), the
current versions of those documents and their renditions/page text. Blobs and uploads are
staff/system only. Legal hold is enforced by triggers (no soft delete, delete or version delete).

## Pipeline

1. `POST /data-room/uploads` — validates the declared type against the allow-list (PDF, PNG/JPEG/WebP,
   DOCX/XLSX/PPTX, CSV, MP4), creates the upload row and returns presigned multipart part URLs (S3
   driver) or the tus endpoint (filesystem driver: `/api/v1/data-room/uploads/tus`, a raw route
   outside the JSON body limit; `Upload-Metadata: upload <base64 upload id>`).
2. `POST /data-room/uploads/{id}/complete` — assembles multipart parts, verifies size, sniffs the
   magic bytes against the declared type, streams the SHA-256, dedupes against a clean blob, writes
   blob + document (or version) rows and enqueues `data-room.ingest` in the same transaction.
3. `data-room.ingest` — scans (`VirusScanPort`), encrypts into the blob key, deletes the quarantine
   copy, sanitises PDFs (pdf-lib: `OpenAction`, `AA`, JavaScript / embedded files, XFA, Launch),
   extracts text, renders the thumbnail, marks the version `ready | unsupported | failed`, audits
   `document.ingested` and publishes `document.ingested`. Files over `RENDER_MAX_BYTES` and
   non-previewable types are download-only.
4. Delivery — `GET …/pages/{n}` rasterises the page on first request (PDFium), stores it encrypted,
   and composites the viewer's watermark (email · time · workspace · confidential) per request;
   `GET …/download` streams the sanitised PDF with the watermark on every page, or the original for
   staff with `data-room.download`. Everything is `Cache-Control: private, no-store`.

## API

Member routes (staff and investors, decided per node by `AuthzPort.check()`): `GET /tree`,
`GET /documents/{id}`, `GET …/thumbnail`, `GET …/pages/{n}`, `GET …/pages/{n}/text`,
`GET …/search?q=`, `GET …/download`, `POST …/viewed`. Staff: `POST /folders`, `PATCH|DELETE /folders/{id}`, `POST /folders/{id}/restore`,
`GET /templates`, `POST /templates/{id}/apply`, `PATCH|DELETE /documents/{id}`,
`POST /documents/{id}/restore`, `DELETE /documents/{id}/purge`, `PUT /documents/{id}/legal-hold`,
`GET /documents/{id}/versions`, `POST /uploads`, `POST /uploads/{id}/complete`, `GET|DELETE /uploads/{id}`,
`GET /trash`, `GET|PATCH /settings`. Permissions: `data-room.read` (all staff), `data-room.manage`
(owner, admin, editor), `data-room.download` (owner, admin, editor, finance, legal),
`data-room.legal_hold` (owner, admin, legal), `data-room.settings` (owner, admin),
`data-room.qa_answer` (owner, admin, editor, finance, legal), `data-room.qa_manage` (owner, admin),
`data-room.qa_approve` (owner, admin, legal). The Q&A routes are listed under [Q&A](#qa).

Investor access comes from grants on folders (inherited by everything below) or on
documents; an investor may download only when the document's `protection.download` is on and the
grant carries `download`, and then only a watermarked PDF.

### Rule paths

A rule's `resource_path` is a *scope*: it covers every node at or below it, whatever the kind. Only a
folder has one — its own `path`. A document is a leaf matched by id; its `folder_path` is where it
sits, not what a rule on it covers. `POST /access/grants`, `/access/policies` and invitations derive
the path from the resource row (a folder's own path, none for a document or `post`) and answer 400
`resource_path_mismatch` to any other client-sent path. Migration `0002_rule_paths` backs this up in
storage for every writer (share links, imports): a trigger on `core.access_grant` and
`core.access_policy` clears the path of any `document` rule and of any non-folder rule inside the
`r` namespace.

The same migration repaired rows written before that (the Share sheet used to file a document grant
under its folder's path, sharing the whole folder): it cleared those paths,
bumped `acl_version` and deleted the workspace's `effective_access` rows so nothing honours the old
scope until the next rebuild. After restoring a pre-fix backup, re-run it as the database owner:
`SELECT dataroom.clear_overbroad_rule_paths();` (returns the number of rules repaired; not callable
by the application role).

### Moves bump `acl_version` (review R3A)

Some effective-access rows are resolved from where a node *sits* at rebuild time: a gated
document's or folder's own row carries the grants of the folders above it, a delegate's document
row its own ancestor excludes, the staff-only veil. So every change of a document's `folder_path`
or a folder's `path` / `staff_only` must move `acl_version` in the same transaction, or the old row
keeps granting what the old ancestors allowed (a gated document restored to the root out of a
binned granted folder stayed open). The services bump explicitly (move, restore to
the root, folder restore, vault flag), which also drops the in-process authz cache; migration
`0006_path_acl_bump` is the backstop for every other writer: DEFERRABLE INITIALLY DEFERRED
constraint triggers on those columns bump and file `acl.changed` (`cause: "data-room.path"`) at
COMMIT, once per transaction, and skip when the transaction already bumped (`bumpAcl` in
`@fundroom/authz` sets the transaction-local `authz.acl_bumped`). Commit time keeps the lock order
(entity rows → workspace row → audit chain): a transaction that audited already holds the
workspace row. Other processes see the change within the 5 s `acl_version` cache, as for any grant
change.

### Download filenames

Downloads build `Content-Disposition` with `attachmentDisposition` (`src/disposition.ts`). The
real name travels as `filename*=UTF-8''…` (RFC 8187). The quoted `filename="…"` fallback is folded
to printable ASCII, because a non-Latin-1 value made the `Headers` constructor throw (a 500), and
a backslash or quote would change how the value is parsed. Both names lose control characters, path
separators (replaced by `_`), leading dots and bidi overrides or isolates, and are capped at 200
characters.

Audit: `folder.created / updated / deleted / restored / template_applied`, `document.created /
version_uploaded / updated / deleted / restored / purged / legal_hold_set / legal_hold_cleared /
scan_infected / sanitized / ingested / vaulted / viewed / downloaded`, `upload.aborted`, `data_room.settings_changed`,
and the `qa.*` actions (resource kind `qa_question`, see [Q&A](#qa)).
Outbox: `document.ingested`, `document.vaulted`, `document.viewed`, `document.downloaded`, `qa.question_asked`,
`qa.question_assigned`, `qa.answer_submitted`, `qa.answer_released`, `qa.question_declined`,
`qa.question_due`. Webhooks: `document.viewed`, `document.downloaded`, `qa.question_asked`,
`qa.answer_released`.

Jobs: `data-room.ingest` (per version), `data-room.vault` (per completed e-sign envelope), `data-room.purge` (hourly: recycle bin past `purge_after`,
orphaned blobs two-phase, expired uploads, stuck ingests), `data-room.reconcile` (weekly: storage
prefix vs rows), `data-room.qa-sla` (every 15 minutes: Q&A due-soon / overdue reminders).

Settings (`workspace.settings.dataRoom`): `watermarkByDefault`, `downloadByDefault`,
`allowUnscanned`, `purgeAfterDays`, `maxUploadBytes`, and `qa` (`enabled` false,
`requireApproval` false, `slaHours` 72, `reminderLeadHours` 24, `defaultVisibility` `asker`,
`allowFolderQuestions` true, `maxOpenPerAsker` 25). `PATCH /settings` locks the workspace row,
re-reads and deep-merges (the `qa` patch is strict).

## Text layer

`GET /documents/{id}/pages/{n}/text` → `{ pageNo, pageCount, text }`: the extracted text behind the
page image, for screen readers, zoom-to-text and find-in-page in the secure viewer. It runs the page
image's checks verbatim — `view` on the document (direct or folder grant), gates pending → 403 with
`pendingGates`, no access → 404, a version that is not viewable (processing, unscanned under the
policy, unsupported, failed) → 409 with `reason`, a page past `pageCount` → 404 — and answers
`Cache-Control: private, no-store`. A page with no text layer (a scan) answers `text: ""`.

**Protection does not withhold it.** `protection.download` and `protection.print` govern copies of
the *file*; the watermark is a deterrent burned into *images*. The words are already readable, page
by page, by everyone this route admits (and findable through `GET …/search?q=`), so removing the text
layer would stop no leak — it would only lock screen-reader users out of the document (WCAG 1.1.1).
The route is read-only: no audit event, no outbox row, no counter (the viewer's `POST …/viewed`
records the view once per session), so it answers 200 under view-as and writes nothing. No extra
rate limit beyond the page image's (none): the text of a page is smaller than its image.

## Workspace search

`search: { version: 2, entries, page }` on the manifest (the rebuild reads `page`: folders 500 and
documents 50 per short transaction, so a rebuild never blocks renames, moves or ingest), and
incremental upkeep through `services.search` on the write's own transaction:

- **document** (`/data-room/documents/<id>`) — every live document: title always; body = the current
  version's page text in page order joined by newlines (≤ 200 000 chars, control characters
  stripped) once that version is `ready` and its blob servable (`clean`, or `skipped` while
  `allowUnscanned` is on — turning it off empties those documents' bodies in the settings
  transaction, and either flip requests a reindex). ACL `resource` / `document` /
  the document id / `folder_path` — the same ref `AuthzPort.check()` and `core.has_access` evaluate,
  so folder grants inherit and a gated (NDA pending) hit shows its title only.
- **folder** (`/data-room/folders/<id>`, the investor folder view) — every live non-root folder, title
  only, ACL `resource` / `folder` / its own `path`.
- **qa** (`/data-room/questions/<id>`, version 2) — every `published` question on a live target
  while `qa.enabled` is on: title = the target's title (never Q&A text, so a gated hit reveals
  nothing a gated document hit does not), body = public wording + answer, ACL = the target's
  resource ACL. See [Q&A](#qa).

Upkeep: upload `complete` (title now; a new version drops the old version's text), the end of the
ingest job (body), document rename / move / delete / restore / purge, folder create (also via
templates), rename, move (the subtree's entries are re-pathed by one SQL statement —
`services.search.moveAclPath` — in the move's transaction: no text is re-read, and there is never
a window in which an entry carries the old ACL path), restore (the soft delete removed the
entries, so the subtree is re-read at its current path, keyset-paged, 50 documents at a time) and
subtree delete.

## Workspace export / import

`portability: { version: 2, tables, afterImport }`, every `dataroom` table in FK order:

| table | carried | notes |
|---|---|---|
| `folder` | rows | `path` through `remapLtree` (labels are folder ids without hyphens) |
| `blob` | rows + object | decrypted into the zip, re-encrypted under the new workspace's `workspace-dek`; `sha256` verified. A blob that never left quarantine (pending/scanning/error/infected) exports no bytes — an infected object is malware — and imports with a placeholder key, `scan_status = 'error'` |
| `document` | rows | `folder_path` through `remapLtree`; protection and legal hold carried as data |
| `document_version` | rows | immutable history, `current_version_id` remapped generically |
| `rendition` | skipped (derived) | re-rendered |
| `page_text` | skipped (derived) | re-extracted |
| `upload` | skipped (transient) | |
| `qa_question` | rows | E3.3 (version 2); membership, document and folder ids remapped |
| `qa_answer` | rows | E3.3 (version 2) |

`afterImport` puts every carried `ready` current version back to `pending`, marks a `pending`
version whose bytes were not exported `failed`, enqueues `data-room.ingest` (`rederive: true`) per
version and requests a search reindex. Ingest on an already-promoted clean blob does not rescan and
never adds versions: it re-renders the thumbnail / sanitised PDF, re-extracts page text and
re-indexes the document (page images stay lazy).

## Q&A

Investors ask about a document or folder they can view; staff triage, answer, optionally
approve (four-eyes) and release the answer to the asker or publish it to everyone who can view
the target. Code: `src/qa/` (rules, service, routes, io-routes, search, jobs, erasure, view);
migration `0003_qa`. **Off by default** (`settings.dataRoom.qa.enabled`): investor routes answer
404 except `GET /qa/status`; staff routes work regardless.

- **Status.** `open → assigned → (awaiting_approval) → answered` (asker only) `→ published`
  (everyone who can view the target); `closed` is `declined`, `withdrawn` (asker, before release)
  or `erased` (DSAR — a tombstone: every staff write is 409 `erased`). Unpublish → `answered` (or
  `assigned`/`open` without an asker); reopen refuses `withdrawn`. `source`: `portal`, `import`,
  `staff`.
- **Visibility.** Per asker: the asker sees their own thread in any status. Anyone else sees only
  `published` questions on a live target they can view now, as `publicText` + answer +
  `publishedAt` — never the asker, the original subject/body, notes, assignee, drafts or
  `createdAt`; `scope=target` lists order and page by `published_at`. Someone else's question by
  id also runs `AuthzPort.check("view")` on the target (gated → 403, none → 404). Delegates read
  published answers but never ask, withdraw or see their investor's questions.
- **RLS + triggers.** External actors read their own rows (not as delegate) and published rows
  on live, viewable targets; insert only their own `open` `portal` question; update only to
  withdraw. `qa_question_external_guard` (UPDATE) admits only waiting → `closed`/`withdrawn` with
  no other column changed; `qa_question_external_insert_guard` (INSERT) keeps every staff column
  empty and sets `due_at` from `qa.slaHours`. Answers: read through a question that released them,
  never written externally.
- **Four-eyes** (`requireApproval`). Approval pins `approved_body_sha256`; release needs an
  approval matching the current body; the author cannot approve. A changed released answer goes
  offline (`assigned`/`open`, unindexed, fresh SLA) until approved and released again.
- **Lock order.** Question rows (FOR UPDATE, by id) → workspace row (FOR NO KEY UPDATE,
  `qaSearchEnabled`) → search entries → audit chain → outbox, on every Q&A write path. This is the
  kernel's global rule with the question rows in front: **workspace row → audit chain**,
  enforced structurally — every audit (`lockAuditChain`) and every search write take the
  workspace row FOR NO KEY UPDATE first. Nothing locks the workspace row FOR SHARE and then
  writes (the audit's upgrade would deadlock two such transactions). Staff actions index before
  they audit; purge, erasure and document/folder rename, move, trash and restore lock the affected
  question rows first; the SLA sweep locks its candidates `FOR UPDATE SKIP LOCKED`. Each ordering
  has a race test asserting no new `pg_stat_database.deadlocks` (`lock-order.integration.test.ts`
  covers the cross-package pairs).
- **SLA.** Clock starts at ask; only asker questions have a due time (assign never sets one);
  reopen and four-eyes take-offline re-arm it. `data-room.qa-sla` sends at most one due-soon and
  one overdue reminder per deadline (`qa.question_due`).
- **Import / export** (`qa_manage` + fresh session). Export: formula-guarded CSV, capped at 50 000
  rows with `X-Fundroom-Export-Truncated: true` (and the pre-rename `X-Seedhost-Export-Truncated`,
  marked deprecated in OpenAPI, until the next minor release). Import: ≤ 500 rows, ≤ 1 MiB, all-or-nothing, dry
  run, errors by physical line; its own body limit `QA_IMPORT_BODY_LIMIT_BYTES` (6 MiB + 64 KiB);
  the export re-imports as is.
- **Erasure / DSAR.** Erasure writes `[erased]` over the subject's subject, body and public
  wording and closes every one as `erased` (not enablement-gated). DSAR export lists the member's
  questions and the answers released to them.

Routes (under `/api/v1/data-room`):

| route | requires |
|---|---|
| `GET /qa/status`, `GET /qa/questions`, `POST /qa/questions`, `GET /qa/questions/{id}`, `POST /qa/questions/{id}/withdraw` | member |
| `GET /qa/inbox`, `GET /qa/inbox/{id}` | `data-room.read` |
| `PUT /qa/inbox/{id}/answer`, `POST /qa/inbox/{id}/submit` | `data-room.qa_answer` |
| `POST /qa/inbox/{id}/approve`, `POST /qa/inbox/{id}/reject` | `data-room.qa_approve` |
| `POST /qa/inbox`, `PATCH /qa/inbox/{id}`, `POST /qa/inbox/{id}/assign`, `…/release`, `…/unpublish`, `…/close`, `…/reopen` | `data-room.qa_manage` |
| `GET /qa/export`, `POST /qa/import` | `data-room.qa_manage` + step-up |

Audit (`qa_question`): `qa.question_asked`, `qa.question_withdrawn`, `qa.question_assigned`,
`qa.answer_saved`, `qa.answer_submitted`, `qa.answer_approved`, `qa.answer_rejected`,
`qa.answer_withdrawn_for_review`, `qa.answer_released`, `qa.answer_unpublished`,
`qa.question_closed`, `qa.question_reopened`, `qa.question_edited`, `qa.imported`, `qa.exported`,
`qa.question_due`.

## Vaulting

A completed e-signature envelope's signed PDF (and the vendor's certificate / audit trail,
when it sends one) is filed into the data room as a **legal-hold, staff-only** document. Code:
`src/service/vault.ts` (job + handler + folder path), `src/service/from-bytes.ts`
(`createDocumentFromBytes`: the upload pipeline for bytes the server already holds), migrations
`0004_vault` (columns) and `0005_staff_only` (the veil at the storage layer).

- **Trigger.** The kernel publishes `esign.envelope_completed` once its `esign.collect` job has
  stored and scanned the artifacts. The handler enqueues `data-room.vault {workspaceId, envelopeId}`
  (idempotency key `data-room.vault:<envelopeId>`) on the dispatcher's transaction.
- **Job.** Skips — never fails — when the data room is disabled for the workspace at run time (the
  kernel keeps the artifact; vaulting is best effort), when the envelope is unknown, not completed,
  names no vault folder, or is already vaulted. It reads the envelope (`services.esign.get`, a
  short transaction) and the artifacts (`services.esign.readArtifact`, **outside** any
  transaction), stages the bytes on quarantine keys (storage writes, outside too), then files
  everything in **one** transaction and lets `data-room.ingest` do the rest (scan → encrypt →
  sanitise → render → index), exactly as for an upload but with no upload row.
- **Folder path.** The envelope's `vault_folder` hint (`Signed documents/<round name>`,
  `Signed documents/NDAs`) is split on `/`; each segment reuses a live child of the same name
  (case-insensitive) or is created. The first folder the vault creates while nothing above it is
  staff-only is created **staff-only**. If the whole path already exists and nothing on it is
  staff-only, the leaf is flagged staff-only (fail closed; `folder.updated` with a diff) rather than
  filing a signed document where investors can see it; folders above keep their access.
- **Documents.** `<envelope title> — signed` (carries `esign_envelope_id`, the dedupe key) and
  `<envelope title> — certificate`, both `legal_hold = true`, `legal_hold_reason =
  'esign:<envelopeId>'`, protection `{download: false, watermark: true, print: false}`, created by
  the system. Audited `document.vaulted` per document (`meta.artifact`); **one** outbox
  `document.vaulted {documentId, versionId, envelopeId}` for the signed copy (the kernel records
  `vaultedDocumentId`, round links the commitment).
- **Idempotent and race-free.** Every vault transaction of a workspace first takes a dedicated
  advisory lock (`dataroom.vault:<workspace>`, taken by nothing else), then re-checks the dedupe
  key: an outbox redelivery, a job retry and two envelopes completing at once into the same new
  path all serialise — one folder, no `409`, no duplicate. Lock order: vault lock → question rows
  (only when flagging an existing folder) → folder / document rows → workspace row (`acl_version`)
  → search entries → audit chain → outbox.
- **Legal hold and erasure.** A vaulted document cannot be deleted, binned or purged (the service
  refuses 409 `legal_hold`; the 0001 triggers refuse any writer), and a folder holding one cannot
  be binned. Erasure (DSAR) leaves vaulted documents alone: they are signed records under retention
  (≥ 6 years); the kernel pseudonymises the signer on the envelope row.
  Workspace export carries them as ordinary held documents without `esign_envelope_id` (envelopes
  are not exported).

### The staff-only veil

**Invariant:** nothing at or below a `staff_only` folder is visible to an external member
(investor, delegate, share-link visitor) — whatever they were granted: a grant on the data-room
root, on the staff-only folder itself, on a folder inside it or on the document. **The flag
dominates evaluation; a grant never lifts it.** Grants on veiled nodes are accepted (the access
screens show them with no capabilities) and simply have no effect. Staff — and staff API keys —
are never veiled. It holds in every layer that decides access:

1. **The module's checks** (`src/service/access.ts`): every `document` / `folder` decision for an
   external viewer tests the node's path against the workspace's staff-only paths (read from the
   folder rows) *before* `AuthzPort.check()`, and answers exactly like "no grant" (404, never a 403
   that confirms existence). Tree, detail, thumbnail, pages, text layer, in-document search,
   download, `viewed`, `document_list` hydration and the Q&A target checks all go through it. It
   reads the rows, so it holds from the commit that created or moved the folder.
2. **RLS** (`0005_staff_only`): the external read policies on `folder` and `document` add `NOT
   dataroom.under_staff_only(path)`; versions, renditions, page text and Q&A rows are only readable
   through a readable document, so they follow.
3. **Search**: documents, folders and published Q&A at or below a staff-only folder are indexed with
   the `staff` ACL (not `resource`), in the transaction that files, moves or flags them.
4. **The authz kernel** (`packages/authz` rebuild, `whoHasAccess`, `explain`): for external
   principals every node at or below a staff-only folder materialises with **no** capability, and
   each staff-only folder gets a zero row of its own, so `core.has_access()` and `check()` (own row
   first, else the deepest ancestor) stop there instead of reaching a grant further up. Writing or
   flagging a staff-only folder bumps `acl_version`.

**Why a later grant cannot undo it:** no layer consults grants for a veiled node — layers 1–3 test
the path alone, layer 4 overrides whatever the rules resolve to. The flag itself is sticky: no
route sets it to false, and a trigger (`folder_staff_only_sticky`) refuses an UPDATE that tries.

**Exposing a signed document is a deliberate staff move.** `PATCH /documents/{id}` with another
`folderId` (`data-room.manage`) may move a vaulted document out of the staff-only subtree — a legal
hold does **not** prevent it (the hold preserves the document and its versions, not its location;
it stays held). The move is audited on `document.updated` with `leftStaffOnly: true` (or
`enteredStaffOnly`) and `legalHold: true`; the search entry turns `resource` in the same transaction
and the new location's grants apply. Moving it back hides it again at once. Folder moves into or
out of a staff-only subtree re-read the subtree's search entries the same way. A restore from the
recycle bin never un-veils: a document or folder whose staff-only ancestor is still binned answers
409 `staff_only_parent` instead of coming back under the root.
