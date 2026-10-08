import type pg from "pg";

/*
 * Running one operator statement as `seedhost_host` (E2.10; migrations/core/0015_break_glass.sql).
 *
 * What this is and is not. `seedhost_host` bypasses row-level security, so a statement run here
 * sees every workspace, not only the session's: the session names the workspace whose owners are
 * told and whose audit chain records every statement, it does not fence the query. Nor is it a
 * boundary against the operator — whoever can run the CLI holds DATABASE_URL, which on a default
 * install is a superuser. What the path guarantees is that the *sanctioned* way in is time-boxed,
 * ticketed, read-only unless asked, audited before it runs, and that what the audit says ran is
 * what ran, as `seedhost_host`:
 *
 *  - Postgres decides what the statement is, not a hand-written lexer: the text must PREPARE
 *    (`PREPARE … AS <text>`, sent over the extended protocol, which refuses a second statement).
 *    PREPARE accepts exactly SELECT/VALUES/TABLE/WITH and INSERT/UPDATE/DELETE/MERGE, so DO,
 *    CALL, SET/RESET, COPY, DDL, EXPLAIN and transaction control never run — however they are
 *    wrapped in comments. `vetBreakGlassStatement` does this before anything is recorded; the
 *    run does it again inside its own transaction. `leadingKeyword` is only a label and a hint.
 *  - one transaction per statement: `SET TRANSACTION READ ONLY` first (unless `write`), then
 *    `SET LOCAL ROLE seedhost_host`, a statement timeout that never outlives the session window,
 *    the tenant GUCs of the session's workspace, and a re-check of the session (active, not
 *    closed, unexpired by the database clock);
 *  - the statement runs inside `core.break_glass_exec()`, a SECURITY DEFINER function owned by
 *    seedhost_host. Postgres refuses to change `role` or `session_authorization` inside a
 *    security-definer frame — directly, through `set_config()`, or through SQL run by
 *    `query_to_xml()` — so the statement cannot step back to the (superuser) session user and
 *    return before anyone looks;
 *  - afterwards the transaction must still be `seedhost_host`, read-only unless `write`, and in
 *    the session's workspace (a session-level `set_config` survives the function); otherwise it
 *    is reported as escaped and rolled back. A read-only transaction is always rolled back.
 *  - seedhost_host cannot write its own evidence: the session log, the audit chain and access
 *    reviews refuse it (`core.break_glass_refuse`).
 *
 * Rows come back as JSON (`row_to_json`): integers beyond 2^53 are kept as strings, timestamps
 * are ISO-8601 text.
 */

export const HOST_ROLE = "seedhost_host";

export interface HostRoleStatus {
  readonly ok: boolean;
  /** Present when `ok` is false: what is wrong, in words an operator can act on. */
  readonly problem?: string;
}

/**
 * Fails closed on anything but the exact shape 0015 creates: the role exists, bypasses RLS, is
 * NOLOGIN and not a superuser, carries seedhost_app's privileges, and the connected user may
 * switch to it.
 */
export async function hostRoleStatus(pool: pg.Pool): Promise<HostRoleStatus> {
  const r = await pool.query<{
    bypass: boolean;
    super: boolean;
    login: boolean;
    can_set: boolean;
    has_app: boolean;
    exec_owner: string | null;
    exec_definer: boolean | null;
    app_can_exec: boolean | null;
  }>(
    `SELECT r.rolbypassrls AS bypass, r.rolsuper AS super, r.rolcanlogin AS login,
            pg_has_role(current_user, r.oid, 'SET') AS can_set,
            (SELECT pg_has_role(r.oid, a.oid, 'USAGE') FROM pg_roles a WHERE a.rolname = 'seedhost_app') AS has_app,
            f.proowner::regrole::text AS exec_owner, f.prosecdef AS exec_definer,
            CASE WHEN f.oid IS NULL THEN NULL
                 ELSE has_function_privilege('seedhost_app', f.oid, 'EXECUTE') END AS app_can_exec
       FROM pg_roles r
       LEFT JOIN pg_proc f ON f.oid = to_regprocedure('core.break_glass_exec(text, boolean, integer)')
      WHERE r.rolname = $1`,
    [HOST_ROLE],
  );
  const row = r.rows[0];
  const fix = 'see docs/runbooks/break-glass.md ("Managed Postgres")';
  if (row === undefined) {
    return {
      ok: false,
      problem: `role ${HOST_ROLE} is missing: the migrating user could not create a BYPASSRLS role; ${fix}`,
    };
  }
  if (!row.bypass) return { ok: false, problem: `role ${HOST_ROLE} lacks BYPASSRLS; ${fix}` };
  if (row.super) return { ok: false, problem: `role ${HOST_ROLE} must not be a superuser; ${fix}` };
  if (row.login) return { ok: false, problem: `role ${HOST_ROLE} must be NOLOGIN; ${fix}` };
  if (row.has_app !== true) {
    return { ok: false, problem: `role ${HOST_ROLE} does not inherit seedhost_app; ${fix}` };
  }
  if (!row.can_set) {
    return {
      ok: false,
      problem: `the database user of DATABASE_URL may not SET ROLE ${HOST_ROLE}; ${fix}`,
    };
  }
  if (row.exec_owner !== HOST_ROLE || row.exec_definer !== true || row.app_can_exec !== false) {
    return {
      ok: false,
      problem: `core.break_glass_exec() must be a SECURITY DEFINER function owned by ${HOST_ROLE} that seedhost_app cannot execute; ${fix}`,
    };
  }
  return { ok: true };
}

