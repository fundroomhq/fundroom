import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import {
  access,
  copyFile,
  constants as fsConstants,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  assertObjectKey,
  type ByteRange,
  type GetOptions,
  isStorageError,
  type ListOptions,
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

/*
 * `ObjectStoragePort` over a local directory (ADR-0006: the single-node default; design/07
 * §1.2 documents the ceiling — one node, no CDN, uploads proxied through the app via tus).
 *
 * Layout under `root`:
 *   objects/<key>        the bytes
 *   meta/<key>.json      content type, user metadata, size, sha256, etag, last-modified
 *   tmp/                 in-flight writes; a crash leaves garbage here, never a partial object
 *
 * Writes are atomic: the body streams into a temp file (sha256 and byte count computed on
 * the way), the file is fsync'ed and renamed into place, then the sidecar is renamed in.
 * `head`/`get` require the sidecar, so a reader never observes a half-written object.
 */
export interface FsStorageOptions {
  readonly root: string;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export interface FsStorage extends ObjectStoragePort {
  readonly root: string;
}

interface Sidecar {
  readonly v: 1;
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly contentType?: string | undefined;
  readonly sha256?: string | undefined;
  readonly metadata: Record<string, string>;
  readonly lastModified: string;
  readonly cacheControl?: string | undefined;
}

const CAPABILITIES: StorageCapabilities = Object.freeze({
  presignedGet: false,
  presignedMultipart: false,
  tus: true,
  ranges: true,
});

const SHA256_RE = /^[0-9a-f]{64}$/iu;

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function backend(key: string | undefined, error: unknown): StorageError {
  if (isStorageError(error)) return error;
  return new StorageError("backend", `filesystem storage failed: ${errorMessage(error)}`, {
    cause: error,
    key,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toNodeReadable(body: ObjectBody): Readable {
  if (body instanceof Uint8Array) return Readable.from([body]);
  // Node's typings for ReadableStream diverge from the DOM ones; the runtime objects are the same.
  return Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]);
}

function toWebStream(readable: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(readable) as unknown as ReadableStream<Uint8Array>;
}

export function createFsStorage(options: FsStorageOptions): FsStorage {
  const root = resolve(options.root);
  const objectsRoot = join(root, "objects");
  const metaRoot = join(root, "meta");
  const tmpRoot = join(root, "tmp");
  const log = options.log ?? (() => {});

  /** Maps a validated key to a path and proves the result stayed inside `base`. */
  function pathFor(base: string, key: string, suffix = ""): string {
    assertObjectKey(key);
    const target = resolve(base, `${key}${suffix}`);
    const rel = relative(base, target);
    if (
      rel === "" ||
      rel.startsWith("..") ||
      rel.includes(`..${sep}`) ||
      resolve(base, rel) !== target
    ) {
      throw new StorageError("invalid_key", `key ${JSON.stringify(key)} escapes the storage root`, {
        key,
      });
    }
    return target;
  }

  const objectPath = (key: string) => pathFor(objectsRoot, key);
  const metaPath = (key: string) => pathFor(metaRoot, key, ".json");

  async function ensureDirs(): Promise<void> {
    await Promise.all([
      mkdir(objectsRoot, { recursive: true }),
      mkdir(metaRoot, { recursive: true }),
      mkdir(tmpRoot, { recursive: true }),
    ]);
  }

  async function readSidecar(key: string): Promise<Sidecar | undefined> {
    let text: string;
    try {
      text = await readFile(metaPath(key), "utf8");
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw backend(key, error);
    }
    try {
      const parsed = JSON.parse(text) as Sidecar;
      if (parsed.v !== 1 || typeof parsed.size !== "number") {
        throw new Error("unrecognised sidecar format");
      }
      return parsed;
    } catch (error) {
      throw new StorageError("backend", `corrupt sidecar for ${key}: ${errorMessage(error)}`, {
        cause: error,
        key,
      });
    }
  }

  function statOf(side: Sidecar): ObjectStat {
    return {
      key: side.key,
      size: side.size,
      etag: side.etag,
      contentType: side.contentType,
      lastModified: new Date(side.lastModified),
      sha256: side.sha256,
      metadata: { ...side.metadata },
    };
  }

  /** Writes the sidecar atomically (temp + rename) next to an already-placed object. */
  async function writeSidecar(side: Sidecar): Promise<void> {
    const target = metaPath(side.key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(tmpRoot, `${randomBytes(8).toString("hex")}.meta`);
    await writeFile(tmp, JSON.stringify(side), { flag: "wx" });
    await rename(tmp, target);
  }

  /** Removes now-empty parent directories up to (not including) `base`. */
  async function prune(base: string, file: string): Promise<void> {
    let dir = dirname(file);
    while (dir !== base && dir.startsWith(base)) {
      try {
        await rmdir(dir);
      } catch {
        return;
      }
      dir = dirname(dir);
    }
  }

  async function put(key: string, body: ObjectBody, opts: PutOptions = {}): Promise<ObjectStat> {
    const target = objectPath(key);
    metaPath(key);
    if (opts.sha256 !== undefined && !SHA256_RE.test(opts.sha256)) {
      throw new StorageError("checksum_mismatch", "sha256 must be 64 hex characters", { key });
    }
    await ensureDirs();
    const tmp = join(tmpRoot, `${randomBytes(8).toString("hex")}.obj`);
    const hash = createHash("sha256");
    let size = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.byteLength;
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      // `flush: true` fsyncs before the fd closes, so the rename below publishes durable bytes.
      await pipeline(
        toNodeReadable(body),
        counter,
        createWriteStream(tmp, { flags: "wx", flush: true }),
      );
      const digest = hash.digest("hex");
      if (opts.contentLength !== undefined && opts.contentLength !== size) {
        throw new StorageError(
          "size_mismatch",
          `expected ${opts.contentLength} bytes, received ${size}`,
          { key },
        );
      }
      if (opts.sha256 !== undefined && opts.sha256.toLowerCase() !== digest) {
        throw new StorageError("checksum_mismatch", "sha256 of the body does not match", { key });
      }
      const side: Sidecar = {
        v: 1,
        key,
        size,
        etag: digest,
        contentType: opts.contentType,
        sha256: opts.sha256 === undefined ? undefined : digest,
        metadata: { ...(opts.metadata ?? {}) },
        lastModified: new Date().toISOString(),
        cacheControl: opts.cacheControl,
      };
      await mkdir(dirname(target), { recursive: true });
      await rename(tmp, target);
      await writeSidecar(side);
      log("storage.put", { driver: "fs", key, size });
      return statOf(side);
    } catch (error) {
      await rm(tmp, { force: true });
      throw backend(key, error);
    }
  }

  async function head(key: string): Promise<ObjectStat | undefined> {
    const side = await readSidecar(key);
    if (!side) return undefined;
    try {
      await access(objectPath(key), fsConstants.R_OK);
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw backend(key, error);
    }
    return statOf(side);
  }

  function resolveRange(size: number, range: ByteRange | undefined, key: string) {
    if (!range) return undefined;
    if (!Number.isInteger(range.start) || range.start < 0) {
      throw new StorageError("backend", "range start must be a non-negative integer", { key });
    }
    if (range.start >= size) {
      throw new StorageError("backend", `range start ${range.start} is past the object (${size})`, {
        key,
      });
    }
    const end = Math.min(range.end ?? size - 1, size - 1);
    if (end < range.start) {
      throw new StorageError("backend", "range end precedes start", { key });
    }
    return { start: range.start, end };
  }

  async function get(key: string, opts: GetOptions = {}): Promise<ObjectRead | undefined> {
    const current = await head(key);
    if (!current) return undefined;
    const range = resolveRange(current.size, opts.range, key);
    const path = objectPath(key);
    const readable =
      range === undefined
        ? createReadStream(path)
        : createReadStream(path, { start: range.start, end: range.end });
    return { body: toWebStream(readable), stat: current, range };
  }

  async function del(key: string): Promise<void> {
    const obj = objectPath(key);
    const meta = metaPath(key);
    for (const file of [meta, obj]) {
      try {
        await unlink(file);
      } catch (error) {
        if (!isEnoent(error)) throw backend(key, error);
      }
    }
    await prune(metaRoot, meta);
    await prune(objectsRoot, obj);
  }

  async function deleteMany(keys: readonly string[]): Promise<void> {
    for (const key of keys) assertObjectKey(key);
    for (const key of keys) await del(key);
  }

  async function copy(sourceKey: string, destinationKey: string): Promise<ObjectStat> {
    const src = await head(sourceKey);
    const dstObj = objectPath(destinationKey);
    metaPath(destinationKey);
    if (!src) throw new StorageError("not_found", `no object at ${sourceKey}`, { key: sourceKey });
    await ensureDirs();
    const tmp = join(tmpRoot, `${randomBytes(8).toString("hex")}.obj`);
    try {
      await copyFile(objectPath(sourceKey), tmp, fsConstants.COPYFILE_EXCL);
      const side: Sidecar = {
        v: 1,
        key: destinationKey,
        size: src.size,
        etag: src.etag ?? "",
        contentType: src.contentType,
        sha256: src.sha256,
        metadata: { ...src.metadata },
        lastModified: new Date().toISOString(),
      };
      await mkdir(dirname(dstObj), { recursive: true });
      await rename(tmp, dstObj);
      await writeSidecar(side);
      return statOf(side);
    } catch (error) {
      await rm(tmp, { force: true });
      throw backend(destinationKey, error);
    }
  }

  async function* walk(dir: string): AsyncGenerator<string> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) yield full;
    }
  }

  async function list(opts: ListOptions): Promise<ObjectPage> {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10_000));
    const prefix = opts.prefix;
    if (prefix.includes("..") || prefix.startsWith("/")) {
      throw new StorageError("invalid_key", `invalid prefix ${JSON.stringify(prefix)}`);
    }
    // Start the walk at the deepest directory the prefix fully names.
    const cut = prefix.lastIndexOf("/");
    const startDir = cut === -1 ? metaRoot : resolve(metaRoot, prefix.slice(0, cut));
    if (relative(metaRoot, startDir).startsWith("..")) {
      throw new StorageError("invalid_key", `invalid prefix ${JSON.stringify(prefix)}`);
    }
    const keys: string[] = [];
    try {
      for await (const file of walk(startDir)) {
        const key = relative(metaRoot, file)
          .split(sep)
          .join("/")
          .replace(/\.json$/u, "");
        if (!key.startsWith(prefix)) continue;
        if (opts.cursor !== undefined && key <= opts.cursor) continue;
        keys.push(key);
      }
    } catch (error) {
      throw backend(undefined, error);
    }
    keys.sort();
    const page = keys.slice(0, limit);
    const objects: ObjectStat[] = [];
    for (const key of page) {
      const side = await readSidecar(key);
      if (side) objects.push(statOf(side));
    }
    const last = page[page.length - 1];
    return { objects, cursor: keys.length > limit && last !== undefined ? last : undefined };
  }

  const multipart: MultipartUploads = {
    create: async (key) => {
      assertObjectKey(key);
      throw new StorageError("unsupported", "fs storage has no multipart uploads; use tus", {
        key,
      });
    },
    presignPart: async (upload) => {
      throw new StorageError("unsupported", "fs storage has no multipart uploads; use tus", {
        key: upload.key,
      });
    },
    complete: async (upload) => {
      throw new StorageError("unsupported", "fs storage has no multipart uploads; use tus", {
        key: upload.key,
      });
    },
    abort: async (upload) => {
      throw new StorageError("unsupported", "fs storage has no multipart uploads; use tus", {
        key: upload.key,
      });
    },
  };

  return {
    driver: "fs",
    capabilities: CAPABILITIES,
    root,
    put,
    get,
    head,
    delete: del,
    deleteMany,
    copy,
    list,
    async presignGet(key: string, _options: PresignGetOptions): Promise<string> {
      assertObjectKey(key);
      throw new StorageError("unsupported", "fs storage cannot presign; stream through the app", {
        key,
      });
    },
    multipart,
    async healthCheck(): Promise<void> {
      try {
        await ensureDirs();
        const probe = join(tmpRoot, `.health-${randomBytes(4).toString("hex")}`);
        await writeFile(probe, "ok", { flag: "wx" });
        await unlink(probe);
        await stat(objectsRoot);
      } catch (error) {
        throw new StorageError(
          "backend",
          `storage root ${root} is not writable: ${errorMessage(error)}`,
          {
            cause: error,
          },
        );
      }
    },
  };
}
