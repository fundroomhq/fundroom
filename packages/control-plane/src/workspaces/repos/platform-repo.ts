import { PLATFORM_WORKSPACE_ID, type Tx } from "@fundroom/db";
import { sql } from "drizzle-orm";

/*
 * The operator API's reads (E3.10): workspaces with their subscription summary, latest usage row
 * and custom-domain count; the latest sanctions screening; a workspace's owners; the platform
 * audit chain. Raw SQL (joins and laterals the query builder renders badly), so every timestamptz
 * comes back as text and is coerced here; `bigint` counters come back as strings.
 *
 * Contexts: the workspace list and the screening run in the HOST context (subscription, usage,
 * custom_domain and sanctions_screening fences all admit the host); the owners need the
 * workspace's `system` context (membership is fenced to it); the platform chain needs the platform
 * pseudo-workspace's.
 */

const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const asDateOrNull = (v: unknown): Date | null =>
  v === null || v === undefined ? null : asDate(v);

export interface UsageDayRow {
  readonly day: string;
  readonly storageBytes: number;
  readonly docsViewed: number;
  readonly emailsSent: number;
  readonly staffSeats: number;
  readonly investorSeats: number;
  readonly customDomains: number;
  readonly computedAt: Date;
}

export interface PlatformWorkspaceRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly country: string | null;
  readonly status: "active" | "pending_review" | "suspended";
  readonly suspendedReason: "operator" | "billing" | "sanctions" | "relocation" | null;
  /** The independent flags `status` / `suspendedReason` are derived from (sorted). */
  readonly holds: readonly (
    | "sanctions_review"
    | "operator"
    | "billing"
    | "sanctions"
    | "relocation"
  )[];
  readonly cellId: string;
  readonly planId: string | null;
  readonly subscription: {
    readonly status: string;
    readonly provider: "manual" | "stripe";
    readonly currentPeriodEnd: Date | null;
  } | null;
  readonly usage: UsageDayRow | null;
  readonly customDomains: number;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
  /** `created_at` at full precision, for the keyset cursor. */
  readonly cursorCreatedAt: string;
}

export interface WorkspaceListFilter {
  readonly q?: string | undefined;
  readonly status?: string | undefined;
  readonly plan?: string | undefined;
  readonly after?: { readonly createdAt: string; readonly id: string } | undefined;
  readonly id?: string | undefined;
}

/** `\`, `%` and `_` escaped for `ILIKE … ESCAPE '\'`. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/gu, (ch) => `\\${ch}`)}%`;
}

/** A page of workspaces, `ORDER BY created_at, id` (host context). */
export async function listPlatformWorkspaceRows(
  tx: Tx,
  filter: WorkspaceListFilter,
  limit: number,
): Promise<PlatformWorkspaceRow[]> {
  const where = [sql`true`];
  if (filter.id !== undefined) where.push(sql`w.id = ${filter.id}::uuid`);
  if (filter.status !== undefined) where.push(sql`w.status = ${filter.status}::text`);
  if (filter.plan !== undefined) where.push(sql`w.plan_id = ${filter.plan}::text`);
  if (filter.q !== undefined && filter.q !== "") {
    const p = likePattern(filter.q);
    where.push(
      sql`(w.slug::text ILIKE ${p} ESCAPE '\\' OR w.name ILIKE ${p} ESCAPE '\\' OR coalesce(w.legal_name, '') ILIKE ${p} ESCAPE '\\')`,
    );
  }
  if (filter.after !== undefined) {
    where.push(
      sql`(w.created_at, w.id) > (${filter.after.createdAt}::timestamptz, ${filter.after.id}::uuid)`,
    );
  }
  const r = await tx.execute(sql`
    SELECT w.id, w.slug::text AS slug, w.name, w.legal_name, w.country, w.status,
           w.suspended_reason, w.holds, w.cell_id, w.plan_id, w.created_at, w.deleted_at,
           w.created_at::text AS cursor_created_at,
           s.status AS sub_status, s.provider AS sub_provider,
           s.current_period_end AS sub_period_end,
           u.day::text AS u_day, u.storage_bytes AS u_storage, u.docs_viewed AS u_docs,
           u.emails_sent AS u_emails, u.staff_seats AS u_staff, u.investor_seats AS u_investors,
           u.custom_domains AS u_domains, u.computed_at AS u_computed,
           (SELECT count(*) FROM core.custom_domain d
             WHERE d.workspace_id = w.id AND d.deleted_at IS NULL AND d.status <> 'failed') AS domains
      FROM core.workspace w
      LEFT JOIN core.subscription s ON s.workspace_id = w.id
      LEFT JOIN LATERAL (
        SELECT * FROM core.tenant_usage_daily t
         WHERE t.workspace_id = w.id ORDER BY t.day DESC LIMIT 1
      ) u ON true
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY w.created_at, w.id
     LIMIT ${limit}::int`);
  return r.rows.map((row) => ({
    id: String(row["id"]),
    slug: String(row["slug"]),
    name: String(row["name"]),
    legalName: (row["legal_name"] as string | null) ?? null,
    country: (row["country"] as string | null) ?? null,
    status: row["status"] as PlatformWorkspaceRow["status"],
    suspendedReason: (row["suspended_reason"] as PlatformWorkspaceRow["suspendedReason"]) ?? null,
    holds: [...((row["holds"] as PlatformWorkspaceRow["holds"] | null) ?? [])].sort(),
    cellId: String(row["cell_id"]),
    planId: (row["plan_id"] as string | null) ?? null,
    subscription:
      row["sub_status"] === null || row["sub_status"] === undefined
        ? null
        : {
            status: String(row["sub_status"]),
            provider: row["sub_provider"] as "manual" | "stripe",
            currentPeriodEnd: asDateOrNull(row["sub_period_end"]),
          },
    usage:
      row["u_day"] === null || row["u_day"] === undefined
        ? null
        : {
            day: String(row["u_day"]),
            storageBytes: Number(row["u_storage"]),
            docsViewed: Number(row["u_docs"]),
            emailsSent: Number(row["u_emails"]),
            staffSeats: Number(row["u_staff"]),
            investorSeats: Number(row["u_investors"]),
            customDomains: Number(row["u_domains"]),
            computedAt: asDate(row["u_computed"]),
          },
    customDomains: Number(row["domains"]),
    createdAt: asDate(row["created_at"]),
    deletedAt: asDateOrNull(row["deleted_at"]),
    cursorCreatedAt: String(row["cursor_created_at"]),
  }));
}

