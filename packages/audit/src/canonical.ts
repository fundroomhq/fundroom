import { createHash, timingSafeEqual } from "node:crypto";

/*
 * Offline verification of an exported chain (design/02 §6 "verification CLI shipped in
 * the repo"). The database hashes `audit.canonical(row)` — a jsonb rendering with a fixed
 * key set — and an export carries that text verbatim, so a verifier needs no Postgres:
 *
 *   hash_n = sha256(canonical_n), canonical_n.prev_hash = hash_{n-1}, seq contiguous.
 *
 * The verifier also parses each canonical text and checks the embedded seq, so a row cannot
 * be moved to another position without changing its hash.
 */
export interface ExportedChainRow {
  readonly seq: number;
  readonly canonical: string;
  /** Hex or bytes. */
  readonly hash: string | Uint8Array;
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly checked: number;
  readonly headHash: string | null;
  readonly problem?: { readonly seq: number; readonly reason: string };
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function toHex(v: string | Uint8Array): string {
  return typeof v === "string" ? v.toLowerCase() : Buffer.from(v).toString("hex");
}

function safeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface CanonicalFields {
  readonly id: string;
  readonly workspace_id: string;
  readonly seq: number;
  readonly occurred_at: string;
  readonly action: string;
  readonly prev_hash: string | null;
  readonly [k: string]: unknown;
}

export function parseCanonical(text: string): CanonicalFields {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("canonical text is not a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  for (const k of ["id", "workspace_id", "occurred_at", "action"]) {
    if (typeof o[k] !== "string") throw new Error(`canonical text lacks ${k}`);
  }
  if (typeof o["seq"] !== "number") throw new Error("canonical text lacks seq");
  if (o["prev_hash"] !== null && typeof o["prev_hash"] !== "string") {
    throw new Error("canonical prev_hash must be hex or null");
  }
  return o as unknown as CanonicalFields;
}

export interface VerifyOptions {
  /** Hash of the row before the first one, when verifying a slice; null for a chain start. */
  readonly expectedPrevHash?: string | null;
}

export function verifyExportedChain(
  rows: readonly ExportedChainRow[],
  options: VerifyOptions = {},
): ChainVerification {
  let expectedPrev: string | null = options.expectedPrevHash ?? null;
  let expectedSeq: number | undefined;
  let checked = 0;
  for (const row of rows) {
    const fail = (reason: string): ChainVerification => ({
      ok: false,
      checked,
      headHash: expectedPrev,
      problem: { seq: row.seq, reason },
    });
    let fields: CanonicalFields;
    try {
      fields = parseCanonical(row.canonical);
    } catch (e) {
      return fail(`unparseable canonical text: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (expectedSeq === undefined) {
      expectedSeq = row.seq;
      if (options.expectedPrevHash === undefined && row.seq !== 1 && fields.prev_hash === null) {
        return fail("chain slice starts after seq 1 but has no prev_hash");
      }
      if (options.expectedPrevHash === undefined) expectedPrev = fields.prev_hash;
    }
    if (row.seq !== expectedSeq) return fail(`expected seq ${expectedSeq}`);
    if (fields.seq !== row.seq) return fail("canonical seq differs from row seq");
    if ((fields.prev_hash ?? null) !== expectedPrev) {
      return fail("prev_hash does not match previous hash");
    }
    const computed = sha256Hex(row.canonical);
    if (!safeHexEqual(computed, toHex(row.hash))) return fail("hash mismatch (row altered)");
    expectedPrev = computed;
    expectedSeq = row.seq + 1;
    checked++;
  }
  return { ok: true, checked, headHash: expectedPrev };
}
