import { createHash, sign } from "node:crypto";
import type { KeyRing, KeyRingEntry } from "@fundroom/config";
import { csvField } from "@fundroom/csv";
import { strFromU8, strToU8, unzipSync, Zip, ZipPassThrough, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { checkpointLeafHash } from "./anchor-proof.js";
import {
  anchorsComplete,
  buildExportBundle,
  type ExportAnchor,
  type ExportBundleInput,
  type ExportCheckpoint,
  type ExportManifest,
  eventsCsv,
  exportPublicKeys,
  exportSigningKey,
  exportVerificationExitCode,
  formatExportVerification,
  UNVERIFIED_ORIGIN_LINE,
  verifyExportBundle,
  verifyExportBundleAnchored,
} from "./bundle.js";
import { ExportRangeTooLargeError, MAX_EXPORT_ROWS } from "./export.js";
import { buildMerkleTree, merkleLeafHash, toHex } from "./merkle.js";
import { createFakeAnchor } from "./testing/fake-anchor.js";

const WS = "0190f1a0-0000-7000-8000-000000000001";

function entry(id: string, fill: number): KeyRingEntry {
  return { id, key: new Uint8Array(32).fill(fill), fingerprint: `sha256:${id}` };
}
const V2 = entry("v2", 2);
const V1 = entry("v1", 1);
const ring: KeyRing = {
  current: V2,
  entries: [V2, V1],
  get: (id) => [V2, V1].find((e) => e.id === id),
};

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** A real chain: canonical texts exactly shaped like `audit.canonical()` output. */
function chain(fromSeq: number, count: number, prevHash: string | null) {
  const rows: { seq: number; canonical: string; hash: Uint8Array }[] = [];
  let prev = prevHash;
  for (let seq = fromSeq; seq < fromSeq + count; seq++) {
    const canonical = JSON.stringify({
      id: `0190f1a0-0000-7000-8000-${String(seq).padStart(12, "0")}`,
      workspace_id: WS,
      seq,
      occurred_at: `2026-09-${String(10 + (seq % 10)).padStart(2, "0")}T10:00:00.000000Z`,
      actor_kind: "staff",
      actor_membership_id: null,
      action: seq === fromSeq ? "access.invited" : "grant.changed",
      resource_kind: "grant",
      outcome: "success",
      ip: "10.0.0.0/24",
      user_agent: '=HYPERLINK("http://evil")',
      meta: { n: seq },
      prev_hash: prev,
    });
    const hash = sha(canonical);
    rows.push({ seq, canonical, hash: Buffer.from(hash, "hex") });
    prev = hash;
  }
  return rows;
}

const PREV = sha("row four");

function input(overrides: Partial<ExportBundleInput> = {}): ExportBundleInput {
  return {
    workspace: { id: WS, slug: "acme", name: "Acme" },
    generatedAt: new Date("2026-09-22T12:00:00.000Z"),
    generatedBy: { membershipId: "0190f1a0-0000-7000-8000-00000000aaaa" },
    range: { from: new Date("2026-09-01T00:00:00Z"), to: null },
    rows: chain(5, 6, PREV),
    prevHash: PREV,
    checkpoints: [],
    signingKey: exportSigningKey(V2),
    ...overrides,
  };
}

const pub = (e: KeyRingEntry) => Buffer.from(exportSigningKey(e).publicKey).toString("base64");

/** Unzip, mutate, re-zip — the attacker's workflow. */
function tamper(bytes: Uint8Array, edit: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(bytes);
  edit(files);
  return zipSync(files);
}

function resign(
  files: Record<string, Uint8Array>,
  manifest: ExportManifest,
  withEntry: KeyRingEntry,
) {
  const key = exportSigningKey(withEntry);
  const m: ExportManifest = {
    ...manifest,
    signature: { ...manifest.signature, keyId: withEntry.id, publicKey: pub(withEntry) },
  };
  const bytes = strToU8(`${JSON.stringify(m, null, 2)}\n`);
  files["manifest.json"] = bytes;
  files["manifest.sig"] = strToU8(sign(null, bytes, key.privateKey).toString("base64"));
}

/** A zip written entry by entry — unlike `zipSync`, which cannot repeat a name. */
function zipEntries(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((err, chunk) => {
    if (err) throw err;
    chunks.push(chunk);
  });
  for (const [name, bytes] of entries) {
    const file = new ZipPassThrough(name);
    zip.add(file);
    file.push(bytes, true);
  }
  zip.end();
  return new Uint8Array(Buffer.concat(chunks));
}

describe("export key derivation", () => {
  it("is stable across calls and differs per key ring entry", () => {
    expect(pub(V2)).toBe(pub(V2));
    expect(pub(V2)).not.toBe(pub(V1));
    expect(exportSigningKey(V2).publicKey).toHaveLength(32);
    // Same key material under another id derives the same key: the id is a label, the HKDF
    // input is the key.
    expect(pub({ ...V2, id: "other" })).toBe(pub(V2));
  });

  it("is not the checkpoint HMAC key (different HKDF info)", () => {
    expect(pub(entry("x", 7))).not.toBe(pub(entry("x", 8)));
  });

  it("publishes every entry, current first", () => {
    expect(exportPublicKeys(ring)).toEqual([
      { keyId: "v2", publicKey: pub(V2), current: true },
      { keyId: "v1", publicKey: pub(V1), current: false },
    ]);
  });
});

describe("bundle round trip", () => {
  it("builds a bundle that verifies, pinned to the published key", () => {
    const b = buildExportBundle(input());
    expect(b.manifest).toMatchObject({
      version: 1,
      kind: "seed-host.audit-export",
      range: { fromSeq: 5, toSeq: 10, from: "2026-09-01T00:00:00.000Z", to: null },
      prevHash: PREV,
      rowCount: 6,
      signature: { alg: "Ed25519", keyId: "v2", publicKey: pub(V2) },
    });
    // Nothing anchored: a version-1 bundle, byte-compatible with verifiers before E3.13 (FIX1 A5).
    expect(Object.keys(b.manifest.files).sort()).toEqual([
      "VERIFY.md",
      "checkpoints.json",
      "events.csv",
      "events.jsonl",
    ]);
    const v = verifyExportBundle(b.bytes, { trustedPublicKeys: [pub(V1), pub(V2)] });
    expect(v.problems).toEqual([]);
    expect(v).toMatchObject({ ok: true, trusted: true, checkedRows: 6 });
    expect(createHash("sha256").update(b.bytes).digest("hex")).toBe(b.sha256);
  });

  it("is byte-deterministic for the same input", () => {
    expect(buildExportBundle(input()).sha256).toBe(buildExportBundle(input()).sha256);
  });

  it("an unpinned verify checks integrity but says origin is unknown", () => {
    const v = verifyExportBundle(buildExportBundle(input()).bytes);
    expect(v).toMatchObject({ ok: true, trusted: null });
  });

  it("unpinned is loud: UNVERIFIED ORIGIN on its own line, exit 3, no self-declared key id", () => {
    const b = buildExportBundle(input());
    const unpinned = verifyExportBundle(b.bytes);
    const text = formatExportVerification(unpinned);
    expect(text.split("\n")).toContain(UNVERIFIED_ORIGIN_LINE);
    expect(UNVERIFIED_ORIGIN_LINE.startsWith("UNVERIFIED ORIGIN — ")).toBe(true);
    expect(text).not.toMatch(/^OK/m);
    expect(text).not.toContain("key v2");
    expect(text).not.toContain(pub(V2));
    expect(exportVerificationExitCode(unpinned)).toBe(3);

    const pinned = verifyExportBundle(b.bytes, { trustedPublicKeys: [pub(V2)] });
    expect(exportVerificationExitCode(pinned)).toBe(0);
    expect(formatExportVerification(pinned)).toContain("signed by trusted key v2");
    expect(formatExportVerification(pinned)).not.toContain("UNVERIFIED ORIGIN");

    const wrong = verifyExportBundle(b.bytes, { trustedPublicKeys: [pub(V1)] });
    expect(exportVerificationExitCode(wrong)).toBe(1);
    expect(formatExportVerification(wrong)).toMatch(/^FAIL/m);
  });

  it("an unpinned truncated re-signed bundle is not reported as OK", () => {
    // Drop the tail, fix the counts, re-sign under a made-up key: internally consistent, so
    // only pinning catches it — and unpinned it must not read as a pass.
    const b = buildExportBundle(input());
    const forged = tamper(b.bytes, (f) => {
      const lines = strFromU8(f["events.jsonl"]!).trimEnd().split("\n").slice(0, 3);
      f["events.jsonl"] = strToU8(`${lines.join("\n")}\n`);
      const last = JSON.parse(lines.at(-1)!) as { seq: number; hash: string };
      const m = JSON.parse(strFromU8(f["manifest.json"]!)) as ExportManifest;
      const files = {
        ...m.files,
        "events.jsonl": createHash("sha256").update(f["events.jsonl"]!).digest("hex"),
      };
      resign(
        f,
        { ...m, rowCount: 3, headHash: last.hash, range: { ...m.range, toSeq: last.seq }, files },
        entry("evil", 9),
      );
    });
    const v = verifyExportBundle(forged);
    expect(v).toMatchObject({ ok: true, trusted: null });
    expect(exportVerificationExitCode(v)).toBe(3);
    expect(formatExportVerification(v)).toContain("UNVERIFIED ORIGIN");
    expect(verifyExportBundle(forged, { trustedPublicKeys: [pub(V2)] }).ok).toBe(false);
  });

  it("an empty range is a valid, empty bundle", () => {
    const b = buildExportBundle(input({ rows: [], prevHash: null }));
    expect(b.manifest).toMatchObject({ rowCount: 0, headHash: null, prevHash: null });
    expect(verifyExportBundle(b.bytes).ok).toBe(true);
  });

  it("refuses non-contiguous rows", () => {
    const rows = chain(1, 4, null);
    expect(() => buildExportBundle(input({ rows: [rows[0]!, rows[2]!], prevHash: null }))).toThrow(
      /contiguous/u,
    );
  });

  it("the CSV guards formula-leading cells", () => {
    const csv = eventsCsv(chain(1, 1, null));
    expect(csv.startsWith("﻿seq,occurred_at,action")).toBe(true);
    expect(csv).toContain(csvField('=HYPERLINK("http://evil")'));
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

describe("export size cap (E2.7 M5)", () => {
  it("is 50,000 rows, and the error tells the admin to narrow the date range", () => {
    expect(MAX_EXPORT_ROWS).toBe(50_000);
    const e = new ExportRangeTooLargeError(60_000);
    expect(e.rows).toBe(60_000);
    expect(e.message).toContain("at most 50000");
    expect(e.message).toContain("narrow the date range");
  });
});

describe("verification failures", () => {
  const good = () => buildExportBundle(input());

  it("a tampered event line fails (file hash and chain)", () => {
    const bytes = tamper(good().bytes, (f) => {
      const text = strFromU8(f["events.jsonl"]!).replace('"n\\":7', '"n\\":70');
      f["events.jsonl"] = strToU8(text);
    });
    const v = verifyExportBundle(bytes);
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("events.jsonl: sha256 differs from the manifest");
    expect(v.problems.some((p) => p.startsWith("chain: hash mismatch"))).toBe(true);
  });

  it("a tampered manifest fails the signature", () => {
    const bytes = tamper(good().bytes, (f) => {
      f["manifest.json"] = strToU8(strFromU8(f["manifest.json"]!).replace('"Acme"', '"Acne"'));
    });
    expect(verifyExportBundle(bytes).problems).toContain("manifest signature does not verify");
  });

  it("a bundle signed by the wrong key fails when the key is pinned", () => {
    const b = buildExportBundle(input({ signingKey: exportSigningKey(entry("rogue", 9)) }));
    const v = verifyExportBundle(b.bytes, { trustedPublicKeys: [pub(V2)] });
    expect(v).toMatchObject({ ok: false, trusted: false });
    expect(v.problems[0]).toMatch(/not a trusted public key/u);
  });

  it("a signature swapped from another key fails even unpinned", () => {
    const other = buildExportBundle(input({ signingKey: exportSigningKey(V1) }));
    const bytes = tamper(good().bytes, (f) => {
      f["manifest.sig"] = unzipSync(other.bytes)["manifest.sig"]!;
    });
    expect(verifyExportBundle(bytes).problems).toContain("manifest signature does not verify");
  });

  /**
   * The attacker who can re-sign (holds *a* key, not ours) rewrites events.jsonl, fixes every
   * file hash and re-signs. Only the chain, the count and the head catch what they removed.
   */
  function dropAndResign(drop: (lines: string[]) => string[], signer: KeyRingEntry = V2) {
    const b = good();
    return tamper(b.bytes, (f) => {
      const lines = strFromU8(f["events.jsonl"]!).trimEnd().split("\n");
      const events = strToU8(`${drop(lines).join("\n")}\n`);
      f["events.jsonl"] = events;
      const files = {
        ...b.manifest.files,
        "events.jsonl": createHash("sha256").update(events).digest("hex"),
      };
      resign(f, { ...b.manifest, files }, signer);
    });
  }

  it("a dropped middle row breaks the chain", () => {
    const v = verifyExportBundle(dropAndResign((l) => [...l.slice(0, 2), ...l.slice(3)]));
    expect(v.ok).toBe(false);
    expect(v.problems).toContain("events.jsonl has 5 rows, the manifest says 6");
    expect(v.problems.some((p) => p.startsWith("chain: expected seq 7"))).toBe(true);
  });

  it("a truncated tail is caught by rowCount, the seq range and headHash", () => {
    const v = verifyExportBundle(dropAndResign((l) => l.slice(0, 4)));
    expect(v.ok).toBe(false);
    expect(v.problems).toEqual(
      expect.arrayContaining([
        "events.jsonl has 4 rows, the manifest says 6",
        "events.jsonl covers seq 5..8, the manifest says 5..10",
        "the last row's hash differs from headHash in the manifest",
      ]),
    );
  });

  it("a cut prefix fails against prevHash", () => {
    const v = verifyExportBundle(dropAndResign((l) => l.slice(1)));
    expect(v.problems.some((p) => p.includes("prev_hash does not match"))).toBe(true);
  });

  it("an extra or missing file is reported", () => {
    const extra = tamper(good().bytes, (f) => {
      f["notes.txt"] = strToU8("hi");
      delete f["events.csv"];
    });
    expect(verifyExportBundle(extra).problems).toEqual(
      expect.arrayContaining([
        "notes.txt is in the zip but is not part of an audit export bundle",
        "events.csv is listed in the manifest but missing",
      ]),
    );
  });

  it("a duplicate entry name is refused (forged first entry ahead of the genuine files)", () => {
    // The reviewer's construction: `unzip -p bundle.zip events.jsonl` and archive browsers show
    // the FIRST entry of a name; fflate keeps the LAST. A forged events.jsonl placed ahead of the
    // genuine, correctly signed files would verify while every human reader sees the forgery.
    const genuine = unzipSync(good().bytes);
    const forged = strToU8(`${JSON.stringify({ seq: 5, canonical: "{}", hash: "00" })}\n`);
    const zipped = zipEntries([["events.jsonl", forged], ...Object.entries(genuine)]);
    expect(Object.keys(genuine)).toContain("events.jsonl");
    const v = verifyExportBundle(zipped, { trustedPublicKeys: [pub(V2)] });
    expect(v.ok).toBe(false);
    expect(v.problems).toContain(
      "events.jsonl appears more than once in the zip (tools disagree on which one to show)",
    );
    // The same zip without the forged entry is fine: it is the duplicate that fails it.
    expect(
      verifyExportBundle(zipEntries(Object.entries(genuine)), { trustedPublicKeys: [pub(V2)] }).ok,
    ).toBe(true);
  });

  it("a duplicated manifest is refused too", () => {
    const genuine = unzipSync(good().bytes);
    const zipped = zipEntries([
      ...Object.entries(genuine),
      ["manifest.json", genuine["manifest.json"]!],
    ]);
    expect(verifyExportBundle(zipped).problems).toContain(
      "manifest.json appears more than once in the zip (tools disagree on which one to show)",
    );
  });

  it("garbage input is a problem, not a throw", () => {
    expect(verifyExportBundle(strToU8("not a zip")).ok).toBe(false);
    expect(verifyExportBundle(zipSync({})).problems).toContain("manifest.json is missing");
  });
});

describe("bundle version 2: anchors.json (E3.13)", () => {
  const rows = chain(5, 6, PREV);
  const cpOf = (seq: number, id: string): ExportCheckpoint => {
    const row = rows.find((r) => r.seq === seq)!;
    const canon = JSON.parse(row.canonical) as { id: string; occurred_at: string };
    return {
      id,
      seq,
      hash: Buffer.from(row.hash).toString("hex"),
      eventId: canon.id,
      // Bound to the row (FIX2 A12): seq 7 → 2026-09-17, seq 10 → 2026-09-10.
      headOccurredAt: new Date(canon.occurred_at).toISOString(),
      previousCheckpointId: null,
      keyId: "v2",
      signature: null,
    };
  };
  const cpA = cpOf(7, "0190f1a0-0000-7000-8000-0000000c0001");
  const cpB = cpOf(10, "0190f1a0-0000-7000-8000-0000000c0002");
  const leafOf = (cp: ExportCheckpoint) =>
    checkpointLeafHash({
      workspaceId: WS,
      seq: cp.seq,
      hash: cp.hash,
      eventId: cp.eventId,
      headOccurredAt: new Date(cp.headOccurredAt),
      previousCheckpointId: cp.previousCheckpointId,
    });
  // Other workspaces' leaves share the batch; only their hashes appear as siblings.
  const foreign = merkleLeafHash(Buffer.from("another workspace's checkpoint"));
  const leaves = [leafOf(cpA), foreign, leafOf(cpB), foreign, foreign];
  const tree = buildMerkleTree(leaves);

  async function anchored(fake: Parameters<typeof createFakeAnchor>[0] = {}) {
    // Anchored after both heads (09-17 and 09-10) and within 8 days of each: on time.
    const tsa = createFakeAnchor({
      kind: "rfc3161",
      now: () => new Date("2026-09-17T12:00:00.000Z"),
      ...fake,
    });
    const receipt = await tsa.anchor(tree.root);
    const anchors: ExportAnchor[] = [
      {
        checkpointId: cpA.id,
        leafIndex: 0,
        path: tree.paths[0]!.map(toHex),
        treeSize: 5,
        root: toHex(tree.root),
        receipts: [receipt],
      },
      {
        checkpointId: cpB.id,
        leafIndex: 2,
        path: tree.paths[2]!.map(toHex),
        treeSize: 5,
        root: toHex(tree.root),
        receipts: [receipt],
      },
    ];
    const b = buildExportBundle(input({ checkpoints: [cpA, cpB], anchors }));
    return { b, tsa, verifiers: { rfc3161: tsa.verify } };
  }
  const pinned = { trustedPublicKeys: [pub(V2)] };

  it("verifies paths synchronously and receipts with injected verifiers", async () => {
    const { b, verifiers } = await anchored();
    const sync = verifyExportBundle(b.bytes, pinned);
    expect(sync.problems).toEqual([]);
    expect(sync.anchors).toMatchObject({ checkpoints: 2, anchored: 2, unchecked: 2, failed: 0 });
    const full = await verifyExportBundleAnchored(b.bytes, {
      ...pinned,
      anchorVerifiers: verifiers,
    });
    expect(full.problems).toEqual([]);
    expect(full.anchors).toMatchObject({
      checkpoints: 2,
      anchored: 2,
      verified: 2,
      failed: 0,
      coveredThroughSeq: 10,
      coveredAt: "2026-09-17T12:00:00.000Z",
    });
    expect(anchorsComplete(full)).toBe(true);
    expect(exportVerificationExitCode(full, { requireAnchors: true })).toBe(0);
    const text = formatExportVerification(full);
    expect(text).toContain("2 verified (trusted time)");
    expect(text).toContain("anchored through seq 10 at 2026-09-17T12:00:00.000Z");
    expect(text).toContain("existed by 2026-09-17T12:00:00.000Z (rfc3161 signed time)");
  });

  it("an unpinned anchor signer keeps the chain verified but --require-anchors exits 3", async () => {
    const { b, verifiers } = await anchored();
    const v = await verifyExportBundleAnchored(b.bytes, {
      ...pinned,
      anchorVerifiers: verifiers,
      trustedAnchorPems: ["someone-else"],
    });
    expect(v.ok).toBe(true);
    expect(v.anchors).toMatchObject({ verified: 0, unverifiedOrigin: 2 });
    expect(exportVerificationExitCode(v)).toBe(0);
    expect(exportVerificationExitCode(v, { requireAnchors: true })).toBe(3);
    expect(formatExportVerification(v)).toContain("no time-verified anchor covers these rows");
    // No verifier at all for the kind: unchecked, same outcome.
    const none = await verifyExportBundleAnchored(b.bytes, pinned);
    expect(none.anchors).toMatchObject({ unchecked: 2, verified: 0 });
    expect(exportVerificationExitCode(none, { requireAnchors: true })).toBe(3);
  });

  it("no anchors: a version-1 bundle; --require-anchors exits 3", async () => {
    const { verifiers } = await anchored();
    const b = buildExportBundle(input({ checkpoints: [cpA, cpB], anchors: [] }));
    expect(b.manifest.version).toBe(1);
    const v = await verifyExportBundleAnchored(b.bytes, { ...pinned, anchorVerifiers: verifiers });
    expect(v.ok).toBe(true);
    expect(v.anchors).toBeNull();
    expect(exportVerificationExitCode(v)).toBe(0);
    expect(exportVerificationExitCode(v, { requireAnchors: true })).toBe(3);
  });

  it("coverage: through the last time-verified checkpoint, the tail reported (FIX1 A2)", async () => {
    const { b, verifiers } = await anchored();
    const onlyA = rewriteAnchors(b.bytes, (a) => a.filter((x) => x.checkpointId === cpA.id));
    const v = await verifyExportBundleAnchored(onlyA, { ...pinned, anchorVerifiers: verifiers });
    expect(v.anchors).toMatchObject({ coveredThroughSeq: 7, toSeq: 10 });
    expect(exportVerificationExitCode(v, { requireAnchors: true })).toBe(0);
    const text = formatExportVerification(v);
    expect(text).toContain("anchored through seq 7");
    expect(text).toContain("seq 8..10: not yet anchored");
  });

  it("a checkpoint outside the exported rows fails (H3 b); no checkpoint in range → exit 3 (H3 a)", async () => {
    const b = buildExportBundle(input({ checkpoints: [{ ...cpA, seq: 2 }] }));
    const v = verifyExportBundle(b.bytes, pinned);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("lies outside the exported rows"))).toBe(true);
    const none = await verifyExportBundleAnchored(buildExportBundle(input()).bytes, pinned);
    expect(none.ok).toBe(true);
    expect(exportVerificationExitCode(none, { requireAnchors: true })).toBe(3);
  });

  it("a late trusted time (a rewrite re-anchored later) does not count (H2)", async () => {
    const { b, verifiers } = await anchored({ now: () => new Date("2026-10-30T00:00:00.000Z") });
    const v = await verifyExportBundleAnchored(b.bytes, { ...pinned, anchorVerifiers: verifiers });
    expect(v.ok).toBe(true);
    expect(v.anchors).toMatchObject({ verified: 0, late: 2, coveredThroughSeq: null });
    expect(exportVerificationExitCode(v, { requireAnchors: true })).toBe(3);
    expect(formatExportVerification(v)).toContain("2 late");
  });

  it("presence-only receipts (Rekor-like, no trusted time) do not count (H1)", async () => {
    const { b, verifiers } = await anchored({ timeTrusted: false });
    const v = await verifyExportBundleAnchored(b.bytes, { ...pinned, anchorVerifiers: verifiers });
    expect(v.ok).toBe(true);
    expect(v.anchors).toMatchObject({ verified: 0, presenceOnly: 2, coveredThroughSeq: null });
    expect(exportVerificationExitCode(v, { requireAnchors: true })).toBe(3);
    const text = formatExportVerification(v);
    expect(text).toContain("present in log, no trusted time");
    expect(text).not.toContain("existed by");
  });

  /** Rewrites checkpoints.json, re-anchors it with the given TSA and re-signs (an insider). */
  async function forgedCheckpoint(edit: (cp: ExportCheckpoint) => ExportCheckpoint) {
    const tsa = createFakeAnchor({
      kind: "rfc3161",
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    });
    const cp = edit(cpA);
    const leaf = leafOf(cp);
    const receipt = await tsa.anchor(leaf);
    const anchors: ExportAnchor[] = [
      {
        checkpointId: cp.id,
        leafIndex: 0,
        path: [],
        treeSize: 1,
        root: toHex(leaf),
        receipts: [receipt],
      },
    ];
    return {
      bytes: buildExportBundle(input({ checkpoints: [cp], anchors })).bytes,
      verifiers: { rfc3161: tsa.verify },
    };
  }

  it("N1: a checkpoint with a non-integer seq never vouches for rows (fails)", async () => {
    for (const seq of [7.5, 10.000001]) {
      const { bytes, verifiers } = await forgedCheckpoint((cp) => ({
        ...cp,
        seq,
        hash: "ab".repeat(32),
      }));
      const v = await verifyExportBundleAnchored(bytes, { ...pinned, anchorVerifiers: verifiers });
      expect(v.ok, String(seq)).toBe(false);
      expect(v.anchors?.coveredThroughSeq ?? null).toBeNull();
      expect(exportVerificationExitCode(v, { requireAnchors: true })).toBe(1);
      expect(formatExportVerification(v)).not.toContain("anchored through");
    }
  });

  it("N2: a checkpoint whose head time or event id differs from its row fails", async () => {
    const now = await forgedCheckpoint((cp) => ({
      ...cp,
      headOccurredAt: "2026-09-17T11:59:00.000Z",
    }));
    const v = await verifyExportBundleAnchored(now.bytes, {
      ...pinned,
      anchorVerifiers: now.verifiers,
    });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("head time differs from the row"))).toBe(true);
    const ev = await forgedCheckpoint((cp) => ({
      ...cp,
      eventId: "0190f1a0-0000-7000-8000-00000000ffff",
    }));
    const w = await verifyExportBundleAnchored(ev.bytes, {
      ...pinned,
      anchorVerifiers: ev.verifiers,
    });
    expect(w.problems.some((p) => p.includes("event id differs from the row"))).toBe(true);
    // The honest one passes.
    const ok = await forgedCheckpoint((cp) => cp);
    expect(
      (await verifyExportBundleAnchored(ok.bytes, { ...pinned, anchorVerifiers: ok.verifiers }))
        .problems,
    ).toEqual([]);
  });

  it("N5: a head row later than the trusted time is anchor_inconsistent (fails)", async () => {
    const { b, verifiers } = await anchored({ now: () => new Date("2026-09-12T00:00:00.000Z") });
    const v = await verifyExportBundleAnchored(b.bytes, { ...pinned, anchorVerifiers: verifiers });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.startsWith(`anchor_inconsistent: checkpoint ${cpA.id}`))).toBe(
      true,
    );
  });

  it("N5: --require-anchors fails when any in-range anchor is late, even with an on-time one", async () => {
    const onTime = createFakeAnchor({
      kind: "rfc3161",
      now: () => new Date("2026-09-17T12:00:00.000Z"),
    });
    const late = createFakeAnchor({
      kind: "rfc3161",
      now: () => new Date("2026-09-25T00:00:00.000Z"),
    });
    // Two separate one-leaf trees: cpA on time, cpB (head 09-10) late.
    const rootA = leafOf(cpA);
    const rootB = leafOf(cpB);
    const anchors: ExportAnchor[] = [
      {
        checkpointId: cpA.id,
        leafIndex: 0,
        path: [],
        treeSize: 1,
        root: toHex(rootA),
        receipts: [await onTime.anchor(rootA)],
      },
      {
        checkpointId: cpB.id,
        leafIndex: 0,
        path: [],
        treeSize: 1,
        root: toHex(rootB),
        receipts: [await late.anchor(rootB)],
      },
    ];
    const b = buildExportBundle(input({ checkpoints: [cpA, cpB], anchors }));
    const v = await verifyExportBundleAnchored(b.bytes, {
      ...pinned,
      anchorVerifiers: { rfc3161: onTime.verify },
    });
    expect(v.anchors).toMatchObject({ verified: 1, late: 1 });
    expect(exportVerificationExitCode(v)).toBe(0);
    expect(exportVerificationExitCode(v, { requireAnchors: true })).toBe(3);
    expect(formatExportVerification(v)).toContain("anchored LATE");
  });

  /** Rewrites anchors.json, fixes its hash and re-signs with our own key (an insider). */
  function rewriteAnchors(bytes: Uint8Array, edit: (a: ExportAnchor[]) => ExportAnchor[]) {
    return tamper(bytes, (f) => {
      const manifest = JSON.parse(strFromU8(f["manifest.json"]!)) as ExportManifest;
      const next = strToU8(
        `${JSON.stringify(edit(JSON.parse(strFromU8(f["anchors.json"]!))), null, 2)}\n`,
      );
      f["anchors.json"] = next;
      const files = {
        ...manifest.files,
        "anchors.json": createHash("sha256").update(next).digest("hex"),
      };
      resign(f, { ...manifest, files }, V2);
    });
  }

  it("a re-signed bundle with a doctored path, root or receipt fails", async () => {
    const { b, verifiers } = await anchored();
    const swapped = rewriteAnchors(b.bytes, (a) =>
      a.map((x) => ({ ...x, leafIndex: x.leafIndex + 1 })),
    );
    const v1 = await verifyExportBundleAnchored(swapped, { ...pinned, anchorVerifiers: verifiers });
    expect(v1.ok).toBe(false);
    expect(v1.problems.some((p) => p.startsWith("anchor_path_invalid"))).toBe(true);

    // A self-consistent tree over different leaves (an insider rebuilt it): the path holds, the
    // receipt over the original root does not.
    const forged = buildMerkleTree([leafOf(cpA), leafOf(cpB)]);
    const rebuilt = rewriteAnchors(b.bytes, (a) =>
      a.map((x, i) => ({
        ...x,
        leafIndex: i,
        treeSize: 2,
        path: forged.paths[i]!.map(toHex),
        root: toHex(forged.root),
      })),
    );
    const v2 = await verifyExportBundleAnchored(rebuilt, { ...pinned, anchorVerifiers: verifiers });
    expect(v2.ok).toBe(false);
    expect(v2.problems.some((p) => p.startsWith("anchor_receipt_failed"))).toBe(true);
    expect(exportVerificationExitCode(v2)).toBe(1);
  });

  it("a doctored checkpoint is caught by the anchor even after re-signing checkpoints.json", async () => {
    const { b, verifiers } = await anchored();
    const bytes = tamper(b.bytes, (f) => {
      const manifest = JSON.parse(strFromU8(f["manifest.json"]!)) as ExportManifest;
      const cps = JSON.parse(strFromU8(f["checkpoints.json"]!)) as ExportCheckpoint[];
      // A field no row binds (head time / event id are row-bound since FIX2): only the anchor's
      // leaf can notice.
      cps[0] = { ...cps[0]!, previousCheckpointId: "0190f1a0-0000-7000-8000-0000000c0009" };
      const next = strToU8(`${JSON.stringify(cps, null, 2)}\n`);
      f["checkpoints.json"] = next;
      const files = {
        ...manifest.files,
        "checkpoints.json": createHash("sha256").update(next).digest("hex"),
      };
      resign(f, { ...manifest, files }, V2);
    });
    const v = await verifyExportBundleAnchored(bytes, { ...pinned, anchorVerifiers: verifiers });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes(`anchor_path_invalid: checkpoint ${cpA.id}`))).toBe(
      true,
    );
  });

  it("a version 1 bundle (no anchors.json) still verifies; v1 with anchors.json does not", async () => {
    const { b } = await anchored();
    const v1 = tamper(b.bytes, (f) => {
      const manifest = JSON.parse(strFromU8(f["manifest.json"]!)) as ExportManifest;
      delete f["anchors.json"];
      const { "anchors.json": _drop, ...files } = manifest.files;
      resign(f, { ...manifest, version: 1, files }, V2);
    });
    const v = await verifyExportBundleAnchored(v1, pinned);
    expect(v.problems).toEqual([]);
    expect(v.anchors).toBeNull();
    expect(exportVerificationExitCode(v)).toBe(0);
    expect(exportVerificationExitCode(v, { requireAnchors: true })).toBe(3);
    expect(formatExportVerification(v)).toContain("version 1 bundle");

    const smuggled = tamper(b.bytes, (f) => {
      const manifest = JSON.parse(strFromU8(f["manifest.json"]!)) as ExportManifest;
      resign(f, { ...manifest, version: 1 }, V2);
    });
    expect(verifyExportBundle(smuggled, pinned).ok).toBe(false);

    const missing = tamper(b.bytes, (f) => {
      const manifest = JSON.parse(strFromU8(f["manifest.json"]!)) as ExportManifest;
      delete f["anchors.json"];
      const { "anchors.json": _drop, ...files } = manifest.files;
      resign(f, { ...manifest, files }, V2);
    });
    expect(verifyExportBundle(missing, pinned).problems).toContain(
      "the manifest does not list anchors.json (required from version 2)",
    );
  });

  it("an anchor for a checkpoint that is not in the bundle fails", async () => {
    const { b, verifiers } = await anchored();
    const bytes = rewriteAnchors(b.bytes, (a) => [
      { ...a[0]!, checkpointId: "0190f1a0-0000-7000-8000-0000000c0009" },
    ]);
    const v = await verifyExportBundleAnchored(bytes, { ...pinned, anchorVerifiers: verifiers });
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => p.includes("not in checkpoints.json"))).toBe(true);
  });
});
