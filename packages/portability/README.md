# @fundroom/portability

Workspace export and import: a workspace export zip (manifest + JSONL +
blobs) and import. An owner downloads everything the workspace holds as one signed zip; an
operator can check that zip offline and import it into a **new** workspace on the same or another
FundRoom instance.

```ts
import {
  exportWorkspace, importWorkspace, verifyExportFile, createPortabilityJobs,
} from "@fundroom/portability";

// The portal path: POST /api/v1/portability/exports queues `portability.export`, which writes the
// zip to DATA_DIR/portability/, stores it SHE1-encrypted at ws/<ws>/exports/<id>.zip for 7 days.
jobs.push(...createPortabilityJobs({ db, storage, envelope, keyRing, modules, instanceVersion,
  audit, dataDir }));

// Offline, no database: exit-code semantics of `fundroom workspace verify-export`.
const v = await verifyExportFile("acme.zip", { trustedPublicKeys: [pinnedKey] });

// Operator import (the CLI wraps this).
await importWorkspace({ ...deps, audit, moduleServices, rebuildAccess, tmpDir },
  { file: "acme.zip", slug: "acme-2", trustedPublicKeys: [pinnedKey], importedBy: "cli:ops" });
```

## The format: `seed-host.workspace-export` v1

| entry | what |
|---|---|
| `manifest.json` | source (workspace id, slug, name, instance version), options, `modules` (each module's portability version and this build's migration names), every table in import order with its row count and sha256 or `skipped` reason, blob count/bytes, `omitted` (module schemas the source database has but the export did not read — see below), the sha256 of **every other entry** (`files`), the audit head, and the signing key |
| `manifest.sig` | base64 Ed25519 signature over the exact bytes of `manifest.json` |
| `tables/<schema>.<table>.jsonl` | one row per line, the database's own column names (`to_jsonb`); generated columns left out; `numeric`/`bigint` as strings (no float rounding); `bytea` as `\x…`; a file column holds `blob:<sha256>` with `$blobs.<column> = {sha256, key[, size]}` beside it (`size` only when the object was read during the row pass) |
| `audit/events.jsonl`, `audit/checkpoints.json` | the source's hash chain (`{seq, canonical, hash}`) and its signed checkpoints — evidence, never re-inserted |
| `blobs/<sha256>` | every file, **decrypted**, named by the sha256 of its bytes (deduplicated) |
| `README.md` | the same explanation for whoever opens the zip |

The central directory lists `manifest.json`, `manifest.sig`, then tables, audit, blobs, README.
The zip is written by our own streaming writer with **ZIP64** (an export can exceed 4 GiB; fflate's
`Zip` writes no ZIP64 records): JSONL is deflated with `node:zlib`, blobs are stored. Nothing is
buffered beyond one cursor page and one chunk.

**Signing.** Ed25519, seed = HKDF-SHA256(key ring entry, info `seed-host/workspace/export-ed25519/v1`)
— a different purpose from the audit bundle's key, deterministic, rotates with `FUNDROOM_SECRET_KEY`,
never stored. `GET /api/v1/portability/export-key` publishes every ring entry's public half. Record
the key when you download: an export proves its origin only against a key obtained independently
of it.

**One snapshot, then the files.** Phase 1 is one short **read-only** `system` transaction: every
table is read through a single `UNION ALL` cursor — one statement, so one snapshot for every table
— so a row inserted mid-export can never reference a row the export already passed; the audit
trail and every data key the files need are read in the same transaction, which then commits.
Phase 2 holds no transaction (and no connection): each distinct file is streamed into the zip once,
decrypted, hashed on the way and refused if it does not match the digest its row declared. A blob
column with a `sha256Column` (the data room: content-addressed, immutable) is not read in phase 1
at all; objects whose digest the row needs up front (optional ones, click-wrap certificates, the
logo) are read and hashed in phase 1 and copied in phase 2. No spool on disk.

**Modules left out.** A module compiled into the build but not loaded (`MODULES`) — or any schema
with tenant tables that no compiled-in module owns — is not exported, but it is not dropped
silently either: `manifest.omitted` lists each such schema with its tables and this workspace's
row count (null when it could not be counted), the finished export carries `warnings` (API
`WorkspaceExport.warnings`, `fundroom workspace export` prints them), `verify-export` prints a
`NOT INCLUDED` line, and the importer repeats them in its warnings.

