import { pgErrorCode, systemContext, type TenantContext, type Tx } from "@fundroom/db";
import type { DataRoomSettings } from "@fundroom/domain";
import type { ModuleServices } from "@fundroom/module-kit";
import type { AccessDecision } from "@fundroom/ports";
import { type Actor, DataRoomError } from "../errors.js";
import {
  isPreviewable,
  PROTECTION_SCHEMA_VERSION,
  type Protection,
  parseProtection,
} from "../model.js";
import { discardAiSuggestions } from "../qa/ai/discard.js";
import { createQaTargetIndexer } from "../qa/search.js";
import {
  BlobRepo,
  DocumentRepo,
  FolderRepo,
  RenditionRepo,
  VersionRepo,
} from "../repos/dataroom-repo.js";
import { QaLifecycleRepo } from "../repos/qa-lifecycle-repo.js";
import type { Blob, Document, DocumentVersion, Folder } from "../schema/dataroom.js";
import { type Access, createAccess, type Viewer } from "./access.js";
import { computeIndexes } from "./folders.js";
import { createSearchIndexer } from "./search.js";

/*
 * Documents: the titled node, its immutable versions, protection, legal hold, the recycle
 * bin. What a viewer may do with the bytes (`viewable`, `download`) is decided here once and
 * reused by the delivery routes.
 */
export type DownloadVariant = "original" | "watermarked";

export interface Availability {
  /** The current version can be opened in the viewer. */
  readonly viewable: boolean;
  /** How this viewer may download, or null. */
  readonly download: DownloadVariant | null;
  /** Why it is not viewable / downloadable: scan state or type. */
  readonly reason:
    | "ready"
    | "processing"
    | "unscanned"
    | "infected"
    | "failed"
    | "unsupported"
    | "no_version";
}

export interface DocumentDetail {
  readonly document: Document;
  readonly folder: Pick<Folder, "id" | "name" | "path">;
  readonly index: string;
  readonly protection: Protection;
  readonly currentVersion: DocumentVersion | null;
  readonly blob: Pick<Blob, "scanStatus" | "scanEngine" | "scanDetail" | "scannedAt"> | null;
  readonly versions: readonly DocumentVersion[];
  readonly decision: AccessDecision;
  readonly availability: Availability;
}

export interface DocumentService {
  get(
    ctx: TenantContext,
    id: string,
    viewer: Viewer,
    settings: DataRoomSettings,
  ): Promise<DocumentDetail>;
  /** System read for jobs and hydrators: no viewer, no decision. */
  load(
    ctx: TenantContext,
    id: string,
  ): Promise<
    { document: Document; version: DocumentVersion | null; blob: Blob | null } | undefined
  >;
  update(
    ctx: TenantContext,
    id: string,
    input: {
      title?: string | undefined;
      folderId?: string | undefined;
      sortOrder?: number | undefined;
      protection?: { [K in keyof Protection]?: Protection[K] | undefined } | undefined;
    },
    actor: Actor,
  ): Promise<Document>;
  setLegalHold(
    ctx: TenantContext,
    id: string,
    input: { hold: boolean; reason?: string | undefined },
    actor: Actor,
  ): Promise<Document>;
  remove(ctx: TenantContext, id: string, actor: Actor, purgeAfterDays: number): Promise<Document>;
  restore(ctx: TenantContext, id: string, actor: Actor): Promise<Document>;
  listDeleted(ctx: TenantContext): Promise<Document[]>;
  /** Hard delete now (recycle bin "delete forever"); legal hold refuses. */
  purge(ctx: TenantContext, id: string, actor: Actor): Promise<void>;
  availabilityFor(
    decision: AccessDecision,
    protection: Protection,
    version: DocumentVersion | null,
    blob: Pick<Blob, "scanStatus"> | null,
    settings: DataRoomSettings,
  ): Availability;
}

export function blobServable(blob: Pick<Blob, "scanStatus">, settings: DataRoomSettings): boolean {
  return blob.scanStatus === "clean" || (blob.scanStatus === "skipped" && settings.allowUnscanned);
}

