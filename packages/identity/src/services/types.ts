import type { AuditRecorder } from "@fundroom/audit";
import type { KeyRing } from "@fundroom/config";
import type {
  Database,
  MembershipKind,
  MembershipRole,
  MembershipStatus,
  TenantContext,
  Tx,
} from "@fundroom/db";
import type {
  AuthenticatedSession,
  AuthLevel,
  AuthPopulation,
  MailerPort,
  RateLimiterPort,
  SsoBinding,
} from "@fundroom/ports";
import type { SessionLifetimes } from "../policy/lifetimes.js";
import type { ShareLinkAccess } from "./share-link-access.js";

/** Wiring shared by every flow. Built once in `apps/server/src/container.ts`. */
export interface IdentityDeps {
  readonly db: Database;
  readonly keyRing: KeyRing;
  readonly mailer: MailerPort;
  readonly rateLimiter: RateLimiterPort;
  /** Audit recorder (E0.4): logins, revocations, credential changes, invites, memberships. */
  readonly audit: AuditRecorder;
  /** Public origin (+ base path) used to build links in emails. */
  readonly baseUrl: URL;
  /** Shown in emails and as the TOTP issuer. */
  readonly productName: string;
  /** Injected clock for tests. */
  readonly now?: () => Date;
  /** Structured log hook; never receives emails, codes or tokens. */
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
  /** Workspace/operator overrides, clamped to platform bounds. */
  readonly lifetimes?: Partial<Readonly<Record<AuthPopulation, Partial<SessionLifetimes>>>>;
  /** Paths (relative to `baseUrl`) that the web app serves; used in emails. */
  readonly paths?: Partial<IdentityPaths>;
  /**
   * Share-link admission and binding (E2.3), wired by the composition root. Absent in every
   * deployment and every test that does not serve share links, and the login path behaves
   * exactly as it did before when it is: a link id with no implementation admits nobody.
   */
  readonly shareLinks?: ShareLinkAccess | undefined;
  /**
   * The relationship recorder (E3.1), wired by the composition root from `@fundroom/compliance`
   * (`createRelationshipService({ db, audit })`) — that package depends on this one, so it is
   * injected rather than imported. `establishMembership` uses it to copy the pre-existing
   * relationship an approver attested on an access request onto the new membership, with its
   * `membership.relationship_recorded` audit row, in the acceptance transaction. Absent: the facts
   * stay on the request row and a warning is logged.
   */
  readonly relationships?: RelationshipRecorder | undefined;
  /**
   * Plan quotas (E3.10), wired by the composition root to `ModuleServices.quota` (structural, so
   * this package does not import the module kit). Checked on the caller's transaction wherever a
   * seat is added — an invitation, a SCIM/SSO-provisioned staff member, a share-link visitor —
   * and throws the 402 `plan_limit` error. Absent: nothing is limited (every self-hosted install).
   */
  readonly quota?: QuotaGate | undefined;
}

/** The slice of `ModuleServices.quota` identity needs (see `IdentityDeps.quota`). */
export interface QuotaGate {
  check(
    tx: Tx,
    input: {
      readonly workspaceId: string;
      readonly kind: "staffSeats" | "investorSeats";
      readonly delta: number;
    },
  ): Promise<void>;
}

/**
 * The slice of compliance's `RelationshipService` identity needs (structural, so this package does
 * not import `@fundroom/compliance`). Runs on the caller's transaction.
 */
export interface RelationshipRecorder {
  record(
    ctx: TenantContext,
    tx: Tx,
    membershipId: string,
    input: {
      readonly establishedAt?: Date | null | undefined;
      readonly source?: string | null | undefined;
      readonly note?: string | null | undefined;
      /** `null`: the system (no approver — see `RelationshipInput.actor` in compliance). */
      readonly actor: {
        readonly membershipId: string;
        readonly requestId?: string | undefined;
      } | null;
    },
  ): Promise<unknown>;
}

export interface IdentityPaths {
  /** POST-to-confirm page for magic links; receives `?token=`. */
  readonly magicLinkConfirm: string;
  /** One-click "this wasn't me" page; receives `?token=`. */
  readonly revokeSession: string;
  /** The sessions & devices settings page. */
  readonly sessions: string;
  /** Invite landing page; receives `/<token>`. */
  readonly invite: string;
  /** The sign-in page (E3.1: linked from "you already have access"). */
  readonly signIn: string;
}

