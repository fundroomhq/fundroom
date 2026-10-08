import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream, type PDFRef } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { assertValidCertificateDocument, type CertificateDocument, digestOf } from "./document.js";
import { PDF_CREATOR, PDF_PRODUCER, renderCertificatePdf, sanitizeForWinAnsi } from "./pdf.js";

const DOC: CertificateDocument = {
  version: 1,
  certificateId: "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a5b",
  workspace: {
    id: "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a01",
    name: "Northwind Ventures",
    host: "invest.northwind.example",
  },
  signer: {
    membershipId: "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a02",
    emailSha256: "b".repeat(64),
    displayName: "Ada Lovelace",
    typedName: "Ada B. Lovelace",
  },
  document: {
    documentId: "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a03",
    slug: "nda",
    title: "Mutual non-disclosure agreement",
    versionNo: 3,
    stamp: "nda:v3",
    bodySha256: "c".repeat(64),
  },
  acceptance: {
    acceptedAt: "2026-09-14T10:11:12.000000Z",
    method: "clickwrap",
    uaFamily: "firefox",
    ipHash: "d".repeat(64),
    viaLinkId: "0192b3c4-5d6e-7f80-8a9b-0c1d2e3f4a04",
  },
  anchor: { auditSeq: 42, auditHash: "e".repeat(64) },
};

const ANCHORS = { issuance: { auditSeq: 43, auditHash: "f".repeat(64) } };

/**
 * Reads the drawn strings back out of the page content streams. `updateMetadata: false` is not
 * optional: pdf-lib's `load` defaults to rewriting `Producer` and `ModDate` on the copy it hands
 * back, so a reader that omits it silently destroys what it came to inspect.
 */
async function extract(bytes: Uint8Array): Promise<{
  readonly text: string;
  /** Every drawn line joined by single spaces, so an assertion can span a wrap. */
  readonly flat: string;
  readonly lines: readonly string[];
  readonly pdf: PDFDocument;
}> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const lines: string[] = [];
  for (const page of pdf.getPages()) {
    const contents = page.node.Contents();
    const streams: unknown[] =
      contents instanceof PDFArray
        ? Array.from({ length: contents.size() }, (_, i) => contents.get(i))
        : [contents];
    for (const entry of streams) {
      const resolved = pdf.context.lookup(entry as PDFRef);
      if (!(resolved instanceof PDFRawStream)) continue;
      const source = Buffer.from(decodePDFRawStream(resolved).decode()).toString("latin1");
      for (const m of source.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/gu)) {
        lines.push(Buffer.from(m[1] ?? "", "hex").toString("latin1"));
      }
      for (const m of source.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/gu)) {
        lines.push((m[1] ?? "").replace(/\\(.)/gu, "$1"));
      }
    }
  }
  return { text: lines.join("\n"), flat: lines.join(" ").replace(/\s+/gu, " "), lines, pdf };
}

