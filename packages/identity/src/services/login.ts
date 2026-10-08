import { bumpAcl, GrantRepo, lookupResource, membershipExpired } from "@fundroom/authz";
import {
  HOST_CONTEXT,
  type Invite,
  type Membership,
  platformContext,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { type InviteGrant, parseInviteGrants } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import type { AuthPopulation } from "@fundroom/ports";
import { AuthError } from "../errors.js";
import { AccessRequestRepo } from "../repos/access-request-repo.js";
import {
  GroupRepo,
  InviteRepo,
  listWorkspaceMembershipsForUser,
  MembershipRepo,
} from "../repos/membership-repo.js";
import {
  createUser,
  findUserByEmail,
  findUserById,
  normalizeEmail,
  primaryEmail,
} from "../repos/user-repo.js";
import type { SessionService } from "./sessions.js";
import type { ShareLinkAccess } from "./share-link-access.js";
import {
  type CompleteLoginInput,
  type IdentityDeps,
  type LoginResult,
  type MembershipSummary,
  nowOf,
} from "./types.js";

/*
 * Who may sign in where (design/05 §4.4 "invite-only"): an email is eligible for a
 * workspace when it already holds a non-revoked membership there, or a pending invite
 * exists for it. Host-level login (no workspace) is only for existing users. Start
 * endpoints call this to decide whether to *send* anything; the response never changes.
 */
export interface LoginEligibility {
  readonly eligible: boolean;
  readonly userId: string | undefined;
  readonly membership: Membership | undefined;
  readonly invite: Invite | undefined;
}

const LOGINABLE_STATUSES: ReadonlySet<Membership["status"]> = new Set([
  "invited",
  "active",
  "dormant",
]);

/** Everything the eligibility rule is allowed to look at, already fetched. */
export interface EligibilityFacts {
  readonly userId: string | undefined;
  readonly membership: Membership | undefined;
  readonly invite: Invite | undefined;
  /**
   * Whether a named share link admits this address — and `undefined` when **no link was named**,
   * which is not the same fact as `false` and must never be treated as one.
   */
  readonly linkAdmits: boolean | undefined;
}

/**
 * The whole eligibility rule, as a pure function, so it can be reasoned about in one place.
 *
 * Three sources, and exactly three: a live membership, a pending invitation, or a share link
 * whose own policy names this address. The last clause is written as `linkAdmits === true` rather
 * than anything laxer because `undefined` means *nobody asked about a link*: an address with no
 * membership, no invite and no link is not eligible, and widening that by a hair turns every
 * workspace's OTP start endpoint into an open mailer for arbitrary addresses.
 */
export function decideEligibility(facts: EligibilityFacts): LoginEligibility {
  if (facts.membership && LOGINABLE_STATUSES.has(facts.membership.status)) {
    return {
      eligible: true,
      userId: facts.userId,
      membership: facts.membership,
      invite: undefined,
    };
  }
  if (facts.invite !== undefined) {
    return { eligible: true, userId: facts.userId, membership: undefined, invite: facts.invite };
  }
  return {
    eligible: facts.linkAdmits === true,
    userId: facts.userId,
    membership: undefined,
    invite: undefined,
  };
}

/**
 * Whether a proven credential must still be refused because the access it would open has ended
 * (E3.2 decision 1). An expired membership already admits nobody (P1-01: no tenant context, no
 * RBAC), but the sign-in used to succeed anyway and land the person on a portal that answered 404
 * to everything. Refusing at the door with `membership_expired` says what actually happened.
 *
 * - **A named workspace**: the membership there exists and is past its own `expires_at`.
 * - **The canonical host** (no workspace): the user holds at least one non-revoked membership and
 *   every one of them has expired. A user with no memberships at all signs in exactly as before —
 *   there is nothing to have ended.
 *
 * Pure, so the rule is stated once: `completeLogin` fetches, this decides. `memberships` for the
 * host case are the user's non-revoked rows (`listWorkspaceMembershipsForUser`).
 */
export function loginAccessEnded(
  facts:
    | {
        readonly scope: "workspace";
        readonly membership: Pick<Membership, "expiresAt"> | undefined;
      }
    | {
        readonly scope: "host";
        readonly memberships: readonly Pick<Membership, "expiresAt">[];
      },
  now: Date,
): boolean {
  if (facts.scope === "workspace") {
    return facts.membership !== undefined && membershipExpired(facts.membership.expiresAt, now);
  }
  return (
    facts.memberships.length > 0 &&
    facts.memberships.every((m) => membershipExpired(m.expiresAt, now))
  );
}

export async function checkEligibility(
  deps: IdentityDeps,
  input: {
    email?: string | undefined;
    userId?: string | undefined;
    workspaceId?: string | undefined;
    /**
     * A share link the caller has already resolved **from its token** (E2.3, contract C4).
     *
     * This parameter must stay reachable only from the three token-scoped link routes
     * (`GET/POST /links/{token}…`). It must NOT be threaded into the generic
     * `POST /auth/otp/start` request schema, ever: a link id — unlike its token — is not a
     * secret. It appears in admin screens, audit rows, logs and URLs. If holding the id were
     * enough to buy eligibility, the link's passcode would be bypassed outright, because the
     * passcode is checked by the link's own `start` route and nowhere else. Hanging the whole
     * ceremony off the token is what enforces the passcode transitively: `verify` never sees a
     * passcode, but the only way to hold a valid code is to have passed `start`, which did.
     */
    linkId?: string | undefined;
  },
): Promise<LoginEligibility> {
  const email = input.email ? normalizeEmail(input.email) : undefined;
  const user = await deps.db.withHost(async (tx) =>
    input.userId
      ? await findUserById(tx, input.userId)
      : email
        ? await findUserByEmail(tx, email)
        : undefined,
  );
  if (!input.workspaceId) {
    return {
      eligible: user !== undefined,
      userId: user?.id,
      membership: undefined,
      invite: undefined,
    };
  }
  return deps.db.withTenant(systemContext(input.workspaceId), async (tx) => {
    const ctx = systemContext(input.workspaceId as string);
    const memberships = new MembershipRepo(ctx, tx);
    const invites = new InviteRepo(ctx, tx);
    const membership = user ? await memberships.findForUser(user.id) : undefined;
    const invite =
      membership && LOGINABLE_STATUSES.has(membership.status)
        ? undefined
        : email
          ? // The injected clock, not the repo's `new Date()` default: `invites.create` stamps
            // `expires_at` from `nowOf(deps)`, so asking "is it still pending?" against a
            // different clock can hide an invitation this very deps just wrote.
            await invites.findPendingByEmail(email, nowOf(deps))
          : undefined;
    // Only asked when a link was actually named, so `linkAdmits` stays `undefined` — the value
    // that means "no third source" — on every ordinary login.
    const linkAdmits =
      input.linkId !== undefined && email !== undefined && deps.shareLinks !== undefined
        ? await deps.shareLinks.admits(ctx, tx, input.linkId, email)
        : undefined;
    return decideEligibility({ userId: user?.id, membership, invite, linkAdmits });
  });
}

/**
 * The display name an invitation carried, if it carried one.
 *
 * `invite.profile` is free-form jsonb an admin filled in (`displayName`, `firm`, …), so every
 * field is checked rather than trusted: a hand-edited row could hold anything, and a non-string
 * here would reach `core.user.display_name`. Trimmed, bounded, and empty when absent — the same
 * answer as before, for the invitations that never named anybody.
 */
function invitedDisplayName(invite: { profile?: unknown } | undefined): string {
  if (invite === undefined || typeof invite.profile !== "object" || invite.profile === null) {
    return "";
  }
  const name = (invite.profile as Record<string, unknown>)["displayName"];
  return typeof name === "string" ? name.trim().slice(0, 200) : "";
}

/**
 * Applies what an invitation or a share link promised: audience groups and, for an **invitation**,
 * direct grants (design/05 §5). One code path for both, because a second copy of "apply the
 * groups" is a second place for the membership loop to drift.
 *
 * The grants it writes are `subject_kind='membership'` copies, and that is correct for exactly one
 * of the two callers. An invitation is a one-time promise: it is consumed when it is accepted, it
 * cannot be paused, and the access it hands over becomes the member's own — so copying it onto the
 * membership is what an invitation *means*. A share link is the opposite (contract §2): it stays
 * the grant subject, its rules are written once against `subject_kind='link'` when the link is
 * minted, and they reach the visitor through the `core.share_link_visit` binding that
 * `PrincipalRepo` walks. Copying those onto the membership would outlive the link, and pause,
 * expiry, per-visitor unbinding and revoke would each become a write that changes no access.
 *
 * So the link paths below pass `grants: []` deliberately. It is not an omission.
 *
 * Each promised grant's resource is **re-derived at acceptance** (E3.2 decision 4), with the same
 * resolver `POST /access/invites` used when the invitation was written (`lookupResource`): the
 * stored `resource.path` is never trusted. Weeks can pass between invitation and acceptance, the
 * folder may have moved (its old path would now scope nothing, or somebody else's subtree), and a
 * row edited by hand or imported from elsewhere could carry any path at all — a folder grant with
 * the root path `r` is a grant over the whole data room. So: a resource that still exists gets the
 * path it has *now* (none for a leaf or flat kind); one that is gone is skipped and counted in
 * `grantsDropped`; a kind the kernel cannot look up is written without a path, as a direct grant
 * on it would be.
 */
async function applyPromises(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
  promises: {
    readonly groupIds: readonly string[];
    readonly grants: readonly InviteGrant[];
    readonly note: string;
    readonly createdBy: string | undefined;
  },
): Promise<{
  readonly groupIds: string[];
  readonly granted: number;
  readonly grantsDropped: number;
}> {
  const groups = new GroupRepo(ctx, tx);
  const live = new Set((await groups.byIds([...promises.groupIds])).map((g) => g.id));
  for (const groupId of promises.groupIds) {
    if (live.has(groupId)) await groups.addMember(groupId, membershipId, promises.createdBy);
  }
  const grants = new GrantRepo(ctx, tx);
  let granted = 0;
  let grantsDropped = 0;
  for (const g of promises.grants) {
    const resource = await canonicalPromisedResource(ctx, tx, g.resource);
    if (resource === undefined) {
      grantsDropped += 1;
      continue;
    }
    for (const capability of g.capabilities) {
      await grants.upsert({
        subject: { kind: "membership", id: membershipId },
        resource,
        capability,
        validUntil: g.validUntil ? new Date(g.validUntil) : undefined,
        createdBy: promises.createdBy,
        note: promises.note,
      });
      granted += 1;
    }
  }
  return { groupIds: [...promises.groupIds].filter((id) => live.has(id)), granted, grantsDropped };
}

/**
 * A promised grant's resource as it stands at acceptance: `{ kind, id, path? }` with the path
 * derived from the resource row, or `undefined` when the resource no longer exists in this
 * workspace (deleted, or never here). The stored `path` is ignored whatever it says.
 */
async function canonicalPromisedResource(
  ctx: TenantContext,
  tx: Tx,
  resource: InviteGrant["resource"],
): Promise<{ kind: string; id: string; path?: string } | undefined> {
  const found = await lookupResource(tx, ctx, resource.kind, resource.id);
  if (found.state === "missing") return undefined;
  const path = found.state === "found" ? found.path : null;
  return { kind: resource.kind, id: resource.id, ...(path === null ? {} : { path }) };
}

/**
 * After a verified login: activate the invited membership, or create one from the invite — or,
 * for a share-link visitor (E2.3), create the `external`/`investor` membership the link admits.
 *
 * `linkId` arrives only from the token-scoped link routes; `checkEligibility` has already
 * established that the link admits this address, so this function's job is to make the fact
 * durable, not to re-decide it. The link itself stays the grant subject (contract §2): `bind`
 * writes the `core.share_link_visit` row that `PrincipalRepo` walks, and the groups and grants it
 * returns are applied exactly the way an invitation's are.
 */
export async function establishMembership(
  deps: IdentityDeps,
  input: {
    workspaceId: string;
    userId: string;
    email: string;
    source: string;
    linkId?: string | undefined;
  },
): Promise<MembershipSummary | undefined> {
  const ctx = systemContext(input.workspaceId);
  const shareLinks = deps.shareLinks;
  const linkId = input.linkId;
  return deps.db.withTenant(ctx, async (tx) => {
    const memberships = new MembershipRepo(ctx, tx);
    const invites = new InviteRepo(ctx, tx);
    const existing = await memberships.findForUser(input.userId);
    if (existing) {
      const activated =
        existing.status === "invited" ? await memberships.activate(existing.id) : undefined;
      if (!activated) await memberships.touchSeen(existing.id);
      else {
        // Access-request rows before the workspace row (the bump; E3.5 LX global order).
        await closeJoinedAccessRequests(deps, ctx, tx, input.email);
        await bumpAcl(tx, ctx, "membership");
      }
      const row = activated ?? existing;
      // A member may redeem a link too, and several links over time (`share_link_visit` is
      // many-to-many). Without this the second link a person opens would admit them to nothing.
      if (linkId !== undefined && shareLinks !== undefined) {
        // System context, for the reason spelled out in `establishFromLink` (contract A5).
        const promised = await shareLinks.bind(ctx, tx, { linkId, membershipId: row.id });
        // Groups, and deliberately **no grants** (contract §2, and the comment on
        // `applyPromises`): the link's rules are already written against the link itself, and the
        // binding `bind` just wrote is how this membership reaches them.
        const applied = await applyPromises(ctx, tx, row.id, {
          groupIds: promised.groupIds,
          grants: [],
          note: `link:${linkId}`,
          createdBy: undefined,
        });
        await bumpAcl(tx, ctx, "membership");
        await deps.audit.record(tx, ctx, {
          action: "share_link.redeemed",
          resourceKind: "share_link",
          resourceId: linkId,
          subjectMembershipId: row.id,
          actorKind: row.kind,
          actorMembershipId: row.id,
          actorUserId: input.userId,
          meta: {
            linkId,
            groupIds: applied.groupIds,
            // What the link carries, not what was copied — nothing is copied (contract §2).
            linkGrants: promised.grants.length,
            grants: applied.granted,
            existing: true,
          },
        });
      }
      return { id: row.id, kind: row.kind, role: row.role, status: row.status };
    }

    const invite = await invites.findPendingByEmail(input.email, nowOf(deps));
    if (linkId !== undefined && shareLinks !== undefined) {
      if (invite === undefined)
        return establishFromLink(deps, ctx, tx, { ...input, linkId }, shareLinks);
      // A pending DELEGATE invitation never wins over the company's share link:
      // anyone who could put one on an address (an investor, E3.2) would otherwise turn
      // the link into the door that made its visitor that investor's delegate. It is withdrawn,
      // not left dangling against the investor's limit. Every other pending invitation keeps its
      // precedence: it is accepted, its groups and grants applied, its access request linked.
      if (invite.principalMembershipId !== null) {
        await invites.revoke(invite.id);
        await deps.audit.record(tx, ctx, {
          action: "invite.revoked",
          resourceKind: "invite",
          resourceId: invite.id,
          actorKind: "system",
          meta: { reason: "link_sign_in", linkId },
        });
        return establishFromLink(deps, ctx, tx, { ...input, linkId }, shareLinks);
      }
    }
    if (!invite) return undefined;
    // A delegate invitation (E3.2) is only as good as its principal: one whose principal was
    // suspended, expired or made dormant since it was sent is withdrawn here rather than accepted
    // (revocation withdraws it already, `MembershipRepo.revoke`).
    if (invite.principalMembershipId !== null) {
      const principal = await memberships.byId(invite.principalMembershipId);
      if (
        principal === undefined ||
        principal.kind !== "external" ||
        principal.role !== "investor" ||
        principal.status !== "active" ||
        membershipExpired(principal.expiresAt, nowOf(deps))
      ) {
        await invites.revoke(invite.id);
        await deps.audit.record(tx, ctx, {
          action: "invite.revoked",
          resourceKind: "invite",
          resourceId: invite.id,
          actorKind: "system",
          meta: { reason: "principal_not_live" },
        });
        return undefined;
      }
    }
    // An invitation that answers an access request (E3.1) makes a `request` membership, whatever
    // sign-in method accepted it: the People screen tells requested members apart by it.
    const source = invite.accessRequestId === null ? input.source : "request";
    const created = await memberships.create({
      userId: input.userId,
      kind: invite.kind,
      role: invite.role,
      status: "active",
      source,
      profile: (invite.profile as Record<string, unknown>) ?? {},
      activatedAt: new Date(),
      lastSeenAt: new Date(),
      ...(invite.principalMembershipId === null
        ? {}
        : {
            principalMembershipId: invite.principalMembershipId,
            delegateScope: invite.delegateScope,
          }),
    });
    await invites.accept(invite.id, created.id);
    // What the invitation promised (design/05 §5): audience groups and direct grants.
    const applied = await applyPromises(ctx, tx, created.id, {
      groupIds: invite.groupIds,
      grants: parseInviteGrants(invite.grants),
      note: `invite:${invite.id}`,
      createdBy: invite.invitedBy ?? undefined,
    });
    if (invite.accessRequestId !== null) {
      await linkAccessRequest(deps, ctx, tx, invite.accessRequestId, created.id);
    }
    await closeJoinedAccessRequests(deps, ctx, tx, input.email);
    await bumpAcl(tx, ctx, "membership");
    await publish(tx, ctx, "membership.created", {
      membershipId: created.id,
      userId: input.userId,
      kind: created.kind,
      role: created.role,
      source,
      inviteId: invite.id,
    });
    await deps.audit.record(tx, ctx, {
      action: "membership.created",
      resourceKind: "membership",
      resourceId: created.id,
      subjectMembershipId: created.id,
      actorKind: created.kind,
      actorMembershipId: created.id,
      actorUserId: input.userId,
      meta: {
        inviteId: invite.id,
        source,
        ...(invite.accessRequestId === null ? {} : { accessRequestId: invite.accessRequestId }),
        kind: created.kind,
        role: created.role,
        groupIds: applied.groupIds,
        grants: applied.granted,
        // Promised grants whose resource was gone by acceptance (E3.2): skipped, not applied.
        grantsDropped: applied.grantsDropped,
        ...(invite.principalMembershipId === null
          ? {}
          : {
              principalMembershipId: invite.principalMembershipId,
              delegateScope: invite.delegateScope,
            }),
      },
    });
    deps.log?.("auth.invite_accepted", {
      workspaceId: input.workspaceId,
      inviteId: invite.id,
      membershipId: created.id,
    });
    return { id: created.id, kind: created.kind, role: created.role, status: created.status };
  });
}

/**
 * The access-request arm of an invitation's acceptance (E3.1), on the acceptance transaction:
 * the request learns the membership it became, and the pre-existing relationship the approver
 * attested (required under 506(b)) is recorded on the membership through compliance's relationship
 * service — so `membership.relationship_recorded` is audited exactly as a People-screen edit is,
 * attributed to the approver. A request that is gone (erased, swept) or carries no attestation
 * contributes nothing; the membership stands either way.
 */
async function linkAccessRequest(
  deps: IdentityDeps,
  ctx: TenantContext,
  tx: Tx,
  accessRequestId: string,
  membershipId: string,
): Promise<void> {
  const requests = new AccessRequestRepo(ctx, tx);
  const request = await requests.lockById(accessRequestId);
  if (request === undefined) return;
  await requests.linkMembership(request.id, membershipId);
  if (request.relationshipSource === null && request.relationshipEstablishedAt === null) return;
  if (deps.relationships === undefined) {
    deps.log?.("auth.access_request_relationship_unrecorded", {
      level: "warn",
      workspaceId: ctx.workspaceId,
      accessRequestId,
      reason: "no_recorder",
    });
    return;
  }
  // Attributed to the approver; with none (the approver's membership is gone, or nobody approved
  // it by hand) the facts are still recorded, by the system — an attestation must not be lost.
  await deps.relationships.record(ctx, tx, membershipId, {
    establishedAt: request.relationshipEstablishedAt,
    source: request.relationshipSource,
    note: request.relationshipNote,
    actor: request.decidedBy === null ? null : { membershipId: request.decidedBy },
  });
}

/**
 * The address just joined (E3.1 C5): a request of theirs still waiting in the access-request
 * queue is moot — an admin approving it would 409, and denying it would mail a member "not
 * approved". Closed as `expired` (decided now), audited as the system, on the joining
 * transaction.
 */
async function closeJoinedAccessRequests(
  deps: IdentityDeps,
  ctx: TenantContext,
  tx: Tx,
  email: string,
): Promise<void> {
  const closed = await new AccessRequestRepo(ctx, tx).closePendingForEmail(email, nowOf(deps));
  for (const id of closed) {
    await deps.audit.record(tx, ctx, {
      action: "access_request.expired",
      resourceKind: "access_request",
      resourceId: id,
      actorKind: "system",
      actorMembershipId: null,
      actorUserId: null,
      meta: { reason: "joined" },
    });
  }
}

/**
 * The share-link arm of `establishMembership` (contract §2).
 *
 * A link visitor becomes a real `core.membership` — there is no anonymous principal and there
 * must not be one: `core.has_access()` keys on `core.current_membership()`, and an attestation
 * (the NDA the link may gate on) is impossible without one. `kind='external'`, `role='investor'`,
 * and `source='link:<id>'` so the People screen can tell a link visitor from an invited investor
 * and not silently fill the Investors directory.
 */
async function establishFromLink(
  deps: IdentityDeps,
  ctx: TenantContext,
  tx: Tx,
  input: { workspaceId: string; userId: string; email: string; linkId: string },
  shareLinks: ShareLinkAccess,
): Promise<MembershipSummary> {
  const source = `link:${input.linkId}`;
  const now = nowOf(deps);
  const created = await new MembershipRepo(ctx, tx).create({
    userId: input.userId,
    kind: "external",
    role: "investor",
    status: "active",
    source,
    profile: {},
    activatedAt: now,
    lastSeenAt: now,
  });
  // `ctx` is the **system** context this whole function runs under, and it must stay that way
  // (contract A5). `core.share_link_visit` is an authorization edge — `PrincipalRepo` walks it to
  // emit the `link` grant subject — so RLS gives `external` no INSERT policy at all: a member who
  // could write one would grant themselves every capability the link carries without holding the
  // token, the passcode or the OTP. Handing `bind` the freshly created visitor's own context
  // instead would fail the quiet way, admitting them while their grants never materialise.
  const promised = await shareLinks.bind(ctx, tx, {
    linkId: input.linkId,
    membershipId: created.id,
  });
  // Groups only. The link's grants belong to the link (contract §2): `mint` wrote them once as
  // `subject_kind='link'` rules, and the `core.share_link_visit` row `bind` just wrote is the
  // edge `PrincipalRepo` walks to emit that subject for this membership. Copying them here is
  // what made a revoked link take nothing away.
  const applied = await applyPromises(ctx, tx, created.id, {
    groupIds: promised.groupIds,
    grants: [],
    note: source,
    createdBy: undefined,
  });
  // Access-request rows before the workspace row (the bump; E3.5 LX global order).
  await closeJoinedAccessRequests(deps, ctx, tx, input.email);
  // E3.10 plan quota. After the row (`delta: 0` — the count includes this visitor) because the
  // check takes the workspace row, which must come after the access-request rows just closed;
  // over the limit, the whole redemption rolls back.
  await deps.quota?.check(tx, { workspaceId: ctx.workspaceId, kind: "investorSeats", delta: 0 });
  await bumpAcl(tx, ctx, "membership");
  await publish(tx, ctx, "membership.created", {
    membershipId: created.id,
    userId: input.userId,
    kind: created.kind,
    role: created.role,
    source,
    // `source` already carries `link:<id>`; the catalogue's payload is closed (`.strict()`) and
    // widening a kernel event for one epic's field is not worth it when the audit row has it.
    inviteId: null,
  });
  await deps.audit.record(tx, ctx, {
    action: "membership.created",
    resourceKind: "membership",
    resourceId: created.id,
    subjectMembershipId: created.id,
    actorKind: created.kind,
    actorMembershipId: created.id,
    actorUserId: input.userId,
    meta: {
      linkId: input.linkId,
      source,
      kind: created.kind,
      role: created.role,
      groupIds: applied.groupIds,
      linkGrants: promised.grants.length,
      grants: applied.granted,
    },
  });
  await deps.audit.record(tx, ctx, {
    action: "share_link.redeemed",
    resourceKind: "share_link",
    resourceId: input.linkId,
    subjectMembershipId: created.id,
    actorKind: created.kind,
    actorMembershipId: created.id,
    actorUserId: input.userId,
    meta: {
      linkId: input.linkId,
      groupIds: applied.groupIds,
      linkGrants: promised.grants.length,
      grants: applied.granted,
    },
  });
  deps.log?.("auth.link_redeemed", {
    workspaceId: input.workspaceId,
    membershipId: created.id,
  });
  return { id: created.id, kind: created.kind, role: created.role, status: created.status };
}

function populationFor(membership: MembershipSummary | undefined): AuthPopulation {
  return membership?.kind === "staff" ? "staff" : "external";
}

/**
 * `completeLogin`'s expiry gate (E3.2 decision 1), after the credential is proven and eligibility
 * is known. Throws `membership_expired` (403) and audits `auth.login_failed` with that reason, once,
 * here — so every credential kind that reaches `completeLogin` (OTP, magic link, passkey, password,
 * OIDC, the embed handoff) is refused the same way without each flow repeating it.
 */
async function refuseEndedAccess(
  deps: IdentityDeps,
  input: CompleteLoginInput,
  eligibility: LoginEligibility,
  userId: string | undefined,
): Promise<void> {
  const now = nowOf(deps);
  let ended: boolean;
  if (input.workspaceId) {
    ended = loginAccessEnded({ scope: "workspace", membership: eligibility.membership }, now);
  } else if (userId !== undefined) {
    const rows = await deps.db.withHost((tx) => listWorkspaceMembershipsForUser(tx, userId), {
      actorKind: "host",
      userId,
    });
    ended = loginAccessEnded({ scope: "host", memberships: rows }, now);
  } else {
    ended = false;
  }
  if (!ended) return;
  await auditLoginFailure(deps, {
    workspaceId: input.workspaceId,
    userId,
    method: input.method,
    reason: "membership_expired",
    ip: input.ip,
    userAgent: input.userAgent,
  });
  throw new AuthError("membership_expired", "this membership has expired");
}

/**
 * The tail every credential flow shares: resolve/create the user, establish the workspace
 * membership, mint the session. Throws `not_eligible` when the login page's workspace admits
 * neither an existing membership nor an invite for this email, and `membership_expired` when the
 * membership it would open has passed its expiry (`refuseEndedAccess`, E3.2).
 */
export async function completeLogin(
  deps: IdentityDeps,
  sessions: SessionService,
  input: CompleteLoginInput,
): Promise<LoginResult> {
  let userId = input.userId;
  let email = input.email ? normalizeEmail(input.email) : undefined;
  let isNewUser = false;
  assertSsoBinding(input);

  if (userId && !email) {
    email = await deps.db.withHost((tx) => primaryEmail(tx, userId as string));
  }
  if (!email) throw new AuthError("invalid_request", "login needs an email or a user");

  const eligibility = await checkEligibility(deps, {
    email,
    userId,
    workspaceId: input.workspaceId,
    linkId: input.linkId,
  });
  if (userId === undefined) userId = eligibility.userId;
  if (!eligibility.eligible && !(userId && !input.workspaceId)) {
    throw new AuthError("not_eligible", "no membership or invitation for this workspace");
  }
  await refuseEndedAccess(deps, input, eligibility, userId);
  if (input.sso !== undefined && !ssoAdmits(eligibility)) {
    // The IdP vouches for staff only (E3.8 decision 6); an investor signs in the ordinary way.
    await auditLoginFailure(deps, {
      workspaceId: input.workspaceId,
      userId,
      method: input.method,
      reason: "staff_only",
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw new AuthError("not_eligible", "single sign-on is for staff members only", {
      reason: "staff_only",
    });
  }

  if (userId === undefined) {
    // The name the inviter typed is the only one anybody has at this point, and until now it was
    // written to the *membership* profile on acceptance and nowhere else — so the account itself
    // was created nameless and the investor's own portal greeted them with "Welcome," and a
    // blank. The caller's `displayName` still wins where there is one (a self-registration form
    // that asked); this is the fallback for the invitation flow, which is how every external
    // member arrives. Found by the E2.2 host harness.
    const created = await deps.db.withHost(async (tx) => {
      const user = await createUser(tx, {
        displayName: input.displayName ?? invitedDisplayName(eligibility.invite),
        identity: { type: "email", identifier: email as string, verified: true },
      });
      await publish(tx, HOST_CONTEXT, "user.created", { userId: user.id, method: input.method });
      return user;
    });
    userId = created.id;
    isNewUser = true;
    deps.log?.("auth.user_created", { userId, method: input.method });
  } else {
    const user = await deps.db.withHost((tx) => findUserById(tx, userId as string));
    if (!user) throw new AuthError("invalid_credential", "user no longer exists");
  }

  const membership = input.workspaceId
    ? await establishMembership(deps, {
        workspaceId: input.workspaceId,
        userId,
        email,
        source: eligibility.invite
          ? "invite"
          : input.linkId === undefined
            ? input.method
            : `link:${input.linkId}`,
        linkId: input.linkId,
      })
    : undefined;
  if (input.workspaceId && !membership) {
    throw new AuthError("not_eligible", "no membership or invitation for this workspace");
  }

  const started = await sessions.startSession({
    userId,
    population: populationFor(membership),
    context: input.embed ? "partitioned" : "first_party",
    authLevel: input.authLevel,
    ip: input.ip,
    userAgent: input.userAgent,
    topSite: input.topSite,
    deviceToken: input.deviceToken,
    rememberDevice: input.rememberDevice,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    replacesSessionId: input.replacesSessionId,
    sso: input.sso,
    authTime: input.authTime,
  });
  deps.log?.("auth.login", {
    userId,
    method: input.method,
    workspaceId: input.workspaceId,
    newUser: isNewUser,
  });
  await deps.audit.recordDetached(actorContextFor(input.workspaceId, membership, userId), {
    action: "auth.login",
    resourceKind: "session",
    resourceId: started.session.sessionId,
    sessionId: started.session.sessionId,
    actorUserId: userId,
    subjectMembershipId: membership?.id ?? null,
    ip: input.ip,
    userAgent: input.userAgent,
    meta: {
      method: input.method,
      authLevel: input.authLevel,
      population: populationFor(membership),
      newUser: isNewUser,
      newDevice: started.isNewDevice,
      embed: input.embed ?? false,
      ...(input.sso === undefined ? {} : { connectionId: input.sso.connectionId }),
    },
  });
  return { ...started, isNewUser, membership };
}

/**
 * An SSO login (E3.8) names its workspace and is the only kind that carries a binding: a binding
 * for another workspace, or one without a workspace, would mint a session the middleware ignores
 * everywhere — or worse, one bound to a tenant the login page never belonged to.
 */
function assertSsoBinding(input: CompleteLoginInput): void {
  if (input.method === "sso" && input.sso === undefined)
    throw new AuthError("invalid_request", "an SSO login needs its connection binding");
  if (input.sso === undefined) return;
  if (input.method !== "sso")
    throw new AuthError("invalid_request", "only an SSO login carries a connection binding");
  if (input.workspaceId === undefined || input.workspaceId !== input.sso.workspaceId)
    throw new AuthError("invalid_request", "an SSO login must be for the connection's workspace");
  if (input.embed === true)
    throw new AuthError("invalid_request", "single sign-on does not run inside the embed");
}

/** What an SSO login may open: a staff membership, or a staff invitation (E3.8 decision 6). */
export function ssoAdmits(eligibility: Pick<LoginEligibility, "membership" | "invite">): boolean {
  if (eligibility.membership !== undefined) return eligibility.membership.kind === "staff";
  if (eligibility.invite !== undefined) return eligibility.invite.kind === "staff";
  return false;
}

/**
 * The audit context for a user acting in a workspace (their own membership) or, with no
 * workspace, the platform chain. Global-user facts (MFA, passkeys, sign-out-everywhere)
 * always go to the platform chain so no tenant learns about a user's other workspaces.
 */
export function actorContextFor(
  workspaceId: string | undefined,
  membership: MembershipSummary | undefined,
  userId: string,
): TenantContext {
  if (workspaceId && membership) {
    return { workspaceId, actorKind: membership.kind, membershipId: membership.id, userId };
  }
  return { ...platformContext(), userId };
}

/** Failed credential checks: `denied` rows in the workspace chain (or platform when none). */
export async function auditLoginFailure(
  deps: IdentityDeps,
  input: {
    workspaceId?: string | undefined;
    userId?: string | undefined;
    method: string;
    reason: string;
    ip?: string | undefined;
    userAgent?: string | undefined;
  },
): Promise<void> {
  const ctx: TenantContext = input.workspaceId
    ? systemContext(input.workspaceId)
    : platformContext();
  try {
    await deps.audit.recordDetached(ctx, {
      action: "auth.login_failed",
      resourceKind: "session",
      outcome: "denied",
      actorKind: "external",
      actorMembershipId: null,
      actorUserId: input.userId ?? null,
      ip: input.ip,
      userAgent: input.userAgent,
      meta: { method: input.method, reason: input.reason },
    });
  } catch (error) {
    // Never turn a denied login into a 500 because the audit write failed; ops sees the log.
    deps.log?.("auth.audit_failed", { action: "auth.login_failed", error: String(error) });
  }
}

/**
 * A failed step-up proof (F-10, ASVS 16.3.1): `auth.step_up` with outcome `denied` on the
 * platform chain, where the successful ones go. Callers audit only verdicts that consumed a
 * rate-limit slot, so a locked-out attacker cannot use this to flood the chain.
 */
export async function auditStepUpFailure(
  deps: IdentityDeps,
  input: {
    userId: string;
    sessionId?: string | undefined;
    method: string;
    reason: string;
  },
): Promise<void> {
  try {
    await deps.audit.recordDetached(
      { ...platformContext(), userId: input.userId },
      {
        action: "auth.step_up",
        resourceKind: "session",
        outcome: "denied",
        actorUserId: input.userId,
        ...(input.sessionId === undefined
          ? {}
          : { resourceId: input.sessionId, sessionId: input.sessionId }),
        meta: { method: input.method, reason: input.reason },
      },
    );
  } catch (error) {
    deps.log?.("auth.audit_failed", { action: "auth.step_up", error: String(error) });
  }
}
