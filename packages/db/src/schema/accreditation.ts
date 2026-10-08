import { sql } from "drizzle-orm";
import {
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
 * Accreditation-vendor connections (EXECUTION_PLAN §15 E3.7, ADR-0055).
 *
 * Typed view of `migrations/core/0021_accreditation.sql`; the SQL is authoritative (ADR-0004) — the
 * fence (with its host SELECT for the ops callback), the permissive staff/system policy and the
 * `set_updated_at` trigger live there. The service is `@fundroom/accreditation`; vendor adapters
 * implement `AccreditationVendorPort` from `@fundroom/ports`.
 */

/** Mirrors `ACCREDITATION_VENDOR_DRIVERS` in `@fundroom/ports` (db does not depend on ports). */
export const ACCREDITATION_VENDOR_DRIVER_VALUES = ["verifyinvestor", "parallel-markets"] as const;
export type AccreditationVendorDriverValue = (typeof ACCREDITATION_VENDOR_DRIVER_VALUES)[number];

export const ACCREDITATION_CONNECTION_STATUSES = ["active", "error"] as const;
export type AccreditationConnectionStatus = (typeof ACCREDITATION_CONNECTION_STATUSES)[number];

/** One sealed column's reference (SHE1 under the `accreditation-credentials` workspace key). */
export interface AccreditationSealedRef {
  readonly format: string;
  readonly keyId: string;
  readonly keyRef: string;
}

/** `accreditation_connection.encryption` (schema version 1). */
export interface AccreditationConnectionEncryption {
  readonly credentials: AccreditationSealedRef;
}

/** At most one live (`deleted_at IS NULL`) connection per workspace. */
export const accreditationConnection = coreSchema.table(
  "accreditation_connection",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    driver: text("driver").$type<AccreditationVendorDriverValue>().notNull(),
    environment: text("environment").notNull(),
    credentialsEnc: bytea("credentials_enc").notNull(),
    encryption: jsonb("encryption").$type<AccreditationConnectionEncryption>().notNull(),
    encryptionSchemaVersion: integer("encryption_schema_version").notNull().default(1),
    credentialHints: jsonb("credential_hints")
      .$type<Readonly<Record<string, string>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    credentialHintsSchemaVersion: integer("credential_hints_schema_version").notNull().default(1),
    status: text("status").$type<AccreditationConnectionStatus>().notNull().default("active"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastCallbackAt: timestamp("last_callback_at", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id").references(() => membership.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("accreditation_connection_live_idx")
      .on(t.workspaceId)
      .where(sql`${t.deletedAt} IS NULL`),
    index("accreditation_connection_creator_idx")
      .on(t.createdByMembershipId)
      .where(sql`${t.createdByMembershipId} IS NOT NULL`),
    check(
      "accreditation_connection_driver",
      sql`${t.driver} IN ('verifyinvestor', 'parallel-markets')`,
    ),
    check(
      "accreditation_connection_environment_length",
      sql`char_length(${t.environment}) BETWEEN 1 AND 50`,
    ),
    check("accreditation_connection_status", sql`${t.status} IN ('active', 'error')`),
    check(
      "accreditation_connection_last_error_length",
      sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 500`,
    ),
    check(
      "accreditation_connection_encryption_object",
      sql`jsonb_typeof(${t.encryption}) = 'object'`,
    ),
    check(
      "accreditation_connection_hints_object",
      sql`jsonb_typeof(${t.credentialHints}) = 'object'`,
    ),
  ],
);
