import type { AuditRecorder } from "@fundroom/audit";
import type { EnvelopeService } from "@fundroom/crypto";
import type { Database, TenantContext, Tx } from "@fundroom/db";
import type {
  IdentityDeps,
  LoginContext,
  LoginResult,
  MembershipService,
  SessionService,
} from "@fundroom/identity";
import type { DnsResolverPort } from "@fundroom/ports";
import type { SsoFlowErrorCode } from "./errors.js";

/*
 * `@fundroom/sso` contract types (E3.8, ADR-0056). Frozen by the epic contract; the foundation
 * landed them verbatim with stub implementations — the service itself is Agent A's.
 */

/** Workspace key purpose (ADR-0016) of the sealed OIDC client secret. */
export const SSO_KEY_PURPOSE = "sso-credentials";

export type SsoProtocol = "oidc" | "saml";
export type StaffJitRole = "editor" | "viewer" | "finance" | "legal";

/** The tenant context the service runs in (the same `TenantContext` accreditation uses). */
export type SsoCtx = TenantContext;

/** Who asked, for the audit row (the shape `AccreditationActor` has). */
export interface SsoActor {
  readonly membershipId: string | null;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly apiKeyId?: string | undefined;
}

export interface SsoSpInfo {
  oidcRedirectUri: string;
  samlAcsUrl: string;
  samlEntityId: string;
  samlMetadataUrl: string;
}

export interface SsoConnectionView {
  id: string;
  protocol: SsoProtocol;
  name: string;
  enabled: boolean;
  enforce: "off" | "staff";
  status: "active" | "error";
  lastError: string | null;
  lastVerifiedAt: string | null;
  lastTestedAt: string | null;
  lastLoginAt: string | null;
  jit: { enabled: boolean; role: StaffJitRole };
  mfa: { trust: boolean; values: string[] };
  oidc: { issuer: string; clientId: string; hasSecret: boolean } | null;
  saml: {
    idpEntityId: string;
    idpSsoUrl: string;
    certificates: { fingerprintSha256: string; notAfter: string; subject: string }[];
  } | null;
  sp: SsoSpInfo;
  createdAt: string;
  updatedAt: string;
}

export type SaveSsoConnectionInput = {
  name: string;
  jit: { enabled: boolean; role: StaffJitRole };
  mfa: { trust: boolean; values: string[] };
} & (
  | {
      protocol: "oidc";
      issuer: string;
      clientId: string;
      /** Required on create, on a protocol switch, and when the issuer changes. */
      clientSecret?: string | undefined;
    }
  | {
      protocol: "saml";
      /** `metadataXml` XOR the three fields below. */
      metadataXml?: string | undefined;
      idpEntityId?: string;
      idpSsoUrl?: string;
      certificates?: string[];
    }
);

export interface SsoDomainView {
  id: string;
  domain: string;
  status: "pending" | "verified";
  txtName: string;
  txtValue: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  takenElsewhere?: never;
}

/**
 * Plan entitlements (A-3, ADR-0063): the server's `sso` feature check, passed per call. Each is
 * called with the connection row locked, before anything is written, only on the transition the
 * plan governs; it throws (the server's 402 `plan_limit`) to refuse. A downgrade freezes the
 * configuration: the existing connection can be re-keyed, kept as it is and switched off, never
 * replaced by a new one or switched (back) on.
 */
export interface SsoSaveOptions {
  /**
   * Called when the save would create a connection: none yet, or another IdP (a protocol switch
   * or another OIDC issuer / SAML entity ID — the service makes a new, disabled connection for
   * those). Re-keying the existing one (secret, certificates, metadata, name, JIT, MFA) never is.
   */
  readonly assertMayCreate?: (() => void) | undefined;
  /**
   * Round-2 decision 18 (RR1 L4): called when a save of the existing connection turns
   * just-in-time provisioning or trusting the IdP's MFA from off to on — new scope, like a
   * domain. Keeping either on, changing the JIT role, or turning either off never call it.
   */
  readonly assertMayTurnOn?: (() => void) | undefined;
}

export interface SsoStateOptions {
  /**
   * Called when the write turns something on: a disabled connection enabled, or an enabled one
   * enforced. Keeping the state, turning enforcement off and disabling never call it.
   */
  readonly assertMayTurnOn?: (() => void) | undefined;
}

