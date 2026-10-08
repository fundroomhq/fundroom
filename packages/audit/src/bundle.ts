import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";
import type { KeyRing, KeyRingEntry } from "@fundroom/config";
import { csvRecord } from "@fundroom/csv";
import type { AnchorReceipt } from "@fundroom/ports";
import { strFromU8, strToU8, unzipSync, type Zippable, zip, zipSync } from "fflate";
import {
  type AnchorVerifier,
  checkpointAnchorState,
  checkpointLeafHash,
  checkReceipts,
  formatReceiptCheck,
  inclusionProblem,
  type ReceiptCheck,
} from "./anchor-proof.js";
import { type ExportedChainRow, parseCanonical, verifyExportedChain } from "./canonical.js";
import { hashFromHex } from "./merkle.js";

/*
 * The signed audit export (E2.7). A zip a regulator, auditor or court can check **without**
 * FundRoom and without trusting the operator's database:
 *
 *   manifest.json    what the bundle claims (range, head hash, row count, every file's sha256)
 *   manifest.sig     base64 Ed25519 signature over the exact bytes of manifest.json
 *   events.jsonl     one `{seq, canonical, hash}` per line — the text the database hashed
 *   events.csv       the same rows for people, formula-injection guarded
 *   checkpoints.json the signed daily checkpoints that fall inside the range
 *   anchors.json     (version 2, E3.13) each exported checkpoint's external anchor: its RFC 6962
 *                    inclusion path to the anchored batch root and every driver's receipt
 *   VERIFY.md        how to check all of the above with sha256sum + openssl, or the CLI
 *
 * The signing key is Ed25519, derived from the config key ring (HKDF-SHA256, info
 * `seed-host/audit/export-ed25519/v1`), so it rotates with the ring and never touches the
 * database. The public half is published at `GET /api/v1/audit/export-key` and embedded in the
 * manifest; a verifier that pins the published key (`trustedPublicKeys`) cannot be fooled by a
 * bundle re-signed under a key somebody made up.
 *
 * The manifest signs the file hashes, the file hashes pin every line, and each line's hash is
 * recomputed from its canonical text. `rowCount`, `range.fromSeq/toSeq`, `prevHash` and
 * `headHash` close the remaining gaps: a dropped middle row breaks the chain, a dropped tail row
 * changes the head hash and the count, and a prefix cut changes `prevHash`.
 */
export const EXPORT_KEY_PURPOSE = "seed-host/audit/export-ed25519/v1";
export const EXPORT_BUNDLE_KIND = "seed-host.audit-export";
/**
 * Version 2 (E3.13) adds `anchors.json` and is written only when the range has anchors; otherwise
 * the bundle is version 1. The verifier accepts both.
 */
export const EXPORT_BUNDLE_VERSION = 2;
export const SUPPORTED_EXPORT_BUNDLE_VERSIONS: readonly number[] = [1, 2];

export const EXPORT_FILES = {
  manifest: "manifest.json",
  signature: "manifest.sig",
  events: "events.jsonl",
  csv: "events.csv",
  checkpoints: "checkpoints.json",
  anchors: "anchors.json",
  verify: "VERIFY.md",
} as const;

/** PKCS#8 / SPKI DER prefixes for a raw 32-byte Ed25519 seed / public key (RFC 8410). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface ExportSigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  /** Raw 32 bytes. */
  readonly publicKey: Uint8Array;
}

