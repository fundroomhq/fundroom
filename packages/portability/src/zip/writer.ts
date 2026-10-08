import { createHash } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw } from "node:zlib";

/*
 * A streaming ZIP writer onto a local file, with ZIP64.
 *
 * Why not fflate's `Zip`: it writes no ZIP64 records, so an archive (or an entry) past 4 GiB —
 * an ordinary data room — would be silently corrupt. This writer uses positional writes on a
 * file it owns: each local header is written with placeholders, the entry streams through (raw
 * deflate from `node:zlib` for JSONL, stored for blobs, which are already compressed or
 * encrypted-then-decrypted binaries), and the CRC and sizes are patched into the header after.
 * Every local header carries a ZIP64 extra field (sizes unknown up front); the central directory
 * uses ZIP64 fields only where a value does not fit 32 bits. Nothing is buffered beyond one chunk.
 *
 * The central directory lists entries in the order the caller asks for (`finish(order)`), which is
 * how `manifest.json` comes first in the directory although it is written last.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const FLAG_UTF8 = 0x0800;
const VERSION = 45;
const U32 = 0xffffffff;
const U16 = 0xffff;

export interface WrittenEntry {
  readonly name: string;
  readonly method: 0 | 8;
  readonly crc: number;
  readonly size: number;
  readonly compressedSize: number;
  readonly offset: number;
  readonly sha256: string;
  readonly time: number;
  readonly date: number;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export class ZipFileWriter {
  private pos = 0;
  private readonly entries = new Map<string, WrittenEntry>();
  private closed = false;

  private constructor(
    private readonly fh: FileHandle,
    private readonly mtime: Date,
  ) {}

  static async create(path: string, mtime: Date): Promise<ZipFileWriter> {
    return new ZipFileWriter(await open(path, "w", 0o600), mtime);
  }

  get bytesWritten(): number {
    return this.pos;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  private async writeRaw(buf: Uint8Array): Promise<void> {
    let off = 0;
    while (off < buf.byteLength) {
      const { bytesWritten } = await this.fh.write(buf, off, buf.byteLength - off, this.pos);
      off += bytesWritten;
      this.pos += bytesWritten;
    }
  }

  /** Streams one entry. `deflate` for text; stored otherwise. Returns what was written. */
  async add(
    name: string,
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options: { readonly deflate: boolean },
  ): Promise<WrittenEntry> {
    if (this.closed) throw new Error("zip already finished");
    if (this.entries.has(name)) throw new Error(`duplicate zip entry ${name}`);
    const nameBytes = Buffer.from(name, "utf8");
    if (nameBytes.length > U16) throw new Error("entry name too long");
    const { time, date } = dosDateTime(this.mtime);
    const method: 0 | 8 = options.deflate ? 8 : 0;
    const offset = this.pos;

    const header = Buffer.alloc(30 + nameBytes.length + 20);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(0, 14); // crc, patched
    header.writeUInt32LE(U32, 18); // sizes live in the ZIP64 extra
    header.writeUInt32LE(U32, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(20, 28);
    nameBytes.copy(header, 30);
    const extra = 30 + nameBytes.length;
    header.writeUInt16LE(0x0001, extra);
    header.writeUInt16LE(16, extra + 2);
    // uncompressed + compressed sizes (8 + 8), patched
    await this.writeRaw(header);
    const dataStart = this.pos;

    let crc = 0;
    let size = 0;
    const hash = createHash("sha256");
    async function* tapped(): AsyncGenerator<Uint8Array> {
      for await (const chunk of source) {
        if (chunk.byteLength === 0) continue;
        crc = crc32(chunk, crc);
        size += chunk.byteLength;
        hash.update(chunk);
        yield chunk;
      }
    }
    const sink = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        this.writeRaw(chunk).then(() => cb(), cb);
      },
    });
    if (method === 8) {
      await pipeline(Readable.from(tapped()), createDeflateRaw({ level: 6 }), sink);
    } else {
      await pipeline(Readable.from(tapped()), sink);
    }
    const compressedSize = this.pos - dataStart;

    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32LE(crc >>> 0, 0);
    await this.fh.write(crcBuf, 0, 4, offset + 14);
    const sizes = Buffer.alloc(16);
    sizes.writeBigUInt64LE(BigInt(size), 0);
    sizes.writeBigUInt64LE(BigInt(compressedSize), 8);
    await this.fh.write(sizes, 0, 16, offset + extra + 4);

    const written: WrittenEntry = {
      name,
      method,
      crc: crc >>> 0,
      size,
      compressedSize,
      offset,
      sha256: hash.digest("hex"),
      time,
      date,
    };
    this.entries.set(name, written);
    return written;
  }

  /** Writes the central directory (in `order` first, then the rest as written) and closes. */
  async finish(order: readonly string[] = []): Promise<{ readonly size: number }> {
    if (this.closed) throw new Error("zip already finished");
    const ordered: WrittenEntry[] = [];
    const seen = new Set<string>();
    for (const name of order) {
      const e = this.entries.get(name);
      if (e && !seen.has(name)) {
        ordered.push(e);
        seen.add(name);
      }
    }
    for (const [name, e] of this.entries) if (!seen.has(name)) ordered.push(e);

    const cdStart = this.pos;
    for (const e of ordered) await this.writeRaw(centralRecord(e));
    const cdSize = this.pos - cdStart;
    const count = ordered.length;
    const needZip64 = count >= U16 || cdStart >= U32 || cdSize >= U32;
    if (needZip64) {
      const z64 = Buffer.alloc(56);
      const recordOffset = this.pos;
      z64.writeUInt32LE(ZIP64_EOCD_SIG, 0);
      z64.writeBigUInt64LE(44n, 4);
      z64.writeUInt16LE((3 << 8) | VERSION, 12);
      z64.writeUInt16LE(VERSION, 14);
      z64.writeUInt32LE(0, 16);
      z64.writeUInt32LE(0, 20);
      z64.writeBigUInt64LE(BigInt(count), 24);
      z64.writeBigUInt64LE(BigInt(count), 32);
      z64.writeBigUInt64LE(BigInt(cdSize), 40);
      z64.writeBigUInt64LE(BigInt(cdStart), 48);
      await this.writeRaw(z64);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(recordOffset), 8);
      loc.writeUInt32LE(1, 16);
      await this.writeRaw(loc);
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(needZip64 ? U16 : count, 8);
    eocd.writeUInt16LE(needZip64 ? U16 : count, 10);
    eocd.writeUInt32LE(needZip64 ? U32 : cdSize, 12);
    eocd.writeUInt32LE(needZip64 ? U32 : cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await this.writeRaw(eocd);
    this.closed = true;
    await this.fh.sync();
    await this.fh.close();
    return { size: this.pos };
  }

  /** Closes without a directory (the caller deletes the file). */
  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.fh.close().catch(() => undefined);
  }
}

