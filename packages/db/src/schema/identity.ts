import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { citext, coreSchema, workspace } from "./core.js";

/*
 * Identity, sessions, memberships (EXECUTION_PLAN §6.1, ADR-0011/0012/0013, E0.3).
 *
 * Typed view of `migrations/core/0001_identity.sql`; the SQL is authoritative (ADR-0004).
 *
 * Two populations of tables:
 *  - global (no workspace_id): user, user_identity, credential, session, device, rate_limit.
 *    Fenced by their own `global_fence` policies (host context, or the acting user, or —
 *    for user/user_identity — a member of the current workspace). Nothing here ever reveals
 *    a user's other workspaces (§6.1 privacy rules).
 *  - tenant (workspace_id): membership, group, group_member, invite, attestation get the
 *    standard `tenant_fence`; auth_challenge carries a custom fence that also admits the
 *    host context because login runs before a membership exists.
 */

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return "inet";
  },
});

export const identityType = coreSchema.enum("identity_type", ["email", "oidc", "saml", "host"]);
export const credentialKind = coreSchema.enum("credential_kind", [
  "passkey",
  "totp",
  "password",
  "recovery_codes",
]);
/** Where the session cookie lives (§6.3). `bearer` is reserved for API clients. */
export const sessionContext = coreSchema.enum("session_context", [
  "first_party",
  "partitioned",
  "bearer",
]);
/** Drives lifetimes (§6.3) and the MFA policy. */
export const authPopulation = coreSchema.enum("auth_population", ["external", "staff", "operator"]);
export const authChallengeKind = coreSchema.enum("auth_challenge_kind", [
  "email_otp",
  "magic_link",
  "webauthn_register",
  "webauthn_login",
  "oidc",
  // E3.8 (0022): a pending SAML AuthnRequest, and the canonical host's verified-login handoff.
  "saml",
  "sso_handoff",
  // E3.10 (0023): central auth's request (workspace host) and handoff code (canonical host), and
  // the self-service signup email code; a new operator's CLI enrolment link (and, once the
  // mailbox is proven, its short enrolment-only session).
  "central_request",
  "central_handoff",
  "signup",
  "operator_enrol",
]);
export const membershipKind = coreSchema.enum("membership_kind", ["staff", "external"]);
export const membershipRole = coreSchema.enum("membership_role", [
  "owner",
  "admin",
  "editor",
  "viewer",
  "finance",
  "legal",
  "investor",
  "delegate",
]);
export const membershipStatus = coreSchema.enum("membership_status", [
  "invited",
  "active",
  "dormant",
  "suspended",
  "revoked",
]);
export const inviteStatus = coreSchema.enum("invite_status", [
  "pending",
  "accepted",
  "expired",
  "revoked",
]);

export const IDENTITY_TYPES = identityType.enumValues;
export const CREDENTIAL_KINDS = credentialKind.enumValues;
export const SESSION_CONTEXTS = sessionContext.enumValues;
export const AUTH_POPULATIONS = authPopulation.enumValues;
export const AUTH_CHALLENGE_KINDS = authChallengeKind.enumValues;
export const MEMBERSHIP_KINDS = membershipKind.enumValues;
export const MEMBERSHIP_ROLES = membershipRole.enumValues;
export const MEMBERSHIP_STATUSES = membershipStatus.enumValues;
export const INVITE_STATUSES = inviteStatus.enumValues;
export const STAFF_ROLES = ["owner", "admin", "editor", "viewer", "finance", "legal"] as const;
export const EXTERNAL_ROLES = ["investor", "delegate"] as const;
/**
 * What a delegate inherits from its principal (E3.2, 0017): everything, or only the data room's /
 * the updates module's resources. `text` + CHECK rather than an enum so a scope can be added
 * without an enum migration.
 */
export const DELEGATE_SCOPES = ["all", "data_room", "updates"] as const;
export type DelegateScope = (typeof DELEGATE_SCOPES)[number];

