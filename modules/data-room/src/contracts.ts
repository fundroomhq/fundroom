import { access, TimestampSchema, UuidSchema } from "@fundroom/contracts";
import { z } from "@hono/zod-openapi";
import { FOLDER_TEMPLATES, ProtectionSchema, ProtectionViewSchema } from "./model.js";
import { QaSettingsPatchBody, QaSettingsSchema } from "./qa/contracts.js";

/*
 * Route schemas for `/api/v1/data-room/*`. Names (`.openapi("…")`) are stable API: the SDK
 * and the web app are generated from them.
 */
export const ScanStatusSchema = z.enum([
  "pending",
  "scanning",
  "clean",
  "infected",
  "error",
  "skipped",
]);
export const RenderStatusSchema = z.enum(["pending", "ready", "unsupported", "failed"]);
export const UploadStatusSchema = z.enum([
  "pending",
  "stored",
  "completed",
  "aborted",
  "expired",
  "failed",
]);
export const DownloadVariantSchema = z.enum(["original", "watermarked"]);

export const FolderSchema = z
  .object({
    id: UuidSchema,
    parentId: UuidSchema.nullable(),
    name: z.string(),
    path: z.string(),
    /** `1.2` style index; null for the root. */
    index: z.string().nullable(),
    sortOrder: z.number().int(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    deletedAt: TimestampSchema.nullable(),
    purgeAfter: TimestampSchema.nullable(),
  })
  .openapi("DataRoomFolder");

export const TreeFolderSchema = FolderSchema.extend({
  access: access.AccessDecisionSchema,
  /** Listed only so a visible item below it can be reached. */
  passthrough: z.boolean(),
}).openapi("DataRoomTreeFolder");

export const DocumentSchema = z
  .object({
    id: UuidSchema,
    folderId: UuidSchema,
    title: z.string(),
    index: z.string(),
    sortOrder: z.number().int(),
    protection: ProtectionViewSchema,
    legalHold: z.boolean(),
    currentVersionId: UuidSchema.nullable(),
    contentType: z.string().nullable(),
    sizeBytes: z.number().int().nullable(),
    pageCount: z.number().int().nullable(),
    renderStatus: RenderStatusSchema.nullable(),
    scanStatus: ScanStatusSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    deletedAt: TimestampSchema.nullable(),
    purgeAfter: TimestampSchema.nullable(),
  })
  .openapi("DataRoomDocument");

export const TreeDocumentSchema = DocumentSchema.extend({
  access: access.AccessDecisionSchema,
}).openapi("DataRoomTreeDocument");

export const TreeSchema = z
  .object({
    rootId: UuidSchema,
    folders: z.array(TreeFolderSchema),
    documents: z.array(TreeDocumentSchema),
  })
  .openapi("DataRoomTree");

export const VersionSchema = z
  .object({
    id: UuidSchema,
    versionNo: z.number().int(),
    fileName: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    pageCount: z.number().int().nullable(),
    renderStatus: RenderStatusSchema,
    renderDetail: z.string().nullable(),
    changeNote: z.string().nullable(),
    uploadedBy: UuidSchema.nullable(),
    createdAt: TimestampSchema,
    isCurrent: z.boolean(),
  })
  .openapi("DataRoomVersion");

export const AvailabilitySchema = z
  .object({
    viewable: z.boolean(),
    download: DownloadVariantSchema.nullable(),
    reason: z.enum([
      "ready",
      "processing",
      "unscanned",
      "infected",
      "failed",
      "unsupported",
      "no_version",
    ]),
  })
  .openapi("DataRoomAvailability");

export const DocumentDetailSchema = z
  .object({
    document: DocumentSchema,
    folder: z.object({ id: UuidSchema, name: z.string(), path: z.string() }),
    currentVersion: VersionSchema.nullable(),
    scan: z
      .object({
        status: ScanStatusSchema,
        engine: z.string().nullable(),
        detail: z.string().nullable(),
        scannedAt: TimestampSchema.nullable(),
      })
      .nullable(),
    versions: z.array(VersionSchema),
    access: access.AccessDecisionSchema,
    availability: AvailabilitySchema,
    legalHold: z
      .object({
        reason: z.string().nullable(),
        setBy: UuidSchema.nullable(),
        setAt: TimestampSchema.nullable(),
      })
      .nullable(),
  })
  .openapi("DataRoomDocumentDetail");

export const VersionListSchema = z
  .object({ versions: z.array(VersionSchema) })
  .openapi("DataRoomVersionList");

export const UploadSchema = z
  .object({
    id: UuidSchema,
    status: UploadStatusSchema,
    method: z.enum(["tus", "multipart"]),
    fileName: z.string(),
    size: z.number().int(),
    contentType: z.string(),
    folderId: UuidSchema.nullable(),
    documentId: UuidSchema.nullable(),
    versionId: UuidSchema.nullable(),
    error: z.string().nullable(),
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
  })
  .openapi("DataRoomUpload");

export const UploadStartBody = z.object({
  fileName: z.string().trim().min(1).max(255),
  size: z.number().int().min(0),
  contentType: z.string().max(200).default("application/octet-stream"),
  /** New document in this folder … */
  folderId: UuidSchema.optional(),
  /** … or a new version of this document. */
  documentId: UuidSchema.optional(),
  changeNote: z.string().trim().max(500).optional(),
});

export const UploadStartSchema = z
  .object({
    upload: UploadSchema,
    method: z.enum(["tus", "multipart"]),
    /** Presigned part URLs (S3 driver). PUT each part, keep the `ETag`, then complete. */
    multipart: z
      .object({
        partSize: z.number().int(),
        parts: z.array(z.object({ partNumber: z.number().int(), url: z.string() })),
      })
      .nullable(),
    /** tus endpoint relative to the API base (filesystem driver); `Upload-Metadata: upload <base64 id>`. */
    tus: z.object({ path: z.string() }).nullable(),
  })
  .openapi("DataRoomUploadStart");

export const UploadCompleteBody = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1), etag: z.string().min(1) }))
    .max(10_000)
    .optional(),
});