export const DEFAULT_PATHS: IdentityPaths = {
  magicLinkConfirm: "/auth/link",
  revokeSession: "/auth/sessions/revoke",
  sessions: "/settings/sessions",
  invite: "/invite",
  signIn: "/login",
};

/** Per-request facts every login flow needs to mint a session. */
export interface LoginContext {
  /** The workspace the login page belongs to; absent only for host-level (multi-tenant) login. */
  readonly workspaceId?: string | undefined;
  /** Used in the OTP/link emails ("Sign in to Acme investors"). */
  readonly workspaceName?: string | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  /** True inside the embed iframe: the session cookie is `Partitioned` (ADR-0009). */
  readonly embed?: boolean | undefined;
  /** Top-level site of the embedding page, when known. */
  readonly topSite?: string | undefined;
  /** Current device cookie value, if the browser sent one. */
  readonly deviceToken?: string | undefined;
  readonly rememberDevice?: boolean | undefined;
  /**
   * The share link this sign-in is happening through (E2.3), resolved by the caller **from the
   * link's token**. Set only by the three token-scoped `/links/{token}` routes; it is deliberately
   * absent from every `/auth/*` request schema (contract C4), because a link id is not a secret
   * and accepting one there would bypass the link's passcode.
   */
  readonly linkId?: string | undefined;
  /**
   * The live session the request's cookie already named, if any. The new session replaces it
   * and it is revoked (ASVS 7.2.4, F-12). Callers pass the *resolved* session's id, never a
   * client-supplied value.
   */
  readonly replacesSessionId?: string | undefined;
}

export interface MembershipSummary {
  readonly id: string;
  readonly kind: MembershipKind;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
}

export interface LoginResult {
  /** Raw session token: goes into the session cookie and nowhere else. */
  readonly token: string;
  /** Raw device token for the device cookie (long-lived). */
  readonly deviceToken: string;
  readonly session: AuthenticatedSession;
  readonly isNewDevice: boolean;
  readonly isNewUser: boolean;
  /** Present when the login named a workspace. */
  readonly membership: MembershipSummary | undefined;
}

export interface CompleteLoginInput extends LoginContext {
  /** Either an existing user, or an email whose eligibility (invite/membership) admits creating one. */
  readonly userId?: string | undefined;
  readonly email?: string | undefined;
  readonly displayName?: string | undefined;
  readonly authLevel: AuthLevel;
  /**
   * When the user actually authenticated (E3.8 FR5: an SSO login passes the IdP's time, or a
   * stale one when the IdP gives none, so the session is fresh only after a real re-login).
   * Default: now.
   */
  readonly authTime?: Date | undefined;
  /** How the user proved themselves; logged, never trusted. */
  readonly method: "email_otp" | "magic_link" | "passkey" | "password" | "oidc" | "host" | "sso";
  /**
   * Staff SSO (E3.8): the workspace connection that verified this login. Required with method
   * `sso` and only with it; `sso.workspaceId` must equal `workspaceId`. The session is bound to
   * that workspace, and only a staff membership (or staff invitation) there is admitted.
   */
  readonly sso?: SsoBinding | undefined;
}

export function nowOf(deps: Pick<IdentityDeps, "now">): Date {
  return deps.now ? deps.now() : new Date();
}

export function pathsOf(deps: Pick<IdentityDeps, "paths">): IdentityPaths {
  return { ...DEFAULT_PATHS, ...deps.paths };
}

export function absoluteUrl(
  deps: Pick<IdentityDeps, "baseUrl">,
  path: string,
  query?: Record<string, string>,
): string {
  const base = deps.baseUrl.href.endsWith("/") ? deps.baseUrl.href : `${deps.baseUrl.href}/`;
  const url = new URL(path.replace(/^\//u, ""), base);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return url.href;
}

/** `a***@example.com`: enough for "we sent a code to…" without confirming the address. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** Keeps the observable duration of a start endpoint the same whether or not mail was sent. */
export async function withMinimumDuration<T>(minMs: number, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const remaining = minMs - (performance.now() - started);
    if (remaining > 0) await new Promise((res) => setTimeout(res, remaining));
  }
}
