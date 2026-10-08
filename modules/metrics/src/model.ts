import { delegationAdmitsModule } from "@fundroom/domain";
import { z } from "@hono/zod-openapi";

/*
 * Pure model of a KPI (E2.4 §2): the vocabulary a definition is described in, and the
 * `audience` that decides who may see its numbers. No drizzle, no pg — `src/schema/metrics.ts`
 * types its columns *from* this file, so the enum a route validates and the enum the column
 * stores cannot drift.
 */

/** Stable machine key; mirrors the `definition_key_format` CHECK exactly. */
export const METRIC_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/u;

export const UNIT_KINDS = ["currency", "count", "percent", "ratio", "days", "months"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** How a metric folds across periods when a chart asks for a coarser one than it was entered at. */
export const AGGREGATIONS = ["sum", "last", "avg"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

/** Which way is good, so the delta badge can be green without the reader having to know. */
export const DIRECTIONS = ["up_good", "down_good", "neutral"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/**
 * Where a point came from. `quickbooks`, `xero` and `stripe` are the KPI integrations (E3.6,
 * migration 0005); the event catalogue's `metric.restated.sourceKind` lists the same labels.
 */
export const SOURCE_KINDS = [
  "manual",
  "csv",
  "sheets",
  "derived",
  "quickbooks",
  "xero",
  "stripe",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** The integrations a definition may be bound to (E3.6 §5); a subset of `SOURCE_KINDS`. */
export const KPI_PROVIDERS = ["quickbooks", "xero", "stripe"] as const;
export type KpiProvider = (typeof KPI_PROVIDERS)[number];

export const SYNC_STATUSES = ["idle", "syncing", "ok", "failed"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const IMPORT_STATUSES = ["pending", "running", "done", "failed"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * Per-metric gating (E2.4 D2). This is an **audience**, not a grant, and the difference is
 * deliberate: a metric is not something an investor requests access to, it is a number that is
 * either shown or not shown. Modelling it as a `core.access_grant` would put every metric row
 * into `effective_access`, `whoHasAccess`, `explain` and the access-management screens — noise
 * an admin reads past forever — and would bump `acl_version` on every audience edit, throwing
 * away every principal's access cache to publish a headcount.
 *
 * It is also a deviation from design/06 §7's `is_public_to_groups uuid[]`, and for a concrete
 * reason: a bare uuid array cannot distinguish "everyone" from "staff only" without overloading
 * the empty array, and the repo already has a tested discriminated union that can.
 *
 * `modules/updates` has the same shape minus `staff_only`, because an update's audience is
 * chosen at the moment it is sent. Ours needs the third arm for the same reason our default is
 * the closed one — see `DEFAULT_AUDIENCE`.
 */
export const AUDIENCE_SCHEMA_VERSION = 1;

export const MetricAudienceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("staff_only") }).strict(),
    z.object({ kind: z.literal("all") }).strict(),
    z.object({ kind: z.literal("groups"), groupIds: z.array(z.uuid()).min(1).max(50) }).strict(),
  ])
  .openapi("MetricAudience");
export type MetricAudience = z.output<typeof MetricAudienceSchema>;

/**
 * A number nobody has chosen to publish is not published.
 *
 * Updates defaults to `all`; we must not. A definition is created weeks before anybody decides
 * who should see it — typically while the founder is still deciding whether the number is one
 * they want to show — and an open default would publish it during that window.
 */
export const DEFAULT_AUDIENCE: MetricAudience = Object.freeze({ kind: "staff_only" });

export interface MetricReader {
  readonly kind: "staff" | "external";
  readonly groupIds: readonly string[];
  /** A delegate's scope (E3.2); metrics are `all`-scope content, so any other scope reads none. */
  readonly delegateScope?: string | null | undefined;
}

/**
 * Staff see every metric: the admin grid badges each one's audience, so hiding rows there
 * would hide the thing the screen exists to manage. RBAC (`metrics.read`) is what decides
 * whether a staff member reaches the screen at all.
 */
export function audienceAdmits(audience: MetricAudience, reader: MetricReader): boolean {
  if (reader.kind === "staff") return true;
  // F3: the TypeScript half of `core.current_delegation_admits('metrics')` (migration 0004).
  if (!delegationAdmitsModule(reader.delegateScope, "metrics")) return false;
  switch (audience.kind) {
    case "all":
      return true;
    case "groups":
      return audience.groupIds.some((g) => reader.groupIds.includes(g));
    case "staff_only":
      return false;
  }
}

/**
 * Never throws, never widens: anything unparseable becomes `DEFAULT_AUDIENCE`.
 *
 * The bias matters and it is the same one `metrics.audience_admits_current`'s `ELSE false`
 * takes in SQL. A row hand-edited in psql, or one written by a future release whose audience
 * shape this one does not know, closes. The alternative — falling back to `all`, or throwing
 * and letting a caller `catch` into a default — publishes a number because of a parse failure,
 * which is the one failure mode this module must not have.
 */
export function parseAudience(raw: unknown): MetricAudience {
  const r = MetricAudienceSchema.safeParse(raw);
  return r.success ? r.data : DEFAULT_AUDIENCE;
}
