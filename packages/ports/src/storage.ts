/**
 * Object storage (EXECUTION_PLAN §5.2 `ObjectStoragePort`, §8, ADR-0006, ADR-0015).
 * Default adapters: `@fundroom/storage-s3` (AWS SDK v3; S3, R2, B2, Garage, SeaweedFS) and
 * `@fundroom/storage-fs` (single node). Bytes live here; Postgres holds metadata only.
 *
 * Rules every adapter must honour:
 *  - keys are opaque paths chosen by the kernel (`@fundroom/storage` builds them); an
 *    adapter rejects anything outside `OBJECT_KEY_RE` and never interprets a key as a
 *    filesystem path without sandboxing it under its root;
 *  - `put` is atomic: a reader never sees a partially written object;
 *  - `delete` is idempotent; `get`/`head` return `undefined` for a missing key;
 *  - bodies are Web streams so Hono can hand them straight to a Response;
 *  - what an adapter cannot do is declared in `capabilities`, and the matching method
 *    rejects with `StorageErrorCode = "unsupported"` rather than emulating it badly.
 *
 * Upload paths (design/07 §6.4): on S3 the browser uploads directly through presigned
 * multipart URLs (`multipart.*`); on the filesystem the app proxies a resumable tus upload
 * (`@fundroom/storage-fs` `createTusUploadServer`). Both land under a quarantine key until
 * the scan/sanitise job promotes the blob (E1.3).
 */
import type { SubProcessorMeta } from "./residency.js";
export const OBJECT_KEY_RE =
  /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/u;
export const OBJECT_KEY_MAX_LENGTH = 1024;

export type StorageDriver = "s3" | "fs" | (string & {});

export interface StorageCapabilities {
  /** `presignGet` works (S3). */
  readonly presignedGet: boolean;
  /** `multipart.*` works (S3). */
  readonly presignedMultipart: boolean;
  /** The adapter ships a tus server for app-proxied uploads (filesystem). */
  readonly tus: boolean;
  /** Byte-range `get` is served natively (both default adapters). */
  readonly ranges: boolean;
}

export interface ObjectStat {
  readonly key: string;
  readonly size: number;
  /** Adapter-specific opaque identity of the content (S3 ETag, fs sha256). */
  readonly etag: string | undefined;
  readonly contentType: string | undefined;
  readonly lastModified: Date | undefined;
  /** Hex SHA-256 recorded at `put` time when the caller supplied one. */
  readonly sha256: string | undefined;
  /** User metadata (S3 `x-amz-meta-*`, fs sidecar). Small, non-PII, ASCII. */
  readonly metadata: Readonly<Record<string, string>>;
}

/** Inclusive byte range, like HTTP `Range: bytes=start-end`. */
export interface ByteRange {
  readonly start: number;
  /** Inclusive; omit for "to the end". */
  readonly end?: number | undefined;
}

export type ObjectBody = Uint8Array | ReadableStream<Uint8Array>;

export interface PutOptions {
  readonly contentType?: string | undefined;
  /** Required by S3 for streaming bodies; the fs adapter verifies it when given. */
  readonly contentLength?: number | undefined;
  /** Hex SHA-256 of the body; verified where the backend can (S3 checksum, fs digest). */
  readonly sha256?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  readonly cacheControl?: string | undefined;
}

export interface GetOptions {
  readonly range?: ByteRange | undefined;
}

export interface ObjectRead {
  readonly body: ReadableStream<Uint8Array>;
  readonly stat: ObjectStat;
  /** The range actually served (absolute, inclusive) when one was requested. */
  readonly range: (ByteRange & { readonly end: number }) | undefined;
}

export interface ListOptions {
  readonly prefix: string;
  /** Opaque token from the previous page. */
  readonly cursor?: string | undefined;
  /** Default 1000. */
  readonly limit?: number | undefined;
}

export interface ObjectPage {
  readonly objects: readonly ObjectStat[];
  /** Present when more objects follow. */
  readonly cursor: string | undefined;
}

export interface PresignGetOptions {
  /** Capped by the adapter (ADR-0015: ≤ 60 s for document delivery). */
  readonly expiresInSeconds: number;
  readonly responseContentType?: string | undefined;
  /** e.g. `attachment; filename="deck.pdf"`. */
  readonly responseContentDisposition?: string | undefined;
}

export interface MultipartCreateOptions {
  readonly contentType?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

export interface MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
}

export interface MultipartPart {
  /** 1-based, ≤ 10 000. */
  readonly partNumber: number;
  readonly etag: string;
}

export interface MultipartUploads {
  create(key: string, options?: MultipartCreateOptions): Promise<MultipartUpload>;
  /** Presigned PUT URL for one part; the client uploads the bytes there. */
  presignPart(
    upload: MultipartUpload,
    partNumber: number,
    options: { readonly expiresInSeconds: number },
  ): Promise<string>;
  complete(upload: MultipartUpload, parts: readonly MultipartPart[]): Promise<ObjectStat>;
  abort(upload: MultipartUpload): Promise<void>;
}

export type StorageErrorCode =
  | "invalid_key"
  | "not_found"
  | "unsupported"
  | "checksum_mismatch"
  | "size_mismatch"
  | "backend";

export class StorageError extends Error {
  override readonly name = "StorageError";
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options?: { readonly cause?: unknown; readonly key?: string | undefined },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.key = options?.key;
  }
  readonly key: string | undefined;
}

export function isStorageError(error: unknown, code?: StorageErrorCode): error is StorageError {
  return error instanceof StorageError && (code === undefined || error.code === code);
}

/** Throws `invalid_key` for anything an adapter must not touch (traversal, absolute, too long). */
export function assertObjectKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > OBJECT_KEY_MAX_LENGTH ||
    !OBJECT_KEY_RE.test(key)
  ) {
    throw new StorageError("invalid_key", `invalid object key ${JSON.stringify(key)}`, { key });
  }
}

export interface ObjectStoragePort {
  readonly driver: StorageDriver;
  /**
   * E3.11: the third party this adapter sends tenant data to, for the residency page and the
   * DPA's sub-processor list. `null` = none (the operator's own infrastructure); absent = the
   * adapter does not say (test doubles).
   */
  readonly subProcessor?: SubProcessorMeta | null | undefined;
  readonly capabilities: StorageCapabilities;
  put(key: string, body: ObjectBody, options?: PutOptions): Promise<ObjectStat>;
  get(key: string, options?: GetOptions): Promise<ObjectRead | undefined>;
  head(key: string): Promise<ObjectStat | undefined>;
  delete(key: string): Promise<void>;
  deleteMany(keys: readonly string[]): Promise<void>;
  /** Server-side copy where the backend supports it; keeps content type and metadata. */
  copy(sourceKey: string, destinationKey: string): Promise<ObjectStat>;
  list(options: ListOptions): Promise<ObjectPage>;
  presignGet(key: string, options: PresignGetOptions): Promise<string>;
  readonly multipart: MultipartUploads;
  /** Cheap liveness probe for `/readyz` (bucket HEAD, root dir writable). */
  healthCheck(): Promise<void>;
}
