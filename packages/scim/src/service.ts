import type { AuditInput } from "@fundroom/audit";
import {
  isViewingAs,
  systemContext,
  type TenantContext,
  type Tx,
  workspaceIsActive,
} from "@fundroom/db";
import { ScimAdminError } from "./errors.js";
import {
  ScimError,
  scimInvalidValue,
  scimMutability,
  scimNotFound,
  scimUniqueness,
} from "./protocol/errors.js";
import { applyGroupPatch, applyUserPatch, parsePatchRequest } from "./protocol/patch.js";
import {
  emailDomain,
  type GroupState,
  identityEmail,
  type JsonRecord,
  parseGroupResource,
  parseUserResource,
  type UserState,
} from "./protocol/resources.js";
import { groupResource, listResponse, userResource } from "./protocol/serialize.js";
import { compileGroupFilter, compileUserFilter } from "./repos/filter-sql.js";
import {
  findTokenByHash,
  type ScimGroupRecordRow,
  ScimRepo,
  type ScimTokenRow,
  type ScimUserRecordRow,
  type ScimUserValues,
} from "./repos/scim-repo.js";
import {
  isPlausibleScimToken,
  mintScimToken,
  SCIM_MAX_LIVE_TOKENS,
  scimDisplayPrefix,
  scimTokenHash,
} from "./token.js";
import type {
  MappableRole,
  ScimActor,
  ScimGroupRow,
  ScimPrincipal,
  ScimProtocol,
  ScimService,
  ScimServiceDeps,
  ScimSystemActor,
  ScimTokenView,
  ScimUserRow,
} from "./types.js";

/*
 * The kernel SCIM service (E3.8, ADR-0056 decision 11).
 *
 * Principal. A `/scim/v2` request is its token: the workspace comes from the token row (host
 * lookup by sha256), never the host. Audit rows name the system actor `scim:<tokenId>`.
 *
 * Transactions and locks. Every protocol write runs in ONE tenant transaction as the workspace's
 * `system` actor (scim_user / scim_group / scim_group_member are staff/system-only under RLS)
 * and takes `scim.workspace:<ws>` first — the global lock order: that advisory lock → scim rows
 * (FOR UPDATE) → membership (identity's suspend/unsuspend/update/revoke on OUR tx via `{ tx }`)
 * → workspace row / audit chain → outbox. All PATCH operations apply in memory first and are
 * persisted in that one transaction, so a failing operation rolls back all of them.
 *
 * The one exception is create: identity's `provisionStaff` opens its own host + tenant
 * transactions and must never run inside ours (pool-deadlock rule). So create is three steps:
 * (1) a checking tx (uniqueness, verified domain, default role) — nothing written; (2)
 * `provisionStaff` with the requested status; (3) the writing tx, which re-checks uniqueness under
 * the lock, refuses a membership another live SCIM user already maps, syncs suspension, inserts
 * the `scim_user` and audits. A crash between (2) and (3) leaves a membership without a SCIM user;
 * the IdP's retry adopts it. When (3) refuses, a membership (2) CREATED is revoked
 * again (`compensate`, R2-H2). Every writer re-reads its scim_user under the lock, so a row
 * tombstoned by erasure is 404 to it (R2-M1); a later IdP POST for that person re-provisions.
 *
 * SCIM never writes global user fields: `userName`, emails, names and `externalId` live only on
 * `core.scim_user`. A `userName` change keeps the linked membership (it must stay in a verified
 * domain). Owners are never modified: role recompute skips them and deactivating / deleting one
 * is 400 `mutability`. A membership revoked by an admin outside SCIM is left alone (projection
 * updates only).
 *
 * Roles. A SCIM-managed non-owner staff membership's role is the highest mapped role of its live
 * groups by `admin > legal > finance > editor > viewer`, else the SSO default role; recomputed
 * for the users whose groups changed and on a mapping change.
 */

const ROLE_PRECEDENCE: readonly MappableRole[] = ["admin", "legal", "finance", "editor", "viewer"];
const MAPPABLE = new Set<string>(ROLE_PRECEDENCE);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DEFAULT_ADMIN_PAGE = 50;
const MAX_ADMIN_PAGE = 200;

/** The effective role from the mapped roles of a user's groups. */
export function effectiveRole(mapped: readonly string[], fallback: MappableRole): MappableRole {
  for (const r of ROLE_PRECEDENCE) if (mapped.includes(r)) return r;
  return fallback;
}

function toUserState(row: ScimUserRecordRow): UserState {
  return {
    userName: row.userName,
    externalId: row.externalId,
    displayName: row.displayName,
    givenName: row.givenName,
    familyName: row.familyName,
    email: row.email,
    active: row.active,
  };
}

function userValues(s: UserState): ScimUserValues {
  return { ...s };
}

function sameUser(a: UserState, b: UserState): boolean {
  return (
    a.userName === b.userName &&
    a.externalId === b.externalId &&
    a.displayName === b.displayName &&
    a.givenName === b.givenName &&
    a.familyName === b.familyName &&
    a.email === b.email
  );
}

function isLive(status: string | undefined): boolean {
  return status !== undefined && status !== "revoked";
}

