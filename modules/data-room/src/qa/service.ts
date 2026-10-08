import { pgErrorCode, systemContext, type TenantContext, type Tx } from "@fundroom/db";
import type { DataRoomQaSettings } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import type { AccessDecision, RequestFacts } from "@fundroom/ports";
import type { Actor } from "../errors.js";
import {
  decodeQaCursor,
  encodeQaCursor,
  QaAnswerRepo,
  type QaCursor,
  QaQuestionRepo,
  QaTargetRepo,
  type QaTargetRow,
} from "../repos/qa-repo.js";
import type { QaAnswer, QaQuestion } from "../schema/qa.js";
import { documentRef, folderRef, loadVeil, VEILED } from "../service/access.js";
import type {
  QaAsk,
  QaInboxDetail,
  QaInboxItem,
  QaInboxPage,
  QaInboxPatch,
  QaInboxQueryInput,
  QaQuestionPage,
  QaQuestionView,
  QaRelease,
  QaStaffCreate,
} from "./contracts.js";
import {
  approvalCurrent,
  defaultPublicText,
  dueAtFor,
  isReleased,
  nextStatus,
  QA_MAX_ASKS_PER_DAY,
  type QaAction,
  type QaQuestionStatus,
  type QaTargetKind,
  type QaVisibility,
  sha256Hex,
  slaState,
} from "./rules.js";
import { indexQuestion, qaSearchEnabled } from "./search.js";
import { isMine, projectQuestionView } from "./view.js";

/*
 * Data-room Q&A (E3.3 D2/D6, ADR-0051): investors ask against a document or folder they can
 * view, staff triage, answer, approve (four-eyes, optional) and release the answer to the asker
 * or publish it to everyone who can view the target.
 *
 * Who sees what is decided twice: RLS on `dataroom.qa_question` / `qa_answer` picks the rows an
 * external caller may read, and `projectQuestionView` picks the columns — a non-asker never
 * receives the asker, the original subject/body, notes, the assignee or a draft. Access to a
 * target is `AuthzPort.check()` — always outside a transaction (it takes its own connection).
 */

const DAY_MS = 86_400_000;

export type QaErrorCode =
  | "not_found"
  | "forbidden"
  | "conflict"
  | "validation_failed"
  | "rate_limited"
  | "view_as_read_only";

