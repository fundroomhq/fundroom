import { createHash } from "node:crypto";
import { pgErrorCode, type TenantContext, type Tx } from "@fundroom/db";
import type { DataRoomSettings } from "@fundroom/domain";
import type { ModuleServices } from "@fundroom/module-kit";
import type { MultipartPart } from "@fundroom/ports";
import { isStorageError } from "@fundroom/ports";
import {
  MULTIPART_PART_BYTES,
  partCountFor,
  quarantineKey,
  UPLOAD_URL_TTL_SECONDS,
} from "@fundroom/storage";
import { type Actor, DataRoomError } from "../errors.js";
import { resolveDeclaredType, sniffBytes, typeMatches } from "../model.js";
import {
  BlobRepo,
  DocumentRepo,
  FolderRepo,
  UploadRepo,
  VersionRepo,
} from "../repos/dataroom-repo.js";
import type { Document, DocumentVersion, Upload } from "../schema/dataroom.js";
import { createSearchIndexer } from "./search.js";

/*
 * The upload pipeline's front half (EXECUTION_PLAN §8, ADR-0028 §4): the app names a
 * quarantine key, the browser streams bytes to it (presigned multipart on S3, tus through
 * the app on the filesystem), and `complete` verifies size, magic bytes and SHA-256, then
 * writes blob + document/version rows in one transaction and enqueues `data-room.ingest`,
 * which scans, sanitises, encrypts and renders. Nothing is servable before ingest says so.
 */
export const UPLOAD_TTL_MS = 24 * 3600_000;
export const INGEST_JOB = "data-room.ingest";
export const SNIFF_BYTES = 64 * 1024;

export interface StartUploadInput {
  readonly fileName: string;
  readonly size: number;
  readonly contentType: string;
  readonly folderId?: string | undefined;
  readonly documentId?: string | undefined;
  readonly changeNote?: string | undefined;
}

export interface StartedUpload {
  readonly upload: Upload;
  readonly method: "tus" | "multipart";
  readonly contentType: string;
  readonly multipart?:
    | { readonly partSize: number; readonly parts: readonly { partNumber: number; url: string }[] }
    | undefined;
  readonly tus?: { readonly path: string } | undefined;
}

export interface CompletedUpload {
  readonly upload: Upload;
  readonly document: Document;
  readonly version: DocumentVersion;
  readonly deduplicated: boolean;
}

export interface UploadService {
  start(
    ctx: TenantContext,
    input: StartUploadInput,
    actor: Actor,
    settings: DataRoomSettings,
  ): Promise<StartedUpload>;
  complete(
    ctx: TenantContext,
    id: string,
    input: { parts?: readonly MultipartPart[] | undefined },
    actor: Actor,
    settings: DataRoomSettings,
  ): Promise<CompletedUpload>;
  abort(ctx: TenantContext, id: string, actor: Actor): Promise<void>;
  get(ctx: TenantContext, id: string): Promise<Upload | undefined>;
  /** tus hook: the destination key for an upload the caller started, or undefined. */
  resolveTus(
    ctx: TenantContext,
    uploadId: string,
    membershipId: string,
  ): Promise<{ key: string; maxSize: number; contentType: string } | undefined>;
  /** tus hook: the bytes landed on the quarantine key. */
  markStored(ctx: TenantContext, uploadId: string): Promise<void>;
}

function titleOf(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/u, "").trim();
  return (base.length > 0 ? base : fileName).slice(0, 300);
}

