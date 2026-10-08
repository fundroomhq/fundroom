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

/*
 * The `seed-host.workspace-export` v1 format (E2.8 contract §4): names, the manifest shape, the
 * entry-name grammar and the Ed25519 signing key. Pure — no database, no storage — so the offline
 * verifier (`verify.ts`) and the unit tests share exactly what the writer uses.
 */

export const EXPORT_FORMAT = "seed-host.workspace-export";
export const EXPORT_FORMAT_VERSION = 1;
/** Version of the kernel's (core.*) section; bumped when a kernel table's portable shape changes. */
export const KERNEL_PORTABILITY_VERSION = 1;
/** HKDF info for the export signing key (mirrors the audit bundle's `seed-host/audit/...`). */
export const EXPORT_SIGNING_PURPOSE = "seed-host/workspace/export-ed25519/v1";
/** Envelope purpose of the stored export object (`ws/<ws>/exports/<id>.zip`). */
export const EXPORT_OBJECT_PURPOSE = "workspace-export";
/** Envelope purpose of the source audit archive kept after an import. */
export const IMPORT_ARCHIVE_PURPOSE = "workspace-import";
/** A single zip entry may not inflate beyond this (a zip bomb aimed at the importer). */
export const MAX_ENTRY_BYTES = 5 * 1024 ** 3;
/** `manifest.json` / `manifest.sig` / `audit/checkpoints.json` are read whole: keep them small. */
export const MAX_SMALL_ENTRY_BYTES = 256 * 1024 * 1024;
/** One JSONL line (one row). */
export const MAX_LINE_BYTES = 256 * 1024 * 1024;

export const ENTRY = {
  manifest: "manifest.json",
  signature: "manifest.sig",
  readme: "README.md",
  auditEvents: "audit/events.jsonl",
  auditCheckpoints: "audit/checkpoints.json",
} as const;

const IDENT = "[a-z_][a-z0-9_]{0,62}";
const TABLE_ENTRY_RE = new RegExp(`^tables/(${IDENT})\\.(${IDENT})\\.jsonl$`, "u");
const BLOB_ENTRY_RE = /^blobs\/([0-9a-f]{64})$/u;

export function tableEntryName(schema: string, table: string): string {
  const name = `tables/${schema}.${table}.jsonl`;
  if (!TABLE_ENTRY_RE.test(name)) throw new Error(`invalid table name ${schema}.${table}`);
  return name;
}

export function blobEntryName(sha256Hex: string): string {
  const name = `blobs/${sha256Hex.toLowerCase()}`;
  if (!BLOB_ENTRY_RE.test(name)) throw new Error("a blob entry is named by 64 hex characters");
  return name;
}

export type EntryKind =
  | { readonly kind: "manifest" | "signature" | "readme" | "auditEvents" | "auditCheckpoints" }
  | { readonly kind: "table"; readonly schema: string; readonly table: string }
  | { readonly kind: "blob"; readonly sha256: string };

/** Classifies an entry name; `undefined` for anything an export never contains. */
export function classifyEntry(name: string): EntryKind | undefined {
  for (const [kind, entry] of Object.entries(ENTRY)) {
    if (name === entry) return { kind: kind as "manifest" };
  }
  const t = TABLE_ENTRY_RE.exec(name);
  if (t) return { kind: "table", schema: t[1] as string, table: t[2] as string };
  const b = BLOB_ENTRY_RE.exec(name);
  if (b) return { kind: "blob", sha256: b[1] as string };
  return undefined;
}

/** Manifest-only skip labels beyond `PortableSkipReason`: `excluded` (an export option was off). */
export type TableSkip =
  | "derived"
  | "transient"
  | "secret"
  | "keyed-hash"
  | "instance-local"
  | "excluded"
  | "undeclared";

export interface ManifestTable {
  /** `<schema>.<table>`. */
  readonly name: string;
  readonly rows: number;
  /** sha256 hex of the JSONL entry; absent when skipped. */
  readonly sha256?: string | undefined;
  readonly skipped?: TableSkip | undefined;
  /** Source rows that could not be carried (e.g. suppressions whose address is unknown). */
  readonly dropped?: number | undefined;
}

/**
 * A schema with tenant tables that this export did NOT read: a compiled-in module left out of
 * `MODULES` (`module` = its id), or a schema no compiled-in module owns (`module` = null). `rows`
 * = this workspace's rows at export time, null when they could not be counted.
 */
