import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { citext, coreSchema, workspace } from "./core.js";
import { bytea, membership } from "./identity.js";

/*
 * Third-party integrations: connections, OAuth handshakes, recorded bookings and booking links
 * (EXECUTION_PLAN §15 E3.6, ADR-0054).
 *
 * Typed view of `migrations/core/0020_integrations.sql`; the SQL is authoritative (ADR-0004) — the
 * fences, the permissive staff/system policies, the host SELECT arm on integration_connection, the
 * external SELECT arm on enabled booking links, the two SECURITY DEFINER OAuth claim functions
 * (`core.integration_oauth_ticket_claim`, `core.integration_oauth_state_claim`) and the
 * `set_updated_at` triggers live there. The service is `@fundroom/integrations`.
 */

/** Mirrors `INTEGRATION_PROVIDERS` in `@fundroom/ports` (db does not depend on ports). */
export const INTEGRATION_PROVIDER_VALUES = [
  "quickbooks",
  "xero",
  "stripe",
  "slack",
  "calendly",
  "calcom",
] as const;
export type IntegrationProviderValue = (typeof INTEGRATION_PROVIDER_VALUES)[number];

export const BOOKING_PROVIDER_VALUES = ["calendly", "calcom"] as const;
export type BookingProviderValue = (typeof BOOKING_PROVIDER_VALUES)[number];

export const INTEGRATION_CONNECTION_STATUSES = ["active", "degraded", "reauth_required"] as const;
export type IntegrationConnectionStatus = (typeof INTEGRATION_CONNECTION_STATUSES)[number];

export const INTEGRATION_BOOKING_STATUSES = ["booked", "cancelled", "rescheduled"] as const;
export type IntegrationBookingStatus = (typeof INTEGRATION_BOOKING_STATUSES)[number];

export type IntegrationEnvironment = "production" | "sandbox";
export type IntegrationAuthKindValue = "oauth2" | "secret";

/** One sealed column's reference (SHE1 under the `integration-credentials` workspace key). */
export interface IntegrationSealedRef {
  readonly format: string;
  readonly keyId: string;
  readonly keyRef: string;
}

/** `integration_connection.encryption` (schema version 1). */
export interface IntegrationConnectionEncryption {
  readonly credentials: IntegrationSealedRef;
  readonly webhookSecret?: IntegrationSealedRef | undefined;
}

/** `integration_oauth_state.encryption` (schema version 1). */
export interface IntegrationOAuthStateEncryption {
  readonly verifier?: IntegrationSealedRef | undefined;
  /** The pending (not yet confirmed) token set (fix round 1). */
  readonly pending?: IntegrationSealedRef | undefined;
}

/** `booking_link.audience` (schema version 1). */
export type BookingLinkAudience =
  | { readonly kind: "all" }
  | { readonly kind: "groups"; readonly groupIds: readonly string[] };

