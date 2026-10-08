import {
  ApiError,
  ai,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  requestIdOf,
  sessionOrApiKeySecurity,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import { type DataRoomQaSettings, parseWorkspaceSettings } from "@fundroom/domain";
import type { ModuleEnv, ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import type { Context } from "hono";
import type { Actor } from "../errors.js";
import { startQaSuggestion } from "./ai/start.js";
import {
  QaAnswerBody,
  QaAskBody,
  QaAssignBody,
  QaCloseBody,
  QaIdParams,
  QaInboxDetailSchema,
  QaInboxPageSchema,
  QaInboxPatchBody,
  QaInboxQuery,
  QaQuestionPageSchema,
  QaQuestionsQuery,
  QaQuestionViewSchema,
  QaRejectBody,
  QaReleaseBody,
  QaStaffCreateBody,
  QaStatusSchema,
} from "./contracts.js";
import { createQaService, type QaCaller, QaError, type QaService } from "./service.js";

/*
 * `/api/v1/data-room/qa/*` (E3.3 D6, ADR-0051) — every route but `/qa/export` and `/qa/import`
 * (`io-routes.ts`).
 *
 * Investor side (`member`): answers 404 while `settings.dataRoom.qa.enabled` is off, except
 * `GET /qa/status`. What an external member reads is decided by RLS (rows) and the service's
 * projection (columns); a staff member calling these gets the same investor-shaped view of their
 * own questions. Staff side: the inbox (`data-room.read`) and the workflow (`qa_answer`,
 * `qa_approve`, `qa_manage`), whether or not Q&A is enabled, so staff can prepare first.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500);
/** The AI suggestion route: the AI kernel answers 402 `plan_limit` without the `ai` feature (A-3). */
const AI_ERRORS = errorResponses(400, 401, 402, 403, 404, 409, 429, 500);
const TAGS = ["data-room"];

interface Signed {
  /** Absent when an API key made the request (E3.4): the key acts as its creator. */
  readonly session?: NonNullable<ModuleEnv["Variables"]["session"]> | undefined;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<ModuleEnv["Variables"]["workspace"]>;
}

function signed(c: Context<ModuleEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if ((!session && !c.get("apiKey")) || !membership || !tenant || !workspace)
    throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

function rethrow(error: unknown): never {
  if (error instanceof QaError) throw new ApiError(error.code, error.message, error.details);
  throw error;
}

const qaSettingsOf = (sg: Signed): DataRoomQaSettings =>
  parseWorkspaceSettings(sg.workspace.settings).dataRoom.qa;

export function registerQaRoutes(api: ModuleRouter, services: ModuleServices): void {
  let service: QaService | undefined;
  const qa = () => {
    service ??= createQaService(services);
    return service;
  };
  const perm = (p: string) => services.guards.requirePermission(p);
  /** An `apiKey: true` matrix row (E3.4): a workspace API key holding `p` may call it too. */
  const keyPerm = (p: string) => services.guards.requirePermission(p, { apiKey: true });
  const member = () => services.guards.requireMember();

  const callerOf = (c: Context<ModuleEnv>, sg: Signed): QaCaller => ({
    membershipId: sg.membership.id,
    kind: sg.membership.kind,
    isDelegate: sg.membership.role === "delegate",
    facts: services.requestFacts(c),
  });
  const actorOf = (c: Context<ModuleEnv>, sg: Signed): Actor => ({
    membershipId: sg.membership.id,
    requestId: requestIdOf(c),
    sessionId: sg.session?.sessionId,
    apiKeyId: c.get("apiKey")?.id,
    ip: services.clientIp(c),
  });

  /** Investor routes: 404 while Q&A is off (indistinguishable from a route that is not there). */
  function investor(c: Context<ModuleEnv>): { sg: Signed; settings: DataRoomQaSettings } {
    const sg = signed(c);
    const settings = qaSettingsOf(sg);
    if (!settings.enabled) throw new ApiError("not_found", "Q&A is not available");
    return { sg, settings };
  }

  /** Nothing is written in an investor's name while staff view the portal as them (E2.7). */
  function refuseViewAs(c: Context<ModuleEnv>): void {
    if (c.get("viewAs") !== undefined)
      throw new ApiError(
        "view_as_read_only",
        "questions cannot be asked while viewing as an investor",
      );
  }

  // ===============================================================================================
  // Investor
  // ===============================================================================================

  api.openapi(
    createRoute({
      method: "get",
      path: "/qa/status",
      tags: TAGS,
      summary: "Whether data-room Q&A is on here, and whether this member may ask",
      description:
        "Never 404: `enabled: false` while the workspace has Q&A off. `canAsk` is true for an external investor (not a delegate) while Q&A is on.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: { 200: jsonResponse(QaStatusSchema, "Status"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const settings = qaSettingsOf(sg);
      return c.json(
        {
          enabled: settings.enabled,
          canAsk:
            settings.enabled &&
            sg.membership.kind === "external" &&
            sg.membership.role !== "delegate",
          allowFolderQuestions: settings.allowFolderQuestions,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/qa/questions",
      tags: TAGS,
      summary: "My questions, or the questions visible on one document or folder",
      description:
        "`scope=mine`: the caller's own questions in any status. `scope=target` (needs `targetKind` + `targetId`): the answers published on that target plus the caller's own questions on it; an unknown, binned or not-viewable target answers an empty page. Another investor's question is only ever shown as its published wording and answer — never its asker, subject or body. 404 while Q&A is off.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { query: QaQuestionsQuery },
      responses: { 200: jsonResponse(QaQuestionPageSchema, "Questions"), ...ERRORS },
    }),
    async (c) => {
      const { sg } = investor(c);
      try {
        return c.json(await qa().list(sg.tenant, callerOf(c, sg), c.req.valid("query")), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/qa/questions",
      tags: TAGS,
      summary: "Ask a question about a document or folder you can view",
      description:
        "External investors only (staff use `POST /qa/inbox`: 403 `not_an_investor`; delegates: 403 `delegate_read_only`). The target must be viewable: gated → 403 with `pendingGates`, otherwise 404. Folder questions can be turned off (400 `folder_questions_disabled`). At most `maxOpenPerAsker` unanswered questions (409 `too_many_open`) and 20 asks per 24 hours (429). The SLA clock starts now. 404 while Q&A is off.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { body: jsonBody(QaAskBody) },
      responses: { 201: jsonResponse(QaQuestionViewSchema, "Asked"), ...ERRORS },
    }),
    async (c) => {
      const { sg, settings } = investor(c);
      refuseViewAs(c);
      try {
        const view = await qa().ask(
          sg.tenant,
          callerOf(c, sg),
          c.req.valid("json"),
          settings,
          actorOf(c, sg),
        );
        return c.json(view, 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/qa/questions/{id}",
      tags: TAGS,
      summary: "One question as this member may see it",
      description:
        "The caller's own question, or a published one on a target the caller can view now: no access → 404; the target's access requirements pending (e.g. an NDA) → 403 with `pendingGates`. 404 while Q&A is off.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: QaIdParams },
      responses: { 200: jsonResponse(QaQuestionViewSchema, "Question"), ...ERRORS },
    }),
    async (c) => {
      const { sg } = investor(c);
      try {
        return c.json(await qa().get(sg.tenant, callerOf(c, sg), c.req.valid("param").id), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/qa/questions/{id}/withdraw",
      tags: TAGS,
      summary: "Withdraw my question (only before it is answered)",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: QaIdParams },
      responses: { 200: jsonResponse(QaQuestionViewSchema, "Withdrawn"), ...ERRORS },
    }),
    async (c) => {
      const { sg } = investor(c);
      refuseViewAs(c);
      try {
        return c.json(
          await qa().withdraw(sg.tenant, callerOf(c, sg), c.req.valid("param").id, actorOf(c, sg)),
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // ===============================================================================================
  // Staff inbox
  // ===============================================================================================

  api.openapi(
    createRoute({
      method: "get",
      path: "/qa/inbox",
      tags: TAGS,
      summary: "The Q&A inbox: questions with filters, SLA state and a count per status",
      security: sessionOrApiKeySecurity,
      "x-requires": "data-room.read+apikey",
      middleware: [keyPerm("data-room.read")] as const,
      request: { query: QaInboxQuery },
      responses: { 200: jsonResponse(QaInboxPageSchema, "Inbox"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          await qa().inbox(sg.tenant, sg.membership.id, c.req.valid("query"), qaSettingsOf(sg)),
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/qa/inbox",
      tags: TAGS,
      summary: "Add a staff-authored question with a draft answer (an FAQ entry)",
      description:
        "Source `staff`, no asker, assigned to its author with the answer drafted; release it separately (to the target's audience — there is no asker to answer privately).",
      security: sessionOrApiKeySecurity,
      "x-requires": "data-room.qa_manage+apikey",
      middleware: [keyPerm("data-room.qa_manage")] as const,
      request: { body: jsonBody(QaStaffCreateBody) },
      responses: { 201: jsonResponse(QaInboxDetailSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          await qa().create(sg.tenant, c.req.valid("json"), actorOf(c, sg), qaSettingsOf(sg)),
          201,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/qa/inbox/{id}",
      tags: TAGS,
      summary: "One question with everything staff see: asker, target, notes, draft, approval",
      security: sessionOrApiKeySecurity,
      "x-requires": "data-room.read+apikey",
      middleware: [keyPerm("data-room.read")] as const,
      request: { params: QaIdParams },
      responses: { 200: jsonResponse(QaInboxDetailSchema, "Question"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(await qa().detail(sg.tenant, c.req.valid("param").id, qaSettingsOf(sg)), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/qa/inbox/{id}",
      tags: TAGS,
      summary: "Edit a question's category, internal note, public wording or due time",
      security: sessionSecurity,
      "x-requires": "data-room.qa_manage",
      middleware: [perm("data-room.qa_manage")] as const,
      request: { params: QaIdParams, body: jsonBody(QaInboxPatchBody) },
      responses: { 200: jsonResponse(QaInboxDetailSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          await qa().patch(
            sg.tenant,
            c.req.valid("param").id,
            c.req.valid("json"),
            actorOf(c, sg),
            qaSettingsOf(sg),
          ),
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/qa/inbox/{id}/assign",
      tags: TAGS,
      summary: "Assign a question to an answerer (null unassigns)",
      description:
        "The assignee must be an active staff member holding `data-room.qa_answer` (400 `invalid_assignee`). Sets the due time from the SLA if it has none.",
      security: sessionSecurity,
      "x-requires": "data-room.qa_manage",
      middleware: [perm("data-room.qa_manage")] as const,
      request: { params: QaIdParams, body: jsonBody(QaAssignBody) },
      responses: { 200: jsonResponse(QaInboxDetailSchema, "Assigned"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          await qa().assign(
            sg.tenant,
            c.req.valid("param").id,
            c.req.valid("json").assigneeMembershipId,
            actorOf(c, sg),
            qaSettingsOf(sg),
          ),
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/qa/inbox/{id}/answer",
      tags: TAGS,
      summary: "Write or edit the answer (clears any approval when the text changes)",
      description:
        "Allowed until the question is closed (409 `closed`; `erased` for an erased asker's question), including on a released answer. A changed text clears any approval. Without four-eyes approval the release stands (a published answer is re-indexed). With `requireApproval` on, a changed released answer is taken offline — back to `assigned` (or `open` with no assignee), unpublished — until it is submitted, approved and released again; the response carries the new status.",
      security: sessionSecurity,
      "x-requires": "data-room.qa_answer",
      middleware: [perm("data-room.qa_answer")] as const,
      request: { params: QaIdParams, body: jsonBody(QaAnswerBody) },
      responses: { 200: jsonResponse(QaInboxDetailSchema, "Saved"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          await qa().saveAnswer(
            sg.tenant,
            c.req.valid("param").id,
            c.req.valid("json").body,
            actorOf(c, sg),
            qaSettingsOf(sg),
          ),
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // E3.12: a suggested answer from AI assist (the `qa_answer` task in `./ai/task.ts`).
  api.openapi(
    createRoute({
      method: "post",
      path: "/qa/inbox/{id}/ai-suggestion",
      tags: TAGS,
      summary: "Ask AI assist to suggest an answer from the data room",
      description:
        'Starts (or reuses your in-flight) AI request for an answer drawn only from documents the asker may view, with page citations checked against the passages sent. Poll `GET /ai/requests/{id}`; nothing is saved until you save an answer (which makes you its author, so four-eyes approval still applies). 404 for an unknown or erased question. 409 `ai_unavailable` / `ai_disabled` / `ai_acknowledgement_required`; 429 `ai_rate_limited` / `ai_busy` / `ai_budget_exhausted`. 402 `plan_limit` (`feature: "ai"`) when the workspace\'s plan does not include AI.',
      security: sessionSecurity,
      "x-requires": "data-room.qa_answer",
      middleware: [perm("data-room.qa_answer")] as const,
      request: { params: QaIdParams },
      responses: { 202: jsonResponse(ai.AiStartedSchema, "Started"), ...AI_ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const started = await startQaSuggestion(services, sg.tenant, c.req.valid("param").id, {
        membershipId: sg.membership.id,
        userId: sg.membership.userId,
      });
      return c.json(started, 202);
    },
  );

  const simple = (
    path: string,
    permission: string,
    summary: string,
    run: (sg: Signed, id: string, actor: Actor, settings: DataRoomQaSettings) => Promise<unknown>,
    description?: string,
  ) =>
    api.openapi(
      createRoute({
        method: "post",
        path,
        tags: TAGS,
        summary,
        ...(description === undefined ? {} : { description }),
        security: sessionSecurity,
        "x-requires": permission,
        middleware: [perm(permission)] as const,
        request: { params: QaIdParams },
        responses: { 200: jsonResponse(QaInboxDetailSchema, "Updated"), ...ERRORS },
      }),
      async (c) => {
        const sg = signed(c);
        try {
          const detail = await run(sg, c.req.valid("param").id, actorOf(c, sg), qaSettingsOf(sg));
          return c.json(detail as never, 200);
        } catch (error) {
          rethrow(error);
        }
      },
    );

  simple(
    "/qa/inbox/{id}/submit",
    "data-room.qa_answer",
    "Submit the answer for approval (workspaces that require four-eyes approval)",
    (sg, id, actor, settings) => qa().submit(sg.tenant, id, actor, settings),
    "409 `approval_not_required` when the workspace does not require approval; `nothing_to_approve` without an answer.",
  );

  simple(
    "/qa/inbox/{id}/approve",
    "data-room.qa_approve",
    "Approve the current answer text (never your own: 409 `self_approval`)",
    (sg, id, actor, settings) => qa().approve(sg.tenant, id, actor, settings),
    "Pins the approval to the SHA-256 of the text approved; editing the answer afterwards clears it.",
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/qa/inbox/{id}/reject",
      tags: TAGS,
      summary: "Send a submitted answer back with a note",
      security: sessionSecurity,
      "x-requires": "data-room.qa_approve",
      middleware: [perm("data-room.qa_approve")] as const,
      request: { params: QaIdParams, body: jsonBody(QaRejectBody) },
      responses: { 200: jsonResponse(QaInboxDetailSchema, "Rejected"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          await qa().reject(
            sg.tenant,
            c.req.valid("param").id,
            c.req.valid("json").note,
            actorOf(c, sg),
            qaSettingsOf(sg),
          ),
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/qa/inbox/{id}/release",
      tags: TAGS,
      summary: "Release the answer to the asker, or publish it to everyone who can view the target",
      description:
        "`asker`: only the asker sees it (400 `no_asker` for staff/imported entries). `target`: published with `publicText` (given, else the existing wording, else subject + body) to everyone who can view the target now. Without `visibility` the workspace's `qa.defaultVisibility` applies (`target` when that is `asker` and the question has no asker). Under four-eyes approval the current text must be approved (409 `approval_required`). An erased asker's question: 409 `erased`.",
      security: sessionSecurity,
      "x-requires": "data-room.qa_manage",
      middleware: [perm("data-room.qa_manage")] as const,
      request: { params: QaIdParams, body: jsonBody(QaReleaseBody) },
      responses: { 200: jsonResponse(QaInboxDetailSchema, "Released"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          await qa().release(
            sg.tenant,
            c.req.valid("param").id,
            c.req.valid("json"),
            actorOf(c, sg),
            qaSettingsOf(sg),
          ),
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  simple(
    "/qa/inbox/{id}/unpublish",
    "data-room.qa_manage",
    "Take a published answer back (the asker, if any, keeps it)",
    (sg, id, actor, settings) => qa().unpublish(sg.tenant, id, actor, settings),
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/qa/inbox/{id}/close",
      tags: TAGS,
      summary: "Decline and close a question",
      description:
        "`notifyAsker: true` emails the asker (if the question has one) that it was declined (`qa.question_declined`).",
      security: sessionSecurity,
      "x-requires": "data-room.qa_manage",
      middleware: [perm("data-room.qa_manage")] as const,
      request: { params: QaIdParams, body: jsonBody(QaCloseBody) },
      responses: { 200: jsonResponse(QaInboxDetailSchema, "Closed"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          await qa().close(
            sg.tenant,
            c.req.valid("param").id,
            c.req.valid("json"),
            actorOf(c, sg),
            qaSettingsOf(sg),
          ),
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  simple(
    "/qa/inbox/{id}/reopen",
    "data-room.qa_manage",
    "Reopen a closed question (back to open, or assigned when it has an assignee)",
    (sg, id, actor, settings) => qa().reopen(sg.tenant, id, actor, settings),
    "A question the asker withdrew stays closed (409 `withdrawn`), as does an erased asker's (409 `erased`). The SLA clock restarts from now for a question with an asker.",
  );
}