export interface OmittedSchema {
  readonly schema: string;
  readonly module: string | null;
  readonly tables: readonly { readonly name: string; readonly rows: number | null }[];
}

export interface ExportManifest {
  readonly format: typeof EXPORT_FORMAT;
  readonly version: number;
  readonly exportedAt: string;
  readonly source: {
    readonly workspaceId: string;
    readonly slug: string;
    readonly name: string;
    readonly instanceVersion: string;
  };
  readonly options: { readonly includeRawAnalytics: boolean };
  /** `core` is the kernel; the rest are module ids. `migrations` = applied migration names. */
  readonly modules: Readonly<
    Record<string, { readonly version: number; readonly migrations: readonly string[] }>
  >;
  /** Every declared table, in import (FK dependency) order. */
  readonly tables: readonly ManifestTable[];
  readonly blobs: { readonly count: number; readonly bytes: number };
  /**
   * Module schemas present in the source database but not exported (fix C, 2026-09-23; absent in
   * files written before it). An importer reports them: that data is simply not in the file.
   */
  readonly omitted?: readonly OmittedSchema[] | undefined;
  /** sha256 hex of every entry except `manifest.json` and `manifest.sig`. */
  readonly files: Readonly<Record<string, string>>;
  readonly audit: {
    readonly rows: number;
    readonly fromSeq: number | null;
    readonly headSeq: number | null;
    readonly headHash: string | null;
    readonly prevHash: string | null;
  };
  readonly signature: {
    readonly alg: "Ed25519";
    readonly keyId: string;
    /** Base64 of the raw 32-byte public key. */
    readonly publicKey: string;
  };
}

/** Serialised exactly like this, so the signature covers stable bytes. */
export function manifestBytes(manifest: ExportManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

// --- signing ------------------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface ExportSigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  /** Raw 32 bytes. */
  readonly publicKey: Uint8Array;
}

/**
 * The Ed25519 key for one key ring entry: HKDF-SHA256(ring key, info
 * `seed-host/workspace/export-ed25519/v1`). Deterministic, rotates with the ring, never stored.
 * A different purpose from the audit bundle's key, so an audit bundle signature can never be
 * passed off as a workspace export's and vice versa.
 */
export function exportSigningKey(entry: KeyRingEntry): ExportSigningKey {
  const seed = Buffer.from(
    hkdfSync("sha256", entry.key, new Uint8Array(0), EXPORT_SIGNING_PURPOSE, 32),
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
  readonly alg: "Ed25519";
  /** Base64 raw 32 bytes. */
  readonly publicKey: string;
}

/** Every ring entry's public half, current first (the ring's own order). */
export function exportPublicKeys(ring: KeyRing): ExportPublicKey[] {
  return ring.entries.map((entry) => ({
    keyId: entry.id,
    alg: "Ed25519" as const,
    publicKey: Buffer.from(exportSigningKey(entry).publicKey).toString("base64"),
  }));
}

export function signManifest(bytes: Uint8Array, key: ExportSigningKey): string {
  return `${sign(null, bytes, key.privateKey).toString("base64")}\n`;
}

/** True when `signature` (base64, whitespace ignored) is the Ed25519 signature of `bytes`. */
export function verifyManifestSignature(
  bytes: Uint8Array,
  signature: string,
  publicKeyB64: string,
): boolean {
  const raw = Buffer.from(publicKeyB64, "base64");
  if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  const key = createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
  return verify(null, bytes, key, Buffer.from(signature.trim(), "base64"));
}

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** `\x0a1b…` (what `to_jsonb(bytea)` yields) → hex, or undefined. */
export function byteaHex(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("\\x")) return undefined;
  const hex = value.slice(2).toLowerCase();
  return /^(?:[0-9a-f]{2})*$/u.test(hex) ? hex : undefined;
}

/** Hex → the `\x…` text `jsonb_populate_record` turns back into bytea. */
export function hexBytea(hex: string): string {
  return `\\x${hex}`;
}

/** The exit codes of `fundroom workspace verify-export` / `import` (mirrors the audit verifier). */
export const EXPORT_VERIFY_EXIT = {
  verified: 0,
  failed: 1,
  usage: 2,
  unverifiedOrigin: 3,
} as const;

export const UNVERIFIED_ORIGIN_LINE =
  "UNVERIFIED ORIGIN — the export is internally consistent, but it was checked only against the key it carries itself, so anyone could have made it. Re-run with --public-key <the key from GET /api/v1/portability/export-key on the source instance>.";
