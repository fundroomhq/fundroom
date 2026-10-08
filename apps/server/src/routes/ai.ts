import type { AiCaller, AiStatusView } from "@fundroom/ai";
import {
  ApiError,
  ai as a,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import { type ApiDeps, principalOf } from "./deps.js";

/*
 * AI assist (E3.12, ADR-0060; owner: agent A): the kernel routes under `/ai/*` behind the
 * `required` `ai` manifest. The kernel is `@fundroom/ai` (`container.aiKernel`); it opens its own
 * short transactions. Module routes start requests (`services.ai.start`); these read settings and
 * status, change settings, and read or discard the CALLER's own requests.
 *
 * `GET /ai/requests/{id}` and `DELETE` answer 404 unless the caller started the request AND still
 * holds its task's permission — never 403, so a request id is not an oracle.
 *
 * Errors that are deliberately not authz-shaped: 409 `ai_unavailable` (no model configured),
 * `ai_disabled`, `ai_acknowledgement_required`; 429 `ai_rate_limited`/`ai_busy`/
 * `ai_budget_exhausted` (module start routes).
 *
 * Plan entitlements (A-3, ADR-0063): the kernel itself refuses with 402 `plan_limit`
 * `{ limit: "feature", feature: "ai" }` — a settings write that turns AI or a feature on, and every
 * start — after the route's permission guard has passed (never an oracle). `GET /ai/status`
 * reports `planAllows`.
 */

type Api = OpenAPIHono<AppEnv>;

const TAGS = ["ai"];
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
/** `PUT /ai/settings` can also answer the plan's 402 (A-3: turning AI or a feature on). */
const SETTINGS_ERRORS = errorResponses(400, 401, 402, 403, 404, 409, 429, 500, 503);

/** The route's `AiStatus` body (a fresh object: the contract schema, nothing else). */
function statusBody(v: AiStatusView) {
  return {
    available: v.available,
    provider: v.provider === null ? null : { ...v.provider },
    settings: {
      enabled: v.settings.enabled,
      features: { ...v.settings.features },
      monthlyTokenBudget: v.settings.monthlyTokenBudget,
      acknowledgement:
        v.settings.acknowledgement === null ? null : { ...v.settings.acknowledgement },
    },
    needsAcknowledgement: v.needsAcknowledgement,
    effective: { ...v.effective },
    planAllows: v.planAllows,
    usage: { ...v.usage },
  };
}

function callerOf(c: Context<AppEnv>): AiCaller {
  const p = principalOf(c);
  return { membershipId: p.membership.id, membership: p.membership };
}

const NOT_FOUND = () => new ApiError("not_found", "no such AI request");

export function registerAiRoutes(api: Api, deps: ApiDeps): void {
  const perm = (permission: string, extra: { readonly fresh?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, permission, extra);

  api.openapi(
    createRoute({
      method: "get",
      path: "/ai/status",
      tags: TAGS,
      summary: "AI assist availability, settings and usage",
      description:
        "Whether the operator configured a model (`available`), the provider as tenants see it (who runs it, where, retention; never a key or URL), this workspace's `settings.ai`, whether the current provider still needs an acknowledgement, which features are effectively on, this UTC month's token usage against the budget, and whether the workspace's plan includes AI (`planAllows`). Always 200, also when AI is unavailable. Writes nothing.",
      security: sessionSecurity,
      "x-requires": "ai.read",
      middleware: [perm("ai.read")] as const,
      responses: { 200: jsonResponse(a.AiStatusSchema, "AI status"), ...ERRORS },
    }),
    async (c) => {
      const p = principalOf(c);
      return c.json(statusBody(await deps.aiKernel.status(p.tenant)), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/ai/settings",
      tags: TAGS,
      summary: "Turn AI assist and its features on or off",
      description:
        "Replaces the workspace's AI settings. `enabled: true` without an acknowledgement of the current provider needs `acknowledge: true` (409 `ai_acknowledgement_required`); `acknowledge: true` records who acknowledged which provider identity. 409 `ai_unavailable` for `enabled: true` when no model is configured; 400 for a budget above the operator's. Turning AI or a feature off cancels that feature's queued and running requests. 402 `plan_limit` (`feature: \"ai\"`) when the write would turn AI or a feature on and the workspace's plan does not include AI; a write that keeps what is on, or turns things off, is allowed. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "ai.manage+fresh",
      middleware: [perm("ai.manage", { fresh: true })] as const,
      request: { body: jsonBody(a.PutAiSettingsBody) },
      responses: { 200: jsonResponse(a.AiStatusSchema, "AI status"), ...SETTINGS_ERRORS },
    }),
    async (c) => {
      const p = principalOf(c);
      const body = c.req.valid("json");
      const status = await deps.aiKernel.updateSettings(p.tenant, body, {
        membershipId: p.membership.id,
        userId: p.membership.userId,
        requestId: requestIdOf(c) ?? null,
        sessionId: p.sessionId ?? null,
      });
      return c.json(statusBody(status), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/ai/requests/{id}",
      tags: TAGS,
      summary: "One of your AI suggestions",
      description:
        "Status and, once done, the suggestion. 404 unless you started the request and still hold the permission of its task. Poll while `queued` or `running`.",
      security: sessionSecurity,
      "x-requires": "ai.read",
      middleware: [perm("ai.read")] as const,
      request: { params: a.AiRequestIdParams },
      responses: { 200: jsonResponse(a.AiRequestSchema, "AI request"), ...ERRORS },
    }),
    async (c) => {
      const p = principalOf(c);
      const view = await deps.aiKernel.getRequest(p.tenant, c.req.valid("param").id, callerOf(c));
      if (view === undefined) throw NOT_FOUND();
      return c.json(
        {
          ...view,
          result: view.result as a.AiRequest["result"],
          usage: { ...view.usage },
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/ai/requests/{id}",
      tags: TAGS,
      summary: "Discard one of your AI suggestions",
      description:
        "Deletes the request (cancelling it when queued or running). Same ownership rule as the read.",
      security: sessionSecurity,
      "x-requires": "ai.read",
      middleware: [perm("ai.read")] as const,
      request: { params: a.AiRequestIdParams },
      responses: { 204: { description: "Discarded" }, ...ERRORS },
    }),
    async (c) => {
      const p = principalOf(c);
      const ok = await deps.aiKernel.deleteRequest(p.tenant, c.req.valid("param").id, callerOf(c));
      if (!ok) throw NOT_FOUND();
      return c.body(null, 204);
    },
  );
}
