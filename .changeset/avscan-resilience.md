---
"@fundroom/server": patch
"@fundroom/ports": patch
"@fundroom/avscan-clamd": patch
"@fundroom/avscan-noop": patch
"@fundroom/config": patch
"@fundroom/contracts": patch
"@fundroom/sdk": patch
---

**Security:** @fundroom/server no longer crashes when clamd drops a connection mid-scan: every clamd exchange settles once, closes its socket and releases the upload stream, and an unhandled promise rejection is logged (`process.unhandled_rejection`) and counted instead of exiting the process. Scan errors now carry a reason: `too_large` and `partial` (clamd `Heuristics.Limits.Exceeded`, "could not be scanned in full" — no longer reported as infected) are final, `unavailable` and `timeout` are retried. New keys `AV_MAX_SCAN_BYTES` (clamd's `StreamMaxLength`; also caps the upload ceiling), `CLAMD_CONNECT_TIMEOUT_MS` and `CLAMD_MIN_BYTES_PER_SECOND`; new metrics `fundroom.avscan.scans`, `.duration`, `.errors`, `.up` and `.signature_age_seconds`; `GET /platform/health` reports the scanner's last probe.
