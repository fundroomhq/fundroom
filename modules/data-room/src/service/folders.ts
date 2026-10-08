import { GrantRepo, PolicyRepo, rederiveRulePathsFor } from "@fundroom/authz";
import { pgErrorCode, systemContext, type TenantContext, type Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import type { AccessDecision } from "@fundroom/ports";
import { type Actor, DataRoomError } from "../errors.js";
import {
  childPath,
  type FolderTemplate,
  isAncestorOrSelf,
  joinIndex,
  numberSiblings,
  ROOT_LABEL,
  templateById,
} from "../model.js";
import { discardAiSuggestions } from "../qa/ai/discard.js";
import { createQaTargetIndexer } from "../qa/search.js";
import { DocumentRepo, FolderRepo } from "../repos/dataroom-repo.js";
import { QaLifecycleRepo } from "../repos/qa-lifecycle-repo.js";
import type { Document, Folder } from "../schema/dataroom.js";
import { type Access, createAccess, type Viewer } from "./access.js";
import { createSearchIndexer } from "./search.js";

/*
 * Folders (design/03 B1): one root per workspace, a tree under it with deterministic index
 * numbers, moves that rewrite the ltree paths of the subtree *and* of the grants that hang
 * on it (then `acl.changed` so effective_access follows), soft delete into the recycle bin
 * with everything below, restore, and the three templates.
 */
export interface TreeFolder {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly path: string;
  readonly index: string | null;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly decision: AccessDecision;
  /** Folder is listed only so a deeper visible item can be reached. */
  readonly passthrough: boolean;
}

export interface TreeDocument {
  readonly document: Document;
  readonly index: string;
  readonly decision: AccessDecision;
}

export interface Tree {
  readonly root: Folder;
  readonly folders: readonly TreeFolder[];
  readonly documents: readonly TreeDocument[];
}

export interface FolderService {
  ensureRoot(workspaceId: string): Promise<Folder>;
  /** The whole live tree as this viewer sees it (staff: everything; external: grants + gates). */
  tree(ctx: TenantContext, viewer: Viewer): Promise<Tree>;
  create(
    ctx: TenantContext,
    input: { parentId: string; name: string },
    actor: Actor,
  ): Promise<Folder>;
  update(
    ctx: TenantContext,
    id: string,
    input: {
      name?: string | undefined;
      parentId?: string | undefined;
      sortOrder?: number | undefined;
    },
    actor: Actor,
  ): Promise<Folder>;
  remove(ctx: TenantContext, id: string, actor: Actor, purgeAfterDays: number): Promise<number>;
  restore(ctx: TenantContext, id: string, actor: Actor): Promise<Folder>;
  applyTemplate(
    ctx: TenantContext,
    templateId: string,
    parentId: string | undefined,
    actor: Actor,
  ): Promise<{ template: FolderTemplate; created: number }>;
  listDeleted(ctx: TenantContext): Promise<Folder[]>;
}

/** Index numbers for every live folder and document, keyed by id. */
export function computeIndexes(
  root: Folder,
  folders: readonly Folder[],
  documents: readonly Document[],
): Map<string, string> {
  const byParent = new Map<string, Folder[]>();
  for (const f of folders) {
    if (f.parentId === null) continue;
    const list = byParent.get(f.parentId) ?? [];
    list.push(f);
    byParent.set(f.parentId, list);
  }
  const docsByFolder = new Map<string, Document[]>();
  for (const d of documents) {
    const list = docsByFolder.get(d.folderId) ?? [];
    list.push(d);
    docsByFolder.set(d.folderId, list);
  }
  const out = new Map<string, string>();
  const walk = (folderId: string, parentIndex: string | null) => {
    const children = byParent.get(folderId) ?? [];
    const docs = docsByFolder.get(folderId) ?? [];
    const numbers = numberSiblings(
      children.map((f) => ({ id: f.id, sortOrder: f.sortOrder, name: f.name })),
      docs.map((d) => ({ id: d.id, sortOrder: d.sortOrder, name: d.title })),
    );
    for (const f of children) {
      const index = joinIndex(parentIndex, numbers.get(f.id) ?? 0);
      out.set(f.id, index);
      walk(f.id, index);
    }
    for (const d of docs) out.set(d.id, joinIndex(parentIndex, numbers.get(d.id) ?? 0));
  };
  walk(root.id, null);
  return out;
}

export function createFolderService(services: ModuleServices): FolderService {
  const { db } = services;
  const now = () => services.now();
  const access: Access = createAccess(services);
  const indexer = createSearchIndexer(services);
  // Published Q&A on anything in a trashed / restored subtree (E3.3). A move needs nothing:
  // `indexer.moved` re-paths every data-room entry under the folder, `qa` ones included.
  const qaIndexer = createQaTargetIndexer(services);

  function audit(
    tx: Tx,
    ctx: TenantContext,
    actor: Actor,
    action: string,
    folderId: string,
    meta: Record<string, string | number | boolean | null | string[]> = {},
  ) {
    return services.audit.record(tx, ctx, {
      action,
      resourceKind: "folder",
      resourceId: folderId,
      actorMembershipId: actor.membershipId,
      requestId: actor.requestId,
      meta,
    });
  }

  async function liveFolder(ctx: TenantContext, tx: Tx, id: string): Promise<Folder> {
    const f = await new FolderRepo(ctx, tx).live(id);
    if (f === undefined) throw new DataRoomError("not_found", "no such folder");
    return f;
  }

  async function uniqueName(
    ctx: TenantContext,
    tx: Tx,
    parentId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const siblings = await new FolderRepo(ctx, tx).children(parentId);
    if (siblings.some((s) => s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase())) {
      throw new DataRoomError("conflict", "a folder with that name exists here", {
        conflict: "name",
      });
    }
  }

  async function createUnder(
    ctx: TenantContext,
    tx: Tx,
    parent: Folder,
    name: string,
    createdBy: string | null,
  ): Promise<Folder> {
    const repo = new FolderRepo(ctx, tx);
    const id = crypto.randomUUID();
    const siblings = await repo.children(parent.id);
    const sortOrder = siblings.reduce((m, s) => Math.max(m, s.sortOrder), 0) + 1;
    try {
      const created = await repo.create({
        id,
        parentId: parent.id,
        name,
        path: childPath(parent.path, id),
        sortOrder,
        createdBy,
      });
      await indexer.folders(tx, ctx, [created.id]);
      return created;
    } catch (error) {
      if (pgErrorCode(error) === "23505")
        throw new DataRoomError("conflict", "a folder with that name exists here", {
          conflict: "name",
        });
      throw error;
    }
  }

  return {
    async ensureRoot(workspaceId) {
      const ctx = systemContext(workspaceId);
      const existing = await db.withTenant(ctx, (tx) => new FolderRepo(ctx, tx).root());
      if (existing !== undefined) return existing;
      try {
        return await db.withTenant(ctx, (tx) =>
          new FolderRepo(ctx, tx).create({
            parentId: null,
            name: "Data room",
            path: ROOT_LABEL,
            sortOrder: 0,
            createdBy: null,
          }),
        );
      } catch (error) {
        if (pgErrorCode(error) !== "23505") throw error;
        const again = await db.withTenant(ctx, (tx) => new FolderRepo(ctx, tx).root());
        if (again === undefined) throw error;
        return again;
      }
    },

    async tree(ctx, viewer) {
      const root = await this.ensureRoot(ctx.workspaceId);
      // Read as system: the viewer's rights are decided per node below, and an external
      // member must still see the folders on the way to something they may open.
      const sys = systemContext(ctx.workspaceId);
      const { folders, documents } = await db.withTenant(sys, async (tx) => ({
        folders: await new FolderRepo(sys, tx).listLive(),
        documents: await new DocumentRepo(sys, tx).listLive(),
      }));
      const indexes = computeIndexes(root, folders, documents);
      // The staff-only veil (E3.5), read once for the whole tree; staff never need it.
      const veil = viewer.kind === "external" ? await access.veil(ctx) : undefined;
      const docDecisions = new Map<string, AccessDecision>();
      for (const d of documents)
        docDecisions.set(d.id, await access.document(ctx, viewer, d, "view", veil));
      const folderDecisions = new Map<string, AccessDecision>();
      for (const f of folders)
        folderDecisions.set(f.id, await access.folder(ctx, viewer, f, "view", veil));

      const visibleDocs = documents.filter((d) => {
        const dec = docDecisions.get(d.id);
        return dec !== undefined && access.listed(dec);
      });
      // A folder is shown when the viewer may see it, or when something visible lives below it.
      const reachable = new Set<string>();
      const byId = new Map(folders.map((f) => [f.id, f]));
      const markAncestors = (folderId: string) => {
        let cur = byId.get(folderId);
        while (cur !== undefined && !reachable.has(cur.id)) {
          reachable.add(cur.id);
          cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
        }
      };
      for (const d of visibleDocs) markAncestors(d.folderId);
      for (const f of folders) {
        const dec = folderDecisions.get(f.id);
        if (dec !== undefined && access.listed(dec)) markAncestors(f.id);
      }
      const treeFolders: TreeFolder[] = folders
        .filter((f) => f.parentId !== null && reachable.has(f.id))
        .map((f) => {
          const decision = folderDecisions.get(f.id) as AccessDecision;
          return {
            id: f.id,
            parentId: f.parentId,
            name: f.name,
            path: f.path,
            index: indexes.get(f.id) ?? null,
            sortOrder: f.sortOrder,
            createdAt: f.createdAt,
            updatedAt: f.updatedAt,
            decision,
            passthrough: !access.listed(decision),
          };
        });
      const treeDocuments: TreeDocument[] = visibleDocs.map((d) => ({
        document: d,
        index: indexes.get(d.id) ?? "",
        decision: docDecisions.get(d.id) as AccessDecision,
      }));
      return { root, folders: treeFolders, documents: treeDocuments };
    },

    create: (ctx, input, actor) =>
      db.withTenant(ctx, async (tx) => {
        const parent = await liveFolder(ctx, tx, input.parentId);
        await uniqueName(ctx, tx, parent.id, input.name);
        const f = await createUnder(ctx, tx, parent, input.name, actor.membershipId);
        await audit(tx, ctx, actor, "folder.created", f.id, { parentId: parent.id });
        return f;
      }),

    update: (ctx, id, input, actor) =>
      db.withTenant(ctx, async (tx) => {
        const repo = new FolderRepo(ctx, tx);
        const f = await liveFolder(ctx, tx, id);
        if (f.parentId === null) throw new DataRoomError("conflict", "the root folder is fixed");
        // Q&A lock order: question rows first (see QaLifecycleRepo.lockOnTargets). A move
        // re-paths every Q&A entry under the folder, a rename re-titles the folder's own.
        if (input.parentId !== undefined && input.parentId !== f.parentId)
          await new QaLifecycleRepo(ctx, tx).lockOnTargets({ underPath: f.path }, "share");
        else if (input.name !== undefined && input.name !== f.name)
          await new QaLifecycleRepo(ctx, tx).lockOnTargets({ folderIds: [id] }, "share");
        const patch: Partial<Pick<Folder, "name" | "parentId" | "path" | "sortOrder">> = {};
        const meta: Record<string, string | number | boolean | null> = {};
        if (input.name !== undefined && input.name !== f.name) {
          await uniqueName(ctx, tx, input.parentId ?? f.parentId, input.name, f.id);
          patch.name = input.name;
          meta["renamed"] = true;
        }
        if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
        let moved: { from: string; to: string } | undefined;
        // E3.5: whether the subtree is behind the staff-only veil before and after the move.
        let veil: { before: boolean; after: boolean } | undefined;
        if (input.parentId !== undefined && input.parentId !== f.parentId) {
          const target = await liveFolder(ctx, tx, input.parentId);
          if (isAncestorOrSelf(f.path, target.path)) {
            throw new DataRoomError("conflict", "a folder cannot move into itself");
          }
          veil = {
            before: await repo.underStaffOnly(f.path),
            after: f.staffOnly || (await repo.underStaffOnly(target.path)),
          };
          if (veil.before !== veil.after)
            meta[veil.after ? "enteredStaffOnly" : "leftStaffOnly"] = true;
          await uniqueName(ctx, tx, target.id, input.name ?? f.name, f.id);
          const newPath = childPath(target.path, f.id);
          moved = { from: f.path, to: newPath };
          patch.parentId = target.id;
          if (input.sortOrder === undefined) {
            // Appended after the new siblings unless the caller placed it.
            const siblings = await repo.children(target.id);
            patch.sortOrder = siblings.reduce((m, s) => Math.max(m, s.sortOrder), 0) + 1;
          }
          meta["movedTo"] = target.id;
        }
        let updated: Folder | undefined;
        try {
          updated = await repo.update(id, patch);
          if (moved !== undefined) {
            // The folder row first (its own path), then the subtree, documents and rules.
            await repo.rewritePaths(moved.from, moved.to);
            await new DocumentRepo(ctx, tx).rewritePaths(moved.from, moved.to);
            const grants = await new GrantRepo(ctx, tx).rewritePaths(moved.from, moved.to);
            const policies = await new PolicyRepo(ctx, tx).rewritePaths(moved.from, moved.to);
            await services.authz.bump(tx, ctx, "folder");
            meta["rulesRewritten"] = grants + policies;
            updated = await repo.byId(id);
          }
        } catch (error) {
          if (pgErrorCode(error) === "23505")
            throw new DataRoomError("conflict", "a folder with that name exists here", {
              conflict: "name",
            });
          throw error;
        }
        if (updated === undefined) throw new DataRoomError("not_found", "no such folder");
        // A move changes the ACL path of everything below: re-path the subtree's entries in
        // this transaction (never a window where an entry carries the old path) — in SQL, no
        // document text is re-read. A rename re-indexes the folder's own title.
        // The folder's own published Q&A is titled with its name: re-read on a rename, first
        // (it takes the workspace row before any search index lock — lock order).
        if (patch.name !== undefined) await qaIndexer.foldersBack(tx, ctx, [id]);
        // Into or out of a staff-only subtree (E3.5): every entry below changes ACL kind
        // (`staff` ↔ `resource`), which a re-path cannot express — re-read the subtree.
        const reveiled = moved !== undefined && veil !== undefined && veil.before !== veil.after;
        if (reveiled && moved !== undefined) await qaIndexer.subtreeBack(tx, ctx, moved.to);
        if (moved !== undefined) await indexer.moved(tx, ctx, moved.from, moved.to);
        if (reveiled && moved !== undefined) await indexer.subtree(tx, ctx, moved.to);
        if (patch.name !== undefined) await indexer.folders(tx, ctx, [id]);
        await audit(tx, ctx, actor, "folder.updated", id, meta);
        return updated;
      }),

    remove: (ctx, id, actor, purgeAfterDays) =>
      db.withTenant(ctx, async (tx) => {
        const f = await liveFolder(ctx, tx, id);
        if (f.parentId === null) throw new DataRoomError("conflict", "the root folder is fixed");
        // the subtree's Q&A entries leave below: its question rows first (lock order)
        const questionIds = await new QaLifecycleRepo(ctx, tx).lockOnTargets(
          { underPath: f.path },
          "share",
        );
        const docs = new DocumentRepo(ctx, tx);
        const held = (await docs.underPath(f.path)).filter((d) => d.legalHold);
        if (held.length > 0) {
          throw new DataRoomError("conflict", "a document in this folder is under legal hold", {
            conflict: "legal_hold",
            documentIds: held.map((d) => d.id),
          });
        }
        const t = now();
        const purgeAfter = new Date(t.getTime() + purgeAfterDays * 86_400_000);
        const values = { deletedAt: t, deletedBy: actor.membershipId, purgeAfter };
        const folderIds = await new FolderRepo(ctx, tx).markSubtree(f.path, values, "live");
        const docIds = await docs.markUnderPath(f.path, values, "live");
        await indexer.remove(tx, ctx, "folder", folderIds);
        await indexer.remove(tx, ctx, "document", docIds);
        await qaIndexer.subtreeGone(tx, ctx, f.path);
        await audit(tx, ctx, actor, "folder.deleted", id, {
          folders: folderIds.length,
          documents: docIds.length,
          purgeAfter: purgeAfter.toISOString(),
        });
        // E3.12: AI suggestions quoting its documents, or drafted for questions on anything in it
        await discardAiSuggestions(services, tx, ctx, { documentIds: docIds, questionIds });
        return folderIds.length + docIds.length;
      }),

    restore: (ctx, id, actor) =>
      db.withTenant(ctx, async (tx) => {
        const repo = new FolderRepo(ctx, tx);
        const f = await repo.byId(id);
        if (f === undefined || f.deletedAt === null)
          throw new DataRoomError("not_found", "no such deleted folder");
        // the subtree's Q&A entries come back below: its question rows first (lock order)
        await new QaLifecycleRepo(ctx, tx).lockOnTargets({ underPath: f.path }, "share");
        const values = { deletedAt: null, deletedBy: null, purgeAfter: null };
        const parent = f.parentId === null ? undefined : await repo.byId(f.parentId);
        let restored: Folder | undefined;
        if (parent === undefined || parent.deletedAt !== null) {
          // E3.5: a subtree veiled only by a trashed staff-only ancestor would come back under
          // the root unveiled — that is not a restore, it is an exposure. Restore the ancestor.
          if (!f.staffOnly && (await repo.underStaffOnly(f.path)))
            throw new DataRoomError("conflict", "restore the staff-only folder above it first", {
              conflict: "staff_only_parent",
            });
          // The parent is gone too: the subtree comes back under the root.
          const root = await repo.root();
          if (root === undefined) throw new Error("workspace has no root folder");
          const newPath = childPath(root.path, f.id);
          await repo.update(id, { parentId: root.id });
          await repo.rewritePaths(f.path, newPath);
          await new DocumentRepo(ctx, tx).rewritePaths(f.path, newPath);
          await new GrantRepo(ctx, tx).rewritePaths(f.path, newPath);
          await new PolicyRepo(ctx, tx).rewritePaths(f.path, newPath);
          await services.authz.bump(tx, ctx, "folder");
          restored = await repo.byId(id);
        }
        const path = restored?.path ?? f.path;
        let restoredIds: string[];
        try {
          restoredIds = await repo.markSubtree(path, values, "deleted");
        } catch (error) {
          if (pgErrorCode(error) === "23505")
            throw new DataRoomError("conflict", "a folder with that name exists here", {
              conflict: "name",
            });
          throw error;
        }
        await new DocumentRepo(ctx, tx).markUnderPath(path, values, "deleted");
        // Every restored folder's rules carry the path it has now (E3.2 L-2). `rewritePaths`
        // above only moves paths it finds under the old prefix; a rule whose path was lost while
        // the folder was in the trash (an import of an older build nulled it) would otherwise
        // come back matching the folder node alone and nothing below it.
        if ((await rederiveRulePathsFor(tx, ctx, "folder", restoredIds)) > 0)
          await services.authz.bump(tx, ctx, "folder");
        // The soft delete removed the subtree's entries, so they are re-read (text included, a
        // bounded page of documents at a time) at the path the subtree now has.
        await qaIndexer.subtreeBack(tx, ctx, path); // before the index lock (lock order)
        await indexer.subtree(tx, ctx, path);
        await audit(tx, ctx, actor, "folder.restored", id, {});
        const out = await repo.byId(id);
        if (out === undefined) throw new DataRoomError("not_found", "no such folder");
        return out;
      }),

    applyTemplate: (ctx, templateId, parentId, actor) =>
      db.withTenant(ctx, async (tx) => {
        const template = templateById(templateId);
        if (template === undefined) throw new DataRoomError("not_found", "no such template");
        const repo = new FolderRepo(ctx, tx);
        const parent =
          parentId === undefined ? await repo.root() : await liveFolder(ctx, tx, parentId);
        if (parent === undefined) throw new Error("workspace has no root folder");
        let created = 0;
        const apply = async (into: Folder, items: FolderTemplate["folders"]) => {
          for (const item of items) {
            const siblings = await repo.children(into.id);
            let f = siblings.find((s) => s.name.toLowerCase() === item.name.toLowerCase());
            if (f === undefined) {
              f = await createUnder(ctx, tx, into, item.name, actor.membershipId);
              created += 1;
            }
            if (item.children) await apply(f, item.children);
          }
        };
        await apply(parent, template.folders);
        await audit(tx, ctx, actor, "folder.template_applied", parent.id, {
          template: template.id,
          created,
        });
        return { template, created };
      }),

    listDeleted: (ctx) => db.withTenant(ctx, (tx) => new FolderRepo(ctx, tx).listDeleted()),
  };
}
