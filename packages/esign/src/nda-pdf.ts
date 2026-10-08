import { sanitizeForWinAnsi, wrapText } from "@fundroom/clickwrap";
import type { ESignField } from "@fundroom/ports";
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import { ESignError } from "./errors.js";

/*
 * The NDA a member signs through a vendor (E3.5 contract §4 "NDA ceremony").
 *
 * The current legal-document version (Markdown) is rendered to a plain, paginated A4 PDF: title,
 * version line, body text wrapped, and a FINAL page that holds nothing but the signature block.
 * The signature block's boxes are at fixed positions on that page, and the same numbers are
 * returned as `ESignField`s (fractions of the page, origin top-left, 1-based page) for signer
 * `s1`, so the vendor places its signature, name and date fields exactly on the drawn boxes.
 *
 * Fonts: the standard 14 only (Helvetica family), never embedded. The runtime image has no
 * fonts at all (E2.4 lesson), and a base-14 font needs none. The price is WinAnsi — and a signed
 * PDF that silently differs from the legal text is worse than no PDF, so a title or body holding a
 * character the standard fonts cannot draw (Greek, Cyrillic, CJK, emoji, arrows, …) is REFUSED
 * (`ndaTextProblem`, 422 `esign_nda_text_unsupported`; E3.5 fix A15), never replaced. Only the
 * decoration around the text degrades: a workspace or signer name that cannot be drawn is left
 * out of the header / signature line rather than printed with `?`s. The document's digest that
 * matters is the stored version's `body_sha256`, which the envelope row names and the PDF prints.
 *
 * Markdown handling is deliberately small: headings become bold lines, list markers become
 * bullets, emphasis/code markers are dropped, links keep their text and URL. Legal templates are
 * prose; anything fancier would be a renderer to maintain for six years.
 */

export const NDA_PAGE_WIDTH = 595.28;
export const NDA_PAGE_HEIGHT = 841.89;
const MARGIN = 64;
const CONTENT_WIDTH = NDA_PAGE_WIDTH - MARGIN * 2;
const TITLE_SIZE = 18;
const META_SIZE = 9;
const HEADING_SIZE = 12;
const BODY_SIZE = 10.5;
const LINE_RATIO = 1.4;
const INK = rgb(0.08, 0.09, 0.11);
const MUTED = rgb(0.42, 0.44, 0.48);
const BOX = rgb(0.55, 0.57, 0.6);

/** The signature block on the last page, in points from the page's TOP-left corner. */
export const NDA_SIGNATURE_BOXES = {
  signature: { x: MARGIN, top: 250, w: 280, h: 64 },
  name: { x: MARGIN, top: 360, w: 280, h: 26 },
  date: { x: MARGIN + 310, top: 360, w: 150, h: 26 },
} as const;

export interface NdaPdfInput {
  readonly title: string;
  readonly versionNo: number;
  /** Markdown body of the version. */
  readonly body: string;
  /** Hex sha256 of the stored body (printed so the paper copy names the version it renders). */
  readonly bodySha256: string;
  /** Workspace display name, for the header line. */
  readonly workspaceName: string;
  readonly signerName: string;
  /** Pins the PDF's dates (reproducible output); normally the envelope's creation time. */
  readonly renderedAt: Date;
}

export interface NdaPdf {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /** Signature, name and date fields for signer `s1` on the last page. */
  readonly fields: readonly ESignField[];
}

/** Whitespace is reflowed by the renderer (wrapping), so it never counts as altered text. */
const WHITESPACE = /\s/u;

/**
 * The distinct characters of `text` the base-14 fonts cannot draw (WinAnsi), in first-seen order,
 * at most `limit`. Empty means the text renders exactly.
 */
