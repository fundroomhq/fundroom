import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import {
  type AuditAnchor,
  assertValidCertificateDocument,
  type CertificateDocument,
  digestOf,
} from "./document.js";

/*
 * The human-readable rendering of a certificate (E2.3, design/04 §4.1, design/03:58).
 *
 * This page is evidence a lawyer will open in six years with nothing but a PDF reader, so it
 * carries every fact the canonical JSON carries, in words, plus the two audit anchors, plus a
 * plain-English paragraph saying what a click-wrap acceptance is and — design/03:58's explicit
 * requirement — what it is not.
 *
 * Only the standard 14 fonts are used. No font file is embedded, so the PDF stays a few
 * kilobytes and never depends on a font we would have to keep shipping for six years. The price
 * is WinAnsi: a name in Chinese, Greek or emoji cannot be drawn (`sanitizeForWinAnsi` replaces
 * what it cannot encode). That loss is confined to this rendering — the canonical JSON, which is
 * the artefact, keeps the exact bytes the signer typed.
 *
 * Reproducibility. `CreationDate`, `ModDate`, `Producer` and `Creator` are pinned to values
 * derived from the document itself, so nothing here reads the wall clock and two renderings of
 * one certificate come out byte-identical on this version of pdf-lib. That is **not** a
 * guarantee: pdf-lib assigns object ids in insertion order, and a pdf-lib upgrade that reorders
 * its own writes, changes its xref formatting or adds a `/ID` would change the bytes without
 * changing a single fact. It does not matter, because the PDF's digest is never the evidence —
 * `digestOf(doc)` over the canonical JSON is (ADR-0041 D2). The pinning is here so that a
 * diff of two renderings shows content changes rather than timestamps.
 *
 * Reading one of these back (in tests, or in a verifier) must pass `{ updateMetadata: false }`
 * to `PDFDocument.load`: pdf-lib's default is `true`, and it rewrites `Producer` and `ModDate`
 * on the in-memory copy the moment you open it.
 */

/** The audit anchors that are *not* already inside the document. */
export interface CertificateAnchors {
  /** The `legal.certificate_issued` event that cites this certificate's digest. */
  readonly issuance: AuditAnchor;
}

export const PDF_PRODUCER = "FundRoom clickwrap";
export const PDF_CREATOR = "FundRoom";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LABEL_WIDTH = 124;
const VALUE_WIDTH = CONTENT_WIDTH - LABEL_WIDTH;

const TITLE_SIZE = 17;
const HEADING_SIZE = 11;
const BODY_SIZE = 9.5;
const LABEL_SIZE = 8.5;
const MONO_SIZE = 8;
const LINE_RATIO = 1.34;

const INK = rgb(0.08, 0.09, 0.11);
const MUTED = rgb(0.42, 0.44, 0.48);
const RULE = rgb(0.82, 0.83, 0.85);

/**
 * WinAnsi covers ASCII, Latin-1's printable half and the CP1252 additions at 0x80-0x9F. The C0
 * controls, DEL and the raw C1 range are not encodable — `assertValidCertificateDocument`
 * already rejects those — and neither is anything above U+00FF except the CP1252 additions.
 */
const CP1252_EXTRAS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const CP1252_EXTRA_SET = new Set([...CP1252_EXTRAS]);

/** Replaces every character the standard fonts cannot draw. Never throws. */
export function sanitizeForWinAnsi(value: string, replacement = "?"): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || CP1252_EXTRA_SET.has(ch)) {
      out += ch;
    } else {
      out += replacement;
    }
  }
  return out;
}

