// sql-hygiene-allow: the refusal tests below deliberately contain SET ROLE / session statements.
import { describe, expect, it } from "vitest";
import { BreakGlassStatementError, checkBreakGlassStatement, leadingKeyword } from "./host.js";
import { BreakGlassInputError, validateOpenInput } from "./session.js";

describe("leadingKeyword", () => {
  it("skips whitespace, comments and parentheses", () => {
    expect(leadingKeyword("  SELECT 1")).toBe("select");
    expect(leadingKeyword("-- why\n/* more */ (select 1)")).toBe("select");
    expect(leadingKeyword("/* a */\n-- b\n\tWITH x AS (SELECT 1) SELECT * FROM x")).toBe("with");
    expect(leadingKeyword("-- only a comment")).toBe("");
    expect(leadingKeyword("/* unterminated")).toBe("");
    expect(leadingKeyword("")).toBe("");
  });

  it("nests block comments as Postgres does (review R1 BG-1)", () => {
    expect(leadingKeyword("/* /* */ SELECT */ DO $$ BEGIN END $$")).toBe("do");
    expect(leadingKeyword("/* a /* b /* c */ */ */ UPDATE t SET a = 1")).toBe("update");
    expect(leadingKeyword("/* /* */ SELECT 1")).toBe("");
  });
});

describe("checkBreakGlassStatement", () => {
  const refused = (sql: string, write = false) => {
    try {
      checkBreakGlassStatement(sql, write);
    } catch (error) {
      expect(error).toBeInstanceOf(BreakGlassStatementError);
      return (error as BreakGlassStatementError).message;
    }
    throw new Error(`not refused: ${sql}`);
  };

  it("labels queries, and asks for --write on a DML verb", () => {
    for (const q of [
      "SELECT 1",
      "with x as (select 1) select * from x",
      "TABLE core.workspace",
      "VALUES (1)",
    ]) {
      expect(checkBreakGlassStatement(q, false)).toBe(leadingKeyword(q));
    }
    for (const q of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE",
      "/* /* */ SELECT */ UPDATE t SET a = 1",
    ]) {
      expect(refused(q)).toMatch(/pass --write/u);
      expect(checkBreakGlassStatement(q, true)).toBe(leadingKeyword(q));
    }
  });

  it("refuses empty and oversized text; what may run at all is Postgres's call (PREPARE)", () => {
    expect(refused("   ")).toMatch(/empty/u);
    expect(refused(`SELECT '${"x".repeat(70 * 1024)}'`)).toMatch(/64 KiB/u);
    // Not a gate: DO/SET/DDL pass this check and are refused by vetBreakGlassStatement.
    expect(checkBreakGlassStatement("DO $$ BEGIN END $$", true)).toBe("do");
  });
});

describe("validateOpenInput", () => {
  const base = {
    workspaceId: "",
    ticket: "OPS-1",
    reason: "a real reason for access",
    operator: "nora",
    osUser: "nora",
  };
  it("accepts a well-formed request and the default window", () => {
    expect(() => validateOpenInput(base)).not.toThrow();
    expect(() => validateOpenInput({ ...base, minutes: 60 })).not.toThrow();
    expect(() =>
      validateOpenInput({ ...base, ticket: "https://tracker.example/INC-42" }),
    ).not.toThrow();
  });
  it.each([
    [{ ticket: "OPS 1" }, /--ticket/u],
    [{ ticket: "ab" }, /--ticket/u],
    [{ ticket: "x".repeat(129) }, /--ticket/u],
    [{ reason: "   too short   " }, /--reason/u],
    [{ operator: "" }, /--operator/u],
    [{ operator: "a\u0007b" }, /--operator/u],
    [{ minutes: 0 }, /--minutes/u],
    [{ minutes: 61 }, /--minutes/u],
    [{ minutes: 1.5 }, /--minutes/u],
  ])("refuses %j", (patch, message) => {
    expect(() => validateOpenInput({ ...base, ...patch })).toThrow(BreakGlassInputError);
    expect(() => validateOpenInput({ ...base, ...patch })).toThrow(message);
  });
});
