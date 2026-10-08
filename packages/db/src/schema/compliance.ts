import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { citext, coreSchema, offeringStatus, workspace } from "./core.js";
import { bytea, membership } from "./identity.js";

/*
 * Offering mode and the legal-document library (EXECUTION_PLAN §11, ADR-0019, ADR-0037, E1.6).
 *
 * Typed view of `migrations/core/0006_compliance.sql`; the SQL is authoritative (ADR-0004).
 * The repositories, the template library and the services live in `@fundroom/compliance`.
 *
 * Acceptances are not here: they reuse `core.attestation` (`<slug>:v<n>`), which already feeds
 * the policy gates from ADR-0032.
 */

export const legalDocumentKind = coreSchema.enum("legal_document_kind", [
  "privacy_notice",
  "nda",
  "terms",
  "disclaimer",
  "accreditation",
  "cookie_notice",
  // E2.8 (0013)
  "accessibility_statement",
]);
export const legalAudience = coreSchema.enum("legal_audience", ["external", "staff", "all"]);
export const legalSource = coreSchema.enum("legal_source", ["template", "custom"]);
export const consentPurpose = coreSchema.enum("consent_purpose", [
  "analytics_engagement",
  "email_tracking",
]);
export const consentSource = coreSchema.enum("consent_source", [
  "gate",
  "settings",
  "gpc",
  "host_cmp",
  "admin",
]);

export const LEGAL_DOCUMENT_KINDS = legalDocumentKind.enumValues;
export const LEGAL_AUDIENCES = legalAudience.enumValues;
export const LEGAL_SOURCES = legalSource.enumValues;
export const CONSENT_PURPOSES = consentPurpose.enumValues;
export const CONSENT_SOURCES = consentSource.enumValues;

export type LegalDocumentKind = (typeof LEGAL_DOCUMENT_KINDS)[number];
export type LegalAudience = (typeof LEGAL_AUDIENCES)[number];
export type LegalSource = (typeof LEGAL_SOURCES)[number];
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** `core.legal_document.ceremony` (E3.5, 0019). */
export const LEGAL_CEREMONIES = ["clickwrap", "esign"] as const;
export type LegalCeremony = (typeof LEGAL_CEREMONIES)[number];

/**
 * Append-only history of `core.workspace.offering_status`. The column on the workspace is the
 * fast read; this is the evidence, and it answers "which status was in force at time T"
 * (design/04 §2). Exactly one row per workspace has `endedAt IS NULL`.
 */
export const offeringPeriod = coreSchema.table(
  "offering_period",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    status: offeringStatus("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Membership id of the staff member who made the change; null for the seed period. */
    changedBy: uuid("changed_by"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one open period per workspace: the open row *is* the current status.
    uniqueIndex("offering_period_open_idx").on(t.workspaceId).where(sql`${t.endedAt} IS NULL`),
    index("offering_period_workspace_idx").on(t.workspaceId, t.startedAt.desc()),
    check("offering_period_window", sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`),
  ],
);

/** A tenant legal text: privacy notice, NDA, a named disclaimer, the self-certification form. */
export const legalDocument = coreSchema.table(
  "legal_document",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    kind: legalDocumentKind("kind").notNull(),
    slug: citext("slug").notNull(),
    title: text("title").notNull(),
    /** Which shipped template this was seeded from, so an upstream bump is diffable. */
    templateId: text("template_id"),
    templateVersion: integer("template_version"),
    /** The member must accept the current version before being served anything else. */
    requiresAcceptance: boolean("requires_acceptance").notNull().default(false),
    audience: legalAudience("audience").notNull().default("external"),
    /** How a member accepts it (E3.5, 0019): the click-wrap engine or a vendor e-signature. */
    ceremony: text("ceremony").$type<LegalCeremony>().notNull().default("clickwrap"),
    currentVersionId: uuid("current_version_id"),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("legal_document_slug_idx")
      .on(t.workspaceId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
    index("legal_document_kind_idx").on(t.workspaceId, t.kind).where(sql`${t.deletedAt} IS NULL`),
    check("legal_document_slug_format", sql`${t.slug} ~ '^[a-z][a-z0-9-]{0,62}$'`),
    check("legal_document_ceremony", sql`${t.ceremony} IN ('clickwrap', 'esign')`),
  ],
);

/**
 * An immutable published version. Acceptance names a version, never the document, so a later
 * edit cannot change what somebody agreed to; `bodySha256` is the click-wrap evidence
 * design/04 §4 requires.
 */
export const legalDocumentVersion = coreSchema.table(
  "legal_document_version",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => legalDocument.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    /** The Markdown exactly as it was shown. */
    body: text("body").notNull(),
    bodySha256: bytea("body_sha256").notNull(),
    source: legalSource("source").notNull().default("custom"),
    templateId: text("template_id"),
    templateVersion: integer("template_version"),
    summary: text("summary"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("legal_document_version_doc_idx").on(t.workspaceId, t.documentId, t.versionNo.desc()),
    unique("legal_document_version_unique").on(t.documentId, t.versionNo),
    check("legal_document_version_no", sql`${t.versionNo} >= 1`),
    check("legal_document_version_sha", sql`octet_length(${t.bodySha256}) = 32`),
  ],
);

/**
 * Append-only consent, deliberately separate from notice acceptance: GDPR requires consent to
 * be unbundled from accepting a notice (design/04 §3.2, R13). The effective answer is the
 * newest row per (membership, purpose).
 */
export const consentEvent = coreSchema.table(
  "consent_event",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    purpose: consentPurpose("purpose").notNull(),
    granted: boolean("granted").notNull(),
    source: consentSource("source").notNull(),
    noticeDocumentId: uuid("notice_document_id").references(() => legalDocument.id, {
      onDelete: "set null",
    }),
    noticeVersionNo: integer("notice_version_no"),
    /** A browser family, never a User-Agent string (ADR-0036). */
    uaFamily: text("ua_family"),
    /** Keyed HMAC of the address, never the address. */
    ipHash: bytea("ip_hash"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("consent_event_member_idx").on(
      t.workspaceId,
      t.membershipId,
      t.purpose,
      t.recordedAt.desc(),
    ),
  ],
);

export type OfferingPeriod = typeof offeringPeriod.$inferSelect;
export type NewOfferingPeriod = typeof offeringPeriod.$inferInsert;
export type LegalDocument = typeof legalDocument.$inferSelect;
export type NewLegalDocument = typeof legalDocument.$inferInsert;
export type LegalDocumentVersion = typeof legalDocumentVersion.$inferSelect;
export type NewLegalDocumentVersion = typeof legalDocumentVersion.$inferInsert;
export type ConsentEvent = typeof consentEvent.$inferSelect;
export type NewConsentEvent = typeof consentEvent.$inferInsert;
