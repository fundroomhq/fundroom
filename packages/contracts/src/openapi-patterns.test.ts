import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, createApi, createRoute, jsonResponse, z } from "./index.js";
import { repairPattern } from "./openapi.js";

/*
 * E2.10 ZAP-05: every zod regex reached the document as `<source>/<flags>` (the generator's
 * `toString()` trim), so no value could match any `pattern`. A `pattern` is an ECMA-262 regex
 * with no flags.
 */
function patternsOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) patternsOf(item, out);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "pattern" && typeof value === "string") out.push(value);
      else patternsOf(value, out);
    }
  }
  return out;
}

function expectUsable(patterns: readonly string[]): void {
  for (const p of patterns) {
    expect(p, p).not.toMatch(/(?<!\\)(?:\\\\)*\/[dgimsuvy]*$/u);
    expect(() => new RegExp(p), p).not.toThrow();
  }
}

describe("OpenAPI patterns", () => {
  const Thing = z
    .object({
      currency: z.string().regex(/^[A-Z]{3}$/u),
      plain: z.string().regex(/^[a-z]+$/),
      sticky: z.string().regex(/^x+$/gu),
      folded: z.string().regex(/^abc$/iu),
      letters: z.string().regex(/^\p{L}+$/u),
      slash: z.string().regex(/^a\/b$/u),
    })
    .openapi("PatternThing");

  const app = createApi();
  app.openapi(
    createRoute({
      method: "get",
      path: "/things",
      responses: { 200: jsonResponse(Thing, "A thing") },
    }),
    (c) =>
      c.json(
        { currency: "EUR", plain: "a", sticky: "x", folded: "ABC", letters: "é", slash: "a/b" },
        200,
      ),
  );

  it("emits the regex source without flags, and drops a pattern the flags change", () => {
    const doc = buildOpenApiDocument(app as never, { version: "0.0.1" });
    const schema = doc.components?.schemas?.["PatternThing"] as
      | { properties: Record<string, { pattern?: string }> }
      | undefined;
    const props = schema?.properties ?? {};
    expect(props["currency"]?.pattern).toBe("^[A-Z]{3}$");
    expect(props["plain"]?.pattern).toBe("^[a-z]+$");
    expect(props["sticky"]?.pattern).toBe("^x+$");
    // `i` has no flag-free spelling and `\p{L}` means "p{L}" without `u`: no pattern beats a wrong one.
    expect(props["folded"]).not.toHaveProperty("pattern");
    expect(props["letters"]).not.toHaveProperty("pattern");
    expect(props["slash"]?.pattern).toBe("^a\\/b$");
    expect(new RegExp(props["currency"]?.pattern ?? "").test("EUR")).toBe(true);
    expectUsable(patternsOf(doc));
  });

  it("repairPattern only cuts a real flag suffix", () => {
    expect(repairPattern("^[A-Z]{3}$/u")).toBe("^[A-Z]{3}$");
    expect(repairPattern("^[A-Z]{3}$")).toBe("^[A-Z]{3}$");
    expect(repairPattern("^a\\/u")).toBe("^a\\/u"); // escaped slash: part of the source
    expect(repairPattern("^a\\\\/u")).toBe("^a\\\\"); // escaped backslash, then the flags
    expect(repairPattern("^a$/ms")).toBeUndefined();
    expect(repairPattern("^[\\p{L}--[a-z]]$/v")).toBeUndefined();
    expect(repairPattern("^a--b$/u")).toBe("^a--b$");
  });

  it("the committed SDK document has only flag-free, compilable patterns", () => {
    const doc: unknown = JSON.parse(
      readFileSync(new URL("../../sdk/openapi.json", import.meta.url), "utf8"),
    );
    const patterns = patternsOf(doc);
    expect(patterns.length).toBeGreaterThan(0);
    expectUsable(patterns);
  });
});