function centralRecord(e: WrittenEntry): Buffer {
  const name = Buffer.from(e.name, "utf8");
  const z64: bigint[] = [];
  const fit = (v: number): number => {
    if (v < U32) return v;
    z64.push(BigInt(v));
    return U32;
  };
  // ZIP64 extra field order: uncompressed size, compressed size, local header offset.
  const size = fit(e.size);
  const comp = fit(e.compressedSize);
  const off = fit(e.offset);
  const extraLen = z64.length === 0 ? 0 : 4 + 8 * z64.length;
  const b = Buffer.alloc(46 + name.length + extraLen);
  b.writeUInt32LE(CENTRAL_SIG, 0);
  b.writeUInt16LE((3 << 8) | VERSION, 4);
  b.writeUInt16LE(VERSION, 6);
  b.writeUInt16LE(FLAG_UTF8, 8);
  b.writeUInt16LE(e.method, 10);
  b.writeUInt16LE(e.time, 12);
  b.writeUInt16LE(e.date, 14);
  b.writeUInt32LE(e.crc, 16);
  b.writeUInt32LE(comp, 20);
  b.writeUInt32LE(size, 24);
  b.writeUInt16LE(name.length, 28);
  b.writeUInt16LE(extraLen, 30);
  b.writeUInt16LE(0, 32);
  b.writeUInt16LE(0, 34);
  b.writeUInt16LE(0, 36);
  b.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  b.writeUInt32LE(off, 42);
  name.copy(b, 46);
  if (extraLen > 0) {
    let p = 46 + name.length;
    b.writeUInt16LE(0x0001, p);
    b.writeUInt16LE(8 * z64.length, p + 2);
    p += 4;
    for (const v of z64) {
      b.writeBigUInt64LE(v, p);
      p += 8;
    }
  }
  return b;
}
