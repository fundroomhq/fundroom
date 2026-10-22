# Runbook: virus scanner down, stale or refusing files

Every file uploaded to the data room is scanned before anyone can open it, and so is every piece of accreditation evidence an investor uploads to a round. The scanner is ClamAV's `clamd`, reached over TCP, or nothing at all. This runbook is for whoever operates the install: what each `AV_DRIVER` actually does to an upload, what happens while `clamd` is unreachable, what signature updates failing looks like (and the gauge that now notices), the size limit that fails large files on a healthy scanner, and how to recover the files that got stuck.

## What has to be true first

- **You know which driver is configured.** `docker compose run --rm app doctor 2>&1 | grep -E 'AV_DRIVER|CLAMD'`. The admin **Data room → Settings** screen shows it too.
- **For `clamd`: the scanner runs where the worker can reach it.** In the reference Compose stack that is the `clamav` service, started with `docker compose --profile av up -d`, and the app's `AV_DRIVER=clamd` (the Compose default for `CLAMD_HOST` is already `clamav`). `AV_DRIVER`, `CLAMD_HOST`, `CLAMD_PORT`, `CLAMD_TIMEOUT_MS`, `CLAMD_CONNECT_TIMEOUT_MS`, `CLAMD_MIN_BYTES_PER_SECOND` and `AV_MAX_SCAN_BYTES` all pass through from `deploy/compose/.env`; left empty, they take their defaults.
- **For `clamd`: `AV_MAX_SCAN_BYTES` equals the daemon's `StreamMaxLength`.** The app then refuses larger uploads up front instead of accepting files the scanner cannot read in full. `doctor` and the boot log warn while it is unset (see [A healthy scanner fails large files](#a-healthy-scanner-fails-large-files)).
- **You know that ClamAV needs time and memory to start.** It downloads its signature databases on first start and loads them into memory: allow a few minutes (the Compose health check has a five-minute start period) and a gigabyte or more of RAM for the `clamav` container.
- **Admin access to the data room**, to see what state each file is in.

## What each driver does to an upload

The data room's ingest job — `data-room.ingest`, one per uploaded version, run by the worker — scans the file while it still sits under its quarantine key, and only a file with an acceptable verdict is encrypted into place and rendered.

| Verdict (`blob.scan_status`) | Shown to admins as | Servable to anyone? | Comes from |
|---|---|---|---|
| `pending`, `scanning` | Processing | No | Upload completed; the job has not finished |
| `clean` | Ready | Yes | `clamd` answered `OK` |
| `infected` | Infected | **Never** — stays in quarantine, the viewer says "Blocked" | `clamd` answered `<signature> FOUND` |
| `error` | Scan failed | No | see the reasons below |
| `skipped` | Unscanned | **Only if** the workspace turns on **Serve files the scanner skipped** | `AV_DRIVER=noop` |

An `error` carries a reason, recorded in the blob's scan detail (`<reason>: <text>`), counted in `fundroom.avscan.errors{kind}`, and deciding whether the job tries again:

| Reason | What happened | Retried? |
|---|---|---|
| `unavailable` | `clamd` could not be reached (`CLAMD_CONNECT_TIMEOUT_MS`), reset the connection, answered something unexpected, or the job stopped mid-scan | Yes — the file stays **Processing** while the job retries; after the last retry it reads **Scan failed** and the job is dead-lettered; uploading the same file again then retries the scan |
| `timeout` | The scan deadline passed (`CLAMD_TIMEOUT_MS`, plus `size / CLAMD_MIN_BYTES_PER_SECOND` when set; never more than 20 minutes) | Yes — as for `unavailable` |
| `too_large` | The file is larger than `AV_MAX_SCAN_BYTES` (refused before anything is sent), or `clamd` answered `INSTREAM size limit exceeded` | **No** — final, Scan failed at once |
| `partial` | `clamd` stopped at its own `MaxFileSize`/`MaxScanSize`/… limits and, with `AlertExceedsMax yes`, said so (`Heuristics.Limits.Exceeded…`): the file **could not be scanned in full**. Not infected; never served | **No** — final |

Two properties follow, and both surprise people:

