import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";
import { membership, membershipRole } from "./identity.js";

/*
 * Access management (EXECUTION_PLAN §6.4, ADR-0014, ADR-0032, E1.1).
 *
 * Typed view of `migrations/core/0004_access.sql`; the SQL is authoritative (ADR-0004).
 * All tenant tables with the standard fence. The evaluator, repositories and the rebuild
 * job live in `@fundroom/authz`; the invite import job in `@fundroom/identity`.
 */

/** Materialised path (`ltree`); drizzle has no built-in type. Labels: `[A-Za-z0-9_-]`, dot-separated. */
export const ltree = customType<{ data: string; driverData: string }>({
  dataType() {
    return "ltree";
  },
});

/** `tstzrange` as its canonical text form, e.g. `["2026-09-11 10:00:00+00",)`. */
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tstzrange";
  },
});

export const grantSubjectKind = coreSchema.enum("grant_subject_kind", [
  "membership",
  "group",
  "role",
  "link",
]);
export const grantEffect = coreSchema.enum("grant_effect", ["allow", "exclude"]);
export const accessCapability = coreSchema.enum("access_capability", [
  "view",
  "download",
  "comment",
  "edit",
]);
export const policyKind = coreSchema.enum("policy_kind", [
  "nda",
  "accredited",
  "min_auth_level",
  "ip_allowlist",
]);
export const policyTargetKind = coreSchema.enum("policy_target_kind", [
  "workspace",
  "group",
  "membership",
  "resource",
  // E2.3: a gate attached to the share link a visitor came through, not to the visitor. It
  // applies only while `core.share_link_visit` still binds them to that link.
  "link",
]);
export const inviteImportStatus = coreSchema.enum("invite_import_status", [
  "queued",
  "running",
  "done",
  "failed",
]);

export const GRANT_SUBJECT_KINDS = grantSubjectKind.enumValues;
export const GRANT_EFFECTS = grantEffect.enumValues;
export const ACCESS_CAPABILITIES = accessCapability.enumValues;
export const POLICY_KINDS = policyKind.enumValues;
export const POLICY_TARGET_KINDS = policyTargetKind.enumValues;
export const INVITE_IMPORT_STATUSES = inviteImportStatus.enumValues;

export type GrantSubjectKind = (typeof GRANT_SUBJECT_KINDS)[number];
export type GrantEffect = (typeof GRANT_EFFECTS)[number];
export type AccessCapability = (typeof ACCESS_CAPABILITIES)[number];
export type PolicyKind = (typeof POLICY_KINDS)[number];
export type PolicyTargetKind = (typeof POLICY_TARGET_KINDS)[number];
export type InviteImportStatus = (typeof INVITE_IMPORT_STATUSES)[number];

/** `subject → resource → capability` with effect allow|exclude and a validity window (ADR-0014). */
export const accessGrant = coreSchema.table(
  "access_grant",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    subjectKind: grantSubjectKind("subject_kind").notNull(),
    /** membership / group / link id; null for role subjects. */
    subjectId: uuid("subject_id"),
    /** Staff role for role subjects; null otherwise. */
    subjectRole: membershipRole("subject_role"),
    resourceKind: text("resource_kind").notNull(),
    resourceId: uuid("resource_id").notNull(),
    /** Materialised path for hierarchical resources (folders); null for flat ones. */
    resourcePath: ltree("resource_path"),
    capability: accessCapability("capability").notNull(),
    effect: grantEffect("effect").notNull().default("allow"),
    validity: tstzrange("validity").notNull().default(sql`tstzrange(now(), NULL, '[)')`),
    maxViews: integer("max_views"),
    note: text("note"),
    /** Membership id of the staff member who created the rule. */
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
  },
  (t) => [
    index("access_grant_resource_idx")
      .on(t.workspaceId, t.resourceKind, t.resourceId)
      .where(sql`${t.revokedAt} IS NULL`),
    index("access_grant_subject_idx")
      .on(t.workspaceId, t.subjectKind, t.subjectId)
      .where(sql`${t.revokedAt} IS NULL`),
    check(
      "access_grant_subject_shape",
      sql`(${t.subjectKind} = 'role' AND ${t.subjectRole} IS NOT NULL AND ${t.subjectId} IS NULL)
        OR (${t.subjectKind} <> 'role' AND ${t.subjectId} IS NOT NULL AND ${t.subjectRole} IS NULL)`,
    ),
    check("access_grant_resource_kind_format", sql`${t.resourceKind} ~ '^[a-z][a-z0-9_-]*$'`),
    check("access_grant_max_views_positive", sql`${t.maxViews} IS NULL OR ${t.maxViews} > 0`),
    check("access_grant_validity_nonempty", sql`NOT isempty(${t.validity})`),
  ],
);