export function winAnsiUnsupported(text: string, limit = 10): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ch of text) {
    if (seen.has(ch) || WHITESPACE.test(ch)) continue;
    seen.add(ch);
    if (sanitizeForWinAnsi(ch, "") === "") {
      out.push(ch);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface NdaTextProblem {
  readonly field: "title" | "body";
  /** Up to ten distinct characters that cannot be drawn. */
  readonly characters: readonly string[];
}

/**
 * Whether an NDA's title and body can be rendered to the e-sign PDF WITHOUT altering them. The
 * kernel refuses to start an e-sign NDA otherwise, and the compliance routes refuse to set the
 * `esign` ceremony on such a document version (FXB, B4). `undefined` = fine.
 */
export function ndaTextProblem(input: {
  readonly title: string;
  readonly body: string;
}): NdaTextProblem | undefined {
  const inTitle = winAnsiUnsupported(input.title);
  if (inTitle.length > 0) return { field: "title", characters: inTitle };
  const inBody = winAnsiUnsupported(input.body);
  if (inBody.length > 0) return { field: "body", characters: inBody };
  return undefined;
}

/** Throws 422 `esign_nda_text_unsupported` when `ndaTextProblem` finds something. */
export function assertNdaTextRenderable(input: {
  readonly title: string;
  readonly body: string;
}): void {
  const problem = ndaTextProblem(input);
  if (problem === undefined) return;
  throw new ESignError(
    "esign_nda_text_unsupported",
    `the NDA ${problem.field} has characters the e-signature PDF cannot show; it cannot be signed electronically as written`,
    { reason: "unsupported_characters", field: problem.field, characters: [...problem.characters] },
  );
}

/** A name for decoration: kept only when it renders exactly (else omitted, never `?`-mangled). */
function drawable(name: string): string | undefined {
  const t = name.trim();
  return t !== "" && winAnsiUnsupported(t, 1).length === 0 ? t : undefined;
}

interface Block {
  readonly kind: "heading" | "paragraph" | "bullet";
  readonly text: string;
}

/** Markdown → blocks of plain text (see the header for what is and is not kept). */
export function markdownBlocks(markdown: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length > 0) out.push({ kind: "paragraph", text: inline(para.join(" ")) });
    para = [];
  };
  for (const raw of markdown.replace(/\r\n?/gu, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "" || /^(-{3,}|\*{3,}|_{3,})$/u.test(line)) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/u.exec(line);
    if (heading !== null) {
      flush();
      out.push({ kind: "heading", text: inline(heading[1] ?? "") });
      continue;
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(line);
    if (bullet !== null) {
      flush();
      const marker = /^\d+[.)]/u.exec(line)?.[0];
      out.push({
        kind: "bullet",
        text: `${marker === undefined ? "•" : marker} ${inline(bullet[1] ?? "")}`,
      });
      continue;
    }
    para.push(line.replace(/^>\s?/u, ""));
  }
  flush();
  return out.filter((b) => b.text.length > 0);
}

function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/gu, "$1 ($2)")
    .replace(/(\*\*|__)(.+?)\1/gu, "$2")
    .replace(/(\*|_)(.+?)\1/gu, "$2")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Field geometry as fractions of the page (top-left origin), rounded to 1e-4. */
export function ndaSignatureFields(page: number): ESignField[] {
  const frac = (v: number, of: number) => Math.round((v / of) * 10_000) / 10_000;
  const field = (
    kind: ESignField["kind"],
    b: { x: number; top: number; w: number; h: number },
  ) => ({
    signerKey: "s1",
    kind,
    page,
    x: frac(b.x, NDA_PAGE_WIDTH),
    y: frac(b.top, NDA_PAGE_HEIGHT),
    w: frac(b.w, NDA_PAGE_WIDTH),
    h: frac(b.h, NDA_PAGE_HEIGHT),
  });
  return [
    field("signature", NDA_SIGNATURE_BOXES.signature),
    field("name", NDA_SIGNATURE_BOXES.name),
    field("date", NDA_SIGNATURE_BOXES.date),
  ];
}

class Writer {
  page: PDFPage;
  y: number;
  constructor(
    private readonly pdf: PDFDocument,
    private readonly fonts: { regular: PDFFont; bold: PDFFont },
  ) {
    this.page = pdf.addPage([NDA_PAGE_WIDTH, NDA_PAGE_HEIGHT]);
    this.y = NDA_PAGE_HEIGHT - MARGIN;
  }

