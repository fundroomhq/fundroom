import type { FundRoomSchemas } from "@fundroom/sdk";
import { api, apiBase, call } from "./api.js";

/*
 * Browser side of the upload pipeline (EXECUTION_PLAN §8, ADR-0028 §4). `POST /uploads`
 * decides the transport: tus through the app (filesystem driver) or presigned multipart
 * PUTs straight to object storage (S3). Either way the server named the destination; we
 * only move bytes and then call `complete`, which verifies size, magic bytes and SHA-256.
 */
export const TUS_CHUNK_BYTES = 8 * 1024 * 1024;

export interface UploadTarget {
  readonly folderId?: string | undefined;
  readonly documentId?: string | undefined;
  readonly changeNote?: string | undefined;
}

export interface UploadOptions extends UploadTarget {
  readonly onProgress?: ((sent: number, total: number) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type UploadStart = FundRoomSchemas["DataRoomUploadStart"];
export type UploadComplete = FundRoomSchemas["DataRoomUploadComplete"];

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

async function tusUpload(
  file: File,
  start: UploadStart,
  tusPath: string,
  options: UploadOptions,
): Promise<void> {
  const base = `${apiBase()}/api/v1${tusPath}`;
  const id = start.upload.id;
  const metadata = [
    `upload ${b64(id)}`,
    `filename ${b64(file.name)}`,
    `filetype ${b64(start.upload.contentType)}`,
  ].join(",");
  const created = await fetch(base, {
    method: "POST",
    credentials: "include",
    signal: options.signal ?? null,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(file.size),
      "Upload-Metadata": metadata,
    },
  });
  if (created.status !== 201) throw new Error(`tus create failed: HTTP ${created.status}`);
  let offset = 0;
  while (offset < file.size || (file.size === 0 && offset === 0)) {
    const chunk = file.slice(offset, Math.min(file.size, offset + TUS_CHUNK_BYTES));
    const res = await fetch(`${base}/${id}`, {
      method: "PATCH",
      credentials: "include",
      signal: options.signal ?? null,
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream",
      },
      body: chunk,
    });
    if (res.status !== 204) throw new Error(`tus patch failed: HTTP ${res.status}`);
    const next = Number(res.headers.get("upload-offset") ?? offset + chunk.size);
    offset = Number.isFinite(next) && next > offset ? next : offset + chunk.size;
    options.onProgress?.(Math.min(offset, file.size), file.size);
    if (file.size === 0) break;
  }
}

async function multipartUpload(
  file: File,
  parts: NonNullable<UploadStart["multipart"]>,
  options: UploadOptions,
): Promise<{ partNumber: number; etag: string }[]> {
  const out: { partNumber: number; etag: string }[] = [];
  let sent = 0;
  for (const part of parts.parts) {
    const from = (part.partNumber - 1) * parts.partSize;
    const chunk = file.slice(from, Math.min(file.size, from + parts.partSize));
    const res = await fetch(part.url, {
      method: "PUT",
      body: chunk,
      signal: options.signal ?? null,
    });
    if (!res.ok) throw new Error(`part ${part.partNumber} failed: HTTP ${res.status}`);
    const etag = res.headers.get("etag") ?? "";
    if (etag === "") throw new Error(`part ${part.partNumber}: storage returned no ETag`);
    out.push({ partNumber: part.partNumber, etag });
    sent += chunk.size;
    options.onProgress?.(sent, file.size);
  }
  return out;
}

/** Uploads one file as a new document (folderId) or a new version (documentId). */
export async function uploadFile(file: File, options: UploadOptions): Promise<UploadComplete> {
  const start = await call(
    api().POST("/data-room/uploads", {
      body: {
        fileName: file.name,
        size: file.size,
        contentType: file.type || "application/octet-stream",
        ...(options.folderId ? { folderId: options.folderId } : {}),
        ...(options.documentId ? { documentId: options.documentId } : {}),
        ...(options.changeNote ? { changeNote: options.changeNote } : {}),
      },
    }),
  );
  const id = start.upload.id;
  try {
    let parts: { partNumber: number; etag: string }[] | undefined;
    if (start.method === "multipart" && start.multipart) {
      parts = await multipartUpload(file, start.multipart, options);
    } else if (start.tus) {
      await tusUpload(file, start, start.tus.path, options);
    } else {
      throw new Error("the server offered no upload transport");
    }
    return await call(
      api().POST("/data-room/uploads/{id}/complete", {
        params: { path: { id } },
        body: parts ? { parts } : {},
      }),
    );
  } catch (error) {
    await api()
      .DELETE("/data-room/uploads/{id}", { params: { path: { id } } })
      .catch(() => undefined);
    throw error;
  }
}
