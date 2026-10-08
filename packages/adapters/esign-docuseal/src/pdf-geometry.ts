import { inflateSync } from "node:zlib";
import type { ESignField } from "@fundroom/ports";

/**
 * DocuSeal's `POST /submissions/pdf` takes field areas in "pixel coordinates" of the page — PDF
 * user-space units (1/72 in, origin top-left) — while the port speaks page fractions. The
 * conversion needs the page size, which we read from the PDF's `/MediaBox` without a PDF library
 * (adapters depend only on `@fundroom/ports` + node builtins):
 *
 * - scan the raw file and every Flate-compressed object stream (`/Type /ObjStm`, which pdf-lib
 *   writes by default) for `/MediaBox [x1 y1 x2 y2]`, inflating at most 64 streams and 8 MiB each;
 * - one distinct size → that size for every page (the NDA renderer and nearly every contract PDF);
 * - several sizes → the first one found, reported as `mixed` so the caller can log it;
 * - none → US Letter (612 × 792), reported as `default`.
 *
 * `/Rotate` and `/CropBox` are ignored: our generated PDFs use neither.
 */

export interface PageSize {
  readonly width: number;
  readonly height: number;
}

export const US_LETTER: PageSize = { width: 612, height: 792 };

const MEDIABOX =
  /\/MediaBox\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/gu;
const MAX_STREAMS = 64;
const MAX_INFLATED = 8 * 1024 * 1024;

function scan(text: string, out: PageSize[]): void {
  for (const m of text.matchAll(MEDIABOX)) {
    const [x1, y1, x2, y2] = [m[1], m[2], m[3], m[4]].map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    if (width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)) {
      out.push({ width, height });
    }
  }
}

export function pdfPageSize(bytes: Uint8Array): {
  readonly size: PageSize;
  readonly source: "mediabox" | "default";
  readonly mixed: boolean;
} {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = buf.toString("latin1");
  const found: PageSize[] = [];
  scan(text, found);

  let streams = 0;
  for (const m of text.matchAll(/\d+\s+\d+\s+obj\b/gu)) {
    if (streams >= MAX_STREAMS) break;
    const objStart = (m.index ?? 0) + m[0].length;
    const streamAt = text.indexOf("stream", objStart);
    const endObj = text.indexOf("endobj", objStart);
    if (streamAt < 0 || (endObj >= 0 && streamAt > endObj)) continue;
    const header = text.slice(objStart, streamAt);
    if (!/\/Type\s*\/ObjStm\b/u.test(header) || !/\/FlateDecode\b/u.test(header)) continue;
    let start = streamAt + "stream".length;
    if (text[start] === "\r") start += 1;
    if (text[start] === "\n") start += 1;
    const end = text.indexOf("endstream", start);
    if (end < 0) continue;
    streams += 1;
    try {
      const inflated = inflateSync(buf.subarray(start, end), { maxOutputLength: MAX_INFLATED });
      scan(inflated.toString("latin1"), found);
    } catch {
      // Truncated or not really Flate: ignore this stream.
    }
  }

  const first = found[0];
  if (first === undefined) return { size: US_LETTER, source: "default", mixed: false };
  const key = (s: PageSize): string => `${s.width.toFixed(2)}x${s.height.toFixed(2)}`;
  const mixed = new Set(found.map(key)).size > 1;
  return { size: first, source: "mediabox", mixed };
}

/** Port field (fractions, top-left origin) → DocuSeal area (page units, top-left origin). */
export function toDocusealArea(
  field: ESignField,
  page: PageSize,
): { x: number; y: number; w: number; h: number; page: number } {
  const clamp = (v: number): number => Math.min(Math.max(v, 0), 1);
  const round = (v: number): number => Math.round(v * 100) / 100;
  return {
    x: round(clamp(field.x) * page.width),
    y: round(clamp(field.y) * page.height),
    w: round(clamp(field.w) * page.width),
    h: round(clamp(field.h) * page.height),
    page: field.page,
  };
}