export type IdentityType = (typeof IDENTITY_TYPES)[number];
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export type SessionContext = (typeof SESSION_CONTEXTS)[number];
export type AuthPopulation = (typeof AUTH_POPULATIONS)[number];
export type AuthChallengeKind = (typeof AUTH_CHALLENGE_KINDS)[number];
export type MembershipKind = (typeof MEMBERSHIP_KINDS)[number];
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export type InviteStatus = (typeof INVITE_STATUSES)[number];
export type StaffRole = (typeof STAFF_ROLES)[number];
export type ExternalRole = (typeof EXTERNAL_ROLES)[number];

// --- global ---------------------------------------------------------------

/** One global person (ADR-0011). Emails live in user_identity, never here. */
export const user = coreSchema.table(
  "user",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    displayName: text("display_name").notNull().default(""),
    avatarUrl: text("avatar_url"),
    /** Bumped by "sign out everywhere"; sessions store the version they were minted under. */
    sessionVersion: integer("session_version").notNull().default(1),
    mfaEnrolled: boolean("mfa_enrolled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** GDPR erasure pseudonymises the row; it is never deleted while audit rows reference it. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** E2.8 (0013): the user's UI/email language; NULL = follow the workspace / browser. */
    locale: text("locale"),
  },
  (t) => [
    check(
      "user_locale_shape",
      sql`${t.locale} IS NULL OR ${t.locale} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`,
    ),
  ],
);

export const userIdentity = coreSchema.table(
  "user_identity",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: identityType("type").notNull(),
    /** Lower-cased email, or `<iss>|<sub>` for oidc/saml, or `<workspace>|<host sub>` for host. */
    identifier: citext("identifier").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_identity_type_identifier_idx").on(t.type, t.identifier),
    uniqueIndex("user_identity_primary_idx").on(t.userId).where(sql`${t.isPrimary}`),
    index("user_identity_user_idx").on(t.userId),
  ],
);

/**
 * Passkeys, TOTP, passwords, recovery codes. Column use by kind:
 *  passkey        external_id (credential id, base64url), public_key, sign_count, transports,
 *                 backup_eligible, backed_up, aaguid
 *  totp           secret (encrypted with the key ring), confirmed_at once the first code verified
 *  password       secret (scrypt hash string)
 *  recovery_codes data.codes (HMAC hashes), one row per user, replaced on regeneration
 */
export const credential = coreSchema.table(
  "credential",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: credentialKind("kind").notNull(),
    label: text("label").notNull().default(""),
    externalId: text("external_id"),
    publicKey: bytea("public_key"),
    signCount: bigint("sign_count", { mode: "number" }),
    transports: text("transports").array(),
    backupEligible: boolean("backup_eligible"),
    backedUp: boolean("backed_up"),
    aaguid: text("aaguid"),
    secret: text("secret"),
    data: jsonb("data").notNull().default({}),
    dataSchemaVersion: integer("data_schema_version").notNull().default(1),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("credential_external_id_idx")
      .on(t.kind, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    index("credential_user_kind_idx").on(t.userId, t.kind).where(sql`${t.revokedAt} IS NULL`),
    check(
      "credential_kind_shape",
      sql`(${t.kind} <> 'passkey' OR (${t.externalId} IS NOT NULL AND ${t.publicKey} IS NOT NULL AND ${t.signCount} IS NOT NULL))
        AND (${t.kind} NOT IN ('totp', 'password') OR ${t.secret} IS NOT NULL)`,
    ),
  ],
);

/** "Remember this device": one row per (user, device cookie). */
export const device = coreSchema.table(
  "device",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** sha256 of the `__Host-did` cookie value. */
    tokenHash: bytea("token_hash").notNull(),
    name: text("name").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    trustedUntil: timestamp("trusted_until", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("device_token_hash_idx").on(t.tokenHash),
    index("device_user_idx").on(t.userId).where(sql`${t.revokedAt} IS NULL`),
  ],
);

