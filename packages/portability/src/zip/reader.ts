import { createReadStream } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { crc32, createInflateRaw } from "node:zlib";

/*
 * A random-access ZIP reader over a local file (ZIP64 included), for the verifier and the
 * importer. It trusts nothing it reads, and it is strict: it reads workspace exports, not
 * arbitrary archives, so anything an export (or a plain re-zip of one) never contains is refused
 * rather than interpreted.
 *
 *  - the end records: no archive comment (a comment can hide a second, fake end record), one
 *    disk, the entry counts agree, the central directory ends exactly where the end record (or the
 *    ZIP64 end record) begins, and the directory holds exactly the declared number of records;
 *  - every directory record: no file comment, a name that is valid UTF-8 without NUL, backslash,
 *    a leading `/`, a drive letter or a `.`/`..`/empty path segment; a well-formed ZIP64 extra
 *    wherever a 32-bit field is saturated; no encryption or unknown flags; stored or deflate
 *    only, and a stored entry's two sizes agree;
 *  - every LOCAL header is read at open and must agree with its directory record (name bytes,
 *    method, flags; CRC and both sizes unless a data descriptor defers them), so no tool can show
 *    a different file than the one verified; the entries tile the file from offset 0 to the
 *    directory with no overlap and no hidden bytes in between (a data descriptor's few bytes
 *    excepted) — the classic "many headers, one payload" bomb and prepended/polyglot data fail
 *    here;
 *  - `read(entry)` streams one entry's bytes, inflating raw deflate itself, and fails as soon as
 *    the output passes the size the directory declared — so a 1 KiB entry that inflates to 1 TiB
 *    costs one chunk, not a disk — and checks the CRC-32 and the size at the end.
 *
 * Duplicate names are not refused here but reported (`directory.duplicates`): the verifier turns
 * them into a failure with a clear message; `entry(name)` returns the first.
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const U32 = 0xffffffff;
const U16 = 0xffff;
/** The directory is read whole; this bounds it (≈ 5 million entries). */
const MAX_CENTRAL_DIRECTORY_BYTES = 512 * 1024 * 1024;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
/** encrypted (refused with its own message), deflate options (bits 1–2), data descriptor, UTF-8. */
const KNOWN_FLAGS = 0x0001 | 0x0002 | 0x0004 | FLAG_DESCRIPTOR | 0x0800;
/** A data descriptor is 12–24 bytes (optional signature, 32- or 64-bit sizes). */
const DESCRIPTOR_MIN = 12;
const DESCRIPTOR_MAX = 24;

export class ZipFormatError extends Error {
  override readonly name = "ZipFormatError";
}

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localHeaderOffset: number;
  /** Where the entry's (compressed) data starts, from its validated local header. */
  readonly dataOffset: number;
}

export interface ZipDirectory {
  readonly entries: readonly ZipEntry[];
  /** Names that occur more than once in the directory. */
  readonly duplicates: readonly string[];
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead === 0) throw new ZipFormatError("unexpected end of file (truncated archive)");
    off += bytesRead;
  }
  return buf;
}

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError("a ZIP64 size does not fit");
  return Number(v);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The entry name, or a thrown reason it is not one an export could contain. */
function entryName(bytes: Buffer): string {
  let name: string;
  try {
    name = utf8.decode(bytes);
  } catch {
    throw new ZipFormatError("an entry name is not valid UTF-8");
  }
  const shown = JSON.stringify(name);
  if (name.length === 0) throw new ZipFormatError("an entry has an empty name");
  if (name.includes("\u0000")) throw new ZipFormatError(`entry name ${shown} contains NUL`);
  if (name.includes("\\")) throw new ZipFormatError(`entry name ${shown} contains a backslash`);
  if (name.startsWith("/") || /^[A-Za-z]:/u.test(name))
    throw new ZipFormatError(`entry name ${shown} is an absolute path`);
  if (name.split("/").some((s) => s === "" || s === "." || s === ".."))
    throw new ZipFormatError(`entry name ${shown} has an empty, "." or ".." path segment`);
  return name;
}

/**
 * The ZIP64 extra field (0x0001) of a record: the 64-bit values for exactly the fields that are
 * saturated, in the spec's order. Throws when one is saturated but the extra is missing or short.
 */
