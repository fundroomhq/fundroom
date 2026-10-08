import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  applyThemeTokens,
  clearThemeTokens,
  DEFAULT_TOKENS,
  dtcgToTokens,
  tokensToCss,
} from "./tokens.js";

// The published package's files, exactly as a consumer resolves them (ADR-0067).
const resolve = createRequire(import.meta.url).resolve;
const doc = JSON.parse(readFileSync(resolve("@fundroomhq/tokens/tokens.json"), "utf8")) as unknown;
const css = readFileSync(resolve("@fundroomhq/tokens/tokens.css"), "utf8");

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const end = css.indexOf("}", start);
  const out: Record<string, string> = {};
  for (const line of css.slice(start, end).split("\n")) {
    const m = /^\s*(--sh-[a-z0-9-]+):\s*(.+);$/u.exec(line);
    if (m?.[1] && m[2]) out[m[1]] = m[2];
  }
  return out;
}

describe("theme tokens", () => {
  it("dtcgToTokens matches the generated tokens.css", () => {
    const light = dtcgToTokens(doc, "light");
    const dark = dtcgToTokens(doc, "dark");
    expect(light).toEqual(block(":root"));
    const darkBlock = block(".dark");
    for (const [k, v] of Object.entries(darkBlock)) expect(dark[k]).toBe(v);
    expect(
      Object.keys(dark)
        .filter((k) => k.startsWith("--sh-color-"))
        .sort(),
    ).toEqual(Object.keys(darkBlock).sort());
    expect(DEFAULT_TOKENS.light).toEqual(light);
  });

  it("refuses unsafe names and values", () => {
    const el = document.createElement("div");
    const applied = applyThemeTokens(
      {
        "--sh-color-primary": "#123456",
        "--evil": "red",
        "--sh-color-bg": "url(http://x)",
        "--sh-radius-base": "1rem; } body { display: none",
      },
      el,
    );
    expect(applied).toEqual(["--sh-color-primary"]);
    expect(el.style.getPropertyValue("--sh-color-primary")).toBe("#123456");
    clearThemeTokens(el);
    expect(el.style.getPropertyValue("--sh-color-primary")).toBe("");
  });

  it("renders CSS", () => {
    expect(tokensToCss({ "--sh-color-bg": "#fff", "--bad": "x" }, ".embed")).toBe(
      ".embed {\n  --sh-color-bg: #fff;\n}\n",
    );
  });
});
