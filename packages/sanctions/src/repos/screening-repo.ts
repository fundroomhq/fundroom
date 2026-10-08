import {
  core,
  PLATFORM_WORKSPACE_ID,
  type SanctionsDecision,
  type SanctionsMatchRow,
  type SanctionsOutcome,
  type SanctionsProvider,
  type SanctionsScreeningRow,
  type Tx,
} from "@fundroom/db";
import { and, desc, eq, sql } from "drizzle-orm";

const { sanctionsScreening: screening, workspace } = core;

/*
 * The SQL behind the sanctions service (E3.10). `core.sanctions_screening` is host-only (RLS: no
 * tenant or system actor sees a row), so every function here runs in a `withHost` transaction;
 * `core.workspace` is readable there too.
 *
 * "Open" — what the operator queue lists and what a decision may be made on — is one predicate,
 * `OPEN_SQL`: a potential match or an error nobody has decided, not superseded by a later screen
 * of the same workspace. An error is superseded by any later screen (the retry that worked); a
 * potential match only by a later real result (clear or another match), never by a later error —
 * a provider outage must not hide a hit from the operator.
 */

function openSql(alias: string) {
  return sql.raw(`${alias}.outcome <> 'clear' AND ${alias}.decision IS NULL AND NOT EXISTS (
      SELECT 1 FROM core.sanctions_screening later
       WHERE later.workspace_id = ${alias}.workspace_id
         AND (later.created_at, later.id) > (${alias}.created_at, ${alias}.id)
         AND (later.outcome <> 'error' OR ${alias}.outcome = 'error'))`);
}

export interface WorkspaceSubjectRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly country: string | null;
  readonly status: string;
  readonly deletedAt: Date | null;
}

export async function readWorkspaceSubject(
  tx: Tx,
  workspaceId: string,
): Promise<WorkspaceSubjectRow | undefined> {
  const rows = await tx
    .select({
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      legalName: workspace.legalName,
      country: workspace.country,
      status: workspace.status,
      deletedAt: workspace.deletedAt,
    })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return rows[0];
}

export interface NewScreening {
  readonly workspaceId: string;
  readonly subjectName: string;
  readonly subjectCountry: string | null;
  readonly provider: SanctionsProvider;
  readonly listVersion: string;
  readonly outcome: SanctionsOutcome;
  readonly matches: readonly SanctionsMatchRow[];
  readonly createdAt: Date;
}

export async function insertScreening(tx: Tx, row: NewScreening): Promise<SanctionsScreeningRow> {
  const [inserted] = await tx
    .insert(screening)
    .values({
      workspaceId: row.workspaceId,
      subjectName: row.subjectName,
      subjectCountry: row.subjectCountry,
      provider: row.provider,
      listVersion: row.listVersion,
      outcome: row.outcome,
      matches: row.matches,
      createdAt: row.createdAt,
    })
    .returning();
  if (inserted === undefined) throw new Error("sanctions_screening insert returned nothing");
  return inserted;
}

/** The workspace's most recent screening, if any. */
export async function latestScreening(
  tx: Tx,
  workspaceId: string,
): Promise<SanctionsScreeningRow | undefined> {
  const rows = await tx
    .select()
    .from(screening)
    .where(eq(screening.workspaceId, workspaceId))
    .orderBy(desc(screening.createdAt), desc(screening.id))
    .limit(1);
  return rows[0];
}

export interface ScreeningListRow extends SanctionsScreeningRow {
  /** `null` once the workspace row is gone. */
  readonly workspaceSlug: string | null;
}

/** The queue (`open`) or the most recent screenings (`all`), newest first. */
export async function listScreenings(
  tx: Tx,
  input: { readonly open: boolean; readonly limit: number },
): Promise<ScreeningListRow[]> {
  const rows = await tx
    .select({ row: screening, workspaceSlug: workspace.slug })
    .from(screening)
    .leftJoin(workspace, eq(workspace.id, screening.workspaceId))
    .where(input.open ? openSql("sanctions_screening") : undefined)
    .orderBy(desc(screening.createdAt), desc(screening.id))
    .limit(input.limit);
  return rows.map((r) => ({ ...r.row, workspaceSlug: r.workspaceSlug }));
}

export async function getScreening(
  tx: Tx,
  id: string,
  options: { readonly lock?: boolean } = {},
): Promise<ScreeningListRow | undefined> {
  if (options.lock === true) {
    // The screening row alone, FOR UPDATE: a second decision on it waits for the first.
    const locked = await tx
      .select({ id: screening.id })
      .from(screening)
      .where(eq(screening.id, id))
      .for("update");
    if (locked.length === 0) return undefined;
  }
  const rows = await tx
    .select({ row: screening, workspaceSlug: workspace.slug })
    .from(screening)
    .leftJoin(workspace, eq(workspace.id, screening.workspaceId))
    .where(eq(screening.id, id))
    .limit(1);
  const r = rows[0];
  return r === undefined ? undefined : { ...r.row, workspaceSlug: r.workspaceSlug };
}

