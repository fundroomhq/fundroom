import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  assertObjectKey,
  type ByteRange,
  type GetOptions,
  isStorageError,
  type ListOptions,
  type MultipartCreateOptions,
  type MultipartPart,
  type MultipartUpload,
  type MultipartUploads,
  type ObjectBody,
  type ObjectPage,
  type ObjectRead,
  type ObjectStat,
  type ObjectStoragePort,
  type PresignGetOptions,
  type PutOptions,
  type StorageCapabilities,
  StorageError,
} from "@fundroom/ports";
import { s3SubProcessor } from "./sub-processor.js";

/*
 * `ObjectStoragePort` over the AWS SDK v3 (ADR-0006). One adapter serves S3, Cloudflare R2,
 * Backblaze B2, Garage and SeaweedFS: everything goes through the S3 API with
 * `requestChecksumCalculation: WHEN_REQUIRED`, because the SDK's newer default of adding
 * CRC32 trailers to every request is rejected by most S3-compatibles. Integrity comes from
 * the caller's `sha256`: it is sent as `ChecksumSHA256` (verified in flight by S3 proper),
 * recomputed by the adapter while the body streams (backends such as SeaweedFS ignore the
 * header; a mismatch deletes the just-written object), and recorded as user metadata so
 * `head` returns it on every backend.
 *
 * Delivery (ADR-0015): `presignGet` is capped at 60 s; document bytes normally stream
 * through the app. Uploads go straight from the browser through presigned multipart URLs
 * to a quarantine key (design/07 §6.4).
 */
export interface S3StorageOptions {
  readonly bucket: string;
  readonly region?: string | undefined;
  /** Non-AWS endpoint (R2, Garage, SeaweedFS, MinIO). */
  readonly endpoint?: string | undefined;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Required by most self-hosted backends; virtual-hosted style is the AWS default. */
  readonly forcePathStyle?: boolean | undefined;
  /** Prepended to every key, e.g. `fundroom/` when sharing a bucket. */
  readonly keyPrefix?: string | undefined;
  /** Hard cap for `presignGet`. Default 60 s (ADR-0015). */
  readonly presignGetMaxSeconds?: number | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  /**
   * TCP (+TLS) connect bound per attempt. Default 5 s. The AWS SDK's own default is **none**:
   * an endpoint that swallows SYNs hangs the call forever (E2.10 fault tests).
   */
  readonly connectionTimeoutMs?: number | undefined;
  /**
   * Socket-idle bound per attempt: no byte in either direction for this long fails the attempt.
   * Default 30 s. The SDK's default is none, so a black-holed or wedged endpoint — one that
   * accepted the connection and then went silent, including a stale keep-alive socket a load
   * balancer dropped — hung every request, and `/readyz`'s storage probe, forever. It is an idle
   * bound, not a total one, so a large upload that keeps moving is never cut off.
   */
  readonly socketTimeoutMs?: number | undefined;
  /**
   * Attempts per call (the SDK retries timeouts and 5xx with backoff). Default 2: one retry is
   * what rescues a dead keep-alive socket; more only multiplies the worst case, which is
   * `maxAttempts × (connectionTimeoutMs + socketTimeoutMs)` plus backoff.
   */
  readonly maxAttempts?: number | undefined;
}

export const DEFAULT_S3_CONNECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_S3_SOCKET_TIMEOUT_MS = 30_000;
export const DEFAULT_S3_MAX_ATTEMPTS = 2;

export interface S3Storage extends ObjectStoragePort {
  readonly bucket: string;
  /** The underlying client, for tests and ops tooling; not for application code. */
  readonly client: S3Client;
}

export const PRESIGN_GET_MAX_SECONDS = 60;
const SHA256_META = "sha256";
const SHA256_RE = /^[0-9a-f]{64}$/iu;
const DELETE_BATCH = 1000;

