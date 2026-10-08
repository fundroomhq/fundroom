import type { RelationshipSource } from "@fundroom/compliance";
import {
  ApiError,
  type ApiErrorCode,
  access as a,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Membership, ResolvedWorkspace, TenantContext } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import { type AccessRequestView, isAuthError } from "@fundroom/identity";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { type AcceptanceGate, requirePermission } from "../middleware/authz.js";
import { markSecurityEvent } from "../middleware/security-events.js";
import { requireWorkspace } from "../middleware/tenant.js";
import { canonicalInviteGrants, INVITE_DAILY_CAP, inviteBody } from "./access.js";
import { type ApiDeps, clientIp } from "./deps.js";

/*
 * Access requests (E3.1): the public "request access" form and the admin approval queue.
 *
 * Kernel routes behind the `required` `access` manifest (design/05 §5 row 198): the request is a
 * `core.access_request` row, approving one issues an ordinary `core.invite`, and accepting that
 * invite runs identity's `establishMembership` — every fact lives on a kernel table. Not the GDPR
 * "access request" (`core.dsar_request`, the compliance routes).
 *
 *  - Two public routes (`x-requires: public`) under `systemContext(workspace.id)`, answering
 *    404 `not_found` unless `access.requests.enabled`. Every "no" a stranger can provoke answers
 *    exactly like a "yes" (the same `expiresAt`; a neutral "received"), inside a duration floor.
 *  - Four admin routes keyed on the row id; externals get 404 from `requirePermission`.
 *
 * Every route carries `x-requires`, checked against packages/authz/matrix/authz-matrix.yaml in CI.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const APPROVE_ERRORS = errorResponses(400, 401, 403, 404, 409, 422, 429, 500, 503);
const TAGS = ["access"];

/** Per-workspace invitation cap, shared with POST /access/invites: an approval is an invitation. */
const INVITE_CAP_KEY = (workspaceId: string) => `invite:ws:${workspaceId}`;

type Vars = AppEnv["Variables"];
type Signed = {
  session: NonNullable<Vars["session"]>;
  membership: Membership;
  tenant: TenantContext;
  workspace: ResolvedWorkspace;
};

function signed(c: Context<AppEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!session || !membership || !tenant || !workspace) throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

/**
 * The workspace of a public call, or 404 when it does not take requests. Whether a workspace
 * takes requests is public (the bootstrap says so), so this refusal is no oracle.
 */
