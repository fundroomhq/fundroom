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
  cellAcceptsWorkspaces,
  changeWorkspacePlacement,
  checkOperatorProof,
  getPlatformWorkspace,
  isLiveOperator,
  listCells,
  listOperators,
  listPlatformWorkspaces,
  OPERATOR_MINT_MAX_AGE_MS,
  operatorMintRefusal,
  operatorProfile,
  PlatformError,
  type PlatformWorkspace,
  type PlatformWorkspaceDetail,
  ProvisioningError,
  platformAuditPage,
  provisionWorkspace,
  suspendWorkspace,
  unsuspendWorkspace,
} from "@fundroom/control-plane";
import { platformContext } from "@fundroom/db";
import type { DirectoryCell } from "@fundroom/ports";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireSession } from "../middleware/auth.js";
import {
  clearOperatorCookie,
  issueOperatorCookie,
  platformOperatorOf,
  platformSurfaceReachable,
  readOperatorCookie,
  requirePlatformOperator,
} from "../middleware/platform.js";
import { markAuthzDenial, markSecurityEvent } from "../middleware/security-events.js";
import { type ApiDeps, clientIp } from "./deps.js";
import { registerPlatformEnrolRoutes } from "./platform-enrol.js";

/*
 * The operator API (E3.10, ADR-0058; owner: agent A): the operator session and
 * `/api/v1/platform/{me,workspaces*,cells,operators,audit,health}`. Plans and usage live in
 * `platform-plans.ts` (M), the manual subscription write in `billing.ts` (B), sanctions review in
 * `platform-sanctions.ts` (S).
 *
 * Every route but `POST /platform/session` is behind `requirePlatformOperator()` (operator cookie
 * session on the canonical host, live operator row, PLATFORM_OPERATOR_CIDRS, CSRF; a plain 404
 * otherwise). `POST /platform/session` needs the ordinary user session — the handler then demands
 * CONTROL_PLANE=on (else 404), the canonical host, auth level 2 and freshness ≤ 10 min
 * (`step_up_required`), a live operator (else 404), the CIDR (else 404) and a level-2 proof from a
 * factor older than the operator grant and the session (else 403 `forbidden`, R1-H1) before it mints the
 * separate `population: operator` session (`issueOperatorCookie`).
 *
 * No tenant content is returned anywhere here. Every write audits on the platform chain and, where
 * it concerns a tenant, on that workspace's chain too (hold changes do both through
 * `setWorkspaceHold`). Write answers carry `owners: []`: only the detail GET reads (and audits)
 * the owners' addresses.
 */

type Api = OpenAPIHono<AppEnv>;

const TAGS = ["platform"];
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);

