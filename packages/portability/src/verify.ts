import { createHash } from "node:crypto";
import { type ExportedChainRow, parseCanonical, verifyExportedChain } from "@fundroom/audit";
import {
  classifyEntry,
  ENTRY,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  EXPORT_VERIFY_EXIT,
  type ExportManifest,
  MAX_ENTRY_BYTES,
  MAX_LINE_BYTES,
  MAX_SMALL_ENTRY_BYTES,
  UNVERIFIED_ORIGIN_LINE,
  verifyManifestSignature,
} from "./format.js";
import { lines, ZipFileReader } from "./zip/reader.js";

/*
 * The offline verifier (`fundroom workspace verify-export`, and step one of every import). Needs
 * no database and no config. Refuses before reading any payload: duplicate entry names, entries
 * an export never contains, entries declared larger than 5 GiB, overlapping entries, encrypted or
 * exotic compression. Then: the manifest's shape and major version, the Ed25519 signature (and
 * whose key signed it), every entry's sha256 against `manifest.files`, every table's row count,
 * every blob's name against its bytes, every `$blobs` reference against the blobs present, and the
 * audit hash chain from its first row to `audit.headHash`. Never throws on hostile input.
 */

export interface VerifyExportOptions {
  /** Base64 raw Ed25519 keys to accept; omitted → only the embedded key (integrity, not origin). */
  readonly trustedPublicKeys?: readonly string[] | undefined;
}