/** identity's `AuthError` (duck-typed: this package does not depend on identity). */
function authErrorOf(e: unknown): { code: string; reason: unknown } | undefined {
  if (typeof e !== "object" || e === null || (e as { name?: unknown }).name !== "AuthError") {
    return undefined;
  }
  const { code, details } = e as { code?: unknown; details?: Record<string, unknown> };
  return typeof code === "string" ? { code, reason: details?.["reason"] } : undefined;
}

/** Maps identity's refusals to SCIM errors; anything else is rethrown. */
function scimFromIdentity(e: unknown): never {
  const a = authErrorOf(e);
  if (a !== undefined) {
    if (a.code === "forbidden" && a.reason === "owner_protected") {
      throw scimMutability("workspace owners are not managed by SCIM");
    }
    if (a.code === "conflict") {
      throw scimUniqueness(
        a.reason === "external_member"
          ? "this person is an external member of the workspace"
          : "this person cannot be provisioned here",
      );
    }
    if (a.code === "validation_failed") throw scimInvalidValue("the email address is not valid");
    if (a.code === "not_found") throw scimNotFound("the membership no longer exists");
  }
  // E3.10: the plan's staff seats are all taken (the control plane's 402 `plan_limit`, matched
  // structurally). SCIM has no quota scimType; the status and detail carry it.
  if ((e as { code?: unknown } | null)?.code === "plan_limit") {
    throw new ScimError(402, "the workspace's plan has no staff seat left");
  }
  throw e;
}

type Provisioned = Awaited<ReturnType<ScimServiceDeps["memberships"]["provisionStaff"]>>;

/**
 * Loggable facts about an error (R2-M5): the name, the pg SQLSTATE and constraint — never the
 * message, which for a failed query carries its parameters (emails, names).
 */
export function errorFields(e: unknown): Record<string, string | undefined> {
  const cause = (e as { cause?: unknown } | null)?.cause;
  const pg = (x: unknown, k: string): string | undefined => {
    const v = (x as Record<string, unknown> | null)?.[k];
    return typeof v === "string" ? v : undefined;
  };
  return {
    errorName: e instanceof Error ? e.name : typeof e,
    pgCode: pg(e, "code") ?? pg(cause, "code"),
    constraint: pg(e, "constraint") ?? pg(cause, "constraint"),
  };
}

