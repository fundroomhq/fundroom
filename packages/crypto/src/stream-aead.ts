import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/*
 * Chunked streaming AEAD for objects in storage (EXECUTION_PLAN §8, §10, ADR-0016,
 * design/02 §4). The construction follows age's STREAM / Tink's streaming AEAD:
 *
 *   header      = "SHE1" | 0x01 | salt(16)                         (21 bytes, in the clear)
 *   object key  = HKDF-SHA256(ikm = workspace DEK, salt, info "seed-host/object-key/v1")
 *   chunk i     = AES-256-GCM(key, nonce_i, plaintext[i*64KiB .. +64KiB], aad = header)
 *   nonce_i     = counter_i (11 bytes, big-endian) | last_flag (1 byte: 0x01 on the final chunk)
 *   ciphertext  = header | (ct_0 | tag_0) | (ct_1 | tag_1) | … | (ct_last | tag_last)
 *
 * Why chunks rather than one GCM over the whole object: the decryptor can start emitting
 * verified plaintext after 64 KiB instead of buffering a multi-gigabyte file, byte ranges
 * (PDF page tiles, video seeks) decrypt only the chunks they touch, and the counter + last
 * flag make reordering, duplication and truncation detectable. A fresh random salt per
 * object means one workspace DEK never encrypts two objects under the same key.
 *
 * An empty plaintext still produces one (empty) final chunk, so every ciphertext carries at
 * least one authenticated tag.
 */
export const MAGIC = new Uint8Array([0x53, 0x48, 0x45, 0x31]); // "SHE1"
export const FORMAT_VERSION = 0x01;
export const SALT_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES;
export const CHUNK_BYTES = 65_536;
export const TAG_BYTES = 16;
export const NONCE_BYTES = 12;
export const DEK_BYTES = 32;
/** Bytes one full ciphertext chunk occupies. */
export const CHUNK_CIPHERTEXT_BYTES = CHUNK_BYTES + TAG_BYTES;

const OBJECT_KEY_INFO = "seed-host/object-key/v1";
const MAX_CHUNKS = 2 ** 53 - 1;

export type StreamAeadErrorCode = "malformed" | "authentication_failed" | "truncated";

export class StreamAeadError extends Error {
  override readonly name = "StreamAeadError";
  constructor(
    readonly code: StreamAeadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function assertDek(dek: Uint8Array): void {
  if (dek.byteLength !== DEK_BYTES) {
    throw new StreamAeadError("malformed", `data key must be ${DEK_BYTES} bytes`);
  }
}

function objectKey(dek: Uint8Array, salt: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", dek, salt, OBJECT_KEY_INFO, DEK_BYTES));
}

function nonceFor(index: number, last: boolean): Buffer {
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_CHUNKS) {
    throw new StreamAeadError("malformed", "chunk index out of range");
  }
  const nonce = Buffer.alloc(NONCE_BYTES);
  // 11-byte big-endian counter: the high 3 bytes stay zero for any JS-safe integer.
  nonce.writeUIntBE(Math.floor(index / 2 ** 32), 3, 4);
  nonce.writeUInt32BE(index >>> 0, 7);
  nonce[11] = last ? 0x01 : 0x00;
  return nonce;
}

export function buildHeader(salt: Uint8Array): Uint8Array {
  if (salt.byteLength !== SALT_BYTES) {
    throw new StreamAeadError("malformed", `salt must be ${SALT_BYTES} bytes`);
  }
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[MAGIC.length] = FORMAT_VERSION;
  header.set(salt, MAGIC.length + 1);
  return header;
}

/** Validates a header and returns its salt. */
export function parseHeader(header: Uint8Array): { readonly salt: Uint8Array } {
  if (header.byteLength !== HEADER_BYTES) {
    throw new StreamAeadError("malformed", "bad header length");
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (header[i] !== MAGIC[i]) throw new StreamAeadError("malformed", "not a SHE1 object");
  }
  if (header[MAGIC.length] !== FORMAT_VERSION) {
    throw new StreamAeadError("malformed", `unsupported format version ${header[MAGIC.length]}`);
  }
  return { salt: header.subarray(MAGIC.length + 1) };
}

function sealChunk(
  key: Uint8Array,
  header: Uint8Array,
  index: number,
  last: boolean,
  plaintext: Uint8Array,
): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonceFor(index, last));
  cipher.setAAD(header);
  const ct = cipher.update(plaintext);
  cipher.final();
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

