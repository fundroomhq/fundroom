import { bumpAcl, GrantRepo } from "@fundroom/authz";
import type { Group, TenantContext, Tx } from "@fundroom/db";
import { lockWorkspaceFacts, pgErrorCode, updateWorkspaceSettings } from "@fundroom/db";
import { AuthError } from "../errors.js";
import {
  GroupRepo,
  type GroupWithCount,
  MembershipRepo,
  type PersonRow,
} from "../repos/membership-repo.js";
import type { IdentityDeps } from "./types.js";

/*
 * Audiences (design/05 §4.3): workspace-scoped groups that grants and policies target.
 * Deleting a group revokes its member rows *and* its grants (a group that no longer exists
 * cannot keep granting), then bumps `acl_version`.
 */
export interface GroupService {
  list(ctx: TenantContext): Promise<GroupWithCount[]>;
  get(
    ctx: TenantContext,
    id: string,
  ): Promise<(GroupWithCount & { members: PersonRow[] }) | undefined>;
  create(
    ctx: TenantContext,
    input: { name: string; kind?: string | undefined },
    actorMembershipId: string,
  ): Promise<Group>;
  update(
    ctx: TenantContext,
    id: string,
    input: { name?: string | undefined; kind?: string | undefined },
  ): Promise<Group>;
  delete(
    ctx: TenantContext,
    id: string,
    actorMembershipId: string,
  ): Promise<{ members: number; grants: number }>;
  addMembers(
    ctx: TenantContext,
    id: string,
    membershipIds: readonly string[],
    actorMembershipId: string,
  ): Promise<number>;
  removeMember(ctx: TenantContext, id: string, membershipId: string): Promise<boolean>;
}

export const GROUP_KINDS = ["custom", "round", "board", "advisors"] as const;

/**
 * A deleted group stops being one of the access-request form's default groups (E3.1 C1), in the
 * deleting transaction — otherwise every later PATCH /access/settings would be refused for a
 * group nobody can see any more, and auto-approvals would silently drop it. Edits the stored
 * jsonb in place (`updateWorkspaceSettings` replaces the whole document, so everything else is
 * carried over untouched). The caller invalidates the workspace resolver after commit.
 */
