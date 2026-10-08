# @fundroom/audit

Append-only, per-workspace hash-chained audit log: the recorder, diff redaction, IP minimisation, HMAC-signed daily
checkpoints, partition maintenance, in-database and offline verification, and the
`fundroom-audit` CLI. The tables and the chain trigger live in `@fundroom/db`
(migration `0002_audit_events`).

```ts
import { createAuditService, diffOf, createCheckpointJob, createAuditMaintenanceJob } from "@fundroom/audit";

const audit = createAuditService({ db, truncateIp: config.raw.AUDIT_IP_TRUNCATE });

// Same transaction as the change; actor defaults to the request context.
await db.withTenant(ctx, async (tx) => {
  const before = await grants.find(id);
  const after = await grants.update(id, patch);
  await audit.record(tx, ctx, {
    action: "grant.changed",
    resourceKind: "grant",
    resourceId: id,
    subjectMembershipId: after.membershipId,
    ip: req.ip, userAgent: req.ua, requestId: req.id, sessionId: session.id,
    diff: diffOf(before, after, { copy: ["capability", "effect", "validity"], hash: ["email"] }),
    meta: { aclVersion },
  });
});

// Host-level facts (no tenant transaction) go to the platform chain.
await audit.recordDetached({ ...platformContext(), userId }, { action: "auth.mfa_enrolled", resourceKind: "credential" });

// Jobs for the composition root.
const jobs = [createCheckpointJob({ db, keyRing }), createAuditMaintenanceJob({ db, audit, retentionMonths: config.raw.AUDIT_RETENTION_MONTHS })];
```

- `seq`, `prev_hash` and `hash` are assigned by the `audit.chain()` trigger under a
  per-workspace advisory lock; `hash = sha256(audit.canonical(row))`, a jsonb rendering with
  a fixed key set that embeds `prev_hash`. Never set those columns from code.
- The app role has SELECT + INSERT only; triggers reject UPDATE/DELETE/TRUNCATE for everyone
  short of dropping the trigger. Checkpoints (signed with a key ring sub-key, i.e. outside
  the database) catch that case: `fundroom-audit verify` walks the chain and checks every
  checkpoint's hash and signature.
- Partitions are monthly (`audit.event_YYYYMM`), created three months ahead by the recorder
  and the daily `audit.maintenance` job, which also drops months past
  `AUDIT_RETENTION_MONTHS` (floor 12) and records the drop in the platform chain.
- Offline: `audit.export_rows()` returns `(seq, canonical, hash)`; `verifyExportedChain(rows)`
  recomputes everything with `node:crypto`. Signed export bundles: see below.
- External sinks (`AuditSinkPort`): pass `onRecorded` to publish `audit.recorded` to the outbox
  and register a subscriber that loads the row and calls the sinks after commit.

```
fundroom-audit verify [--workspace <uuid>] [--from <seq>]   # exit 1 on any failure
fundroom-audit checkpoint                                    # what the daily job does
fundroom-audit verify-export <bundle.zip> [--public-key <b64>]...   # offline, no DB
```

`verify-export` exit codes: **0** verified and signed by a `--public-key` you gave; **1** failed;
**2** usage; **3** `UNVERIFIED ORIGIN` — the bundle is internally consistent but, with no
`--public-key`, was checked only against the key it embeds itself, which proves nothing about who
made it (a truncated bundle re-signed under a made-up key passes that check). Scripts must treat
3 as "not verified".

## Admin reads

`listAuditEventsPage(tx, workspaceId, filter, { beforeSeq, limit })` backs
`GET /api/v1/audit/events`: newest first by `seq` (a total order per workspace, so the keyset
cursor is the seq alone), filters on action (exact, or prefix when it ends in `.` — matched with
`starts_with`, because `_` is a LIKE wildcard), actor, subject, resource, outcome and an
inclusive `occurred_at` window. Actor and subject names are joined at read time from *this*
workspace's memberships (user display name, else profile `displayName`) and read `null` once a
person is erased. It runs in the caller's tenant transaction, so `tenant_fence` enforces isolation.

