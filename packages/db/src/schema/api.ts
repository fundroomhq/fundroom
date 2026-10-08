import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";
import { bytea, membership } from "./identity.js";

/*
 * Workspace API keys and outbound webhooks (EXECUTION_PLAN §15 E3.4, ADR-0052).
 *
 * Typed view of `migrations/core/0018_api_keys_webhooks.sql`; the SQL is authoritative (ADR-0004) —
 * the fences, the permissive staff/system policies and the `set_updated_at` trigger live there.
 * Token rules and repositories are in `@fundroom/api-keys`; the signer, fan-out and delivery in
 * `@fundroom/webhooks`. Kernel, not a module: the bearer lookup runs during tenant resolution,
 * before module enablement is knowable.
 */

export const API_KEY_REVOKED_REASONS = [
  "revoked",
  "rotated",
  "creator_inactive",
  "erased",
] as const;
export type ApiKeyRevokedReason = (typeof API_KEY_REVOKED_REASONS)[number];

export const WEBHOOK_DISABLED_REASONS = ["gone", "failing", "manual"] as const;
export type WebhookDisabledReason = (typeof WEBHOOK_DISABLED_REASONS)[number];

export const WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "sending",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * One API key. `token_hash` is sha256 of the plaintext (returned once, never stored); the key acts
 * as `created_by_membership_id`, capped by `scopes`.
 */
export const apiKey = coreSchema.table(
  "api_key",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** `sha256(token)`; the plaintext is never stored. */
    tokenHash: bytea("token_hash").notNull(),
    /** Display only: the token's first 12 characters. */
    prefix: text("prefix").notNull(),
    scopes: text("scopes").array().notNull(),
    createdByMembershipId: uuid("created_by_membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason").$type<ApiKeyRevokedReason>(),
    replacedById: uuid("replaced_by_id").references((): AnyPgColumn => apiKey.id, {
      onDelete: "set null",
    }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastUsedIp: text("last_used_ip"),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("api_key_token_hash_idx").on(t.tokenHash),
    index("api_key_ws_created_idx").on(t.workspaceId, t.createdAt.desc()),
    index("api_key_creator_idx")
      .on(t.workspaceId, t.createdByMembershipId)
      .where(sql`${t.revokedAt} IS NULL`),
    index("api_key_replaced_by_idx").on(t.replacedById).where(sql`${t.replacedById} IS NOT NULL`),
    check("api_key_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 80`),
    check("api_key_token_hash_length", sql`octet_length(${t.tokenHash}) = 32`),
    check("api_key_prefix_shape", sql`${t.prefix} ~ '^(shk|frk)_[A-Za-z0-9_-]{8}$'`),
    check("api_key_scopes_nonempty", sql`cardinality(${t.scopes}) >= 1`),
    check(
      "api_key_revoked_shape",
      sql`(${t.revokedAt} IS NULL) = (${t.revokedReason} IS NULL)
    AND (${t.revokedReason} IS NULL
      OR ${t.revokedReason} IN ('revoked', 'rotated', 'creator_inactive', 'erased'))`,
    ),
    check("api_key_note_length", sql`${t.note} IS NULL OR char_length(${t.note}) <= 500`),
    check(
      "api_key_last_used_ip_length",
      sql`${t.lastUsedIp} IS NULL OR char_length(${t.lastUsedIp}) <= 64`,
    ),
    check(
      "api_key_not_self_replaced",
      sql`${t.replacedById} IS NULL OR ${t.replacedById} <> ${t.id}`,
    ),
  ],
);

/** One webhook receiver. URL and secrets are SHE1-sealed under the `webhook-secret` key. */
export const webhookEndpoint = coreSchema.table(
  "webhook_endpoint",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    description: text("description"),
    urlEnc: bytea("url_enc").notNull(),
    /** `{ url, secret, secretPrev? }`, each `{ format, keyId, keyRef }`. */
    encryption: jsonb("encryption").notNull().default({}),
    encryptionSchemaVersion: integer("encryption_schema_version").notNull().default(1),
    urlHost: text("url_host").notNull(),
    urlHint: text("url_hint").notNull(),
    secretEnc: bytea("secret_enc").notNull(),
    secretPrevEnc: bytea("secret_prev_enc"),
    secretPrevExpiresAt: timestamp("secret_prev_expires_at", { withTimezone: true }),
    events: text("events").array().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    disabledReason: text("disabled_reason").$type<WebhookDisabledReason>(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id").references(() => membership.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhook_endpoint_ws_idx").on(t.workspaceId),
    index("webhook_endpoint_creator_idx")
      .on(t.createdByMembershipId)
      .where(sql`${t.createdByMembershipId} IS NOT NULL`),
    check(
      "webhook_endpoint_description_length",
      sql`${t.description} IS NULL OR char_length(${t.description}) <= 200`,
    ),
    check("webhook_endpoint_url_host_length", sql`char_length(${t.urlHost}) BETWEEN 1 AND 300`),
    check("webhook_endpoint_url_hint_length", sql`char_length(${t.urlHint}) <= 4`),
    check(
      "webhook_endpoint_secret_prev_shape",
      sql`(${t.secretPrevEnc} IS NULL) = (${t.secretPrevExpiresAt} IS NULL)`,
    ),
    check("webhook_endpoint_events_nonempty", sql`cardinality(${t.events}) >= 1`),
    check(
      "webhook_endpoint_disabled_shape",
      sql`${t.enabled} = (${t.disabledReason} IS NULL)
    AND (${t.disabledReason} IS NULL OR ${t.disabledReason} IN ('gone', 'failing', 'manual'))`,
    ),
    check("webhook_endpoint_failures_nonnegative", sql`${t.consecutiveFailures} >= 0`),
  ],
);

