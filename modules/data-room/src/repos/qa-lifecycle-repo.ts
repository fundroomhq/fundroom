import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { QaQuestionStatus, QaTargetKind, QaVisibility } from "../qa/rules.js";
import { document, folder } from "../schema/dataroom.js";
import { type NewQaAnswer, type NewQaQuestion, qaAnswer, qaQuestion } from "../schema/qa.js";

/*
 * Q&A reads and writes for the lifecycle side (E3.3 D7): the search source, the SLA sweep,
 * DSAR erasure, and the CSV export/import. The inbox/investor flows live in `qa-repo.ts`.
 */

/** One published question on a live target, ready to become a search entry. */
export interface QaSearchRow {
  readonly id: string;
  readonly targetKind: QaTargetKind;
  readonly targetId: string;
  /** The ltree path `core.has_access` evaluates for the target (document: its folder's path). */
  readonly path: string;
  /** The target's own title (document title / folder name): the entry's non-secret title. */
  readonly targetTitle: string;
  readonly publicText: string;
  readonly answerBody: string | null;
  readonly updatedAt: Date;
  /** The target lies at or below a staff-only folder (E3.5): the entry gets the `staff` ACL. */
  readonly staffOnly: boolean;
}

/** An unanswered question with a due time (the SLA sweep's candidates). */
export interface QaDueRow {
  readonly id: string;
  readonly status: QaQuestionStatus;
  readonly dueAt: Date;
  readonly assigneeMembershipId: string | null;
  readonly dueSoonNotifiedAt: Date | null;
  readonly overdueNotifiedAt: Date | null;
}

/** One question with everything the CSV export writes (names resolved by the caller). */
export interface QaExportRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly status: QaQuestionStatus;
  readonly source: string;
  readonly targetKind: QaTargetKind;
  readonly targetId: string;
  readonly targetTitle: string;
  readonly askerMembershipId: string | null;
  readonly assigneeMembershipId: string | null;
  readonly subject: string;
  readonly body: string;
  readonly publicText: string | null;
  readonly category: string | null;
  readonly dueAt: Date | null;
  readonly answer: string | null;
  readonly visibility: QaVisibility | null;
  readonly releasedAt: Date | null;
  readonly publishedAt: Date | null;
  readonly closedReason: string | null;
}

/** Most rows one export writes. */
export const QA_EXPORT_CAP = 50_000;

const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