## Signed export

`POST /api/v1/audit/exports` (owner/legal, step-up) reads the range with
`readWorkspaceExport(tx, …)` in one tenant transaction, builds the zip with
`buildExportBundleAsync(…)` after releasing it (deflate on fflate's worker thread), and records
`audit.exported` in a second transaction; `verifyExportBundle(bytes, { trustedPublicKeys })`
checks one with no database and no config. One export per workspace runs at a time in a process
(409 `conflict`, reason `export_running`).

| File | Content |
| --- | --- |
| `manifest.json` | `{ version: 1 \| 2, kind: "seed-host.audit-export", workspace {id, slug, name}, generatedAt, generatedBy {membershipId}, range {from, to, fromSeq, toSeq}, prevHash, headHash, rowCount, files {name: sha256hex}, signature {alg: "Ed25519", keyId, publicKey} }` |
| `manifest.sig` | base64 Ed25519 signature over the exact bytes of `manifest.json` |
| `events.jsonl` | one `{seq, canonical, hash}` per line — `audit.export_rows()`, the text each hash was computed over |
| `events.csv` | the same rows for people: UTF-8 BOM, CRLF, every cell formula-guarded (`@fundroom/csv` `csvField`) |
| `checkpoints.json` | the signed daily checkpoints whose seq falls inside the range |
| `VERIFY.md` | how to check all of it with `sha256sum` + `openssl`, or the CLI |
| `anchors.json` | version 2 only (below): per anchored checkpoint `{ checkpointId, leafIndex, path, treeSize, root, receipts }` |

- **Key.** Ed25519 seed = HKDF-SHA256(key ring entry, empty salt,
  `seed-host/audit/export-ed25519/v1`, 32 bytes); `keyId` = the entry id; new bundles are signed
  with `ring.current`. `exportPublicKeys(ring)` lists every entry's public half
  (`GET /api/v1/audit/export-key`). Nothing is stored: it rotates with the ring.
- **Range.** A time window becomes the *contiguous* seq range covering it (first seq at or after
  `from` .. last seq at or before `to`), because a chain only verifies over contiguous rows; a
  row whose `occurred_at` was supplied out of order but sits between those seqs is included.
  `prevHash` is the stored hash of `fromSeq - 1` (null at seq 1), so a mid-chain slice verifies.
  At most `MAX_EXPORT_ROWS` (50,000) rows, 413 `payload_too_large` above it — narrow the date
  range and export in parts. The bundle is built in memory: measured at 50,000 rows, ~0.9 s
  wall, ~0.4 s of it on the event loop (the deflate runs on a worker) and ~170 MB peak transient
  RSS (at the earlier 200,000 cap, built synchronously: ~5.2 s blocking the event loop, ~600 MB). An empty window is a valid bundle
  with `rowCount: 0` and null seqs/hashes.
- **Zip hygiene.** The verifier refuses a zip that repeats an entry name (fflate keeps the last
  entry of a name, `unzip` and archive browsers show the first — a forged `events.jsonl` ahead of
  the genuine one would otherwise pass while people read the forgery) and any file a bundle never
  contains.
- **Pin the key, and record it at export time.** Unpinned verification (`trusted: null`) proves
  integrity only; the CLIs print `UNVERIFIED ORIGIN — …` and exit 3. The public key is in the
  manifest and on `GET /api/v1/audit/export-key`; whoever receives an export (counsel, auditor)
  should record the key **from the endpoint when the export is made** and keep it with the bundle.
  The ring rotates: `fundroom audit verify-export` with a loadable config trusts only the ring's
  *current* entries, and the endpoint lists only those, so a bundle signed by a key later removed
  from the ring fails there (NOT trusted) and verifies only with `--public-key <recorded key>`.
  The bundle's own VERIFY.md says the same.
- **What verification catches.** Edited manifest → signature. Edited file → its sha256. Edited
  line re-hashed and manifest re-signed with another key → pinned-key mismatch
  (`trustedPublicKeys`; without it `trusted` is `null` and only integrity is proven). A
  dropped middle row → chain (`prev_hash`, seq contiguity). A truncated tail → `rowCount`,
  `range.toSeq` and `headHash`. A cut prefix → `prevHash`. Rows from another workspace →
  `workspace_id` check. A checkpoint in range whose hash differs from its row → reported.
- **Determinism.** Same input (including `generatedAt`, also each entry's zip mtime) → same
  bytes; fflate writes DOS times in local time, so hosts in different time zones differ in zip
  bytes but never in the signed manifest.
- The route records `audit.exported` (meta `{fromSeq, toSeq, rows, sha256, keyId}`) after the
  zip is built, in a transaction of its own; the range was fixed when it was read, so that row is
  never inside the export it describes, and a failed build records nothing.

## External anchoring

Off unless `AUDIT_ANCHOR_DRIVERS` lists anchors; operations in
[`docs/runbooks/audit-anchoring.md`](../../docs/runbooks/audit-anchoring.md). This package owns the tree, the
job, the proofs and the bundle checks; the anchors themselves are `AuditAnchorPort` adapters
(`@fundroom/anchor-rfc3161`, `@fundroom/anchor-rekor`), which this package never imports: drivers and
offline verifiers are injected.

- **`merkle.ts`**: RFC 6962 leaf (`SHA-256(0x00 ‖ data)`), node (`SHA-256(0x01 ‖ l ‖ r)`), MTH for any size,
  inclusion paths and their verification (checked against the Certificate Transparency test vectors).
- **`anchor.ts`**: `anchorPending({ db, drivers, keyRing?, log?, now?, maxBatchLeaves? })` (the job and
  `fundroom audit anchor`) and `createAnchorJob(...)` (`audit.anchor`, cron `40 2 * * *`, registered only with
  drivers). A run takes every checkpoint without a `merkle` anchor, ordered by `(created_at, id)` across all
  workspaces and the platform chain, skips any whose HMAC fails (`audit.anchor_checkpoint_skipped`), and
  builds batches of at most `MAX_BATCH_LEAVES` (10 000), up to 20 per run, under a run-wide advisory lock.
  A batch and its anchor rows are written in a savepoint; leaves whose row cannot be written are removed and
  the tree rebuilt (≤ 3 attempts) before any driver is called, and reported in `skippedCheckpointIds`. Each
  driver's receipt is stored only when the driver's own offline `verify` says `verified`; a failed driver is
  retried on later runs for batches created in the last 7 days (database clock), `UNIQUE (batch_id, kind)`
  keeping one receipt per anchor. Driver failures are logged `audit.anchor_driver_failed` with `errorCode`;
  each batch attempt is audited `audit.anchored` on the platform chain (`{ batchId, leafCount, kinds,
  failures }`). Result: `{ batchIds, leaves, receipts: { batchId, kind, ok, code? }[], skipped,
  skippedCheckpointIds }`. Also `listAnchorPage` (the anchors list route; per item `state` anchored, pending
  or failed) and `readAnchorProof` (the proof route).
- **`anchor-key.ts`**: `deriveAnchorSigningKey(entry)`: an ECDSA P-256 `KeyObject` from a key-ring entry (HKDF
  48 bytes, purpose `ANCHOR_KEY_PURPOSE` = `seed-host/audit/anchor-ecdsa-p256/v1`, d = (v mod (n − 1)) + 1),
  used by the Rekor adapter.
- **Trusted time.** A receipt's time counts only when it verified and is time-bearing:
  `status === "verified" && (timeTrusted ?? kind === "rfc3161")`. RFC 3161 receipts are; Rekor receipts are
  presence-only. Per checkpoint, the internal `checkpointAnchorState` gives `failed`, `time_verified`, `late`
  (earliest trusted time more than `ANCHOR_LATE_DAYS` = 8 after the head or creation: `anchor_late`, a
  warning),
  `presence_only`, `unverified_origin`, `unchecked` or `none`; a head later than the trusted time plus 5
  minutes is `anchor_inconsistent` (failed).
- **`verifyWorkspace(..., { anchorDrivers?, now? })`** binds each anchored checkpoint to its head row (event
  id, head time, hash), recomputes the leaf, verifies the path to the batch root and that the batch's
  `leaf_count` equals the proof's tree size, and verifies each receipt with the matching driver. Result
  `anchors: { checked, verified, late, presenceOnly, unverifiedOrigin, failed, missing }` (always present) and
  `anchorProblems: { code, checkpointId, detail }[]`; codes `anchor_path_invalid`, `anchor_receipt_failed`,
  `anchor_inconsistent`, `anchor_missing` (a checkpoint older than 8 days without a receipt while drivers are
  configured; never without drivers) and `anchor_late` (does not clear `ok`).
- **`anchor-proof.ts`**: `verifyAnchorProof(doc, { verifiers, trustedPems, trustedOrigins })` checks a proof
  file from `GET /api/v1/audit/anchors/{checkpointId}/proof` offline; verdicts `verified`, `late`,
  `presence_only`, `unverified_origin`, `failed`; `anchorProofExitCode` maps them to 0 / 3 / 3 / 3 / 1 and
  `formatAnchorProofVerification` prints them (`fundroom audit verify-anchor`).
- **Bundle version 2.** `EXPORT_BUNDLE_VERSION` is 2: a bundle whose range has anchored checkpoints adds
  `anchors.json` and lists it in `manifest.files`; a range with none is still written as version 1 (no
  `anchors.json`, the E3.12 VERIFY.md). Both verify; a v1 manifest with `anchors.json`, or a v2 without it,
  fails. Every checkpoint in a bundle must be bound to an exported row (integer seq in range, the row's hash,
  event id and head time), or the bundle fails. `verifyExportBundle` stays synchronous and checks inclusion
  paths only (receipts `unchecked`); `verifyExportBundleAnchored(bytes, { trustedPublicKeys?,
  anchorVerifiers?, trustedAnchorPems?, trustedAnchorOrigins? })` also verifies receipts, and reports
  `anchors: { checkpoints, anchored, verified, unverifiedOrigin, unchecked, failed, receipts[] } | null`
  (null for v1) with the coverage ("anchored through seq N at T"). `exportVerificationExitCode(v, {
  requireAnchors })`: with `requireAnchors`, 3 unless an on-time trusted time-stamp of a checkpoint inside the
  range verified against a pinned signer and no in-range anchor is late.
- **The `fundroom-audit` package CLI has no anchor commands**: building drivers and verifiers needs the
  adapters. The product CLI has `fundroom audit anchor`, `fundroom audit verify-anchor <proof.json>
  [--anchor-cert <pem>]... [--rekor-origin <origin>]...` and `verify-export ... [--anchor-cert <pem>]...
  [--rekor-origin <origin>]... [--require-anchors]`.
- **`./testing`**: `describeAuditAnchorPortContract(name, factory)` (the adapters' shared contract suite:
  verifiable receipts, tampered digest or proof → failed, untrusted signer → `unverified_origin`, network
  errors → `AnchorError` with a code, no redirects followed) and `createFakeAnchor({ kind, fail? })`. `vitest`
  is a runtime dependency because the suite imports it.

Tables (core migration `0026_evidence_authz`): `audit.anchor_batch` (root, leaf count) and
`audit.anchor_receipt` (one per batch and anchor kind) are global, append-only, readable by staff, system and
host contexts and inserted only by system or host; `audit.anchor` rows of kind `merkle` carry `batch_id`,
`leaf_index` and `proof` `{ leafHash, path, treeSize }`, tied to a checkpoint of the same workspace. All stay
with the source install on workspace export and moves.
