# Runbook: rotate secrets and keys

This runbook is for whoever operates the install. It covers the master key ring (`FUNDROOM_SECRET_KEY` / `SECRET_KEY_RING`) and everything derived from it, then the secrets that stand alone: the metrics token, the ESP webhook secrets, the OIDC client secret, the database password and the storage and mail credentials. For each one it says what rotating it touches and what it does *not* touch — which, for the master key, is most of what people expect it to.

## What has to be true first

- **You know where the current master key lives.** One of three places:
  - `FUNDROOM_SECRET_KEY` (or `FUNDROOM_SECRET_KEY_FILE`) in the environment — the ring then has one entry, with id `v1`;
  - `SECRET_KEY_RING` (or `SECRET_KEY_RING_FILE`) — you have rotated before;
  - neither, and the first `serve` **generated** one into `/data/secret.key` on the data volume (the log said so in a block of `!!` lines). This is the reference Compose default. The key in that file is also id `v1`.
- **You have a copy of the current key outside the install.** A rotation that loses the old key before every piece of data has moved off it is data loss, and there is no recovery from it: the documents are encrypted under keys that only the old ring entry can unwrap.
- **You can run the CLI.** Throughout this runbook it is `docker compose run --rm app <command>`: the image's entrypoint *is* the CLI, and the image is distroless, so there is no shell to `exec` into. Every command finds a key generated into `/data/secret.key` on its own; only `serve`, `migrate`, `setup-token` and `seed-demo` ever create one.
- **You can reach Postgres** for the checks, as the database owner: `docker compose exec db psql -U seedhost -d seedhost`. The owner role bypasses row security, which these checks need.

## Read the current ring

```
docker compose run --rm app doctor 2>&1 | grep keyRing
```

(The CLI writes to stderr, hence `2>&1`.) The row reads `v1 (sha256:167100b12087)` — ids and fingerprints, newest first, never the key itself. The fingerprint is the first 12 hex characters of the SHA-256 of the key bytes, so you can check which key a machine holds without printing it anywhere. Write the fingerprints down before you start; you will compare against them at the end.

To print a generated key so you can store it (it goes to your terminal and nowhere else):

```
docker compose exec app /nodejs/bin/node -e "process.stdout.write(require('fs').readFileSync('/data/secret.key','utf8'))"
```

## What the master key ring actually protects

Every use of the ring derives its own sub-key (HKDF-SHA256 with a fixed purpose label), so one ring rotation rotates all of them at once. They do not all behave the same way afterwards, and that is the whole of this runbook's master-key section:

| What | How it uses the ring | After you put `v2` first |
|---|---|---|
| **Workspace data keys** (documents, renditions, exports, evidence, integration secrets, chart tokens, the mail suppression list) | Each workspace's data keys are *wrapped* under the ring (`kms-local`). The documents themselves are encrypted under the data keys, not under the ring. | New data keys wrap under `v2` at once. Existing ones are **re-wrapped** — not re-encrypted — by the `crypto.rewrap` job, **daily at 03:20 UTC**, for live workspaces only. No stored object is rewritten, ever; that is why a rotation is cheap. |
| **TOTP seeds** | Sealed with the ring; the ciphertext names the entry. | Re-sealed under `v2` the next time that person completes a TOTP sign-in. Someone who never signs in with TOTP stays on `v1` indefinitely. |
| **Recovery codes, email sign-in codes, share-link passcodes** | Stored as an HMAC under the entry that was current when they were set. | Verified against *every* entry in the ring, so they keep working. Nothing re-hashes them. |
| **Audit checkpoints** | HMAC-signed, entry id recorded. | Old checkpoints stay signed by `v1`; new ones by `v2`. `fundroom audit verify` checks each against the entry it names. Checkpoints are never re-signed. |
| **Signed audit export bundles and workspace export files** | Ed25519 key derived from the current entry; the public key goes in the manifest and on `GET /api/v1/audit/export-key` / `GET /api/v1/portability/export-key`. | New exports are signed by the `v2` key. Bundles already handed out stay verifiable **with the public key recorded when they were made**. |
| **Forensic watermarks** ([forensic-watermarking.md](forensic-watermarking.md)) | Each mark's pattern is seeded from a key derived (HKDF, `seed-host/forensic/pattern/v1`) from the entry current when the mark was issued; the `dataroom.forensic_mark` row records the entry id. | New marks (a viewer's first view of a version) use `v2`. Existing marks keep their entry and stay detectable while `v1` is in the ring. Nothing is re-issued. |
| **Audit anchor signing key** ([audit-anchoring.md](audit-anchoring.md)) | ECDSA P-256 key derived (`seed-host/audit/anchor-ecdsa-p256/v1`) from the current entry; signs the daily Merkle root sent to Rekor. | New Rekor entries carry the `v2` public key. Verification uses the key inside each entry, so old entries keep verifying with no ring at all. TSA time-stamps involve no key of ours. |
| **Custom-domain TXT challenge tokens** | HMAC under a sub-key of the current entry. | Only domains added *after* the rotation get a token from `v2`. Existing rows store their token and keep verifying; no customer has to touch their DNS. |
| **Sessions** | Not at all. | Nothing. See "What signs people out" below. |

