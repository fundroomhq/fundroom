import type { RenderedImage, VectorOp } from "@fundroom/ports";
import { PDFDocument, PDFName, rgb, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { createPdfiumRenderer, MAX_VECTOR_OPS, sniffContentType } from "./pdfium-renderer.js";

let pdf: Uint8Array;
let hostile: Uint8Array;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Confidential page ${i} runway`, { x: 60, y: 700, size: 28, font });
    page.drawRectangle({ x: 0, y: 0, width: 612, height: 100, color: rgb(1, 0, 0) });
  }
  pdf = await doc.save();
  const bad = await PDFDocument.load(pdf);
  bad.catalog.set(
    PDFName.of("OpenAction"),
    bad.context.obj({ S: "JavaScript", JS: "app.alert(1)" }),
  );
  bad.catalog.set(
    PDFName.of("Names"),
    bad.context.obj({
      JavaScript: bad.context.obj({ Names: [] }),
      EmbeddedFiles: bad.context.obj({}),
    }),
  );
  hostile = await bad.save();
});

describe("pdfium renderer", () => {
  const r = createPdfiumRenderer();

  it("sniffs, probes and counts pages", async () => {
    expect(sniffContentType(pdf)).toBe("application/pdf");
    const probe = await r.probe(pdf, "application/octet-stream");
    expect(probe).toMatchObject({ kind: "pdf", pageCount: 3 });
    expect(probe.pageSizes[0]).toEqual({ width: 612, height: 792 });
    expect(await r.probe(Buffer.from("hello"), "text/csv")).toMatchObject({ kind: "unsupported" });
  });

  it("extracts text before rendering", async () => {
    const text = await r.extractText(pdf, "pdf");
    expect(text).toHaveLength(3);
    expect(text[1]).toContain("page 2");
  });

  it("renders a page in the right colour order and honours the width", async () => {
    const page = await r.renderPage(pdf, "pdf", 1, { width: 400, format: "png" });
    expect(page.width).toBe(400);
    expect(page.contentType).toBe("image/png");
    const { data, info } = await sharp(page.bytes).raw().toBuffer({ resolveWithObject: true });
    // Bottom band is red: R high, G/B low → BGRA→RGBA swap worked.
    const y = info.height - 5;
    const px = (y * info.width + 10) * info.channels;
    expect(data[px]).toBeGreaterThan(200);
    expect(data[px + 1]).toBeLessThan(60);
    expect(data[px + 2]).toBeLessThan(60);
    await expect(r.renderPage(pdf, "pdf", 9, { width: 100 })).rejects.toThrow(RangeError);
  });

  it("watermarks images and PDFs", async () => {
    const page = await r.renderPage(pdf, "pdf", 1, { width: 600 });
    const marked = await r.watermarkImage(page, { lines: ["ada@example.com", "acme"] });
    expect(marked.width).toBe(600);
    expect(marked.bytes).not.toEqual(page.bytes);
    const out = await r.watermarkPdf(pdf, { lines: ["ada@example.com · now", "acme"] });
    const text = await r.extractText(out, "pdf");
    expect(text[0]).toContain("ada@example.com");
    expect(text[2]).toContain("acme");
  });

  it("sanitises active content and reports what it removed", async () => {
    const clean = await r.sanitizePdf(hostile);
    expect(clean.removed).toEqual(["EmbeddedFiles", "JavaScript", "OpenAction"]);
    const again = await r.sanitizePdf(clean.bytes);
    expect(again.removed).toEqual([]);
    expect(again.bytes).toBe(clean.bytes);
  });

  it("wraps images into a PDF and renders image documents", async () => {
    const png = await sharp({
      create: { width: 300, height: 200, channels: 3, background: "#00f" },
    })
      .png()
      .toBuffer();
    expect(sniffContentType(png)).toBe("image/png");
    expect(await r.probe(png, "image/png")).toMatchObject({ kind: "image", pageCount: 1 });
    const thumb = await r.renderPage(png, "image", 1, { width: 100 });
    expect(thumb.width).toBe(100);
    const wrapped = await r.imageToPdf(png, "image/png");
    expect(await r.probe(wrapped, "application/pdf")).toMatchObject({ kind: "pdf", pageCount: 1 });
  });
});

/*
 * `renderVector` (E2.4 contract §7) and the watermark font guard (§12 C1).
 *
 * The assertion that matters here is not "a PNG came out" — the failure this work package
 * exists to prevent produced a perfectly valid PNG full of empty boxes. It is that *glyphs*
 * appeared: the label band is inked, it is empty when the same ops are drawn without the text,
 * and six wide letters carry several times the ink of six narrow ones (which they cannot if
 * every glyph is the same .notdef rectangle).
 */
const CHART: VectorOp[] = [
  { op: "rect", x: 0, y: 0, w: 300, h: 150, fill: "#ffffff" },
  { op: "line", x1: 40, y1: 130, x2: 280, y2: 130, stroke: "#111111", strokeWidth: 1 },
  {
    op: "polyline",
    points: [
      [40, 110],
      [100, 70],
      [160, 90],
      [220, 60],
    ],
    stroke: "#2b6cb0",
    strokeWidth: 2,
  },
  { op: "text", x: 40, y: 20, text: "Revenue", size: 12, fill: "#000000", weight: "bold" },
];

interface Grey {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

async function grey(image: RenderedImage): Promise<Grey> {
  const out = await sharp(image.bytes).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height };
}

function inkIn(g: Grey, x0: number, y0: number, x1: number, y1: number): number {
  let ink = 0;
  for (let y = Math.max(0, y0); y < Math.min(g.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(g.width, x1); x++) {
      if ((g.data[y * g.width + x] ?? 255) < 128) ink++;
    }
  }
  return ink;
}

function inkBox(g: Grey): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = g.width;
  let y0 = g.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if ((g.data[y * g.width + x] ?? 255) >= 128) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, x1, y1 };
}

const textOp = (over: Partial<Extract<VectorOp, { op: "text" }>>): VectorOp => ({
  op: "text",
  x: 150,
  y: 75,
  text: "Hg",
  size: 20,
  fill: "#000000",
  ...over,
});

describe("renderVector", () => {
  const r = createPdfiumRenderer();
  const WHITE: VectorOp = { op: "rect", x: 0, y: 0, w: 300, h: 150, fill: "#ffffff" };

  it("rasterises at the requested scale and flattens to an opaque PNG", async () => {
    const png = await r.renderVector(CHART, { width: 300, height: 150 });
    expect(png.contentType).toBe("image/png");
    expect([png.width, png.height]).toEqual([600, 300]);
    const meta = await sharp(png.bytes).metadata();
    expect(meta.channels).toBe(3); // flattened: no alpha for a mail client to mishandle
    const one = await r.renderVector(CHART, { width: 300, height: 150, scale: 1 });
    expect([one.width, one.height]).toEqual([300, 150]);
  });

  it("is byte-identical across runs", async () => {
    const a = await r.renderVector(CHART, { width: 300, height: 150 });
    const b = await r.renderVector(CHART, { width: 300, height: 150 });
    expect(Buffer.from(b.bytes).equals(Buffer.from(a.bytes))).toBe(true);
  });

  it("draws real glyphs, not boxes", async () => {
    const withText = await grey(await r.renderVector(CHART, { width: 300, height: 150 }));
    const withoutText = await grey(
      await r.renderVector(
        CHART.filter((o) => o.op !== "text"),
        { width: 300, height: 150 },
      ),
    );
    // The band the "Revenue" baseline sits in, in device pixels at scale 2.
    const band = [70, 16, 430, 46] as const;
    expect(inkIn(withText, ...band)).toBeGreaterThan(50);
    expect(inkIn(withoutText, ...band)).toBe(0);

    // Six wide letters must carry far more ink than six narrow ones. Under a .notdef fallback
    // every glyph is the same rectangle and these two numbers are equal — which is exactly the
    // production failure §12 C1 records for the SVG path.
    const wide = await grey(
      await r.renderVector([WHITE, textOp({ text: "MMMMMM", x: 20 })], {
        width: 300,
        height: 150,
      }),
    );
    const narrow = await grey(
      await r.renderVector([WHITE, textOp({ text: "llllll", x: 20 })], {
        width: 300,
        height: 150,
      }),
    );
    const total = (g: Grey) => inkIn(g, 0, 0, g.width, g.height);
    expect(total(wide)).toBeGreaterThan(total(narrow) * 2);
  });

  it("resolves the text anchor against the font that draws the glyphs", async () => {
    const start = inkBox(
      await grey(
        await r.renderVector([WHITE, textOp({ anchor: "start" })], { width: 300, height: 150 }),
      ),
    );
    const end = inkBox(
      await grey(
        await r.renderVector([WHITE, textOp({ anchor: "end" })], { width: 300, height: 150 }),
      ),
    );
    const middle = inkBox(
      await grey(
        await r.renderVector([WHITE, textOp({ anchor: "middle" })], { width: 300, height: 150 }),
      ),
    );
    expect(start.x0).toBeGreaterThanOrEqual(300);
    expect(end.x1).toBeLessThanOrEqual(302);
    expect((middle.x0 + middle.x1) / 2).toBeGreaterThan(280);
    expect((middle.x0 + middle.x1) / 2).toBeLessThan(320);
  });

  it("rotates clockwise about the anchor point, SVG's sign", async () => {
    const upright = inkBox(
      await grey(
        await r.renderVector([WHITE, textOp({ text: "Revenue" })], { width: 300, height: 150 }),
      ),
    );
    const turned = inkBox(
      await grey(
        await r.renderVector([WHITE, textOp({ text: "Revenue", rotate: -90 })], {
          width: 300,
          height: 150,
        }),
      ),
    );
    expect(upright.x1 - upright.x0).toBeGreaterThan(upright.y1 - upright.y0);
    expect(turned.y1 - turned.y0).toBeGreaterThan(turned.x1 - turned.x0);
    // -90 in SVG reads bottom-to-top, so the glyphs climb *above* the anchor's baseline.
    expect(turned.y0).toBeLessThan(150);
  });

  it("keeps a label that Helvetica cannot encode from taking the render down", async () => {
    const png = await r.renderVector([WHITE, textOp({ text: "€1.2M → ∞" })], {
      width: 300,
      height: 150,
    });
    expect(png.width).toBe(600);
  });

  it("refuses an absurd operation list", async () => {
    const many = Array.from({ length: MAX_VECTOR_OPS + 1 }, () => WHITE);
    await expect(r.renderVector(many, { width: 300, height: 150 })).rejects.toThrow(RangeError);
  });
});

describe("healthCheck", () => {
  /** Collects the adapter's log hook so the coverage report can be read back. */
  function recording(): {
    renderer: ReturnType<typeof createPdfiumRenderer>;
    events: { event: string; fields?: Readonly<Record<string, unknown>> | undefined }[];
  } {
    const events: { event: string; fields?: Readonly<Record<string, unknown>> | undefined }[] = [];
    return {
      renderer: createPdfiumRenderer({ log: (event, fields) => events.push({ event, fields }) }),
      events,
    };
  }

  it("passes when librsvg can find a font and reports which scripts it verified", async () => {
    // Fails loudly in the distroless image without the font layer: that is the point (§12 C1).
    const { renderer, events } = recording();
    await expect(renderer.healthCheck()).resolves.toBeUndefined();
    const report = events.find((e) => e.event === "render.font_coverage");
    expect(report).toBeDefined();
    // Latin is the only script the guard *requires*; the rest are reported, not demanded,
    // because the shipped face (DejaVu Sans) has no CJK and must still enter rotation.
    expect(report?.fields?.["verified"]).toContain("latin");
    expect(report?.fields).toHaveProperty("unsupported");
  });

  it("measures the check once and remembers it", async () => {
    const { renderer, events } = recording();
    await renderer.healthCheck();
    await renderer.healthCheck();
    expect(events.filter((e) => e.event === "render.font_coverage")).toHaveLength(1);
  });

  /*
   * The guard the fontless image must fail is not "is there ink" and is not "is this font
   * proportional" either. Measured through the real probe with one face per isolated
   * fontconfig directory, the wide/narrow ink ratio the first version demanded (≥ 2) reads
   * 2.79 for DejaVu Sans and 3.51 for Noto Sans but 1.97 for DejaVu Sans Mono, 1.93 for
   * Liberation Mono and 1.97 for Nimbus Mono PS — so a monospace-only image rendered every
   * glyph correctly and never entered rotation. What the guard tests now is that "M" does not
   * draw in the same box as U+0378, an unassigned code point no font can have a glyph for;
   * that separates a drawn glyph from a .notdef box whatever the face's metrics are. Proved
   * end to end against three real distroless images in the WP report, which is the only place
   * the *failing* half can be driven — macOS always has fonts.
   */
  it("separates a real glyph from the missing-glyph box on this host", async () => {
    const { renderer, events } = recording();
    await renderer.healthCheck();
    const fields = events.find((e) => e.event === "render.font_coverage")?.fields;
    const verified = fields?.["verified"];
    const unsupported = fields?.["unsupported"];
    expect(Array.isArray(verified) && Array.isArray(unsupported)).toBe(true);
    // Every sampled script lands in exactly one of the two lists.
    expect([...(verified as string[]), ...(unsupported as string[])].sort()).toEqual(
      [
        "arabic",
        "cyrillic",
        "greek",
        "han",
        "hangul",
        "hebrew",
        "kana",
        "latin",
        "latin-supplement",
        "symbols",
      ].sort(),
    );
  });
});
