import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeyRingEntry } from "@fundroom/config";
import { defineModule } from "@fundroom/module-kit";
import { beforeAll, describe, expect, it } from "vitest";
import { rederiveAccess } from "./import.js";
import {
  ENTRY,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  type ExportManifest,
  exportSigningKey,
  findUndeclared,
  IdMap,
  KERNEL_TABLES,
  lines,
  type ManifestTable,
  manifestBytes,
  planTables,
  signManifest,
  uuidv7,
  verificationExitCode,
  verifyExportFile,
  ZipFileReader,
  ZipFileWriter,
} from "./index.js";

/*
 * Unit tests of the pieces that need no database: the id remap, the ZIP container, the manifest
 * signature and the offline verifier against tampered, bomb-shaped and duplicate-entry archives.
 */

const WS = "0190f1a0-0000-7000-8000-000000000001";
const entryOf = (id: string, fill: number): KeyRingEntry => ({
  id,
  key: new Uint8Array(32).fill(fill),
  fingerprint: `sha256:${id}`,
});
const KEY = entryOf("v1", 7);
const OTHER = entryOf("v9", 9);
const pub = (e: KeyRingEntry) => Buffer.from(exportSigningKey(e).publicKey).toString("base64");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "portability-unit-"));
});

function auditRows(n: number): { seq: number; canonical: string; hash: string }[] {
  const out: { seq: number; canonical: string; hash: string }[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const canonical = JSON.stringify({
      id: uuidv7(),
      workspace_id: WS,
      seq,
      occurred_at: "2026-09-23T00:00:00.000Z",
      action: "test.happened",
      prev_hash: prev,
    });
    const hash = sha(canonical);
    out.push({ seq, canonical, hash });
    prev = hash;
  }
  return out;
}

interface Build {
  /** Replace an entry's bytes AFTER the manifest was computed (tampering). */
  readonly tamper?: Record<string, string>;
  /** Mutate the manifest before signing. */
  readonly manifest?: (m: ExportManifest) => ExportManifest;
  readonly signWith?: KeyRingEntry;
  readonly extra?: readonly [string, string][];
  /** Leave these entries out (and out of `files`). */
  readonly omitBlobs?: boolean;
}

/** A small but complete export: one table, one blob, three audit rows. */
async function buildExport(name: string, opts: Build = {}): Promise<string> {
  const blob = Buffer.from("the deck, decrypted");
  const blobSha = sha(blob);
  const row = {
    id: "0190f1a0-0000-7000-8000-0000000000aa",
    workspace_id: WS,
    storage_key: `blob:${blobSha}`,
    $blobs: {
      storage_key: { sha256: blobSha, key: `ws/${WS}/blobs/${blobSha}`, size: blob.length },
    },
  };
  const events = auditRows(3);
  const content: [string, string | Buffer][] = [
    [
      "tables/core.workspace.jsonl",
      `${JSON.stringify({ id: WS, slug: "acme", name: "Acme", settings: {} })}\n`,
    ],
    ["tables/dataroom.blob.jsonl", `${JSON.stringify(row)}\n`],
    [ENTRY.auditEvents, events.map((e) => `${JSON.stringify(e)}\n`).join("")],
    [ENTRY.auditCheckpoints, "[]\n"],
    [`blobs/${blobSha}`, blob],
    [ENTRY.readme, "# readme\n"],
  ];
  if (opts.omitBlobs)
    content.splice(
      content.findIndex(([n]) => n.startsWith("blobs/")),
      1,
    );
  const files: Record<string, string> = {};
  for (const [n, b] of content) files[n] = sha(b);
  const signer = opts.signWith ?? KEY;
  let manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_FORMAT_VERSION,
    exportedAt: "2026-09-23T00:00:00.000Z",
    source: { workspaceId: WS, slug: "acme", name: "Acme", instanceVersion: "test" },
    options: { includeRawAnalytics: false },
    modules: { core: { version: 1, migrations: [] } },
    tables: [
      { name: "core.workspace", rows: 1, sha256: files["tables/core.workspace.jsonl"] },
      { name: "dataroom.blob", rows: 1, sha256: files["tables/dataroom.blob.jsonl"] },
      { name: "core.effective_access", rows: 0, skipped: "derived" },
    ],
    blobs: { count: 1, bytes: blob.length },
    files,
    audit: {
      rows: 3,
      fromSeq: 1,
      headSeq: 3,
      headHash: events[2]?.hash ?? null,
      prevHash: null,
    },
    signature: { alg: "Ed25519", keyId: signer.id, publicKey: pub(signer) },
  };
  if (opts.manifest) manifest = opts.manifest(manifest);
  const path = join(dir, `${name}.zip`);
  const zip = await ZipFileWriter.create(path, new Date("2026-09-23T00:00:00Z"));
  const bytes = manifestBytes(manifest);
  await zip.add(ENTRY.manifest, [bytes], { deflate: false });
  await zip.add(ENTRY.signature, [Buffer.from(signManifest(bytes, exportSigningKey(signer)))], {
    deflate: false,
  });
  for (const [n, b] of content) {
    const body = opts.tamper?.[n] ?? b;
    await zip.add(n, [Buffer.from(body)], { deflate: !n.startsWith("blobs/") });
  }
  for (const [n, b] of opts.extra ?? []) await zip.add(n, [Buffer.from(b)], { deflate: false });
  await zip.finish();
  return path;
}