Two things people expect and that do not happen:

- **Rotating the ring does not sign anyone out.** Sessions are opaque random tokens stored as SHA-256 hashes. No key is involved in checking one.
- **`SESSION_SECRET` does nothing today.** The schema accepts it (32 characters or more), `doctor` redacts it, and no code reads it — the planned signed-session design was replaced by server-side sessions before it shipped. Setting or changing it has no effect.

## Rotate the master key ring

1. **Generate the new key.**

   ```
   openssl rand -base64 32
   ```

   Any id matching `[A-Za-z0-9][A-Za-z0-9_-]{0,31}` works; the convention is `v2`, `v3`, …, and ids must be unique. Keys must decode (base64, base64url or hex) to at least 32 bytes.

2. **Build the ring: new key first, every old key after it.** The first entry is the one used for all new encryption and signing; the rest are decrypt- and verify-only.

   ```
   SECRET_KEY_RING=v2:<new key>,v1:<old key>
   ```

   **Remove `FUNDROOM_SECRET_KEY`** (and `FUNDROOM_SECRET_KEY_FILE`, and the pre-rename `SEEDHOST_SECRET_KEY` / `SEEDHOST_SECRET_KEY_FILE` if still set) in the same edit. Setting both is refused at boot (`SECRET_KEY_RING: set together with FUNDROOM_SECRET_KEY`; the message names the variable you actually set). If the old key was the generated `/data/secret.key`, leave the file where it is for now: once `SECRET_KEY_RING` is set the file is ignored, and it is your fallback until step 5.

   Where you can, prefer `SECRET_KEY_RING_FILE` pointing at a mounted secret over putting the ring in `.env`: the value now contains two keys, and every copy of `.env` is a copy of both. The reference `compose.yaml` passes `SECRET_KEY_RING` through from `.env` but no `*_FILE` variables, so on Compose the file form needs a `compose.override.yaml` that mounts the secret and sets the variable on `migrate`, `app` and (if you run it) `worker`.

3. **Roll it out.**

   - **One process (the reference Compose stack with the embedded worker):** `docker compose up -d`. Compose recreates `migrate` and `app` with the new environment.
   - **More than one process (a separate worker, several replicas, Helm, a PaaS with a worker service): do it in two deploys.** First deploy `SECRET_KEY_RING=v1:<old key>,v2:<new key>` everywhere — `v1` still current, `v2` known. When every process runs that, deploy `v2:<new key>,v1:<old key>`. The reason is the window in between: a process that has `v2` current wraps a new workspace's data key under `v2`, and a process that has never heard of `v2` then fails every read of it with `no key "v2" in the ring` until it is restarted. Order-swapping the same two keys is safe in both directions; introducing a key and making it current in one step is not.

