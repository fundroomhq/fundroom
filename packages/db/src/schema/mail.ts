import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";
import { workspaceKey } from "./crypto.js";
import { bytea } from "./identity.js";

/*
 * Mail feedback (E2.6, design/04 §3.2).
 *
 * Typed view of `migrations/core/0010_mail_feedback.sql`; the SQL is authoritative (ADR-0004) —
 * the fence that lets the host actor *read* `mail_message` (and nothing more) lives there.
 */

export const MAIL_STREAMS = ["transactional", "broadcast", "notification"] as const;
export type MailStreamValue = (typeof MAIL_STREAMS)[number];

export const MAIL_SUPPRESSION_REASONS = ["bounce", "complaint", "manual", "provider"] as const;
export type MailSuppressionReason = (typeof MAIL_SUPPRESSION_REASONS)[number];

/**
 * One message handed to the provider on behalf of a workspace. The only thing that turns an ESP
 * webhook (a provider message id) into a workspace, a stream, a resource and a member. Ids only.
 */
export const mailMessage = coreSchema.table(
  "mail_message",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    stream: text("stream").$type<MailStreamValue>().notNull(),
    refKind: text("ref_kind"),
    refId: uuid("ref_id"),
    membershipId: uuid("membership_id"),
    trackingOpens: boolean("tracking_opens").notNull().default(false),
    trackingClicks: boolean("tracking_clicks").notNull().default(false),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mail_message_provider_idx").on(t.provider, t.providerMessageId),
    index("mail_message_ws_sent_idx").on(t.workspaceId, t.sentAt),
    check(
      "mail_message_stream",
      sql`${t.stream} IN ('transactional', 'broadcast', 'notification')`,
    ),
    check("mail_message_provider_length", sql`char_length(${t.provider}) BETWEEN 1 AND 64`),
    check(
      "mail_message_provider_id_length",
      sql`char_length(${t.providerMessageId}) BETWEEN 1 AND 300`,
    ),
    check(
      "mail_message_ref_kind_length",
      sql`${t.refKind} IS NULL OR char_length(${t.refKind}) BETWEEN 1 AND 64`,
    ),
  ],
);

export type MailMessage = typeof mailMessage.$inferSelect;
export type NewMailMessage = typeof mailMessage.$inferInsert;

/**
 * An address a workspace must not send broadcast/notification mail to. Keyed by an HMAC of the
 * lower-cased address under the workspace's `mail-suppression` data key, never the address.
 */
export const mailSuppression = coreSchema.table(
  "mail_suppression",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    addressHash: bytea("address_hash").notNull(),
    /** The `core.workspace_key` the hash was taken under; lookups hash under every such key. */
    keyId: uuid("key_id")
      .notNull()
      .references(() => workspaceKey.id),
    id: uuid("id").notNull().default(sql`core.uuidv7()`),
    addressMasked: text("address_masked").notNull(),
    reason: text("reason").$type<MailSuppressionReason>().notNull(),
    messageRef: uuid("message_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.addressHash] }),
    uniqueIndex("mail_suppression_id_idx").on(t.id),
    index("mail_suppression_ws_id_idx").on(t.workspaceId, t.id.desc()),
    check(
      "mail_suppression_reason",
      sql`${t.reason} IN ('bounce', 'complaint', 'manual', 'provider')`,
    ),
    check("mail_suppression_hash_length", sql`octet_length(${t.addressHash}) = 32`),
    check("mail_suppression_masked_length", sql`char_length(${t.addressMasked}) BETWEEN 1 AND 320`),
  ],
);

export type MailSuppression = typeof mailSuppression.$inferSelect;
export type NewMailSuppression = typeof mailSuppression.$inferInsert;
