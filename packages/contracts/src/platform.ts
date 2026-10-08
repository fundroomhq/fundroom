import { z } from "@hono/zod-openapi";
import { JurisdictionSchema, MoveStateSchema } from "./residency.js";
import { EmailSchema, SlugSchema, TimestampSchema, UuidSchema } from "./schemas.js";

/*
 * The managed-host control plane's operator API (E3.10, ADR-0058): `/api/v1/platform/*`, plus the
 * plan/usage schemas the tenant's `GET /api/v1/usage` and `GET /api/v1/billing` share.
 *
 * Handlers live in `apps/server/src/routes/platform*.ts`, behind `requirePlatformOperator()`
 * (`apps/server/src/middleware/platform.ts`): an operator cookie session on the canonical host,
 * a live `core.platform_operator` row, `PLATFORM_OPERATOR_CIDRS`, CSRF. Anything else — including
 * CONTROL_PLANE=off — is a plain 404 `not_found`. No tenant content is ever returned here: names,
 * slugs, plans, status, usage counters and owners' email addresses (audited) only.
 *
 * Enum values are spelled out rather than imported from `@fundroom/db` (see `domains.ts`), and
 * `z.union([X, z.null()])` is used instead of `.nullable()` on a named schema.
 */

// --- shared vocabulary --------------------------------------------------------------------------

export const WorkspaceStatusSchema = z
  .enum(["active", "pending_review", "suspended"])
  .openapi("WorkspaceStatus", {
    description:
      "`pending_review`: held until its sanctions screen is cleared. `suspended`: see `suspendedReason`.",
  });

export const SuspendReasonSchema = z
  .enum(["operator", "billing", "sanctions", "relocation"])
  .openapi("SuspendReason", {
    description: "`relocation`: the workspace is moving to another cell (planned downtime).",
  });

export const WorkspaceHoldSchema = z
  .enum(["sanctions_review", "operator", "billing", "sanctions", "relocation"])
  .openapi("WorkspaceHold", {
    description:
      "Independent flags, each set and cleared by its owner; `status` / `suspendedReason` are derived from them. `sanctions_review`: a new workspace until its screen is clear or cleared (→ `pending_review`). `operator`, `billing`, `sanctions`, `relocation` suspend (reason = the highest: sanctions > operator > relocation > billing). `sanctions` is lifted only by an operator once a later screening is clear or cleared. `relocation` is set and lifted only by a move between cells.",
  });

/** The holds an operator may lift with `POST /platform/workspaces/{id}/unsuspend` (not `relocation`: moves own it). */
export const LiftableHoldSchema = z
  .enum(["sanctions_review", "operator", "billing", "sanctions"])
  .openapi("LiftableHold");

export const SubscriptionStatusSchema = z
  .enum(["trialing", "active", "past_due", "unpaid", "canceled", "incomplete", "paused"])
  .openapi("SubscriptionStatus");

/** `core.plan.id`. */
export const PlanIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,40}$/u, "lower-case plan id")
  .openapi({ example: "starter" });

/** `core.cell.id`. */
export const CellIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,30}$/u, "lower-case cell id")
  .openapi({ example: "default" });

/** ISO 3166-1 alpha-2, upper case. */
export const CountryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/u, "ISO 3166-1 alpha-2 country code")
  .openapi({ example: "DE" });

/**
 * A feature a plan can gate (A-3, ADR-0063), in display order. Mirrors `PLAN_FEATURES` in
 * `@fundroom/domain` (spelled out: this package keeps no `@fundroom/*` dependencies; the server
 * pins the two together at compile time in `apps/server/src/entitlements.ts`).
 */
export const PlanFeatureSchema = z
  .enum([
    "qa",
    "api_keys",
    "webhooks",
    "integrations",
    "esign",
    "accreditation",
    "sso",
    "scim",
    "forensic",
    "anchoring",
    "ai",
    "access_reviews",
  ])
  .openapi("PlanFeature");

