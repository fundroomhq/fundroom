import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { exportRows, listCheckpointsInRange, parseCanonical } from "@fundroom/audit";
import type { KeyRing } from "@fundroom/config";
import { decryptStream, type EnvelopeService } from "@fundroom/crypto";
import { type Database, systemContext, type TenantContext, type Tx } from "@fundroom/db";
import type { ModuleManifest, PortableBlob } from "@fundroom/module-kit";
import type { JsonObject, JsonValue, ObjectStoragePort } from "@fundroom/ports";
import { certificateKey } from "@fundroom/storage";
import { PortabilityError } from "./errors.js";
import {
  blobEntryName,
  byteaHex,
  ENTRY,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  type ExportManifest,
  exportSigningKey,
  KERNEL_PORTABILITY_VERSION,
  type ManifestTable,
  manifestBytes,
  type OmittedSchema,
  sha256Hex,
  signManifest,
  type TableSkip,
  tableEntryName,
} from "./format.js";
import { buildMigrations } from "./migrations.js";
import {
  hashStream,
  maskAddress,
  parseShe,
  SUPPRESSION_KEY_PURPOSE,
  suppressionHash,
} from "./objects.js";
import { findUndeclared, KERNEL_OWNER, type PlannedTable, planTables } from "./plan.js";
import { readmeText } from "./readme.js";
import {
  auditSeqRange,
  type CursorTable,
  closeExportCursor,
  countWorkspaceRows,
  describeTable,
  fetchExportCursor,
  knownEmails,
  listCatalogTables,
  listSuppressions,
  openExportCursor,
  prepareExportSession,
  readWorkspaceRow,
} from "./repos/portability-repo.js";
import { ZipFileWriter } from "./zip/writer.js";

/*
 * The export writer (E2.8 contract §2/§4), in two phases.
 *
 * Phase 1 — ONE read-only tenant transaction as the `system` actor, as short as the rows allow:
 *  1. every declared table is read through ONE cursor (a UNION ALL: one statement, so one snapshot
 *     for every table), row by row, into `tables/<schema>.<table>.jsonl` (deflated), with generated
 *     columns stripped, numerics as text, `omitColumns` dropped and `exportRow` applied;
 *  2. blob columns become `blob:<sha256>` (encryption column null, `$blobs.<keyColumn>` =
 *     `{sha256, key[, size]}` for the importer). A column with a declared `sha256Column` (content-
 *     addressed, immutable: the data room) is NOT read here — its declared digest is used and the
 *     object is verified when it is copied in phase 2. Other objects (optional ones, certificates,
 *     the logo) are read and hashed now, because the row cannot be written without knowing them;
 *  3. the audit chain goes to `audit/events.jsonl` + `audit/checkpoints.json`; every data key the
 *     objects need is resolved; module schemas that exist in the database but are not loaded
 *     (`MODULES`) are recorded as `omitted`. COMMIT.
 * Phase 2 — no transaction: every distinct blob is streamed (stored) to `blobs/<sha256>`, hashed
 * on the way and refused when it does not match the digest its row declared; then `README.md`,
 * `manifest.json` (every entry's sha256) and `manifest.sig` (Ed25519).
 *
 * `onProgress` is called at least once per cursor page and per blob chunk (the job's heartbeat; it
 * may throw to abort). The zip goes to `outPath` (a temp file under DATA_DIR for the job, the
 * operator's file for the CLI). Nothing is buffered beyond one cursor page and one chunk.
 */

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface PortabilityEngineDeps {
  readonly db: Database;
  readonly storage: ObjectStoragePort;
  readonly envelope: EnvelopeService;
  readonly keyRing: KeyRing;
  /**
   * The LOADED module manifests (all of them, enabled for the workspace or not: a disabled
   * module's rows are still data). `MODULES` may leave compiled-in modules out.
   */
  readonly modules: readonly ModuleManifest[];
  /**
   * Every module compiled into this build, loaded or not — only to name the owner of a schema the
   * export has to leave out (`manifest.omitted`). Default: `modules`.
   */
  readonly compiledModules?: readonly ModuleManifest[] | undefined;
  readonly instanceVersion: string;
  readonly now?: (() => Date) | undefined;
  readonly log?: Log | undefined;
}

