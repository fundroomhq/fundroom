import { membershipExpired } from "@fundroom/authz";
import {
  type DelegateScope,
  type Invite,
  type Membership,
  STAFF_ROLES,
  type TenantContext,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import { AuthError } from "../errors.js";
import { InviteRepo, MembershipRepo, type PersonRow } from "../repos/membership-repo.js";
import { findUserByEmail, normalizeEmail } from "../repos/user-repo.js";
import { type CreatedInvite, sendInviteEmail, writeInvite } from "./invites.js";
import type { Actor, MembershipService } from "./memberships.js";
import { type IdentityDeps, nowOf } from "./types.js";

/*
 * Delegates (E3.2, design/05 §4.2 and §5 "Delegates", §7 "Delegate abuse"). A delegate acts for
 * a principal investor with a chosen subset of what the principal can see (`scope`); it is
 * created as an ordinary invitation naming its principal (`invite.principal_membership_id`,
 * `invite.delegate_scope`) and becomes a `delegate` membership on acceptance
 * (`establishMembership`). What it inherits, and when it stops, is the evaluator's business
 * (`@fundroom/authz` `rulesFor` / `PrincipalRepo.listActive`); this service only decides who may
 * add or remove one.
 *
 * Refusals, in the order they are checked:
 *  - the principal is not a live external investor (not `active`, expired, a delegate, staff)
 *    → `invalid_request` reason `principal_not_investor` (admin path) — the self-service path
 *    cannot get here with anyone but the caller, so a delegate caller is `forbidden`;
 *  - self-service while `access.allowDelegates` is off → `delegates_disabled`;
 *  - self-service past the principal's daily add budget (`DELEGATE_ADD_DAILY_BUDGET` in 24 h,
 *    withdrawn and skipped adds included) → `rate_limited`;
 *  - the principal already has `access.maxDelegatesPerPrincipal` live + pending → `delegate_limit_reached`;
 *  - the address is already a member, or has a pending invitation → `conflict` (admin path only).
 *
 * The self-service path answers the SAME way for every address: an address
 * that is already a member here (in any state, revoked included) or already invited gets no
 * invitation and no error — the add is `skipped`, audited as `membership.delegate_add_skipped`,
 * and still spends budget. The one oracle left is the principal's own list (a skipped add does
 * not appear in it); the daily budget bounds it to `DELEGATE_ADD_DAILY_BUDGET` probes a day.
 */

/** Self-service delegate adds a principal may make in any 24 hours. */
export const DELEGATE_ADD_DAILY_BUDGET = 10;
const DAY_MS = 24 * 3600_000;

export interface DelegateView {
  readonly kind: "member" | "invite";
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly scope: DelegateScope;
  readonly status: "pending" | "invited" | "active" | "dormant" | "suspended";
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastSeenAt: Date | null;
}

export interface AddDelegateInput {
  readonly principalMembershipId: string;
  readonly email: string;
  readonly displayName?: string | undefined;
  readonly scope: DelegateScope;
  /** Staff only: a self-service add never carries a message into the branded email (F2). */
  readonly message?: string | undefined;
  /** `self`: the principal adds its own delegate; `staff`: an admin does (People screen). */
  readonly by: "self" | "staff";
  readonly actor: Actor;
  readonly allowDelegates: boolean;
  readonly maxDelegates: number;
  readonly expiresInDays: number;
  readonly workspaceName?: string | undefined;
  readonly inviterName?: string | undefined;
  readonly requestId?: string | undefined;
  /**
   * Spends the workspace's shared daily invitation cap; throws when it is exhausted. Called only
   * once an invitation will actually be sent (never for a refused or skipped add), outside any
   * transaction.
   */
  readonly spendInviteCap?: (() => Promise<void>) | undefined;
}

export interface RemoveDelegateInput {
  readonly principalMembershipId: string;
  /** A delegate membership id, or a pending delegate invitation id. */
  readonly delegateId: string;
  readonly by: "self" | "staff";
  readonly actor: Actor;
  readonly requestId?: string | undefined;
}

/** `skipped`: a self-service add that issued nothing (the address is already known here, F1). */
export type AddDelegateResult =
  | { readonly outcome: "sent"; readonly created: CreatedInvite }
  | { readonly outcome: "skipped" };

export interface DelegateService {
  list(ctx: TenantContext, principalMembershipId: string): Promise<DelegateView[]>;
  add(ctx: TenantContext, input: AddDelegateInput): Promise<AddDelegateResult>;
  remove(ctx: TenantContext, input: RemoveDelegateInput): Promise<{ kind: "member" | "invite" }>;
}

/** A live external investor: the only membership that may have delegates. */
export function canHaveDelegates(
  m: Pick<Membership, "kind" | "role" | "status" | "expiresAt">,
  now: Date,
): boolean {
  return (
    m.kind === "external" &&
    m.role === "investor" &&
    m.status === "active" &&
    !membershipExpired(m.expiresAt, now)
  );
}

function memberView(row: PersonRow): DelegateView {
  const m = row.membership;
  return {
    kind: "member",
    id: m.id,
    email: row.email,
    displayName: row.displayName,
    scope: (m.delegateScope ?? "all") as DelegateScope,
    status: m.status === "revoked" ? "suspended" : m.status,
    createdAt: m.createdAt,
    expiresAt: m.expiresAt,
    lastSeenAt: m.lastSeenAt,
  };
}

function inviteView(i: Invite): DelegateView {
  const profile = (i.profile as Record<string, unknown>) ?? {};
  const name = typeof profile["displayName"] === "string" ? profile["displayName"] : "";
  return {
    kind: "invite",
    id: i.id,
    email: i.email,
    displayName: name,
    scope: (i.delegateScope ?? "all") as DelegateScope,
    status: "pending",
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    lastSeenAt: null,
  };
}

function isStaff(role: string): boolean {
  return (STAFF_ROLES as readonly string[]).includes(role);
}

export function createDelegateService(
  deps: IdentityDeps,
  memberships: Pick<MembershipService, "revoke">,
): DelegateService {
  return {
    list: (ctx, principalMembershipId) =>
      deps.db.withTenant(ctx, async (tx) => {
        const repo = new MembershipRepo(ctx, tx);
        const members = await repo.delegatesOf(principalMembershipId);
        const rows: PersonRow[] = [];
        for (const m of members) {
          const row = await repo.person(m.id);
          if (row !== undefined) rows.push(row);
        }
        const pending = await new InviteRepo(ctx, tx).pendingDelegatesOf(
          principalMembershipId,
          nowOf(deps),
        );
        return [...rows.map(memberView), ...pending.map(inviteView)];
      }),

    async add(ctx, input) {
      const now = nowOf(deps);
      const email = normalizeEmail(input.email);
      const self = input.by === "self";
      // Staff may say something in the invitation; a principal may not (F2: the mail is branded
      // as the company's, so an investor-written message would speak in the company's voice).
      const message = self ? undefined : input.message;
      const existingUser = await deps.db.withHost((tx) => findUserByEmail(tx, email));
      /*
       * Two passes under the principal's row lock: the first decides — refusals,
       * the principal's budget, the limit, a skip (audited, and final) — and writes nothing else;
       * only when an invitation will really go out is the workspace's shared daily cap spent
       * (`spendInviteCap`, outside any transaction: it takes its own connection), and the second
       * pass re-checks everything and writes. So a skipped or refused add never spends the cap
       * that every other invitation in the workspace shares.
       */
      const attempt = (write: boolean) =>
        deps.db.withTenant(ctx, async (tx) => {
          const repo = new MembershipRepo(ctx, tx);
          // Locked first: two concurrent adds for one principal count one after the other.
          const principal = await repo.lockForUpdate(input.principalMembershipId);
          if (self) {
            // The caller *is* the principal. A delegate may not add delegates (design/05 §7).
            if (principal === undefined || principal.role === "delegate")
              throw new AuthError("forbidden", "a delegate cannot add delegates", {
                reason: "delegate_cannot_delegate",
              });
            if (!canHaveDelegates(principal, now))
              throw new AuthError("forbidden", "only an investor can add delegates", {
                reason: "principal_not_investor",
              });
            if (!input.allowDelegates)
              throw new AuthError("delegates_disabled", "this workspace does not allow delegates");
            const spent = await repo.delegateAddsSince(
              principal.id,
              new Date(now.getTime() - DAY_MS),
            );
            if (spent.count >= DELEGATE_ADD_DAILY_BUDGET) {
              const retryAfterMs = Math.max(
                1000,
                (spent.oldest?.getTime() ?? now.getTime()) + DAY_MS - now.getTime(),
              );
              throw new AuthError("rate_limited", "too many delegate invitations today", {
                retryAfterMs,
              });
            }
          } else if (principal === undefined) {
            throw new AuthError("not_found", "no such member");
          } else if (!canHaveDelegates(principal, now)) {
            throw new AuthError("invalid_request", "delegates can only be added for an investor", {
              reason: "principal_not_investor",
            });
          }
          const invites = new InviteRepo(ctx, tx);
          const live = await repo.delegatesOf(principal.id);
          const pending = await invites.pendingDelegatesOf(principal.id, now);
          if (live.length + pending.length >= input.maxDelegates)
            throw new AuthError("delegate_limit_reached", "this investor has no delegates left", {
              limit: input.maxDelegates,
            });
          const actorKind = self ? "external" : "staff";
          const audit = {
            resourceKind: "membership",
            resourceId: principal.id,
            subjectMembershipId: principal.id,
            actorKind,
            actorMembershipId: input.actor.membershipId,
            actorUserId: input.actor.userId,
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          } as const;
          if (self) {
            // F1: the same answer for every address. Anyone already known here — a member in any
            // state, revoked included (an investor must not re-admit someone the company removed),
            // or an address with a pending invitation — gets nothing, and nobody is told why.
            const known =
              existingUser === undefined ? undefined : await repo.findAnyForUser(existingUser.id);
            const invited = await invites.findPendingByEmail(email, now);
            if (known !== undefined || invited !== undefined) {
              await deps.audit.record(tx, ctx, {
                action: "membership.delegate_add_skipped",
                ...audit,
                meta: {
                  scope: input.scope,
                  by: input.by,
                  reason:
                    known === undefined
                      ? "pending_invite"
                      : known.status === "revoked"
                        ? "revoked_member"
                        : "member",
                },
              });
              return { outcome: "skipped" as const };
            }
          }
          if (!write) return { outcome: "ready" as const };
          // Named in the invitation (F5): the invitee is told whom they would act for.
          const person = await repo.person(principal.id);
          const principalName = person?.displayName || person?.email || "An investor";
          const invite = await writeInvite(
            deps,
            ctx,
            tx,
            {
              workspaceId: ctx.workspaceId,
              workspaceName: input.workspaceName,
              email,
              kind: "external",
              role: "delegate",
              groupIds: [],
              grants: [],
              message,
              expiresInDays: input.expiresInDays,
              invitedBy: input.actor.membershipId,
              inviterName: input.inviterName,
              profile: input.displayName ? { displayName: input.displayName } : {},
              delegate: { principalMembershipId: principal.id, scope: input.scope },
              actorKind,
              requestId: input.requestId,
            },
            existingUser?.id,
          );
          await publish(tx, ctx, "membership.delegate_added", {
            principalMembershipId: principal.id,
            inviteId: invite.invite.id,
            scope: input.scope,
            byMembershipId: input.actor.membershipId,
            by: input.by,
          });
          await deps.audit.record(tx, ctx, {
            action: "membership.delegate_added",
            ...audit,
            meta: { inviteId: invite.invite.id, scope: input.scope, by: input.by },
          });
          return { outcome: "sent" as const, created: invite, principalName };
        });
      let result = await attempt(false);
      if (result.outcome === "ready") {
        await input.spendInviteCap?.();
        result = await attempt(true);
      }
      if (result.outcome === "skipped") {
        deps.log?.("auth.delegate_add_skipped", {
          workspaceId: ctx.workspaceId,
          principalMembershipId: input.principalMembershipId,
        });
        return { outcome: "skipped" };
      }
      if (result.outcome !== "sent")
        throw new Error("unreachable: a write pass always sends or skips");
      const { created, principalName } = result;
      await sendInviteEmail(
        deps,
        email,
        {
          workspaceId: ctx.workspaceId,
          workspaceName: input.workspaceName,
          inviterName: input.inviterName,
          message,
          delegateFor: principalName,
        },
        created.url,
        created.invite.expiresAt,
      );
      deps.log?.("auth.delegate_added", {
        workspaceId: ctx.workspaceId,
        principalMembershipId: input.principalMembershipId,
        inviteId: created.invite.id,
        by: input.by,
      });
      return { outcome: "sent", created };
    },

    async remove(ctx, input) {
      const actorKind = isStaff(input.actor.role) ? "staff" : "external";
      // A pending invitation is withdrawn in one transaction with its audit rows.
      const invite = await deps.db.withTenant(ctx, async (tx) => {
        const invites = new InviteRepo(ctx, tx);
        const inv = await invites.byId(input.delegateId);
        if (inv === undefined || inv.principalMembershipId !== input.principalMembershipId)
          return undefined;
        if (!(await invites.revoke(inv.id))) throw new AuthError("not_found", "no such delegate");
        await deps.audit.record(tx, ctx, {
          action: "invite.revoked",
          resourceKind: "invite",
          resourceId: inv.id,
          actorKind,
          actorMembershipId: input.actor.membershipId,
          actorUserId: input.actor.userId,
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
        });
        await deps.audit.record(tx, ctx, {
          action: "membership.delegate_removed",
          resourceKind: "membership",
          resourceId: input.principalMembershipId,
          subjectMembershipId: input.principalMembershipId,
          actorKind,
          actorMembershipId: input.actor.membershipId,
          actorUserId: input.actor.userId,
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          meta: { inviteId: inv.id, by: input.by },
        });
        return inv;
      });
      if (invite !== undefined) return { kind: "invite" };

      const target = await deps.db.withTenant(ctx, (tx) =>
        new MembershipRepo(ctx, tx).byId(input.delegateId),
      );
      if (
        target === undefined ||
        target.status === "revoked" ||
        target.role !== "delegate" ||
        target.principalMembershipId !== input.principalMembershipId
      )
        throw new AuthError("not_found", "no such delegate");
      await memberships.revoke(
        ctx,
        { membershipId: target.id, reason: "delegate_removed" },
        input.actor,
      );
      await deps.db.withTenant(ctx, (tx) =>
        deps.audit.record(tx, ctx, {
          action: "membership.delegate_removed",
          resourceKind: "membership",
          resourceId: input.principalMembershipId,
          subjectMembershipId: input.principalMembershipId,
          actorKind,
          actorMembershipId: input.actor.membershipId,
          actorUserId: input.actor.userId,
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          meta: { delegateMembershipId: target.id, by: input.by },
        }),
      );
      return { kind: "member" };
    },
  };
}
