import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  consentData,
  ESIGN_CONSENT_KIND,
  ESIGN_DISCLOSURE_SHA256,
  ESIGN_DISCLOSURE_TEXT,
  ESIGN_DISCLOSURE_VERSION,
} from "./consent.js";
import {
  markdownBlocks,
  NDA_PAGE_HEIGHT,
  NDA_PAGE_WIDTH,
  NDA_SIGNATURE_BOXES,
  ndaSignatureFields,
  ndaTextProblem,
  renderNdaPdf,
  winAnsiUnsupported,
} from "./nda-pdf.js";

/** The text a content stream draws (pdf-lib writes `<hex> Tj`). */
function drawnText(ops: string): string {
  return [...ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/gu)]
    .map((m) => Buffer.from(m[1] ?? "", "hex").toString("latin1"))
    .join("\n");
}

const BODY = [
  "# Mutual NDA",
  "",
  "This **Agreement** is made between the *Company* and the recipient. See [terms](https://example.com/t).",
  "",
  "## 1. Confidential information",
  "",
  "- first point",
  "- second point with `code`",
  "1. numbered",
  "",
  `${"Long paragraph text that keeps going. ".repeat(200)}`,
  "",
  "Ünïcödé — “quotes” and a € sign: WinAnsi, drawn exactly.",
].join("\n");

async function contentOf(pdf: PDFDocument, pageIndex: number): Promise<string> {
  const page = pdf.getPage(pageIndex);
  const contents = page.node.get(PDFName.of("Contents"));
  const refs =
    contents === undefined
      ? []
      : "asArray" in contents
        ? (contents as { asArray(): unknown[] }).asArray()
        : [contents];
  let out = "";
  for (const ref of refs) {
    const stream = pdf.context.lookup(ref as never);
    if (stream instanceof PDFRawStream) {
      const bytes = stream.getContents();
      const filter = stream.dict.get(PDFName.of("Filter"));
      out += Buffer.from(filter === undefined ? bytes : inflateSync(bytes)).toString("latin1");
    }
  }
  return out;
}

/** Rectangles pdf-lib strokes: a translation followed by a closed 4-point path. */
function rects(ops: string): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  const re =
    /1 0 0 1 ([\d.]+) ([\d.]+) cm\n(?:1 0 0 1 0 0 cm\n)*0 0 m\n0 ([\d.]+) l\n([\d.]+) [\d.]+ l\n[\d.]+ 0 l\nh\nS/gu;
  for (const m of ops.matchAll(re)) {
    out.push({ x: Number(m[1]), y: Number(m[2]), h: Number(m[3]), w: Number(m[4]) });
  }
  return out;
}

