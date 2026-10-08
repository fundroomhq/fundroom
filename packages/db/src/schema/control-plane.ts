import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";
import { user } from "./identity.js";

/*
 * The managed-host control plane (EXECUTION_PLAN §15 E3.10, ADR-0058).
 *
 * Typed view of `migrations/core/0023_control_plane.sql`; the SQL is authoritative (ADR-0004) —
 * the fences (host-only on platform_operator, billing_event and sanctions_screening; staff SELECT
 * on subscription and tenant_usage_daily; anybody-reads on cell and plan), the workspace
 * control-plane guard trigger and the `set_updated_at` triggers live there. The workspace columns
 * (`cell_id`, `status`, `suspended_reason`, `suspended_at`, `legal_name`, `country`, `plan_id`)
 * are in `./core.ts`, `session.bound_workspace_id` in `./identity.ts`.
 */

export const CELL_STATUSES = ["active", "draining", "closed"] as const;
/** E3.11 (0024): `core.cell.jurisdiction`; mirrors `JURISDICTIONS` in `@fundroom/ports`. */
export const CELL_JURISDICTIONS = ["eu", "uk", "ch", "us", "ca", "au", "other"] as const;
export type CellJurisdiction = (typeof CELL_JURISDICTIONS)[number];
/** E3.11: the region a fresh install seeds; ignored by the single-region rule, replaced at boot. */
export const PLACEHOLDER_REGION = "default";
export type CellStatus = (typeof CELL_STATUSES)[number];
export const SUBSCRIPTION_PROVIDERS = ["manual", "stripe"] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "paused",
] as const;
export type SubscriptionStatusValue = (typeof SUBSCRIPTION_STATUSES)[number];
export const SANCTIONS_PROVIDERS = ["ofac", "opensanctions"] as const;
export type SanctionsProvider = (typeof SANCTIONS_PROVIDERS)[number];
export const SANCTIONS_OUTCOMES = ["clear", "potential_match", "error"] as const;
export type SanctionsOutcome = (typeof SANCTIONS_OUTCOMES)[number];
export const SANCTIONS_DECISIONS = ["cleared", "confirmed"] as const;
export type SanctionsDecision = (typeof SANCTIONS_DECISIONS)[number];

/**
 * `plan.limits`. An absent key is unlimited. Schema version 2 (A-3, ADR-0063) adds the two
 * entitlement lists — absent = all, `[]` = none; version 1 rows simply have no lists, so readers
 * accept both and writers always write 2.
 */
export interface PlanLimitsRow {
  readonly staffSeats?: number | undefined;
  readonly investorSeats?: number | undefined;
  readonly storageBytes?: number | undefined;
  readonly customDomains?: number | undefined;
  readonly emailsPerMonth?: number | undefined;
  /** Optional module ids a workspace on the plan may have on (sorted, unique). */
  readonly modules?: readonly string[] | undefined;
  /** Feature ids (`PLAN_FEATURES` in `@fundroom/domain`) it may turn on (sorted, unique). */
  readonly features?: readonly string[] | undefined;
}

/** One `sanctions_screening.matches` element (schema version 1); `SanctionsMatch` in the ports. */
export interface SanctionsMatchRow {
  readonly listEntryId: string;
  readonly name: string;
  readonly score: number;
  readonly programs: readonly string[];
  readonly source: string;
}

/**
 * Where a workspace is served. `public_origin` '' = this install. E3.11 (0024): one database =
 * one region (trigger `cell_single_region`; a declared region is immutable, only the placeholder
 * `default` may be replaced).
 */
export const cell = coreSchema.table(
  "cell",
  {
    id: text("id").primaryKey(),
    region: text("region").notNull(),
    publicOrigin: text("public_origin").notNull().default(""),
    status: text("status").$type<CellStatus>().notNull().default("active"),
    /** E3.11 (0024): human text for the region ('' = none declared). */
    regionLabel: text("region_label").notNull().default(""),
    /** E3.11 (0024): null = not declared. */
    jurisdiction: text("jurisdiction").$type<CellJurisdiction>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("cell_id_format", sql`${t.id} ~ '^[a-z0-9][a-z0-9-]{0,30}$'`),
    check("cell_region_length", sql`char_length(${t.region}) BETWEEN 1 AND 64`),
    check(
      "cell_public_origin_shape",
      sql`${t.publicOrigin} = '' OR ${t.publicOrigin} ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'`,
    ),
    check("cell_status", sql`${t.status} IN ('active', 'draining', 'closed')`),
    check("cell_region_label_length", sql`char_length(${t.regionLabel}) <= 120`),
    check(
      "cell_jurisdiction",
      sql`${t.jurisdiction} IS NULL OR ${t.jurisdiction} IN ('eu', 'uk', 'ch', 'us', 'ca', 'au', 'other')`,
    ),
  ],
);

