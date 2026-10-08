---
"@fundroom/db": minor
"@fundroom/config": minor
---

Add `@fundroom/db`: the tenancy kernel. Drizzle schema for `core.workspace`, `core.module_enablement`, `core.outbox` and `core.schema_migration`; an SQL migration runner with per-module journals, checksums, a session advisory lock, `SET LOCAL lock_timeout` with retry, and `no-transaction` files for `CONCURRENTLY`; `core.uuidv7()` (native on Postgres 18, RFC 9562 shim on 16/17); `withTenant()`/`withHost()` that switch to the `seedhost_app` role and set the tenant context transaction-locally; `TenantRepo`; `core.apply_tenant_fence()` / `core.check_tenant_fence()` and the `fundroom-db check-rls` catalog check; single-tenant workspace resolution. `@fundroom/config` gains `TENANCY_MODE` and `DATABASE_STATEMENT_TIMEOUT_MS`.
