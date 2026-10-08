import { createHash } from "node:crypto";
import { MATCHER_VERSION, normalizeName } from "@fundroom/sanctions";
import { OfacCsvError, parseCsv, programsOf, value } from "./csv.js";

/*
 * The OFAC list in memory (E3.10): the four exports parsed into entries with their names already
 * normalised, and the snapshot's version. Pure — no I/O; `index.ts` downloads and caches.
 *
 *   SDN.CSV        ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type, Tonnage,
 *                  GRT, Vess_flag, Vess_owner, Remarks
 *   ALT.CSV        ent_num, alt_num, alt_type, alt_name, alt_remarks
 *   CONS_PRIM.CSV  as SDN.CSV, for the non-SDN consolidated list
 *   CONS_ALT.CSV   as ALT.CSV
 *
 * A file that does not parse, a primary row without a numeric id or a name, or an alias naming an
 * entry that is not on the list rejects the whole snapshot: a half-parsed list must never screen
 * anybody "clear".
 */

export const OFAC_FILES = ["SDN.CSV", "ALT.CSV", "CONS_PRIM.CSV", "CONS_ALT.CSV"] as const;
export type OfacFile = (typeof OFAC_FILES)[number];

export const SOURCE_SDN = "OFAC SDN";
export const SOURCE_CONSOLIDATED = "OFAC Consolidated (non-SDN)";

/** SDN_Type values that name a thing, not a party a company could be (a vessel, an aircraft). */
const NOT_A_PARTY = new Set(["vessel", "aircraft"]);

export interface OfacName {
  readonly name: string;
  readonly tokens: readonly string[];
}

export interface OfacEntry {
  /** `sdn:<ent_num>` or `cons:<ent_num>`. */
  readonly id: string;
  readonly source: string;
  readonly primaryName: string;
  readonly programs: readonly string[];
  /** The primary name first, then the aliases. */
  readonly names: readonly OfacName[];
}

export interface OfacList {
  /** `ofac:<sha256-12>:jw4`. */
  readonly version: string;
  readonly entries: readonly OfacEntry[];
}

export class OfacListError extends Error {
  override readonly name = "OfacListError";
}

/** The snapshot's version: SHA-256 over every file (name, length, bytes), 12 hex, matcher tag. */
export function versionOf(files: Readonly<Record<OfacFile, Uint8Array>>): string {
  const hash = createHash("sha256");
  for (const name of OFAC_FILES) {
    const bytes = files[name];
    hash.update(`${name}\n${bytes.byteLength}\n`);
    hash.update(bytes);
  }
  return `ofac:${hash.digest("hex").slice(0, 12)}:${MATCHER_VERSION}`;
}

function decode(bytes: Uint8Array): string {
  // The exports have been Latin-1 as well as UTF-8 over the years: UTF-8 (strict) first.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

function rowsOf(name: OfacFile, bytes: Uint8Array): string[][] {
  try {
    return parseCsv(decode(bytes));
  } catch (error) {
    if (error instanceof OfacCsvError) throw new OfacListError(`${name}: ${error.message}`);
    throw error;
  }
}

interface Building {
  readonly id: string;
  readonly source: string;
  readonly primaryName: string;
  readonly programs: string[];
  readonly names: OfacName[];
}

function primaries(
  file: OfacFile,
  bytes: Uint8Array,
  prefix: string,
  source: string,
  into: Map<string, Building | null>,
): number {
  let count = 0;
  for (const [i, row] of rowsOf(file, bytes).entries()) {
    const num = value(row[0]);
    const name = value(row[1]);
    if (num === null || !/^\d+$/u.test(num) || name === null || row.length < 4) {
      throw new OfacListError(`${file}: row ${i + 1} is not an entry`);
    }
    count++;
    const id = `${prefix}:${num}`;
    const type = (value(row[2]) ?? "").toLowerCase();
    // Vessels and aircraft stay known (their aliases are valid) but are never screened against.
    if (NOT_A_PARTY.has(type)) {
      into.set(id, null);
      continue;
    }
    into.set(id, {
      id,
      source,
      primaryName: name,
      programs: programsOf(row[3]),
      names: [{ name, tokens: normalizeName(name) }],
    });
  }
  return count;
}

function aliases(
  file: OfacFile,
  bytes: Uint8Array,
  prefix: string,
  into: Map<string, Building | null>,
): void {
  for (const [i, row] of rowsOf(file, bytes).entries()) {
    const num = value(row[0]);
    const name = value(row[3]);
    if (num === null || !/^\d+$/u.test(num) || name === null) {
      throw new OfacListError(`${file}: row ${i + 1} is not an alias`);
    }
    const id = `${prefix}:${num}`;
    if (!into.has(id)) throw new OfacListError(`${file}: row ${i + 1} names unknown entry ${num}`);
    into.get(id)?.names.push({ name, tokens: normalizeName(name) });
  }
}

/**
 * Parses a complete snapshot. `minPrimaryEntries`: fewer SDN rows than this is a truncated
 * download, not a list (the real SDN list has ~19 000).
 */
export function buildList(
  files: Readonly<Record<OfacFile, Uint8Array>>,
  options: { readonly minPrimaryEntries: number },
): OfacList {
  const byId = new Map<string, Building | null>();
  const sdn = primaries("SDN.CSV", files["SDN.CSV"], "sdn", SOURCE_SDN, byId);
  if (sdn < options.minPrimaryEntries) {
    throw new OfacListError(
      `SDN.CSV has ${sdn} entries, fewer than the ${options.minPrimaryEntries} expected`,
    );
  }
  primaries("CONS_PRIM.CSV", files["CONS_PRIM.CSV"], "cons", SOURCE_CONSOLIDATED, byId);
  aliases("ALT.CSV", files["ALT.CSV"], "sdn", byId);
  aliases("CONS_ALT.CSV", files["CONS_ALT.CSV"], "cons", byId);
  const entries: OfacEntry[] = [];
  for (const entry of byId.values()) if (entry !== null) entries.push(entry);
  return { version: versionOf(files), entries };
}
