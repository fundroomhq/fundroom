---
"@fundroom/audit": minor
"@fundroom/events": minor
"@fundroom/domain": minor
"@fundroom/queue-pgboss": minor
"@fundroom/identity": minor
"@fundroom/ports": minor
"@fundroom/db": minor
"@fundroom/config": minor
---

Add the audit, events and jobs kernel. `@fundroom/db` gains migration `0002_audit_events`: the `audit` schema (`event` partitioned monthly with a per-workspace SHA-256 hash chain assigned by a `SECURITY DEFINER` trigger under an advisory lock, `chain_head`, `checkpoint`, `anchor`, all append-only), `core.idempotency_key`, `outbox.dispatched`, `audit.ensure_partitions()` / `expired_partitions()` / `drop_partition()` / `verify_chain()` / `export_rows()`, plus `PLATFORM_WORKSPACE_ID`, `platformContext()` and `listActiveWorkspaceIds()`. `@fundroom/ports` adds `JobQueuePort`, `JobDefinition`, `AuditSinkPort`. `@fundroom/domain` starts with the Zod-typed domain event catalogue. `@fundroom/events` implements the transactional outbox writer, the relay (one job per subscriber, transactional enqueue, poison-row isolation), the worker-side dispatcher, idempotency keys and job registration. `@fundroom/queue-pgboss` implements `JobQueuePort` over pg-boss 12 with a shared dead-letter queue. `@fundroom/audit` implements the recorder, diff redaction, IP truncation, HMAC-signed daily checkpoints, partition maintenance, in-database and offline chain verification and the `fundroom-audit verify` CLI. `@fundroom/identity` now records audit rows and publishes outbox events for logins, failed logins, revocations, credential changes, invites and memberships, and exports `createIdentityJobs`. `@fundroom/config` gains `AUDIT_RETENTION_MONTHS`, `AUDIT_IP_TRUNCATE`, `OUTBOX_POLL_INTERVAL_MS`, `JOBS_POLL_INTERVAL_MS`.
