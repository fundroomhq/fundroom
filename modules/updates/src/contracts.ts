import { EmailSchema, TimestampSchema, UuidSchema } from "@fundroom/contracts";
import { PageDocSchema } from "@fundroom/module-content";
import { z } from "@hono/zod-openapi";
import { AudienceSchema, SectionRulesSchema } from "./model.js";
import { TEMPLATE_KEYS } from "./templates.js";

/*
 * Route schemas for `/api/v1/updates/*`. They are part of the OpenAPI document the SDK is
 * generated from, so names (`.openapi("…")`) are stable API.
 */
export const PostStateSchema = z.enum(["draft", "scheduled", "sending", "sent", "archived"]);
export const SendKindSchema = z.enum(["live", "test"]);
export const SendStatusSchema = z.enum(["queued", "running", "finished", "failed"]);
export const RecipientStatusSchema = z.enum([
  "queued",
  "sent",
  "delivered",
  "failed",
  "skipped",
  "bounced",
  "complained",
]);
export const TemplateKeySchema = z.enum(TEMPLATE_KEYS);
export const PostSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u)
  .openapi({ example: "september-2026-update" });

export const SendSummarySchema = z
  .object({
    id: UuidSchema,
    kind: SendKindSchema,
    status: SendStatusSchema,
    total: z.number().int(),
    sent: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    /**
     * Delivery feedback from the ESP's webhooks (E2.6), live: a send's `sent` is what the
     * provider accepted; these say what happened next. All zero on a driver without webhooks
     * (SMTP), which is "we were not told", not "nothing was delivered".
     */
    delivered: z.number().int(),
    bounced: z.number().int(),
    complained: z.number().int(),
    error: z.string().nullable(),
    versionId: UuidSchema,
    requestedBy: UuidSchema.nullable(),
    startedAt: TimestampSchema.nullable(),
    finishedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .openapi("UpdateSend");

export const PostSummarySchema = z
  .object({
    id: UuidSchema,
    slug: PostSlugSchema,
    title: z.string(),
    state: PostStateSchema,
    audience: AudienceSchema,
    templateKey: z.string().nullable(),
    scheduledFor: TimestampSchema.nullable(),
    sentAt: TimestampSchema.nullable(),
    publishedVersionNo: z.number().int().nullable(),
    savedAt: TimestampSchema,
    authorMembershipId: UuidSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    lastSend: z.union([SendSummarySchema, z.null()]),
  })
  .openapi("UpdatePost");

export const PostListSchema = z
  .object({ posts: z.array(PostSummarySchema) })
  .openapi("UpdatePostList");

export const VersionSummarySchema = z
  .object({
    id: UuidSchema,
    versionNo: z.number().int(),
    title: z.string(),
    createdAt: TimestampSchema,
    createdBy: UuidSchema.nullable(),
    /** `<slug>:v<n>` of the disclaimer in force when this version was snapshotted (E1.6). */
    disclaimerVersion: z.string().nullable(),
    isPublished: z.boolean(),
  })
  .openapi("UpdateVersion");

export const PostDetailSchema = z
  .object({
    post: PostSummarySchema,
    doc: PageDocSchema,
    visibility: SectionRulesSchema,
    groups: z.array(z.object({ id: UuidSchema, name: z.string() })),
    versions: z.array(VersionSummarySchema),
  })
  .openapi("UpdatePostDetail");

export const TemplateSchema = z
  .object({
    key: TemplateKeySchema,
    name: z.string(),
    description: z.string(),
    doc: PageDocSchema,
  })
  .openapi("UpdateTemplate");
export const TemplateListSchema = z
  .object({ templates: z.array(TemplateSchema) })
  .openapi("UpdateTemplateList");

export const PostIdParams = z.object({ id: UuidSchema });
export const SendIdParams = z.object({ sendId: UuidSchema });
export const ArchiveParams = z.object({ slug: z.string().min(1).max(80) });

export const CreatePostBody = z.object({
  title: z.string().trim().min(1).max(200),
  template: TemplateKeySchema.default("yc"),
});

/** `POST /updates/ai/draft` (E3.12): staff notes for the model and the outline to follow. */
export const AiDraftBody = z.object({
  notes: z.union([
    z
      .string()
      .max(2000)
      .refine((v) => !v.includes("\u0000"), "must not contain the NUL character"),
    z.null(),
  ]),
  template: TemplateKeySchema,
});

export const SaveDraftBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  doc: PageDocSchema.optional(),
  audience: AudienceSchema.optional(),
  visibility: SectionRulesSchema.optional(),
  /** The `savedAt` the editor loaded; a mismatch is a 409. */
  baseSavedAt: TimestampSchema.optional(),
});

export const ScheduleBody = z.object({ scheduledFor: TimestampSchema });
export const TestSendBody = z.object({
  /** Defaults to the caller's own address. */
  to: z.array(EmailSchema).max(5).optional(),
});
export const ArchiveBody = z.object({ archived: z.boolean() });

export const SendListSchema = z
  .object({ sends: z.array(SendSummarySchema) })
  .openapi("UpdateSendList");