  private ensure(height: number): void {
    if (this.y - height < MARGIN) {
      this.page = this.pdf.addPage([NDA_PAGE_WIDTH, NDA_PAGE_HEIGHT]);
      this.y = NDA_PAGE_HEIGHT - MARGIN;
    }
  }

  lines(text: string, size: number, bold = false, color = INK, indent = 0): void {
    const font = bold ? this.fonts.bold : this.fonts.regular;
    const safe = sanitizeForWinAnsi(text);
    const lead = size * LINE_RATIO;
    for (const line of wrapText(safe, font, size, CONTENT_WIDTH - indent)) {
      this.ensure(lead);
      this.y -= lead;
      this.page.drawText(line, { x: MARGIN + indent, y: this.y, size, font, color });
    }
  }

  gap(points: number): void {
    this.y -= points;
  }
}

export async function renderNdaPdf(input: NdaPdfInput): Promise<NdaPdf> {
  assertNdaTextRenderable({ title: input.title, body: input.body });
  const workspaceName = drawable(input.workspaceName);
  const signerName = drawable(input.signerName);
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(pdf, { regular, bold });

  w.lines(input.title, TITLE_SIZE, true);
  w.gap(4);
  w.lines(
    workspaceName === undefined
      ? `Version ${input.versionNo}`
      : `${workspaceName} · version ${input.versionNo}`,
    META_SIZE,
    false,
    MUTED,
  );
  w.lines(`Text sha256 ${input.bodySha256}`, META_SIZE - 1, false, MUTED);
  w.gap(14);
  for (const block of markdownBlocks(input.body)) {
    if (block.kind === "heading") {
      w.gap(6);
      w.lines(block.text, HEADING_SIZE, true);
      w.gap(2);
    } else if (block.kind === "bullet") {
      w.lines(block.text, BODY_SIZE, false, INK, 12);
      w.gap(2);
    } else {
      w.lines(block.text, BODY_SIZE, false);
      w.gap(8);
    }
  }

  // The signature page: always its own, last page, so the boxes are at known coordinates.
  const sig = pdf.addPage([NDA_PAGE_WIDTH, NDA_PAGE_HEIGHT]);
  const topY = (top: number, h = 0) => NDA_PAGE_HEIGHT - top - h;
  sig.drawText(sanitizeForWinAnsi("Signature"), {
    x: MARGIN,
    y: topY(MARGIN + TITLE_SIZE),
    size: TITLE_SIZE,
    font: bold,
    color: INK,
  });
  const intro = wrapText(
    sanitizeForWinAnsi(
      `By signing below, ${signerName ?? "the signer"} agrees to "${input.title}" (version ${input.versionNo}) as set out on the preceding pages.`,
    ),
    regular,
    BODY_SIZE,
    CONTENT_WIDTH,
  );
  intro.forEach((line, i) => {
    sig.drawText(line, {
      x: MARGIN,
      y: topY(MARGIN + TITLE_SIZE + 28 + i * BODY_SIZE * LINE_RATIO),
      size: BODY_SIZE,
      font: regular,
      color: INK,
    });
  });
  const labelled = (label: string, b: { x: number; top: number; w: number; h: number }) => {
    sig.drawRectangle({
      x: b.x,
      y: topY(b.top, b.h),
      width: b.w,
      height: b.h,
      borderColor: BOX,
      borderWidth: 0.75,
    });
    sig.drawText(label, {
      x: b.x,
      y: topY(b.top, b.h) - META_SIZE - 3,
      size: META_SIZE,
      font: regular,
      color: MUTED,
    });
  };
  labelled("Signature", NDA_SIGNATURE_BOXES.signature);
  labelled("Full name", NDA_SIGNATURE_BOXES.name);
  labelled("Date", NDA_SIGNATURE_BOXES.date);

  pdf.setTitle(sanitizeForWinAnsi(input.title));
  pdf.setProducer("FundRoom esign");
  pdf.setCreator("FundRoom");
  pdf.setCreationDate(input.renderedAt);
  pdf.setModificationDate(input.renderedAt);
  const bytes = await pdf.save({ useObjectStreams: false });
  const pageCount = pdf.getPageCount();
  return { bytes, pageCount, fields: ndaSignatureFields(pageCount) };
}
