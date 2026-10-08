/**
 * What the rest of the system needs from the identity kernel (EXECUTION_PLAN §5.2
 * `AuthPort`, §6). Credential flows (OTP, magic link, passkeys, TOTP, password, OIDC) are
 * the kernel's own API in `@fundroom/identity`; this port is the narrow surface that HTTP
 * middleware and modules depend on, so the implementation can be swapped (e.g. for an
 * external OIDC IdP adapter) without touching them.
 */

/** 0 host-asserted, 1 email/password verified, 2 MFA (§6.2). */
export type AuthLevel = 0 | 1 | 2;

/** Drives session lifetimes (§6.3) and the MFA policy. */
export type AuthPopulation = "external" | "staff" | "operator";

/** Where the session cookie lives (§6.3). */
export type SessionCookieContext = "first_party" | "partitioned" | "bearer";

/**
 * "View as investor" (E2.7): a staff session looking at one workspace's portal as one external
 * member of it, until `until`. Stored on the session row; the HTTP layer decides per request
 * whether it applies (right workspace, not expired, staff still entitled, target still live).
 */
export interface SessionViewAs {
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly startedAt: Date;
  readonly until: Date;
}

/**
 * Staff SSO (E3.8, ADR-0056): the workspace whose IdP asserted a session, and the connection that
 * minted it. A bound session is treated as no session on any request whose resolved workspace is
 * another one (or none): a tenant's IdP can assert any email, so what it vouches for must stay in
 * that tenant.
 */
export interface SsoBinding {
  readonly workspaceId: string;
  readonly connectionId: string;
  /**
   * The connection's `version` when the session was minted (E3.8 FR3). Session resolution ignores
   * the session once the workspace's live connection id/version (`core.workspace.sso_connection_*`)
   * differ — a disable, delete or security-relevant save bumps or clears them. Absent on a session
   * minted without one: such a session is ignored wherever a version is live.
   */
  readonly connectionVersion?: number | undefined;
}

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly deviceId: string | undefined;
  readonly population: AuthPopulation;
  readonly context: SessionCookieContext;
  readonly authLevel: AuthLevel;
  /** When `authLevel` was last proven; step-up compares this. */
  readonly authTime: Date;
  readonly createdAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly lastWorkspaceId: string | undefined;
  readonly user: {
    readonly displayName: string;
    readonly mfaEnrolled: boolean;
    /** E2.8: the user's chosen UI/email language (`core.user.locale`); null = not chosen. */
    readonly locale?: string | null | undefined;
  };
  /** Present while this session is viewing a workspace as an investor (may be expired). */
  readonly viewAs?: SessionViewAs | undefined;
  /** Present when the session was minted by a workspace's SSO connection (E3.8). */
  readonly sso?: SsoBinding | undefined;
  /**
   * Present when the session was minted by a central-auth handoff (E3.10, ADR-0058): it serves
   * this workspace only and cannot read or change the global account, like an SSO-bound session.
   */
  readonly boundWorkspaceId?: string | undefined;
}

/**
 * A workspace API key authenticating a request (E3.4, ADR-0052). Set on the request context as
 * `apiKey` by the bearer resolver when `Authorization: Bearer frk_…` names a live key; the key
 * acts as `creatorMembershipId`, capped by `scopes` (∩ the creator's current role permissions).
 * Never carries the token or its hash.
 */
export interface ApiKeyPrincipal {
  readonly id: string;
  readonly name: string;
  /** Display prefix: the token's first 12 characters. */
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly creatorMembershipId: string;
}

export type SessionRevokeReason =
  | "logout"
  | "logout_everywhere"
  | "expired"
  | "membership_revoked"
  | "credential_changed"
  | "device_revoked"
  | "admin"
  | "suspicious"
  | "membership_suspended"
  | "sso_connection_deleted";

export interface AuthPort {
  /**
   * Resolves a raw session token (from the cookie) to a live session, touching
   * `last_seen_at` when due. `undefined` for unknown, expired or revoked tokens — the
   * caller never learns which.
   */
  resolveSession(token: string): Promise<AuthenticatedSession | undefined>;
  revokeSession(sessionId: string, reason: SessionRevokeReason): Promise<void>;
  /** "Sign out everywhere": bumps `user.session_version` and revokes every session. */
  revokeAllSessions(userId: string, reason: SessionRevokeReason): Promise<number>;
  /**
   * Membership revocation (§13.2): kills the user's sessions that last touched this
   * workspace (or none yet). Sessions active in other workspaces survive.
   */
  revokeSessionsForWorkspace(
    userId: string,
    workspaceId: string,
    reason: SessionRevokeReason,
  ): Promise<number>;
  /** Records which workspace a session last served; read back as `lastWorkspaceId`. */
  touchWorkspace(sessionId: string, workspaceId: string): Promise<void>;
}
