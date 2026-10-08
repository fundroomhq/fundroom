import { embedForensicMark } from "@fundroom/forensic";
import type {
  DocumentRenderPort,
  GrayImageData,
  ProbeResult,
  RenderableKind,
  RenderedImage,
  RenderPageOptions,
  SanitizeResult,
  WatermarkSpec,
} from "@fundroom/ports";
import { PDFiumLibrary } from "@hyzyla/pdfium";
import {
  degrees,
  LineCapStyle,
  PDFArray,
  PDFDict,
  PDFDocument,
  type PDFFont,
  PDFName,
  type PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type RGB,
  rgb,
  StandardFonts,
} from "pdf-lib";
import sharp, { type Sharp } from "sharp";

/*
 * The default `DocumentRenderPort` (EXECUTION_PLAN §5.2, §8, design/02 §4). Three
 * libraries, all in-process, no system packages (the runtime image is distroless):
 *
 *  - PDFium (WASM, BSD) rasterises pages and extracts text. The WASM module is single
 *    threaded and one document may be open at a time, so every call is serialised through
 *    one queue; text must be read *before* a page is rendered (the build's FPDFText handle
 *    breaks after a render), which `extractText` and `renderPage` never mix in one document.
 *  - pdf-lib (MIT) rewrites the PDF: sanitising strips `OpenAction`, page/document `AA`,
 *    the `JavaScript` and `EmbeddedFiles` name trees, `XFA` and `Launch`/`JavaScript`
 *    annotation actions; watermarking draws the viewer's lines diagonally on every page.
 *  - sharp (Apache-2.0, prebuilt libvips) converts PDFium's RGBA bitmap to WebP/PNG, makes
 *    thumbnails, decodes images and composites the SVG watermark.
 */
export interface PdfiumRendererOptions {
  /** Largest page width in pixels a caller may ask for. Default 2400. */
  readonly maxWidth?: number | undefined;
  /** Largest encoded image `toGray` accepts (bytes). Default 200 MiB (`RENDER_MAX_BYTES`). */
  readonly maxInputBytes?: number | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export const MAX_RENDER_WIDTH = 2400;
/** `toGray` refuses images above this many pixels (decompression bombs). */
export const MAX_GRAY_PIXELS = 50_000_000;
const DEFAULT_MAX_INPUT_BYTES = 200 * 1024 ** 2;
/** `WatermarkSpec.traceId`: the forensic token as hex. */
const TRACE_ID = /^[0-9a-f]{8,64}$/u;
const TRACE_KEY = PDFName.of("SeedHostTrace");

/**
 * Drops every indirect object nothing reachable from the trailer (Root, Info, Encrypt) refers to.
 * pdf-lib re-serialises every object it parsed, so without this an orphan dict, an older
 * revision's Info (incremental update) or a dead object stream would ride along in the output
 * bytes (review RR-3). Returns the reachable refs (by tag).
 */
function pruneUnreachable(pdf: PDFDocument): Set<string> {
  const ctx = pdf.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  for (const key of ["Root", "Info", "Encrypt"] as const) {
    const v = ctx.trailerInfo[key];
    if (v) stack.push(v);
  }
  while (stack.length > 0) {
    const obj = stack.pop() as PDFObject;
    if (obj instanceof PDFRef) {
      if (seen.has(obj.tag)) continue;
      seen.add(obj.tag);
      const target = ctx.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) stack.push(v);
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) stack.push(v);
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
  return seen;
}

/** Every dictionary of the document (indirect, nested, stream dicts and a direct trailer Info). */
function allDicts(pdf: PDFDocument): PDFDict[] {
  const out: PDFDict[] = [];
  const stack: PDFObject[] = pdf.context.enumerateIndirectObjects().map(([, o]) => o);
  const info = pdf.context.trailerInfo.Info;
  if (info && !(info instanceof PDFRef)) stack.push(info);
  while (stack.length > 0) {
    const obj = stack.pop() as PDFObject;
    if (obj instanceof PDFDict) {
      out.push(obj);
      for (const [, v] of obj.entries()) if (!(v instanceof PDFRef)) stack.push(v);
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) if (!(v instanceof PDFRef)) stack.push(v);
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  return out;
}

/**
 * Removes every `/SeedHostTrace` from the document — the trailer Info, any other dictionary, and
 * (by pruning) unreachable objects and older revisions. True when the source carried one anywhere.
 */
function stripTrace(pdf: PDFDocument): boolean {
  const found = allDicts(pdf).some((d) => d.has(TRACE_KEY));
  if (!found) return false;
  pruneUnreachable(pdf);
  for (const d of allDicts(pdf)) d.delete(TRACE_KEY);
  return true;
}
const DEFAULT_QUALITY = 82;

/** A chart with more operations than this is a bug in the caller, not a chart. */
export const MAX_VECTOR_OPS = 20_000;

/**
 * Every intermediate chart PDF is stamped with the same instant. `/ModDate` was the *only*
 * source of instability the E2.4 spike found: without this, two `renderVector` calls with
 * identical operations produce different PDF bytes a second apart, and a cache keyed on the
 * output churns forever. The date is meaningless — the PDF exists for the ~3 ms it takes
 * PDFium to rasterise it and is never written anywhere.
 */
const STABLE_PDF_DATE = new Date(0);

export function sniffContentType(bytes: Uint8Array): string | undefined {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2d)
    return "application/pdf";
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return "image/webp";
  if (at(0) === 0x50 && at(1) === 0x4b && at(2) === 0x03 && at(3) === 0x04)
    return "application/zip";
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) return "video/mp4";
  return undefined;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function kindOf(contentType: string): RenderableKind | "unsupported" {
  if (contentType === "application/pdf") return "pdf";
  if (IMAGE_TYPES.has(contentType)) return "image";
  return "unsupported";
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/gu, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      default:
        return "&quot;";
    }
  });
}

