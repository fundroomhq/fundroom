import { sql } from "drizzle-orm";
import { bigint, check, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";

/*
 * The external relationship engine's sync state (EXECUTION_PLAN §15 E3.13, ADR-0061).
 *
 * Typed view of `core.authz_engine_state` in `migrations/core/0026_evidence_authz.sql`; the SQL is
 * authoritative (ADR-0004) — the fence and the system-only policy live there. One row per
 * workspace: which store/model the engine (`RelationshipEnginePort`) holds and the acl_version it
 * last synced. Instance-local: a projection rebuilt at will, never exported.
 */
export const authzEngineState = coreSchema.table(
  "authz_engine_state",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspace.id, { onDelete: "cascade" }),
    driver: text("driver").notNull(),
    storeRef: text("store_ref"),
    modelRef: text("model_ref"),
    syncedAclVersion: bigint("synced_acl_version", { mode: "number" }).notNull().default(0),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    /** The sync lease (FIX2 C9): owner token and expiry; both null or both set. */
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("authz_engine_state_driver", sql`${t.driver} ~ '^[a-z][a-z0-9_-]{0,31}$'`),
    check(
      "authz_engine_state_error_code",
      sql`${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} ~ '^[a-z_]{1,64}$'`,
    ),
    check("authz_engine_state_version", sql`${t.syncedAclVersion} >= 0`),
    check("authz_engine_state_lease", sql`(${t.leaseOwner} IS NULL) = (${t.leaseUntil} IS NULL)`),
    check(
      "authz_engine_state_lease_owner",
      sql`${t.leaseOwner} IS NULL OR ${t.leaseOwner} ~ '^[A-Za-z0-9_-]{1,64}$'`,
    ),
  ],
);

export type AuthzEngineStateRow = typeof authzEngineState.$inferSelect;
export type NewAuthzEngineStateRow = typeof authzEngineState.$inferInsert;
