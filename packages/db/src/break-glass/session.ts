import { sql } from "drizzle-orm";
import { BREAK_GLASS_MAX_MINUTES, type BreakGlassCloseReason } from "../schema/break-glass.js";
import type { Tx } from "../tenant/database.js";

/*
 * The break-glass session log (E2.10; migrations/core/0015_break_glass.sql).
 *
 * Every function takes the caller's transaction. Writes need the `system` context of the
 * session's workspace (RLS: `withTenant(systemContext(workspaceId), …)`); the listings also work
 * in host context, which may read every workspace's sessions but write none.
 *
 * Raw SQL on purpose: `tx.execute` returns `timestamptz` as text on this path, so every row is
 * coerced through `toSession`, and the expiry is computed from the database clock (`now()`),
 * never from the operator's.
 */

export interface BreakGlassSession {
  readonly id: string;
  readonly workspaceId: string;
  readonly ticket: string;
  readonly reason: string;
  readonly operator: string;
  readonly osUser: string;
  readonly openedAt: Date;
  readonly expiresAt: Date;
  /** When the opening was recorded and the owners told; `null` while pending (unusable). */
  readonly notifiedAt: Date | null;
  readonly closedAt: Date | null;
  readonly closeReason: BreakGlassCloseReason | null;
  readonly statements: number;
  readonly writes: number;
  readonly lastStatementAt: Date | null;
  /** Computed by the database at read time: active (notified), not closed, `now() < expires_at`. */
  readonly open: boolean;
}

/** Ticket references: printable ASCII without spaces, 3–128 characters (the CHECK's shape). */
export const BREAK_GLASS_TICKET_RE = /^[!-~]{3,128}$/u;

export class BreakGlassInputError extends Error {
  override readonly name = "BreakGlassInputError";
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects.
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

export interface OpenBreakGlassInput {
  readonly workspaceId: string;
  readonly ticket: string;
  readonly reason: string;
  readonly operator: string;
  readonly osUser: string;
  /** 1–60; default 60. */
  readonly minutes?: number | undefined;
}

/** The same rules as the table's CHECKs, with messages an operator can act on. */
export function validateOpenInput(input: OpenBreakGlassInput): void {
  if (!BREAK_GLASS_TICKET_RE.test(input.ticket)) {
    throw new BreakGlassInputError(
      "--ticket must be a ticket or incident reference: 3–128 printable characters, no spaces",
    );
  }
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1000) {
    throw new BreakGlassInputError("--reason must say why, in 10–1000 characters");
  }
  for (const [name, value] of [
    ["--operator", input.operator],
    ["OS user", input.osUser],
  ] as const) {
    if (value.length === 0 || value.length > 128 || CONTROL_RE.test(value)) {
      throw new BreakGlassInputError(`${name} must be 1–128 characters without control characters`);
    }
  }
  const minutes = input.minutes ?? BREAK_GLASS_MAX_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > BREAK_GLASS_MAX_MINUTES) {
    throw new BreakGlassInputError(
      `--minutes must be an integer from 1 to ${BREAK_GLASS_MAX_MINUTES}`,
    );
  }
}

const COLUMNS = sql.raw(`id, workspace_id, ticket, reason, operator, os_user, opened_at, expires_at,
  notified_at, closed_at, close_reason, statements, writes, last_statement_at,
  (notified_at IS NOT NULL AND closed_at IS NULL AND now() < expires_at) AS open`);

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

function toSession(row: Record<string, unknown>): BreakGlassSession {
  return {
    id: String(row["id"]),
    workspaceId: String(row["workspace_id"]),
    ticket: String(row["ticket"]),
    reason: String(row["reason"]),
    operator: String(row["operator"]),
    osUser: String(row["os_user"]),
    openedAt: toDate(row["opened_at"]),
    expiresAt: toDate(row["expires_at"]),
    notifiedAt: row["notified_at"] == null ? null : toDate(row["notified_at"]),
    closedAt: row["closed_at"] == null ? null : toDate(row["closed_at"]),
    closeReason: (row["close_reason"] as BreakGlassCloseReason | null) ?? null,
    statements: Number(row["statements"]),
    writes: Number(row["writes"]),
    lastStatementAt: row["last_statement_at"] == null ? null : toDate(row["last_statement_at"]),
    open: row["open"] === true || row["open"] === "t",
  };
}

/**
 * Opens a *pending* session in `system` context of `input.workspaceId`; the window starts at
 * `now()`. Nothing runs on it until `activateBreakGlassSession` (after the owners were told).
 */
export async function insertBreakGlassSession(
  tx: Tx,
  input: OpenBreakGlassInput,
): Promise<BreakGlassSession> {
  validateOpenInput(input);
  const minutes = input.minutes ?? BREAK_GLASS_MAX_MINUTES;
  const r = await tx.execute(sql`
    INSERT INTO core.break_glass_session (workspace_id, ticket, reason, operator, os_user, expires_at)
    VALUES (${input.workspaceId}::uuid, ${input.ticket}, ${input.reason.trim()}, ${input.operator},
            ${input.osUser}, now() + make_interval(mins => ${minutes}::int))
    RETURNING ${COLUMNS}`);
  const row = r.rows[0];
  if (row === undefined) throw new Error("break-glass session insert returned no row");
  return toSession(row);
}