4. **Confirm the ring on every process.** `doctor` (as above) must show `v2 (sha256:…), v1 (sha256:…)`, with the `v1` fingerprint you wrote down. Then load the portal, open a document in the data room, and sign in once with TOTP if you use it — three different uses of the ring, each of which fails loudly if the ring is wrong.

5. **Wait for the re-wrap and check it.** The next 03:20 UTC run of `crypto.rewrap` moves every live workspace's data keys to `v2`. There is no command to trigger it early; it is a no-op when nothing is stale, so it is safe to leave on its daily schedule. The following morning:

   ```
   docker compose exec db psql -U seedhost -d seedhost -c "
     SELECT k.kms_key_ref, w.deleted_at IS NOT NULL AS workspace_deleted, count(*)
       FROM core.workspace_key k JOIN core.workspace w ON w.id = k.workspace_id
      GROUP BY 1, 2 ORDER BY 1, 2;"
   ```

   Expect `local:v2` for every live workspace and `shredded` for purged ones. **Rows on `local:v1` with `workspace_deleted = t` are expected and are not rewrapped**: the job walks live workspaces only, so a workspace inside its 30-day restore window keeps its keys wrapped under the key that was current when it was deleted. It picks up `v2` on the first run after a restore, or is shredded by the purge.

6. **Keep `v1` in the ring.** Retired entries cost nothing to carry and are what keep the rest of the table above working. The next rotation is `v3:<new>,v2:<…>,v1:<…>`.

### Removing an old key from the ring

Do this only when you have a reason — the old key leaked, or policy demands it — and only after reading what it breaks. Removing an entry is permanent for anything that still depends on it:

| Still on the removed key | What happens |
|---|---|
| Data keys of a workspace that was soft-deleted before the rotation (step 5's `local:v1` rows) | A restore succeeds and the workspace's documents are unreadable. Wait until every such workspace is purged or restored-and-rewrapped. |
| TOTP seeds of people who have not completed a TOTP sign-in since the rotation | Their authenticator stops working (`no key "v1" in the ring`). Plan how they will sign in — a passkey, or an email code where the workspace allows it — before you remove the key. |
| Recovery codes issued before the rotation | Stop verifying. Ask people to regenerate them first (`POST /api/v1/auth/totp/recovery-codes`, which invalidates the old set). |
| Share-link passcodes set before the rotation | Stop verifying. Reset the passcode on those links. |
| Audit checkpoints signed before the rotation | **`fundroom audit verify` reports every one of them as `signature does not verify (key v1)` and exits 1, for good.** The hash chain itself still verifies; only the checkpoint signatures cannot. If the key leaked, those signatures were never worth more than the key anyway — say so in the incident record — but expect the admin audit page's verify button to go red and stay red for those workspaces. |
| Forensic marks issued before the rotation | **Copies made under them cannot be traced any more, for good.** Tracing a leaked page skips those marks and reports how many in `keysMissing` (`409 forensic_no_marks` when none is left). Each such mark is re-issued with a new token under the current key the next time its viewer is served, so only new copies are traceable. Keep the entry for as long as leaks of documents viewed before the rotation may need tracing. |
| External anchors (Rekor entries, TSA timestamps) | Nothing: they verify with public material. They keep proving that the checkpoints' hashes existed at the anchored time, even once the checkpoints' own HMAC signatures (row above) no longer verify. |
| Signed export bundles made before the rotation | `audit verify-export` / `workspace verify-export` against this install's ring say *NOT trusted*. Verify them with `--public-key <the key recorded at export time>` instead; import one with the same flag. |

If you are removing a key because it leaked, the leaked key can still decrypt every backup, WAL segment and old volume snapshot taken while it was current — rotation protects what is written from now on, not what was already copied. That is a backup-retention decision, and it belongs in the incident record.

## What signs people out

Rotating keys does not. These do, and they are the tools to reach for when sessions themselves are the problem:

- **One person, everywhere:** the person's own "sign out everywhere" (`POST /api/v1/auth/logout-everywhere`), which also bumps their session version so nothing minted before it survives.
- **One person, from one workspace, as an admin:** **People →** the person **→ Sessions → Revoke** (`POST /api/v1/access/people/{id}/sessions/revoke`, and per session `…/sessions/{sessionId}`).
- **Everyone in a workspace:** **Settings → Danger zone → Sign everyone out** (`POST /api/v1/access/sessions/revoke-all`) — owner, fresh sign-in, the slug typed back; staff only if `includeStaff` is ticked. The caller's own session survives.
- **Everyone on the instance:** there is no command. Revoke in SQL; sessions are checked against the database on every request, so it takes effect on the next request:

  ```
  docker compose exec db psql -U seedhost -d seedhost -c "
    UPDATE core.session SET revoked_at = now(), revoked_reason = 'operator_incident'
     WHERE revoked_at IS NULL;"
  ```

  This writes no audit row — record what you did and when in the incident record yourself.

Sessions are global sign-ins, not per workspace: revoking a session that last served workspace A also signs its holder out of workspace B. The admin screens say so; it surprises people anyway.

## Rotate the standalone secrets

None of these touch stored data. Each is: change it at the other end, change it here, restart, check.

1. **`METRICS_TOKEN`** (16+ characters). Generate (`openssl rand -hex 24`), set it, `docker compose up -d`, then update the scraper's bearer token. Between the two the scraper gets 401 and your dashboards show a gap; nothing else is affected. Check with:

   ```
   curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $METRICS_TOKEN" https://<your host>/metrics
   ```

   Unset, `/metrics` is public. The app answers `/metrics` on every host it serves, custom domains included (the investor KPIs page is `/kpis`, so nothing else lives there); the shipped Caddy edge refuses it from outside unless `EDGE_EXPOSE_METRICS=true`.

2. **ESP webhook secrets** — `RESEND_WEBHOOK_SECRET` (`whsec_…`), `POSTMARK_WEBHOOK_USER` + `POSTMARK_WEBHOOK_PASSWORD` (set both or neither; the password is 16–200 characters), or for SES the topic allow-list `SES_SNS_TOPIC_ARNS`. The app holds exactly one value per provider — there is no overlap window — so from the moment you change one side until you change the other, `POST /webhooks/email/<driver>` answers **401** to the provider. Every provider retries on non-2xx, so do both changes within minutes and nothing is lost; do them a day apart and bounce and complaint events expire in the provider's retry queue, which means addresses that should be suppressed are not. Order: generate or reveal the new secret in the provider's console, set it here, `docker compose up -d`, then save it in the console. The admin mail screen shows the webhook URL to paste.

3. **ESP API keys** — `RESEND_API_KEY`, `POSTMARK_SERVER_TOKEN`, `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN` for temporary credentials). Create the new key at the provider, set it, restart, send a test (an OTP sign-in is enough), then revoke the old key. Mail that failed in between is retried by its job and dead-letters after its retries run out — see [queue-backlog.md](queue-backlog.md).

4. **`SMTP_URL`** credentials: the same shape. The `mail` readiness check (`/readyz`) tells you within a minute whether the new URL connects.

5. **`OIDC_CLIENT_SECRET`**: add a second secret at the IdP if it allows two (most do), set the new one here, restart, sign in once with OIDC, then delete the old one at the IdP. Sign-ins that were mid-flight at the restart fail and simply start again.

6. **`S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY`**: create the new key pair with the same bucket policy, set, restart, check the `storage` readiness check, then revoke the old pair. Objects are encrypted by the app before they reach the bucket, so a leaked S3 key exposes ciphertext — rotate anyway.