export class QaLifecycleRepo extends TenantRepo<typeof qaQuestion> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(qaQuestion, ctx, tx);
  }

  // -------------------------------------------------------------------------------------------
  // Search source
  // -------------------------------------------------------------------------------------------

  /**
   * Published questions whose target is live (not in the recycle bin), keyset by id. Filters
   * narrow to given question ids, targets (document ids / folder ids) or everything whose
   * target sits under an ltree path (a document by its folder path, a folder by its own).
   */
  async searchRows(filter: {
    readonly ids?: readonly string[] | undefined;
    readonly documentIds?: readonly string[] | undefined;
    readonly folderIds?: readonly string[] | undefined;
    readonly underPath?: string | undefined;
    readonly afterId?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<QaSearchRow[]> {
    if (filter.ids !== undefined && filter.ids.length === 0) return [];
    if (filter.documentIds !== undefined && filter.documentIds.length === 0) return [];
    if (filter.folderIds !== undefined && filter.folderIds.length === 0) return [];
    const rows = await this.tx
      .select({
        id: qaQuestion.id,
        targetKind: qaQuestion.targetKind,
        documentId: qaQuestion.documentId,
        folderId: qaQuestion.folderId,
        docPath: document.folderPath,
        folderPath: folder.path,
        docTitle: document.title,
        folderName: folder.name,
        publicText: qaQuestion.publicText,
        answerBody: qaAnswer.body,
        updatedAt: qaQuestion.updatedAt,
        staffOnly: sql<boolean>`dataroom.under_staff_only(COALESCE(${document}.folder_path, ${folder}.path))`,
      })
      .from(qaQuestion)
      .leftJoin(qaAnswer, eq(qaAnswer.questionId, qaQuestion.id))
      .leftJoin(document, and(eq(document.id, qaQuestion.documentId), isNull(document.deletedAt)))
      .leftJoin(folder, and(eq(folder.id, qaQuestion.folderId), isNull(folder.deletedAt)))
      .where(
        this.scope(
          and(
            eq(qaQuestion.status, "published"),
            isNotNull(qaQuestion.publicText),
            or(isNotNull(document.id), isNotNull(folder.id)),
            filter.ids === undefined ? undefined : inArray(qaQuestion.id, [...filter.ids]),
            filter.documentIds === undefined
              ? undefined
              : inArray(qaQuestion.documentId, [...filter.documentIds]),
            filter.folderIds === undefined
              ? undefined
              : inArray(qaQuestion.folderId, [...filter.folderIds]),
            filter.underPath === undefined
              ? undefined
              : sql`(${document}.folder_path <@ ${filter.underPath}::ltree
                  OR ${folder}.path <@ ${filter.underPath}::ltree)`,
            filter.afterId === undefined ? undefined : sql`${qaQuestion}.id > ${filter.afterId}`,
          ),
        ),
      )
      .orderBy(asc(qaQuestion.id))
      .limit(filter.limit ?? 10_000);
    return rows.map((r) => ({
      id: r.id,
      targetKind: r.targetKind,
      targetId: (r.targetKind === "document" ? r.documentId : r.folderId) ?? "",
      path: (r.targetKind === "document" ? r.docPath : r.folderPath) ?? "",
      targetTitle: (r.targetKind === "document" ? r.docTitle : r.folderName) ?? "",
      publicText: r.publicText ?? "",
      answerBody: r.answerBody ?? null,
      updatedAt: r.updatedAt,
      staffOnly: r.staffOnly === true,
    }));
  }

  /**
   * Ids of published questions on the given documents, or with a target anywhere under a path —
   * trashed or not (the entries to drop when the target leaves).
   */
  async publishedIdsOnTargets(filter: {
    readonly documentIds?: readonly string[] | undefined;
    readonly underPath?: string | undefined;
  }): Promise<string[]> {
    const conds = [];
    if (filter.documentIds !== undefined && filter.documentIds.length > 0)
      conds.push(inArray(qaQuestion.documentId, [...filter.documentIds]));
    if (filter.underPath !== undefined) {
      conds.push(sql`${qaQuestion}.document_id IN (SELECT d.id FROM dataroom.document d
        WHERE d.workspace_id = ${this.ctx.workspaceId} AND d.folder_path <@ ${filter.underPath}::ltree)`);
      conds.push(sql`${qaQuestion}.folder_id IN (SELECT f.id FROM dataroom.folder f
        WHERE f.workspace_id = ${this.ctx.workspaceId} AND f.path <@ ${filter.underPath}::ltree)`);
    }
    if (conds.length === 0) return [];
    const rows = await this.tx
      .select({ id: qaQuestion.id })
      .from(qaQuestion)
      .where(this.scope(and(eq(qaQuestion.status, "published"), or(...conds))))
      .orderBy(asc(qaQuestion.id));
    return rows.map((r) => r.id);
  }

  /**
   * The workspace's settings jsonb as this transaction sees it. `lock` row-locks it FOR NO KEY
   * UPDATE (a writer's index decision then serialises with a settings PATCH that flips
   * `qa.enabled`); without it the read is plain (the rebuild's pages run in read-only
   * transactions). Never FOR SHARE (E3.5 LX): every locking caller goes on to audit, which takes
   * this row FOR NO KEY UPDATE — two share holders would each wait for the other's upgrade.
   */
  async workspaceSettings(lock: "lock" | "none"): Promise<unknown> {
    const result = await this.tx.execute(
      lock === "lock"
        ? sql`SELECT settings FROM core.workspace WHERE id = ${this.ctx.workspaceId}::uuid FOR NO KEY UPDATE`
        : sql`SELECT settings FROM core.workspace WHERE id = ${this.ctx.workspaceId}::uuid`,
    );
    return (result.rows as { settings: unknown }[])[0]?.settings;
  }

  // -------------------------------------------------------------------------------------------
  // SLA sweep
  // -------------------------------------------------------------------------------------------

  /**
   * Unanswered questions that owe a reminder at `now`: past `due_at − leadHours` without a
   * due-soon or overdue stamp (when `leadHours > 0`), or past `due_at` without an overdue stamp.
   *
   * Row-locks every candidate in this one statement (FOR UPDATE SKIP LOCKED), before the sweep's
   * first audit entry. A row a staff action holds is skipped — its reminder goes out next run —
   * so the sweep never waits on a question row while it holds the audit chain (a staff action
   * holds its row and then audits: waiting would close the cycle).
   */
  async dueCandidates(now: Date, leadHours: number, limit = 1000): Promise<QaDueRow[]> {
    const rows = await this.tx
      .select({
        id: qaQuestion.id,
        status: qaQuestion.status,
        dueAt: qaQuestion.dueAt,
        assigneeMembershipId: qaQuestion.assigneeMembershipId,
        dueSoonNotifiedAt: qaQuestion.dueSoonNotifiedAt,
        overdueNotifiedAt: qaQuestion.overdueNotifiedAt,
      })
      .from(qaQuestion)
      .where(
        this.scope(
          and(
            inArray(qaQuestion.status, ["open", "assigned", "awaiting_approval"]),
            isNotNull(qaQuestion.dueAt),
            or(
              and(
                isNull(qaQuestion.overdueNotifiedAt),
                sql`${qaQuestion}.due_at <= ${now.toISOString()}::timestamptz`,
              ),
              leadHours > 0
                ? and(
                    isNull(qaQuestion.dueSoonNotifiedAt),
                    // A question already reminded as overdue is owed nothing more: without
                    // this, first-seen-overdue rows (never stamped due-soon) would match forever
                    // and, oldest `due_at` first, crowd real due-soon rows out of the page.
                    isNull(qaQuestion.overdueNotifiedAt),
                    sql`${qaQuestion}.due_at - make_interval(hours => ${leadHours}::int) <= ${now.toISOString()}::timestamptz`,
                  )
                : undefined,
            ),
          ),
        ),
      )
      .orderBy(asc(qaQuestion.dueAt), asc(qaQuestion.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    return rows.map((r) => ({ ...r, dueAt: toDate(r.dueAt as Date) }));
  }

  /**
   * Stamps one reminder phase, only if still unstamped and the question still waits on staff.
   * Returns false when another run (or a status change) got there first.
   */
  async stampDue(id: string, phase: "due_soon" | "overdue", at: Date): Promise<boolean> {
    const column =
      phase === "due_soon" ? qaQuestion.dueSoonNotifiedAt : qaQuestion.overdueNotifiedAt;
    const rows = await this.tx
      .update(qaQuestion)
      .set(phase === "due_soon" ? { dueSoonNotifiedAt: at } : { overdueNotifiedAt: at })
      .where(
        this.scope(
          and(
            eq(qaQuestion.id, id),
            isNull(column),
            inArray(qaQuestion.status, ["open", "assigned", "awaiting_approval"]),
          ),
        ),
      )
      .returning({ id: qaQuestion.id });
    return rows.length > 0;
  }

  // -------------------------------------------------------------------------------------------
  // Erasure
  // -------------------------------------------------------------------------------------------

  /**
   * Questions the member asked (any status), with their status before erasure — row-locked
   * (FOR UPDATE, in id order) before erasure touches their search entries: question rows come
   * first in the Q&A lock order.
   */
  async askedBy(membershipId: string): Promise<{ id: string; status: QaQuestionStatus }[]> {
    return this.tx
      .select({ id: qaQuestion.id, status: qaQuestion.status })
      .from(qaQuestion)
      .where(this.scope(eq(qaQuestion.askerMembershipId, membershipId)))
      .orderBy(asc(qaQuestion.id))
      .for("update");
  }

  /**
   * Row-locks, in id order, every question (any status) on the given documents or folders, or
   * with a target anywhere under an ltree path (a document by its folder path, a folder by its
   * own) — the first lock of any transaction that changes Q&A targets: question rows come first
   * in the Q&A lock order.
   *
   * `update` before a hard delete that cascades to them (the cascade must not take them only
   * after search entries or the audit chain). `share` before a rename, move, trash or restore of
   * a target: those re-read (or drop) the questions' search entries, and a staff action holding
   * a row re-indexes it from the target's title, path and liveness — the share lock serialises
   * the two, so neither writes an entry from what the other has not committed yet.
   */
  async lockOnTargets(
    filter: {
      readonly documentIds?: readonly string[] | undefined;
      readonly folderIds?: readonly string[] | undefined;
      readonly underPath?: string | undefined;
    },
    mode: "update" | "share" = "update",
  ): Promise<string[]> {
    const conds = [];
    if (filter.documentIds !== undefined && filter.documentIds.length > 0)
      conds.push(inArray(qaQuestion.documentId, [...filter.documentIds]));
    if (filter.folderIds !== undefined && filter.folderIds.length > 0)
      conds.push(inArray(qaQuestion.folderId, [...filter.folderIds]));
    if (filter.underPath !== undefined) {
      conds.push(sql`${qaQuestion}.document_id IN (SELECT d.id FROM dataroom.document d
        WHERE d.workspace_id = ${this.ctx.workspaceId} AND d.folder_path <@ ${filter.underPath}::ltree)`);
      conds.push(sql`${qaQuestion}.folder_id IN (SELECT f.id FROM dataroom.folder f
        WHERE f.workspace_id = ${this.ctx.workspaceId} AND f.path <@ ${filter.underPath}::ltree)`);
    }
    if (conds.length === 0) return [];
    const rows = await this.tx
      .select({ id: qaQuestion.id })
      .from(qaQuestion)
      .where(this.scope(or(...conds)))
      .orderBy(asc(qaQuestion.id))
      .for(mode);
    return rows.map((r) => r.id);
  }

  /**
   * Overwrites the asker's words and closes the questions (`erased`). The answer rows stay (staff
   * text) but nobody can read them: a closed question is visible to its asker only, and the
   * asker is gone. Every one ends `erased` — an already-closed (declined, withdrawn) question
   * too, so nothing can reopen or release it again; its original `closed_at` is kept.
   */
  async erase(ids: readonly string[], text: string, at: Date): Promise<number> {
    if (ids.length === 0) return 0;
    const rows = await this.tx
      .update(qaQuestion)
      .set({
        subject: text,
        body: text,
        publicText: sql`CASE WHEN ${qaQuestion}.public_text IS NULL THEN NULL ELSE ${text}::text END`,
        internalNote: null,
        status: "closed",
        visibility: null,
        closedReason: "erased",
        closedAt: sql`COALESCE(${qaQuestion}.closed_at, ${at.toISOString()}::timestamptz)`,
      })
      .where(this.scope(inArray(qaQuestion.id, [...ids])))
      .returning({ id: qaQuestion.id });
    return rows.length;
  }

  // -------------------------------------------------------------------------------------------
  // CSV export / import
  // -------------------------------------------------------------------------------------------

  /**
   * Every question (oldest first), with its target's title (trashed targets included). Reads at
   * most `QA_EXPORT_CAP + 1` rows: the caller writes `QA_EXPORT_CAP` and flags the rest.
   */
  async exportRows(): Promise<QaExportRow[]> {
    const rows = await this.tx
      .select({
        id: qaQuestion.id,
        createdAt: qaQuestion.createdAt,
        status: qaQuestion.status,
        source: qaQuestion.source,
        targetKind: qaQuestion.targetKind,
        documentId: qaQuestion.documentId,
        folderId: qaQuestion.folderId,
        documentTitle: document.title,
        folderName: folder.name,
        askerMembershipId: qaQuestion.askerMembershipId,
        assigneeMembershipId: qaQuestion.assigneeMembershipId,
        subject: qaQuestion.subject,
        body: qaQuestion.body,
        publicText: qaQuestion.publicText,
        category: qaQuestion.category,
        dueAt: qaQuestion.dueAt,
        answer: qaAnswer.body,
        visibility: qaQuestion.visibility,
        releasedAt: qaQuestion.releasedAt,
        publishedAt: qaQuestion.publishedAt,
        closedReason: qaQuestion.closedReason,
      })
      .from(qaQuestion)
      .leftJoin(qaAnswer, eq(qaAnswer.questionId, qaQuestion.id))
      .leftJoin(document, eq(document.id, qaQuestion.documentId))
      .leftJoin(folder, eq(folder.id, qaQuestion.folderId))
      .where(this.scope())
      .orderBy(asc(qaQuestion.createdAt), asc(qaQuestion.id))
      .limit(QA_EXPORT_CAP + 1);
    return rows.map(({ documentId, folderId, documentTitle, folderName, answer, ...r }) => ({
      ...r,
      targetId: (r.targetKind === "document" ? documentId : folderId) ?? "",
      targetTitle: (r.targetKind === "document" ? documentTitle : folderName) ?? "",
      answer: answer ?? null,
    }));
  }

  /** Of `ids`, the documents that exist and are not in the recycle bin. */
  async liveDocumentIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.tx
      .select({ id: document.id })
      .from(document)
      .where(
        and(
          eq(document.workspaceId, this.ctx.workspaceId),
          isNull(document.deletedAt),
          inArray(document.id, [...ids]),
        ),
      );
    return new Set(rows.map((r) => r.id));
  }

  /** Of `ids`, the folders that exist and are not in the recycle bin. */
  async liveFolderIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.tx
      .select({ id: folder.id })
      .from(folder)
      .where(
        and(
          eq(folder.workspaceId, this.ctx.workspaceId),
          isNull(folder.deletedAt),
          inArray(folder.id, [...ids]),
        ),
      );
    return new Set(rows.map((r) => r.id));
  }

  /** The root folder's id (the data room itself). */
  async rootFolderId(): Promise<string | undefined> {
    const rows = await this.tx
      .select({ id: folder.id })
      .from(folder)
      .where(and(eq(folder.workspaceId, this.ctx.workspaceId), isNull(folder.parentId)))
      .limit(1);
    return rows[0]?.id;
  }

  /** Inserts one imported question and, when given, its answer. Returns the question id. */
  async insertImported(
    question: Omit<NewQaQuestion, "workspaceId">,
    answer: Omit<NewQaAnswer, "workspaceId" | "questionId"> | undefined,
  ): Promise<string> {
    const ws = this.ctx.workspaceId;
    const [row] = await this.tx
      .insert(qaQuestion)
      .values({ ...question, workspaceId: ws })
      .returning({ id: qaQuestion.id });
    if (row === undefined) throw new Error("qa import: insert returned nothing");
    if (answer !== undefined)
      await this.tx.insert(qaAnswer).values({ ...answer, workspaceId: ws, questionId: row.id });
    return row.id;
  }
}
