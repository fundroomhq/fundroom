import { describe, expect, it } from "vitest";
import {
  compareRegisterKeys,
  csvField,
  decodeRegisterCursor,
  encodeRegisterCursor,
  REGISTER_COLUMNS,
  type RegisterEntry,
  registerCsv,
  registerJson,
  registerKeyOf,
} from "./register.js";

const NOW = new Date("2026-09-14T10:30:00.000Z");
const WS = "01920000-0000-7000-8000-00000000000a";
const ALICE = "01920000-0000-7000-8000-0000000000a1";
const BOB = "01920000-0000-7000-8000-0000000000b2";

function entry(over: Partial<RegisterEntry> = {}): RegisterEntry {
  return {
    membershipId: ALICE,
    documentId: "01920000-0000-7000-8000-0000000000d0",
    slug: "nda",
    versionNo: 2,
    stamp: "nda:v2",
    bodySha256: "ab".repeat(32),
    acceptedAt: NOW,
    evidenceRef: null,
    ...over,
  };
}

describe("the register cursor", () => {
  it("round-trips all three ordering columns", () => {
    const key = { signedAt: NOW, membershipId: ALICE, kind: "nda:v2" };
    expect(decodeRegisterCursor(encodeRegisterCursor(key))).toEqual(key);
  });

  it("refuses a cursor carrying only the timestamp, which is the E1.5 bug in a new hat", () => {
    const truncated = Buffer.from(NOW.toISOString(), "utf8").toString("base64url");
    expect(decodeRegisterCursor(truncated)).toBeUndefined();
  });

  it("refuses a cursor missing its kind, rather than paging on a partial key", () => {
    const partial = Buffer.from(`${NOW.toISOString()}|${ALICE}`, "utf8").toString("base64url");
    expect(decodeRegisterCursor(partial)).toBeUndefined();
  });

  it("refuses an empty membership or kind segment", () => {
    const blank = Buffer.from(`${NOW.toISOString()}||nda:v2`, "utf8").toString("base64url");
    expect(decodeRegisterCursor(blank)).toBeUndefined();
  });

  it("refuses an unparseable timestamp instead of producing an Invalid Date key", () => {
    const bad = Buffer.from(`never|${ALICE}|nda:v2`, "utf8").toString("base64url");
    expect(decodeRegisterCursor(bad)).toBeUndefined();
  });
});

describe("compareRegisterKeys", () => {
  it("orders a tie on signed_at by membership, so a publish's stampede is still a total order", () => {
    // Two investors clicking through the same gate in the same microsecond is not a hypothetical:
    // it is what happens the moment an admin publishes a new version.
    const a = registerKeyOf(entry({ membershipId: ALICE }));
    const b = registerKeyOf(entry({ membershipId: BOB }));
    expect(compareRegisterKeys(a, b)).toBeGreaterThan(0);
    expect(compareRegisterKeys(b, a)).toBeLessThan(0);
    expect(compareRegisterKeys(a, a)).toBe(0);
  });

  it("orders a tie on signed_at AND membership by kind, for two documents accepted at once", () => {
    const nda = registerKeyOf(entry({ stamp: "nda:v2" }));
    const privacy = registerKeyOf(entry({ slug: "privacy-notice", stamp: "privacy-notice:v1" }));
    expect(compareRegisterKeys(nda, privacy)).toBeGreaterThan(0);
    expect(compareRegisterKeys(privacy, nda)).toBeLessThan(0);
  });

  it("puts the newest acceptance first", () => {
    const older = registerKeyOf(entry({ acceptedAt: new Date("2026-01-01T00:00:00.000Z") }));
    const newer = registerKeyOf(entry());
    expect(compareRegisterKeys(newer, older)).toBeLessThan(0);
  });

  it("never returns 0 for two distinct rows, so a cursor can neither skip nor repeat one", () => {
    const rows = [
      entry({ membershipId: ALICE, stamp: "nda:v2" }),
      entry({ membershipId: BOB, stamp: "nda:v2" }),
      entry({ membershipId: ALICE, slug: "privacy-notice", stamp: "privacy-notice:v1" }),
    ].map(registerKeyOf);
    for (const a of rows) {
      for (const b of rows) {
        if (a === b) continue;
        expect(compareRegisterKeys(a, b)).not.toBe(0);
      }
    }
  });
});

describe("csvField", () => {
  it("quotes a field containing a comma and leaves the comma intact", () => {
    expect(csvField("Smith, Jane")).toBe('"Smith, Jane"');
  });

  it("doubles embedded quotes inside a quoted field (RFC 4180)", () => {
    expect(csvField('he said "yes"')).toBe('"he said ""yes"""');
  });

  it("quotes a field containing a newline so one row stays one row", () => {
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
    expect(csvField("line one\r\nline two")).toBe('"line one\r\nline two"');
  });

  it("neutralises a leading `=` so counsel's spreadsheet does not execute the export", () => {
    // A slug is tenant-controlled, and `=HYPERLINK(...)` in a cell runs on open in Excel,
    // LibreOffice and Sheets alike. The apostrophe goes INSIDE the field, before any quoting.
    expect(csvField('=HYPERLINK("http://evil","click")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""click"")"',
    );
  });

  it("neutralises the other formula leads: + - @ tab and carriage return", () => {
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-1")).toBe("'-1");
    expect(csvField("@SUM(1+1)")).toBe("'@SUM(1+1)");
    // A tab needs no RFC 4180 quoting; the apostrophe alone is what defuses it.
    expect(csvField("\tcmd")).toBe("'\tcmd");
    expect(csvField("\r=1")).toBe('"\'\r=1"');
  });

  it("leaves an ordinary value exactly as it is", () => {
    expect(csvField("nda:v2")).toBe("nda:v2");
    expect(csvField("")).toBe("");
  });
});

describe("registerCsv", () => {
  it("emits the fixed header, CRLF rows and a BOM so Excel reads UTF-8", () => {
    const csv = registerCsv([entry()]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.slice(1).split("\r\n")[0]).toBe(REGISTER_COLUMNS.join(","));
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("sorts by the register's own order, so pages assembled in any order give one file", () => {
    const a = entry({ membershipId: ALICE });
    const b = entry({ membershipId: BOB });
    expect(registerCsv([a, b])).toBe(registerCsv([b, a]));
    const rows = registerCsv([a, b]).slice(1).trimEnd().split("\r\n");
    expect(rows[1]?.startsWith(BOB)).toBe(true);
    expect(rows[2]?.startsWith(ALICE)).toBe(true);
  });

  it("writes an empty cell, not the word null, for a missing hash or certificate", () => {
    const csv = registerCsv([entry({ bodySha256: null, evidenceRef: null })]);
    const row = csv.slice(1).split("\r\n")[1] ?? "";
    expect(row).not.toContain("null");
    expect(row.endsWith(`,${NOW.toISOString()},`)).toBe(true);
  });
});

describe("registerJson", () => {
  it("is byte-stable for the same rows in any order", () => {
    const a = entry({ membershipId: ALICE });
    const b = entry({ membershipId: BOB });
    const meta = { workspaceId: WS, generatedAt: NOW };
    expect(registerJson([a, b], meta)).toBe(registerJson([b, a], meta));
  });

  it("states the filter it was produced under, so an export cannot be mistaken for the whole", () => {
    const doc = JSON.parse(
      registerJson([entry()], { workspaceId: WS, generatedAt: NOW, filter: { slug: "nda" } }),
    ) as Record<string, unknown>;
    expect(doc["filter"]).toEqual({ membershipId: null, documentId: null, slug: "nda" });
    expect(doc["count"]).toBe(1);
  });
});
