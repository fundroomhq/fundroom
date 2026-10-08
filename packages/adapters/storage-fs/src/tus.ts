import { Readable } from "node:stream";
import { assertObjectKey, type ObjectStat, type ObjectStoragePort } from "@fundroom/ports";
import { FileStore } from "@tus/file-store";
import { Server } from "@tus/server";

/*
 * Resumable uploads through the app for the filesystem driver (ADR-0006, ADR-0015,
 * design/07 §1.2, §6.4). S3 installs let the browser upload straight to the bucket through
 * presigned multipart URLs; a single-node install has no such endpoint, so the tus protocol
 * (`@tus/server`, `handleWeb`) does the same job over the app's own HTTP.
 *
 * Trust model: the *app* names the upload. `POST /api/v1/uploads` (E1.3) creates the upload
 * row and hands the client an upload id; the tus client then creates the upload here with
 * `Upload-Metadata: upload <base64 id>` and PATCHes bytes to `<path>/<id>`. Every request is
 * mapped back through `resolveUpload(request, id)`, which returns the destination key (never
 * chosen by the client) and the size ceiling, or `undefined` → 404. When the last byte lands,
 * the staged file streams into `storage.put(key)` (quarantine key; the scan job promotes it),
 * the staging copy is removed and `onUploadFinish` fires with the resulting `ObjectStat`.
 */
export interface ResolvedTusUpload {
  /** Destination key, normally `quarantineKey(ws, uploadId)`. */
  readonly key: string;
  /** Per-upload ceiling in bytes; the server default applies when absent. */
  readonly maxSize?: number | undefined;
  /** Content type to record; declared type from the client is metadata only. */
  readonly contentType?: string | undefined;
}

export interface TusUploadFinished {
  readonly uploadId: string;
  readonly key: string;
  readonly stat: ObjectStat;
}

export interface TusUploadServerOptions {
  readonly storage: ObjectStoragePort;
  /** Where in-flight uploads are staged; keep it on the same filesystem as `storage`'s root. */
  readonly stagingDir: string;
  /** Route prefix the app mounts the handler at, e.g. `/api/v1/uploads/tus`. */
  readonly path: string;
  /** Default ceiling in bytes (`UPLOAD_MAX_BYTES`). 0 = unlimited. */
  readonly maxSize?: number | undefined;
  /** Unfinished uploads older than this are removed by `cleanupExpired()`. Default 24 h. */
  readonly expirationMs?: number | undefined;
  readonly resolveUpload: (
    request: Request,
    uploadId: string,
  ) => Promise<ResolvedTusUpload | undefined>;
  readonly onUploadFinish?: ((upload: TusUploadFinished) => Promise<void>) | undefined;
  /** CORS origins allowed to talk tus (the embed host pages). Default: same-origin only. */
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export interface TusUploadServer {
  handle(request: Request): Promise<Response>;
  /** Deletes staged uploads past `expirationMs`; returns how many. Schedule from a job. */
  cleanupExpired(): Promise<number>;
  close(): Promise<void>;
}

/** Upload ids are UUIDs minted by the app (`core.uuidv7()`). */
export const TUS_UPLOAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const CONTENT_TYPE_RE = /^[\w.+-]+\/[\w.+-]+$/u;

interface TusHttpError {
  readonly status_code: number;
  readonly body: string;
}

function httpError(status_code: number, body: string): TusHttpError {
  return { status_code, body: `${body}\n` };
}

export function createTusUploadServer(options: TusUploadServerOptions): TusUploadServer {
  const log = options.log ?? (() => {});
  const defaultMax = options.maxSize ?? 0;
  const resolved = new WeakMap<Request, Map<string, Promise<ResolvedTusUpload | undefined>>>();

  function resolveOnce(req: Request, id: string): Promise<ResolvedTusUpload | undefined> {
    let byId = resolved.get(req);
    if (!byId) {
      byId = new Map();
      resolved.set(req, byId);
    }
    let pending = byId.get(id);
    if (!pending) {
      pending = options.resolveUpload(req, id);
      byId.set(id, pending);
    }
    return pending;
  }

  async function requireUpload(req: Request, id: string): Promise<ResolvedTusUpload> {
    if (!TUS_UPLOAD_ID_RE.test(id)) throw httpError(404, "unknown upload");
    const found = await resolveOnce(req, id);
    if (!found) throw httpError(404, "unknown upload");
    assertObjectKey(found.key);
    return found;
  }

  const store = new FileStore({
    directory: options.stagingDir,
    expirationPeriodInMilliseconds: options.expirationMs ?? 24 * 3600_000,
  });

  const server = new Server({
    path: options.path,
    datastore: store,
    relativeLocation: true,
    respectForwardedHeaders: false,
    ...(options.allowedOrigins ? { allowedOrigins: [...options.allowedOrigins] } : {}),
    maxSize: async (req, id) => {
      if (id === null) return defaultMax;
      const upload = await resolveOnce(req, id);
      return upload?.maxSize ?? defaultMax;
    },
    namingFunction: (_req, metadata) => {
      const id = metadata?.["upload"];
      if (typeof id !== "string" || !TUS_UPLOAD_ID_RE.test(id)) {
        throw httpError(400, "Upload-Metadata must carry the upload id issued by POST /uploads");
      }
      return id.toLowerCase();
    },
    getFileIdFromRequest: (_req, lastPath) =>
      lastPath !== undefined && TUS_UPLOAD_ID_RE.test(lastPath)
        ? lastPath.toLowerCase()
        : undefined,
    onIncomingRequest: async (req, id) => {
      await requireUpload(req, id);
    },
    onUploadCreate: async (req, upload) => {
      const found = await requireUpload(req, upload.id);
      const ceiling = found.maxSize ?? defaultMax;
      if (upload.size !== undefined && ceiling > 0 && upload.size > ceiling) {
        throw httpError(413, "Maximum size exceeded");
      }
      return {};
    },
    onUploadFinish: async (req, upload) => {
      const found = await requireUpload(req, upload.id);
      const declared = upload.metadata?.["filetype"];
      const contentType =
        found.contentType ??
        (typeof declared === "string" && CONTENT_TYPE_RE.test(declared)
          ? declared
          : "application/octet-stream");
      const size = upload.size ?? upload.offset;
      const body = Readable.toWeb(store.read(upload.id)) as unknown as ReadableStream<Uint8Array>;
      let stat: ObjectStat;
      try {
        stat = await options.storage.put(found.key, body, { contentLength: size, contentType });
      } catch (error) {
        log("tus.put_failed", {
          uploadId: upload.id,
          key: found.key,
          error: error instanceof Error ? error.message : String(error),
        });
        throw httpError(500, "failed to store the upload");
      }
      // Data file and the configstore entry go together; a failure here only leaves garbage.
      await store.remove(upload.id).catch(() => {});
      log("tus.finished", { uploadId: upload.id, key: found.key, size: stat.size });
      await options.onUploadFinish?.({ uploadId: upload.id, key: found.key, stat });
      return { status_code: 204 };
    },
  });

  return {
    handle: (request) => server.handleWeb(request),
    cleanupExpired: () => server.cleanUpExpiredUploads(),
    async close() {
      // MemoryLocker and FileStore hold no handles between requests; nothing to release.
    },
  };
}