/** The Ed25519 key for one key ring entry. Deterministic: the same entry always yields the same key. */
export function exportSigningKey(entry: KeyRingEntry): ExportSigningKey {
  const seed = Buffer.from(
    hkdfSync("sha256", entry.key, new Uint8Array(0), EXPORT_KEY_PURPOSE, 32),
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return {
    keyId: entry.id,
    privateKey,
    publicKey: new Uint8Array(spki.subarray(SPKI_ED25519_PREFIX.length)),
  };
}

export interface ExportPublicKey {
  readonly keyId: string;
  /** Base64 of the raw 32-byte public key. */
  readonly publicKey: string;
  readonly current: boolean;
}

/** Every ring entry's public half, current first (the ring's own order). */
export function exportPublicKeys(ring: KeyRing): ExportPublicKey[] {
  return ring.entries.map((entry) => ({
    keyId: entry.id,
    publicKey: Buffer.from(exportSigningKey(entry).publicKey).toString("base64"),
    current: entry.id === ring.current.id,
  }));
}

function publicKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface ExportManifest {
  readonly version: 1 | 2;
  readonly kind: typeof EXPORT_BUNDLE_KIND;
  readonly workspace: { readonly id: string; readonly slug: string; readonly name: string };
  readonly generatedAt: string;
  readonly generatedBy: { readonly membershipId: string | null };
  readonly range: {
    /** The requested window (ISO), or null when open-ended. */
    readonly from: string | null;
    readonly to: string | null;
    /** The contiguous seq range covering it; null when the window holds no events. */
    readonly fromSeq: number | null;
    readonly toSeq: number | null;
  };
  /** Hash (hex) of the row at `fromSeq - 1`; null when the range starts the chain or is empty. */
  readonly prevHash: string | null;
  /** Hash (hex) of the row at `toSeq`; null when the range is empty. */
  readonly headHash: string | null;
  readonly rowCount: number;
  /** sha256 hex of every other file in the zip except `manifest.sig`. */
  readonly files: Readonly<Record<string, string>>;
  readonly signature: {
    readonly alg: "Ed25519";
    readonly keyId: string;
    /** Base64 raw 32 bytes. */
    readonly publicKey: string;
  };
}

export interface ExportCheckpoint {
  readonly id: string;
  readonly seq: number;
  /** Hex. */
  readonly hash: string;
  readonly eventId: string;
  readonly headOccurredAt: string;
  readonly previousCheckpointId: string | null;
  readonly keyId: string | null;
  /** Base64 HMAC (verifiable only with the key ring; included for the operator). */
  readonly signature: string | null;
}

/** One entry of `anchors.json` (bundle version 2). */
export interface ExportAnchor {
  readonly checkpointId: string;
  readonly leafIndex: number;
  /** Hex sibling hashes, leaf to root (RFC 6962). */
  readonly path: readonly string[];
  readonly treeSize: number;
  /** Hex Merkle root the drivers anchored. */
  readonly root: string;
  readonly receipts: readonly AnchorReceipt[];
}

export interface ExportBundleInput {
  readonly workspace: ExportManifest["workspace"];
  readonly generatedAt: Date;
  readonly generatedBy: { readonly membershipId: string | null };
  readonly range: { readonly from: Date | null; readonly to: Date | null };
  /** Contiguous, ascending by seq. */
  readonly rows: readonly {
    readonly seq: number;
    readonly canonical: string;
    readonly hash: Uint8Array;
  }[];
  readonly prevHash: string | null;
  readonly checkpoints: readonly ExportCheckpoint[];
  /** Anchors of exported checkpoints (only anchored ones); default none. */
  readonly anchors?: readonly ExportAnchor[] | undefined;
  readonly signingKey: ExportSigningKey;
}

export interface ExportBundle {
  readonly bytes: Uint8Array;
  readonly manifest: ExportManifest;
  /** sha256 hex of `bytes`. */
  readonly sha256: string;
}

const CSV_COLUMNS = [
  "seq",
  "occurred_at",
  "action",
  "outcome",
  "actor_kind",
  "actor_membership_id",
  "on_behalf_of_membership_id",
  "resource_kind",
  "resource_id",
  "subject_membership_id",
  "ip",
  "user_agent",
  "request_id",
  "meta",
  "diff",
  "hash",
] as const;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Human-readable CSV: UTF-8 BOM, CRLF, every field formula-guarded (`@fundroom/csv`). */
export function eventsCsv(rows: ExportBundleInput["rows"]): string {
  let out = `﻿${csvRecord(CSV_COLUMNS)}`;
  for (const row of rows) {
    const f = parseCanonical(row.canonical);
    const hash = Buffer.from(row.hash).toString("hex");
    out += csvRecord(CSV_COLUMNS.map((c) => (c === "hash" ? hash : cell(f[c]))));
  }
  return out;
}

function verifyMd(manifest: Omit<ExportManifest, "files">): string {
  const v2 = manifest.version !== 1;
  return `# Verifying this audit export

Workspace: ${manifest.workspace.name} (\`${manifest.workspace.slug}\`, \`${manifest.workspace.id}\`)
Range: seq ${manifest.range.fromSeq ?? "-"} to ${manifest.range.toSeq ?? "-"} (${manifest.rowCount} rows)
Signed with key \`${manifest.signature.keyId}\` (Ed25519, public key \`${manifest.signature.publicKey}\`).

That key is what the bundle says about itself: anyone can make a bundle that names a key and
verifies against it. Compare it with the one your workspace publishes at
\`GET /api/v1/audit/export-key\` (Admin, Audit log). A bundle is only as trustworthy as the key
you check it against.

**Record the public key when you receive the export** (from the export-key endpoint, not from
this file) and keep it with the bundle. Signing keys rotate with the server's key ring; once a key
has left the ring the endpoint no longer lists it and \`fundroom audit verify-export\` run on the
server trusts only the ring's current keys, so a bundle signed by a retired key verifies only with
the \`--public-key\` you recorded.

## With the FundRoom CLI

    fundroom audit verify-export <this.zip> --public-key <base64 key>
    fundroom-audit verify-export <this.zip> --public-key <base64 key>

Exit 0: verified and signed by a key you trusted. Exit 1: it failed. Exit 3 (\`UNVERIFIED
ORIGIN\`): the bundle is internally consistent but was checked only against its own embedded
key, because no \`--public-key\` was given — that proves nothing about who made it.

## By hand

${
  v2
    ? `1. File hashes: \`sha256sum events.jsonl events.csv checkpoints.json anchors.json VERIFY.md\`
   must equal \`files\` in manifest.json.`
    : `1. File hashes: \`sha256sum events.jsonl events.csv checkpoints.json VERIFY.md\` must equal
   \`files\` in manifest.json.`
}
2. Signature over the exact bytes of manifest.json:

       (printf '\\x30\\x2a\\x30\\x05\\x06\\x03\\x2b\\x65\\x70\\x03\\x21\\x00'; \\
         echo '<base64 public key>' | base64 -d) | openssl pkey -pubin -inform DER -out pub.pem
       base64 -d manifest.sig > manifest.sig.bin
       openssl pkeyutl -verify -pubin -inkey pub.pem -rawin -in manifest.json -sigfile manifest.sig.bin

3. The chain, for every line of events.jsonl in order:
   - \`sha256(canonical)\` (UTF-8, hex) equals \`hash\`;
   - \`canonical.seq\` equals \`seq\`, and seqs are contiguous from \`range.fromSeq\`;
   - \`canonical.prev_hash\` equals the previous line's \`hash\` (the first line's equals
     \`prevHash\` in the manifest);
   - the last line's \`hash\` equals \`headHash\`, and the line count equals \`rowCount\`.

A removed or edited line breaks step 3; an edited file breaks step 1; an edited manifest breaks
step 2. events.csv is a rendering for people: cells beginning \`= + - @\` carry a leading
apostrophe so a spreadsheet does not run them as formulas. events.jsonl is the evidence.
${v2 ? ANCHORS_MD : ""}`;
}