/** Server-side opaque sessions (ADR-0013). The cookie carries a 256-bit token; only its hash is stored. */
export const session = coreSchema.table(
  "session",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    tokenHash: bytea("token_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").references(() => device.id, { onDelete: "set null" }),
    population: authPopulation("population").notNull(),
    context: sessionContext("context").notNull(),
    /** 0 host-asserted, 1 email/password verified, 2 MFA (§6.2). */
    authLevel: smallint("auth_level").notNull(),
    /** When the current auth level was last proven; step-up compares this (§6.2). */
    authTime: timestamp("auth_time", { withTimezone: true }).notNull(),
    /** Copy of user.session_version at mint time; mismatch = signed out everywhere. */
    sessionVersion: integer("session_version").notNull(),
    /** Top-level site for partitioned (embed) sessions; null for first-party. */
    topSite: text("top_site"),
    ip: inet("ip"),
    userAgent: text("user_agent").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    lastWorkspaceId: uuid("last_workspace_id").references(() => workspace.id, {
      onDelete: "set null",
    }),
    /** Hash of the one-click "this wasn't me" token in the new-device email. */
    revokeTokenHash: bytea("revoke_token_hash"),
    // --- view as investor (E2.7, 0012): all four set together or none ---
    /** The external membership this staff session is currently viewing the portal as. No FK. */
    viewAsMembershipId: uuid("view_as_membership_id"),
    /** The workspace of that membership; the view only applies when it is the resolved one. */
    viewAsWorkspaceId: uuid("view_as_workspace_id").references(() => workspace.id, {
      onDelete: "cascade",
    }),
    /** The view ends at this instant (started + 30 min); expired views are cleared lazily. */
    viewAsUntil: timestamp("view_as_until", { withTimezone: true }),
    viewAsStartedAt: timestamp("view_as_started_at", { withTimezone: true }),
    // --- staff SSO (E3.8, 0022): both set or neither ---
    /**
     * The workspace whose IdP asserted this session. A bound session is treated as no session on
     * any request whose resolved workspace is another one (or none).
     */
    ssoWorkspaceId: uuid("sso_workspace_id").references(() => workspace.id, {
      onDelete: "cascade",
    }),
    /**
     * The `core.sso_connection` that minted it. The SQL declares the FK (ON DELETE CASCADE); it is
     * left out here so this file does not import `./sso.js`, which imports it.
     */
    ssoConnectionId: uuid("sso_connection_id"),
    /** The connection's `version` when this session was minted (checked on every request). */
    ssoConnectionVersion: integer("sso_connection_version"),
    /**
     * E3.10 (0023): minted by a central-auth handoff on this workspace's host. Like
     * `ssoWorkspaceId`, a bound session is treated as no session on any other workspace (or on the
     * canonical host), and may not read or change global account state.
     */
    boundWorkspaceId: uuid("bound_workspace_id").references(() => workspace.id, {
      onDelete: "cascade",
    }),
    /**
     * E3.10 (0023): the session this one was minted from (a central-auth handoff's or an operator
     * session's canonical session). Signing the source out revokes the sessions it minted. The SQL
     * declares the self-FK (ON DELETE SET NULL); it is left out here (self-reference).
     */
    sourceSessionId: uuid("source_session_id"),
  },
  (t) => [
    uniqueIndex("session_token_hash_idx").on(t.tokenHash),
    index("session_user_active_idx").on(t.userId, t.lastSeenAt).where(sql`${t.revokedAt} IS NULL`),
    index("session_absolute_expires_idx").on(t.absoluteExpiresAt),
    check("session_auth_level_range", sql`${t.authLevel} BETWEEN 0 AND 2`),
    index("session_sso_connection_idx")
      .on(t.ssoConnectionId)
      .where(sql`${t.ssoConnectionId} IS NOT NULL`),
    check("session_sso_shape", sql`num_nulls(${t.ssoWorkspaceId}, ${t.ssoConnectionId}) IN (0, 2)`),
    check(
      "session_sso_version_shape",
      sql`${t.ssoConnectionVersion} IS NULL OR ${t.ssoConnectionId} IS NOT NULL`,
    ),
    index("session_bound_workspace_idx")
      .on(t.boundWorkspaceId)
      .where(sql`${t.boundWorkspaceId} IS NOT NULL`),
    index("session_source_session_idx")
      .on(t.sourceSessionId)
      .where(sql`${t.sourceSessionId} IS NOT NULL`),
    check(
      "session_bound_shape",
      sql`${t.boundWorkspaceId} IS NULL OR ${t.population} <> 'operator'`,
    ),
    check(
      "session_view_as_shape",
      sql`num_nulls(${t.viewAsMembershipId}, ${t.viewAsWorkspaceId}, ${t.viewAsUntil}, ${t.viewAsStartedAt}) IN (0, 4)`,
    ),
  ],
);

