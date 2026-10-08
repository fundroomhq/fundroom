import {
  type Gate,
  GrantRepo,
  gateOfRow,
  PolicyRepo,
  parseTstzRange,
  subjectOfRow,
} from "@fundroom/authz";
import {
  createRelationshipService,
  isComplianceError,
  LegalDocumentRepo,
  type RelationshipSource,
  relationshipWarning,
} from "@fundroom/compliance";
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
  sessionOrApiKeySecurity,
  sessionSecurity,
} from "@fundroom/contracts";
import {
  type AccessGrant,
  type AccessPolicy,
  type Group,
  type Invite,
  type InviteImport,
  lockWorkspaceFacts,
  type Membership,
  type OfferingStatus,
  type TenantContext,
  type Tx,
  updateWorkspaceSettingsBlock,
} from "@fundroom/db";
import { parseWorkspaceSettings, WorkspaceSettingsSchema } from "@fundroom/domain";
import {
  type Actor,
  GroupRepo,
  INVITE_IMPORT_JOB,
  isAuthError,
  MembershipRepo,
  type PersonRow,
} from "@fundroom/identity";
import type {
  AccessHolder,
  AccessVia,
  RateLimitRule,
  RequestFacts,
  ResourceRef,
  SubjectRef,
} from "@fundroom/ports";
import { ShareLinkRepo } from "@fundroom/share-links";
import type { Context } from "hono";
import { lookupResource } from "../access/repos/resource-repo.js";
import type { AppEnv } from "../env.js";
import { type AcceptanceGate, requireMember, requirePermission } from "../middleware/authz.js";
import { type ApiDeps, requestFactsOf } from "./deps.js";

/*
 * Access management (E1.1, §6.4, §13.1, §13.2): people, invitations, CSV imports, groups,
 * grants, policy gates, "who has access / why", workspace access settings. Every route
 * carries `x-requires` (checked against packages/authz/matrix/authz-matrix.yaml in CI) and
 * mounts the matching `requirePermission` / `requireMember` middleware.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const TAGS = ["access"];

/** Per-workspace invitation cap (design/05 §7 "invite spam"). */
export const INVITE_DAILY_CAP: RateLimitRule = { max: 500, windowMs: 24 * 3600_000 };

