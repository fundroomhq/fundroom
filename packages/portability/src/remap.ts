import { randomBytes } from "node:crypto";
import type { JsonValue } from "@fundroom/ports";

/*
 * The generic id remap of an import (E2.8 contract §2 "Engine semantics"):
 *
 *  - every exported row's `id` (any table, any module, core included) and the source workspace id
 *    get a fresh uuidv7, allocated in export order so time-ordered ids stay time-ordered;
 *  - `deepRemap` replaces every JSON string (at any depth, jsonb included) that EXACTLY equals one
 *    of those ids — and, likewise, an object key — and leaves everything else alone. Substrings are
 *    not touched: a folder `ltree` path or an object key goes through `remapLtree` / `remapKey`,
 *    which a table's `importRow` calls explicitly.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UUID_ANY_RE =
  /(?<![0-9a-f])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})(?![0-9a-f])/giu;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

let lastMs = 0;
let seq = 0;

/**
 * RFC 9562 uuidv7 with a 12-bit monotonic counter in `rand_a`, so ids minted in one millisecond
 * still sort in the order they were minted (the import allocates thousands per millisecond).
 */
export function uuidv7(now: number = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    seq = 0;
  } else {
    seq += 1;
    if (seq > 0xfff) {
      lastMs += 1;
      seq = 0;
    }
  }
  const ms = lastMs;
  const b = randomBytes(16);
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = (ms >>> 24) & 0xff;
  b[3] = (ms >>> 16) & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = 0x70 | ((seq >>> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = 0x80 | ((b[8] as number) & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const hyphenate = (h: string): string =>
  `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

/** old id → new id. Keys are lower-case hyphenated uuids. */
export class IdMap {
  private readonly map = new Map<string, string>();
  private readonly allocated = new Set<string>();

  /** Allocates a new id for `oldId` (idempotent: the same old id always maps to one new id). */
  allocate(oldId: string, newId: string = uuidv7()): string {
    const key = oldId.toLowerCase();
    const existing = this.map.get(key);
    if (existing !== undefined) return existing;
    this.map.set(key, newId);
    this.allocated.add(newId.toLowerCase());
    return newId;
  }

  has(oldId: string): boolean {
    return this.map.has(oldId.toLowerCase());
  }

  /** True when `id` is one of the NEW ids this map handed out (hyphenated, any case). */
  isNewId(id: string): boolean {
    return this.allocated.has(id.toLowerCase());
  }

  get size(): number {
    return this.map.size;
  }

  /** New id, or `oldId` unchanged when it is not an exported row id. */
  mapId = (oldId: string): string => {
    if (oldId.length !== 36) return oldId;
    return this.map.get(oldId.toLowerCase()) ?? oldId;
  };

  /** Labels that are hyphenless uuids (data-room folder paths) → hyphenless new ids. */
  remapLtree = (path: string): string =>
    path
      .split(".")
      .map((label) => {
        if (!/^[0-9a-f]{32}$/iu.test(label)) return label;
        const mapped = this.map.get(hyphenate(label.toLowerCase()));
        return mapped === undefined ? label : mapped.replaceAll("-", "");
      })
      .join(".");

  /** Every uuid inside a string (hyphenated or 32 hex), e.g. `ws/<ws>/renditions/<version>/page/1`. */
  remapKey = (key: string): string =>
    key.replace(UUID_ANY_RE, (match) => {
      if (match.length === 36) return this.map.get(match.toLowerCase()) ?? match;
      const mapped = this.map.get(hyphenate(match.toLowerCase()));
      return mapped === undefined ? match : mapped.replaceAll("-", "");
    });

  /** Deep remap of a JSON value: exact-match strings and object keys. Returns a new value. */
  deepRemap = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return this.mapId(value);
    if (Array.isArray(value)) return value.map(this.deepRemap);
    if (value !== null && typeof value === "object") {
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(value))
        out[this.mapId(k)] = this.deepRemap(v as JsonValue);
      return out;
    }
    return value;
  };
}