describe("ids", () => {
  it("uuidv7 is monotonic in minting order, even thousands per millisecond", () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7(1_758_600_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids.slice(0, 3))
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("allocates new ids in source order, so source pk order survives the remap", () => {
    const map = new IdMap();
    const source = Array.from({ length: 200 }, () => uuidv7());
    const mapped = source.map((id) => map.allocate(id));
    expect([...mapped].sort()).toEqual(mapped);
    expect(map.allocate(source[0] as string)).toBe(mapped[0]);
  });

  it("deep-remaps exact ids in values and keys, at any depth, and nothing else", () => {
    const map = new IdMap();
    const a = "0190f1a0-0000-7000-8000-0000000000a1";
    const b = "0190f1a0-0000-7000-8000-0000000000b2";
    const newA = map.allocate(a);
    const newB = map.allocate(b);
    const stranger = "0190f1a0-0000-7000-8000-0000000000ff";
    const out = map.deepRemap({
      id: a,
      group_ids: [a, b, stranger],
      grants: [{ resource: { kind: "folder", id: b, path: "x" }, n: 3, ok: true, none: null }],
      byId: { [a]: 1 },
      prose: `see ${a}`,
      upper: a.toUpperCase(),
    });
    expect(out).toEqual({
      id: newA,
      group_ids: [newA, newB, stranger],
      grants: [{ resource: { kind: "folder", id: newB, path: "x" }, n: 3, ok: true, none: null }],
      byId: { [newA]: 1 },
      prose: `see ${a}`,
      upper: newA,
    });
  });

  it("remaps ltree labels and object keys by uuid, leaving digests and strangers alone", () => {
    const map = new IdMap();
    const folder = "0190f1a0-0000-7000-8000-0000000000c3";
    const ws = "0190f1a0-0000-7000-8000-0000000000d4";
    const nf = map.allocate(folder).replaceAll("-", "");
    const nw = map.allocate(ws);
    const digest = `${folder.replaceAll("-", "")}${"0".repeat(32)}`; // 64 hex: not an id
    expect(map.remapLtree(`root.${folder.replaceAll("-", "")}.other`)).toBe(`root.${nf}.other`);
    expect(map.remapKey(`ws/${ws}/blobs/${digest}`)).toBe(`ws/${nw}/blobs/${digest}`);
    expect(map.remapKey(`round/verification/${ws}/${folder}`)).toBe(
      `round/verification/${nw}/${map.mapId(folder)}`,
    );
    expect(map.remapKey(`x/${folder.replaceAll("-", "")}`)).toBe(`x/${nf}`);
  });
});

describe("zip container", () => {
  it("round-trips stored and deflated entries with CRC and size checks, directory order as asked", async () => {
    const path = join(dir, "rt.zip");
    const zip = await ZipFileWriter.create(path, new Date());
    const big = Buffer.alloc(300_000, "ab\n");
    await zip.add("b.txt", [big], { deflate: true });
    await zip.add("a.bin", [Buffer.from([1, 2, 3])], { deflate: false });
    await zip.add("empty", [], { deflate: false });
    await zip.finish(["a.bin"]);
    const r = await ZipFileReader.open(path);
    expect(r.entries.map((e) => e.name)).toEqual(["a.bin", "b.txt", "empty"]);
    expect((await r.readAll(r.entry("b.txt") as never)).equals(big)).toBe(true);
    expect([...(await r.readAll(r.entry("a.bin") as never))]).toEqual([1, 2, 3]);
    expect((await r.readAll(r.entry("empty") as never)).length).toBe(0);
    let n = 0;
    for await (const _ of lines(r.read(r.entry("b.txt") as never), 10)) n += 1;
    expect(n).toBe(100_000);
    await r.close();
  });

  it("refuses an entry that inflates past its declared size (bomb) and a CRC mismatch", async () => {
    const path = join(dir, "bomb.zip");
    const zip = await ZipFileWriter.create(path, new Date());
    await zip.add("x.jsonl", [Buffer.alloc(1_000_000, 0x61)], { deflate: true });
    await zip.finish();
    const bytes = readFileSync(path);
    const cd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    // Local header and directory must agree (the reader checks), so the lie goes into both: the
    // central size field and the local header's ZIP64 extra (id, len, then the size).
    const localSize = 30 + "x.jsonl".length + 4;
    const bomb = Buffer.from(bytes);
    bomb.writeUInt32LE(1000, cd + 24); // declares 1000 bytes
    bomb.writeBigUInt64LE(1000n, localSize);
    writeFileSync(path, bomb);
    const r = await ZipFileReader.open(path);
    await expect(r.readAll(r.entry("x.jsonl") as never)).rejects.toThrow(/inflates beyond/u);
    await r.close();
    const crc = Buffer.from(bytes);
    crc.writeUInt32LE(0xdeadbeef, cd + 16);
    crc.writeUInt32LE(0xdeadbeef, 14);
    writeFileSync(path, crc);
    const r2 = await ZipFileReader.open(path);
    await expect(r2.readAll(r2.entry("x.jsonl") as never)).rejects.toThrow(/CRC/u);
    await r2.close();
  });
});

describe("the offline verifier", () => {
  it("verifies an intact export: trusted with the pinned key (exit 0), unpinned is exit 3", async () => {
    const path = await buildExport("ok");
    const pinned = await verifyExportFile(path, { trustedPublicKeys: [pub(KEY)] });
    expect(pinned.problems).toEqual([]);
    expect(pinned.trusted).toBe(true);
    expect(verificationExitCode(pinned)).toBe(0);
    expect(pinned.stats).toMatchObject({ tables: 2, rows: 2, blobs: 1, auditRows: 3 });
    const unpinned = await verifyExportFile(path);
    expect(unpinned.ok).toBe(true);
    expect(verificationExitCode(unpinned)).toBe(3);
  });

  it("fails on a key nobody pinned, even though the signature is internally valid", async () => {
    const path = await buildExport("other-key", { signWith: OTHER });
    const v = await verifyExportFile(path, { trustedPublicKeys: [pub(KEY)] });
    expect(v.trusted).toBe(false);
    expect(verificationExitCode(v)).toBe(1);
  });

  it("catches an edited table line, an edited blob and an edited manifest", async () => {
    const edited = await buildExport("edited-row", {
      tamper: { "tables/core.workspace.jsonl": `${JSON.stringify({ id: WS, slug: "evil" })}\n` },
    });
    expect((await verifyExportFile(edited)).problems).toContain(
      "tables/core.workspace.jsonl: sha256 differs from the manifest",
    );
    const blobName = (await ZipFileReader.open(edited)).entries.find((e) =>
      e.name.startsWith("blobs/"),
    )?.name as string;
    const blob = await buildExport("edited-blob", { tamper: { [blobName]: "swapped" } });
    const vb = await verifyExportFile(blob);
    expect(vb.problems).toEqual(
      expect.arrayContaining([
        `${blobName}: sha256 differs from the manifest`,
        `${blobName}: its bytes do not hash to its name`,
      ]),
    );
    // A manifest edited after signing: rebuild the zip with a changed manifest but the old sig.
    const good = await buildExport("good-for-sig");
    const r = await ZipFileReader.open(good);
    const sig = await r.readAll(r.entry(ENTRY.signature) as never);
    const manifest = JSON.parse((await r.readAll(r.entry(ENTRY.manifest) as never)).toString());
    manifest.tables[1].rows = 0;
    const path = join(dir, "forged-manifest.zip");
    const zip = await ZipFileWriter.create(path, new Date());
    await zip.add(ENTRY.manifest, [manifestBytes(manifest)], { deflate: false });
    await zip.add(ENTRY.signature, [sig], { deflate: false });
    for (const e of r.entries) {
      if (e.name === ENTRY.manifest || e.name === ENTRY.signature) continue;
      await zip.add(e.name, [await r.readAll(e)], { deflate: false });
    }
    await zip.finish();
    await r.close();
    const vf = await verifyExportFile(path, { trustedPublicKeys: [pub(KEY)] });
    expect(vf.problems).toEqual(
      expect.arrayContaining([
        "manifest signature does not verify",
        "tables/dataroom.blob.jsonl has 1 rows, the manifest says 0",
      ]),
    );
  });

  it("the signature covers every entry: tables, blobs, audit events, checkpoints and the README", async () => {
    // Every entry except manifest.json/manifest.sig is hashed in the signed manifest, so editing
    // ANY of them (without re-signing) is caught; the list is exactly the zip's content.
    for (const name of [
      "tables/core.workspace.jsonl",
      "tables/dataroom.blob.jsonl",
      ENTRY.auditEvents,
      ENTRY.auditCheckpoints,
      ENTRY.readme,
    ]) {
      const path = await buildExport(`tamper-${name.replaceAll("/", "_")}`, {
        tamper: { [name]: "[ ]\n" },
      });
      const v = await verifyExportFile(path, { trustedPublicKeys: [pub(KEY)] });
      expect(v.ok).toBe(false);
      expect(v.problems.some((p) => p.startsWith(`${name}:`))).toBe(true);
    }
    // An entry the manifest does not list, and a listed entry the zip lacks.
    const extra = await buildExport("unlisted", { extra: [[`blobs/${"b".repeat(64)}`, "x"]] });
    expect((await verifyExportFile(extra)).problems).toContain(
      `blobs/${"b".repeat(64)} is in the zip but not in the manifest`,
    );
    const missing = await buildExport("missing-blob", { omitBlobs: true });
    expect((await verifyExportFile(missing)).ok).toBe(false);
  });

  it("refuses a manifest that lists one table twice (two readings of one entry)", async () => {
    const path = await buildExport("dup-table", {
      manifest: (m) => ({
        ...m,
        tables: [...m.tables, { ...(m.tables[1] as ManifestTable), rows: 0 }],
      }),
    });
    const v = await verifyExportFile(path, { trustedPublicKeys: [pub(KEY)] });
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("manifest lists table dataroom.blob more than once");
  });

  it("refuses duplicate entry names and entries an export never contains", async () => {
    const dup = await buildExport("dup", { extra: [[ENTRY.readme, "# forged\n"]] }).catch(
      (e: Error) => e,
    );
    // The writer itself refuses duplicates; build the duplicate by hand-patching a name.
    expect(dup).toBeInstanceOf(Error);
    const path = await buildExport("dup2", { extra: [["README.mX", "# forged\n"]] });
    const bytes = readFileSync(path);
    const patched = Buffer.from(
      bytes.toString("latin1").replaceAll("README.mX", "README.md"),
      "latin1",
    );
    writeFileSync(path, patched);
    const v = await verifyExportFile(path);
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/README\.md appears more than once/u);

    const unexpected = await buildExport("unexpected", { extra: [["../../etc/passwd", "x"]] });
    const vu = await verifyExportFile(unexpected);
    // The reader itself refuses a traversal name before anything is classified.
    expect(vu.ok).toBe(false);
    expect(vu.problems[0]).toMatch(/not a readable zip: .*"\.\." path segment/u);
    const stranger = await buildExport("stranger", { extra: [["etc/passwd", "x"]] });
    const vs = await verifyExportFile(stranger);
    expect(vs.problems).toContain("etc/passwd is in the zip but is not part of a workspace export");
  });

  it("refuses an entry declared larger than 5 GiB before reading it", async () => {
    // A hand-made ZIP64 central record declaring 6 GiB for a 1-byte stored entry.
    // Local header and directory agree (deflate, ZIP64 sizes in both), so only the size lies.
    const name = Buffer.from(`blobs/${"a".repeat(64)}`);
    const local = Buffer.alloc(30 + name.length + 20);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(20, 28);
    name.copy(local, 30);
    local.writeUInt16LE(1, 30 + name.length);
    local.writeUInt16LE(16, 32 + name.length);
    local.writeBigUInt64LE(6n * 1024n ** 3n, 34 + name.length);
    local.writeBigUInt64LE(1n, 42 + name.length);
    const data = Buffer.from("x");
    const cd = Buffer.alloc(46 + name.length + 20);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(45, 4);
    cd.writeUInt16LE(45, 6);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(0xffffffff, 20);
    cd.writeUInt32LE(0xffffffff, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(20, 30);
    name.copy(cd, 46);
    cd.writeUInt16LE(1, 46 + name.length);
    cd.writeUInt16LE(16, 48 + name.length);
    cd.writeBigUInt64LE(6n * 1024n ** 3n, 50 + name.length);
    cd.writeBigUInt64LE(1n, 58 + name.length);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(local.length + data.length, 16);
    const path = join(dir, "huge.zip");
    writeFileSync(path, Buffer.concat([local, data, cd, eocd]));
    const v = await verifyExportFile(path);
    expect(v.problems).toContain(`blobs/${"a".repeat(64)} is larger than 5 GiB`);
  });

  it("refuses an unknown major version and a broken audit chain", async () => {
    const v2 = await buildExport("v2", { manifest: (m) => ({ ...m, version: 2 }) });
    expect((await verifyExportFile(v2)).problems).toEqual([
      "unsupported export format version 2 (this build reads version 1)",
    ]);
    const chain = await buildExport("chain", {
      tamper: {
        [ENTRY.auditEvents]: auditRows(3)
          .map((e, i) => `${JSON.stringify(i === 1 ? { ...e, hash: "00".repeat(32) } : e)}\n`)
          .join(""),
      },
    });
    const vc = await verifyExportFile(chain);
    expect(vc.problems.some((p) => p.startsWith("audit chain:"))).toBe(true);
  });

  it("refuses a row that references a blob the zip does not hold", async () => {
    const path = await buildExport("missing-blob", { omitBlobs: true });
    const v = await verifyExportFile(path);
    expect(
      v.problems.some((p) =>
        /a row references blob [0-9a-f]{64}, which is not in the zip/u.test(p),
      ),
    ).toBe(true);
  });
});

describe("the table plan", () => {
  it("declares every kernel table once, with a reason for every skip", () => {
    const names = KERNEL_TABLES.map((t) => `${t.schema}.${t.table}`);
    expect(new Set(names).size).toBe(names.length);
    for (const t of KERNEL_TABLES) if (t.mode === "skip") expect(t.reason).toBeDefined();
    expect(names).toEqual(expect.arrayContaining(["core.membership", "core.mail_suppression"]));
  });

  it("orders modules by `after`, and flags a module table nobody declared", () => {
    const b = defineModule({
      id: "bbb",
      version: "1.0.0",
      schema: "bbb",
      migrations: "file:///nowhere",
      portability: { version: 1, after: ["ccc"], tables: [{ table: "one", mode: "rows" }] },
    });
    const c = defineModule({
      id: "ccc",
      version: "1.0.0",
      schema: "ccc",
      migrations: "file:///nowhere",
      portability: { version: 1, tables: [{ table: "two", mode: "rows" }] },
    });
    const plan = planTables([b, c]);
    const order = plan.map((p) => p.name);
    expect(order.indexOf("ccc.two")).toBeLessThan(order.indexOf("bbb.one"));
    expect(order[0]).toBe("core.workspace");
    const undeclared = findUndeclared(
      [
        { schema: "bbb", table: "one", hasWorkspaceId: true },
        { schema: "bbb", table: "new_table", hasWorkspaceId: true },
        { schema: "core", table: "brand_new", hasWorkspaceId: true },
        { schema: "core", table: "user", hasWorkspaceId: false },
        { schema: "pgboss", table: "job", hasWorkspaceId: false },
      ],
      plan,
      [b, c],
    );
    expect(undeclared).toEqual(["bbb.new_table", "core.brand_new"]);
  });
});

describe("import re-derivation (E3.2)", () => {
  const tx = {} as never;
  const ctx = { workspaceId: WS, actorKind: "system" } as never;

  it("re-derives rule paths before the effective-access rebuild, and warns with the count", async () => {
    const calls: string[] = [];
    const warnings = await rederiveAccess(
      {
        rederiveRulePaths: async (t, c) => {
          expect([t, c]).toEqual([tx, ctx]);
          calls.push("rederive");
          return 3;
        },
        rebuildAccess: async () => {
          calls.push("rebuild");
        },
      },
      tx,
      ctx,
    );
    expect(calls).toEqual(["rederive", "rebuild"]);
    expect(warnings).toEqual([expect.stringMatching(/^3 access rule\(s\) or pending invitation/u)]);
  });

  it("says nothing when no path changed, and still rebuilds without a re-deriver", async () => {
    const calls: string[] = [];
    const rebuildAccess = async () => {
      calls.push("rebuild");
    };
    expect(
      await rederiveAccess({ rederiveRulePaths: async () => 0, rebuildAccess }, tx, ctx),
    ).toEqual([]);
    expect(await rederiveAccess({ rebuildAccess }, tx, ctx)).toEqual([]);
    expect(calls).toEqual(["rebuild", "rebuild"]);
  });
});
