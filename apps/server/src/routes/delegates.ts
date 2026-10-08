import {
  ApiError,
  access as a,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import { type Actor, type DelegateView, isAuthError } from "@fundroom/identity";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireFreshAuth } from "../middleware/auth.js";
import { type AcceptanceGate, requireMember, requirePermission } from "../middleware/authz.js";
import { INVITE_DAILY_CAP } from "./access.js";
import type { ApiDeps } from "./deps.js";

/*
 * Delegates (E3.2, design/05 §4.2, §5 "Delegates", §7 "Delegate abuse"): an investor's own
 * delegates under `/access/my/delegates` (member; writes need a fresh sign-in and
 * `access.allowDelegates`), and any investor's delegates from the People screen under
 * `/access/people/{id}/delegates` (`access.manage`; writes fresh). Adding one issues an ordinary
 * invitation acting for the principal, counted under the workspace's daily invitation cap; the
 * rules on who may add one live in identity's `services/delegates.ts`, what a delegate then sees
 * in `@fundroom/authz`.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const TAGS = ["access"];

type Vars = AppEnv["Variables"];
interface Signed {
  readonly session: NonNullable<Vars["session"]>;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<AppEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!session || !membership || !tenant || !workspace) throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

function actorOf(s: Signed): Actor {
  return { membershipId: s.membership.id, userId: s.session.userId, role: s.membership.role };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function delegateBody(d: DelegateView) {
  return {
    kind: d.kind,
    id: d.id,
    email: d.email,
    displayName: d.displayName,
    scope: d.scope,
    status: d.status,
    createdAt: d.createdAt.toISOString(),
    expiresAt: iso(d.expiresAt),
    lastSeenAt: iso(d.lastSeenAt),
  };
}

// The admin route keeps its precise errors (a `conflict` names the membership); the self-service
// route never reaches one for an address (F1: the service skips instead of refusing).
function rethrow(error: unknown): never {
  if (isAuthError(error)) throw new ApiError(error.code as never, error.message, error.details);
  throw error;
}

export function registerDelegateRoutes(
  api: OpenAPIHono<AppEnv>,
  deps: ApiDeps,
  gate: AcceptanceGate,
): void {
  const perm = (p: string, fresh = false) =>
    requirePermission({ authz: () => deps.authz }, p, { fresh });

  async function listFor(s: Signed, principalMembershipId: string) {
    const settings = parseWorkspaceSettings(s.workspace.settings).access;
    const delegates = await deps.auth.delegates.list(s.tenant, principalMembershipId);
    return {
      delegates: delegates.map(delegateBody),
      limit: settings.maxDelegatesPerPrincipal,
      selfService: settings.allowDelegates,
    };
  }

  async function add(
    c: Context<AppEnv>,
    s: Signed,
    principalMembershipId: string,
    by: "self" | "staff",
    body: {
      email: string;
      displayName?: string | undefined;
      scope: "all" | "data_room" | "updates";
      message?: string | undefined;
    },
  ) {
    const settings = parseWorkspaceSettings(s.workspace.settings).access;
    // Self-service refusals (disabled) are answered first. The per-principal budget (F2) and the
    // workspace's shared daily invitation cap (design/05 §7 "invite spam") are both the service's
    // business: the budget is checked first, and the cap is spent only when an invitation is
    // really sent — a skipped or refused add must not drain what every other
    // invitation in the workspace shares.
    if (by === "self" && !settings.allowDelegates)
      throw new ApiError("delegates_disabled", "this workspace does not allow delegates");
    const spendInviteCap = async () => {
      const cap = await deps.rateLimiter.hit(`invite:ws:${s.workspace.id}`, INVITE_DAILY_CAP);
      if (!cap.allowed)
        throw new ApiError(
          "rate_limited",
          "daily invitation cap reached for this workspace",
          { retryAfterMs: cap.retryAfterMs },
          { headers: { "Retry-After": String(Math.ceil(cap.retryAfterMs / 1000)) } },
        );
    };
    try {
      await deps.auth.delegates.add(s.tenant, {
        principalMembershipId,
        email: body.email,
        displayName: body.displayName,
        scope: body.scope,
        // F2: never from the self-service route (its body schema has no `message` either).
        message: by === "staff" ? body.message : undefined,
        by,
        spendInviteCap,
        actor: actorOf(s),
        allowDelegates: settings.allowDelegates,
        maxDelegates: settings.maxDelegatesPerPrincipal,
        expiresInDays: settings.inviteExpiryDays,
        workspaceName: s.workspace.name,
        inviterName: s.session.user.displayName || undefined,
        requestId: requestIdOf(c),
      });
    } catch (error) {
      if (isAuthError(error) && error.code === "rate_limited") {
        const retryAfterMs = Number(error.details["retryAfterMs"] ?? 60_000);
        throw new ApiError(
          "rate_limited",
          error.message,
          { retryAfterMs },
          { headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } },
        );
      }
      rethrow(error);
    }
    deps.authz.invalidate(s.workspace.id);
  }

  // --- the investor's own delegates ------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/access/my/delegates",
      tags: TAGS,
      summary: "The caller's delegates (accepted and pending) and the workspace's delegate policy",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [requireMember({ gate })] as const,
      responses: { 200: jsonResponse(a.DelegateListSchema, "Delegates"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      // A delegate has no delegates of its own; staff are nobody's principal. Both see an empty list.
      if (s.membership.role !== "investor") {
        const settings = parseWorkspaceSettings(s.workspace.settings).access;
        return c.json(
          {
            delegates: [],
            limit: settings.maxDelegatesPerPrincipal,
            selfService: false,
          },
          200,
        );
      }
      return c.json(await listFor(s, s.membership.id), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/my/delegates",
      tags: TAGS,
      summary: "Add a delegate who acts for the caller (emails an invitation)",
      description:
        'Only an active investor may add delegates, only while `access.allowDelegates` is on, and at most `access.maxDelegatesPerPrincipal` (accepted + pending). A delegate cannot add delegates. Answers `202 {status: "sent"}` for every address: one that is already a member here (in any state) or already has a pending invitation gets no invitation and no error, so this route does not say who is a member. At most ten adds a day per investor (skipped and withdrawn ones included), and the workspace\'s daily invitation cap; the caller and staff holding `access.manage` are notified. The invitation email names the investor; the caller cannot add a message to it.',
      security: sessionSecurity,
      "x-requires": "member+fresh",
      middleware: [requireMember({ gate }), requireFreshAuth()] as const,
      request: { body: jsonBody(a.MyDelegateCreateBody) },
      responses: { 202: jsonResponse(a.DelegateAddAcceptedSchema, "Accepted"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      if (s.membership.role === "delegate")
        throw new ApiError("forbidden", "a delegate cannot add delegates", {
          reason: "delegate_cannot_delegate",
        });
      if (s.membership.kind !== "external")
        throw new ApiError("forbidden", "only an investor can add delegates", {
          reason: "principal_not_investor",
        });
      await add(c, s, s.membership.id, "self", c.req.valid("json"));
      return c.json({ status: "sent" as const }, 202);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/access/my/delegates/{id}",
      tags: TAGS,
      summary: "Remove one of the caller's delegates (revokes it, or withdraws its invitation)",
      security: sessionSecurity,
      "x-requires": "member+fresh",
      middleware: [requireMember({ gate }), requireFreshAuth()] as const,
      request: { params: a.MyDelegateParams },
      responses: { 200: jsonResponse(OkSchema, "Removed"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      if (s.membership.role !== "investor") throw new ApiError("not_found", "no such delegate");
      try {
        await deps.auth.delegates.remove(s.tenant, {
          principalMembershipId: s.membership.id,
          delegateId: c.req.valid("param").id,
          by: "self",
          actor: actorOf(s),
          requestId: requestIdOf(c),
        });
      } catch (error) {
        rethrow(error);
      }
      deps.authz.invalidate(s.workspace.id);
      return c.json({ ok: true as const }, 200);
    },
  );

  // --- admin: any investor's delegates (People screen) -------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/access/people/{id}/delegates",
      tags: TAGS,
      summary: "A member's delegates (accepted and pending)",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { params: a.MyDelegateParams },
      responses: { 200: jsonResponse(a.DelegateListSchema, "Delegates"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { id } = c.req.valid("param");
      const person = await deps.auth.memberships.person(s.tenant, id);
      if (person === undefined) throw new ApiError("not_found", "no such member");
      return c.json(await listFor(s, id), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/people/{id}/delegates",
      tags: TAGS,
      summary: "Add a delegate for an investor (emails an invitation)",
      description:
        "Works whatever `access.allowDelegates` says; the investor must be active and the limit `access.maxDelegatesPerPrincipal` still applies. Counted under the daily invitation cap; the investor and staff holding `access.manage` are notified.",
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true)] as const,
      request: { params: a.MyDelegateParams, body: jsonBody(a.DelegateCreateBody) },
      responses: { 200: jsonResponse(a.DelegateListSchema, "Delegates"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const principalMembershipId = c.req.valid("param").id;
      await add(c, s, principalMembershipId, "staff", c.req.valid("json"));
      return c.json(await listFor(s, principalMembershipId), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/access/people/{id}/delegates/{delegateId}",
      tags: TAGS,
      summary: "Remove an investor's delegate (revokes it, or withdraws its invitation)",
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true)] as const,
      request: { params: a.PersonDelegateParams },
      responses: { 200: jsonResponse(OkSchema, "Removed"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const p = c.req.valid("param");
      try {
        await deps.auth.delegates.remove(s.tenant, {
          principalMembershipId: p.id,
          delegateId: p.delegateId,
          by: "staff",
          actor: actorOf(s),
          requestId: requestIdOf(c),
        });
      } catch (error) {
        rethrow(error);
      }
      deps.authz.invalidate(s.workspace.id);
      return c.json({ ok: true as const }, 200);
    },
  );
}
