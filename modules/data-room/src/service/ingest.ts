import { systemContext, type TenantContext } from "@fundroom/db";
import { publish } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import type { ScanResult } from "@fundroom/ports";
import { blobKey, renditionKey } from "@fundroom/storage";
import { isPreviewable } from "../model.js";
import {
  BlobRepo,
  DocumentRepo,
  PageTextRepo,
  RenditionRepo,
  UploadRepo,
  VersionRepo,
} from "../repos/dataroom-repo.js";
import type { Blob, DocumentVersion } from "../schema/dataroom.js";
import { createObjectStore, ENCRYPTION_SCHEMA_VERSION, parseEncryption } from "./objects.js";
import { createSearchIndexer } from "./search.js";

/*
 * The upload pipeline's back half (§8): scan → sanitise → encrypt to the blob key → page
 * count, text, thumbnail. Idempotent per step: a retried job picks up where the state
 * machine says it stopped (`blob.scan_status`, `blob.storage_key`, `version.render_status`).
 * A scanner outage throws (pg-boss retries, then dead-letters and the blob stays `error`);
 * a rendering problem marks the version `failed` and finishes — the bytes are safe, only
 * the preview is missing.
 */
export const THUMBNAIL_WIDTH = 320;

export interface IngestInput {
  readonly workspaceId: string;
  readonly versionId: string;
  readonly blobId: string;
  readonly uploadId?: string | undefined;
  /** Re-derivation after a workspace import: the blob is already promoted, only renditions and text are rebuilt. */
  readonly rederive?: boolean | undefined;
}

export interface IngestResult {
  readonly scanStatus: Blob["scanStatus"];
  readonly renderStatus: DocumentVersion["renderStatus"];
}

export class ScanUnavailableError extends Error {
  override readonly name = "ScanUnavailableError";
}

export interface IngestService {
  ingest(input: IngestInput): Promise<IngestResult | undefined>;
}