/** Postgres sliding-window counters (RateLimiterPort default adapter). No user data: keys are hashed. */
export const rateLimit = coreSchema.table(
  "rate_limit",
  {
    key: text("key").notNull(),
    bucket: bigint("bucket", { mode: "number" }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.bucket] })],
);

// --- tenant ---------------------------------------------------------------

/**
 * Short-lived login state: OTP codes, magic-link tokens, WebAuthn challenges, OIDC state.
 * Secrets are stored hashed (HMAC with the key ring for guessable ones). Runs in host
 * context because no membership exists yet, hence the custom fence in the migration.
 */
export const authChallenge = coreSchema.table(
  "auth_challenge",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    kind: authChallengeKind("kind").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspace.id, { onDelete: "cascade" }),
    email: citext("email"),
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** HMAC/sha256 of the code, token, challenge or OIDC state. */
    secretHash: bytea("secret_hash").notNull(),
    /** Magic link: sha256 of the `__Host-auth_req` browser-binding cookie. */
    bindingHash: bytea("binding_hash"),
    data: jsonb("data").notNull().default({}),
    dataSchemaVersion: integer("data_schema_version").notNull().default(1),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    ip: inet("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("auth_challenge_secret_hash_idx").on(t.kind, t.secretHash),
    index("auth_challenge_email_idx")
      .on(t.kind, t.email, t.createdAt)
      .where(sql`${t.consumedAt} IS NULL`),
    index("auth_challenge_expires_idx").on(t.expiresAt),
  ],
);

/** The unit audit and analytics reference (§6.1). One active row per (workspace, user). */
export const membership = coreSchema.table(
  "membership",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    kind: membershipKind("kind").notNull(),
    role: membershipRole("role").notNull(),
    status: membershipStatus("status").notNull().default("invited"),
    /** `invite` | `link:<id>` | `sso` | `host` | `request` | `setup`. */
    source: text("source").notNull(),
    /** Delegates act for a principal membership; revoked with it (§13.2). */
    principalMembershipId: uuid("principal_membership_id"),
    /** E3.2 (0017): `DelegateScope`; set iff role = 'delegate'. */
    delegateScope: text("delegate_scope").$type<DelegateScope>(),
    profile: jsonb("profile").notNull().default({}),
    profileSchemaVersion: integer("profile_schema_version").notNull().default(1),
    relationshipEstablishedAt: timestamp("relationship_established_at", { withTimezone: true }),
    relationshipSource: text("relationship_source"),
    /** Free text counsel asked for alongside the enumerated source (design/04 §1.6, E1.6). */
    relationshipNote: text("relationship_note"),
    /** First time this member was served offering material; the other half of the R5 heuristic. */
    firstExposureAt: timestamp("first_exposure_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    reverifyDueAt: timestamp("reverify_due_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    revokeReason: text("revoke_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("membership_active_user_idx")
      .on(t.workspaceId, t.userId)
      .where(sql`${t.status} <> 'revoked'`),
    index("membership_workspace_status_idx").on(t.workspaceId, t.status, t.kind),
    index("membership_user_idx").on(t.userId),
    index("membership_principal_idx")
      .on(t.principalMembershipId)
      .where(sql`${t.principalMembershipId} IS NOT NULL`),
    check(
      "membership_kind_role",
      sql`(${t.kind} = 'staff' AND ${t.role} IN ('owner', 'admin', 'editor', 'viewer', 'finance', 'legal'))
        OR (${t.kind} = 'external' AND ${t.role} IN ('investor', 'delegate'))`,
    ),
    check(
      "membership_delegate_principal",
      sql`(${t.role} = 'delegate') = (${t.principalMembershipId} IS NOT NULL)`,
    ),
    check(
      "membership_delegate_scope",
      sql`(${t.role} = 'delegate') = (${t.delegateScope} IS NOT NULL)
  AND (${t.delegateScope} IS NULL OR ${t.delegateScope} IN ('all', 'data_room', 'updates'))`,
    ),
  ],
);

/** Workspace-scoped audiences: "Seed investors", "Board", "Series A prospects". */
export const group = coreSchema.table(
  "group",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** `custom` | `round` | `board` | `advisors`; drives badges, not permissions. */
    kind: text("kind").notNull().default("custom"),
    defaultPolicies: jsonb("default_policies").notNull().default({}),
    defaultPoliciesSchemaVersion: integer("default_policies_schema_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("group_workspace_name_idx")
      .on(t.workspaceId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const groupMember = coreSchema.table(
  "group_member",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => group.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    /** Kept, not deleted, on removal/revocation (§13.2). */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.membershipId] }),
    index("group_member_workspace_membership_idx").on(t.workspaceId, t.membershipId),
  ],
);

