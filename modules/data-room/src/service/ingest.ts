import { systemContext, type TenantContext } from "@fundroom/db";
import { publish } from "@fundroom/events";
import type { ModuleServices } from "@fundroom/module-kit";
import type { ScanResult } from "@fundroom/ports";
import { blobKey, renditionKey } from "@fundroom/storage";
import { isFinalScanDetail, isPreviewable } from "../model.js";
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
 * One job scans a blob at a time (`BlobRepo.claimScan`, which records the claiming version);
 * the others end, and the job that owns the blob enqueues them again in the transaction that
 * makes it final (the infected or unscannable verdict, or the promotion). A scanner outage throws and the blob stays `scanning` while pg-boss
 * retries; the last attempt records `error` and the job is dead-lettered; a
 * file the scanner cannot scan in full (`retryable: false`: too large, engine limits) is final:
 * the blob is `error`, `document.ingested` says so and the job ends without a retry. Uploading
 * the same bytes again retries the scan (uploads.ts). A rendering problem marks the version
 * `failed` and finishes — the bytes are safe, only the preview is missing.
 */
export const THUMBNAIL_WIDTH = 320;

export interface IngestInput {
  readonly workspaceId: string;
  readonly versionId: string;
  readonly blobId: string;
  readonly uploadId?: string | undefined;
  /** Re-derivation after a workspace import: the blob is already promoted, only renditions and text are rebuilt. */
  readonly rederive?: boolean | undefined;
  /** The job's delivery (`ActiveJob.attempt`); unknown counts as the last attempt. */
  readonly attempt?: { readonly count: number; readonly limit: number } | undefined;
  /** The job's abort signal (stop or expiry), handed to the scanner. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * `scan_detail` of an `error` a later scan can fix: everything but a final detail
 * (`isFinalScanDetail` in model.ts, the one rule `BlobRepo.claimScan` also applies).
 */
export function isRetryableScanDetail(detail: string | null): boolean {
  return !isFinalScanDetail(detail);
}

/** Same name as `JOB_INGEST` in jobs.ts (which imports this file, so it is not imported back). */
const INGEST_JOB_NAME = "data-room.ingest";

/**
 * A `scanning` claim older than this belongs to a job that died: every attempt of the ingest
 * job expires after 30 minutes and the scan deadline is shorter, so a live scan is never this old.
 */
const SCAN_CLAIM_STALE_MS = 35 * 60_000;

export interface IngestResult {
  readonly scanStatus: Blob["scanStatus"];
  readonly renderStatus: DocumentVersion["renderStatus"];
}

export class ScanUnavailableError extends Error {
  override readonly name = "ScanUnavailableError";
}

/** `scan_detail` for an `error` verdict: `${reason}: ${detail}` when the scanner says why. */
export function scanErrorDetail(result: ScanResult): string | null {
  if (result.reason === undefined) return result.detail ?? null;
  return result.detail === undefined || result.detail === ""
    ? result.reason
    : `${result.reason}: ${result.detail}`;
}

async function cancelBody(body: ReadableStream<Uint8Array>): Promise<void> {
  try {
    await body.cancel();
  } catch {
    // Locked by a reader the scanner did not release, or already closed: nothing to free here.
  }
}

export interface IngestService {
  ingest(input: IngestInput): Promise<IngestResult | undefined>;
}

export function createIngestService(services: ModuleServices): IngestService {
  const { db, storage, scanner, renderer, log } = services;
  const objects = createObjectStore(services);
  const indexer = createSearchIndexer(services);
  const now = () => services.now();

  type Tx = Parameters<Parameters<typeof db.withTenant>[1]>[0];

  interface Settled {
    readonly blob: Blob;
    /** False when another job holds the scan (or moved the blob on): this job does nothing. */
    readonly owned: boolean;
  }

  /**
   * The blob just became final for its versions (infected, unscannable, or promoted): its other
   * unfinished versions are enqueued again, in the same transaction, to render (or record the
   * failure). Their own jobs found the scan claimed and ended without waiting; enqueuing them
   * with the write means a crash after the commit cannot strand them.
   */
  async function handOn(tx: Tx, ctx: TenantContext, blobId: string, versionId: string) {
    for (const other of await new VersionRepo(ctx, tx).pendingForBlob(blobId)) {
      if (other.id === versionId) continue;
      await services.queue.sendInTransaction(
        tx,
        INGEST_JOB_NAME,
        { workspaceId: ctx.workspaceId, versionId: other.id, blobId },
        { idempotencyKey: `ingest:${other.id}` },
      );
    }
  }

  async function reload(ctx: TenantContext, id: string): Promise<Blob> {
    const row = await db.withTenant(ctx, (tx) => new BlobRepo(ctx, tx).byId(id));
    if (row === undefined) throw new Error(`blob ${id} vanished during ingest`);
    return row;
  }

  async function scanAndPromote(ctx: TenantContext, b: Blob, input: IngestInput): Promise<Settled> {
    const blobs = (tx: Tx) => new BlobRepo(ctx, tx);
    // Defence in depth behind the import engine's key checks (E2.8 review): this function reads
    // and then deletes the object it is given, so a key naming another workspace's object must
    // never reach it, whatever row put it there.
    if (!b.storageKey.startsWith(`ws/${ctx.workspaceId}/`)) {
      throw new Error(
        `blob ${b.id}: storage key is outside workspace ${ctx.workspaceId}; refusing to read or delete it`,
      );
    }
    // Final verdicts: never scanned twice (a retry after a failed last step must not count an
    // infected file again). An `error` is final only when its detail says so (too large, engine
    // limits); any other is scanned again (a dead-lettered job retried by hand). Uploading the
    // bytes again resets the blob either way.
    if (
      b.scanStatus === "infected" ||
      (b.scanStatus === "error" && isFinalScanDetail(b.scanDetail))
    ) {
      return { blob: b, owned: true };
    }
    if (
      b.storageKey === blobKey(ctx.workspaceId, b.sha256.toString("hex")) &&
      (b.scanStatus === "clean" || b.scanStatus === "skipped")
    ) {
      return { blob: b, owned: true };
    }

    // 1. scan the quarantine object
    if (b.scanStatus !== "clean" && b.scanStatus !== "skipped") {
      const quarantine = b.storageKey;
      const at = now();
      const claimed = await db.withTenant(ctx, (tx) =>
        blobs(tx).claimScan(b.id, quarantine, {
          claimant: input.versionId,
          at,
          staleBefore: new Date(at.getTime() - SCAN_CLAIM_STALE_MS),
        }),
      );
      if (claimed === undefined) {
        const current = await reload(ctx, b.id);
        log("data-room.scan_claim_lost", {
          workspaceId: ctx.workspaceId,
          blobId: b.id,
          versionId: input.versionId,
          scanStatus: current.scanStatus,
        });
        if (
          (current.scanStatus === "clean" || current.scanStatus === "skipped") &&
          current.storageKey !== blobKey(ctx.workspaceId, current.sha256.toString("hex"))
        ) {
          // Scanned clean but not promoted yet (the scanning job died or failed before its
          // promotion): promote it here. `lockForPromotion` and `updateIfKey` serialise this
          // against any other job doing the same.
          b = current;
        } else {
          return { blob: current, owned: false };
        }
      } else {
        b = claimed;
        const read = await storage.get(quarantine);
        if (read === undefined) {
          await db.withTenant(ctx, (tx) =>
            blobs(tx).updateIfKey(b.id, quarantine, {
              scanStatus: "error",
              scanDetail: "upload object missing",
            }),
          );
          throw new Error(`blob ${b.id}: quarantine object ${quarantine} is missing`);
        }
        const verdict = await scanner.scan({
          body: read.body,
          size: b.sizeBytes,
          source: "data-room",
          signal: input.signal,
        });
        const t = now();
        if (verdict.verdict === "error") {
          // Whatever the scanner left unread is released, so the storage connection is not held
          // open until the job retries (or forever when it does not).
          await cancelBody(read.body);
          const final = verdict.retryable === false;
          const detail = scanErrorDetail(verdict);
          // A retryable failure keeps the blob `scanning` (still Processing for the reader) while
          // the job has attempts left; the last attempt records `error`, then throws so the job
          // is dead-lettered. Unknown attempt (a direct call) counts as the last.
          const attempt = input.attempt;
          const last = attempt === undefined || attempt.count >= attempt.limit;
          const recordError = final || last;
          const updated = await db.withTenant(ctx, async (tx) => {
            const row = await blobs(tx).updateIfKey(
              b.id,
              quarantine,
              {
                scanStatus: recordError ? "error" : "scanning",
                scannedAt: t,
                scanEngine: verdict.engine,
                scanDetail: detail,
              },
              // Staying `scanning` only while it still is: never undo a verdict written meanwhile.
              recordError ? {} : { scanStatus: "scanning" },
            );
            if (row !== undefined && final) await handOn(tx, ctx, b.id, input.versionId);
            return row;
          });
          if (updated === undefined) {
            const current = await reload(ctx, b.id);
            log("data-room.scan_superseded", {
              workspaceId: ctx.workspaceId,
              blobId: b.id,
              scanStatus: current.scanStatus,
            });
            return { blob: current, owned: false };
          }
          if (!final) {
            // On the last attempt the other versions stay pending: the blob reads Scan failed,
            // and whichever job scans it next (a dead letter retried by hand) hands them on.
            throw new ScanUnavailableError(`blob ${b.id}: scan failed: ${detail ?? "unknown"}`);
          }
          // Retrying cannot help (too large to scan in full, or the engine stopped at one of its
          // limits): the failure is final, the bytes stay in quarantine and are never served.
          log("data-room.scan_unscannable", {
            level: "warn",
            workspaceId: ctx.workspaceId,
            blobId: b.id,
            reason: verdict.reason ?? null,
          });
          return { blob: updated, owned: true };
        }
        const updated = await db.withTenant(ctx, async (tx) => {
          const row = await blobs(tx).updateIfKey(b.id, quarantine, {
            scanStatus: verdict.verdict,
            scannedAt: t,
            scanEngine: verdict.engine,
            scanDetail: verdict.detail ?? null,
          });
          if (row !== undefined && verdict.verdict === "infected") {
            await services.audit.record(tx, ctx, {
              action: "document.scan_infected",
              resourceKind: "blob",
              resourceId: b.id,
              outcome: "denied",
              meta: { engine: verdict.engine, signature: verdict.detail ?? null },
            });
            await handOn(tx, ctx, b.id, input.versionId);
          }
          return row;
        });
        if (updated === undefined) {
          const current = await reload(ctx, b.id);
          log("data-room.scan_superseded", {
            workspaceId: ctx.workspaceId,
            blobId: b.id,
            scanStatus: current.scanStatus,
          });
          return { blob: current, owned: false };
        }
        b = updated;
        log("data-room.scanned", {
          workspaceId: ctx.workspaceId,
          blobId: b.id,
          verdict: verdict.verdict,
        });
        if (verdict.verdict === "infected") return { blob: b, owned: true }; // stays in quarantine
      }
    }

    // 2. encrypt into the content-addressed key, drop the quarantine copy. `promoted` is read
    // from the row as it is now, and the promotion holds the row (still naming the quarantine
    // key) for the whole write, so two jobs never both encrypt into the content key.
    const key = blobKey(ctx.workspaceId, b.sha256.toString("hex"));
    if (b.storageKey !== key) {
      const quarantine = b.storageKey;
      const promoted = await db.withTenant(ctx, async (tx) => {
        const held = await blobs(tx).lockForPromotion(b.id, quarantine);
        if (held === undefined) return undefined;
        const read = await storage.get(quarantine);
        if (read === undefined)
          throw new Error(`blob ${b.id}: quarantine object vanished before promotion`);
        const stored = await objects.putStream(tx, ctx, key, read.body, b.sizeBytes, b.contentType);
        const row = await blobs(tx).updateIfKey(b.id, quarantine, {
          storageKey: key,
          encryption: stored.encryption,
        });
        // Whichever attempt promotes hands on, not only the one that scanned: an earlier
        // attempt may have scanned and then failed here.
        if (row !== undefined) await handOn(tx, ctx, b.id, input.versionId);
        return row;
      });
      if (promoted === undefined) {
        const current = await reload(ctx, b.id);
        log("data-room.promotion_superseded", {
          workspaceId: ctx.workspaceId,
          blobId: b.id,
          scanStatus: current.scanStatus,
        });
        return { blob: current, owned: current.storageKey === key };
      }
      b = promoted;
      await storage.delete(quarantine).catch((error) =>
        log("data-room.quarantine_delete_failed", {
          level: "warn",
          key: quarantine,
          error: String(error),
        }),
      );
    }
    return { blob: b, owned: true };
  }

  /** The version's final state; written by `ingest` with its audit row (`finishIfPending`). */
  type Outcome = Pick<DocumentVersion, "renderStatus" | "renderDetail" | "pageCount">;

  /** Renditions and page text commit here; the version's own status is returned, not written. */
  async function render(ctx: TenantContext, b: Blob, v: DocumentVersion): Promise<Outcome> {
    const finish = async (
      status: DocumentVersion["renderStatus"],
      detail: string | null,
      pageCount: number | null,
    ): Promise<Outcome> => ({ renderStatus: status, renderDetail: detail, pageCount });
    // Already finished (another job got there first): nothing to render; the final write in
    // `ingest` then changes no row and records nothing.
    if (v.renderStatus !== "pending") return v;
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
      const v = loaded.version;
      const settled = await scanAndPromote(ctx, loaded.blob, input);
      if (!settled.owned) {
        // Another job holds the scan (it hands this version on when the verdict is in), or a
        // re-upload moved the blob on and queued its own ingest.
        log("data-room.ingest_deferred", {
          workspaceId: input.workspaceId,
          versionId: input.versionId,
          blobId: input.blobId,
        });
        return undefined;
      }
      const b = settled.blob;
      const outcome: Outcome =
        b.scanStatus === "infected" || b.scanStatus === "error"
          ? {
              renderStatus: "failed",
              renderDetail: b.scanStatus === "infected" ? "infected" : "not scanned",
              pageCount: null,
            }
          : await render(ctx, b, v);
      const renderStatus = outcome.renderStatus === "pending" ? "failed" : outcome.renderStatus;
      const changed = await db.withTenant(ctx, async (tx) => {
        if (input.uploadId !== undefined) {
          await new UploadRepo(ctx, tx).update(input.uploadId, { status: "completed" });
        }
        // Conditional on `pending`: when two jobs finish the same version, only the one whose
        // write changed the row records the audit entry, re-indexes and publishes.
        const finished = await new VersionRepo(ctx, tx).finishIfPending(v.id, {
          ...outcome,
          renderStatus,
        });
        if (finished === undefined) {
          log("data-room.ingest_already_final", {
            workspaceId: input.workspaceId,
            versionId: input.versionId,
          });
          return false;
        }
        const doc = await new DocumentRepo(ctx, tx).byId(v.documentId);
        await services.audit.record(tx, ctx, {
          action: "document.ingested",
          resourceKind: "document",
          resourceId: v.documentId,
          outcome:
            b.scanStatus === "infected"
              ? "denied"
              : b.scanStatus === "error"
                ? "failure"
                : "success",
          meta: {
            versionId: v.id,
            scanStatus: b.scanStatus,
            renderStatus,
            pageCount: finished.pageCount ?? null,
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
        if (b.scanStatus === "infected") {
          await publish(tx, ctx, "document.scan_infected", {
            ...(doc !== undefined ? { documentId: v.documentId, versionId: v.id } : {}),
            blobId: b.id,
            uploadedBy: v.uploadedBy ?? b.createdBy ?? null,
            signature: (b.scanDetail ?? "unknown").slice(0, 512) || "unknown",
          });
        }
        return true;
      });
      if (!changed) {
        const current = await db.withTenant(ctx, (tx) => new VersionRepo(ctx, tx).byId(v.id));
        const stored = current?.renderStatus ?? renderStatus;
        return { scanStatus: b.scanStatus, renderStatus: stored === "pending" ? "failed" : stored };
      }
      return { scanStatus: b.scanStatus, renderStatus };
    },
  };
}