export const UploadCompleteSchema = z
  .object({
    upload: UploadSchema,
    document: DocumentSchema,
    version: VersionSchema,
    deduplicated: z.boolean(),
  })
  .openapi("DataRoomUploadComplete");

export const FolderCreateBody = z.object({
  parentId: UuidSchema,
  name: z.string().trim().min(1).max(200),
});
export const FolderPatchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  parentId: UuidSchema.optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});
export const DocumentPatchBody = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  folderId: UuidSchema.optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  protection: ProtectionSchema.partial().optional(),
});
export const LegalHoldBody = z.object({
  hold: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});
export const DeleteResultSchema = z
  .object({ deleted: z.number().int() })
  .openapi("DataRoomDeleteResult");

export const TemplateSchema = z
  .object({
    id: z.enum(FOLDER_TEMPLATES.map((t) => t.id) as [string, ...string[]]),
    name: z.string(),
    description: z.string(),
    folders: z.array(z.string()),
  })
  .openapi("DataRoomTemplate");
export const TemplateListSchema = z
  .object({ templates: z.array(TemplateSchema) })
  .openapi("DataRoomTemplateList");
export const TemplateApplyBody = z.object({ parentId: UuidSchema.optional() });
export const TemplateApplyResultSchema = z
  .object({ created: z.number().int(), tree: TreeSchema })
  .openapi("DataRoomTemplateApplyResult");

export const TrashSchema = z
  .object({ folders: z.array(FolderSchema), documents: z.array(DocumentSchema) })
  .openapi("DataRoomTrash");

export const SearchHitSchema = z
  .object({ pageNo: z.number().int(), snippet: z.string() })
  .openapi("DataRoomSearchHit");
export const SearchResultSchema = z
  .object({ hits: z.array(SearchHitSchema) })
  .openapi("DataRoomSearchResult");
export const SearchQuery = z.object({ q: z.string().trim().min(1).max(200) });

/** `GET /documents/{id}/pages/{n}/text` (E2.8): the extracted text of one page, for assistive tech. */
export const PageTextSchema = z
  .object({
    pageNo: z.number().int().min(1),
    pageCount: z.number().int().min(0),
    text: z.string().openapi({
      description: "Plain text extracted from the page; empty when the page has none (a scan)",
    }),
  })
  .openapi("DataRoomPageText");

export const DataRoomSettingsSchema = z
  .object({
    watermarkByDefault: z.boolean(),
    downloadByDefault: z.boolean(),
    /** E3.13: default `protection.forensic` for new documents. */
    forensicByDefault: z.boolean(),
    allowUnscanned: z.boolean(),
    purgeAfterDays: z.number().int(),
    maxUploadBytes: z.number().int().nullable(),
    /** Operator ceilings the workspace cannot exceed. */
    limits: z.object({ uploadMaxBytes: z.number().int(), renderMaxBytes: z.number().int() }),
    scanner: z.string(),
    /** E3.3: data-room Q&A. */
    qa: QaSettingsSchema,
  })
  .openapi("DataRoomSettings");
export const DataRoomSettingsPatchBody = z.object({
  watermarkByDefault: z.boolean().optional(),
  downloadByDefault: z.boolean().optional(),
  forensicByDefault: z.boolean().optional(),
  allowUnscanned: z.boolean().optional(),
  purgeAfterDays: z.number().int().min(1).max(365).optional(),
  maxUploadBytes: z.number().int().min(1_048_576).nullable().optional(),
  /** Deep-merged into the stored `qa` block (only the keys given change). */
  qa: QaSettingsPatchBody.optional(),
});

export const IdParams = z.object({ id: UuidSchema });
export const PageParams = z.object({
  id: UuidSchema,
  n: z.coerce.number().int().min(1).max(10_000),
});
export const TemplateParams = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/u) });
export const DownloadQuery = z.object({ variant: DownloadVariantSchema.optional() });

export const ViewedResultSchema = z.object({ recorded: z.boolean() }).openapi("DataRoomViewed");

export const BinaryResponse = (contentType: string, description: string) => ({
  description,
  content: { [contentType]: { schema: z.string().openapi({ format: "binary" }) } },
});

