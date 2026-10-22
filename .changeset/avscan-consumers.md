---
"@fundroom/server": patch
"@fundroom/esign": patch
"@fundroom/module-data-room": patch
"@fundroom/module-round": patch
"@fundroom/ports": patch
"@fundroom/queue-pgboss": patch
"@fundroom/config": patch
"@fundroom/avscan-clamd": patch
---

Scan failures that retrying cannot fix are now final instead of retried until the dead letters. A data-room file the virus scanner cannot scan in full (over its size limit, or the engine stopped at one of its limits) is marked `error` with the reason, `document.ingested` is published with `scanStatus: "error"`, and the document reads "failed"; uploading the same file again retries the scan instead of answering 409, while the same bytes as an infected file get a 409 "the virus scanner flagged this file". An e-signature artifact that cannot be scanned in full fails collection with `artifact_unscannable`. A multipart upload over the part limit is refused with 413 before anything is created, and every scan names its caller (`data-room`, `esign`, `round`) for the scanner metrics. A scanner outage no longer shows "Scan failed" while the ingest job is still retrying: the file stays Processing (`scanning`, with the reason in its scan detail) and only the last attempt records `error` before the job is dead-lettered; a retried dead letter scans again. For that, a job handler now sees which delivery it is (`ActiveJob.attempt: { count, limit }`, from pg-boss's retry count and limit). One ingest job scans a blob at a time (a conditional claim) and the promotion into the content-addressed key holds the blob row, so a re-upload or a second job can no longer race a scan or overwrite a promoted object; re-uploading a file whose scan failed also re-ingests the versions that failed with it. A stopping or expired job aborts its scan (`ScanInput.signal`), the scan deadline is capped at 20 minutes (`CLAMD_MAX_DEADLINE_MS`, now defined once in `@fundroom/ports`), the e-sign collect job expires after 30 minutes, and `doctor` warns when `CLAMD_TIMEOUT_MS` alone passes that cap or when `ESIGN_MAX_ARTIFACT_BYTES` exceeds `AV_MAX_SCAN_BYTES`. Migration `data-room/0009` adds a nullable `scan_claimed_by` column (no rewrite).