/** At most one live (`deleted_at IS NULL`) connection per (workspace, provider). */
export const integrationConnection = coreSchema.table(
  "integration_connection",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    provider: text("provider").$type<IntegrationProviderValue>().notNull(),
    authKind: text("auth_kind").$type<IntegrationAuthKindValue>().notNull(),
    environment: text("environment")
      .$type<IntegrationEnvironment>()
      .notNull()
      .default("production"),
    credentialsEnc: bytea("credentials_enc").notNull(),
    encryption: jsonb("encryption")
      .$type<IntegrationConnectionEncryption>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    encryptionSchemaVersion: integer("encryption_schema_version").notNull().default(1),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    scope: text("scope"),
    externalAccountId: text("external_account_id"),
    accountLabel: text("account_label"),
    webhookSecretEnc: bytea("webhook_secret_enc"),
    webhookSubscriptionId: text("webhook_subscription_id"),
    status: text("status").$type<IntegrationConnectionStatus>().notNull().default("active"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastError: text("last_error"),
    refreshLeaseUntil: timestamp("refresh_lease_until", { withTimezone: true }),
    webhookRotationLeaseUntil: timestamp("webhook_rotation_lease_until", { withTimezone: true }),
    webhookRotationLeaseToken: uuid("webhook_rotation_lease_token"),
    createdByMembershipId: uuid("created_by_membership_id").references(() => membership.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("integration_connection_live_idx")
      .on(t.workspaceId, t.provider)
      .where(sql`${t.deletedAt} IS NULL`),
    index("integration_connection_creator_idx")
      .on(t.createdByMembershipId)
      .where(sql`${t.createdByMembershipId} IS NOT NULL`),
    check(
      "integration_connection_provider",
      sql`${t.provider} IN ('quickbooks', 'xero', 'stripe', 'slack', 'calendly', 'calcom')`,
    ),
    check("integration_connection_auth_kind", sql`${t.authKind} IN ('oauth2', 'secret')`),
    check("integration_connection_environment", sql`${t.environment} IN ('production', 'sandbox')`),
    check(
      "integration_connection_status",
      sql`${t.status} IN ('active', 'degraded', 'reauth_required')`,
    ),
    check("integration_connection_failures_nonnegative", sql`${t.consecutiveFailures} >= 0`),
    check(
      "integration_connection_scope_length",
      sql`${t.scope} IS NULL OR char_length(${t.scope}) <= 1000`,
    ),
    check(
      "integration_connection_external_account_length",
      sql`${t.externalAccountId} IS NULL OR char_length(${t.externalAccountId}) BETWEEN 1 AND 300`,
    ),
    check(
      "integration_connection_account_label_length",
      sql`${t.accountLabel} IS NULL OR char_length(${t.accountLabel}) <= 200`,
    ),
    check(
      "integration_connection_subscription_length",
      sql`${t.webhookSubscriptionId} IS NULL OR char_length(${t.webhookSubscriptionId}) BETWEEN 1 AND 300`,
    ),
    check(
      "integration_connection_last_error_length",
      sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 500`,
    ),
    check(
      "integration_connection_encryption_object",
      sql`jsonb_typeof(${t.encryption}) = 'object'`,
    ),
  ],
);

/**
 * One OAuth attempt. Single use, 10 minutes. The ops routes reach a row only through the SECURITY
 * DEFINER claim functions (see the migration).
 */
export const integrationOAuthState = coreSchema.table(
  "integration_oauth_state",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    provider: text("provider").$type<IntegrationProviderValue>().notNull(),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    ticketHash: bytea("ticket_hash").notNull(),
    ticketExpiresAt: timestamp("ticket_expires_at", { withTimezone: true }).notNull(),
    ticketClaimedAt: timestamp("ticket_claimed_at", { withTimezone: true }),
    stateHash: bytea("state_hash"),
    browserHash: bytea("browser_hash"),
    verifierEnc: bytea("verifier_enc"),
    encryption: jsonb("encryption")
      .$type<IntegrationOAuthStateEncryption>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    encryptionSchemaVersion: integer("encryption_schema_version").notNull().default(1),
    environment: text("environment")
      .$type<IntegrationEnvironment>()
      .notNull()
      .default("production"),
    returnPath: text("return_path").notNull().default("/admin/integrations"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    pendingHash: bytea("pending_hash"),
    pendingEnc: bytea("pending_enc"),
    pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("integration_oauth_state_ticket_idx").on(t.ticketHash),
    uniqueIndex("integration_oauth_state_state_idx")
      .on(t.stateHash)
      .where(sql`${t.stateHash} IS NOT NULL`),
    uniqueIndex("integration_oauth_state_pending_idx")
      .on(t.pendingHash)
      .where(sql`${t.pendingHash} IS NOT NULL`),
    index("integration_oauth_state_expires_idx").on(t.expiresAt),
    index("integration_oauth_state_member_idx").on(t.workspaceId, t.membershipId),
    check(
      "integration_oauth_state_provider",
      sql`${t.provider} IN ('quickbooks', 'xero', 'stripe', 'slack', 'calendly', 'calcom')`,
    ),
    check(
      "integration_oauth_state_environment",
      sql`${t.environment} IN ('production', 'sandbox')`,
    ),
    check("integration_oauth_state_ticket_hash_length", sql`octet_length(${t.ticketHash}) = 32`),
    check(
      "integration_oauth_state_state_hash_length",
      sql`${t.stateHash} IS NULL OR octet_length(${t.stateHash}) = 32`,
    ),
    check(
      "integration_oauth_state_browser_hash_length",
      sql`${t.browserHash} IS NULL OR octet_length(${t.browserHash}) = 32`,
    ),
    check(
      "integration_oauth_state_pending_hash_length",
      sql`${t.pendingHash} IS NULL OR octet_length(${t.pendingHash}) = 32`,
    ),
    check(
      "integration_oauth_state_pending_shape",
      sql`(${t.pendingHash} IS NULL) = (${t.pendingExpiresAt} IS NULL) AND (${t.pendingEnc} IS NULL OR ${t.pendingHash} IS NOT NULL)`,
    ),
    check(
      "integration_oauth_state_return_path",
      sql`${t.returnPath} LIKE '/admin/%' AND char_length(${t.returnPath}) <= 300`,
    ),
    check(
      "integration_oauth_state_encryption_object",
      sql`jsonb_typeof(${t.encryption}) = 'object'`,
    ),
  ],
);

/** A meeting a booking vendor's webhook told us about. Retained 400 days after `starts_at`. */
export const integrationBooking = coreSchema.table(
  "integration_booking",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => integrationConnection.id),
    provider: text("provider").$type<BookingProviderValue>().notNull(),
    externalId: text("external_id").notNull(),
    status: text("status").$type<IntegrationBookingStatus>().notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    inviteeEmail: citext("invitee_email").notNull(),
    inviteeName: text("invitee_name"),
    eventName: text("event_name"),
    membershipId: uuid("membership_id").references(() => membership.id, { onDelete: "set null" }),
    erasedAt: timestamp("erased_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("integration_booking_external_idx").on(t.workspaceId, t.provider, t.externalId),
    index("integration_booking_member_idx").on(t.workspaceId, t.membershipId),
    index("integration_booking_email_idx").on(t.workspaceId, t.inviteeEmail),
    index("integration_booking_starts_idx").on(t.workspaceId, t.startsAt.desc(), t.id.desc()),
    index("integration_booking_retention_idx").on(t.startsAt),
    index("integration_booking_connection_idx").on(t.connectionId),
    check("integration_booking_provider", sql`${t.provider} IN ('calendly', 'calcom')`),
    check("integration_booking_status", sql`${t.status} IN ('booked', 'cancelled', 'rescheduled')`),
    check(
      "integration_booking_external_id_length",
      sql`char_length(${t.externalId}) BETWEEN 1 AND 300`,
    ),
    check(
      "integration_booking_invitee_email_length",
      sql`char_length(${t.inviteeEmail}) BETWEEN 1 AND 320`,
    ),
    check(
      "integration_booking_invitee_name_length",
      sql`${t.inviteeName} IS NULL OR char_length(${t.inviteeName}) <= 200`,
    ),
    check(
      "integration_booking_event_name_length",
      sql`${t.eventName} IS NULL OR char_length(${t.eventName}) <= 200`,
    ),
  ],
);

/**
 * Keyed hashes of erased people's addresses (fix round 2): booking ingest drops their events.
 * HMAC-SHA256(workspace key `integration-booking-suppression`, lower(email)); no address stored.
 */
export const integrationBookingSuppression = coreSchema.table(
  "integration_booking_suppression",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    emailHash: bytea("email_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.emailHash] }),
    check("integration_booking_suppression_hash_length", sql`octet_length(${t.emailHash}) = 32`),
  ],
);

/** A booking link shown on the investor portal. Max 10 per workspace (service-enforced). */
export const bookingLink = coreSchema.table(
  "booking_link",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    provider: text("provider").$type<BookingProviderValue>().notNull(),
    url: text("url").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    audience: jsonb("audience")
      .$type<BookingLinkAudience>()
      .notNull()
      .default(sql`'{"kind":"all"}'::jsonb`),
    audienceSchemaVersion: integer("audience_schema_version").notNull().default(1),
    position: integer("position").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdByMembershipId: uuid("created_by_membership_id").references(() => membership.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("booking_link_ws_position_idx").on(t.workspaceId, t.position, t.id),
    index("booking_link_creator_idx")
      .on(t.createdByMembershipId)
      .where(sql`${t.createdByMembershipId} IS NOT NULL`),
    check("booking_link_provider", sql`${t.provider} IN ('calendly', 'calcom')`),
    check(
      "booking_link_url_shape",
      sql`${t.url} LIKE 'https://%' AND char_length(${t.url}) BETWEEN 9 AND 500`,
    ),
    check("booking_link_label_length", sql`char_length(${t.label}) BETWEEN 1 AND 80`),
    check(
      "booking_link_description_length",
      sql`${t.description} IS NULL OR char_length(${t.description}) <= 300`,
    ),
    check(
      "booking_link_audience_object",
      sql`jsonb_typeof(${t.audience}) = 'object' AND ${t.audience} ->> 'kind' IN ('all', 'groups')`,
    ),
    check("booking_link_position_nonnegative", sql`${t.position} >= 0`),
  ],
);

export type IntegrationConnectionRow = typeof integrationConnection.$inferSelect;
export type NewIntegrationConnectionRow = typeof integrationConnection.$inferInsert;
export type IntegrationOAuthStateRow = typeof integrationOAuthState.$inferSelect;
export type NewIntegrationOAuthStateRow = typeof integrationOAuthState.$inferInsert;
export type IntegrationBookingRow = typeof integrationBooking.$inferSelect;
export type NewIntegrationBookingRow = typeof integrationBooking.$inferInsert;
export type BookingLinkRow = typeof bookingLink.$inferSelect;
export type NewBookingLinkRow = typeof bookingLink.$inferInsert;
