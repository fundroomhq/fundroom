import {
  type AuditChainHead,
  type AuditCheckpointRow,
  type AuditEventRow,
  core,
  lockWorkspaceRow,
  type NewAuditCheckpointRow,
  type NewAuditEventRow,
  type Tx,
} from "@fundroom/db";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";

/*
 * The only file that touches audit.* through drizzle. Inserts go through the parent table
 * (partition routing + the chain trigger); `seq`, `prev_hash` and `hash` are never
 * supplied. Reads use the context's fence; `workspace_id` is always in the WHERE so the
 * planner uses the (workspace_id, …) indexes.
 */
export async function insertAuditEvent(
  tx: Tx,
  values: Omit<NewAuditEventRow, "seq" | "prevHash" | "hash">,
): Promise<AuditEventRow> {
  const rows = await tx.insert(core.auditEvent).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error("audit insert returned no row");
  return row;
}

/**
 * Takes, in this order and for the rest of the transaction, (1) the workspace row
 * `FOR NO KEY UPDATE` (`lockWorkspaceRow`) and (2) the workspace's audit-chain lock — the very
 * advisory lock `audit.chain()` takes on every insert (`0002_audit_events.sql`:
 * `pg_advisory_xact_lock(24301, hashtext(workspace_id::text))`).
 *
 * THE global lock order (E3.5 LX): **workspace row → audit chain**. `createAuditService().record`
 * calls this before every insert, so no transaction can hold the chain without the row, and the
 * old "audit, then `bumpAclVersionInTx` / settings UPDATE" paths are row → chain like the
 * settings writers. Other locks (entity rows, per-feature advisory locks, search entries) come
 * before the row or after the chain, never between a row holder and a lock it would wait for.
 * A caller that must serialise with auditors before it audits (DSAR `lockById`) calls this
 * early. Re-entrant: re-granted as a no-op when the transaction already holds either lock (the
 * row in this mode or stronger). No row for the platform pseudo-workspace: only the chain.
 */