const WRITE_VERBS = new Set(["insert", "update", "delete", "merge"]);

/**
 * The first keyword after leading whitespace, comments (nested, as Postgres nests them) and
 * parentheses; lower case. A label for the audit trail and the `--write` hint only: whether a
 * statement may run at all is decided by Postgres (`vetBreakGlassStatement`).
 */
export function leadingKeyword(text: string): string {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (/[\s(]/u.test(c)) {
      i += 1;
    } else if (text.startsWith("--", i)) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl + 1;
    } else if (text.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      if (depth > 0) return "";
    } else {
      break;
    }
  }
  return (/^[A-Za-z_]+/u.exec(text.slice(i))?.[0] ?? "").toLowerCase();
}

export const BREAK_GLASS_MAX_SQL_BYTES = 64 * 1024;

export class BreakGlassStatementError extends Error {
  override readonly name = "BreakGlassStatementError";
  constructor(
    /**
     * `commit_unknown`: the statement ran and COMMIT was sent, but the connection failed before
     * the answer came — the write may or may not have committed. `result` is what it reported.
     */
    readonly code: "refused" | "session_closed" | "escaped" | "failed" | "commit_unknown",
    message: string,
    readonly result?: BreakGlassStatementResult | undefined,
  ) {
    super(message);
  }
}

/**
 * The cheap checks that need no database: size, emptiness, and a DML verb without `write`
 * (a hint — a DML hidden in a CTE is stopped by the read-only transaction instead). Returns the
 * statement's leading keyword as a label. Not a gate: `vetBreakGlassStatement` is.
 */
export function checkBreakGlassStatement(text: string, write: boolean): string {
  if (Buffer.byteLength(text, "utf8") > BREAK_GLASS_MAX_SQL_BYTES) {
    throw new BreakGlassStatementError("refused", "the statement is larger than 64 KiB");
  }
  if (text.trim() === "") throw new BreakGlassStatementError("refused", "the statement is empty");
  const verb = leadingKeyword(text);
  if (WRITE_VERBS.has(verb) && !write) {
    throw new BreakGlassStatementError(
      "refused",
      `${verb.toUpperCase()} changes data: pass --write (the owners are told)`,
    );
  }
  return verb;
}

const PREPARED = "break_glass_stmt";

/** Extended protocol: exactly one statement (`queryMode` is honoured by pg ≥ 8.12, not typed). */
function extended(text: string, values?: unknown[]): pg.QueryConfig {
  return { text, values, queryMode: "extended" } as unknown as pg.QueryConfig;
}

export interface VettedStatement {
  /** The statement produces rows (a query, or DML with RETURNING). */
  readonly returnsRows: boolean;
}

/**
 * Has Postgres parse the statement as the body of a PREPARE on `client` (inside the caller's
 * transaction, as seedhost_host). Parse analysis runs nothing. A syntax error — which is what
 * DO, CALL, SET, COPY, DDL, EXPLAIN, transaction control and a second statement all are here —
 * is `refused`; any other error (an unknown table, a type error) is `failed`.
 */
async function prepareOn(client: pg.PoolClient, text: string): Promise<VettedStatement> {
  try {
    await client.query(extended(`PREPARE ${PREPARED} AS ${text}`));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "42601") {
      throw new BreakGlassStatementError(
        "refused",
        `break-glass runs exactly one SELECT, VALUES, TABLE, WITH, INSERT, UPDATE, DELETE or MERGE statement (${message})`,
      );
    }
    throw new BreakGlassStatementError("failed", message);
  }
  const r = await client.query<{ returns_rows: boolean }>(
    "SELECT result_types IS NOT NULL AS returns_rows FROM pg_prepared_statements WHERE name = $1",
    [PREPARED],
  );
  await client.query(`DEALLOCATE ${PREPARED}`);
  return { returnsRows: r.rows[0]?.returns_rows === true };
}

/**
 * Checks, before anything is recorded, that Postgres accepts `text` as one preparable statement
 * (see `prepareOn`). Runs in a read-only transaction as seedhost_host that is always rolled
 * back, on a connection that is then discarded.
 */
