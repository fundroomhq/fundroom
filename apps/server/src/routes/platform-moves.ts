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
import {
  type ControlPlaneActor,
  cancelMove,
  listMoves,
  type MoveDeps,
  MoveError,
  requestMove,
} from "@fundroom/control-plane";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { platformOperatorOf, requirePlatformOperator } from "../middleware/platform.js";
import { type ApiDeps, clientIp } from "./deps.js";

/*
 * Moves between cells (E3.11, ADR-0059; owner: agent C): operator-only, like every
 * `/api/v1/platform/*` route (a plain 404 for anybody else, and whenever CONTROL_PLANE=off). A
 * move needs the shared directory (409 `move_unavailable`, `reason: no_directory`, in local
 * mode). The engine is `@fundroom/control-plane` moves; its jobs are wired by
 * `residency/move-jobs.ts`. Responses are `MoveSchema`: never the bundle URL, the transfer key or
 * the carried facts.
 */

type Api = OpenAPIHono<AppEnv>;

const TAGS = ["platform"];
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);

function moveDeps(deps: ApiDeps): MoveDeps {
  return {
    db: deps.db,
    audit: deps.audit,
    directory: deps.directory,
    cellId: deps.controlPlane.cellId,
    invalidate: () => deps.resolver.invalidate(),
    queue: deps.queue,
    canPresign: deps.storage.capabilities.presignedGet,
    storage: deps.storage,
  };
}

function operatorActor(
  c: Context<AppEnv>,
  deps: ApiDeps,
): Extract<ControlPlaneActor, { kind: "operator" }> {
  const op = platformOperatorOf(c);
  return {
    kind: "operator",
    userId: op.userId,
    sessionId: op.sessionId,
    requestId: requestIdOf(c),
    ip: clientIp(c, deps.trustProxy),
    userAgent: c.req.header("user-agent")?.slice(0, 512),
  };
}

/** `MoveError` → the API envelope. */
function moveApiError(error: unknown): unknown {
  if (!(error instanceof MoveError)) return error;
  switch (error.code) {
    case "move_unavailable":
      return new ApiError("move_unavailable", error.message, { reason: error.reason ?? "" });
    case "move_busy":
      return new ApiError("move_busy", error.message);
    case "not_found":
      return new ApiError("not_found", error.message);
    case "confirmation_mismatch":
      return new ApiError("validation_failed", error.message, {
        field: "confirmSlug",
        reason: "confirmation_mismatch",
      });
    case "not_cancellable":
      return new ApiError("conflict", error.message, { reason: "not_cancellable" });
    case "directory_unavailable":
      return new ApiError("directory_unavailable", error.message);
  }
}

export function registerPlatformMoveRoutes(api: Api, deps: ApiDeps): void {
  const operator = requirePlatformOperator(deps);

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/workspaces/{id}/move",
      tags: TAGS,
      summary: "Move a workspace to another cell",
      description:
        "Planned downtime: the workspace is held (`relocation`), exported (signed), pulled by the target cell (verified against this cell's published export key), imported and switched over in the directory; the source copy is then purged after MOVE_SOURCE_RETENTION_HOURS. Carried: content, members (matched by email), plan, legal name, country, every hold (a held workspace arrives held), the billing subscription binding; custom domains come back pending re-verification. Not carried: sessions, passwords, passkeys, MFA, API keys, webhooks and vendor connections — members sign in again. `confirmSlug` must equal the workspace's slug (400 `validation_failed`, `reason: confirmation_mismatch`). 409 `move_unavailable` with `reason` `no_directory` | `storage` | `target_unknown` | `target_local` | `target_inactive` | `target_stale` | `source_remote` | `deleted` | `legal_hold` | `sanctions_review` | `erasure_open` | `not_in_directory`; 409 `move_busy` while a move is live; 503 `directory_unavailable`.",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.PlatformWorkspaceIdParam, body: jsonBody(p.PlatformMoveBody) },
      responses: { 202: jsonResponse(p.MoveSchema, "The move, requested"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const actor = operatorActor(c, deps);
      try {
        const move = await requestMove(moveDeps(deps), {
          workspaceId: id,
          targetCellId: body.targetCellId,
          confirmSlug: body.confirmSlug,
          actor,
          requestedBy: `op:${actor.userId}`,
        });
        return c.json(move, 202);
      } catch (error) {
        throw moveApiError(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/moves",
      tags: TAGS,
      summary: "Moves between cells",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { query: p.PlatformMovesQuery },
      responses: { 200: jsonResponse(p.MoveListSchema, "Moves"), ...ERRORS },
    }),
    async (c) => {
      const q = c.req.valid("query");
      try {
        const items = await listMoves(moveDeps(deps), {
          workspaceId: q.workspaceId,
          state: q.state,
        });
        return c.json({ items }, 200);
      } catch (error) {
        throw moveApiError(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/moves/{id}/cancel",
      tags: TAGS,
      summary: "Cancel a move",
      description:
        "Allowed until the import completes (states `requested`, `exporting`, `exported`, `importing`); afterwards 409 `conflict` with `reason: not_cancellable`. The source copy is released at once when this cell is the source, else by the source cell's next poll; a copy the target already wrote is discarded.",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.MoveIdParam },
      responses: { 200: jsonResponse(p.MoveSchema, "The move"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      try {
        return c.json(await cancelMove(moveDeps(deps), id, operatorActor(c, deps)), 200);
      } catch (error) {
        throw moveApiError(error);
      }
    },
  );
}