function openChunk(
  key: Uint8Array,
  header: Uint8Array,
  index: number,
  last: boolean,
  chunk: Uint8Array,
): Buffer | undefined {
  if (chunk.byteLength < TAG_BYTES) return undefined;
  const body = chunk.subarray(0, chunk.byteLength - TAG_BYTES);
  const tag = chunk.subarray(chunk.byteLength - TAG_BYTES);
  // Pinned (ASVS F-22): Node otherwise accepts any 4–16-byte tag. The slice above already
  // makes it 16; the option keeps it so if that ever changes.
  const decipher = createDecipheriv("aes-256-gcm", key, nonceFor(index, last), {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  try {
    const pt = decipher.update(body);
    decipher.final();
    return pt;
  } catch {
    return undefined;
  }
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Small append-only byte buffer for the transforms below. */
class ByteQueue {
  private parts: Uint8Array[] = [];
  private total = 0;

  get length(): number {
    return this.total;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.parts.push(chunk);
    this.total += chunk.byteLength;
  }

  /** Removes and returns the first `n` bytes (n ≤ length). */
  take(n: number): Uint8Array {
    const merged = concat(this.parts, this.total);
    const head = merged.subarray(0, n);
    const rest = merged.subarray(n);
    this.parts = rest.byteLength > 0 ? [rest] : [];
    this.total = rest.byteLength;
    return head;
  }

  takeAll(): Uint8Array {
    return this.take(this.total);
  }
}

export interface EncryptOptions {
  /** Tests only: pins the salt so the output is deterministic. Production uses random salts. */
  readonly salt?: Uint8Array | undefined;
}

/** Encrypts a plaintext stream; the output starts with the 21-byte header. */
export function encryptStream(
  dek: Uint8Array,
  plaintext: ReadableStream<Uint8Array>,
  options: EncryptOptions = {},
): ReadableStream<Uint8Array> {
  assertDek(dek);
  const header = buildHeader(options.salt ?? randomBytes(SALT_BYTES));
  const key = objectKey(dek, parseHeader(header).salt);
  const queue = new ByteQueue();
  let index = 0;
  let headerSent = false;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!headerSent) {
        controller.enqueue(header);
        headerSent = true;
      }
      queue.push(chunk);
      // Keep at least one byte back: only at flush do we know which chunk is the last.
      while (queue.length > CHUNK_BYTES) {
        controller.enqueue(sealChunk(key, header, index, false, queue.take(CHUNK_BYTES)));
        index += 1;
      }
    },
    flush(controller) {
      if (!headerSent) controller.enqueue(header);
      controller.enqueue(sealChunk(key, header, index, true, queue.takeAll()));
    },
  });
  return plaintext.pipeThrough(transform);
}

export interface DecryptOptions {
  /**
   * The object's header when the stream does not start with it (a range read). Fetch bytes
   * `0 .. HEADER_BYTES-1` separately.
   */
  readonly header?: Uint8Array | undefined;
  /** Index of the first chunk in the stream (range reads). Default 0. */
  readonly firstChunkIndex?: number | undefined;
  /**
   * Whether the stream must end with the object's final chunk. Default true, which turns a
   * truncated object into `truncated`. Range reads pass false.
   */
  readonly expectLast?: boolean | undefined;
}

/** Decrypts a ciphertext stream. Every emitted byte has been authenticated. */
export function decryptStream(
  dek: Uint8Array,
  ciphertext: ReadableStream<Uint8Array>,
  options: DecryptOptions = {},
): ReadableStream<Uint8Array> {
  assertDek(dek);
  const expectLast = options.expectLast ?? true;
  const queue = new ByteQueue();
  let header: Uint8Array | undefined = options.header ? Uint8Array.from(options.header) : undefined;
  let key: Uint8Array | undefined = header ? objectKey(dek, parseHeader(header).salt) : undefined;
  let index = options.firstChunkIndex ?? 0;
  let done = false;

  function open(chunk: Uint8Array, last: boolean): Uint8Array {
    if (!key || !header) throw new StreamAeadError("malformed", "missing header");
    const pt = openChunk(key, header, index, last, chunk);
    if (pt === undefined) {
      throw new StreamAeadError("authentication_failed", `chunk ${index} failed authentication`);
    }
    index += 1;
    return pt;
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (done) throw new StreamAeadError("malformed", "data after the final chunk");
      queue.push(chunk);
      if (!header) {
        if (queue.length < HEADER_BYTES) return;
        header = queue.take(HEADER_BYTES);
        key = objectKey(dek, parseHeader(header).salt);
      }
      // A chunk is known to be non-final only once more bytes follow it.
      while (queue.length > CHUNK_CIPHERTEXT_BYTES) {
        controller.enqueue(open(queue.take(CHUNK_CIPHERTEXT_BYTES), false));
      }
    },
    flush(controller) {
      if (!header) throw new StreamAeadError("truncated", "stream ended before the header");
      const rest = queue.takeAll();
      if (rest.byteLength < TAG_BYTES) {
        throw new StreamAeadError("truncated", "stream ended inside a chunk");
      }
      if (!key) throw new StreamAeadError("malformed", "missing key");
      if (expectLast) {
        const pt = openChunk(key, header, index, true, rest);
        if (pt !== undefined) {
          controller.enqueue(pt);
          done = true;
          return;
        }
        // Distinguish "object cut short" from "object tampered" for the operator's benefit;
        // both are failures.
        const asMiddle = openChunk(key, header, index, false, rest);
        throw new StreamAeadError(
          asMiddle === undefined ? "authentication_failed" : "truncated",
          asMiddle === undefined
            ? `chunk ${index} failed authentication`
            : "stream ended before the final chunk",
        );
      }
      // Range read: the last fetched chunk may or may not be the object's final one.
      const asMiddle = openChunk(key, header, index, false, rest);
      if (asMiddle !== undefined) {
        controller.enqueue(asMiddle);
        return;
      }
      const asLast = openChunk(key, header, index, true, rest);
      if (asLast === undefined) {
        throw new StreamAeadError("authentication_failed", `chunk ${index} failed authentication`);
      }
      controller.enqueue(asLast);
    },
  });
  return ciphertext.pipeThrough(transform);
}

