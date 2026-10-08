import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import {
  type DetectCandidate,
  detectForensicMarks,
  FORENSIC_INCONCLUSIVE_Z,
  FORENSIC_MATCH_Z,
  FORENSIC_MIN_ALIGNMENT_QUALITY,
} from "@fundroom/forensic";
import type { GrayImageData, RenderedImage } from "@fundroom/ports";
import { PDFDict, PDFDocument, PDFName, PDFString, rgb, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { createPdfiumRenderer, MAX_GRAY_PIXELS } from "./pdfium-renderer.js";

/*
 * E3.13 forensic mark through the real pipeline, exactly as the data room uses it: a PDF page is
 * rendered by PDFium at 1600 px (webp q82 — the stored unwatermarked rendition), marked for one
 * viewer (decode → engine → webp q82, the served image), optionally overlaid with a visible
 * watermark, attacked with sharp, then both images go through `toGray` and the engine.
 */

const r = createPdfiumRenderer();
const seedOf = (label: string) => new Uint8Array(createHash("sha256").update(label).digest());
const TRUE: DetectCandidate = { id: "recipient", seed: seedOf("recipient") };
const DECOYS: DetectCandidate[] = Array.from({ length: 50 }, (_, i) => ({
  id: `decoy-${i}`,
  seed: seedOf(`decoy-${i}`),
}));
const WORDS =
  "the company shall deliver revenue growth runway burn margin customer churn quarterly board investor capital equity preferred liquidation covenant warrant".split(
    " ",
  );

/** Three fixture pages: dense text, a table + bar chart, and a blank page with a heading. */
async function fixturePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let k = 7;
  const next = () => {
    k = (Math.imul(k, 1103515245) + 12345) & 0x7fffffff;
    return k;
  };
  let p = doc.addPage([612, 792]);
  p.drawText("Confidential Information Memorandum", { x: 72, y: 720, size: 18, font: bold });
  for (let line = 0; line < 42; line++) {
    let t = "";
    while (t.length < 88) t += `${WORDS[next() % WORDS.length]} `;
    p.drawText(t.trim(), { x: 72, y: 690 - line * 14, size: 10, font });
  }
  p = doc.addPage([612, 792]);
  p.drawText("Financial summary FY2026", { x: 72, y: 730, size: 16, font: bold });
  const grey = rgb(0.3, 0.3, 0.3);
  for (let row = 0; row <= 12; row++)
    p.drawLine({
      start: { x: 72, y: 700 - row * 22 },
      end: { x: 540, y: 700 - row * 22 },
      thickness: 0.6,
      color: grey,
    });
  for (let col = 0; col <= 5; col++)
    p.drawLine({
      start: { x: 72 + col * 93.6, y: 700 },
      end: { x: 72 + col * 93.6, y: 436 },
      thickness: 0.6,
      color: grey,
    });
  for (let row = 0; row < 12; row++)
    for (let col = 0; col < 5; col++)
      p.drawText(col === 0 ? `Line item ${row + 1}` : `${(next() % 99999) / 10}`, {
        x: 78 + col * 93.6,
        y: 685 - row * 22,
        size: 9,
        font,
      });
  const colours = [rgb(0.2, 0.4, 0.8), rgb(0.9, 0.5, 0.1), rgb(0.2, 0.7, 0.3)];
  p.drawLine({ start: { x: 90, y: 120 }, end: { x: 540, y: 120 }, thickness: 1 });
  p.drawLine({ start: { x: 90, y: 120 }, end: { x: 90, y: 400 }, thickness: 1 });
  for (let b = 0; b < 12; b++) {
    const colour = colours[b % 3] ?? grey;
    p.drawRectangle({
      x: 100 + b * 36,
      y: 120,
      width: 26,
      height: 40 + (next() % 230),
      color: colour,
    });
    p.drawText(`Q${(b % 4) + 1}`, { x: 104 + b * 36, y: 106, size: 8, font });
  }
  p = doc.addPage([612, 792]);
  p.drawText("Appendix C - Reserved", { x: 72, y: 720, size: 20, font: bold });
  return doc.save();
}