function zip64Fields(
  buf: Buffer,
  extraStart: number,
  extraLen: number,
  want: { readonly size: boolean; readonly compressed: boolean; readonly offset: boolean },
  where: string,
): { size?: number; compressed?: number; offset?: number } {
  const out: { size?: number; compressed?: number; offset?: number } = {};
  const needed = [want.size, want.compressed, want.offset].filter(Boolean).length;
  let x = extraStart;
  const end = extraStart + extraLen;
  let found = false;
  while (x < end) {
    if (x + 4 > end) throw new ZipFormatError(`${where}: malformed extra field`);
    const id = buf.readUInt16LE(x);
    const len = buf.readUInt16LE(x + 2);
    if (x + 4 + len > end) throw new ZipFormatError(`${where}: malformed extra field`);
    if (id === 0x0001) {
      if (found) throw new ZipFormatError(`${where}: two ZIP64 extra fields`);
      found = true;
      if (len < 8 * needed) throw new ZipFormatError(`${where}: ZIP64 extra field too short`);
      let q = x + 4;
      if (want.size) {
        out.size = u64(buf, q);
        q += 8;
      }
      if (want.compressed) {
        out.compressed = u64(buf, q);
        q += 8;
      }
      if (want.offset) out.offset = u64(buf, q);
    }
    x += 4 + len;
  }
  if (needed > 0 && !found)
    throw new ZipFormatError(`${where}: a saturated size or offset without a ZIP64 extra field`);
  return out;
}

export class ZipFileReader {
  private readonly byName: ReadonlyMap<string, ZipEntry>;

  private constructor(
    readonly path: string,
    private readonly fh: FileHandle,
    readonly fileSize: number,
    readonly directory: ZipDirectory,
  ) {
    const byName = new Map<string, ZipEntry>();
    for (const e of directory.entries) if (!byName.has(e.name)) byName.set(e.name, e);
    this.byName = byName;
  }

  static async open(path: string): Promise<ZipFileReader> {
    const fh = await open(path, "r");
    try {
      const { size } = await fh.stat();
      const directory = await readDirectory(fh, size);
      return new ZipFileReader(path, fh, size, directory);
    } catch (error) {
      await fh.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.fh.close();
  }

  get entries(): readonly ZipEntry[] {
    return this.directory.entries;
  }

  entry(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  /** The entry's uncompressed bytes, streamed; throws on overrun, short data or a CRC mismatch. */
  async *read(entry: ZipEntry): AsyncGenerator<Buffer> {
    const start = entry.dataOffset;
    if (start + entry.compressedSize > this.fileSize)
      throw new ZipFormatError(`${entry.name}: data runs past the end of the file`);
    let produced = 0;
    let crc = 0;
    if (entry.compressedSize > 0) {
      const raw = createReadStream(this.path, { start, end: start + entry.compressedSize - 1 });
      const inflate = entry.method === 8 ? createInflateRaw() : undefined;
      if (inflate) {
        raw.on("error", (e) => inflate.destroy(e));
        raw.pipe(inflate);
      }
      const source: AsyncIterable<Buffer> = inflate ?? raw;
      try {
        for await (const chunk of source) {
          produced += chunk.byteLength;
          if (produced > entry.size)
            throw new ZipFormatError(
              `${entry.name}: inflates beyond its declared ${entry.size} bytes`,
            );
          crc = crc32(chunk, crc);
          yield chunk;
        }
      } finally {
        inflate?.destroy();
        raw.destroy();
      }
    }
    if (produced !== entry.size)
      throw new ZipFormatError(
        `${entry.name}: ${produced} bytes, the directory says ${entry.size}`,
      );
    if (crc >>> 0 !== entry.crc) throw new ZipFormatError(`${entry.name}: CRC-32 mismatch`);
  }

  /** Whole entry in memory — only for small entries (the caller bounds `entry.size`). */
  async readAll(entry: ZipEntry): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of this.read(entry)) parts.push(chunk);
    return Buffer.concat(parts);
  }
}

interface EndRecords {
  readonly count: number;
  readonly cdSize: number;
  readonly cdOffset: number;
  /** Where the directory must end: the ZIP64 end record, or the end record. */
  readonly cdEnd: number;
}

