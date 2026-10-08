import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bytea, inet } from "./identity.js";

/*
 * Audit log (EXECUTION_PLAN §7 `audit`, §10, ADR-0017, E0.4).
 *
 * Typed view of `migrations/core/0002_audit_events.sql`; the SQL is authoritative (ADR-0004).
 * `audit.event` is range-partitioned by month on `occurred_at` (drizzle cannot express that,
 * so the snapshot models it as a plain table) and append-only: the app role has SELECT and
 * INSERT only, triggers reject UPDATE/DELETE/TRUNCATE, and a BEFORE INSERT trigger assigns
 * `seq`, `prev_hash` and `hash` per workspace under an advisory lock. Never insert these
 * columns from application code; the trigger overwrites them.
 */
export const auditSchema = pgSchema("audit");

export const auditOutcome = auditSchema.enum("outcome", ["success", "denied", "failure"]);
export const AUDIT_OUTCOMES = auditOutcome.enumValues;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** `action` is a dotted verb (`document.viewed`); `resource_kind` a bare noun (`document`). */
export const AUDIT_ACTION_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/u;
export const AUDIT_RESOURCE_KIND_RE = /^[a-z][a-z0-9_]*$/u;

export const auditEvent = auditSchema.table(
  "event",
  {
    id: uuid("id").notNull().default(sql`core.uuidv7()`),
    /** No FK: audit rows outlive their workspace. Platform events use PLATFORM_WORKSPACE_ID. */
    workspaceId: uuid("workspace_id").notNull(),
    /** Per-workspace chain position, 1-based; set by the trigger. */
    seq: bigint("seq", { mode: "number" }).notNull().default(0),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorKind: text("actor_kind").notNull(),
    actorMembershipId: uuid("actor_membership_id"),
    actorUserId: uuid("actor_user_id"),
    /** Impersonation / "view as investor": the membership whose view was rendered. */
    onBehalfOfMembershipId: uuid("on_behalf_of_membership_id"),
    action: text("action").notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: uuid("resource_id"),
    /** Whose data was touched (the investor a grant was issued to, the member revoked, …). */
    subjectMembershipId: uuid("subject_membership_id"),
    outcome: auditOutcome("outcome").notNull().default("success"),
    /** Truncated by default (/24, /48) per design/02 §6. */
    ip: inet("ip"),
    userAgent: text("user_agent"),
    requestId: uuid("request_id"),
    sessionId: uuid("session_id"),
    /** `{ before, after }` restricted to an allowlist with per-field redaction. */
    diff: jsonb("diff"),
    diffSchemaVersion: integer("diff_schema_version").notNull().default(1),
    meta: jsonb("meta").notNull().default({}),
    metaSchemaVersion: integer("meta_schema_version").notNull().default(1),
    prevHash: bytea("prev_hash"),
    hash: bytea("hash").notNull().default(sql`'\\x'::bytea`),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.occurredAt, t.id] }),
    index("event_workspace_seq_idx").on(t.workspaceId, t.seq),
    index("event_workspace_action_idx").on(t.workspaceId, t.action, t.occurredAt),
    index("event_workspace_resource_idx")
      .on(t.workspaceId, t.resourceKind, t.resourceId, t.occurredAt)
      .where(sql`${t.resourceId} IS NOT NULL`),
    index("event_workspace_subject_idx")
      .on(t.workspaceId, t.subjectMembershipId, t.occurredAt)
      .where(sql`${t.subjectMembershipId} IS NOT NULL`),
    index("event_workspace_actor_idx")
      .on(t.workspaceId, t.actorMembershipId, t.occurredAt)
      .where(sql`${t.actorMembershipId} IS NOT NULL`),
    check("event_action_format", sql`${t.action} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`),
    check("event_resource_kind_format", sql`${t.resourceKind} ~ '^[a-z][a-z0-9_]*$'`),
    check("event_actor_kind", sql`${t.actorKind} IN ('staff', 'external', 'system', 'host')`),
  ],
);