export interface ExportWorkspaceInput {
  readonly workspaceId: string;
  readonly includeRawAnalytics: boolean;
  readonly outPath: string;
  /**
   * TEST SEAM ONLY: `<schema>.<table>` names tolerated without a portability decision (listed in
   * the manifest as `undeclared` and not exported). Production passes nothing: an undeclared table
   * fails the export rather than silently leaving data behind.
   */
  readonly allowUndeclared?: readonly string[] | undefined;
  /** Called at least once per cursor page and blob chunk; may throw to abort the export. */
  readonly onProgress?: (() => void) | undefined;
}

export interface ExportWorkspaceResult {
  readonly manifest: ExportManifest;
  /** sha256 hex of the zip file. */
  readonly sha256: string;
  readonly size: number;
  readonly manifestSha256: string;
  /** Human-readable: data this export could not include (module schemas not loaded here). */
  readonly warnings: readonly string[];
}

const CURSOR_PAGE = 500;
const AUDIT_PAGE = 5_000;
const CHUNK_BYTES = 64 * 1024;
const CERT_REF_RE = /^cert:v1:([0-9a-f-]{36}):she1:([0-9a-f-]{36})$/iu;

interface BlobSource {
  readonly key: string;
  readonly keyId: string | undefined;
}

/** Batches text lines into ~64 KiB buffers for the deflater. */
async function* chunked(lines: AsyncIterable<string>): AsyncGenerator<Uint8Array> {
  let parts: string[] = [];
  let len = 0;
  for await (const line of lines) {
    parts.push(line, "\n");
    len += line.length + 1;
    if (len >= CHUNK_BYTES) {
      yield Buffer.from(parts.join(""), "utf8");
      parts = [];
      len = 0;
    }
  }
  if (parts.length > 0) yield Buffer.from(parts.join(""), "utf8");
}

class CursorReader {
  private buf: { t: number; r: JsonObject }[] = [];
  private i = 0;
  private done = false;
  constructor(
    private readonly tx: Tx,
    private readonly onProgress: (() => void) | undefined,
  ) {}

  private async peek(): Promise<{ t: number; r: JsonObject } | undefined> {
    if (this.i >= this.buf.length && !this.done) {
      this.onProgress?.();
      this.buf = await fetchExportCursor(this.tx, CURSOR_PAGE);
      this.i = 0;
      if (this.buf.length === 0) this.done = true;
    }
    return this.buf[this.i];
  }

  async *rowsOf(index: number): AsyncGenerator<JsonObject> {
    for (;;) {
      const next = await this.peek();
      if (next === undefined || Number(next.t) !== index) return;
      this.i += 1;
      yield next.r;
    }
  }
}

