import { TimestampSchema, trimmedText, UuidSchema } from "@fundroom/contracts";
import { z } from "@hono/zod-openapi";
import { BLOCK_TYPES, PageDocSchema, SECTION_KEY_RE } from "./blocks.js";
import { PreviewAsSchema, VisibilityMapSchema, VisibilityRuleSchema } from "./visibility.js";

/*
 * Route schemas for `/api/v1/content/*`. They are part of the OpenAPI document the SDK is
 * generated from, so names (`.openapi("…")`) are stable API.
 */
export const PageKindSchema = z.enum(["home", "custom"]);
export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u)
  .openapi({ example: "round-2026" });

export const PageSummarySchema = z
  .object({
    id: UuidSchema,
    slug: SlugSchema,
    kind: PageKindSchema,
    title: z.string(),
    publishedRevisionNo: z.number().int().nullable(),
    publishedAt: TimestampSchema.nullable(),
    draftSavedAt: TimestampSchema.nullable(),
    draftDirty: z.boolean(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("ContentPage");

export const PageListSchema = z
  .object({ pages: z.array(PageSummarySchema) })
  .openapi("ContentPageList");

export const PageDetailSchema = z
  .object({
    page: PageSummarySchema,
    draft: z.object({ revisionId: UuidSchema, doc: PageDocSchema, savedAt: TimestampSchema }),
    visibility: VisibilityMapSchema,
    /** Groups the editor can target (names only). */
    groups: z.array(z.object({ id: UuidSchema, name: z.string() })),
  })
  .openapi("ContentPageDetail");

export const RevisionSummarySchema = z
  .object({
    id: UuidSchema,
    revisionNo: z.number().int(),
    createdAt: TimestampSchema,
    publishedAt: TimestampSchema.nullable(),
    createdBy: UuidSchema.nullable(),
    note: z.string().nullable(),
    /** `<slug>:v<n>` of the disclaimer in force when this revision was published (E1.6). */
    disclaimerVersion: z.string().nullable(),
    isCurrent: z.boolean(),
    isDraft: z.boolean(),
  })
  .openapi("ContentRevision");

export const RevisionListSchema = z
  .object({ revisions: z.array(RevisionSummarySchema) })
  .openapi("ContentRevisionList");

export const RevisionDetailSchema = z
  .object({ revision: RevisionSummarySchema, doc: PageDocSchema, visibility: VisibilityMapSchema })
  .openapi("ContentRevisionDetail");

export const RenderedBlockSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    schemaVersion: z.number().int(),
    data: z.record(z.string(), z.unknown()),
    unavailable: z.enum(["module_unavailable", "hydration_failed"]).optional(),
  })
  .openapi("RenderedBlock");

export const RenderedSectionSchema = z
  .object({
    key: z.string(),
    title: z.string().nullable(),
    visibility: VisibilityRuleSchema,
    blocks: z.array(RenderedBlockSchema),
  })
  .openapi("RenderedSection");

export const RenderedPageSchema = z
  .object({
    page: z.object({ id: UuidSchema, slug: SlugSchema, kind: PageKindSchema, title: z.string() }),
    revision: z.object({
      id: UuidSchema,
      revisionNo: z.number().int(),
      publishedAt: TimestampSchema.nullable(),
    }),
    sections: z.array(RenderedSectionSchema),
    viewer: z.enum(["anonymous", "external", "staff"]),
    preview: z.boolean(),
  })
  .openapi("RenderedPage");

export const BlockDescriptorSchema = z
  .object({
    type: z.enum(BLOCK_TYPES),
    kind: z.enum(["static", "reference"]),
    schemaVersion: z.number().int(),
    /** For reference blocks: the module that hydrates it, and whether it is enabled here. */
    providedBy: z.string().nullable(),
    available: z.boolean(),
  })
  .openapi("BlockDescriptor");

export const BlockListSchema = z
  .object({ blocks: z.array(BlockDescriptorSchema) })
  .openapi("BlockList");

export const ContentSettingsSchema = z
  .object({ allowPublicSections: z.boolean() })
  .openapi("ContentSettings");
export const ContentSettingsPatchBody = z.object({ allowPublicSections: z.boolean().optional() });

export const PageIdParams = z.object({ id: UuidSchema });
export const RevisionParams = z.object({ id: UuidSchema, revisionId: UuidSchema });
export const SlugParams = z.object({ slug: SlugSchema });
export const CreatePageBody = z.object({
  slug: SlugSchema,
  title: trimmedText({ min: 1, max: 200 }),
});
export const PatchPageBody = z.object({
  title: trimmedText({ min: 1, max: 200 }).optional(),
  slug: SlugSchema.optional(),
});
export const SaveDraftBody = z.object({
  doc: PageDocSchema,
  /** The `draft.savedAt` you loaded; a different value on the server means someone else saved (409). */
  baseSavedAt: TimestampSchema.optional(),
});
export const VisibilityBody = z.object({ rules: VisibilityMapSchema });
export const PublishBody = z.object({ note: z.string().trim().max(500).optional() });
export const PreviewQuery = z.object({ as: PreviewAsSchema.default("authenticated") });

export { PageDocSchema, SECTION_KEY_RE, VisibilityMapSchema, VisibilityRuleSchema };