type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "paused";

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The operator surface's one refusal: the same plain 404 the guard answers (no oracle). */
function notFound(c: Context<AppEnv>, reason: string): ApiError {
  markSecurityEvent(c, { event: "authz_denied", code: "not_found", reason });
  return markAuthzDenial(new ApiError("not_found", "no such path"));
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

function workspaceBody(w: PlatformWorkspace) {
  return {
    id: w.id,
    slug: w.slug,
    name: w.name,
    legalName: w.legalName,
    country: w.country,
    status: w.status,
    suspendedReason: w.suspendedReason,
    holds: [...w.holds],
    cellId: w.cellId,
    planId: w.planId,
    subscription:
      w.subscription === null
        ? null
        : {
            status: w.subscription.status as SubscriptionStatus,
            provider: w.subscription.provider,
            currentPeriodEnd: iso(w.subscription.currentPeriodEnd),
          },
    usage: w.usage === null ? null : { ...w.usage, computedAt: w.usage.computedAt.toISOString() },
    customDomains: w.customDomains,
    createdAt: w.createdAt.toISOString(),
    deletedAt: iso(w.deletedAt),
  };
}

function detailBody(w: PlatformWorkspaceDetail) {
  return {
    ...workspaceBody(w),
    sanctions:
      w.sanctions === null
        ? null
        : {
            outcome: w.sanctions.outcome,
            decision: w.sanctions.decision,
            createdAt: w.sanctions.createdAt.toISOString(),
          },
    owners: w.owners.map((o) => ({ email: o.email })),
  };
}

/** `PlatformError` / `ProvisioningError` → the API envelope. */
function platformApiError(error: unknown): unknown {
  if (error instanceof PlatformError || error instanceof ProvisioningError) {
    switch (error.reason) {
      case "not_found":
        return new ApiError("not_found", "no such workspace");
      case "invalid_cursor":
        return new ApiError("validation_failed", "bad cursor", { field: "cursor" });
      case "plan_unavailable":
        return new ApiError("invalid_request", error.message, { field: "planId" });
      case "cell_unavailable":
        return new ApiError("invalid_request", error.message, { field: "cellId" });
      case "sanctions_unresolved":
        return new ApiError(
          "sanctions_unresolved",
          error.message,
          error instanceof PlatformError && error.detail !== undefined
            ? { reason: error.detail }
            : {},
        );
      case "slug_taken":
        return new ApiError("slug_taken", error.message);
      case "invalid_email":
        return new ApiError("validation_failed", error.message, { field: "ownerEmail" });
      case "directory_unavailable":
        return new ApiError("directory_unavailable", error.message);
      case "hold_not_liftable":
        return new ApiError("conflict", error.message, { reason: "relocation" });
      case "relocating":
        return new ApiError("conflict", error.message, { reason: "relocating" });
    }
  }
  return error;
}

/**
 * E3.11: a cell of ANOTHER database is not a label change — the workspace's rows would stay here
 * while tenant resolution sends it there. `PATCH` refuses it with 409 `move_unavailable`
 * (`reason: use_move`: `POST /platform/workspaces/{id}/move`). A cell of this database (active
 * or not) and an id nobody knows go on to `changeWorkspacePlacement` as before (400
 * `cell_unavailable` for the unknown one), so local mode behaves exactly as in E3.10.
 */
async function refuseRemoteCell(deps: ApiDeps, cellId: string): Promise<void> {
  if (deps.directory.mode === "local") return;
  if (await cellAcceptsWorkspaces(deps.db, cellId)) return;
  let remote = false;
  try {
    remote = (await deps.directory.listCells()).some((d) => d.id === cellId && !d.local);
  } catch {
    throw new ApiError("directory_unavailable", "the cell directory could not be reached");
  }
  if (remote) {
    throw new ApiError(
      "move_unavailable",
      "that cell is served by another database: move the workspace there instead",
      { reason: "use_move" },
    );
  }
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw platformApiError(error);
  }
}

/**
 * The workspace as the operator API returns it; 404 when it is gone. `owners` only for the detail
 * GET (audited `platform.workspace.owners_read`) — a write answers `owners: []` and is never
 * recorded as an owners read.
 */
async function detailOr404(
  deps: ApiDeps,
  id: string,
  actor: ControlPlaneActor,
  opts: { readonly owners: boolean } = { owners: false },
): Promise<ReturnType<typeof detailBody>> {
  const detail = await getPlatformWorkspace(deps.controlPlane.operators.platform, id, actor, opts);
  if (detail === undefined) throw new ApiError("not_found", "no such workspace");
  return detailBody(detail);
}

