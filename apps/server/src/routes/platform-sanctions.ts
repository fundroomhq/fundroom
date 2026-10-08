import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  platform as p,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import { SanctionsDecisionError, type SanctionsService } from "@fundroom/sanctions";
import type { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { platformOperatorOf, requirePlatformOperator } from "../middleware/platform.js";
import { type ApiDeps, clientIp } from "./deps.js";

/*
 * Sanctions review (E3.10, ADR-0058; owner: agent S): `/api/v1/platform/sanctions*` and
 * `POST /platform/workspaces/{id}/rescreen`, operator-only. A decision needs a note; `cleared`
 * releases the hold (or lifts a `sanctions` suspension), `confirmed` suspends (`sanctions`).
 * Tenants never see any of it.
 *
 * The listing and a decision work whenever the control plane is on (screenings outlive a driver
 * change); a re-screen needs a configured driver and is a plain 404 without one, like every other
 * feature gate. `/platform/*` is already a 404 when CONTROL_PLANE=off (the operator guard).
 */

type Api = OpenAPIHono<AppEnv>;
type Screening = Awaited<ReturnType<SanctionsService["list"]>>[number];

function iso(d: Date | string | null): string | null {
  if (d === null) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

function summary(row: Screening): z.infer<typeof p.SanctionsScreeningSchema> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceSlug: row.workspaceSlug,
    subjectName: row.subjectName,
    subjectCountry: row.subjectCountry,
    provider: row.provider,
    listVersion: row.listVersion,
    outcome: row.outcome,
    matchCount: row.matches.length,
    decision: row.decision,
    decidedAt: iso(row.decidedAt),
    createdAt: iso(row.createdAt) as string,
  };
}

function detail(row: Screening): z.infer<typeof p.SanctionsScreeningDetailSchema> {
  return {
    ...summary(row),
    matches: row.matches.map((m) => ({
      listEntryId: m.listEntryId,
      name: m.name,
      score: m.score,
      programs: [...m.programs],
      source: m.source,
    })),
    decidedBy: row.decidedBy,
    decisionNote: row.decisionNote,
  };
}

function serviceOf(deps: ApiDeps): SanctionsService {
  const service = deps.sanctions.service;
  if (service === null) throw new ApiError("not_found", "no such path");
  return service;
}

function operatorActor(c: Context<AppEnv>, deps: ApiDeps) {
  const op = platformOperatorOf(c);
  return {
    userId: op.userId,
    sessionId: op.sessionId,
    requestId: requestIdOf(c),
    ip: clientIp(c, deps.trustProxy),
    userAgent: c.req.header("user-agent")?.slice(0, 512),
  };
}

const TAGS = ["platform"];
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);

export function registerPlatformSanctionsRoutes(api: Api, deps: ApiDeps): void {
  const operator = requirePlatformOperator(deps);

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/sanctions",
      tags: TAGS,
      summary: "Sanctions screenings",
      description: "`status=open` (default): potential matches and errors nobody has decided.",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { query: p.SanctionsListQuery },
      responses: { 200: jsonResponse(p.SanctionsScreeningListSchema, "Screenings"), ...ERRORS },
    }),
    async (c) => {
      const { status } = c.req.valid("query");
      const rows = await serviceOf(deps).list({ status });
      return c.json({ items: rows.map(summary) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/sanctions/{id}",
      tags: TAGS,
      summary: "One screening with its matches",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.SanctionsIdParam },
      responses: {
        200: jsonResponse(p.SanctionsScreeningDetailSchema, "Screening"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await serviceOf(deps).get(id);
      if (row === null) throw new ApiError("not_found", "no such screening");
      return c.json(detail(row), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/sanctions/{id}/decision",
      tags: TAGS,
      summary: "Decide a potential match",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.SanctionsIdParam, body: jsonBody(p.SanctionsDecisionBody) },
      responses: {
        200: jsonResponse(p.SanctionsScreeningDetailSchema, "Decided"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      try {
        const row = await serviceOf(deps).decide({
          id,
          decision: body.decision,
          note: body.note,
          operator: operatorActor(c, deps),
        });
        return c.json(detail(row), 200);
      } catch (error) {
        if (error instanceof SanctionsDecisionError) {
          throw error.reason === "not_found"
            ? new ApiError("not_found", "no such screening")
            : new ApiError("conflict", error.message);
        }
        throw error;
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/workspaces/{id}/rescreen",
      tags: TAGS,
      summary: "Screen a workspace again",
      description: "Enqueues a screen against the current list; the result appears in the queue.",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.PlatformWorkspaceIdParam },
      responses: { 202: { description: "Enqueued" }, ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const service = serviceOf(deps);
      if (!service.enabled) throw new ApiError("not_found", "no such path");
      const queued = await service.requestRescreen({
        workspaceId: id,
        operator: operatorActor(c, deps),
      });
      if (!queued) throw new ApiError("not_found", "no such workspace");
      return c.body(null, 202);
    },
  );
}