export class QaError extends Error {
  override readonly name = "QaError";
  constructor(
    readonly code: QaErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

/** The caller of an investor route. */
export interface QaCaller {
  readonly membershipId: string;
  readonly kind: "staff" | "external";
  /** `role = 'delegate'`: reads published answers only, never asks. */
  readonly isDelegate: boolean;
  readonly facts: RequestFacts;
}

export interface QaService {
  // --- investor ---
  ask(
    ctx: TenantContext,
    caller: QaCaller,
    input: QaAsk,
    settings: DataRoomQaSettings,
    actor: Actor,
  ): Promise<QaQuestionView>;
  list(
    ctx: TenantContext,
    caller: QaCaller,
    query: {
      scope: "mine" | "target";
      targetKind?: QaTargetKind | undefined;
      targetId?: string | undefined;
      cursor?: string | undefined;
      limit: number;
    },
  ): Promise<QaQuestionPage>;
  get(ctx: TenantContext, caller: QaCaller, id: string): Promise<QaQuestionView>;
  withdraw(ctx: TenantContext, caller: QaCaller, id: string, actor: Actor): Promise<QaQuestionView>;
  // --- staff ---
  inbox(
    ctx: TenantContext,
    me: string,
    query: QaInboxQueryInput,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxPage>;
  detail(ctx: TenantContext, id: string, settings: DataRoomQaSettings): Promise<QaInboxDetail>;
  create(
    ctx: TenantContext,
    input: QaStaffCreate,
    actor: Actor,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail>;
  patch(
    ctx: TenantContext,
    id: string,
    input: QaInboxPatch,
    actor: Actor,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail>;
  assign(
    ctx: TenantContext,
    id: string,
    assigneeMembershipId: string | null,
    actor: Actor,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail>;
  saveAnswer(
    ctx: TenantContext,
    id: string,
    body: string,
    actor: Actor,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail>;
  submit(
    ctx: TenantContext,
    id: string,
    actor: Actor,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail>;
  approve(
    ctx: TenantContext,
    id: string,
    actor: Actor,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail>;
  reject(
    ctx: TenantContext,
    id: string,
    note: string,
    actor: Actor,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail>;
  release(
    ctx: TenantContext,
    id: string,
    input: QaRelease,
    actor: Actor,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail>;
  unpublish(
    ctx: TenantContext,
    id: string,
    actor: Actor,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail>;
  close(
    ctx: TenantContext,
    id: string,
    input: { reason: "declined"; notifyAsker: boolean },
    actor: Actor,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail>;
  reopen(
    ctx: TenantContext,
    id: string,
    actor: Actor,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail>;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function targetIdOf(q: Pick<QaQuestion, "targetKind" | "documentId" | "folderId">): string {
  return (q.targetKind === "document" ? q.documentId : q.folderId) ?? "";
}

function viewSource(q: QaQuestion, answer: QaAnswer | undefined) {
  return { ...q, answerBody: answer?.body ?? null };
}

function hasAsker(q: QaQuestion): boolean {
  return q.source === "portal" && q.askerMembershipId !== null;
}

export function createQaService(services: ModuleServices): QaService {
  const { db } = services;
  const now = () => services.now();

  function auditQa(
    tx: Tx,
    ctx: TenantContext,
    actor: Actor,
    action: string,
    questionId: string,
    meta: Record<string, string | number | boolean | null | string[]> = {},
    subjectMembershipId?: string | null,
  ) {
    return services.audit.record(tx, ctx, {
      action,
      resourceKind: "qa_question",
      resourceId: questionId,
      actorMembershipId: actor.membershipId,
      subjectMembershipId: subjectMembershipId ?? null,
      requestId: actor.requestId,
      sessionId: actor.sessionId,
      apiKeyId: actor.apiKeyId,
      ip: actor.ip,
      meta,
    });
  }

  /** The target as the system sees it (live only), for the authz check. */
  async function liveTarget(
    workspaceId: string,
    kind: QaTargetKind,
    id: string,
  ): Promise<QaTargetRow | undefined> {
    const sys = systemContext(workspaceId);
    return db.withTenant(sys, (tx) => new QaTargetRepo(sys, tx).one(kind, id, true));
  }

  /**
   * `AuthzPort.check("view")` on a target — outside any transaction. An external caller never
   * reaches a target under a staff-only folder (E3.5 veil): asked about, listed or read by id, it
   * answers as if they had no grant.
   */
  async function checkTarget(
    ctx: TenantContext,
    caller: QaCaller,
    t: QaTargetRow,
  ): Promise<AccessDecision> {
    if (caller.kind === "external" && (await loadVeil(services, ctx.workspaceId)).covers(t.path))
      return VEILED;
    const ref =
      t.kind === "document" ? documentRef({ id: t.id, folderPath: t.path }) : folderRef(t);
    return services.authz.check(
      { workspaceId: ctx.workspaceId, membershipId: caller.membershipId },
      ref,
      "view",
      caller.facts,
    );
  }

  /** A refused target decision as the documents routes answer it: gated → 403, else 404. */
  function refuse(decision: AccessDecision, notFound: string): never {
    if (!decision.allowed && decision.reason === "gated")
      throw new QaError("forbidden", "an access requirement is pending", {
        pendingGates: decision.pendingGates,
      });
    throw new QaError("not_found", notFound);
  }

  /** Titles of the targets the caller's own context may read (RLS: live and viewable). */
  async function titlesFor(
    ctx: TenantContext,
    tx: Tx,
    qs: readonly QaQuestion[],
  ): Promise<Map<string, string>> {
    const repo = new QaTargetRepo(ctx, tx);
    const docIds = qs.flatMap((q) => (q.documentId ? [q.documentId] : []));
    const folderIds = qs.flatMap((q) => (q.folderId ? [q.folderId] : []));
    const [docs, folders] = await Promise.all([
      repo.documents([...new Set(docIds)], true),
      repo.folders([...new Set(folderIds)], true),
    ]);
    const out = new Map<string, string>();
    for (const [id, t] of docs) out.set(id, t.title);
    for (const [id, t] of folders) out.set(id, t.title);
    return out;
  }

  async function project(
    ctx: TenantContext,
    tx: Tx,
    caller: QaCaller,
    qs: readonly QaQuestion[],
  ): Promise<QaQuestionView[]> {
    const answers = await new QaAnswerRepo(ctx, tx).forQuestions(qs.map((q) => q.id));
    const titles = await titlesFor(ctx, tx, qs);
    const viewer = { membershipId: caller.membershipId, isDelegate: caller.isDelegate };
    const out: QaQuestionView[] = [];
    for (const q of qs) {
      const v = projectQuestionView(
        viewSource(q, answers.get(q.id)),
        viewer,
        titles.get(targetIdOf(q)) ?? "",
      );
      if (v !== null) out.push(v);
    }
    return out;
  }

  // --- staff helpers ---------------------------------------------------------------------------

  async function lockOr404(ctx: TenantContext, tx: Tx, id: string): Promise<QaQuestion> {
    const q = await new QaQuestionRepo(ctx, tx).lock(id);
    if (q === undefined) throw new QaError("not_found", "no such question");
    return q;
  }

  function transition(
    q: QaQuestion,
    action: QaAction,
    extra: { hasAssignee?: boolean } = {},
  ): QaQuestionStatus {
    const to = nextStatus(q.status, action, {
      hasAssignee: extra.hasAssignee ?? q.assigneeMembershipId !== null,
      hasAsker: hasAsker(q),
    });
    if (to === null) {
      if (q.status === "closed")
        throw new QaError("conflict", "the question is closed", { reason: "closed" });
      throw new QaError(
        "conflict",
        `cannot ${action.replace(/_/gu, " ")} a question that is ${q.status}`,
      );
    }
    return to;
  }

  async function updateQ(
    ctx: TenantContext,
    tx: Tx,
    id: string,
    patch: Parameters<QaQuestionRepo["update"]>[1],
  ): Promise<QaQuestion> {
    const q = await new QaQuestionRepo(ctx, tx).update(id, patch);
    if (q === undefined) throw new QaError("not_found", "no such question");
    return q;
  }

  async function buildDetail(
    ctx: TenantContext,
    tx: Tx,
    q: QaQuestion,
    settings: DataRoomQaSettings,
  ): Promise<QaInboxDetail> {
    const answer = await new QaAnswerRepo(ctx, tx).forQuestion(q.id);
    const targets = new QaTargetRepo(ctx, tx);
    const target = await targets.one(q.targetKind, targetIdOf(q), false);
    let path: string | null = null;
    if (target !== undefined) {
      const crumbs = await targets.breadcrumb(target.path);
      // a folder's own name is its title, not part of its path
      if (target.kind === "folder") crumbs.pop();
      path = crumbs.join(" / ");
    }
    const ids = [
      q.askerMembershipId,
      q.assigneeMembershipId,
      answer?.authorMembershipId ?? null,
      answer?.approvedBy ?? null,
    ].filter((x): x is string => x !== null);
    const names = await new MembershipRepo(ctx, tx).namesFor([...new Set(ids)]);
    const ref = (id: string | null) => {
      if (id === null) return null;
      const n = names.get(id);
      return n === undefined ? null : { membershipId: id, displayName: n.displayName };
    };
    const askerName = q.askerMembershipId ? names.get(q.askerMembershipId) : undefined;
    return {
      id: q.id,
      source: q.source,
      status: q.status,
      asker:
        q.askerMembershipId && askerName
          ? {
              membershipId: q.askerMembershipId,
              displayName: askerName.displayName,
              email: askerName.email ?? "",
            }
          : null,
      target: {
        kind: q.targetKind,
        id: targetIdOf(q),
        title: target?.title ?? "",
        path,
        deleted: target?.deleted ?? true,
      },
      assignee: ref(q.assigneeMembershipId),
      subject: q.subject,
      body: q.body,
      publicText: q.publicText,
      category: q.category,
      internalNote: q.internalNote,
      visibility: q.visibility,
      dueAt: iso(q.dueAt),
      sla: slaState(q.dueAt, now(), settings.reminderLeadHours, q.status),
      answer: answer
        ? {
            body: answer.body,
            author: ref(answer.authorMembershipId),
            submittedAt: iso(answer.submittedAt),
            approvedBy: ref(answer.approvedBy),
            approvedAt: iso(answer.approvedAt),
            approvalCurrent: approvalCurrent(answer),
            rejectedNote: answer.rejectedNote,
          }
        : null,
      createdAt: q.createdAt.toISOString(),
      releasedAt: iso(q.releasedAt),
      publishedAt: iso(q.publishedAt),
      closedAt: iso(q.closedAt),
      closedReason: q.closedReason,
    };
  }

  /** One staff state change: lock, act, detail — one transaction. */
  function staffTx(
    ctx: TenantContext,
    id: string,
    settings: DataRoomQaSettings,
    act: (tx: Tx, q: QaQuestion) => Promise<QaQuestion>,
  ): Promise<QaInboxDetail> {
    return db.withTenant(ctx, async (tx) => {
      const q = await lockOr404(ctx, tx, id);
      // THE Q&A lock order, for every write path (the SLA sweep, erasure, document / folder
      // purge and the settings PATCH follow it too) — the global order (E3.5 LX) with the
      // question rows in front:
      //   question row(s) FOR UPDATE (by id) → workspace row FOR NO KEY UPDATE → search entries
      //   → audit chain (advisory lock, every audit insert) → outbox insert (FK: FOR KEY SHARE
      //   on the workspace row, which NO KEY UPDATE does not conflict with).
      // The workspace row is taken here, right after the question row, and it is also taken by
      // every search write and every audit (`lockWorkspaceRow` / `lockAuditChain`) — so the
      // order holds structurally. Never FOR SHARE: auditing upgrades it to NO KEY UPDATE, and
      // two staff actions both holding SHARE would wait for each other's upgrade (a deadlock).
      await qaSearchEnabled(tx, ctx, "lock");
      // An erased asker's question is a tombstone: nothing reopens, answers or releases it.
      if (q.closedReason === "erased")
        throw new QaError("conflict", "the asker's data was erased", { reason: "erased" });
      const next = await act(tx, q);
      return buildDetail(ctx, tx, next, settings);
    });
  }

  function cursorOr400(raw: string | undefined): QaCursor | undefined {
    if (raw === undefined) return undefined;
    const c = decodeQaCursor(raw);
    if (c === undefined)
      throw new QaError("validation_failed", "malformed cursor", { reason: "cursor" });
    return c;
  }

  return {
    // =============================================================================================
    // Investor
    // =============================================================================================

    async ask(ctx, caller, input, settings, actor) {
      if (caller.kind !== "external")
        throw new QaError("forbidden", "staff add questions from the inbox", {
          reason: "not_an_investor",
        });
      if (caller.isDelegate)
        throw new QaError("forbidden", "a delegate cannot ask questions", {
          reason: "delegate_read_only",
        });
      if (input.targetKind === "folder" && !settings.allowFolderQuestions)
        throw new QaError("validation_failed", "questions about folders are turned off", {
          reason: "folder_questions_disabled",
        });
      const target = await liveTarget(ctx.workspaceId, input.targetKind, input.targetId);
      if (target === undefined) throw new QaError("not_found", `no such ${input.targetKind}`);
      const decision = await checkTarget(ctx, caller, target);
      if (!decision.allowed) refuse(decision, `no such ${input.targetKind}`);
      const createdAt = now();
      try {
        return await db.withTenant(ctx, async (tx) => {
          const repo = new QaQuestionRepo(ctx, tx);
          await repo.lockAsker(caller.membershipId);
          if ((await repo.countOpenByAsker(caller.membershipId)) >= settings.maxOpenPerAsker)
            throw new QaError("conflict", "too many questions are waiting for an answer", {
              reason: "too_many_open",
            });
          const since = new Date(createdAt.getTime() - DAY_MS);
          if ((await repo.countAskedSince(caller.membershipId, since)) >= QA_MAX_ASKS_PER_DAY)
            throw new QaError("rate_limited", "too many questions today; try again tomorrow");
          const q = await repo.create({
            targetKind: input.targetKind,
            documentId: input.targetKind === "document" ? input.targetId : null,
            folderId: input.targetKind === "folder" ? input.targetId : null,
            askerMembershipId: caller.membershipId,
            source: "portal",
            status: nextStatus(null, "ask") ?? "open",
            subject: input.subject,
            body: input.body,
            // `created_at` (now()) and `due_at` (created_at + qa.slaHours, read from the
            // workspace settings) are the qa_question_external_insert_guard trigger's: an
            // external INSERT may not choose either.
            createdBy: caller.membershipId,
          });
          await auditQa(tx, ctx, actor, "qa.question_asked", q.id, {
            targetKind: q.targetKind,
            targetId: input.targetId,
            source: "portal",
          });
          await publish(tx, ctx, "qa.question_asked", {
            questionId: q.id,
            targetKind: q.targetKind,
            targetId: input.targetId,
            askerMembershipId: caller.membershipId,
          });
          const [view] = await project(ctx, tx, caller, [q]);
          if (view === undefined) throw new QaError("not_found", "no such question");
          return view;
        });
      } catch (error) {
        // RLS refused the insert: the target stopped being viewable between check and write.
        if (pgErrorCode(error) === "42501")
          throw new QaError("not_found", `no such ${input.targetKind}`);
        throw error;
      }
    },

    async list(ctx, caller, query) {
      const cursor = cursorOr400(query.cursor);
      const target =
        query.targetKind !== undefined && query.targetId !== undefined
          ? { kind: query.targetKind, id: query.targetId }
          : undefined;
      if (query.scope === "target") {
        // Same answer for "no such target", "binned", "not yours to view" and "gated": an empty
        // page — the list must not tell a stranger which targets exist.
        if (target === undefined) return { items: [], nextCursor: null };
        const t = await liveTarget(ctx.workspaceId, target.kind, target.id);
        if (t === undefined) return { items: [], nextCursor: null };
        const decision = await checkTarget(ctx, caller, t);
        if (!decision.allowed) return { items: [], nextCursor: null };
      }
      return db.withTenant(ctx, async (tx) => {
        const rows = await new QaQuestionRepo(ctx, tx).listForViewer({
          membershipId: caller.membershipId,
          isDelegate: caller.isDelegate,
          scope: query.scope,
          target,
          cursor,
          limit: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        const items = await project(
          ctx,
          tx,
          caller,
          page.map((r) => r.question),
        );
        const last = page.at(-1);
        return {
          items,
          nextCursor:
            rows.length > query.limit && last
              ? encodeQaCursor({ createdAt: last.cursor, id: last.question.id })
              : null,
        };
      });
    },

    async get(ctx, caller, id) {
      const found = await db.withTenant(ctx, async (tx) => {
        const q = await new QaQuestionRepo(ctx, tx).visibleById(id, caller);
        if (q === undefined) return undefined;
        const [view] = await project(ctx, tx, caller, [q]);
        return view === undefined ? undefined : { q, view };
      });
      if (found === undefined) throw new QaError("not_found", "no such question");
      // Someone else's published question is the target's content: RLS's has_access knows
      // grants but not gates (NDA, …), so the full check runs here — outside the transaction,
      // exactly as for the document itself (none → 404, gated → 403 with the pending gates).
      if (!isMine(found.q, caller)) {
        const t = await liveTarget(ctx.workspaceId, found.q.targetKind, targetIdOf(found.q));
        if (t === undefined) throw new QaError("not_found", "no such question");
        const decision = await checkTarget(ctx, caller, t);
        if (!decision.allowed) refuse(decision, "no such question");
      }
      return found.view;
    },

    async withdraw(ctx, caller, id, actor) {
      if (caller.isDelegate)
        throw new QaError("forbidden", "a delegate cannot withdraw questions", {
          reason: "delegate_read_only",
        });
      return db
        .withTenant(ctx, async (tx) => {
          const repo = new QaQuestionRepo(ctx, tx);
          const visible = await repo.visibleById(id, caller);
          // Someone else's (published) question looks exactly like a missing one here.
          if (visible === undefined || visible.askerMembershipId !== caller.membershipId)
            throw new QaError("not_found", "no such question");
          const q = await lockOr404(ctx, tx, id);
          const to = nextStatus(q.status, "withdraw");
          if (to === null)
            throw new QaError(
              "conflict",
              q.status === "closed" ? "the question is closed" : "the answer was already released",
              q.status === "closed" ? { reason: "closed" } : {},
            );
          const at = now();
          const next = await updateQ(ctx, tx, id, {
            status: to,
            closedReason: "withdrawn",
            closedAt: at,
          });
          await auditQa(tx, ctx, actor, "qa.question_withdrawn", id, { from: q.status });
          const [view] = await project(ctx, tx, caller, [next]);
          if (view === undefined) throw new QaError("not_found", "no such question");
          return view;
        })
        .catch((error: unknown) => {
          // RLS / the external guard refused the write (the rules above should have caught it
          // first): a conflict, never a 500 — and no more detail than the checks above give.
          if (pgErrorCode(error) === "42501")
            throw new QaError("conflict", "the question can no longer be withdrawn");
          throw error;
        });
    },

    // =============================================================================================
    // Staff
    // =============================================================================================

    async inbox(ctx, me, query, settings) {
      const cursor = cursorOr400(query.cursor);
      const at = now();
      return db.withTenant(ctx, async (tx) => {
        const repo = new QaQuestionRepo(ctx, tx);
        const rows = await repo.inbox(
          {
            status: query.status,
            assignee: query.assignee === "me" ? me : query.assignee,
            targetKind: query.targetKind,
            targetId: query.targetId,
            overdueAt: query.overdue === "true" ? at : undefined,
          },
          cursor,
          query.limit + 1,
        );
        const page = rows.slice(0, query.limit);
        const ids = page.flatMap((r) =>
          [r.question.askerMembershipId, r.question.assigneeMembershipId].filter(
            (x): x is string => x !== null,
          ),
        );
        const names = await new MembershipRepo(ctx, tx).namesFor([...new Set(ids)]);
        const nameOf = (id: string | null) =>
          id === null ? null : (names.get(id)?.displayName ?? null);
        const items: QaInboxItem[] = page.map((r) => ({
          id: r.question.id,
          subject: r.question.subject,
          target: {
            kind: r.question.targetKind,
            id: targetIdOf(r.question),
            title: r.title ?? "",
          },
          askerName: nameOf(r.question.askerMembershipId),
          assigneeName: nameOf(r.question.assigneeMembershipId),
          status: r.question.status,
          dueAt: iso(r.question.dueAt),
          sla: slaState(r.question.dueAt, at, settings.reminderLeadHours, r.question.status),
          createdAt: r.question.createdAt.toISOString(),
          hasDraft: r.hasDraft,
        }));
        const last = page.at(-1);
        return {
          items,
          nextCursor:
            rows.length > query.limit && last
              ? encodeQaCursor({ createdAt: last.cursor, id: last.question.id })
              : null,
          counts: await repo.counts(),
        };
      });
    },

    detail(ctx, id, settings) {
      return db.withTenant(ctx, async (tx) => {
        const q = await new QaQuestionRepo(ctx, tx).byId(id);
        if (q === undefined) throw new QaError("not_found", "no such question");
        return buildDetail(ctx, tx, q, settings);
      });
    },

    async create(ctx, input, actor, settings) {
      return db.withTenant(ctx, async (tx) => {
        const t = await new QaTargetRepo(ctx, tx).one(input.targetKind, input.targetId, true);
        if (t === undefined) throw new QaError("not_found", `no such ${input.targetKind}`);
        const q = await new QaQuestionRepo(ctx, tx).create({
          targetKind: input.targetKind,
          documentId: input.targetKind === "document" ? input.targetId : null,
          folderId: input.targetKind === "folder" ? input.targetId : null,
          askerMembershipId: null,
          source: "staff",
          status: "assigned",
          subject: input.subject,
          body: input.body,
          assigneeMembershipId: actor.membershipId,
          createdBy: actor.membershipId,
          createdAt: now(),
        });
        await new QaAnswerRepo(ctx, tx).create({
          questionId: q.id,
          body: input.answer,
          authorMembershipId: actor.membershipId,
        });
        await auditQa(tx, ctx, actor, "qa.question_asked", q.id, {
          targetKind: q.targetKind,
          targetId: input.targetId,
          source: "staff",
        });
        await auditQa(tx, ctx, actor, "qa.answer_saved", q.id, { created: true });
        return buildDetail(ctx, tx, q, settings);
      });
    },

    patch(ctx, id, input, actor, settings) {
      return staffTx(ctx, id, settings, async (tx, q) => {
        const patch: Parameters<QaQuestionRepo["update"]>[1] = {};
        const fields: string[] = [];
        if (input.category !== undefined) {
          patch.category = input.category;
          fields.push("category");
        }
        if (input.internalNote !== undefined) {
          patch.internalNote = input.internalNote === "" ? null : input.internalNote;
          fields.push("internalNote");
        }
        if (input.publicText !== undefined) {
          if (input.publicText === null && q.status === "published")
            throw new QaError("validation_failed", "a published question needs its public text", {
              reason: "public_text_required",
            });
          patch.publicText = input.publicText;
          fields.push("publicText");
        }
        if (input.dueAt !== undefined) {
          patch.dueAt = input.dueAt === null ? null : new Date(input.dueAt);
          // a new due time re-arms the SLA reminders
          patch.dueSoonNotifiedAt = null;
          patch.overdueNotifiedAt = null;
          fields.push("dueAt");
        }
        if (fields.length === 0) return q;
        const next = await updateQ(ctx, tx, q.id, patch);
        // entries before the audit chain (lock order, see staffTx)
        if (next.status === "published" && fields.includes("publicText"))
          await indexQuestion(services, tx, ctx, q.id);
        await auditQa(tx, ctx, actor, "qa.question_edited", q.id, { fields });
        return next;
      });
    },

    async assign(ctx, id, assigneeMembershipId, actor, settings) {
      return staffTx(ctx, id, settings, async (tx, q) => {
        if (assigneeMembershipId !== null) {
          const m = await new MembershipRepo(ctx, tx).byId(assigneeMembershipId);
          if (m === undefined || !services.authz.hasPermission(m, "data-room.qa_answer"))
            throw new QaError("validation_failed", "the assignee cannot answer questions", {
              reason: "invalid_assignee",
            });
        }
        const action = assigneeMembershipId === null ? "unassign" : "assign";
        const to = transition(q, action, { hasAssignee: assigneeMembershipId !== null });
        if (q.assigneeMembershipId === assigneeMembershipId && to === q.status) return q;
        // Assigning never touches the due time: ask and reopen set it, staff may clear it.
        const next = await updateQ(ctx, tx, q.id, { assigneeMembershipId, status: to });
        await auditQa(
          tx,
          ctx,
          actor,
          "qa.question_assigned",
          q.id,
          { from: q.assigneeMembershipId, to: assigneeMembershipId },
          assigneeMembershipId,
        );
        await publish(tx, ctx, "qa.question_assigned", {
          questionId: q.id,
          assigneeMembershipId,
          actorMembershipId: actor.membershipId,
        });
        return next;
      });
    },

    saveAnswer(ctx, id, body, actor, settings) {
      return staffTx(ctx, id, settings, async (tx, q) => {
        transition(q, "save_answer");
        const answers = new QaAnswerRepo(ctx, tx);
        const existing = await answers.forQuestion(q.id);
        if (existing === undefined) {
          await answers.create({ questionId: q.id, body, authorMembershipId: actor.membershipId });
          await auditQa(tx, ctx, actor, "qa.answer_saved", q.id, { created: true });
        } else if (existing.body !== body) {
          const hadApproval = existing.approvedAt !== null;
          // Four-eyes: a released answer must never show text nobody approved. Under
          // requireApproval a changed release goes offline until it is submitted, approved and
          // released again; without it the release stands with the new text.
          const review = settings.requireApproval && isReleased(q.status);
          await answers.update(existing.id, {
            body,
            // whoever wrote the current text is its author for four-eyes
            authorMembershipId: actor.membershipId,
            approvedBy: null,
            approvedAt: null,
            approvedBodySha256: null,
            ...(review ? { submittedAt: null } : {}),
          });
          let next = q;
          if (review) {
            // released_at / published_at stay as history; visibility says "not released". Back
            // in the queue it owes its asker a fresh SLA and fresh reminders, as on reopen.
            next = await updateQ(ctx, tx, q.id, {
              status: transition(q, "withdraw_for_review"),
              visibility: null,
              dueAt: hasAsker(q) ? dueAtFor(now(), settings.slaHours) : null,
              dueSoonNotifiedAt: null,
              overdueNotifiedAt: null,
            });
          }
          // entries before the audit chain (lock order, see staffTx)
          if (review || q.status === "published") await indexQuestion(services, tx, ctx, q.id);
          await auditQa(tx, ctx, actor, "qa.answer_saved", q.id, {
            created: false,
            released: isReleased(q.status),
            approvalCleared: hadApproval,
          });
          if (review)
            await auditQa(
              tx,
              ctx,
              actor,
              "qa.answer_withdrawn_for_review",
              q.id,
              { from: q.status, to: next.status },
              q.askerMembershipId,
            );
          return next;
        }
        return q;
      });
    },

    submit(ctx, id, actor, settings) {
      if (!settings.requireApproval)
        return Promise.reject(
          new QaError("conflict", "this workspace does not require approval", {
            reason: "approval_not_required",
          }),
        );
      return staffTx(ctx, id, settings, async (tx, q) => {
        const answers = new QaAnswerRepo(ctx, tx);
        const answer = await answers.forQuestion(q.id);
        if (answer === undefined)
          throw new QaError("conflict", "write an answer first", { reason: "nothing_to_approve" });
        const to = transition(q, "submit");
        await answers.update(answer.id, { submittedAt: now(), rejectedNote: null });
        const next = await updateQ(ctx, tx, q.id, { status: to });
        await auditQa(tx, ctx, actor, "qa.answer_submitted", q.id);
        await publish(tx, ctx, "qa.answer_submitted", {
          questionId: q.id,
          actorMembershipId: actor.membershipId,
        });
        return next;
      });
    },

    approve(ctx, id, actor, settings) {
      return staffTx(ctx, id, settings, async (tx, q) => {
        const answers = new QaAnswerRepo(ctx, tx);
        const answer = await answers.forQuestion(q.id);
        if (answer === undefined || nextStatus(q.status, "approve") === null)
          throw new QaError("conflict", "there is nothing to approve", {
            reason: q.status === "closed" ? "closed" : "nothing_to_approve",
          });
        if (approvalCurrent(answer))
          throw new QaError("conflict", "this answer is already approved", {
            reason: "nothing_to_approve",
          });
        if (answer.authorMembershipId === actor.membershipId)
          throw new QaError("conflict", "someone else must approve your answer", {
            reason: "self_approval",
          });
        await answers.update(answer.id, {
          approvedBy: actor.membershipId,
          approvedAt: now(),
          approvedBodySha256: sha256Hex(answer.body),
          rejectedNote: null,
        });
        await auditQa(tx, ctx, actor, "qa.answer_approved", q.id);
        return q;
      });
    },

    reject(ctx, id, note, actor, settings) {
      return staffTx(ctx, id, settings, async (tx, q) => {
        const to = transition(q, "reject");
        const answers = new QaAnswerRepo(ctx, tx);
        const answer = await answers.forQuestion(q.id);
        if (answer !== undefined)
          await answers.update(answer.id, {
            rejectedNote: note,
            submittedAt: null,
            approvedBy: null,
            approvedAt: null,
            approvedBodySha256: null,
          });
        const next = await updateQ(ctx, tx, q.id, { status: to });
        await auditQa(tx, ctx, actor, "qa.answer_rejected", q.id);
        return next;
      });
    },

    release(ctx, id, input, actor, settings) {
      return staffTx(ctx, id, settings, async (tx, q) => {
        const visibility: QaVisibility =
          input.visibility ??
          (settings.defaultVisibility === "asker" && !hasAsker(q)
            ? "target"
            : settings.defaultVisibility);
        if (visibility === "asker" && !hasAsker(q))
          throw new QaError("validation_failed", "this question has no asker to answer", {
            reason: "no_asker",
          });
        const answer = await new QaAnswerRepo(ctx, tx).forQuestion(q.id);
        if (answer === undefined)
          throw new QaError("conflict", "write an answer first", { reason: "nothing_to_approve" });
        const to = transition(q, visibility === "asker" ? "release_asker" : "release_target");
        if (settings.requireApproval && !approvalCurrent(answer))
          throw new QaError("conflict", "the answer needs a current approval", {
            reason: "approval_required",
          });
        const at = now();
        const next = await updateQ(ctx, tx, q.id, {
          status: to,
          visibility,
          releasedAt: at,
          firstReleasedAt: q.firstReleasedAt ?? at,
          ...(visibility === "target"
            ? {
                publishedAt: at,
                publicText:
                  input.publicText ?? q.publicText ?? defaultPublicText(q.subject, q.body),
              }
            : {}),
        });
        // entries before the audit chain (lock order, see staffTx)
        if (to === "published") await indexQuestion(services, tx, ctx, q.id);
        await auditQa(
          tx,
          ctx,
          actor,
          "qa.answer_released",
          q.id,
          { visibility, from: q.status },
          q.askerMembershipId,
        );
        await publish(tx, ctx, "qa.answer_released", {
          questionId: q.id,
          visibility,
          askerMembershipId: q.askerMembershipId,
        });
        return next;
      });
    },

    unpublish(ctx, id, actor, settings) {
      return staffTx(ctx, id, settings, async (tx, q) => {
        const to = transition(q, "unpublish");
        const next = await updateQ(ctx, tx, q.id, {
          status: to,
          publishedAt: null,
          ...(to === "answered" ? { visibility: "asker" } : { visibility: null, releasedAt: null }),
        });
        await indexQuestion(services, tx, ctx, q.id); // before the audit (lock order)
        await auditQa(tx, ctx, actor, "qa.answer_unpublished", q.id, { to });
        return next;
      });
    },

    close(ctx, id, input, actor, settings) {
      return staffTx(ctx, id, settings, async (tx, q) => {
        const to = transition(q, "close");
        const next = await updateQ(ctx, tx, q.id, {
          status: to,
          closedReason: input.reason,
          closedAt: now(),
        });
        // entries before the audit chain (lock order, see staffTx)
        if (q.status === "published") await indexQuestion(services, tx, ctx, q.id);
        await auditQa(
          tx,
          ctx,
          actor,
          "qa.question_closed",
          q.id,
          { reason: input.reason, notifyAsker: input.notifyAsker, from: q.status },
          q.askerMembershipId,
        );
        if (input.notifyAsker && q.askerMembershipId !== null && hasAsker(q)) {
          const asker = await new MembershipRepo(ctx, tx).byId(q.askerMembershipId);
          if (asker !== undefined && asker.status !== "revoked")
            await publish(tx, ctx, "qa.question_declined", {
              questionId: q.id,
              askerMembershipId: q.askerMembershipId,
            });
        }
        return next;
      });
    },

    reopen(ctx, id, actor, settings) {
      return staffTx(ctx, id, settings, async (tx, q) => {
        // the asker took it back; staff may not put words back in their mouth
        if (q.closedReason === "withdrawn")
          throw new QaError("conflict", "the asker withdrew this question", {
            reason: "withdrawn",
          });
        const to = transition(q, "reopen");
        const next = await updateQ(ctx, tx, q.id, {
          status: to,
          closedReason: null,
          closedAt: null,
          visibility: null,
          releasedAt: null,
          publishedAt: null,
          // a reopened question owes its asker a fresh SLA (and fresh reminders)
          dueAt: hasAsker(q) ? dueAtFor(now(), settings.slaHours) : null,
          dueSoonNotifiedAt: null,
          overdueNotifiedAt: null,
        });
        await indexQuestion(services, tx, ctx, q.id); // before the audit (lock order)
        await auditQa(tx, ctx, actor, "qa.question_reopened", q.id, { to });
        return next;
      });
    },
  };
}
