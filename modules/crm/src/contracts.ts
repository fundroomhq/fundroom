import { page, TimestampSchema, UuidSchema } from "@fundroom/contracts";
import { z } from "@hono/zod-openapi";
import {
  ACTIVITY_KINDS,
  NO_ROUND,
  ORGANIZATION_KINDS,
  STAGE_KEY_RE,
  SUBJECT_KINDS,
} from "./model.js";

/*
 * Route schemas for `/api/v1/crm/*` (E2.5 §P). Part of the OpenAPI document the SDK is
 * generated from, so every `.openapi("…")` name is stable API: `CrmStage`, `CrmStageList`,
 * `CrmOrganization`, `CrmOrganizationPage`, `CrmOrganizationSummary`, `CrmContact`,
 * `CrmContactPage`, `CrmContactSummary`, `CrmContactDetail`, `CrmContactPipelineItem`,
 * `CrmNote`, `CrmTask`, `CrmPipelineItem` and `CrmPipelineBoard` are the component names this
 * contract froze.
 *
 * Two house rules are load-bearing and both have bitten this repo before:
 *
 *  - **Never `.nullable()` on a named schema.** `X.nullable()` marks the *component* nullable,
 *    so the generated type becomes `X | null` at every use site including the ones that can
 *    never be null. `z.union([X, z.null()])` keeps the component alone.
 *  - **A money figure is a decimal string**, never a JSON number: `numeric(20, 6)` does not
 *    survive a round trip through a double, and `JSON.parse` would make one into a double on
 *    the client the moment it left this document.
 */

/**
 * Plain decimal text — the same expression as `@fundroom/round-terms`' `Decimal`, spelled here
 * with `@hono/zod-openapi`'s `z` so the component carries an example and a description.
 *
 * On a pipeline card this is a **forecast**: what staff expect the investor to put in. The
 * committed figure is `round.commitment`'s and is reached through `commitmentId` (E2.5 D2).
 */
export const CrmDecimalSchema = z
  .string()
  .regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u, "a plain decimal number")
  .max(32)
  .openapi({
    example: "250000",
    description: "Decimal as text; never a JSON number. A forecast, not the committed amount.",
  });

export const SubjectKindSchema = z.enum(SUBJECT_KINDS);
export const OrganizationKindSchema = z.enum(ORGANIZATION_KINDS);

const StageKeySchema = z
  .string()
  .regex(STAGE_KEY_RE)
  .openapi({ example: "soft_committed", description: "Stable machine key; handlers address it" });

const NullableString = z.union([z.string(), z.null()]);
const NullableUuid = z.union([UuidSchema, z.null()]);
const NullableDecimal = z.union([CrmDecimalSchema, z.null()]);
const NullableTimestamp = z.union([TimestampSchema, z.null()]);

export const CrmIdParams = z.object({ id: UuidSchema });

// --- stages -----------------------------------------------------------------------------------

export const CrmStageSchema = z
  .object({
    id: UuidSchema,
    key: StageKeySchema,
    name: z.string(),
    position: z.number().int(),
    isTerminal: z.boolean(),
  })
  .openapi("CrmStage");

export const CrmStageListSchema = z
  .object({ stages: z.array(CrmStageSchema) })
  .openapi("CrmStageList");

/**
 * One entry of a ladder replacement.
 *
 * `id` keeps an existing stage (and its key, which is other people's stored data — see
 * `resolveLadder`). No `id` makes a new one: `key` when the caller wants to choose it,
 * otherwise `custom_<slug of name>`. `position` is absent on purpose — the array's order *is*
 * the order, and a body carrying both would have two answers whenever they disagreed.
 */