/** Greedy wrap; a word longer than the column (a 64-char digest) is broken by character. */
export function wrapText(
  value: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): readonly string[] {
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line.length > 0) lines.push(line);
    line = "";
  };
  const pushWord = (word: string) => {
    const candidate = line.length === 0 ? word : `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      return;
    }
    flush();
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      line = word;
      return;
    }
    for (const ch of word) {
      if (font.widthOfTextAtSize(line + ch, size) > maxWidth) flush();
      line += ch;
    }
  };
  for (const word of value.split(/\s+/u)) {
    if (word.length > 0) pushWord(word);
  }
  flush();
  return lines.length > 0 ? lines : [""];
}

interface Fonts {
  readonly body: PDFFont;
  readonly bold: PDFFont;
  readonly mono: PDFFont;
}

/** A cursor that flows down the page and starts a new one when it runs out of room. */
class Sheet {
  private page: PDFPage;
  private y: number;

  constructor(
    private readonly pdf: PDFDocument,
    private readonly fonts: Fonts,
  ) {
    this.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private room(height: number): void {
    if (this.y - height >= MARGIN) return;
    this.page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  gap(height: number): void {
    this.y -= height;
  }

  rule(): void {
    this.room(8);
    this.y -= 6;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + CONTENT_WIDTH, y: this.y },
      thickness: 0.5,
      color: RULE,
    });
    this.y -= 10;
  }

  title(value: string): void {
    this.paragraph(value, { font: this.fonts.bold, size: TITLE_SIZE, color: INK });
  }

  heading(value: string): void {
    this.gap(6);
    this.paragraph(value, { font: this.fonts.bold, size: HEADING_SIZE, color: INK });
    this.gap(2);
  }

  paragraph(
    value: string,
    options: { font?: PDFFont; size?: number; color?: typeof INK; width?: number } = {},
  ): void {
    const font = options.font ?? this.fonts.body;
    const size = options.size ?? BODY_SIZE;
    const color = options.color ?? INK;
    const width = options.width ?? CONTENT_WIDTH;
    const height = size * LINE_RATIO;
    for (const line of wrapText(sanitizeForWinAnsi(value), font, size, width)) {
      this.room(height);
      this.y -= height;
      this.page.drawText(line, { x: MARGIN, y: this.y, size, font, color });
    }
    this.gap(2);
  }

  /** A label/value row; `mono` is for digests and ids, which must be transcribable. */
  field(label: string, value: string, mono = false): void {
    const font = mono ? this.fonts.mono : this.fonts.body;
    const size = mono ? MONO_SIZE : BODY_SIZE;
    const lines = wrapText(sanitizeForWinAnsi(value), font, size, VALUE_WIDTH);
    const height = Math.max(BODY_SIZE, size) * LINE_RATIO;
    this.room(height * lines.length);
    let first = true;
    for (const line of lines) {
      this.y -= height;
      if (first) {
        this.page.drawText(sanitizeForWinAnsi(label), {
          x: MARGIN,
          y: this.y,
          size: LABEL_SIZE,
          font: this.fonts.body,
          color: MUTED,
        });
        first = false;
      }
      this.page.drawText(line, {
        x: MARGIN + LABEL_WIDTH,
        y: this.y,
        size,
        font,
        color: INK,
      });
    }
    this.gap(2);
  }
}

const NONE = "(not recorded)";

/**
 * Renders the certificate. PURE with respect to the clock: every byte is a function of `doc`
 * and `anchors`.
 */
export async function renderCertificatePdf(
  doc: CertificateDocument,
  anchors: CertificateAnchors,
): Promise<Uint8Array> {
  const d = assertValidCertificateDocument(doc);
  const certificateSha256 = digestOf(d);
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    body: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const sheet = new Sheet(pdf, fonts);

  sheet.title("Click-wrap acceptance certificate");
  sheet.paragraph(`${d.workspace.name} - ${d.workspace.host}`, { color: MUTED });
  sheet.rule();

  sheet.heading("Signer");
  sheet.field("Name", d.signer.displayName ?? NONE);
  sheet.field("Typed name", d.signer.typedName ?? "(none requested)");
  sheet.field("Membership id", d.signer.membershipId, true);
  sheet.field("Email sha256", d.signer.emailSha256, true);

  sheet.heading("Document accepted");
  sheet.field("Title", d.document.title);
  sheet.field("Version", `v${d.document.versionNo} (${d.document.stamp})`);
  sheet.field("Body sha256", d.document.bodySha256, true);

  sheet.heading("Acceptance");
  sheet.field("Accepted at (UTC)", d.acceptance.acceptedAt, true);
  sheet.field("Method", "click-wrap: an unticked box ticked, then a labelled button pressed");
  sheet.field("Browser family", d.acceptance.uaFamily ?? NONE);
  sheet.field("Network (keyed hash)", d.acceptance.ipHash ?? NONE, true);
  sheet.field("Via share link", d.acceptance.viaLinkId ?? "(none - signed in directly)", true);

  sheet.heading("Integrity");
  sheet.field("Certificate id", d.certificateId, true);
  sheet.field("Certificate sha256", certificateSha256, true);
  sheet.field("Acceptance event", `#${d.anchor.auditSeq}`, true);
  sheet.field("Acceptance hash", d.anchor.auditHash, true);
  sheet.field("Issuance event", `#${anchors.issuance.auditSeq}`, true);
  sheet.field("Issuance hash", anchors.issuance.auditHash, true);
  sheet.rule();

  sheet.heading("What this certificate records");
  sheet.paragraph(
    "It records that the person identified above was shown the exact text whose sha256 is " +
      "printed above, and then took a deliberate affirmative action to accept it: ticking a box " +
      "that was not pre-ticked and pressing a button labelled with the agreement. The timestamp " +
      "is the server's, in UTC. The email address behind the acceptance had been verified by a " +
      "one-time code before the acceptance was possible.",
  );
  sheet.paragraph(
    "Under US ESIGN and UETA, and under EU eIDAS as a simple electronic signature (SES), an " +
      "acceptance of this kind is admissible and generally enforceable for commercial " +
      "agreements such as a non-disclosure agreement.",
  );

  sheet.heading("What this certificate is not");
  sheet.paragraph(
    "A click-wrap acceptance is not a signed NDA. It is not a handwritten signature, not an " +
      "advanced or qualified electronic signature (eIDAS AdES or QES), and not a notarised or " +
      "witnessed deed. It does not prove who was physically at the keyboard: it proves that an " +
      "authenticated session belonging to the membership identified above performed the " +
      "acceptance at the time recorded. Some instruments, in some jurisdictions, require more " +
      "than this, and where a counter-signed agreement is required this document is not a " +
      "substitute for one.",
  );
  sheet.paragraph(
    "It does not record consent to do business electronically. That consent is captured " +
      "separately, per subject, and is not part of this certificate.",
  );

  sheet.heading("How to verify this copy");
  sheet.paragraph(
    "The canonical artefact is the JSON certificate, not this PDF. This page is a rendering of " +
      "it and can be regenerated from that JSON together with the issuance event named above. " +
      "To verify: take the stored canonical JSON, compute sha256 over its UTF-8 bytes, and " +
      `check that it equals the certificate sha256 above. Then check that audit event #${anchors.issuance.auditSeq} ` +
      "in this workspace's hash-chained audit log carries that same digest, and that audit " +
      `event #${d.anchor.auditSeq} is the acceptance this certificate describes. The two events sit ` +
      "in one append-only chain, so neither can be moved, removed or back-dated without " +
      "breaking every hash after it.",
  );

  pdf.setTitle(sanitizeForWinAnsi(`Click-wrap acceptance certificate ${d.certificateId}`));
  pdf.setSubject(sanitizeForWinAnsi(`${d.document.title} v${d.document.versionNo}`));
  pdf.setProducer(PDF_PRODUCER);
  pdf.setCreator(PDF_CREATOR);
  pdf.setLanguage("en-GB");
  // Pinned to the acceptance instant, not `new Date()`: the only clock this file reads is the
  // one already inside the document.
  const stampedAt = new Date(`${d.acceptance.acceptedAt.slice(0, 23)}Z`);
  pdf.setCreationDate(stampedAt);
  pdf.setModificationDate(stampedAt);

  return pdf.save({ useObjectStreams: false });
}