describe("renderCertificatePdf", () => {
  it("produces a loadable PDF", async () => {
    const bytes = await renderCertificatePdf(DOC, ANCHORS);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    const { pdf } = await extract(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("prints every fact the canonical JSON carries", async () => {
    const { text } = await extract(await renderCertificatePdf(DOC, ANCHORS));
    for (const fact of [
      DOC.workspace.name,
      DOC.workspace.host,
      DOC.signer.displayName ?? "",
      DOC.signer.typedName ?? "",
      DOC.signer.membershipId,
      DOC.signer.emailSha256,
      DOC.document.title,
      DOC.document.stamp,
      DOC.document.bodySha256,
      DOC.acceptance.acceptedAt,
      DOC.acceptance.uaFamily ?? "",
      DOC.acceptance.ipHash ?? "",
      DOC.acceptance.viaLinkId ?? "",
      DOC.certificateId,
    ]) {
      expect(text, `missing ${fact}`).toContain(fact);
    }
  });

  it("prints its own digest and both audit anchors", async () => {
    const { text } = await extract(await renderCertificatePdf(DOC, ANCHORS));
    expect(text).toContain(digestOf(DOC));
    expect(text).toContain(DOC.anchor.auditHash);
    expect(text).toContain(ANCHORS.issuance.auditHash);
    expect(text).toContain(`#${DOC.anchor.auditSeq}`);
    expect(text).toContain(`#${ANCHORS.issuance.auditSeq}`);
  });

  it("says a click-wrap acceptance is not a signed NDA (design/03:58)", async () => {
    const { flat } = await extract(await renderCertificatePdf(DOC, ANCHORS));
    expect(flat).toContain("not a signed NDA");
    expect(flat).toContain("not an advanced or qualified electronic signature");
    expect(flat).toContain("does not prove who was physically at the keyboard");
  });

  it("says it is a rendering of the JSON and how to regenerate and verify it", async () => {
    const { flat } = await extract(await renderCertificatePdf(DOC, ANCHORS));
    expect(flat).toContain("canonical artefact is the JSON certificate, not this PDF");
    expect(flat).toContain("can be regenerated from that JSON");
    expect(flat).toContain("compute sha256 over its UTF-8 bytes");
  });

  it("never prints an email address, an IP address or a User-Agent string", async () => {
    const { text } = await extract(await renderCertificatePdf(DOC, ANCHORS));
    expect(text).not.toContain("@");
    expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/u);
    expect(text).not.toMatch(/Mozilla|AppleWebKit|Gecko\//u);
  });

  it("pins the dates and producer instead of reading the wall clock", async () => {
    const { pdf } = await extract(await renderCertificatePdf(DOC, ANCHORS));
    expect(pdf.getProducer()).toBe(PDF_PRODUCER);
    expect(pdf.getCreator()).toBe(PDF_CREATOR);
    expect(pdf.getCreationDate()?.toISOString()).toBe("2026-09-14T10:11:12.000Z");
    expect(pdf.getModificationDate()?.toISOString()).toBe("2026-09-14T10:11:12.000Z");
    expect(pdf.getTitle()).toContain(DOC.certificateId);
  });

  it("renders the same document to the same bytes a year apart", async () => {
    // Only `Date` is faked: pdf-lib's own `save` yields through real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
      const a = await renderCertificatePdf(DOC, ANCHORS);
      vi.setSystemTime(new Date("2027-06-07T08:09:10Z"));
      const b = await renderCertificatePdf(DOC, ANCHORS);
      // Best-effort and never relied upon — the JSON's digest is the evidence — but while it
      // holds it proves no wall clock leaked into the bytes.
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a different document to different bytes", async () => {
    const other = assertValidCertificateDocument({
      ...DOC,
      document: { ...DOC.document, versionNo: 4, stamp: "nda:v4" },
    });
    const a = await renderCertificatePdf(DOC, ANCHORS);
    const b = await renderCertificatePdf(other, ANCHORS);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("draws a name the standard fonts cannot encode instead of throwing", async () => {
    const doc = assertValidCertificateDocument({
      ...DOC,
      signer: { ...DOC.signer, displayName: "李雷", typedName: "Zoë 😀" },
    });
    const { text } = await extract(await renderCertificatePdf(doc, ANCHORS));
    // Latin-1 survives; everything else becomes `?`, and nothing throws.
    expect(text).toContain("??");
    expect(text).toContain("Zoë ?");
  });

  it("wraps a title too long for one line rather than running off the page", async () => {
    const title = "Mutual non-disclosure and confidentiality agreement ".repeat(9).trim();
    const doc = assertValidCertificateDocument({
      ...DOC,
      document: { ...DOC.document, title },
    });
    const { lines } = await extract(await renderCertificatePdf(doc, ANCHORS));
    const drawn = lines.filter((l) => l.includes("Mutual non-disclosure and confidentiality"));
    expect(drawn.length).toBeGreaterThan(1);
    for (const line of drawn) expect(line.length).toBeLessThan(title.length);
  });

  it("refuses to render a document it would not canonicalise", async () => {
    await expect(
      renderCertificatePdf({ ...DOC, certificateId: "nope" } as CertificateDocument, ANCHORS),
    ).rejects.toThrow(/certificateId/u);
  });
});

describe("sanitizeForWinAnsi", () => {
  it("keeps everything the standard 14 fonts can draw", () => {
    const keep = "ASCII ~ !\"#$%&'()*+,-./0123456789:;<=>?@ Müller Ærø çà ÿ € — “ ” •";
    expect(sanitizeForWinAnsi(keep)).toBe(keep);
  });

  it("replaces what they cannot, one replacement per code point", () => {
    expect(sanitizeForWinAnsi("a李b")).toBe("a?b");
    // An emoji is one code point, not two UTF-16 units: a naive loop would emit "??".
    expect(sanitizeForWinAnsi("a😀b")).toBe("a?b");
    expect(sanitizeForWinAnsi("tab\there")).toBe("tab?here");
  });
});