**Crash safety.** The `portability.export` job is never retried, so a worker that dies must not lock
the workspace out. While it makes progress the job beats at least once a minute (`started_at` on
`core.workspace_export` is the heartbeat, and the temp file's mtime is refreshed). A running export
whose heartbeat is **15 minutes** old is stale: the next `POST /portability/exports` fails it first
(so it no longer answers 409 `export_running`), the hourly `portability.expire` fails it, and
`DELETE` removes it; a queued export can be cancelled with `DELETE` at any time (its job then finds
no row). A job whose row stopped being `running` under it aborts at its next beat and deletes what
it wrote. Temp files (`DATA_DIR/portability/export-<id>.zip`) untouched for 15 minutes are swept
when an export starts and hourly.

## Verification (`fundroom workspace verify-export <zip> [--public-key <b64>]…`)

The zip reader is strict — it reads workspace exports, not arbitrary archives — and refuses at open:
an archive comment or file comments (a comment can carry a second, fake end record), more than one
disk, end records whose counts, sizes or ZIP64 twins disagree, a central directory that does not
end exactly at the end record or holds more or fewer records than declared, a saturated 32-bit
field without a well-formed ZIP64 extra, sizes past 2^53, entry names that are not valid UTF-8 or
contain NUL, a backslash, a leading `/`, a drive letter or a `.`/`..`/empty segment, encryption and
unknown flags, methods other than stored/deflate, a stored entry whose two sizes differ, **any local
header that disagrees with its directory record** (name bytes, method, flags, and CRC and sizes
unless a data descriptor defers them), and entries that overlap or leave unaccounted bytes between
them (prepended or smuggled data). Then, before reading any payload: duplicate entry names (tools
disagree on which copy they show), entries an export never contains, entries declared over 5 GiB,
a manifest that lists one table twice. Then the manifest's shape and **major version** (only 1 is read), the signature
and whose key made it, every entry's sha256 against `files`, every table's row count, every blob's
bytes against its name, every `$blobs` reference against the blobs present, and the audit chain
(each line's hash recomputed, seq contiguous, head = `audit.headHash`, checkpoints agree). Inflation
stops the moment an entry passes the size its directory record declared (zip bombs), and every
entry's CRC-32 is checked.

Exit 0 verified and signed by a pinned key; 1 failed; 3 `UNVERIFIED ORIGIN` (intact, but only the
embedded key was checked). With no `--public-key` and a loadable config, this instance's own keys
are pinned.

The signature covers everything: it signs the exact bytes of `manifest.json`, and `manifest.files`
holds the sha256 of every other entry (tables, audit events, checkpoints, blobs, README), with the
set of names required to equal the zip's content. Entry order carries no meaning for the importer
(it inserts in this build's plan order), so it is not part of what is verified.

## Import (`fundroom workspace import <zip> --slug <new> [--name] [--public-key]… [--allow-unverified] [--owner-email]`)

1. Verified as above. A signature by a key nobody pinned is refused with exit 3 unless
   `--allow-unverified` (recorded as `signature: "unverified"` on `core.workspace_import` and in the
   audit event). The instance's own keys are pinned by default, so a same-instance copy needs no flag.
2. Compatibility: every migration the source build had must exist in this build (a column the
   target lacks would otherwise be dropped silently); a module section newer than this build's is
   refused; a table this build does not declare is refused.
3. A new uuidv7 for **every** exported row id, allocated in export (primary-key) order, so
   time-ordered ids keep their relative order (analytics' rollup cursor relies on it).
4. **One transaction**: the workspace row and the members' users (host context), then — on the same
   connection, switched to the new workspace's `system` actor — every table in plan order. The
   generic remap replaces every JSON string (and object key), at any depth, that equals an exported
   id; `workspace_id` becomes the new workspace; each `blob:<sha>` is re-encrypted under the new
   workspace's key for the blob's `purpose` and stored at `remapKey(old key)`; then the table's
   `importRow`. A non-deferrable FK that points at a row not inserted yet (a cycle such as
   `legal_document.current_version_id`, a self-reference) is written NULL and set at the end;
   `SET CONSTRAINTS ALL DEFERRED` covers the deferrable ones, checked at COMMIT. Then the
   suppression list is re-hashed, effective access rebuilt, every module's `afterImport` runs
   (re-derivation: renditions, search), a search reindex is requested, the source audit trail is
   archived **encrypted** at `ws/<new>/imports/<importId>/audit.zip`, and `core.workspace_import` +
   one `workspace.imported` audit event (source workspace id, manifest sha256, source audit head,
   signature status) start the new chain. Objects written before a failed commit are deleted.

### Import refusal rules

A file is supplied by an operator but is **not trusted for what it names**: a signature (even a
pinned one — a customer migrating from their own instance hands over their own key) proves who made
the file, not that its rows are benign. The importer therefore enforces, whatever the signature:

1. **Object keys are the engine's.** Every declared blob key column must arrive as
   `blob:<64 hex>` or null — anything else (e.g. another workspace's `ws/<id>/quarantine/…` key,
   which the data room's re-ingest would otherwise read, re-store in the new workspace and delete)
   refuses the import (`unsafe_reference`, naming the table and column). The digest must equal
   `$blobs.<column>.sha256` and the row's own `sha256Column`. The stored key is the source key
   remapped, and must be a relative path of plain segments that names the NEW workspace (under
   `ws/<new>/…` when it starts with `ws/`) and whose every uuid-shaped segment is the new workspace
   or a row this import created. A module's `importRow` may not change a key the engine wrote; it
   may only fill a key the engine left null, under `ws/<new>/…` (the data room's placeholder for a
   file whose bytes were not exported). A `cert:` evidence reference without its carried
   certificate is cleared; a logo without its carried blob is dropped.
2. **Verbatim uuids may not name another workspace's rows.** The generic remap rewrites every uuid
   that is an exported row's id and keeps every other uuid verbatim (a reference to something the
   export did not carry). Before inserting anything, the importer asks the database
   (`core.import_foreign_references`, a guarded SECURITY DEFINER function, migration 0014) which
   of those verbatim uuids — anywhere in a row, jsonb included, except the kernel's verbatim
   evidence columns — is the `id` of a row of **another workspace on this instance** (any tenant
   table, or a workspace id). Such a value is cleared: a column value becomes NULL, an array
   element or object key is dropped, and the import's warnings count them; in a **NOT NULL**
   column the import is refused. One exception: a file signed by **this instance's own key** was
   written by this instance's exporter, so its references to rows of its own source workspace are
   genuine (e.g. the analytics rollup cursor's last raw event when raw events were not exported)
   and are kept. The check needs the function's owner (the migration role) to bypass RLS, as the
   migration runner already expects; otherwise the import is refused rather than let through
   unchecked.
3. **Foreign keys stay inside the workspace.** After every row is in (and before `afterImport`),
   every foreign key — from `pg_catalog`, any arity — whose child table received rows and whose
   parent is workspace-scoped is checked: an imported row that references a parent row outside the
   new workspace refuses the import (FK checks bypass RLS, so the database alone would accept a
   document filed in another tenant's folder, which would then block that folder's deletion or be
   cascaded by it).
4. **Modules check their own invariants.** A module's `afterImport` may throw
   `PortableImportRefusal` (`@fundroom/module-kit`) to refuse the import with its message
   (`invalid_input`, prefixed with the module id); any other error is an import failure. The data
   room refuses a folder tree whose ltree paths do not follow its parent links (the root at `r`,
   every folder at its parent's path plus its own id label, every document at its folder's path,
   deleted rows included): access rules are derived from those paths, so a crafted one
   would be a grant over another folder's subtree.

All of this is one transaction: a refusal leaves no workspace, no rows and no objects behind.

### Identity matching

A membership is exported with its member's email and display name (`$identity`) — never the global
user id, credentials, sessions, devices, passkeys or MFA. On import the email is matched to an
existing live `core.user_identity`, or a user is created with that verified email (what
`provisionUser` does). An existing user keeps their own display name. **Nothing in the result, the
CLI output or the logs says which** — only memberships are counted — so an import cannot be used to
learn whether an address already has an account, or other memberships, on this instance. The same
person therefore signs in to the copy with their existing account and sees what the source gave
them. A member whose identity was erased (DSAR) or who had no email identity is bound to an inert
tombstone user that can never sign in. Kinds and roles, staff roles included, are carried as they
were. `--owner-email` guarantees a live staff owner with that address (an existing live membership
is promoted, otherwise one is created); without it the CLI warns when the copy has no live owner.

**Import is operator-trusted for identity.** Because memberships are matched by email, a file can
attach memberships — staff and **owner** included — of the new workspace to **existing accounts of
this instance**: whoever wrote the file decides who gets what role in the copy, and those people
sign in to it with their existing accounts. (It cannot touch those accounts' other memberships or
data, which stay fenced to their own workspaces, and the refusal rules above keep the copy from
naming other workspaces' rows.) Import only files from sources you know; prefer pinning the source
instance's key (`--public-key`, obtained independently from its `GET
/api/v1/portability/export-key`), and use `--allow-unverified` only for a file whose provenance you
have established another way. Review the imported workspace's members before announcing it.

## What travels, and what does not

Every table in a module schema and every tenant-scoped `core.*`/`audit.*` table has a decision
(`KERNEL_TABLES` for the kernel, `ModuleManifest.portability` for modules); the integration test
compares both with the catalog, so a new table without one fails CI.

Not carried, and why:

- **Derived** — `effective_access` (+ state, rebuilt in the import transaction), `search_entry` /
  `search_state` (reindexed), `audit.chain_head`; modules' renditions and page text (re-rendered).
- **Secret** — `workspace_key` (new keys are minted; every object is re-encrypted); modules' DKIM
  keys (`updates.sending_domain`).
- **Keyed hashes** — `consent_event.ip_hash` (an HMAC under a key that stays behind; omitted),
  `access_request.code_hash` / `client_ip_hash` (an unverified request starts again).
  The **mail suppression list** is keyed too: the export recovers the plaintext of every suppressed
  address the kernel knows (member identities and invitation emails) and the import re-hashes it
  under the new key; a suppression for any other address cannot be recovered and is **dropped**
  (counted as `dropped` in the manifest).
- **Instance-local** — `custom_domain` (DNS points at the source and the hostname's claim is unique
  there), `mail_message` (provider message ids; delivery webhooks go to the source),
  `workspace_export` / `workspace_import`, the source's audit rows (archived, not re-inserted: new
  ids would change every hash).
- **Transient** — `outbox`, `idempotency_key`, `auth_challenge`.
- Carried but **neutralised**: share links are carried as history and **revoked** (the token and
  the passcode — an HMAC under the source's key ring — are secrets); pending invitations keep their
  status with a dead token (resend them); a bulk invite import still queued or running is marked
  failed; module state that would send mail or call out is stopped by each module's `importRow`
  (scheduled posts to draft, queued sends failed, sheet connections disabled).

### What the importer must redo

- Custom domains: add and verify them again, then move DNS.
- Integration secrets: re-paste the Google Sheets service-account credential, re-add chat webhooks
  that did not travel, re-add the sending domain (new DKIM key, new DNS records).
- Share links: mint new ones. Pending invitations: resend.
- People: staff re-enrol passkeys / TOTP on the new instance if their account is new there
  (credentials never travel); everyone signs in with their email.
- Legal evidence stays verifiable: click-wrap certificates are re-sealed under the new key with the
  same bytes, and the source's audit chain (which anchors them) is archived with the import.

## Limits

- `numeric`/`bigint` **columns** round-trip exactly; a number inside a `jsonb` value beyond 2^53
  would be rounded by JSON parsing (FundRoom stores decimals in jsonb as strings).
- A row whose deferred FK column is NOT NULL cannot be deferred: the import refuses rather than
  guessing. Rows needing a deferred column get `updated_at` = import time on tables with an
  `updated_at` trigger.
- An export needs disk for the zip (DATA_DIR). It holds one database connection only for the
  snapshot phase (rows, audit trail, keys); copying the files takes none.