async function dropDefaultRequestGroup(
  tx: Tx,
  workspaceId: string,
  groupId: string,
): Promise<boolean> {
  const facts = await lockWorkspaceFacts(tx, workspaceId);
  const settings = isRecord(facts?.settings) ? facts.settings : undefined;
  const access = isRecord(settings?.["access"]) ? settings["access"] : undefined;
  const requests = isRecord(access?.["requests"]) ? access["requests"] : undefined;
  const ids = requests?.["defaultGroupIds"];
  if (settings === undefined || access === undefined || requests === undefined) return false;
  if (!Array.isArray(ids) || !ids.includes(groupId)) return false;
  await updateWorkspaceSettings(tx, workspaceId, {
    ...settings,
    access: {
      ...access,
      requests: { ...requests, defaultGroupIds: ids.filter((g: unknown) => g !== groupId) },
    },
  });
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createGroupService(deps: IdentityDeps): GroupService {
  return {
    list: (ctx) => deps.db.withTenant(ctx, (tx) => new GroupRepo(ctx, tx).listWithCounts()),

    get: (ctx, id) =>
      deps.db.withTenant(ctx, async (tx) => {
        const groups = new GroupRepo(ctx, tx);
        const g = (await groups.listWithCounts()).find((x) => x.id === id);
        if (g === undefined) return undefined;
        const page = await new MembershipRepo(ctx, tx).listPeople({ groupId: id, limit: 500 });
        return { ...g, members: page.items };
      }),

    async create(ctx, input, actorMembershipId) {
      return deps.db.withTenant(ctx, async (tx) => {
        const groups = new GroupRepo(ctx, tx);
        if ((await groups.byName(input.name)) !== undefined)
          throw new AuthError("invalid_request", "a group with that name already exists", {
            conflict: "name",
          });
        let g: Group;
        try {
          g = await groups.create(input);
        } catch (error) {
          if (pgErrorCode(error) === "23505")
            throw new AuthError("invalid_request", "a group with that name already exists", {
              conflict: "name",
            });
          throw error;
        }
        await deps.audit.record(tx, ctx, {
          action: "group.created",
          resourceKind: "group",
          resourceId: g.id,
          actorMembershipId,
          meta: { kind: g.kind },
        });
        return g;
      });
    },

    async update(ctx, id, input) {
      return deps.db.withTenant(ctx, async (tx) => {
        const groups = new GroupRepo(ctx, tx);
        if (input.name !== undefined) {
          const clash = await groups.byName(input.name);
          if (clash !== undefined && clash.id !== id)
            throw new AuthError("invalid_request", "a group with that name already exists", {
              conflict: "name",
            });
        }
        let g: Group | undefined;
        try {
          g = await groups.update(id, input);
        } catch (error) {
          if (pgErrorCode(error) === "23505")
            throw new AuthError("invalid_request", "a group with that name already exists", {
              conflict: "name",
            });
          throw error;
        }
        if (g === undefined) throw new AuthError("not_found", "no such group");
        await deps.audit.record(tx, ctx, {
          action: "group.updated",
          resourceKind: "group",
          resourceId: id,
          meta: { fields: Object.keys(input) },
        });
        return g;
      });
    },

    async delete(ctx, id, actorMembershipId) {
      return deps.db.withTenant(ctx, async (tx) => {
        const groups = new GroupRepo(ctx, tx);
        const g = await groups.byId(id);
        if (g === undefined) throw new AuthError("not_found", "no such group");
        const members = await groups.softDelete(id);
        const grants = await new GrantRepo(ctx, tx).revokeForGroup(id, actorMembershipId);
        const unsuggested = await dropDefaultRequestGroup(tx, ctx.workspaceId, id);
        await deps.audit.record(tx, ctx, {
          action: "group.deleted",
          resourceKind: "group",
          resourceId: id,
          meta: { members, grants, ...(unsuggested ? { accessRequestDefault: true } : {}) },
        });
        await bumpAcl(tx, ctx, "group");
        return { members, grants };
      });
    },

    async addMembers(ctx, id, membershipIds, actorMembershipId) {
      return deps.db.withTenant(ctx, async (tx) => {
        const groups = new GroupRepo(ctx, tx);
        if ((await groups.byId(id)) === undefined)
          throw new AuthError("not_found", "no such group");
        const memberships = new MembershipRepo(ctx, tx);
        const rows = await memberships.byIds(membershipIds);
        const live = new Set(rows.filter((m) => m.status !== "revoked").map((m) => m.id));
        for (const mid of membershipIds) {
          if (!live.has(mid))
            throw new AuthError("not_found", "no such member", { membershipId: mid });
        }
        const current = new Set((await groups.membersOf(id)).map((gm) => gm.membershipId));
        let added = 0;
        for (const mid of new Set(membershipIds)) {
          if (current.has(mid)) continue;
          await groups.addMember(id, mid, actorMembershipId);
          await deps.audit.record(tx, ctx, {
            action: "group.member_added",
            resourceKind: "group",
            resourceId: id,
            subjectMembershipId: mid,
          });
          added += 1;
        }
        if (added > 0) await bumpAcl(tx, ctx, "group");
        return added;
      });
    },

    async removeMember(ctx, id, membershipId) {
      return deps.db.withTenant(ctx, async (tx) => {
        const groups = new GroupRepo(ctx, tx);
        if ((await groups.byId(id)) === undefined)
          throw new AuthError("not_found", "no such group");
        const ok = await groups.removeMember(id, membershipId);
        if (ok) {
          await deps.audit.record(tx, ctx, {
            action: "group.member_removed",
            resourceKind: "group",
            resourceId: id,
            subjectMembershipId: membershipId,
          });
          await bumpAcl(tx, ctx, "group");
        }
        return ok;
      });
    },
  };
}
