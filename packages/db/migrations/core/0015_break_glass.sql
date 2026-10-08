-- 0015_break_glass — the host operator's break-glass role and session log (EXECUTION_PLAN §10
-- Audit row, §15 E2.10; design/02 §"Break-glass": "host-operator role with BYPASSRLS usable only
-- via CLI with a ticket reference, time-boxed (1 h), fully audited, alerts sent to tenant owners").
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/break-glass.ts; the CLI is
-- `seedhost break-glass` (apps/server/src/cli-commands/break-glass.ts) over src/break-glass/.
--
--  * seedhost_host          NOLOGIN, BYPASSRLS. Nothing connects as it: the CLI switches to it
--                           with `SET LOCAL ROLE` inside one transaction per statement, exactly
--                           like withTenant() switches to seedhost_app. Its table privileges are
--                           seedhost_app's, by membership (INHERIT) rather than by copied GRANTs,
--                           so every schema a module migration grants to seedhost_app later —
--                           including its ALTER DEFAULT PRIVILEGES — reaches break-glass without
--                           this file knowing about it, and every REVOKE (audit tables are
--                           SELECT/INSERT only, access reviews are append-only) binds it too. The
--                           one thing it adds is BYPASSRLS, which is a role attribute and is never
--                           inherited: only a transaction that has switched to seedhost_host
--                           itself bypasses row security. Reads are the default: the CLI runs
--                           every statement READ ONLY unless the operator passes --write.
--  * break_glass_session    one row per `break-glass open`: ticket, reason, operator, a window of
--                           at most one hour computed from the database clock, and counters the
--                           CLI bumps before each statement. The trigger refuses a statement on a
--                           closed or expired session, so the time box is enforced by Postgres,
--                           never by the operator's clock. A session starts *pending*
--                           (`notified_at IS NULL`) and is usable only once the CLI has recorded
--                           it and told the owners; a crash in between leaves it unusable.
--  * break_glass_exec()     the only way an operator statement runs: SECURITY DEFINER, owned by
--                           seedhost_host. Inside a security-definer function Postgres refuses to
--                           change `role` or `session_authorization` (also through set_config()
--                           or query_to_xml()), so a statement cannot leave seedhost_host and come
--                           back to the superuser DATABASE_URL usually is.
--  * break_glass_refuse     seedhost_host may not write the evidence break-glass itself produces:
--                           its session log, the audit chain, access reviews.
--
-- Creating a BYPASSRLS role needs a superuser (or, on PostgreSQL 16+, a CREATEROLE role that has
-- BYPASSRLS itself). Managed Postgres usually gives neither. The role section therefore tries and,
-- when refused, only raises a NOTICE: the migration succeeds, the session table exists, and the
-- CLI refuses to open a session ("seedhost_host is missing …") until a DBA creates the role with
-- the SQL in docs/runbooks/break-glass.md. Fail closed, never half-privileged.

--> statement-breakpoint
-- 1. The role. Kept in its own statement so the migration test can run it as a non-superuser.
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seedhost_host') THEN
    BEGIN
      CREATE ROLE seedhost_host NOLOGIN INHERIT BYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'seedhost_host was not created (%): break-glass stays unavailable until a DBA creates it, see docs/runbooks/break-glass.md', SQLERRM;
      RETURN;
    END;
  END IF;
  -- seedhost_app's privileges, inherited. (Needs ADMIN on seedhost_app, which its creator has.)
  BEGIN
    GRANT seedhost_app TO seedhost_host WITH INHERIT TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'could not grant seedhost_app to seedhost_host (%); see docs/runbooks/break-glass.md', SQLERRM;
  END;
  -- The migrating user (the one DATABASE_URL names) may switch to it; it does not inherit it,
  -- so nothing the application does outside `SET LOCAL ROLE seedhost_host` changes.
  BEGIN
    EXECUTE format('GRANT seedhost_host TO %I WITH INHERIT FALSE, SET TRUE', current_user);
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'could not grant seedhost_host to % (%); see docs/runbooks/break-glass.md', current_user, SQLERRM;
  END;
END
$do$;