export async function lockAuditChain(tx: Tx, workspaceId: string): Promise<void> {
  await lockWorkspaceRow(tx, workspaceId);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(24301, hashtext(${workspaceId}::uuid::text))`);
}

/** `fromMonth` as YYYY-MM-DD (first of month, UTC); default = the current month. */
export async function ensureAuditPartitions(
  tx: Tx,
  monthsAhead: number,
  fromMonth?: string,
): Promise<number> {
  const r = await tx.execute(
    sql`SELECT audit.ensure_partitions(${monthsAhead}::int, ${fromMonth ?? null}::date) AS n`,
  );
  return Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
}

export async function listExpiredPartitions(
  tx: Tx,
  retentionMonths: number,
): Promise<{ name: string; upperBound: Date }[]> {
  const r = await tx.execute(
    sql`SELECT partition_name, upper_bound FROM audit.expired_partitions(${retentionMonths}::int)`,
  );
  return (r.rows as { partition_name: string; upper_bound: Date | string }[]).map((row) => ({
    name: row.partition_name,
    upperBound: new Date(row.upper_bound),
  }));
}

export async function dropPartition(tx: Tx, name: string): Promise<boolean> {
  const r = await tx.execute(sql`SELECT audit.drop_partition(${name}) AS ok`);
  return Boolean((r.rows[0] as { ok: boolean } | undefined)?.ok);
}

export async function findChainHead(
  tx: Tx,
  workspaceId: string,
): Promise<AuditChainHead | undefined> {
  const rows = await tx
    .select()
    .from(core.auditChainHead)
    .where(eq(core.auditChainHead.workspaceId, workspaceId))
    .limit(1);
  return rows[0];
}

export async function findLatestCheckpoint(
  tx: Tx,
  workspaceId: string,
): Promise<AuditCheckpointRow | undefined> {
  const rows = await tx
    .select()
    .from(core.auditCheckpoint)
    .where(eq(core.auditCheckpoint.workspaceId, workspaceId))
    .orderBy(desc(core.auditCheckpoint.seq), desc(core.auditCheckpoint.createdAt))
    .limit(1);
  return rows[0];
}

export async function insertCheckpoint(
  tx: Tx,
  values: NewAuditCheckpointRow,
): Promise<AuditCheckpointRow> {
  const rows = await tx.insert(core.auditCheckpoint).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error("checkpoint insert returned no row");
  return row;
}

export async function listCheckpoints(
  tx: Tx,
  workspaceId: string,
  limit = 100,
): Promise<AuditCheckpointRow[]> {
  return tx
    .select()
    .from(core.auditCheckpoint)
    .where(eq(core.auditCheckpoint.workspaceId, workspaceId))
    .orderBy(core.auditCheckpoint.seq)
    .limit(limit);
}

export async function findEventById(
  tx: Tx,
  workspaceId: string,
  id: string,
): Promise<AuditEventRow | undefined> {
  const rows = await tx
    .select()
    .from(core.auditEvent)
    .where(and(eq(core.auditEvent.workspaceId, workspaceId), eq(core.auditEvent.id, id)))
    .limit(1);
  return rows[0];
}

export async function listEventsBySeq(
  tx: Tx,
  workspaceId: string,
  fromSeq: number,
  toSeq: number,
): Promise<AuditEventRow[]> {
  return tx
    .select()
    .from(core.auditEvent)
    .where(
      and(
        eq(core.auditEvent.workspaceId, workspaceId),
        gte(core.auditEvent.seq, fromSeq),
        lte(core.auditEvent.seq, toSeq),
      ),
    )
    .orderBy(core.auditEvent.seq);
}

export interface ExportedRow {
  readonly seq: number;
  readonly canonical: string;
  readonly hash: Buffer;
}

/** Rows with their canonical text (what was hashed), for exports and offline verification. */
export async function exportRows(
  tx: Tx,
  workspaceId: string,
  fromSeq = 1,
  toSeq?: number,
): Promise<ExportedRow[]> {
  const r = await tx.execute(
    sql`SELECT seq, canonical, hash FROM audit.export_rows(${workspaceId}::uuid, ${fromSeq}::bigint, ${toSeq ?? null}::bigint)`,
  );
  return (r.rows as { seq: string | number; canonical: string; hash: Buffer }[]).map((row) => ({
    seq: Number(row.seq),
    canonical: row.canonical,
    hash: row.hash,
  }));
}

export interface ChainProblem {
  readonly checked: number;
  readonly badSeq: number;
  readonly problem: string;
}

/** Runs audit.verify_chain(); `undefined` = the range verified clean. */
export async function verifyChainInDb(
  tx: Tx,
  workspaceId: string,
  fromSeq = 1,
  toSeq?: number,
): Promise<ChainProblem | undefined> {
  const r = await tx.execute(
    sql`SELECT checked, bad_seq, problem FROM audit.verify_chain(${workspaceId}::uuid, ${fromSeq}::bigint, ${toSeq ?? null}::bigint)`,
  );
  const row = r.rows[0] as
    | { checked: string | number; bad_seq: string | number; problem: string }
    | undefined;
  if (!row) return undefined;
  return { checked: Number(row.checked), badSeq: Number(row.bad_seq), problem: row.problem };
}

// --- E2.7: the admin audit log and the signed export ------------------------------------------

export interface AuditEventFilter {
  /** Exact action, or a prefix when it ends in `.` (`access.` = every access event). */
  readonly action?: string | undefined;
  readonly actorMembershipId?: string | undefined;
  readonly subjectMembershipId?: string | undefined;
  readonly resourceKind?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly outcome?: "success" | "denied" | "failure" | undefined;
  /** Inclusive bounds on `occurred_at`. */
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export interface AuditEventListRow {
  readonly id: string;
  readonly seq: number;
  readonly occurredAt: Date;
  readonly actorKind: string;
  readonly actorMembershipId: string | null;
  readonly actorName: string | null;
  readonly onBehalfOfMembershipId: string | null;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string | null;
  readonly subjectMembershipId: string | null;
  readonly subjectName: string | null;
  readonly outcome: "success" | "denied" | "failure";
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly meta: Record<string, unknown>;
  readonly diff: unknown;
}

/**
 * A member's display name as the log shows it: the user's display name, else the membership
 * profile's `displayName`, else null. Erasure empties both (`core.erase_user_identity` sets the
 * user's name to '' and the membership profile to {}), so an erased person reads as null here
 * even though their membership id stays on every row they touched.
 */
function nameOf(m: string, u: string) {
  return sql.raw(
    `NULLIF(COALESCE(NULLIF(${u}.display_name, ''), ${m}.profile->>'displayName', ''), '')`,
  );
}

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

/**
 * One page of the log, newest first (`seq` DESC). `beforeSeq` is the keyset: `seq` alone is a
 * total order within a workspace, so the cursor needs nothing else. Names are joined per row
 * from this workspace's memberships only (`m.workspace_id = e.workspace_id`): a membership id is
 * never resolved against another tenant's row, even if one were planted on an event.
 *
 * Raw SQL rather than the query builder because the two aliased membership/user joins would
 * otherwise render bare column names in the select list (the E2.1 drizzle trap); the raw path
 * returns timestamptz as text, so `occurred_at` is coerced.
 */
export async function listAuditEventsPage(
  tx: Tx,
  workspaceId: string,
  filter: AuditEventFilter,
  page: { readonly beforeSeq?: number | undefined; readonly limit: number },
): Promise<AuditEventListRow[]> {
  const where = [sql`e.workspace_id = ${workspaceId}::uuid`];
  if (page.beforeSeq !== undefined) where.push(sql`e.seq < ${page.beforeSeq}::bigint`);
  if (filter.action !== undefined) {
    // `starts_with`, not LIKE: `_` is a LIKE wildcard and every action is snake_case.
    where.push(
      filter.action.endsWith(".")
        ? sql`starts_with(e.action, ${filter.action}::text)`
        : sql`e.action = ${filter.action}::text`,
    );
  }
  if (filter.actorMembershipId !== undefined)
    where.push(sql`e.actor_membership_id = ${filter.actorMembershipId}::uuid`);
  if (filter.subjectMembershipId !== undefined)
    where.push(sql`e.subject_membership_id = ${filter.subjectMembershipId}::uuid`);
  if (filter.resourceKind !== undefined)
    where.push(sql`e.resource_kind = ${filter.resourceKind}::text`);
  if (filter.resourceId !== undefined) where.push(sql`e.resource_id = ${filter.resourceId}::uuid`);
  if (filter.outcome !== undefined) where.push(sql`e.outcome = ${filter.outcome}::audit.outcome`);
  if (filter.from !== undefined)
    where.push(sql`e.occurred_at >= ${filter.from.toISOString()}::timestamptz`);
  if (filter.to !== undefined)
    where.push(sql`e.occurred_at <= ${filter.to.toISOString()}::timestamptz`);
  const r = await tx.execute(sql`
    SELECT e.id, e.seq, e.occurred_at, e.actor_kind, e.actor_membership_id,
           ${nameOf("am", "au")} AS actor_name,
           e.on_behalf_of_membership_id, e.action, e.resource_kind, e.resource_id,
           e.subject_membership_id,
           ${nameOf("sm", "su")} AS subject_name,
           e.outcome, e.ip::text AS ip, e.user_agent, e.request_id, e.meta, e.diff
      FROM audit.event e
      LEFT JOIN core.membership am
        ON am.id = e.actor_membership_id AND am.workspace_id = e.workspace_id
      LEFT JOIN core."user" au ON au.id = am.user_id
      LEFT JOIN core.membership sm
        ON sm.id = e.subject_membership_id AND sm.workspace_id = e.workspace_id
      LEFT JOIN core."user" su ON su.id = sm.user_id
     WHERE ${sql.join(where, sql` AND `)}
     ORDER BY e.seq DESC
     LIMIT ${page.limit}::int`);
  type Raw = {
    id: string;
    seq: string | number;
    occurred_at: Date | string;
    actor_kind: string;
    actor_membership_id: string | null;
    actor_name: string | null;
    on_behalf_of_membership_id: string | null;
    action: string;
    resource_kind: string;
    resource_id: string | null;
    subject_membership_id: string | null;
    subject_name: string | null;
    outcome: AuditEventListRow["outcome"];
    ip: string | null;
    user_agent: string | null;
    request_id: string | null;
    meta: Record<string, unknown> | null;
    diff: unknown;
  };
  return (r.rows as Raw[]).map((row) => ({
    id: row.id,
    seq: Number(row.seq),
    occurredAt: asDate(row.occurred_at),
    actorKind: row.actor_kind,
    actorMembershipId: row.actor_membership_id,
    actorName: row.actor_name,
    onBehalfOfMembershipId: row.on_behalf_of_membership_id,
    action: row.action,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    subjectMembershipId: row.subject_membership_id,
    subjectName: row.subject_name,
    outcome: row.outcome,
    ip: row.ip,
    userAgent: row.user_agent,
    requestId: row.request_id,
    meta: row.meta ?? {},
    diff: row.diff ?? null,
  }));
}

/**
 * A time range as the contiguous seq range that covers it: the first seq that occurred at or
 * after `from`, through the last seq that occurred at or before `to`. A hash chain only verifies
 * over contiguous seqs, so the range is *covering*, not exact — a row whose `occurred_at` was
 * supplied out of order and falls outside the window, but sits between those seqs, is included.
 * `null` when nothing in the workspace falls inside the window.
 */
export async function seqRangeForTime(
  tx: Tx,
  workspaceId: string,
  from: Date | undefined,
  to: Date | undefined,
): Promise<{ fromSeq: number; toSeq: number } | null> {
  const r = await tx.execute(sql`
    SELECT
      (SELECT min(seq) FROM audit.event
        WHERE workspace_id = ${workspaceId}::uuid
          AND (${from?.toISOString() ?? null}::timestamptz IS NULL
               OR occurred_at >= ${from?.toISOString() ?? null}::timestamptz)) AS from_seq,
      (SELECT max(seq) FROM audit.event
        WHERE workspace_id = ${workspaceId}::uuid
          AND (${to?.toISOString() ?? null}::timestamptz IS NULL
               OR occurred_at <= ${to?.toISOString() ?? null}::timestamptz)) AS to_seq`);
  const row = r.rows[0] as
    | { from_seq: string | number | null; to_seq: string | number | null }
    | undefined;
  if (!row || row.from_seq === null || row.to_seq === null) return null;
  const fromSeq = Number(row.from_seq);
  const toSeq = Number(row.to_seq);
  return fromSeq <= toSeq ? { fromSeq, toSeq } : null;
}

export async function listCheckpointsInRange(
  tx: Tx,
  workspaceId: string,
  fromSeq: number,
  toSeq: number,
): Promise<AuditCheckpointRow[]> {
  return tx
    .select()
    .from(core.auditCheckpoint)
    .where(
      and(
        eq(core.auditCheckpoint.workspaceId, workspaceId),
        gte(core.auditCheckpoint.seq, fromSeq),
        lte(core.auditCheckpoint.seq, toSeq),
      ),
    )
    .orderBy(core.auditCheckpoint.seq);
}
