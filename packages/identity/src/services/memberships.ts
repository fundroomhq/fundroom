import { bumpAcl, GrantRepo, membershipExpired } from "@fundroom/authz";
import {
  type Attestation,
  HOST_CONTEXT,
  type Membership,
  type MembershipRole,
  pgErrorCode,
  STAFF_ROLES,
  type StaffRole,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import { AuthError } from "../errors.js";
import {
  AttestationRepo,
  GroupRepo,
  MembershipRepo,
  type PeopleFilter,
  type PersonRow,
} from "../repos/membership-repo.js";
import { revokeSessionsForWorkspaceAsSubject } from "../repos/session-repo.js";
import { createUser, findUserByEmail, normalizeEmail } from "../repos/user-repo.js";
import type { SessionService } from "./sessions.js";
import { type IdentityDeps, nowOf } from "./types.js";

/*
 * People (E1.1): the membership lifecycle after the invite. Every mutation runs in the
 * caller's tenant transaction, writes its audit row there, publishes what other modules
 * need, and bumps `acl_version` when the change affects access (ADR-0014).
 *
 * Revocation (§13.2) in one transaction: membership + delegates → revoked, group rows and
 * grants keep a `revoked_at`, pending invites they created are cancelled, `acl_version++`,
 * `membership.revoked` on the outbox, audit `membership.revoked` with the reason; then the
 * user's sessions in this workspace are revoked (server-side rows) so the next request 401s.
 */
export interface Actor {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: MembershipRole;
}

/**
 * A non-person actor (E3.8): SCIM provisioning (`label: "scim:<tokenId>"`) or SSO just-in-time
 * provisioning (`"sso:<connectionId>"`). It holds no role, so it can never touch an owner's
 * membership nor make anybody an owner; its audit rows are `actorKind: "system"` with the label
 * in `meta.actor`. Use it with a `systemContext(workspaceId)`.
 */
export interface SystemActor {
  readonly kind: "system";
  /** Bounded, no PII: `scim:<tokenId>`, `sso:<connectionId>`. */
  readonly label: string;
}

/** Who may change a membership: a person (their own membership) or the system. */
export type MembershipActor = Actor | SystemActor;

export function isSystemActor(actor: MembershipActor | undefined): actor is SystemActor {
  return actor !== undefined && "kind" in actor && actor.kind === "system";
}

/**
 * Runs on the caller's tenant transaction instead of opening one (E3.8): SCIM changes its own
 * `scim_user` row and the membership atomically. The transaction must be the tenant one for the
 * same `ctx`, holding nothing that sorts after the membership row in the global lock order.
 */
export interface InTransaction {
  readonly tx?: Tx | undefined;
}

export interface ProvisionStaffInput {
  readonly email: string;
  /** Used only when a new global user is created; never changes an existing user. */
  readonly displayName?: string | undefined;
  /** Never `owner` (refused). */
  readonly role: StaffRole;
  readonly source: "sso" | "scim";
  /** Default `active`. `suspended`: SCIM created the user with `active: false`. */
  readonly status?: "active" | "suspended" | undefined;
}

export interface ProvisionStaffResult {
  readonly userId: string;
  readonly membershipId: string;
  /** A new global user was created (with a verified email identity). */
  readonly created: boolean;
  /** An existing non-revoked staff membership was adopted (role untouched) instead of a new one. */
  readonly adopted: boolean;
}

export interface SuspendInput {
  readonly membershipId: string;
  /** Bounded code, e.g. `scim_deactivated`, `admin`. Audited, never shown to the member. */
  readonly reason: string;
}

export interface SuspendResult {
  readonly membership: Membership;
  /** False when it was already suspended (idempotent: nothing written). */
  readonly changed: boolean;
  readonly sessionsRevoked: number;
}

export interface UnsuspendResult {
  readonly membership: Membership;
  /** False when it was not suspended (idempotent: nothing written). */
  readonly changed: boolean;
}

export interface PersonDetail extends PersonRow {
  readonly delegates: readonly Membership[];
  readonly attestations: readonly Attestation[];
}

export interface UpdateMembershipInput {
  readonly role?: MembershipRole | undefined;
  readonly profile?: Readonly<Record<string, unknown>> | undefined;
  /** `null` clears the expiry. */
  readonly expiresAt?: Date | null | undefined;
}

export interface RevokeInput {
  readonly membershipId: string;
  readonly reason?: string | undefined;
}

export interface RevokeResult {
  readonly membershipIds: readonly string[];
  readonly sessionsRevoked: number;
  readonly grantsRevoked: number;
}

export interface TransferOwnershipInput {
  readonly toMembershipId: string;
  /** Keep the caller an owner too (co-owners); default: the caller becomes an admin. */
  readonly keepOwner?: boolean | undefined;
  readonly requestId?: string | null | undefined;
}

export interface MembershipService {
  listPeople(
    ctx: TenantContext,
    filter: PeopleFilter,
  ): Promise<{ items: PersonRow[]; nextCursor: string | null }>;
  person(ctx: TenantContext, membershipId: string): Promise<PersonDetail | undefined>;
  /**
   * Role / profile / expiry. Role rules: staff only, never the last owner. Only an owner may
   * change anything on an owner's membership (P1-02), and an owner's membership never expires:
   * setting `expiresAt` on one is refused, and promoting a member to owner clears theirs.
   */
  update(
    ctx: TenantContext,
    membershipId: string,
    input: UpdateMembershipInput,
    actor: MembershipActor,
    options?: InTransaction,
  ): Promise<Membership>;
  /** Replaces the member's live groups with exactly `groupIds`. */
  setGroups(
    ctx: TenantContext,
    membershipId: string,
    groupIds: readonly string[],
    actor: Actor,
  ): Promise<{ added: string[]; removed: string[] }>;
  /**
   * With `options.tx` (E3.8) it runs on the caller's transaction and revokes the user's sessions
   * for this workspace there too (as the subject, no second connection); otherwise it opens its
   * own and revokes the sessions after the commit.
   */
  revoke(
    ctx: TenantContext,
    input: RevokeInput,
    actor: MembershipActor | undefined,
    options?: InTransaction,
  ): Promise<RevokeResult>;
  /**
   * Staff provisioning without an invitation (E3.8: SSO just-in-time, SCIM create). Finds or
   * creates the global user by email (a new one gets a verified email identity; an existing one
   * is never changed), then: a non-revoked **staff** membership is adopted (role untouched; an
   * `invited` one is activated unless `status` is `suspended`); an **external** one throws
   * `conflict` (`reason: "external_member"`); none → a staff membership with `role`, `source` and
   * `status`. Refuses `owner` (`forbidden`, `reason: "owner_protected"`). Two transactions (host
   * for the user, tenant for the membership), so never call it inside another transaction.
   */
  provisionStaff(
    ctx: TenantContext,
    input: ProvisionStaffInput,
    actor: MembershipActor,
  ): Promise<ProvisionStaffResult>;
  /**
   * Status → `suspended` (staff or external, never an owner: `forbidden` with
   * `reason: "owner_protected"`), the user's sessions for this workspace revoked in the same
   * transaction, audit `membership.suspended`, `acl_version++`. Idempotent. The member's API keys
   * stop working at once (their creator is no longer live) and the key sweep revokes them.
   */
  suspend(
    ctx: TenantContext,
    input: SuspendInput,
    actor: MembershipActor,
    options?: InTransaction,
  ): Promise<SuspendResult>;
  /** `suspended` → `active`, audit `membership.reactivated`, `acl_version++`. Idempotent. */
  unsuspend(
    ctx: TenantContext,
    input: { readonly membershipId: string },
    actor: MembershipActor,
    options?: InTransaction,
  ): Promise<UnsuspendResult>;
  /**
   * Danger zone (E2.7): makes an active staff member an owner and, unless `keepOwner`, demotes
   * the calling owner to admin — one transaction, both role changes audited as
   * `membership.role_changed` plus one `access.ownership_transferred`.
   */
  transferOwnership(
    ctx: TenantContext,
    input: TransferOwnershipInput,
    actor: Actor,
  ): Promise<{ readonly from: Membership; readonly to: Membership }>;
}

function isStaffRole(role: string): role is (typeof STAFF_ROLES)[number] {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

/** The acting role for the owner rules: the system holds none. */
function roleOf(actor: MembershipActor | undefined): MembershipRole | undefined {
  return actor === undefined || isSystemActor(actor) ? undefined : actor.role;
}

/** Audit actor fields for a membership change (overrides the context's defaults). */
function auditActor(actor: MembershipActor | undefined): {
  actorKind: "staff" | "external" | "system";
  actorMembershipId: string | null;
  actorUserId: string | null;
} {
  if (actor === undefined || isSystemActor(actor))
    return { actorKind: "system", actorMembershipId: null, actorUserId: null };
  return {
    // An investor removing their own delegate (E3.2) is an external actor.
    actorKind: isStaffRole(actor.role) ? "staff" : "external",
    actorMembershipId: actor.membershipId,
    actorUserId: actor.userId,
  };
}

/** `meta.actor` for a system actor, nothing for a person. */
function actorMeta(actor: MembershipActor | undefined): { actor?: string } {
  return isSystemActor(actor) ? { actor: actor.label.slice(0, 120) } : {};
}

/**
 * What `provisionStaff` does with the membership the user already holds here (pure, so the rule
 * is stated once): nothing yet → create; staff → adopt (activating an invitation unless the
 * provisioner asked for a suspended member); anything else → conflict.
 */
export function provisionDecision(
  existing: Pick<Membership, "kind" | "status"> | undefined,
  status: "active" | "suspended",
): "create" | "adopt" | "adopt_activate" | "conflict" {
  if (existing === undefined) return "create";
  if (existing.kind !== "staff") return "conflict";
  return existing.status === "invited" && status === "active" ? "adopt_activate" : "adopt";
}

/** Whether `suspend` may touch this membership at all (never an owner, never a revoked one). */
export function suspendRefusal(
  m: Pick<Membership, "kind" | "role" | "status"> | undefined,
): "not_found" | "owner_protected" | undefined {
  if (m === undefined || m.status === "revoked") return "not_found";
  if (m.kind === "staff" && m.role === "owner") return "owner_protected";
  return undefined;
}

export function createMembershipService(
  deps: IdentityDeps,
  sessions: Pick<SessionService, "revokeSessionsForWorkspace">,
): MembershipService {
  function inTenant<T>(
    ctx: TenantContext,
    options: InTransaction,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return options.tx === undefined ? deps.db.withTenant(ctx, fn) : fn(options.tx);
  }

  /** The global user for a (normalised) email: found, or created with a verified identity. */
  async function findOrCreateUser(
    email: string,
    displayName: string | undefined,
    method: string,
  ): Promise<{ id: string; created: boolean }> {
    const run = () =>
      deps.db.withHost(async (tx) => {
        const existing = await findUserByEmail(tx, email);
        if (existing) return { id: existing.id, created: false };
        const user = await createUser(tx, {
          displayName: (displayName ?? "").trim().slice(0, 200),
          identity: { type: "email", identifier: email, verified: true },
        });
        await publish(tx, HOST_CONTEXT, "user.created", { userId: user.id, method });
        return { id: user.id, created: true };
      });
    try {
      return await run();
    } catch (error) {
      // Somebody created the same address concurrently (unique identity): use theirs.
      if (pgErrorCode(error) !== "23505") throw error;
      return run();
    }
  }

  return {
    listPeople: (ctx, filter) =>
      deps.db.withTenant(ctx, (tx) => new MembershipRepo(ctx, tx).listPeople(filter)),

    person: (ctx, membershipId) =>
      deps.db.withTenant(ctx, async (tx) => {
        const memberships = new MembershipRepo(ctx, tx);
        const row = await memberships.person(membershipId);
        if (row === undefined) return undefined;
        return {
          ...row,
          delegates: await memberships.delegatesOf(membershipId),
          attestations: await new AttestationRepo(ctx, tx).listFor(membershipId),
        };
      }),

    async update(ctx, membershipId, input, actor, options = {}) {
      const actorRole = roleOf(actor);
      return inTenant(ctx, options, async (tx) => {
        const memberships = new MembershipRepo(ctx, tx);
        const current = await memberships.byId(membershipId);
        if (current === undefined || current.status === "revoked")
          throw new AuthError("not_found", "no such member");
        // Every field, not just the role (P1-02): an admin who could set an owner's expiry
        // could expire every owner and be the top remaining role. The system (SCIM) holds no
        // role, so it never changes an owner (E3.8).
        if (current.role === "owner" && actorRole !== "owner")
          throw new AuthError("forbidden", "only an owner can change an owner's membership", {
            reason: "owner_protected",
          });
        const patch: Parameters<MembershipRepo["update"]>[1] = {};
        if (input.role !== undefined && input.role !== current.role) {
          if (current.kind !== "staff" || !isStaffRole(input.role)) {
            throw new AuthError("invalid_request", "only staff roles can be changed", {
              kind: current.kind,
            });
          }
          const touchesOwner = current.role === "owner" || input.role === "owner";
          if (touchesOwner && actorRole !== "owner") {
            throw new AuthError("forbidden", "only an owner can change who owns the workspace");
          }
          if (current.role === "owner") await memberships.lockOwners(); // R1-A5
          if (
            current.role === "owner" &&
            (await memberships.countActiveOwners(nowOf(deps), { excluding: current.id })) < 1
          ) {
            throw new AuthError("invalid_request", "a workspace needs at least one owner");
          }
          patch.role = input.role;
        }
        if (input.profile !== undefined) {
          patch.profile = {
            ...((current.profile as Record<string, unknown>) ?? {}),
            ...input.profile,
          };
        }
        // Owners never expire: an expiring owner is how a workspace ends up with none, and the
        // last-owner rule only guards demotion. Promotion clears an expiry the member had.
        const ownerAfter = (patch.role ?? current.role) === "owner";
        if (ownerAfter && input.expiresAt != null)
          throw new AuthError("invalid_request", "an owner's membership cannot expire");
        if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt;
        else if (ownerAfter && current.expiresAt !== null) patch.expiresAt = null;
        const updated = (await memberships.update(membershipId, patch)) ?? current;
        if (patch.role !== undefined) {
          await publish(tx, ctx, "membership.role_changed", {
            membershipId,
            from: current.role,
            to: patch.role,
            byMembershipId: isSystemActor(actor) ? null : actor.membershipId,
          });
          await deps.audit.record(tx, ctx, {
            action: "membership.role_changed",
            resourceKind: "membership",
            resourceId: membershipId,
            subjectMembershipId: membershipId,
            ...(isSystemActor(actor) ? auditActor(actor) : {}),
            meta: { from: current.role, to: patch.role, ...actorMeta(actor) },
          });
          await bumpAcl(tx, ctx, "membership");
        }
        if (input.profile !== undefined || patch.expiresAt !== undefined) {
          await deps.audit.record(tx, ctx, {
            action: "membership.updated",
            resourceKind: "membership",
            resourceId: membershipId,
            subjectMembershipId: membershipId,
            ...(isSystemActor(actor) ? auditActor(actor) : {}),
            meta: {
              ...actorMeta(actor),
              fields: [
                ...(input.profile !== undefined ? Object.keys(input.profile) : []),
                ...(patch.expiresAt !== undefined ? ["expiresAt"] : []),
              ],
              ...(patch.expiresAt === undefined
                ? {}
                : { expiresAt: patch.expiresAt?.toISOString() ?? null }),
            },
          });
          if (patch.expiresAt !== undefined) await bumpAcl(tx, ctx, "membership");
        }
        return updated;
      });
    },

    async setGroups(ctx, membershipId, groupIds, actor) {
      return deps.db.withTenant(ctx, async (tx) => {
        const memberships = new MembershipRepo(ctx, tx);
        const groups = new GroupRepo(ctx, tx);
        // The membership row first (E3.5 R3B): the loop below audits after each group row, so it
        // holds the workspace row while it takes the next one. Revocation and identity erasure
        // lock the membership and then its group rows; without this a set-groups holding one
        // group row and the workspace row could wait for a group row either of them had taken.
        const m = await memberships.lockNoKeyUpdate(membershipId);
        if (m === undefined || m.status === "revoked")
          throw new AuthError("not_found", "no such member");
        const wanted = new Set(groupIds);
        const known = new Set((await groups.byIds([...wanted])).map((g) => g.id));
        for (const id of wanted) {
          if (!known.has(id)) throw new AuthError("not_found", "no such group", { groupId: id });
        }
        const current = new Set(await groups.groupIdsFor(membershipId));
        const added = [...wanted].filter((id) => !current.has(id));
        const removed = [...current].filter((id) => !wanted.has(id));
        for (const id of added) {
          await groups.addMember(id, membershipId, actor.membershipId);
          await deps.audit.record(tx, ctx, {
            action: "group.member_added",
            resourceKind: "group",
            resourceId: id,
            subjectMembershipId: membershipId,
          });
        }
        for (const id of removed) {
          await groups.removeMember(id, membershipId);
          await deps.audit.record(tx, ctx, {
            action: "group.member_removed",
            resourceKind: "group",
            resourceId: id,
            subjectMembershipId: membershipId,
          });
        }
        if (added.length > 0 || removed.length > 0) await bumpAcl(tx, ctx, "group");
        return { added, removed };
      });
    },

    async revoke(ctx, input, actor, options = {}) {
      const person = isSystemActor(actor) ? undefined : actor;
      let revokedInTx: number | undefined;
      const { ids, userIds, grantsRevoked } = await inTenant(ctx, options, async (tx) => {
        const memberships = new MembershipRepo(ctx, tx);
        const target = await memberships.byId(input.membershipId);
        if (target === undefined || target.status === "revoked") {
          return { ids: [] as string[], userIds: [] as string[], grantsRevoked: 0 };
        }
        if (target.role === "owner") {
          // A person must be an owner; the system (SCIM, E3.8) never removes one. `undefined`
          // (identity erasure, jobs) keeps its old meaning.
          if (isSystemActor(actor) || (person !== undefined && person.role !== "owner"))
            throw new AuthError("forbidden", "only an owner can revoke an owner", {
              reason: "owner_protected",
            });
          await memberships.lockOwners(); // R1-A5: a concurrent demotion waits for this one
          if ((await memberships.countActiveOwners(nowOf(deps), { excluding: target.id })) < 1)
            throw new AuthError("invalid_request", "a workspace needs at least one owner");
        }
        if (person !== undefined && person.membershipId === input.membershipId)
          throw new AuthError("invalid_request", "you cannot revoke your own membership");
        const revoked = await memberships.revoke(input.membershipId, {
          by: person?.membershipId,
          reason: input.reason,
        });
        if (revoked.length === 0)
          return { ids: [] as string[], userIds: [] as string[], grantsRevoked: 0 };
        const rows = await memberships.byIds(revoked);
        const grantsRevoked = await new GrantRepo(ctx, tx).revokeForMemberships(
          revoked,
          person?.membershipId,
        );
        const userIds = [...new Set(rows.map((r) => r.userId))];
        if (options.tx !== undefined) {
          // On the caller's transaction there is no "after the commit" to wait for, and a host
          // transaction now would be a second connection: revoke as the subject, here, before
          // the workspace row and the chain (session rows sort before both).
          revokedInTx = 0;
          for (const userId of userIds) {
            revokedInTx += await revokeSessionsForWorkspaceAsSubject(
              tx,
              userId,
              ctx.workspaceId,
              "membership_revoked",
            );
          }
        }
        await publish(tx, ctx, "membership.revoked", {
          membershipIds: revoked,
          byMembershipId: person?.membershipId ?? null,
          reason: input.reason ?? null,
        });
        await deps.audit.record(tx, ctx, {
          action: "membership.revoked",
          resourceKind: "membership",
          resourceId: input.membershipId,
          subjectMembershipId: input.membershipId,
          ...auditActor(actor),
          meta: {
            membershipIds: revoked,
            reason: input.reason ?? null,
            grantsRevoked,
            delegates: revoked.length - 1,
            ...actorMeta(actor),
            ...(revokedInTx === undefined ? {} : { sessionsRevoked: revokedInTx }),
          },
        });
        await bumpAcl(tx, ctx, "membership");
        return { ids: revoked, userIds, grantsRevoked };
      });
      let sessionsRevoked = revokedInTx ?? 0;
      if (revokedInTx === undefined) {
        for (const userId of userIds) {
          sessionsRevoked += await sessions.revokeSessionsForWorkspace(
            userId,
            ctx.workspaceId,
            "membership_revoked",
          );
        }
      }
      if (ids.length > 0) {
        deps.log?.("auth.membership_revoked", {
          workspaceId: ctx.workspaceId,
          membershipIds: ids,
          sessionsRevoked,
          grantsRevoked,
        });
      }
      return { membershipIds: ids, sessionsRevoked, grantsRevoked };
    },
    async provisionStaff(ctx, input, actor) {
      if (!isStaffRole(input.role))
        throw new AuthError("invalid_request", "only a staff role can be provisioned", {
          reason: "invalid_role",
        });
      if (input.role === "owner")
        throw new AuthError("forbidden", "an owner is never provisioned automatically", {
          reason: "owner_protected",
        });
      let email: string;
      try {
        email = normalizeEmail(input.email);
      } catch {
        throw new AuthError("validation_failed", "not an email address", { reason: "email" });
      }
      const status = input.status ?? "active";
      const user = await findOrCreateUser(email, input.displayName, input.source);
      const attempt = () =>
        deps.db.withTenant(ctx, async (tx) => {
          const memberships = new MembershipRepo(ctx, tx);
          const found = await memberships.findForUser(user.id);
          const existing =
            found === undefined ? undefined : await memberships.lockNoKeyUpdate(found.id);
          const decision = provisionDecision(existing, status);
          if (decision === "conflict")
            throw new AuthError("conflict", "this person is an external member here", {
              reason: "external_member",
            });
          if (existing !== undefined) {
            if (decision === "adopt_activate") {
              await memberships.activate(existing.id);
              await deps.audit.record(tx, ctx, {
                action: "membership.updated",
                resourceKind: "membership",
                resourceId: existing.id,
                subjectMembershipId: existing.id,
                ...auditActor(actor),
                meta: {
                  fields: ["status"],
                  status: "active",
                  source: input.source,
                  ...actorMeta(actor),
                },
              });
              await bumpAcl(tx, ctx, "membership");
            }
            return { membershipId: existing.id, adopted: true };
          }
          // E3.10 plan quota, before the row and the audit (the check takes the workspace row). A
          // suspended row (a deactivated SCIM user) holds no seat.
          if (status !== "suspended")
            await deps.quota?.check(tx, {
              workspaceId: ctx.workspaceId,
              kind: "staffSeats",
              delta: 1,
            });
          const now = nowOf(deps);
          const created = await memberships.create({
            userId: user.id,
            kind: "staff",
            role: input.role,
            status,
            source: input.source,
            ...(status === "active" ? { activatedAt: now, lastSeenAt: now } : {}),
          });
          await publish(tx, ctx, "membership.created", {
            membershipId: created.id,
            userId: user.id,
            kind: created.kind,
            role: created.role,
            source: input.source,
            inviteId: null,
          });
          await deps.audit.record(tx, ctx, {
            action: "membership.created",
            resourceKind: "membership",
            resourceId: created.id,
            subjectMembershipId: created.id,
            ...auditActor(actor),
            meta: {
              source: input.source,
              kind: created.kind,
              role: created.role,
              status: created.status,
              newUser: user.created,
              ...actorMeta(actor),
            },
          });
          await bumpAcl(tx, ctx, "membership");
          return { membershipId: created.id, adopted: false };
        });
      let result: { membershipId: string; adopted: boolean };
      try {
        result = await attempt();
      } catch (error) {
        // A concurrent provisioning of the same person inserted first (one non-revoked row per
        // workspace and user): theirs is committed by now, so the retry adopts it.
        if (pgErrorCode(error) !== "23505") throw error;
        result = await attempt();
      }
      deps.log?.("auth.staff_provisioned", {
        workspaceId: ctx.workspaceId,
        membershipId: result.membershipId,
        source: input.source,
        adopted: result.adopted,
        newUser: user.created,
      });
      return { userId: user.id, created: user.created, ...result };
    },

    async suspend(ctx, input, actor, options = {}) {
      return inTenant(ctx, options, async (tx) => {
        const memberships = new MembershipRepo(ctx, tx);
        // The membership row first (entity rows before the workspace row and the chain). Owners
        // are refused outright, so no owner count — and no owner lock — is needed.
        const current = await memberships.lockNoKeyUpdate(input.membershipId);
        const refusal = suspendRefusal(current);
        if (refusal === "not_found" || current === undefined)
          throw new AuthError("not_found", "no such member");
        if (refusal === "owner_protected")
          throw new AuthError("forbidden", "an owner cannot be suspended", {
            reason: "owner_protected",
          });
        if (!isSystemActor(actor) && actor.membershipId === current.id)
          throw new AuthError("invalid_request", "you cannot suspend your own membership");
        if (current.status === "suspended")
          return { membership: current, changed: false, sessionsRevoked: 0 };
        const updated = (await memberships.update(current.id, { status: "suspended" })) ?? current;
        const sessionsRevoked = await revokeSessionsForWorkspaceAsSubject(
          tx,
          current.userId,
          ctx.workspaceId,
          "membership_suspended",
        );
        await deps.audit.record(tx, ctx, {
          action: "membership.suspended",
          resourceKind: "membership",
          resourceId: current.id,
          subjectMembershipId: current.id,
          ...auditActor(actor),
          meta: {
            reason: input.reason.slice(0, 64),
            from: current.status,
            sessionsRevoked,
            ...actorMeta(actor),
          },
        });
        await bumpAcl(tx, ctx, "membership");
        deps.log?.("auth.membership_suspended", {
          workspaceId: ctx.workspaceId,
          membershipId: current.id,
          sessionsRevoked,
        });
        return { membership: updated, changed: true, sessionsRevoked };
      });
    },

    async unsuspend(ctx, input, actor, options = {}) {
      return inTenant(ctx, options, async (tx) => {
        const memberships = new MembershipRepo(ctx, tx);
        const current = await memberships.lockNoKeyUpdate(input.membershipId);
        if (current === undefined || current.status === "revoked")
          throw new AuthError("not_found", "no such member");
        if (current.status !== "suspended") return { membership: current, changed: false };
        // E3.10 FR1 (R3-M3): a suspended member holds no seat, so reactivating one takes a seat
        // back — the plan quota is checked like an invitation's. After the membership row (entity
        // rows first), before the update and the audit (the check takes the workspace row, which
        // the audit would take anyway). Delegates are capped per investor, not by the plan.
        if (current.kind === "staff" || current.role === "investor") {
          await deps.quota?.check(tx, {
            workspaceId: ctx.workspaceId,
            kind: current.kind === "staff" ? "staffSeats" : "investorSeats",
            delta: 1,
          });
        }
        const updated = (await memberships.update(current.id, { status: "active" })) ?? current;
        await deps.audit.record(tx, ctx, {
          action: "membership.reactivated",
          resourceKind: "membership",
          resourceId: current.id,
          subjectMembershipId: current.id,
          ...auditActor(actor),
          meta: { ...actorMeta(actor) },
        });
        await bumpAcl(tx, ctx, "membership");
        return { membership: updated, changed: true };
      });
    },

    async transferOwnership(ctx, input, actor) {
      if (actor.role !== "owner")
        throw new AuthError("forbidden", "only an owner can transfer ownership");
      if (input.toMembershipId === actor.membershipId)
        throw new AuthError("invalid_request", "you already own this workspace");
      return deps.db.withTenant(ctx, async (tx) => {
        const memberships = new MembershipRepo(ctx, tx);
        // R1-A5: before reading who owns what, so a concurrent demotion of the target or of
        // this owner cannot slip between the reads below and the backstop count.
        await memberships.lockOwners();
        const self = await memberships.byId(actor.membershipId);
        if (self === undefined || self.status !== "active" || self.role !== "owner")
          throw new AuthError("forbidden", "only an active owner can transfer ownership");
        const target = await memberships.byId(input.toMembershipId);
        // Only an active staff member can become an owner; anything else reads as "no such
        // member", so the route cannot be used to probe external memberships' states.
        if (
          target === undefined ||
          target.kind !== "staff" ||
          target.status !== "active" ||
          membershipExpired(target.expiresAt, nowOf(deps))
        )
          throw new AuthError("not_found", "no such active staff member");
        const changes: { id: string; from: MembershipRole; to: MembershipRole }[] = [];
        if (target.role !== "owner")
          changes.push({ id: target.id, from: target.role, to: "owner" });
        if (!input.keepOwner) changes.push({ id: self.id, from: "owner", to: "admin" });
        for (const change of changes) {
          // Owners never expire (P1-02): the new owner's expiry, if any, goes with the promotion.
          const clearExpiry = change.to === "owner" && target.expiresAt !== null;
          await memberships.update(change.id, {
            role: change.to,
            ...(clearExpiry ? { expiresAt: null } : {}),
          });
          await publish(tx, ctx, "membership.role_changed", {
            membershipId: change.id,
            from: change.from,
            to: change.to,
            byMembershipId: actor.membershipId,
          });
          await deps.audit.record(tx, ctx, {
            action: "membership.role_changed",
            resourceKind: "membership",
            resourceId: change.id,
            subjectMembershipId: change.id,
            requestId: input.requestId ?? null,
            meta: {
              from: change.from,
              to: change.to,
              via: "ownership_transfer",
              ...(change.to === "owner" && target.expiresAt !== null
                ? { expiryCleared: target.expiresAt.toISOString() }
                : {}),
            },
          });
        }
        // The new owner is in place before the old one steps down, so the last-owner rule holds
        // by construction; the count is a backstop against a concurrent demotion.
        if ((await memberships.countActiveOwners(nowOf(deps))) < 1)
          throw new AuthError("invalid_request", "a workspace needs at least one owner");
        await deps.audit.record(tx, ctx, {
          action: "access.ownership_transferred",
          resourceKind: "membership",
          resourceId: target.id,
          subjectMembershipId: target.id,
          requestId: input.requestId ?? null,
          meta: {
            fromMembershipId: self.id,
            toMembershipId: target.id,
            keepOwner: input.keepOwner === true,
            previousRole: target.role,
          },
        });
        if (changes.length > 0) await bumpAcl(tx, ctx, "membership");
        const from = (await memberships.byId(self.id)) ?? self;
        const to = (await memberships.byId(target.id)) ?? target;
        return { from, to };
      });
    },
  };
}