const ANCHORS_MD = `
## External anchors (anchors.json)

When the server anchors its daily checkpoints externally (an RFC 3161 timestamp authority and/or
a Sigstore Rekor transparency log), anchors.json carries, per exported checkpoint, the RFC 6962
inclusion path from \`SHA-256(0x00 || canonical checkpoint)\` to the anchored root and every
receipt. An RFC 3161 receipt whose signer you pin proves the checkpoint — and so every row up to
it — existed by its signed time, independently of the operator; a Rekor receipt alone proves the
root is in a public log, not when. \`fundroom audit verify-export\` checks the paths and the
receipts and prints how far trusted time-stamps cover the rows; pin the TSA certificate / Rekor
log key with \`--anchor-cert <pem>\` (repeatable) and add \`--require-anchors\` to exit 3 unless
an on-time trusted time-stamp covers the rows.
`;

/**
 * Builds the zip. Byte-deterministic for the same input (including `generatedAt`, which is also
 * every entry's zip mtime): files are written in a fixed order, Ed25519 signatures are
 * deterministic, and nothing reads the clock. fflate writes DOS times in the local time zone, so
 * two hosts in different zones produce different bytes for the same input; the manifest, and so
 * the signature, does not depend on that.
 */
export function buildExportBundle(input: ExportBundleInput): ExportBundle {
  const { zippable, manifest } = prepareExportBundle(input);
  const bytes = zipSync(zippable, ZIP_OPTIONS);
  return { bytes, manifest, sha256: sha256(bytes) };
}

/**
 * `buildExportBundle` with the deflate (most of the cost: ~0.75 s for 50,000 rows) done on
 * fflate's worker thread, so a large export does not stall the server's event loop. Same bytes.
 * Consumes `input`'s derived file buffers (transferred to the worker, not copied).
 */
export async function buildExportBundleAsync(input: ExportBundleInput): Promise<ExportBundle> {
  const { zippable, manifest } = prepareExportBundle(input);
  const bytes = await new Promise<Uint8Array>((resolve, reject) =>
    // `consume`: the file buffers are transferred to the worker rather than copied — they were
    // made for this zip alone and are hashed already.
    zip(zippable, { ...ZIP_OPTIONS, consume: true }, (error, data) =>
      error ? reject(error) : resolve(data),
    ),
  );
  return { bytes, manifest, sha256: sha256(bytes) };
}

const ZIP_OPTIONS = { level: 6 } as const;

function prepareExportBundle(input: ExportBundleInput): {
  zippable: Zippable;
  manifest: ExportManifest;
} {
  const rows = input.rows;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]?.seq !== (rows[i - 1]?.seq ?? 0) + 1) {
      throw new Error("export rows must be contiguous and ascending by seq");
    }
  }
  const first = rows[0];
  const last = rows.at(-1);
  const eventsJsonl = rows
    .map(
      (r) =>
        `${JSON.stringify({ seq: r.seq, canonical: r.canonical, hash: Buffer.from(r.hash).toString("hex") })}\n`,
    )
    .join("");
  // Version 1 (no anchors.json) unless something is anchored: with anchoring off an export stays
  // readable by verifiers from before E3.13 (E3.13 FIX1 A5).
  const withAnchors = (input.anchors ?? []).length > 0;
  const base: Omit<ExportManifest, "files"> = {
    version: withAnchors ? EXPORT_BUNDLE_VERSION : 1,
    kind: EXPORT_BUNDLE_KIND,
    workspace: { id: input.workspace.id, slug: input.workspace.slug, name: input.workspace.name },
    generatedAt: input.generatedAt.toISOString(),
    generatedBy: { membershipId: input.generatedBy.membershipId },
    range: {
      from: input.range.from?.toISOString() ?? null,
      to: input.range.to?.toISOString() ?? null,
      fromSeq: first?.seq ?? null,
      toSeq: last?.seq ?? null,
    },
    prevHash: first ? input.prevHash : null,
    headHash: last ? Buffer.from(last.hash).toString("hex") : null,
    rowCount: rows.length,
    signature: {
      alg: "Ed25519",
      keyId: input.signingKey.keyId,
      publicKey: Buffer.from(input.signingKey.publicKey).toString("base64"),
    },
  };
  const content: [string, Uint8Array][] = [
    [EXPORT_FILES.events, strToU8(eventsJsonl)],
    [EXPORT_FILES.csv, strToU8(eventsCsv(rows))],
    [EXPORT_FILES.checkpoints, strToU8(`${JSON.stringify(input.checkpoints, null, 2)}\n`)],
    ...(withAnchors
      ? [
          [EXPORT_FILES.anchors, strToU8(`${JSON.stringify(input.anchors, null, 2)}\n`)] as [
            string,
            Uint8Array,
          ],
        ]
      : []),
    [EXPORT_FILES.verify, strToU8(verifyMd(base))],
  ];
  const files: Record<string, string> = {};
  for (const [name, bytes] of content) files[name] = sha256(bytes);
  // Key order is part of the signed bytes: spell it out rather than spread `base`.
  const manifest: ExportManifest = {
    version: base.version,
    kind: base.kind,
    workspace: base.workspace,
    generatedAt: base.generatedAt,
    generatedBy: base.generatedBy,
    range: base.range,
    prevHash: base.prevHash,
    headHash: base.headHash,
    rowCount: base.rowCount,
    files,
    signature: base.signature,
  };
  const manifestBytes = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = sign(null, manifestBytes, input.signingKey.privateKey);
  const mtime = input.generatedAt;
  const zippable: Zippable = {
    [EXPORT_FILES.manifest]: [manifestBytes, { mtime }],
    [EXPORT_FILES.signature]: [strToU8(`${signature.toString("base64")}\n`), { mtime }],
  };
  for (const [name, bytes] of content) zippable[name] = [bytes, { mtime }];
  return { zippable, manifest };
}

