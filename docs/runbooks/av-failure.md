# Runbook: virus scanner down, stale or refusing files

Every file uploaded to the data room is scanned before anyone can open it, and so is every piece of accreditation evidence an investor uploads to a round. The scanner is ClamAV's `clamd`, reached over TCP, or nothing at all. This runbook is for whoever operates the install: what each `AV_DRIVER` actually does to an upload, what happens while `clamd` is unreachable, what signature updates failing looks like (almost nothing, which is the problem), the size limit that fails large files on a healthy scanner, and how to recover the files that got stuck.

## What has to be true first

- **You know which driver is configured.** `docker compose run --rm app doctor 2>&1 | grep -E 'AV_DRIVER|CLAMD'`. The admin **Data room → Settings** screen shows it too.
- **For `clamd`: the scanner runs where the worker can reach it.** In the reference Compose stack that is the `clamav` service, started with `docker compose --profile av up -d`, and the app's `AV_DRIVER=clamd` (the Compose default for `CLAMD_HOST` is already `clamav`). `AV_DRIVER`, `CLAMD_HOST`, `CLAMD_PORT` and `CLAMD_TIMEOUT_MS` all pass through from `deploy/compose/.env`; left empty, the port and timeout take their defaults.
- **You know that ClamAV needs time and memory to start.** It downloads its signature databases on first start and loads them into memory: allow a few minutes (the Compose health check has a five-minute start period) and a gigabyte or more of RAM for the `clamav` container.
- **Admin access to the data room**, to see what state each file is in.

## What each driver does to an upload

The data room's ingest job — `data-room.ingest`, one per uploaded version, run by the worker — scans the file while it still sits under its quarantine key, and only a file with an acceptable verdict is encrypted into place and rendered.

| Verdict (`blob.scan_status`) | Shown to admins as | Servable to anyone? | Comes from |
|---|---|---|---|
| `pending`, `scanning` | Processing | No | Upload completed; the job has not finished |
| `clean` | Ready | Yes | `clamd` answered `OK` |
| `infected` | Infected | **Never** — stays in quarantine, the viewer says "Blocked" | `clamd` answered `… FOUND` |
| `error` | Scan failed | No | `clamd` unreachable, timed out, or answered `… ERROR` |
| `skipped` | Unscanned | **Only if** the workspace turns on **Serve files the scanner skipped** | `AV_DRIVER=noop` |

Two properties follow, and both surprise people:

- **With `AV_DRIVER=noop`, the reference Compose default, uploads are not served at all** until a workspace admin turns on **Data room → Settings → Serve files the scanner skipped (no virus scanner configured)**. That setting (`dataRoom.allowUnscanned`) defaults to off, per workspace. The operator chooses the driver; each workspace chooses whether to accept unscanned files. Nothing about `noop` is silent: the process logs `avscan.noop` once at warn level, and every file carries the Unscanned badge.
- **Switching from `noop` to `clamd` later does not rescan anything.** Files already `skipped` stay `skipped` — servable or not according to the same setting. There is no rescan command. A file that must be scanned is uploaded again as a new version. The same applies to a workspace **imported** from another install: its files keep the verdict they had there.

Accreditation evidence in the round module is scanned **synchronously**, in the upload request. `infected` and `error` both reject the file with "this file could not be accepted", so an investor uploading evidence while `clamd` is down is refused on the spot rather than queued.

## `clamd` is down or unreachable

This is fail-closed. For each upload while the scanner cannot answer:

1. The job marks the file `error` (Scan failed) and throws, with the reason in the error (`connect ECONNREFUSED …`, `clamd: INSTREAM timed out after 120000 ms`).
2. pg-boss retries it — five retries, exponential backoff starting at 15 seconds — about eight minutes in all.
3. If `clamd` is back within that window, a retry scans the file and it proceeds as if nothing happened.
4. If not, the job goes to the **dead-letter queue** and the file stays `error`. **Nothing retries it again by itself** — the data room's hourly sweep re-enqueues files stuck in `pending` or `scanning`, not `error`.

