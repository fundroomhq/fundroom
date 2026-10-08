import { membershipExpired } from "@fundroom/authz";
import {
  type DelegateScope,
  type Invite,
  type MembershipKind,
  type MembershipRole,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { type InviteGrant, InviteGrantsSchema } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import { randomToken, sha256 } from "../crypto/tokens.js";
import { AuthError } from "../errors.js";
import { inviteEmail } from "../mail/templates.js";
import { GroupRepo, InviteRepo, MembershipRepo } from "../repos/membership-repo.js";
import { findUserByEmail, normalizeEmail } from "../repos/user-repo.js";
import type { MembershipService } from "./memberships.js";
import { recipientLocale } from "./recipient-locale.js";
import { absoluteUrl, type IdentityDeps, maskEmail, nowOf, pathsOf } from "./types.js";

/*
 * Invitations (§13.1, design/05 §5). An opaque token identifies the invite without revealing
 * the email; acceptance = verified login (never the link alone). Groups and grants named on
 * the invite are applied when the membership is created (`establishMembership`).
 */
export interface CreateInviteInput {
  readonly workspaceId: string;
  readonly workspaceName?: string | undefined;
  readonly email: string;
  readonly kind: MembershipKind;
  readonly role: MembershipRole;
  readonly groupIds?: readonly string[] | undefined;
  /** Direct grants applied on acceptance (`InviteGrant[]`). */
  readonly grants?: readonly InviteGrant[] | undefined;
  readonly message?: string | undefined;
  readonly expiresInDays?: number | undefined;
  /** Membership id of the inviter (for audit and revocation cascade). */
  readonly invitedBy?: string | undefined;
  readonly inviterName?: string | undefined;
  /** Send the invitation email now. Default true. */
  readonly send?: boolean | undefined;
  /** Stored on the membership profile when the invite is accepted (`displayName`, `firm`, …). */
  readonly profile?: Readonly<Record<string, unknown>> | undefined;
  /**
   * E3.2: a delegate invitation acting for this principal with this scope. Only the delegate
   * service (`services/delegates.ts`) sets these; it has already checked the principal and the limit.
   */
  readonly delegate?:
    | { readonly principalMembershipId: string; readonly scope: DelegateScope }
    | undefined;
}

export interface CreatedInvite {
  readonly invite: Invite;
  /** Raw token; appears in the emailed URL and nowhere else. */
  readonly token: string;
  readonly url: string;
}

export interface InviteLanding {
  readonly valid: boolean;
  readonly workspaceId?: string;
  readonly emailHint?: string;
  readonly kind?: MembershipKind;
  readonly expiresAt?: Date;
}

export interface InviteService {
  create(input: CreateInviteInput): Promise<CreatedInvite>;
  /** What the landing page may show (no content, no full email); never consumes the invite. */
  resolve(workspaceId: string, token: string): Promise<InviteLanding>;
  list(
    ctx: TenantContext,
    filter: { status?: Invite["status"] | undefined; limit?: number },
  ): Promise<Invite[]>;
  get(ctx: TenantContext, inviteId: string): Promise<Invite | undefined>;
  /** New token + expiry on the same pending invite, email sent again. */
  resend(
    ctx: TenantContext,
    inviteId: string,
    input: {
      workspaceName?: string | undefined;
      inviterName?: string | undefined;
      expiresInDays?: number | undefined;
      /**
       * `access.maxDelegatesPerPrincipal`, for a delegate invitation: resending
       * one re-checks that its principal is still a live investor and still under the limit.
       */
      maxDelegates?: number | undefined;
    },
  ): Promise<CreatedInvite>;
  /** `by` = membership id of the revoking staff member, for the audit row. */
  revoke(workspaceId: string, inviteId: string, by?: string | undefined): Promise<boolean>;
  /** Revocation (§13.2) as a system action; the People screen goes through `MembershipService.revoke`. */
  revokeMembership(input: {
    workspaceId: string;
    membershipId: string;
    by?: string | undefined;
    reason?: string | undefined;
  }): Promise<readonly string[]>;
}

/**
 * The database half of `InviteService.create`, on the caller's tenant transaction: the
 * already-a-member refusal, group validation, superseding a pending invite to the same address,
 * the row, its event and its audit row. No mail and no second connection — the caller sends
 * (`sendInviteEmail`) after its transaction commits. `existingUserId` is the address's user, if
 * any, looked up by the caller on a host transaction beforehand (the user table is not readable
 * from a tenant one). Shared by `create` and the access-request approval (E3.1), so there is one
 * copy of "what an invitation is".
 */
export async function writeInvite(
  deps: IdentityDeps,
  ctx: TenantContext,
  tx: Tx,
  input: CreateInviteInput & {
    /** The access request this invitation answers (E3.1). */
    readonly accessRequestId?: string | undefined;
    /** Audit actor kind override; defaults to `staff` when `invitedBy` is set, else `system`. */
    readonly actorKind?: "staff" | "external" | "system" | undefined;
    readonly requestId?: string | undefined;
  },
  existingUserId: string | undefined,
): Promise<CreatedInvite> {
  const email = normalizeEmail(input.email);
  const now = nowOf(deps);
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + (input.expiresInDays ?? 7) * 24 * 3600_000);
  const grants = InviteGrantsSchema.parse(input.grants ?? []);
  const membershipsRepo = new MembershipRepo(ctx, tx);
  const invites = new InviteRepo(ctx, tx);
  if (existingUserId !== undefined) {
    const m = await membershipsRepo.findForUser(existingUserId);
    if (m)
      throw new AuthError("conflict", "already a member of this workspace", {
        membershipId: m.id,
        status: m.status,
      });
  }
  const groupIds = [...new Set(input.groupIds ?? [])];
  if (groupIds.length > 0) {
    const known = new Set((await new GroupRepo(ctx, tx).byIds(groupIds)).map((g) => g.id));
    for (const id of groupIds) {
      if (!known.has(id)) throw new AuthError("not_found", "no such group", { groupId: id });
    }
  }
  const pending = await invites.findPendingByEmail(email, now);
  // A delegate invitation never supersedes (E3.2): otherwise an investor could turn an admin's
  // pending invitation to someone into a delegate invitation acting for themselves.
  if (pending && input.delegate !== undefined)
    throw new AuthError("conflict", "this address already has a pending invitation", {
      reason: "pending_invite",
    });
  if (pending) await invites.revoke(pending.id);
  // E3.10 plan quota: a pending invitation holds its seat. After the superseded one is withdrawn
  // (it no longer counts), before the row and the audit (the check takes the workspace row).
  // Delegates are capped per investor (E3.2), not by the plan.
  if (input.kind === "staff" || input.role === "investor") {
    await deps.quota?.check(tx, {
      workspaceId: ctx.workspaceId,
      kind: input.kind === "staff" ? "staffSeats" : "investorSeats",
      delta: 1,
    });
  }
  const invite = await invites.create({
    email,
    tokenHash: sha256(token),
    kind: input.kind,
    role: input.role,
    groupIds,
    grants,
    profile: input.profile ?? {},
    message: input.message ?? null,
    expiresAt,
    invitedBy: input.invitedBy ?? null,
    createdAt: now,
    ...(input.accessRequestId === undefined ? {} : { accessRequestId: input.accessRequestId }),
    ...(input.delegate === undefined
      ? {}
      : {
          principalMembershipId: input.delegate.principalMembershipId,
          delegateScope: input.delegate.scope,
        }),
  });
  await publish(tx, ctx, "invite.created", {
    inviteId: invite.id,
    kind: input.kind,
    role: input.role,
    byMembershipId: input.invitedBy ?? null,
  });
  await deps.audit.record(tx, ctx, {
    action: "invite.created",
    resourceKind: "invite",
    resourceId: invite.id,
    actorKind: input.actorKind ?? (input.invitedBy ? "staff" : "system"),
    actorMembershipId: input.invitedBy ?? null,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    meta: {
      kind: input.kind,
      role: input.role,
      groupIds,
      grants: grants.length,
      supersededInviteId: pending?.id ?? null,
      expiresAt: expiresAt.toISOString(),
      ...(input.accessRequestId === undefined ? {} : { accessRequestId: input.accessRequestId }),
      ...(input.delegate === undefined
        ? {}
        : {
            principalMembershipId: input.delegate.principalMembershipId,
            delegateScope: input.delegate.scope,
          }),
    },
  });
  deps.log?.("auth.invite_created", {
    workspaceId: ctx.workspaceId,
    inviteId: invite.id,
    kind: input.kind,
    role: input.role,
  });
  const url = absoluteUrl(deps, `${pathsOf(deps).invite}/${token}`);
  return { invite, token, url };
}

