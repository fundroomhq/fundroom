import {
  customType,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Typed view of `migrations/*.sql`; the SQL is authoritative (ADR-0004). The
 * `content` schema is owned by this module (ADR-0007): nothing outside `modules/content`
 * reads these tables.
 */
export const contentSchema = pgSchema("content");

const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

export const pageKind = contentSchema.enum("page_kind", ["home", "custom"]);
export const PAGE_KINDS = pageKind.enumValues;
export type PageKind = (typeof PAGE_KINDS)[number];

export const page = contentSchema.table("page", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  slug: citext("slug").notNull(),
  kind: pageKind("kind").notNull().default("custom"),
  title: text("title").notNull(),
  publishedRevisionId: uuid("published_revision_id"),
  draftRevisionId: uuid("draft_revision_id"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const pageRevision = contentSchema.table("page_revision", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  pageId: uuid("page_id").notNull(),
  revisionNo: integer("revision_no").notNull(),
  doc: jsonb("doc").notNull(),
  docSchemaVersion: integer("doc_schema_version").notNull().default(1),
  visibility: jsonb("visibility"),
  visibilitySchemaVersion: integer("visibility_schema_version").notNull().default(1),
  note: text("note"),
  /** `<slug>:v<n>` of the disclaimer in force when this revision was published (E1.6). */
  disclaimerVersion: text("disclaimer_version"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

export const sectionVisibility = contentSchema.table(
  "section_visibility",
  {
    workspaceId: uuid("workspace_id").notNull(),
    pageId: uuid("page_id").notNull(),
    sectionKey: text("section_key").notNull(),
    rule: jsonb("rule").notNull(),
    ruleSchemaVersion: integer("rule_schema_version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.pageId, t.sectionKey] })],
);

export type Page = typeof page.$inferSelect;
export type NewPage = typeof page.$inferInsert;
export type PageRevision = typeof pageRevision.$inferSelect;
export type NewPageRevision = typeof pageRevision.$inferInsert;
export type SectionVisibilityRow = typeof sectionVisibility.$inferSelect;