async function readEnd(fh: FileHandle, fileSize: number): Promise<EndRecords> {
  if (fileSize < 22) throw new ZipFormatError("not a zip file (too short)");
  const tailLen = Math.min(fileSize, 22 + U16);
  const tail = await readAt(fh, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG && i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipFormatError("not a zip file (no end of central directory)");
  if (tail.readUInt16LE(eocd + 20) !== 0)
    throw new ZipFormatError("archive comments are not supported (an export has none)");
  const eocdPos = fileSize - 22;
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0)
    throw new ZipFormatError("multi-disk archives are not supported");
  const onDisk = tail.readUInt16LE(eocd + 8);
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (onDisk !== count) throw new ZipFormatError("the end record's entry counts disagree");
  let cdEnd = eocdPos;
  if (count === U16 || cdSize === U32 || cdOffset === U32) {
    if (eocdPos < 20 + 56) throw new ZipFormatError("ZIP64 locator missing");
    const loc = await readAt(fh, eocdPos - 20, 20);
    if (loc.readUInt32LE(0) !== ZIP64_LOCATOR_SIG)
      throw new ZipFormatError("ZIP64 locator missing");
    if (loc.readUInt32LE(4) !== 0 || loc.readUInt32LE(16) !== 1)
      throw new ZipFormatError("multi-disk archives are not supported");
    const recPos = u64(loc, 8);
    if (recPos + 56 > eocdPos - 20) throw new ZipFormatError("bad ZIP64 end record offset");
    const rec = await readAt(fh, recPos, 56);
    if (rec.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new ZipFormatError("bad ZIP64 end record");
    // The record may carry an extensible data sector, but nothing may follow it except the locator.
    if (recPos + 12 + u64(rec, 4) !== eocdPos - 20)
      throw new ZipFormatError("bytes between the ZIP64 end record and its locator");
    if (rec.readUInt32LE(16) !== 0 || rec.readUInt32LE(20) !== 0)
      throw new ZipFormatError("multi-disk archives are not supported");
    const onDisk64 = u64(rec, 24);
    const count64 = u64(rec, 32);
    if (onDisk64 !== count64) throw new ZipFormatError("the ZIP64 end record's counts disagree");
    // A 32-bit field that is not saturated must agree with its 64-bit twin.
    if (count !== U16 && count !== count64)
      throw new ZipFormatError("the end records disagree on the entry count");
    if (cdSize !== U32 && cdSize !== u64(rec, 40))
      throw new ZipFormatError("the end records disagree on the directory size");
    if (cdOffset !== U32 && cdOffset !== u64(rec, 48))
      throw new ZipFormatError("the end records disagree on the directory offset");
    count = count64;
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
    cdEnd = recPos;
  }
  if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES) throw new ZipFormatError("central directory too large");
  if (cdOffset + cdSize !== cdEnd)
    throw new ZipFormatError(
      "the central directory does not end where the end record begins (hidden or missing bytes)",
    );
  if (count > cdSize / 46) throw new ZipFormatError("the entry count exceeds the directory");
  return { count, cdSize, cdOffset, cdEnd };
}

