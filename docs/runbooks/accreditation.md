# Runbook: accreditation vendors

When a workspace connects an accreditation vendor — VerifyInvestor.com or Parallel Markets — FundRoom
starts each 506(c) verification at the vendor, follows it to an outcome, records the decision and keeps
the vendor's certificate. This runbook is for whoever operates the install and for workspace admins:
verifications that stay pending, callbacks that are refused, a connection in error, a start that failed,
re-running the status sync, and reading what happened from the audit log. How the feature works and how
to set up each vendor is in the [accreditation guide](../accreditation/README.md).

Reference material: `packages/accreditation/src/service.ts` (connections and the vendor calls),
`apps/server/src/routes/accreditation-callback.ts` (the callback route), `modules/round/src/jobs.ts` (the
verification jobs) and each adapter's README under `packages/adapters/accred-*`.

## What has to be true first

- **A worker is running.** Starting a vendor verification, every status read, the decision, reminders and
  expiry run as jobs. With no worker, verifications stay `pending` with no vendor reference, even when
  callbacks arrive. See [queue-backlog.md](queue-backlog.md) question 1.
- **You know who can act.** The connection (**Settings → Accreditation**) is for the workspace's owners
  and admins; the verifications, **Check now** and manual decisions (**Round → Verifications**) need
  `round.manage`. The operator sees the queues, the logs and the metrics, not the verifications:
  `core.accreditation_connection` and `round.verification` are behind forced row-level security, and
  reading them directly is a [break-glass](break-glass.md) session with a ticket. Everything below works
  without one.
- **The CLI and Postgres** as in [queue-backlog.md](queue-backlog.md): `docker compose run --rm app <command>`
  and `docker compose exec db psql -U seedhost -d seedhost`.

## The moving parts