/**
 * The protection a request is served under (E3.13 §1.6): the document's own, then what a share
 * link forces on its visitors. A link may only force the visible watermark ON (never off, and
 * never the forensic mark), so the read is skipped when the document already watermarks. Reads
 * in its own short transaction: call it while holding none.
 */
export async function effectiveProtection(
  services: Pick<ModuleServices, "shareLinks">,
  workspaceId: string,
  membershipId: string,
  protection: Protection,
): Promise<Protection> {
  if (protection.watermark) return protection;
  const forced = await services.shareLinks.forcedProtection(workspaceId, membershipId);
  return forced.forceWatermark ? { ...protection, watermark: true } : protection;
}

export function createDocumentService(services: ModuleServices): DocumentService {
  const { db } = services;
  const now = () => services.now();
  const access: Access = createAccess(services);
  const indexer = createSearchIndexer(services);
  // Published Q&A on a document follows it into the bin, back out, and to its new folder (E3.3).
  const qaIndexer = createQaTargetIndexer(services);

  function audit(
    tx: Tx,
    ctx: TenantContext,
    actor: Actor,
    action: string,
    documentId: string,
    meta: Record<string, string | number | boolean | null | string[]> = {},
  ) {
    return services.audit.record(tx, ctx, {
      action,
      resourceKind: "document",
      resourceId: documentId,
      actorMembershipId: actor.membershipId,
      requestId: actor.requestId,
      meta,
    });
  }

  async function liveDocument(ctx: TenantContext, tx: Tx, id: string): Promise<Document> {
    const d = await new DocumentRepo(ctx, tx).live(id);
    if (d === undefined) throw new DataRoomError("not_found", "no such document");
    return d;
  }

  const availabilityFor: DocumentService["availabilityFor"] = (
    decision,
    protection,
    version,
    blob,
    settings,
  ) => {
    if (version === null || blob === null) {
      return { viewable: false, download: null, reason: "no_version" };
    }
    if (blob.scanStatus === "infected")
      return { viewable: false, download: null, reason: "infected" };
    if (blob.scanStatus === "pending" || blob.scanStatus === "scanning") {
      return { viewable: false, download: null, reason: "processing" };
    }
    if (!blobServable(blob, settings))
      return { viewable: false, download: null, reason: "unscanned" };
    if (blob.scanStatus === "error") return { viewable: false, download: null, reason: "failed" };
    const previewable = isPreviewable(version.contentType);
    const viewable = decision.allowed && previewable && version.renderStatus === "ready";
    // Staff with the download permission always get the original; investors get what the
    // document's policy and their grant allow.
    const canDownload = decision.allowed && decision.capabilities.includes("download");
    let download: DownloadVariant | null = null;
    if (canDownload) {
      if (protection.download || decision.capabilities.includes("edit")) {
        // A traced copy whenever the document is watermarked or forensic (E3.13 FIX1 D2): a
        // forensic document never hands an investor the untraced original.
        download =
          (protection.watermark || protection.forensic) && previewable ? "watermarked" : "original";
        if (decision.capabilities.includes("edit")) download = "original";
      }
    }
    const reason: Availability["reason"] = !previewable
      ? "unsupported"
      : version.renderStatus === "failed"
        ? "failed"
        : version.renderStatus === "unsupported"
          ? "unsupported"
          : version.renderStatus === "pending"
            ? "processing"
            : "ready";
    return { viewable, download, reason };
  };

  return {
    availabilityFor,

    async load(ctx, id) {
      return db.withTenant(ctx, async (tx) => {
        const document = await new DocumentRepo(ctx, tx).live(id);
        if (document === undefined) return undefined;
        const version = document.currentVersionId
          ? ((await new VersionRepo(ctx, tx).byId(document.currentVersionId)) ?? null)
          : null;
        const blob = version ? ((await new BlobRepo(ctx, tx).byId(version.blobId)) ?? null) : null;
        return { document, version, blob };
      });
    },

    async get(ctx, id, viewer, settings) {
      // Rows are read as system; the viewer's decision comes from the authz engine and an
      // investor without `view` learns nothing (404) — same shape as an unknown id.
      const sys = systemContext(ctx.workspaceId);
      const loaded = await db.withTenant(sys, async (tx) => {
        const document = await new DocumentRepo(sys, tx).live(id);
        if (document === undefined) return undefined;
        const folders = new FolderRepo(sys, tx);
        const folder = await folders.byId(document.folderId);
        const root = await folders.root();
        if (folder === undefined || root === undefined) return undefined;
        const versions = new VersionRepo(sys, tx);
        const all = await versions.forDocument(document.id);
        const current = all.find((v) => v.id === document.currentVersionId) ?? null;
        const blob = current ? ((await new BlobRepo(sys, tx).byId(current.blobId)) ?? null) : null;
        const siblingsFolders = await folders.listLive();
        const siblingDocs = await new DocumentRepo(sys, tx).listLive();
        const index = computeIndexes(root, siblingsFolders, siblingDocs).get(document.id) ?? "";
        return { document, folder, versions: all, current, blob, index };
      });
      if (loaded === undefined) throw new DataRoomError("not_found", "no such document");
      const decision = await access.document(ctx, viewer, loaded.document);
      if (!access.listed(decision)) throw new DataRoomError("not_found", "no such document");
      const protection = await effectiveProtection(
        services,
        ctx.workspaceId,
        viewer.membershipId,
        parseProtection(loaded.document.protection),
      );
      return {
        document: loaded.document,
        folder: { id: loaded.folder.id, name: loaded.folder.name, path: loaded.folder.path },
        index: loaded.index,
        protection,
        currentVersion: loaded.current,
        blob: loaded.blob
          ? {
              scanStatus: loaded.blob.scanStatus,
              scanEngine: loaded.blob.scanEngine,
              scanDetail: loaded.blob.scanDetail,
              scannedAt: loaded.blob.scannedAt,
            }
          : null,
        versions:
          viewer.kind === "staff" ? loaded.versions : loaded.current ? [loaded.current] : [],
        decision,
        availability: availabilityFor(decision, protection, loaded.current, loaded.blob, settings),
      };
    },

    update: (ctx, id, input, actor) =>
      db.withTenant(ctx, async (tx) => {
        const repo = new DocumentRepo(ctx, tx);
        await liveDocument(ctx, tx, id);
        // A rename or move re-reads the document's Q&A entries: its question rows first (lock
        // order — see QaLifecycleRepo.lockOnTargets), shared, so no staff re-index interleaves.
        if (input.title !== undefined || input.folderId !== undefined)
          await new QaLifecycleRepo(ctx, tx).lockOnTargets({ documentIds: [id] }, "share");
        // Then the row itself, locked: `protection` is written whole, so it (and the plan's
        // forensic gate below, A-3) must judge the stored value this write replaces — never a copy
        // a concurrent edit has already changed.
        const d = await repo.lockLive(id);
        if (d === undefined) throw new DataRoomError("not_found", "no such document");
        const patch: Parameters<DocumentRepo["update"]>[1] = {};
        const meta: Record<string, string | number | boolean | null | string[]> = {};
        if (input.title !== undefined && input.title !== d.title) {
          patch.title = input.title;
          meta["renamed"] = true;
        }
        if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
        if (input.folderId !== undefined && input.folderId !== d.folderId) {
          const folders = new FolderRepo(ctx, tx);
          const target = await folders.live(input.folderId);
          if (target === undefined) throw new DataRoomError("not_found", "no such folder");
          patch.folderId = target.id;
          patch.folderPath = target.path;
          meta["movedTo"] = target.id;
          // E3.5: moving a document out of a staff-only folder is how staff share a signed
          // document on purpose (a legal hold does not stop it: the hold keeps the document and
          // its versions, not its place). Both directions are recorded on the audit event.
          const before = await folders.underStaffOnly(d.folderPath);
          const after = await folders.underStaffOnly(target.path);
          if (before !== after) meta[after ? "enteredStaffOnly" : "leftStaffOnly"] = true;
          if (d.legalHold) meta["legalHold"] = true;
        }
        if (input.protection !== undefined) {
          const before = parseProtection(d.protection);
          const next = { ...before };
          for (const [k, v] of Object.entries(input.protection)) {
            if (v !== undefined) next[k as keyof Protection] = v;
          }
          // A-3: the plan gates turning forensic marking ON for a document; one already marked
          // keeps it (and can still be renamed, moved or have its other protection changed).
          if (next.forensic && !before.forensic) {
            const entitlements = await services.entitlements.forWorkspace(tx, ctx.workspaceId);
            services.entitlements.assertFeature(entitlements, "forensic");
          }
          patch.protection = next;
          meta["protection"] = Object.keys(input.protection);
        }
        const updated = await repo.update(id, patch);
        if (updated === undefined) throw new DataRoomError("not_found", "no such document");
        if (patch.folderPath !== undefined) await services.authz.bump(tx, ctx, "folder");
        // Title and ACL path live in the entry; re-read so it matches the committed row. The
        // document's published Q&A carries both too (title = the target's title). Q&A first: it
        // takes the workspace row before any search index lock (lock order).
        if (patch.title !== undefined || patch.folderPath !== undefined) {
          await qaIndexer.documentsBack(tx, ctx, [id]);
          await indexer.documents(tx, ctx, [id]);
        }
        await audit(tx, ctx, actor, "document.updated", id, meta);
        return updated;
      }),

    setLegalHold: (ctx, id, input, actor) =>
      db.withTenant(ctx, async (tx) => {
        const d = await new DocumentRepo(ctx, tx).byId(id);
        if (d === undefined) throw new DataRoomError("not_found", "no such document");
        if (input.hold && !input.reason?.trim()) {
          throw new DataRoomError("validation_failed", "a legal hold needs a reason", {
            issues: [{ path: "reason", message: "required", code: "required" }],
          });
        }
        const t = now();
        const updated = await new DocumentRepo(ctx, tx).update(id, {
          legalHold: input.hold,
          legalHoldReason: input.hold ? (input.reason ?? null) : null,
          legalHoldSetBy: input.hold ? actor.membershipId : null,
          legalHoldSetAt: input.hold ? t : null,
          // A held document in the bin stops its purge clock; clearing restarts it later.
          ...(input.hold ? { purgeAfter: null } : {}),
        });
        if (updated === undefined) throw new DataRoomError("not_found", "no such document");
        await services.audit.record(tx, ctx, {
          action: input.hold ? "document.legal_hold_set" : "document.legal_hold_cleared",
          resourceKind: "document",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          diff: { before: { legalHold: d.legalHold }, after: { legalHold: input.hold } },
          meta: { reason: input.reason ?? null },
        });
        return updated;
      }),

    remove: (ctx, id, actor, purgeAfterDays) =>
      db.withTenant(ctx, async (tx) => {
        const d = await liveDocument(ctx, tx, id);
        if (d.legalHold)
          throw new DataRoomError("conflict", "this document is under legal hold", {
            conflict: "legal_hold",
          });
        // its Q&A entries leave below: the question rows first (lock order)
        const questionIds = await new QaLifecycleRepo(ctx, tx).lockOnTargets(
          { documentIds: [id] },
          "share",
        );
        const t = now();
        const purgeAfter = new Date(t.getTime() + purgeAfterDays * 86_400_000);
        let updated: Document | undefined;
        try {
          updated = await new DocumentRepo(ctx, tx).update(id, {
            deletedAt: t,
            deletedBy: actor.membershipId,
            purgeAfter,
          });
        } catch (error) {
          if (pgErrorCode(error) === "23001")
            throw new DataRoomError("conflict", "this document is under legal hold", {
              conflict: "legal_hold",
            });
          throw error;
        }
        if (updated === undefined) throw new DataRoomError("not_found", "no such document");
        await indexer.remove(tx, ctx, "document", [id]);
        await qaIndexer.documentsGone(tx, ctx, [id]);
        await audit(tx, ctx, actor, "document.deleted", id, {
          purgeAfter: purgeAfter.toISOString(),
        });
        // E3.12: AI suggestions quoting it, or drafted for its questions (after the workspace row)
        await discardAiSuggestions(services, tx, ctx, { documentIds: [id], questionIds });
        return updated;
      }),

    restore: (ctx, id, actor) =>
      db.withTenant(ctx, async (tx) => {
        const repo = new DocumentRepo(ctx, tx);
        const d = await repo.byId(id);
        if (d === undefined || d.deletedAt === null)
          throw new DataRoomError("not_found", "no such deleted document");
        // its Q&A entries come back below: the question rows first (lock order)
        await new QaLifecycleRepo(ctx, tx).lockOnTargets({ documentIds: [id] }, "share");
        const folders = new FolderRepo(ctx, tx);
        const parent = await folders.byId(d.folderId);
        const patch: Parameters<DocumentRepo["update"]>[1] = {
          deletedAt: null,
          deletedBy: null,
          purgeAfter: null,
        };
        if (parent === undefined || parent.deletedAt !== null) {
          // E3.5: never restore a document out from under a (trashed) staff-only folder.
          if (await folders.underStaffOnly(d.folderPath))
            throw new DataRoomError("conflict", "restore the staff-only folder above it first", {
              conflict: "staff_only_parent",
            });
          const root = await folders.root();
          if (root === undefined) throw new Error("workspace has no root folder");
          patch.folderId = root.id;
          patch.folderPath = root.path;
        }
        const updated = await repo.update(id, patch);
        if (updated === undefined) throw new DataRoomError("not_found", "no such document");
        // Back under the root is a move (review R3A): a row the rebuild resolved from where the
        // document sat — a gated document's own row carries its old folder's grants — must go.
        // Entity rows first, then the workspace row (lock order); migration 0006's commit-time
        // trigger is the backstop for any writer that forgets.
        if (patch.folderPath !== undefined && patch.folderPath !== d.folderPath)
          await services.authz.bump(tx, ctx, "folder");
        await qaIndexer.documentsBack(tx, ctx, [id]); // before the index lock (lock order)
        await indexer.documents(tx, ctx, [id]);
        await audit(tx, ctx, actor, "document.restored", id, {});
        return updated;
      }),

    listDeleted: (ctx) => db.withTenant(ctx, (tx) => new DocumentRepo(ctx, tx).listDeleted()),

    purge: (ctx, id, actor) =>
      db.withTenant(ctx, async (tx) => {
        const repo = new DocumentRepo(ctx, tx);
        const d = await repo.byId(id);
        if (d === undefined || d.deletedAt === null)
          throw new DataRoomError("not_found", "no such deleted document");
        if (d.legalHold)
          throw new DataRoomError("conflict", "this document is under legal hold", {
            conflict: "legal_hold",
          });
        // Q&A lock order: the document's question rows first (the hard delete cascades to them),
        // then their search entries, then the audit chain. Taking them only through the cascade —
        // after the entries — deadlocks with a staff action that holds a row and re-indexes it.
        const questionIds = await new QaLifecycleRepo(ctx, tx).lockOnTargets({
          documentIds: [id],
        });
        const versions = new VersionRepo(ctx, tx);
        const renditions = new RenditionRepo(ctx, tx);
        const keys: string[] = [];
        for (const v of await versions.forDocument(id)) {
          for (const r of await renditions.deleteForVersion(v.id)) keys.push(r.storageKey);
        }
        // Q&A rows cascade with the document; their entries go first, while they can be found.
        await qaIndexer.documentsGone(tx, ctx, [id]);
        await repo.hardDelete(id); // versions and page text cascade; blobs wait for the purge job
        await indexer.remove(tx, ctx, "document", [id]);
        await audit(tx, ctx, actor, "document.purged", id, { renditions: keys.length });
        // E3.12: AI suggestions quoting it, or drafted for its questions (after the workspace row)
        await discardAiSuggestions(services, tx, ctx, { documentIds: [id], questionIds });
        // Objects after the row is gone: a crash here leaves orphans the reconciler removes.
        if (keys.length > 0) await services.storage.deleteMany(keys);
      }),
  };
}

export { PROTECTION_SCHEMA_VERSION };
