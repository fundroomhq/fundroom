import { sql } from "drizzle-orm";
import {
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
import { citext, coreSchema, workspace } from "./core.js";
import { bytea, membership } from "./identity.js";

/*
 * E-signature connections and envelopes (EXECUTION_PLAN §15 E3.5, ADR-0053).
 *
 * Typed view of `migrations/core/0019_esign.sql`; the SQL is authoritative (ADR-0004) — the fences,
 * the permissive staff/system policies, the external own-row SELECT, the terminal-status guard
 * trigger and the `set_updated_at` triggers live there. The service is `@fundroom/esign`; vendor
 * adapters implement `ESignPort` from `@fundroom/ports`.
 */

/** Mirrors `ESIGN_DRIVERS` in `@fundroom/ports` (db does not depend on ports). */
export const ESIGN_DRIVER_VALUES = ["documenso", "docuseal", "docusign", "dropbox-sign"] as const;
export type ESignDriverValue = (typeof ESIGN_DRIVER_VALUES)[number];

export const ESIGN_CONNECTION_STATUSES = ["active", "error"] as const;
export type ESignConnectionStatus = (typeof ESIGN_CONNECTION_STATUSES)[number];

export const ESIGN_PURPOSES = ["nda", "round_closing"] as const;
export type ESignPurposeValue = (typeof ESIGN_PURPOSES)[number];

export const ESIGN_ENVELOPE_STATUSES = [
  "draft",
  "sent",
  "delivered",
  "completed",
  "declined",
  "voided",
  "expired",
  "error",
] as const;
export type ESignEnvelopeStatusValue = (typeof ESIGN_ENVELOPE_STATUSES)[number];

/** The statuses an envelope never leaves (enforced by `core.esign_envelope_guard`). */
export const ESIGN_TERMINAL_STATUSES = ["completed", "declined", "voided", "expired"] as const;

export const ESIGN_SIGNER_STATUSES = ["pending", "viewed", "signed", "declined"] as const;
export type ESignSignerStatusValue = (typeof ESIGN_SIGNER_STATUSES)[number];

/** One sealed column's reference (SHE1 under the `esign-credentials` workspace key). */
export interface ESignSealedRef {
  readonly format: string;
  readonly keyId: string;
  readonly keyRef: string;
}

/** `esign_connection.encryption` (schema version 1). */
export interface ESignConnectionEncryption {
  readonly credentials: ESignSealedRef;
  readonly baseUrl?: ESignSealedRef | undefined;
  readonly callbackSecret?: ESignSealedRef | undefined;
}

/** One stored artifact (`esign_envelope.artifacts`, schema version 1). */
export interface ESignStoredArtifact {
  /** Object key, `ws/<ws>/esign/<envelopeId>/{signed,certificate}.pdf`. */
  readonly key: string;
  /** Hex sha256 of the plaintext. */
  readonly sha256: string;
  readonly size: number;
  /** The per-object key reference (purpose `esign-artifact`). */
  readonly keyRef: string;
}

export interface ESignEnvelopeArtifacts {
  readonly signed: ESignStoredArtifact;
  readonly certificate?: ESignStoredArtifact | undefined;
}

/** At most one live (`deleted_at IS NULL`) connection per workspace. */
export const esignConnection = coreSchema.table(
  "esign_connection",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    driver: text("driver").$type<ESignDriverValue>().notNull(),
    baseUrlEnc: bytea("base_url_enc"),
    baseUrlHost: text("base_url_host"),
    credentialsEnc: bytea("credentials_enc").notNull(),
    callbackSecretEnc: bytea("callback_secret_enc"),
    encryption: jsonb("encryption")
      .$type<ESignConnectionEncryption>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    encryptionSchemaVersion: integer("encryption_schema_version").notNull().default(1),
    credentialHints: jsonb("credential_hints")
      .$type<Readonly<Record<string, string>>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    credentialHintsSchemaVersion: integer("credential_hints_schema_version").notNull().default(1),
    status: text("status").$type<ESignConnectionStatus>().notNull().default("active"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdByMembershipId: uuid("created_by_membership_id").references(() => membership.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("esign_connection_live_idx").on(t.workspaceId).where(sql`${t.deletedAt} IS NULL`),
    index("esign_connection_creator_idx")
      .on(t.createdByMembershipId)
      .where(sql`${t.createdByMembershipId} IS NOT NULL`),
    check(
      "esign_connection_driver",
      sql`${t.driver} IN ('documenso', 'docuseal', 'docusign', 'dropbox-sign')`,
    ),
    check("esign_connection_status", sql`${t.status} IN ('active', 'error')`),
    check(
      "esign_connection_base_url_shape",
      sql`(${t.baseUrlEnc} IS NULL) = (${t.baseUrlHost} IS NULL)`,
    ),
    check(
      "esign_connection_base_url_host_length",
      sql`${t.baseUrlHost} IS NULL OR char_length(${t.baseUrlHost}) BETWEEN 1 AND 300`,
    ),
    check(
      "esign_connection_last_error_length",
      sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 500`,
    ),
    check("esign_connection_encryption_object", sql`jsonb_typeof(${t.encryption}) = 'object'`),
    check("esign_connection_hints_object", sql`jsonb_typeof(${t.credentialHints}) = 'object'`),
  ],
);

/** One envelope a vendor was asked to create. Retained under legal hold once signed. */
export const esignEnvelope = coreSchema.table(
  "esign_envelope",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => esignConnection.id),
    driver: text("driver").$type<ESignDriverValue>().notNull(),
    providerRef: text("provider_ref"),
    purpose: text("purpose").$type<ESignPurposeValue>().notNull(),
    subjectModule: text("subject_module").notNull(),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    legalDocumentId: uuid("legal_document_id"),
    legalVersionNo: integer("legal_version_no"),
    membershipId: uuid("membership_id").references(() => membership.id, { onDelete: "set null" }),
    signerName: text("signer_name").notNull(),
    signerEmail: citext("signer_email").notNull(),
    title: text("title").notNull(),
    status: text("status").$type<ESignEnvelopeStatusValue>().notNull().default("draft"),
    signerStatus: text("signer_status").$type<ESignSignerStatusValue>(),
    embedded: boolean("embedded").notNull().default(false),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
    syncAttempts: integer("sync_attempts").notNull().default(0),
    artifacts: jsonb("artifacts").$type<ESignEnvelopeArtifacts>(),
    artifactsSchemaVersion: integer("artifacts_schema_version").notNull().default(1),
    vaultFolder: text("vault_folder"),
    vaultedDocumentId: uuid("vaulted_document_id"),
    requestedByMembershipId: uuid("requested_by_membership_id").references(() => membership.id, {
      onDelete: "set null",
    }),
    signerPseudonymisedAt: timestamp("signer_pseudonymised_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("esign_envelope_provider_ref_idx")
      .on(t.workspaceId, t.driver, t.providerRef)
      .where(sql`${t.providerRef} IS NOT NULL`),
    index("esign_envelope_status_sync_idx").on(t.workspaceId, t.status, t.nextSyncAt),
    index("esign_envelope_member_idx").on(t.workspaceId, t.membershipId),
    index("esign_envelope_subject_idx").on(
      t.workspaceId,
      t.subjectModule,
      t.subjectKind,
      t.subjectId,
    ),
    index("esign_envelope_ws_created_idx").on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
    index("esign_envelope_connection_idx").on(t.connectionId),
    index("esign_envelope_requested_by_idx")
      .on(t.requestedByMembershipId)
      .where(sql`${t.requestedByMembershipId} IS NOT NULL`),
    check(
      "esign_envelope_driver",
      sql`${t.driver} IN ('documenso', 'docuseal', 'docusign', 'dropbox-sign')`,
    ),
    check("esign_envelope_purpose", sql`${t.purpose} IN ('nda', 'round_closing')`),
    check(
      "esign_envelope_status",
      sql`${t.status} IN ('draft', 'sent', 'delivered', 'completed', 'declined', 'voided', 'expired', 'error')`,
    ),
    check(
      "esign_envelope_signer_status",
      sql`${t.signerStatus} IS NULL OR ${t.signerStatus} IN ('pending', 'viewed', 'signed', 'declined')`,
    ),
    check(
      "esign_envelope_nda_shape",
      sql`(${t.purpose} = 'nda') = (${t.legalDocumentId} IS NOT NULL AND ${t.legalVersionNo} IS NOT NULL)`,
    ),
    check(
      "esign_envelope_provider_ref_length",
      sql`${t.providerRef} IS NULL OR char_length(${t.providerRef}) BETWEEN 1 AND 200`,
    ),
    check(
      "esign_envelope_subject_shape",
      sql`${t.subjectModule} ~ '^[a-z][a-z0-9-]{0,63}$' AND ${t.subjectKind} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    check("esign_envelope_signer_name_length", sql`char_length(${t.signerName}) BETWEEN 1 AND 300`),
    check(
      "esign_envelope_signer_email_length",
      sql`char_length(${t.signerEmail}) BETWEEN 1 AND 320`,
    ),
    check("esign_envelope_title_length", sql`char_length(${t.title}) BETWEEN 1 AND 300`),
    check(
      "esign_envelope_error_code_length",
      sql`${t.errorCode} IS NULL OR char_length(${t.errorCode}) <= 100`,
    ),
    check(
      "esign_envelope_error_detail_length",
      sql`${t.errorDetail} IS NULL OR char_length(${t.errorDetail}) <= 500`,
    ),
    check(
      "esign_envelope_vault_folder_length",
      sql`${t.vaultFolder} IS NULL OR char_length(${t.vaultFolder}) BETWEEN 1 AND 500`,
    ),
    check("esign_envelope_sync_attempts_nonnegative", sql`${t.syncAttempts} >= 0`),
    check(
      "esign_envelope_artifacts_object",
      sql`${t.artifacts} IS NULL OR jsonb_typeof(${t.artifacts}) = 'object'`,
    ),
  ],
);

export type ESignConnectionRow = typeof esignConnection.$inferSelect;
export type NewESignConnectionRow = typeof esignConnection.$inferInsert;
export type ESignEnvelopeRow = typeof esignEnvelope.$inferSelect;
export type NewESignEnvelopeRow = typeof esignEnvelope.$inferInsert;
