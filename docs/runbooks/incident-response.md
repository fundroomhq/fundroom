# Runbook: security incident response

An install holds investor documents, investors' contact details and a record of who looked at what. This runbook is for whoever operates the install when something may have gone wrong with that: a leaked credential, an account used by someone it does not belong to, a document seen by someone who should not have seen it, a host you no longer trust, a vulnerability in FundRoom itself. It covers how to size the incident, what to do in the first fifteen minutes, how to preserve evidence before you change anything, how to contain, and who has to be told by when.

It is a procedure, not legal advice. Where it names a legal deadline, the decision about whether and how to notify belongs to the controller of the data and their counsel — this runbook tells you what to have ready for them.

To report a vulnerability in FundRoom itself, see [`SECURITY.md`](../../SECURITY.md).

## What has to be true first

- **You know who the controller is for each workspace.** On a single-tenant install the company that runs it usually is both operator and controller. On a multi-tenant install each workspace's company is the controller and you are processing on its behalf; your duty is to tell them, promptly and with facts, and theirs is to decide what to tell regulators and investors.
- **You can run the CLI:** `docker compose run --rm app <command>` (entrypoint is the CLI; no shell).
- **You can reach Postgres as the owner:** `docker compose exec db psql -U seedhost -d seedhost`.
- **You have somewhere to put evidence that is not this host** — an encrypted bucket, an encrypted laptop volume — and a place to keep a timeline.

## Size it

| Severity | Looks like | Clock |
|---|---|---|
| **SEV1** | Confirmed or likely exposure of investor data or documents to someone not entitled; the master key, database credentials or a host compromised; an attacker with a staff session | Start now, work until contained. Assume a notification decision is needed within 72 hours of *awareness*. |
| **SEV2** | Integrity in doubt without known exposure: `audit verify` fails; a misconfiguration that *could* have exposed data (a public bucket, a grant on the wrong group) with no evidence yet that it did; malware uploaded through the portal | Same day. May become SEV1 once you have looked. |
| **SEV3** | A security control degraded without exposure: the virus scanner down ([av-failure.md](av-failure.md)), expired certificates ([acme-failures.md](acme-failures.md)), a failed login spike that is being refused | Next working day, through the ordinary runbook. |

When unsure between two levels, take the higher and downgrade later. The time you became aware is a fact you will be asked for; write it down now, in UTC.

## The first fifteen minutes

1. **Name one incident lead** — the person who decides, keeps the timeline and talks to workspace owners. Everyone else reports to them.
2. **Start the timeline.** UTC timestamps, what was seen, what was done, by whom. Every command below goes in it with its output file.
3. **Preserve before you change anything** (next section). Recreating a container throws away its logs; rotating a key changes what `audit verify` can check; revoking sessions removes the live sessions you might want to look at. Take the copies first — it takes minutes.
4. **Contain the obvious** (the section after that): if a session or credential is being used right now, revoke or rotate it as soon as the evidence is taken.
5. **If the flaw is in FundRoom itself**, report it privately as `SECURITY.md` describes — GitHub private vulnerability reporting, or `security@fundroom.com` — not in a public issue. Include the version (below).

## Preserve evidence

Do these in order; each is read-only on the install.

**1. What is running.**

```
docker compose ps > incident-ps.txt
docker compose images > incident-images.txt
curl -s https://<your host>/.well-known/fundroom.json > incident-version.json
```

The last one records `serverVersion`, the version a vulnerability report needs.

**2. The process logs**, before any container is recreated (`docker compose up -d` after a config change recreates it, and its logs go with it):

```
docker compose logs --no-color --timestamps > incident-logs.txt
```

These are operational logs: JSON lines, redacted of emails, tokens and cookies by design, and kept only as long as the container. They say what the process did; they are not the evidence of who did what. That is the audit log.

**3. The audit chains: verify, then checkpoint.** Every workspace has a hash-chained audit log in Postgres, and the platform has its own chain for operator actions.

```
docker compose run --rm -T app audit verify > incident-audit-verify.txt 2>&1; echo "exit $?"
docker compose run --rm -T app audit checkpoint > incident-audit-checkpoint.txt 2>&1
```

`verify` walks every live workspace's chain and the platform chain, recomputes every hash and checks each signed checkpoint; `OK` per workspace and `audit: all chains verified` at the end, exit 0. A `FAIL` line names the sequence number where the chain breaks — that is a SEV1 in itself: someone with database-owner access has edited or deleted audit rows. `checkpoint` then signs the current head of every chain that moved since the last checkpoint (it prints `written`, `unchanged` or `empty` per workspace), so anything altered **after** this moment is detectable later even by someone who re-computes the chain. Copy both files off the host.

**3a. Anchor them, if anchoring is configured** ([audit-anchoring.md](audit-anchoring.md)):

```
docker compose run --rm -T app audit anchor > incident-audit-anchor.txt 2>&1
```