function takingRequests(c: Context<AppEnv>): ResolvedWorkspace {
  const workspace = c.get("workspace");
  if (workspace === undefined) throw new ApiError("setup_required");
  if (!parseWorkspaceSettings(workspace.settings).access.requests.enabled)
    throw new ApiError("not_found", "this workspace does not take access requests");
  return workspace;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The wire shape (`AccessRequest`). Never the code hash or the ip hash. */
function requestBody(v: AccessRequestView) {
  return {
    id: v.id,
    email: v.email,
    name: v.name,
    firm: v.firm ?? null,
    reason: v.reason ?? null,
    status: v.status,
    createdAt: v.createdAt.toISOString(),
    verifiedAt: iso(v.verifiedAt),
    expiresAt: v.expiresAt.toISOString(),
    suggestedGroupIds: [...v.suggestedGroupIds],
    autoApproved: v.autoApproved,
    decidedAt: iso(v.decidedAt),
    decidedBy: v.decidedBy
      ? { membershipId: v.decidedBy.membershipId, displayName: v.decidedBy.displayName }
      : null,
    decisionNote: v.decisionNote ?? null,
    relationship: v.relationship
      ? {
          source: v.relationship.source as RelationshipSource,
          establishedAt: v.relationship.establishedAt.toISOString(),
          note: v.relationship.note ?? null,
        }
      : null,
    inviteId: v.inviteId ?? null,
    membershipId: v.membershipId ?? null,
  };
}

/** Service refusals (`AuthError`: not_found, conflict, relationship_attestation_required, …). */
function rethrow(error: unknown): never {
  if (isAuthError(error))
    throw new ApiError(error.code as ApiErrorCode, error.message, error.details);
  throw error;
}

export function registerAccessRequestRoutes(
  api: OpenAPIHono<AppEnv>,
  deps: ApiDeps,
  _gate: AcceptanceGate,
): void {
  const perm = (p: string, fresh = false) =>
    requirePermission({ authz: () => deps.authz }, p, { fresh });
  // Read on use, never at registration: the OpenAPI generator registers against throwing stubs.
  const requests = () => deps.accessRequests;

  // --- public ---------------------------------------------------------------------------------

  api.openapi(
    createRoute({
      method: "post",
      path: "/access-requests/start",
      tags: TAGS,
      summary: "Ask for access to this workspace and get an emailed code (public)",
      description:
        "Available only when the workspace takes access requests (`access.requests.enabled`); otherwise 404. The reply is the same for every well-formed submission — a new request, one already pending, an address that already has access (it is mailed a sign-in hint instead of a code), a filled honeypot, a rate limit or a full queue — and takes the same minimum time, so it cannot be used to learn anything about an address. `expiresAt` is always the instant the submission arrived plus the code lifetime. Send the address and the mailed code to `/access-requests/verify`; submitting again mails another code, and every unexpired code keeps working.",
      "x-requires": "public",
      middleware: [requireWorkspace()] as const,
      request: { body: jsonBody(a.AccessRequestStartBody) },
      responses: {
        202: jsonResponse(a.AccessRequestChallengeSchema, "Challenge (always)"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const workspace = takingRequests(c);
      const body = c.req.valid("json");
      // The service answers every "no" with a decoy and floors its own duration; nothing here
      // may branch on what it did.
      const r = await requests().start({
        workspace,
        email: body.email,
        name: body.name,
        firm: body.firm ?? null,
        reason: body.reason ?? null,
        honeypot: body.website ?? null,
        clientIp: clientIp(c, deps.trustProxy) ?? null,
      });
      // A tripped workspace/IP budget is a security event for the operator (a log line and a
      // counter, emitted by the request log after the response) — never a different answer.
      if (r.throttled !== null)
        markSecurityEvent(c, {
          event: "access_request_throttled",
          code: "decoy",
          reason: `${r.throttled}_budget`,
        });
      return c.json({ expiresAt: r.expiresAt.toISOString() }, 202);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access-requests/verify",
      tags: TAGS,
      summary: "Prove the address with the emailed code; the request enters the queue (public)",
      description:
        'Available only when the workspace takes access requests; otherwise 404. Accepts any unexpired code mailed to `email` for this workspace. An address with no request, a wrong or expired code and too many attempts (5 per 15 minutes per address) are the same 400 `invalid_code`. Success is always `{ status: "received" }`, whether the request was queued, approved automatically, or set aside — whether it can be considered is never revealed.',
      "x-requires": "public",
      middleware: [requireWorkspace()] as const,
      request: { body: jsonBody(a.AccessRequestVerifyBody) },
      responses: {
        200: jsonResponse(a.AccessRequestReceivedSchema, "Received (always)"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const workspace = takingRequests(c);
      const body = c.req.valid("json");
      const r = await requests().verify({
        workspace,
        email: body.email,
        code: body.code,
      });
      if (!r.ok) throw new ApiError("invalid_code", "the code is wrong or no longer valid");
      return c.json({ status: "received" as const }, 200);
    },
  );

  // --- admin queue ----------------------------------------------------------------------------

  api.openapi(
    createRoute({
      method: "get",
      path: "/access/requests",
      tags: TAGS,
      summary: "Access requests by status, newest first (pending by default)",
      description:
        "Verified requests only; an address that never proved its code is not listed. Keyset-paginated: pass `nextCursor` back as `cursor`.",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { query: a.AccessRequestListQuery },
      responses: { 200: jsonResponse(a.AccessRequestPageSchema, "Access requests"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const q = c.req.valid("query");
      const page = await deps.db
        .withTenant(s.tenant, (tx) =>
          requests().list(s.tenant, tx, {
            status: q.status,
            ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
            limit: q.limit,
          }),
        )
        .catch(rethrow);
      return c.json({ items: page.items.map(requestBody), nextCursor: page.nextCursor }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/access/requests/{id}",
      tags: TAGS,
      summary: "One access request",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { params: a.AccessRequestIdParams },
      responses: { 200: jsonResponse(a.AccessRequestSchema, "Access request"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const id = c.req.valid("param").id;
      const view = await deps.db.withTenant(s.tenant, (tx) => requests().get(s.tenant, tx, id));
      if (!view) throw new ApiError("not_found", "no such access request");
      return c.json(requestBody(view), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/requests/{id}/approve",
      tags: TAGS,
      summary: "Approve a pending request: issue an ordinary invitation to the requester",
      description:
        'Creates the invitation exactly like POST /access/invites (grants canonicalised, the workspace\'s daily invitation cap applies) and links it to the request; the requester then signs in through the ordinary invite flow. 409 `conflict` when the request is no longer pending, the address is already a member, or it already has a pending invitation (details `{ reason: "invite_pending" }`). Under Rule 506(b) the approver must attest the pre-existing relationship (`relationship`), otherwise 422 `relationship_attestation_required`; a relationship dated in the future is 400 `validation_failed`. The approval is committed before the invitation is mailed: `mailSent: false` means the mail failed and the invitation should be resent from People → Invites.',
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { params: a.AccessRequestIdParams, body: jsonBody(a.AccessRequestApproveBody) },
      responses: {
        200: jsonResponse(a.AccessRequestApproveResultSchema, "Approved"),
        ...APPROVE_ERRORS,
      },
    }),
    async (c) => {
      const s = signed(c);
      const id = c.req.valid("param").id;
      const body = c.req.valid("json");
      // Unknown (or another tenant's) and already-decided requests are refused before anything
      // else; the service checks both again under its row lock.
      const current = await deps.db.withTenant(s.tenant, (tx) => requests().get(s.tenant, tx, id));
      if (!current) throw new ApiError("not_found", "no such access request");
      if (current.status !== "pending")
        throw new ApiError("conflict", `the request is already ${current.status}`, {
          status: current.status,
        });
      // Checked (and their paths derived) before anything is written or mailed, exactly like
      // POST /access/invites. The 506(b) attestation, the relationship date, the address's
      // standing and the groups are the service's checks, against a fresh read of the workspace.
      const grants = await canonicalInviteGrants(deps, s.tenant, body.grants);
      // An approval is an invitation: it spends the same per-workspace daily cap — once every
      // check that can refuse it has passed (C7), which is when the service calls this.
      const spendInviteSlot = async () => {
        const cap = await deps.rateLimiter.hit(INVITE_CAP_KEY(s.workspace.id), INVITE_DAILY_CAP);
        if (!cap.allowed)
          throw new ApiError(
            "rate_limited",
            "daily invitation cap reached for this workspace",
            { retryAfterMs: cap.retryAfterMs },
            { headers: { "Retry-After": String(Math.ceil(cap.retryAfterMs / 1000)) } },
          );
      };
      try {
        const r = await requests().approve(s.tenant, {
          id,
          actorMembershipId: s.membership.id,
          actorName: s.session.user.displayName || undefined,
          workspace: s.workspace,
          groupIds: body.groupIds,
          grants,
          expiresInDays:
            body.expiresInDays ??
            parseWorkspaceSettings(s.workspace.settings).access.inviteExpiryDays,
          message: body.message,
          note: body.note,
          relationship: body.relationship
            ? {
                source: body.relationship.source,
                establishedAt: new Date(body.relationship.establishedAt),
                note: body.relationship.note ?? null,
              }
            : undefined,
          requestId: requestIdOf(c),
          beforeWrite: spendInviteSlot,
        });
        return c.json(
          { request: requestBody(r.request), invite: inviteBody(r.invite), mailSent: r.mailSent },
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
      path: "/access/requests/{id}/deny",
      tags: TAGS,
      summary: "Deny a pending request",
      description:
        "409 `conflict` when the request is no longer pending. With `notifyRequester` (default) the requester gets a neutral mail that never contains the internal note.",
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { params: a.AccessRequestIdParams, body: jsonBody(a.AccessRequestDenyBody) },
      responses: { 200: jsonResponse(a.AccessRequestDenyResultSchema, "Denied"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const id = c.req.valid("param").id;
      const body = c.req.valid("json");
      try {
        const r = await requests().deny(s.tenant, {
          id,
          actorMembershipId: s.membership.id,
          workspace: s.workspace,
          note: body.note,
          notifyRequester: body.notifyRequester,
          requestId: requestIdOf(c),
        });
        return c.json({ request: requestBody(r.request) }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );
}
