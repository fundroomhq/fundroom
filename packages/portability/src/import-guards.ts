import type { JsonValue } from "@fundroom/ports";

/*
 * The pure half of the importer's refusal rules (E2.8 fix C). An export file is operator-supplied
 * but not trusted for what it NAMES: a crafted row must not be able to make the importer read,
 * write or delete another workspace's objects, or point a row at another workspace's rows.
 *
 *  1. Object keys. A declared blob key column must arrive as `blob:<64 hex>` or null — nothing
 *     else — and the stored key is derived by the engine (`remapKey` of the source key, then
 *     `checkImportedKey`): a relative path of plain segments that names the NEW workspace, whose
 *     every uuid-shaped segment is the new workspace or an id this import minted. A module's
 *     `importRow` may not change the key the engine wrote; it may only fill a key the engine left
 *     null (the data room's "bytes not exported" placeholder), and only under `ws/<new ws>/`.
 *  2. Verbatim uuids. `collectUuids` gathers every uuid in the file that is not an exported row's
 *     id; the importer asks the database which of them name a row of ANOTHER workspace here and
 *     `scrubForeign` clears those (JSON null, array element dropped, object key removed); a NOT
 *     NULL column holding one refuses the import.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HEX32_RE = /^[0-9a-f]{32}$/iu;
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,255}$/u;
/** What a blob key column holds in the JSONL. */
export const BLOB_VALUE_RE = /^blob:([0-9a-f]{64})$/u;
export const MAX_OBJECT_KEY = 1024;

const hyphenate = (h: string): string =>
  `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

/**
 * Why `key` may not be written by this import, or null when it may. `isNewId` answers for the
 * ids this import minted (hyphenated).
 */
export function checkImportedKey(
  key: string,
  workspaceId: string,
  isNewId: (id: string) => boolean,
): string | null {
  if (key.length === 0 || key.length > MAX_OBJECT_KEY) return "is empty or too long";
  const segments = key.split("/");
  for (const s of segments) {
    if (!SEGMENT_RE.test(s) || s === "." || s === "..")
      return "is not a relative path of plain segments";
  }
  const ws = workspaceId.toLowerCase();
  if (segments[0] === "ws" && segments[1]?.toLowerCase() !== ws)
    return "names another workspace's prefix";
  if (!segments.some((s) => s.toLowerCase() === ws)) return "does not name the new workspace";
  for (const s of segments) {
    const id = UUID_RE.test(s)
      ? s.toLowerCase()
      : HEX32_RE.test(s)
        ? hyphenate(s.toLowerCase())
        : null;
    if (id !== null && id !== ws && !isNewId(id))
      return `names ${s}, which is neither the new workspace nor a row of this import`;
  }
  return null;
}

/** Every uuid string (values and object keys, any depth) in `value`, lower-cased, into `into`. */
export function collectUuids(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (value.length === 36 && UUID_RE.test(value)) into.add(value.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectUuids(v, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k.length === 36 && UUID_RE.test(k)) into.add(k.toLowerCase());
      collectUuids(v, into);
    }
  }
}

const isForeign = (v: unknown, foreign: ReadonlyMap<string, unknown>): v is string =>
  typeof v === "string" && v.length === 36 && foreign.has(v.toLowerCase());

/**
 * `value` with every foreign uuid removed: a string becomes null, an array drops the element, an
 * object drops the key (and nulls the value). `cleared` counts removals.
 */
export function scrubForeign(
  value: JsonValue,
  foreign: ReadonlyMap<string, unknown>,
): { readonly value: JsonValue; readonly cleared: number } {
  let cleared = 0;
  const walk = (v: JsonValue): JsonValue => {
    if (isForeign(v, foreign)) {
      cleared += 1;
      return null;
    }
    if (Array.isArray(v)) {
      const out: JsonValue[] = [];
      for (const x of v) {
        if (isForeign(x, foreign)) {
          cleared += 1;
          continue;
        }
        out.push(walk(x));
      }
      return out;
    }
    if (v !== null && typeof v === "object") {
      const out: Record<string, JsonValue> = {};
      for (const [k, x] of Object.entries(v)) {
        if (isForeign(k, foreign)) {
          cleared += 1;
          continue;
        }
        out[k] = walk(x as JsonValue);
      }
      return out;
    }
    return v;
  };
  const out = walk(value);
  return { value: out, cleared };
}
