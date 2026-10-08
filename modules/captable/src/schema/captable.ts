import {
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { SecurityKind, SnapshotSource, SnapshotStatus } from "../model.js";

/*
 * Typed view of `migrations/0001_captable.sql`; the SQL is authoritative (ADR-0004). The
 * `captable` schema is owned by this module (ADR-0007). Numeric columns come back from `pg` as
 * strings and stay strings until `@fundroom/decimal` parses them.
 */
export const captableSchema = pgSchema("captable");

const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

export const snapshot = captableSchema.table("snapshot", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  asOf: date("as_of", { mode: "string" }).notNull(),
  source: text("source").$type<SnapshotSource>().notNull(),
  status: text("status").$type<SnapshotStatus>().notNull().default("draft"),
  note: text("note"),
  totals: jsonb("totals").notNull().default({}),
  totalsSchemaVersion: integer("totals_schema_version").notNull().default(1),
  importedBy: uuid("imported_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});
export type Snapshot = typeof snapshot.$inferSelect;

export const securityClass = captableSchema.table("security_class", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  kind: text("kind").$type<SecurityKind>().notNull(),
  position: integer("position").notNull().default(0),
});
export type SecurityClass = typeof securityClass.$inferSelect;

export const holding = captableSchema.table("holding", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  classId: uuid("class_id").notNull(),
  holderName: text("holder_name").notNull(),
  holderEmail: citext("holder_email"),
  membershipId: uuid("membership_id"),
  shares: numeric("shares", { precision: 24, scale: 6 }),
  amount: numeric("amount", { precision: 20, scale: 6 }),
  currency: text("currency"),
  issuedOn: date("issued_on", { mode: "string" }),
  erasedAt: timestamp("erased_at", { withTimezone: true }),
});
export type Holding = typeof holding.$inferSelect;
