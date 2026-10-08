/**
 * Document rendering (EXECUTION_PLAN §5.2 `DocumentRenderPort`, §8, ADR-0015). The default
 * adapter `@fundroom/render-pdfium` rasterises PDF pages with PDFium (WASM), sanitises and
 * watermarks PDFs with pdf-lib and encodes/composites images with sharp; a Gotenberg /
 * LibreOffice adapter can add Office → PDF later. Everything here works on in-memory bytes:
 * the data room caps what it renders (`RENDER_MAX_BYTES`) and streams the rest.
 */
export type RenderableKind = "pdf" | "image";

export interface ProbeResult {
  readonly kind: RenderableKind | "unsupported";
  readonly pageCount: number;
  /** Points (PDF) or pixels (image) of every page, in order. */
  readonly pageSizes: readonly { readonly width: number; readonly height: number }[];
}

export interface SanitizeResult {
  readonly bytes: Uint8Array;
  /** Names of the constructs removed (`OpenAction`, `AA`, `JavaScript`, `EmbeddedFiles`, `XFA`, `Launch`). */
  readonly removed: readonly string[];
}

export interface RenderPageOptions {
  /** Target width in pixels; the adapter caps it. */
  readonly width: number;
  readonly format?: "webp" | "png" | undefined;
  readonly quality?: number | undefined;
}

export interface RenderedImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly contentType: "image/webp" | "image/png";
}

/**
 * A drawing operation, the sole currency between `packages/charts` and the two things that
 * draw a chart: the SPA (React SVG elements) and `renderVector` below (pdf-lib calls). It
 * lives here rather than in `packages/charts` so the port can name it without the port
 * depending on the geometry package (E2.4 contract §7).
 *
 * Coordinates are **top-left origin, pixels** — SVG's convention, and what a reader of the
 * React component expects. `rotate` is degrees **clockwise** about `(x, y)`, again SVG's sign;
 * PDF is bottom-left origin and rotates the other way, so the pdf-lib interpreter flips y and
 * negates the angle once, in one place, and says so there.
 *
 * `text` is Helvetica/base-14 when it reaches PDFium: the runtime image is distroless and has
 * no fonts (§D4), so nothing here may assume a family. `weight` picks Helvetica-Bold.
 */
export type VectorOp =
  | {
      readonly op: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      fill?: string | undefined;
      stroke?: string | undefined;
      strokeWidth?: number | undefined;
    }
  | {
      readonly op: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stroke: string;
      strokeWidth: number;
      dash?: readonly number[] | undefined;
    }
  | {
      readonly op: "polyline";
      points: readonly (readonly [number, number])[];
      stroke: string;
      strokeWidth: number;
    }
  | {
      readonly op: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      fill: string;
      weight?: "regular" | "bold" | undefined;
      anchor?: "start" | "middle" | "end" | undefined;
      rotate?: number | undefined;
    };

export interface WatermarkSpec {
  /** Lines burned diagonally across every page (viewer email · timestamp · workspace). */
  readonly lines: readonly string[];
  /** 0–1. Default 0.18. */
  readonly opacity?: number | undefined;
  /**
   * E3.13: the forensic mark's token (hex) of a watermarked download. `watermarkPdf` writes it to
   * the PDF Info dictionary as `/SeedHostTrace`; ignored by `watermarkImage`.
   */
  readonly traceId?: string | undefined;
}

/** E3.13: the invisible, keyed per-recipient pattern embedded into a page image. */
export interface ForensicMarkSpec {
  /** 32-byte pattern seed: `forensicSeed(patternKey, token)` from `@fundroom/forensic`. */
  readonly seed: Uint8Array;
  /** Embedding strength; the engine's tuned default when unset. */
  readonly strength?: number | undefined;
}

/** E3.13: an 8-bit luma image, row-major (`toGray`). */
export interface GrayImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export interface DocumentRenderPort {
  readonly driver: string;
  /** Sniffs bytes + declared type; `unsupported` for anything the viewer cannot show. */
  probe(bytes: Uint8Array, contentType: string): Promise<ProbeResult>;
  /** Strips active content from a PDF (design/02 §4 "PDF sanitisation"). Throws on a broken file. */
  sanitizePdf(bytes: Uint8Array): Promise<SanitizeResult>;
  /** Per-page text (search, accessibility text layer). Empty strings for pages without text. */
  extractText(bytes: Uint8Array, kind: RenderableKind): Promise<readonly string[]>;
  /** Rasterises one page (1-based). */
  renderPage(
    bytes: Uint8Array,
    kind: RenderableKind,
    pageNo: number,
    options: RenderPageOptions,
  ): Promise<RenderedImage>;
  /** Burns the watermark into an already rendered page image. */
  watermarkImage(image: RenderedImage, spec: WatermarkSpec): Promise<RenderedImage>;
  /**
   * E3.13: embeds the invisible forensic mark into an already rendered page image (decode →
   * `embedForensicMark` → re-encode in the same format/quality as `watermarkImage`). Deterministic
   * for the same image and spec. Applied before the visible watermark.
   */
  embedForensicMark(image: RenderedImage, mark: ForensicMarkSpec): Promise<RenderedImage>;
  /**
   * E3.13: decodes any image the renderer reads (png, jpeg, webp) to 8-bit luma — flattened on
   * white, EXIF-rotated, downscaled to at most `maxWidth` (default 2400). Rejects inputs over
   * RENDER_MAX_BYTES, over `maxPixels` (default 50 megapixels) or whose output would be taller
   * than `maxHeight` (default 4 × maxWidth) — the pixel and height checks read the header only,
   * before anything is decoded.
   */
  toGray(
    bytes: Uint8Array,
    contentType: string,
    options?: {
      readonly maxWidth?: number | undefined;
      readonly maxHeight?: number | undefined;
      readonly maxPixels?: number | undefined;
    },
  ): Promise<GrayImageData>;
  /** Burns the watermark into every page of a PDF (download-watermarked). */
  watermarkPdf(bytes: Uint8Array, spec: WatermarkSpec): Promise<Uint8Array>;
  /** Wraps a single image in a one-page PDF so image documents can be downloaded watermarked. */
  imageToPdf(bytes: Uint8Array, contentType: string): Promise<Uint8Array>;
  /**
   * Rasterises vector drawing operations (E2.4 charts). Goes through pdf-lib and PDFium rather
   * than an SVG because the runtime image is distroless: librsvg finds no fonts there and
   * renders every glyph as a .notdef box, silently and only in production.
   */
  renderVector(
    ops: readonly VectorOp[],
    options: {
      readonly width: number;
      readonly height: number;
      readonly scale?: number | undefined;
    },
  ): Promise<RenderedImage>;
  healthCheck(): Promise<void>;
}
