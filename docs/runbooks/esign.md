# Runbook: e-signature

When a workspace sends documents for signature (the e-sign NDA ceremony, round closing), FundRoom creates envelopes at the workspace's vendor — Documenso, DocuSeal, DocuSign or Dropbox Sign — follows their status, and collects the signed copies. This runbook is for whoever operates the install and for workspace admins: envelopes that do not move, callbacks that are refused, a vendor outage, a signed copy that was not collected, and rotating the callback secret. How the feature works and how to set up each vendor is in the [e-signature guide](../esign/README.md).

Reference material: `packages/esign/src/service.ts` (the pipeline and its jobs), `apps/server/src/routes/esign-callback.ts` (the callback route) and each adapter's README under `packages/adapters/esign-*`.

## What has to be true first

- **A worker is running.** Sending an envelope is a request, but everything after it — status pulls, collection, vaulting, voids after erasure — runs as jobs. With no worker, envelopes stay `sent` forever even when callbacks arrive. See [queue-backlog.md](queue-backlog.md) question 1.
- **You know who can act.** The envelope register, **Resync**, **Void**, **Verify** and the connection settings are in the workspace's admin (**Settings → E-signature**), for its owners and admins. The operator sees the queues, the logs and the metrics, not the envelopes: `core.esign_envelope` and `core.esign_connection` are behind forced row-level security, and reading them directly is a [break-glass](break-glass.md) session with a ticket. Everything below works without one.
- **The CLI and Postgres** as in [queue-backlog.md](queue-backlog.md): `docker compose run --rm app <command>` and `docker compose exec db psql -U seedhost -d seedhost`.

## The moving parts

| Job | What it does | Retries | Scheduled by |
|---|---|---|---|
| `esign.sync-due` | cron, every 5 minutes: queues a status pull for every envelope that is due, re-queues collection of completed envelopes without a copy (every 15 minutes), voids open envelopes of erased signers, and marks drafts older than 15 minutes `orphaned_draft` | none (the next run) | cron `*/5 * * * *` |
| `esign.sync` | one status pull from the vendor, applied to the envelope | 3 | the sweep, a callback, **Resync** |
| `esign.collect` | download, check, scan, encrypt and store the signed copy; records the NDA acceptance; publishes `esign.envelope_completed` | 6 | a pull that saw `completed`, the sweep, **Resync** |
| `esign.void` | void at the vendor (after erasure) | 8 | the sweep |
| `data-room.vault` | file the signed copy in the data room | module default | `event.esign.envelope_completed` |

Every one of them is idempotent and keyed by envelope (`esign.sync:<envelopeId>` …), and the sweep re-queues sync and collection on its own: **a dead-lettered e-sign job heals by itself** once its cause is fixed. Retrying it with `jobs dlq retry` only makes that happen sooner; discarding it loses nothing.

Log lines (component `esign`, one JSON object per line, `"event"` is the name):

