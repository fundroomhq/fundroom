# @fundroom/db

Kernel database package: Drizzle schemas per Postgres schema, the SQL migration runner,
the row-level-security tenant fence, and `withTenant()` — the only way application code
gets a query handle.

## Getting a query handle

```ts
import { createDatabase, systemContext, TenantRepo } from "@fundroom/db";

const db = createDatabase({ connectionString: config.raw.DATABASE_URL });

await db.withTenant({ workspaceId, actorKind: "staff", membershipId, userId }, async (tx) => {
  // tx is a Drizzle transaction running as role seedhost_app with
  // app.workspace_id / app.actor_kind / app.membership_id / app.user_id set for this tx only.
});

await db.withHost(async (tx) => {
  // No workspace: core.workspace, core.outbox and the global identity tables are visible,
  // tenant tables return zero rows.
});
```

Repositories extend `TenantRepo`; they append `workspace_id = ctx.workspaceId` to reads and
force it on inserts. Only `packages/db`, `**/repos/**`, `**/schema/**` and migration code may
import `drizzle-orm` or `pg` (dependency-cruiser rule `only-repos-touch-drizzle`).

### View as investor

`TenantContext.viewAs?: { staffMembershipId, staffUserId }` marks an **external** context that a
staff member is using to look at the portal as that investor (`assertTenantContext` refuses it on
any other actor kind). `withTenant` opens such a transaction with `SET TRANSACTION READ ONLY`: the
database backstop behind the route-level suppressions, so a forgotten side effect fails with
SQLSTATE `25006` (mapped by the server to 403 `view_as_read_only`) instead of being recorded as
the investor. `isViewingAs(ctx)` is the check services use. Note the backstop covers only the
view-as context itself: work a service does in `systemContext(...)` is not read only, which is
why the routes skip their side effects explicitly.

## Identity tables (0001)

`core."user"`, `user_identity`, `credential`, `device`, `session` and `rate_limit` are *global*
(no `workspace_id`). They carry a RESTRICTIVE `global_fence`: the host context sees everything;
a tenant context sees the acting user's own rows (`app.user_id`), and for `user` /
`user_identity` also the people who hold a membership in the current workspace. Nothing lets a
tenant context discover a user's other workspaces. `membership` has a custom
`tenant_fence` that additionally lets the host context read the *named* user's own rows:

```ts
await db.withHost((tx) => …, { actorKind: "host", userId }); // workspace switcher
```

`auth_challenge` (OTP codes, magic-link tokens, WebAuthn challenges, OIDC state) is fenced like
`outbox`: tenant rows plus the host context, because login runs before a membership exists.
`group`, `group_member`, `invite` and `attestation` are ordinary tenant tables. The repositories
and flows over these tables live in `@fundroom/identity`.

## Audit tables (0002)

`audit.event` is range-partitioned by month on `occurred_at` and append-only: the app role
has SELECT + INSERT, triggers reject UPDATE/DELETE/TRUNCATE, and `audit.chain()` (BEFORE
INSERT, `SECURITY DEFINER`, per-workspace advisory lock) assigns `seq`, `prev_hash` and
`hash = sha256(audit.canonical(row))`. `audit.chain_head` caches the head per workspace,
`audit.checkpoint` holds the signed daily snapshots and `audit.anchor` external anchors.
All four carry the standard workspace fence; host-level rows use `PLATFORM_WORKSPACE_ID`
(`platformContext()`), a reserved pseudo-workspace that no tenant context can read.
Helpers: `audit.ensure_partitions(months_ahead, from_month)`, `audit.expired_partitions(n)`,
`audit.drop_partition(name)`, `audit.verify_chain(ws, from, to)`, `audit.export_rows(ws, from, to)`.
The recorder, checkpoints and the verification CLI live in `@fundroom/audit`.

## Workspace keys (0003)

`core.workspace_key` holds one active wrapped data-encryption key per (workspace, purpose)
(partial unique index on `retired_at IS NULL`), the `kms_key_ref` of the KEK that wrapped it,
and a `rotated_from_id` link to its predecessor. Standard workspace fence; the app role can
SELECT/INSERT/UPDATE but not DELETE (keys are retired, never removed; crypto-shred is workspace
deletion, which cascades). The envelope service, streaming AEAD and the `crypto.rewrap` job
live in `@fundroom/crypto`; the local KMS adapter in `@fundroom/kms-local`.

`core.idempotency_key` (fenced like `outbox`) backs `@fundroom/events`' `onceByKey()`;
`core.outbox.dispatched` records how many jobs the relay created per row.
`core.check_tenant_fence()` ignores the `pgboss` schema (third-party tables owned by the
queue adapter, which grants `seedhost_app` access to them at start-up).

## Access tables (0004)

`core.access_grant` (subject membership | group | role | link → resource kind + id + optional
`ltree` path → one capability, effect allow | exclude, `tstzrange` validity; two partial
unique indexes keep one live rule per subject/resource/capability), `core.access_policy`
(gates `nda | accredited | min_auth_level | ip_allowlist` on the workspace, a group, a
membership or a resource), `core.effective_access` (materialised per membership × granted node:
capabilities + pending gates) with `core.effective_access_state` (built `acl_version`), and
`core.invite_import` (CSV jobs). `core.invite` gained `profile`. All standard-fenced.
`core.has_access(kind, id, path, capability)` is the predicate module RLS policies use for
investors (nearest node by `ltree`; gates deliberately ignored). Evaluator, repos and the
rebuild live in `@fundroom/authz`.

## Break-glass (0015)

