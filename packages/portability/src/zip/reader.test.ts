import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { ZipFileReader } from "./reader.js";
import { ZipFileWriter } from "./writer.js";

/*
 * Adversarial archives against the strict reader (E2.8 fix C, item 2). Each archive is built by
 * hand so a test can make exactly one field lie; `rawZip` with no overrides produces an archive
 * the reader accepts (asserted first), so every refusal below is caused by the one lie.
 */

interface RawEntry {
  readonly name: string | Buffer;
  readonly data: Buffer;
  readonly method?: 0 | 8;
  readonly flags?: number;
  /** Data descriptor: the local header carries zeros, 16 bytes (with signature) follow the data. */
  readonly descriptor?: boolean;
  readonly local?: {
    readonly name?: Buffer;
    readonly method?: number;
    readonly flags?: number;
    readonly crc?: number;
    readonly size?: number;
    readonly compressed?: number;
  };
  readonly central?: {
    readonly crc?: number;
    readonly size?: number;
    readonly compressed?: number;
    readonly offset?: number;
    readonly extra?: Buffer;
    readonly comment?: Buffer;
    readonly flags?: number;
  };
  /** Bytes inserted after this entry (before the next local header). */
  readonly gapAfter?: Buffer;
}

interface RawOptions {
  readonly prefix?: Buffer;
  readonly comment?: Buffer;
  readonly count?: number;
  /** Bytes between the directory and the end record. */
  readonly afterDirectory?: Buffer;
  /** Write a ZIP64 end record + locator; the 32-bit end record fields are saturated. */
  readonly zip64?: { readonly count?: number; readonly eocdCount?: number };
}

const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
};
const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
};
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v, 0);
  return b;
};

function rawZip(entries: readonly RawEntry[], opts: RawOptions = {}): Buffer {
  const parts: Buffer[] = [];
  let pos = 0;
  const push = (b: Buffer) => {
    parts.push(b);
    pos += b.length;
  };
  if (opts.prefix) push(opts.prefix);
  const central: Buffer[] = [];
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, "utf8");
    const method = e.method ?? 0;
    const flags = (e.flags ?? 0x0800) | (e.descriptor ? 0x0008 : 0);
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data) >>> 0;
    const offset = pos;
    const lname = e.local?.name ?? name;
    push(
      Buffer.concat([
        u32(0x04034b50),
        u16(20),
        u16(e.local?.flags ?? flags),
        u16(e.local?.method ?? method),
        u16(0),
        u16(0),
        u32(e.local?.crc ?? (e.descriptor ? 0 : crc)),
        u32(e.local?.compressed ?? (e.descriptor ? 0 : body.length)),
        u32(e.local?.size ?? (e.descriptor ? 0 : e.data.length)),
        u16(lname.length),
        u16(0),
        lname,
      ]),
    );
    push(body);
    if (e.descriptor)
      push(Buffer.concat([u32(0x08074b50), u32(crc), u32(body.length), u32(e.data.length)]));
    if (e.gapAfter) push(e.gapAfter);
    const extra = e.central?.extra ?? Buffer.alloc(0);
    const comment = e.central?.comment ?? Buffer.alloc(0);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(e.central?.flags ?? flags),
        u16(method),
        u16(0),
        u16(0),
        u32(e.central?.crc ?? crc),
        u32(e.central?.compressed ?? body.length),
        u32(e.central?.size ?? e.data.length),
        u16(name.length),
        u16(extra.length),
        u16(comment.length),
        u16(0),
        u16(0),
        u32(0),
        u32(e.central?.offset ?? offset),
        name,
        extra,
        comment,
      ]),
    );
  }
  const cdStart = pos;
  for (const c of central) push(c);
  const cdSize = pos - cdStart;
  if (opts.afterDirectory) push(opts.afterDirectory);
  const count = opts.count ?? entries.length;
  if (opts.zip64) {
    const rec = pos;
    const n = BigInt(opts.zip64.count ?? count);
    push(
      Buffer.concat([
        u32(0x06064b50),
        u64(44n),
        u16(45),
        u16(45),
        u32(0),
        u32(0),
        u64(n),
        u64(n),
        u64(BigInt(cdSize)),
        u64(BigInt(cdStart)),
      ]),
    );
    push(Buffer.concat([u32(0x07064b50), u32(0), u64(BigInt(rec)), u32(1)]));
  }
  const eocdCount = opts.zip64 ? (opts.zip64.eocdCount ?? 0xffff) : count;
  const comment = opts.comment ?? Buffer.alloc(0);
  push(
    Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(eocdCount),
      u16(eocdCount),
      u32(opts.zip64 ? 0xffffffff : cdSize),
      u32(opts.zip64 ? 0xffffffff : cdStart),
      u16(comment.length),
      comment,
    ]),
  );
  return Buffer.concat(parts);
}