async function sha256OfFile(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export async function exportWorkspace(
  deps: PortabilityEngineDeps,
  input: ExportWorkspaceInput,
): Promise<ExportWorkspaceResult> {
  const now = deps.now?.() ?? new Date();
  const ctx = systemContext(input.workspaceId);
  const writer = await ZipFileWriter.create(input.outPath, now);
  try {
    // Phase 1: the rows, the audit trail and the data keys, in one short read-only transaction.
    const snapshot = await deps.db.withTenant(ctx, (tx) =>
      writeContent(deps, tx, ctx, input, writer, now),
    );
    // Phase 2: the objects, outside any transaction (content-addressed; verified as copied).
    const blobBytes = await copyBlobs(deps, snapshot, writer, input.onProgress);
    const { manifest, order } = await snapshot.finish(blobBytes);
    const bytes = manifestBytes(manifest);
    await writer.add(ENTRY.manifest, [bytes], { deflate: false });
    const signature = signManifest(bytes, exportSigningKey(deps.keyRing.current));
    await writer.add(ENTRY.signature, [Buffer.from(signature, "utf8")], { deflate: false });
    const { size } = await writer.finish([ENTRY.manifest, ENTRY.signature, ...order]);
    const sha256 = await sha256OfFile(input.outPath);
    deps.log?.("portability.exported", {
      workspaceId: input.workspaceId,
      size,
      tables: manifest.tables.length,
      blobs: manifest.blobs.count,
    });
    return {
      manifest,
      sha256,
      size,
      manifestSha256: sha256Hex(bytes),
      warnings: omittedWarnings(manifest.omitted ?? []),
    };
  } catch (error) {
    await writer.abort();
    await rm(input.outPath, { force: true });
    throw error;
  }
}

/** What phase 1 hands phase 2: the objects to copy, their keys, and how to finish the manifest. */
interface Snapshot {
  readonly blobs: ReadonlyMap<string, BlobSource>;
  readonly keys: ReadonlyMap<string, Uint8Array>;
  readonly files: Record<string, string>;
  readonly order: string[];
  finish(blobBytes: number): Promise<{ manifest: ExportManifest; order: string[] }>;
}

/** The human-readable warning for each omitted schema that holds (or may hold) this workspace's rows. */
export function omittedWarnings(omitted: readonly OmittedSchema[]): string[] {
  const out: string[] = [];
  for (const o of omitted) {
    const known = o.tables.every((t) => t.rows !== null);
    const rows = o.tables.reduce((n, t) => n + (t.rows ?? 0), 0);
    if (known && rows === 0) continue;
    const what = known
      ? `${rows} row(s) of this workspace`
      : "rows of this workspace (not countable)";
    out.push(
      o.module === null
        ? `schema ${o.schema} holds ${what} but no module compiled into this build owns it: NOT in this export`
        : `module ${o.module} is compiled in but not loaded on this instance (MODULES): its schema ${o.schema} holds ${what} that are NOT in this export`,
    );
  }
  return out;
}

async function copyBlobs(
  deps: PortabilityEngineDeps,
  snapshot: Snapshot,
  writer: ZipFileWriter,
  onProgress: (() => void) | undefined,
): Promise<number> {
  let bytes = 0;
  for (const [sha256, src] of snapshot.blobs) {
    const read = await deps.storage.get(src.key);
    if (read === undefined)
      throw new PortabilityError("blob_missing", `object ${src.key} is missing from storage`);
    let body = read.body as unknown as AsyncIterable<Uint8Array>;
    if (src.keyId !== undefined) {
      const dek = snapshot.keys.get(src.keyId);
      if (dek === undefined) throw new Error(`workspace key ${src.keyId} was not resolved`);
      body = decryptStream(dek, read.body) as unknown as AsyncIterable<Uint8Array>;
    }
    const source = body;
    async function* tapped(): AsyncGenerator<Uint8Array> {
      for await (const chunk of source) {
        onProgress?.();
        yield chunk;
      }
    }
    const name = blobEntryName(sha256);
    const written = await writer.add(name, tapped(), { deflate: false });
    if (written.sha256 !== sha256)
      throw new PortabilityError(
        "blob_mismatch",
        `object ${src.key} has sha256 ${written.sha256}, its row says ${sha256} (or it changed during the export)`,
      );
    snapshot.files[name] = sha256;
    snapshot.order.push(name);
    bytes += written.size;
  }
  return bytes;
}

async function writeContent(
  deps: PortabilityEngineDeps,
  tx: Tx,
  ctx: TenantContext,
  input: ExportWorkspaceInput,
  writer: ZipFileWriter,
  now: Date,
): Promise<Snapshot> {
  const ws = input.workspaceId;
  await prepareExportSession(tx);
  const plan = planTables(deps.modules);
  const catalog = await listCatalogTables(tx);
  const undeclared = findUndeclared(catalog, plan, deps.modules);
  const tolerated = new Set(input.allowUndeclared ?? []);
  const refused = undeclared.filter((n) => !tolerated.has(n));
  if (refused.length > 0) {
    throw new PortabilityError(
      "undeclared_tables",
      `these tables have no portability decision, so an export would silently leave their rows behind: ${refused.join(", ")}`,
      refused,
    );
  }
  const catalogNames = new Set(catalog.map((c) => `${c.schema}.${c.table}`));
  const workspace = await readWorkspaceRow(tx, ws);
  if (workspace === undefined) throw new PortabilityError("not_found", "no such live workspace");
  const migrations = await buildMigrations(deps.modules);

  const blobs = new Map<string, BlobSource>();
  const keys = new Map<string, Uint8Array>();
  const files: Record<string, string> = {};
  const tables: ManifestTable[] = [];
  const order: string[] = [];

  // --- decide each table
  type Step =
    | { readonly p: PlannedTable; readonly kind: "skip"; readonly skipped: TableSkip }
    | { readonly p: PlannedTable; readonly kind: "special" }
    | { readonly p: PlannedTable; readonly kind: "cursor"; readonly index: number };
  const steps: Step[] = [];
  const cursorTables: CursorTable[] = [];
  for (const p of plan) {
    if (p.spec.mode === "skip") {
      steps.push({ p, kind: "skip", skipped: p.spec.reason ?? "derived" });
      continue;
    }
    if (p.spec.includeWhen === "rawAnalytics" && !input.includeRawAnalytics) {
      steps.push({ p, kind: "skip", skipped: "excluded" });
      continue;
    }
    if (!catalogNames.has(p.name)) {
      throw new PortabilityError(
        "incompatible",
        `${p.name} is declared (${p.owner}) but the table does not exist; run the migrations`,
      );
    }
    const special = p.kernel?.special;
    if (special === "workspace" || special === "mail_suppression") {
      steps.push({ p, kind: "special" });
      continue;
    }
    const info = await describeTable(tx, p.schema, p.table);
    const columns = new Set(info.columns.map((c) => c.name));
    for (const b of p.spec.blobs ?? []) {
      for (const c of [b.keyColumn, b.encryptionColumn, b.sha256Column]) {
        if (c !== undefined && !columns.has(c))
          throw new PortabilityError("incompatible", `${p.name}: blob column ${c} does not exist`);
      }
    }
    cursorTables.push({
      info,
      orderBy: p.kernel?.orderBy,
      withIdentity: special === "membership",
    });
    steps.push({ p, kind: "cursor", index: cursorTables.length - 1 });
  }

  const addTable = async (p: PlannedTable, lines: AsyncIterable<string>, dropped?: number) => {
    let rows = 0;
    async function* counted(): AsyncGenerator<string> {
      for await (const line of lines) {
        rows += 1;
        yield line;
      }
    }
    const entry = tableEntryName(p.schema, p.table);
    const written = await writer.add(entry, chunked(counted()), { deflate: true });
    files[entry] = written.sha256;
    order.push(entry);
    tables.push({
      name: p.name,
      rows,
      sha256: written.sha256,
      ...(dropped !== undefined && dropped > 0 ? { dropped } : {}),
    });
  };

  // --- blobs: the data keys resolved now (phase 2 has no transaction), bytes copied later
  const dekFor = async (keyId: string, key: string): Promise<Uint8Array> => {
    const known = keys.get(keyId);
    if (known !== undefined) return known;
    const k = await deps.envelope.keyById(tx, ctx, keyId);
    if (k === undefined) throw new Error(`workspace key ${keyId} (for ${key}) is unknown`);
    keys.set(keyId, k.key);
    return k.key;
  };
  /** Reads and hashes an object now (its digest is needed for the row); undefined if missing. */
  const noteBlob = async (
    key: string,
    keyId: string | undefined,
  ): Promise<{ sha256: string; size: number } | undefined> => {
    const dek = keyId === undefined ? undefined : await dekFor(keyId, key);
    const read = await deps.storage.get(key);
    if (read === undefined) return undefined;
    const body = dek === undefined ? read.body : decryptStream(dek, read.body);
    const h = await hashStream(body as unknown as AsyncIterable<Uint8Array>);
    if (!blobs.has(h.sha256)) blobs.set(h.sha256, { key, keyId });
    return h;
  };

  const exportBlob = async (p: PlannedTable, row: JsonObject, b: PortableBlob): Promise<void> => {
    const key = row[b.keyColumn];
    if (key === null || key === undefined) return;
    if (typeof key !== "string")
      throw new PortabilityError("incompatible", `${p.name}.${b.keyColumn} is not a text key`);
    const rawEnc = b.encryptionColumn === undefined ? undefined : row[b.encryptionColumn];
    const enc = parseShe(rawEnc);
    if (
      b.encryptionColumn !== undefined &&
      enc === undefined &&
      rawEnc !== null &&
      rawEnc !== undefined
    ) {
      // `{}` is a column default meaning "not written yet"; anything else we cannot read.
      if (!(typeof rawEnc === "object" && Object.keys(rawEnc as object).length === 0))
        throw new PortabilityError("incompatible", `${p.name}.${b.encryptionColumn} is not SHE1`);
    }
    const declared = b.sha256Column === undefined ? undefined : hexDigest(row[b.sha256Column]);
    if (declared !== undefined && !b.optional) {
      // Content-addressed and declared: not read now. Phase 2 copies it and refuses a mismatch.
      if (enc !== undefined) await dekFor(enc.keyId, key);
      if (!blobs.has(declared)) blobs.set(declared, { key, keyId: enc?.keyId });
      row[b.keyColumn] = `blob:${declared}`;
      if (b.encryptionColumn !== undefined) row[b.encryptionColumn] = null;
      const meta = (row["$blobs"] ?? {}) as Record<string, JsonValue>;
      meta[b.keyColumn] = { sha256: declared, key };
      row["$blobs"] = meta;
      return;
    }
    const h = await noteBlob(key, enc?.keyId);
    if (h === undefined) {
      if (b.optional) {
        row[b.keyColumn] = null;
        if (b.encryptionColumn !== undefined) row[b.encryptionColumn] = null;
        return;
      }
      throw new PortabilityError(
        "blob_missing",
        `${p.name}: object ${key} is missing from storage`,
      );
    }
    if (declared !== undefined && declared !== h.sha256)
      throw new PortabilityError(
        "blob_mismatch",
        `${p.name}: object ${key} has sha256 ${h.sha256}, the row says ${declared}`,
      );
    row[b.keyColumn] = `blob:${h.sha256}`;
    if (b.encryptionColumn !== undefined) row[b.encryptionColumn] = null;
    const meta = (row["$blobs"] ?? {}) as Record<string, JsonValue>;
    meta[b.keyColumn] = { sha256: h.sha256, key, size: h.size };
    row["$blobs"] = meta;
  };

  const exportCertificate = async (row: JsonObject): Promise<void> => {
    const ref =
      typeof row["evidence_ref"] === "string" ? CERT_REF_RE.exec(row["evidence_ref"]) : null;
    if (!ref) return;
    const certificateId = (ref[1] as string).toLowerCase();
    const keyId = (ref[2] as string).toLowerCase();
    const found: Record<string, JsonValue> = { certificateId };
    for (const form of ["json", "pdf"] as const) {
      const h = await noteBlob(certificateKey(ws, certificateId, form), keyId);
      if (h === undefined) {
        // The certificate's bytes are gone (crypto-shredded or never written): carry the
        // acceptance without a reference the new workspace could not resolve.
        row["evidence_ref"] = null;
        return;
      }
      found[form] = h.sha256;
    }
    row["$certificate"] = found;
  };

  const exportRowOf = async (p: PlannedTable, raw: JsonObject): Promise<JsonObject | null> => {
    let row: JsonObject = { ...raw };
    for (const c of p.spec.omitColumns ?? []) delete row[c];
    if (p.kernel?.special === "membership") {
      const id = row["$identity"];
      row["$identity"] = typeof id === "object" && id !== null ? id : null;
    }
    if (p.spec.exportRow) {
      const r = p.spec.exportRow(row);
      if (r === null) return null;
      row = r;
    }
    if (p.kernel?.special === "attestation") await exportCertificate(row);
    for (const b of p.spec.blobs ?? []) await exportBlob(p, row, b);
    return row;
  };

  // --- tables, in plan order, off one cursor
  await openExportCursor(tx, ws, cursorTables);
  const cursor = new CursorReader(tx, input.onProgress);
  for (const step of steps) {
    const p = step.p;
    if (step.kind === "skip") {
      tables.push({ name: p.name, rows: 0, skipped: step.skipped });
      continue;
    }
    if (step.kind === "special" && p.kernel?.special === "workspace") {
      const row = await workspaceRow(workspace);
      await addTable(
        p,
        (async function* () {
          yield JSON.stringify(row);
        })(),
      );
      continue;
    }
    if (step.kind === "special") {
      const { lines, dropped } = await suppressionLines();
      await addTable(
        p,
        (async function* () {
          yield* lines;
        })(),
        dropped,
      );
      continue;
    }
    const index = step.index;
    await addTable(
      p,
      (async function* () {
        for await (const raw of cursor.rowsOf(index)) {
          const row = await exportRowOf(p, raw);
          if (row !== null) yield JSON.stringify(row);
        }
      })(),
    );
  }
  if (cursorTables.length > 0) await closeExportCursor(tx);
  for (const name of undeclared) tables.push({ name, rows: 0, skipped: "undeclared" });

  async function workspaceRow(w: JsonObject): Promise<JsonObject> {
    const row: JsonObject = { ...w };
    const settings = (
      typeof row["settings"] === "object" && row["settings"] !== null
        ? { ...(row["settings"] as JsonObject) }
        : {}
    ) as JsonObject;
    const branding =
      typeof settings["branding"] === "object" && settings["branding"] !== null
        ? { ...(settings["branding"] as JsonObject) }
        : undefined;
    const logo =
      branding && typeof branding["logo"] === "object" && branding["logo"] !== null
        ? { ...(branding["logo"] as JsonObject) }
        : undefined;
    if (branding && logo && typeof logo["key"] === "string") {
      const key = logo["key"];
      const h = await noteBlob(key, undefined);
      if (h === undefined) {
        branding["logo"] = null;
      } else {
        logo["key"] = `blob:${h.sha256}`;
        branding["logo"] = logo;
        row["$blobs"] = { logo: { sha256: h.sha256, key, size: h.size } };
      }
      settings["branding"] = branding;
    }
    row["settings"] = settings;
    return row;
  }

  async function suppressionLines(): Promise<{ lines: string[]; dropped: number }> {
    const keys = await deps.envelope.keysFor(tx, ctx, SUPPRESSION_KEY_PURPOSE);
    const byHash = new Map<string, string>();
    for (const email of await knownEmails(tx, ws)) {
      for (const k of keys) byHash.set(suppressionHash(k.key, email).toString("hex"), email);
    }
    const lines: string[] = [];
    let dropped = 0;
    for (const s of await listSuppressions(tx, ws)) {
      const address = byHash.get(Buffer.from(s.addressHash).toString("hex"));
      if (address === undefined) {
        dropped += 1;
        continue;
      }
      lines.push(
        JSON.stringify({
          id: s.id,
          address,
          address_masked: s.addressMasked || maskAddress(address),
          reason: s.reason,
          created_at: s.createdAt,
          created_by: s.createdBy,
        }),
      );
    }
    return { lines, dropped };
  }

  // --- the audit trail
  const range = await auditSeqRange(tx, ws);
  let auditRows = 0;
  let prevHash: string | null = null;
  let headHash: string | null = null;
  let headSeq: number | null = null;
  async function* auditLines(): AsyncGenerator<string> {
    if (range === undefined) return;
    for (let from = range.fromSeq; from <= range.toSeq; from += AUDIT_PAGE) {
      input.onProgress?.();
      const to = Math.min(range.toSeq, from + AUDIT_PAGE - 1);
      for (const r of await exportRows(tx, ws, from, to)) {
        if (auditRows === 0) prevHash = parseCanonical(r.canonical).prev_hash ?? null;
        auditRows += 1;
        headHash = Buffer.from(r.hash).toString("hex");
        headSeq = r.seq;
        yield JSON.stringify({ seq: r.seq, canonical: r.canonical, hash: headHash });
      }
    }
  }
  const events = await writer.add(ENTRY.auditEvents, chunked(auditLines()), { deflate: true });
  files[ENTRY.auditEvents] = events.sha256;
  order.push(ENTRY.auditEvents);
  const checkpoints =
    range === undefined
      ? []
      : (await listCheckpointsInRange(tx, ws, range.fromSeq, range.toSeq)).map((cp) => ({
          id: cp.id,
          seq: Number(cp.seq),
          hash: Buffer.from(cp.hash).toString("hex"),
          eventId: cp.eventId,
          headOccurredAt: new Date(cp.headOccurredAt).toISOString(),
          previousCheckpointId: cp.previousCheckpointId,
          keyId: cp.keyId,
          signature: cp.signature ? Buffer.from(cp.signature).toString("base64") : null,
        }));
  const cp = await writer.add(
    ENTRY.auditCheckpoints,
    [Buffer.from(`${JSON.stringify(checkpoints, null, 2)}\n`, "utf8")],
    { deflate: true },
  );
  files[ENTRY.auditCheckpoints] = cp.sha256;
  order.push(ENTRY.auditCheckpoints);

  // --- module schemas this instance has but does not load (MODULES): recorded, never silent
  const loadedSchemas = new Set(
    deps.modules.flatMap((m) => (m.schema === undefined ? [] : [m.schema])),
  );
  const compiled = deps.compiledModules ?? deps.modules;
  const omittedBySchema = new Map<string, { name: string; rows: number | null }[]>();
  for (const t of catalog) {
    if (!t.hasWorkspaceId || t.schema === "core" || t.schema === "audit") continue;
    if (loadedSchemas.has(t.schema)) continue;
    const list = omittedBySchema.get(t.schema) ?? [];
    list.push({
      name: `${t.schema}.${t.table}`,
      rows: await countWorkspaceRows(tx, t.schema, t.table, ws),
    });
    omittedBySchema.set(t.schema, list);
  }
  const omitted: OmittedSchema[] = [...omittedBySchema].map(([schema, list]) => ({
    schema,
    module: compiled.find((m) => m.schema === schema)?.id ?? null,
    tables: list,
  }));

  // --- modules section
  const modules: Record<string, { version: number; migrations: string[] }> = {
    [KERNEL_OWNER]: {
      version: KERNEL_PORTABILITY_VERSION,
      migrations: migrations[KERNEL_OWNER] ?? [],
    },
  };
  for (const m of deps.modules) {
    if (m.migrations === undefined && m.portability === undefined) continue;
    modules[m.id] = { version: m.portability?.version ?? 0, migrations: migrations[m.id] ?? [] };
  }

  const signingKey = exportSigningKey(deps.keyRing.current);
  const finish = async (blobBytes: number) => {
    const partial: Omit<ExportManifest, "files"> = {
      format: EXPORT_FORMAT,
      version: EXPORT_FORMAT_VERSION,
      exportedAt: now.toISOString(),
      source: {
        workspaceId: ws,
        slug: String(workspace["slug"]),
        name: String(workspace["name"]),
        instanceVersion: deps.instanceVersion,
      },
      options: { includeRawAnalytics: input.includeRawAnalytics },
      modules,
      tables,
      blobs: { count: blobs.size, bytes: blobBytes },
      omitted,
      audit: { rows: auditRows, fromSeq: range?.fromSeq ?? null, headSeq, headHash, prevHash },
      signature: {
        alg: "Ed25519" as const,
        keyId: signingKey.keyId,
        publicKey: Buffer.from(signingKey.publicKey).toString("base64"),
      },
    };
    const readme = Buffer.from(readmeText(partial, plan), "utf8");
    const readmeEntry = await writer.add(ENTRY.readme, [readme], { deflate: true });
    files[ENTRY.readme] = readmeEntry.sha256;
    order.push(ENTRY.readme);

    const manifest: ExportManifest = {
      format: partial.format,
      version: partial.version,
      exportedAt: partial.exportedAt,
      source: partial.source,
      options: partial.options,
      modules: partial.modules,
      tables: partial.tables,
      blobs: partial.blobs,
      omitted: partial.omitted,
      files,
      audit: partial.audit,
      signature: partial.signature,
    };
    return { manifest, order };
  };
  return { blobs, keys, files, order, finish };
}

/** A `sha256Column` value (bytea `\x…` or 64-hex text) as lower-case hex, or undefined. */
function hexDigest(value: unknown): string | undefined {
  const hex =
    byteaHex(value) ??
    (typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value) ? value.toLowerCase() : undefined);
  return hex !== undefined && hex.length === 64 ? hex : undefined;
}