export function registerPlatformRoutes(api: Api, deps: ApiDeps): void {
  const operator = requirePlatformOperator(deps);
  // A new operator's enrolment link and enrolment-only session (fix round 2).
  registerPlatformEnrolRoutes(api, deps);

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/session",
      tags: TAGS,
      summary: "Start an operator session",
      description:
        "Mints the separate operator session (`__Host-op_sid`, SameSite=Strict, 1 h idle / 12 h absolute) from a fresh (≤ 10 min) auth-level-2 user session on the canonical host. 404 unless the control plane is on and the caller is a live operator on an allowed network. 403 `forbidden` (`reason: factor_too_new|factor_required`) when the level-2 proof did not come from a passkey or authenticator that existed before the operator was granted and before the session was created (re-enrolling a factor needs a new grant).",
      security: sessionSecurity,
      "x-requires": "session",
      middleware: [requireSession()] as const,
      responses: { 200: jsonResponse(p.PlatformSessionSchema, "Operator session"), ...ERRORS },
    }),
    async (c) => {
      // Checks 1-3 (control plane, canonical host with no workspace, CIDR), then the session's
      // own shape, then the live operator row — every refusal the same 404. Only a live operator
      // on an allowed network learns that a step-up is what is missing.
      if (!platformSurfaceReachable(c, deps)) throw notFound(c, "platform_operator");
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const now = new Date();
      const refusal = operatorMintRefusal(s, now);
      if (refusal === "bound" || refusal === "population") throw notFound(c, "platform_operator");
      if (!(await isLiveOperator(deps.db, s.userId))) throw notFound(c, "platform_operator");
      if (refusal === "level") {
        throw new ApiError("step_up_required", "confirm it's you with a passkey or authenticator", {
          reason: "level",
          requiredLevel: 2,
          currentLevel: s.authLevel,
        });
      }
      if (refusal === "stale") {
        throw new ApiError("step_up_required", "please confirm it's you", {
          reason: "fresh",
          maxAgeMs: OPERATOR_MINT_MAX_AGE_MS,
          ageMs: now.getTime() - s.authTime.getTime(),
        });
      }
      // R1-H1: the level-2 proof must come from a factor that existed before the operator grant
      // and before this session (a mailbox holder who enrolled an authenticator of their own —
      // even before signing in again — is refused; a re-enrolled operator is granted again).
      const proof = await checkOperatorProof(deps.db, s);
      if (proof !== undefined) {
        markSecurityEvent(c, {
          event: "authz_denied",
          code: "forbidden",
          reason: `operator_${proof}`,
        });
        throw new ApiError(
          "forbidden",
          "confirm it's you with a passkey or authenticator you set up before this sign-in",
          { reason: proof === "unproven" ? "factor_required" : "factor_too_new" },
        );
      }
      // A browser that already held an operator session gets the new one in its place.
      const held = readOperatorCookie(c);
      const previous = held === undefined ? undefined : await deps.auth.resolveSession(held);
      const ip = clientIp(c, deps.trustProxy);
      const userAgent = c.req.header("user-agent")?.slice(0, 512);
      const started = await deps.auth.sessions.startSession({
        userId: s.userId,
        population: "operator",
        context: "first_party",
        authLevel: 2,
        // Never fresher than the proof it was minted from.
        authTime: s.authTime,
        // FR1 R2-L1 (F2): signing the canonical session out ends the operator session too.
        sourceSessionId: s.sessionId,
        ip,
        userAgent,
        ...(previous?.population === "operator" && previous.userId === s.userId
          ? { replacesSessionId: previous.sessionId }
          : {}),
      });
      await deps.audit.recordDetached(platformContext(), {
        action: "operator.session_start",
        resourceKind: "session",
        resourceId: started.session.sessionId,
        actorKind: "host",
        actorUserId: s.userId,
        sessionId: started.session.sessionId,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
        requestId: requestIdOf(c),
        meta: {
          operator: true,
          sourceSessionId: s.sessionId,
          authLevel: s.authLevel,
          authTime: s.authTime.toISOString(),
        },
      });
      issueOperatorCookie(c, started.token);
      return c.json(
        { ok: true as const, expiresAt: started.session.absoluteExpiresAt.toISOString() },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/platform/session",
      tags: TAGS,
      summary: "End the operator session",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      responses: { 204: { description: "Signed out" }, ...ERRORS },
    }),
    async (c) => {
      const op = platformOperatorOf(c);
      await deps.auth.revokeSession(op.sessionId, "logout");
      await deps.audit.recordDetached(platformContext(), {
        action: "operator.session_end",
        resourceKind: "session",
        resourceId: op.sessionId,
        actorKind: "host",
        actorUserId: op.userId,
        sessionId: op.sessionId,
        ip: clientIp(c, deps.trustProxy) ?? null,
        userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
        requestId: requestIdOf(c),
        meta: { operator: true },
      });
      clearOperatorCookie(c);
      return c.body(null, 204);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/me",
      tags: TAGS,
      summary: "The signed-in operator",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      responses: { 200: jsonResponse(p.PlatformMeSchema, "Operator"), ...ERRORS },
    }),
    async (c) => {
      const op = platformOperatorOf(c);
      const profile = await operatorProfile(deps.db, op.userId);
      return c.json(
        {
          userId: op.userId,
          email: profile?.email ?? null,
          displayName: profile?.displayName ?? op.session.user.displayName,
          cellId: deps.controlPlane.cellId,
          billingDriver: deps.billing.enabled ? deps.billing.driver : ("none" as const),
          session: {
            createdAt: op.session.createdAt.toISOString(),
            idleExpiresAt: op.session.idleExpiresAt.toISOString(),
            absoluteExpiresAt: op.session.absoluteExpiresAt.toISOString(),
          },
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/workspaces",
      tags: TAGS,
      summary: "Workspaces on this install",
      description:
        "Keyset-paged on `(createdAt, id)`. Names, plans, status, the latest usage row and the subscription summary — never tenant content.",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { query: p.PlatformWorkspaceListQuery },
      responses: { 200: jsonResponse(p.PlatformWorkspacePageSchema, "Page"), ...ERRORS },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const page = await guarded(() =>
        listPlatformWorkspaces(deps.db, {
          cursor: q.cursor,
          limit: q.limit,
          q: q.q,
          status: q.status,
          plan: q.plan,
        }),
      );
      return c.json({ items: page.items.map(workspaceBody), nextCursor: page.nextCursor }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/workspaces",
      tags: TAGS,
      summary: "Create a workspace",
      description:
        "Creates and seeds the workspace, invites the owner by email and runs the provisioning hooks (a sanctions screen may hold it `pending_review`; a plan with a price starts a subscription). 409 `slug_taken`.",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { body: jsonBody(p.PlatformWorkspaceCreateBody) },
      responses: { 201: jsonResponse(p.PlatformWorkspaceDetailSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const actor = operatorActor(c, deps);
      const created = await guarded(() =>
        provisionWorkspace(deps.controlPlane.operators.provisioning, {
          slug: body.slug,
          name: body.name,
          legalName: body.legalName,
          country: body.country,
          ownerEmail: body.ownerEmail,
          planId: body.planId,
          cellId: body.cellId,
          actor,
        }),
      );
      return c.json(await detailOr404(deps, created.id, actor), 201);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/workspaces/{id}",
      tags: TAGS,
      summary: "One workspace",
      description:
        "Adds the latest sanctions screening and the owners' email addresses (audited `platform.workspace.owners_read`).",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.PlatformWorkspaceIdParam },
      responses: { 200: jsonResponse(p.PlatformWorkspaceDetailSchema, "Workspace"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(await detailOr404(deps, id, operatorActor(c, deps), { owners: true }), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/platform/workspaces/{id}",
      tags: TAGS,
      summary: "Change a workspace's plan, cell, legal name or country",
      description:
        "Last write wins; audited `workspace.plan_change` / `workspace.cell_change` / `workspace.legal_change` on both chains. An archived plan cannot be assigned. A new legal name or country queues a sanctions re-screen when a driver is configured (a hit on a live workspace goes to the review queue; it never suspends by itself).",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.PlatformWorkspaceIdParam, body: jsonBody(p.PlatformWorkspacePatchBody) },
      responses: { 200: jsonResponse(p.PlatformWorkspaceDetailSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const actor = operatorActor(c, deps);
      if (body.cellId !== undefined) await refuseRemoteCell(deps, body.cellId);
      const changed = await guarded(() =>
        changeWorkspacePlacement(
          deps.controlPlane.operators.platform,
          id,
          {
            planId: body.planId,
            cellId: body.cellId,
            legalName: body.legalName,
            country: body.country,
          },
          actor,
        ),
      );
      if (changed === undefined) throw new ApiError("not_found", "no such workspace");
      // The screening subject moved: screen it again (after commit; its own transaction and
      // audit). Without a sanctions driver this is a no-op.
      if (changed.subjectChanged && deps.sanctions.service !== null) {
        await deps.sanctions.service.requestRescreen({
          workspaceId: id,
          operator: {
            userId: actor.userId,
            sessionId: actor.sessionId,
            requestId: actor.requestId,
            ip: actor.ip,
            userAgent: actor.userAgent,
          },
        });
      }
      return c.json(await detailOr404(deps, id, actor), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/workspaces/{id}/suspend",
      tags: TAGS,
      summary: "Suspend a workspace",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.PlatformWorkspaceIdParam, body: jsonBody(p.PlatformSuspendBody) },
      responses: { 200: jsonResponse(p.PlatformWorkspaceDetailSchema, "Suspended"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const actor = operatorActor(c, deps);
      const found = await suspendWorkspace(
        deps.controlPlane.operators.platform,
        id,
        { note: body.note },
        actor,
      );
      if (!found) throw new ApiError("not_found", "no such workspace");
      return c.json(await detailOr404(deps, id, actor), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/platform/workspaces/{id}/unsuspend",
      tags: TAGS,
      summary: "Lift a hold",
      description:
        "Clears ONE hold (`hold`, default `operator`); the others stay, so the workspace may still be held or suspended afterwards. `sanctions_review` needs the latest screening clear or cleared (or, with no sanctions driver and no screening at all, is released with `noScreening`); `sanctions` needs a LATER screening that is clear or a potential match decided cleared (never an error) and another operator than the one who confirmed it (409 `sanctions_unresolved`, `reason: not_cleared | four_eyes`); `billing` may be overridden (audited).",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { params: p.PlatformWorkspaceIdParam, body: jsonBody(p.PlatformUnsuspendBody) },
      responses: { 200: jsonResponse(p.PlatformWorkspaceDetailSchema, "Unsuspended"), ...ERRORS },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const actor = operatorActor(c, deps);
      const found = await guarded(() =>
        unsuspendWorkspace(
          deps.controlPlane.operators.platform,
          id,
          { note: body.note, hold: body.hold },
          actor,
        ),
      );
      if (!found) throw new ApiError("not_found", "no such workspace");
      return c.json(await detailOr404(deps, id, actor), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/cells",
      tags: TAGS,
      summary: "Cells",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      responses: { 200: jsonResponse(p.CellListSchema, "Cells"), ...ERRORS },
    }),
    async (c) => {
      const cells = await listCells(deps.db);
      // E3.11: the directory's view — heartbeats of this database's cells and the remote cells
      // (shared mode). An unreachable directory leaves the local list, logged, never a 5xx: the
      // console must still show what this cell serves during a directory outage.
      let directoryCells: readonly DirectoryCell[] = [];
      try {
        directoryCells = await deps.directory.listCells();
      } catch (error) {
        deps.log("platform.directory_cells_failed", {
          level: "warn",
          error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        });
      }
      const heartbeat = new Map(directoryCells.map((d) => [d.id, d.heartbeatAt]));
      const localIds = new Set(cells.map((cell) => cell.id));
      return c.json(
        {
          cells: [
            ...cells.map((cell) => ({
              id: cell.id,
              region: cell.region,
              regionLabel: cell.regionLabel,
              jurisdiction: cell.jurisdiction ?? null,
              publicOrigin: cell.publicOrigin,
              status: cell.status,
              local: true,
              heartbeatAt: iso(heartbeat.get(cell.id) ?? null),
              workspaces: cell.workspaces,
              createdAt: cell.createdAt.toISOString(),
            })),
            ...directoryCells
              .filter((d) => !d.local && !localIds.has(d.id))
              .sort((a, b) => a.id.localeCompare(b.id))
              .map((d) => ({
                id: d.id,
                region: d.region,
                regionLabel: d.regionLabel,
                jurisdiction: d.jurisdiction,
                publicOrigin: d.publicOrigin,
                status: d.status,
                local: false,
                heartbeatAt: iso(d.heartbeatAt),
                // Another cell's tenants are counted by that cell, never here.
                workspaces: null,
                createdAt: null,
              })),
          ],
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/operators",
      tags: TAGS,
      summary: "Platform operators",
      description: "Read-only: operators are granted and revoked with `fundroom operator`.",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      responses: { 200: jsonResponse(p.PlatformOperatorListSchema, "Operators"), ...ERRORS },
    }),
    async (c) => {
      const operators = await listOperators(deps.db);
      return c.json(
        {
          operators: operators.map((o) => ({
            userId: o.userId,
            email: o.email,
            createdAt: o.createdAt.toISOString(),
            createdBy: o.createdBy,
            revokedAt: iso(o.revokedAt),
          })),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/audit",
      tags: TAGS,
      summary: "The platform audit chain",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      request: { query: p.PlatformAuditQuery },
      responses: { 200: jsonResponse(p.PlatformAuditPageSchema, "Page"), ...ERRORS },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const page = await guarded(() =>
        platformAuditPage(deps.db, { cursor: q.cursor, limit: q.limit }),
      );
      return c.json(
        {
          items: page.items.map((e) => ({ ...e, occurredAt: e.occurredAt.toISOString() })),
          nextCursor: page.nextCursor,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/platform/health",
      tags: TAGS,
      summary: "Install health",
      description: "Queue depth per queue, the dead-letter count (no payloads) and adapter health.",
      security: sessionSecurity,
      "x-requires": "platform-operator",
      middleware: [operator] as const,
      responses: { 200: jsonResponse(p.PlatformHealthSchema, "Health"), ...ERRORS },
    }),
    async (c) => {
      // Instance facts only: queue depths, the dead-letter count (never a payload) and the same
      // adapter probes `/readyz` runs (cached there).
      const [queues, deadLetters, ready] = await Promise.all([
        deps.jobs.stats(),
        deps.jobs.deadLetters.count(),
        deps.readiness.run(),
      ]);
      return c.json(
        {
          queues: queues.map((q) => ({ name: q.name, queued: q.queued, active: q.active })),
          deadLetters,
          adapters: ready.checks.map((r) => ({
            name: r.name,
            status: r.status,
            detail: r.detail ?? null,
          })),
          checkedAt: new Date().toISOString(),
        },
        200,
      );
    },
  );
}
