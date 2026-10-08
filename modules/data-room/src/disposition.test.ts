import { describe, expect, it } from "vitest";
import { asciiFileName, attachmentDisposition, safeFileName } from "./disposition.js";

/** What a server actually does with the value: Fetch `Headers` refuse anything but Latin-1. */
function asHeader(value: string): string {
  return new Headers({ "Content-Disposition": value }).get("Content-Disposition") ?? "";
}

/** The `filename*` value decoded back, as a browser would. */
function extended(value: string): string {
  const m = /filename\*=UTF-8''([^;]*)$/u.exec(value);
  return decodeURIComponent(m?.[1] ?? "");
}

function fallback(value: string): string {
  return /filename="([^"]*)"/u.exec(value)?.[1] ?? "";
}

describe("attachmentDisposition (ASVS F-23)", () => {
  it("keeps a plain name as it is", () => {
    expect(attachmentDisposition("Q3 report.pdf")).toBe(
      `attachment; filename="Q3 report.pdf"; filename*=UTF-8''Q3%20report.pdf`,
    );
  });

  it("builds a valid header for a non-Latin-1 name, with an ASCII fallback", () => {
    const name = "Übersicht – 財務報告 (final).pdf";
    const value = attachmentDisposition(name);
    expect(() => asHeader(value)).not.toThrow();
    expect(extended(value)).toBe(name);
    expect(fallback(value)).toBe("Ubersicht _ ____ (final).pdf");
    expect(value).toMatch(/filename\*=UTF-8''[A-Za-z0-9%!._~-]+$/u);
  });

  it("strips quotes, backslashes, CR/LF, control characters and path separators", () => {
    const value = attachmentDisposition('a"b\\c\r\nSet-Cookie: x=1\u0000/../../etc\\passwd.pdf');
    expect(value).not.toMatch(/[\r\n]/u);
    expect(value.includes("\u0000")).toBe(false);
    const quoted = fallback(value);
    expect(quoted).not.toMatch(/["\\/]/u);
    expect(extended(value)).not.toMatch(/[\r\n/\\]/u);
    expect(extended(value).includes("\u0000")).toBe(false);
    expect(() => asHeader(value)).not.toThrow();
  });

  it("drops bidi overrides that disguise an extension", () => {
    const value = attachmentDisposition(`invoice${String.fromCharCode(0x202e)}fdp.exe`);
    expect(extended(value)).toBe("invoicefdp.exe");
    expect(fallback(value)).toBe("invoicefdp.exe");
  });

  it("survives lone surrogates, empty and dot-only names", () => {
    expect(() => attachmentDisposition("bad\ud800name.pdf")).not.toThrow();
    expect(safeFileName("   ")).toBe("download");
    expect(safeFileName("...")).toBe("download");
    expect(asciiFileName("財務")).toBe("__");
    expect(asciiFileName("100%.pdf")).toBe("100_.pdf");
  });
});