--> statement-breakpoint
-- 2. The session log.
CREATE TABLE core.break_glass_session (
  id uuid PRIMARY KEY DEFAULT core.uuidv7(),
  workspace_id uuid NOT NULL REFERENCES core.workspace (id) ON DELETE CASCADE,
  -- The ticket / incident reference the access is justified by: printable ASCII, no spaces.
  ticket text NOT NULL,
  reason text NOT NULL,
  -- Who: the name the operator gave (--operator, else the OS user) and the OS user regardless.
  operator text NOT NULL,
  os_user text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Set once, by the CLI, after the opening is recorded in both chains and the owners were
  -- told; NULL = pending: no statement runs (claim and run both require it).
  notified_at timestamptz,
  closed_at timestamptz,
  -- 'closed' (break-glass close) | 'notification_failed' (no owner could be told; see the CLI)
  close_reason text,
  statements integer NOT NULL DEFAULT 0,
  writes integer NOT NULL DEFAULT 0,
  last_statement_at timestamptz,
  CONSTRAINT break_glass_session_ticket_shape CHECK (ticket ~ '^[!-~]{3,128}$'),
  CONSTRAINT break_glass_session_reason_length CHECK (
    char_length(btrim(reason)) BETWEEN 10 AND 1000
  ),
  CONSTRAINT break_glass_session_operator_shape CHECK (
    char_length(operator) BETWEEN 1 AND 128 AND operator !~ '[[:cntrl:]]'
    AND char_length(os_user) BETWEEN 1 AND 128 AND os_user !~ '[[:cntrl:]]'
  ),
  CONSTRAINT break_glass_session_window CHECK (
    expires_at > opened_at AND expires_at <= opened_at + interval '1 hour'
  ),
  CONSTRAINT break_glass_session_closed_shape CHECK (
    (closed_at IS NULL) = (close_reason IS NULL)
    AND (closed_at IS NULL OR closed_at >= opened_at)
    AND (close_reason IS NULL OR close_reason IN ('closed', 'notification_failed'))
  ),
  CONSTRAINT break_glass_session_counts CHECK (statements >= 0 AND writes BETWEEN 0 AND statements),
  CONSTRAINT break_glass_session_notified_shape CHECK (
    (notified_at IS NULL OR notified_at >= opened_at) AND (statements = 0 OR notified_at IS NOT NULL)
  )
);
-- A workspace's history, newest first; the instance-wide evidence listing.
CREATE INDEX break_glass_session_ws_idx ON core.break_glass_session (workspace_id, opened_at DESC);
CREATE INDEX break_glass_session_opened_idx ON core.break_glass_session (opened_at DESC);

-- Append-only in effect: the facts of an opening never change; a session is closed at most once;
-- the counters only grow and only while the session is open and unexpired by the database clock.
CREATE FUNCTION core.break_glass_session_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, core AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A new session is always a fresh, pending, unused one whose window starts now (by the
    -- database clock). Only a superuser (a DBA, a test fixture) may write history.
    IF NOT coalesce((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
      NEW.opened_at := now();
      NEW.notified_at := NULL;
      NEW.closed_at := NULL;
      NEW.close_reason := NULL;
      NEW.statements := 0;
      NEW.writes := 0;
      NEW.last_statement_at := NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.ticket IS DISTINCT FROM OLD.ticket
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.operator IS DISTINCT FROM OLD.operator
     OR NEW.os_user IS DISTINCT FROM OLD.os_user
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a break-glass session''s ticket, reason, operator and window are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'break-glass session % is closed', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.notified_at IS NOT NULL AND NEW.notified_at IS DISTINCT FROM OLD.notified_at THEN
    RAISE EXCEPTION 'break-glass session % is already active', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.notified_at IS NULL AND NEW.notified_at IS NOT NULL
     AND (NEW.closed_at IS NOT NULL OR now() >= OLD.expires_at) THEN
    RAISE EXCEPTION 'break-glass session % is closed or expired', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.statements < OLD.statements OR NEW.writes < OLD.writes THEN
    RAISE EXCEPTION 'break-glass counters only grow' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.statements > OLD.statements OR NEW.writes > OLD.writes)
     AND (NEW.closed_at IS NOT NULL OR now() >= OLD.expires_at OR OLD.notified_at IS NULL) THEN
    RAISE EXCEPTION 'break-glass session % is closed, expired or not yet active', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER break_glass_session_guard BEFORE INSERT OR UPDATE ON core.break_glass_session
  FOR EACH ROW EXECUTE FUNCTION core.break_glass_session_guard();

-- The core schema's default privileges grant DELETE; take it back (the workspace cascade still
-- removes the rows with the workspace, like access_review).
REVOKE DELETE ON core.break_glass_session FROM seedhost_app;

-- Row security. The fence admits the owning workspace, and the `host` actor for reading only
-- (the instance-wide `seedhost evidence` listings run in host context, like the outbox relay and
-- the custom-domain lookup); a host context can never write a row. Staff of the workspace may
-- read its sessions (the tenant-visible half of the design); only the `system` actor of the
-- workspace — which is what the CLI runs as — may open one or bump its counters. Externals match
-- no permissive policy.
ALTER TABLE core.break_glass_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.break_glass_session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_fence ON core.break_glass_session AS RESTRICTIVE FOR ALL
  USING (workspace_id = core.current_workspace() OR core.current_actor_kind() = 'host')
  WITH CHECK (workspace_id = core.current_workspace());
