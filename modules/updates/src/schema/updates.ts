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
 * Typed view of `migrations/0001_updates.sql`; the SQL is authoritative (ADR-0004). The
 * `updates` schema is owned by this module (ADR-0007): nothing outside `modules/updates`
 * reads these tables.
 */
export const updatesSchema = pgSchema("updates");

const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return Buffer.from(value);
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
});

export const postState = updatesSchema.enum("post_state", [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "archived",
]);
export const POST_STATES = postState.enumValues;
export type PostState = (typeof POST_STATES)[number];

export const sendKind = updatesSchema.enum("send_kind", ["live", "test"]);
export type SendKind = (typeof sendKind.enumValues)[number];
export const sendStatus = updatesSchema.enum("send_status", [
  "queued",
  "running",
  "finished",
  "failed",
]);
export type SendStatus = (typeof sendStatus.enumValues)[number];
export const recipientStatus = updatesSchema.enum("recipient_status", [
  "queued",
  "sent",
  // E2.6 (0002): an ESP webhook confirmed the receiving server accepted the message.
  "delivered",
  "failed",
  "skipped",
  "bounced",
  "complained",
]);
export const RECIPIENT_STATUSES = recipientStatus.enumValues;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];
export const domainStatus = updatesSchema.enum("domain_status", ["pending", "verified", "failed"]);
export type DomainStatus = (typeof domainStatus.enumValues)[number];
export const unsubscribeSource = updatesSchema.enum("unsubscribe_source", [
  "link",
  "one_click",
  "portal",
  "staff",
]);
export type UnsubscribeSource = (typeof unsubscribeSource.enumValues)[number];

export const post = updatesSchema.table("post", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  slug: citext("slug").notNull(),
  title: text("title").notNull(),
  state: postState("state").notNull().default("draft"),
  doc: jsonb("doc").notNull(),
  docSchemaVersion: integer("doc_schema_version").notNull().default(1),
  visibility: jsonb("visibility").notNull().default({}),
  visibilitySchemaVersion: integer("visibility_schema_version").notNull().default(1),
  audience: jsonb("audience").notNull().default({ kind: "all" }),
  audienceSchemaVersion: integer("audience_schema_version").notNull().default(1),
  templateKey: text("template_key"),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  publishedVersionId: uuid("published_version_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  authorMembershipId: uuid("author_membership_id"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const postVersion = updatesSchema.table("post_version", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  postId: uuid("post_id").notNull(),
  versionNo: integer("version_no").notNull(),
  title: text("title").notNull(),
  doc: jsonb("doc").notNull(),
  docSchemaVersion: integer("doc_schema_version").notNull().default(1),
  visibility: jsonb("visibility").notNull().default({}),
  visibilitySchemaVersion: integer("visibility_schema_version").notNull().default(1),
  audience: jsonb("audience").notNull(),
  audienceSchemaVersion: integer("audience_schema_version").notNull().default(1),
  disclaimerVersion: text("disclaimer_version"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const send = updatesSchema.table("send", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  postId: uuid("post_id").notNull(),
  versionId: uuid("version_id").notNull(),
  kind: sendKind("kind").notNull(),
  status: sendStatus("status").notNull().default("queued"),
  requestedBy: uuid("requested_by"),
  total: integer("total").notNull().default(0),
  sent: integer("sent").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  // E2.6 (0002): delivery feedback, maintained by the `mail.delivery_recorded` subscriber.
  delivered: integer("delivered").notNull().default(0),
  bounced: integer("bounced").notNull().default(0),
  complained: integer("complained").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recipient = updatesSchema.table("recipient", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  sendId: uuid("send_id").notNull(),
  membershipId: uuid("membership_id"),
  email: citext("email").notNull(),
  status: recipientStatus("status").notNull().default("queued"),
  messageId: text("message_id"),
  error: text("error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const reply = updatesSchema.table("reply", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  postId: uuid("post_id").notNull(),
  threadMembershipId: uuid("thread_membership_id").notNull(),
  authorMembershipId: uuid("author_membership_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const unsubscribe = updatesSchema.table(
  "unsubscribe",
  {
    workspaceId: uuid("workspace_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    email: citext("email").notNull(),
    source: unsubscribeSource("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.membershipId] })],
);

export const sendingDomain = updatesSchema.table("sending_domain", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  domain: citext("domain").notNull(),
  selector: text("selector").notNull(),
  publicKey: text("public_key").notNull(),
  privateKeyEnc: bytea("private_key_enc").notNull(),
  encryption: jsonb("encryption").notNull().default({}),
  encryptionSchemaVersion: integer("encryption_schema_version").notNull().default(1),
  status: domainStatus("status").notNull().default("pending"),
  checks: jsonb("checks").notNull().default({}),
  checksSchemaVersion: integer("checks_schema_version").notNull().default(1),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastError: text("last_error"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Post = typeof post.$inferSelect;
export type NewPost = typeof post.$inferInsert;
export type PostVersion = typeof postVersion.$inferSelect;
export type NewPostVersion = typeof postVersion.$inferInsert;
export type Send = typeof send.$inferSelect;
export type NewSend = typeof send.$inferInsert;
export type Recipient = typeof recipient.$inferSelect;
export type NewRecipient = typeof recipient.$inferInsert;
export type Reply = typeof reply.$inferSelect;
export type Unsubscribe = typeof unsubscribe.$inferSelect;
export type SendingDomain = typeof sendingDomain.$inferSelect;
export type NewSendingDomain = typeof sendingDomain.$inferInsert;
