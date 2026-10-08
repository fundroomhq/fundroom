import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";
import { membership } from "./identity.js";

/*
 * AI assist (EXECUTION_PLAN §15 E3.12, ADR-0060).
 *
 * Typed view of `migrations/core/0025_ai_assist.sql`; the SQL is authoritative (ADR-0004) — the
 * fence, the permissive staff/system policies and the `set_updated_at` trigger live there. The
 * kernel is `@fundroom/ai`; model adapters implement `ModelPort` from `@fundroom/ports`.
 */

/** Mirrors `AiFeature` in `@fundroom/module-kit` (db depends on neither). */
export const AI_FEATURE_VALUES = ["update_draft", "qa_answer"] as const;
export type AiFeatureValue = (typeof AI_FEATURE_VALUES)[number];

export const AI_REQUEST_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "refused",
  "cancelled",
] as const;
export type AiRequestStatus = (typeof AI_REQUEST_STATUSES)[number];

/** One AI suggestion. Transient: deleted at `expires_at` and never exported. */
export const aiRequest = coreSchema.table(
  "ai_request",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    feature: text("feature").$type<AiFeatureValue>().notNull(),
    /** The question id for `qa_answer`; null for `update_draft`. */
    subjectId: uuid("subject_id"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    status: text("status").$type<AiRequestStatus>().notNull().default("queued"),
    params: jsonb("params")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    paramsSchemaVersion: integer("params_schema_version").notNull().default(1),
    /** The task's result (contracts `AiResult`); null until done. Set together with its version. */
    result: jsonb("result").$type<Readonly<Record<string, unknown>>>(),
    resultSchemaVersion: integer("result_schema_version"),
    errorCode: text("error_code"),
    /** `aiProviderKey(info)` at start. */
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ai_request_inflight_idx")
      .on(t.workspaceId, t.status)
      .where(sql`${t.status} IN ('queued', 'running')`),
    index("ai_request_subject_inflight_idx")
      .on(t.workspaceId, t.feature, t.subjectId)
      .where(sql`${t.status} IN ('queued', 'running')`),
    index("ai_request_requested_by_idx").on(t.requestedBy),
    index("ai_request_expires_idx").on(t.expiresAt),
    check("ai_request_feature", sql`${t.feature} IN ('update_draft', 'qa_answer')`),
    check(
      "ai_request_status",
      sql`${t.status} IN ('queued', 'running', 'done', 'failed', 'refused', 'cancelled')`,
    ),
    check(
      "ai_request_error_code",
      sql`${t.errorCode} IS NULL OR ${t.errorCode} ~ '^[a-z_]{1,64}$'`,
    ),
    check("ai_request_params_object", sql`jsonb_typeof(${t.params}) = 'object'`),
    check(
      "ai_request_result_object",
      sql`${t.result} IS NULL OR jsonb_typeof(${t.result}) = 'object'`,
    ),
    check(
      "ai_request_result_version",
      sql`(${t.result} IS NULL) = (${t.resultSchemaVersion} IS NULL)`,
    ),
    check("ai_request_provider_length", sql`char_length(${t.provider}) BETWEEN 1 AND 400`),
    check("ai_request_model_length", sql`char_length(${t.model}) BETWEEN 1 AND 200`),
    check("ai_request_tokens_non_negative", sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0`),
  ],
);

/** Tokens and requests per workspace per UTC calendar month (the budget). Instance-local. */
export const aiUsageMonthly = coreSchema.table(
  "ai_usage_monthly",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** First day of the UTC month, `YYYY-MM-01`. */
    month: date("month", { mode: "string" }).notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    requests: integer("requests").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.month] }),
    check("ai_usage_monthly_month_start", sql`date_trunc('month', ${t.month}) = ${t.month}`),
    check(
      "ai_usage_monthly_non_negative",
      sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0 AND ${t.requests} >= 0`,
    ),
  ],
);

export type AiRequestRow = typeof aiRequest.$inferSelect;
export type NewAiRequestRow = typeof aiRequest.$inferInsert;
export type AiUsageMonthlyRow = typeof aiUsageMonthly.$inferSelect;
