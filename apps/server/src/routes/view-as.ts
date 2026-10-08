import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
  viewAs as v,
} from "@fundroom/contracts";
import { type Database, systemContext } from "@fundroom/db";
import { MembershipRepo } from "@fundroom/identity";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireSession } from "../middleware/auth.js";
import { requirePermission } from "../middleware/authz.js";
import type { ApiDeps } from "./deps.js";

/*
 * View as investor (E2.7 package B2): `POST /access/people/{id}/view-as`, `GET` and `DELETE
 * /me/view-as`.
 *
 * Starting a view only writes it onto the caller's session row (30 minutes) and audits it. What
 * makes it a view is elsewhere, and deliberately in more than one place:
 *  - `middleware/auth.ts` re-checks it on every request (not expired, staff still active with
 *    `access.manage`, target still an active external member), swaps in the investor's
 *    membership and a `TenantContext` carrying `viewAs`, and refuses every non-read method with
 *    403 `view_as_read_only` (except leaving the view and signing out);
 *  - `withTenant` runs that context's transactions `READ ONLY`, and the audit recorder refuses
 *    to write under it — the backstops for a side effect a route forgot to skip;
 *  - read routes that record the investor's own activity (engagement events, exposure stamps,
 *    view audits) skip it under `viewAs`, and downloads answer `view_as_read_only`.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const TAGS = ["access"];

type ViewAsState = {
  workspaceId: string;
  membershipId: string;
  name: string | null;
  startedAt: string;
  until: string;
};

/** The wire shape of a view, with the member's display name (null when erased). */
export async function viewAsStateOf(
  db: Database,
  view: { workspaceId: string; membershipId: string; startedAt: Date; until: Date },
): Promise<ViewAsState> {
  const sys = systemContext(view.workspaceId);
  const person = await db.withTenant(sys, (tx) =>
    new MembershipRepo(sys, tx).person(view.membershipId),
  );
  const name = person?.displayName?.trim() ?? "";
  return {
    workspaceId: view.workspaceId,
    membershipId: view.membershipId,
    name: name === "" ? null : name,
    startedAt: view.startedAt.toISOString(),
    until: view.until.toISOString(),
  };
}

/** The view applied to this request (bootstrap, `/me`), or null. */
export async function appliedViewAs(c: Context<AppEnv>, db: Database): Promise<ViewAsState | null> {
  const applied = c.get("viewAs");
  const workspace = c.get("workspace");
  if (applied === undefined || workspace === undefined) return null;
  return viewAsStateOf(db, { workspaceId: workspace.id, ...applied });
}

export function registerViewAsRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  api.openapi(
    createRoute({
      method: "post",
      path: "/access/people/{id}/view-as",
      "x-requires": "access.manage+fresh",
      tags: TAGS,
      summary: "Look at the portal as this investor for 30 minutes (read only, audited)",
      description:
        "The target must be an active external member of this workspace, else 404. Replaces any view this session already holds (the old one is audited as ended). While the view applies, every request in this workspace is served as the investor, read only: a mutating request answers 403 `view_as_read_only` (except `DELETE /me/view-as` and `POST /auth/logout`), nothing the investor's own visit would record is written, and downloads are refused.",
      security: sessionSecurity,
      middleware: [
        requirePermission({ authz: () => deps.authz }, "access.manage", { fresh: true }),
      ] as const,
      request: { params: v.PersonIdParam, body: jsonBody(v.StartViewAsBody) },
      responses: { 200: jsonResponse(v.StartViewAsResponseSchema, "Viewing"), ...ERRORS },
    }),
    async (c) => {
      const session = c.get("session");
      const staff = c.get("membership");
      const workspace = c.get("workspace");
      if (session === undefined || staff === undefined || workspace === undefined)
        throw new ApiError("unauthenticated");
      const { id } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const sys = systemContext(workspace.id);
      const target = await deps.db.withTenant(sys, (tx) => new MembershipRepo(sys, tx).byId(id));
      if (target === undefined || target.kind !== "external" || target.status !== "active")
        throw new ApiError("not_found", "no such member");
      const view = await deps.auth.sessions.startViewAs({
        sessionId: session.sessionId,
        workspaceId: workspace.id,
        staffMembershipId: staff.id,
        targetMembershipId: target.id,
        reason,
        ttlMs: v.VIEW_AS_TTL_MS,
        requestId: requestIdOf(c),
      });
      return c.json({ viewAs: await viewAsStateOf(deps.db, view) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/me/view-as",
      "x-requires": "session",
      tags: ["account"],
      summary: "The view as an investor this session holds, if any",
      description:
        "The session's unexpired view, in whichever workspace it was started (the bootstrap's `viewAs` is only the one applied to the current workspace).",
      security: sessionSecurity,
      middleware: [requireSession()] as const,
      responses: { 200: jsonResponse(v.ViewAsResponseSchema, "View"), ...ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const view = s.viewAs;
      if (view === undefined || view.until.getTime() <= Date.now())
        return c.json({ viewAs: null }, 200);
      return c.json({ viewAs: await viewAsStateOf(deps.db, view) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/me/view-as",
      "x-requires": "session",
      tags: ["account"],
      summary: "Leave the view as an investor (idempotent)",
      security: sessionSecurity,
      middleware: [requireSession()] as const,
      responses: { 204: { description: "Ended (or there was nothing to end)" }, ...ERRORS },
    }),
    async (c) => {
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      if (s.viewAs !== undefined) {
        await deps.auth.sessions.endViewAs({
          sessionId: s.sessionId,
          reason: s.viewAs.until.getTime() <= Date.now() ? "expired" : "exited",
          requestId: requestIdOf(c),
        });
      }
      return c.body(null, 204);
    },
  );
}