- **With `AV_DRIVER=noop`, the reference Compose default, uploads are not served at all** until a workspace admin turns on **Data room → Settings → Serve files the scanner skipped (no virus scanner configured)**. That setting (`dataRoom.allowUnscanned`) defaults to off, per workspace. The operator chooses the driver; each workspace chooses whether to accept unscanned files. Nothing about `noop` is silent: the process logs `avscan.noop` once at warn level, and every file carries the Unscanned badge.
- **Switching from `noop` to `clamd` later does not rescan anything.** Files already `skipped` stay `skipped` — servable or not according to the same setting. There is no rescan command. A file that must be scanned is uploaded again as a new version. The same applies to a workspace **imported** from another install: its files keep the verdict they had there.

Accreditation evidence in the round module is scanned **synchronously**, in the upload request. `infected` and `error` both reject the file with "this file could not be accepted", so an investor uploading evidence while `clamd` is down is refused on the spot rather than queued.

## `clamd` is down or unreachable

This is fail-closed. For each upload while the scanner cannot answer:

1. The scan ends `error` with reason `unavailable` or `timeout` (`clamd: Error: connect ECONNREFUSED …`, `clamd: connect to clamav:3310 timed out after 5000 ms`, `clamd: INSTREAM timed out after 120000 ms`), and the job throws so it is retried. The file stays **Processing** (`scanning`, with the reason in its scan detail) meanwhile. `fundroom.avscan.errors{kind="unavailable"}` and `fundroom.avscan.up` = 0 show it on the dashboards.
2. pg-boss retries it — five retries, exponential backoff starting at 15 seconds — 8–16 minutes in all, longer when scans time out (each timed-out attempt adds its scan deadline).
3. If `clamd` is back within that window, a retry scans the file and it proceeds as if nothing happened.
4. If not, the last retry records `error` (**Scan failed**) and the job goes to the **dead-letter queue**. **Nothing retries it again by itself** — the data room's hourly sweep re-enqueues files stuck in `pending` or `scanning`, not `error`. Retrying the dead letter, or uploading the same file again, scans it again.

No file is ever served unscanned because the scanner was down. A scanner that drops connections mid-stream cannot crash the process either: every exchange with `clamd` settles once and closes its socket, and a stray rejection anywhere is logged as `process.unhandled_rejection` and counted in `fundroom.process.unhandled_rejections` instead of exiting.

### Diagnose

**1. Is `clamd` running and answering?**

```
docker compose ps clamav
docker compose logs --tail=100 clamav
docker compose exec clamav clamdcheck.sh && echo OK
```

A container that restarts repeatedly is usually out of memory while loading signatures: check `docker compose events` or the kernel log for an OOM kill, and give the container more memory.

**2. Can the app reach it?** From inside the app container, the way the adapter connects (the image has no shell, so this is Node):

```
docker compose exec app /nodejs/bin/node -e "const s=require('net').connect(3310,'clamav',()=>s.write('zPING\0'));s.on('data',d=>{console.log(String(d));s.end()});s.on('error',e=>{console.error(e.message);process.exit(1)})"
```

`PONG` means the path works. `ENOTFOUND clamav` means the `av` profile is not running or `CLAMD_HOST` names something else; `ECONNREFUSED` means the name resolves and nothing listens yet. With a separate worker, run the same line in the `worker` container — the worker is what scans.

On a single-tenant install the admin **Health** page (`GET /api/v1/ops/health`) runs the same `PING` as its `avscan` check and shows it as *degraded* when it fails. Every install also probes `clamd` once a minute from each process: `fundroom.avscan.up` (1/0) on `/metrics` and OTLP, and the `avscan` block of the operator's `GET /api/v1/platform/health`, both read from that probe. `/readyz` does **not** check the scanner — a scanner outage does not, and should not, take the portal out of rotation.

**3. Which files are stuck?** In the data room admin, filter or scan for **Scan failed**. From the operator side, the dead letters say the same:

```
docker compose run --rm app jobs dlq list --limit 200
```

Lines with source queue `data-room.ingest` are the stuck files, one per upload.

### Recover

Once question 2 answers `PONG`:

- Jobs still retrying finish on their own.
- Dead-lettered ones need a retry: per job with `docker compose run --rm app jobs dlq retry <id>`, or **Jobs → Failed jobs → Retry** in the workspace admin. [queue-backlog.md](queue-backlog.md) has a loop for retrying many. The ingest job is idempotent — it resumes from whatever state the file is in — so a retry is always safe.