export interface ExportVerification {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly manifest: ExportManifest | null;
  /** `true`/`false` when trusted keys were given, `null` when not. */
  readonly trusted: boolean | null;
  readonly stats: {
    readonly tables: number;
    readonly rows: number;
    readonly blobs: number;
    readonly auditRows: number;
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Why a manifest cannot be read, or null. The major version gates everything else. */
export function manifestShapeProblem(m: unknown): string | null {
  if (!isObject(m)) return "manifest.json is not a JSON object";
  if (m["format"] !== EXPORT_FORMAT) return `manifest format is not ${EXPORT_FORMAT}`;
  if (typeof m["version"] !== "number" || !Number.isInteger(m["version"]))
    return "manifest lacks an integer version";
  if (m["version"] !== EXPORT_FORMAT_VERSION)
    return `unsupported export format version ${m["version"]} (this build reads version ${EXPORT_FORMAT_VERSION})`;
  const src = m["source"];
  if (!isObject(src) || typeof src["workspaceId"] !== "string")
    return "manifest lacks source.workspaceId";
  if (!Array.isArray(m["tables"])) return "manifest lacks tables";
  const tableNames = new Set<string>();
  for (const t of m["tables"] as unknown[]) {
    if (
      !isObject(t) ||
      typeof t["name"] !== "string" ||
      typeof t["rows"] !== "number" ||
      !Number.isInteger(t["rows"]) ||
      t["rows"] < 0
    )
      return "manifest tables are malformed";
    // One entry per table: a second listing would give the verifier and the importer two
    // different row counts (and skip states) for the same JSONL.
    if (tableNames.has(t["name"])) return `manifest lists table ${t["name"]} more than once`;
    tableNames.add(t["name"]);
  }
  if (!isObject(m["modules"])) return "manifest lacks modules";
  if (!isObject(m["files"])) return "manifest lacks files";
  if (!isObject(m["audit"])) return "manifest lacks audit";
  if (!isObject(m["options"])) return "manifest lacks options";
  const sig = m["signature"];
  if (!isObject(sig) || sig["alg"] !== "Ed25519" || typeof sig["publicKey"] !== "string")
    return "manifest lacks an Ed25519 signature block";
  return null;
}

export async function verifyExportFile(
  path: string,
  options: VerifyExportOptions = {},
): Promise<ExportVerification> {
  const problems: string[] = [];
  let tablesChecked = 0;
  let rowsChecked = 0;
  let blobsChecked = 0;
  let auditRows = 0;
  const done = (manifest: ExportManifest | null, trusted: boolean | null): ExportVerification => ({
    ok: problems.length === 0,
    problems,
    manifest,
    trusted,
    stats: { tables: tablesChecked, rows: rowsChecked, blobs: blobsChecked, auditRows },
  });

  let zip: ZipFileReader;
  try {
    zip = await ZipFileReader.open(path);
  } catch (e) {
    problems.push(`not a readable zip: ${e instanceof Error ? e.message : String(e)}`);
    return done(null, null);
  }
  try {
    // --- structure, before reading any payload
    for (const name of zip.directory.duplicates) {
      problems.push(
        `${name} appears more than once in the zip (tools disagree on which one to show)`,
      );
    }
    if (problems.length > 0) return done(null, null);
    for (const e of zip.entries) {
      const kind = classifyEntry(e.name);
      if (kind === undefined)
        problems.push(`${e.name} is in the zip but is not part of a workspace export`);
      if (e.size > MAX_ENTRY_BYTES || e.compressedSize > MAX_ENTRY_BYTES)
        problems.push(`${e.name} is larger than 5 GiB`);
      else if (
        kind !== undefined &&
        (kind.kind === "manifest" ||
          kind.kind === "signature" ||
          kind.kind === "auditCheckpoints") &&
        e.size > MAX_SMALL_ENTRY_BYTES
      )
        problems.push(`${e.name} is implausibly large`);
    }
    if (problems.length > 0) return done(null, null);

    const manifestEntry = zip.entry(ENTRY.manifest);
    const sigEntry = zip.entry(ENTRY.signature);
    if (!manifestEntry) problems.push("manifest.json is missing");
    if (!sigEntry) problems.push("manifest.sig is missing");
    if (!manifestEntry || !sigEntry) return done(null, null);
    const manifestBytes = await zip.readAll(manifestEntry);
    const sigText = (await zip.readAll(sigEntry)).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestBytes.toString("utf8"));
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

    // --- the signature, and whose it is
    let trusted: boolean | null = null;
    const embedded = manifest.signature.publicKey;
    if (options.trustedPublicKeys !== undefined) {
      trusted = options.trustedPublicKeys.some((k) => k.trim() === embedded);
      if (!trusted)
        problems.push(
          `signed by key ${manifest.signature.keyId} (${embedded}), which is not a trusted public key`,
        );
    }
    try {
      if (!verifyManifestSignature(manifestBytes, sigText, embedded))
        problems.push("manifest signature does not verify");
    } catch (e) {
      problems.push(`manifest signature unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }

    // --- the file list is exactly the zip's content
    const files = manifest.files;
    const names = new Set(zip.entries.map((e) => e.name));
    for (const name of names) {
      if (name === ENTRY.manifest || name === ENTRY.signature) continue;
      if (!(name in files)) problems.push(`${name} is in the zip but not in the manifest`);
    }
    for (const name of Object.keys(files)) {
      if (name === ENTRY.manifest || name === ENTRY.signature || !names.has(name))
        problems.push(`the manifest lists ${name}, which is not in the zip`);
    }
    const tableRows = new Map(manifest.tables.map((t) => [t.name, t]));
    for (const t of manifest.tables) {
      const entry = `tables/${t.name}.jsonl`;
      if (t.skipped === undefined && !names.has(entry))
        problems.push(`${t.name} is carried per the manifest but ${entry} is missing`);
      if (t.skipped !== undefined && names.has(entry))
        problems.push(`${t.name} is skipped per the manifest but ${entry} is present`);
    }

    // --- checkpoints first (small), so the chain pass can check them
    const checkpointSeqs = new Map<number, string>();
    const cpEntry = zip.entry(ENTRY.auditCheckpoints);
    if (cpEntry) {
      try {
        const cps: unknown = JSON.parse((await zip.readAll(cpEntry)).toString("utf8"));
        if (!Array.isArray(cps)) throw new Error("not an array");
        for (const cp of cps) {
          if (isObject(cp) && typeof cp["seq"] === "number" && typeof cp["hash"] === "string")
            checkpointSeqs.set(cp["seq"], cp["hash"].toLowerCase());
        }
      } catch (e) {
        problems.push(`audit/checkpoints.json: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // --- every entry's bytes
    const referencedBlobs = new Set<string>();
    const presentBlobs = new Set<string>();
    for (const e of zip.entries) {
      if (e.name === ENTRY.manifest || e.name === ENTRY.signature) continue;
      const kind = classifyEntry(e.name);
      const expected = files[e.name];
      const hash = createHash("sha256");
      const tap = async function* (): AsyncGenerator<Buffer> {
        for await (const chunk of zip.read(e)) {
          hash.update(chunk);
          yield chunk;
        }
      };
      try {
        if (kind?.kind === "table") {
          let n = 0;
          for await (const line of lines(tap(), MAX_LINE_BYTES)) {
            if (line.length === 0) continue;
            const row: unknown = JSON.parse(line);
            if (!isObject(row)) throw new Error(`line ${n + 1} is not a JSON object`);
            collectBlobRefs(row, referencedBlobs);
            n += 1;
          }
          const name = `${kind.schema}.${kind.table}`;
          const declared = tableRows.get(name);
          if (declared === undefined) problems.push(`${e.name} is not a table the manifest lists`);
          else if (declared.rows !== n)
            problems.push(`${e.name} has ${n} rows, the manifest says ${declared.rows}`);
          tablesChecked += 1;
          rowsChecked += n;
        } else if (kind?.kind === "auditEvents") {
          auditRows = await verifyAuditLines(tap(), manifest, checkpointSeqs, problems);
        } else {
          for await (const _ of tap()) {
            // hashed by `tap`
          }
        }
      } catch (err) {
        problems.push(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const actual = hash.digest("hex");
      if (expected !== undefined && actual !== String(expected).toLowerCase())
        problems.push(`${e.name}: sha256 differs from the manifest`);
      if (kind?.kind === "blob") {
        presentBlobs.add(kind.sha256);
        blobsChecked += 1;
        if (actual !== kind.sha256) problems.push(`${e.name}: its bytes do not hash to its name`);
      }
    }
    for (const sha of referencedBlobs) {
      if (!presentBlobs.has(sha))
        problems.push(`a row references blob ${sha}, which is not in the zip`);
    }
    if (manifest.blobs.count !== presentBlobs.size)
      problems.push(
        `the manifest counts ${manifest.blobs.count} blobs, the zip holds ${presentBlobs.size}`,
      );
    return done(manifest, trusted);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
    return done(null, null);
  } finally {
    await zip.close();
  }
}

function collectBlobRefs(row: Record<string, unknown>, into: Set<string>): void {
  const blobs = row["$blobs"];
  if (isObject(blobs)) {
    for (const v of Object.values(blobs)) {
      if (isObject(v) && typeof v["sha256"] === "string") into.add(v["sha256"].toLowerCase());
    }
  }
  const cert = row["$certificate"];
  if (isObject(cert)) {
    for (const k of ["json", "pdf"]) if (typeof cert[k] === "string") into.add(String(cert[k]));
  }
}

async function verifyAuditLines(
  chunks: AsyncIterable<Buffer>,
  manifest: ExportManifest,
  checkpoints: ReadonlyMap<number, string>,
  problems: string[],
): Promise<number> {
  const PAGE = 5_000;
  let page: ExportedChainRow[] = [];
  let count = 0;
  let head: string | null | undefined;
  let lastSeq: number | null = null;
  let firstSeq: number | null = null;
  let broken = false;
  const flush = () => {
    if (page.length === 0 || broken) return;
    const r = verifyExportedChain(page, head === undefined ? {} : { expectedPrevHash: head });
    if (!r.ok && r.problem) {
      problems.push(`audit chain: ${r.problem.reason} at seq ${r.problem.seq}`);
      broken = true;
    }
    head = r.headHash;
    page = [];
  };
  for await (const line of lines(chunks, MAX_LINE_BYTES)) {
    if (line.length === 0) continue;
    const o: unknown = JSON.parse(line);
    if (
      !isObject(o) ||
      typeof o["seq"] !== "number" ||
      typeof o["canonical"] !== "string" ||
      typeof o["hash"] !== "string"
    )
      throw new Error(`line ${count + 1}: expected {seq, canonical, hash}`);
    const seq = o["seq"];
    if (lastSeq !== null && seq !== lastSeq + 1 && !broken) {
      problems.push(`audit chain: seq ${seq} follows ${lastSeq}`);
      broken = true;
    }
    if (firstSeq === null) firstSeq = seq;
    lastSeq = seq;
    try {
      if (parseCanonical(o["canonical"]).workspace_id !== manifest.source.workspaceId && !broken) {
        problems.push(`audit seq ${seq} belongs to another workspace`);
        broken = true;
      }
    } catch {
      // verifyExportedChain reports unparseable text
    }
    const cp = checkpoints.get(seq);
    if (cp !== undefined && cp !== o["hash"].toLowerCase())
      problems.push(`audit checkpoint at seq ${seq} differs from the chain`);
    page.push({ seq, canonical: o["canonical"], hash: o["hash"] });
    count += 1;
    if (page.length >= PAGE) flush();
  }
  flush();
  const a = manifest.audit;
  if (a.rows !== count)
    problems.push(`audit/events.jsonl has ${count} rows, the manifest says ${a.rows}`);
  if ((a.fromSeq ?? null) !== firstSeq || (a.headSeq ?? null) !== lastSeq)
    problems.push("audit seq range differs from the manifest");
  if (!broken && count > 0 && (head ?? null) !== a.headHash)
    problems.push("the last audit row's hash differs from audit.headHash in the manifest");
  return count;
}

export function verificationExitCode(v: ExportVerification): number {
  if (!v.ok) return EXPORT_VERIFY_EXIT.failed;
  return v.trusted === true ? EXPORT_VERIFY_EXIT.verified : EXPORT_VERIFY_EXIT.unverifiedOrigin;
}

export function formatVerification(v: ExportVerification): string {
  const m = v.manifest;
  const out: string[] = [];
  if (m) {
    out.push(
      `workspace ${m.source.slug} (${m.source.workspaceId}), exported ${m.exportedAt}, ${v.stats.tables} tables / ${v.stats.rows} rows, ${v.stats.blobs} files, ${v.stats.auditRows} audit events`,
    );
    if (v.trusted === true)
      out.push(`signed by trusted key ${m.signature.keyId} ${m.signature.publicKey}`);
    else if (v.trusted === false)
      out.push(
        `signed by an UNTRUSTED key (${m.signature.publicKey}; the file calls it ${m.signature.keyId})`,
      );
    else out.push("signature checked against the export's own embedded key only (not pinned)");
    for (const o of m.omitted ?? []) {
      const rows = o.tables.every((t) => t.rows !== null)
        ? `${o.tables.reduce((n, t) => n + (t.rows ?? 0), 0)} row(s)`
        : "rows not countable";
      out.push(
        `NOT INCLUDED: schema ${o.schema}${o.module === null ? "" : ` (module ${o.module}, not loaded on the source)`}, ${rows}`,
      );
    }
  }
  for (const p of v.problems) out.push(`  - ${p}`);
  if (!v.ok) out.push("FAIL workspace export did not verify");
  else if (v.trusted === true) out.push("OK   workspace export verified");
  else out.push("internally consistent", UNVERIFIED_ORIGIN_LINE);
  return out.join("\n");
}