export interface ExportVerifyOptions {
  /**
   * E3.13: offline receipt verifiers by driver kind (the adapters' `verify`). Only
   * `verifyExportBundleAnchored` uses them; `verifyExportBundle` checks inclusion paths only and
   * reports receipts as unchecked.
   */
  readonly anchorVerifiers?: Readonly<Record<string, AnchorVerifier>> | undefined;
  /** Pinned Rekor checkpoint origins handed to every verifier as `trusted.origins`. */
  readonly trustedAnchorOrigins?: readonly string[] | undefined;
  /** Pinned TSA certificates / Rekor log keys (PEM) handed to every verifier as `trusted.pems`. */
  readonly trustedAnchorPems?: readonly string[] | undefined;
  /**
   * Base64 raw Ed25519 public keys to accept. When given, a bundle signed by any other key fails
   * even if its signature is internally valid. When omitted, only the key embedded in the
   * manifest is used — that proves integrity, not origin (`trusted` is then `null`).
   */
  readonly trustedPublicKeys?: readonly string[] | undefined;
}

export interface ExportVerification {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly manifest: ExportManifest | null;
  /** `true`/`false` when `trustedPublicKeys` was given, `null` when it was not. */
  readonly trusted: boolean | null;
  /** Rows whose chain verified. */
  readonly checkedRows: number;
  /** E3.13: null for a version-1 bundle (no anchors.json). */
  readonly anchors: ExportAnchorSummary | null;
}

export interface ExportAnchorSummary {
  /** Checkpoints in checkpoints.json. */
  readonly checkpoints: number;
  /** Of those, with an entry in anchors.json. */
  readonly anchored: number;
  /**
   * Time-verified: a receipt with a TRUSTED time (RFC 3161 genTime against a pinned signer)
   * within ANCHOR_LATE_DAYS of the checkpoint's head; none failed.
   */
  readonly verified: number;
  /** Trusted time, but more than ANCHOR_LATE_DAYS after the checkpoint (`anchor_late`). */
  readonly late: number;
  /** Verified receipts, none with a trusted time (Rekor only: present in a log, not when). */
  readonly presenceOnly: number;
  /** Receipts consistent but no signer pinned/trusted. */
  readonly unverifiedOrigin: number;
  /** No receipt yet, or no verifier for its kind (`verifyExportBundle` reports every receipt so). */
  readonly unchecked: number;
  /** Path or receipt failed. */
  readonly failed: number;
  /** The highest exported seq covered by a time-verified anchor (null: none). */
  readonly coveredThroughSeq: number | null;
  /** That anchor's trusted time. */
  readonly coveredAt: string | null;
  /** The last exported seq (rows after `coveredThroughSeq` are not yet anchored). */
  readonly toSeq: number | null;
  readonly receipts: readonly (ReceiptCheck & { readonly checkpointId: string })[];
}

/** Refuse to inflate anything larger than this (a zip bomb aimed at the verifier). */
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function manifestShapeProblem(m: unknown): string | null {
  if (!isObject(m)) return "manifest.json is not a JSON object";
  if (typeof m["version"] !== "number" || !SUPPORTED_EXPORT_BUNDLE_VERSIONS.includes(m["version"]))
    return `unsupported manifest version ${String(m["version"])}`;
  if (m["kind"] !== EXPORT_BUNDLE_KIND) return `manifest kind is not ${EXPORT_BUNDLE_KIND}`;
  const ws = m["workspace"];
  if (!isObject(ws) || typeof ws["id"] !== "string") return "manifest lacks workspace.id";
  const range = m["range"];
  if (!isObject(range)) return "manifest lacks range";
  if (typeof m["rowCount"] !== "number") return "manifest lacks rowCount";
  if (!isObject(m["files"])) return "manifest lacks files";
  const sig = m["signature"];
  if (!isObject(sig) || sig["alg"] !== "Ed25519" || typeof sig["publicKey"] !== "string")
    return "manifest lacks an Ed25519 signature block";
  return null;
}

/**
 * Checks a bundle with no database and no FundRoom config: signature over the manifest, every
 * file hash, the hash chain from `prevHash` to `headHash`, the row count and seq range, and the
 * checkpoints that fall inside the range. Never throws on hostile input; every failure is a
 * string in `problems`.
 */