`seedhost_host` is a NOLOGIN, BYPASSRLS role that inherits `seedhost_app`'s privileges. Nothing
connects as it; the `fundroom break-glass` CLI switches to it with `SET LOCAL ROLE`, one
transaction per statement. `core.break_glass_session` records the ticket, the operator and a
window of at most 1 h computed from the database clock. A session starts *pending*
(`notified_at IS NULL`). `activateBreakGlassSession` makes it usable once the opening is audited
and the owners were told. `claimBreakGlassStatement` row-locks it and counts each statement, and
a guard trigger refuses a closed or expired session. `src/break-glass/` exports:

- `hostRoleStatus()`: fails closed unless the role has exactly the shape 0015 creates. Managed
  Postgres may refuse `CREATE ROLE … BYPASSRLS`, so the migration only raises a NOTICE and a DBA
  creates the role.
- `vetBreakGlassStatement()`: Postgres parses the text as a `PREPARE` body over the extended
  protocol. Only SELECT/VALUES/TABLE/WITH and INSERT/UPDATE/DELETE/MERGE pass, and a second
  statement is refused.
- `runBreakGlassStatement()`: runs the statement READ ONLY unless `write`, through the
  SECURITY DEFINER `core.break_glass_exec()`, so it cannot switch back to the session user. It
  re-checks the role, the read-only state and the workspace afterwards.
- `core.break_glass_refuse` stops `seedhost_host` from writing its own evidence: the session log,
  `audit.event` and access reviews.
- `evidence.ts` holds the read-only queries behind `fundroom evidence`.

The operator procedure is in `docs/runbooks/break-glass.md`.

## Fault bounds

`statementTimeoutMs` is enforced by the server, so it cannot bound a connection that stops
answering. `clientTimeoutMs` (off by default) destroys the socket once a query runs past the bound.
The query fails, the pool drops the client, and the transaction ends with `ClientTimeoutError`:
SQLSTATE `08006` for a statement, `08007` for a COMMIT, whose outcome is then unknown, so do not
retry it blindly. An in-transaction `SET LOCAL statement_timeout = N` moves the bound to
N + `clientTimeoutGraceMs`, and `= 0` lifts it until the transaction ends. Savepoints are
followed, and COMMIT/ROLLBACK always get the plain bound. `withTenant`/`withHost` check out and
release the pool client themselves, in a `finally`, so a killed connection is never leaked.
`connectionTimeoutMs` bounds getting a connection. The server derives all three from
`DATABASE_STATEMENT_TIMEOUT_MS` (default 30 000; `0` turns them off) in
`apps/server/src/container.ts`. Leave the client bound off for pools that run migrations.

## Migrations

```
pnpm --filter @fundroom/db migrate            # kernel only; `fundroom migrate` runs every module
pnpm --filter @fundroom/db migrate -- --dry-run
pnpm --filter @fundroom/db migrate:status
pnpm --filter @fundroom/db test:rls           # RLS catalog check (CI)
```

- One folder per module (`migrations/core/` here; `modules/<id>/migrations/` for modules),
  files named `NNNN_snake_case.sql`, journaled per module in `core.schema_migration`
  with a sha256 checksum. Applied files are immutable; add a new one.
- A file runs in one transaction with `SET LOCAL lock_timeout` (retried on lock timeout).
  `--> statement-breakpoint` separates chunks. A file headed `-- seedhost: no-transaction`
  runs chunk by chunk in autocommit mode — required for `CREATE INDEX CONCURRENTLY` and
  must be idempotent.
- Two runners serialise on a session advisory lock; pending files numbered below the newest
  applied one are refused unless `--allow-out-of-order`.
- After every run the runner calls `core.apply_tenant_fence()`, which gives every table with
  a `workspace_id` column `ENABLE` + `FORCE ROW LEVEL SECURITY` and a RESTRICTIVE policy
  `tenant_fence`. A table that needs a different fence creates its own policy named
  `tenant_fence` in its migration. Every table also needs one permissive policy
  (`<table>_access … USING (true)`), otherwise RLS denies everything.
- The first migration of every module schema must grant the app role access:

  ```sql
  CREATE SCHEMA dataroom;
  GRANT USAGE ON SCHEMA dataroom TO seedhost_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA dataroom GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO seedhost_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA dataroom GRANT USAGE, SELECT ON SEQUENCES TO seedhost_app;
  ```

  `check-rls` fails if `seedhost_app` cannot read a table, or if a `jsonb` column has no
  `<name>_schema_version` sibling.
- Drafting: `pnpm --filter @fundroom/db db:generate --name <change>` diffs `src/schema/*.ts`
  against the drizzle-kit snapshot in `migrations/core/meta/` and writes a new SQL file; hand-edit
  it, then commit both. The runner ignores `meta/`.

## Database roles

The runner connects as `DATABASE_URL` (the table owner; superuser in the default Compose
install). Migration 0001 creates `seedhost_app` (NOLOGIN, no BYPASSRLS), grants it to the
connecting user, and every transaction opened by `withTenant()`/`withHost()` starts with
`SET LOCAL ROLE seedhost_app`. RLS therefore applies to all application queries regardless of
how privileged the connection string is. Migrations that touch tenant rows need a
superuser/BYPASSRLS migrator; the runner warns otherwise. Backfills are jobs, not migrations.

## Testing

`*.test.ts` need no database. `*.integration.test.ts` start Postgres 18 via Testcontainers;
set `FUNDROOM_TEST_PG_IMAGE=postgres:16-alpine` to exercise the `uuidv7()` shim. `@fundroom/db/testing`
exports `startPostgres()` for other packages' integration tests.
