import {
  boolean,
  customType,
  integer,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ActivityKind, OrganizationKind, SubjectKind, TransitionCause } from "../model.js";

/*
 * Typed view of `migrations/0001_crm.sql` and `0002_activity.sql`; the SQL is authoritative (ADR-0004). The `crm`
 * schema is owned by this module (ADR-0007): nothing outside `modules/crm` reads these tables,
 * and nothing inside it reads anybody else's.
 *
 * The string unions come from `../model.js` rather than from `pgSchema.enum()`, the way
 * `modules/metrics` does it: the route contracts and the event handlers need the vocabulary,
 * and importing it from here would drag drizzle into files the dependency-cruiser rule
 * `only-repos-touch-drizzle` keeps it out of.
 */
export const crmSchema = pgSchema("crm");

const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

/** `tsvector`; declared so the table type is complete, never read and never written. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const organization = crmSchema.table("organization", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  domain: citext("domain"),
  website: text("website"),
  kind: text("kind").$type<OrganizationKind>(),
  notes: text("notes"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
export type Organization = typeof organization.$inferSelect;

/**
 * `searchTsv` is `GENERATED ALWAYS … STORED`: drizzle has no generated-column concept here, so
 * it is declared as a plain column and never written. The SQL is what enforces that.
 */
export const contact = crmSchema.table("contact", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  organizationId: uuid("organization_id"),
  membershipId: uuid("membership_id"),
  displayName: text("display_name").notNull(),
  email: citext("email"),
  title: text("title"),
  tags: text("tags").array().notNull().default([]),
  notes: text("notes"),
  ownerMembershipId: uuid("owner_membership_id"),
  searchTsv: tsvector("search_tsv"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
export type Contact = typeof contact.$inferSelect;

export const pipelineStage = crmSchema.table("pipeline_stage", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  isTerminal: boolean("is_terminal").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type PipelineStage = typeof pipelineStage.$inferSelect;

/**
 * `amount` is `numeric(20, 6)`, which the driver hands over as a **string**. It is a forecast
 * and never the committed figure (E2.5 D2); nothing in this module may put it through
 * `Number()`.
 */
export const pipelineItem = crmSchema.table("pipeline_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  roundId: uuid("round_id"),
  contactId: uuid("contact_id"),
  organizationId: uuid("organization_id"),
  stageId: uuid("stage_id").notNull(),
  amount: numeric("amount", { precision: 20, scale: 6 }),
  currency: text("currency"),
  ownerMembershipId: uuid("owner_membership_id"),
  commitmentId: uuid("commitment_id"),
  position: integer("position").notNull().default(0),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
export type PipelineItem = typeof pipelineItem.$inferSelect;

export const note = crmSchema.table("note", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  subjectKind: text("subject_kind").$type<SubjectKind>().notNull(),
  subjectId: uuid("subject_id").notNull(),
  body: text("body").notNull(),
  authorMembershipId: uuid("author_membership_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
export type Note = typeof note.$inferSelect;

export const task = crmSchema.table("task", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  subjectKind: text("subject_kind").$type<SubjectKind>().notNull(),
  subjectId: uuid("subject_id").notNull(),
  title: text("title").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }),
  assigneeMembershipId: uuid("assignee_membership_id"),
  doneAt: timestamp("done_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Task = typeof task.$inferSelect;

export const stageTransition = crmSchema.table("stage_transition", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  pipelineItemId: uuid("pipeline_item_id").notNull(),
  fromStageId: uuid("from_stage_id"),
  fromStageKey: text("from_stage_key"),
  toStageId: uuid("to_stage_id").notNull(),
  toStageKey: text("to_stage_key").notNull(),
  actorMembershipId: uuid("actor_membership_id"),
  cause: text("cause").$type<TransitionCause>().notNull().default("staff"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type StageTransition = typeof stageTransition.$inferSelect;

/**
 * `migrations/0002_activity.sql`. One row per (booking, kind); `bookingId` is a soft reference to
 * the kernel's `core.integration_booking` (no foreign key), `title` the vendor's event name only.
 */
export const activity = crmSchema.table("activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  contactId: uuid("contact_id").notNull(),
  kind: text("kind").$type<ActivityKind>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  title: text("title"),
  bookingId: uuid("booking_id"),
  provider: text("provider").$type<"calendly" | "calcom">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Activity = typeof activity.$inferSelect;