function tokenView(row: ScimTokenRow): ScimTokenView {
  return {
    id: row.id,
    name: row.name,
    displayPrefix: row.displayPrefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

function groupRow(row: ScimGroupRecordRow, memberCount: number): ScimGroupRow {
  return {
    id: row.id,
    displayName: row.displayName,
    role: (row.role as MappableRole | null) ?? null,
    memberCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const [at, id] = raw.split("|");
  const createdAt = new Date(at ?? "");
  if (id === undefined || !UUID_RE.test(id) || Number.isNaN(createdAt.getTime())) {
    throw new ScimAdminError("validation_failed", "invalid cursor", { field: "cursor" });
  }
  return { createdAt, id };
}

export function createScimService(deps: ScimServiceDeps): ScimService {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const throttleMs = deps.lastUsedThrottleMs ?? 60_000;
  const base = `${deps.baseUrl.href.replace(/\/+$/u, "")}/scim/v2`;

  const scimActor = (p: ScimPrincipal): ScimSystemActor => ({
    kind: "system",
    label: `scim:${p.tokenId}`,
  });

  /** One SCIM write: the workspace's system tx with the SCIM lock held first. */
  async function write<T>(
    p: ScimPrincipal,
    fn: (tx: Tx, repo: ScimRepo, sctx: TenantContext) => Promise<T>,
  ): Promise<T> {
    const sctx = systemContext(p.workspaceId);
    return deps.db.withTenant(sctx, async (tx) => {
      const repo = new ScimRepo(sctx, tx);
      await repo.lockWorkspace();
      return fn(tx, repo, sctx);
    });
  }

  async function read<T>(p: ScimPrincipal, fn: (tx: Tx, repo: ScimRepo) => Promise<T>): Promise<T> {
    const sctx = systemContext(p.workspaceId);
    return deps.db.withTenant(sctx, (tx) => fn(tx, new ScimRepo(sctx, tx)));
  }

  function audit(
    tx: Tx,
    sctx: TenantContext,
    p: ScimPrincipal,
    input: Pick<AuditInput, "action" | "resourceKind" | "resourceId" | "subjectMembershipId"> & {
      meta?: Record<string, string | number | boolean | null | string[]>;
    },
  ): Promise<unknown> {
    return deps.audit.record(tx, sctx, {
      ...input,
      actorKind: "system",
      actorMembershipId: null,
      actorUserId: null,
      meta: { actor: `scim:${p.tokenId}`, scimTokenId: p.tokenId, ...(input.meta ?? {}) },
    });
  }

  function adminAudit(ctx: TenantContext, actor: ScimActor): Partial<AuditInput> {
    return {
      actorKind: ctx.actorKind,
      actorMembershipId: actor.membershipId,
      actorUserId: ctx.userId ?? null,
      requestId: actor.requestId ?? null,
      sessionId: actor.sessionId ?? null,
      ...(actor.apiKeyId === undefined ? {} : { apiKeyId: actor.apiKeyId }),
    };
  }

  function refuseViewAs(ctx: TenantContext): void {
    if (isViewingAs(ctx)) {
      throw new ScimAdminError("conflict", "view-as is read only", {
        reason: "view_as_read_only",
      });
    }
  }

  async function requireVerifiedDomain(tx: Tx, ws: string, state: UserState): Promise<string> {
    const email = identityEmail(state);
    if (email === null) {
      throw scimInvalidValue("userName (or the work email) must be an email address");
    }
    const domains = await deps.sso.verifiedDomains(tx, ws);
    if (!domains.includes(emailDomain(email))) {
      throw scimInvalidValue("the email domain is not a verified domain of this workspace");
    }
    return email;
  }

  async function requireUnique(
    repo: ScimRepo,
    state: Pick<UserState, "userName" | "externalId">,
    except?: string,
  ): Promise<void> {
    const clash = await repo.userConflicts(state.userName, state.externalId, except);
    if (clash !== undefined) throw scimUniqueness(`${clash.field} is already in use`);
  }

  /**
   * Brings the membership's role in line with the user's mapped groups. Skips users without a
   * live staff membership and owners. Returns how many roles changed.
   */
  async function recompute(
    tx: Tx,
    sctx: TenantContext,
    repo: ScimRepo,
    users: readonly ScimUserRecordRow[],
    actor: ScimSystemActor,
  ): Promise<number> {
    const linked = users.filter((u) => u.membershipId !== null && u.deletedAt === null);
    if (linked.length === 0) return 0;
    // Global lock order (R2-H1): every scim_user row, then every membership row, in id order,
    // BEFORE the first role change — each change audits and bumps the ACL (workspace row +
    // audit chain), so a membership lock taken after it could close a cycle with a revoke or
    // an erasure that holds membership → workspace.
    await repo.lockForRecompute(
      linked.map((u) => u.id),
      linked.map((u) => u.membershipId as string),
    );
    const mapped = await repo.mappedRoles(linked.map((u) => u.id));
    const fallback = (await deps.sso.defaultStaffRole(tx, sctx.workspaceId)) as MappableRole;
    let changed = 0;
    const ordered = [...linked].sort((a, b) =>
      (a.membershipId ?? "").localeCompare(b.membershipId ?? ""),
    );
    for (const u of ordered) {
      const m = await repo.membership(u.membershipId as string);
      if (m === undefined || !isLive(m.status) || m.kind !== "staff" || m.role === "owner") {
        continue;
      }
      const target = effectiveRole(mapped.get(u.id) ?? [], fallback);
      if (m.role === target) continue;
      try {
        await deps.memberships.update(sctx, m.id, { role: target }, actor, { tx });
      } catch (e) {
        scimFromIdentity(e);
      }
      changed++;
    }
    return changed;
  }

  /** Suspends or reactivates the linked membership to match `active`. */
  async function syncActive(
    tx: Tx,
    sctx: TenantContext,
    p: ScimPrincipal,
    row: Pick<ScimUserRecordRow, "id" | "membershipId">,
    active: boolean,
  ): Promise<"suspended" | "reactivated" | undefined> {
    if (row.membershipId === null) return undefined;
    const repo = new ScimRepo(sctx, tx);
    const m = await repo.membership(row.membershipId);
    if (m === undefined || !isLive(m.status)) return undefined;
    if (!active) {
      if (m.role === "owner")
        throw scimMutability("a workspace owner cannot be deactivated by SCIM");
      if (m.status === "suspended") return undefined;
      try {
        const r = await deps.memberships.suspend(
          sctx,
          { membershipId: m.id, reason: "scim_deactivated" },
          scimActor(p),
          { tx },
        );
        return r.changed ? "suspended" : undefined;
      } catch (e) {
        scimFromIdentity(e);
      }
    }
    if (m.status !== "suspended") return undefined;
    try {
      const r = await deps.memberships.unsuspend(sctx, { membershipId: m.id }, scimActor(p), {
        tx,
      });
      return r.changed ? "reactivated" : undefined;
    } catch (e) {
      scimFromIdentity(e);
    }
  }

  /**
   * `active` as the IdP should see it (FR1 / R2-M3): the projection's flag AND a live,
   * unsuspended membership — a membership revoked or suspended outside SCIM reads `false`, so
   * the IdP's next `active:true` re-provisions or reactivates it.
   */
  function effectiveActive(row: ScimUserRecordRow, status: string | undefined): boolean {
    return row.active && status !== undefined && status !== "revoked" && status !== "suspended";
  }

  function userOut(row: ScimUserRecordRow, status: string | undefined): JsonRecord {
    return userResource(base, {
      ...toUserState(row),
      ...row,
      active: effectiveActive(row, status),
    });
  }

  async function statusOf(repo: ScimRepo, row: ScimUserRecordRow): Promise<string | undefined> {
    return row.membershipId === null
      ? undefined
      : (await repo.membership(row.membershipId))?.status;
  }

  /**
   * Undoes step 2 of a create / re-provision that step 3 refused (R2-H2, R2-M1b): revokes the
   * membership only when THIS request's `provisionStaff` created it (`adopted: false`) and no
   * live SCIM user links it meanwhile. An adopted membership — including an invitation step 2
   * activated (`adopt_activate` reports `adopted: true`) — is never touched: an activated
   * invitation left without a SCIM user is accepted (the person had been invited anyway).
   * Own transaction, after the refused one rolled back.
   */
  async function compensate(p: ScimPrincipal, prov: Provisioned): Promise<void> {
    if (prov.adopted) return;
    try {
      await write(p, async (tx, repo, sctx) => {
        const m = await repo.membership(prov.membershipId);
        if (m === undefined || !isLive(m.status) || m.role === "owner") return;
        if ((await repo.userByMembership(m.id)) !== undefined) return;
        await deps.memberships.revoke(
          sctx,
          { membershipId: m.id, reason: "scim_rollback" },
          scimActor(p),
          { tx },
        );
      });
    } catch (e) {
      log("scim.compensate_failed", { level: "error", ...errorFields(e) });
    }
  }

  async function provision(
    p: ScimPrincipal,
    email: string,
    state: UserState,
    role: MappableRole,
  ): Promise<Provisioned> {
    const displayName =
      state.displayName ??
      ([state.givenName, state.familyName].filter((x) => x !== null).join(" ") || undefined);
    try {
      return await deps.memberships.provisionStaff(
        systemContext(p.workspaceId),
        {
          email,
          ...(displayName === undefined ? {} : { displayName }),
          role,
          source: "scim",
          status: state.active ? "active" : "suspended",
        },
        scimActor(p),
      );
    } catch (e) {
      scimFromIdentity(e);
    }
  }

  /** Step 3 of a provisioning: the fresh membership must still be live and unlinked. */
  async function requireLinkable(
    repo: ScimRepo,
    prov: Provisioned,
    selfId?: string,
  ): Promise<void> {
    const m = await repo.membership(prov.membershipId);
    if (m === undefined || !isLive(m.status)) {
      throw new ScimError(409, "the membership changed during provisioning; retry");
    }
    const mapped = await repo.userByMembership(prov.membershipId);
    if (mapped !== undefined && mapped.id !== selfId) {
      throw scimUniqueness("this person is already provisioned by another SCIM user");
    }
  }

  function uuidOr404(id: string): string {
    if (!UUID_RE.test(id)) throw scimNotFound();
    return id.toLowerCase();
  }

  /** Validates that every member id is a live SCIM user of this workspace. */
  async function requireMembers(repo: ScimRepo, ids: readonly string[]): Promise<void> {
    const bad = ids.filter((id) => !UUID_RE.test(id));
    const live = await repo.liveUserIds(ids.filter((id) => UUID_RE.test(id)));
    const missing = [...bad, ...ids.filter((id) => UUID_RE.test(id) && !live.has(id))];
    if (missing.length > 0) {
      throw scimInvalidValue(`unknown member ${missing[0]}`);
    }
  }

  // --- users -------------------------------------------------------------------------------------

  async function updateUser(
    p: ScimPrincipal,
    rawId: string,
    next: (current: UserState) => UserState,
  ): Promise<JsonRecord> {
    const id = uuidOr404(rawId);
    const first = await write(p, (tx, repo, sctx) => applyUserUpdate(tx, repo, sctx, p, id, next));
    if (!("reprovision" in first)) return first.resource;
    // FR1 / R2-M3: `active:true` for a person whose membership is gone (revoked outside SCIM):
    // re-provision through identity (its own transactions), then relink under the lock.
    const prov = await provision(
      p,
      first.reprovision.email,
      first.reprovision.state,
      first.reprovision.role,
    );
    try {
      const second = await write(p, (tx, repo, sctx) =>
        applyUserUpdate(tx, repo, sctx, p, id, next, prov),
      );
      if ("reprovision" in second) {
        throw new ScimError(409, "the membership changed during provisioning; retry");
      }
      return second.resource;
    } catch (e) {
      await compensate(p, prov);
      throw e;
    }
  }

  /**
   * One PUT/PATCH under the SCIM lock. Re-reads the row (a tombstoned — erased or deleted —
   * user is 404: R2-M1). Without `relink`, a needed re-provision is returned instead of written.
   */
  async function applyUserUpdate(
    tx: Tx,
    repo: ScimRepo,
    sctx: TenantContext,
    p: ScimPrincipal,
    id: string,
    next: (current: UserState) => UserState,
    relink?: Provisioned,
  ): Promise<
    | { resource: JsonRecord }
    | { reprovision: { email: string; state: UserState; role: MappableRole } }
  > {
    const row = await repo.user(id, true);
    if (row === undefined) throw scimNotFound();
    const status = await statusOf(repo, row);
    const cur: UserState = { ...toUserState(row), active: effectiveActive(row, status) };
    const upd = next(cur);
    const gone = status === undefined || status === "revoked";
    if (
      upd.userName.toLowerCase() !== cur.userName.toLowerCase() ||
      upd.externalId !== cur.externalId
    ) {
      await requireUnique(repo, upd, id);
    }
    if (identityEmail(upd) !== identityEmail(cur) || (gone && upd.active)) {
      await requireVerifiedDomain(tx, p.workspaceId, upd);
    }
    if (gone && upd.active && relink === undefined) {
      return {
        reprovision: {
          email: identityEmail(upd) as string,
          state: upd,
          role: (await deps.sso.defaultStaffRole(tx, p.workspaceId)) as MappableRole,
        },
      };
    }
    if (relink !== undefined) {
      await requireLinkable(repo, relink, id);
      // Every row lock before the first audit (ours or identity's; R4-C1): a relink recomputes
      // the role, which locks the owner rows then the member — take them now, in erasure's
      // order, not after an audit already holds the workspace row and the audit chain.
      await repo.lockForRecompute([id], [relink.membershipId]);
    }
    let out = row;
    const link =
      relink === undefined ? {} : { membershipId: relink.membershipId, userId: relink.userId };
    if (!sameUser(cur, upd) || row.active !== upd.active || relink !== undefined) {
      out = await repo.updateUser(id, { ...userValues(upd), ...link });
    }
    const membershipId = out.membershipId;
    const activeChanged = cur.active !== upd.active || relink !== undefined;
    let synced: "suspended" | "reactivated" | undefined;
    if (activeChanged) {
      // identity locks the membership row before its own audit.
      synced = await syncActive(tx, sctx, p, out, upd.active);
      if (relink !== undefined) await recompute(tx, sctx, repo, [out], scimActor(p));
    }
    // SCIM's own audits last, after every row lock of this transaction.
    if (!sameUser(cur, upd)) {
      await audit(tx, sctx, p, {
        action: "scim.user_updated",
        resourceKind: "scim_user",
        resourceId: id,
        subjectMembershipId: membershipId,
        meta: {
          fields: (Object.keys(upd) as (keyof UserState)[])
            .filter((k) => k !== "active" && upd[k] !== cur[k])
            .sort(),
        },
      });
    }
    if (activeChanged) {
      await audit(tx, sctx, p, {
        action: upd.active ? "scim.user_reactivated" : "scim.user_suspended",
        resourceKind: "scim_user",
        resourceId: id,
        subjectMembershipId: membershipId,
        meta: {
          membershipChanged: synced !== undefined || relink !== undefined,
          reprovisioned: relink !== undefined,
        },
      });
    }
    return { resource: userOut(out, (await statusOf(repo, out)) ?? undefined) };
  }

  // --- groups ------------------------------------------------------------------------------------

  async function groupOut(
    repo: ScimRepo,
    row: ScimGroupRecordRow,
    members: boolean,
  ): Promise<JsonRecord> {
    const m = members ? (await repo.membersOf([row.id])).get(row.id) : undefined;
    return groupResource(base, row, m);
  }

  /** Persists a new group state (name/externalId/members), recomputing roles when mapped. */
  async function saveGroup(
    tx: Tx,
    sctx: TenantContext,
    repo: ScimRepo,
    p: ScimPrincipal,
    row: ScimGroupRecordRow,
    next: GroupState,
  ): Promise<ScimGroupRecordRow> {
    if (next.displayName.toLowerCase() !== row.displayName.toLowerCase()) {
      if (await repo.groupNameTaken(next.displayName, row.id)) {
        throw scimUniqueness("displayName is already in use");
      }
    }
    const current = new Set(await repo.memberIds(row.id));
    const wanted = new Set(next.members);
    const added = [...wanted].filter((id) => !current.has(id));
    const removed = [...current].filter((id) => !wanted.has(id));
    await requireMembers(repo, added);
    const renamed = next.displayName !== row.displayName;
    const reExternal = next.externalId !== row.externalId;
    const updated = await repo.updateGroup(row.id, {
      displayName: next.displayName,
      externalId: next.externalId,
    });
    await repo.removeMembers(row.id, removed);
    await repo.addMembers(row.id, added);
    let recomputed = 0;
    if (row.role !== null && added.length + removed.length > 0) {
      recomputed = await recompute(
        tx,
        sctx,
        repo,
        await repo.usersByIds([...added, ...removed]),
        scimActor(p),
      );
    }
    if (renamed || reExternal || added.length + removed.length > 0) {
      await audit(tx, sctx, p, {
        action: "scim.group_updated",
        resourceKind: "scim_group",
        resourceId: row.id,
        meta: {
          renamed,
          externalIdChanged: reExternal,
          added: added.length,
          removed: removed.length,
          rolesChanged: recomputed,
        },
      });
    }
    return updated;
  }

  const unguarded: ScimProtocol = {
    baseUrl: base,

    async listUsers(p, q) {
      const where = q.filter === undefined ? undefined : compileUserFilter(q.filter);
      return read(p, async (_tx, repo) => {
        const { total, rows } = await repo.listUsers(where, q.startIndex - 1, q.count);
        const statuses = await repo.membershipStatuses(
          rows.flatMap((r) => (r.membershipId === null ? [] : [r.membershipId])),
        );
        return listResponse(
          rows.map((r) =>
            userOut(r, r.membershipId === null ? undefined : statuses.get(r.membershipId)),
          ),
          total,
          q.startIndex,
        );
      });
    },

    async getUser(p, rawId) {
      const id = uuidOr404(rawId);
      return read(p, async (_tx, repo) => {
        const row = await repo.user(id);
        if (row === undefined) throw scimNotFound();
        return userOut(row, await statusOf(repo, row));
      });
    },

    async createUser(p, body) {
      const state = parseUserResource(body);
      // (1) Check under the lock, write nothing. A userName/externalId that a live SCIM user
      // whose membership is gone already holds is that person coming back (FR1 / R2-M3):
      // re-provision and relink that user rather than 409.
      const checked = await write(p, async (tx, repo) => {
        const clash = await repo.userConflicts(state.userName, state.externalId);
        if (clash !== undefined) {
          const [only] = clash.ids;
          const row =
            clash.ids.length === 1 && only !== undefined ? await repo.user(only) : undefined;
          const status = row === undefined ? "live" : await statusOf(repo, row);
          if (row !== undefined && (status === undefined || status === "revoked")) {
            return { relinkId: row.id };
          }
          throw scimUniqueness(`${clash.field} is already in use`);
        }
        const email = await requireVerifiedDomain(tx, p.workspaceId, state);
        const role = (await deps.sso.defaultStaffRole(tx, p.workspaceId)) as MappableRole;
        return { email, role };
      });
      if ("relinkId" in checked) return updateUser(p, checked.relinkId, () => state);
      // (2) Identity's own transactions.
      const provisioned = await provision(p, checked.email, state, checked.role);
      // (3) Write under the lock; on refusal undo (2).
      try {
        return await write(p, async (tx, repo, sctx) => {
          await requireUnique(repo, state);
          await requireLinkable(repo, provisioned);
          const row = await repo.insertUser({
            ...userValues(state),
            membershipId: provisioned.membershipId,
            userId: provisioned.userId,
          });
          const synced = await syncActive(tx, sctx, p, row, state.active);
          await audit(tx, sctx, p, {
            action: "scim.user_created",
            resourceKind: "scim_user",
            resourceId: row.id,
            subjectMembershipId: provisioned.membershipId,
            meta: {
              adopted: provisioned.adopted,
              newUser: provisioned.created,
              active: state.active,
              membershipChanged: synced !== undefined,
            },
          });
          log("scim.user_created", { workspaceId: p.workspaceId, scimUserId: row.id });
          return userOut(row, await statusOf(repo, row));
        });
      } catch (e) {
        await compensate(p, provisioned);
        throw e;
      }
    },

    async replaceUser(p, id, body) {
      const state = parseUserResource(body);
      return updateUser(p, id, () => state);
    },

    async patchUser(p, id, body) {
      const ops = parsePatchRequest(body);
      return updateUser(p, id, (cur) => applyUserPatch(cur, ops));
    },

    async deleteUser(p, rawId) {
      const id = uuidOr404(rawId);
      await write(p, async (tx, repo, sctx) => {
        const row = await repo.user(id, true);
        if (row === undefined) throw scimNotFound();
        const m = row.membershipId === null ? undefined : await repo.membership(row.membershipId);
        const live = m !== undefined && isLive(m.status);
        if (live && m.role === "owner") {
          throw scimMutability("a workspace owner cannot be deleted by SCIM");
        }
        if (live) {
          try {
            await deps.memberships.revoke(
              sctx,
              { membershipId: m.id, reason: "scim_deprovisioned" },
              scimActor(p),
              { tx },
            );
          } catch (e) {
            scimFromIdentity(e);
          }
        }
        const groups = await repo.removeUserFromGroups(id);
        await repo.updateUser(id, { deletedAt: now() });
        await audit(tx, sctx, p, {
          action: "scim.user_deleted",
          resourceKind: "scim_user",
          resourceId: id,
          subjectMembershipId: row.membershipId,
          meta: { membershipRevoked: live, groups: groups.length },
        });
      });
    },

    async listGroups(p, q, o) {
      const where = q.filter === undefined ? undefined : compileGroupFilter(q.filter);
      return read(p, async (_tx, repo) => {
        const { total, rows } = await repo.listGroups(where, q.startIndex - 1, q.count);
        const members =
          o?.members === false ? undefined : await repo.membersOf(rows.map((r) => r.id));
        return listResponse(
          rows.map((r) => groupResource(base, r, members?.get(r.id))),
          total,
          q.startIndex,
        );
      });
    },

    async getGroup(p, rawId, o) {
      const id = uuidOr404(rawId);
      return read(p, async (_tx, repo) => {
        const row = await repo.group(id);
        if (row === undefined) throw scimNotFound();
        return groupOut(repo, row, o?.members !== false);
      });
    },

    async createGroup(p, body) {
      const state = parseGroupResource(body);
      return write(p, async (tx, repo, sctx) => {
        if (await repo.groupNameTaken(state.displayName)) {
          throw scimUniqueness("displayName is already in use");
        }
        await requireMembers(repo, state.members);
        const row = await repo.insertGroup({
          displayName: state.displayName,
          externalId: state.externalId,
        });
        await repo.addMembers(row.id, state.members);
        await audit(tx, sctx, p, {
          action: "scim.group_created",
          resourceKind: "scim_group",
          resourceId: row.id,
          meta: { members: state.members.length },
        });
        return groupOut(repo, row, true);
      });
    },

    async replaceGroup(p, rawId, body) {
      const id = uuidOr404(rawId);
      const state = parseGroupResource(body);
      return write(p, async (tx, repo, sctx) => {
        const row = await repo.group(id, true);
        if (row === undefined) throw scimNotFound();
        const saved = await saveGroup(tx, sctx, repo, p, row, state);
        return groupOut(repo, saved, true);
      });
    },

    async patchGroup(p, rawId, body) {
      const id = uuidOr404(rawId);
      const ops = parsePatchRequest(body);
      await write(p, async (tx, repo, sctx) => {
        const row = await repo.group(id, true);
        if (row === undefined) throw scimNotFound();
        const current: GroupState = {
          displayName: row.displayName,
          externalId: row.externalId,
          members: await repo.memberIds(id),
        };
        await saveGroup(tx, sctx, repo, p, row, applyGroupPatch(current, ops));
      });
    },

    async deleteGroup(p, rawId) {
      const id = uuidOr404(rawId);
      await write(p, async (tx, repo, sctx) => {
        const row = await repo.group(id, true);
        if (row === undefined) throw scimNotFound();
        const members = await repo.usersInGroup(id);
        await repo.updateGroup(id, { deletedAt: now() });
        await repo.removeAllMembers(id);
        const recomputed =
          row.role === null ? 0 : await recompute(tx, sctx, repo, members, scimActor(p));
        await audit(tx, sctx, p, {
          action: "scim.group_deleted",
          resourceKind: "scim_group",
          resourceId: id,
          meta: { members: members.length, rolesChanged: recomputed },
        });
      });
    },
  };

  /*
   * E3.10 FR1: a held (`pending_review`) or suspended workspace takes no directory traffic — 403
   * (a SCIM error body) on every `/scim/v2` operation, before any read or write. The client's
   * token stays valid, so provisioning resumes once the workspace is active again; nothing is
   * queued meanwhile (the IdP retries and later re-syncs).
   */
  async function requireActive(p: ScimPrincipal): Promise<void> {
    const sctx = systemContext(p.workspaceId);
    const active = await deps.db.withTenant(sctx, (tx) => workspaceIsActive(tx, p.workspaceId));
    if (!active) throw new ScimError(403, "the workspace is unavailable");
  }
  const guard =
    <A extends unknown[], R>(fn: (p: ScimPrincipal, ...rest: A) => Promise<R>) =>
    async (p: ScimPrincipal, ...rest: A): Promise<R> => {
      await requireActive(p);
      return fn(p, ...rest);
    };
  const protocol: ScimProtocol = {
    baseUrl: unguarded.baseUrl,
    listUsers: guard(unguarded.listUsers),
    getUser: guard(unguarded.getUser),
    createUser: guard(unguarded.createUser),
    replaceUser: guard(unguarded.replaceUser),
    patchUser: guard(unguarded.patchUser),
    deleteUser: guard(unguarded.deleteUser),
    listGroups: guard(unguarded.listGroups),
    getGroup: guard(unguarded.getGroup),
    createGroup: guard(unguarded.createGroup),
    replaceGroup: guard(unguarded.replaceGroup),
    patchGroup: guard(unguarded.patchGroup),
    deleteGroup: guard(unguarded.deleteGroup),
  };

  return {
    protocol,

    async authenticate(bearer) {
      if (!isPlausibleScimToken(bearer)) return null;
      const row = await deps.db.withHost((tx) => findTokenByHash(tx, scimTokenHash(bearer)));
      if (row === undefined || row.revokedAt !== null) return null;
      const at = now();
      if (row.lastUsedAt === null || at.getTime() - row.lastUsedAt.getTime() >= throttleMs) {
        const sctx = systemContext(row.workspaceId);
        try {
          await deps.db.withTenant(sctx, (tx) =>
            new ScimRepo(sctx, tx).touchToken(row.id, at, new Date(at.getTime() - throttleMs)),
          );
        } catch (e) {
          // Bookkeeping only; never fail the request over it.
          log("scim.token_touch_failed", { level: "warn", ...errorFields(e) });
        }
      }
      return { workspaceId: row.workspaceId, tokenId: row.id };
    },

    async adminView(ctx) {
      const sctx = systemContext(ctx.workspaceId);
      return deps.db.withTenant(sctx, async (tx) => {
        const repo = new ScimRepo(sctx, tx);
        return {
          enabled: deps.enabled,
          baseUrl: base,
          tokens: (await repo.liveTokens()).map(tokenView),
          counts: await repo.counts(),
        };
      });
    },

    async createToken(ctx, input, actor, options = {}) {
      refuseViewAs(ctx);
      if (!deps.enabled) {
        throw new ScimAdminError("scim_disabled", "SCIM is not enabled on this server");
      }
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (name.length < 1 || name.length > 80) {
        throw new ScimAdminError("validation_failed", "the token name must be 1–80 characters", {
          field: "name",
        });
      }
      const sctx = systemContext(ctx.workspaceId);
      return deps.db.withTenant(sctx, async (tx) => {
        const repo = new ScimRepo(sctx, tx);
        await repo.lockWorkspace();
        const live = await repo.liveTokens();
        if (live.length === 0) options.assertMayStart?.();
        if (live.length >= SCIM_MAX_LIVE_TOKENS) {
          throw new ScimAdminError(
            "scim_token_limit",
            `at most ${SCIM_MAX_LIVE_TOKENS} SCIM tokens can be live; revoke one first`,
            { max: SCIM_MAX_LIVE_TOKENS },
          );
        }
        const token = mintScimToken();
        const row = await repo.insertToken({
          tokenHash: scimTokenHash(token),
          displayPrefix: scimDisplayPrefix(token),
          name,
          createdByMembershipId: actor.membershipId,
        });
        await deps.audit.record(tx, sctx, {
          ...adminAudit(ctx, actor),
          action: "scim.token_created",
          resourceKind: "scim_token",
          resourceId: row.id,
          meta: { displayPrefix: row.displayPrefix, liveTokens: live.length + 1 },
        });
        return { token, view: tokenView(row) };
      });
    },

    async revokeToken(ctx, id, actor) {
      refuseViewAs(ctx);
      if (!UUID_RE.test(id)) throw new ScimAdminError("not_found", "no such SCIM token");
      const sctx = systemContext(ctx.workspaceId);
      await deps.db.withTenant(sctx, async (tx) => {
        const repo = new ScimRepo(sctx, tx);
        await repo.lockWorkspace();
        const row = await repo.revokeToken(id.toLowerCase(), now());
        if (row === undefined) throw new ScimAdminError("not_found", "no such SCIM token");
        await deps.audit.record(tx, sctx, {
          ...adminAudit(ctx, actor),
          action: "scim.token_revoked",
          resourceKind: "scim_token",
          resourceId: row.id,
          meta: { displayPrefix: row.displayPrefix },
        });
      });
    },

    async listUsers(ctx, q) {
      const limit = Math.max(1, Math.min(q.limit ?? DEFAULT_ADMIN_PAGE, MAX_ADMIN_PAGE));
      const after = q.cursor === undefined || q.cursor === "" ? undefined : decodeCursor(q.cursor);
      const sctx = systemContext(ctx.workspaceId);
      const rows = await deps.db.withTenant(sctx, (tx) =>
        new ScimRepo(sctx, tx).adminUsers(after, limit + 1),
      );
      const page = rows.slice(0, limit);
      const items: ScimUserRow[] = page.map((r) => ({
        id: r.id,
        userName: r.userName,
        displayName: r.displayName,
        active: r.active,
        membershipId: r.membershipId,
        role: r.role,
        groups: r.groups,
        updatedAt: r.updatedAt.toISOString(),
      }));
      const last = page.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last !== undefined ? encodeCursor(last) : null,
      };
    },

    async listGroups(ctx) {
      const sctx = systemContext(ctx.workspaceId);
      const rows = await deps.db.withTenant(sctx, (tx) => new ScimRepo(sctx, tx).adminGroups());
      return rows.map((r) => groupRow(r, r.memberCount));
    },

    async setGroupRole(ctx, groupId, role, actor) {
      refuseViewAs(ctx);
      if (role !== null && !MAPPABLE.has(role)) {
        throw new ScimAdminError("validation_failed", "that role cannot be mapped", {
          field: "role",
        });
      }
      if (!UUID_RE.test(groupId)) throw new ScimAdminError("not_found", "no such SCIM group");
      const sctx = systemContext(ctx.workspaceId);
      return deps.db.withTenant(sctx, async (tx) => {
        const repo = new ScimRepo(sctx, tx);
        await repo.lockWorkspace();
        const row = await repo.group(groupId.toLowerCase(), true);
        if (row === undefined) throw new ScimAdminError("not_found", "no such SCIM group");
        const previous = row.role;
        const updated = previous === role ? row : await repo.updateGroup(row.id, { role });
        const members = await repo.usersInGroup(row.id);
        let recomputed = 0;
        if (previous !== role) {
          try {
            recomputed = await recompute(tx, sctx, repo, members, {
              kind: "system",
              label: "scim:role-mapping",
            });
          } catch (e) {
            if (e instanceof ScimError) {
              throw new ScimAdminError("conflict", e.detail, { reason: e.scimType ?? "scim" });
            }
            throw e;
          }
          await deps.audit.record(tx, sctx, {
            ...adminAudit(ctx, actor),
            action: "scim.group_role_mapped",
            resourceKind: "scim_group",
            resourceId: row.id,
            meta: {
              role,
              previousRole: previous,
              members: members.length,
              rolesChanged: recomputed,
            },
          });
        }
        return groupRow(updated, members.length);
      });
    },
  };
}
