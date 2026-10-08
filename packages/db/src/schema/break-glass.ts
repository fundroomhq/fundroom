import { sql } from "drizzle-orm";
import { check, index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";

/*
 * Break-glass sessions of the host operator (E2.10, design/02 "Break-glass").
 *
 * Typed view of `migrations/core/0015_break_glass.sql`; the SQL is authoritative (ADR-0004) —
 * the `seedhost_host` role, the guard trigger (fresh pending rows, immutable facts, activate once,
 * close once, counters only while active and unexpired by the database clock), the
 * `break_glass_refuse` triggers, `core.break_glass_exec()` and the fence all live there. The CLI is
 * `fundroom break-glass`; the queries are in `src/break-glass/`.
 */

export const BREAK_GLASS_CLOSE_REASONS = ["closed", "notification_failed"] as const;
export type BreakGlassCloseReason = (typeof BREAK_GLASS_CLOSE_REASONS)[number];

/** The longest window one session may have (the migration's CHECK says the same). */
export const BREAK_GLASS_MAX_MINUTES = 60;

export const breakGlassSession = coreSchema.table(
  "break_glass_session",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    ticket: text("ticket").notNull(),
    reason: text("reason").notNull(),
    operator: text("operator").notNull(),
    osUser: text("os_user").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** NULL while pending: set once the opening is recorded and the owners were told. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason").$type<BreakGlassCloseReason>(),
    statements: integer("statements").notNull().default(0),
    writes: integer("writes").notNull().default(0),
    lastStatementAt: timestamp("last_statement_at", { withTimezone: true }),
  },
  (t) => [
    index("break_glass_session_ws_idx").on(t.workspaceId, t.openedAt.desc()),
    index("break_glass_session_opened_idx").on(t.openedAt.desc()),
    check("break_glass_session_ticket_shape", sql`${t.ticket} ~ '^[!-~]{3,128}$'`),
    check(
      "break_glass_session_reason_length",
      sql`char_length(btrim(${t.reason})) BETWEEN 10 AND 1000`,
    ),
    check(
      "break_glass_session_operator_shape",
      sql`char_length(${t.operator}) BETWEEN 1 AND 128 AND ${t.operator} !~ '[[:cntrl:]]'
    AND char_length(${t.osUser}) BETWEEN 1 AND 128 AND ${t.osUser} !~ '[[:cntrl:]]'`,
    ),
    check(
      "break_glass_session_window",
      sql`${t.expiresAt} > ${t.openedAt} AND ${t.expiresAt} <= ${t.openedAt} + interval '1 hour'`,
    ),
    check(
      "break_glass_session_closed_shape",
      sql`(${t.closedAt} IS NULL) = (${t.closeReason} IS NULL)
    AND (${t.closedAt} IS NULL OR ${t.closedAt} >= ${t.openedAt})
    AND (${t.closeReason} IS NULL OR ${t.closeReason} IN ('closed', 'notification_failed'))`,
    ),
    check(
      "break_glass_session_counts",
      sql`${t.statements} >= 0 AND ${t.writes} BETWEEN 0 AND ${t.statements}`,
    ),
    check(
      "break_glass_session_notified_shape",
      sql`(${t.notifiedAt} IS NULL OR ${t.notifiedAt} >= ${t.openedAt}) AND (${t.statements} = 0 OR ${t.notifiedAt} IS NOT NULL)`,
    ),
  ],
);

export type BreakGlassSessionRow = typeof breakGlassSession.$inferSelect;
export type NewBreakGlassSessionRow = typeof breakGlassSession.$inferInsert;