/** A gate (NDA version, accreditation, auth level, IP allowlist) on a workspace, group, membership, share link or resource. */
export const accessPolicy = coreSchema.table(
  "access_policy",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    targetKind: policyTargetKind("target_kind").notNull(),
    /** Group / membership / share link id, or the resource id; null for workspace-wide gates. */
    targetId: uuid("target_id"),
    resourceKind: text("resource_kind"),
    resourcePath: ltree("resource_path"),
    kind: policyKind("kind").notNull(),
    config: jsonb("config").notNull().default({}),
    configSchemaVersion: integer("config_schema_version").notNull().default(1),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
  },
  (t) => [
    index("access_policy_target_idx")
      .on(t.workspaceId, t.targetKind, t.targetId)
      .where(sql`${t.revokedAt} IS NULL`),
    check(
      "access_policy_target_shape",
      sql`(${t.targetKind} = 'workspace' AND ${t.targetId} IS NULL AND ${t.resourceKind} IS NULL)
        OR (${t.targetKind} IN ('group', 'membership') AND ${t.targetId} IS NOT NULL AND ${t.resourceKind} IS NULL)
        OR (${t.targetKind} = 'link' AND ${t.targetId} IS NOT NULL AND ${t.resourceKind} IS NULL)
        OR (${t.targetKind} = 'resource' AND ${t.targetId} IS NOT NULL AND ${t.resourceKind} IS NOT NULL)`,
    ),
    check(
      "access_policy_resource_kind_format",
      sql`${t.resourceKind} IS NULL OR ${t.resourceKind} ~ '^[a-z][a-z0-9_-]*$'`,
    ),
  ],
);

/**
 * Materialised access per (membership, granted node), rebuilt by `authz.rebuild` whenever the
 * workspace `acl_version` moves. `core.has_access()` reads it for investor RLS policies.
 */
export const effectiveAccess = coreSchema.table(
  "effective_access",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    resourceKind: text("resource_kind").notNull(),
    resourceId: uuid("resource_id").notNull(),
    resourcePath: ltree("resource_path"),
    capabilities: accessCapability("capabilities").array().notNull(),
    pendingGates: jsonb("pending_gates").notNull().default([]),
    pendingGatesSchemaVersion: integer("pending_gates_schema_version").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    aclVersion: bigint("acl_version", { mode: "number" }).notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.membershipId, t.resourceKind, t.resourceId] }),
    index("effective_access_resource_idx").on(t.workspaceId, t.resourceKind, t.resourceId),
    index("effective_access_path_idx").using("gist", t.resourcePath),
  ],
);

/** Which `acl_version` a workspace's effective_access rows were built for. */
export const effectiveAccessState = coreSchema.table("effective_access_state", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspace.id, { onDelete: "cascade" }),
  aclVersion: bigint("acl_version", { mode: "number" }).notNull(),
  builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
  rowCount: integer("row_count").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
});

/** A CSV invite import (design/05 §5 "Bulk CSV"): rows and their per-row status in jsonb. */
export const inviteImport = coreSchema.table(
  "invite_import",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    status: inviteImportStatus("status").notNull().default("queued"),
    defaults: jsonb("defaults").notNull().default({}),
    defaultsSchemaVersion: integer("defaults_schema_version").notNull().default(1),
    rows: jsonb("rows").notNull().default([]),
    rowsSchemaVersion: integer("rows_schema_version").notNull().default(1),
    total: integer("total").notNull().default(0),
    invited: integer("invited").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [index("invite_import_workspace_idx").on(t.workspaceId, t.createdAt)],
);

export type AccessGrant = typeof accessGrant.$inferSelect;
export type NewAccessGrant = typeof accessGrant.$inferInsert;
export type AccessPolicy = typeof accessPolicy.$inferSelect;
export type NewAccessPolicy = typeof accessPolicy.$inferInsert;
export type EffectiveAccessRow = typeof effectiveAccess.$inferSelect;
export type NewEffectiveAccessRow = typeof effectiveAccess.$inferInsert;
export type EffectiveAccessState = typeof effectiveAccessState.$inferSelect;
export type InviteImport = typeof inviteImport.$inferSelect;
export type NewInviteImport = typeof inviteImport.$inferInsert;