/** An optional module's id (`ModuleManifest.id`); existence is checked server-side. */
const PlanModuleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/u, "module id")
  .openapi({ example: "data-room" });

const unique = (a: readonly string[]) => new Set(a).size === a.length;

/**
 * What a plan allows. Every key is optional and an absent key is unlimited; a workspace without a
 * plan (every self-hosted one) is unlimited everywhere. `emailsPerMonth` is reported, not enforced
 * (v1).
 *
 * `modules` / `features` (A-3, ADR-0063): the optional modules a workspace on the plan may have on
 * and the features it may turn on. Absent = all, `[]` = none. A plan gates turning things on: a
 * module already on but outside the plan becomes read-only for staff, and a feature already set up
 * keeps working. `modules` lists optional modules compiled into this build only (400
 * `validation_failed`, `reason: "unknown_module"`, otherwise); `GET /platform/plans`
 * `entitlementCatalog` says which.
 */
export const PlanLimitsSchema = z
  .strictObject({
    staffSeats: z.number().int().min(1).optional(),
    investorSeats: z.number().int().min(1).optional(),
    storageBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    customDomains: z.number().int().min(0).optional(),
    emailsPerMonth: z.number().int().min(0).optional(),
    modules: z
      .array(PlanModuleIdSchema)
      .max(32)
      .refine(unique, { message: "duplicate module id" })
      .optional()
      .openapi({
        description:
          "Optional modules a workspace on this plan may have on. Absent: all; `[]`: none",
      }),
    features: z
      .array(PlanFeatureSchema)
      .max(12)
      .refine(unique, { message: "duplicate feature" })
      .optional()
      .openapi({
        description: "Features a workspace on this plan may turn on. Absent: all; `[]`: none",
      }),
  })
  .openapi("PlanLimits");

export const PlanLimitKindSchema = z
  .enum(["staffSeats", "investorSeats", "storageBytes", "customDomains", "module", "feature"])
  .openapi("PlanLimitKind", {
    description:
      "`details.limit` of a 402 `plan_limit`: a quota (with `details.max`), or `module` / `feature` (with `details.module` / `details.feature`) when the plan does not include it",
  });

/** One day of `core.tenant_usage_daily` (`day` is a UTC date). */
export const UsageDaySchema = z
  .object({
    day: z.iso.date().openapi({ example: "2026-09-27" }),
    storageBytes: z.number().int().nonnegative(),
    docsViewed: z.number().int().nonnegative(),
    emailsSent: z.number().int().nonnegative(),
    staffSeats: z.number().int().nonnegative(),
    investorSeats: z.number().int().nonnegative(),
    customDomains: z.number().int().nonnegative(),
    computedAt: TimestampSchema,
  })
  .openapi("UsageDay");

export const PlanSummarySchema = z
  .object({ id: PlanIdSchema, name: z.string(), limits: PlanLimitsSchema })
  .openapi("PlanSummary");

/** `GET /usage` (tenant, `billing.read`) and `GET /platform/workspaces/{id}/usage`. */
export const WorkspaceUsageSchema = z
  .object({
    plan: z.union([PlanSummarySchema, z.null()]).openapi({
      description: "`null`: no plan, nothing is limited",
    }),
    today: z.union([UsageDaySchema, z.null()]),
    last30: z.array(UsageDaySchema).openapi({ description: "Oldest first" }),
  })
  .openapi("WorkspaceUsage");

/** Carried by the bootstrap and the page config while the workspace is not `active`. */
export const WorkspaceStatusStateSchema = z
  .object({
    status: WorkspaceStatusSchema,
    reason: z.union([SuspendReasonSchema, z.null()]),
  })
  .openapi("WorkspaceStatusState");

// --- operator session -------------------------------------------------------------------------

export const PlatformSessionSchema = z
  .object({
    ok: z.literal(true),
    expiresAt: TimestampSchema.openapi({ description: "Absolute expiry of the operator session" }),
  })
  .openapi("PlatformSession");

