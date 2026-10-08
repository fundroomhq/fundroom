import type { Terms } from "@fundroom/round-terms";
import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AccreditationPath,
  CommitmentStatus,
  InstrumentKind,
  InterestStatus,
  InterestSubject,
  RoundStage,
  RoundStatus,
  SignatureRequestStatus,
  VerificationMethod,
  VerificationStatus,
} from "../model.js";

/*
 * Typed view of `migrations/0001_round.sql`; the SQL is authoritative (ADR-0004). The `round`
 * schema is owned by this module (ADR-0007): nothing outside `modules/round` reads these tables,
 * and `crm` — which has every reason to want the commitment amount — goes through the outbox and
 * the module's own API instead.
 *
 * The enum unions come from `../model.js` (and, through it, from `@fundroom/round-terms`)
 * rather than from `pgSchema.enum()`, the same choice `modules/metrics` records: the route
 * contract, the calculator and the eligibility function all need the vocabulary, and importing
 * it from here would drag drizzle into files the dependency-cruiser rule
 * `only-repos-touch-drizzle` keeps it out of.
 */
export const roundSchema = pgSchema("round");

export const round = roundSchema.table("round", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name").notNull(),
  stage: text("stage").$type<RoundStage>().notNull(),
  instrumentKind: text("instrument_kind").$type<InstrumentKind>().notNull(),
  status: text("status").$type<RoundStatus>().notNull().default("planning"),
  targetAmount: numeric("target_amount", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull(),
  minimumInvestment: numeric("minimum_investment", { precision: 20, scale: 6 }),
  opensAt: timestamp("opens_at", { withTimezone: true }),
  closesAt: timestamp("closes_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  showProgress: boolean("show_progress").notNull().default(true),
  summary: text("summary"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type RoundRow = typeof round.$inferSelect;

/**
 * Append-only, like `metrics.point`: the only column an UPDATE may move is `superseded_by`, and
 * a trigger in the migration is what enforces it rather than convention.
 */
export const terms = roundSchema.table("terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  roundId: uuid("round_id").notNull(),
  revision: integer("revision").notNull(),
  terms: jsonb("terms").$type<Terms>().notNull(),
  termsSchemaVersion: integer("terms_schema_version").notNull().default(1),
  asOf: timestamp("as_of", { withTimezone: true }).notNull().defaultNow(),
  disclaimerStamp: text("disclaimer_stamp"),
  supersededBy: uuid("superseded_by"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type TermsRow = typeof terms.$inferSelect;

export const interestSubmission = roundSchema.table("interest_submission", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  roundId: uuid("round_id").notNull(),
  membershipId: uuid("membership_id").notNull(),
  amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
  currency: text("currency").notNull(),
  subject: text("subject").$type<InterestSubject>().notNull(),
  entityName: text("entity_name"),
  note: text("note"),
  accreditationPath: text("accreditation_path").$type<AccreditationPath>().notNull(),
  nonAccredited: boolean("non_accredited").notNull().default(false),
  accreditationStamp: text("accreditation_stamp"),
  disclaimerStamp: text("disclaimer_stamp"),
  offeringStatus: text("offering_status").notNull(),
  status: text("status").$type<InterestStatus>().notNull().default("submitted"),
  verificationId: uuid("verification_id"),
  commitmentId: uuid("commitment_id"),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type InterestSubmissionRow = typeof interestSubmission.$inferSelect;

/**
 * `evidence_key` is a storage key and never the bytes; the object it names is
 * envelope-encrypted under the workspace DEK and deleted by `round.evidence_purge`. The
 * decision, its method and `evidence_sha256` survive that deletion, which is what makes the
 * verification provable after the file is gone (design/04 §102).
 */
export const verification = roundSchema.table("verification", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  membershipId: uuid("membership_id").notNull(),
  interestSubmissionId: uuid("interest_submission_id"),
  provider: text("provider").notNull().default("manual"),
  providerRef: text("provider_ref"),
  method: text("method").$type<VerificationMethod>(),
  status: text("status").$type<VerificationStatus>().notNull().default("pending"),
  evidenceKey: text("evidence_key"),
  evidenceSha256: text("evidence_sha256"),
  evidenceContentType: text("evidence_content_type"),
  evidenceBytes: integer("evidence_bytes"),
  evidenceNote: text("evidence_note"),
  evidenceUploadedAt: timestamp("evidence_uploaded_at", { withTimezone: true }),
  evidencePurgedAt: timestamp("evidence_purged_at", { withTimezone: true }),
  /** `{format:"she1", keyId, keyRef}` of the DEK that sealed the object (0002); NULL before it. */
  evidenceEncryption: jsonb("evidence_encryption"),
  evidenceEncryptionSchemaVersion: integer("evidence_encryption_schema_version")
    .notNull()
    .default(1),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /** E3.7 (0005): the last raw vendor status (≤100), error (≤500) and when it was read. */
  vendorStatus: text("vendor_status"),
  vendorError: text("vendor_error"),
  vendorCheckedAt: timestamp("vendor_checked_at", { withTimezone: true }),
  vendorDecidedAt: timestamp("vendor_decided_at", { withTimezone: true }),
  /** E3.7 (0005): polling schedule of a pending vendor row; NULL = not polled. */
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
  checkAttempts: integer("check_attempts").notNull().default(0),
  /** E3.7 (0005): the `AccreditationHandoff` the investor continues with (never `upload`). */
  handoff: jsonb("handoff"),
  handoffSchemaVersion: integer("handoff_schema_version").notNull().default(1),
  /** E3.7 (0005): the vendor driver that decided (a vendor decision has no `decided_by`). */
  decidedByProvider: text("decided_by_provider"),
  /** E3.7 (0005): the verification this one renews. */
  reverificationOf: uuid("reverification_of"),
  /** E3.7 (0005): when the single pre-expiry reminder went out. */
  reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type VerificationRow = typeof verification.$inferSelect;

/**
 * `amount` is `numeric(20, 6)`, which drizzle hands over as a **string** and which the repo
 * keeps as a string all the way to `allocation()` — nothing in this module puts a commitment
 * amount through `Number()`.
 */
export const commitment = roundSchema.table("commitment", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  roundId: uuid("round_id").notNull(),
  membershipId: uuid("membership_id"),
  organizationId: uuid("organization_id"),
  contactId: uuid("contact_id"),
  displayName: text("display_name"),
  amount: numeric("amount", { precision: 20, scale: 6 }).notNull(),
  status: text("status").$type<CommitmentStatus>().notNull().default("soft"),
  note: text("note"),
  interestSubmissionId: uuid("interest_submission_id"),
  signedDocumentId: uuid("signed_document_id"),
  wiredAt: timestamp("wired_at", { withTimezone: true }),
  /** E3.5 (0004): the company confirmed the money arrived and reconciled. */
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  /** Membership id of the staff member who confirmed. */
  confirmedBy: uuid("confirmed_by"),
  /** E3.5 (0004): the subscription agreement was signed (set when a signature request completes). */
  signedAt: timestamp("signed_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CommitmentRow = typeof commitment.$inferSelect;

export const closingTask = roundSchema.table("closing_task", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  roundId: uuid("round_id").notNull(),
  title: text("title").notNull(),
  doneAt: timestamp("done_at", { withTimezone: true }),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type ClosingTaskRow = typeof closingTask.$inferSelect;

/**
 * E3.5 (0004): a subscription agreement sent for e-signature for one commitment. `envelopeId` is
 * a soft reference to the kernel's `core.esign_envelope`; `signedDocumentId` to the vaulted
 * data-room document. At most one open (pending/sent/delivered) row per commitment; `envelopeId`
 * is null only while `pending` (or for a claim that failed before the vendor answered).
 */
export const signatureRequest = roundSchema.table("signature_request", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  roundId: uuid("round_id").notNull(),
  commitmentId: uuid("commitment_id").notNull(),
  envelopeId: uuid("envelope_id"),
  status: text("status").$type<SignatureRequestStatus>().notNull().default("pending"),
  templateRef: text("template_ref"),
  sentByMembershipId: uuid("sent_by_membership_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  signedDocumentId: uuid("signed_document_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type SignatureRequestRow = typeof signatureRequest.$inferSelect;
