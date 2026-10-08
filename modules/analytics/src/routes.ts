import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import type { ModuleEnv, ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import * as s from "./contracts.js";
import { type Actor, AnalyticsError } from "./errors.js";
import { createHotListService, type HotListService } from "./service/hot-list.js";
import { createInsightsService, type InsightsService } from "./service/insights.js";
import {
  type AnalyticsSettingsService,
  createAnalyticsSettingsService,
} from "./service/settings.js";
import { createTrackingService, type TrackingService } from "./service/tracking.js";

/*
 * `/api/v1/analytics/*` (E1.5). Three routes are member-facing — the page-dwell heartbeat, the
 * close beacon and the transparency notice — and every member (investor included) may call
 * them; the rest are staff surfaces behind `analytics.read` / `analytics.settings`, which
 * answer an external caller with 404 rather than 403 (no oracle, ADR-0014). Handlers hold no
 * logic beyond shaping the response: the services do the work, the repos touch SQL.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const TAGS = ["analytics"];
export const PERM_READ = "analytics.read";
export const PERM_SETTINGS = "analytics.settings";

type Vars = ModuleEnv["Variables"];
interface Signed {
  readonly session: NonNullable<Vars["session"]>;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<ModuleEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!session || !membership || !tenant || !workspace) throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

function rethrow(error: unknown): never {
  if (error instanceof AnalyticsError) throw new ApiError(error.code, error.message, error.details);
  throw error;
}

export function registerAnalyticsRoutes(api: ModuleRouter, services: ModuleServices): void {
  // Services are built on first use so that nothing is constructed at registration time.
  let tracking: TrackingService | undefined;
  let insights: InsightsService | undefined;
  let settings: AnalyticsSettingsService | undefined;
  let hotList: HotListService | undefined;
  const svc = () => {
    tracking ??= createTrackingService(services);
    insights ??= createInsightsService(services);
    settings ??= createAnalyticsSettingsService(services);
    hotList ??= createHotListService(services);
    return { tracking, insights, settings, hotList };
  };
  const perm = (p: string, fresh = false) => services.guards.requirePermission(p, { fresh });
  const member = () => services.guards.requireMember();

  const modeOf = (sg: Signed) => svc().settings.read(sg.workspace);
  const legalOf = (sg: Signed) => parseWorkspaceSettings(sg.workspace.settings).legal;
  /**
   * Global Privacy Control (`Sec-GPC: 1`). A legally recognised opt-out signal in several US
   * states and an unambiguous objection everywhere else, so it is read on every member-facing
   * request and always means "no" — design/04 §3.2, R13.
   */
  const gpcOf = (c: Context<ModuleEnv>) => c.req.header("sec-gpc") === "1";
  const actorOf = (c: Context<ModuleEnv>, sg: Signed): Actor => ({
    membershipId: sg.membership.id,
    requestId: requestIdOf(c),
    sessionId: sg.session.sessionId,
    ip: services.clientIp(c),
  });

  // --- member-facing ----------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/heartbeat",
      tags: TAGS,
      summary: "Record dwell on one page of a document",
      description:
        'Sent by the viewer every few seconds while a page is on screen. Each beat is capped at 15 s server-side and accumulates in `analytics.page_open` until the tab closes or the flush job times it out. A no-op (`accepted: false`, `reason: "mode"`) unless the workspace\'s analytics mode is `engagement`.',
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { body: jsonBody(s.HeartbeatBody) },
      responses: { 200: jsonResponse(s.HeartbeatResultSchema, "Recorded"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const input = c.req.valid("json");
      const result = await svc().tracking.heartbeat(
        sg.workspace.id,
        modeOf(sg),
        {
          membershipId: sg.membership.id,
          sessionId: sg.session.sessionId,
          gpc: gpcOf(c),
          ip: services.clientIp(c),
          userAgent: c.req.header("user-agent") ?? null,
          embed: c.get("embed"),
        },
        input,
      );
      return c.json(result, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/close",
      tags: TAGS,
      summary: "Flush this session's dwell on a resource",
      description:
        "Sent as a beacon when the viewer closes the document. Turns the session's accumulated `page_open` rows for that resource into `page_viewed` events.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { body: jsonBody(s.CloseBody) },
      responses: { 200: jsonResponse(s.CloseResultSchema, "Flushed"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const input = c.req.valid("json");
      const result = await svc().tracking.close(
        sg.workspace.id,
        { sessionId: sg.session.sessionId },
        input,
      );
      return c.json(result, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/notice",
      tags: TAGS,
      summary: "What this workspace records about me",
      description:
        "The transparency notice the portal shows, and the authority the viewer obeys: `dwell` folds the workspace's analytics mode, its consent mode, the caller's stored answer and their Global Privacy Control signal into the one boolean the browser needs.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: { 200: jsonResponse(s.NoticeSchema, "Notice"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const notice = await svc().tracking.notice(sg.workspace.id, modeOf(sg), legalOf(sg), {
        membershipId: sg.membership.id,
        gpc: gpcOf(c),
      });
      return c.json(notice, 200);
    },
  );

  // --- staff ------------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/overview",
      tags: TAGS,
      summary: "Engagement overview for the last N days",
      description:
        "Totals and top documents come from the daily rollups (up to five minutes behind); the recent strip reads raw events.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { query: s.OverviewQuery },
      responses: { 200: jsonResponse(s.OverviewSchema, "Overview"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { days } = c.req.valid("query");
      return c.json(await svc().insights.overview(sg.tenant, modeOf(sg), days), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/{kind}/{id}/viewers",
      tags: TAGS,
      summary: "Who viewed this document or update",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.ResourceParams },
      responses: { 200: jsonResponse(s.ViewerListSchema, "Viewers"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { kind, id } = c.req.valid("param");
      return c.json(await svc().insights.viewers(sg.tenant, modeOf(sg), kind, id), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/{kind}/{id}/viewers/{membershipId}/pages",
      tags: TAGS,
      summary: "Per-page dwell for one viewer of one resource",
      description: "Empty unless the workspace has run in `engagement` mode.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.ResourceMemberParams },
      responses: { 200: jsonResponse(s.PageDwellListSchema, "Page dwell"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { id, membershipId } = c.req.valid("param");
      return c.json(await svc().insights.pages(sg.tenant, id, membershipId), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/members/{membershipId}/timeline",
      tags: TAGS,
      summary: "One contact's engagement timeline",
      description:
        "Newest first, keyset paged: pass the returned `nextBefore` and `nextBeforeId` back as `before` and `beforeId` for the next page.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.MemberParams, query: s.TimelineQuery },
      responses: { 200: jsonResponse(s.TimelineSchema, "Timeline"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { membershipId } = c.req.valid("param");
      const { limit, before, beforeId } = c.req.valid("query");
      return c.json(
        await svc().insights.timeline(sg.tenant, membershipId, { limit, before, beforeId }),
        200,
      );
    },
  );

  // --- E2.6: heatmap, hot list, email engagement ------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/{kind}/{id}/heatmap",
      tags: TAGS,
      summary: "Page heatmap: dwell per page across every reader",
      description:
        "From `analytics.page_rollup` (up to five minutes behind), one heatmap per document version — two versions' page 3 are different pages. Empty unless the workspace has run in `engagement` mode. Counts only: erasing a member removes them from the distinct-reader set without rewriting the totals.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.ResourceParams, query: s.HeatmapQuery },
      responses: { 200: jsonResponse(s.HeatmapSchema, "Heatmap"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { kind, id } = c.req.valid("param");
      const { versionId } = c.req.valid("query");
      return c.json(
        await svc().insights.heatmap(sg.tenant, modeOf(sg), kind, id, versionId ?? null),
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/hot-list",
      tags: TAGS,
      summary: "Investors ranked by recent engagement",
      description:
        "External members ranked by a 0–100 score over the last `days` (default: the workspace's `hotListWindowDays`): views, page dwell, downloads, human email opens and clicks, each worth half as much every `days / 2` days. Automated opens and clicks (Apple Mail Privacy Protection, link scanners) are listed in `counts` and never scored. Empty unless the mode is `engagement`; a member whose consent does not allow engagement analytics is not ranked. At most 200 rows.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { query: s.HotListQuery },
      responses: { 200: jsonResponse(s.HotListSchema, "Hot list"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const settings = modeOf(sg);
      const days = c.req.valid("query").days ?? settings.hotListWindowDays;
      return c.json(await svc().hotList.list(sg.tenant, settings, days), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/hot-list.csv",
      tags: TAGS,
      summary: "The hot list, as a CSV",
      description:
        "Columns `rank,membership_id,name,role,score,views,dwell_seconds,downloads,human_opens,clicks,automated_opens,last_activity_at`, frozen. RFC 4180 with CRLF endings and a UTF-8 BOM; a field beginning `=`, `+`, `-` or `@` is prefixed with an apostrophe (a display name is chosen by the person it names). Audited (`analytics.hot_list_exported`) and `no-store`.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { query: s.HotListQuery },
      responses: {
        200: { description: "The hot list", content: { "text/csv": { schema: z.string() } } },
        ...ERRORS,
      },
    }),
    async (c) => {
      const sg = signed(c);
      const settings = modeOf(sg);
      const days = c.req.valid("query").days ?? settings.hotListWindowDays;
      const { csv } = await svc().hotList.exportCsv(sg.tenant, settings, days, actorOf(c, sg));
      return c.body(csv, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="hot-list-${days}d.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      }) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/posts/{id}/email",
      tags: TAGS,
      summary: "Email opens and clicks for one update",
      description:
        "Counted from the ESP's open/click webhooks, independently of delivery status (which the updates module owns): unique human opens, automated opens (Apple Mail Privacy Protection prefetches, scanners) reported separately, and human clicks per link (origin + path). Recorded only under `engagement` mode and for members whose `email_tracking` consent allowed it; raw events, so subject to retention.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.PostParams },
      responses: { 200: jsonResponse(s.EmailEngagementSchema, "Email engagement"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { id } = c.req.valid("param");
      return c.json(await svc().insights.email(sg.tenant, modeOf(sg), id), 200);
    },
  );

  // --- settings + DSAR --------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/settings",
      tags: TAGS,
      summary: "Tracking mode and retention",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      responses: { 200: jsonResponse(s.AnalyticsSettingsSchema, "Settings"), ...ERRORS },
    }),
    (c) => c.json(svc().settings.read(signed(c).workspace), 200),
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/settings",
      tags: TAGS,
      summary: "Change the tracking mode, retention or hot-list settings",
      description:
        "`off` stops every writer in this module; `essential` keeps server-side access facts only; `engagement` adds page dwell, email opens/clicks and the hot list. Retention trims this workspace's raw events (daily, skipped while `legal.legalHold` is set), never the rollups. `hotLeadThreshold: null` turns hot-lead alerts off.",
      security: sessionSecurity,
      "x-requires": `${PERM_SETTINGS}+fresh`,
      middleware: [perm(PERM_SETTINGS, true)] as const,
      request: { body: jsonBody(s.AnalyticsSettingsPatchBody) },
      responses: { 200: jsonResponse(s.AnalyticsSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const patch = c.req.valid("json");
      const next = await svc().settings.patch(sg.tenant, sg.workspace, patch, actorOf(c, sg));
      return c.json(next, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/members/{membershipId}/anonymise",
      tags: TAGS,
      summary: "Erase everything analytics knows about one member (DSAR)",
      description:
        "Deletes that member's events, open pages, view sessions, per-viewer rollups, heatmap reader rows and hot-lead marker. The daily and page rollups keep their counts: they name nobody. The kernel's DSAR erasure (`member.erasure_requested`) runs the same erasure. Refused with 409 `conflict` and `reason: \"legal_hold\"` while the workspace is under legal hold, like the kernel's DSAR request.",
      security: sessionSecurity,
      "x-requires": `${PERM_SETTINGS}+fresh`,
      middleware: [perm(PERM_SETTINGS, true)] as const,
      request: { params: s.MemberParams },
      responses: { 200: jsonResponse(s.AnonymiseResultSchema, "Erased"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { membershipId } = c.req.valid("param");
      try {
        const deleted = await svc().settings.anonymise(sg.tenant, membershipId, actorOf(c, sg));
        return c.json({ ok: true as const, deleted }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );
}
