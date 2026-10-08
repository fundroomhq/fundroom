import {
  HOST_CONTEXT,
  type MembershipKind,
  type MembershipRole,
  systemContext,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import { AuthError } from "../errors.js";
import { MembershipRepo } from "../repos/membership-repo.js";
import { createUser, findUserByEmail, normalizeEmail } from "../repos/user-repo.js";
import { actorContextFor } from "./login.js";
import type { SessionService } from "./sessions.js";
import type { IdentityDeps, LoginResult, MembershipSummary } from "./types.js";

/*
 * Host-level provisioning (E0.8): the setup wizard's owner, `seed-demo`, and later host
 * admins create users and memberships without an invite. Everything here runs under a
 * host or system context and is audited like the invite path, with `source` recording who
 * created the row (`setup`, `host`, `demo`).
 */
export interface ProvisionUserInput {
  readonly email: string;
  readonly displayName?: string | undefined;
}

export interface ProvisionedUser {
  readonly userId: string;
  readonly email: string;
  readonly created: boolean;
}

/** Finds or creates the global user for an email (verified: a host operator vouches for it). */
export async function provisionUser(
  deps: IdentityDeps,
  input: ProvisionUserInput,
): Promise<ProvisionedUser> {
  const email = normalizeEmail(input.email);
  return deps.db.withHost(async (tx) => {
    const existing = await findUserByEmail(tx, email);
    if (existing) return { userId: existing.id, email, created: false };
    const user = await createUser(tx, {
      displayName: input.displayName ?? "",
      identity: { type: "email", identifier: email, verified: true },
    });
    await publish(tx, HOST_CONTEXT, "user.created", { userId: user.id, method: "provision" });
    deps.log?.("auth.user_created", { userId: user.id, method: "provision" });
    return { userId: user.id, email, created: true };
  });
}

export interface ProvisionMembershipInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly kind: MembershipKind;
  readonly role: MembershipRole;
  /** `setup` | `host` | `demo` … (see `core.membership.source`). */
  readonly source: string;
  /** Default `active`. */
  readonly status?: "active" | "invited" | undefined;
  /** Membership id of the staff member doing this, when there is one. */
  readonly actorMembershipId?: string | undefined;
  readonly actorUserId?: string | undefined;
}

/**
 * Creates an active membership directly. Refuses (`mfa_already_enrolled`-style 409 is wrong
 * here, so `invalid_request`) when the user already holds a live membership in the workspace.
 */
export async function provisionMembership(
  deps: IdentityDeps,
  input: ProvisionMembershipInput,
): Promise<MembershipSummary> {
  const ctx = systemContext(input.workspaceId);
  return deps.db.withTenant(ctx, async (tx) => {
    const memberships = new MembershipRepo(ctx, tx);
    const existing = await memberships.findForUser(input.userId);
    if (existing) {
      throw new AuthError("invalid_request", "the user already belongs to this workspace", {
        membershipId: existing.id,
      });
    }
    const status = input.status ?? "active";
    const now = deps.now?.() ?? new Date();
    const created = await memberships.create({
      userId: input.userId,
      kind: input.kind,
      role: input.role,
      status,
      source: input.source,
      ...(status === "active" ? { activatedAt: now, lastSeenAt: now } : {}),
    });
    await publish(tx, ctx, "membership.created", {
      membershipId: created.id,
      userId: input.userId,
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
      actorKind: input.actorMembershipId ? "staff" : "host",
      actorMembershipId: input.actorMembershipId ?? null,
      actorUserId: input.actorUserId ?? null,
      meta: { source: input.source, kind: created.kind, role: created.role },
    });
    return { id: created.id, kind: created.kind, role: created.role, status: created.status };
  });
}

export interface BootstrapOwnerInput {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly email: string;
  readonly displayName?: string | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * The setup wizard's one privileged step: the first owner of a fresh workspace, signed in
 * at auth level 1 (the wizard then adds a passkey or password + TOTP on that session).
 * The setup token check and the "no workspace yet" check are the caller's job.
 */
export async function bootstrapOwner(
  deps: IdentityDeps,
  sessions: SessionService,
  input: BootstrapOwnerInput,
): Promise<LoginResult> {
  const user = await provisionUser(deps, { email: input.email, displayName: input.displayName });
  const membership = await provisionMembership(deps, {
    workspaceId: input.workspaceId,
    userId: user.userId,
    kind: "staff",
    role: "owner",
    source: "setup",
    actorUserId: user.userId,
  });
  const started = await sessions.startSession({
    userId: user.userId,
    population: "staff",
    context: "first_party",
    authLevel: 1,
    ip: input.ip,
    userAgent: input.userAgent,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
  });
  deps.log?.("auth.owner_bootstrapped", {
    userId: user.userId,
    workspaceId: input.workspaceId,
    newUser: user.created,
  });
  await deps.audit.recordDetached(actorContextFor(input.workspaceId, membership, user.userId), {
    action: "auth.login",
    resourceKind: "session",
    resourceId: started.session.sessionId,
    sessionId: started.session.sessionId,
    actorUserId: user.userId,
    subjectMembershipId: membership.id,
    ip: input.ip,
    userAgent: input.userAgent,
    meta: {
      method: "setup",
      authLevel: 1,
      population: "staff",
      newUser: user.created,
      newDevice: started.isNewDevice,
      embed: false,
    },
  });
  return { ...started, isNewUser: user.created, membership };
}