export interface ScreeningSummaryRow {
  readonly id: string;
  readonly outcome: "clear" | "potential_match" | "error";
  readonly decision: "cleared" | "confirmed" | null;
  readonly createdAt: Date;
}

/**
 * The workspace's newest screening (host context). `lock`: row-locked `FOR UPDATE` — the
 * unsuspend path takes it before `setWorkspaceHold`, as the sanctions decision path does.
 */
export async function latestScreening(
  tx: Tx,
  workspaceId: string,
  lock = false,
): Promise<ScreeningSummaryRow | undefined> {
  const r = await tx.execute(sql`
    SELECT id, outcome, decision, created_at FROM core.sanctions_screening
     WHERE workspace_id = ${workspaceId}::uuid
     ORDER BY created_at DESC, id DESC
     LIMIT 1 ${lock ? sql`FOR UPDATE` : sql``}`);
  const row = r.rows[0];
  if (row === undefined) return undefined;
  return {
    id: String(row["id"]),
    outcome: row["outcome"] as ScreeningSummaryRow["outcome"],
    decision: (row["decision"] as ScreeningSummaryRow["decision"]) ?? null,
    createdAt: asDate(row["created_at"]),
  };
}

/**
 * The workspace's newest `confirmed` screening (host context): what set its `sanctions` hold, and
 * which operator confirmed it (the four-eyes rule on lifting it).
 */
export async function latestConfirmedScreening(
  tx: Tx,
  workspaceId: string,
): Promise<(ScreeningSummaryRow & { readonly decidedBy: string | null }) | undefined> {
  const r = await tx.execute(sql`
    SELECT id, outcome, decision, created_at, decided_by::text AS decided_by
      FROM core.sanctions_screening
     WHERE workspace_id = ${workspaceId}::uuid AND decision = 'confirmed'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`);
  const row = r.rows[0];
  if (row === undefined) return undefined;
  return {
    id: String(row["id"]),
    outcome: row["outcome"] as ScreeningSummaryRow["outcome"],
    decision: "confirmed",
    createdAt: asDate(row["created_at"]),
    decidedBy: (row["decided_by"] as string | null) ?? null,
  };
}

/** Owners' primary email addresses (the workspace's `system` context). */
export async function ownerEmails(tx: Tx): Promise<string[]> {
  const r = await tx.execute(sql`
    SELECT e.identifier AS email
      FROM core.membership m
      JOIN core."user" u ON u.id = m.user_id
      JOIN LATERAL (
        SELECT ui.identifier::text AS identifier FROM core.user_identity ui
         WHERE ui.user_id = u.id AND ui.type = 'email'
         ORDER BY ui.is_primary DESC, ui.created_at
         LIMIT 1
      ) e ON true
     WHERE m.workspace_id = core.current_workspace()
       AND m.kind = 'staff' AND m.role = 'owner' AND m.status IN ('active', 'dormant')
       AND u.deleted_at IS NULL
     ORDER BY m.created_at, m.id`);
  return r.rows.map((row) => String(row["email"]));
}

export interface PlatformAuditRow {
  readonly id: string;
  readonly seq: number;
  readonly occurredAt: Date;
  readonly actorKind: "staff" | "external" | "system" | "host";
  readonly actorUserId: string | null;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string | null;
  readonly outcome: "success" | "denied" | "failure";
  readonly meta: Record<string, unknown>;
}

/** The platform chain, newest first (the platform pseudo-workspace's context). */
export async function platformAuditRows(
  tx: Tx,
  page: { readonly beforeSeq?: number | undefined; readonly limit: number },
): Promise<PlatformAuditRow[]> {
  const r = await tx.execute(sql`
    SELECT id, seq, occurred_at, actor_kind, actor_user_id, action, resource_kind,
           resource_id, outcome, meta
      FROM audit.event
     WHERE workspace_id = ${PLATFORM_WORKSPACE_ID}::uuid
       ${page.beforeSeq === undefined ? sql`` : sql`AND seq < ${page.beforeSeq}::bigint`}
     ORDER BY seq DESC
     LIMIT ${page.limit}::int`);
  return r.rows.map((row) => ({
    id: String(row["id"]),
    seq: Number(row["seq"]),
    occurredAt: asDate(row["occurred_at"]),
    actorKind: row["actor_kind"] as PlatformAuditRow["actorKind"],
    actorUserId: (row["actor_user_id"] as string | null) ?? null,
    action: String(row["action"]),
    resourceKind: String(row["resource_kind"]),
    resourceId: (row["resource_id"] as string | null) ?? null,
    outcome: row["outcome"] as PlatformAuditRow["outcome"],
    meta: (row["meta"] as Record<string, unknown> | null) ?? {},
  }));
}
