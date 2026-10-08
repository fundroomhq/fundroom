// biome-ignore lint/correctness/useImportExtensions: JSON module, not a source file
import defaultDoc from "./default-tokens.json" with { type: "json" };

/*
 * Runtime theming (design/08 §4). A workspace theme is a DTCG document with the same shape
 * as `@fundroomhq/tokens`' fundroom.tokens.json (copied to ./default-tokens.json by `codegen`);
 * `dtcgToTokens` flattens one mode into `--sh-*` custom properties, `applyThemeTokens` sets
 * them inline on <html>. Precedence (init overrides → host-posted tokens → workspace theme →
 * defaults) is the caller's business; this module only validates names and values so a theme
 * can never inject CSS.
 */
export type ThemeTokens = Readonly<Record<string, string>>;
export type ThemeMode = "light" | "dark";

const NAME_RE = /^--sh-[a-z0-9-]+$/u;
const BAD_VALUE_RE = /[;}<]|url\(|expression\(/iu;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Group = { [k: string]: Json };

function isGroup(v: Json | undefined): v is Group {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function renderTokenValue(value: Json, type: string | undefined): string {
  switch (type) {
    case "fontFamily": {
      const list = Array.isArray(value) ? value : [value];
      return list
        .map((f) => String(f))
        .map((f) => (/\s/u.test(f) ? `"${f}"` : f))
        .join(", ");
    }
    case "dimension":
      if (isGroup(value)) return `${String(value["value"])}${String(value["unit"])}`;
      return String(value);
    case "shadow": {
      const list = Array.isArray(value) ? value : [value];
      return list
        .filter(isGroup)
        .map(
          (s) =>
            `${String(s["offsetX"])} ${String(s["offsetY"])} ${String(s["blur"])} ${String(s["spread"] ?? "0px")} ${String(s["color"])}`,
        )
        .join(", ");
    }
    default:
      return String(value);
  }
}

function flatten(group: Group, prefix: string, out: Record<string, string>): void {
  const type = typeof group["$type"] === "string" ? group["$type"] : undefined;
  for (const [name, node] of Object.entries(group)) {
    if (name.startsWith("$")) continue;
    if (!isGroup(node)) continue;
    if ("$value" in node) {
      const nodeType = typeof node["$type"] === "string" ? node["$type"] : type;
      out[`--sh-${prefix}-${name}`] = renderTokenValue(node["$value"] as Json, nodeType);
    } else {
      flatten({ ...(type ? { $type: type } : {}), ...node }, `${prefix}-${name}`, out);
    }
  }
}

/** Flattens a DTCG document into `--sh-*` tokens for one colour mode. Unknown groups are ignored. */
export function dtcgToTokens(doc: unknown, mode: ThemeMode): ThemeTokens {
  const out: Record<string, string> = {};
  if (!isGroup(doc as Json)) return out;
  const d = doc as Group;
  for (const g of ["font", "radius", "density", "shadow"] as const) {
    const group = d[g];
    if (isGroup(group)) flatten(group, g, out);
  }
  const color = d["color"];
  if (isGroup(color)) {
    const palette = color[mode];
    if (isGroup(palette)) {
      const type = typeof color["$type"] === "string" ? color["$type"] : "color";
      flatten({ $type: type, ...palette }, "color", out);
    }
  }
  return out;
}

export function isSafeToken(name: string, value: string): boolean {
  return NAME_RE.test(name) && !BAD_VALUE_RE.test(value) && value.length <= 512;
}

export function tokensToCss(tokens: ThemeTokens, selector = ":root"): string {
  const lines = Object.entries(tokens)
    .filter(([k, v]) => isSafeToken(k, v))
    .map(([k, v]) => `  ${k}: ${v};`);
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}

/** Sets tokens as inline custom properties; unsafe names/values are skipped, not thrown. Returns the applied names. */
export function applyThemeTokens(
  tokens: ThemeTokens,
  root: HTMLElement | undefined = typeof document === "undefined"
    ? undefined
    : document.documentElement,
): string[] {
  if (!root) return [];
  const applied: string[] = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (!isSafeToken(name, value)) continue;
    root.style.setProperty(name, value);
    applied.push(name);
  }
  return applied;
}

/** Removes every inline `--sh-*` property set on the element. */
export function clearThemeTokens(
  root: HTMLElement | undefined = typeof document === "undefined"
    ? undefined
    : document.documentElement,
): void {
  if (!root) return;
  const names: string[] = [];
  for (let i = 0; i < root.style.length; i++) {
    const n = root.style.item(i);
    if (n.startsWith("--sh-")) names.push(n);
  }
  for (const n of names) root.style.removeProperty(n);
}

export const DEFAULT_TOKENS: { readonly light: ThemeTokens; readonly dark: ThemeTokens } = {
  light: dtcgToTokens(defaultDoc, "light"),
  dark: dtcgToTokens(defaultDoc, "dark"),
};