/** Sends the invitation email (after the invite's transaction committed). `mail_failed` on error. */
export async function sendInviteEmail(
  deps: IdentityDeps,
  email: string,
  input: {
    /** Always known here: an invitation only exists inside one workspace (E1.7 branding). */
    workspaceId: string;
    workspaceName?: string | undefined;
    inviterName?: string | undefined;
    message?: string | undefined | null;
    /** Already negotiated by the caller; otherwise read here on a host transaction. */
    locale?: string | undefined;
    /** E3.2 / F5: the principal a delegate invitation acts for, named in the email. */
    delegateFor?: string | undefined;
  },
  url: string,
  expiresAt: Date,
): Promise<void> {
  // The invitee may already have an account with a language of their own (E2.8).
  const locale =
    input.locale ??
    (await deps.db.withHost((tx) =>
      recipientLocale(tx, { email, workspaceId: input.workspaceId }),
    ));
  try {
    await deps.mailer.send(
      inviteEmail(email, {
        productName: deps.productName,
        workspaceId: input.workspaceId,
        workspaceName: input.workspaceName,
        url,
        inviterName: input.inviterName,
        message: input.message ?? undefined,
        expiresAt,
        locale,
        ...(input.delegateFor === undefined ? {} : { delegateFor: input.delegateFor }),
      }),
    );
  } catch (error) {
    throw new AuthError("mail_failed", "could not send the invitation", {}, { cause: error });
  }
}