const OVERLAY = { lines: ["mallory@example.com · 2026-10-01 12:00 UTC", "acme · confidential"] };

type Attack = (b: Buffer) => Promise<Buffer>;
async function widthOf(b: Buffer): Promise<{ width: number; height: number }> {
  const m = await sharp(b).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0 };
}
const cropEdges =
  (l: number, t: number, rr: number, bb: number): Attack =>
  async (b) => {
    const { width, height } = await widthOf(b);
    const left = Math.round(width * l);
    const top = Math.round(height * t);
    return sharp(b)
      .extract({
        left,
        top,
        width: width - left - Math.round(width * rr),
        height: height - top - Math.round(height * bb),
      })
      .png()
      .toBuffer();
  };
const ATTACKS: Record<string, Attack> = {
  "served webp q82": async (b) => b,
  "JPEG q50": (b) => sharp(b).jpeg({ quality: 50 }).toBuffer(),
  "50 % down and up": async (b) => {
    const { width } = await widthOf(b);
    const half = await sharp(b)
      .resize({ width: Math.round(width / 2) })
      .png()
      .toBuffer();
    return sharp(half).resize({ width }).png().toBuffer();
  },
  "rescale to 1170 wide": (b) => sharp(b).resize({ width: 1170 }).png().toBuffer(),
  "rescale to 2000 wide": (b) => sharp(b).resize({ width: 2000 }).png().toBuffer(),
  "crop 5 % per edge": cropEdges(0.05, 0.05, 0.05, 0.05),
  "crop 2/5/4/1 % + 1170 wide JPEG q70": async (b) =>
    sharp(await cropEdges(0.02, 0.05, 0.04, 0.01)(b))
      .resize({ width: 1170 })
      .jpeg({ quality: 70 })
      .toBuffer(),
};
const OVERLAY_ATTACKS = [
  "served webp q82",
  "JPEG q50",
  "rescale to 1170 wide",
  "crop 5 % per edge",
];

interface Fixture {
  readonly rendition: RenderedImage;
  readonly reference: GrayImageData;
  readonly served: RenderedImage;
  readonly overlaid: RenderedImage;
}
const PAGES = ["text page", "table/chart page", "mostly blank page"] as const;
const fixtures = new Map<string, Fixture>();

beforeAll(async () => {
  const pdf = await fixturePdf();
  for (const [i, name] of PAGES.entries()) {
    const rendition = await r.renderPage(pdf, "pdf", i + 1, { width: 1600 });
    const served = await r.embedForensicMark(rendition, { seed: TRUE.seed });
    fixtures.set(name, {
      rendition,
      reference: await r.toGray(rendition.bytes, rendition.contentType, { maxWidth: 1600 }),
      served,
      overlaid: await r.watermarkImage(served, OVERLAY),
    });
  }
}, 120_000);

function fixture(name: string): Fixture {
  const f = fixtures.get(name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
}

async function detect(f: Fixture, leaked: Buffer, candidates = [...DECOYS, TRUE]) {
  const suspect = await r.toGray(new Uint8Array(leaked), "image/png", {
    maxWidth: f.reference.width,
  });
  return detectForensicMarks(f.reference, suspect, candidates);
}

function psnr(a: Uint8Array, b: Uint8Array): { psnr: number; maxDiff: number } {
  let mse = 0;
  let maxDiff = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs((a[i] as number) - (b[i] as number));
    mse += d * d;
    if (d > maxDiff) maxDiff = d;
  }
  mse /= a.length;
  return { psnr: 10 * Math.log10((255 * 255) / Math.max(mse, 1e-12)), maxDiff };
}