let dir: string;
let n = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "zip-reader-"));
});

function file(bytes: Buffer): string {
  n += 1;
  const path = join(dir, `a${n}.zip`);
  writeFileSync(path, bytes);
  return path;
}

async function openBytes(bytes: Buffer): Promise<ZipFileReader> {
  return ZipFileReader.open(file(bytes));
}

async function refused(bytes: Buffer, pattern: RegExp): Promise<void> {
  await expect(openBytes(bytes)).rejects.toThrow(pattern);
}

const A_NAME = "tables/core.a.jsonl";
const B_NAME = "README.md";
const A: RawEntry = { name: A_NAME, data: Buffer.from('{"a":1}\n'), method: 8 };
const B: RawEntry = { name: B_NAME, data: Buffer.from("# hello\n") };

describe("the strict zip reader: the baseline is accepted", () => {
  it("reads a hand-built archive, with and without a data descriptor, and ZIP64 end records", async () => {
    for (const bytes of [
      rawZip([A, B]),
      rawZip([{ ...A, descriptor: true }, B]),
      rawZip([A, B], { zip64: {} }),
    ]) {
      const r = await openBytes(bytes);
      expect(r.entries.map((e) => e.name)).toEqual([A_NAME, B_NAME]);
      expect((await r.readAll(r.entry(A_NAME) as never)).toString()).toBe('{"a":1}\n');
      expect((await r.readAll(r.entry(B_NAME) as never)).toString()).toBe("# hello\n");
      await r.close();
    }
  });

  it("reads what its own writer produces (entry lookup is by name)", async () => {
    const path = join(dir, "own.zip");
    const w = await ZipFileWriter.create(path, new Date());
    for (let i = 0; i < 300; i++)
      await w.add(`blobs/${String(i).padStart(64, "0")}`, [], {
        deflate: false,
      });
    await w.finish();
    const r = await ZipFileReader.open(path);
    expect(r.entries).toHaveLength(300);
    expect(r.entry(`blobs/${"299".padStart(64, "0")}`)?.size).toBe(0);
    await r.close();
  });
});