| Event | Meaning |
|---|---|
| `esign.sync_failed` | a status pull failed; `code` is the vendor error class (`unauthorized`, `not_found`, `rejected`, `rate_limited`, `unavailable`, `invalid_response`) |
| `esign.swept` | the sweep claimed `claimed` envelopes (only logged when > 0) |
| `esign.sweep_failed` | the sweep failed for one workspace (`error`); the others continue |
| `esign.artifact_infected` | the virus scanner flagged a signed copy (`which`, `engine`) |
| `security.esign_callback_rejected` | the first refused (401) callback of the minute |
| `esign.callback_summary` | per minute: `rejected` callbacks after the first, `throttled` (over a connection's or the global budget; answered 200, nothing queued) and `shed` (past the pre-auth ceiling) |
| `esign.callback_ingest_failed` | a callback could not be processed (500; the vendor retries) |

Metric: `fundroom_security_events_total{event="esign_callback_rejected"}` and `{event="esign_artifact_infected"}` on `/metrics`.

## Envelopes stuck in `sent` or `delivered`

First, the usual answer: **nobody has signed yet.** The envelope's detail dialog shows the signer's status (`pending`, `viewed`, `signed`). Status sync keeps following an unsigned envelope — 5 minutes after the last change, then 15 minutes, 1 hour, 6 hours, and daily — and marks it `expired` after 60 days. The vendor's own reminders are the vendor's settings.

If the signer did sign (the vendor's dashboard says completed) and FundRoom still shows `sent`:

1. **Resync** the envelope (admin, **Settings → E-signature** → envelope → **Resync**, or `POST /api/v1/esign/envelopes/{id}/sync`; 10 per minute per workspace). It queues a pull now. Wait a minute and reopen it.
2. **Is the sweep running?** On the operator side:

   ```
   docker compose exec db psql -U seedhost -d seedhost -c "
     SELECT name, state, count(*), max(created_on) AS newest
       FROM pgboss.job
      WHERE name LIKE 'esign.%'
      GROUP BY 1, 2 ORDER BY 1, 2;"
   ```

   `esign.sync-due` rows should appear every 5 minutes. None recent means no worker is working (see [queue-backlog.md](queue-backlog.md)); many `esign.sync` in `retry` means pulls are failing.
3. **Are pulls failing?**

   ```
   docker compose logs --since 1h app 2>&1 | grep '"event":"esign.sync_failed"' | tail -n 20
   ```

   `unauthorized`: the workspace's credentials no longer work (a revoked token, DocuSign consent withdrawn) — the envelope turns `error` and the connection needs **Verify** and new credentials; the next pull recovers it. `unavailable` / `rate_limited`: the vendor is down or throttling — see [Vendor outage](#vendor-outage). `invalid_response`: the vendor answered with something unexpected (a redirect, HTML); for a self-hosted vendor, check its base URL and proxy. The same class shows on the envelope as `errorCode`.
4. **Nothing failing, nothing moving**: tell the admin to compare the envelope's vendor reference with the vendor dashboard (the vendor also carries the FundRoom envelope id as its external id / metadata). A vendor document deleted by hand answers `not_found`; two of those in a row mark the envelope `voided`.

## Callbacks refused (401)

Refused callbacks cost latency, never data: status sync converges anyway. Look at the rate:

```
docker compose logs --since 1h app 2>&1 | grep -E '"event":"(security.esign_callback_rejected|esign.callback_summary)"' | tail -n 20
```

- **A steady trickle from one vendor after a change**: the secret no longer matches. Documenso/DocuSeal — someone rotated the callback secret in FundRoom (the old one stops at once) or the vendor still has the old value; DocuSeal — the header must be named `X-Fundroom-Signature` (or the pre-rename `X-Seedhost-Signature`; if the webhook sends both, both must carry the current secret). DocuSign — the Connect HMAC key here is not an active Connect key. Dropbox Sign — the API key here is not the one the account signs callbacks with. Fix it in the vendor or re-enter it in FundRoom; the vendor's webhook log confirms with a 200.
- **After a vendor switch**: the new connection has a new callback URL; the vendor is still posting to the old one (answered 401). Update the URL in the vendor.
- **Self-hosted Documenso**: its callbacks carry a per-delivery timestamp and are refused more than 5 minutes off; fix the host's clock (NTP).
- **Bursts from many addresses with no matching vendor change**: someone is probing the callback URL. Nothing is needed — forged callbacks are refused before any work, and an authentic replay only causes a status pull. Budgets count only authenticated callbacks (120 per minute per connection, 6,000 per process), and an over-budget callback is answered 200 without queueing work, so a flood of forgeries cannot starve another tenant or make Dropbox Sign drop the callback URL; the 5-minute status sync picks up anything shed.

**Dropbox Sign clears its account callback URL after 10 consecutive failures.** After a long 401 or outage spell, ask the admin to check **Settings → API → Account callback** in Dropbox Sign and set it again.

## Vendor outage

While the vendor is down or rate-limiting:

- **New sends fail** with `502 esign_provider_error` (`providerCode` `unavailable` or `rate_limited`). The envelope is recorded as `error` and, for round closing, the request is released: send again when the vendor is back. NDA starts fail the same way; the investor retries from the portal.
- **Status pulls back off** without changing the envelope (`esign.sync_failed` with `unavailable`), and **collection retries** (6 times, then every 15 minutes through the sweep). Nothing is lost.
- **Callbacks** are the vendor's to retry once it is back; they are not needed for correctness.
- **Credentials** show `unreachable` on **Verify** until the vendor answers.

When it is back, nothing needs doing: the sweep catches up within its schedule. To hurry a specific envelope, **Resync** it. For a self-hosted vendor that "is down" only for FundRoom, check the outbound path: https, the certificate, `ESIGN_ALLOW_PRIVATE_HOSTS` for a private address, and that the vendor does not answer with a redirect (never followed).

## A signed copy was not collected

The envelope is `completed` but has no signed copy, and shows an `errorCode`:

| `errorCode` | Cause | Fix |
|---|---|---|
| `artifact_too_large` | signed PDF + certificate exceed `ESIGN_MAX_ARTIFACT_BYTES` (default 25 MiB) | operator raises it (at most 100 MiB) in `.env`, `docker compose up -d`; then **Resync** |
| `artifact_not_pdf` | the vendor's download is not a PDF (an error page, a redirect target) | fix the vendor side (DocuSeal: file URLs must not redirect; Documenso: S3 upload transport); **Resync** |
| `artifact_unauthorized`, `artifact_not_found`, `artifact_rejected`, `artifact_invalid_response` | the vendor refused the download | fix credentials or the vendor's state; **Resync** |
| `artifact_infected` | the virus scanner flagged the file | **final**: **Resync** does not clear it. Treat it as a security event ([incident-response.md](incident-response.md)); get a clean copy from the vendor out of band |

**Resync** on a completed envelope without a copy clears the error (except `artifact_infected`) and queues collection again. An NDA acceptance is recorded only once the copy is collected, so an investor waiting at the gate is unblocked by the successful collection.

If there is no `errorCode` and no copy, collection is still retrying: a scanner that is down makes it retry rather than fail ([av-failure.md](av-failure.md)), and the sweep re-queues it every 15 minutes. Check `esign.collect` in the query above and the dead letters:

```
docker compose run --rm app jobs dlq list --workspace <workspace uuid>
```

A copy that was collected but is not in the data room: the data room is disabled for the workspace (vaulting is skipped, the copy stays downloadable in **Settings → E-signature**), or `data-room.vault` / `event.esign.envelope_completed` is in the dead letters — retry it after fixing the cause; vaulting deduplicates on the envelope.

## Orphaned drafts

An envelope that shows `error` with `orphaned_draft` was interrupted between the vendor's answer and FundRoom recording it (a restart at the wrong moment). The vendor may hold a live document that was sent to the signer. The admin finds it in the vendor dashboard by the FundRoom envelope id (external id / metadata), cancels it there, voids the envelope in FundRoom and sends again. For round closing, a request left `pending` for more than 15 minutes is released by the next **Send for signature**.

## Rotating secrets

- **Callback secret (Documenso, DocuSeal)**: **Settings → E-signature → Rotate callback secret** (fresh sign-in). The new secret is shown once and the old one stops working **immediately**, so paste it into the vendor straight away (Documenso: the webhook's Secret; DocuSeal: the `X-Fundroom-Signature` header value). Callbacks refused in between are harmless; for DocuSeal and Documenso the vendor's retries then succeed.
- **DocuSign Connect HMAC key**: no downtime — add the new key in DocuSign, put it in *Connect HMAC key (secondary)*, save, promote it to the main field, clear the secondary, save, delete the old key in DocuSign ([docusign.md](../esign/docusign.md#rotating-the-connect-hmac-key)).
- **Vendor API credentials** (token, API key, RSA key): create the new one at the vendor, enter it in **Settings → E-signature** (other secret fields left blank keep their stored values; the connection id and callback URL stay the same), save — it is verified live before it is stored — then revoke the old one at the vendor. For Dropbox Sign the API key also signs callbacks: do both within minutes.
- **The master key ring**: e-sign credentials and signed copies are encrypted under workspace data keys like everything else; see [rotate-keys.md](rotate-keys.md).

## Erasure and open envelopes

When a member's data is erased, their open envelopes are voided at the vendor by the next sweep (within about 5 minutes, audited `esign.envelope_voided` with reason `erasure`). If the void fails (vendor down), `esign.void` retries and the sweep re-queues it; `jobs dlq list` shows persistent failures. The vendor's own copy of the signer's data is outside FundRoom: the admin handles the erasure request at the vendor too ([e-signature guide](../esign/README.md#records-retention-and-erasure)).

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `ESIGN_DRIVERS` | app | `documenso,docuseal,docusign,dropbox-sign` |
| `ESIGN_ALLOW_PRIVATE_HOSTS` | app, worker | empty; prod/staging refuse loopback, unspecified and wildcard entries |
| `ESIGN_MAX_ARTIFACT_BYTES` | worker | `26214400` (25 MiB), 1 MiB–100 MiB |
| `BASE_URL` | app | the callback URL is `<BASE_URL>/webhooks/esign/<connectionId>` — `BASE_URL` as configured, path included (never derived from `BASE_PATH`) |
| `AV_DRIVER` | worker | `noop`; see [av-failure.md](av-failure.md) |