export function createInviteService(
  deps: IdentityDeps,
  memberships: Pick<MembershipService, "revoke">,
): InviteService {
  const sendInvite = (
    email: string,
    input: Parameters<typeof sendInviteEmail>[2],
    url: string,
    expiresAt: Date,
  ) => sendInviteEmail(deps, email, input, url, expiresAt);

  return {
    async create(input) {
      const email = normalizeEmail(input.email);
      const ctx = systemContext(input.workspaceId);
      const existingUser = await deps.db.withHost((tx) => findUserByEmail(tx, email));
      const created = await deps.db.withTenant(ctx, (tx) =>
        writeInvite(deps, ctx, tx, { ...input, email }, existingUser?.id),
      );
      if (input.send ?? true) await sendInvite(email, input, created.url, created.invite.expiresAt);
      return created;
    },

    async resolve(workspaceId, token) {
      if (typeof token !== "string" || token.length < 32) return { valid: false };
      const ctx = systemContext(workspaceId);
      const now = nowOf(deps);
      return deps.db.withTenant(ctx, async (tx) => {
        const inv = await new InviteRepo(ctx, tx).findByTokenHash(sha256(token));
        if (inv?.status !== "pending" || inv.expiresAt.getTime() <= now.getTime())
          return { valid: false };
        return {
          valid: true,
          workspaceId,
          emailHint: maskEmail(inv.email),
          kind: inv.kind,
          expiresAt: inv.expiresAt,
        };
      });
    },

    list: (ctx, filter) =>
      deps.db.withTenant(ctx, (tx) =>
        new InviteRepo(ctx, tx).list({ status: filter.status, limit: filter.limit ?? 200 }),
      ),

    get: (ctx, inviteId) => deps.db.withTenant(ctx, (tx) => new InviteRepo(ctx, tx).byId(inviteId)),

    async resend(ctx, inviteId, input) {
      const now = nowOf(deps);
      const token = randomToken();
      const expiresAt = new Date(now.getTime() + (input.expiresInDays ?? 7) * 24 * 3600_000);
      const invite = await deps.db.withTenant(ctx, async (tx) => {
        const invites = new InviteRepo(ctx, tx);
        const current = await invites.byId(inviteId);
        if (current === undefined || current.status !== "pending")
          throw new AuthError("not_found", "no pending invitation with that id");
        // F7: a delegate invitation is only as good as its principal, and resending one must not
        // be a way around the limit (an expired invitation no longer counts toward it).
        let delegateFor: string | undefined;
        if (current.principalMembershipId !== null) {
          const memberships = new MembershipRepo(ctx, tx);
          const principal = await memberships.lockForUpdate(current.principalMembershipId);
          if (
            principal === undefined ||
            principal.kind !== "external" ||
            principal.role !== "investor" ||
            principal.status !== "active" ||
            membershipExpired(principal.expiresAt, now)
          )
            throw new AuthError(
              "invalid_request",
              "this delegate's investor no longer has access",
              {
                reason: "principal_not_investor",
              },
            );
          if (input.maxDelegates !== undefined) {
            const live = await memberships.delegatesOf(principal.id);
            const pending = (await invites.pendingDelegatesOf(principal.id, now)).filter(
              (i) => i.id !== current.id,
            );
            if (live.length + pending.length >= input.maxDelegates)
              throw new AuthError("delegate_limit_reached", "this investor has no delegates left", {
                limit: input.maxDelegates,
              });
          }
          const person = await memberships.person(principal.id);
          delegateFor = person?.displayName || person?.email || "An investor";
        }
        const rotated = await invites.rotateToken(inviteId, sha256(token), expiresAt);
        if (rotated === undefined)
          throw new AuthError("not_found", "no pending invitation with that id");
        await deps.audit.record(tx, ctx, {
          action: "invite.resent",
          resourceKind: "invite",
          resourceId: inviteId,
          meta: { expiresAt: expiresAt.toISOString() },
        });
        return { rotated, delegateFor };
      });
      const url = absoluteUrl(deps, `${pathsOf(deps).invite}/${token}`);
      await sendInvite(
        invite.rotated.email,
        {
          ...input,
          workspaceId: ctx.workspaceId,
          message: invite.rotated.message,
          ...(invite.delegateFor === undefined ? {} : { delegateFor: invite.delegateFor }),
        },
        url,
        expiresAt,
      );
      deps.log?.("auth.invite_resent", { workspaceId: ctx.workspaceId, inviteId });
      return { invite: invite.rotated, token, url };
    },

    async revoke(workspaceId, inviteId, by) {
      const ctx = systemContext(workspaceId);
      return deps.db.withTenant(ctx, async (tx) => {
        const ok = await new InviteRepo(ctx, tx).revoke(inviteId);
        if (ok) {
          await deps.audit.record(tx, ctx, {
            action: "invite.revoked",
            resourceKind: "invite",
            resourceId: inviteId,
            actorKind: by ? "staff" : "system",
            actorMembershipId: by ?? null,
          });
        }
        return ok;
      });
    },

    async revokeMembership(input) {
      const r = await memberships.revoke(
        systemContext(input.workspaceId),
        { membershipId: input.membershipId, reason: input.reason },
        undefined,
      );
      return r.membershipIds;
    },
  };
}