type Vars = AppEnv["Variables"];
type Signed = {
  session: NonNullable<Vars["session"]>;
  membership: Membership;
  tenant: TenantContext;
  workspace: NonNullable<Vars["workspace"]>;
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
 * What a key-callable read (E3.4, ADR-0052) needs: the resolved workspace and the acting
 * membership, with **no** session. An API key acts as its creator's membership, so these are set
 * by the bearer resolver exactly as a session sets them; handlers built on this must not read
 * anything session-bound (display name, auth level, session id).
 */
type Scoped = Omit<Signed, "session">;

function scoped(c: Context<AppEnv>): Scoped {
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if ((!c.get("session") && !c.get("apiKey")) || !membership || !tenant || !workspace)
    throw new ApiError("unauthenticated");
  return { membership, tenant, workspace };
}

function actorOf(s: Signed): Actor {
  return { membershipId: s.membership.id, userId: s.session.userId, role: s.membership.role };
}

/**
 * One builder for the evaluator's request facts, shared with every module through
 * `ModuleServices.requestFacts` (E2.3 contract §5.6). It used to be built by hand here and again
 * in the data room; a `min_auth_level` gate that cannot see `authLevel` fails open, so two copies
 * of this object were one missed field away from a silent hole.
 */
function factsOf(c: Context<AppEnv>, deps: ApiDeps): RequestFacts {
  return requestFactsOf(c, deps.trustProxy);
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * What the R5 warning heuristic needs beyond the membership row itself. Read once per request
 * from the resolved workspace rather than per person: it is the same answer for everybody, and
 * a page of two hundred people should not ask the database two hundred times.
 */
interface RelationshipFacts {
  readonly offeringStatus: OfferingStatus;
  readonly warningDays: number;
}

function relationshipFactsOf(s: Pick<Signed, "workspace">): RelationshipFacts {
  return {
    offeringStatus: s.workspace.offeringStatus,
    warningDays: parseWorkspaceSettings(s.workspace.settings).legal.relationshipWarningDays,
  };
}

/**
 * A grant or gate names a resource that must exist **in this workspace** (pen test P1-03), the
 * same way the subject beside it must. The lookup runs inside the caller's tenant transaction, so
 * another workspace's id is invisible (RLS) and answers exactly like an id nobody minted: one
 * 404 `unknown_resource`, no oracle. A kind no module registered can never be satisfied by
 * anybody (share-link contract S3) and is refused as `unsupported`.
 *
 * The rule's `path` is **derived from the resource row**, never taken from the client (review
 * R1-A1/A2): a path is a scope — the rule covers every node at or below it, whatever its kind
 * (ADR-0034) — so a client-chosen one is a client-chosen blast radius. Only a container (a data
 * room folder) has one, its own; a document is a leaf matched by id, and a flat kind (`post`) or
 * a kind the kernel cannot look up gets none. A `path` the client does send must be exactly the
 * derived one, else 400 `resource_path_mismatch` — the web Share sheet used to send a document's
 * *folder* path, which turned "share this document" into "share this folder".
 */
export async function canonicalResource(
  tx: Tx,
  tenant: TenantContext,
  kinds: Readonly<Record<string, unknown>>,
  resource: { readonly kind: string; readonly id: string; readonly path?: string | undefined },
): Promise<ResourceRef> {
  if (!Object.hasOwn(kinds, resource.kind))
    throw new ApiError("unsupported", `no module owns resources of kind ${resource.kind}`, {
      reason: "unknown_resource_kind",
    });
  const found = await lookupResource(tx, tenant, resource.kind, resource.id);
  if (found.state === "missing")
    throw new ApiError("not_found", "no such resource", { reason: "unknown_resource" });
  const path = found.state === "found" ? found.path : null;
  if (resource.path !== undefined && resource.path !== path)
    throw new ApiError(
      "validation_failed",
      path === null
        ? `a rule on a ${resource.kind} is matched by id and carries no path`
        : "the path is not this resource's path",
      { reason: "resource_path_mismatch" },
    );
  return { kind: resource.kind, id: resource.id, ...(path === null ? {} : { path }) };
}

/**
 * A delegate acts for a principal (`principal_membership_id`), and a plain invitation names none:
 * accepting one made a `delegate` membership that acted for nobody (E3.2). Refused as
 * `validation_failed` here and in CSV imports: delegates are added through their own routes
 * (`routes/delegates.ts`), which name the principal and the scope.
 */
function refuseDelegateInvite(role: string): void {
  if (role === "delegate")
    throw new ApiError("validation_failed", "a delegate is added for a principal, not invited", {
      reason: "delegate_invite",
    });
}

/** Every invite grant's resource, canonicalised as a direct grant's is (R1-A1/A2). */
export async function canonicalInviteGrants<G extends { readonly resource: ResourceRef }>(
  deps: ApiDeps,
  tenant: TenantContext,
  grants: readonly G[],
): Promise<G[]> {
  if (grants.length === 0) return [];
  return deps.db.withTenant(tenant, async (tx) => {
    const out: G[] = [];
    for (const g of grants)
      out.push({
        ...g,
        resource: await canonicalResource(tx, tenant, deps.registry.resourceKinds, g.resource),
      });
    return out;
  });
}

/** An `nda` gate's `documentId` must be a live legal document of this workspace (P1-03). */
async function assertLegalDocumentHere(
  tx: Tx,
  tenant: TenantContext,
  documentId: string | undefined,
): Promise<void> {
  if (documentId === undefined) return;
  if ((await new LegalDocumentRepo(tenant, tx).byId(documentId)) === undefined)
    throw new ApiError("not_found", "no such legal document", { reason: "unknown_resource" });
}

export function personBody(row: PersonRow, facts: RelationshipFacts) {
  const m = row.membership;
  // Staff are never warned about: a pre-existing relationship is something Rule 506(b) asks of
  // the people being offered securities, not of the company offering them.
  const warning =
    m.kind === "staff"
      ? undefined
      : relationshipWarning({
          offeringStatus: facts.offeringStatus,
          membershipCreatedAt: m.createdAt,
          relationshipEstablishedAt: m.relationshipEstablishedAt,
          relationshipSource: m.relationshipSource,
          firstExposureAt: m.firstExposureAt,
          warningDays: facts.warningDays,
        });
  return {
    membershipId: m.id,
    userId: m.userId,
    kind: m.kind,
    role: m.role,
    status: m.status,
    displayName: row.displayName,
    email: row.email,
    groups: row.groups.map((g) => ({ id: g.id, name: g.name })),
    profile: (m.profile as Record<string, unknown>) ?? {},
    source: m.source,
    principalMembershipId: m.principalMembershipId ?? null,
    delegateScope: m.delegateScope ?? null,
    principal: row.principal,
    expiresAt: iso(m.expiresAt),
    lastSeenAt: iso(m.lastSeenAt),
    activatedAt: iso(m.activatedAt),
    createdAt: m.createdAt.toISOString(),
    relationship: {
      establishedAt: iso(m.relationshipEstablishedAt),
      source: (m.relationshipSource ?? null) as RelationshipSource | null,
      note: m.relationshipNote ?? null,
      firstExposureAt: iso(m.firstExposureAt),
      warning: warning ?? null,
    },
  };
}

export function inviteBody(i: Invite) {
  return {
    id: i.id,
    email: i.email,
    kind: i.kind,
    role: i.role,
    groupIds: i.groupIds,
    status: i.status,
    message: i.message,
    expiresAt: i.expiresAt.toISOString(),
    createdAt: i.createdAt.toISOString(),
    invitedBy: i.invitedBy ?? null,
    acceptedAt: iso(i.acceptedAt),
    acceptedMembershipId: i.acceptedMembershipId ?? null,
    principalMembershipId: i.principalMembershipId ?? null,
    delegateScope: i.delegateScope ?? null,
  };
}

function groupBody(g: Group & { memberCount: number }) {
  return {
    id: g.id,
    name: g.name,
    kind: (["custom", "round", "board", "advisors"].includes(g.kind) ? g.kind : "custom") as
      | "custom"
      | "round"
      | "board"
      | "advisors",
    memberCount: g.memberCount,
    createdAt: g.createdAt.toISOString(),
  };
}

function resourceBody(r: ResourceRef) {
  return { kind: r.kind, id: r.id, ...(r.path === undefined ? {} : { path: r.path }) };
}

function grantBody(g: AccessGrant) {
  const v = parseTstzRange(g.validity);
  return {
    id: g.id,
    subject: subjectOfRow(g) as SubjectRef & { role: "owner" },
    resource: resourceBody({
      kind: g.resourceKind,
      id: g.resourceId,
      path: g.resourcePath ?? undefined,
    }),
    capability: g.capability,
    effect: g.effect,
    validFrom: iso(v.from),
    validUntil: iso(v.until),
    note: g.note,
    createdBy: g.createdBy ?? null,
    createdAt: g.createdAt.toISOString(),
  };
}

/**
 * The gate's target, narrowed one arm at a time.
 *
 * Written as a `switch` rather than the nested ternary it replaced because the ternary's else
 * branch collapsed to `{ kind: "group" | "membership" | "link"; id }`, which is not assignable to
 * `PolicyTargetSchema`'s discriminated union — TypeScript cannot distribute a widened discriminant
 * back over the arms. E2.3's `link` arm made that a build error rather than a latent one.
 */
function policyTargetBody(target: Gate["target"]) {
  switch (target.kind) {
    case "workspace":
      return { kind: "workspace" as const };
    case "group":
      return { kind: "group" as const, id: target.id };
    case "membership":
      return { kind: "membership" as const, id: target.id };
    case "link":
      return { kind: "link" as const, id: target.id };
    default:
      return { kind: "resource" as const, resource: resourceBody(target.resource) };
  }
}

function policyBody(p: AccessPolicy) {
  const target = policyTargetBody(gateOfRow(p).target);
  return {
    id: p.id,
    kind: p.kind,
    target,
    config: (p.config ?? {}) as Record<string, never>,
    createdAt: p.createdAt.toISOString(),
    createdBy: p.createdBy ?? null,
  };
}

function importBody(i: InviteImport) {
  return {
    id: i.id,
    status: i.status,
    total: i.total,
    invited: i.invited,
    skipped: i.skipped,
    failed: i.failed,
    rows: i.rows as never[],
    createdAt: i.createdAt.toISOString(),
    startedAt: iso(i.startedAt),
    finishedAt: iso(i.finishedAt),
  };
}

function parseStatuses(raw: string | undefined): Membership["status"][] {
  const all: Membership["status"][] = ["invited", "active", "dormant", "suspended", "revoked"];
  if (raw === undefined) return ["invited", "active", "dormant", "suspended"];
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Membership["status"] => (all as string[]).includes(s));
  if (out.length === 0) throw new ApiError("validation_failed", "unknown status filter");
  return out;
}

function rethrow(error: unknown): never {
  if (isAuthError(error)) throw new ApiError(error.code as never, error.message, error.details);
  throw error;
}

/** Resolves subject labels for `via` rows (people and group names) in one tenant read. */
async function labelVia(
  deps: ApiDeps,
  ctx: TenantContext,
  holders: readonly { readonly via: readonly AccessVia[] }[],
): Promise<(v: AccessVia) => ReturnType<typeof viaBody>> {
  const membershipIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const h of holders)
    for (const v of h.via) {
      if (v.subject.kind === "membership") membershipIds.add(v.subject.id);
      if (v.subject.kind === "group") groupIds.add(v.subject.id);
    }
  const { names, groups } = await deps.db.withTenant(ctx, async (tx) => ({
    names: await new MembershipRepo(ctx, tx).namesFor([...membershipIds]),
    groups: new Map((await new GroupRepo(ctx, tx).byIds([...groupIds])).map((g) => [g.id, g.name])),
  }));
  return (v) => {
    const s = v.subject;
    const label =
      s.kind === "membership"
        ? names.get(s.id)?.displayName || names.get(s.id)?.email || "member"
        : s.kind === "group"
          ? (groups.get(s.id) ?? "group")
          : s.kind === "role"
            ? s.role
            : "link";
    return viaBody(v, label);
  };
}