/**
 * A diagonal, tiled text watermark as SVG the size of the page image.
 *
 * **Latin, Cyrillic, Greek, Hebrew, Arabic and the common symbols only.** The lines are drawn
 * through sharp → librsvg → pango → fontconfig against the one face the runtime image ships
 * (DejaVu Sans), and DejaVu has no CJK: a viewer identity, timestamp or workspace name written
 * in Japanese, Chinese or Korean comes out as a grid of hex boxes and the mark carries **none**
 * of the attributable information this control exists for. Measured in the shipped image,
 * `日本語のワークスペース` inks 1 699 px with the font layer against 1 651 px without it — i.e.
 * the font layer does not change it at all. macOS development shows it perfectly through
 * CoreText, which is the same dev/prod divergence §12 C1 was opened to close, still open for
 * these scripts.
 *
 * This is a deliberate scope, not an oversight: a full CJK face is tens of megabytes on a
 * ~590 MB image and choosing to carry it is a decision for whoever owns the image size, not a
 * side effect of a bug fix. `healthCheck()` reports which scripts the running image actually
 * verified (`render.font_coverage`), so the limitation is legible rather than silent, and the
 * runbook says what it means for a CJK workspace. `watermarkPdf()` — the *download* path — does
 * not come through here at all, but it is no better off: it draws base-14 Helvetica, which is
 * WinAnsi-encoded and cannot represent these scripts either.
 */
