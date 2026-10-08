import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import {
  assertHostContext,
  assertTenantContext,
  HOST_CONTEXT,
  type HostContext,
  type TenantContext,
} from "./context.js";

/**
 * The only way to get a query handle (design/06 §3). Every call opens a transaction,
 * switches to the non-owner application role and sets the tenant context
 * transaction-locally, so pooled connections never carry state between tenants
 * (PgBouncer transaction mode safe) and RLS is enforced even for a superuser
 * DATABASE_URL (ADR-0025).
 */
export type Tx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly poolMax?: number;
  /** Idle timeout for pooled connections. Default 30 s. */
  readonly idleTimeoutMs?: number;
  /** Per-statement timeout applied inside every transaction. Default 30 s; 0 disables. */
  readonly statementTimeoutMs?: number;
  /** Application role switched to inside transactions. Default `seedhost_app`. */
  readonly appRole?: string;
  /** Set false to skip `SET LOCAL ROLE` (only for tests that create no role). */
  readonly switchRole?: boolean;
  /**
   * An *idle* pooled connection failed (the server restarted, a failover, an admin
   * `pg_terminate_backend`, a network drop). `pg` has already discarded the client and the next
   * checkout opens a fresh one, so this is information, not a failure to handle. Default: ignored.
   */
  readonly onIdleError?: ((error: Error) => void) | undefined;
  /**
   * Client-side bound on every query, in ms (E2.10 fault tests). Off by default.
   *
   * `statementTimeoutMs` is enforced by the *server*, so it bounds a slow statement and nothing
   * else: a connection whose replies stop arriving — a black-holed network path, a wedged proxy
   * or PgBouncer, a frozen database host that still ACKs TCP — hangs the query, the transaction,
   * the request and the pooled connection forever. Past this bound the connection is destroyed,
   * which fails the query (and the transaction's ROLLBACK, immediately) and makes the pool drop
   * the client instead of handing a wedged one to the next request.
   *
   * Tracks the transaction: a `SET [LOCAL] statement_timeout = N` (any unit, quoted or not)
   * inside it moves the bound to N + `clientTimeoutGraceMs` (so the server's own cancel always
   * arrives first), and `= 0` lifts it until COMMIT/ROLLBACK — the export/import snapshot path
   * relies on that. Savepoints are followed: `ROLLBACK TO SAVEPOINT` restores the bound in force
   * when the savepoint was taken, as the server restores the setting. Any other way of touching
   * the setting (`TO DEFAULT`, `set_config('statement_timeout', …)`, `RESET`) cannot be read
   * from the text, so it lifts the bound for the rest of the transaction: the client never cuts
   * off a statement the server might still allow.
   *
   * COMMIT and ROLLBACK always get the plain `clientTimeoutMs` (never lifted, never shortened):
   * the server's statement timeout does not bound a COMMIT (a synchronous-replication wait
   * ignores it), so without this a wedged COMMIT after `= 0` would hang forever. A COMMIT cut
   * off by the bound fails with `ClientTimeoutError` code `08007` (transaction resolution
   * unknown): the server may have committed. Callers must not blindly retry it.
   *
   * Leave it off for pools that run migrations: a long `CREATE INDEX` has no statement timeout.
   */
  readonly clientTimeoutMs?: number | undefined;
  /** Added to an in-transaction `SET LOCAL statement_timeout`. Default 1 s. */
  readonly clientTimeoutGraceMs?: number | undefined;
  /**
   * Bound on getting a connection: the TCP + startup handshake of a new one, and the wait for a
   * free one when the pool is exhausted. Default 0 (wait forever, `pg`'s default).
   */
  readonly connectionTimeoutMs?: number | undefined;
  /**
   * A connection failed *while checked out* (reset by the server, cut mid-query). The query
   * that was running has already been rejected with the same error and the pool discards the
   * client on release. Default: ignored.
   */
  readonly onActiveError?: ((error: Error) => void) | undefined;
}