describe("render-pdfium embedForensicMark", () => {
  it("keeps the format, size and quality of the input, deterministically", async () => {
    const f = fixture("text page");
    expect(f.served).toMatchObject({ contentType: "image/webp", width: 1600 });
    expect(f.served.height).toBe(f.rendition.height);
    const again = await r.embedForensicMark(f.rendition, { seed: TRUE.seed });
    const [a, b] = await Promise.all([again, f.served].map((x) => sharp(x.bytes).raw().toBuffer()));
    expect(a?.equals(b as Buffer)).toBe(true);
    const png = await r.renderPage(await fixturePdf(), "pdf", 3, { width: 400, format: "png" });
    const markedPng = await r.embedForensicMark(png, { seed: TRUE.seed });
    expect(markedPng).toMatchObject({ contentType: "image/png", width: 400, height: png.height });
  });

  it.each(PAGES)("is invisible on the %s: PSNR ≥ 42 dB, blank paper ±2", async (name) => {
    // PNG in → PNG out isolates the mark from codec noise.
    const pngPage = await sharp(fixture(name).rendition.bytes).png().toBuffer();
    const image: RenderedImage = {
      bytes: new Uint8Array(pngPage),
      width: 1600,
      height: fixture(name).rendition.height,
      contentType: "image/png",
    };
    const marked = await r.embedForensicMark(image, { seed: TRUE.seed });
    const [before, after] = await Promise.all(
      [image, marked].map((x) => sharp(x.bytes).removeAlpha().raw().toBuffer()),
    );
    const all = psnr(before as Buffer, after as Buffer);
    expect(all.psnr).toBeGreaterThanOrEqual(42);
    // blank paper: rows 2–6 % from the bottom are empty on all three pages
    const rowBytes = 1600 * 3;
    const h = image.height;
    const band = (x: Buffer) =>
      x.subarray(Math.round(h * 0.94) * rowBytes, Math.round(h * 0.98) * rowBytes);
    const blank = psnr(band(before as Buffer), band(after as Buffer));
    expect(blank.maxDiff).toBeLessThanOrEqual(2);
    expect(blank.maxDiff).toBeGreaterThan(0);
  });
});

describe("forensic detection on rendered pages", () => {
  const cases: [string, string, boolean][] = [];
  for (const page of PAGES) {
    for (const attack of Object.keys(ATTACKS)) cases.push([page, attack, false]);
    for (const attack of OVERLAY_ATTACKS) cases.push([page, attack, true]);
  }

  it.each(cases)(
    "%s — %s (another viewer's visible watermark: %s)",
    async (page, attack, ovl) => {
      const f = fixture(page);
      const served = ovl ? f.overlaid : f.served;
      const leaked = await (ATTACKS[attack] as Attack)(Buffer.from(served.bytes));
      const res = await detect(f, leaked);
      expect(res.aligned.quality).toBeGreaterThanOrEqual(FORENSIC_MIN_ALIGNMENT_QUALITY);
      expect(res.scores[0]).toMatchObject({ id: TRUE.id, verdict: "match" });
      expect(res.scores[0]?.z).toBeGreaterThanOrEqual(FORENSIC_MATCH_Z);
      expect(res.scores).toHaveLength(51);
      for (const s of res.scores.slice(1)) expect(s.z).toBeLessThan(FORENSIC_INCONCLUSIVE_Z);
    },
    60_000,
  );

  it.each(PAGES)(
    "accuses nobody on the unmarked %s or one marked for an outsider",
    async (page) => {
      const f = fixture(page);
      const outsider = await r.embedForensicMark(f.rendition, { seed: seedOf("outsider") });
      const leaks = [
        Buffer.from(f.rendition.bytes),
        await sharp(f.rendition.bytes).resize({ width: 1170 }).jpeg({ quality: 60 }).toBuffer(),
        Buffer.from(outsider.bytes),
        Buffer.from((await r.watermarkImage(outsider, OVERLAY)).bytes),
      ];
      for (const leaked of leaks) {
        const res = await detect(f, leaked);
        for (const s of res.scores) expect(s.verdict).toBe("no_match");
      }
    },
    60_000,
  );
});

