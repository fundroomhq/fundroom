import { systemContext, type TenantContext } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import type { AccessDecision, Capability, RequestFacts } from "@fundroom/ports";
import { isAncestorOrSelf } from "../model.js";
import { FolderRepo } from "../repos/dataroom-repo.js";
import type { Document, Folder } from "../schema/dataroom.js";

/*
 * Who may see what. Every decision goes through `AuthzPort.check()` (ADR-0032): staff get
 * capabilities from the RBAC matrix through the module's `resourceKinds`, external members
 * from grants on the document, or on a folder above it (document rows carry the folder's
 * path, ADR-0034). Gated access (NDA pending, E2.3) is reported, not silently hidden.
 */
export interface Viewer {
  readonly membershipId: string;
  readonly kind: "staff" | "external";
  readonly facts: RequestFacts;
}

export interface Decided<T> {
  readonly item: T;
  readonly decision: AccessDecision;
}

export function folderRef(f: Pick<Folder, "id" | "path">) {
  return { kind: "folder", id: f.id, path: f.path } as const;
}

export function documentRef(d: Pick<Document, "id" | "folderPath">) {
  return { kind: "document", id: d.id, path: d.folderPath } as const;
}

/**
 * The staff-only veil (E3.5, ADR-0053): the paths of the workspace's staff-only folders. Anything
 * at or below one is invisible to an external viewer whatever grant they hold. Decided here, before
 * `AuthzPort.check()`, from the folder rows themselves — so it holds from the instant the folder
 * row commits, without waiting for the effective-access rebuild (which applies the same veil to
 * the materialised rows `core.has_access()` reads).
 */
export interface Veil {
  covers(path: string): boolean;
}

export function veilOf(staffOnlyPaths: readonly string[]): Veil {
  return { covers: (path) => staffOnlyPaths.some((s) => isAncestorOrSelf(s, path)) };
}

/** What an external viewer gets for a veiled node: the same answer as no grant at all (404). */
export const VEILED: AccessDecision = Object.freeze({
  allowed: false,
  capabilities: [],
  pendingGates: [],
  reason: "no_grant",
});

/** The workspace's veil, read as system (trashed staff-only folders included). */
export function loadVeil(services: Pick<ModuleServices, "db">, workspaceId: string): Promise<Veil> {
  const sys = systemContext(workspaceId);
  return services.db.withTenant(sys, async (tx) =>
    veilOf(await new FolderRepo(sys, tx).staffOnlyPaths()),
  );
}

export function createAccess(services: ModuleServices) {
  const { authz } = services;

  function principal(ctx: TenantContext, viewer: Viewer) {
    return { workspaceId: ctx.workspaceId, membershipId: viewer.membershipId };
  }

  /** External viewers only: staff (and staff API keys) are never veiled. */
  async function veiled(
    ctx: TenantContext,
    viewer: Viewer,
    path: string,
    veil: Veil | undefined,
  ): Promise<boolean> {
    if (viewer.kind !== "external") return false;
    return (veil ?? (await loadVeil(services, ctx.workspaceId))).covers(path);
  }

  return {
    /** Load once per request when deciding many nodes (the tree); omit it for a single check. */
    veil: (ctx: TenantContext): Promise<Veil> => loadVeil(services, ctx.workspaceId),
    async document(
      ctx: TenantContext,
      viewer: Viewer,
      d: Pick<Document, "id" | "folderPath">,
      capability: Capability = "view",
      veil?: Veil,
    ): Promise<AccessDecision> {
      if (await veiled(ctx, viewer, d.folderPath, veil)) return VEILED;
      return authz.check(principal(ctx, viewer), documentRef(d), capability, viewer.facts);
    },
    async folder(
      ctx: TenantContext,
      viewer: Viewer,
      f: Pick<Folder, "id" | "path">,
      capability: Capability = "view",
      veil?: Veil,
    ): Promise<AccessDecision> {
      if (await veiled(ctx, viewer, f.path, veil)) return VEILED;
      return authz.check(principal(ctx, viewer), folderRef(f), capability, viewer.facts);
    },
    /** Listed = allowed or gated (the viewer learns the item exists and what stands in the way). */
    listed(decision: AccessDecision): boolean {
      return decision.allowed || decision.reason === "gated";
    },
  };
}

export type Access = ReturnType<typeof createAccess>;
