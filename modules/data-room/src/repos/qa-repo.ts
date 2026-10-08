import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import {
  QA_STATUSES,
  QA_UNANSWERED_STATUSES,
  type QaQuestionStatus,
  type QaTargetKind,
} from "../qa/rules.js";
import { document, folder } from "../schema/dataroom.js";
import {
  type NewQaAnswer,
  type NewQaQuestion,
  type QaAnswer,
  type QaQuestion,
  qaAnswer,
  qaQuestion,
} from "../schema/qa.js";

/*
 * Q&A reads and writes for the inbox and the investor routes (E3.3 D6, ADR-0051). Every query
 * runs under the caller's own context: for an external member RLS decides which rows exist
 * (own questions, published ones on live targets it can view); the explicit predicates below
 * repeat that decision so a staff caller of an investor route gets the same investor-shaped
 * answer. Keyset cursors carry every ORDER BY column (the sort key at microsecond precision
 * as text, then `id`).
 */

/**
 * A page position: the last row's sort key (Postgres text, µs precision) and id. The key is
 * `created_at` for the inbox and `scope=mine`, `targetSortKey` for `scope=target`.
 */
export interface QaCursor {
  readonly createdAt: string;
  readonly id: string;
}

export function encodeQaCursor(c: QaCursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id]), "utf8").toString("base64url");
}

/** Exactly what `cursorText` emits: UTC, microseconds, `Z`. */
const CURSOR_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/u;

/**
 * The shape `cursorText` writes, and a real calendar time (no 2026-02-30 or 25:00 — Postgres
 * would refuse those in the `::timestamptz` cast and the route would answer 500, not 400).
 */
function validCursorTime(s: string): boolean {
  const m = CURSOR_TIME.exec(s);
  if (m === null) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === se
  );
}

/** undefined for a malformed cursor (the route answers 400). */
export function decodeQaCursor(raw: string): QaCursor | undefined {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== 2) return undefined;
    const [createdAt, id] = v as unknown[];
    if (typeof createdAt !== "string" || typeof id !== "string") return undefined;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))
      return undefined;
    if (!validCursorTime(createdAt)) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

const Q = sql.raw('"dataroom"."qa_question"');
const CREATED = sql`${Q}."created_at"`;