export const PutStagesBody = z.object({
  stages: z
    .array(
      z.object({
        id: UuidSchema.optional(),
        key: z.string().regex(STAGE_KEY_RE).optional(),
        name: z.string().trim().min(1).max(80),
        isTerminal: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(40),
});

// --- organisations ----------------------------------------------------------------------------

export const CrmOrganizationSchema = z
  .object({
    id: UuidSchema,
    name: z.string(),
    domain: NullableString,
    website: NullableString,
    kind: z.union([OrganizationKindSchema, z.null()]),
    notes: NullableString,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("CrmOrganization");

export const CrmOrganizationPageSchema = page(CrmOrganizationSchema, "CrmOrganizationPage");

/** What a card or a contact shows about its firm: the name, and nothing else. */
export const CrmOrganizationSummarySchema = z
  .object({ id: UuidSchema, name: z.string() })
  .openapi("CrmOrganizationSummary");

const DomainSchema = z.string().trim().max(253);
const WebsiteSchema = z.string().trim().max(2000);
const NotesSchema = z.string().trim().max(4000);

export const CreateOrganizationBody = z.object({
  name: z.string().trim().min(1).max(200),
  domain: DomainSchema.optional(),
  website: WebsiteSchema.optional(),
  kind: OrganizationKindSchema.optional(),
  notes: NotesSchema.optional(),
});

export const PatchOrganizationBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  domain: z.union([DomainSchema, z.null()]).optional(),
  website: z.union([WebsiteSchema, z.null()]).optional(),
  kind: z.union([OrganizationKindSchema, z.null()]).optional(),
  notes: z.union([NotesSchema, z.null()]).optional(),
});

export const OrganizationsQuery = z.object({
  q: z.string().trim().max(120).optional(),
  cursor: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// --- contacts ---------------------------------------------------------------------------------

export const CrmContactSchema = z
  .object({
    id: UuidSchema,
    organizationId: NullableUuid,
    /** The `core.membership` this contact is linked to, if any. A contact is not a login. */
    membershipId: NullableUuid,
    displayName: z.string(),
    email: NullableString,
    title: NullableString,
    tags: z.array(z.string()),
    notes: NullableString,
    ownerMembershipId: NullableUuid,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("CrmContact");

export const CrmContactPageSchema = page(CrmContactSchema, "CrmContactPage");

/** What a pipeline card shows about its person. */
export const CrmContactSummarySchema = z
  .object({ id: UuidSchema, displayName: z.string(), email: NullableString })
  .openapi("CrmContactSummary");

export const CrmNoteSchema = z
  .object({
    id: UuidSchema,
    subjectKind: SubjectKindSchema,
    subjectId: UuidSchema,
    body: z.string(),
    authorMembershipId: NullableUuid,
    createdAt: TimestampSchema,
  })
  .openapi("CrmNote");

export const CrmTaskSchema = z
  .object({
    id: UuidSchema,
    subjectKind: SubjectKindSchema,
    subjectId: UuidSchema,
    title: z.string(),
    dueAt: NullableTimestamp,
    assigneeMembershipId: NullableUuid,
    doneAt: NullableTimestamp,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("CrmTask");

/** A card as the contact screen shows it: enough to say where this person stands. */
export const CrmContactPipelineItemSchema = z
  .object({
    id: UuidSchema,
    roundId: NullableUuid,
    stageId: UuidSchema,
    stageKey: NullableString,
    stageName: NullableString,
    amount: NullableDecimal,
    currency: NullableString,
    commitmentId: NullableUuid,
    ownerMembershipId: NullableUuid,
    position: z.number().int(),
  })
  .openapi("CrmContactPipelineItem");

export const CrmContactDetailSchema = z
  .object({
    contact: CrmContactSchema,
    organization: z.union([CrmOrganizationSummarySchema, z.null()]),
    notes: z.array(CrmNoteSchema),
    tasks: z.array(CrmTaskSchema),
    items: z.array(CrmContactPipelineItemSchema),
  })
  .openapi("CrmContactDetail");

// --- activity (E3.6) --------------------------------------------------------------------------

export const CrmActivityKindSchema = z.enum(ACTIVITY_KINDS).openapi("CrmActivityKind");

/**
 * One meeting fact on a contact's timeline, recorded from a verified Calendly / Cal.com booking
 * webhook. `title` is the vendor's event-type name; the invitee's name and address are the
 * contact's own fields and are not repeated here.
 */
export const CrmActivitySchema = z
  .object({
    id: UuidSchema,
    contactId: UuidSchema,
    kind: CrmActivityKindSchema,
    /** When the fact was recorded (the webhook arrived). */
    occurredAt: TimestampSchema,
    /** The meeting's start (for a reschedule: the new start). */
    startsAt: TimestampSchema,
    endsAt: NullableTimestamp,
    title: NullableString,
    provider: z.union([z.enum(["calendly", "calcom"]), z.null()]),
    /** The kernel booking (`GET /integrations/bookings`); null for a non-booking activity. */
    bookingId: NullableUuid,
  })
  .openapi("CrmActivity");

export const CrmActivityListSchema = z
  .object({ activities: z.array(CrmActivitySchema) })
  .openapi("CrmActivityList");

const EmailSchema = z.string().trim().max(320);
const TagsSchema = z.array(z.string().trim().min(1).max(40)).max(50);

/**
 * `displayName` defaults to the empty string because `membershipId` may supply it: a staff
 * member who picks somebody out of the people list should not have to retype their name. With
 * no `membershipId` an empty name is refused by the service, not by this schema, so the two
 * cases produce one message instead of two.
 */
export const CreateContactBody = z.object({
  displayName: z.string().trim().max(200).default(""),
  organizationId: UuidSchema.optional(),
  membershipId: UuidSchema.optional(),
  email: EmailSchema.optional(),
  title: z.string().trim().max(120).optional(),
  tags: TagsSchema.optional(),
  notes: NotesSchema.optional(),
  ownerMembershipId: UuidSchema.optional(),
});

export const PatchContactBody = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  organizationId: z.union([UuidSchema, z.null()]).optional(),
  membershipId: z.union([UuidSchema, z.null()]).optional(),
  email: z.union([EmailSchema, z.null()]).optional(),
  title: z.union([z.string().trim().max(120), z.null()]).optional(),
  tags: TagsSchema.optional(),
  notes: z.union([NotesSchema, z.null()]).optional(),
  ownerMembershipId: z.union([UuidSchema, z.null()]).optional(),
});

export const ContactsQuery = z.object({
  q: z.string().trim().max(120).optional(),
  organizationId: UuidSchema.optional(),
  tag: z.string().trim().max(40).optional(),
  cursor: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// --- pipeline ---------------------------------------------------------------------------------

export const CrmPipelineItemSchema = z
  .object({
    id: UuidSchema,
    /** Soft reference into the round module; `null` for a card attached to no round. */
    roundId: NullableUuid,
    stageId: UuidSchema,
    stageKey: NullableString,
    amount: NullableDecimal,
    currency: NullableString,
    commitmentId: NullableUuid,
    ownerMembershipId: NullableUuid,
    position: z.number().int(),
    contact: z.union([CrmContactSummarySchema, z.null()]),
    organization: z.union([CrmOrganizationSummarySchema, z.null()]),
  })
  .openapi("CrmPipelineItem");

export const CrmPipelineBoardSchema = z
  .object({ stages: z.array(CrmStageSchema), items: z.array(CrmPipelineItemSchema) })
  .openapi("CrmPipelineBoard");

/**
 * `roundId` has three states and a query string can only carry two, so the third is spelled:
 * absent means every card, the literal `none` means the cards attached to no round, and a uuid
 * means that round. An empty string is indistinguishable from absence once a browser has
 * serialised a form, which is why the sentinel is a word.
 */
export const PipelineQuery = z.object({
  roundId: z
    .union([UuidSchema, z.literal(NO_ROUND)])
    .optional()
    .openapi({ description: `A round id, or \`${NO_ROUND}\` for cards attached to no round` }),
});

const CurrencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/u);

export const CreatePipelineItemBody = z.object({
  roundId: UuidSchema.optional(),
  contactId: UuidSchema.optional(),
  organizationId: UuidSchema.optional(),
  stageId: UuidSchema.optional(),
  stageKey: z.string().regex(STAGE_KEY_RE).optional(),
  amount: CrmDecimalSchema.optional(),
  currency: CurrencySchema.optional(),
  ownerMembershipId: UuidSchema.optional(),
  commitmentId: UuidSchema.optional(),
});

export const PatchPipelineItemBody = z.object({
  stageId: UuidSchema.optional(),
  stageKey: z.string().regex(STAGE_KEY_RE).optional(),
  amount: z.union([CrmDecimalSchema, z.null()]).optional(),
  currency: z.union([CurrencySchema, z.null()]).optional(),
  ownerMembershipId: z.union([UuidSchema, z.null()]).optional(),
  commitmentId: z.union([UuidSchema, z.null()]).optional(),
  organizationId: z.union([UuidSchema, z.null()]).optional(),
  position: z.number().int().min(0).max(100_000).optional(),
});

// --- notes and tasks --------------------------------------------------------------------------

export const CreateNoteBody = z.object({
  subjectKind: SubjectKindSchema,
  subjectId: UuidSchema,
  body: z.string().trim().min(1).max(20_000),
});

export const CreateTaskBody = z.object({
  subjectKind: SubjectKindSchema,
  subjectId: UuidSchema,
  title: z.string().trim().min(1).max(200),
  dueAt: TimestampSchema.optional(),
  assigneeMembershipId: UuidSchema.optional(),
});

export const PatchTaskBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  dueAt: z.union([TimestampSchema, z.null()]).optional(),
  assigneeMembershipId: z.union([UuidSchema, z.null()]).optional(),
  done: z.boolean().optional(),
});