Then upload the EICAR test string through the data room once and check it ends **Infected**: that proves the whole path, not just the socket.

## A healthy scanner fails large files

`clamd` refuses a stream larger than its `StreamMaxLength` (100 MiB in the stock `clamav/clamav` image) with `INSTREAM size limit exceeded. ERROR`. The app accepts uploads up to `UPLOAD_MAX_BYTES` (5 GiB by default), far above that — so without further configuration a stock `clamav` container fails every large pitch-deck export or video. Such a file ends **Scan failed** with reason `too_large` at once; it is not retried, since every retry would fail the same way.

Set `AV_MAX_SCAN_BYTES` to the daemon's `StreamMaxLength`. With `AV_DRIVER=clamd` the app then:

- caps the upload ceiling at `min(UPLOAD_MAX_BYTES, AV_MAX_SCAN_BYTES)` — a larger upload is refused with 413 before any byte is stored, which is the answer the uploader can act on;
- refuses a larger input in the scanner itself (`too_large`) before connecting, for anything that reaches it another way (e-sign artifacts, imports).

`doctor` and the boot log warn while `AV_MAX_SCAN_BYTES` is unset, and when `UPLOAD_MAX_BYTES` is larger (the ceiling is capped).

Read the limits the daemon is actually running with:

```
docker compose exec clamav grep -E '^#?(StreamMaxLength|MaxFileSize|MaxScanSize|AlertExceedsMax)' /etc/clamav/clamd.conf
```

Raise them **together**, in a `clamd.conf` you mount into the container, and restart `clamav`:

- `StreamMaxLength` — the largest stream the daemon accepts at all. Past it: the `ERROR` above.
- `MaxFileSize` and `MaxScanSize` — how much of a file, and of the content unpacked from it, the engine actually scans. **Past these, ClamAV by default stops scanning and answers `OK`.** Raising `StreamMaxLength` alone therefore turns "large files fail" into "large files are partly scanned and marked clean". Either raise all three to at least `AV_MAX_SCAN_BYTES` (and give the container the memory that costs), or set `AlertExceedsMax yes`, which reports an over-limit file as `FOUND` with a `Heuristics.Limits.Exceeded…` signature. The app reads that as reason `partial`: **Scan failed — could not be scanned in full**, never served, not retried, and *not* Infected (nothing was found; the engine just stopped reading).

Then raise `AV_MAX_SCAN_BYTES` to the new `StreamMaxLength`. Large files take longer: set `CLAMD_MIN_BYTES_PER_SECOND` (e.g. `1048576`, 1 MiB/s) so the deadline grows with the file — `CLAMD_TIMEOUT_MS + size / rate`, capped at 20 minutes because the jobs that scan expire at 30. `doctor` also warns when `ESIGN_MAX_ARTIFACT_BYTES` is larger than `AV_MAX_SCAN_BYTES`: an e-sign artifact between the two fails its collection as unscannable. `doctor` warns when the largest allowed file would hit that cap.

Files that already failed `too_large` or `partial` are not retried by anything. Once the limits are raised, the uploader uploads the file again: re-uploading a file whose earlier scan failed is a fresh scan, not a duplicate.

## Signature updates are failing

`freshclam` runs inside the `clamav` container and updates the signature databases in the background; when it cannot — no outbound network, a mirror rate-limiting the host, a full volume — **`clamd` keeps answering with the signatures it has**. `PING` stays green and every file keeps coming back clean, against a database that stops knowing about new malware.

Two gauges, from the minute-by-minute probe (`clamd` `PING` and `VERSION`), exist for this:

- `fundroom.avscan.signature_age_seconds` — now minus the daily database's build date. Signatures are published several times a day; alert above two days (`172800`). It keeps ageing while `clamd` is down.
- `fundroom.avscan.up` — 1 while `clamd` answers, 0 when not. Alert when it stays 0 for more than a few minutes.

Both exist only with `AV_DRIVER=clamd`, from every process (api and worker run the same binary).

**1. How old are the signatures the daemon is using?** The gauge says; to check by hand:

```
docker compose exec clamav clamdscan --version
```