This sends the root of the checkpoints you just wrote to the configured TSA and/or Rekor log, so the state of every chain at the moment you took charge is fixed *outside* the install, against the operator too. Read the anchors summary in `incident-audit-verify.txt` as well:

- `failed` with `anchor_path_invalid`, `anchor_receipt_failed` or `anchor_inconsistent` means a stored anchor row or receipt no longer matches its checkpoint, or a checkpoint claims a head later than its own time-stamp: someone with database-owner access changed audit rows. Treat it like a chain `FAIL` (SEV1), and keep the external receipts (download the proofs, **Audit log → External anchors → Proof**) as evidence of what the chain said before. A checkpoint shown **Failed** on that card, or `SKIPPED` by `audit anchor`, needs the same look.
- `missing` means checkpoints older than 8 days have no receipt: anchoring has been failing. Not an incident on its own, but find out since when, because those days are covered only by the key ring. `late` and `present in log without trusted time` are not incidents either: a late anchor proves existence only from its own time on, and a Rekor-only anchor proves presence, not time (only an RFC 3161 time-stamp gives time).
- If the master key ring itself may be compromised, the RFC 3161 time-stamps are what still proves the history up to the last anchored checkpoint: an attacker with the key can re-sign checkpoints, but cannot obtain time-stamps dated in the past.

**4. A signed audit export for each affected workspace.** This is the evidence that survives the install: a zip whose manifest is signed with Ed25519 and which anyone can verify offline. A workspace owner or legal member makes it in **Audit log → Export** (`POST /api/v1/audit/exports`, fresh sign-in, a time range, at most 50 000 rows per export — split long ranges). Ask the owner to make it and send it to you, or to counsel directly. Record the export public key at the same time — **Audit log** shows it, as does `GET /api/v1/audit/export-key` — because a key rotation later in this incident takes the old key out of the install's hands. Anyone can then check the bundle without the install:

```
docker run --rm -v "$PWD:/in:ro" ghcr.io/fundroomhq/fundroom:<version> audit verify-export /in/audit-export.zip --public-key <base64 public key>
```

Exit 0 verified and pinned; 1 failed; 3 intact but **UNVERIFIED ORIGIN** (no key given). There is no CLI to *make* an audit export; the operator's equivalent is a workspace export, which carries the audit chain with everything else ([tenant-export-and-deletion.md](tenant-export-and-deletion.md)) and is far more sensitive.

**5. A database snapshot, if the incident may involve the database itself** — tampering, a compromised host, a destructive attacker:

```
docker compose exec -T db pg_dump -U seedhost -Fc seedhost > incident-$(date -u +%Y%m%dT%H%MZ).dump
```

The dump holds every row on the install — investors' contact details, the audit logs, analytics, the wrapped workspace keys — but not the documents, which live in object storage (the `/data` volume or the bucket); snapshot that too if it may have been touched. Store it encrypted, with the fewest possible copies, and delete it when the incident closes.

## Contain

Pick what fits; each is reversible except where it says so.

- **Stop all traffic, keep the install:** `docker compose stop caddy`. The app, database and CLI keep running for you; nobody outside can reach anything, custom domains included. `docker compose start caddy` undoes it.
- **Sign people out.**
  - One person everywhere: they use "sign out everywhere"; an admin can revoke their sessions under **People →** the person **→ Sessions**.
  - A whole workspace: **Settings → Danger zone → Sign everyone out** — owner, fresh sign-in, slug typed back; tick staff too if staff accounts may be affected.
  - The whole instance: SQL, effective on the next request — see "What signs people out" in [rotate-keys.md](rotate-keys.md). It writes no audit row; the timeline is its record.
- **Remove access**, not just sessions. A revoked session can sign in again. Revoke the membership (**People →** the person **→ Revoke**) of an account that is not its owner's, and have the real owner re-enrol their second factor before restoring it.
- **Undo destructive changes** — mass deletion, a wiped data room, tampered records — with a point-in-time restore to just before the first bad audit event, *after* the evidence above is taken: the restore rewrites the database, audit log included. [backup-and-restore.md](backup-and-restore.md) has the procedure and what comes back to life with it (revoked sessions and memberships among them).
- **Close the side doors.** Revoke share links (**Share links**), remove embed origins that should not frame the portal (**Embed**), and check the data room's grants on anything that was exposed.
- **Rotate what may have leaked**, in [rotate-keys.md](rotate-keys.md): the master key ring if the key, a backup of it or the data volume may have been copied; database, storage and mail credentials if the host or `.env` was exposed; ESP webhook secrets if those were. Read that runbook's section on removing an old key before you remove one — removing it has permanent side effects on audit checkpoint verification and on anything still wrapped under it.
- **Look at a workspace's data past row-level security** only through `fundroom break-glass` ([break-glass.md](break-glass.md)): it needs a ticket reference, lasts at most an hour, emails the workspace's owners and writes every statement to their audit log. Raw `psql` as the database owner leaves none of that record. Also check `fundroom evidence break-glass --since <date>` for sessions nobody told you about.
- **A compromised host** is rebuilt, not cleaned: new host, fresh images by digest, restore data from a backup taken before the compromise ([backup-and-restore.md](backup-and-restore.md) — the database, the file storage *and* the master key), rotate every secret. Do not reuse the old host's `.env`.