/** One delivery (queue, log and DLQ). `id` is the Standard Webhooks `webhook-id`. */
export const webhookDelivery = coreSchema.table(
  "webhook_delivery",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id")
      .notNull()
      .references(() => webhookEndpoint.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    eventId: text("event_id").notNull(),
    payload: jsonb("payload").notNull(),
    payloadSchemaVersion: integer("payload_schema_version").notNull().default(1),
    status: text("status").$type<WebhookDeliveryStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    lastDurationMs: integer("last_duration_ms"),
    lastResponseExcerpt: text("last_response_excerpt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    manual: boolean("manual").notNull().default(false),
  },
  (t) => [
    index("webhook_delivery_due_idx").on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    index("webhook_delivery_sending_idx").on(t.claimedAt).where(sql`${t.status} = 'sending'`),
    index("webhook_delivery_ws_created_idx").on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
    index("webhook_delivery_endpoint_idx").on(t.endpointId, t.createdAt.desc()),
    uniqueIndex("webhook_delivery_event_uq")
      .on(t.endpointId, t.eventId)
      .where(sql`NOT ${t.manual}`),
    check(
      "webhook_delivery_status",
      sql`${t.status} IN ('pending', 'sending', 'succeeded', 'failed', 'cancelled')`,
    ),
    check("webhook_delivery_topic_length", sql`char_length(${t.topic}) BETWEEN 1 AND 100`),
    check("webhook_delivery_event_id_length", sql`char_length(${t.eventId}) BETWEEN 1 AND 100`),
    check("webhook_delivery_attempts_nonnegative", sql`${t.attempts} >= 0`),
    check(
      "webhook_delivery_pending_due",
      sql`${t.status} <> 'pending' OR ${t.nextAttemptAt} IS NOT NULL`,
    ),
    check(
      "webhook_delivery_status_code_range",
      sql`${t.lastStatusCode} IS NULL OR ${t.lastStatusCode} BETWEEN 100 AND 599`,
    ),
    check(
      "webhook_delivery_last_error_length",
      sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 300`,
    ),
    check(
      "webhook_delivery_duration_nonnegative",
      sql`${t.lastDurationMs} IS NULL OR ${t.lastDurationMs} >= 0`,
    ),
    check(
      "webhook_delivery_excerpt_length",
      sql`${t.lastResponseExcerpt} IS NULL OR char_length(${t.lastResponseExcerpt}) <= 512`,
    ),
  ],
);

export type ApiKeyRow = typeof apiKey.$inferSelect;
export type NewApiKeyRow = typeof apiKey.$inferInsert;
export type WebhookEndpointRow = typeof webhookEndpoint.$inferSelect;
export type NewWebhookEndpointRow = typeof webhookEndpoint.$inferInsert;
export type WebhookDeliveryRow = typeof webhookDelivery.$inferSelect;
export type NewWebhookDeliveryRow = typeof webhookDelivery.$inferInsert;