function watermarkSvg(width: number, height: number, spec: WatermarkSpec): Buffer {
  const opacity = spec.opacity ?? 0.18;
  const fontSize = Math.max(14, Math.round(width / 38));
  const lines = spec.lines.map(escapeXml);
  const lineHeight = fontSize * 1.35;
  const blockHeight = lineHeight * lines.length;
  const stepY = Math.max(blockHeight + fontSize * 6, height / 3);
  const stepX = Math.max(width / 2, fontSize * 24);
  const texts: string[] = [];
  for (let y = -height; y < height * 2; y += stepY) {
    for (let x = -width; x < width * 2; x += stepX) {
      const tspans = lines
        .map((l, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${l}</tspan>`)
        .join("");
      texts.push(`<text x="${x}" y="${y}" font-size="${fontSize}">${tspans}</text>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><g transform="rotate(-30 ${width / 2} ${height / 2})" fill="#000" fill-opacity="${opacity}" font-family="Helvetica, Arial, sans-serif" font-weight="600">${texts.join("")}</g></svg>`;
  return Buffer.from(svg);
}

/**
 * `#rgb` / `#rrggbb` → pdf-lib's `RGB`. The chart geometry package resolves theme tokens to hex
 * strings and holds no palette of its own (E2.4 contract §7), so this is the only place a
 * colour is interpreted. Anything unparseable becomes black rather than throwing: a chart with
 * one wrong colour is a cosmetic bug, a chart that fails to render is a broken email.
 */
function parseColour(value: string): RGB {
  const hex = value.trim().replace(/^#/u, "");
  const full = hex.length === 3 ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : hex;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (full.length < 6 || !Number.isFinite(n)) return rgb(0, 0, 0);
  return rgb(((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255);
}

/** The WinAnsi code points above the Latin-1 block, in CP1252's 0x80–0x9F window. */
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

/**
 * Chart text is drawn in a base-14 standard font, which is WinAnsi-encoded, and pdf-lib throws
 * on a character it cannot encode. A KPI label is workspace-supplied text, so "¥" is expected
 * and "→" is possible; neither may take an update email down. Unencodable characters become
 * "?" and the caller's `describedBy` still carries the real string (contract §7).
 *
 * Embedding a Unicode font instead was rejected for the same reason §D4 chose this path at all:
 * it would put a megabyte of font bytes into every render for a case that is cosmetic.
 */
function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(c) ? ch : "?";
  }
  return out;
}

/**
 * The probe canvas for the font guard below. One glyph at 36px, always at the same baseline on
 * the same canvas, so two probes are comparable pixel for pixel.
 */
const FONT_PROBE = { width: 280, height: 56, size: 36 };

/**
 * U+0378 is a permanent hole in the Greek block — an unassigned code point no font has a glyph
 * for and none ever will. Whatever the SVG text path draws for it *is* this installation's
 * missing-glyph rendering, and every other probe is measured against it.
 *
 * It must be a **BMP** code point, which is the one correction to the obvious choice of a
 * plane-15 private-use code point: pango's hex box is sized to the number of hex digits it
 * shows, so U+F0000 draws a five-digit box (measured bounding box `5,14,43,43` at 36px) while
 * every missing BMP character draws a four-digit one (`5,14,31,43`). A plane-15 reference would
 * therefore differ from every BMP tofu box and the guard would pass on an image that renders
 * nothing but boxes. Every sample below is BMP for the same reason.
 */
const NO_GLYPH = "͸";

/**
 * One representative code point per script the watermark might have to draw. `latin` is the
 * only one that is *required* — the bundled face (DejaVu Sans) has no CJK and is not expected
 * to grow one (see `watermarkSvg`) — but all of them are reported, so an operator can read what
 * the running image actually verified instead of a bare "ok".
 */
const SCRIPT_SAMPLES: readonly (readonly [string, string])[] = [
  ["latin", "M"],
  ["latin-supplement", "é"],
  ["cyrillic", "Ж"],
  ["greek", "α"],
  ["hebrew", "א"],
  ["arabic", "ا"],
  ["symbols", "€"],
  ["han", "日"],
  ["kana", "ノ"],
  ["hangul", "한"],
];

/** What one glyph drew: how many dark pixels, and the box they occupy (`x0,y0,x1,y1`). */
interface GlyphRaster {
  readonly ink: number;
  readonly box: string;
}

/** Rasterises one character through sharp → librsvg → pango and measures what came out. */
async function probeGlyph(text: string): Promise<GlyphRaster> {
  const { width, height, size } = FONT_PROBE;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="4" y="42" font-size="${size}" font-family="sans-serif" fill="#000">${escapeXml(text)}</text></svg>`;
  const { data } = await sharp(Buffer.from(svg))
    .flatten({ background: "#ffffff" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let ink = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < data.length; i++) {
    if ((data[i] ?? 255) >= 128) continue;
    ink++;
    const x = i % width;
    const y = (i - x) / width;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { ink, box: x1 < 0 ? "empty" : `${x0},${y0},${x1},${y1}` };
}

/** Which scripts the SVG text path can actually draw in this process. */
export interface FontCoverage {
  /** Scripts whose sample drew a real glyph. Always contains `latin` (or the guard threw). */
  readonly verified: readonly string[];
  /** Scripts whose sample drew the missing-glyph box: these render as tofu in a watermark. */
  readonly unsupported: readonly string[];
}

function fontError(detail: string): Error {
  return new Error(
    `no font available to librsvg: the SVG text path renders every glyph as a .notdef box, so ` +
      `every data-room watermark would be blank (${detail}). The runtime image must ship a font ` +
      `and a FONTCONFIG_FILE — see deploy/docker/Dockerfile and ADR-0015.`,
  );
}

/**
 * The watermark font guard (E2.4 contract §12 C1, design/02 §4, ADR-0015).
 *
 * `watermarkSvg` composites `<text>` through sharp → librsvg → pango → fontconfig. The runtime
 * image is distroless and shipped with no fonts and no fontconfig, so librsvg rendered every
 * glyph as a `.notdef` box: every per-viewer data-room watermark in production was a grid of
 * empty rectangles, carrying none of the attributable information the control exists for, while
 * macOS development showed it perfectly through CoreText. It failed **silently**, with a
 * plausible non-zero ink count, which is why a guard is needed at all and why an absolute ink
 * threshold is not enough to be one.
 *
 * It tests the property directly rather than a proxy for it. The predecessor compared the ink of
 * "MMMMMM" against "llllll" and demanded a 2× ratio, which measures *"is this font
 * proportional"*: measured through this same probe, one face per isolated fontconfig directory,
 * DejaVu Sans scored 2.79 and Noto Sans 3.51 but DejaVu Sans Mono 1.97, Liberation Mono 1.93 and
 * Nimbus Mono PS 1.97 — so an image whose only Latin face is monospace rendered every glyph
 * perfectly, failed the guard, and never entered rotation.
 *
 * Instead each sample is compared against `NO_GLYPH`, whose rendering *is* this installation's
 * tofu by construction. The comparison is the **ink bounding box**, because that is what both
 * failure modes have in common and a real glyph does not. With no font at all every character
 * draws the same empty rectangle: measured in the real image with its font layer removed, "M",
 * "é", "日" and U+0378 all ink 36 px in box `5,29,12,40`, which is what the boot failure prints.
 * With a font present but lacking the code point, pango draws a hex box whose digits differ but
 * whose frame is the same rectangle to the pixel: in the shipped image "日", "語", "ノ", "한",
 * U+E000 and U+0378 all box `5,14,31,43`. A real glyph is never that rectangle — "M" boxes
 * `8,16,31,41`, "Ж" `5,16,41,41`, "€" `4,15,24,41`.
 */
async function measureFontCoverage(): Promise<FontCoverage> {
  let reference: GlyphRaster;
  const samples: { script: string; raster: GlyphRaster }[] = [];
  try {
    reference = await probeGlyph(NO_GLYPH);
    for (const [script, sample] of SCRIPT_SAMPLES) {
      samples.push({ script, raster: await probeGlyph(sample) });
    }
  } catch (error) {
    throw fontError(`rasterising the probe failed: ${String(error)}`);
  }
  const drewAGlyph = (r: GlyphRaster): boolean => r.ink > 0 && r.box !== reference.box;
  const latin = samples[0];
  if (latin === undefined || !drewAGlyph(latin.raster)) {
    throw fontError(
      `'M' at ${FONT_PROBE.size}px inked ${latin?.raster.ink ?? 0}px in box ` +
        `${latin?.raster.box ?? "empty"}, the same box U+0378 — a code point no font can have a ` +
        `glyph for — draws in (${reference.box}, ${reference.ink}px)`,
    );
  }
  const verified: string[] = [];
  const unsupported: string[] = [];
  for (const { script, raster } of samples)
    (drewAGlyph(raster) ? verified : unsupported).push(script);
  return { verified, unsupported };
}

export function createPdfiumRenderer(options: PdfiumRendererOptions = {}): DocumentRenderPort {
  const maxWidth = options.maxWidth ?? MAX_RENDER_WIDTH;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const log = options.log ?? (() => {});
  let library: Promise<PDFiumLibrary> | undefined;
  let coverage: Promise<FontCoverage> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  /**
   * Memoises the WASM instance — but **only on success**. `library ??= PDFiumLibrary.init()`
   * caches the rejected promise too, so one transient failure at the first render (a stalled
   * WASM fetch, a momentary allocation failure) made every later call in the process replay that
   * same rejection forever, with no retry and nothing short of a restart to clear it. A
   * rejection now drops the memo so the next caller tries again.
   */
  function lib(): Promise<PDFiumLibrary> {
    if (library === undefined) {
      const pending = PDFiumLibrary.init();
      library = pending;
      // Attached here, not by the caller: it is what clears the memo, and it also means the
      // rejection is always observed (the caller's own `await` reports it).
      pending.catch(() => {
        if (library === pending) library = undefined;
      });
    }
    return library;
  }

  /**
   * The font coverage of the running image is static for the life of the process — the font
   * files are baked into the image and the root filesystem is read-only — so it is measured
   * once and remembered, and the result is logged once so an operator can read which scripts
   * this image actually renders rather than inferring it. A *failure* is not remembered, for
   * the same reason `lib()` does not remember one.
   */
  function fonts(): Promise<FontCoverage> {
    if (coverage === undefined) {
      const pending = measureFontCoverage().then((c) => {
        log("render.font_coverage", { verified: [...c.verified], unsupported: [...c.unsupported] });
        return c;
      });
      coverage = pending;
      pending.catch(() => {
        if (coverage === pending) coverage = undefined;
      });
    }
    return coverage;
  }

  /** Serialises PDFium work: one document open at a time in the WASM instance. */
  function withDocument<T>(bytes: Uint8Array, fn: (doc: PdfiumDoc) => Promise<T> | T): Promise<T> {
    const run = async () => {
      const l = await lib();
      const doc = await l.loadDocument(bytes);
      try {
        return await fn(doc);
      } finally {
        doc.destroy();
      }
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  async function encode(
    pipeline: Sharp,
    format: "webp" | "png",
    quality: number,
  ): Promise<RenderedImage> {
    const out =
      format === "png"
        ? await pipeline.png({ compressionLevel: 6 }).toBuffer({ resolveWithObject: true })
        : await pipeline.webp({ quality }).toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(out.data),
      width: out.info.width,
      height: out.info.height,
      contentType: format === "png" ? "image/png" : "image/webp",
    };
  }

  return {
    driver: "pdfium",

    async probe(bytes, contentType): Promise<ProbeResult> {
      const sniffed = sniffContentType(bytes);
      const type = sniffed ?? contentType;
      const kind = kindOf(type);
      if (kind === "unsupported") return { kind, pageCount: 0, pageSizes: [] };
      if (kind === "image") {
        const meta = await sharp(bytes).metadata();
        return {
          kind,
          pageCount: 1,
          pageSizes: [{ width: meta.width ?? 0, height: meta.height ?? 0 }],
        };
      }
      return withDocument(bytes, (doc) => {
        const count = doc.getPageCount();
        const pageSizes: { width: number; height: number }[] = [];
        for (let i = 0; i < count; i++) {
          const size = doc.getPage(i).getOriginalSize();
          pageSizes.push({ width: size.originalWidth, height: size.originalHeight });
        }
        return { kind, pageCount: count, pageSizes };
      });
    },

    async sanitizePdf(bytes): Promise<SanitizeResult> {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      const removed = new Set<string>();
      const catalog = pdf.catalog;
      for (const key of ["OpenAction", "AA"]) {
        if (catalog.has(PDFName.of(key))) {
          catalog.delete(PDFName.of(key));
          removed.add(key);
        }
      }
      const names = catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
      if (names) {
        for (const key of ["JavaScript", "EmbeddedFiles"]) {
          if (names.has(PDFName.of(key))) {
            names.delete(PDFName.of(key));
            removed.add(key);
          }
        }
      }
      const acroForm = catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
      if (acroForm?.has(PDFName.of("XFA"))) {
        acroForm.delete(PDFName.of("XFA"));
        removed.add("XFA");
      }
      const dangerous = new Set(["JavaScript", "Launch", "ImportData", "SubmitForm"]);
      const actionIsDangerous = (dict: PDFDict | undefined): boolean => {
        const s = dict?.lookupMaybe(PDFName.of("S"), PDFName);
        return s !== undefined && dangerous.has(s.decodeText());
      };
      for (const page of pdf.getPages()) {
        if (page.node.has(PDFName.of("AA"))) {
          page.node.delete(PDFName.of("AA"));
          removed.add("AA");
        }
        const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
        if (!annots) continue;
        const keep: (PDFRef | PDFDict)[] = [];
        let dropped = false;
        for (let i = 0; i < annots.size(); i++) {
          const raw = annots.get(i);
          const annot = annots.lookupMaybe(i, PDFDict);
          if (annot === undefined) continue;
          const action = annot.lookupMaybe(PDFName.of("A"), PDFDict);
          if (actionIsDangerous(action) || annot.has(PDFName.of("AA"))) {
            const s = action?.lookupMaybe(PDFName.of("S"), PDFName)?.decodeText();
            removed.add(s ?? "AA");
            dropped = true;
            continue;
          }
          keep.push(raw as PDFRef | PDFDict);
        }
        if (dropped) page.node.set(PDFName.of("Annots"), pdf.context.obj(keep));
      }
      if (stripTrace(pdf)) removed.add("SeedHostTrace");
      if (removed.size === 0) return { bytes, removed: [] };
      const out = await pdf.save({ useObjectStreams: false });
      log("render.sanitized", { removed: [...removed] });
      return { bytes: out, removed: [...removed].sort() };
    },

    async extractText(bytes, kind): Promise<readonly string[]> {
      if (kind !== "pdf") return [];
      return withDocument(bytes, (doc) => {
        const count = doc.getPageCount();
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
          try {
            out.push(doc.getPage(i).getText().replace(/\s+/gu, " ").trim());
          } catch (error) {
            log("render.text_failed", { level: "warn", page: i + 1, error: String(error) });
            out.push("");
          }
        }
        return out;
      });
    },

    async renderPage(bytes, kind, pageNo, opts: RenderPageOptions): Promise<RenderedImage> {
      const width = Math.min(maxWidth, Math.max(64, Math.round(opts.width)));
      const format = opts.format ?? "webp";
      const quality = opts.quality ?? DEFAULT_QUALITY;
      if (kind === "image") {
        if (pageNo !== 1) throw new RangeError("images have one page");
        return encode(
          sharp(bytes).rotate().resize({ width, withoutEnlargement: true }),
          format,
          quality,
        );
      }
      const raw = await withDocument(bytes, async (doc) => {
        if (pageNo < 1 || pageNo > doc.getPageCount()) {
          throw new RangeError(`page ${pageNo} is out of range`);
        }
        const page = doc.getPage(pageNo - 1);
        const size = page.getOriginalSize();
        const scale = Math.max(0.1, width / Math.max(1, size.originalWidth));
        const r = await page.render({ scale, render: "bitmap", transparent: false });
        // `@hyzyla/pdfium` already converts PDFium's BGRA buffer to RGBA.
        return { data: r.data, width: r.width, height: r.height };
      });
      return encode(
        sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }).flatten({
          background: "#ffffff",
        }),
        format,
        quality,
      );
    },

    async watermarkImage(image, spec): Promise<RenderedImage> {
      if (spec.lines.length === 0) return image;
      const format = image.contentType === "image/png" ? "png" : "webp";
      return encode(
        sharp(image.bytes).composite([
          { input: watermarkSvg(image.width, image.height, spec), blend: "over" },
        ]),
        format,
        DEFAULT_QUALITY,
      );
    },

    /**
     * E3.13: decode → `@fundroom/forensic` embed → re-encode exactly as `watermarkImage` does
     * (same format, quality 82). Decoding with the same libvips build that `toGray` uses keeps the
     * served pixels and the detector's reference in one colour pipeline.
     */
    async embedForensicMark(image, mark): Promise<RenderedImage> {
      const format = image.contentType === "image/png" ? "png" : "webp";
      const { data, info } = await sharp(image.bytes).raw().toBuffer({ resolveWithObject: true });
      if (info.channels !== 3 && info.channels !== 4) {
        throw new RangeError(`render-pdfium: cannot mark a ${info.channels}-channel image`);
      }
      const marked = embedForensicMark(
        {
          width: info.width,
          height: info.height,
          channels: info.channels,
          data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        },
        mark.seed,
        mark.strength === undefined ? undefined : { strength: mark.strength },
      );
      return encode(
        sharp(marked.data, {
          raw: { width: marked.width, height: marked.height, channels: marked.channels },
        }),
        format,
        DEFAULT_QUALITY,
      );
    },

    /**
     * E3.13: any png/jpeg/webp → 8-bit luma, EXIF-rotated, flattened on white, at most
     * `maxWidth` wide (default 2400). The format is sniffed from the bytes (the declared type is
     * advisory: an upload labelled image/jpg is still a JPEG). Byte size is checked first; then
     * the header (dimensions + EXIF orientation) is read and the image refused when it exceeds
     * `maxPixels` (default 50 MP) or its output — after the width cap — would be taller than
     * `maxHeight` (default 4 × maxWidth), all BEFORE decoding (review R1-1: a 200 × 250,000 px
     * strip decoded fine under the pixel cap and then cost seconds and a gigabyte downstream).
     */
    async toGray(bytes, _contentType, opts): Promise<GrayImageData> {
      if (bytes.byteLength > maxInputBytes) {
        throw new RangeError(`render-pdfium: image is larger than ${maxInputBytes} bytes`);
      }
      const sniffed = sniffContentType(bytes);
      if (sniffed === undefined || !IMAGE_TYPES.has(sniffed)) {
        throw new RangeError("render-pdfium: not a png, jpeg or webp image");
      }
      const width = Math.max(1, Math.round(opts?.maxWidth ?? MAX_RENDER_WIDTH));
      const maxHeight = Math.max(1, Math.round(opts?.maxHeight ?? width * 4));
      const maxPixels = Math.max(1, Math.round(opts?.maxPixels ?? MAX_GRAY_PIXELS));
      const meta = await sharp(bytes, { limitInputPixels: false }).metadata();
      const rotated = (meta.orientation ?? 1) >= 5;
      const inW = (rotated ? meta.height : meta.width) ?? 0;
      const inH = (rotated ? meta.width : meta.height) ?? 0;
      if (inW < 1 || inH < 1) throw new RangeError("render-pdfium: image has no dimensions");
      if (inW * inH > maxPixels) {
        throw new RangeError(`render-pdfium: image exceeds the pixel limit of ${maxPixels}`);
      }
      const outH = inW > width ? Math.round((inH * width) / inW) : inH;
      if (outH > maxHeight) {
        throw new RangeError(`render-pdfium: image is taller than ${maxHeight} px at this width`);
      }
      const { data, info } = await sharp(bytes, { limitInputPixels: maxPixels })
        .rotate()
        .flatten({ background: "#ffffff" })
        .resize({ width, withoutEnlargement: true })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (info.channels !== 1) {
        throw new Error(`render-pdfium: expected 1 channel of luma, got ${info.channels}`);
      }
      return {
        width: info.width,
        height: info.height,
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      };
    },

    async watermarkPdf(bytes, spec): Promise<Uint8Array> {
      const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      const font = await pdf.embedFont(StandardFonts.HelveticaBold);
      const opacity = spec.opacity ?? 0.18;
      for (const page of pdf.getPages()) {
        const { width, height } = page.getSize();
        const size = Math.max(10, Math.round(width / 38));
        const lineHeight = size * 1.35;
        const stepY = Math.max(lineHeight * spec.lines.length + size * 6, height / 3);
        const stepX = Math.max(width / 2, size * 24);
        for (let y = -height; y < height * 2; y += stepY) {
          for (let x = -width; x < width * 2; x += stepX) {
            spec.lines.forEach((line, i) => {
              page.drawText(line, {
                x,
                y: y - i * lineHeight,
                size,
                font,
                color: rgb(0, 0, 0),
                opacity,
                rotate: degrees(30),
              });
            });
          }
        }
      }
      // E3.13: the forensic token travels in the Info dictionary too. Trivially strippable
      // (deterrence + best-effort attribution); the visible `trace` line is the robust half. A
      // `/SeedHostTrace` already in the source (a re-uploaded traced copy, or a planted one) is
      // ALWAYS removed first, so it can never point a recipient's download at someone else
      // (review R1-2).
      stripTrace(pdf);
      if (spec.traceId !== undefined) {
        if (!TRACE_ID.test(spec.traceId)) {
          throw new RangeError("render-pdfium: traceId must be 8–64 lowercase hex characters");
        }
        const ctx = pdf.context;
        let info = ctx.trailerInfo.Info
          ? ctx.lookupMaybe(ctx.trailerInfo.Info, PDFDict)
          : undefined;
        if (info === undefined) {
          info = ctx.obj({});
          ctx.trailerInfo.Info = ctx.register(info);
        }
        info.set(TRACE_KEY, PDFString.of(spec.traceId));
      }
      // Write only what the document uses (fonts are embedded by flush, so prune after it).
      await pdf.flush();
      pruneUnreachable(pdf);
      return pdf.save({ useObjectStreams: false });
    },

    /**
     * Draws chart geometry (`packages/charts`) with pdf-lib and rasterises it with PDFium
     * (E2.4 contract §7, §D4). The obvious route — build an SVG and hand it to sharp — cannot
     * be used: the runtime image has no fonts, so every label would come out as a .notdef box,
     * silently, in production only (see `measureFontCoverage` above). PDFium's WASM embeds the
     * base-14 fonts, so this path needs nothing from the host.
     */
    async renderVector(ops, opts): Promise<RenderedImage> {
      if (ops.length > MAX_VECTOR_OPS) {
        throw new RangeError(`too many drawing operations: ${ops.length} > ${MAX_VECTOR_OPS}`);
      }
      const width = Math.max(16, Math.round(opts.width));
      const height = Math.max(16, Math.round(opts.height));
      const pdf = await PDFDocument.create();
      pdf.setCreationDate(STABLE_PDF_DATE);
      pdf.setModificationDate(STABLE_PDF_DATE);
      const page = pdf.addPage([width, height]);
      const fonts: Record<"regular" | "bold", PDFFont> = {
        regular: await pdf.embedFont(StandardFonts.Helvetica),
        bold: await pdf.embedFont(StandardFonts.HelveticaBold),
      };
      /*
       * **The one y flip.** `VectorOp` coordinates are top-left origin pixels (SVG's
       * convention, and what the React interpreter uses); PDF's origin is bottom-left and its
       * rotations run anticlockwise. Everything below converts here and nowhere else, so the
       * geometry package never has to know PDF exists and the two interpreters cannot drift.
       */
      const fy = (y: number): number => height - y;
      for (const op of ops) {
        switch (op.op) {
          case "rect":
            page.drawRectangle({
              x: op.x,
              y: fy(op.y + op.h),
              width: op.w,
              height: op.h,
              ...(op.fill === undefined ? {} : { color: parseColour(op.fill) }),
              ...(op.stroke === undefined
                ? {}
                : { borderColor: parseColour(op.stroke), borderWidth: op.strokeWidth ?? 1 }),
            });
            break;
          case "line":
            page.drawLine({
              start: { x: op.x1, y: fy(op.y1) },
              end: { x: op.x2, y: fy(op.y2) },
              thickness: op.strokeWidth,
              color: parseColour(op.stroke),
              ...(op.dash === undefined ? {} : { dashArray: [...op.dash] }),
            });
            break;
          case "polyline": {
            if (op.points.length === 0) break;
            // `drawSvgPath` scales y by -1 from the origin it is given, so an origin of
            // (0, height) makes an SVG path in our pixel coordinates land exactly right —
            // one primitive, real joins, and no per-segment flipping.
            const d = op.points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y}`).join(" ");
            page.drawSvgPath(d, {
              x: 0,
              y: height,
              borderColor: parseColour(op.stroke),
              borderWidth: op.strokeWidth,
              borderLineCap: LineCapStyle.Round,
            });
            break;
          }
          case "text": {
            const font = op.weight === "bold" ? fonts.bold : fonts.regular;
            const text = toWinAnsi(op.text);
            // The geometry package has no text measurement (it is pure, and the browser draws a
            // different face anyway), so the anchor is resolved here, against the font that will
            // actually draw the glyphs.
            const advance = font.widthOfTextAtSize(text, op.size);
            const dx = op.anchor === "middle" ? -advance / 2 : op.anchor === "end" ? -advance : 0;
            const angle = -(op.rotate ?? 0);
            const rad = (angle * Math.PI) / 180;
            page.drawText(text, {
              // The anchor offset runs along the *rotated* baseline, not along the page x axis.
              x: op.x + dx * Math.cos(rad),
              y: fy(op.y) + dx * Math.sin(rad),
              size: op.size,
              font,
              color: parseColour(op.fill),
              ...(angle === 0 ? {} : { rotate: degrees(angle) }),
            });
            break;
          }
        }
      }
      const bytes = await pdf.save({ useObjectStreams: false });
      // Default 2 for retina; capped so a caller cannot ask for a 40 MP bitmap.
      const scale = Math.max(0.25, Math.min(opts.scale ?? 2, Math.max(0.25, maxWidth / width)));
      const raw = await withDocument(bytes, async (doc) => {
        const rendered = await doc
          .getPage(0)
          .render({ scale, render: "bitmap", transparent: false });
        return { data: rendered.data, width: rendered.width, height: rendered.height };
      });
      return encode(
        sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }).flatten({
          background: "#ffffff",
        }),
        "png",
        DEFAULT_QUALITY,
      );
    },

    async imageToPdf(bytes, contentType): Promise<Uint8Array> {
      const pdf = await PDFDocument.create();
      let png: Uint8Array = bytes;
      if (contentType !== "image/png" && contentType !== "image/jpeg") {
        png = new Uint8Array(await sharp(bytes).rotate().png().toBuffer());
      }
      const image =
        contentType === "image/jpeg" ? await pdf.embedJpg(png) : await pdf.embedPng(png);
      const page = pdf.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      return pdf.save({ useObjectStreams: false });
    },

    async healthCheck() {
      await lib();
      // Not a formality: the watermark's font was missing in production for the whole of E1.3
      // and nothing said so. §12 C1. `apps/server` asserts this once at boot and refuses to
      // listen when it throws, so a fontless image cannot quietly serve traffic; `/readyz`
      // reports it too.
      await fonts();
    },
  };
}

type PdfiumDoc = Awaited<ReturnType<PDFiumLibrary["loadDocument"]>>;
