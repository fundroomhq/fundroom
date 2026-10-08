import {
  isPlacementError,
  localPlacementCell,
  releaseQuietly,
  withSlugClaim,
} from "@fundroom/control-plane";
import {
  createWorkspace,
  deleteWorkspace,
  findWorkspaceBySlug,
  listLiveWorkspaceIds,
  systemContext,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import type { Container } from "../container.js";
import { type DemoPeopleOptions, demoPeople } from "./factories.js";

/*
 * `fundroom seed-demo`: a realistic, fully synthetic workspace for demos, previews and
 * e2e. Kernel-only in Phase 0 (workspace, staff, investors across tiers, pending invites);
 * each module adds its own `seed-demo` hook as it lands (documents, updates, KPIs).
 * Refuses to touch a workspace it did not create unless `--reset` names the demo slug.
 */
export interface SeedDemoOptions extends DemoPeopleOptions {
  readonly slug?: string | undefined;
  readonly name?: string | undefined;
  /** Soft-delete an existing workspace with this slug first. */
  readonly reset?: boolean | undefined;
}

export interface SeedDemoResult {
  readonly workspaceId: string;
  readonly slug: string;
  readonly owner: string;
  readonly staff: number;
  readonly investorsActive: number;
  readonly investorsInvited: number;
}

export const DEMO_SLUG = "acme-demo";

export async function seedDemo(
  container: Container,
  options: SeedDemoOptions = {},
): Promise<SeedDemoResult> {
  const { db, auth, audit, config } = container;
  const slug = options.slug ?? DEMO_SLUG;
  const name = options.name ?? "Acme Demo";
  const people = demoPeople(options);

  // E3.11: this process's cell. Asked first (E-UP-13 fix round 2): a missing or draining own
  // cell refuses before `--reset` has deleted the old demo or released its slug.
  const cellId = await localPlacementCell(db, container.controlPlane.cellId);

  const existing = await findWorkspaceBySlug(db, slug);
  if (existing) {
    if (!options.reset) {
      throw new Error(`workspace "${slug}" already exists; pass --reset to replace it`);
    }
    // Both caches, via `deleteWorkspace` itself (E2.1 M9): the demo workspace may have held a
    // custom domain, and a cached hostname entry would keep routing to a workspace that is gone.
    await deleteWorkspace(db, existing.id, {
      lookup: container.customDomainLookup,
      workspaces: container.resolver,
    });
    // E3.11: `--reset` replaces the demo, so its directory entry goes too (the new one claims
    // the slug below); a soft delete alone keeps the slug for the restore window.
    await releaseQuietly(container.directory, existing.id, container.log);
  }
  if (config.raw.TENANCY_MODE === "single") {
    const others = await listLiveWorkspaceIds(db);
    if (others.length > 0) {
      throw new Error(
        "TENANCY_MODE=single already has a workspace; seed-demo would leave two (set TENANCY_MODE=multi for a demo next to a real workspace)",
      );
    }
  }

  // E3.11: the slug claimed in the cell directory first.
  let workspace: Awaited<ReturnType<typeof createWorkspace>>;
  try {
    workspace = await withSlugClaim(
      container.directory,
      { slug, cellId, log: container.log },
      (id) => createWorkspace(db, { id, slug, name, cellId }),
    );
  } catch (error) {
    if (isPlacementError(error) && error.reason === "slug_taken")
      throw new Error(`workspace "${slug}" is taken by a workspace of another cell`);
    throw error;
  }
  const ctx = systemContext(workspace.id);
  const owner = await provisionUser(identity(container), people.owner);
  const ownerMembership = await provisionMembership(identity(container), {
    workspaceId: workspace.id,
    userId: owner.userId,
    kind: "staff",
    role: "owner",
    source: "demo",
  });
  await db.withTenant(ctx, async (tx) => {
    await publish(tx, ctx, "workspace.created", { workspaceId: workspace.id, slug });
    await audit.record(tx, ctx, {
      action: "workspace.created",
      resourceKind: "workspace",
      resourceId: workspace.id,
      actorKind: "host",
      actorUserId: owner.userId,
      meta: { slug, source: "demo" },
    });
  });

  for (const s of people.staff) {
    const u = await provisionUser(identity(container), s);
    await provisionMembership(identity(container), {
      workspaceId: workspace.id,
      userId: u.userId,
      kind: "staff",
      role: s.role,
      source: "demo",
      actorMembershipId: ownerMembership.id,
      actorUserId: owner.userId,
    });
  }

  let active = 0;
  let invited = 0;
  for (const inv of people.investors) {
    if (inv.invited) {
      await auth.invites.create({
        workspaceId: workspace.id,
        workspaceName: name,
        email: inv.email,
        kind: "external",
        role: "investor",
        invitedBy: ownerMembership.id,
        inviterName: people.owner.displayName,
        message: `Welcome to the ${name} investor portal.`,
        send: false,
      });
      invited += 1;
      continue;
    }
    const u = await provisionUser(identity(container), inv);
    await provisionMembership(identity(container), {
      workspaceId: workspace.id,
      userId: u.userId,
      kind: "external",
      role: "investor",
      source: "demo",
      actorMembershipId: ownerMembership.id,
      actorUserId: owner.userId,
    });
    active += 1;
  }

  container.setupGate.invalidate();
  container.resolver.invalidate();
  container.log("demo.seeded", {
    workspaceId: workspace.id,
    slug,
    staff: people.staff.length + 1,
    investorsActive: active,
    investorsInvited: invited,
  });
  return {
    workspaceId: workspace.id,
    slug,
    owner: people.owner.email,
    staff: people.staff.length + 1,
    investorsActive: active,
    investorsInvited: invited,
  };
}

/** The identity wiring `provision*` needs, taken from the container. */
function identity(container: Container) {
  return container.identityDeps;
}