export const PlatformMeSchema = z
  .object({
    userId: UuidSchema,
    email: z.union([z.string(), z.null()]),
    displayName: z.string(),
    cellId: CellIdSchema.openapi({ description: "The cell this server runs (`CELL_ID`)" }),
    billingDriver: z.enum(["none", "manual", "stripe"]).openapi({
      description:
        "`BILLING_DRIVER` in effect (`none` when billing is off); `manual` enables `POST /platform/workspaces/{id}/subscription`",
    }),
    session: z.object({
      createdAt: TimestampSchema,
      idleExpiresAt: TimestampSchema,
      absoluteExpiresAt: TimestampSchema,
    }),
  })
  .openapi("PlatformMe");

// --- workspaces -------------------------------------------------------------------------------

export const PlatformSubscriptionSummarySchema = z
  .object({
    status: SubscriptionStatusSchema,
    provider: z.enum(["manual", "stripe"]),
    currentPeriodEnd: z.union([TimestampSchema, z.null()]),
  })
  .openapi("PlatformSubscriptionSummary");

export const PlatformWorkspaceSchema = z
  .object({
    id: UuidSchema,
    slug: SlugSchema,
    name: z.string(),
    legalName: z.union([z.string(), z.null()]),
    country: z.union([CountryCodeSchema, z.null()]),
    status: WorkspaceStatusSchema,
    suspendedReason: z.union([SuspendReasonSchema, z.null()]),
    holds: z.array(WorkspaceHoldSchema).openapi({
      description: "Every hold the workspace carries (sorted); empty when `active`",
    }),
    cellId: CellIdSchema,
    planId: z.union([PlanIdSchema, z.null()]),
    subscription: z.union([PlatformSubscriptionSummarySchema, z.null()]),
    usage: z.union([UsageDaySchema, z.null()]).openapi({ description: "The latest usage row" }),
    customDomains: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
    deletedAt: z.union([TimestampSchema, z.null()]),
  })
  .openapi("PlatformWorkspace");

export const PlatformWorkspacePageSchema = z
  .object({
    items: z.array(PlatformWorkspaceSchema),
    nextCursor: z.union([z.string(), z.null()]).openapi({ description: "`null` on the last page" }),
  })
  .openapi("PlatformWorkspacePage");