export interface Database {
  /** Runs `fn` in a transaction fenced to one workspace. */
  withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` in a transaction with no workspace: global tables and the outbox only.
   * Pass `{ userId }` to also see that user's own membership rows (workspace switcher).
   */
  withHost<T>(fn: (tx: Tx, ctx: HostContext) => Promise<T>, ctx?: HostContext): Promise<T>;
  /** Cheap liveness check for /readyz. */
  ping(): Promise<boolean>;
  /** Migrations and pg-boss need the raw pool; application code must not. */
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

const ROLE_RE = /^[a-z_][a-z0-9_]*$/u;

/**
 * Drizzle wraps driver errors (`DrizzleQueryError` with the `pg` error as `cause`).
 * Walks the cause chain and returns the SQLSTATE, e.g. `23505` unique_violation,
 * `42501` insufficient_privilege (also raised for RLS `WITH CHECK` rejections).
 */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The innermost error message (the Postgres one when a driver error was wrapped). */
export function pgErrorMessage(error: unknown): string {
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    message = current.message;
    current = current.cause;
  }
  return message;
}

/**
 * A transaction ended because the client-side bound (`clientTimeoutMs`) destroyed its connection.
 * `code` is a SQLSTATE so `pgErrorCode` sees it: `08006` (connection failure) for a statement,
 * `08007` (transaction resolution unknown) for a COMMIT — the server may or may not have
 * committed. `cause` is what the driver or drizzle reported afterwards (typically "Client has
 * encountered a connection error and is not queryable" from the ROLLBACK drizzle attempts).
 */
export class ClientTimeoutError extends Error {
  override readonly name = "ClientTimeoutError";
  readonly code: "08006" | "08007";
  constructor(
    readonly phase: "statement" | "commit",
    readonly boundMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      phase === "commit"
        ? `COMMIT exceeded the ${boundMs} ms client-side bound; the transaction may or may not have committed`
        : `query exceeded the ${boundMs} ms client-side bound`,
      options,
    );
    this.code = phase === "commit" ? "08007" : "08006";
  }
}

const TIMEOUT_UNITS_MS: Record<string, number> = {
  us: 0.001,
  ms: 1,
  s: 1000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
const SET_STATEMENT_TIMEOUT_RE =
  /^\s*SET\s+(?:LOCAL\s+|SESSION\s+)?statement_timeout\s*(?:=|\bTO\b)\s*'?\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*'?\s*;?\s*$/iu;
/** A change of the setting the text does not let us read (a read of it is not one). */
const CHANGES_STATEMENT_TIMEOUT_RE =
  /(?:^\s*(?:SET|RESET)\b[\s\S]*\bstatement_timeout\b|^\s*RESET\s+ALL\b|\bset_config\s*\(\s*'statement_timeout')/iu;
const SET_CONFIG_RE = /\bset_config\s*\(/iu;
const BEGIN_RE = /^\s*(?:BEGIN|START\s+TRANSACTION)\b/iu;
/** Bare transaction ends only: `ROLLBACK TO SAVEPOINT` is not one. */
const TX_END_RE =
  /^\s*(COMMIT|END|ROLLBACK|ABORT)(?:\s+(?:WORK|TRANSACTION))?(?:\s+AND\s+(?:NO\s+)?CHAIN)?\s*;?\s*$/iu;
const SAVEPOINT_RE = /^\s*SAVEPOINT\s+("?)([^\s";]+)\1\s*;?\s*$/iu;
const RELEASE_RE = /^\s*RELEASE\s+(?:SAVEPOINT\s+)?("?)([^\s";]+)\1\s*;?\s*$/iu;
const ROLLBACK_TO_RE =
  /^\s*ROLLBACK\s+(?:WORK\s+|TRANSACTION\s+)?TO\s+(?:SAVEPOINT\s+)?("?)([^\s";]+)\1\s*;?\s*$/iu;

const KILLED = Symbol("fundroom.clientTimeoutKill");
interface KillRecord {
  readonly phase: "statement" | "commit";
  readonly boundMs: number;
}
/** The client-side bound that destroyed `client`'s connection, if any (and forgets it). */
function takeKill(client: unknown): KillRecord | undefined {
  const c = client as { [KILLED]?: KillRecord | undefined };
  const kill = c[KILLED];
  c[KILLED] = undefined;
  return kill;
}

/**
 * The pool's client class. Two fault behaviours `pg.Client` lacks (both proven by
 * `apps/server/src/faults.integration.test.ts`):
 *
 *  1. **A checked-out client has an `error` listener.** `pg-pool` listens only while a client is
 *     idle; a connection reset *during* a query (Postgres restarting, a failover, a proxy cut)
 *     emits `error` on the client after rejecting the query, and with no listener that is an
 *     uncaught exception — the whole process exits on one Postgres restart mid-request.
 *  2. **An optional client-side bound per query** (`clientTimeoutMs`), enforced by destroying the
 *     socket. `pg`'s own `query_timeout` rejects the promise but leaves the query active on the
 *     connection, so drizzle's ROLLBACK queues behind it, and the client goes back to the pool
 *     wedged: every later transaction on it hangs too.
 *
 * The timer starts when the query is handed to the client, which is when it starts running for
 * every caller here (one query at a time per transaction); a query queued behind another on the
 * same client would have its wait counted too.
 */
function boundedClientClass(settings: {
  readonly clientTimeoutMs: number;
  readonly graceMs: number;
  readonly onActiveError?: ((error: Error) => void) | undefined;
}): new () => pg.ClientBase {
  class BoundedClient extends pg.Client {
    /** The bound for the next statement of the current transaction; 0 = lifted. */
    #boundMs = settings.clientTimeoutMs;
    /** Open savepoints and the bound in force when each was taken. */
    #savepoints: { name: string; boundMs: number }[] = [];
    [KILLED]: KillRecord | undefined;

    constructor(config?: string | pg.ClientConfig) {
      super(config);
      this.on("error", (error: Error) => settings.onActiveError?.(error));
    }

    #reset(): void {
      this.#boundMs = settings.clientTimeoutMs;
      this.#savepoints = [];
    }

    /** The bound for this query, and what it does to the bound of the ones after it. */
    #track(
      text: string | undefined,
      values?: readonly unknown[],
    ): { boundMs: number; phase: "statement" | "commit" } {
      const current = this.#boundMs;
      if (text === undefined) return { boundMs: current, phase: "statement" };
      const end = TX_END_RE.exec(text);
      if (end) {
        this.#reset();
        const verb = (end[1] as string).toUpperCase();
        return {
          boundMs: settings.clientTimeoutMs,
          phase: verb === "COMMIT" || verb === "END" ? "commit" : "statement",
        };
      }
      if (BEGIN_RE.test(text)) {
        this.#reset();
        return { boundMs: settings.clientTimeoutMs, phase: "statement" };
      }
      const savepoint = SAVEPOINT_RE.exec(text);
      if (savepoint) {
        this.#savepoints.push({ name: (savepoint[2] as string).toLowerCase(), boundMs: current });
        return { boundMs: current, phase: "statement" };
      }
      const release = RELEASE_RE.exec(text);
      if (release) {
        const name = (release[2] as string).toLowerCase();
        const at = this.#savepoints.map((p) => p.name).lastIndexOf(name);
        if (at >= 0) this.#savepoints.length = at;
        return { boundMs: current, phase: "statement" };
      }
      const rollbackTo = ROLLBACK_TO_RE.exec(text);
      if (rollbackTo) {
        const name = (rollbackTo[2] as string).toLowerCase();
        const at = this.#savepoints.map((p) => p.name).lastIndexOf(name);
        if (at >= 0) {
          // The savepoint survives ROLLBACK TO; the setting is back to what it was when taken.
          this.#boundMs = (this.#savepoints[at] as { boundMs: number }).boundMs;
          this.#savepoints.length = at + 1;
        }
        return { boundMs: current, phase: "statement" };
      }
      const set = SET_STATEMENT_TIMEOUT_RE.exec(text);
      if (set) {
        const ms = Math.floor(
          Number(set[1]) * (TIMEOUT_UNITS_MS[(set[2] ?? "ms").toLowerCase()] ?? 1),
        );
        this.#boundMs = ms === 0 ? 0 : ms + settings.graceMs;
      } else if (
        CHANGES_STATEMENT_TIMEOUT_RE.test(text) ||
        (SET_CONFIG_RE.test(text) && values?.some((v) => v === "statement_timeout") === true)
      ) {
        this.#boundMs = 0;
      }
      return { boundMs: current, phase: "statement" };
    }

    // biome-ignore lint/suspicious/noExplicitAny: pg.Client#query has nine overloads.
    override query(...args: any[]): any {
      if (settings.clientTimeoutMs <= 0) {
        return (super.query as (...a: unknown[]) => unknown)(...args);
      }
      const first = args[0] as { text?: unknown } | string | undefined;
      const text =
        typeof first === "string"
          ? first
          : typeof first?.text === "string"
            ? (first.text as string)
            : undefined;
      // The bound in force for *this* query is the one before it runs; a `SET … = 0` lifts the
      // bound for what follows, not for itself.
      const values =
        typeof first === "object" && Array.isArray((first as { values?: unknown }).values)
          ? ((first as { values: unknown[] }).values as readonly unknown[])
          : Array.isArray(args[1])
            ? (args[1] as readonly unknown[])
            : undefined;
      const { boundMs: bound, phase } = this.#track(text, values);
      if (bound <= 0) return (super.query as (...a: unknown[]) => unknown)(...args);

      const timer = setTimeout(() => {
        const stream = (
          this as unknown as { connection?: { stream?: { destroy(e?: Error): void } } }
        ).connection?.stream;
        this[KILLED] = { phase, boundMs: bound };
        stream?.destroy(new ClientTimeoutError(phase, bound));
      }, bound);
      timer.unref?.();
      const last = args.length - 1;
      if (typeof args[last] === "function") {
        const callback = args[last] as (...a: unknown[]) => unknown;
        args[last] = (...cbArgs: unknown[]) => {
          clearTimeout(timer);
          return callback(...cbArgs);
        };
        return (super.query as (...a: unknown[]) => unknown)(...args);
      }
      const result = (super.query as (...a: unknown[]) => unknown)(...args);
      if (result !== null && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        );
      } else {
        // A Submittable (cursor, stream): its lifetime is its caller's; do not bound it.
        clearTimeout(timer);
      }
      return result;
    }
  }
  return BoundedClient as unknown as new () => pg.ClientBase;
}

export function createDatabase(options: DatabaseOptions): Database {
  const appRole = options.appRole ?? "seedhost_app";
  if (!ROLE_RE.test(appRole)) throw new Error(`invalid appRole ${JSON.stringify(appRole)}`);
  const switchRole = options.switchRole ?? true;
  const statementTimeoutMs = options.statementTimeoutMs ?? 30_000;

  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.poolMax ?? 10,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    allowExitOnIdle: false,
    ...(options.connectionTimeoutMs
      ? { connectionTimeoutMillis: options.connectionTimeoutMs }
      : {}),
    Client: boundedClientClass({
      clientTimeoutMs: options.clientTimeoutMs ?? 0,
      graceMs: options.clientTimeoutGraceMs ?? 1_000,
      onActiveError: options.onActiveError,
    }),
  });
  /*
   * `pg.Pool` re-emits an idle client's connection error on the pool, and an `EventEmitter`
   * `error` with no listener is an uncaught exception: one Postgres restart would take the whole
   * process down with "terminating connection due to administrator command" (57P01) — which is
   * also exactly what an integration test's teardown printed when its container stopped while a
   * pool still held idle connections. The listener is mandatory per the `pg` docs.
   */
  pool.on("error", (error) => options.onIdleError?.(error));
  /*
   * The pool connection is checked out and released here, not by drizzle. Drizzle's pool path
   * sends `begin` *before* its try/finally, so a `begin` that fails (the connection was reset,
   * the client-side bound destroyed it) never releases the client: each such failure leaks one
   * pool slot for the life of the process, and ten of them — one Postgres blip under load — is a
   * pool with no connections and every request waiting forever (faults.integration.test.ts).
   * Drizzle over a checked-out client leaves the release to us, in a `finally` that always runs.
   * A client that failed is not queryable any more and `pg-pool` discards it on release.
   */
  async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    takeKill(client);
    try {
      const db: NodePgDatabase = drizzle({ client });
      return await db.transaction(fn);
    } catch (error) {
      // When the client-side bound cut the connection, what reaches here is usually drizzle's
      // failed ROLLBACK on the dead client ("not queryable"). Report the bound — and for a
      // COMMIT, that the outcome is unknown — and keep what was thrown as the cause.
      const kill = takeKill(client);
      if (kill !== undefined) {
        throw new ClientTimeoutError(kill.phase, kill.boundMs, { cause: error });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function prepare(tx: Tx, settings: Record<string, string>): Promise<void> {
    // SET LOCAL is transaction-scoped: nothing survives COMMIT/ROLLBACK on the pooled connection.
    if (switchRole) await tx.execute(sql.raw(`SET LOCAL ROLE ${appRole}`));
    if (statementTimeoutMs > 0) {
      await tx.execute(
        sql.raw(`SET LOCAL statement_timeout = '${Math.floor(statementTimeoutMs)}ms'`),
      );
    }
    const pairs = Object.entries(settings);
    const calls = pairs.map(([k, v]) => sql`set_config(${k}, ${v}, true)`);
    await tx.execute(sql`SELECT ${sql.join(calls, sql`, `)}`);
  }

  return {
    pool,
    async withTenant(ctx, fn) {
      assertTenantContext(ctx);
      return transaction(async (tx) => {
        // View as investor (E2.7): the database itself refuses every write, so a side effect a
        // service forgot to skip fails loudly instead of being recorded as the investor's.
        if (ctx.viewAs !== undefined) await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
        await prepare(tx, {
          "app.workspace_id": ctx.workspaceId,
          "app.actor_kind": ctx.actorKind,
          "app.membership_id": ctx.membershipId ?? "",
          "app.user_id": ctx.userId ?? "",
        });
        return fn(tx);
      });
    },
    async withHost(fn, ctx = HOST_CONTEXT) {
      assertHostContext(ctx);
      return transaction(async (tx) => {
        await prepare(tx, {
          "app.workspace_id": "",
          "app.actor_kind": "host",
          "app.membership_id": "",
          "app.user_id": ctx.userId ?? "",
        });
        return fn(tx, ctx);
      });
    },
    async ping() {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await endPool(pool);
    },
  };
}

/**
 * `pool.end()` and then wait until every client's connection has actually closed.
 *
 * `pg-pool` resolves `end()` as soon as its bookkeeping is empty, while each client's `end()` —
 * the Terminate message and the socket close — is still in flight. A caller that stops the
 * server right after (a test tearing down its container, an operator stopping Postgres after
 * the app) can then have the server kill a connection that was about to close, which surfaces as
 * a 57P01 error on a client nobody is listening to any more. Bounded, so a wedged socket cannot
 * hang a shutdown.
 */
export async function endPool(pool: pg.Pool, timeoutMs = 5_000): Promise<void> {
  const open = pool.totalCount;
  let removed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const allClosed = new Promise<void>((resolve) => {
    if (open === 0) return resolve();
    pool.on("remove", () => {
      removed += 1;
      if (removed >= open) resolve();
    });
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await pool.end();
  await allClosed;
  if (timer !== undefined) clearTimeout(timer);
}