describe("NDA PDF", () => {
  it("renders a parseable multi-page PDF with base-14 fonts only", async () => {
    const out = await renderNdaPdf({
      title: "Mutual NDA",
      versionNo: 3,
      body: BODY,
      bodySha256: "ab".repeat(32),
      workspaceName: "Acme Robotics",
      signerName: "Ada Lovelace",
      renderedAt: new Date("2026-09-25T00:00:00Z"),
    });
    expect(Buffer.from(out.bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    const pdf = await PDFDocument.load(out.bytes, { updateMetadata: false });
    expect(pdf.getPageCount()).toBe(out.pageCount);
    expect(out.pageCount).toBeGreaterThanOrEqual(3); // long body spills + signature page
    const raw = Buffer.from(out.bytes).toString("latin1");
    expect(raw).toContain("/BaseFont /Helvetica");
    expect(raw).not.toContain("/FontFile");
    expect(pdf.getTitle()).toBe("Mutual NDA");
  });

  it("returns signature/name/date fields for s1 on the last page matching the drawn boxes", async () => {
    const out = await renderNdaPdf({
      title: "NDA",
      versionNo: 1,
      body: "Short.",
      bodySha256: "00".repeat(32),
      workspaceName: "W",
      signerName: "S",
      renderedAt: new Date("2026-09-25T00:00:00Z"),
    });
    expect(out.pageCount).toBe(2);
    expect(out.fields.map((f) => [f.kind, f.signerKey, f.page])).toEqual([
      ["signature", "s1", 2],
      ["name", "s1", 2],
      ["date", "s1", 2],
    ]);
    const pdf = await PDFDocument.load(out.bytes, { updateMetadata: false });
    const last = pdf.getPage(out.pageCount - 1);
    expect(last.getWidth()).toBeCloseTo(NDA_PAGE_WIDTH, 2);
    expect(last.getHeight()).toBeCloseTo(NDA_PAGE_HEIGHT, 2);
    const ops = await contentOf(pdf, out.pageCount - 1);
    expect(rects(ops)).toHaveLength(3);
    for (const f of out.fields) {
      const box = NDA_SIGNATURE_BOXES[f.kind];
      // Fractions → points (top-left origin) → PDF user space (bottom-left origin).
      const x = f.x * NDA_PAGE_WIDTH;
      const w = f.w * NDA_PAGE_WIDTH;
      const h = f.h * NDA_PAGE_HEIGHT;
      const yBottom = NDA_PAGE_HEIGHT - f.y * NDA_PAGE_HEIGHT - h;
      expect(x).toBeCloseTo(box.x, 0);
      expect(w).toBeCloseTo(box.w, 0);
      expect(h).toBeCloseTo(box.h, 0);
      // The box is stroked on the page: `1 0 0 1 x y cm … 0 0 m 0 h l w h l w 0 l h S`.
      const drawn = rects(ops).find(
        (r) =>
          Math.abs(r.x - box.x) < 0.01 &&
          Math.abs(r.w - box.w) < 0.01 &&
          Math.abs(r.h - box.h) < 0.01,
      );
      expect(drawn).toBeDefined();
      expect(drawn?.y).toBeCloseTo(NDA_PAGE_HEIGHT - box.top - box.h, 2);
      expect(yBottom).toBeCloseTo(NDA_PAGE_HEIGHT - box.top - box.h, 0);
    }
    // Every field fits inside the page.
    for (const f of out.fields) {
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(1);
      expect(f.y + f.h).toBeLessThanOrEqual(1);
    }
  });

  it("A15: refuses a title or body the base-14 fonts cannot draw — never signs altered text", async () => {
    const base = {
      versionNo: 1,
      bodySha256: "00".repeat(32),
      workspaceName: "W",
      signerName: "S",
      renderedAt: new Date("2026-09-25T00:00:00Z"),
    };
    for (const [title, body, field, chars] of [
      ["NDA", "Keep it secret. Ευχαριστώ.", "body", ["Ε", "υ", "χ"]],
      ["NDA", "Emoji 🚀 and 中文.", "body", ["🚀", "中", "文"]],
      ["Соглашение", "Body.", "title", ["С", "о", "г"]],
      ["NDA", "An arrow → here.", "body", ["→"]],
    ] as const) {
      const problem = ndaTextProblem({ title, body });
      expect(problem?.field).toBe(field);
      expect(problem?.characters.slice(0, chars.length)).toEqual([...chars]);
      await expect(renderNdaPdf({ ...base, title, body })).rejects.toMatchObject({
        code: "esign_nda_text_unsupported",
        details: { reason: "unsupported_characters", field },
      });
    }
    expect(ndaTextProblem({ title: "Mutual NDA", body: BODY })).toBeUndefined();
    expect(winAnsiUnsupported("tabs\tand\nnewlines, “smart” quotes — €")).toEqual([]);
    expect(winAnsiUnsupported("ααααβ")).toEqual(["α", "β"]);
  });

  it("A15: a signer or workspace name it cannot draw is left out, not printed as ???", async () => {
    const out = await renderNdaPdf({
      title: "NDA",
      versionNo: 1,
      body: "Short.",
      bodySha256: "00".repeat(32),
      workspaceName: "東京 Robotics",
      signerName: "山田太郎",
      renderedAt: new Date("2026-09-25T00:00:00Z"),
    });
    const pdf = await PDFDocument.load(out.bytes, { updateMetadata: false });
    const sig = drawnText(await contentOf(pdf, out.pageCount - 1));
    const first = drawnText(await contentOf(pdf, 0));
    expect(first).toContain("Version 1");
    expect(sig).toContain("the signer agrees");
    expect(`${sig}${first}`).not.toContain("?");
  });

  it("computes fields for whatever page is last", () => {
    expect(ndaSignatureFields(7).every((f) => f.page === 7)).toBe(true);
  });

  it("reduces Markdown to headings, bullets and paragraphs", () => {
    const blocks = markdownBlocks(BODY);
    expect(blocks[0]).toEqual({ kind: "heading", text: "Mutual NDA" });
    expect(blocks[1]).toEqual({
      kind: "paragraph",
      text: "This Agreement is made between the Company and the recipient. See terms (https://example.com/t).",
    });
    expect(blocks[2]).toEqual({ kind: "heading", text: "1. Confidential information" });
    expect(blocks[3]).toEqual({ kind: "bullet", text: "• first point" });
    expect(blocks[4]).toEqual({ kind: "bullet", text: "• second point with code" });
    expect(blocks[5]).toEqual({ kind: "bullet", text: "1. numbered" });
  });
});

describe("ESIGN consent disclosure", () => {
  it("has a stable sha256 of the English canonical text", () => {
    expect(ESIGN_DISCLOSURE_SHA256).toBe(
      createHash("sha256").update(ESIGN_DISCLOSURE_TEXT, "utf8").digest("hex"),
    );
    // Pinned: changing the text must come with a version bump (and this pin).
    expect(ESIGN_DISCLOSURE_VERSION).toBe(1);
    expect(ESIGN_DISCLOSURE_SHA256).toMatchInlineSnapshot(
      `"231554b511a939684f0b01e012a4402627ab4d00877e8bd9f4ec17a7fd7bd138"`,
    );
  });

  it("names its attestation kind by version and records version + digest", () => {
    expect(ESIGN_CONSENT_KIND).toBe("esign-consent:v1");
    expect(consentData()).toEqual({
      disclosureVersion: 1,
      disclosureSha256: ESIGN_DISCLOSURE_SHA256,
    });
  });
});