async function readDirectory(fh: FileHandle, fileSize: number): Promise<ZipDirectory> {
  const { count, cdSize, cdOffset } = await readEnd(fh, fileSize);
  const cd = await readAt(fh, cdOffset, cdSize);
  const records: (Omit<ZipEntry, "dataOffset"> & { nameBytes: Buffer })[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG)
      throw new ZipFormatError("bad central directory record (entry count mismatch?)");
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const compressed32 = cd.readUInt32LE(p + 20);
    const size32 = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const disk = cd.readUInt16LE(p + 34);
    const offset32 = cd.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cd.length)
      throw new ZipFormatError("bad central directory record");
    const nameBytes = Buffer.from(cd.subarray(p + 46, p + 46 + nameLen));
    const name = entryName(nameBytes);
    if (commentLen !== 0)
      throw new ZipFormatError(`${name}: file comments are not supported (an export has none)`);
    if (disk !== 0) throw new ZipFormatError("multi-disk archives are not supported");
    const z = zip64Fields(
      cd,
      p + 46 + nameLen,
      extraLen,
      { size: size32 === U32, compressed: compressed32 === U32, offset: offset32 === U32 },
      name,
    );
    const size = z.size ?? size32;
    const compressedSize = z.compressed ?? compressed32;
    const localHeaderOffset = z.offset ?? offset32;
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & FLAG_ENCRYPTED)
      throw new ZipFormatError(`${name}: encrypted entries are not supported`);
    if ((flags & ~KNOWN_FLAGS) !== 0)
      throw new ZipFormatError(
        `${name}: unsupported general-purpose flags 0x${flags.toString(16)}`,
      );
    if (method !== 0 && method !== 8)
      throw new ZipFormatError(`${name}: compression method ${method} is not supported`);
    if (method === 0 && compressedSize !== size)
      throw new ZipFormatError(`${name}: a stored entry whose two sizes differ`);
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
    records.push({ name, nameBytes, method, flags, crc, compressedSize, size, localHeaderOffset });
  }
  if (p !== cd.length)
    throw new ZipFormatError(
      "the central directory holds more than the declared entries (entry count mismatch)",
    );

  // Local headers must agree with the directory, and the entries must tile [0, directory).
  const entries: ZipEntry[] = [];
  const spans: { name: string; start: number; end: number; slack: number }[] = [];
  for (const r of records) {
    if (r.localHeaderOffset + 30 > cdOffset)
      throw new ZipFormatError(`${r.name}: local header outside the entry area`);
    const h = await readAt(fh, r.localHeaderOffset, 30);
    if (h.readUInt32LE(0) !== LOCAL_SIG) throw new ZipFormatError(`${r.name}: bad local header`);
    const lFlags = h.readUInt16LE(6);
    const lMethod = h.readUInt16LE(8);
    const lCrc = h.readUInt32LE(14);
    const lCompressed32 = h.readUInt32LE(18);
    const lSize32 = h.readUInt32LE(22);
    const lNameLen = h.readUInt16LE(26);
    const lExtraLen = h.readUInt16LE(28);
    const dataOffset = r.localHeaderOffset + 30 + lNameLen + lExtraLen;
    if (dataOffset > cdOffset)
      throw new ZipFormatError(`${r.name}: local header runs into the central directory`);
    const rest = await readAt(fh, r.localHeaderOffset + 30, lNameLen + lExtraLen);
    if (!rest.subarray(0, lNameLen).equals(r.nameBytes))
      throw new ZipFormatError(`${r.name}: the local header names a different file`);
    if (lMethod !== r.method)
      throw new ZipFormatError(`${r.name}: local header and directory disagree on the method`);
    if (lFlags !== r.flags)
      throw new ZipFormatError(`${r.name}: local header and directory disagree on the flags`);
    const deferred = (r.flags & FLAG_DESCRIPTOR) !== 0;
    const saturated = lSize32 === U32 || lCompressed32 === U32;
    const lz = zip64Fields(
      rest,
      lNameLen,
      lExtraLen,
      // In a local header the ZIP64 extra holds BOTH sizes whenever either is saturated.
      { size: saturated, compressed: saturated, offset: false },
      r.name,
    );
    const lSize = lz.size ?? lSize32;
    const lCompressed = lz.compressed ?? lCompressed32;
    const agrees = lCrc === r.crc && lSize === r.size && lCompressed === r.compressedSize;
    // A data descriptor defers the three values: the local header then carries zeros.
    const zeros = lCrc === 0 && lSize === 0 && lCompressed === 0;
    if (!agrees && !(deferred && zeros))
      throw new ZipFormatError(
        `${r.name}: local header and directory disagree on the CRC or the sizes`,
      );
    const end = dataOffset + r.compressedSize;
    spans.push({
      name: r.name,
      start: r.localHeaderOffset,
      end: end + (deferred ? DESCRIPTOR_MIN : 0),
      slack: deferred ? DESCRIPTOR_MAX - DESCRIPTOR_MIN : 0,
    });
    entries.push({
      name: r.name,
      method: r.method,
      flags: r.flags,
      crc: r.crc,
      compressedSize: r.compressedSize,
      size: r.size,
      localHeaderOffset: r.localHeaderOffset,
      dataOffset,
    });
  }
  spans.sort((a, b) => a.start - b.start);
  let cursor = 0;
  let slack = 0;
  let previous = "the start of the file";
  for (const s of spans) {
    if (s.start < cursor) throw new ZipFormatError(`${previous} and ${s.name} overlap`);
    if (s.start > cursor + slack)
      throw new ZipFormatError(`unaccounted bytes before ${s.name} (hidden data)`);
    if (s.end > cdOffset)
      throw new ZipFormatError(`${s.name}: data runs into the central directory`);
    cursor = s.end;
    slack = s.slack;
    previous = s.name;
  }
  if (cdOffset > cursor + slack)
    throw new ZipFormatError("unaccounted bytes before the central directory (hidden data)");
  return { entries, duplicates: [...duplicates] };
}

/** Splits a byte stream into UTF-8 lines (without the `\n`); refuses a line over `maxLine`. */
export async function* lines(
  chunks: AsyncIterable<Buffer>,
  maxLine: number,
): AsyncGenerator<string> {
  let pending: Buffer[] = [];
  let pendingLen = 0;
  for await (const chunk of chunks) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) break;
      const piece = chunk.subarray(start, nl);
      if (pendingLen + piece.length > maxLine) throw new ZipFormatError("a line is too long");
      const line = pendingLen === 0 ? piece : Buffer.concat([...pending, piece]);
      pending = [];
      pendingLen = 0;
      yield line.toString("utf8");
      start = nl + 1;
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0) {
      pendingLen += rest.length;
      if (pendingLen > maxLine) throw new ZipFormatError("a line is too long");
      pending.push(Buffer.from(rest));
    }
  }
  if (pendingLen > 0) yield Buffer.concat(pending).toString("utf8");
}
