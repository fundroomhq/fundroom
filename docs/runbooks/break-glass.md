# Runbook: break-glass access to a tenant's data

Break-glass is the host operator's one sanctioned way to look at (or, rarely, change) a workspace's rows past row-level security. It exists for the cases the product cannot handle from inside: a tenant's data is in a state no screen can show, a migration or import went wrong in one workspace, a security investigation needs the raw rows. It is **ticketed, time-boxed to at most one hour, read-only unless you say otherwise, recorded in the tenant's own audit log, and announced to the tenant's owners by email**.

Reference material: `apps/server/src/cli-commands/break-glass.ts` (the command and its audit trail), `packages/db/src/break-glass/host.ts` (how a statement is run), `packages/db/migrations/core/0015_break_glass.sql` (the role, the session table, the guard triggers and `core.break_glass_exec()`). Their header comments are part of this runbook.

## Before you start: is this the right tool?

Use break-glass only when **all** of these hold:

- There is a **ticket** — a support request from the tenant, an incident, a security investigation — and it names the workspace. No ticket, no session. The reference is recorded and shown to the tenant's owners, so make it one they can quote back to you (`SUP-1432`, `INC-2026-09-23-01`, or a URL to the issue).
- The question **cannot be answered from the product**: the audit export (`fundroom audit verify`, the admin audit screen, the signed export), `fundroom workspace export`, the jobs DLQ, the doctor, the logs.
- You can say **why** in one sentence the owners will read (`--reason`). "Debugging" is not a reason; "Customer reports 12 documents missing after the 21 Sep import; checking dataroom.document rows" is.

Things break-glass is **not** for: routine support you could do by asking the owner to share their screen, looking around, anything on a workspace you have no ticket for, and changing data you could change through the product. If you are about to use `--write`, stop and ask whether a code fix, a migration or a documented CLI command would be the honest way to do it.

## What the tenant sees

- **Every active or dormant owner gets an email** when the session opens: the ticket, your reason, the operator name, and when the session ends at the latest. It goes on the transactional stream, so a suppressed or bounced address does not silence it (a hard provider rejection is still a failure; see below). Owners get a second email after every `--write` statement that committed — or whose COMMIT outcome is unknown because the connection failed while committing — with the verb, the number of rows affected, and the statement's SHA-256. That mail goes out even if recording the statement's result in the audit log failed.
- **Their audit log** (admin → Audit, and every export) gets, with `actor_kind = host`:

  | Action | When | Meta |
  |---|---|---|
  | `host.break_glass` | the session opened | `ticket`, `reason`, `operator`, `osUser`, `sessionId`, `openedAt`, `expiresAt` |
  | `host.break_glass_notified` | owners were emailed (after open, after each write) | `recipients`, `delivered`, `failed` |
  | `host.break_glass_statement` | **before** each statement runs | `sha256`, `bytes`, `verb`, `write`, `statement` (its number in the session) |
  | `host.break_glass_result` | after it ran | outcome `success`/`failure`, `command`, `rowCount`, `durationMs`, and `error` on failure (`failed`, `escaped`, `session_closed`, `commit_unknown`) |
  | `host.break_glass_closed` | `close`, or an open that notified nobody | `statements`, `writes`, `closeReason` |

  The tenant's log carries the statement's **fingerprint, not its text**: an operator's SQL can contain literals from *other* workspaces (an email address, an id), and one tenant's log must not leak another's data. The **platform chain** (`fundroom audit verify` covers it; tenants cannot read it) carries the same rows plus the statement text (first 16 KiB). When an owner quotes a fingerprint, find the statement there.
- **`core.break_glass_session`** holds one row per session; the workspace's staff can read their own rows (RLS), nobody else's.

## Commands

The image's entrypoint is the `fundroom` CLI. In the reference Compose stack run it as a one-off container (`docker compose run --rm app …`); on Kubernetes, `kubectl -n <ns> exec deploy/<fullname>-server -- /nodejs/bin/node /app/dist/cli.js …` (distroless, no shell). Below, `fundroom` stands for either.

**1. Open a session** (prints the session id on stdout, the details on stderr):

```
fundroom break-glass open --workspace acme --ticket SUP-1432 \
  --reason "Customer reports 12 documents missing after the 21 Sep import; checking dataroom rows" \
  --minutes 30 --operator "Nora Jensen"
```

