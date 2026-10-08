import { listLiveWorkspaceIds, systemContext, type TenantContext } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { parseObjectKey, workspacePrefix } from "@fundroom/storage";
import { discardAiSuggestions } from "../qa/ai/discard.js";
import {
  BlobRepo,
  DocumentRepo,
  FolderRepo,
  RenditionRepo,
  UploadRepo,
  VersionRepo,
} from "../repos/dataroom-repo.js";
import { QaLifecycleRepo } from "../repos/qa-lifecycle-repo.js";

/*
 * Housekeeping (design/06 §4): the hourly purge empties the recycle bin past `purge_after`
 * (documents → versions → renditions → orphaned blobs, two-phase so a crash never leaves a
 * row pointing nowhere), expires stale uploads, and re-enqueues ingests that never ran; the
 * weekly reconciler compares storage prefixes with rows and removes orphans older than a day.
 */
export interface PurgeSummary {
  documents: number;
  folders: number;
  blobs: number;
  uploads: number;
  reenqueued: number;
}

export interface ReconcileSummary {
  orphanObjects: number;
  missingObjects: number;
  workspaces: number;
}

export interface MaintenanceService {
  purge(workspaceId?: string): Promise<PurgeSummary>;
  reconcile(workspaceId?: string): Promise<ReconcileSummary>;
}

const ORPHAN_GRACE_MS = 24 * 3600_000;

/**
 * The object kinds this module owns, and therefore the only ones the reconciler may delete.
 *
 * `ws/<workspace>/` is the whole tenant's storage prefix, not the data room's — E1.7 put logos
 * under `branding/` and E2.3 puts click-wrap certificates under `certificates/`, both alongside
 * our `blobs/`, `renditions/` and `quarantine/`. The sweep used to skip only `parseObjectKey`'s
 * `other`, which meant every key another epic taught the parser to *recognise* became an orphan
 * here the moment it was not in our tables: a workspace logo was deleted on the first weekly run
 * more than a day after it was uploaded, and a certificate would have followed. Recognising a key
 * is not the same as owning it, and the safe direction for that test is an allow-list — a kind we
 * have never heard of must be left alone, not deleted.
 */
const RECONCILED_KINDS: ReadonlySet<string> = new Set(["blob", "rendition", "quarantine"]);