## Assess what happened

- **The audit log** is the record of who did what in each workspace: **Audit log** in the admin (owner, admin, legal), filterable by actor, action and time, or `GET /api/v1/audit/events`. Document opens, downloads, grant and group changes, sign-ins and session revocations, exports and "view as investor" sessions are all there, attributed to a membership. IP addresses are stored truncated to a /24 (IPv4) or /48 (IPv6) unless `AUDIT_IP_TRUNCATE=false` — enough to recognise a network, not a household.
- **What a person could see** is answered by the access review (**Access review** in the admin), which shows each member's role, groups, grants and last activity at the moment you open it. It shows the current state; the audit log shows how it got there.
- **Engagement analytics** show which documents and pages a member viewed, if the workspace's privacy mode records them.
- **A leaked document page** (a screenshot or photo of a data-room page posted somewhere): if the document had **Forensic watermark** on when it was viewed, an owner, admin or legal member can test the image against everyone who was served that version (the document's **Forensic tracing → Trace a leak…**), and **Recipients with a marked copy** lists who was served it at all. Read [forensic-watermarking.md](forensic-watermarking.md) "Reading the result" before acting: a `match` identifies the membership the copy was served to (for a copy viewed under "view as investor", the staff member who was viewing, never the investor), not the person who leaked it, and needs corroboration from the audit log. Keep the leaked image and the result in the incident record; the product does not store the image. A leaked download carries a visible `trace` code (look it up in the recipients list) and the token in its PDF metadata: corroboration only, since both are easy to remove or copy; confirm with the `document.downloaded` audit event or an image detection.
- **The platform audit trail** records what operators did with the CLI (`workspace.restored`, `ops.dead_letter_retried`, …); `audit verify` covers it as `platform`.

Write down, per workspace: which data, which people, from when to when, and how you know. That is what the notification decision needs.

## Notify

**Workspace owners, first and fast.** They are the controllers of their investors' data and the ones who must decide about regulators and investors. GDPR Article 33 gives a controller **72 hours from becoming aware** of a personal-data breach to notify its supervisory authority, unless the breach is unlikely to result in a risk to people; a processor must tell the controller **without undue delay** — every hour you hold a finding is an hour off their 72. Tell them what you know, what you do not know yet, and when you will update them. There is no operator broadcast in the product; list the owners and write to them directly:

```
docker compose exec db psql -U seedhost -d seedhost -c "
  SELECT w.slug, ui.identifier AS owner_email
    FROM core.membership m
    JOIN core.workspace w ON w.id = m.workspace_id AND w.deleted_at IS NULL
    JOIN core.user_identity ui ON ui.user_id = m.user_id AND ui.type = 'email'
   WHERE m.role = 'owner' AND m.status = 'active'
   ORDER BY w.slug;"
```

**Investors** are told by the workspace, not by you. Where the risk to them is high, Article 34 requires telling them without undue delay, and US state breach laws have their own triggers and timelines. The workspace's own channel — an investor update, or a direct email from the company — is how it reaches them; offer the owner the facts they need to write it.

**Regulators** are notified by the controller. If you are the controller (single-tenant, your own company), that is you: have the timeline, the affected data categories, the approximate number of people and the containment steps ready.

**The FundRoom maintainers**, if the cause is a flaw in FundRoom: privately, per [`SECURITY.md`](../../SECURITY.md).

## Close

- Keep the evidence files for as long as counsel says, encrypted, then delete them — they are a second copy of the incident.
- Re-run `audit verify` at the end and keep the output next to the first one.
- Remove the old master key from the ring only if you decided to, after reading [rotate-keys.md](rotate-keys.md).
- Write the post-mortem: timeline, cause, what detected it, what would have detected it sooner, what changes. Detection is where installs are weakest: nothing in the product alerts on failed-login spikes, CSP violation spikes or scanner hits by itself — `document.scan_infected` and `csp.report` are in the audit log and the process log respectively, and only monitoring you build will page anyone about them.

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `AUDIT_IP_TRUNCATE` | app | `true` — IPs stored as /24 or /48 |
| `AUDIT_RETENTION_MONTHS` | app | `84` |
| `FUNDROOM_SECRET_KEY` / `SECRET_KEY_RING` | app | the ring that signs checkpoints and export bundles, and seeds forensic marks |
| `AUDIT_ANCHOR_DRIVERS` | app | empty (no external anchoring); see [audit-anchoring.md](audit-anchoring.md) |
| `LOG_LEVEL` | app | `info` |
| `ERROR_REPORTING_DSN` | app | unset (no error reporting) |