export interface SsoService {
  getConnection(ctx: SsoCtx): Promise<SsoConnectionView | null>;
  /** Live-verifies OUTSIDE the transaction first; bumps `version`. */
  saveConnection(
    ctx: SsoCtx,
    input: SaveSsoConnectionInput,
    actor: SsoActor,
    options?: SsoSaveOptions,
  ): Promise<SsoConnectionView>;
  setState(
    ctx: SsoCtx,
    input: { enabled: boolean; enforce: "off" | "staff" },
    actor: SsoActor,
    options?: SsoStateOptions,
  ): Promise<SsoConnectionView>;
  deleteConnection(ctx: SsoCtx, actor: SsoActor): Promise<void>;
  protocolsOffered(): SsoProtocol[];
  listDomains(ctx: SsoCtx): Promise<SsoDomainView[]>;
  addDomain(ctx: SsoCtx, domain: string, actor: SsoActor): Promise<SsoDomainView>;
  /** TXT `_fundroom-sso.<domain>` = `fundroom-sso=<token>` via `DnsResolverPort`; the
   *  pre-rename `_seedhost-sso` label and `seedhost-sso=` prefix are still accepted. */
  verifyDomain(ctx: SsoCtx, id: string, actor: SsoActor): Promise<SsoDomainView>;
  removeDomain(ctx: SsoCtx, id: string, actor: SsoActor): Promise<void>;
  /** Tx-scoped helpers for SCIM — MUST use the caller's tx (pool-deadlock rule). */
  verifiedDomains(tx: Tx, workspaceId: string): Promise<string[]>;
  defaultStaffRole(tx: Tx, workspaceId: string): Promise<StaffJitRole>;

  // --- the login flow: only `apps/server/src/routes/sso-flow.ts` calls these -----------------
  /** `GET /auth/sso` for a resolved workspace. */
  publicInfo(workspaceId: string): Promise<SsoPublicInfo>;
  /** `POST /auth/sso/discover`: rate-limited per IP, answers after a fixed floor either way. */
  discover(input: {
    workspaceId: string;
    email: string;
    ip?: string | undefined;
  }): Promise<boolean>;
  /** `POST /auth/sso/begin`, on the workspace origin. */
  begin(input: SsoBeginInput): Promise<SsoBeginResult>;
  /** `GET /sso/oidc/{id}/callback` on the canonical host: always a redirect `Location`. */
  oidcCallback(connectionId: string, currentUrl: URL): Promise<string>;
  /** `POST /sso/saml/{id}/acs` on the canonical host: always a redirect `Location`. */
  samlAcs(
    connectionId: string,
    form: { readonly SAMLResponse?: string | undefined; readonly RelayState?: string | undefined },
  ): Promise<string>;
  /** `GET /sso/saml/{id}/metadata`: the SP metadata, or undefined for an unknown/deleted/OIDC id. */
  spMetadata(connectionId: string): Promise<string | undefined>;
  /** `GET /auth/sso/finish?h=` on the workspace origin. */
  finish(input: SsoFinishInput): Promise<SsoFinishResult>;
  /** The IdP-facing URLs of a connection (for the admin view and SP metadata). */
  spInfo(connectionId: string): SsoSpInfo;
}

export interface SsoPublicInfo {
  available: boolean;
  name: string | null;
  protocol: SsoProtocol | null;
  enforced: boolean;
}

export interface SsoBeginInput {
  readonly workspaceId: string;
  /**
   * The workspace's app base on its own origin — `workspaceUrl(BASE_URL, tenancy, ws,
   * BASE_PATH)` without a trailing slash. Finish, `/login` and `/admin/sso` hang off it.
   */
  readonly appBase: string;
  /** Already `safeReturnPath`-checked by the route. */
  readonly returnTo?: string | undefined;
  /** A test login by a member holding `sso.manage` (checked by the route). */
  readonly tester?: { readonly membershipId: string; readonly userId: string } | undefined;
  readonly loginHint?: string | undefined;
  /**
   * SSO re-authentication for step-up (FR4): the user id of the caller's session bound to THIS
   * workspace. Forces a fresh IdP login (OIDC `prompt=login` + `max_age=0`, SAML `ForceAuthn`),
   * requires the IdP's authentication time within five minutes, and refuses (`reauth_mismatch`)
   * unless the IdP names this same user. The route passes it only for such a session.
   */
  readonly reauthUserId?: string | undefined;
  readonly ip?: string | undefined;
}