/** Chain head per workspace, maintained by the trigger; read-only for the app role. */
export const auditChainHead = auditSchema.table("chain_head", {
  workspaceId: uuid("workspace_id").primaryKey(),
  seq: bigint("seq", { mode: "number" }).notNull(),
  hash: bytea("hash").notNull(),
  eventId: uuid("event_id").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Daily HMAC-signed snapshot of the chain head (key from the config key ring, not the DB). */
export const auditCheckpoint = auditSchema.table(
  "checkpoint",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    hash: bytea("hash").notNull(),
    eventId: uuid("event_id").notNull(),
    headOccurredAt: timestamp("head_occurred_at", { withTimezone: true }).notNull(),
    previousCheckpointId: uuid("previous_checkpoint_id"),
    keyId: text("key_id"),
    signature: bytea("signature"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("checkpoint_workspace_idx").on(t.workspaceId, sql`${t.seq} DESC`),
    // E3.13 FIX1: target of audit.anchor's same-workspace FK.
    unique("checkpoint_workspace_id_unique").on(t.workspaceId, t.id),
  ],
);

/**
 * One anchoring run (E3.13, `0026_evidence_authz.sql`): an RFC 6962 Merkle tree over the leaf
 * hashes of every checkpoint that had no anchor yet. Global (no workspace): only the root leaves
 * the install. Append-only; written by the system/host context.
 */
export const auditAnchorBatch = auditSchema.table(
  "anchor_batch",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    merkleRoot: bytea("merkle_root").notNull(),
    leafCount: integer("leaf_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("anchor_batch_created_idx").on(sql`${t.createdAt} DESC`),
    check("anchor_batch_root_length", sql`octet_length(${t.merkleRoot}) = 32`),
    check("anchor_batch_leaf_count", sql`${t.leafCount} > 0`),
  ],
);

/** What one anchor driver returned for a batch root (`AnchorReceipt` from `@fundroom/ports`). */
export const auditAnchorReceipt = auditSchema.table(
  "anchor_receipt",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => auditAnchorBatch.id),
    kind: text("kind").notNull(),
    reference: text("reference").notNull(),
    anchoredAt: timestamp("anchored_at", { withTimezone: true }).notNull(),
    /** The full `AnchorReceipt` (kind, reference, anchoredAt, proof). */
    receipt: jsonb("receipt").$type<Readonly<Record<string, unknown>>>().notNull(),
    receiptSchemaVersion: integer("receipt_schema_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("anchor_receipt_batch_kind").on(t.batchId, t.kind),
    check("anchor_receipt_kind_format", sql`${t.kind} ~ '^[a-z][a-z0-9_-]*$'`),
    check("anchor_receipt_reference_length", sql`char_length(${t.reference}) BETWEEN 1 AND 2000`),
    check("anchor_receipt_object", sql`jsonb_typeof(${t.receipt}) = 'object'`),
  ],
);

/** A checkpoint's inclusion path to its batch root (E3.13): `{ leafHash, path: [hex…], treeSize }`. */
export interface AuditAnchorProof {
  readonly leafHash: string;
  readonly path: readonly string[];
  readonly treeSize: number;
}

/**
 * External anchor of a checkpoint. Since E3.13 rows of kind `merkle` place the checkpoint in an
 * `anchor_batch` (`reference` = the batch id) with its inclusion `proof`; one per checkpoint.
 */
export const auditAnchor = auditSchema.table(
  "anchor",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id").notNull(),
    checkpointId: uuid("checkpoint_id")
      .notNull()
      .references(() => auditCheckpoint.id),
    kind: text("kind").notNull(),
    reference: text("reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    batchId: uuid("batch_id").references(() => auditAnchorBatch.id),
    leafIndex: integer("leaf_index"),
    proof: jsonb("proof").$type<AuditAnchorProof>(),
    proofSchemaVersion: integer("proof_schema_version").notNull().default(1),
  },
  (t) => [
    index("anchor_checkpoint_idx").on(t.workspaceId, t.checkpointId),
    foreignKey({
      name: "anchor_checkpoint_same_workspace",
      columns: [t.workspaceId, t.checkpointId],
      foreignColumns: [auditCheckpoint.workspaceId, auditCheckpoint.id],
    }),
    uniqueIndex("anchor_merkle_checkpoint_idx").on(t.checkpointId).where(sql`${t.kind} = 'merkle'`),
    index("anchor_batch_idx").on(t.batchId).where(sql`${t.batchId} IS NOT NULL`),
    check("anchor_kind_format", sql`${t.kind} ~ '^[a-z][a-z0-9_-]*$'`),
    check(
      "anchor_merkle_shape",
      sql`${t.kind} <> 'merkle' OR (${t.batchId} IS NOT NULL AND ${t.leafIndex} IS NOT NULL AND ${t.proof} IS NOT NULL)`,
    ),
    check("anchor_leaf_index_non_negative", sql`${t.leafIndex} IS NULL OR ${t.leafIndex} >= 0`),
    check("anchor_proof_object", sql`${t.proof} IS NULL OR jsonb_typeof(${t.proof}) = 'object'`),
  ],
);

export type AuditEventRow = typeof auditEvent.$inferSelect;
export type NewAuditEventRow = typeof auditEvent.$inferInsert;
export type AuditChainHead = typeof auditChainHead.$inferSelect;
export type AuditCheckpointRow = typeof auditCheckpoint.$inferSelect;
export type NewAuditCheckpointRow = typeof auditCheckpoint.$inferInsert;
export type AuditAnchorRow = typeof auditAnchor.$inferSelect;
export type NewAuditAnchorRow = typeof auditAnchor.$inferInsert;
export type AuditAnchorBatchRow = typeof auditAnchorBatch.$inferSelect;
export type NewAuditAnchorBatchRow = typeof auditAnchorBatch.$inferInsert;
export type AuditAnchorReceiptRow = typeof auditAnchorReceipt.$inferSelect;
export type NewAuditAnchorReceiptRow = typeof auditAnchorReceipt.$inferInsert;