The answer ends with the daily database's version and build date, `ClamAV 1.4.x/<daily version>/<date>`. Signatures are published several times a day; a date more than two days old means updates are failing.

**2. Why?**

```
docker compose logs --since=48h clamav 2>&1 | grep -iE "freshclam|error|warning|cooldown|429|403" | tail -n 40
```

- **`429` / cool-down**: the ClamAV CDN is rate-limiting this address — usually because updates run too often (more than the default schedule), or because many hosts share one egress address. The message says how long the cool-down lasts. Do not restart the container in a loop; each attempt extends it.
- **`403`**: blocked outright, typically by country or by an abusive update pattern from the same address. Use a private mirror.
- **Connection errors**: the container has no outbound HTTPS. Check the host's egress rules.
- **No space left**: the `clamav` volume or the host disk is full.

**3. Force an update** once the cause is fixed: `docker compose restart clamav`. The container runs `freshclam` on start before starting the daemon, so the restart both updates and reloads; scanning is unavailable for the minute or two it takes, and uploads in that window retry as described above.

The age gauge drops back on the next probe after the reload.

## An upload was flagged Infected

The file never left quarantine, cannot be opened or downloaded by anyone, and the workspace's audit log holds a `document.scan_infected` event naming the signature. Nothing deletes it automatically: an admin deletes the document when they have decided what it was.

Each such file also counts in `fundroom.security.events{event="avscan_infected"}`, labelled with where it came from (`data-room`, `esign`, `round`). An infected e-sign artifact counts twice: under `esign_artifact_infected` (the collection failing) and under `avscan_infected` (the verdict).

There is no way to mark a file clean by hand, deliberately — and uploading the same file again is refused ("the virus scanner flagged this file"), since the verdict stands for those bytes. If a staff member is sure it is a false positive, check the file with other tools, wait for the next signature update, delete the flagged document, and upload it again; if it is still flagged, report the false positive to ClamAV. (A file whose scan merely *failed* is different: uploading it again simply scans it again.) If it is *not* a false positive, find out where it came from before anyone opens the original — and see [incident-response.md](incident-response.md) if it arrived through an investor-facing upload.

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `AV_DRIVER` | worker (and the api process, for round evidence) | `noop` |
| `CLAMD_HOST` | same | unset; `clamav` in the reference Compose file; required with `AV_DRIVER=clamd` |
| `CLAMD_PORT` | same | `3310` |
| `CLAMD_TIMEOUT_MS` | same | `120000` — the base scan deadline |
| `CLAMD_CONNECT_TIMEOUT_MS` | same | `5000` — past it the scan is `unavailable` and retried |
| `CLAMD_MIN_BYTES_PER_SECOND` | same | `0` (fixed deadline); above 0 the deadline is `CLAMD_TIMEOUT_MS + size / rate`, at most 20 minutes |
| `AV_MAX_SCAN_BYTES` | app and worker | unset; set it to `clamd`'s `StreamMaxLength`. With `AV_DRIVER=clamd`: larger files are refused (`too_large`) and the upload ceiling is capped to it. Ignored with `noop` |
| `UPLOAD_MAX_BYTES` | app | `5368709120` (5 GiB); a workspace may set a lower limit; capped by `AV_MAX_SCAN_BYTES` with `clamd` |
| `RENDER_MAX_BYTES` | worker | `209715200` (200 MiB) — the renderer's ceiling, independent of scanning |
| `dataRoom.allowUnscanned` | workspace setting | off |

## Metrics this runbook refers to

| Metric | Labels | Meaning |
|---|---|---|
| `fundroom.avscan.scans` | `verdict`, `source` | Every scan |
| `fundroom.avscan.duration` (s) | `verdict`, `source` | Scan time |
| `fundroom.avscan.errors` | `kind` (`too_large`, `partial`, `unavailable`, `timeout`), `source` | Scans that ended `error` |
| `fundroom.avscan.up` | `driver` | 1 = `clamd` answered the last probe (clamd only) |
| `fundroom.avscan.signature_age_seconds` | `driver` | Age of the signature database (clamd only) |
| `fundroom.security.events` | `event="avscan_infected"`, `code` = source | Infected files |
| `fundroom.process.unhandled_rejections` | — | Rejections nothing handled; the process logged and kept running |