export function createUploadService(services: ModuleServices): UploadService {
  const { db, storage } = services;
  const now = () => services.now();

  function ceilingFor(settings: DataRoomSettings): number {
    const ws = settings.maxUploadBytes ?? Number.POSITIVE_INFINITY;
    return Math.min(services.limits.uploadMaxBytes, ws);
  }

  async function audit(
    tx: Tx,
    ctx: TenantContext,
    actor: Actor,
    action: string,
    resourceKind: "document" | "upload",
    resourceId: string,
    meta: Record<string, string | number | boolean | null> = {},
  ) {
    await services.audit.record(tx, ctx, {
      action,
      resourceKind,
      resourceId,
      actorMembershipId: actor.membershipId,
      requestId: actor.requestId,
      meta,
    });
  }

  async function sniffAndHash(
    key: string,
  ): Promise<{ size: number; sha256: Buffer; sniffed: string | undefined }> {
    const read = await storage.get(key);
    if (read === undefined) throw new DataRoomError("conflict", "the upload has no bytes yet");
    const hash = createHash("sha256");
    const head: Uint8Array[] = [];
    let headBytes = 0;
    let size = 0;
    const reader = read.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      hash.update(value);
      size += value.byteLength;
      if (headBytes < SNIFF_BYTES) {
        head.push(value.subarray(0, SNIFF_BYTES - headBytes));
        headBytes += Math.min(value.byteLength, SNIFF_BYTES - headBytes);
      }
    }
    return { size, sha256: hash.digest(), sniffed: sniffBytes(Buffer.concat(head)) };
  }

  async function fail(ctx: TenantContext, up: Upload, error: string): Promise<void> {
    await db.withTenant(ctx, (tx) =>
      new UploadRepo(ctx, tx).update(up.id, { status: "failed", error }),
    );
    await storage.delete(up.storageKey).catch(() => {});
  }

  return {
    async start(ctx, input, actor, settings) {
      const contentType = resolveDeclaredType(input.contentType, input.fileName);
      if (contentType === undefined) {
        throw new DataRoomError("unsupported_media_type", "that file type is not accepted", {
          declared: input.contentType,
        });
      }
      const ceiling = ceilingFor(settings);
      if (input.size > ceiling) {
        throw new DataRoomError(
          "payload_too_large",
          "the file is larger than this workspace allows",
          {
            maxBytes: ceiling,
          },
        );
      }
      if ((input.folderId === undefined) === (input.documentId === undefined)) {
        throw new DataRoomError("validation_failed", "give either folderId or documentId", {
          issues: [{ path: "folderId", message: "exactly one target", code: "target" }],
        });
      }
      const method: "tus" | "multipart" = storage.capabilities.presignedMultipart
        ? "multipart"
        : "tus";
      const id = crypto.randomUUID();
      const key = quarantineKey(ctx.workspaceId, id);
      const t = now();
      const up = await db.withTenant(ctx, async (tx) => {
        if (input.folderId !== undefined) {
          const f = await new FolderRepo(ctx, tx).live(input.folderId);
          if (f === undefined) throw new DataRoomError("not_found", "no such folder");
        } else if (input.documentId !== undefined) {
          const d = await new DocumentRepo(ctx, tx).live(input.documentId);
          if (d === undefined) throw new DataRoomError("not_found", "no such document");
        }
        // E3.10 plan quota: the latest usage row's stored bytes + the declared sizes of the open
        // uploads + this one (approximate by design: what completed since the hourly rollup is
        // not counted; a tus create is bound to this row's declared size, so it is covered here).
        // The first call takes the quota lock (the workspace row) so the open uploads are counted
        // under it: two parallel starts serialise and the second one sees the first.
        const quota = { workspaceId: ctx.workspaceId, kind: "storageBytes" as const };
        await services.quota.check(tx, { ...quota, delta: 0 });
        const open = await new UploadRepo(ctx, tx).openDeclaredBytes(t);
        await services.quota.check(tx, { ...quota, delta: open + input.size });
        return new UploadRepo(ctx, tx).create({
          id,
          folderId: input.folderId ?? null,
          documentId: input.documentId ?? null,
          fileName: input.fileName,
          declaredSize: input.size,
          declaredType: contentType,
          changeNote: input.changeNote ?? null,
          method,
          storageKey: key,
          createdBy: actor.membershipId,
          expiresAt: new Date(t.getTime() + UPLOAD_TTL_MS),
        });
      });
      if (method === "tus")
        return { upload: up, method, contentType, tus: { path: "/data-room/uploads/tus" } };
      const mp = await storage.multipart.create(key, { contentType });
      const count = partCountFor(input.size);
      const parts = [];
      for (let n = 1; n <= count; n++) {
        parts.push({
          partNumber: n,
          url: await storage.multipart.presignPart(mp, n, {
            expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
          }),
        });
      }
      const stored = await db.withTenant(ctx, (tx) =>
        new UploadRepo(ctx, tx).update(id, { multipartUploadId: mp.uploadId }),
      );
      return {
        upload: stored ?? up,
        method,
        contentType,
        multipart: { partSize: MULTIPART_PART_BYTES, parts },
      };
    },

    async complete(ctx, id, input, actor, settings) {
      const up = await db.withTenant(ctx, (tx) => new UploadRepo(ctx, tx).byId(id));
      if (up === undefined || up.createdBy !== actor.membershipId)
        throw new DataRoomError("not_found", "no such upload");
      if (up.status === "completed") {
        throw new DataRoomError("conflict", "the upload was already completed", {
          status: up.status,
        });
      }
      if (up.status !== "pending" && up.status !== "stored") {
        throw new DataRoomError("conflict", `the upload is ${up.status}`, { status: up.status });
      }
      if (up.method === "multipart") {
        if (up.multipartUploadId === null || !input.parts || input.parts.length === 0) {
          throw new DataRoomError(
            "validation_failed",
            "multipart uploads complete with their parts",
            {
              issues: [{ path: "parts", message: "required", code: "required" }],
            },
          );
        }
        try {
          await storage.multipart.complete(
            { key: up.storageKey, uploadId: up.multipartUploadId },
            input.parts,
          );
        } catch (error) {
          if (isStorageError(error)) {
            await fail(ctx, up, `multipart complete failed: ${error.code}`);
            throw new DataRoomError("conflict", "the parts could not be assembled", {
              code: error.code,
            });
          }
          throw error;
        }
      } else if (up.status !== "stored") {
        throw new DataRoomError("conflict", "the bytes have not arrived yet", {
          status: up.status,
        });
      }

      const ceiling = ceilingFor(settings);
      const head = await storage.head(up.storageKey);
      if (head === undefined) {
        await fail(ctx, up, "object missing after upload");
        throw new DataRoomError("conflict", "the upload has no bytes");
      }
      if (head.size !== up.declaredSize || head.size > ceiling) {
        await fail(ctx, up, `size mismatch: declared ${up.declaredSize}, stored ${head.size}`);
        throw new DataRoomError("conflict", "the stored size does not match what was declared", {
          declared: up.declaredSize,
          stored: head.size,
        });
      }
      const { size, sha256, sniffed } = await sniffAndHash(up.storageKey);
      if (size !== up.declaredSize) {
        await fail(ctx, up, `size mismatch while hashing: ${size}`);
        throw new DataRoomError("conflict", "the stored size does not match what was declared");
      }
      if (!typeMatches(up.declaredType, sniffed)) {
        await fail(
          ctx,
          up,
          `type mismatch: declared ${up.declaredType}, sniffed ${sniffed ?? "unknown"}`,
        );
        throw new DataRoomError(
          "unsupported_media_type",
          "the file content does not match its declared type",
          {
            declared: up.declaredType,
            sniffed: sniffed ?? null,
          },
        );
      }

      const t = now();
      const result = await db.withTenant(ctx, async (tx) => {
        const blobs = new BlobRepo(ctx, tx);
        const docs = new DocumentRepo(ctx, tx);
        const versions = new VersionRepo(ctx, tx);
        let deduplicated = false;
        let b = await blobs.bySha256(sha256);
        if (b !== undefined) {
          if (b.scanStatus === "clean" || b.scanStatus === "skipped") {
            deduplicated = true;
          } else {
            throw new DataRoomError("conflict", "the same file is already being processed", {
              conflict: "blob",
              scanStatus: b.scanStatus,
            });
          }
        } else {
          try {
            b = await blobs.create({
              sha256,
              sizeBytes: size,
              contentType: up.declaredType,
              storageKey: up.storageKey,
              encryption: {},
              scanStatus: "pending",
              createdBy: actor.membershipId,
            });
          } catch (error) {
            if (pgErrorCode(error) === "23505")
              throw new DataRoomError("conflict", "the same file is already being processed", {
                conflict: "blob",
              });
            throw error;
          }
        }
        let document: Document;
        let created = false;
        if (up.documentId !== null) {
          const existing = await docs.live(up.documentId);
          if (existing === undefined) throw new DataRoomError("not_found", "no such document");
          document = existing;
        } else {
          if (up.folderId === null) throw new DataRoomError("conflict", "the upload has no target");
          const folder = await new FolderRepo(ctx, tx).live(up.folderId);
          if (folder === undefined) throw new DataRoomError("not_found", "no such folder");
          const siblings = await docs.inFolder(folder.id);
          document = await docs.create({
            folderId: folder.id,
            folderPath: folder.path,
            title: titleOf(up.fileName),
            sortOrder: siblings.reduce((m, s) => Math.max(m, s.sortOrder), 0) + 1,
            protection: {
              download: settings.downloadByDefault,
              watermark: settings.watermarkByDefault,
              print: false,
              forensic: settings.forensicByDefault,
            },
            createdBy: actor.membershipId,
          });
          created = true;
        }
        const version = await versions.create({
          documentId: document.id,
          versionNo: await versions.nextVersionNo(document.id),
          blobId: b.id,
          fileName: up.fileName,
          contentType: up.declaredType,
          sizeBytes: size,
          changeNote: up.changeNote,
          uploadedBy: actor.membershipId,
          createdAt: t,
        });
        const updatedDoc = await docs.update(document.id, { currentVersionId: version.id });
        // Title now; the body follows when ingest has the new version's text (a previous
        // version's text leaves the index here — it no longer describes the document).
        await createSearchIndexer(services).documents(tx, ctx, [document.id]);
        const updatedUp = await new UploadRepo(ctx, tx).update(up.id, {
          status: "completed",
          blobId: b.id,
          versionId: version.id,
          completedAt: t,
        });
        await audit(
          tx,
          ctx,
          actor,
          created ? "document.created" : "document.version_uploaded",
          "document",
          document.id,
          {
            versionId: version.id,
            versionNo: version.versionNo,
            blobId: b.id,
            sizeBytes: size,
            contentType: up.declaredType,
            deduplicated,
          },
        );
        await services.queue.sendInTransaction(
          tx,
          INGEST_JOB,
          { workspaceId: ctx.workspaceId, uploadId: up.id, versionId: version.id, blobId: b.id },
          { idempotencyKey: `ingest:${version.id}` },
        );
        return { upload: updatedUp ?? up, document: updatedDoc ?? document, version, deduplicated };
      });
      if (result.deduplicated) await storage.delete(up.storageKey).catch(() => {});
      return result;
    },

    async abort(ctx, id, actor) {
      const up = await db.withTenant(ctx, (tx) => new UploadRepo(ctx, tx).byId(id));
      if (up === undefined || up.createdBy !== actor.membershipId)
        throw new DataRoomError("not_found", "no such upload");
      if (up.status === "completed")
        throw new DataRoomError("conflict", "the upload was already completed");
      if (up.method === "multipart" && up.multipartUploadId !== null) {
        await storage.multipart
          .abort({ key: up.storageKey, uploadId: up.multipartUploadId })
          .catch(() => {});
      }
      await storage.delete(up.storageKey).catch(() => {});
      await db.withTenant(ctx, async (tx) => {
        await new UploadRepo(ctx, tx).update(id, { status: "aborted" });
        await audit(tx, ctx, actor, "upload.aborted", "upload", id);
      });
    },

    get: (ctx, id) => db.withTenant(ctx, (tx) => new UploadRepo(ctx, tx).byId(id)),

    async resolveTus(ctx, uploadId, membershipId) {
      const up = await db.withTenant(ctx, (tx) => new UploadRepo(ctx, tx).byId(uploadId));
      if (
        up === undefined ||
        up.method !== "tus" ||
        up.createdBy !== membershipId ||
        up.status !== "pending" ||
        up.expiresAt.getTime() < now().getTime()
      )
        return undefined;
      return { key: up.storageKey, maxSize: up.declaredSize, contentType: up.declaredType };
    },

    async markStored(ctx, uploadId) {
      await db.withTenant(ctx, (tx) =>
        new UploadRepo(ctx, tx).update(uploadId, { status: "stored" }),
      );
    },
  };
}
