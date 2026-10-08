import { inflateSync } from "node:zlib";

/**
 * Page size detection for coordinate fields. Our field geometry is page fractions; Dropbox Sign wants
 * pixels at 72 DPI from the page's top-left corner (its "new" coordinate system), so we need each page's size. The adapter must not
 * depend on a PDF library (ports + node builtins only), so this is a deliberately small scanner:
 * it collects every `/MediaBox [x0 y0 x1 y1]` in the file — in the plain object text and inside
 * Flate-compressed object streams (pdf-lib and most modern writers put page dictionaries there) —
 * and returns the size when the document is uniform.
 *
 * Mixed page sizes cannot be mapped to page numbers without walking the page tree, so the first
 * size seen is used for every page and `mixed` is reported (the adapter logs a warning). No
 * MediaBox at all → US Letter (612×792), also reported. Page rotation is ignored.
 */

export interface PageSize {
  readonly width: number;
  readonly height: number;
}

export const US_LETTER: PageSize = { width: 612, height: 792 };

const MEDIABOX_RE =
  /\/MediaBox\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/g;
const MAX_INFLATED_TOTAL = 16 * 1024 * 1024;
const MAX_STREAMS = 2048;

function scan(text: string, out: PageSize[]): void {
  for (const m of text.matchAll(MEDIABOX_RE)) {
    const width = Math.abs(Number(m[3]) - Number(m[1]));
    const height = Math.abs(Number(m[4]) - Number(m[2]));
    if (width >= 1 && height >= 1 && width <= 14400 && height <= 14400) out.push({ width, height });
  }
}

export function detectPageSize(bytes: Uint8Array): {
  size: PageSize;
  mixed: boolean;
  found: boolean;
} {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const sizes: PageSize[] = [];
  scan(text, sizes);

  let inflatedTotal = 0;
  let streams = 0;
  let pos = 0;
  for (;;) {
    const at = text.indexOf("stream", pos);
    if (at < 0 || inflatedTotal > MAX_INFLATED_TOTAL) break;
    pos = at + 6;
    if (text.startsWith("end", at - 3)) continue;
    let start = pos;
    if (text[start] === "\r") start++;
    if (text[start] === "\n") start++;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    pos = end + 9;
    // The stream dictionary: from the last `obj` keyword before `stream` (bounded look-back).
    const head = text.slice(Math.max(0, at - 2048), at);
    const dict = head.slice(head.lastIndexOf(" obj") + 1);
    if (!/>>\s*$/.test(dict) || !/\/Type\s*\/ObjStm/.test(dict) || !/\/FlateDecode/.test(dict))
      continue;
    if (++streams > MAX_STREAMS) break;
    try {
      const inflated = inflateSync(bytes.subarray(start, end), {
        maxOutputLength: MAX_INFLATED_TOTAL - inflatedTotal + 1,
      });
      inflatedTotal += inflated.byteLength;
      scan(inflated.toString("latin1"), sizes);
    } catch {
      // Truncated/garbage stream, or over the inflate budget: skip it.
    }
  }

  const first = sizes[0];
  if (!first) return { size: US_LETTER, mixed: false, found: false };
  const mixed = sizes.some(
    (s) => Math.abs(s.width - first.width) > 0.5 || Math.abs(s.height - first.height) > 0.5,
  );
  return { size: first, mixed, found: true };
}
