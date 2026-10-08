/**
 * Who a transaction runs as. Set transaction-locally by withTenant()/withHost() and read
 * by the RLS policies through core.current_workspace() etc. (EXECUTION_PLAN §6.4, §7).
 *
 *  - staff     a workspace member with kind=staff (owner/admin/editor/…)
 *  - external  investor / delegate; zero role-level rights, grants only
 *  - system    a background job acting for one explicit workspace
 *  - host      no workspace: tenant resolution, setup wizard, the outbox relay.
 *              Sees global tables (core.workspace) and outbox rows; tenant tables return
 *              zero rows because app.workspace_id is unset.
 */
export const ACTOR_KINDS = ["staff", "external", "system", "host"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
export type TenantActorKind = Exclude<ActorKind, "host">;
export const TENANT_ACTOR_KINDS: readonly TenantActorKind[] = ["staff", "external", "system"];

export interface TenantContext {
  readonly workspaceId: string;
  readonly actorKind: TenantActorKind;
  /** The acting membership; absent for `system`. */
  readonly membershipId?: string;
  /** The acting global user; absent for `system`. */
  readonly userId?: string;
  /**
   * "View as investor" (E2.7): the context is an external member's, but the person behind the
   * request is this staff member. `withTenant` runs such a transaction `READ ONLY` (the DB
   * backstop), the audit recorder refuses to write under it, and services skip the side effects
   * an investor's own visit would have (engagement, exposure stamps, view audits).
   */
  readonly viewAs?: ViewAsActor;
}

export interface ViewAsActor {
  readonly staffMembershipId: string;
  readonly staffUserId: string;
}

/** True when this context is a staff member viewing the portal as an investor. */
export function isViewingAs(
  ctx: { readonly viewAs?: ViewAsActor | undefined } | undefined,
): boolean {
  return ctx?.viewAs !== undefined;
}

export interface HostContext {
  readonly actorKind: "host";
  /**
   * Optional acting user. Lets the host context read that user's own rows in tables whose
   * fence admits it (currently core.membership, for the workspace switcher). Never grants
   * tenant rows.
   */
  readonly userId?: string;
}

export const HOST_CONTEXT: HostContext = Object.freeze({ actorKind: "host" });

export function assertHostContext(ctx: HostContext): void {
  if (ctx.actorKind !== "host") throw new TenantContextError("actorKind must be host");
  if (ctx.userId !== undefined && !UUID_RE.test(ctx.userId)) {
    throw new TenantContextError("userId must be a UUID");
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class TenantContextError extends Error {
  override readonly name = "TenantContextError";
}

/** Rejects anything that could not have come from our own tables. Cheap and loud. */
export function assertTenantContext(ctx: TenantContext): void {
  if (!UUID_RE.test(ctx.workspaceId)) {
    throw new TenantContextError("workspaceId must be a UUID");
  }
  if (!(TENANT_ACTOR_KINDS as readonly string[]).includes(ctx.actorKind)) {
    throw new TenantContextError("actorKind must be one of staff|external|system");
  }
  if (ctx.membershipId !== undefined && !UUID_RE.test(ctx.membershipId)) {
    throw new TenantContextError("membershipId must be a UUID");
  }
  if (ctx.userId !== undefined && !UUID_RE.test(ctx.userId)) {
    throw new TenantContextError("userId must be a UUID");
  }
  if (ctx.actorKind !== "system" && ctx.membershipId === undefined) {
    throw new TenantContextError(`${ctx.actorKind} context requires a membershipId`);
  }
  if (ctx.viewAs !== undefined) {
    if (ctx.actorKind !== "external") {
      throw new TenantContextError("viewAs requires an external context");
    }
    if (!UUID_RE.test(ctx.viewAs.staffMembershipId) || !UUID_RE.test(ctx.viewAs.staffUserId)) {
      throw new TenantContextError("viewAs ids must be UUIDs");
    }
  }
}

/** Builds a `system` context for a job acting on one workspace. */
export function systemContext(workspaceId: string): TenantContext {
  return { workspaceId, actorKind: "system" };
}

/**
 * Reserved workspace id for host-level (platform) records that must be fenced like tenant
 * rows but belong to no tenant: platform audit events, operator actions. Not a row in
 * core.workspace; nothing with an FK to workspace may use it. Shaped as a valid v7 UUID so
 * it passes the context checks.
 */
export const PLATFORM_WORKSPACE_ID = "00000000-0000-7000-8000-000000000000";

/** A `system` context for the platform pseudo-workspace (see PLATFORM_WORKSPACE_ID). */
export function platformContext(): TenantContext {
  return { workspaceId: PLATFORM_WORKSPACE_ID, actorKind: "system" };
}

export function isPlatformWorkspace(workspaceId: string): boolean {
  return workspaceId === PLATFORM_WORKSPACE_ID;
}
