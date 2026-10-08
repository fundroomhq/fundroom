import { describe, expect, it } from "vitest";
import {
  checkLogo,
  LOGO_MAX_BYTES,
  LOGO_MAX_PIXELS,
  LOGO_MIN_PIXELS,
  logoCandidates,
  sniffImage,
} from "./image.js";

/*
 * The bytes are the only thing trusted here, so the fixtures are real headers rather than
 * mocks: a PNG IHDR, a JPEG SOF0 segment and a lossless WebP chunk, each built to say a
 * specific size. If the readers ever start believing a `Content-Type` instead, these stop
 * passing — which is the point, because the sniffed type is echoed as a response header on a
 * route anyone may call.
 */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false); // IHDR chunk length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // colour type: truecolour with alpha
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(20);
  bytes.set([0xff, 0xd8], 0); // SOI
  bytes.set([0xff, 0xc0], 2); // SOF0, the baseline start-of-frame
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 17, false); // segment length
  bytes[6] = 8; // sample precision
  view.setUint16(7, height, false);
  view.setUint16(9, width, false);
  return bytes;
}

function webp(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(34);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 26, true);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // "VP8L", the lossless chunk
  view.setUint32(16, 14, true);
  bytes[20] = 0x2f; // VP8L signature byte
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  bytes[21] = bits & 0xff;
  bytes[22] = (bits >>> 8) & 0xff;
  bytes[23] = (bits >>> 16) & 0xff;
  bytes[24] = (bits >>> 24) & 0xff;
  return bytes;
}

const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><script>alert(1)</script></svg>',
);

describe("sniffImage", () => {
  it("reads the type and intrinsic size from a PNG header", () => {
    expect(sniffImage(png(512, 256))).toEqual({
      contentType: "image/png",
      width: 512,
      height: 256,
    });
  });

  it("reads a JPEG's size from its start-of-frame segment", () => {
    expect(sniffImage(jpeg(640, 480))).toEqual({
      contentType: "image/jpeg",
      width: 640,
      height: 480,
    });
  });

  it("reads a lossless WebP's packed canvas size", () => {
    expect(sniffImage(webp(200, 100))).toEqual({
      contentType: "image/webp",
      width: 200,
      height: 100,
    });
  });

  it("recognises nothing else, however plausible the first bytes look", () => {
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    // A PNG magic with a chunk that is not IHDR: the header does not parse, so it is refused
    // rather than guessed at.
    const notIhdr = png(64, 64);
    notIhdr[12] = 0x49;
    notIhdr[13] = 0x44;
    notIhdr[14] = 0x41;
    notIhdr[15] = 0x54; // "IDAT"
    expect(sniffImage(notIhdr)).toBeNull();
  });
});

describe("checkLogo", () => {
  it("accepts each supported type at a sane size", () => {
    for (const bytes of [png(256, 256), jpeg(300, 120), webp(64, 64)]) {
      const check = checkLogo(bytes);
      expect(check.ok).toBe(true);
    }
  });

  it("refuses an empty body", () => {
    expect(checkLogo(new Uint8Array(0))).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses an oversized body before it looks at the header", () => {
    expect(checkLogo(new Uint8Array(LOGO_MAX_BYTES + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("refuses SVG: it is a script carrier, not an image format we serve", () => {
    expect(checkLogo(SVG)).toEqual({ ok: false, reason: "unsupported_type" });
  });

  it("refuses an image too small to be a logo and one too large to be sane", () => {
    expect(checkLogo(png(LOGO_MIN_PIXELS - 1, 128))).toEqual({ ok: false, reason: "too_small" });
    expect(checkLogo(png(128, LOGO_MIN_PIXELS - 1))).toEqual({ ok: false, reason: "too_small" });
    expect(checkLogo(png(LOGO_MAX_PIXELS + 1, 128))).toEqual({ ok: false, reason: "too_wide" });
  });

  it("accepts exactly the boundary sizes", () => {
    expect(checkLogo(png(LOGO_MIN_PIXELS, LOGO_MIN_PIXELS)).ok).toBe(true);
    expect(checkLogo(png(LOGO_MAX_PIXELS, LOGO_MAX_PIXELS)).ok).toBe(true);
  });
});

describe("logoCandidates", () => {
  const BASE = "https://example.com/about";

  it("prefers the Open Graph image and falls back to the favicon", () => {
    const html = `<head>
      <link rel="shortcut icon" href="/icon.png">
      <meta property="og:image" content="https://cdn.example.com/logo.png">
    </head>`;
    expect(logoCandidates(html, BASE)).toEqual([
      "https://cdn.example.com/logo.png",
      "https://example.com/icon.png",
      "https://example.com/favicon.ico",
    ]);
  });

  it("resolves relative and protocol-relative URLs against the page", () => {
    const html = `<meta name="twitter:image" content="../img/mark.png">`;
    expect(logoCandidates(html, BASE)[0]).toBe("https://example.com/img/mark.png");
  });

  it("always offers /favicon.ico, even for a page that names nothing", () => {
    expect(logoCandidates("<html><body>hello</body></html>", BASE)).toEqual([
      "https://example.com/favicon.ico",
    ]);
  });

  it("drops schemes we will not fetch and never repeats a URL", () => {
    const html = `
      <meta property="og:image" content="data:image/png;base64,AAAA">
      <meta property="og:image:secure_url" content="https://example.com/logo.png">
      <link rel="icon" href="https://example.com/logo.png">
      <link rel="apple-touch-icon" href="javascript:alert(1)">`;
    expect(logoCandidates(html, BASE)).toEqual([
      "https://example.com/logo.png",
      "https://example.com/favicon.ico",
    ]);
  });

  it("survives malformed markup rather than throwing on someone else's page", () => {
    expect(() => logoCandidates('<meta property="og:image" content="::::">', BASE)).not.toThrow();
  });
});
