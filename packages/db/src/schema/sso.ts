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
import { bytea, membership, membershipRole, user } from "./identity.js";

/*
 * Staff SSO (OIDC + SAML) and SCIM 2.0 provisioning (EXECUTION_PLAN §15 E3.8, ADR-0056).
 *
 * Typed view of `migrations/core/0022_sso_scim.sql`; the SQL is authoritative (ADR-0004) — the
 * fences (with the host SELECT on sso_connection / sso_domain / scim_token and the host INSERT on
 * sso_assertion_replay), the permissive staff/system policies and the `set_updated_at` triggers
 * live there. The services are `@fundroom/sso` and `@fundroom/scim`.
 */

export const SSO_PROTOCOL_VALUES = ["oidc", "saml"] as const;
export type SsoProtocolValue = (typeof SSO_PROTOCOL_VALUES)[number];
export const SSO_ENFORCE_VALUES = ["off", "staff"] as const;
export type SsoEnforceValue = (typeof SSO_ENFORCE_VALUES)[number];
export const SSO_CONNECTION_STATUSES = ["active", "error"] as const;
export type SsoConnectionStatus = (typeof SSO_CONNECTION_STATUSES)[number];
/** Roles a JIT-provisioned staff member may get (never owner or admin). */
export const SSO_JIT_ROLES = ["editor", "viewer", "finance", "legal"] as const;
export type SsoJitRoleValue = (typeof SSO_JIT_ROLES)[number];
export const SSO_DOMAIN_STATUSES = ["pending", "verified"] as const;
export type SsoDomainStatus = (typeof SSO_DOMAIN_STATUSES)[number];
/** Roles a SCIM group may map to (never owner). */
export const SCIM_MAPPABLE_ROLES = ["admin", "editor", "viewer", "finance", "legal"] as const;
export type ScimMappableRoleValue = (typeof SCIM_MAPPABLE_ROLES)[number];

/** One sealed column's reference (SHE1 under the `sso-credentials` workspace key). */
export interface SsoSealedRef {
  readonly format: string;
  readonly keyId: string;
  readonly keyRef: string;
}

/** `sso_connection.encryption` (schema version 1). */
export interface SsoConnectionEncryption {
  readonly credentials: SsoSealedRef;
}

/** `sso_connection.options` (schema version 1). */
export interface SsoConnectionOptions {
  readonly trustMfa?: boolean | undefined;
  readonly mfaValues?: readonly string[] | undefined;
}

/** At most one live (`deleted_at IS NULL`) connection per workspace. */
export const ssoConnection = coreSchema.table(
  "sso_connection",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    protocol: text("protocol").$type<SsoProtocolValue>().notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    enforce: text("enforce").$type<SsoEnforceValue>().notNull().default("off"),
    version: integer("version").notNull().default(1),
    oidcIssuer: text("oidc_issuer"),
    oidcClientId: text("oidc_client_id"),
    credentialsEnc: bytea("credentials_enc"),
    encryption: jsonb("encryption").$type<SsoConnectionEncryption>(),
    encryptionSchemaVersion: integer("encryption_schema_version").notNull().default(1),
    samlIdpEntityId: text("saml_idp_entity_id"),
    samlIdpSsoUrl: text("saml_idp_sso_url"),
    /** PEM signing certificates. */
    samlIdpCerts: text("saml_idp_certs").array(),
    options: jsonb("options").$type<SsoConnectionOptions>().notNull().default(sql`'{}'::jsonb`),
    optionsSchemaVersion: integer("options_schema_version").notNull().default(1),
    jitEnabled: boolean("jit_enabled").notNull().default(false),
    jitRole: membershipRole("jit_role").$type<SsoJitRoleValue>().notNull().default("viewer"),
    status: text("status").$type<SsoConnectionStatus>().notNull().default("active"),
    lastError: text("last_error"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id").references(() => membership.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sso_connection_live_idx").on(t.workspaceId).where(sql`${t.deletedAt} IS NULL`),
    index("sso_connection_creator_idx")
      .on(t.createdByMembershipId)
      .where(sql`${t.createdByMembershipId} IS NOT NULL`),
    check("sso_connection_protocol", sql`${t.protocol} IN ('oidc', 'saml')`),
    check("sso_connection_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    check("sso_connection_enforce", sql`${t.enforce} IN ('off', 'staff')`),
    check("sso_connection_version_positive", sql`${t.version} >= 1`),
    check("sso_connection_jit_role", sql`${t.jitRole} IN ('editor', 'viewer', 'finance', 'legal')`),
    check("sso_connection_status", sql`${t.status} IN ('active', 'error')`),
    check(
      "sso_connection_last_error_length",
      sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 500`,
    ),
    check("sso_connection_options_object", sql`jsonb_typeof(${t.options}) = 'object'`),
    check(
      "sso_connection_sealed_shape",
      sql`(${t.credentialsEnc} IS NULL) = (${t.encryption} IS NULL) AND (${t.encryption} IS NULL OR jsonb_typeof(${t.encryption}) = 'object')`,
    ),
    check(
      "sso_connection_protocol_shape",
      sql`(${t.protocol} = 'oidc' AND ${t.oidcIssuer} IS NOT NULL AND ${t.oidcClientId} IS NOT NULL) OR (${t.protocol} = 'saml' AND ${t.samlIdpEntityId} IS NOT NULL AND ${t.samlIdpSsoUrl} IS NOT NULL AND ${t.samlIdpCerts} IS NOT NULL AND cardinality(${t.samlIdpCerts}) >= 1)`,
    ),
  ],
);

/** DNS-TXT-proven email domains; a verified domain belongs to one workspace per install. */
export const ssoDomain = coreSchema.table(
  "sso_domain",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    domain: citext("domain").notNull(),
    token: text("token").notNull(),
    status: text("status").$type<SsoDomainStatus>().notNull().default("pending"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sso_domain_workspace_domain_idx").on(t.workspaceId, t.domain),
    uniqueIndex("sso_domain_verified_idx").on(t.domain).where(sql`${t.status} = 'verified'`),
    check(
      "sso_domain_format",
      sql`char_length(${t.domain}) <= 253 AND ${t.domain}::text = lower(${t.domain}::text) AND ${t.domain} ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    check("sso_domain_token_length", sql`char_length(${t.token}) BETWEEN 16 AND 128`),
    check("sso_domain_status", sql`${t.status} IN ('pending', 'verified')`),
    check(
      "sso_domain_verified_shape",
      sql`${t.status} <> 'verified' OR ${t.verifiedAt} IS NOT NULL`,
    ),
    check(
      "sso_domain_last_error_length",
      sql`${t.lastError} IS NULL OR char_length(${t.lastError}) <= 500`,
    ),
  ],
);

/** SAML assertion ids already consumed, per connection, until `expires_at` (then swept). */
export const ssoAssertionReplay = coreSchema.table(
  "sso_assertion_replay",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => ssoConnection.id, { onDelete: "cascade" }),
    assertionId: text("assertion_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.assertionId] }),
    index("sso_assertion_replay_expires_idx").on(t.expiresAt),
    check("sso_assertion_replay_id_length", sql`char_length(${t.assertionId}) BETWEEN 1 AND 512`),
  ],
);