- `--workspace` takes the slug or the id of a live workspace. A soft-deleted workspace must be restored first (`fundroom workspace restore`), which is itself audited.
- `--minutes` is 1–60; default 60. The window is computed by **Postgres** (`expires_at = now() + …`), and every statement is checked against Postgres's clock, so your laptop's clock does not matter. There is no "extend": open a new session, which mails the owners again.
- `--operator` is the human name recorded and mailed; without it the OS user is used. The OS user (`$SUDO_USER`, else the login name) is recorded either way.
- The session is created **pending** and only becomes usable after the opening is in both audit chains and the owners were mailed. If the command dies in between (a crash, a kill, an audit write that fails), the session stays pending — `list` shows `pending` — and no statement can run on it; open a new one.
- If owners exist and **not one** notification could be delivered, the session is closed on the spot (`closeReason: notification_failed`) and the command exits 1: access nobody was told about does not start. Fix outbound mail (`fundroom doctor`, the setup wizard's mail probe) and open again. If the workspace has **no** owner with an email address, the session opens with a warning and `recipients: 0` in the log — restoring an owner may be exactly what the ticket is for.

**2. Run statements**, one per call:

```
fundroom break-glass sql --session <id> --query "SELECT id, name, deleted_at FROM dataroom.document WHERE workspace_id = '<ws id>' ORDER BY created_at DESC LIMIT 50"
fundroom break-glass sql --session <id> --file /tmp/q.sql --format table
```

With Compose, mount the file: `docker compose run --rm -v "$PWD/q.sql:/tmp/q.sql:ro" app break-glass sql --session <id> --file /tmp/q.sql`.

- **Read-only by default.** The transaction is `READ ONLY`; a statement whose first keyword is `INSERT`/`UPDATE`/`DELETE`/`MERGE` is refused unless you pass `--write`, and DML hidden in a CTE fails on the read-only transaction.
- **Only queries and DML — Postgres decides.** Before anything is recorded, Postgres itself parses the text as the body of a `PREPARE` (over the extended protocol, so exactly one statement). That accepts `SELECT`, `VALUES`, `TABLE`, `WITH`, `INSERT`, `UPDATE`, `DELETE` and `MERGE` and nothing else: transaction control, `SET`/`RESET`, `DO`, `CALL`, `COPY`, DDL, `GRANT`, `EXPLAIN` and `SHOW` are refused (exit 2) however they are dressed up in comments. For a setting use `SELECT current_setting('…')`. The run repeats the check in its own transaction.
- **Always filter by workspace yourself.** `seedhost_host` bypasses RLS: a query without `WHERE workspace_id = …` reads every tenant on the instance, and the session only makes that visible to the one tenant it names. The tenant GUCs (`app.workspace_id`, actor `system`) are set to the session's workspace for functions that read them, but they fence nothing.
- Each statement has a timeout of 60 s or the time left in the session, whichever is shorter. Output is JSON (`command`, `rowCount`, `fields`, `rows`, `truncated`) or `--format table`; `--max-rows` (default 1000) limits what is printed, not what runs. Rows are Postgres's `row_to_json`: timestamps are ISO-8601 text, integers beyond 2^53 are strings, `bytea` is `\x…` text, and `fields` is empty when no row came back. `command` is the statement's leading keyword (`SELECT` for a query).
- Exit codes: 0 ran; 1 refused by the session (closed/expired), failed, or escaped; 2 usage or a refused statement.
- The statement runs inside `core.break_glass_exec()`, a `SECURITY DEFINER` function owned by `seedhost_host`. Inside it Postgres refuses any change of `role` or `session_authorization` — `set_config('role', …)`, the same through `query_to_xml(…)` — so a statement cannot step back to the (superuser) database user and return before the check. A statement that still leaves the transaction in another role, out of read-only mode or in another tenant context (a session-level `set_config`) is rolled back and recorded as `error: escaped`. The connection that ran operator SQL is never returned to the pool.
- `seedhost_host` cannot write the evidence of its own use: `core.break_glass_session`, `audit.event`, `audit.checkpoint`, `audit.anchor` and `core.access_review` refuse it (`break_glass_refuse` triggers), even with `--write`.

**3. Close it** as soon as you are done — do not wait for the window to run out:

```
fundroom break-glass close --session <id>
```

**4. List sessions**: `fundroom break-glass list [--workspace acme] [--since 2026-09-01] [--json]`.

## After the session

1. Write in the ticket what you looked at, what you found and what (if anything) you changed, with the session id and the fingerprints of any `--write` statements.
2. Tell the owners the outcome, quoting the ticket. They already have the notification; a human follow-up is what makes it trustworthy.
3. `fundroom audit verify --workspace <id>` must still say `OK`.

## Reviewing break-glass use

Monthly (and for every SOC 2 period), the security owner runs:

```
fundroom evidence break-glass --since 2026-09-01 > break-glass-2026-09.json
fundroom evidence operators > operators-2026-09.json
```

and checks: every session has a ticket that exists and names that workspace; no session stayed open past its window without a `close` (state `expired` is acceptable but worth a word with the operator); every `writes > 0` session has a written justification in its ticket; the platform chain verifies (`fundroom audit verify`); and `operators.json` lists no member of `seedhost_host` other than the database user the app runs as. See `docs/compliance/soc2-evidence.md`.

## The trust model, honestly

Break-glass makes the **sanctioned** path accountable. It is not a boundary against the operator: whoever can run the CLI holds `DATABASE_URL`, which on the reference Compose install is a Postgres superuser that could also open `psql` and do anything unrecorded. The controls against that are organisational (who holds the credential, the host's own access log, the infrastructure provider's audit trail) plus the audit chain's tamper evidence: rows deleted or edited by hand break the hash chain, and the daily checkpoints — HMAC-signed with a key derived from the key ring in the environment, not the database — make even a re-computed chain detectable by `fundroom audit verify`. An operator who also holds the key ring can defeat that too; external anchors (`audit.anchor`) that would take "not even the operator" further are not implemented yet. What break-glass adds is that using the database for a tenant's data *the right way* is cheap, visible to the tenant, and leaves an evidence trail an auditor can sample.

Specifically, `seedhost_host`:

- is `NOLOGIN` — nothing connects as it; the CLI switches to it with `SET LOCAL ROLE` inside one transaction per statement;
- has **seedhost_app's privileges, by membership** — every module schema's grants reach it automatically, and every revocation binds it too (audit tables are `SELECT`/`INSERT` only, access reviews and break-glass sessions cannot be deleted) — minus writes to the evidence tables listed above, which triggers refuse it;
- adds exactly one thing: `BYPASSRLS`, which is a role attribute and is never inherited — only a transaction that has switched to `seedhost_host` bypasses RLS. The application never does.

## What it does not protect against

Break-glass makes the sanctioned path honest; it does not make the operator harmless. Known limits:

- **The credential.** Whoever runs the CLI holds `DATABASE_URL` — usually a superuser — and can open `psql` and do anything, unrecorded. Only the audit chain's tamper evidence (above) and the organisational controls on that credential cover this.
- **Every workspace is readable.** `seedhost_host` bypasses RLS; the session's workspace is the one that is *told*, not the one that is *fenced*. A read of another tenant's rows shows up only in the platform chain's copy of the statement text; that tenant is not notified. Likewise a `--write` can change rows of any workspace, and only the session's owners are mailed.
- **What a statement may call.** A statement can call every function `seedhost_app` may execute, including the kernel's fixed-purpose `SECURITY DEFINER` helpers (audit partition maintenance, the admin-surface and import-guard checks), which run with their owner's rights. None of them executes caller-supplied SQL; a future `SECURITY DEFINER` function that did — or an installed `dblink`/`postgres_fdw` usable by `seedhost_app` — would be a way out of `seedhost_host`, so review new ones with this in mind.
- **Resources.** A statement may hold locks and burn CPU and I/O for up to 60 s (or the rest of the window); a `--write` can take row locks the application then waits on.
- **Evidence tables other than the five listed** (for example a module's own history table) are ordinary tables to a `--write` statement.
- **The operator's identity** is what `--operator` says plus the OS user (`$SUDO_USER` or the login name), both of which the operator controls. Who actually ran the command is attested by the host's own access log, not by break-glass.
- **Notification** means the mail provider accepted the message, not that an owner read it. A workspace with no owner with an email address opens with `recipients: 0` and nobody is told.
- **Partial trails.** If recording a statement's result fails, the pre-run `host.break_glass_statement` row is there, the result row is not, and the command exits non-zero (owners are still mailed for a write). If the connection fails during COMMIT, the result is `commit_unknown` and the owners are told the write may have happened: check the data before retrying.
- **Output leaves the database.** Rows printed on stdout land in the operator's terminal, scrollback and any CI or shell log. Treat them as the tenant's data.

## Managed Postgres: creating the role by hand

Creating a `BYPASSRLS` role needs a superuser, or on PostgreSQL 16+ a `CREATEROLE` role that has `BYPASSRLS` itself. Managed services (RDS, Cloud SQL, Azure, Neon, Supabase, …) usually give the migrating user neither. Migration `0015_break_glass` then prints a `NOTICE` and carries on: the session table exists, and every `break-glass` command refuses with `break-glass is unavailable: role seedhost_host is missing …`. `fundroom evidence operators` shows `"available": false`.

If your provider lets an administrator create such a role (some do through a privileged admin role or a support request), run as that administrator, replacing `<app_user>` with the user in `DATABASE_URL`:

```sql
CREATE ROLE seedhost_host NOLOGIN INHERIT BYPASSRLS;
GRANT seedhost_app TO seedhost_host WITH INHERIT TRUE;
GRANT seedhost_host TO <app_user> WITH INHERIT FALSE, SET TRUE;
ALTER FUNCTION core.break_glass_exec(text, boolean, integer) OWNER TO seedhost_host;
REVOKE ALL ON FUNCTION core.break_glass_exec(text, boolean, integer) FROM PUBLIC, seedhost_app;
```

The CLI checks this exact shape before every `open` and `sql` (exists, `BYPASSRLS`, not superuser, `NOLOGIN`, inherits `seedhost_app`, the connected user may `SET ROLE` to it, and `core.break_glass_exec()` is a `SECURITY DEFINER` function owned by `seedhost_host` that `seedhost_app` cannot execute) and refuses otherwise. If the provider cannot create a `BYPASSRLS` role at all, break-glass is unavailable on that install; use the provider's own audited database access instead, and record the ticket and the tenant notification by hand.

Never give `seedhost_host` `LOGIN`, and never make it a superuser: the CLI refuses both, because either would let someone use it outside the recorded path.