/** What a workspace may use and what it costs. */
export const plan = coreSchema.table(
  "plan",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    limits: jsonb("limits").$type<PlanLimitsRow>().notNull().default({}),
    limitsSchemaVersion: integer("limits_schema_version").notNull().default(1),
    /** The billing provider's price (a Stripe `price_…` id). */
    billingPriceRef: text("billing_price_ref"),
    /**
     * E3.10 (fix round 2): the provider's metered prices (quantity-less checkout line items;
     * usage is reported only for meters whose price is on the subscription). At most 10.
     */
    billingMeteredPriceRefs: text("billing_metered_price_refs")
      .array()
      .notNull()
      .default(sql`'{}'`),
    trialDays: integer("trial_days").notNull().default(0),
    /** Offered at self-service signup and on the tenant's billing page. */
    public: boolean("public").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    check("plan_id_format", sql`${t.id} ~ '^[a-z0-9][a-z0-9_-]{0,40}$'`),
    check("plan_name_length", sql`char_length(${t.name}) BETWEEN 1 AND 100`),
    check("plan_limits_object", sql`jsonb_typeof(${t.limits}) = 'object'`),
    check(
      "plan_price_ref_length",
      sql`${t.billingPriceRef} IS NULL OR char_length(${t.billingPriceRef}) BETWEEN 1 AND 255`,
    ),
    check("plan_metered_price_refs", sql`core.plan_price_refs_valid(${t.billingMeteredPriceRefs})`),
    check("plan_trial_days_range", sql`${t.trialDays} BETWEEN 0 AND 90`),
    check("plan_version_positive", sql`${t.version} >= 1`),
  ],
);

/** Who may open an operator session (granted/revoked only by the CLI). */
export const platformOperator = coreSchema.table(
  "platform_operator",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** `cli:<os user>` or the granting operator's user id. */
    createdBy: text("created_by").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    check(
      "platform_operator_created_by_length",
      sql`char_length(${t.createdBy}) BETWEEN 1 AND 200`,
    ),
  ],
);

/** One per workspace: the billing provider's view, re-read on every webhook. */
export const subscription = coreSchema.table(
  "subscription",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspace.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id),
    provider: text("provider").$type<SubscriptionProvider>().notNull(),
    status: text("status").$type<SubscriptionStatusValue>().notNull(),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    trialEnd: timestamp("trial_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /** Set when the status enters past_due / unpaid; the enforcement job suspends after it. */
    graceUntil: timestamp("grace_until", { withTimezone: true }),
    /** The provider event creation time of the last fact applied; older facts are ignored. */
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subscription_provider_subscription_idx")
      .on(t.providerSubscriptionId)
      .where(sql`${t.providerSubscriptionId} IS NOT NULL`),
    index("subscription_provider_customer_idx")
      .on(t.providerCustomerId)
      .where(sql`${t.providerCustomerId} IS NOT NULL`),
    index("subscription_plan_idx").on(t.planId),
    index("subscription_grace_idx").on(t.graceUntil).where(sql`${t.graceUntil} IS NOT NULL`),
    check("subscription_provider", sql`${t.provider} IN ('manual', 'stripe')`),
    check(
      "subscription_status",
      sql`${t.status} IN ('trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'paused')`,
    ),
    check(
      "subscription_customer_length",
      sql`${t.providerCustomerId} IS NULL OR char_length(${t.providerCustomerId}) BETWEEN 1 AND 255`,
    ),
    check(
      "subscription_subscription_length",
      sql`${t.providerSubscriptionId} IS NULL OR char_length(${t.providerSubscriptionId}) BETWEEN 1 AND 255`,
    ),
    check("subscription_version_positive", sql`${t.version} >= 1`),
  ],
);

/** Provider event ids already processed (dedupe; 90 days). */
export const billingEvent = coreSchema.table(
  "billing_event",
  {
    id: text("id").primaryKey(),
    provider: text("provider").$type<SubscriptionProvider>().notNull(),
    type: text("type").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** No FK: kept for its 90 days whatever happens to the workspace. */
    workspaceId: uuid("workspace_id"),
  },
  (t) => [
    index("billing_event_received_idx").on(t.receivedAt),
    check("billing_event_id_length", sql`char_length(${t.id}) BETWEEN 1 AND 255`),
    check("billing_event_provider", sql`${t.provider} IN ('manual', 'stripe')`),
    check("billing_event_type_length", sql`char_length(${t.type}) BETWEEN 1 AND 128`),
  ],
);