export async function vetBreakGlassStatement(
  pool: pg.Pool,
  text: string,
): Promise<VettedStatement> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL ROLE ${HOST_ROLE}`);
    return await prepareOn(client, text);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release(true);
  }
}

/** JSON rows from Postgres: an integer too large for a JS number stays its exact text. */
function parseRow(json: string): Record<string, unknown> {
  const reviver = (_key: string, value: unknown, context?: { source?: string }): unknown =>
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    context?.source !== undefined &&
    /^-?\d+$/u.test(context.source)
      ? context.source
      : value;
  return JSON.parse(json, reviver as (key: string, value: unknown) => unknown) as Record<
    string,
    unknown
  >;
}

export interface RunBreakGlassStatementInput {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly sql: string;
  readonly write: boolean;
  /** Upper bound; the session's remaining window lowers it. Default 60 s. */
  readonly statementTimeoutMs?: number | undefined;
  /** Rows returned to the caller (the statement itself is not limited). Default 1000. */
  readonly maxRows?: number | undefined;
}

export interface BreakGlassStatementResult {
  readonly command: string;
  readonly rowCount: number;
  readonly fields: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** Runs one statement on a dedicated pool connection (the caller holds no transaction). */
export async function runBreakGlassStatement(
  pool: pg.Pool,
  input: RunBreakGlassStatementInput,
): Promise<BreakGlassStatementResult> {
  const verb = checkBreakGlassStatement(input.sql, input.write);
  const maxRows = Math.max(1, Math.floor(input.maxRows ?? 1000));
  const ceilingMs = Math.max(1, Math.floor(input.statementTimeoutMs ?? 60_000));
  const client = await pool.connect();
  let inTx = false;
  try {
    await client.query("BEGIN");
    inTx = true;
    if (!input.write) await client.query("SET TRANSACTION READ ONLY");
    await client.query(`SET LOCAL ROLE ${HOST_ROLE}`);
    await client.query(
      `SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_kind', 'system', true),
              set_config('app.membership_id', '', true), set_config('app.user_id', '', true)`,
      [input.workspaceId],
    );
    const check = await client.query<{ open: boolean; ws: string; remaining_ms: string }>(
      `SELECT (notified_at IS NOT NULL AND closed_at IS NULL AND now() < expires_at) AS open,
              workspace_id::text AS ws,
              floor(extract(epoch FROM (expires_at - now())) * 1000)::bigint AS remaining_ms
         FROM core.break_glass_session WHERE id = $1`,
      [input.sessionId],
    );
    const s = check.rows[0];
    if (s === undefined || !s.open || s.ws !== input.workspaceId) {
      throw new BreakGlassStatementError(
        "session_closed",
        "the break-glass session is closed, expired or not yet active",
      );
    }
    const timeoutMs = Math.max(1, Math.min(ceilingMs, Number(s.remaining_ms)));
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}ms'`);

    // Postgres's own parser decides, in this transaction, on exactly this text.
    const { returnsRows } = await prepareOn(client, input.sql);

    const started = performance.now();
    let out: pg.QueryResult<{ r: string }>;
    try {
      out = await client.query<{ r: string }>(
        extended("SELECT r FROM core.break_glass_exec($1, $2, $3) AS r", [
          input.sql,
          returnsRows,
          maxRows,
        ]),
      );
    } catch (error) {
      throw new BreakGlassStatementError(
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    const durationMs = Math.round(performance.now() - started);

    const after = await client.query<{ who: string; ro: string; ws: string }>(
      `SELECT current_user::text AS who, current_setting('transaction_read_only') AS ro,
              current_setting('app.workspace_id', true) AS ws`,
    );
    const a = after.rows[0];
    if (
      a === undefined ||
      a.who !== HOST_ROLE ||
      a.ws !== input.workspaceId ||
      (!input.write && a.ro !== "on")
    ) {
      throw new BreakGlassStatementError(
        "escaped",
        "the statement changed the transaction's role, read-only mode or tenant context; rolled back",
      );
    }
    const texts = out.rows.map((row) => row.r);
    const total = Number(texts.pop() ?? "0");
    const rows = texts.map(parseRow);
    const result: BreakGlassStatementResult = {
      command: returnsRows && !WRITE_VERBS.has(verb) ? "SELECT" : verb.toUpperCase(),
      rowCount: total,
      fields: rows[0] === undefined ? [] : Object.keys(rows[0]),
      rows,
      truncated: total > rows.length,
      durationMs,
    };
    if (input.write) {
      inTx = false;
      try {
        await client.query("COMMIT");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A server-side refusal (a deferred constraint, a serialization failure) rolled back; a
        // connection that failed after COMMIT was sent leaves the outcome unknown.
        if (typeof (error as { code?: unknown }).code === "string") {
          throw new BreakGlassStatementError("failed", message);
        }
        throw new BreakGlassStatementError(
          "commit_unknown",
          `the connection failed during COMMIT; the write may have been committed (${message})`,
          result,
        );
      }
    } else {
      await client.query("ROLLBACK");
      inTx = false;
    }
    return result;
  } finally {
    if (inTx) await client.query("ROLLBACK").catch(() => {});
    // Never hand a connection that ran operator SQL back to the pool: whatever it did to its
    // session (a session-level set_config in a committed write, a temporary table) dies with it.
    client.release(true);
  }
}