| Job | What it does | Retries | Scheduled by |
|---|---|---|---|
| `round.verification_start` | starts the vendor verification once the row is committed (queued in the same transaction); each attempt holds a 10-minute lease; stores the reference and handoff; first status read 5 minutes later | 3 failed attempts (one more at most after two unreachable/timed-out ones; an aborted attempt counts as unreachable), 5 attempts in all, then the row shows vendor status `start_failed` | the interest submission, a renewal, auto-start, the sweep (a start that never ran), **Check now** on a failed start |
| `round.verification_sync` | one status read from the vendor; decides the verification when the vendor has; schedules the next read | 2 (a vendor error is not a job failure: it is recorded on the row and the next read is scheduled) | the sweep, a callback, **Check now** |
| `round.verification_sync_due` | cron, every 15 minutes: claims pending vendor verifications with a reference whose next read is due (at most 25 per workspace per run, leased for 10 minutes) and queues `round.verification_sync`; re-queues starts that never ran (no reference, opened over 15 minutes ago, lease expired) | none (the next run) | cron `*/15 * * * *` |
| `round.verification_lifecycle` | cron, daily 05:10 UTC: re-checks vendor verifications nearing expiry (renew in place), sends the one expiry reminder, expires verified rows past their date, and auto-starts renewals when enabled | none (the next run) | cron `10 5 * * *` |
| `event.accreditation.provider_updated` | turns an authentic callback into `round.verification_sync` for the verifications it names (VerifyInvestor: when none matches, the workspace's verifications still waiting on an invitation, newest 50) | module default | the callback route (outbox) |
| `event.member.erasure_requested` | cuts every verification of the erased member down to its handoff kind and stops polling its pending vendor verifications (`member_erased`) | module default | an erasure (DSAR) |

The status read is keyed by verification, and the sweep re-queues a verification whose read is due:
**a dead-lettered sync heals by itself** once its cause is fixed. The schedule after a start or a change is
5 minutes, 15 minutes, 1 hour, 6 hours, 1 day, then daily; polling stops after 120 days pending.

Log lines (one JSON object per line, `"event"` is the name):

| Event | Meaning |
|---|---|
| `round.verification_sync_queued` | the sweep queued `queued` status reads (only logged when > 0) |
| `round.verification_sync_due_failed` | the sweep failed for one workspace (`error`); the others continue |
| `round.verification_certificate_unavailable` | the vendor said accredited but its certificate could not be fetched, scanned (a scanner that is down or an infected file) or stored; the decision was recorded with the note `vendor:<driver>:<reference>` instead |
| `round.verification_lifecycle_ran` | the nightly lifecycle finished (counts `expired`, `reminded`, `renewed`, `started`) |
| `round.verification_lifecycle_failed` | the lifecycle failed for one workspace |
| `round.verification_recheck_failed` | a pre-expiry vendor re-check failed; the verification keeps its expiry |
| `round.verification_autostart_budget` | auto-start stopped for a workspace at its 50-an-hour vendor budget; the rest start on a later night |
| `round.verification_orphan_certificate` | a certificate stored for a decision that then lost (an admin decided first, or the investor was erased) could not be deleted; `storageKey` names the object — see [Orphan certificates](#orphan-certificates) |
| `accreditation.connection_unauthorized` | a vendor refused the workspace's credentials during normal work; the connection was set to `error` |
| `accreditation.callback` | an authentic callback was accepted |
| `security.accreditation_callback_rejected` | the first refused (401) callback of the minute |
| `accreditation.callback_summary` | per minute: refused callbacks after the first, throttled (over budget; answered 200, nothing queued) and shed (past the pre-auth ceiling) |
| `accreditation.callback_ingest_failed` | a callback could not be processed (500; the vendor retries) |

Metric: `fundroom_security_events_total{event="accreditation_callback_rejected"}` on `/metrics`.

## A verification stays `pending`

First, the usual answer: **the investor has not finished.** The verification's row in **Round →
Verifications** shows the vendor's own status word (**vendor status**) and when it was last read:

| Vendor status | What it means | Who acts |
|---|---|---|
| `invitation_sent`, `waiting_for_investor_acceptance` (VerifyInvestor) | the investor has not accepted the emailed invitation (re-sent on days 3 and 10; it expires after 30 days) | the investor; ask them to look for VerifyInvestor's email |
| `record_created`, `no_accreditation`, `unsubmitted` (Parallel) | the investor has not been through (or not finished) Parallel's flow on the handoff page | the investor; the round page's **Accreditation verification** card has the **Continue with Parallel Markets** link |
| `waiting_for_information_from_investor` (VerifyInvestor), `submitter_pending`, `third_party_pending` (Parallel) | the vendor is waiting for documents from the investor, or for a third party they named (an adviser's letter) | the investor |
| `accepted_by_investor`, `waiting_for_review`, `in_review` (VerifyInvestor), `pending` (Parallel) | the vendor is collecting or its reviewers have it | the vendor; typically days |
| `start_failed` | the vendor start failed for good (the **vendor error** says why) | see [A start failed](#a-start-failed) |
| empty | the start job has not run yet | see step 2 below |

If the vendor's dashboard says the investor is done and FundRoom still shows `pending`:

1. **Check now** on the verification (**Round → Verifications** → the row → **Check now**, or
   `POST /api/v1/round/verifications/{id}/check`, `round.manage`). It answers `202` and queues a status
   read; reopen the row in a minute. A `409` means the row is not a pending vendor verification (a manual
   one, or already decided).
2. **Is the sweep running?** On the operator side:

   ```
   docker compose exec db psql -U seedhost -d seedhost -c "
     SELECT name, state, count(*), max(created_on) AS newest
       FROM pgboss.job
      WHERE name LIKE 'round.verification%'
      GROUP BY 1, 2 ORDER BY 1, 2;"
   ```

   `round.verification_sync_due` rows should appear every 15 minutes. None recent means no worker is
   working (see [queue-backlog.md](queue-backlog.md)); many `round.verification_sync` in `retry` means
   reads are failing.
3. **Are reads failing?** The row's **vendor error** carries the last failure. On the operator side:

   ```
   docker compose logs --since 1h app worker 2>&1 | grep -E '"event":"(round.verification|accreditation\.)' | tail -n 20
   ```

   | Vendor error | Meaning | Polling |
   |---|---|---|
   | `unauthorized` | the workspace's credentials no longer work (or can no longer be unsealed); the connection turns `error` — see [Connection in error](#connection-in-error) | continues on the schedule; recovers once fixed |
   | `rate_limited`, `unavailable` | the vendor is throttling or down (also: an answer too large, not JSON, or a redirect) | continues; catches up on its own |
   | `not_found` | the vendor does not know the reference — usually the connection was moved between sandbox and production | continues until 120 days; decide by hand |
   | `invalid_request`, `conflict` | the vendor refused the request | continues |
   | `renewal_not_recertified` | the vendor answered a renewal with an accreditation it had already certified before the earlier verification ([renewal rule](../accreditation/README.md#how-it-works)); the investor has not been re-certified yet | continues; cleared by the eventual decision. If the investor insists they renewed, compare dates in the vendor's dashboard and decide by hand |
   | `connection_changed` | the workspace switched vendors or disconnected after this verification started | **stopped** — an admin decides it (the investor cannot start another while this one is pending; once it is decided, e.g. rejected with a note, they can, with the current provider) |
   | `polling_stopped` | pending for 120 days | **stopped** — an admin decides it |
   | `member_erased` | the investor's data was erased; late vendor answers are dropped | **stopped** — reject it to clear the queue (`verified` is refused) |
   | `member_inactive` | (start) the member was not active (revoked, suspended) when the start ran; no vendor call was made | **stopped** — reject it, or **Check now** once the member is active again |
   | `imported` | the row came in with a workspace import; its reference belongs to the other install's connection | **stopped for good** — decide by hand; **Check now** answers `409` |
   | `no_email`, `invalid_response`, `start_timeout` | (start) no email address; an unusable vendor answer; 5 attempts without a result | **stopped** — see [A start failed](#a-start-failed) |

**Deciding by hand** is always possible and always wins: **Round → Verifications** → the row → **Record a
decision** (`POST /round/verifications/{id}/decide`). For a vendor verification, method *Third-party
verification service* with a note naming what you relied on (for example the vendor letter the investor
sent you). It stops polling, and a vendor answer that arrives afterwards is ignored (a certificate that
was being stored for it is deleted again).

## A start failed

The row shows vendor status `start_failed` and a **vendor error**; the investor sees that verification
could not be started. Nothing is polled. Common causes:

- `unauthorized` — the vendor refused the credentials (a revoked token). Fix the connection first
  ([Connection in error](#connection-in-error)).
- `connection_changed` — the workspace has no live connection with this vendor any more.
- `no_email` — the member has no email address to send the vendor. `member_erased` — the member was
  erased (if that happened while the vendor was starting, nothing of the vendor's answer is kept).
  `member_inactive` — the membership was revoked or suspended; no vendor call was made.
- `start_timeout` — 5 attempts ran without a result (each attempt leases the row for 10 minutes; a
  queue backlog alone never gets here). Check the worker and the vendor's reachability.
- `invalid_request` / `conflict` — the vendor refused the investor's details (a malformed email; with
  Parallel, an entity without a legal name, or an email it holds under a record FundRoom could not
  find).
- `invalid_response` — the vendor answered with something FundRoom could not store.
- `unavailable` / `rate_limited` — the vendor was down for all attempts. After two `unavailable`
  failures in a row the start stops early: a timed-out VerifyInvestor call may already have sent
  the invitation, and FundRoom cannot look it up by its own id. Before **Check now**, ask the
  investor whether VerifyInvestor already emailed them (a second invitation is a second bill).

Fix the cause, then **Check now** on the verification: on a row without a vendor reference it clears the
failure and runs the start again. Or decide it by hand.

## Callbacks refused (401)

Refused callbacks cost latency, never data: polling converges anyway. Look at the rate:

```
docker compose logs --since 1h app 2>&1 | grep -E '"event":"(security.accreditation_callback_rejected|accreditation.callback_summary)"' | tail -n 20
```

- **Every callback refused since the connection was made**: the connection has no webhook secret. That is
  allowed (polling only); to receive callbacks, paste the vendor's secret into **Settings →
  Accreditation** (VerifyInvestor *Webhook secret*, Parallel *Webhook signing key*).
- **A steady trickle after a change**: the secret no longer matches — someone regenerated it at the
  vendor, or the vendor posts for another environment (a sandbox account posting to a production
  connection). Re-enter the current secret in FundRoom; the vendor's webhook log should then show 200.
- **Parallel Markets, only some callbacks**: Parallel signs a timestamp; callbacks too far from FundRoom's
  clock are refused. Check NTP on the app host.
- **After a vendor switch or a disconnect**: the old connection's URL answers 401; the new connection has a
  new callback URL. Update it at the vendor.
- **Bursts from many addresses with no matching vendor change**: someone is probing the URL. Nothing is
  needed: forged callbacks are refused before any work, an authentic replay only causes one extra status
  read, and over-budget callbacks are answered 200 without queueing work.

## Connection in error

**Settings → Accreditation** shows status `error` and `lastError` when **Verify**, a save, or a vendor
call during normal work was refused as unauthorised.

- The API key or token was revoked or rotated at the vendor, or belongs to the other environment
  (staging/demo vs production). Create or copy the current one, enter it (other secret fields left blank
  keep their stored values) and save — it is verified live before it is stored — then **Verify**.
- Parallel Markets: the key is for the other environment, or the partner account's API access was
  withdrawn.
- `502 accreditation_provider_error` on save or **Verify**: the vendor could not be reached. Try again
  later; for a test rig on a private address, the host must be in `ACCREDITATION_ALLOW_PRIVATE_HOSTS`.

A connection in `error` still starts and follows verifications; the calls simply fail until the
credentials work. Verifications whose reads failed meanwhile recover on their next scheduled read, or
at once with **Check now**.

## Re-running the sync

- **One verification**: **Check now** (above).
- **Everything due**: nothing to do — `round.verification_sync_due` runs every 15 minutes. To hurry it
  after an outage, retry the dead letters:

  ```
  docker compose run --rm app jobs dlq list --workspace <workspace uuid>
  docker compose run --rm app jobs dlq retry <job id>
  ```

  Discarding a dead-lettered `round.verification_sync` loses nothing: the sweep queues the next read.
- A verification whose polling **stopped** (`connection_changed`, `polling_stopped`,
  `member_erased`, `member_inactive`, `imported`) is not picked up again by any of these; decide it
  by hand. One whose **start** failed (`start_failed`) is
  started again by **Check now**. An investor cannot open a new verification while one is pending.

## Reading the audit log

Everything the pipeline does is on the workspace's audit log (**Audit log** in the admin, or
`GET /api/v1/audit/events`, `audit.read`; an API key with that scope works too). Filter by action — an
exact action, or a prefix ending in `.`:

```
curl -sS "https://<workspace host>/api/v1/audit/events?action=accreditation.&limit=50" \
  -H "Authorization: Bearer $FUNDROOM_API_KEY"
curl -sS "https://<workspace host>/api/v1/audit/events?action=round.verification_synced&from=2026-09-01T00:00:00Z" \
  -H "Authorization: Bearer $FUNDROOM_API_KEY"
curl -sS "https://<workspace host>/api/v1/audit/events?resourceKind=round_verification&resourceId=<verification id>" \
  -H "Authorization: Bearer $FUNDROOM_API_KEY"
```

| Action | Actor | Meaning |
|---|---|---|
| `accreditation.connection_saved` | staff | a vendor was connected or re-keyed (meta: driver, environment, field keys — never secrets) |
| `accreditation.connection_verified` | staff | **Verify** ran (meta: the outcome) |
| `accreditation.connection_deleted` | staff | disconnected |
| `round.verification_requested` | investor or system | a verification was opened (interest, renewal, auto-start) |
| `round.verification_started` | system | the vendor start succeeded (meta: provider) |
| `round.verification_start_failed` | system | the vendor start failed for good (meta: the error code) |
| `round.verification_synced` | system | **the vendor decided** it: meta `status` (verified / rejected / expired), `vendorStatus`, `method`, `expiresAt`, `vendorDecidedAt` (the vendor's certification date; the row's decision time is when FundRoom recorded it), `hasFile` (certificate kept) |
| `round.verification_decided` | staff | an admin decided it by hand |
| `round.verification_renewed` | system | a vendor re-check extended the expiry in place |
| `round.verification_reminder_sent` | system | the one expiry reminder was queued |
| `round.verification_expired` | system | a verified row passed its expiry (meta `superseded`, `notified` — whether the investor was emailed: only within 7 days of the expiry and when no other verified verification stands as long) |
| `round.verification_member_erased` | system | the member was erased; meta `verifications` = rows cut down to their handoff kind |

Refused callbacks are not audited (they are not the workspace's actions); they are the security-event
metric and log lines above.

## Orphan certificates

When a vendor decision loses a race — an admin decided the verification by hand, or the investor was
erased, between the certificate download and the decision — FundRoom deletes the certificate it had
just stored. If that delete fails, it logs `round.verification_orphan_certificate` (warn) with the
`storageKey`. Nothing refers to the object and the nightly evidence purge only follows rows, so it
stays until removed by hand. It is encrypted under the workspace's round evidence key, so it is
unreadable without the key ring, but it is still a copy of an investor's accreditation letter:

```
docker compose logs --since 7d app worker 2>&1 | grep '"event":"round.verification_orphan_certificate"'
```

Delete each `storageKey` from the object store (the `objstore` bucket, or your S3 bucket), and note
it in the ticket. A workspace deletion crypto-shreds it along with everything else.

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `ACCREDITATION_DRIVERS` | app | `verifyinvestor,parallel-markets`; `none` = vendors off (an empty value means the default) |
| `ACCREDITATION_ALLOW_PRIVATE_HOSTS` | app, worker | empty; prod/staging refuse loopback, unspecified and wildcard entries |
| `BASE_URL` | app | the callback URL is `<BASE_URL>/webhooks/accreditation/<connectionId>` — `BASE_URL` as configured, path included (never derived from `BASE_PATH`) |
| `AV_DRIVER` | worker | `noop`; vendor certificates are scanned like uploads ([av-failure.md](av-failure.md)) |