/** Drops the first `skip` bytes and passes through the next `take`. */
export function sliceStream(
  source: ReadableStream<Uint8Array>,
  skip: number,
  take: number,
): ReadableStream<Uint8Array> {
  let toSkip = skip;
  let toTake = take;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let c = chunk;
        if (toSkip > 0) {
          const drop = Math.min(toSkip, c.byteLength);
          c = c.subarray(drop);
          toSkip -= drop;
        }
        if (toTake <= 0 || c.byteLength === 0) return;
        const emit = c.subarray(0, Math.min(toTake, c.byteLength));
        toTake -= emit.byteLength;
        controller.enqueue(emit);
      },
    }),
  );
}

export interface PlaintextRange {
  readonly start: number;
  /** Inclusive. */
  readonly end: number;
}

export interface CiphertextRange {
  /** Absolute object offset of the first ciphertext byte to fetch (after the header). */
  readonly start: number;
  /** Absolute, inclusive; may run past the object's end — the fetcher clamps. */
  readonly end: number;
  readonly firstChunkIndex: number;
  /** Plaintext bytes to drop from the front of the decrypted chunks. */
  readonly skipBytes: number;
  /** Plaintext bytes to keep after skipping. */
  readonly takeBytes: number;
}

/** Which bytes of the stored object cover a plaintext byte range, and how to trim them. */
export function ciphertextRangeFor(range: PlaintextRange): CiphertextRange {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    throw new StreamAeadError("malformed", "invalid plaintext range");
  }
  const firstChunkIndex = Math.floor(range.start / CHUNK_BYTES);
  const lastChunkIndex = Math.floor(range.end / CHUNK_BYTES);
  return {
    start: HEADER_BYTES + firstChunkIndex * CHUNK_CIPHERTEXT_BYTES,
    end: HEADER_BYTES + (lastChunkIndex + 1) * CHUNK_CIPHERTEXT_BYTES - 1,
    firstChunkIndex,
    skipBytes: range.start - firstChunkIndex * CHUNK_BYTES,
    takeBytes: range.end - range.start + 1,
  };
}

/**
 * Decrypts exactly `range` of the plaintext from the ciphertext bytes that
 * `ciphertextRangeFor(range)` asked for. `header` is the object's first 21 bytes.
 */
export function decryptRange(
  dek: Uint8Array,
  header: Uint8Array,
  ciphertext: ReadableStream<Uint8Array>,
  range: PlaintextRange,
): ReadableStream<Uint8Array> {
  const r = ciphertextRangeFor(range);
  return sliceStream(
    decryptStream(dek, ciphertext, {
      header,
      firstChunkIndex: r.firstChunkIndex,
      expectLast: false,
    }),
    r.skipBytes,
    r.takeBytes,
  );
}

export function ciphertextLength(plaintextLength: number): number {
  const chunks = Math.max(1, Math.ceil(plaintextLength / CHUNK_BYTES));
  return HEADER_BYTES + plaintextLength + chunks * TAG_BYTES;
}

export function plaintextLength(ciphertextLength: number): number {
  const body = ciphertextLength - HEADER_BYTES;
  if (body < TAG_BYTES) throw new StreamAeadError("malformed", "ciphertext too short");
  const chunks = Math.max(1, Math.ceil(body / CHUNK_CIPHERTEXT_BYTES));
  const pt = body - chunks * TAG_BYTES;
  if (pt < 0) throw new StreamAeadError("malformed", "ciphertext length is not a chunk multiple");
  return pt;
}

export function bytesToStream(bytes: Uint8Array, pieceSize = 1 << 20): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        if (offset === 0 && bytes.byteLength === 0) {
          // nothing to emit
        }
        controller.close();
        return;
      }
      const end = Math.min(offset + pieceSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  return concat(parts, total);
}

export async function encryptBytes(
  dek: Uint8Array,
  plaintext: Uint8Array,
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  return streamToBytes(encryptStream(dek, bytesToStream(plaintext), options));
}

export async function decryptBytes(dek: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  return streamToBytes(decryptStream(dek, bytesToStream(ciphertext)));
}