describe("render-pdfium toGray", () => {
  it("decodes png/jpeg/webp to luma, flattened on white and capped at maxWidth", async () => {
    const rgba = await sharp({
      create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const g = await r.toGray(new Uint8Array(rgba), "image/png");
    expect(g).toMatchObject({ width: 300, height: 200 });
    expect(g.data).toHaveLength(300 * 200);
    expect(g.data.every((v) => v === 255)).toBe(true); // transparent → white, not black
    for (const format of ["jpeg", "webp"] as const) {
      const img = await sharp({
        create: { width: 3000, height: 1000, channels: 3, background: { r: 0, g: 0, b: 0 } },
      })
        [format]()
        .toBuffer();
      const small = await r.toGray(new Uint8Array(img), `image/${format}`);
      expect(small).toMatchObject({ width: 2400, height: 800 });
      expect((small.data[0] as number) < 10).toBe(true);
      const capped = await r.toGray(new Uint8Array(img), `image/${format}`, { maxWidth: 600 });
      expect(capped.width).toBe(600);
    }
    // never enlarges
    expect((await r.toGray(new Uint8Array(rgba), "image/png", { maxWidth: 1600 })).width).toBe(300);
  });

  it("applies the EXIF orientation", async () => {
    const jpeg = await sharp({
      create: { width: 400, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const g = await r.toGray(new Uint8Array(jpeg), "image/jpeg");
    expect(g).toMatchObject({ width: 100, height: 400 });
  });

  it("rejects non-images, oversize files and decompression bombs", async () => {
    await expect(r.toGray(new TextEncoder().encode("%PDF-1.7 nope"), "image/png")).rejects.toThrow(
      RangeError,
    );
    const small = createPdfiumRenderer({ maxInputBytes: 1024 });
    const png = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    await expect(small.toGray(new Uint8Array(png), "image/png")).rejects.toThrow(RangeError);
    // a tiny PNG whose header claims more than MAX_GRAY_PIXELS: refused before decoding
    const bomb = Buffer.from(
      await sharp({
        create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .png()
        .toBuffer(),
    );
    const side = Math.ceil(Math.sqrt(MAX_GRAY_PIXELS)) + 8;
    bomb.writeUInt32BE(side, 16); // IHDR width
    bomb.writeUInt32BE(side, 20); // IHDR height
    bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
    await expect(r.toGray(new Uint8Array(bomb), "image/png")).rejects.toThrow(
      `exceeds the pixel limit of ${MAX_GRAY_PIXELS}`,
    );
  }, 60_000);

  /** A 1×1 PNG whose header claims `w × h` (the body never decodes to that). */
  async function forgedPng(w: number, h: number): Promise<Uint8Array> {
    const png = Buffer.from(
      await sharp({
        create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .png()
        .toBuffer(),
    );
    png.writeUInt32BE(w, 16);
    png.writeUInt32BE(h, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
    return new Uint8Array(png);
  }

  it("refuses tall strips and caller pixel caps from the header, before decoding (fix R1-1)", async () => {
    // review repro: 200 × 250,000 (50 MP, under the default pixel cap)
    await expect(r.toGray(await forgedPng(200, 250_000), "image/png")).rejects.toThrow(
      /taller than 9600 px/u,
    );
    await expect(
      r.toGray(await forgedPng(1600, 7000), "image/png", { maxWidth: 1600, maxHeight: 4140 }),
    ).rejects.toThrow(/taller than 4140 px/u);
    await expect(
      r.toGray(await forgedPng(4000, 4000), "image/png", { maxPixels: 4 * 1600 * 2070 }),
    ).rejects.toThrow(`exceeds the pixel limit of ${4 * 1600 * 2070}`);
    // the height check is on the OUTPUT: an 800 × 2000 photo scaled to 400 wide is 1000 tall
    const tallPhoto = await sharp({
      create: { width: 800, height: 2000, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .jpeg()
      .toBuffer();
    const g = await r.toGray(new Uint8Array(tallPhoto), "image/jpeg", {
      maxWidth: 400,
      maxHeight: 1000,
    });
    expect(g).toMatchObject({ width: 400, height: 1000 });
    await expect(
      r.toGray(new Uint8Array(tallPhoto), "image/jpeg", { maxWidth: 400, maxHeight: 999 }),
    ).rejects.toThrow(RangeError);
    // EXIF orientation is applied before the checks (100×400 rotated = 400 wide, 100 tall)
    const rotated = await sharp({
      create: { width: 400, height: 100, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    await expect(
      r.toGray(new Uint8Array(rotated), "image/jpeg", { maxHeight: 399 }),
    ).rejects.toThrow(/taller/u);
    expect((await r.toGray(new Uint8Array(rotated), "image/jpeg", { maxHeight: 400 })).height).toBe(
      400,
    );
  }, 60_000);
});

describe("render-pdfium watermarkPdf traceId", () => {
  /** A PDF that already carries `/SeedHostTrace` (a re-uploaded traced copy, or a planted one). */
  const plantedPdf = async (): Promise<Uint8Array> => {
    const doc = await PDFDocument.load(await fixturePdf());
    const ref = doc.context.trailerInfo.Info;
    const info = ref ? doc.context.lookupMaybe(ref, PDFDict) : undefined;
    info?.set(PDFName.of("SeedHostTrace"), PDFString.of("0123456789abcdef"));
    return doc.save();
  };

  it("never carries a source PDF's /SeedHostTrace into another download (fix R1-2)", async () => {
    const planted = await plantedPdf();
    expect(await traceOf(planted)).toBe("0123456789abcdef");
    expect(await traceOf(await r.watermarkPdf(planted, { lines: ["bob@example.com"] }))).toBe(
      undefined,
    );
    expect(
      await traceOf(await r.watermarkPdf(planted, { lines: ["bob"], traceId: "fedcba9876543210" })),
    ).toBe("fedcba9876543210");
    const clean = await r.sanitizePdf(planted);
    expect(clean.removed).toEqual(["SeedHostTrace"]);
    expect(await traceOf(clean.bytes)).toBe(undefined);
    expect((await r.sanitizePdf(clean.bytes)).removed).toEqual([]);
  });

  it("leaves no planted token anywhere in the bytes: orphans, other dicts, old revisions (fix RR-3)", async () => {
    const has = (b: Uint8Array, token: string) => Buffer.from(b).includes(Buffer.from(token));
    const base = async () => {
      const d = await PDFDocument.create();
      const p = d.addPage([612, 792]);
      p.drawText("hello", {
        x: 50,
        y: 700,
        size: 20,
        font: await d.embedFont(StandardFonts.Helvetica),
      });
      return d;
    };
    // (1) an unreferenced dict and (2) a key on the page dict
    const d1 = await base();
    const orphan = d1.context.obj({});
    orphan.set(PDFName.of("SeedHostTrace"), PDFString.of("1111111111111111"));
    d1.context.register(orphan);
    // an orphan carrying the token under ANOTHER key: only pruning (watermarkPdf) removes it
    const stray = d1.context.obj({});
    stray.set(PDFName.of("Keywords"), PDFString.of("trace 5555555555555555"));
    d1.context.register(stray);
    d1.getPage(0).node.set(PDFName.of("SeedHostTrace"), PDFString.of("4444444444444444"));
    const src1 = await d1.save({ useObjectStreams: false });
    // (3) an incremental update whose PREVIOUS revision's Info holds the token
    const d2 = await base();
    const info = d2.context.obj({});
    info.set(PDFName.of("SeedHostTrace"), PDFString.of("2222222222222222"));
    d2.context.trailerInfo.Info = d2.context.register(info);
    const v1 = Buffer.from(await d2.save({ useObjectStreams: false }));
    const sx = v1.lastIndexOf("startxref");
    const prevXref = Number(
      v1
        .subarray(sx + 9)
        .toString()
        .trim()
        .split(/\s+/u)[0],
    );
    const trailer = v1.subarray(v1.lastIndexOf("trailer"), sx).toString();
    const size = Number(/\/Size (\d+)/u.exec(trailer)?.[1]);
    const root = /\/Root (\d+ \d+ R)/u.exec(trailer)?.[1];
    const obj = `${size} 0 obj\n<< /Producer (x) >>\nendobj\n`;
    const xref = `xref\n${size} 1\n${String(v1.length).padStart(10, "0")} 00000 n \ntrailer\n<< /Size ${size + 1} /Root ${root} /Info ${size} 0 R /Prev ${prevXref} >>\nstartxref\n${v1.length + obj.length}\n%%EOF\n`;
    const src2 = new Uint8Array(Buffer.concat([v1, Buffer.from(obj + xref)]));
    expect(has(src1, "1111111111111111") && has(src2, "2222222222222222")).toBe(true);

    for (const [src, tokens] of [
      [src1, ["1111111111111111", "4444444444444444"]],
      [src2, ["2222222222222222"]],
    ] as const) {
      const watermarked = await r.watermarkPdf(src, { lines: ["bob@example.com"] });
      const traced = await r.watermarkPdf(src, { lines: ["bob"], traceId: "fedcba9876543210" });
      const sanitized = await r.sanitizePdf(src);
      expect(sanitized.removed).toContain("SeedHostTrace");
      for (const out of [watermarked, traced, sanitized.bytes])
        for (const token of tokens) expect(has(out, token)).toBe(false);
      for (const out of [watermarked, traced]) expect(has(out, "5555555555555555")).toBe(false);
      expect(await traceOf(traced)).toBe("fedcba9876543210");
      // still a valid, renderable document
      expect((await r.extractText(watermarked, "pdf"))[0]).toContain("hello");
      expect((await r.extractText(sanitized.bytes, "pdf"))[0]).toContain("hello");
    }
  });

  it("supports a spec whose only line is the trace line (forensic on, visible off)", async () => {
    const pdf = await fixturePdf();
    const traced = await r.watermarkPdf(pdf, {
      lines: ["trace AEBAGBAF"],
      traceId: "0102030405060708",
    });
    const text = await r.extractText(traced, "pdf");
    for (const pageText of text) expect(pageText).toContain("trace AEBAGBAF");
    expect(text[0]).not.toContain("@");
    expect(await traceOf(traced)).toBe("0102030405060708");
    const image = await r.renderPage(pdf, "pdf", 3, { width: 600 });
    const marked = await r.watermarkImage(image, { lines: ["trace AEBAGBAF"] });
    expect(marked).toMatchObject({ width: 600, contentType: "image/webp" });
    const [a, b] = await Promise.all([image, marked].map((x) => sharp(x.bytes).raw().toBuffer()));
    expect(a?.equals(b as Buffer)).toBe(false);
  });

  const traceOf = async (bytes: Uint8Array): Promise<string | undefined> => {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const ref = doc.context.trailerInfo.Info;
    const info = ref ? doc.context.lookupMaybe(ref, PDFDict) : undefined;
    const value = info?.lookupMaybe(PDFName.of("SeedHostTrace"), PDFString);
    return value?.decodeText();
  };

  it("writes the token to the Info dictionary as /SeedHostTrace", async () => {
    const pdf = await fixturePdf();
    const traced = await r.watermarkPdf(pdf, {
      lines: ["ada@example.com", "trace AEBAGBAF"],
      traceId: "0102030405060708",
    });
    expect(await traceOf(traced)).toBe("0102030405060708");
    const text = await r.extractText(traced, "pdf");
    expect(text[0]).toContain("trace AEBAGBAF");
    expect(await traceOf(await r.watermarkPdf(pdf, { lines: ["ada@example.com"] }))).toBe(
      undefined,
    );
    // a PDF without an Info dictionary at all gets one
    const bare = await PDFDocument.create();
    bare.addPage([200, 200]);
    const raw = await bare.save({ updateFieldAppearances: false });
    const bareDoc = await PDFDocument.load(raw, { updateMetadata: false });
    Reflect.deleteProperty(bareDoc.context.trailerInfo, "Info");
    const stripped = await bareDoc.save();
    expect(
      await traceOf(await r.watermarkPdf(stripped, { lines: ["x"], traceId: "abcdef0123456789" })),
    ).toBe("abcdef0123456789");
  });

  it("refuses a trace id that is not lowercase hex", async () => {
    const pdf = await fixturePdf();
    for (const traceId of ["", "xyz", "ABCDEF0123456789", "01020304) /JS (x", "0".repeat(65)])
      await expect(r.watermarkPdf(pdf, { lines: ["a"], traceId })).rejects.toThrow(RangeError);
  });
});