export interface SsoBeginResult {
  readonly url: string;
  /** Goes into the `sso_req` binding cookie on the workspace origin. */
  readonly bindingToken: string;
  readonly bindingMaxAgeSeconds: number;
}

export interface SsoFinishInput {
  /** `?h=`: the handoff token. */
  readonly handoff: string;
  /** The `sso_req` binding cookie this browser sent. */
  readonly bindingToken: string | undefined;
  /** The workspace the finish request resolved to. */
  readonly workspaceId: string | undefined;
  /** Request facts for the session (ip, user agent, device, replaced session…). */
  readonly login: LoginContext;
}

export type SsoFinishResult =
  | {
      readonly kind: "session";
      readonly result: LoginResult;
      readonly returnTo: string | undefined;
    }
  | { readonly kind: "test"; readonly outcome: "ok" | SsoFlowErrorCode }
  | { readonly kind: "error"; readonly code: SsoFlowErrorCode };

/** What the login flow needs from `@fundroom/identity` (the container's `auth` + deps). */
export interface SsoIdentityWiring {
  readonly deps: IdentityDeps;
  /** The session service `completeLogin` mints with; also revokes a deleted connection's. */
  readonly sessions: SessionService;
  readonly memberships: Pick<MembershipService, "provisionStaff">;
}

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/**
 * What the container hands `createSsoService`. Minimal on purpose — Agent A extends it (and the
 * container block marked `E3.8 A owns`).
 */
export interface SsoServiceDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly crypto: Pick<EnvelopeService, "currentKey" | "keyById">;
  /** DoH resolver for domain verification (`container.dns`). */
  readonly dns: DnsResolverPort;
  /**
   * The dedicated guarded client (`container.ssoOutbound`): no redirects, 5 s, 1 MiB, private
   * hosts only through SSO_ALLOW_PRIVATE_HOSTS. OIDC discovery/JWKS and SAML metadata only.
   */
  readonly fetch: typeof fetch;
  /** Protocols offered to workspaces (`SSO_PROTOCOLS`). */
  readonly protocols: readonly SsoProtocol[];
  /**
   * `BASE_URL`, the install's canonical public URL (origin + path). The IdP-facing URLs are
   * `{BASE_URL without trailing slash}/sso/…` (E3.9: not `origin + BASE_PATH`).
   */
  readonly baseUrl: URL;
  readonly now?: (() => Date) | undefined;
  readonly log?: Log | undefined;
  /**
   * `BASE_PATH`. Accepted for compatibility and no longer used for URLs: since E3.9 the
   * IdP-facing URLs come from `baseUrl`'s path, which equals BASE_PATH unless a path-mount proxy
   * strips or replaces the prefix.
   */
  readonly basePath?: string | undefined;
  /**
   * `SSO_ALLOW_PRIVATE_HOSTS`: hosts whose issuer / IdP URL may be plain http (tests, a LAN IdP).
   * The guarded fetch applies the same list to address checks.
   */
  readonly insecureHosts?: readonly string[] | undefined;
  /** Identity wiring for the login flow (sessions, JIT, sealing). Absent: the flow refuses. */
  readonly identity?: SsoIdentityWiring | undefined;
  /** The tenant resolver's cache, invalidated after `sso_enforced` changes. */
  readonly resolver?: { invalidate(): void } | undefined;
  /**
   * Whether a membership holds `sso.manage` (the container passes the RBAC matrix's answer). Used
   * to re-check a test login's tester at finish. Default: an active staff owner.
   */
  readonly canManage?:
    | ((membership: {
        readonly kind: "staff" | "external";
        readonly role: string;
        readonly status: string;
        readonly expiresAt?: Date | null | undefined;
      }) => boolean)
    | undefined;
  /**
   * Test seams only (never set by the container): `afterCompleteLogin` runs in finish between
   * `completeLogin` and the identity-link transaction (the erasure-race window).
   */
  readonly hooks?:
    | {
        readonly afterCompleteLogin?: (facts: {
          readonly userId: string;
          readonly sessionId: string;
        }) => Promise<void>;
      }
    | undefined;
  /** Minimum duration of `discover` (default 150 ms). */
  readonly discoverFloorMs?: number | undefined;
}