/**
 * SCIM bearer tokens (`frs_…`, or legacy `shs_…`; sha256 stored). At most two live per workspace
 * (service rule).
 */
export const scimToken = coreSchema.table(
  "scim_token",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull(),
    displayPrefix: text("display_prefix").notNull(),
    name: text("name").notNull(),
    createdByMembershipId: uuid("created_by_membership_id").references(() => membership.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("scim_token_hash_idx").on(t.tokenHash),
    index("scim_token_live_idx").on(t.workspaceId).where(sql`${t.revokedAt} IS NULL`),
    index("scim_token_creator_idx")
      .on(t.createdByMembershipId)
      .where(sql`${t.createdByMembershipId} IS NOT NULL`),
    check("scim_token_hash_length", sql`octet_length(${t.tokenHash}) = 32`),
    check("scim_token_prefix_length", sql`char_length(${t.displayPrefix}) BETWEEN 4 AND 32`),
    check("scim_token_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 80`),
  ],
);

/** The IdP's per-workspace view of a person; `id` is the SCIM id. Never global user fields. */
export const scimUser = coreSchema.table(
  "scim_user",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id").references(() => membership.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),
    externalId: text("external_id"),
    userName: citext("user_name").notNull(),
    email: citext("email"),
    displayName: text("display_name"),
    givenName: text("given_name"),
    familyName: text("family_name"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("scim_user_user_name_idx")
      .on(t.workspaceId, t.userName)
      .where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex("scim_user_external_id_idx")
      .on(t.workspaceId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    uniqueIndex("scim_user_membership_idx").on(t.membershipId).where(sql`${t.deletedAt} IS NULL`),
    index("scim_user_user_idx").on(t.userId).where(sql`${t.userId} IS NOT NULL`),
    check("scim_user_user_name_length", sql`char_length(${t.userName}) BETWEEN 1 AND 320`),
    check("scim_user_email_length", sql`${t.email} IS NULL OR char_length(${t.email}) <= 320`),
    check(
      "scim_user_external_id_length",
      sql`${t.externalId} IS NULL OR char_length(${t.externalId}) BETWEEN 1 AND 512`,
    ),
    check(
      "scim_user_names_length",
      sql`(${t.displayName} IS NULL OR char_length(${t.displayName}) <= 256) AND (${t.givenName} IS NULL OR char_length(${t.givenName}) <= 256) AND (${t.familyName} IS NULL OR char_length(${t.familyName}) <= 256)`,
    ),
  ],
);

/** SCIM groups; `role` is the staff role an admin mapped it to (never owner). */
export const scimGroup = coreSchema.table(
  "scim_group",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    externalId: text("external_id"),
    role: membershipRole("role").$type<ScimMappableRoleValue>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("scim_group_display_name_idx")
      .on(t.workspaceId, sql`lower(${t.displayName})`)
      .where(sql`${t.deletedAt} IS NULL`),
    check("scim_group_display_name_length", sql`char_length(${t.displayName}) BETWEEN 1 AND 256`),
    check(
      "scim_group_external_id_length",
      sql`${t.externalId} IS NULL OR char_length(${t.externalId}) BETWEEN 1 AND 512`,
    ),
    check(
      "scim_group_role",
      sql`${t.role} IS NULL OR ${t.role} IN ('admin', 'editor', 'viewer', 'finance', 'legal')`,
    ),
  ],
);

export const scimGroupMember = coreSchema.table(
  "scim_group_member",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => scimGroup.id, { onDelete: "cascade" }),
    scimUserId: uuid("scim_user_id")
      .notNull()
      .references(() => scimUser.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.scimUserId] }),
    index("scim_group_member_user_idx").on(t.scimUserId),
  ],
);

export type SsoConnectionRecord = typeof ssoConnection.$inferSelect;
export type SsoDomainRecord = typeof ssoDomain.$inferSelect;
export type ScimTokenRecord = typeof scimToken.$inferSelect;
export type ScimUserRecord = typeof scimUser.$inferSelect;
export type ScimGroupRecord = typeof scimGroup.$inferSelect;
