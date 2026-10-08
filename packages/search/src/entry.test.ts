import type { SearchEntryInput } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { SEARCH_UNTITLED, SearchEntryError, toSearchRow } from "./entry.js";
import { MAX_BODY_CHARS, MAX_TITLE_CHARS } from "./text.js";

const REF = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
const GROUP = "0192f1a0-5c3e-7d2a-9a3b-000000000001";

function entry(over: Partial<SearchEntryInput> = {}): SearchEntryInput {
  return {
    kind: "document",
    refId: REF,
    title: "Pitch deck",
    body: "Runway is 18 months.",
    acl: { kind: "members" },
    href: `/data-room/documents/${REF}`,
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

function refused(e: Partial<SearchEntryInput> | unknown, pattern: RegExp, module = "data-room") {
  expect(() => toSearchRow(module, entry(e as Partial<SearchEntryInput>))).toThrow(
    SearchEntryError,
  );
  expect(() => toSearchRow(module, entry(e as Partial<SearchEntryInput>))).toThrow(pattern);
}

describe("toSearchRow", () => {
  it("normalises a members entry", () => {
    expect(toSearchRow("data-room", entry())).toEqual({
      module: "data-room",
      kind: "document",
      refId: REF,
      part: "",
      title: "Pitch deck",
      body: "Runway is 18 months.",
      href: `/data-room/documents/${REF}`,
      aclKind: "members",
      aclGroups: null,
      aclResourceKind: null,
      aclResourceId: null,
      aclPath: null,
      sourceUpdatedAt: new Date("2026-09-01T00:00:00Z"),
    });
  });

  it("maps every ACL kind onto the table's shape", () => {
    expect(toSearchRow("content", entry({ acl: { kind: "staff" } })).aclKind).toBe("staff");
    const groups = toSearchRow(
      "content",
      entry({ acl: { kind: "groups", groupIds: [GROUP, GROUP.toUpperCase()] } }),
    );
    expect([groups.aclKind, groups.aclGroups]).toEqual(["groups", [GROUP]]);
    const res = toSearchRow(
      "data-room",
      entry({
        acl: { kind: "resource", resourceKind: "document", resourceId: REF, path: "root.a1b2" },
      }),
    );
    expect(res).toMatchObject({
      aclKind: "resource",
      aclResourceKind: "document",
      aclResourceId: REF,
      aclPath: "root.a1b2",
      aclGroups: null,
    });
  });

  it("truncates body and title on a code-point boundary and strips control characters", () => {
    const body = `\u0002${"😀".repeat(MAX_BODY_CHARS)}`;
    const row = toSearchRow(
      "data-room",
      entry({ body, title: `  T\u0003itle${"é".repeat(2_000)}` }),
    );
    expect(row.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(row.body.isWellFormed()).toBe(true);
    expect(row.body.startsWith(" 😀")).toBe(true);
    expect(row.title.length).toBe(MAX_TITLE_CHARS);
    expect(row.title.startsWith("T itle")).toBe(true);
  });

  it("refuses bad hrefs with a clear message", () => {
    for (const href of [
      "https://evil.example/x",
      "//evil.example/x",
      "data-room/x",
      "/a b",
      "/a\\b",
      "/a\nb",
      "",
      `/${"x".repeat(3_000)}`,
    ]) {
      refused({ href }, /href .* must be an SPA path/u);
    }
  });

  it("refuses malformed ACLs with a clear message", () => {
    refused({ acl: { kind: "groups", groupIds: [] } }, /needs at least one group id/u);
    refused({ acl: { kind: "groups", groupIds: ["nope"] } }, /group id "nope" is not a uuid/u);
    refused(
      { acl: { kind: "resource", resourceKind: "Doc!", resourceId: REF } },
      /resourceKind "Doc!"/u,
    );
    refused(
      { acl: { kind: "resource", resourceKind: "document", resourceId: "x" } },
      /resourceId "x" is not a uuid/u,
    );
    refused(
      { acl: { kind: "resource", resourceKind: "document", resourceId: REF, path: "a..b" } },
      /is not an ltree path/u,
    );
    refused({ acl: { kind: "everyone" } }, /acl kind "everyone"/u);
    refused({ acl: undefined }, /acl is required/u);
  });

  it("never refuses text: an empty-after-cleaning title becomes the neutral marker (fix A #7)", () => {
    for (const title of ["   ", "\u0007", "\u0001\u0002 \u0003", "\u007f\n"])
      expect(toSearchRow("content", entry({ title })).title).toBe(SEARCH_UNTITLED);
    expect(toSearchRow("content", entry({ body: "y".repeat(300_000) })).body).toHaveLength(200_000);
    // A non-string title is still a programming error.
    refused({ title: 42 as unknown as string }, /title must be a string/u);
  });

  it("refuses bad identity fields", () => {
    refused({ kind: "Document" }, /kind "Document"/u);
    refused({ refId: "42" }, /refId "42" must be a uuid/u);
    refused({ part: "x".repeat(200) }, /part must be/u);
    refused({ updatedAt: new Date("nope") }, /updatedAt must be a valid Date/u);
    refused({}, /module id "Data Room"/u, "Data Room");
  });
});