No file is ever served unscanned because the scanner was down.

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

On a single-tenant install the admin **Health** page (`GET /api/v1/ops/health`) runs the same `PING` as its `avscan` check and shows it as *degraded* when it fails. `/readyz` does **not** check the scanner — a scanner outage does not, and should not, take the portal out of rotation.

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

`clamd` refuses a stream larger than its `StreamMaxLength` with `INSTREAM size limit exceeded. ERROR`, and the app records that as Scan failed. It is deterministic: every retry fails the same way, so each such file dead-letters, and the error line says `size limit exceeded`. The app accepts uploads up to `UPLOAD_MAX_BYTES` (5 GiB by default), far above ClamAV's shipped limits — so a stock `clamav` container fails every large pitch-deck export or video.

Read the limits the daemon is actually running with:

```
docker compose exec clamav grep -E '^#?(StreamMaxLength|MaxFileSize|MaxScanSize|AlertExceedsMax)' /etc/clamav/clamd.conf
```

Raise them **together**, in a `clamd.conf` you mount into the container, and restart `clamav`:

- `StreamMaxLength` — the largest stream the daemon accepts at all. Past it: the `ERROR` above.
- `MaxFileSize` and `MaxScanSize` — how much of a file, and of the content unpacked from it, the engine actually scans. **Past these, ClamAV by default stops scanning and answers `OK`.** Raising `StreamMaxLength` alone therefore turns "large files fail" into "large files are partly scanned and marked clean". Either raise all three to at least `UPLOAD_MAX_BYTES` (and give the container the memory that costs), or set `AlertExceedsMax yes`, which reports an over-limit file as `FOUND` (`Heuristics.Limits.Exceeded…`) — the file is then **Infected** and blocked, which is the honest answer for a file nobody scanned.

The other lever is the app: lower `UPLOAD_MAX_BYTES` (install-wide) or the workspace's own upload limit to what your scanner is configured to scan. A timeout (`CLAMD_TIMEOUT_MS`, default 120 s) on very large files is the same decision from the other side.

Then retry the dead letters as above.

## Signature updates are failing

This is the failure nothing in the product notices. `freshclam` runs inside the `clamav` container and updates the signature databases in the background; when it cannot — no outbound network, a mirror rate-limiting the host, a full volume — **`clamd` keeps answering with the signatures it has**. Every health check stays green and every file keeps coming back clean, against a database that stops knowing about new malware.

**1. How old are the signatures the daemon is using?**

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

Put a check on question 1's date in your monitoring. Nothing else will tell you.

## An upload was flagged Infected

The file never left quarantine, cannot be opened or downloaded by anyone, and the workspace's audit log holds a `document.scan_infected` event naming the signature. Nothing deletes it automatically: an admin deletes the document when they have decided what it was.

There is no way to mark a file clean by hand, deliberately. If a staff member is sure it is a false positive, the route is to check the file with other tools, wait for the next signature update, and upload it again; if it is still flagged, report the false positive to ClamAV. If it is *not* a false positive, find out where it came from before anyone opens the original — and see [incident-response.md](incident-response.md) if it arrived through an investor-facing upload.

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `AV_DRIVER` | worker (and the api process, for round evidence) | `noop` |
| `CLAMD_HOST` | same | unset; `clamav` in the reference Compose file; required with `AV_DRIVER=clamd` |
| `CLAMD_PORT` | same | `3310` |
| `CLAMD_TIMEOUT_MS` | same | `120000` — the whole scan's deadline |
| `UPLOAD_MAX_BYTES` | app | `5368709120` (5 GiB); a workspace may set a lower limit |
| `RENDER_MAX_BYTES` | worker | `209715200` (200 MiB) — the renderer's ceiling, independent of scanning |
| `dataRoom.allowUnscanned` | workspace setting | off |
