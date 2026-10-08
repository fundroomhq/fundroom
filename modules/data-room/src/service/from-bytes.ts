import { createHash } from "node:crypto";
import type { TenantContext, Tx } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { quarantineKey } from "@fundroom/storage";
import { type Protection, sniffBytes } from "../model.js";
import { BlobRepo, DocumentRepo, VersionRepo } from "../repos/dataroom-repo.js";
import type { Document, DocumentVersion, Folder } from "../schema/dataroom.js";
import { INGEST_JOB, SNIFF_BYTES } from "./uploads.js";

/*
 * `createDocumentFromBytes` (E3.5): the upload pipeline's front half for bytes the server already
 * holds — a vaulted e-signature artifact — with no upload row and no client. Same shape as
 * `uploads.complete`: the bytes land on a quarantine key first (plaintext, like a client upload),
 * then blob + document + version rows and the `data-room.ingest` job commit together, and ingest
 * scans, encrypts into the content-addressed blob key, sanitises, renders and indexes the text —
 * exactly as for an upload (`IngestInput.uploadId` is optional for this reason). Nothing is
 * servable before ingest says so.
 *
 * Two steps because object storage is not transactional: `stageBytes` runs OUTSIDE any
 * transaction (a storage write), `createDocumentFromStaged` INSIDE the caller's. The caller deletes
 * the staged object when the transaction rolls back or the blob was deduplicated
 * (`discardStaged`).
 */
export interface StagedBytes {
  /** `ws/<ws>/quarantine/<uuid>`: plaintext, like a client upload before ingest. */
  readonly key: string;
  readonly sha256: Buffer;
  readonly size: number;
  /** The sniffed type (magic bytes), never a declared one. */
  readonly contentType: string;
}

export async function stageBytes(
  services: Pick<ModuleServices, "storage">,
  workspaceId: string,
  bytes: Uint8Array,
): Promise<StagedBytes | undefined> {
  const contentType = sniffBytes(bytes.subarray(0, SNIFF_BYTES));
  if (contentType === undefined) return undefined;
  const key = quarantineKey(workspaceId, crypto.randomUUID());
  const sha256 = createHash("sha256").update(bytes).digest();
  await services.storage.put(key, bytes, {
    contentType,
    contentLength: bytes.byteLength,
    sha256: sha256.toString("hex"),
  });
  return { key, sha256, size: bytes.byteLength, contentType };
}

/** Best effort: a leftover quarantine object is found by the weekly reconciler anyway. */
export async function discardStaged(
  services: Pick<ModuleServices, "storage">,
  staged: readonly (StagedBytes | undefined)[],
): Promise<void> {
  for (const s of staged) if (s !== undefined) await services.storage.delete(s.key).catch(() => {});
}

export interface FromBytesInput {
  readonly folder: Pick<Folder, "id" | "path">;
  readonly staged: StagedBytes;
  readonly title: string;
  readonly fileName: string;
  readonly protection: Protection;
  /** Legal hold set at creation (`legal_hold_set_by` stays null: the system set it). */
  readonly legalHoldReason?: string | undefined;
  /** The vault's dedupe key (partial unique `document_esign_envelope_idx`). */
  readonly esignEnvelopeId?: string | undefined;
  readonly createdBy: string | null;
  readonly now: Date;
}

export interface FromBytesResult {
  readonly document: Document;
  readonly version: DocumentVersion;
  /** A servable blob with the same bytes already existed; the staged object is now surplus. */
  readonly deduplicated: boolean;
}

export class BlobNotReadyError extends Error {
  override readonly name = "BlobNotReadyError";
}

/**
 * Blob (content-addressed, deduplicated against a servable one), document, version 1, and the
 * ingest job — on the caller's transaction. A blob with the same bytes that is still in the scan
 * pipeline (or failed it) is not reused: `BlobNotReadyError`, so a job retries once the other
 * ingest has finished rather than racing it.
 */
export async function createDocumentFromStaged(
  services: Pick<ModuleServices, "queue">,
  tx: Tx,
  ctx: TenantContext,
  input: FromBytesInput,
): Promise<FromBytesResult> {
  const blobs = new BlobRepo(ctx, tx);
  const docs = new DocumentRepo(ctx, tx);
  const versions = new VersionRepo(ctx, tx);
  let b = await blobs.bySha256(input.staged.sha256);
  let deduplicated = false;
  if (b !== undefined) {
    if (b.scanStatus !== "clean" && b.scanStatus !== "skipped")
      throw new BlobNotReadyError(`blob ${b.id} with the same bytes is ${b.scanStatus}`);
    deduplicated = true;
  } else {
    b = await blobs.create({
      sha256: input.staged.sha256,
      sizeBytes: input.staged.size,
      contentType: input.staged.contentType,
      storageKey: input.staged.key,
      encryption: {},
      scanStatus: "pending",
      createdBy: input.createdBy,
    });
  }
  const siblings = await docs.inFolder(input.folder.id);
  const held = input.legalHoldReason !== undefined;
  const created = await docs.create({
    folderId: input.folder.id,
    folderPath: input.folder.path,
    title: input.title,
    sortOrder: siblings.reduce((m, s) => Math.max(m, s.sortOrder), 0) + 1,
    protection: input.protection,
    legalHold: held,
    legalHoldReason: input.legalHoldReason ?? null,
    legalHoldSetBy: null,
    legalHoldSetAt: held ? input.now : null,
    esignEnvelopeId: input.esignEnvelopeId ?? null,
    createdBy: input.createdBy,
  });
  const version = await versions.create({
    documentId: created.id,
    versionNo: 1,
    blobId: b.id,
    fileName: input.fileName,
    contentType: input.staged.contentType,
    sizeBytes: input.staged.size,
    changeNote: null,
    uploadedBy: input.createdBy,
    createdAt: input.now,
  });
  const document = (await docs.update(created.id, { currentVersionId: version.id })) ?? created;
  await services.queue.sendInTransaction(
    tx,
    INGEST_JOB,
    { workspaceId: ctx.workspaceId, versionId: version.id, blobId: b.id },
    { idempotencyKey: `ingest:${version.id}` },
  );
  return { document, version, deduplicated };
}