/** A sort key as UTC text with microseconds, for the cursor. */
function cursorText(key: SQL): SQL<string> {
  return sql<string>`to_char((${key}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function after(key: SQL, c: QaCursor | undefined): SQL | undefined {
  if (c === undefined) return undefined;
  return sql`((${key}), ${Q}."id") < (${c.createdAt}::timestamptz, ${c.id}::uuid)`;
}

function orderBy(key: SQL): SQL[] {
  return [sql`(${key}) DESC`, sql`${Q}."id" DESC`];
}

/**
 * The sort key of a list that can hold other people's questions (`scope=target`). When a rival
 * asked is itself a signal (the view withholds `createdAt` from non-askers), so it must not leak
 * through the order or the cursor either: someone else's (published) question sorts by
 * `published_at` — never its `created_at`, not even as a fallback (a published row without a
 * publish time sorts at the epoch). The caller's own questions sort by `published_at` once
 * published, else by when they asked. (The uuidv7 id still encodes the ask time to the
 * millisecond — accepted, ADR-0051.)
 */
function targetSortKey(membershipId: string, isDelegate: boolean): SQL {
  const published = sql`${Q}."published_at"`;
  if (isDelegate) return sql`COALESCE(${published}, 'epoch'::timestamptz)`;
  return sql`CASE WHEN ${Q}."asker_membership_id" = ${membershipId}::uuid
    THEN COALESCE(${published}, ${CREATED})
    ELSE COALESCE(${published}, 'epoch'::timestamptz) END`;
}

/** The target is live (not in the recycle bin). The viewability half is RLS / authz. */
const targetLive = sql`(
  (${Q}."target_kind" = 'document' AND EXISTS (
    SELECT 1 FROM dataroom.document d WHERE d.id = ${Q}."document_id" AND d.deleted_at IS NULL))
  OR (${Q}."target_kind" = 'folder' AND EXISTS (
    SELECT 1 FROM dataroom.folder f WHERE f.id = ${Q}."folder_id" AND f.deleted_at IS NULL))
)`;

/** `and()` / `or()` of two defined conditions, typed as defined. */
const both = (a: SQL, b: SQL): SQL => sql`(${a} AND ${b})`;
const either = (a: SQL, b: SQL): SQL => sql`(${a} OR ${b})`;

function targetIs(kind: QaTargetKind, id: string): SQL {
  return kind === "document"
    ? both(eq(qaQuestion.targetKind, "document"), eq(qaQuestion.documentId, id))
    : both(eq(qaQuestion.targetKind, "folder"), eq(qaQuestion.folderId, id));
}

export interface QaRow {
  readonly question: QaQuestion;
  readonly cursor: string;
}

export interface QaInboxRow extends QaRow {
  readonly title: string | null;
  readonly hasDraft: boolean;
}

export interface QaInboxFilter {
  readonly status?: QaQuestionStatus | undefined;
  /** A membership id, or `unassigned`. */
  readonly assignee?: string | undefined;
  readonly targetKind?: QaTargetKind | undefined;
  readonly targetId?: string | undefined;
  /** Unanswered questions past `due_at` at `now`. */
  readonly overdueAt?: Date | undefined;
}

export class QaQuestionRepo extends TenantRepo<typeof qaQuestion> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(qaQuestion, ctx, tx);
  }

  byId(id: string): Promise<QaQuestion | undefined> {
    return this.findById(id);
  }

  /** Row-locks the question for a state change (FOR UPDATE; RLS decides whether it exists). */
  async lock(id: string): Promise<QaQuestion | undefined> {
    const rows = await this.tx
      .select()
      .from(qaQuestion)
      .where(this.scope(eq(qaQuestion.id, id)))
      .limit(1)
      .for("update");
    return rows[0];
  }

  create(values: Omit<NewQaQuestion, "workspaceId">): Promise<QaQuestion> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<Omit<NewQaQuestion, "id" | "workspaceId" | "createdAt" | "updatedAt">>,
  ): Promise<QaQuestion | undefined> {
    const rows = await this.tx
      .update(qaQuestion)
      .set(patch)
      .where(this.scope(eq(qaQuestion.id, id)))
      .returning();
    return rows[0];
  }

  /**
   * Serialises asks by one member (transaction-scoped advisory lock), so two concurrent asks
   * cannot both pass the open-question budget.
   */
  async lockAsker(membershipId: string): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`qa-ask:${membershipId}`}, 0))`,
    );
  }

  /** The member's questions still waiting on staff (open, assigned, awaiting approval). */
  async countOpenByAsker(membershipId: string): Promise<number> {
    const rows = await this.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(qaQuestion)
      .where(
        this.scope(
          and(
            eq(qaQuestion.askerMembershipId, membershipId),
            inArray(qaQuestion.status, [...QA_UNANSWERED_STATUSES]),
          ),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /** Questions the member asked at or after `since` (the per-day rate limit). */
  async countAskedSince(membershipId: string, since: Date): Promise<number> {
    const rows = await this.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(qaQuestion)
      .where(
        this.scope(
          and(
            eq(qaQuestion.askerMembershipId, membershipId),
            sql`${Q}."created_at" >= ${since.toISOString()}::timestamptz`,
          ),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /**
   * The investor-visible predicate: the caller's own question (never as a delegate), or a
   * published one whose target is live. RLS adds "and viewable now" for an external caller.
   */
  private visibleTo(membershipId: string, isDelegate: boolean): SQL {
    const published = both(eq(qaQuestion.status, "published"), targetLive);
    if (isDelegate) return published;
    return either(eq(qaQuestion.askerMembershipId, membershipId), published);
  }

  /** One question as the investor routes may show it, or undefined. */
  async visibleById(
    id: string,
    viewer: { membershipId: string; isDelegate: boolean },
  ): Promise<QaQuestion | undefined> {
    const rows = await this.tx
      .select()
      .from(qaQuestion)
      .where(
        this.scope(
          and(eq(qaQuestion.id, id), this.visibleTo(viewer.membershipId, viewer.isDelegate)),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * `scope=mine`: the caller's own questions (optionally on one target). `scope=target`: the
   * caller's own plus published ones on the target. Newest first.
   */
  async listForViewer(input: {
    readonly membershipId: string;
    readonly isDelegate: boolean;
    readonly scope: "mine" | "target";
    readonly target?: { kind: QaTargetKind; id: string } | undefined;
    readonly cursor?: QaCursor | undefined;
    readonly limit: number;
  }): Promise<QaRow[]> {
    const who =
      input.scope === "mine"
        ? input.isDelegate
          ? sql`false`
          : eq(qaQuestion.askerMembershipId, input.membershipId)
        : this.visibleTo(input.membershipId, input.isDelegate);
    // `mine` holds only the caller's own rows: newest ask first. `target` may hold rivals'.
    const key =
      input.scope === "mine" ? CREATED : targetSortKey(input.membershipId, input.isDelegate);
    const rows = await this.tx
      .select({ question: qaQuestion, cursor: cursorText(key) })
      .from(qaQuestion)
      .where(
        this.scope(
          and(
            who,
            input.target ? targetIs(input.target.kind, input.target.id) : undefined,
            after(key, input.cursor),
          ),
        ),
      )
      .orderBy(...orderBy(key))
      .limit(input.limit);
    return rows;
  }

  /** The staff inbox: filters, newest first, with the target's title and whether a draft exists. */
  async inbox(
    filter: QaInboxFilter,
    cursor: QaCursor | undefined,
    limit: number,
  ): Promise<QaInboxRow[]> {
    const conds: (SQL | undefined)[] = [];
    if (filter.status !== undefined) conds.push(eq(qaQuestion.status, filter.status));
    if (filter.assignee === "unassigned") conds.push(isNull(qaQuestion.assigneeMembershipId));
    else if (filter.assignee !== undefined)
      conds.push(eq(qaQuestion.assigneeMembershipId, filter.assignee));
    if (filter.targetKind !== undefined && filter.targetId !== undefined)
      conds.push(targetIs(filter.targetKind, filter.targetId));
    else if (filter.targetKind !== undefined)
      conds.push(eq(qaQuestion.targetKind, filter.targetKind));
    else if (filter.targetId !== undefined)
      conds.push(
        or(eq(qaQuestion.documentId, filter.targetId), eq(qaQuestion.folderId, filter.targetId)),
      );
    if (filter.overdueAt !== undefined)
      conds.push(
        and(
          inArray(qaQuestion.status, [...QA_UNANSWERED_STATUSES]),
          sql`${Q}."due_at" <= ${filter.overdueAt.toISOString()}::timestamptz`,
        ),
      );
    conds.push(after(CREATED, cursor));
    const rows = await this.tx
      .select({
        question: qaQuestion,
        cursor: cursorText(CREATED),
        title: sql<
          string | null
        >`COALESCE("dataroom"."document"."title", "dataroom"."folder"."name")`,
        hasDraft: sql<boolean>`("dataroom"."qa_answer"."id" IS NOT NULL)`,
      })
      .from(qaQuestion)
      .leftJoin(document, eq(document.id, qaQuestion.documentId))
      .leftJoin(folder, eq(folder.id, qaQuestion.folderId))
      .leftJoin(qaAnswer, eq(qaAnswer.questionId, qaQuestion.id))
      .where(this.scope(and(...conds)))
      .orderBy(...orderBy(CREATED))
      .limit(limit);
    return rows.map((r) => ({ ...r, hasDraft: Boolean(r.hasDraft) }));
  }

  /** Ids of the workspace's `published` questions (the only ones that can have a search entry). */
  async publishedIds(): Promise<string[]> {
    const rows = await this.tx
      .select({ id: qaQuestion.id })
      .from(qaQuestion)
      .where(this.scope(eq(qaQuestion.status, "published")));
    return rows.map((r) => r.id);
  }

  /** Every status's count in the workspace (zeros included). */
  async counts(): Promise<Record<QaQuestionStatus, number>> {
    const rows = await this.tx
      .select({ status: qaQuestion.status, n: sql<number>`count(*)::int` })
      .from(qaQuestion)
      .where(this.scope())
      .groupBy(qaQuestion.status);
    const out = Object.fromEntries(QA_STATUSES.map((s) => [s, 0])) as Record<
      QaQuestionStatus,
      number
    >;
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }
}

export class QaAnswerRepo extends TenantRepo<typeof qaAnswer> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(qaAnswer, ctx, tx);
  }

  async forQuestion(questionId: string): Promise<QaAnswer | undefined> {
    const rows = await this.findMany(eq(qaAnswer.questionId, questionId));
    return rows[0];
  }

  /** Answers of these questions that the caller may read (RLS), by question id. */
  async forQuestions(questionIds: readonly string[]): Promise<Map<string, QaAnswer>> {
    const out = new Map<string, QaAnswer>();
    if (questionIds.length === 0) return out;
    const rows = await this.findMany(inArray(qaAnswer.questionId, [...questionIds]));
    for (const r of rows) out.set(r.questionId, r);
    return out;
  }

  create(values: Omit<NewQaAnswer, "workspaceId">): Promise<QaAnswer> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<Omit<NewQaAnswer, "id" | "workspaceId" | "questionId" | "createdAt">>,
  ): Promise<QaAnswer | undefined> {
    const rows = await this.tx
      .update(qaAnswer)
      .set(patch)
      .where(this.scope(eq(qaAnswer.id, id)))
      .returning();
    return rows[0];
  }
}

export interface QaTargetRow {
  readonly kind: QaTargetKind;
  readonly id: string;
  readonly title: string;
  /** The ltree path authz evaluates (a document: its folder's). */
  readonly path: string;
  readonly deleted: boolean;
  /** Folder: its parent; document: its folder. */
  readonly folderId: string | null;
}

/** Targets (documents / folders) as the caller's context may read them — RLS applies. */
export class QaTargetRepo {
  constructor(
    private readonly ctx: TenantContext,
    private readonly tx: Tx,
  ) {}

  async documents(ids: readonly string[], liveOnly: boolean): Promise<Map<string, QaTargetRow>> {
    const out = new Map<string, QaTargetRow>();
    if (ids.length === 0) return out;
    const rows = await this.tx
      .select({
        id: document.id,
        title: document.title,
        path: document.folderPath,
        deletedAt: document.deletedAt,
        folderId: document.folderId,
      })
      .from(document)
      .where(
        and(
          eq(document.workspaceId, this.ctx.workspaceId),
          inArray(document.id, [...ids]),
          liveOnly ? isNull(document.deletedAt) : undefined,
        ),
      );
    for (const r of rows)
      out.set(r.id, {
        kind: "document",
        id: r.id,
        title: r.title,
        path: r.path,
        deleted: r.deletedAt !== null,
        folderId: r.folderId,
      });
    return out;
  }

  async folders(ids: readonly string[], liveOnly: boolean): Promise<Map<string, QaTargetRow>> {
    const out = new Map<string, QaTargetRow>();
    if (ids.length === 0) return out;
    const rows = await this.tx
      .select({
        id: folder.id,
        name: folder.name,
        path: folder.path,
        deletedAt: folder.deletedAt,
        parentId: folder.parentId,
      })
      .from(folder)
      .where(
        and(
          eq(folder.workspaceId, this.ctx.workspaceId),
          inArray(folder.id, [...ids]),
          liveOnly ? isNull(folder.deletedAt) : undefined,
        ),
      );
    for (const r of rows)
      out.set(r.id, {
        kind: "folder",
        id: r.id,
        title: r.name,
        path: r.path,
        deleted: r.deletedAt !== null,
        folderId: r.parentId,
      });
    return out;
  }

  async one(kind: QaTargetKind, id: string, liveOnly: boolean): Promise<QaTargetRow | undefined> {
    const m =
      kind === "document"
        ? await this.documents([id], liveOnly)
        : await this.folders([id], liveOnly);
    return m.get(id);
  }

  /**
   * Names of the folders from below the root down to `path` (inclusive), for a breadcrumb.
   * Deleted folders included (a binned target keeps its breadcrumb).
   */
  async breadcrumb(path: string): Promise<string[]> {
    const rows = await this.tx
      .select({ name: folder.name, parentId: folder.parentId })
      .from(folder)
      .where(
        and(
          eq(folder.workspaceId, this.ctx.workspaceId),
          sql`"dataroom"."folder"."path" @> ${path}::ltree`,
        ),
      )
      .orderBy(sql`nlevel("dataroom"."folder"."path")`);
    return rows.filter((r) => r.parentId !== null).map((r) => r.name);
  }
}
