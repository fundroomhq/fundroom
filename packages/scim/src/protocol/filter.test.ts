import { describe, expect, it } from "vitest";
import { ScimError } from "./errors.js";
import { matchesElement } from "./evaluate.js";
import { parseAttrName, parseFilter, parsePath } from "./filter.js";

function scimTypeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ScimError) return `${e.status}:${e.scimType ?? ""}`;
    throw e;
  }
  return undefined;
}

describe("parseFilter", () => {
  it("parses userName eq with a string", () => {
    expect(parseFilter('userName eq "jane@acme.test"')).toEqual({
      kind: "compare",
      path: { attr: "userName", attrKey: "username" },
      op: "eq",
      value: "jane@acme.test",
    });
  });

  it("is case-insensitive for attribute names, operators and keywords", () => {
    const f = parseFilter('USERNAME EQ "x" AND externalid Eq "y"');
    expect(f.kind).toBe("and");
    if (f.kind !== "and") throw new Error("unreachable");
    expect(f.left).toMatchObject({ kind: "compare", op: "eq", path: { attrKey: "username" } });
    expect(f.right).toMatchObject({ kind: "compare", op: "eq", path: { attrKey: "externalid" } });
  });

  it('parses Entra\'s emails[type eq "work"].value eq', () => {
    const f = parseFilter('emails[type eq "work"].value eq "a@b.test"');
    expect(f).toMatchObject({
      kind: "compare",
      op: "eq",
      value: "a@b.test",
      path: {
        attrKey: "emails",
        subKey: "value",
        filter: { kind: "compare", path: { attrKey: "type" }, value: "work" },
      },
    });
  });

  it("parses emails.value eq", () => {
    expect(parseFilter('emails.value eq "a@b.test"')).toMatchObject({
      kind: "compare",
      path: { attrKey: "emails", subKey: "value" },
    });
  });

  it("parses URN-prefixed attribute names", () => {
    expect(parseFilter('urn:ietf:params:scim:schemas:core:2.0:User:userName eq "x"')).toMatchObject(
      {
        kind: "compare",
        path: { schema: "urn:ietf:params:scim:schemas:core:2.0:user", attrKey: "username" },
      },
    );
  });

  it("decodes string escapes", () => {
    expect(parseFilter('displayName eq "a \\"quoted\\" \\\\ name \\u00e9"')).toMatchObject({
      value: 'a "quoted" \\ name é',
    });
  });

  it("parses literals, pr, or, not and parentheses", () => {
    expect(parseFilter("active eq true")).toMatchObject({ value: true });
    expect(parseFilter("active eq False")).toMatchObject({ value: false });
    expect(parseFilter("externalId eq null")).toMatchObject({ value: null });
    expect(parseFilter("count gt 10")).toMatchObject({ op: "gt", value: 10 });
    expect(parseFilter("title pr")).toMatchObject({ kind: "present" });
    const f = parseFilter('not (a eq "1") or (b eq "2" and c eq "3")');
    expect(f).toMatchObject({ kind: "or", left: { kind: "not" }, right: { kind: "and" } });
  });

  it("parses a stand-alone value path (members[value eq …])", () => {
    const f = parseFilter('id eq "g1" and members[value eq "u1"]');
    expect(f).toMatchObject({
      kind: "and",
      right: { kind: "has", path: { attrKey: "members", filter: { value: "u1" } } },
    });
  });

  it("rejects malformed filters as 400 invalidFilter", () => {
    for (const bad of [
      "",
      'userName "x"',
      'userName eq "x',
      'userName eq "x" and',
      'userName eq "x" )',
      "(userName eq x",
      'emails[type eq "work".value eq "x"',
      'userName zz "x"',
      'bad$name eq "x" extra',
      'userName eq "\\q"',
      "1abc eq 2",
    ]) {
      expect(
        scimTypeOf(() => parseFilter(bad)),
        bad,
      ).toBe("400:invalidFilter");
    }
  });

  it("bounds nesting depth and length", () => {
    expect(scimTypeOf(() => parseFilter(`${"(".repeat(100)}a eq 1${")".repeat(100)}`))).toBe(
      "400:invalidFilter",
    );
    expect(scimTypeOf(() => parseFilter(`a eq "${"x".repeat(5000)}"`))).toBe("400:invalidFilter");
  });
});

describe("parsePath / parseAttrName", () => {
  it("parses PATCH paths", () => {
    expect(parsePath("active")).toEqual({ attr: "active", attrKey: "active" });
    expect(parsePath("name.givenName")).toMatchObject({ attrKey: "name", subKey: "givenname" });
    expect(parsePath('members[value eq "abc"]')).toMatchObject({
      attrKey: "members",
      filter: { kind: "compare", value: "abc" },
    });
    expect(parsePath('emails[type eq "work"].value')).toMatchObject({ subKey: "value" });
    expect(
      parsePath("urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber"),
    ).toMatchObject({
      schema: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:user",
      attrKey: "employeenumber",
    });
  });

  it("refuses bad paths as invalidPath", () => {
    expect(scimTypeOf(() => parsePath("a.b.c"))).toBe("400:invalidPath");
    expect(scimTypeOf(() => parsePath('members[value eq "x"] junk'))).toBe("400:invalidPath");
    expect(scimTypeOf(() => parseAttrName("na me"))).toBe("400:invalidPath");
  });
});

describe("matchesElement", () => {
  it("evaluates eq case-insensitively and boolean strings", () => {
    const f = parsePath('emails[type eq "Work" and primary eq true]').filter;
    if (f === undefined) throw new Error("no filter");
    expect(matchesElement(f, { type: "work", primary: "True" })).toBe(true);
    expect(matchesElement(f, { type: "home", primary: true })).toBe(false);
  });

  it("supports ne, co, sw, ew, pr, not, or and comparison", () => {
    const el = { value: "abc-123", n: 5 };
    const m = (s: string) => matchesElement(parseFilter(s), el);
    expect(m('value ne "x"')).toBe(true);
    expect(m('value co "c-1"')).toBe(true);
    expect(m('value sw "ABC"')).toBe(true);
    expect(m('value ew "23"')).toBe(true);
    expect(m("value pr")).toBe(true);
    expect(m("missing pr")).toBe(false);
    expect(m('not (value eq "abc-123")')).toBe(false);
    expect(m('value eq "x" or n ge 5')).toBe(true);
    expect(m("n lt 5")).toBe(false);
    expect(m("missing eq null")).toBe(true);
  });
});

describe("control characters in filter strings (R2-L1)", () => {
  it("refuses NUL raw or escaped as invalidFilter", () => {
    expect(scimTypeOf(() => parseFilter('userName eq "a\u0000b"'))).toBe("400:invalidFilter");
    expect(scimTypeOf(() => parseFilter('userName eq "a\\u0000b"'))).toBe("400:invalidFilter");
    expect(scimTypeOf(() => parseFilter('displayName eq "tab\\there"'))).toBe("400:invalidFilter");
  });
});