export function createMaintenanceService(services: ModuleServices): MaintenanceService {
  const { db, storage, log, queue } = services;
  const now = () => services.now();

  async function purgeWorkspace(ctx: TenantContext, summary: PurgeSummary): Promise<void> {
    const t = now();
    // 1. documents whose bin time is up (legal hold excluded by the repo and the trigger)
    const docs = await db.withTenant(ctx, (tx) => new DocumentRepo(ctx, tx).purgeable(t));
    for (const d of docs) {
      const keys = await db.withTenant(ctx, async (tx) => {
        // Q&A lock order: the question rows the delete cascades to, before the audit chain.
        const questionIds = await new QaLifecycleRepo(ctx, tx).lockOnTargets({
          documentIds: [d.id],
        });
        const versions = new VersionRepo(ctx, tx);
        const renditions = new RenditionRepo(ctx, tx);
        const out: string[] = [];
        for (const v of await versions.forDocument(d.id)) {
          for (const r of await renditions.deleteForVersion(v.id)) out.push(r.storageKey);
        }
        await new DocumentRepo(ctx, tx).hardDelete(d.id);
        await services.audit.record(tx, ctx, {
          action: "document.purged",
          resourceKind: "document",
          resourceId: d.id,
          meta: { renditions: out.length, deletedAt: d.deletedAt?.toISOString() ?? null },
        });
        // E3.12: AI suggestions quoting it, or drafted for its questions (after the workspace row)
        await discardAiSuggestions(services, tx, ctx, { documentIds: [d.id], questionIds });
        return out;
      });
      if (keys.length > 0) await storage.deleteMany(keys);
      summary.documents += 1;
    }
    // 2. folders in the bin with nothing left below them
    const folders = await db.withTenant(ctx, (tx) => new FolderRepo(ctx, tx).purgeable(t));
    for (const f of [...folders].sort((a, b) => b.path.length - a.path.length)) {
      const removed = await db.withTenant(ctx, async (tx) => {
        const remaining = await new DocumentRepo(ctx, tx).countUnderPath(f.path, "any");
        const children = (await new FolderRepo(ctx, tx).subtree(f.path)).length;
        if (remaining > 0 || children > 0) return false;
        // Q&A lock order: the folder's question rows (the delete cascades to them) first.
        const questionIds = await new QaLifecycleRepo(ctx, tx).lockOnTargets({
          folderIds: [f.id],
        });
        await new FolderRepo(ctx, tx).hardDelete(f.id);
        // E3.12: AI suggestions drafted for its questions (no audit here: lock the row first)
        await discardAiSuggestions(services, tx, ctx, { documentIds: [], questionIds });
        return true;
      });
      if (removed) summary.folders += 1;
    }
    // 3. blobs no version references: mark, delete the object, drop the row (two-phase)
    const orphans = await db.withTenant(ctx, (tx) => new BlobRepo(ctx, tx).orphans());
    for (const b of orphans) {
      if (b.purgeAfter === null) {
        await db.withTenant(ctx, (tx) => new BlobRepo(ctx, tx).update(b.id, { purgeAfter: t }));
        continue; // next run deletes: a version created in between keeps it (orphans() re-checks)
      }
      await storage.delete(b.storageKey);
      await db.withTenant(ctx, (tx) => new BlobRepo(ctx, tx).hardDelete(b.id));
      summary.blobs += 1;
    }
    // 4. uploads that never completed
    const expired = await db.withTenant(ctx, (tx) => new UploadRepo(ctx, tx).expired(t));
    for (const up of expired) {
      if (up.method === "multipart" && up.multipartUploadId !== null) {
        await storage.multipart
          .abort({ key: up.storageKey, uploadId: up.multipartUploadId })
          .catch(() => {});
      }
      await storage.delete(up.storageKey).catch(() => {});
      await db.withTenant(ctx, (tx) =>
        new UploadRepo(ctx, tx).update(up.id, { status: "expired" }),
      );
      summary.uploads += 1;
    }
    // 5. blobs stuck before the scanner ran (the enqueue was lost or the worker died)
    const stale = await db.withTenant(ctx, (tx) =>
      new BlobRepo(ctx, tx).stale(new Date(t.getTime() - 30 * 60_000)),
    );
    for (const b of stale) {
      const version = await db.withTenant(ctx, (tx) => new VersionRepo(ctx, tx).firstForBlob(b.id));
      if (version === undefined) continue;
      await queue.send(
        "data-room.ingest",
        { workspaceId: ctx.workspaceId, versionId: version.id, blobId: b.id },
        { idempotencyKey: `ingest:${version.id}` },
      );
      summary.reenqueued += 1;
    }
  }

  async function reconcileWorkspace(ctx: TenantContext, summary: ReconcileSummary): Promise<void> {
    const t = now().getTime();
    const { blobs, renditions, uploads } = await db.withTenant(ctx, async (tx) => ({
      blobs: await new BlobRepo(ctx, tx).listAll(),
      renditions: await new RenditionRepo(ctx, tx).listAll(),
      uploads: await new UploadRepo(ctx, tx).listByStatus(["pending", "stored"]),
    }));
    const known = new Set<string>([
      ...blobs.map((b) => b.storageKey),
      ...renditions.map((r) => r.storageKey),
      ...uploads.map((u) => u.storageKey),
    ]);
    const seen = new Set<string>();
    let cursor: string | undefined;
    const orphans: string[] = [];
    do {
      const page = await storage.list({ prefix: `${workspacePrefix(ctx.workspaceId)}/`, cursor });
      for (const o of page.objects) {
        seen.add(o.key);
        const parsed = parseObjectKey(o.key);
        if (!RECONCILED_KINDS.has(parsed.kind)) continue;
        if (known.has(o.key)) continue;
        const age = o.lastModified ? t - o.lastModified.getTime() : Number.POSITIVE_INFINITY;
        if (age > ORPHAN_GRACE_MS) orphans.push(o.key);
      }
      cursor = page.cursor;
    } while (cursor !== undefined);
    if (orphans.length > 0) {
      await storage.deleteMany(orphans);
      summary.orphanObjects += orphans.length;
    }
    for (const b of blobs) {
      if (!seen.has(b.storageKey) && (await storage.head(b.storageKey)) === undefined) {
        summary.missingObjects += 1;
        log("data-room.blob_missing", {
          level: "error",
          workspaceId: ctx.workspaceId,
          blobId: b.id,
        });
        await db.withTenant(ctx, (tx) =>
          new BlobRepo(ctx, tx).update(b.id, {
            scanStatus: "error",
            scanDetail: "object missing from storage",
          }),
        );
      }
    }
  }

  return {
    async purge(workspaceId) {
      const summary: PurgeSummary = {
        documents: 0,
        folders: 0,
        blobs: 0,
        uploads: 0,
        reenqueued: 0,
      };
      const ids = workspaceId === undefined ? await listLiveWorkspaceIds(db) : [workspaceId];
      for (const id of ids) {
        try {
          await purgeWorkspace(systemContext(id), summary);
        } catch (error) {
          log("data-room.purge_failed", {
            level: "error",
            workspaceId: id,
            error: String(error instanceof Error && error.cause ? error.cause : error),
          });
        }
      }
      log("data-room.purged", { ...summary });
      return summary;
    },
    async reconcile(workspaceId) {
      const summary: ReconcileSummary = { orphanObjects: 0, missingObjects: 0, workspaces: 0 };
      const ids = workspaceId === undefined ? await listLiveWorkspaceIds(db) : [workspaceId];
      for (const id of ids) {
        try {
          await reconcileWorkspace(systemContext(id), summary);
          summary.workspaces += 1;
        } catch (error) {
          log("data-room.reconcile_failed", {
            level: "error",
            workspaceId: id,
            error: String(error),
          });
        }
      }
      log("data-room.reconciled", { ...summary });
      return summary;
    },
  };
}
