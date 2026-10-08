import {
  bigint,
  boolean,
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
 * Typed view of `migrations/0001_dataroom.sql`; the SQL is authoritative (ADR-0004). The
 * `dataroom` schema is owned by this module (ADR-0007): nothing outside `modules/data-room`
 * reads these tables.
 */
export const dataroomSchema = pgSchema("dataroom");

/** Materialised path (`ltree`). Labels: `[A-Za-z0-9_-]`, dot-separated. */
const ltree = customType<{ data: string; driverData: string }>({
  dataType() {
    return "ltree";
  },
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const scanStatus = dataroomSchema.enum("scan_status", [
  "pending",
  "scanning",
  "clean",
  "infected",
  "error",
  "skipped",
]);
export const SCAN_STATUSES = scanStatus.enumValues;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const renderStatus = dataroomSchema.enum("render_status", [
  "pending",
  "ready",
  "unsupported",
  "failed",
]);
export const RENDER_STATUSES = renderStatus.enumValues;
export type RenderStatus = (typeof RENDER_STATUSES)[number];

export const uploadStatus = dataroomSchema.enum("upload_status", [
  "pending",
  "stored",
  "completed",
  "aborted",
  "expired",
  "failed",
]);
export const UPLOAD_STATUSES = uploadStatus.enumValues;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const RENDITION_KINDS = ["thumbnail", "page", "pdf"] as const;
export type RenditionKind = (typeof RENDITION_KINDS)[number];

export const folder = dataroomSchema.table("folder", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  parentId: uuid("parent_id"),
  name: text("name").notNull(),
  path: ltree("path").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  /** E3.5 (0004): contents are never reachable by an external member through an inherited grant. */
  staffOnly: boolean("staff_only").notNull().default(false),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  purgeAfter: timestamp("purge_after", { withTimezone: true }),
});

export const blob = dataroomSchema.table("blob", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  sha256: bytea("sha256").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  contentType: text("content_type").notNull(),
  storageKey: text("storage_key").notNull(),
  encryption: jsonb("encryption").notNull().default({}),
  encryptionSchemaVersion: integer("encryption_schema_version").notNull().default(1),
  scanStatus: scanStatus("scan_status").notNull().default("pending"),
  scannedAt: timestamp("scanned_at", { withTimezone: true }),
  scanEngine: text("scan_engine"),
  scanDetail: text("scan_detail"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  purgeAfter: timestamp("purge_after", { withTimezone: true }),
});

export const document = dataroomSchema.table("document", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  folderId: uuid("folder_id").notNull(),
  folderPath: ltree("folder_path").notNull(),
  title: text("title").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  currentVersionId: uuid("current_version_id"),
  protection: jsonb("protection").notNull(),
  protectionSchemaVersion: integer("protection_schema_version").notNull().default(1),
  legalHold: boolean("legal_hold").notNull().default(false),
  legalHoldReason: text("legal_hold_reason"),
  legalHoldSetBy: uuid("legal_hold_set_by"),
  legalHoldSetAt: timestamp("legal_hold_set_at", { withTimezone: true }),
  /** E3.5 (0004): the kernel e-sign envelope this document was vaulted from (soft reference). */
  esignEnvelopeId: uuid("esign_envelope_id"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  purgeAfter: timestamp("purge_after", { withTimezone: true }),
});

export const documentVersion = dataroomSchema.table("document_version", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  documentId: uuid("document_id").notNull(),
  versionNo: integer("version_no").notNull(),
  blobId: uuid("blob_id").notNull(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  pageCount: integer("page_count"),
  renderStatus: renderStatus("render_status").notNull().default("pending"),
  renderDetail: text("render_detail"),
  changeNote: text("change_note"),
  uploadedBy: uuid("uploaded_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rendition = dataroomSchema.table("rendition", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  versionId: uuid("version_id").notNull(),
  kind: text("kind").$type<RenditionKind>().notNull(),
  pageNo: integer("page_no"),
  width: integer("width"),
  height: integer("height"),
  contentType: text("content_type").notNull(),
  storageKey: text("storage_key").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pageText = dataroomSchema.table(
  "page_text",
  {
    workspaceId: uuid("workspace_id").notNull(),
    versionId: uuid("version_id").notNull(),
    pageNo: integer("page_no").notNull(),
    text: text("text").notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.versionId, t.pageNo] })],
);

export const upload = dataroomSchema.table("upload", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  folderId: uuid("folder_id"),
  documentId: uuid("document_id"),
  fileName: text("file_name").notNull(),
  declaredSize: bigint("declared_size", { mode: "number" }).notNull(),
  declaredType: text("declared_type").notNull(),
  changeNote: text("change_note"),
  method: text("method").$type<"tus" | "multipart">().notNull(),
  storageKey: text("storage_key").notNull(),
  multipartUploadId: text("multipart_upload_id"),
  status: uploadStatus("status").notNull().default("pending"),
  blobId: uuid("blob_id"),
  versionId: uuid("version_id"),
  error: text("error"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type Folder = typeof folder.$inferSelect;
export type NewFolder = typeof folder.$inferInsert;
export type Blob = typeof blob.$inferSelect;
export type NewBlob = typeof blob.$inferInsert;
export type Document = typeof document.$inferSelect;
export type NewDocument = typeof document.$inferInsert;
export type DocumentVersion = typeof documentVersion.$inferSelect;
export type NewDocumentVersion = typeof documentVersion.$inferInsert;
export type Rendition = typeof rendition.$inferSelect;
export type NewRendition = typeof rendition.$inferInsert;
export type PageTextRow = typeof pageText.$inferSelect;
export type Upload = typeof upload.$inferSelect;
export type NewUpload = typeof upload.$inferInsert;