// --- forensic watermarking (E3.13, ADR-0061) ------------------------------------------------

/** Largest image a detection accepts. */
export const FORENSIC_DETECT_MAX_BYTES = 15 * 1024 * 1024;
/** Image types a detection accepts. */
export const FORENSIC_DETECT_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/**
 * `multipart/form-data` body of `POST /documents/{id}/forensic/detect`. The image is decoded,
 * tested and dropped — never stored.
 */
export const ForensicDetectBody = z
  .object({
    image: z.string().openapi({
      format: "binary",
      description: "The leaked page image: png, jpeg or webp, at most 15 MiB, at least 200 px wide",
    }),
    page: z.coerce.number().int().min(1).max(10_000).openapi({
      description: "The 1-based page number the image shows",
    }),
    versionId: UuidSchema.optional().openapi({
      description: "The document version it was taken from; default the current version",
    }),
  })
  .openapi("ForensicDetectRequest");

export const ForensicVerdictSchema = z
  .enum(["match", "inconclusive", "no_match"])
  .openapi("ForensicVerdict");

export const ForensicDetectionResultSchema = z
  .object({
    documentId: UuidSchema,
    versionId: UuidSchema,
    page: z.number().int().min(1),
    alignment: z
      .object({
        scale: z.number(),
        dx: z.number(),
        dy: z.number(),
        quality: z.number(),
      })
      .openapi({ description: "How the image was registered onto the page" }),
    thresholds: z.object({ match: z.number(), inconclusive: z.number() }).openapi({
      description:
        "The z-scores the verdicts used: they grow with the number of recipients tested (Bonferroni on P(z ≥ t) ≤ e^(−t²/2)), so the chance that any innocent recipient reaches `match` in this detection stays below about 1e-6",
    }),
    tamperSuspected: z.boolean().openapi({
      description:
        "A recipient scored strongly negative (≤ −match): the mark looks inverted or subtracted, e.g. by averaging copies — treat the image as tampered with",
    }),
    candidatesTested: z.number().int().min(0),
    keysMissing: z.number().int().min(0).openapi({
      description:
        "Recipients that could not be tested because their mark's key has left the key ring",
    }),
    results: z
      .array(
        z.object({
          membershipId: UuidSchema,
          displayName: z.string(),
          email: z.string().nullable().openapi({ description: "`null` once erased" }),
          z: z.number().openapi({
            description: "Detection score; compare with `thresholds` (match / inconclusive)",
          }),
          verdict: ForensicVerdictSchema,
          servedUnderViewAs: z.boolean().openapi({
            description:
              "Served under view-as at least once: this (staff) recipient was served this version at least once while viewing as an investor, and such a copy showed that investor's VISIBLE line over this member's invisible mark. Not per copy: a match does not say whether the leaked copy was the view-as one",
          }),
          viewAsMembershipId: UuidSchema.nullable().openapi({
            description:
              "The LAST investor this member viewed as when served this version under view-as (earlier ones are not kept); `null` when never",
          }),
          firstServedAt: TimestampSchema,
          lastServedAt: TimestampSchema,
        }),
      )
      .openapi({ description: "Only `match` and `inconclusive` recipients, highest z first" }),
    noMatchCount: z.number().int().min(0).openapi({
      description:
        "Recipients whose mark was not detected — NOT ruled out: the image may be degraded, the wrong page, or tampered with",
    }),
  })
  .openapi("ForensicDetectionResult");

export const ForensicRecipientsQuery = z.object({
  versionId: UuidSchema.optional().openapi({ description: "Default: every version" }),
  cursor: z
    .string()
    .max(128)
    .optional()
    .openapi({ description: "Opaque cursor from a previous page" }),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export const ForensicRecipientSchema = z
  .object({
    membershipId: UuidSchema,
    displayName: z.string(),
    email: z.string().nullable().openapi({ description: "`null` once erased" }),
    versionId: UuidSchema,
    versionNo: z.number().int().min(1),
    servedUnderViewAs: z.boolean().openapi({
      description:
        "Served under view-as at least once: this (staff) recipient was served this version at least once while viewing as an investor, and such a copy showed that investor's VISIBLE line over this member's invisible mark. Not per copy: a match does not say whether the leaked copy was the view-as one",
    }),
    viewAsMembershipId: UuidSchema.nullable().openapi({
      description:
        "The LAST investor this member viewed as when served this version under view-as (earlier ones are not kept); `null` when never",
    }),
    trace: z
      .string()
      .regex(/^[A-Z2-7]{8}$/u)
      .openapi({
        description:
          "The trace code printed on this recipient's watermarked downloads (`trace XXXXXXXX`); match a leaked PDF to its recipient with it",
      }),
    firstServedAt: TimestampSchema,
    lastServedAt: TimestampSchema,
  })
  .openapi("ForensicRecipient");

export const ForensicRecipientPageSchema = z
  .object({
    items: z.array(ForensicRecipientSchema),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
  })
  .openapi("ForensicRecipientPage");

export { ProtectionSchema };
