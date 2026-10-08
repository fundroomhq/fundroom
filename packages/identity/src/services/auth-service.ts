import { membershipExpired } from "@fundroom/authz";
import type { AuthPort, SsoBinding } from "@fundroom/ports";
import { STEP_UP_MAX_AGE_MS } from "../policy/lifetimes.js";
import { assertMayChangeAccount } from "../policy/sso-bound.js";
import { listCredentials } from "../repos/credential-repo.js";
import { listWorkspaceMembershipsForUser } from "../repos/membership-repo.js";
import { findUserByEmail, normalizeEmail, primaryEmail } from "../repos/user-repo.js";
import { createDelegateService, type DelegateService } from "./delegates.js";
import { createEmailOtpFlow, type EmailOtpFlow, type EmailOtpOptions } from "./email-otp.js";
import { createGroupService, type GroupService } from "./groups.js";
import { createInviteImportService, type InviteImportService } from "./invite-import.js";
import { createInviteService, type InviteService } from "./invites.js";
import { checkEligibility, type LoginEligibility } from "./login.js";
import { createMagicLinkFlow, type MagicLinkFlow, type MagicLinkOptions } from "./magic-link.js";
import { createMembershipService, type MembershipService } from "./memberships.js";
import { createOidcFlow, type OidcFlow, type OidcOptions } from "./oidc.js";
import {
  createPasskeyFlow,
  PASSKEY_PRESENCE_KEY,
  type PasskeyFlow,
  type PasskeyOptions,
} from "./passkeys.js";
import { createPasswordFlow, type PasswordFlow, type PasswordOptions } from "./password.js";
import { type BootstrapOwnerInput, bootstrapOwner } from "./provision.js";
import { createSessionService, type SessionService } from "./sessions.js";
import { createTotpFlow, type TotpFlow, type TotpOptions } from "./totp.js";
import { type IdentityDeps, type LoginResult, type MembershipSummary, nowOf } from "./types.js";

/**
 * The composition root for identity. `apps/server/src/container.ts` builds one of these
 * from config and hands `AuthPort` to middleware and modules; the auth routes (E0.6) call
 * the flows.
 */
export interface AuthServiceOptions {
  readonly emailOtp?: EmailOtpOptions | undefined;
  readonly magicLink?: MagicLinkOptions | undefined;
  readonly passkeys: PasskeyOptions;
  readonly totp?: TotpOptions | undefined;
  readonly password: PasswordOptions;
  readonly oidc?: OidcOptions | undefined;
}

export interface AuthService extends AuthPort {
  readonly sessions: SessionService;
  readonly emailOtp: EmailOtpFlow;
  readonly magicLink: MagicLinkFlow;
  readonly passkeys: PasskeyFlow;
  readonly totp: TotpFlow;
  readonly password: PasswordFlow;
  /** Absent when no OIDC provider is configured. */
  readonly oidc: OidcFlow | undefined;
  readonly invites: InviteService;
  /** Delegates of principal investors (E3.2). */
  readonly delegates: DelegateService;
  /** People, groups and CSV imports (E1.1). */
  readonly memberships: MembershipService;
  readonly groups: GroupService;
  readonly inviteImports: InviteImportService;
  /** Whether an email may start a login for a workspace (start endpoints never reveal this). */
  checkEligibility(input: {
    email?: string | undefined;
    userId?: string | undefined;
    workspaceId?: string | undefined;
  }): Promise<LoginEligibility>;
  /** The user's own non-revoked, unexpired memberships (workspace switcher). */
  listMemberships(
    userId: string,
  ): Promise<readonly (MembershipSummary & { workspaceId: string })[]>;
  /** Setup wizard (E0.8): first owner of a fresh workspace, signed in at level 1. */
  bootstrapOwner(input: BootstrapOwnerInput): Promise<LoginResult>;
  /** The user's primary email (for host-level mail such as the setup probe). */
  primaryEmail(userId: string): Promise<string | undefined>;
  /**
   * Whether the user holds a second factor: a confirmed authenticator app or any passkey (P2-01).
   * A password is not one, and neither is a pending, unconfirmed TOTP enrolment. Read from the
   * credentials themselves, not the `mfa_enrolled` flag, because it gates who may replace them.
   */
  hasSecondFactor(userId: string): Promise<boolean>;
  /**
   * Whether this session may manage the user's sign-in factors (P2-01, E2.10 R1-05): yes when
   * the user holds no second factor yet (enrolling the first is onboarding), when the session is
   * level 2, or when the session was stepped up within the step-up window with one of the
   * user's passkeys *without* user verification. That last case is a security key with no PIN:
   * it cannot make a session MFA on its own (it signs in at level 1), but it does prove
   * possession of an enrolled factor — what this gate exists to ask for — and without it a user
   * whose only factor is such a key could never change anything again.
   */
  /**
   * Whether `email` is a verified address of an active staff member in a workspace where
   * `userId` is an active staff owner or admin (E2.10 F-28: who the setup mail probe may write
   * to besides the caller). Never says why not.
   */
  isVerifiedStaffColleague(userId: string, email: string): Promise<boolean>;
  /**
   * Throws `sso_session_restricted` for an SSO-bound session (E3.8): a tenant's IdP vouches for
   * that tenant only, never for changes to the global account (see `assertMayChangeAccount`).
   */
  canManageFactors(session: {
    readonly userId: string;
    readonly sessionId: string;
    readonly authLevel: number;
    readonly sso?: SsoBinding | undefined;
    /** E3.10: a central-auth bound session is refused too (`bound_session_restricted`). */
    readonly boundWorkspaceId?: string | undefined;
  }): Promise<boolean>;
}