const CAPABILITIES: StorageCapabilities = Object.freeze({
  presignedGet: true,
  presignedMultipart: true,
  tus: false,
  ranges: true,
});

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.name === "NoSuchUpload" ||
    e.$metadata?.httpStatusCode === 404
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function backend(key: string | undefined, error: unknown): StorageError {
  if (isStorageError(error)) return error;
  const e = error as { name?: string };
  if (
    e?.name === "BadDigest" ||
    e?.name === "InvalidDigest" ||
    e?.name === "XAmzContentSHA256Mismatch"
  ) {
    return new StorageError("checksum_mismatch", "sha256 of the body does not match", {
      cause: error,
      key,
    });
  }
  return new StorageError("backend", `s3 storage failed: ${errorMessage(error)}`, {
    cause: error,
    key,
  });
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

function parseContentRange(header: string | undefined): (ByteRange & { end: number }) | undefined {
  const m = header === undefined ? null : /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(header);
  if (!m) return undefined;
  return { start: Number(m[1]), end: Number(m[2]) };
}

function toWebStream(body: unknown): ReadableStream<Uint8Array> {
  if (body instanceof Readable) {
    return Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>;
  }
  if (
    body &&
    typeof (body as { transformToWebStream?: unknown }).transformToWebStream === "function"
  ) {
    return (body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream();
  }
  if (body instanceof ReadableStream) return body as ReadableStream<Uint8Array>;
  throw new StorageError("backend", "unexpected S3 body type");
}

export function createS3Storage(options: S3StorageOptions): S3Storage {
  const log = options.log ?? (() => {});
  const bucket = options.bucket;
  const prefix = options.keyPrefix ?? "";
  if (prefix !== "" && !prefix.endsWith("/")) {
    throw new StorageError("invalid_key", "keyPrefix must end with a slash");
  }
  const presignMax = options.presignGetMaxSeconds ?? PRESIGN_GET_MAX_SECONDS;

  const config: S3ClientConfig = {
    region: options.region ?? "auto",
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    forcePathStyle: options.forcePathStyle ?? options.endpoint !== undefined,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    maxAttempts: options.maxAttempts ?? DEFAULT_S3_MAX_ATTEMPTS,
    requestHandler: {
      connectionTimeout: options.connectionTimeoutMs ?? DEFAULT_S3_CONNECTION_TIMEOUT_MS,
      socketTimeout: options.socketTimeoutMs ?? DEFAULT_S3_SOCKET_TIMEOUT_MS,
    },
  };
  const client = new S3Client(config);

  const full = (key: string): string => {
    assertObjectKey(key);
    return `${prefix}${key}`;
  };
  const strip = (fullKey: string): string =>
    fullKey.startsWith(prefix) ? fullKey.slice(prefix.length) : fullKey;

  function statFrom(
    key: string,
    out: Pick<
      HeadObjectCommandOutput,
      "ContentLength" | "ETag" | "ContentType" | "LastModified" | "Metadata"
    >,
  ): ObjectStat {
    const metadata: Record<string, string> = {};
    let sha256: string | undefined;
    for (const [k, v] of Object.entries(out.Metadata ?? {})) {
      if (v === undefined) continue;
      if (k.toLowerCase() === SHA256_META) sha256 = v;
      else metadata[k] = v;
    }
    return {
      key,
      size: out.ContentLength ?? 0,
      etag: out.ETag?.replace(/^"|"$/gu, ""),
      contentType: out.ContentType,
      lastModified: out.LastModified,
      sha256,
      metadata,
    };
  }

  async function head(key: string): Promise<ObjectStat | undefined> {
    const Key = full(key);
    try {
      const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key }));
      return statFrom(key, out);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw backend(key, error);
    }
  }

  async function put(key: string, body: ObjectBody, opts: PutOptions = {}): Promise<ObjectStat> {
    const Key = full(key);
    if (opts.sha256 !== undefined && !SHA256_RE.test(opts.sha256)) {
      throw new StorageError("checksum_mismatch", "sha256 must be 64 hex characters", { key });
    }
    const isBytes = body instanceof Uint8Array;
    if (!isBytes && opts.contentLength === undefined) {
      throw new StorageError(
        "size_mismatch",
        "s3 storage needs contentLength for a streaming body (or pass the bytes)",
        { key },
      );
    }
    const length = isBytes ? body.byteLength : (opts.contentLength as number);
    if (isBytes && opts.contentLength !== undefined && opts.contentLength !== length) {
      throw new StorageError(
        "size_mismatch",
        `expected ${opts.contentLength} bytes, got ${length}`,
        {
          key,
        },
      );
    }
    const sha = opts.sha256?.toLowerCase();
    if (isBytes && sha !== undefined) {
      const actual = createHash("sha256").update(body).digest("hex");
      if (actual !== sha) {
        throw new StorageError("checksum_mismatch", "sha256 of the body does not match", { key });
      }
    }
    const hash = createHash("sha256");
    const hashing = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key,
          Body: isBytes
            ? body
            : Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(
                hashing,
              ),
          ContentLength: length,
          ...(opts.contentType !== undefined ? { ContentType: opts.contentType } : {}),
          ...(opts.cacheControl !== undefined ? { CacheControl: opts.cacheControl } : {}),
          ...(sha !== undefined ? { ChecksumSHA256: hexToBase64(sha) } : {}),
          Metadata: {
            ...(opts.metadata ?? {}),
            ...(sha !== undefined ? { [SHA256_META]: sha } : {}),
          },
        }),
      );
    } catch (error) {
      throw backend(key, error);
    }
    if (!isBytes && sha !== undefined && hash.digest("hex") !== sha) {
      // The backend did not enforce ChecksumSHA256; undo the write ourselves.
      await del(key).catch(() => {});
      throw new StorageError("checksum_mismatch", "sha256 of the body does not match", { key });
    }
    log("storage.put", { driver: "s3", key, size: length });
    const stat = await head(key);
    if (!stat) throw new StorageError("backend", `object vanished after put: ${key}`, { key });
    return stat;
  }

  async function get(key: string, opts: GetOptions = {}): Promise<ObjectRead | undefined> {
    const Key = full(key);
    const range = opts.range;
    if (range !== undefined) {
      if (!Number.isInteger(range.start) || range.start < 0) {
        throw new StorageError("backend", "range start must be a non-negative integer", { key });
      }
      if (range.end !== undefined && range.end < range.start) {
        throw new StorageError("backend", "range end precedes start", { key });
      }
    }
    try {
      const out = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key,
          ...(range !== undefined
            ? { Range: `bytes=${range.start}-${range.end === undefined ? "" : range.end}` }
            : {}),
        }),
      );
      const served = range === undefined ? undefined : parseContentRange(out.ContentRange);
      const totalSize =
        range === undefined
          ? (out.ContentLength ?? 0)
          : Number(/\/(\d+)$/u.exec(out.ContentRange ?? "")?.[1] ?? out.ContentLength ?? 0);
      if (range !== undefined) {
        if (served === undefined) {
          throw new StorageError("backend", "backend ignored the range request", { key });
        }
        if (served.end < served.start || served.start >= totalSize) {
          // Some backends answer 200 with an empty body instead of 416.
          await out.Body?.transformToByteArray().catch(() => {});
          throw new StorageError("backend", `range ${JSON.stringify(range)} is not satisfiable`, {
            key,
          });
        }
      }
      const stat = { ...statFrom(key, out), size: totalSize };
      return { body: toWebStream(out.Body), stat, range: served };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e?.name === "InvalidRange" || e?.$metadata?.httpStatusCode === 416) {
        throw new StorageError("backend", `range ${JSON.stringify(range)} is not satisfiable`, {
          cause: error,
          key,
        });
      }
      throw backend(key, error);
    }
  }

  async function del(key: string): Promise<void> {
    const Key = full(key);
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
    } catch (error) {
      if (isNotFound(error)) return;
      throw backend(key, error);
    }
  }

  async function deleteMany(keys: readonly string[]): Promise<void> {
    const Keys = keys.map(full);
    for (let i = 0; i < Keys.length; i += DELETE_BATCH) {
      const batch = Keys.slice(i, i + DELETE_BATCH);
      try {
        const out = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        const failed = (out.Errors ?? []).filter((e) => e.Code !== "NoSuchKey");
        if (failed.length > 0) {
          throw new StorageError(
            "backend",
            `deleteMany: ${failed.length} objects failed (${failed[0]?.Code ?? "?"}: ${failed[0]?.Message ?? ""})`,
            { key: failed[0]?.Key === undefined ? undefined : strip(failed[0].Key) },
          );
        }
      } catch (error) {
        throw backend(undefined, error);
      }
    }
  }

  async function copy(sourceKey: string, destinationKey: string): Promise<ObjectStat> {
    const source = full(sourceKey);
    const Key = full(destinationKey);
    // Backends disagree on the error for a missing source (S3: NoSuchKey, SeaweedFS:
    // InvalidArgument); one HEAD gives every caller the same `not_found`.
    if ((await head(sourceKey)) === undefined) {
      throw new StorageError("not_found", `no object at ${sourceKey}`, { key: sourceKey });
    }
    try {
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key,
          CopySource: `${bucket}/${source.split("/").map(encodeURIComponent).join("/")}`,
          MetadataDirective: "COPY",
        }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw new StorageError("not_found", `no object at ${sourceKey}`, {
          cause: error,
          key: sourceKey,
        });
      }
      throw backend(destinationKey, error);
    }
    const stat = await head(destinationKey);
    if (!stat) throw new StorageError("backend", `copy produced no object at ${destinationKey}`);
    return stat;
  }

  async function list(opts: ListOptions): Promise<ObjectPage> {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 1000));
    if (opts.prefix.includes("..") || opts.prefix.startsWith("/")) {
      throw new StorageError("invalid_key", `invalid prefix ${JSON.stringify(opts.prefix)}`);
    }
    try {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `${prefix}${opts.prefix}`,
          MaxKeys: limit,
          ...(opts.cursor !== undefined ? { ContinuationToken: opts.cursor } : {}),
        }),
      );
      const objects: ObjectStat[] = (out.Contents ?? [])
        .filter((o) => o.Key !== undefined)
        .map((o) => ({
          key: strip(o.Key as string),
          size: o.Size ?? 0,
          etag: o.ETag?.replace(/^"|"$/gu, ""),
          contentType: undefined,
          lastModified: o.LastModified,
          sha256: undefined,
          metadata: {},
        }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return {
        objects,
        cursor: out.IsTruncated ? out.NextContinuationToken : undefined,
      };
    } catch (error) {
      throw backend(undefined, error);
    }
  }

  async function presignGet(key: string, opts: PresignGetOptions): Promise<string> {
    const Key = full(key);
    const expiresIn = Math.max(1, Math.min(Math.floor(opts.expiresInSeconds), presignMax));
    try {
      return await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key,
          ...(opts.responseContentType !== undefined
            ? { ResponseContentType: opts.responseContentType }
            : {}),
          ...(opts.responseContentDisposition !== undefined
            ? { ResponseContentDisposition: opts.responseContentDisposition }
            : {}),
        }),
        { expiresIn },
      );
    } catch (error) {
      throw backend(key, error);
    }
  }

  const multipart: MultipartUploads = {
    async create(key: string, opts: MultipartCreateOptions = {}): Promise<MultipartUpload> {
      const Key = full(key);
      try {
        const out = await client.send(
          new CreateMultipartUploadCommand({
            Bucket: bucket,
            Key,
            ...(opts.contentType !== undefined ? { ContentType: opts.contentType } : {}),
            ...(opts.metadata !== undefined ? { Metadata: { ...opts.metadata } } : {}),
          }),
        );
        if (!out.UploadId) throw new StorageError("backend", "no UploadId returned", { key });
        return { key, uploadId: out.UploadId };
      } catch (error) {
        throw backend(key, error);
      }
    },
    async presignPart(upload, partNumber, opts): Promise<string> {
      const Key = full(upload.key);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
        throw new StorageError("backend", "partNumber must be 1..10000", { key: upload.key });
      }
      try {
        return await getSignedUrl(
          client,
          new UploadPartCommand({
            Bucket: bucket,
            Key,
            UploadId: upload.uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: Math.max(1, Math.floor(opts.expiresInSeconds)) },
        );
      } catch (error) {
        throw backend(upload.key, error);
      }
    },
    async complete(upload, parts: readonly MultipartPart[]): Promise<ObjectStat> {
      const Key = full(upload.key);
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      try {
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key,
            UploadId: upload.uploadId,
            MultipartUpload: {
              Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
            },
          }),
        );
      } catch (error) {
        throw backend(upload.key, error);
      }
      const stat = await head(upload.key);
      if (!stat)
        throw new StorageError("backend", `multipart complete produced no object`, {
          key: upload.key,
        });
      log("storage.multipart_complete", { driver: "s3", key: upload.key, size: stat.size });
      return stat;
    },
    async abort(upload): Promise<void> {
      const Key = full(upload.key);
      try {
        await client.send(
          new AbortMultipartUploadCommand({ Bucket: bucket, Key, UploadId: upload.uploadId }),
        );
      } catch (error) {
        if (isNotFound(error)) return;
        throw backend(upload.key, error);
      }
    },
  };

  return {
    driver: "s3",
    subProcessor: s3SubProcessor({ region: options.region, endpoint: options.endpoint }),
    capabilities: CAPABILITIES,
    bucket,
    client,
    put,
    get,
    head,
    delete: del,
    deleteMany,
    copy,
    list,
    presignGet,
    multipart,
    async healthCheck(): Promise<void> {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        throw new StorageError(
          "backend",
          `bucket ${bucket} is not reachable: ${errorMessage(error)}`,
          {
            cause: error,
          },
        );
      }
    },
  };
}
