import { describe, expect, it } from "vitest";
import { csvField, csvRecord } from "./write.js";

describe("csvField", () => {
  it("guards formula-leading cells before quoting", () => {
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvField('-2,"x"')).toBe(`"'-2,""x"""`);
    expect(csvField("\tx")).toBe("'\tx");
    expect(csvField("plain")).toBe("plain");
  });

  it("builds CRLF records", () => {
    expect(csvRecord(["a", "b,c"])).toBe('a,"b,c"\r\n');
  });
});
