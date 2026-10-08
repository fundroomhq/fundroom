import { customType, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { dataroomSchema } from "./dataroom.js";

/*
 * Typed view of `migrations/0007_forensic.sql` (E3.13, ADR-0061); the SQL is authoritative
 * (ADR-0004). One row per (viewer membership, document version) served with an invisible mark.
 * Staff read, only the system context writes; kept on erasure; not exported.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const forensicMark = dataroomSchema.table("forensic_mark", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  membershipId: uuid("membership_id").notNull(),
  documentId: uuid("document_id").notNull(),
  versionId: uuid("version_id").notNull(),
  /** 8 random bytes; the page pattern's seed is HMAC(pattern key of `keyId`, "mark\0" || token). */
  token: bytea("token").notNull(),
  /** The key-ring entry id the pattern key was derived from. */
  keyId: text("key_id").notNull(),
  firstServedAt: ts("first_served_at").notNull().defaultNow(),
  lastServedAt: ts("last_served_at").notNull().defaultNow(),
  /** Last time this member was served the version while viewing as an investor (view-as). */
  lastViewAsAt: ts("last_view_as_at"),
  /** The investor whose visible line that view-as copy carried. */
  viewAsMembershipId: uuid("view_as_membership_id"),
});

export type ForensicMark = typeof forensicMark.$inferSelect;
export type NewForensicMark = typeof forensicMark.$inferInsert;
