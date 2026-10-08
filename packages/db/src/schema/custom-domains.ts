import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { citext, coreSchema, workspace } from "./core.js";

/*
 * Custom portal domains (EXECUTION_PLAN §9.2, design/07 §2.2, ADR-0039, E2.1).
 *
 * Typed view of `migrations/core/0007_custom_domains.sql`; the SQL is authoritative (ADR-0004) —
 * the claim index, the fence that admits the `host` actor and the `set_updated_at` trigger all
 * live there. The pure state machine and hostname rules live in `@fundroom/custom-domains`.
 *
 * Kernel, not a module table: the hostname -> workspace lookup runs in the tenant classifier
 * before tenant context or module enablement exists. This is the *portal* domain; the *sending*
 * (DKIM) domain is `updates.sending_domain` and is a separate state machine (E1.4).
 */

export const customDomainStatus = coreSchema.enum("custom_domain_status", [
  "pending",
  "dns_ok",
  "active",
  "failed",
]);

export const CUSTOM_DOMAIN_STATUSES = customDomainStatus.enumValues;
export type CustomDomainStatus = (typeof CUSTOM_DOMAIN_STATUSES)[number];

/** The statuses the Caddy `ask` endpoint answers 200 for, and the tenant classifier resolves. */
export const CUSTOM_DOMAIN_ISSUABLE_STATUSES = [
  "dns_ok",
  "active",
] as const satisfies readonly CustomDomainStatus[];

/**
 * One hostname a workspace wants its portal served on, plus the verification state that gates
 * it. Verification is exclusive in both directions: a hostname is verified for at most one
 * workspace (`custom_domain_claim_idx`) and a workspace has at most one verified hostname
 * (`custom_domain_one_per_workspace_idx`). `pending` rows are exempt from both, so a squatter
 * cannot park a claim on a rival's hostname and a founder can add a corrected hostname before
 * removing the typo.
 */
export const customDomain = coreSchema.table(
  "custom_domain",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    hostname: citext("hostname").notNull(),
    status: customDomainStatus("status").notNull().default("pending"),
    /** `base32(HMAC(secret, workspace || hostname))`: reproducible, carries no secret of its own. */
    token: text("token").notNull(),
    /** The last resolver answer, surfaced verbatim in the UI (§9.2). */
    lastAnswer: jsonb("last_answer"),
    lastAnswerSchemaVersion: integer("last_answer_schema_version").notNull().default(1),
    /** One operator-facing sentence naming what DNS actually said. */
    lastDetail: text("last_detail"),
    /** Consecutive re-verify failures; an `active` domain is demoted only after the grace count. */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    firstAttemptAt: timestamp("first_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    dnsOkAt: timestamp("dns_ok_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    /** Membership id of the admin who added it; null when the row predates the actor. */
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // One live row per workspace+hostname; workspace-leading, so it is also the admin list index.
    uniqueIndex("custom_domain_ws_host_idx")
      .on(t.workspaceId, t.hostname)
      .where(sql`${t.deletedAt} IS NULL`),
    // The claim *and* the `ask` lookup, deliberately one index (design/07 §2.2 step 4).
    uniqueIndex("custom_domain_claim_idx")
      .on(t.hostname)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} IN ('dns_ok', 'active')`),
    // One verified hostname per workspace: a second one is a second `__Host-` cookie jar, not an
    // alias. See the migration comment.
    uniqueIndex("custom_domain_one_per_workspace_idx")
      .on(t.workspaceId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} IN ('dns_ok', 'active')`),
    // `ResolvedWorkspace.primaryHost` reads this on every resolved workspace.
    index("custom_domain_active_idx")
      .on(t.workspaceId, t.activatedAt)
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} = 'active'`),
    // The verify / re-verify sweeps: least-recently-checked first, never-checked first of all.
    index("custom_domain_check_idx")
      .on(t.status, t.lastCheckedAt.asc().nullsFirst())
      .where(sql`${t.deletedAt} IS NULL`),
    // A backstop against a direct SQL write, not the product rule: `normalizeHostname()` in
    // `@fundroom/custom-domains` is the real validator.
    check(
      "custom_domain_hostname_format",
      sql`char_length(${t.hostname}) <= 253 AND ${t.hostname} ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    // Length only: the token's encoding belongs to `challengeToken()`, not to the schema.
    check("custom_domain_token_length", sql`char_length(${t.token}) BETWEEN 16 AND 128`),
    check(
      "custom_domain_detail_length",
      sql`${t.lastDetail} IS NULL OR char_length(${t.lastDetail}) <= 1000`,
    ),
    check("custom_domain_failures_nonnegative", sql`${t.consecutiveFailures} >= 0`),
  ],
);

export type CustomDomain = typeof customDomain.$inferSelect;
export type NewCustomDomain = typeof customDomain.$inferInsert;
