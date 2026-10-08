import { describe, expect, it } from "vitest";
import {
  childPath,
  folderLabel,
  isPreviewable,
  joinIndex,
  numberSiblings,
  parseProtection,
  resolveDeclaredType,
  sniffBytes,
  templateById,
  typeMatches,
  watermarkLines,
} from "./model.js";

describe("paths", () => {
  it("labels folders by their uuid without hyphens", () => {
    expect(folderLabel("0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01")).toBe(
      "0192f1a05c3e7d2a9a3b1f2e3d4c5d01",
    );
    expect(childPath("r", "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01")).toBe(
      "r.0192f1a05c3e7d2a9a3b1f2e3d4c5d01",
    );
    expect(() => folderLabel("nope")).toThrow(RangeError);
  });
});

describe("index numbering", () => {
  it("numbers folders before documents by sort order then name", () => {
    const n = numberSiblings(
      [
        { id: "b", sortOrder: 2, name: "Bravo" },
        { id: "a", sortOrder: 1, name: "Alpha" },
      ],
      [
        { id: "d2", sortOrder: 0, name: "Zulu" },
        { id: "d1", sortOrder: 0, name: "Mike" },
      ],
    );
    expect([...n.entries()]).toEqual([
      ["a", 1],
      ["b", 2],
      ["d1", 3],
      ["d2", 4],
    ]);
    expect(joinIndex(null, 2)).toBe("2");
    expect(joinIndex("1.2", 3)).toBe("1.2.3");
  });
});

describe("uploads", () => {
  it("accepts allow-listed types and falls back to the extension for octet-stream", () => {
    expect(resolveDeclaredType("application/pdf; charset=binary", "deck.pdf")).toBe(
      "application/pdf",
    );
    expect(resolveDeclaredType("application/octet-stream", "model.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(resolveDeclaredType("text/html", "evil.html")).toBeUndefined();
    expect(resolveDeclaredType("image/svg+xml", "logo.svg")).toBeUndefined();
  });

  it("sniffs magic bytes and refuses a mismatch", () => {
    expect(sniffBytes(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
    expect(sniffBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe("image/png");
    expect(sniffBytes(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBe("text/html");
    expect(sniffBytes(Buffer.from("a,b,c\n1,2,3\n"))).toBe("text/plain");
    expect(typeMatches("application/pdf", "application/pdf")).toBe(true);
    expect(typeMatches("application/pdf", "text/html")).toBe(false);
    expect(typeMatches("text/csv", "text/plain")).toBe(true);
    expect(
      typeMatches(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/zip",
      ),
    ).toBe(true);
  });

  it("knows what the viewer can show", () => {
    expect(isPreviewable("application/pdf")).toBe(true);
    expect(isPreviewable("image/webp")).toBe(true);
    expect(isPreviewable("video/mp4")).toBe(false);
  });
});

describe("protection + watermark", () => {
  it("defaults and tolerates junk", () => {
    expect(parseProtection(undefined)).toEqual({
      download: false,
      watermark: true,
      print: false,
      forensic: false,
    });
    expect(parseProtection({ download: true, watermark: false, print: false })).toEqual({
      download: true,
      watermark: false,
      print: false,
      forensic: false,
    });
    expect(parseProtection({ download: "yes" })).toEqual({
      download: false,
      watermark: true,
      print: false,
      forensic: false,
    });
    // E3.13: forensic is independent of the visible watermark.
    expect(parseProtection({ watermark: false, forensic: true })).toMatchObject({
      watermark: false,
      forensic: true,
    });
  });

  it("burns email, time and workspace, falling back to the display name", () => {
    const at = new Date("2026-09-12T10:30:00Z");
    expect(
      watermarkLines({ email: "ada@example.com", displayName: "Ada", workspaceSlug: "acme", at }),
    ).toEqual(["ada@example.com · 2026-09-12 10:30 UTC", "acme · confidential"]);
    expect(watermarkLines({ email: null, displayName: "Ada", workspaceSlug: "acme", at })[0]).toBe(
      "Ada · 2026-09-12 10:30 UTC",
    );
  });
});

describe("templates", () => {
  it("ships Seed, Series A DD and Board", () => {
    expect(templateById("seed")?.folders.map((f) => f.name)).toContain("Financials");
    expect(templateById("series-a-dd")?.folders[0]?.children?.length).toBeGreaterThan(0);
    expect(templateById("board")).toBeDefined();
    expect(templateById("nope")).toBeUndefined();
  });
});
