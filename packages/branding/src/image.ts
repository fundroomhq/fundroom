/**
 * Identifies logo bytes and reads their intrinsic size from the file header.
 *
 * The content type is decided by the BYTES, never by the upload's `Content-Type` or the
 * file name: both are attacker-controlled, and the stored value is later echoed as a
 * response header on a public route. SVG is deliberately absent from the allow-list — it is
 * a script carrier, and serving one from our own origin would hand a workspace admin stored
 * XSS on the portal. No decoding and no re-encoding happens here, so there is no image
 * library in the dependency tree and nothing to exploit with a malformed body: a file whose
 * header does not parse is simply rejected.
 */

export const LOGO_MIN_PIXELS = 32;
export const LOGO_MAX_PIXELS = 2048;
/** Generous for a logo, and well under any JSON body limit once base64-expanded. */
export const LOGO_MAX_BYTES = 1024 * 1024;

export type LogoContentType = "image/png" | "image/jpeg" | "image/webp";

export interface ImageInfo {
  readonly contentType: LogoContentType;
  readonly width: number;
  readonly height: number;
}

export type LogoRejection =
  | "empty"
  | "too_large"
  | "unsupported_type"
  | "corrupt"
  | "too_small"
  | "too_wide";

export type LogoCheck =
  | { readonly ok: true; readonly info: ImageInfo }
  | { readonly ok: false; readonly reason: LogoRejection };

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean => {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50];

function readPng(bytes: Uint8Array): ImageInfo | null {
  // IHDR is required to be the first chunk: length(4) type(4) width(4) height(4) at offset 8.
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0) !== "IHDR"
  ) {
    return null;
  }
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) return null;
  return { contentType: "image/png", width, height };
}

function readJpeg(bytes: Uint8Array): ImageInfo | null {
  // Walk the marker segments to the first SOFn, which is the only place the size lives.
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint16(offset + 2, false);
    if (length < 2) return null;
    const isBaselineOrProgressive =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isBaselineOrProgressive) {
      if (offset + 9 >= bytes.length) return null;
      const height = view.getUint16(offset + 5, false);
      const width = view.getUint16(offset + 7, false);
      if (width === 0 || height === 0) return null;
      return { contentType: "image/jpeg", width, height };
    }
    offset += 2 + length;
  }
  return null;
}

function readWebp(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 30) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (chunk === "VP8 ") {
    // Lossy: a 3-byte start code then 14-bit width and height, little-endian.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return width && height ? { contentType: "image/webp", width, height } : null;
  }
  if (chunk === "VP8L") {
    // Lossless: signature byte then 14-bit width-1 and height-1 packed across four bytes.
    if (bytes[20] !== 0x2f) return null;
    const bits =
      (bytes[21] ?? 0) |
      ((bytes[22] ?? 0) << 8) |
      ((bytes[23] ?? 0) << 16) |
      ((bytes[24] ?? 0) << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { contentType: "image/webp", width, height };
  }
  if (chunk === "VP8X") {
    // Extended: 24-bit canvas width-1 and height-1, little-endian, after the 4-byte flags.
    const width = ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16)) + 1;
    const height = ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16)) + 1;
    return { contentType: "image/webp", width, height };
  }
  return null;
}

/** Content type and intrinsic size from the header alone; null when nothing recognises it. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  if (startsWith(bytes, PNG_MAGIC)) return readPng(bytes);
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return readJpeg(bytes);
  if (startsWith(bytes, RIFF_MAGIC) && startsWith(bytes, WEBP_MAGIC, 8)) return readWebp(bytes);
  return null;
}

/** The whole acceptance decision for a logo, so route and wizard cannot drift apart. */
export function checkLogo(bytes: Uint8Array): LogoCheck {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, reason: "too_large" };
  const info = sniffImage(bytes);
  if (info === null) return { ok: false, reason: "unsupported_type" };
  if (info.width < LOGO_MIN_PIXELS || info.height < LOGO_MIN_PIXELS) {
    return { ok: false, reason: "too_small" };
  }
  if (info.width > LOGO_MAX_PIXELS || info.height > LOGO_MAX_PIXELS) {
    return { ok: false, reason: "too_wide" };
  }
  return { ok: true, info };
}

const OG_IMAGE_RE =
  /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/giu;
const CONTENT_RE = /content\s*=\s*["']([^"']+)["']/iu;
const ICON_RE = /<link[^>]+rel\s*=\s*["'][^"']*\bicon\b[^"']*["'][^>]*>/giu;
const HREF_RE = /href\s*=\s*["']([^"']+)["']/iu;

/**
 * Candidate logo URLs from a company's home page, best first: the Open Graph image is what
 * the company chose to represent itself, the favicon is the fallback. Parsing is a regex
 * over the head rather than a DOM: the input is an untrusted third-party page fetched
 * through the SSRF guard, and nothing here is rendered — only URLs are extracted, and the
 * caller re-validates each one through the guard before fetching it.
 */
export function logoCandidates(html: string, baseUrl: string): readonly string[] {
  const head = html.slice(0, 200_000);
  const found: string[] = [];
  const push = (raw: string | undefined): void => {
    if (raw === undefined) return;
    try {
      const resolved = new URL(raw, baseUrl);
      if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return;
      const href = resolved.toString();
      if (!found.includes(href)) found.push(href);
    } catch {
      // A malformed URL in someone else's markup is not an error worth reporting.
    }
  };
  for (const tag of head.match(OG_IMAGE_RE) ?? []) push(tag.match(CONTENT_RE)?.[1]);
  for (const tag of head.match(ICON_RE) ?? []) push(tag.match(HREF_RE)?.[1]);
  push(new URL("/favicon.ico", baseUrl).toString());
  return found;
}