/** The usage rollup's per-day meter (400 days). */
export const tenantUsageDaily = coreSchema.table(
  "tenant_usage_daily",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** UTC day, `YYYY-MM-DD`. */
    day: date("day", { mode: "string" }).notNull(),
    storageBytes: bigint("storage_bytes", { mode: "number" }).notNull().default(0),
    docsViewed: integer("docs_viewed").notNull().default(0),
    emailsSent: integer("emails_sent").notNull().default(0),
    staffSeats: integer("staff_seats").notNull().default(0),
    investorSeats: integer("investor_seats").notNull().default(0),
    customDomains: integer("custom_domains").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.day] }),
    index("tenant_usage_daily_day_idx").on(t.day),
    check(
      "tenant_usage_daily_non_negative",
      sql`${t.storageBytes} >= 0 AND ${t.docsViewed} >= 0 AND ${t.emailsSent} >= 0 AND ${t.staffSeats} >= 0 AND ${t.investorSeats} >= 0 AND ${t.customDomains} >= 0`,
    ),
  ],
);

/** One row per screen of a tenant company. Host only; no FK (kept 5 years). */
export const sanctionsScreening = coreSchema.table(
  "sanctions_screening",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id").notNull(),
    subjectName: text("subject_name").notNull(),
    subjectCountry: text("subject_country"),
    provider: text("provider").$type<SanctionsProvider>().notNull(),
    /** The list snapshot + matcher version (`ofac:<sha256-12>:jw1`). */
    listVersion: text("list_version").notNull(),
    outcome: text("outcome").$type<SanctionsOutcome>().notNull(),
    matches: jsonb("matches").$type<readonly SanctionsMatchRow[]>().notNull().default([]),
    matchesSchemaVersion: integer("matches_schema_version").notNull().default(1),
    decision: text("decision").$type<SanctionsDecision>(),
    /** The deciding operator's user id. */
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sanctions_screening_workspace_idx").on(t.workspaceId, t.createdAt.desc()),
    index("sanctions_screening_open_idx")
      .on(t.createdAt)
      .where(sql`${t.outcome} <> 'clear' AND ${t.decision} IS NULL`),
    check(
      "sanctions_screening_subject_length",
      sql`char_length(${t.subjectName}) BETWEEN 1 AND 300`,
    ),
    check(
      "sanctions_screening_country_format",
      sql`${t.subjectCountry} IS NULL OR ${t.subjectCountry} ~ '^[A-Z]{2}$'`,
    ),
    check("sanctions_screening_provider", sql`${t.provider} IN ('ofac', 'opensanctions')`),
    check(
      "sanctions_screening_list_version_length",
      sql`char_length(${t.listVersion}) BETWEEN 1 AND 200`,
    ),
    check(
      "sanctions_screening_outcome",
      sql`${t.outcome} IN ('clear', 'potential_match', 'error')`,
    ),
    check("sanctions_screening_matches_array", sql`jsonb_typeof(${t.matches}) = 'array'`),
    check(
      "sanctions_screening_decision",
      sql`${t.decision} IS NULL OR ${t.decision} IN ('cleared', 'confirmed')`,
    ),
    check(
      "sanctions_screening_decision_shape",
      sql`(${t.decision} IS NULL) = (${t.decidedAt} IS NULL) AND (${t.decision} IS NULL) = (${t.decidedBy} IS NULL) AND (${t.decision} IS NULL) = (${t.decisionNote} IS NULL) AND (${t.decision} IS NULL OR ${t.outcome} <> 'clear')`,
    ),
    check(
      "sanctions_screening_note_length",
      sql`${t.decisionNote} IS NULL OR char_length(${t.decisionNote}) BETWEEN 1 AND 2000`,
    ),
  ],
);

export type CellRow = typeof cell.$inferSelect;
export type NewCellRow = typeof cell.$inferInsert;
export type PlanRow = typeof plan.$inferSelect;
export type NewPlanRow = typeof plan.$inferInsert;
export type PlatformOperatorRow = typeof platformOperator.$inferSelect;
export type NewPlatformOperatorRow = typeof platformOperator.$inferInsert;
export type SubscriptionRow = typeof subscription.$inferSelect;
export type NewSubscriptionRow = typeof subscription.$inferInsert;
export type BillingEventRow = typeof billingEvent.$inferSelect;
export type NewBillingEventRow = typeof billingEvent.$inferInsert;
export type TenantUsageDailyRow = typeof tenantUsageDaily.$inferSelect;
export type NewTenantUsageDailyRow = typeof tenantUsageDaily.$inferInsert;
export type SanctionsScreeningRow = typeof sanctionsScreening.$inferSelect;
export type NewSanctionsScreeningRow = typeof sanctionsScreening.$inferInsert;