export async function findBreakGlassSession(
  tx: Tx,
  id: string,
): Promise<BreakGlassSession | undefined> {
  const r = await tx.execute(
    sql`SELECT ${COLUMNS} FROM core.break_glass_session WHERE id = ${id}::uuid`,
  );
  const row = r.rows[0];
  return row === undefined ? undefined : toSession(row);
}

/**
 * Counts one statement against an open, unexpired session (row-locked, database clock).
 * `undefined` when the session is closed, expired or not visible — the caller must refuse.
 */
export async function claimBreakGlassStatement(
  tx: Tx,
  id: string,
  write: boolean,
): Promise<BreakGlassSession | undefined> {
  const r = await tx.execute(sql`
    UPDATE core.break_glass_session SET statements = statements + 1,
           writes = writes + ${write ? 1 : 0}::int,
           last_statement_at = now()
     WHERE id = ${id}::uuid AND notified_at IS NOT NULL AND closed_at IS NULL AND now() < expires_at
    RETURNING ${COLUMNS}`);
  const row = r.rows[0];
  return row === undefined ? undefined : toSession(row);
}

/**
 * Makes a pending session usable, once, while it is unclosed and unexpired. `undefined` when it
 * was not pending (already active, closed, expired or not visible).
 */
export async function activateBreakGlassSession(
  tx: Tx,
  id: string,
): Promise<BreakGlassSession | undefined> {
  const r = await tx.execute(sql`
    UPDATE core.break_glass_session SET notified_at = now()
     WHERE id = ${id}::uuid AND notified_at IS NULL AND closed_at IS NULL AND now() < expires_at
    RETURNING ${COLUMNS}`);
  const row = r.rows[0];
  return row === undefined ? undefined : toSession(row);
}

/** Closes a session once; `undefined` when it was already closed (or is not visible). */
export async function closeBreakGlassSession(
  tx: Tx,
  id: string,
  reason: BreakGlassCloseReason = "closed",
): Promise<BreakGlassSession | undefined> {
  const r = await tx.execute(sql`
    UPDATE core.break_glass_session SET closed_at = now(), close_reason = ${reason}
     WHERE id = ${id}::uuid AND closed_at IS NULL
    RETURNING ${COLUMNS}`);
  const row = r.rows[0];
  return row === undefined ? undefined : toSession(row);
}

export interface ListBreakGlassOptions {
  readonly workspaceId?: string | undefined;
  /** Sessions opened at or after this instant. */
  readonly since?: Date | undefined;
  /** Default 500. */
  readonly limit?: number | undefined;
}

/** Newest first. In host context: every workspace; in a tenant context: that workspace's. */
export async function listBreakGlassSessions(
  tx: Tx,
  options: ListBreakGlassOptions = {},
): Promise<BreakGlassSession[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 10_000));
  const conditions = [sql`true`];
  if (options.workspaceId !== undefined)
    conditions.push(sql`workspace_id = ${options.workspaceId}::uuid`);
  if (options.since !== undefined)
    conditions.push(sql`opened_at >= ${options.since.toISOString()}::timestamptz`);
  const r = await tx.execute(sql`
    SELECT ${COLUMNS} FROM core.break_glass_session
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY opened_at DESC, id DESC
     LIMIT ${limit}`);
  return r.rows.map(toSession);
}

export interface OwnerContact {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
  /** `user.locale`, else the workspace's default language. */
  readonly locale: string;
}

/**
 * The owners of the transaction's workspace who must hear about operator access: staff members
 * with role `owner` whose membership is `active` or `dormant` (a dormant owner is still an
 * owner), whose user is not erased, and who have an email identity (primary first). Needs a
 * `staff` or `system` context of the workspace.
 *
 * Deliberately wider than the last-owner floor (`MembershipRepo.countActiveOwners`, E3.2: active
 * and unexpired only). That count asks "who can administer the workspace right now"; this list
 * asks "who must be told an operator looked inside it", and a dormant owner — or one whose row
 * carries an expiry from before owners stopped expiring (P1-02) — is still somebody the notice is
 * owed to. Telling one person too many is the safe side here.
 */
export async function listWorkspaceOwnerContacts(tx: Tx): Promise<OwnerContact[]> {
  const r = await tx.execute(sql`
    SELECT m.id AS membership_id, u.id AS user_id, u.display_name,
           e.identifier AS email, coalesce(u.locale, w.default_locale) AS locale
      FROM core.membership m
      JOIN core.workspace w ON w.id = m.workspace_id
      JOIN core."user" u ON u.id = m.user_id
      JOIN LATERAL (
        SELECT ui.identifier::text AS identifier
          FROM core.user_identity ui
         WHERE ui.user_id = u.id AND ui.type = 'email'
         ORDER BY ui.is_primary DESC, ui.verified_at DESC NULLS LAST, ui.created_at
         LIMIT 1
      ) e ON true
     WHERE m.workspace_id = core.current_workspace()
       AND m.kind = 'staff' AND m.role = 'owner' AND m.status IN ('active', 'dormant')
       AND u.deleted_at IS NULL
     ORDER BY m.created_at, m.id`);
  return r.rows.map((row) => ({
    membershipId: String(row["membership_id"]),
    userId: String(row["user_id"]),
    displayName: String(row["display_name"] ?? ""),
    email: String(row["email"]),
    locale: String(row["locale"] ?? "en"),
  }));
}