export const RecipientSchema = z
  .object({
    id: UuidSchema,
    membershipId: UuidSchema.nullable(),
    email: z.string(),
    status: RecipientStatusSchema,
    error: z.string().nullable(),
    sentAt: TimestampSchema.nullable(),
    lastEventAt: TimestampSchema.nullable(),
  })
  .openapi("UpdateRecipient");
export const RecipientListSchema = z
  .object({ send: SendSummarySchema, recipients: z.array(RecipientSchema) })
  .openapi("UpdateRecipientList");

export const RenderedBlockSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    schemaVersion: z.number().int(),
    data: z.record(z.string(), z.unknown()),
    unavailable: z.enum(["module_unavailable", "hydration_failed"]).optional(),
  })
  .openapi("UpdateRenderedBlock");
export const RenderedSectionSchema = z
  .object({
    key: z.string(),
    title: z.string().nullable(),
    blocks: z.array(RenderedBlockSchema),
  })
  .openapi("UpdateRenderedSection");

export const ArchiveEntrySchema = z
  .object({
    id: UuidSchema,
    slug: PostSlugSchema,
    title: z.string(),
    sentAt: TimestampSchema.nullable(),
    versionNo: z.number().int(),
  })
  .openapi("UpdateArchiveEntry");
export const ArchiveListSchema = z
  .object({ posts: z.array(ArchiveEntrySchema), subscribed: z.boolean() })
  .openapi("UpdateArchiveList");
export const ArchivePageSchema = z
  .object({
    post: ArchiveEntrySchema,
    version: z.object({ id: UuidSchema, versionNo: z.number().int(), createdAt: TimestampSchema }),
    sections: z.array(RenderedSectionSchema),
    viewer: z.enum(["staff", "external"]),
  })
  .openapi("UpdateArchivePage");

export const ThreadReplySchema = z
  .object({
    id: UuidSchema,
    authorMembershipId: UuidSchema,
    authorName: z.string(),
    authorKind: z.enum(["staff", "external"]),
    body: z.string(),
    createdAt: TimestampSchema,
  })
  .openapi("UpdateReply");
export const ThreadSchema = z
  .object({
    membershipId: UuidSchema,
    displayName: z.string(),
    replies: z.array(ThreadReplySchema),
  })
  .openapi("UpdateThread");
export const ThreadListSchema = z
  .object({ threads: z.array(ThreadSchema) })
  .openapi("UpdateThreadList");
export const CreateReplyBody = z.object({
  body: z.string().trim().min(1).max(5000),
  /** Staff only: the investor whose thread to answer in. */
  threadMembershipId: UuidSchema.optional(),
});

export const SubscriptionSchema = z
  .object({ subscribed: z.boolean() })
  .openapi("UpdateSubscription");
export const SubscriptionBody = z.object({ subscribed: z.boolean() });
export const UnsubscribeQuery = z.object({ token: z.string().min(16).max(2048) });
export const UnsubscribeBody = z.object({ token: z.string().min(16).max(2048).optional() });
export const UnsubscribeResultSchema = z
  .object({ ok: z.literal(true), email: z.string(), alreadyUnsubscribed: z.boolean() })
  .openapi("UpdateUnsubscribeResult");

export const UpdatesSettingsSchema = z
  .object({
    fromName: z.string().nullable(),
    fromLocalPart: z.string(),
    replyTo: z.string().nullable(),
    postalAddress: z.string().nullable(),
    footerNote: z.string().nullable(),
  })
  .openapi("UpdatesSettings");
export const UpdatesSettingsPatchBody = z.object({
  fromName: z.string().trim().min(1).max(120).nullable().optional(),
  fromLocalPart: z
    .string()
    .trim()
    .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u)
    .optional(),
  replyTo: EmailSchema.nullable().optional(),
  postalAddress: z.string().trim().min(1).max(300).nullable().optional(),
  footerNote: z.string().trim().min(1).max(1000).nullable().optional(),
});

export const DnsRecordSchema = z
  .object({
    kind: z.enum(["dkim", "spf", "dmarc"]),
    type: z.literal("TXT"),
    name: z.string(),
    value: z.string(),
    required: z.boolean(),
  })
  .openapi("DnsRecord");
export const DomainCheckSchema = z.object({ ok: z.boolean(), found: z.string().nullable() });
export const SendingDomainSchema = z
  .object({
    id: UuidSchema,
    domain: z.string(),
    selector: z.string(),
    status: z.enum(["pending", "verified", "failed"]),
    records: z.array(DnsRecordSchema),
    checks: z.object({
      dkim: DomainCheckSchema.optional(),
      spf: DomainCheckSchema.optional(),
      dmarc: DomainCheckSchema.optional(),
    }),
    lastCheckedAt: TimestampSchema.nullable(),
    lastError: z.string().nullable(),
    verifiedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .openapi("SendingDomain");
export const SendingDomainEnvelopeSchema = z
  .object({ domain: z.union([SendingDomainSchema, z.null()]) })
  .openapi("SendingDomainEnvelope");
export const SetSendingDomainBody = z.object({
  domain: z.string().trim().toLowerCase().min(4).max(253),
});
