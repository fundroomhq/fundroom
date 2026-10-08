#!/usr/bin/env node
/**
 * DTCG tokens → CSS custom properties (design/08 §4).
 *
 *   fundroom.tokens.json  →  tokens.css
 *
 * Every token becomes `--sh-<group>-<path>`; `color.light` renders under `:root`, `color.dark`
 * under `.dark` and under `prefers-color-scheme: dark` when no explicit `.light` class is set.
 * `--check` exits 1 when the committed CSS is behind the JSON (CI runs it through `codegen:check`;
 * `prepack` runs it too, so a stale tokens.css can never be packed). Both files are published as
 * `@fundroomhq/tokens` (ADR-0067). `@fundroomhq/ui` keeps a copy of the JSON for `DEFAULT_TOKENS`, and
 * its runtime renderer (`tokensToCss`, `dtcgToTokens` in `@fundroomhq/ui/theme`) is tested against
 * this file's output.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const input = join(here, "..", "fundroom.tokens.json");
const output = join(here, "..", "tokens.css");

const tokens = JSON.parse(readFileSync(input, "utf8"));
const css = renderTokens(tokens);

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(output, "utf8");
  } catch {
    /* missing → stale */
  }
  if (current !== css) {
    console.error("tokens.css is stale; run `pnpm --filter @fundroomhq/tokens codegen`");
    process.exit(1);
  }
  process.exit(0);
}
writeFileSync(output, css);

/** @param {Record<string, unknown>} t */
export function renderTokens(t) {
  const light = flatten(t.color.light, "color");
  const dark = flatten(t.color.dark, "color");
  const shared = [
    ...flatten(t.font, "font"),
    ...flatten(t.radius, "radius"),
    ...flatten(t.density, "density"),
    ...flatten(t.shadow, "shadow"),
  ];
  const block = (sel, vars, indent = "") =>
    `${indent}${sel} {\n${vars.map(([k, v]) => `${indent}  ${k}: ${v};`).join("\n")}\n${indent}}\n`;
  return [
    "/* Generated from fundroom.tokens.json by scripts/build-tokens.mjs. Do not edit. */",
    block(":root", [...shared, ["color-scheme", "light"], ...light]),
    block(".dark", [["color-scheme", "dark"], ...dark]),
    "@media (prefers-color-scheme: dark) {",
    block(":root:not(.light)", [["color-scheme", "dark"], ...dark], "  ").trimEnd(),
    "}",
    "",
  ].join("\n");
}

/** @returns {Array<[string, string]>} */
function flatten(group, prefix) {
  const out = [];
  const type = group.$type;
  for (const [name, node] of Object.entries(group)) {
    if (name.startsWith("$")) continue;
    if (node && typeof node === "object" && "$value" in node) {
      out.push([`--sh-${prefix}-${name}`, renderValue(node.$value, node.$type ?? type)]);
    } else if (node && typeof node === "object") {
      out.push(...flatten({ $type: type, ...node }, `${prefix}-${name}`));
    }
  }
  return out;
}

export function renderValue(value, type) {
  switch (type) {
    case "fontFamily":
      return (Array.isArray(value) ? value : [value])
        .map((f) => (/[\s]/u.test(f) ? `"${f}"` : f))
        .join(", ");
    case "dimension":
      return typeof value === "object" ? `${value.value}${value.unit}` : String(value);
    case "shadow": {
      const list = Array.isArray(value) ? value : [value];
      return list
        .map((s) => `${s.offsetX} ${s.offsetY} ${s.blur} ${s.spread ?? "0px"} ${s.color}`)
        .join(", ");
    }
    default:
      return String(value);
  }
}