export const PlatformWorkspaceListQuery = z.object({
  cursor: z.string().max(512).optional().openapi({ description: "Opaque, from `nextCursor`" }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z
    .string()
    .trim()
    .max(200)
    .optional()
    .openapi({ description: "Matches slug, name or legal name" }),
  status: WorkspaceStatusSchema.optional(),
  plan: PlanIdSchema.optional(),
});

export const SanctionsScreeningStateSchema = z
  .object({
    outcome: z.enum(["clear", "potential_match", "error"]),
    decision: z.union([z.enum(["cleared", "confirmed"]), z.null()]),
    createdAt: TimestampSchema,
  })
  .openapi("SanctionsScreeningState");

export const PlatformWorkspaceDetailSchema = PlatformWorkspaceSchema.extend({
  sanctions: z.union([SanctionsScreeningStateSchema, z.null()]).openapi({
    description: "The latest screening; `null` when never screened",
  }),
  owners: z.array(z.object({ email: z.string() })).openapi({
    description:
      "Owners' addresses, for the billing contact (the read is audited). Only `GET /platform/workspaces/{id}` fills it; the answer to a write is `[]` (a write is not an owners read)",
  }),
}).openapi("PlatformWorkspaceDetail");

export const PlatformWorkspaceIdParam = z.object({ id: UuidSchema });

export const PlatformWorkspaceCreateBody = z.strictObject({
  slug: SlugSchema,
  name: z.string().trim().min(1).max(100),
  legalName: z.string().trim().min(1).max(200),
  country: CountryCodeSchema,
  ownerEmail: EmailSchema,
  planId: z.union([PlanIdSchema, z.null()]),
  cellId: CellIdSchema.optional(),
});

export const PlatformWorkspacePatchBody = z
  .strictObject({
    planId: z.union([PlanIdSchema, z.null()]).optional(),
    cellId: CellIdSchema.optional(),
    legalName: z.string().trim().min(1).max(200).optional().openapi({
      description: "The tenant company's legal name; a change queues a sanctions re-screen",
    }),
    country: CountryCodeSchema.optional().openapi({
      description: "The tenant company's country; a change queues a sanctions re-screen",
    }),
  })
  .refine(
    (b) =>
      b.planId !== undefined ||
      b.cellId !== undefined ||
      b.legalName !== undefined ||
      b.country !== undefined,
    { message: "name planId, cellId, legalName or country" },
  );

export const PlatformSuspendBody = z.strictObject({
  reason: z.literal("operator"),
  note: z.string().trim().min(1).max(2000),
});

export const PlatformUnsuspendBody = z.strictObject({
  note: z.string().trim().min(1).max(2000).optional(),
  hold: LiftableHoldSchema.default("operator").openapi({
    description:
      "The hold to lift (default `operator`); every other hold stays. `sanctions_review` and `sanctions` need the latest screening clear or cleared (409 `sanctions_unresolved`); `billing` is an audited override (the billing job sets it again while the subscription is past its grace)",
  }),
});

/** `POST /platform/workspaces/{id}/subscription` — manual billing driver only. */
export const PlatformSubscriptionBody = z.strictObject({
  status: SubscriptionStatusSchema,
  planId: PlanIdSchema.optional().openapi({ description: "Default: the workspace's plan" }),
  currentPeriodEnd: z.union([TimestampSchema, z.null()]).optional(),
});

// --- operator enrolment (fix round 2) -----------------------------------------------------------

/** The token `fundroom operator enrol-link` printed (base64url, 256 bits). */
const EnrolTokenSchema = z
  .string()
  .min(20)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .openapi({ description: "The token `fundroom operator enrol-link` printed" });

export const PlatformEnrolStartBody = z.strictObject({
  token: EnrolTokenSchema,
  email: EmailSchema,
});

export const PlatformEnrolVerifyBody = z.strictObject({
  token: EnrolTokenSchema,
  email: EmailSchema,
  code: z.string().min(4).max(12).openapi({ example: "123456" }),
});

export const PlatformEnrolSessionSchema = z
  .object({
    email: z.string(),
    expiresAt: TimestampSchema.openapi({ description: "The enrolment-only session ends then" }),
  })
  .openapi("PlatformEnrolSession");

// --- cells, operators, audit, health ----------------------------------------------------------

export const CellSchema = z
  .object({
    id: CellIdSchema,
    region: z.string(),
    /** E3.11: human text for the region ('' = none declared). */
    regionLabel: z.string(),
    jurisdiction: z.union([JurisdictionSchema, z.null()]),
    publicOrigin: z.string().openapi({ description: "`''`: this install" }),
    status: z.enum(["active", "draining", "closed"]),
    local: z.boolean().openapi({
      description:
        "Served by this cell's database (a label change moves a workspace instantly); remote cells come from the shared directory and need a move",
    }),
    heartbeatAt: z.union([TimestampSchema, z.null()]).openapi({
      description: "The cell's last directory heartbeat (null in local mode)",
    }),
    workspaces: z.union([z.number().int().nonnegative(), z.null()]).openapi({
      description: "null for remote cells",
    }),
    createdAt: z.union([TimestampSchema, z.null()]).openapi({
      description: "null for remote cells",
    }),
  })
  .openapi("Cell");

export const CellListSchema = z.object({ cells: z.array(CellSchema) }).openapi("CellList");

// --- moves between cells (E3.11, ADR-0059) -----------------------------------------------------

/** The public view of a directory move: never the bundle URL. */
export const MoveSchema = z
  .object({
    id: UuidSchema,
    workspaceId: UuidSchema.openapi({ description: "The SOURCE workspace id" }),
    slug: SlugSchema,
    sourceCellId: CellIdSchema,
    targetCellId: CellIdSchema,
    sourceRegion: z.union([z.string(), z.null()]),
    targetRegion: z.union([z.string(), z.null()]),
    state: MoveStateSchema,
    error: z.union([z.object({ stage: z.string(), code: z.string() }), z.null()]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("Move");

export const MoveListSchema = z.object({ items: z.array(MoveSchema) }).openapi("MoveList");

/** `POST /platform/workspaces/{id}/move`. */
export const PlatformMoveBody = z.strictObject({
  targetCellId: CellIdSchema,
  confirmSlug: SlugSchema.openapi({ description: "Must equal the workspace's slug" }),
});

/** `GET /platform/moves`. */
export const PlatformMovesQuery = z.object({
  workspaceId: UuidSchema.optional(),
  state: MoveStateSchema.optional(),
});

export const MoveIdParam = z.object({ id: UuidSchema });

export const PlatformOperatorSchema = z
  .object({
    userId: UuidSchema,
    email: z.union([z.string(), z.null()]),
    createdAt: TimestampSchema,
    createdBy: z.string(),
    revokedAt: z.union([TimestampSchema, z.null()]),
  })
  .openapi("PlatformOperator");

export const PlatformOperatorListSchema = z
  .object({ operators: z.array(PlatformOperatorSchema) })
  .openapi("PlatformOperatorList");

export const PlatformAuditEntrySchema = z
  .object({
    id: UuidSchema,
    seq: z.number().int(),
    occurredAt: TimestampSchema,
    actorKind: z.enum(["staff", "external", "system", "host"]),
    actorUserId: z.union([UuidSchema, z.null()]),
    action: z.string(),
    resourceKind: z.string(),
    resourceId: z.union([z.string(), z.null()]),
    outcome: z.enum(["success", "denied", "failure"]),
    meta: z.record(z.string(), z.unknown()),
  })
  .openapi("PlatformAuditEntry");

export const PlatformAuditPageSchema = z
  .object({
    items: z.array(PlatformAuditEntrySchema),
    nextCursor: z.union([z.string(), z.null()]),
  })
  .openapi("PlatformAuditPage");

export const PlatformAuditQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const PlatformHealthSchema = z
  .object({
    queues: z.array(
      z.object({
        name: z.string(),
        queued: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
      }),
    ),
    deadLetters: z.number().int().nonnegative(),
    adapters: z.array(
      z.object({
        name: z.string(),
        status: z.enum(["ok", "fail", "skipped"]),
        detail: z.union([z.string(), z.null()]),
      }),
    ),
    checkedAt: TimestampSchema,
  })
  .openapi("PlatformHealth");

// --- plans --------------------------------------------------------------------------------------

/** A plan's metered provider prices (Stripe `price_…` ids): at most 10, distinct. */
export const MeteredPriceRefsSchema = z
  .array(z.string().min(1).max(255))
  .max(10)
  .refine((a) => new Set(a).size === a.length, { message: "duplicate price ref" })
  .openapi({
    description:
      "Metered prices (on the meters whose event names are `BILLING_METER_SEATS_EVENT` and `BILLING_METER_STORAGE_EVENT`, by default `fundroom_staff_seats` and `fundroom_storage_gb`): added to a checkout as quantity-less line items; usage is reported only for meters whose price is on the subscription",
  });

export const PlanSchema = z
  .object({
    id: PlanIdSchema,
    name: z.string(),
    limits: PlanLimitsSchema,
    billingPriceRef: z.union([z.string(), z.null()]),
    billingMeteredPriceRefs: z.array(z.string()),
    trialDays: z.number().int().min(0).max(90),
    public: z.boolean(),
    archivedAt: z.union([TimestampSchema, z.null()]),
    workspaces: z.number().int().nonnegative().openapi({ description: "Workspaces on this plan" }),
    version: z.number().int().min(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("Plan");

/** What a plan's `modules` / `features` may list on this build (the operator UI's checklists). */
export const PlanEntitlementCatalogSchema = z
  .object({
    modules: z.array(z.string()).openapi({
      description:
        "Optional (non-required) modules compiled into this build, sorted; not narrowed by `MODULES`, so a plan can list a module this install runs without",
    }),
    features: z.array(PlanFeatureSchema).openapi({ description: "Every feature, display order" }),
  })
  .openapi("PlanEntitlementCatalog");

export const PlanListSchema = z
  .object({ plans: z.array(PlanSchema), entitlementCatalog: PlanEntitlementCatalogSchema })
  .openapi("PlanList");

export const PlanIdParam = z.object({ id: PlanIdSchema });

export const PlanCreateBody = z.strictObject({
  id: PlanIdSchema,
  name: z.string().trim().min(1).max(100),
  limits: PlanLimitsSchema,
  billingPriceRef: z.union([z.string().min(1).max(255), z.null()]).optional(),
  billingMeteredPriceRefs: MeteredPriceRefsSchema.optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  public: z.boolean().optional(),
});

export const PlanPatchBody = z.strictObject({
  version: z
    .number()
    .int()
    .min(1)
    .openapi({ description: "The version read; 409 `version_conflict` if stale" }),
  name: z.string().trim().min(1).max(100).optional(),
  limits: PlanLimitsSchema.optional(),
  billingPriceRef: z.union([z.string().min(1).max(255), z.null()]).optional(),
  billingMeteredPriceRefs: MeteredPriceRefsSchema.optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  public: z.boolean().optional(),
});

// --- sanctions ----------------------------------------------------------------------------------

export const SanctionsMatchSchema = z
  .object({
    listEntryId: z.string(),
    name: z.string(),
    score: z.number().min(0).max(1),
    programs: z.array(z.string()),
    source: z.string(),
  })
  .openapi("SanctionsMatch");

export const SanctionsScreeningSchema = z
  .object({
    id: UuidSchema,
    workspaceId: UuidSchema,
    workspaceSlug: z.union([SlugSchema, z.null()]).openapi({
      description: "`null` once the workspace row is gone (screenings are kept 5 years)",
    }),
    subjectName: z.string(),
    subjectCountry: z.union([CountryCodeSchema, z.null()]),
    provider: z.enum(["ofac", "opensanctions"]),
    listVersion: z.string(),
    outcome: z.enum(["clear", "potential_match", "error"]),
    matchCount: z.number().int().nonnegative(),
    decision: z.union([z.enum(["cleared", "confirmed"]), z.null()]),
    decidedAt: z.union([TimestampSchema, z.null()]),
    createdAt: TimestampSchema,
  })
  .openapi("SanctionsScreening");

export const SanctionsScreeningListSchema = z
  .object({ items: z.array(SanctionsScreeningSchema) })
  .openapi("SanctionsScreeningList");

export const SanctionsScreeningDetailSchema = SanctionsScreeningSchema.extend({
  matches: z.array(SanctionsMatchSchema),
  decidedBy: z.union([UuidSchema, z.null()]),
  decisionNote: z.union([z.string(), z.null()]),
}).openapi("SanctionsScreeningDetail");

export const SanctionsListQuery = z.object({
  status: z
    .enum(["open", "all"])
    .default("open")
    .openapi({ description: "`open`: potential matches and errors nobody has decided" }),
});

export const SanctionsIdParam = z.object({ id: UuidSchema });

export const SanctionsDecisionBody = z.strictObject({
  decision: z.enum(["cleared", "confirmed"]),
  note: z.string().trim().min(1).max(2000),
});