/** A confirmed authenticator app or any passkey; a password is not a second factor (P2-01). */
function isSecondFactor(c: { kind: string; confirmedAt: Date | null }): boolean {
  return c.kind === "passkey" || (c.kind === "totp" && c.confirmedAt !== null);
}

export function createAuthService(deps: IdentityDeps, options: AuthServiceOptions): AuthService {
  const sessions = createSessionService(deps);
  const oidc =
    options.oidc && Object.keys(options.oidc.providers).length > 0
      ? createOidcFlow(deps, sessions, options.oidc)
      : undefined;
  const memberships = createMembershipService(deps, sessions);
  const invites = createInviteService(deps, memberships);
  async function listMemberships(
    userId: string,
  ): Promise<readonly (MembershipSummary & { workspaceId: string })[]> {
    const rows = await deps.db.withHost((tx) => listWorkspaceMembershipsForUser(tx, userId), {
      actorKind: "host",
      userId,
    });
    // An expired membership is not live (P1-01): it leaves the switcher like a revoked one.
    const t = nowOf(deps);
    return rows
      .filter((r) => !membershipExpired(r.expiresAt, t))
      .map((r) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        kind: r.kind,
        role: r.role,
        status: r.status,
      }));
  }

  return {
    memberships,
    groups: createGroupService(deps),
    inviteImports: createInviteImportService(deps, invites),
    sessions,
    emailOtp: createEmailOtpFlow(deps, sessions, options.emailOtp),
    magicLink: createMagicLinkFlow(deps, sessions, options.magicLink),
    passkeys: createPasskeyFlow(deps, sessions, options.passkeys),
    totp: createTotpFlow(deps, sessions, options.totp),
    password: createPasswordFlow(deps, sessions, options.password),
    oidc,
    invites,
    delegates: createDelegateService(deps, memberships),

    resolveSession: (token) => sessions.resolveSession(token),
    revokeSession: (id, reason) => sessions.revokeSession(id, reason),
    revokeAllSessions: (userId, reason) => sessions.revokeAllSessions(userId, reason),
    revokeSessionsForWorkspace: (userId, workspaceId, reason) =>
      sessions.revokeSessionsForWorkspace(userId, workspaceId, reason),
    touchWorkspace: (sessionId, workspaceId) => sessions.touchWorkspace(sessionId, workspaceId),

    checkEligibility: (input) => checkEligibility(deps, input),

    bootstrapOwner: (input) => bootstrapOwner(deps, sessions, input),
    primaryEmail: (userId) => deps.db.withHost((tx) => primaryEmail(tx, userId)),

    async hasSecondFactor(userId) {
      const creds = await deps.db.withHost((tx) => listCredentials(tx, userId));
      return creds.some(isSecondFactor);
    },

    async canManageFactors({ userId, sessionId, authLevel, sso, boundWorkspaceId }) {
      assertMayChangeAccount({ sso, boundWorkspaceId });
      if (authLevel >= 2) return true;
      const creds = await deps.db.withHost((tx) => listCredentials(tx, userId));
      if (!creds.some(isSecondFactor)) return true;
      const t = nowOf(deps).getTime();
      return creds.some((c) => {
        if (c.kind !== "passkey") return false;
        const presence = (c.data as Record<string, unknown> | null)?.[PASSKEY_PRESENCE_KEY] as
          | { sessionId?: unknown; at?: unknown }
          | undefined;
        if (presence?.sessionId !== sessionId || typeof presence.at !== "string") return false;
        const age = t - Date.parse(presence.at);
        return age >= 0 && age <= STEP_UP_MAX_AGE_MS;
      });
    },

    listMemberships,

    async isVerifiedStaffColleague(userId, email) {
      let normalized: string;
      try {
        normalized = normalizeEmail(email);
      } catch {
        return false;
      }
      const target = await deps.db.withHost((tx) => findUserByEmail(tx, normalized));
      if (target === undefined || target.identity.verifiedAt === null) return false;
      const led = new Set(
        (await listMemberships(userId))
          .filter(
            (m) =>
              m.kind === "staff" &&
              m.status === "active" &&
              (m.role === "owner" || m.role === "admin"),
          )
          .map((m) => m.workspaceId),
      );
      if (led.size === 0) return false;
      return (await listMemberships(target.id)).some(
        (m) => m.kind === "staff" && m.status === "active" && led.has(m.workspaceId),
      );
    },
  };
}