function viaBody(v: AccessVia, label: string) {
  const s = v.subject;
  return {
    subject: {
      kind: s.kind,
      ...(s.kind === "role" ? { role: s.role as Membership["role"] } : { id: s.id }),
      label,
    },
    grantId: v.grantId,
    capability: v.capability,
    effect: v.effect,
    resource: resourceBody(v.resource),
    inherited: v.inherited,
    decisive: v.decisive,
    validUntil: iso(v.validUntil),
  };
}

export function registerAccessRoutes(
  api: OpenAPIHono<AppEnv>,
  deps: ApiDeps,
  gate: AcceptanceGate,
): void {
  const perm = (p: string, fresh = false) =>
    requirePermission({ authz: () => deps.authz }, p, { fresh });
  /** An `apiKey: true` matrix row (E3.4): a workspace API key holding `p` may call it too. */
  const keyPerm = (p: string) =>
    requirePermission({ authz: () => deps.authz }, p, { apiKey: true });

  // --- people ------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/access/people",
      tags: TAGS,
      summary: "People in this workspace (staff and external) with their groups",
      security: sessionOrApiKeySecurity,
      "x-requires": "access.read+apikey",
      middleware: [keyPerm("access.read")] as const,
      request: { query: a.PeopleQuery },
      responses: { 200: jsonResponse(a.PeoplePageSchema, "Page"), ...ERRORS },
    }),
    async (c) => {
      const s = scoped(c);
      const q = c.req.valid("query");
      const page = await deps.auth.memberships.listPeople(s.tenant, {
        kind: q.kind,
        statuses: parseStatuses(q.status),
        groupId: q.groupId,
        q: q.q,
        cursor: q.cursor,
        limit: q.limit,
      });
      const facts = relationshipFactsOf(s);
      return c.json(
        { items: page.items.map((p) => personBody(p, facts)), nextCursor: page.nextCursor },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/access/people/{id}",
      tags: TAGS,
      summary: "One person: membership, groups, delegates, attestations, direct grants",
      security: sessionOrApiKeySecurity,
      "x-requires": "access.read+apikey",
      middleware: [keyPerm("access.read")] as const,
      request: { params: a.ResourceParams.pick({ id: true }) },
      responses: { 200: jsonResponse(a.PersonDetailSchema, "Person"), ...ERRORS },
    }),
    async (c) => {
      const s = scoped(c);
      const { id } = c.req.valid("param");
      const detail = await deps.auth.memberships.person(s.tenant, id);
      if (detail === undefined) throw new ApiError("not_found", "no such member");
      const grants = await deps.db.withTenant(s.tenant, (tx) =>
        new GrantRepo(s.tenant, tx).listForSubjects([{ kind: "membership", id }]),
      );
      const delegates = await Promise.all(
        detail.delegates.map((d) => deps.auth.memberships.person(s.tenant, d.id)),
      );
      return c.json(
        {
          person: personBody(detail, relationshipFactsOf(s)),
          delegates: delegates
            .filter((d) => d !== undefined)
            .map((d) => personBody(d, relationshipFactsOf(s))),
          attestations: detail.attestations
            .filter((at) => at.revokedAt === null)
            .map((at) => ({
              kind: at.kind,
              signedAt: at.signedAt.toISOString(),
              expiresAt: iso(at.expiresAt),
            })),
          grants: grants.map(grantBody),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/access/people/{id}",
      tags: TAGS,
      summary: "Change a member's role (staff only), profile, expiry or relationship evidence",
      description:
        "Role changes need `access.manage_staff`; only an owner may make or unmake an owner, and the last owner cannot be demoted. `relationship` records how the relationship with an external member began and is audited separately as `membership.relationship_recorded`; it never blocks anything, it only changes the warning on the person.",
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true)] as const,
      request: { params: a.ResourceParams.pick({ id: true }), body: jsonBody(a.PersonPatchBody) },
      responses: { 200: jsonResponse(a.PersonSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      if (body.role !== undefined && !deps.authz.hasPermission(s.membership, "access.manage_staff"))
        throw new ApiError("forbidden", "your role cannot change staff roles");
      // A relationship-only patch touches no membership column identity owns, and the repo
      // refuses an empty `SET`; skip the call rather than inventing a no-op write.
      const touchesMembership =
        body.role !== undefined || body.profile !== undefined || body.expiresAt !== undefined;
      try {
        if (touchesMembership)
          await deps.auth.memberships.update(
            s.tenant,
            id,
            {
              role: body.role,
              profile: body.profile,
              expiresAt:
                body.expiresAt === undefined
                  ? undefined
                  : body.expiresAt === null
                    ? null
                    : new Date(body.expiresAt),
            },
            actorOf(s),
          );
      } catch (error) {
        rethrow(error);
      }
      if (body.relationship !== undefined) {
        const rel = body.relationship;
        try {
          await deps.db.withTenant(s.tenant, (tx) =>
            createRelationshipService({ db: deps.db, audit: deps.audit }).record(s.tenant, tx, id, {
              ...(rel.establishedAt === undefined
                ? {}
                : {
                    establishedAt: rel.establishedAt === null ? null : new Date(rel.establishedAt),
                  }),
              ...(rel.source === undefined ? {} : { source: rel.source }),
              ...(rel.note === undefined ? {} : { note: rel.note }),
              actor: actorOf(s),
            }),
          );
        } catch (error) {
          if (isComplianceError(error))
            throw new ApiError(error.code as never, error.message, error.details);
          throw error;
        }
      }
      deps.authz.invalidate(s.workspace.id);
      const row = await deps.auth.memberships.person(s.tenant, id);
      if (row === undefined) throw new ApiError("not_found");
      return c.json(personBody(row, relationshipFactsOf(s)), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/people/{id}/revoke",
      tags: TAGS,
      summary: "Revoke a membership (§13.2): delegates, group rows, grants, invites, sessions",
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true)] as const,
      request: { params: a.ResourceParams.pick({ id: true }), body: jsonBody(a.RevokeBody) },
      responses: { 200: jsonResponse(a.RevokeResultSchema, "Revoked"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { id } = c.req.valid("param");
      const target = await deps.auth.memberships.person(s.tenant, id);
      if (target === undefined || target.membership.status === "revoked")
        throw new ApiError("not_found", "no such member");
      if (
        target.membership.kind === "staff" &&
        !deps.authz.hasPermission(s.membership, "access.manage_staff")
      )
        throw new ApiError("forbidden", "your role cannot revoke staff");
      try {
        const r = await deps.auth.memberships.revoke(
          s.tenant,
          { membershipId: id, reason: c.req.valid("json").reason },
          actorOf(s),
        );
        deps.authz.invalidate(s.workspace.id);
        return c.json(
          {
            membershipIds: [...r.membershipIds],
            sessionsRevoked: r.sessionsRevoked,
            grantsRevoked: r.grantsRevoked,
          },
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
      path: "/access/people/{id}/groups",
      tags: TAGS,
      summary: "Replace a member's groups",
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { params: a.ResourceParams.pick({ id: true }), body: jsonBody(a.SetGroupsBody) },
      responses: { 200: jsonResponse(a.SetGroupsResultSchema, "Diff applied"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const r = await deps.auth.memberships.setGroups(
          s.tenant,
          c.req.valid("param").id,
          c.req.valid("json").groupIds,
          actorOf(s),
        );
        deps.authz.invalidate(s.workspace.id);
        return c.json(r, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- invitations ---------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/access/invites",
      tags: TAGS,
      summary: "Invitations (pending by default)",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { query: a.InviteListQuery },
      responses: { 200: jsonResponse(a.InviteListSchema, "Invitations"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const q = c.req.valid("query");
      const rows = await deps.auth.invites.list(s.tenant, { status: q.status, limit: q.limit });
      return c.json({ invites: rows.map(inviteBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/invites",
      tags: TAGS,
      summary: "Invite people by email (one email each, shared groups/grants/message)",
      description:
        "Existing members come back under `failed` with `conflict`; a pending invite for the same address is superseded. Inviting staff needs `access.manage_staff`. Capped per workspace per day.",
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { body: jsonBody(a.InviteCreateBody) },
      responses: { 200: jsonResponse(a.InviteCreateResultSchema, "Result per address"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      if (body.kind === "staff" && !deps.authz.hasPermission(s.membership, "access.manage_staff"))
        throw new ApiError("forbidden", "your role cannot invite staff");
      if (
        (body.kind === "staff") !==
        ["owner", "admin", "editor", "viewer", "finance", "legal"].includes(body.role)
      )
        throw new ApiError("validation_failed", "role does not match kind");
      if (body.role === "owner")
        throw new ApiError("forbidden", "ownership is transferred, not invited");
      refuseDelegateInvite(body.role);
      const settings = parseWorkspaceSettings(s.workspace.settings).access;
      // Checked (and their paths derived) once, before any invitation is written or mailed.
      const grants = await canonicalInviteGrants(deps, s.tenant, body.grants);
      const created = [];
      const failed = [];
      for (const inv of body.invites) {
        const cap = await deps.rateLimiter.hit(`invite:ws:${s.workspace.id}`, INVITE_DAILY_CAP);
        if (!cap.allowed) {
          throw new ApiError(
            "rate_limited",
            "daily invitation cap reached for this workspace",
            { retryAfterMs: cap.retryAfterMs },
            { headers: { "Retry-After": String(Math.ceil(cap.retryAfterMs / 1000)) } },
          );
        }
        try {
          const r = await deps.auth.invites.create({
            workspaceId: s.workspace.id,
            workspaceName: s.workspace.name,
            email: inv.email,
            kind: body.kind,
            role: body.role,
            groupIds: body.groupIds,
            grants,
            message: body.message,
            expiresInDays: body.expiresInDays ?? settings.inviteExpiryDays,
            invitedBy: s.membership.id,
            inviterName: s.session.user.displayName || undefined,
            profile: {
              ...(inv.displayName ? { displayName: inv.displayName } : {}),
              ...(inv.firm ? { firm: inv.firm } : {}),
            },
          });
          created.push(inviteBody(r.invite));
        } catch (error) {
          if (isAuthError(error)) failed.push({ email: inv.email, code: error.code });
          else throw error;
        }
      }
      return c.json({ created, failed }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/invites/{id}/resend",
      tags: TAGS,
      summary: "Send a pending invitation again with a fresh link",
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { params: a.ResourceParams.pick({ id: true }) },
      responses: { 200: jsonResponse(a.InviteSchema, "Resent"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const settings = parseWorkspaceSettings(s.workspace.settings).access;
        const r = await deps.auth.invites.resend(s.tenant, c.req.valid("param").id, {
          workspaceName: s.workspace.name,
          inviterName: s.session.user.displayName || undefined,
          expiresInDays: settings.inviteExpiryDays,
          // F7: a delegate invitation is re-checked against its principal and this limit.
          maxDelegates: settings.maxDelegatesPerPrincipal,
        });
        return c.json(inviteBody(r.invite), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/access/invites/{id}",
      tags: TAGS,
      summary: "Revoke a pending invitation",
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { params: a.ResourceParams.pick({ id: true }) },
      responses: { 200: jsonResponse(OkSchema, "Revoked"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const ok = await deps.auth.invites.revoke(
        s.workspace.id,
        c.req.valid("param").id,
        s.membership.id,
      );
      if (!ok) throw new ApiError("not_found", "no pending invitation with that id");
      return c.json({ ok: true as const }, 200);
    },
  );

  const importDefaults = async (
    s: Signed,
    body: {
      kind: "staff" | "external";
      role: string;
      groupIds: string[];
      grants: unknown[];
      message?: string | undefined;
      expiresInDays?: number | undefined;
    },
  ) => {
    if (body.kind === "staff" && !deps.authz.hasPermission(s.membership, "access.manage_staff"))
      throw new ApiError("forbidden", "your role cannot invite staff");
    if (body.role === "owner")
      throw new ApiError("forbidden", "ownership is transferred, not invited");
    refuseDelegateInvite(body.role);
    return {
      kind: body.kind,
      role: body.role as Membership["role"],
      groupIds: body.groupIds,
      grants: (await canonicalInviteGrants(
        deps,
        s.tenant,
        body.grants as { resource: ResourceRef }[],
      )) as never[],
      message: body.message,
      expiresInDays:
        body.expiresInDays ?? parseWorkspaceSettings(s.workspace.settings).access.inviteExpiryDays,
    };
  };

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/invites/csv/dry-run",
      tags: TAGS,
      summary: "Validate a CSV of invitees without inviting anyone",
      description:
        "Columns: `email, name, firm, groups, expires_at, note` (header required; `groups` semicolon-separated names). Reports invalid rows, unknown groups, duplicates, existing members and pending invites.",
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { body: jsonBody(a.CsvBody) },
      responses: { 200: jsonResponse(a.CsvDryRunResultSchema, "Validated rows"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      const r = await deps.auth.inviteImports.dryRun(
        s.tenant,
        body.csv,
        await importDefaults(s, body),
      );
      return c.json({ rows: r.rows as never[], summary: r.summary }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/invites/csv/import",
      tags: TAGS,
      summary: "Start a CSV invite import job",
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { body: jsonBody(a.CsvBody) },
      responses: { 200: jsonResponse(a.InviteImportSchema, "Queued"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      try {
        const imp = await deps.auth.inviteImports.start(
          s.tenant,
          body.csv,
          await importDefaults(s, body),
          {
            membershipId: s.membership.id,
            inviterName: s.session.user.displayName || undefined,
            workspaceName: s.workspace.name,
          },
          (data) =>
            deps.queue.send(INVITE_IMPORT_JOB, data, {
              idempotencyKey: `import:${String(data["importId"])}`,
            }),
        );
        return c.json(importBody(imp), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/access/invites/csv/imports/{id}",
      tags: TAGS,
      summary: "Status and per-row results of a CSV import",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { params: a.ResourceParams.pick({ id: true }) },
      responses: { 200: jsonResponse(a.InviteImportSchema, "Import"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const imp = await deps.auth.inviteImports.get(s.tenant, c.req.valid("param").id);
      if (imp === undefined) throw new ApiError("not_found", "no such import");
      return c.json(importBody(imp), 200);
    },
  );

  // --- groups --------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/access/groups",
      tags: TAGS,
      summary: "Groups with member counts",
      security: sessionOrApiKeySecurity,
      "x-requires": "access.read+apikey",
      middleware: [keyPerm("access.read")] as const,
      responses: { 200: jsonResponse(a.GroupListSchema, "Groups"), ...ERRORS },
    }),
    async (c) => {
      const s = scoped(c);
      const groups = await deps.auth.groups.list(s.tenant);
      return c.json({ groups: groups.map(groupBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/groups",
      tags: TAGS,
      summary: "Create a group",
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { body: jsonBody(a.GroupCreateBody) },
      responses: { 200: jsonResponse(a.GroupSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const g = await deps.auth.groups.create(s.tenant, c.req.valid("json"), s.membership.id);
        return c.json(groupBody({ ...g, memberCount: 0 }), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/access/groups/{id}",
      tags: TAGS,
      summary: "A group and its members",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { params: a.ResourceParams.pick({ id: true }) },
      responses: { 200: jsonResponse(a.GroupDetailSchema, "Group"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const g = await deps.auth.groups.get(s.tenant, c.req.valid("param").id);
      if (g === undefined) throw new ApiError("not_found", "no such group");
      const { members, ...rest } = g;
      const facts = relationshipFactsOf(s);
      return c.json(
        { group: groupBody(rest), members: members.map((m) => personBody(m, facts)) },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/access/groups/{id}",
      tags: TAGS,
      summary: "Rename a group or change its kind",
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { params: a.ResourceParams.pick({ id: true }), body: jsonBody(a.GroupPatchBody) },
      responses: { 200: jsonResponse(a.GroupSchema, "Updated"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const g = await deps.auth.groups.update(
          s.tenant,
          c.req.valid("param").id,
          c.req.valid("json"),
        );
        const count =
          (await deps.auth.groups.list(s.tenant)).find((x) => x.id === g.id)?.memberCount ?? 0;
        return c.json(groupBody({ ...g, memberCount: count }), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/access/groups/{id}",
      tags: TAGS,
      summary: "Delete a group (its grants stop applying)",
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true)] as const,
      request: { params: a.ResourceParams.pick({ id: true }) },
      responses: { 200: jsonResponse(a.GroupDeleteResultSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const r = await deps.auth.groups.delete(s.tenant, c.req.valid("param").id, s.membership.id);
        deps.authz.invalidate(s.workspace.id);
        // The delete may have taken the group out of `access.requests.defaultGroupIds`.
        deps.resolver.invalidate();
        return c.json(r, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/groups/{id}/members",
      tags: TAGS,
      summary: "Add members to a group",
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { params: a.ResourceParams.pick({ id: true }), body: jsonBody(a.GroupMembersBody) },
      responses: { 200: jsonResponse(a.AddedCountSchema, "Added"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const added = await deps.auth.groups.addMembers(
          s.tenant,
          c.req.valid("param").id,
          c.req.valid("json").membershipIds,
          s.membership.id,
        );
        deps.authz.invalidate(s.workspace.id);
        return c.json({ added }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/access/groups/{id}/members/{membershipId}",
      tags: TAGS,
      summary: "Remove a member from a group",
      security: sessionSecurity,
      "x-requires": "access.manage",
      middleware: [perm("access.manage")] as const,
      request: { params: a.MembershipIdParam },
      responses: { 200: jsonResponse(OkSchema, "Removed"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const p = c.req.valid("param");
      try {
        const ok = await deps.auth.groups.removeMember(s.tenant, p.id, p.membershipId);
        if (!ok) throw new ApiError("not_found", "not a member of that group");
        deps.authz.invalidate(s.workspace.id);
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- grants --------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/access/grants",
      tags: TAGS,
      summary: "Live grants on a resource and its ancestors",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { query: a.GrantsQuery },
      responses: { 200: jsonResponse(a.GrantListSchema, "Grants"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const q = c.req.valid("query");
      const rows = await deps.db.withTenant(s.tenant, (tx) =>
        new GrantRepo(s.tenant, tx).listForResource({
          kind: q.resourceKind,
          id: q.resourceId,
          path: q.resourcePath,
        }),
      );
      return c.json({ grants: rows.map(grantBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/grants",
      tags: TAGS,
      summary: "Grant (or exclude) capabilities on a resource for a person, group or role",
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true)] as const,
      request: { body: jsonBody(a.GrantCreateBody) },
      responses: { 200: jsonResponse(a.GrantCreateResultSchema, "Rules written"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      const rows = await deps.db.withTenant(s.tenant, async (tx) => {
        const subject = body.subject as SubjectRef;
        if (subject.kind === "membership") {
          const m = await new MembershipRepo(s.tenant, tx).byId(subject.id);
          if (m === undefined || m.status === "revoked")
            throw new ApiError("not_found", "no such member");
        } else if (subject.kind === "group") {
          if ((await new GroupRepo(s.tenant, tx).byId(subject.id)) === undefined)
            throw new ApiError("not_found", "no such group");
        } else if (subject.kind === "link") {
          throw new ApiError("unsupported", "grant share links through the share-links API");
        }
        const resource = await canonicalResource(
          tx,
          s.tenant,
          deps.registry.resourceKinds,
          body.resource,
        );
        const grants = new GrantRepo(s.tenant, tx);
        const out: AccessGrant[] = [];
        for (const capability of new Set(body.capabilities)) {
          const r = await grants.upsert({
            subject,
            resource,
            capability,
            effect: body.effect,
            validUntil: body.validUntil ? new Date(body.validUntil) : undefined,
            note: body.note,
            createdBy: s.membership.id,
          });
          out.push(r.grant);
          await deps.audit.record(tx, s.tenant, {
            action: "grant.created",
            resourceKind: "grant",
            resourceId: r.grant.id,
            subjectMembershipId: subject.kind === "membership" ? subject.id : null,
            requestId: requestIdOf(c),
            meta: {
              subjectKind: subject.kind,
              subjectId: subject.kind === "role" ? subject.role : subject.id,
              resourceKind: body.resource.kind,
              resourceId: body.resource.id,
              capability,
              effect: body.effect,
              replaced: r.replaced ?? null,
            },
          });
        }
        await deps.authz.bump(tx, s.tenant, "grant");
        return out;
      });
      return c.json({ grants: rows.map(grantBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/access/grants/{id}",
      tags: TAGS,
      summary: "Revoke a grant",
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true)] as const,
      request: { params: a.ResourceParams.pick({ id: true }) },
      responses: { 200: jsonResponse(OkSchema, "Revoked"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { id } = c.req.valid("param");
      await deps.db.withTenant(s.tenant, async (tx) => {
        const g = await new GrantRepo(s.tenant, tx).revoke(id, s.membership.id);
        if (g === undefined) throw new ApiError("not_found", "no such grant");
        await deps.audit.record(tx, s.tenant, {
          action: "grant.revoked",
          resourceKind: "grant",
          resourceId: id,
          subjectMembershipId: g.subjectKind === "membership" ? g.subjectId : null,
          requestId: requestIdOf(c),
          meta: {
            resourceKind: g.resourceKind,
            resourceId: g.resourceId,
            capability: g.capability,
          },
        });
        await deps.authz.bump(tx, s.tenant, "grant");
      });
      return c.json({ ok: true as const }, 200);
    },
  );

  // --- policies ------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/access/policies",
      tags: TAGS,
      summary: "Live policy gates",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      responses: { 200: jsonResponse(a.PolicyListSchema, "Policies"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const rows = await deps.db.withTenant(s.tenant, (tx) =>
        new PolicyRepo(s.tenant, tx).listLive(),
      );
      return c.json({ policies: rows.map(policyBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/access/policies",
      tags: TAGS,
      summary: "Attach a gate (NDA version, accreditation, auth level, IP allowlist)",
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true)] as const,
      request: { body: jsonBody(a.PolicyCreateBody) },
      responses: { 200: jsonResponse(a.PolicySchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      const row = await deps.db.withTenant(s.tenant, async (tx) => {
        // The target and the NDA document are checked like a grant's subject and resource (P1-03).
        let target = body.target;
        if (target.kind === "resource") {
          target = {
            kind: "resource",
            resource: await canonicalResource(
              tx,
              s.tenant,
              deps.registry.resourceKinds,
              target.resource,
            ),
          };
        } else if (target.kind === "membership") {
          const m = await new MembershipRepo(s.tenant, tx).byId(target.id);
          if (m === undefined || m.status === "revoked")
            throw new ApiError("not_found", "no such member");
        } else if (target.kind === "group") {
          if ((await new GroupRepo(s.tenant, tx).byId(target.id)) === undefined)
            throw new ApiError("not_found", "no such group");
        } else if (target.kind === "link") {
          if ((await new ShareLinkRepo(s.tenant, tx).byId(target.id)) === undefined)
            throw new ApiError("not_found", "no such share link");
        }
        await assertLegalDocumentHere(tx, s.tenant, body.config.documentId);
        const p = await new PolicyRepo(s.tenant, tx).create({
          kind: body.kind,
          config: body.config,
          target,
          createdBy: s.membership.id,
        });
        await deps.audit.record(tx, s.tenant, {
          action: "policy.created",
          resourceKind: "policy",
          resourceId: p.id,
          requestId: requestIdOf(c),
          meta: { kind: body.kind, targetKind: body.target.kind },
        });
        await deps.authz.bump(tx, s.tenant, "policy");
        return p;
      });
      return c.json(policyBody(row), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/access/policies/{id}",
      tags: TAGS,
      summary: "Remove a gate",
      security: sessionSecurity,
      "x-requires": "access.manage+fresh",
      middleware: [perm("access.manage", true)] as const,
      request: { params: a.ResourceParams.pick({ id: true }) },
      responses: { 200: jsonResponse(OkSchema, "Revoked"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { id } = c.req.valid("param");
      await deps.db.withTenant(s.tenant, async (tx) => {
        const p = await new PolicyRepo(s.tenant, tx).revoke(id, s.membership.id);
        if (p === undefined) throw new ApiError("not_found", "no such policy");
        await deps.audit.record(tx, s.tenant, {
          action: "policy.revoked",
          resourceKind: "policy",
          resourceId: id,
          requestId: requestIdOf(c),
          meta: { kind: p.kind },
        });
        await deps.authz.bump(tx, s.tenant, "policy");
      });
      return c.json({ ok: true as const }, 200);
    },
  );

  // --- who has access / explain -----------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/access/resources/{kind}/{id}/who",
      tags: TAGS,
      summary: "Who has access to a resource, and through what",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { params: a.ResourceParams, query: a.ResourcePathQuery },
      responses: { 200: jsonResponse(a.WhoHasAccessSchema, "Holders"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const p = c.req.valid("param");
      const resource: ResourceRef = { kind: p.kind, id: p.id, path: c.req.valid("query").path };
      const holders = await deps.authz.whoHasAccess(s.workspace.id, resource);
      const label = await labelVia(deps, s.tenant, holders);
      const names = await deps.db.withTenant(s.tenant, (tx) =>
        new MembershipRepo(s.tenant, tx).namesFor(holders.map((h) => h.membershipId)),
      );
      const body = (h: AccessHolder) => {
        const n = names.get(h.membershipId);
        return {
          membershipId: h.membershipId,
          displayName: n?.displayName ?? "",
          email: n?.email ?? null,
          kind: n?.kind ?? ("external" as const),
          role: n?.role ?? ("investor" as const),
          capabilities: [...h.capabilities],
          pendingGates: h.pendingGates.map((g) => ({ ...g, detail: { ...g.detail } })),
          via: h.via.map(label),
          expiresAt: iso(h.expiresAt),
        };
      };
      return c.json({ resource: resourceBody(resource), holders: holders.map(body) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/access/resources/{kind}/{id}/explain",
      tags: TAGS,
      summary: "Why can (or can't) this member see this resource?",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      request: { params: a.ResourceParams, query: a.ExplainQuery },
      responses: { 200: jsonResponse(a.AccessExplanationSchema, "Explanation"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const p = c.req.valid("param");
      const q = c.req.valid("query");
      const resource: ResourceRef = { kind: p.kind, id: p.id, path: q.path };
      const ex = await deps.authz.explain(
        { workspaceId: s.workspace.id, membershipId: q.membershipId },
        resource,
      );
      const label = await labelVia(deps, s.tenant, [{ via: ex.rules }]);
      return c.json(
        {
          membershipId: ex.membershipId,
          resource: resourceBody(resource),
          decision: {
            ...ex.decision,
            capabilities: [...ex.decision.capabilities],
            pendingGates: ex.decision.pendingGates.map((g) => ({ ...g, detail: { ...g.detail } })),
          },
          rules: ex.rules.map(label),
          aclVersion: ex.aclVersion,
        },
        200,
      );
    },
  );

  // --- settings + my access ------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/access/settings",
      tags: TAGS,
      summary: "Workspace access settings",
      security: sessionSecurity,
      "x-requires": "access.read",
      middleware: [perm("access.read")] as const,
      responses: { 200: jsonResponse(a.AccessSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      return c.json(parseWorkspaceSettings(s.workspace.settings).access, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/access/settings",
      tags: TAGS,
      summary: "Change access settings (MFA requirements, invite expiry, delegates)",
      security: sessionSecurity,
      "x-requires": "access.settings+fresh",
      middleware: [perm("access.settings", true)] as const,
      request: { body: jsonBody(a.AccessSettingsPatchBody) },
      responses: { 200: jsonResponse(a.AccessSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const patch = c.req.valid("json");
      const saved = await deps.db.withTenant(s.tenant, async (tx) => {
        // The `access` block alone, merged on the row-locked copy (A-3 R2 M1: never the request's
        // cached settings, never the whole document — a concurrent writer of another block, or
        // a group deletion dropping a default group, keeps its change). Row lock first (E3.5 LX).
        const current = parseWorkspaceSettings(
          (await lockWorkspaceFacts(tx, s.workspace.id))?.settings,
        );
        // `requests` is a whole-object replacement (the shallow spread below replaces it outright).
        const next = WorkspaceSettingsSchema.parse({
          ...current,
          access: { ...current.access, ...patch },
        });
        // A suggested group must be a live group of this workspace: another tenant's id is
        // invisible under RLS and answers exactly like a deleted or unknown one. Only NEWLY added
        // ids are refused (E3.1 C1): an id already stored whose group has since been deleted is
        // dropped silently, so a stale default can never make the settings page unsaveable.
        let saved = next;
        const suggested = next.access.requests.defaultGroupIds;
        if (patch.requests !== undefined && suggested.length > 0) {
          const known = new Set(
            (await new GroupRepo(s.tenant, tx).byIds(suggested)).map((g) => g.id),
          );
          const stored = new Set(current.access.requests.defaultGroupIds);
          const unknown = suggested.filter((id) => !known.has(id) && !stored.has(id));
          if (unknown.length > 0)
            throw new ApiError(
              "validation_failed",
              "default groups must be groups of this workspace",
              {
                reason: "unknown_group",
                groupIds: unknown,
              },
            );
          saved = {
            ...next,
            access: {
              ...next.access,
              requests: {
                ...next.access.requests,
                defaultGroupIds: suggested.filter((id) => known.has(id)),
              },
            },
          };
        }
        await updateWorkspaceSettingsBlock(tx, s.workspace.id, "access", saved.access);
        await deps.audit.record(tx, s.tenant, {
          action: "access.settings_changed",
          resourceKind: "workspace",
          resourceId: s.workspace.id,
          requestId: requestIdOf(c),
          meta: { fields: Object.keys(patch) },
        });
        return saved;
      });
      deps.resolver.invalidate();
      return c.json(saved.access, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/access/my",
      tags: TAGS,
      summary: "The caller's permissions and accessible resources (optionally one kind)",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [requireMember({ gate })] as const,
      request: { query: a.MyAccessQuery },
      responses: { 200: jsonResponse(a.MyAccessSchema, "My access"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const q = c.req.valid("query");
      const modules = await deps.enablement.get(deps.db, s.tenant);
      const catalogue = [...deps.registry.permissions.entries()]
        .filter(([, mod]) => modules.enabled.has(mod))
        .map(([p]) => p);
      const permissions = deps.authz.permissionsFor(s.membership, catalogue);
      const principal = { workspaceId: s.workspace.id, membershipId: s.membership.id };
      const facts = factsOf(c, deps);
      const kinds = q.kind ? [q.kind] : Object.keys(deps.registry.resourceKinds);
      const resources = [];
      const seen = new Set<string>();
      for (const kind of q.kind ? kinds : [...kinds, ...(await allKinds())]) {
        if (seen.has(kind)) continue;
        seen.add(kind);
        for (const r of await deps.authz.listAccessible(principal, kind, facts)) {
          resources.push({
            kind: r.kind,
            id: r.id,
            path: r.path ?? null,
            capabilities: [...r.capabilities],
            pendingGates: r.pendingGates.map((g) => ({ ...g, detail: { ...g.detail } })),
            expiresAt: iso(r.expiresAt),
          });
        }
      }
      return c.json({ permissions, resources }, 200);

      async function allKinds(): Promise<string[]> {
        // Kinds present in the caller's materialised rows (modules not yet compiled in still count).
        const rows = await deps.db.withTenant(s.tenant, (tx) =>
          new GrantRepo(s.tenant, tx).listForSubjects([
            { kind: "membership", id: s.membership.id },
          ]),
        );
        return [...new Set(rows.map((r) => r.resourceKind))];
      }
    },
  );
}