7. **The database password.** In the reference Compose stack `POSTGRES_PASSWORD` is read by Postgres only when the data directory is first created, so changing it in `.env` alone changes what the app *sends*, not what the database *accepts*, and the stack stops. Change the role first, then `.env`, then restart:

   ```
   docker compose exec db psql -U seedhost -d seedhost -c "ALTER ROLE seedhost PASSWORD '<new password>';"
   ```

   Then set `POSTGRES_PASSWORD=<new password>` in `.env` and `docker compose up -d`. Elsewhere, `DATABASE_URL` is the one value to change.

8. **`SETUP_TOKEN`** is ignored once setup is complete. Remove it from the environment after the first workspace exists; there is nothing to rotate.

9. **`AUTHZ_OPENFGA_API_TOKEN`** (only with `AUTHZ_ENGINE=openfga`; required in `prod`/`staging`): OpenFGA accepts a list of preshared keys, so there is an overlap window. Add the new key to `OPENFGA_AUTHN_PRESHARED_KEYS` and restart OpenFGA, set the new value here and restart, then remove the old key from OpenFGA. A refused key shows as `unauthorized` in `fundroom_authz_engine_errors_total`, and in enforce mode denies every external viewer until fixed — see [openfga.md](openfga.md).

10. **Audit anchor pins** (`AUDIT_ANCHOR_TSA_CERTS_FILE`, `AUDIT_ANCHOR_REKOR_LOG_KEY_FILE`, `AUDIT_ANCHOR_REKOR_ORIGIN`) are public certificates, keys and log names, not secrets, but they change when a TSA re-issues its certificate or Sigstore starts a new Rekor shard. Add the new pin from an independent source before the old one stops being used (new Rekor key and origin first, old ones after), and keep every old pin, with the driver off if need be, for verifying old receipts — see [audit-anchoring.md](audit-anchoring.md) "Pin the TSA certificates" and "Rekor shard rotation".

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `FUNDROOM_SECRET_KEY` | app | unset; `serve`/`migrate` generate `/data/secret.key` when no key is configured and `DATA_DIR` is writable |
| `SECRET_KEY_RING` | app | unset; `id:key,id:key`, newest (current) first; exactly one of this or `FUNDROOM_SECRET_KEY` |
| `SESSION_SECRET` | app | unset; accepted and **unused** |
| `KMS_DRIVER` | app | `local` (the only driver: data keys are wrapped under the ring) |
| `DATA_DIR` | app | `/data` |
| `METRICS_ENABLED` / `METRICS_TOKEN` | app | `true` / unset (public) |
| `RESEND_WEBHOOK_SECRET`, `POSTMARK_WEBHOOK_USER`, `POSTMARK_WEBHOOK_PASSWORD`, `SES_SNS_TOPIC_ARNS` | app | unset (the webhook answers 404) |
| `RESEND_API_KEY`, `POSTMARK_SERVER_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | app | unset |
| `SMTP_URL` | app | unset (required outside dev with `MAILER_DRIVER=smtp`) |
| `OIDC_CLIENT_SECRET` | app | unset |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | app | unset |
| `DATABASE_URL` / `POSTGRES_PASSWORD` | app / `db` | Compose builds the URL from `POSTGRES_PASSWORD` |
| `AUTHZ_OPENFGA_API_TOKEN` | app | unset; the OpenFGA preshared key, only with `AUTHZ_ENGINE=openfga` |
| `AUDIT_ANCHOR_TSA_CERTS` / `AUDIT_ANCHOR_REKOR_LOG_KEY` / `AUDIT_ANCHOR_REKOR_ORIGIN` | app | unset; pinned anchor trust (PEM, usually as `_FILE`; Rekor origins as csv) |

Every key also accepts `<KEY>_FILE` pointing at a mounted secret; setting both `KEY` and `KEY_FILE` is refused.