/** Whether the screening is open (see the header). */
export async function isOpenScreening(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx
    .select({ id: screening.id })
    .from(screening)
    .where(and(eq(screening.id, id), openSql("sanctions_screening")))
    .limit(1);
  return rows.length > 0;
}

export async function writeDecision(
  tx: Tx,
  id: string,
  input: {
    readonly decision: SanctionsDecision;
    readonly decidedBy: string;
    readonly note: string;
    readonly at: Date;
  },
): Promise<void> {
  await tx
    .update(screening)
    .set({
      decision: input.decision,
      decidedBy: input.decidedBy,
      decisionNote: input.note,
      decidedAt: input.at,
    })
    .where(eq(screening.id, id));
}

/**
 * A page of live workspaces (keyset on id) with no successful screen against `listVersion` —
 * the re-screen's work list. The platform pseudo-workspace is never screened.
 */
/** The subject name as screened: `(legal_name ?? name).trim()`, at most this many characters. */
export const SUBJECT_NAME_MAX = 300;

export async function workspacesToRescreen(
  tx: Tx,
  input: {
    readonly listVersion: string;
    /** `<driver>:unscreenable:<matcher>` — see the service. */
    readonly unscreenableVersion: string;
    readonly after: string | null;
    readonly limit: number;
  },
): Promise<string[]> {
  const r = await tx.execute<{ id: string }>(sql`
    SELECT w.id::text AS id
      FROM core.workspace w
     WHERE w.deleted_at IS NULL
       AND w.id <> ${PLATFORM_WORKSPACE_ID}::uuid
       AND (${input.after}::uuid IS NULL OR w.id > ${input.after}::uuid)
       AND NOT EXISTS (
         SELECT 1 FROM core.sanctions_screening s
          WHERE s.workspace_id = w.id
            AND s.list_version = ${input.listVersion}
            AND s.outcome <> 'error')
       -- RR2-3: a name nothing can be screened against stays unscreenable whatever the list says:
       -- skip it while its latest screening is that error for the SAME name (decided or not) under
       -- this matcher. A renamed company (or a matcher that can read it) is screened again.
       AND NOT EXISTS (
         SELECT 1 FROM (
           SELECT s.subject_name, s.list_version, s.outcome
             FROM core.sanctions_screening s
            WHERE s.workspace_id = w.id
            ORDER BY s.created_at DESC, s.id DESC
            LIMIT 1) latest
          WHERE latest.outcome = 'error'
            AND latest.list_version = ${input.unscreenableVersion}
            AND latest.subject_name = left(btrim(coalesce(w.legal_name, w.name)), ${SUBJECT_NAME_MAX}))
     ORDER BY w.id
     LIMIT ${input.limit}`);
  return r.rows.map((row) => row.id);
}

// --- transaction context (as `@fundroom/control-plane`'s status repo) --------------------------

export interface TxContextSnapshot {
  readonly workspaceId: string;
  readonly actorKind: string;
  readonly membershipId: string;
  readonly userId: string;
}

export async function readTxContext(tx: Tx): Promise<TxContextSnapshot> {
  const r = await tx.execute<{
    workspace_id: string;
    actor_kind: string;
    membership_id: string;
    user_id: string;
  }>(sql`
    SELECT coalesce(current_setting('app.workspace_id', true), '') AS workspace_id,
           coalesce(current_setting('app.actor_kind', true), '') AS actor_kind,
           coalesce(current_setting('app.membership_id', true), '') AS membership_id,
           coalesce(current_setting('app.user_id', true), '') AS user_id`);
  const row = r.rows[0];
  return {
    workspaceId: row?.workspace_id ?? "",
    actorKind: row?.actor_kind ?? "",
    membershipId: row?.membership_id ?? "",
    userId: row?.user_id ?? "",
  };
}

export async function restoreTxContext(tx: Tx, ctx: TxContextSnapshot): Promise<void> {
  await tx.execute(sql`
    SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true),
           set_config('app.actor_kind', ${ctx.actorKind}, true),
           set_config('app.membership_id', ${ctx.membershipId}, true),
           set_config('app.user_id', ${ctx.userId}, true)`);
}

/** Switches the transaction to the platform pseudo-workspace's `system` actor (its audit chain). */
export async function enterPlatformContext(tx: Tx): Promise<void> {
  await tx.execute(sql`
    SELECT set_config('app.workspace_id', ${PLATFORM_WORKSPACE_ID}, true),
           set_config('app.actor_kind', 'system', true),
           set_config('app.membership_id', '', true),
           set_config('app.user_id', '', true)`);
}