/** Invitation addressed by opaque token (§13.1). Accepting = OTP/link verification of the email. */
export const invite = coreSchema.table(
  "invite",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    email: citext("email").notNull(),
    tokenHash: bytea("token_hash").notNull(),
    kind: membershipKind("kind").notNull(),
    role: membershipRole("role").notNull(),
    groupIds: uuid("group_ids").array().notNull().default(sql`'{}'::uuid[]`),
    grants: jsonb("grants").notNull().default([]),
    grantsSchemaVersion: integer("grants_schema_version").notNull().default(1),
    /** Copied onto the membership profile on acceptance (`displayName`, `firm`, …). Added in 0004. */
    profile: jsonb("profile").notNull().default({}),
    profileSchemaVersion: integer("profile_schema_version").notNull().default(1),
    message: text("message"),
    status: inviteStatus("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invitedBy: uuid("invited_by"),
    acceptedMembershipId: uuid("accepted_membership_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** E3.1 (0016): the access request this invite approves; membership.source = `request`. */
    accessRequestId: uuid("access_request_id").references((): AnyPgColumn => accessRequest.id, {
      onDelete: "set null",
    }),
    /** E3.2 (0017): a delegate invitation names its principal; acceptance copies it over. */
    principalMembershipId: uuid("principal_membership_id").references(() => membership.id, {
      onDelete: "cascade",
    }),
    delegateScope: text("delegate_scope").$type<DelegateScope>(),
  },
  (t) => [
    uniqueIndex("invite_token_hash_idx").on(t.tokenHash),
    index("invite_workspace_email_idx")
      .on(t.workspaceId, t.email)
      .where(sql`${t.status} = 'pending'`),
    index("invite_access_request_idx")
      .on(t.accessRequestId)
      .where(sql`${t.accessRequestId} IS NOT NULL`),
    index("invite_principal_idx")
      .on(t.principalMembershipId)
      .where(sql`${t.principalMembershipId} IS NOT NULL`),
    check(
      "invite_kind_role",
      sql`(${t.kind} = 'staff' AND ${t.role} IN ('owner', 'admin', 'editor', 'viewer', 'finance', 'legal'))
        OR (${t.kind} = 'external' AND ${t.role} IN ('investor', 'delegate'))`,
    ),
    check(
      "invite_delegate",
      sql`(${t.principalMembershipId} IS NULL) = (${t.delegateScope} IS NULL)
  AND (${t.role} = 'delegate') = (${t.principalMembershipId} IS NOT NULL)
  AND (${t.delegateScope} IS NULL OR ${t.delegateScope} IN ('all', 'data_room', 'updates'))`,
    ),
  ],
);

/** E3.1 (0016): lifecycle of a public access request. */
export const accessRequestStatus = coreSchema.enum("access_request_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);
export const ACCESS_REQUEST_STATUSES = accessRequestStatus.enumValues;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

/**
 * A prospective investor's verified "request access" submission (E3.1, 0016). Created only when
 * an emailed code is proven (`accessRequestChallenge`), `pending` in the admin queue until
 * approved (an ordinary invite, `invite.access_request_id`), denied, or expired. Staff/system
 * only. `clientIpHash` is a secret: never exported, never returned by the API.
 * Not the GDPR "access request" (`dsar_request`).
 */
export const accessRequest = coreSchema.table(
  "access_request",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    email: citext("email").notNull(),
    name: text("name").notNull(),
    firm: text("firm"),
    reason: text("reason"),
    status: accessRequestStatus("status").notNull().default("pending"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** Copied from `access.requests.defaultGroupIds` at verification. */
    suggestedGroupIds: uuid("suggested_group_ids").array().notNull().default(sql`'{}'::uuid[]`),
    autoApproved: boolean("auto_approved").notNull().default(false),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => membership.id, { onDelete: "set null" }),
    /** Staff-only; never mailed. */
    decisionNote: text("decision_note"),
    relationshipEstablishedAt: timestamp("relationship_established_at", { withTimezone: true }),
    relationshipSource: text("relationship_source"),
    relationshipNote: text("relationship_note"),
    inviteId: uuid("invite_id").references((): AnyPgColumn => invite.id, { onDelete: "set null" }),
    membershipId: uuid("membership_id").references(() => membership.id, { onDelete: "set null" }),
    /** Keyed hash of the client address, abuse review only. */
    clientIpHash: bytea("client_ip_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("access_request_open_email_uq")
      .on(t.workspaceId, t.email)
      .where(sql`${t.status} = 'pending'`),
    index("access_request_ws_status_idx").on(t.workspaceId, t.status, t.createdAt.desc()),
    check("access_request_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 120`),
    check("access_request_firm_length", sql`${t.firm} IS NULL OR char_length(${t.firm}) <= 160`),
    check(
      "access_request_reason_length",
      sql`${t.reason} IS NULL OR char_length(${t.reason}) <= 2000`,
    ),
    check(
      "access_request_decision_note_length",
      sql`${t.decisionNote} IS NULL OR char_length(${t.decisionNote}) <= 2000`,
    ),
    check(
      "access_request_relationship_note_length",
      sql`${t.relationshipNote} IS NULL OR char_length(${t.relationshipNote}) <= 2000`,
    ),
  ],
);

/**
 * One public "request access" submission and its emailed code (E3.1, 0016): the text THAT
 * submission carried. Deleted when any code for the address is proven (the matched one's text
 * becomes the request's) or by the sweeper after `expiresAt`. System actor only; never exported.
 * `id` is generated by the caller because `codeHash` is an HMAC scoped to it.
 */
export const accessRequestChallenge = coreSchema.table(
  "access_request_challenge",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    email: citext("email").notNull(),
    name: text("name").notNull(),
    firm: text("firm"),
    reason: text("reason"),
    codeHash: bytea("code_hash").notNull(),
    clientIpHash: bytea("client_ip_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("access_request_challenge_email_idx").on(t.workspaceId, t.email, t.expiresAt),
    index("access_request_challenge_expiry_idx").on(t.workspaceId, t.expiresAt),
    check("access_request_challenge_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 120`),
    check(
      "access_request_challenge_firm_length",
      sql`${t.firm} IS NULL OR char_length(${t.firm}) <= 160`,
    ),
    check(
      "access_request_challenge_reason_length",
      sql`${t.reason} IS NULL OR char_length(${t.reason}) <= 2000`,
    ),
  ],
);

/** Legal facts per membership, never per user: NDA vN, accreditation, privacy notice, consent. */
export const attestation = coreSchema.table(
  "attestation",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    /** `nda:v3`, `accredited`, `privacy_notice:v2`, `analytics_consent`. */
    kind: text("kind").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
    evidenceRef: text("evidence_ref"),
    data: jsonb("data").notNull().default({}),
    dataSchemaVersion: integer("data_schema_version").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("attestation_membership_kind_idx")
      .on(t.workspaceId, t.membershipId, t.kind)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type UserIdentity = typeof userIdentity.$inferSelect;
export type NewUserIdentity = typeof userIdentity.$inferInsert;
export type Credential = typeof credential.$inferSelect;
export type NewCredential = typeof credential.$inferInsert;
export type Device = typeof device.$inferSelect;
export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;
export type AuthChallenge = typeof authChallenge.$inferSelect;
export type NewAuthChallenge = typeof authChallenge.$inferInsert;
export type Membership = typeof membership.$inferSelect;
export type NewMembership = typeof membership.$inferInsert;
export type Group = typeof group.$inferSelect;
export type GroupMember = typeof groupMember.$inferSelect;
export type Invite = typeof invite.$inferSelect;
export type NewInvite = typeof invite.$inferInsert;
export type Attestation = typeof attestation.$inferSelect;
export type AccessRequest = typeof accessRequest.$inferSelect;
export type NewAccessRequest = typeof accessRequest.$inferInsert;
export type NewAttestation = typeof attestation.$inferInsert;
