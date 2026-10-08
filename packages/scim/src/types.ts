import type { AuditRecorder } from "@fundroom/audit";
import type { Database, TenantContext, Tx } from "@fundroom/db";
import type { SsoService } from "@fundroom/sso";
import type { FilterNode } from "./protocol/filter.js";
import type { JsonRecord } from "./protocol/resources.js";

/*
 * `@fundroom/scim` contract types (E3.8, ADR-0056). Frozen by the epic contract; the foundation
 * landed them verbatim with stub implementations — the service itself is Agent C's.
 */

export type MappableRole = "admin" | "editor" | "viewer" | "finance" | "legal";

/** The tenant context admin operations run in (the same `TenantContext` accreditation uses). */
export type ScimCtx = TenantContext;

/** Who asked (an admin), for the audit row — the shape `SsoActor` has. */
export interface ScimActor {
  readonly membershipId: string | null;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly apiKeyId?: string | undefined;
}

export interface ScimTokenView {
  id: string;
  name: string;
  displayPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ScimAdminView {
  /** `SCIM_ENABLED`. */
  enabled: boolean;
  /** `{BASE_URL}/scim/v2`. */
  baseUrl: string;
  tokens: ScimTokenView[];
  counts: { users: number; activeUsers: number; groups: number };
}

export interface ScimUserRow {
  id: string;
  userName: string;
  displayName: string | null;
  active: boolean;
  membershipId: string | null;
  role: string | null;
  groups: string[];
  updatedAt: string;
}

export interface ScimGroupRow {
  id: string;
  displayName: string;
  role: MappableRole | null;
  memberCount: number;
  updatedAt: string;
}

/**
 * Plan entitlements (A-3, ADR-0063): the server's `scim` feature check for a token mint.
 * `assertMayStart` is called, with the workspace locked and before anything is written, only when
 * the workspace has no live token — the mint would start SCIM provisioning. A token minted while
 * one is live is rotation (at most two live, `scim_token_limit`) and is never refused for the plan.
 */
export interface ScimTokenOptions {
  readonly assertMayStart?: (() => void) | undefined;
}

export interface ScimService {
  adminView(ctx: ScimCtx): Promise<ScimAdminView>;
  /** `scim_token_limit` at two live tokens. */
  createToken(
    ctx: ScimCtx,
    input: { name: string },
    actor: ScimActor,
    options?: ScimTokenOptions,
  ): Promise<{ token: string; view: ScimTokenView }>;
  revokeToken(ctx: ScimCtx, id: string, actor: ScimActor): Promise<void>;
  listUsers(
    ctx: ScimCtx,
    q: { cursor?: string; limit?: number },
  ): Promise<{ items: ScimUserRow[]; nextCursor: string | null }>;
  listGroups(ctx: ScimCtx): Promise<ScimGroupRow[]>;
  /** Recomputes the members' roles. */
  setGroupRole(
    ctx: ScimCtx,
    groupId: string,
    role: MappableRole | null,
    actor: ScimActor,
  ): Promise<ScimGroupRow>;
  /** Protocol entry for Agent C's own routes. */
  authenticate(bearer: string): Promise<{ workspaceId: string; tokenId: string } | null>;
  /** The `/scim/v2` Users/Groups operations (`routes/scim.ts`). Throw `ScimError`. */
  readonly protocol: ScimProtocol;
}

/** Who a `/scim/v2` request is: the token's workspace and id (never the host). */
export interface ScimPrincipal {
  readonly workspaceId: string;
  readonly tokenId: string;
}

export interface ScimListQuery {
  readonly filter?: FilterNode | undefined;
  /** 1-based. */
  readonly startIndex: number;
  readonly count: number;
}

export interface ScimGroupReadOptions {
  /** False skips loading `members` (`excludedAttributes=members`). Default true. */
  readonly members?: boolean | undefined;
}

/**
 * The SCIM protocol surface. Every method takes the authenticated principal and returns the
 * resource (or ListResponse) JSON before attribute projection; errors are `ScimError`.
 */
export interface ScimProtocol {
  /** `{BASE_URL}/scim/v2` (no trailing slash): the base of every `meta.location`. */
  readonly baseUrl: string;
  listUsers(p: ScimPrincipal, q: ScimListQuery): Promise<JsonRecord>;
  getUser(p: ScimPrincipal, id: string): Promise<JsonRecord>;
  createUser(p: ScimPrincipal, body: unknown): Promise<JsonRecord>;
  replaceUser(p: ScimPrincipal, id: string, body: unknown): Promise<JsonRecord>;
  patchUser(p: ScimPrincipal, id: string, body: unknown): Promise<JsonRecord>;
  deleteUser(p: ScimPrincipal, id: string): Promise<void>;
  listGroups(p: ScimPrincipal, q: ScimListQuery, o?: ScimGroupReadOptions): Promise<JsonRecord>;
  getGroup(p: ScimPrincipal, id: string, o?: ScimGroupReadOptions): Promise<JsonRecord>;
  createGroup(p: ScimPrincipal, body: unknown): Promise<JsonRecord>;
  replaceGroup(p: ScimPrincipal, id: string, body: unknown): Promise<JsonRecord>;
  /** Answers nothing (the route sends 204). */
  patchGroup(p: ScimPrincipal, id: string, body: unknown): Promise<void>;
  deleteGroup(p: ScimPrincipal, id: string): Promise<void>;
}

/** `@fundroom/identity`'s `SystemActor` (structural). */
export interface ScimSystemActor {
  readonly kind: "system";
  readonly label: string;
}

/**
 * The slice of `@fundroom/identity`'s `MembershipService` SCIM drives (structural, so this
 * package does not depend on identity). `provisionStaff` opens its own transactions — never call
 * it inside one; the others run on the caller's tenant transaction via `{ tx }`.
 */
export interface ScimMembershipPort {
  provisionStaff(
    ctx: TenantContext,
    input: {
      readonly email: string;
      readonly displayName?: string | undefined;
      readonly role: MappableRole;
      readonly source: "scim";
      readonly status?: "active" | "suspended" | undefined;
    },
    actor: ScimSystemActor,
  ): Promise<{ userId: string; membershipId: string; created: boolean; adopted: boolean }>;
  suspend(
    ctx: TenantContext,
    input: { readonly membershipId: string; readonly reason: string },
    actor: ScimSystemActor,
    options: { readonly tx: Tx },
  ): Promise<{ readonly changed: boolean; readonly sessionsRevoked: number }>;
  unsuspend(
    ctx: TenantContext,
    input: { readonly membershipId: string },
    actor: ScimSystemActor,
    options: { readonly tx: Tx },
  ): Promise<{ readonly changed: boolean }>;
  update(
    ctx: TenantContext,
    membershipId: string,
    input: { readonly role: MappableRole },
    actor: ScimSystemActor,
    options: { readonly tx: Tx },
  ): Promise<unknown>;
  revoke(
    ctx: TenantContext,
    input: { readonly membershipId: string; readonly reason: string },
    actor: ScimSystemActor,
    options: { readonly tx: Tx },
  ): Promise<unknown>;
}

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/**
 * What the container hands `createScimService`. Minimal on purpose — Agent C extends it (and the
 * container block marked `E3.8 C owns`).
 */
export interface ScimServiceDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  /** `verifiedDomains` / `defaultStaffRole` (tx-scoped). */
  readonly sso: Pick<SsoService, "verifiedDomains" | "defaultStaffRole">;
  /** `auth.memberships` (E3.8 B's provisioning API). */
  readonly memberships: ScimMembershipPort;
  /** `SCIM_ENABLED`. */
  readonly enabled: boolean;
  /** The install's canonical origin + BASE_PATH (`BASE_URL`); SCIM lives at `{BASE_URL}/scim/v2`. */
  readonly baseUrl: URL;
  readonly now?: (() => Date) | undefined;
  readonly log?: Log | undefined;
  /** `last_used_at` is written at most this often per token. Default 60 s. */
  readonly lastUsedThrottleMs?: number | undefined;
}