export function verifyExportBundle(
  bytes: Uint8Array,
  options: ExportVerifyOptions = {},
): ExportVerification {
  return verifyBundleCore(bytes, options).result;
}

/**
 * `verifyExportBundle` plus every anchor receipt checked with `options.anchorVerifiers` (offline;
 * a verifier never touches the network). A failed receipt fails the bundle; a receipt that is
 * only consistent (no pinned signer) leaves the bundle verified and counts as `unverifiedOrigin`.
 */
export async function verifyExportBundleAnchored(
  bytes: Uint8Array,
  options: ExportVerifyOptions = {},
): Promise<ExportVerification> {
  const { result, anchors } = verifyBundleCore(bytes, options);
  if (!result.anchors || anchors.length === 0) return result;
  const problems = [...result.problems];
  let verified = 0;
  let late = 0;
  let presenceOnly = 0;
  let unverifiedOrigin = 0;
  let unchecked = 0;
  let failed = result.anchors.failed;
  let coveredThroughSeq: number | null = null;
  let coveredAt: string | null = null;
  const receipts: (ReceiptCheck & { checkpointId: string })[] = [];
  for (const a of anchors) {
    const checks = await checkReceipts(
      a.root,
      a.receipts,
      options.anchorVerifiers ?? {},
      options.trustedAnchorPems,
      options.trustedAnchorOrigins,
    );
    for (const c of checks) receipts.push({ ...c, checkpointId: a.checkpointId });
    const { state, trustedTime } = checkpointAnchorState(checks, [a.headOccurredAt]);
    if (state === "failed") {
      failed += 1;
      for (const c of checks.filter((x) => x.status === "failed")) {
        problems.push(
          `anchor_receipt_failed: checkpoint ${a.checkpointId}: ${c.kind} (${c.reference}): ${c.detail ?? "failed"}`,
        );
      }
    } else if (state === "inconsistent") {
      failed += 1;
      problems.push(
        `anchor_inconsistent: checkpoint ${a.checkpointId}: its head row (${a.headOccurredAt.toISOString()}) is later than the trusted anchor time ${trustedTime}`,
      );
    } else if (state === "time_verified") {
      verified += 1;
      if (coveredThroughSeq === null || a.seq > coveredThroughSeq) {
        coveredThroughSeq = a.seq;
        coveredAt = trustedTime;
      }
    } else if (state === "late") {
      late += 1;
    } else if (state === "presence_only") presenceOnly += 1;
    else if (state === "unverified_origin") unverifiedOrigin += 1;
    else unchecked += 1;
  }
  return {
    ...result,
    ok: problems.length === 0,
    problems,
    anchors: {
      ...result.anchors,
      verified,
      late,
      presenceOnly,
      unverifiedOrigin,
      unchecked,
      failed,
      coveredThroughSeq,
      coveredAt,
      receipts,
    },
  };
}

interface PathCheckedAnchor {
  readonly checkpointId: string;
  readonly seq: number;
  readonly headOccurredAt: Date;
  readonly root: Uint8Array;
  readonly receipts: readonly AnchorReceipt[];
}