export function createIngestService(services: ModuleServices): IngestService {
  const { db, storage, scanner, renderer, log } = services;
  const objects = createObjectStore(services);
  const indexer = createSearchIndexer(services);
  const now = () => services.now();

  async function scanAndPromote(ctx: TenantContext, b: Blob): Promise<Blob> {
    const blobs = (tx: Parameters<Parameters<typeof db.withTenant>[1]>[0]) => new BlobRepo(ctx, tx);
    // Defence in depth behind the import engine's key checks (E2.8 review): this function reads
    // and then deletes the object it is given, so a key naming another workspace's object must
    // never reach it, whatever row put it there.
    if (!b.storageKey.startsWith(`ws/${ctx.workspaceId}/`)) {
      throw new Error(
        `blob ${b.id}: storage key is outside workspace ${ctx.workspaceId}; refusing to read or delete it`,
      );
    }
    const promoted = b.storageKey === blobKey(ctx.workspaceId, b.sha256.toString("hex"));
    if (promoted && (b.scanStatus === "clean" || b.scanStatus === "skipped")) return b;

    // 1. scan the quarantine object
    let verdict: ScanResult;
    if (b.scanStatus === "clean" || b.scanStatus === "skipped") {
      verdict = { verdict: b.scanStatus, engine: b.scanEngine ?? "recorded" };
    } else {
      await db.withTenant(ctx, (tx) => blobs(tx).update(b.id, { scanStatus: "scanning" }));
      const read = await storage.get(b.storageKey);
      if (read === undefined) {
        await db.withTenant(ctx, (tx) =>
          blobs(tx).update(b.id, { scanStatus: "error", scanDetail: "upload object missing" }),
        );
        throw new Error(`blob ${b.id}: quarantine object ${b.storageKey} is missing`);
      }
      verdict = await scanner.scan({ body: read.body, size: b.sizeBytes });
      const t = now();
      if (verdict.verdict === "error") {
        await db.withTenant(ctx, (tx) =>
          blobs(tx).update(b.id, {
            scanStatus: "error",
            scannedAt: t,
            scanEngine: verdict.engine,
            scanDetail: verdict.detail ?? null,
          }),
        );
        throw new ScanUnavailableError(`blob ${b.id}: scan failed: ${verdict.detail ?? "unknown"}`);
      }
      const updated = await db.withTenant(ctx, async (tx) => {
        const row = await blobs(tx).update(b.id, {
          scanStatus: verdict.verdict,
          scannedAt: t,
          scanEngine: verdict.engine,
          scanDetail: verdict.detail ?? null,
        });
        if (verdict.verdict === "infected") {
          await services.audit.record(tx, ctx, {
            action: "document.scan_infected",
            resourceKind: "blob",
            resourceId: b.id,
            outcome: "denied",
            meta: { engine: verdict.engine, signature: verdict.detail ?? null },
          });
        }
        return row;
      });
      if (updated === undefined) throw new Error(`blob ${b.id} vanished during scan`);
      b = updated;
      log("data-room.scanned", {
        workspaceId: ctx.workspaceId,
        blobId: b.id,
        verdict: verdict.verdict,
      });
      if (verdict.verdict === "infected") return b; // stays in quarantine, never servable
    }

    // 2. encrypt into the content-addressed key, drop the quarantine copy
    if (!promoted) {
      const read = await storage.get(b.storageKey);
      if (read === undefined)
        throw new Error(`blob ${b.id}: quarantine object vanished before promotion`);
      const key = blobKey(ctx.workspaceId, b.sha256.toString("hex"));
      const stored = await db.withTenant(ctx, (tx) =>
        objects.putStream(tx, ctx, key, read.body, b.sizeBytes, b.contentType),
      );
      const quarantine = b.storageKey;
      const updated = await db.withTenant(ctx, (tx) =>
        blobs(tx).update(b.id, {
          storageKey: key,
          encryption: stored.encryption,
        }),
      );
      if (updated === undefined) throw new Error(`blob ${b.id} vanished during promotion`);
      b = updated;
      await storage.delete(quarantine).catch((error) =>
        log("data-room.quarantine_delete_failed", {
          level: "warn",
          key: quarantine,
          error: String(error),
        }),
      );
    }
    return b;
  }

  async function render(ctx: TenantContext, b: Blob, v: DocumentVersion): Promise<DocumentVersion> {
    const versions = (tx: Parameters<Parameters<typeof db.withTenant>[1]>[0]) =>
      new VersionRepo(ctx, tx);
    if (v.renderStatus !== "pending") return v;
    const finish = async (
      status: DocumentVersion["renderStatus"],
      detail: string | null,
      pageCount: number | null,
    ) => {
      const row = await db.withTenant(ctx, (tx) =>
        versions(tx).update(v.id, { renderStatus: status, renderDetail: detail, pageCount }),
      );
      return row ?? v;
    };
    if (!isPreviewable(v.contentType))
      return finish("unsupported", "no preview for this file type", null);
    if (b.sizeBytes > services.limits.renderMaxBytes) {
      return finish("unsupported", "too large to preview; download only", null);
    }
    const encryption = parseEncryption(b.encryption);
    if (encryption === undefined) return finish("failed", "blob is not encrypted yet", null);
    try {
      const bytes = await db.withTenant(ctx, (tx) =>
        objects.readBytes(tx, ctx, b.storageKey, encryption),
      );
      const probe = await renderer.probe(bytes, v.contentType);
      if (probe.kind === "unsupported") return finish("unsupported", "unrecognised content", null);
      let source = bytes;
      if (probe.kind === "pdf") {
        const sanitized = await renderer.sanitizePdf(bytes);
        if (sanitized.removed.length > 0) {
          source = sanitized.bytes;
          const key = renditionKey(ctx.workspaceId, v.id, "pdf");
          await db.withTenant(ctx, async (tx) => {
            const stored = await objects.putBytes(tx, ctx, key, sanitized.bytes, "application/pdf");
            await new RenditionRepo(ctx, tx).createIfAbsent({
              versionId: v.id,
              kind: "pdf",
              pageNo: null,
              contentType: "application/pdf",
              storageKey: key,
              sizeBytes: sanitized.bytes.byteLength,
            });
            await services.audit.record(tx, ctx, {
              action: "document.sanitized",
              resourceKind: "document",
              resourceId: v.documentId,
              meta: {
                versionId: v.id,
                removed: [...sanitized.removed],
                keyId: stored.encryption.keyId,
              },
            });
          });
        }
      }
      const texts = await renderer.extractText(source, probe.kind);
      const thumb = await renderer.renderPage(source, probe.kind, 1, { width: THUMBNAIL_WIDTH });
      const thumbKey = renditionKey(ctx.workspaceId, v.id, "thumbnail");
      await db.withTenant(ctx, async (tx) => {
        await objects.putBytes(tx, ctx, thumbKey, thumb.bytes, thumb.contentType);
        await new RenditionRepo(ctx, tx).createIfAbsent({
          versionId: v.id,
          kind: "thumbnail",
          pageNo: null,
          width: thumb.width,
          height: thumb.height,
          contentType: thumb.contentType,
          storageKey: thumbKey,
          sizeBytes: thumb.bytes.byteLength,
        });
        await new PageTextRepo(ctx, tx).replace(v.id, texts);
      });
      return finish("ready", null, probe.pageCount);
    } catch (error) {
      log("data-room.render_failed", {
        level: "warn",
        workspaceId: ctx.workspaceId,
        versionId: v.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return finish(
        "failed",
        (error instanceof Error ? error.message : String(error)).slice(0, 500),
        null,
      );
    }
  }

  return {
    async ingest(input) {
      const ctx = systemContext(input.workspaceId);
      const loaded = await db.withTenant(ctx, async (tx) => ({
        blob: await new BlobRepo(ctx, tx).byId(input.blobId),
        version: await new VersionRepo(ctx, tx).byId(input.versionId),
      }));
      if (loaded.blob === undefined || loaded.version === undefined) {
        log("data-room.ingest_skipped", {
          workspaceId: input.workspaceId,
          versionId: input.versionId,
        });
        return undefined;
      }
      let b = loaded.blob;
      let v = loaded.version;
      b = await scanAndPromote(ctx, b);
      if (b.scanStatus === "infected") {
        v =
          (await db.withTenant(ctx, (tx) =>
            new VersionRepo(ctx, tx).update(v.id, {
              renderStatus: "failed",
              renderDetail: "infected",
            }),
          )) ?? v;
      } else {
        v = await render(ctx, b, v);
      }
      const renderStatus = v.renderStatus === "pending" ? "failed" : v.renderStatus;
      await db.withTenant(ctx, async (tx) => {
        if (input.uploadId !== undefined) {
          await new UploadRepo(ctx, tx).update(input.uploadId, { status: "completed" });
        }
        const doc = await new DocumentRepo(ctx, tx).byId(v.documentId);
        await services.audit.record(tx, ctx, {
          action: "document.ingested",
          resourceKind: "document",
          resourceId: v.documentId,
          outcome: b.scanStatus === "infected" ? "denied" : "success",
          meta: {
            versionId: v.id,
            scanStatus: b.scanStatus,
            renderStatus,
            pageCount: v.pageCount ?? null,
            encryptionSchemaVersion: ENCRYPTION_SCHEMA_VERSION,
            ...(input.rederive === true ? { rederived: true } : {}),
          },
        });
        // The page text committed with the render; the entry reads the document's *current*
        // version, so an older version finishing late never overwrites a newer one's text.
        if (doc !== undefined) await indexer.documents(tx, ctx, [doc.id]);
        if (doc !== undefined) {
          await publish(tx, ctx, "document.ingested", {
            documentId: v.documentId,
            versionId: v.id,
            scanStatus: b.scanStatus as "clean" | "infected" | "error" | "skipped",
            renderStatus: renderStatus as "ready" | "unsupported" | "failed",
          });
        }
      });
      return { scanStatus: b.scanStatus, renderStatus };
    },
  };
}
