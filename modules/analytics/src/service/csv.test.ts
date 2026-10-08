import { describe, expect, it } from "vitest";
import { csvField, HOT_LIST_CSV_COLUMNS, type HotListCsvRow, hotListCsv } from "./csv.js";

const row = (over: Partial<HotListCsvRow> = {}): HotListCsvRow => ({
  membershipId: "0190a0a0-0000-7000-8000-000000000001",
  displayName: "Ada Lovelace",
  role: "investor",
  score: 72,
  counts: { views: 3, dwellMs: 61_400, downloads: 1, humanOpens: 2, clicks: 1, automatedOpens: 4 },
  lastActivityAt: "2026-09-22T10:00:00.000Z",
  ...over,
});

describe("csvField", () => {
  it("leaves plain values alone", () => {
    expect(csvField("Ada Lovelace")).toBe("Ada Lovelace");
    expect(csvField("")).toBe("");
  });

  it("quotes commas, quotes and line breaks, doubling inner quotes (RFC 4180)", () => {
    expect(csvField("Lovelace, Ada")).toBe('"Lovelace, Ada"');
    expect(csvField('Ada "the countess"')).toBe('"Ada ""the countess"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField("cr\rlf")).toBe('"cr\rlf"');
  });

  it.each([
    ['=HYPERLINK("http://evil","x")', '"\'=HYPERLINK(""http://evil"",""x"")"'],
    ["+1+1", "'+1+1"],
    ["-2+3", "'-2+3"],
    ["@SUM(1+1)*cmd|'/c calc'!A0", "'@SUM(1+1)*cmd|'/c calc'!A0"],
    ["\t=1", "'\t=1"],
    ["\r=1", '"\'\r=1"'],
  ])("neutralises a formula lead: %j", (input, expected) => {
    expect(csvField(input)).toBe(expected);
  });

  it("does not touch a formula character that is not the first", () => {
    expect(csvField("Ada=Lovelace")).toBe("Ada=Lovelace");
    expect(csvField("a-b@c+d")).toBe("a-b@c+d");
  });
});

describe("hotListCsv", () => {
  it("writes a BOM, the frozen header and CRLF-terminated rows in rank order", () => {
    const csv = hotListCsv([row(), row({ displayName: "Bob", score: 40, lastActivityAt: null })]);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe(HOT_LIST_CSV_COLUMNS.join(","));
    expect(lines[0]).toBe(
      "rank,membership_id,name,role,score,views,dwell_seconds,downloads,human_opens,clicks,automated_opens,last_activity_at",
    );
    expect(lines[1]).toBe(
      "1,0190a0a0-0000-7000-8000-000000000001,Ada Lovelace,investor,72,3,61,1,2,1,4,2026-09-22T10:00:00.000Z",
    );
    expect(lines[2]).toBe("2,0190a0a0-0000-7000-8000-000000000001,Bob,investor,40,3,61,1,2,1,4,");
    expect(lines[3]).toBe("");
    expect(lines).toHaveLength(4);
  });

  it("guards a member-chosen display name against formula injection", () => {
    const csv = hotListCsv([row({ displayName: "=cmd|' /C calc'!A0" })]);
    expect(csv).toContain(",'=cmd|' /C calc'!A0,");
    expect(csv).not.toContain(",=cmd");
  });

  it("an empty list is just the header", () => {
    expect(hotListCsv([])).toBe(`﻿${HOT_LIST_CSV_COLUMNS.join(",")}\r\n`);
  });
});