function verifyBundleCore(
  bytes: Uint8Array,
  options: ExportVerifyOptions,
): { result: ExportVerification; anchors: PathCheckedAnchor[] } {
  const problems: string[] = [];
  let anchorSummary: ExportAnchorSummary | null = null;
  const pathChecked: PathCheckedAnchor[] = [];
  const done = (manifest: ExportManifest | null, trusted: boolean | null, checkedRows = 0) => ({
    result: {
      ok: problems.length === 0,
      problems,
      manifest,
      trusted,
      checkedRows,
      anchors: anchorSummary,
    },
    anchors: pathChecked,
  });

  // Every central-directory entry passes through `filter`, duplicates included. fflate keeps the
  // *last* entry of a name while `unzip` and most archive tools show the *first*, so a zip with a
  // forged `events.jsonl` ahead of the genuine one would verify here and mislead a reader — a
  // duplicate name is refused outright, as is any file a bundle never contains.
  const expected: ReadonlySet<string> = new Set(Object.values(EXPORT_FILES));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unexpected: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        if (seen.has(f.name)) duplicates.add(f.name);
        seen.add(f.name);
        if (!expected.has(f.name)) {
          unexpected.push(f.name);
          return false;
        }
        if (f.originalSize > MAX_ENTRY_BYTES) throw new Error(`${f.name} is too large`);
        return true;
      },
    });
  } catch (e) {
    problems.push(`not a readable zip: ${e instanceof Error ? e.message : String(e)}`);
    return done(null, null);
  }
  for (const name of duplicates) {
    problems.push(
      `${name} appears more than once in the zip (tools disagree on which one to show)`,
    );
  }
  if (duplicates.size > 0) return done(null, null);
  for (const name of unexpected) {
    problems.push(`${name} is in the zip but is not part of an audit export bundle`);
  }

  const manifestBytes = entries[EXPORT_FILES.manifest];
  const sigBytes = entries[EXPORT_FILES.signature];
  if (!manifestBytes) problems.push("manifest.json is missing");
  if (!sigBytes) problems.push("manifest.sig is missing");
  if (!manifestBytes || !sigBytes) return done(null, null);

  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(manifestBytes));
  } catch {
    problems.push("manifest.json is not valid JSON");
    return done(null, null);
  }
  const shape = manifestShapeProblem(parsed);
  if (shape) {
    problems.push(shape);
    return done(null, null);
  }
  const manifest = parsed as ExportManifest;
  // A version-1 bundle never carried anchors.json; a version-2 one always does.
  const allowed: ReadonlySet<string> =
    manifest.version === 1
      ? new Set([...expected].filter((n) => n !== EXPORT_FILES.anchors))
      : expected;
  if (manifest.version === 1 && entries[EXPORT_FILES.anchors]) {
    problems.push("anchors.json is in the zip but a version 1 bundle has none");
  }
  if (manifest.version !== 1 && !(EXPORT_FILES.anchors in manifest.files)) {
    problems.push("the manifest does not list anchors.json (required from version 2)");
  }

  // --- 1. the signature, and whose it is
  let trusted: boolean | null = null;
  const embedded = manifest.signature.publicKey;
  if (options.trustedPublicKeys !== undefined) {
    trusted = options.trustedPublicKeys.some((k) => k.trim() === embedded);
    if (!trusted) {
      problems.push(
        `signed by key ${manifest.signature.keyId} (${embedded}), which is not a trusted public key`,
      );
    }
  }
  try {
    const sig = Buffer.from(strFromU8(sigBytes).trim(), "base64");
    if (!verify(null, manifestBytes, publicKeyObject(Buffer.from(embedded, "base64")), sig)) {
      problems.push("manifest signature does not verify");
    }
  } catch (e) {
    problems.push(`manifest signature unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- 2. every file is listed, present and unaltered (unexpected names were refused above)
  for (const name of Object.keys(entries)) {
    if (name === EXPORT_FILES.manifest || name === EXPORT_FILES.signature) continue;
    if (!(name in manifest.files)) problems.push(`${name} is in the zip but not in the manifest`);
  }
  for (const name of Object.keys(manifest.files)) {
    if (!allowed.has(name) || name === EXPORT_FILES.manifest || name === EXPORT_FILES.signature)
      problems.push(`the manifest lists ${name}, which is not part of an audit export bundle`);
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = entries[name];
    if (!file) problems.push(`${name} is listed in the manifest but missing`);
    else if (sha256(file) !== String(expected).toLowerCase())
      problems.push(`${name}: sha256 differs from the manifest`);
  }

  // --- 3. the chain
  const eventsBytes = entries[EXPORT_FILES.events];
  if (!eventsBytes) return done(manifest, trusted);
  const rows: ExportedChainRow[] = [];
  const lines = strFromU8(eventsBytes).split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [i, line] of lines.entries()) {
    try {
      const o: unknown = JSON.parse(line);
      if (
        !isObject(o) ||
        typeof o["seq"] !== "number" ||
        typeof o["canonical"] !== "string" ||
        typeof o["hash"] !== "string"
      ) {
        throw new Error("expected {seq, canonical, hash}");
      }
      rows.push({ seq: o["seq"], canonical: o["canonical"], hash: o["hash"] });
    } catch (e) {
      problems.push(`events.jsonl line ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
      return done(manifest, trusted);
    }
  }
  if (rows.length !== manifest.rowCount) {
    problems.push(`events.jsonl has ${rows.length} rows, the manifest says ${manifest.rowCount}`);
  }
  const firstSeq = rows[0]?.seq ?? null;
  const lastSeq = rows.at(-1)?.seq ?? null;
  if (firstSeq !== manifest.range.fromSeq || lastSeq !== manifest.range.toSeq) {
    problems.push(
      `events.jsonl covers seq ${firstSeq ?? "-"}..${lastSeq ?? "-"}, the manifest says ${manifest.range.fromSeq ?? "-"}..${manifest.range.toSeq ?? "-"}`,
    );
  }
  for (const row of rows) {
    try {
      if (parseCanonical(row.canonical).workspace_id !== manifest.workspace.id) {
        problems.push(`seq ${row.seq}: row belongs to another workspace`);
        break;
      }
    } catch {
      // verifyExportedChain reports unparseable rows below.
    }
  }
  const chain = verifyExportedChain(rows, { expectedPrevHash: manifest.prevHash ?? null });
  if (!chain.ok && chain.problem) {
    problems.push(`chain: ${chain.problem.reason} at seq ${chain.problem.seq}`);
  } else if (
    (chain.headHash ?? null) !==
    (rows.length === 0 ? (manifest.prevHash ?? null) : manifest.headHash)
  ) {
    problems.push("the last row's hash differs from headHash in the manifest");
  }

  // --- 4. every checkpoint must name an exported row exactly: an integer seq inside the range,
  // that row's hash, its event id and its occurred_at. A checkpoint vouches only for rows the
  // bundle carries — anything else (outside the range, a non-integer seq, a head time or event id
  // the row does not have) is how a re-signed bundle would borrow an anchor for forged rows or
  // dodge `anchor_late` (E3.13 FIX2 A11/A12).
  const cpBytes = entries[EXPORT_FILES.checkpoints];
  let checkpoints: ExportCheckpoint[] = [];
  if (cpBytes) {
    try {
      const cps: unknown = JSON.parse(strFromU8(cpBytes));
      if (!Array.isArray(cps)) throw new Error("not an array");
      checkpoints = cps as ExportCheckpoint[];
    } catch (e) {
      problems.push(`checkpoints.json: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const rowBySeq = new Map(rows.map((r) => [r.seq, r]));
  /** checkpoint id → the head row's occurred_at, for checkpoints bound to an exported row. */
  const bound = new Map<string, Date>();
  for (const cp of checkpoints) {
    const label = `checkpoint ${isObject(cp) ? String(cp.id) : "?"}`;
    if (!isObject(cp) || typeof cp.id !== "string" || !Number.isSafeInteger(cp.seq)) {
      problems.push(`${label}: malformed (seq must be an integer)`);
      continue;
    }
    const from = manifest.range.fromSeq;
    const to = manifest.range.toSeq;
    const row = rowBySeq.get(cp.seq);
    if (from === null || to === null || cp.seq < from || cp.seq > to || !row) {
      problems.push(
        `${label}: seq ${cp.seq} lies outside the exported rows (${from ?? "-"}..${to ?? "-"})`,
      );
      continue;
    }
    if (String(row.hash).toLowerCase() !== String(cp.hash).toLowerCase()) {
      problems.push(`${label}: hash at seq ${cp.seq} differs from the checkpoint`);
      continue;
    }
    let canon: { id?: unknown; occurred_at?: unknown };
    try {
      canon = parseCanonical(row.canonical) as { id?: unknown; occurred_at?: unknown };
    } catch {
      problems.push(`${label}: the row at seq ${cp.seq} is unreadable`);
      continue;
    }
    const rowAt =
      typeof canon.occurred_at === "string" ? Date.parse(canon.occurred_at) : Number.NaN;
    const cpAt = typeof cp.headOccurredAt === "string" ? Date.parse(cp.headOccurredAt) : Number.NaN;
    if (canon.id !== cp.eventId) {
      problems.push(`${label}: event id differs from the row at seq ${cp.seq}`);
      continue;
    }
    if (Number.isNaN(rowAt) || rowAt !== cpAt) {
      problems.push(`${label}: head time differs from the row at seq ${cp.seq}`);
      continue;
    }
    bound.set(cp.id, new Date(rowAt));
  }

  // --- 5. (version 2) every anchor's inclusion path, from the checkpoint as exported
  const anchorBytes = manifest.version === 1 ? undefined : entries[EXPORT_FILES.anchors];
  if (anchorBytes) {
    anchorSummary = checkBundleAnchors(
      anchorBytes,
      manifest.workspace.id,
      checkpoints,
      bound,
      problems,
      pathChecked,
      manifest.range.toSeq,
    );
  }
  return done(manifest, trusted, chain.checked);
}

/** Path checks for anchors.json; fills `pathChecked` with the anchors whose path holds. */
function checkBundleAnchors(
  bytes: Uint8Array,
  workspaceId: string,
  checkpoints: readonly ExportCheckpoint[],
  bound: ReadonlyMap<string, Date>,
  problems: string[],
  pathChecked: PathCheckedAnchor[],
  toSeq: number | null,
): ExportAnchorSummary {
  const empty = {
    late: 0,
    presenceOnly: 0,
    coveredThroughSeq: null,
    coveredAt: null,
    toSeq,
  } as const;
  let failed = 0;
  let unchecked = 0;
  const receipts: (ReceiptCheck & { checkpointId: string })[] = [];
  let list: unknown;
  try {
    list = JSON.parse(strFromU8(bytes));
    if (!Array.isArray(list)) throw new Error("not an array");
  } catch (e) {
    problems.push(`anchors.json: ${e instanceof Error ? e.message : String(e)}`);
    return {
      checkpoints: checkpoints.length,
      anchored: 0,
      verified: 0,
      unverifiedOrigin: 0,
      unchecked: 0,
      failed: 1,
      receipts,
      ...empty,
    };
  }
  const byId = new Map(checkpoints.map((cp) => [cp.id, cp]));
  const seen = new Set<string>();
  for (const raw of list as unknown[]) {
    if (!isObject(raw) || typeof raw["checkpointId"] !== "string") {
      failed += 1;
      problems.push("anchor_path_invalid: anchors.json has a malformed entry");
      continue;
    }
    const id = raw["checkpointId"];
    if (seen.has(id)) {
      failed += 1;
      problems.push(`anchor_path_invalid: checkpoint ${id} is anchored twice in anchors.json`);
      continue;
    }
    seen.add(id);
    const cp = byId.get(id);
    const root = hashFromHex(raw["root"]);
    if (!cp || !root) {
      failed += 1;
      problems.push(
        `anchor_path_invalid: checkpoint ${id}: ${cp ? "the root is malformed" : "not in checkpoints.json"}`,
      );
      continue;
    }
    const rowTime = bound.get(id);
    if (rowTime === undefined) {
      // Its checkpoint is not bound to an exported row (reported above): no path, no coverage.
      failed += 1;
      continue;
    }
    const at = new Date(cp.headOccurredAt);
    const leaf = checkpointLeafHash({
      workspaceId,
      seq: cp.seq,
      hash: String(cp.hash),
      eventId: cp.eventId,
      headOccurredAt: at,
      previousCheckpointId: cp.previousCheckpointId,
    });
    const problem = Number.isNaN(at.getTime())
      ? "the checkpoint's time is malformed"
      : inclusionProblem(
          leaf,
          {
            leafHash: Buffer.from(leaf).toString("hex"),
            path: raw["path"],
            treeSize: raw["treeSize"],
          },
          raw["leafIndex"],
          root,
        );
    if (problem) {
      failed += 1;
      problems.push(`anchor_path_invalid: checkpoint ${id}: ${problem}`);
      continue;
    }
    const rs: AnchorReceipt[] = [];
    for (const r of Array.isArray(raw["receipts"]) ? raw["receipts"] : []) {
      if (
        isObject(r) &&
        typeof r["kind"] === "string" &&
        typeof r["reference"] === "string" &&
        typeof r["anchoredAt"] === "string" &&
        isObject(r["proof"])
      ) {
        rs.push({
          kind: r["kind"],
          reference: r["reference"],
          anchoredAt: r["anchoredAt"],
          proof: r["proof"],
        });
        receipts.push({
          checkpointId: id,
          kind: r["kind"],
          reference: r["reference"],
          status: "unchecked",
          trustedTime: null,
        });
      } else {
        problems.push(`anchor_receipt_failed: checkpoint ${id}: a receipt is malformed`);
      }
    }
    unchecked += 1;
    pathChecked.push({
      checkpointId: id,
      seq: cp.seq,
      headOccurredAt: rowTime,
      root,
      receipts: rs,
    });
  }
  return {
    checkpoints: checkpoints.length,
    anchored: seen.size,
    verified: 0,
    unverifiedOrigin: 0,
    unchecked,
    failed,
    receipts,
    ...empty,
  };
}

/** The exit code for a verification: 0 verified and trusted, 1 failed, 3 intact but unpinned. */
export const EXPORT_VERIFY_EXIT = { verified: 0, failed: 1, unverifiedOrigin: 3 } as const;

/**
 * `--require-anchors`: the exported rows are covered by at least one time-verified anchor (a
 * checkpoint inside the range with an on-time trusted time-stamp), no anchor failed and none is
 * late (lateness is the signature of a rewrite). Rows after
 * `coveredThroughSeq` are reported as not yet anchored.
 */
export function anchorsComplete(v: ExportVerification): boolean {
  const a = v.anchors;
  return a !== null && a.failed === 0 && a.late === 0 && a.coveredThroughSeq !== null;
}

export function exportVerificationExitCode(
  v: ExportVerification,
  options: { readonly requireAnchors?: boolean | undefined } = {},
): number {
  if (!v.ok) return EXPORT_VERIFY_EXIT.failed;
  if (v.trusted !== true) return EXPORT_VERIFY_EXIT.unverifiedOrigin;
  if (options.requireAnchors && !anchorsComplete(v)) return EXPORT_VERIFY_EXIT.unverifiedOrigin;
  return EXPORT_VERIFY_EXIT.verified;
}

export const UNVERIFIED_ORIGIN_LINE =
  "UNVERIFIED ORIGIN — the bundle is internally consistent, but it was checked only against the key it carries itself, so anyone could have made it. Re-run with --public-key <the key recorded at export time, or from GET /api/v1/audit/export-key>.";

export function formatExportVerification(v: ExportVerification): string {
  const m = v.manifest;
  const lines: string[] = [];
  if (m) {
    lines.push(
      `workspace ${m.workspace.slug} (${m.workspace.id}), seq ${m.range.fromSeq ?? "-"}..${m.range.toSeq ?? "-"}, ${m.rowCount} rows, generated ${m.generatedAt}`,
    );
    // Unpinned, the key id and public key are whatever the bundle says about itself: printing
    // them as "signed by key v2" would lend an attacker's choice the look of a fact.
    if (v.trusted === true)
      lines.push(`signed by trusted key ${m.signature.keyId} ${m.signature.publicKey}`);
    else if (v.trusted === false)
      lines.push(
        `signed by an UNTRUSTED key (${m.signature.publicKey}; the bundle calls it ${m.signature.keyId})`,
      );
    else lines.push("signature checked against the bundle's own embedded key only (not pinned)");
  }
  const a = v.anchors;
  if (a === null) {
    if (m) lines.push("anchors: none (version 1 bundle)");
  } else {
    lines.push(
      `anchors: ${a.anchored} of ${a.checkpoints} checkpoint(s) anchored — ${a.verified} verified (trusted time), ${a.late} late, ${a.presenceOnly} present in log without trusted time, ${a.unverifiedOrigin} unverified origin, ${a.unchecked} unchecked, ${a.failed} failed`,
    );
    for (const r of a.receipts) lines.push(`  ${r.checkpointId} ${formatReceiptCheck(r)}`);
    if (a.late > 0)
      lines.push(
        `anchors: ${a.late} checkpoint(s) anchored LATE (trusted time more than 8 days after the head) — --require-anchors fails`,
      );
    if (a.coveredThroughSeq !== null) {
      lines.push(`anchored through seq ${a.coveredThroughSeq} at ${a.coveredAt}`);
      if (a.toSeq !== null && a.toSeq > a.coveredThroughSeq)
        lines.push(`seq ${a.coveredThroughSeq + 1}..${a.toSeq}: not yet anchored`);
    } else if (a.failed === 0) {
      lines.push(
        "anchors: no time-verified anchor covers these rows — pin the TSA with --anchor-cert <PEM>; a Rekor receipt alone proves presence in a log, not time",
      );
    }
  }
  for (const p of v.problems) lines.push(`  - ${p}`);
  if (!v.ok) lines.push("FAIL export bundle did not verify");
  else if (v.trusted === true) lines.push(`OK   ${v.checkedRows} rows verified`);
  else lines.push(`${v.checkedRows} rows internally consistent`, UNVERIFIED_ORIGIN_LINE);
  return lines.join("\n");
}