CREATE POLICY break_glass_session_read ON core.break_glass_session FOR SELECT
  USING (core.current_actor_kind() IN ('staff', 'system', 'host'));
CREATE POLICY break_glass_session_insert ON core.break_glass_session FOR INSERT
  WITH CHECK (core.current_actor_kind() = 'system');
CREATE POLICY break_glass_session_update ON core.break_glass_session FOR UPDATE
  USING (core.current_actor_kind() = 'system')
  WITH CHECK (core.current_actor_kind() = 'system');

--> statement-breakpoint
-- 3. seedhost_host may not write the evidence of its own use. Its privileges are seedhost_app's
-- by membership, and BYPASSRLS skips every policy, so without this a `--write` statement could
-- forge a session (for any workspace), close or bump one, or append a correctly chained audit
-- event that nobody could tell from a real one. A trigger is the only fence BYPASSRLS respects.
-- current_user is seedhost_host both after the CLI's role switch and inside core.break_glass_exec().
-- Row triggers on audit.event are cloned to every partition, present and future.
CREATE FUNCTION core.break_glass_refuse() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'seedhost_host' THEN
    RAISE EXCEPTION 'break-glass statements may not write %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_LEVEL = 'ROW' AND TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER break_glass_refuse BEFORE INSERT OR UPDATE OR DELETE ON core.break_glass_session
  FOR EACH ROW EXECUTE FUNCTION core.break_glass_refuse();
CREATE TRIGGER break_glass_refuse BEFORE INSERT OR UPDATE OR DELETE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION core.break_glass_refuse();
CREATE TRIGGER break_glass_refuse BEFORE INSERT OR UPDATE OR DELETE ON audit.checkpoint
  FOR EACH ROW EXECUTE FUNCTION core.break_glass_refuse();
CREATE TRIGGER break_glass_refuse BEFORE INSERT OR UPDATE OR DELETE ON audit.anchor
  FOR EACH ROW EXECUTE FUNCTION core.break_glass_refuse();
CREATE TRIGGER break_glass_refuse BEFORE INSERT OR UPDATE OR DELETE ON core.access_review
  FOR EACH ROW EXECUTE FUNCTION core.break_glass_refuse();

--> statement-breakpoint
-- 4. The statement runner. The CLI has already proven the text is ONE preparable statement
-- (`PREPARE … AS <text>` over the extended protocol, in the same transaction: SELECT, VALUES,
-- TABLE, WITH, INSERT, UPDATE, DELETE or MERGE — never DO, CALL, SET, COPY, DDL or transaction
-- control) and whether it returns rows (pg_prepared_statements.result_types). This function
-- then runs it as its owner, seedhost_host, inside a security-definer frame, where Postgres
-- refuses every change of `role` and `session_authorization`: that is what makes "the statement
-- ran as seedhost_host" true for a session user that is a superuser. Returned: up to `max_rows`
-- rows as JSON text, then one last row with the total row count. The statement itself is not
-- limited. The function's own search_path setting also scopes any transaction-local set_config()
-- the statement makes to the function, so it cannot leak into the caller's transaction.
CREATE FUNCTION core.break_glass_exec(stmt text, returns_rows boolean, max_rows integer)
RETURNS SETOF text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r record;
  n bigint := 0;
BEGIN
  IF current_user <> 'seedhost_host' THEN
    RAISE EXCEPTION 'core.break_glass_exec must be owned by seedhost_host'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF returns_rows THEN
    FOR r IN EXECUTE stmt LOOP
      n := n + 1;
      IF n <= max_rows THEN
        RETURN NEXT row_to_json(r)::text;
      END IF;
    END LOOP;
  ELSE
    EXECUTE stmt;
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  RETURN NEXT n::text;
END;
$$;
-- 0000's default privileges hand every core function to seedhost_app: never this one.
REVOKE ALL ON FUNCTION core.break_glass_exec(text, boolean, integer) FROM PUBLIC, seedhost_app;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seedhost_host') THEN
    BEGIN
      ALTER FUNCTION core.break_glass_exec(text, boolean, integer) OWNER TO seedhost_host;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'could not give core.break_glass_exec to seedhost_host (%); see docs/runbooks/break-glass.md', SQLERRM;
    END;
  END IF;
END
$do$;
