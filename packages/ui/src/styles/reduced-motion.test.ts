import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The reduced-motion reset lives in `@layer base`; Tailwind's transition/duration/delay and
 * tw-animate-css's animate utilities live in the later `utilities` layer and win over normal
 * declarations. Only `!important` (which reverses layer precedence) lets the reset win (C-10).
 */
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.css"), "utf8");

function reducedMotionDeclarations(): Map<string, string> {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(start, "reduced-motion block missing").toBeGreaterThan(-1);
  const open = css.indexOf("{", css.indexOf("{", start) + 1);
  const close = css.indexOf("}", open);
  const out = new Map<string, string>();
  for (const decl of css.slice(open + 1, close).split(";")) {
    const [prop, ...value] = decl.split(":");
    if (prop?.trim()) out.set(prop.trim(), value.join(":").trim());
  }
  return out;
}

describe("reduced-motion reset", () => {
  it("sits in @layer base and targets every element and pseudo-element", () => {
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(css.lastIndexOf("@layer base", start)).toBeGreaterThan(-1);
    const selector = css
      .slice(css.indexOf("{", start) + 1, css.indexOf("{", css.indexOf("{", start) + 1))
      .replace(/\s+/gu, " ")
      .trim();
    // Pseudo-elements are invalid inside :where()/:is(); `:where(*, *::before, *::after)`
    // compiles to `:where(*)` and leaves ::before/::after animating. A plain list is required.
    expect(selector).not.toMatch(/:(where|is)\(/u);
    expect(selector.split(/\s*,\s*/u).sort()).toEqual(["*", "*::after", "*::before"]);
  });

  it("neutralises durations, delays, iteration and smooth scroll", () => {
    expect([...reducedMotionDeclarations().keys()].sort()).toEqual(
      [
        "animation-delay",
        "animation-duration",
        "animation-iteration-count",
        "scroll-behavior",
        "transition-delay",
        "transition-duration",
      ].sort(),
    );
  });

  it("marks every declaration !important so later utility layers cannot override it", () => {
    for (const [prop, value] of reducedMotionDeclarations()) {
      expect(value, prop).toMatch(/\s!important$/u);
    }
  });
});