describe("the strict zip reader refuses", () => {
  it("a local header that disagrees with the directory (name, method, flags, CRC, sizes)", async () => {
    await refused(
      rawZip([{ ...A, local: { name: Buffer.from("tables/core.b.jsonl") } }, B]),
      /names a different file/u,
    );
    await refused(rawZip([{ ...A, local: { method: 0 } }, B]), /disagree on the method/u);
    await refused(rawZip([{ ...A, local: { flags: 0 } }, B]), /disagree on the flags/u);
    await refused(rawZip([{ ...B, local: { crc: 1 } }]), /CRC or the sizes/u);
    await refused(rawZip([{ ...B, local: { size: 3, compressed: 3 } }]), /CRC or the sizes/u);
    // With a data descriptor the local values must be zero or the real ones — not something else.
    await refused(rawZip([{ ...B, descriptor: true, local: { size: 99 } }]), /CRC or the sizes/u);
  });

  it("overlapping entries (two directory records, one payload) and hidden bytes", async () => {
    // B's directory record points at A's local header under A's own name: a duplicate that
    // overlaps. (A different name would already fail the local-name check.)
    await refused(rawZip([A, { ...A, central: { offset: 0 } }]), /overlap/u);
    await refused(rawZip([A, B], { prefix: Buffer.from("MZ polyglot prefix") }), /hidden data/u);
    await refused(rawZip([{ ...A, gapAfter: Buffer.from("smuggled") }, B]), /hidden data/u);
    await refused(rawZip([A, B], { afterDirectory: Buffer.from("xx") }), /does not end where/u);
    // A declared compressed size that runs into the directory.
    await refused(
      rawZip([A, { ...B, central: { compressed: 9_999 } }]),
      /stored entry whose|runs into/u,
    );
    await refused(rawZip([{ ...A, central: { compressed: 9_999 } }]), /CRC or the sizes/u);
  });

  it("entry count mismatches", async () => {
    await refused(rawZip([A, B], { count: 1 }), /more than the declared entries/u);
    await refused(rawZip([A, B], { count: 3 }), /entry count/u);
    await refused(rawZip([A, B], { zip64: { count: 3 } }), /entry count/u);
    await refused(rawZip([A, B], { zip64: { eocdCount: 1 } }), /disagree on the entry count/u);
  });

  it("comments (a comment can carry a fake end record), file comments included", async () => {
    await refused(rawZip([A, B], { comment: Buffer.from("hello") }), /comments are not supported/u);
    const fakeEnd = Buffer.concat([u32(0x06054b50), Buffer.alloc(18)]);
    await refused(rawZip([A, B], { comment: fakeEnd }), /does not end where|comments/u);
    await refused(
      rawZip([{ ...B, central: { comment: Buffer.from("x") } }]),
      /file comments are not supported/u,
    );
  });

  it("names with .., an absolute path, a backslash, NUL, a drive letter, an empty segment, bad UTF-8", async () => {
    for (const [name, pattern] of [
      ["../../etc/passwd", /"\."|"\.\." path segment|path segment/u],
      ["tables/../x", /path segment/u],
      ["/etc/passwd", /absolute path/u],
      ["C:/x", /absolute path/u],
      ["blobs\\x", /backslash/u],
      ["manifest.json\u0000.txt", /NUL/u],
      ["blobs//x", /path segment/u],
      ["./README.md", /path segment/u],
    ] as const) {
      await refused(rawZip([{ ...B, name }]), pattern);
    }
    await refused(rawZip([{ ...B, name: Buffer.from([0x61, 0xff, 0x62]) }]), /not valid UTF-8/u);
  });

  it("fake ZIP64 sizes and offsets", async () => {
    // Saturated 32-bit size with no ZIP64 extra field.
    await refused(rawZip([{ ...B, central: { size: 0xffffffff } }]), /without a ZIP64 extra/u);
    // A ZIP64 extra field too short for the saturated fields it must carry.
    const short = Buffer.concat([u16(1), u16(8), u64(8n)]);
    await refused(
      rawZip([{ ...B, central: { size: 0xffffffff, compressed: 0xffffffff, extra: short } }]),
      /too short/u,
    );
    // A 64-bit size past Number.MAX_SAFE_INTEGER.
    const huge = Buffer.concat([u16(1), u16(8), u64(2n ** 62n)]);
    await refused(rawZip([{ ...B, central: { size: 0xffffffff, extra: huge } }]), /does not fit/u);
    // A 64-bit local header offset past the entry area.
    const far = Buffer.concat([u16(1), u16(8), u64(10_000n)]);
    await refused(
      rawZip([{ ...B, central: { offset: 0xffffffff, extra: far } }]),
      /outside the entry area/u,
    );
    // An extra field whose declared length runs past the record.
    const ragged = Buffer.concat([u16(0x5455), u16(40), Buffer.alloc(4)]);
    await refused(rawZip([{ ...B, central: { extra: ragged } }]), /malformed extra field/u);
  });

  it("encryption, unknown flags, exotic methods and a stored entry whose sizes differ", async () => {
    await refused(rawZip([{ ...B, flags: 0x0801 }]), /encrypted/u);
    await refused(rawZip([{ ...B, flags: 0x2800 }]), /unsupported general-purpose flags/u);
    await refused(rawZip([{ ...B, central: { compressed: 3 } }]), /stored entry whose two sizes/u);
  });

  it("truncated archives", async () => {
    const whole = rawZip([A, B]);
    await refused(whole.subarray(0, whole.length - 1), /no end of central directory/u);
    await refused(whole.subarray(0, 10), /too short/u);
    // The end record survives but the directory it points at is cut away.
    const cut = Buffer.concat([whole.subarray(0, 20), whole.subarray(whole.length - 22)]);
    await refused(cut, /does not end where|out of range|truncated|entry count/u);
  });

  it("a declared-small entry that inflates huge (bomb): one chunk read, then refused", async () => {
    const bomb = Buffer.alloc(20 * 1024 * 1024, 0);
    const bytes = rawZip([
      {
        name: "tables/core.a.jsonl",
        data: bomb,
        method: 8,
        central: { size: 100 },
        local: { size: 100 },
      },
    ]);
    expect(bytes.length).toBeLessThan(100_000);
    const r = await openBytes(bytes);
    let seen = 0;
    await expect(
      (async () => {
        for await (const chunk of r.read(r.entry("tables/core.a.jsonl") as never))
          seen += chunk.length;
      })(),
    ).rejects.toThrow(/inflates beyond its declared 100 bytes/u);
    expect(seen).toBeLessThanOrEqual(100);
    await r.close();
  });
});
