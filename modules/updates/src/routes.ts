import {
  ApiError,
  ai,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  requestIdOf,
  sessionOrApiKeySecurity,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import { lockWorkspaceFacts, updateWorkspaceSettingsBlock } from "@fundroom/db";
import { parseWorkspaceSettings, WorkspaceSettingsSchema } from "@fundroom/domain";
import { MembershipRepo, maskEmail, sha256 } from "@fundroom/identity";
import {
  AiStartError,
  type ModuleEnv,
  type ModuleRouter,
  type ModuleServices,
} from "@fundroom/module-kit";
import type { Context } from "hono";
import * as s from "./contracts.js";
import { type Actor, UpdatesError } from "./errors.js";
import type { Reader } from "./model.js";
import { RecipientRepo, SendRepo } from "./repos/updates-repo.js";
import {
  createSendingDomainService,
  type SendingDomainService,
  type SendingDomainView,
} from "./service/domains.js";
import {
  createPostService,
  type PostDetail,
  type PostService,
  type PostSummary,
  type SendSummary,
  sendSummary,
} from "./service/posts.js";
import {
  createReplyService,
  type ReplyService,
  type Thread,
  type ThreadReply,
} from "./service/replies.js";
import { createSubscriptionService, type SubscriptionService } from "./service/subscriptions.js";
import { TEMPLATES } from "./templates.js";

/*
 * `/api/v1/updates/*` (E1.4). Staff routes mount the kernel guards from `ModuleServices`;
 * the archive, threads and the subscription switch are for every member; the unsubscribe
 * redemption is public-shaped (a signed token stands in for the session, RFC 8058).
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
/** `POST /ai/draft`: the AI kernel answers 402 `plan_limit` when the plan leaves AI out (A-3). */
const AI_ERRORS = errorResponses(400, 401, 402, 403, 404, 409, 429, 500, 503);
const TAGS = ["updates"];

type Vars = ModuleEnv["Variables"];
interface Signed {
  /** Absent when an API key made the request (E3.4): the key acts as its creator. */
  readonly session?: NonNullable<Vars["session"]> | undefined;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
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

const actorOf = (c: Context<ModuleEnv>, sg: Signed): Actor => ({
  membershipId: sg.membership.id,
  requestId: requestIdOf(c),
  sessionId: sg.session?.sessionId,
  apiKeyId: c.get("apiKey")?.id,
});

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function sendBody(x: SendSummary) {
  return {
    ...x,
    startedAt: iso(x.startedAt),
    finishedAt: iso(x.finishedAt),
    createdAt: x.createdAt.toISOString(),
  };
}

function postBody(p: PostSummary) {
  return {
    ...p,
    scheduledFor: iso(p.scheduledFor),
    sentAt: iso(p.sentAt),
    savedAt: p.savedAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    lastSend: p.lastSend ? sendBody(p.lastSend) : null,
  };
}

function detailBody(d: PostDetail) {
  return {
    post: postBody(d.post),
    doc: d.doc,
    visibility: d.visibility,
    groups: [...d.groups],
    versions: d.versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
  };
}

function replyBody(r: ThreadReply) {
  return { ...r, createdAt: r.createdAt.toISOString() };
}

function threadBody(t: Thread) {
  return {
    membershipId: t.membershipId,
    displayName: t.displayName,
    replies: t.replies.map(replyBody),
  };
}

function domainBody(d: SendingDomainView) {
  return {
    ...d,
    records: [...d.records],
    checks: {
      ...(d.checks.dkim ? { dkim: d.checks.dkim } : {}),
      ...(d.checks.spf ? { spf: d.checks.spf } : {}),
      ...(d.checks.dmarc ? { dmarc: d.checks.dmarc } : {}),
    },
    lastCheckedAt: iso(d.lastCheckedAt),
    verifiedAt: iso(d.verifiedAt),
    createdAt: d.createdAt.toISOString(),
  };
}

/** `AiStartError` → the API error of the same code (`Retry-After` when the kernel gives one). */
function aiStartApiError(error: unknown): unknown {
  if (!(error instanceof AiStartError)) return error;
  const headers: Record<string, string> =
    error.retryAfterMs === undefined
      ? {}
      : { "Retry-After": String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) };
  const message =
    error.code === "ai_unavailable" ? "AI assist is not configured on this install" : undefined;
  return new ApiError(error.code, message, {}, { headers });
}

function rethrow(error: unknown): never {
  if (error instanceof UpdatesError) throw new ApiError(error.code, error.message, error.details);
  throw error;
}

export function registerUpdatesRoutes(api: ModuleRouter, services: ModuleServices): void {
  let posts: PostService | undefined;
  let replies: ReplyService | undefined;
  let subscriptions: SubscriptionService | undefined;
  let domains: SendingDomainService | undefined;
  const postSvc = () => (posts ??= createPostService(services));
  const replySvc = () => (replies ??= createReplyService(services));
  const subSvc = () => (subscriptions ??= createSubscriptionService(services));
  const domainSvc = () => (domains ??= createSendingDomainService(services));
  const perm = (p: string, fresh = false) => services.guards.requirePermission(p, { fresh });
  /** An `apiKey: true` matrix row (E3.4): a workspace API key holding `p` may call it too. */
  const keyPerm = (p: string) => services.guards.requirePermission(p, { apiKey: true });
  const member = () => services.guards.requireMember();
  const facts = (c: Context<ModuleEnv>, sg: Signed) => ({
    authLevel: sg.session?.authLevel,
    ip: services.clientIp(c),
  });
  const readerOf = async (sg: Signed): Promise<Reader> =>
    sg.membership.kind === "staff"
      ? { kind: "staff", groupIds: [] }
      : {
          kind: "external",
          groupIds: await postSvc().groupIdsOf(sg.tenant, sg.membership.id),
          delegateScope: sg.membership.role === "delegate" ? sg.membership.delegateScope : null,
        };
  const canRead = (sg: Signed) => services.authz.hasPermission(sg.membership, "updates.read");

  // --- templates + posts (staff) --------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/templates",
      tags: TAGS,
      summary: "Update templates (YC, minimal, board, blank)",
      security: sessionSecurity,
      "x-requires": "updates.read",
      middleware: [perm("updates.read")] as const,
      responses: { 200: jsonResponse(s.TemplateListSchema, "Templates"), ...ERRORS },
    }),
    (c) => c.json({ templates: TEMPLATES.map((t) => ({ ...t, doc: t.doc })) }, 200),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/posts",
      tags: TAGS,
      summary: "List updates (drafts, scheduled, sent, archived)",
      security: sessionOrApiKeySecurity,
      "x-requires": "updates.read+apikey",
      middleware: [keyPerm("updates.read")] as const,
      responses: { 200: jsonResponse(s.PostListSchema, "Posts"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      return c.json({ posts: (await postSvc().list(sg.tenant)).map(postBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/posts",
      tags: TAGS,
      summary: "Create a draft update from a template",
      security: sessionSecurity,
      "x-requires": "updates.manage",
      middleware: [perm("updates.manage")] as const,
      request: { body: jsonBody(s.CreatePostBody) },
      responses: { 201: jsonResponse(s.PostDetailSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const d = await postSvc().create(sg.tenant, body, actorOf(c, sg));
        return c.json(detailBody(d), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // E3.12: starts the `update_draft` AI task (modules/updates/src/ai). Nothing is written to
  // the workspace's updates: the suggestion is stored on the kernel's request row.
  api.openapi(
    createRoute({
      method: "post",
      path: "/ai/draft",
      tags: TAGS,
      summary: "Ask AI assist for a draft update",
      description:
        "Starts (or reuses your in-flight) AI request for a draft built from your notes, the template's outline, the last sent update and — with the metrics module on — your KPIs. Poll `GET /ai/requests/{id}`; nothing is saved until you create a draft from the suggestion. 409 `ai_unavailable` / `ai_disabled` / `ai_acknowledgement_required`; 429 `ai_rate_limited` / `ai_busy` / `ai_budget_exhausted`. 402 `plan_limit` (`feature: \"ai\"`) when the workspace's plan does not include AI.",
      security: sessionSecurity,
      "x-requires": "updates.manage",
      middleware: [perm("updates.manage")] as const,
      request: { body: jsonBody(s.AiDraftBody) },
      responses: { 202: jsonResponse(ai.AiStartedSchema, "Started"), ...AI_ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const params = s.AiDraftBody.parse(c.req.valid("json"));
      // Outside any transaction (the kernel runs its own short ones); errors map 1:1.
      try {
        const started = await services.ai.start(sg.tenant, {
          feature: "update_draft",
          subjectId: null,
          params: { notes: params.notes, template: params.template },
          actor: { membershipId: sg.membership.id, userId: sg.membership.userId },
        });
        return c.json({ requestId: started.requestId }, 202);
      } catch (error) {
        throw aiStartApiError(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/posts/{id}",
      tags: TAGS,
      summary: "An update: draft document, section rules, audience, versions",
      security: sessionOrApiKeySecurity,
      "x-requires": "updates.read+apikey",
      middleware: [keyPerm("updates.read")] as const,
      request: { params: s.PostIdParams },
      responses: { 200: jsonResponse(s.PostDetailSchema, "Update"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(detailBody(await postSvc().get(sg.tenant, c.req.valid("param").id)), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/posts/{id}/draft",
      tags: TAGS,
      summary: "Save the draft (title, document, audience, section rules; autosave)",
      description:
        "Blocks are validated against the content block registry (no `hero`). Section rules of removed sections are dropped, new sections default to `authenticated`. Pass `baseSavedAt` to detect concurrent edits (409). Refused while the update is being sent.",
      security: sessionSecurity,
      "x-requires": "updates.manage",
      middleware: [perm("updates.manage")] as const,
      request: { params: s.PostIdParams, body: jsonBody(s.SaveDraftBody) },
      responses: { 200: jsonResponse(s.PostDetailSchema, "Saved"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const d = await postSvc().saveDraft(
          sg.tenant,
          c.req.valid("param").id,
          {
            title: body.title,
            doc: body.doc,
            audience: body.audience,
            visibility: body.visibility,
            baseSavedAt: body.baseSavedAt ? new Date(body.baseSavedAt) : undefined,
          },
          actorOf(c, sg),
        );
        return c.json(detailBody(d), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/posts/{id}",
      tags: TAGS,
      summary: "Delete an update (soft; versions and sends stay for the record)",
      security: sessionSecurity,
      "x-requires": "updates.manage+fresh",
      middleware: [perm("updates.manage", true)] as const,
      request: { params: s.PostIdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await postSvc().remove(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/posts/{id}/schedule",
      tags: TAGS,
      summary: "Schedule the update; the dispatcher sends it at that time",
      security: sessionSecurity,
      "x-requires": "updates.send",
      middleware: [perm("updates.send")] as const,
      request: { params: s.PostIdParams, body: jsonBody(s.ScheduleBody) },
      responses: { 200: jsonResponse(s.PostDetailSchema, "Scheduled"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const d = await postSvc().schedule(
          sg.tenant,
          c.req.valid("param").id,
          new Date(c.req.valid("json").scheduledFor),
          actorOf(c, sg),
        );
        return c.json(detailBody(d), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/posts/{id}/unschedule",
      tags: TAGS,
      summary: "Cancel a scheduled send (back to draft)",
      security: sessionSecurity,
      "x-requires": "updates.send",
      middleware: [perm("updates.send")] as const,
      request: { params: s.PostIdParams },
      responses: { 200: jsonResponse(s.PostDetailSchema, "Draft"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          detailBody(
            await postSvc().unschedule(sg.tenant, c.req.valid("param").id, actorOf(c, sg)),
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
      path: "/posts/{id}/send",
      tags: TAGS,
      summary: "Send now: publish an immutable version and fan out to the audience",
      description:
        "Creates the version investors see in the archive, queues `updates.send` and returns at once; poll the post (`lastSend`) or the sends list for progress.",
      security: sessionSecurity,
      "x-requires": "updates.send+fresh",
      middleware: [perm("updates.send", true)] as const,
      request: { params: s.PostIdParams },
      responses: { 202: jsonResponse(s.PostDetailSchema, "Queued"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const { detail } = await postSvc().send(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json(detailBody(detail), 202);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/posts/{id}/test-send",
      tags: TAGS,
      summary: "Send a test of the current draft to yourself (or up to five addresses)",
      security: sessionSecurity,
      "x-requires": "updates.send",
      middleware: [perm("updates.send")] as const,
      request: { params: s.PostIdParams, body: jsonBody(s.TestSendBody) },
      responses: { 202: jsonResponse(s.SendSummarySchema, "Queued"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      let to = c.req.valid("json").to ?? [];
      if (to.length === 0) {
        const names = await services.db.withTenant(sg.tenant, (tx) =>
          new MembershipRepo(sg.tenant, tx).namesFor([sg.membership.id]),
        );
        const email = names.get(sg.membership.id)?.email;
        if (!email)
          throw new ApiError("validation_failed", "your account has no email address; pass `to`");
        to = [email];
      }
      try {
        const sent = await postSvc().testSend(
          sg.tenant,
          c.req.valid("param").id,
          to,
          actorOf(c, sg),
        );
        return c.json(sendBody(sendSummary(sent)), 202);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/posts/{id}/publish",
      tags: TAGS,
      summary: "Publish to the web archive without sending email (corrections)",
      security: sessionSecurity,
      "x-requires": "updates.send",
      middleware: [perm("updates.send")] as const,
      request: { params: s.PostIdParams },
      responses: { 200: jsonResponse(s.PostDetailSchema, "Published"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          detailBody(
            await postSvc().publishToArchive(sg.tenant, c.req.valid("param").id, actorOf(c, sg)),
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
      path: "/posts/{id}/archived",
      tags: TAGS,
      summary: "Archive (hide from investors) or restore an update",
      security: sessionSecurity,
      "x-requires": "updates.manage",
      middleware: [perm("updates.manage")] as const,
      request: { params: s.PostIdParams, body: jsonBody(s.ArchiveBody) },
      responses: { 200: jsonResponse(s.PostDetailSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          detailBody(
            await postSvc().archive(
              sg.tenant,
              c.req.valid("param").id,
              actorOf(c, sg),
              c.req.valid("json").archived,
            ),
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
      method: "get",
      path: "/posts/{id}/sends",
      tags: TAGS,
      summary: "Sends of an update (live and test) with counts",
      security: sessionSecurity,
      "x-requires": "updates.read",
      middleware: [perm("updates.read")] as const,
      request: { params: s.PostIdParams },
      responses: { 200: jsonResponse(s.SendListSchema, "Sends"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          { sends: (await postSvc().sends(sg.tenant, c.req.valid("param").id)).map(sendBody) },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/sends/{sendId}/recipients",
      tags: TAGS,
      summary: "Per-recipient status of a send",
      security: sessionSecurity,
      "x-requires": "updates.read",
      middleware: [perm("updates.read")] as const,
      request: { params: s.SendIdParams },
      responses: { 200: jsonResponse(s.RecipientListSchema, "Recipients"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const sendId = c.req.valid("param").sendId;
      const out = await services.db.withTenant(sg.tenant, async (tx) => {
        const send = await new SendRepo(sg.tenant, tx).byId(sendId);
        if (send === undefined) return undefined;
        const rows = await new RecipientRepo(sg.tenant, tx).forSend(sendId);
        return { send, rows };
      });
      if (out === undefined) throw new ApiError("not_found", "no such send");
      return c.json(
        {
          send: sendBody(sendSummary(out.send)),
          recipients: out.rows.map((r) => ({
            id: r.id,
            membershipId: r.membershipId,
            email: r.email,
            status: r.status,
            error: r.error,
            sentAt: iso(r.sentAt),
            lastEventAt: iso(r.lastEventAt),
          })),
        },
        200,
      );
    },
  );

  // --- archive + threads + subscription (every member) ------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/archive",
      tags: TAGS,
      summary: "Sent updates this member may read, newest first",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: { 200: jsonResponse(s.ArchiveListSchema, "Archive"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const reader = await readerOf(sg);
      const [items, subscribed] = await Promise.all([
        postSvc().archiveList(sg.tenant, reader),
        subSvc().isSubscribed(sg.tenant, sg.membership.id),
      ]);
      return c.json(
        { posts: items.map((p) => ({ ...p, sentAt: iso(p.sentAt) })), subscribed },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/archive/{slug}",
      tags: TAGS,
      summary: "One sent update as this member sees it (sections filtered, references hydrated)",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: s.ArchiveParams },
      responses: { 200: jsonResponse(s.ArchivePageSchema, "Update"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const reader = await readerOf(sg);
      const enabled = (await services.enablement.get(services.db, sg.tenant)).enabled;
      const page = await postSvc().archiveRead(sg.tenant, c.req.valid("param").slug, {
        reader,
        facts: facts(c, sg),
        enabledModules: enabled,
        actor: actorOf(c, sg),
      });
      if (page === undefined) throw new ApiError("not_found", "no such update");
      return c.json(
        {
          post: { ...page.post, sentAt: iso(page.post.sentAt) },
          version: { ...page.version, createdAt: page.version.createdAt.toISOString() },
          sections: page.sections.map((sec) => ({
            key: sec.key,
            title: sec.title,
            blocks: sec.blocks.map((b) => ({
              id: b.id,
              type: b.type,
              schemaVersion: b.schemaVersion,
              data: b.data as Record<string, unknown>,
              ...(b.unavailable === undefined ? {} : { unavailable: b.unavailable }),
            })),
          })),
          viewer: page.viewer,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/posts/{id}/replies",
      tags: TAGS,
      summary: "Reply threads: staff see every investor's thread, an investor their own",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: s.PostIdParams },
      responses: { 200: jsonResponse(s.ThreadListSchema, "Threads"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      if (sg.membership.kind === "staff" && !canRead(sg))
        throw new ApiError("forbidden", "updates.read required");
      try {
        return c.json(
          { threads: (await replySvc().list(sg.tenant, c.req.valid("param").id)).map(threadBody) },
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
      path: "/posts/{id}/replies",
      tags: TAGS,
      summary: "Reply in a thread (investors: their own; staff: `threadMembershipId`)",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: s.PostIdParams, body: jsonBody(s.CreateReplyBody) },
      responses: { 201: jsonResponse(s.ThreadReplySchema, "Reply"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      if (sg.membership.kind === "staff" && !canRead(sg))
        throw new ApiError("forbidden", "updates.read required");
      try {
        const r = await replySvc().create(sg.tenant, c.req.valid("param").id, c.req.valid("json"), {
          ...actorOf(c, sg),
          kind: sg.membership.kind,
        });
        return c.json(replyBody(r), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/subscription",
      tags: TAGS,
      summary: "Whether this member receives update emails",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: { 200: jsonResponse(s.SubscriptionSchema, "Subscription"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      return c.json({ subscribed: await subSvc().isSubscribed(sg.tenant, sg.membership.id) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/subscription",
      tags: TAGS,
      summary: "Opt out of (or back into) update emails; portal access is unaffected",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { body: jsonBody(s.SubscriptionBody) },
      responses: { 200: jsonResponse(s.SubscriptionSchema, "Subscription"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const subscribed = await subSvc().set(
          sg.tenant,
          sg.membership.id,
          c.req.valid("json").subscribed,
          "portal",
          actorOf(c, sg),
        );
        return c.json({ subscribed }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/unsubscribe",
      tags: TAGS,
      summary: "Redeem an unsubscribe token (footer link page, RFC 8058 one-click POST)",
      description:
        "No session needed: the token in the email identifies the member. Mail clients POST here with `List-Unsubscribe=One-Click`; the body is ignored. Rate limited per IP.",
      "x-requires": "public",
      request: { query: s.UnsubscribeQuery },
      responses: { 200: jsonResponse(s.UnsubscribeResultSchema, "Unsubscribed"), ...ERRORS },
    }),
    async (c) => {
      const workspace = c.get("workspace");
      if (!workspace) throw new ApiError("not_found", "no workspace");
      const ip = services.clientIp(c) ?? "unknown";
      const limit = await services.rateLimiter.hit(
        `updates.unsubscribe:${sha256(ip).toString("hex")}`,
        { max: 30, windowMs: 60_000 },
      );
      if (!limit.allowed)
        throw new ApiError("rate_limited", "too many attempts", {
          retryAfterMs: limit.retryAfterMs,
        });
      try {
        const r = await subSvc().unsubscribeByToken(
          workspace.id,
          c.req.valid("query").token,
          "one_click",
        );
        return c.json(
          {
            ok: true as const,
            email: maskEmail(r.email),
            alreadyUnsubscribed: r.alreadyUnsubscribed,
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- settings + sending domain (owner/admin) --------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/settings",
      tags: TAGS,
      summary: "Update email settings (sender name, reply-to, footer)",
      security: sessionSecurity,
      "x-requires": "updates.settings",
      middleware: [perm("updates.settings")] as const,
      responses: { 200: jsonResponse(s.UpdatesSettingsSchema, "Settings"), ...ERRORS },
    }),
    (c) => {
      const sg = signed(c);
      return c.json(parseWorkspaceSettings(sg.workspace.settings).updates, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/settings",
      tags: TAGS,
      summary: "Change update email settings",
      security: sessionSecurity,
      "x-requires": "updates.settings+fresh",
      middleware: [perm("updates.settings", true)] as const,
      request: { body: jsonBody(s.UpdatesSettingsPatchBody) },
      responses: { 200: jsonResponse(s.UpdatesSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const patch = c.req.valid("json");
      const next = await services.db.withTenant(sg.tenant, async (tx) => {
        // The `updates` block alone, merged on the row-locked copy (A-3 R2 M1): never the request's
        // cached settings, never the whole document — a concurrent writer of another block keeps
        // its change. Row lock first, audit last (E3.5 LX).
        const current = parseWorkspaceSettings(
          (await lockWorkspaceFacts(tx, sg.workspace.id))?.settings,
        );
        const next = WorkspaceSettingsSchema.parse({
          ...current,
          updates: { ...current.updates, ...patch },
        });
        await updateWorkspaceSettingsBlock(tx, sg.workspace.id, "updates", next.updates);
        await services.audit.record(tx, sg.tenant, {
          action: "updates.settings_changed",
          resourceKind: "workspace",
          resourceId: sg.workspace.id,
          actorMembershipId: sg.membership.id,
          requestId: requestIdOf(c),
          meta: { fields: Object.keys(patch) },
        });
        return next;
      });
      services.workspaces.invalidate(sg.workspace.id);
      return c.json(next.updates, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/sending-domain",
      tags: TAGS,
      summary: "The workspace's sending domain: DNS records to publish and verification state",
      security: sessionSecurity,
      "x-requires": "updates.settings",
      middleware: [perm("updates.settings")] as const,
      responses: { 200: jsonResponse(s.SendingDomainEnvelopeSchema, "Sending domain"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const d = await domainSvc().get(sg.tenant);
      return c.json({ domain: d ? domainBody(d) : null }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/sending-domain",
      tags: TAGS,
      summary: "Set the sending domain: generates a DKIM key pair and the records to publish",
      description:
        "Replaces any previous domain (new selector and keys). Update mail keeps using the operator default sender until the DKIM record verifies.",
      security: sessionSecurity,
      "x-requires": "updates.settings+fresh",
      middleware: [perm("updates.settings", true)] as const,
      request: { body: jsonBody(s.SetSendingDomainBody) },
      responses: { 200: jsonResponse(s.SendingDomainSchema, "Sending domain"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        return c.json(
          domainBody(await domainSvc().set(sg.tenant, c.req.valid("json").domain, actorOf(c, sg))),
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
      path: "/sending-domain/verify",
      tags: TAGS,
      summary: "Look the records up in DNS now (DKIM must match; SPF and DMARC are advisory)",
      security: sessionSecurity,
      "x-requires": "updates.settings",
      middleware: [perm("updates.settings")] as const,
      responses: { 200: jsonResponse(s.SendingDomainSchema, "Sending domain"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const limit = await services.rateLimiter.hit(`updates.dns_verify:${sg.workspace.id}`, {
        max: 10,
        windowMs: 60_000,
      });
      if (!limit.allowed)
        throw new ApiError("rate_limited", "too many checks", { retryAfterMs: limit.retryAfterMs });
      try {
        return c.json(domainBody(await domainSvc().verify(sg.tenant, actorOf(c, sg))), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/sending-domain",
      tags: TAGS,
      summary: "Remove the sending domain (back to the operator default sender)",
      security: sessionSecurity,
      "x-requires": "updates.settings+fresh",
      middleware: [perm("updates.settings", true)] as const,
      responses: { 200: jsonResponse(OkSchema, "Removed"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await domainSvc().remove(sg.tenant, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );
}
