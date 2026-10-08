/*
 * The `en-XA` pseudo-locale (E2.8): accented, ~35% longer and bracketed, so a screen shows at a
 * glance which strings went through the catalogue (they are bracketed), which were hard-coded
 * (they are plain ASCII) and where a layout breaks once a real translation runs longer.
 *
 * This file has NO imports on purpose: `scripts/i18n-pseudo.mjs` loads it directly as TypeScript
 * (Node 24 strips types), so it must stay erasable-only syntax.
 *
 * What is never touched:
 * - `{placeholder}` references, byte for byte (Paraglide and the server catalogue both use them);
 * - ICU-style arguments (`{count, plural, one {# item} other {# items}}`): the head
 *   (`count, plural,`), the selector keys and `#` stay, only the nested sub-messages are
 *   pseudo-localised, recursively;
 * - anything that is not an ASCII letter (digits, punctuation, whitespace, emoji, URLs' `:/`).
 */

const ACCENTS: Readonly<Record<string, string>> = {
  a: "á",
  b: "ƀ",
  c: "ç",
  d: "ð",
  e: "é",
  f: "ƒ",
  g: "ĝ",
  h: "ĥ",
  i: "í",
  j: "ĵ",
  k: "ķ",
  l: "ļ",
  m: "ɱ",
  n: "ñ",
  o: "ó",
  p: "þ",
  q: "ǫ",
  r: "ŕ",
  s: "š",
  t: "ţ",
  u: "ú",
  v: "ṽ",
  w: "ŵ",
  x: "ẋ",
  y: "ý",
  z: "ž",
  A: "Á",
  B: "Ɓ",
  C: "Ç",
  D: "Ð",
  E: "É",
  F: "Ƒ",
  G: "Ĝ",
  H: "Ĥ",
  I: "Í",
  J: "Ĵ",
  K: "Ķ",
  L: "Ļ",
  M: "Ṁ",
  N: "Ñ",
  O: "Ó",
  P: "Þ",
  Q: "Ǫ",
  R: "Ŕ",
  S: "Š",
  T: "Ţ",
  U: "Ú",
  V: "Ṽ",
  W: "Ŵ",
  X: "Ẋ",
  Y: "Ý",
  Z: "Ž",
};

/** Opening and closing markers. A screen test looks for these. */
export const PSEUDO_OPEN = "⟦";
export const PSEUDO_CLOSE = "⟧";
/** Share of the visible text length added as padding (translations run ~30-40% longer). */
export const PSEUDO_EXPANSION = 0.35;

const PAD = "·";
const PAD_GROUP = 6;

function accent(text: string): string {
  let out = "";
  for (const ch of text) out += ACCENTS[ch] ?? ch;
  return out;
}

/** Index of the `}` that closes the `{` at `open`, or -1 when unbalanced. */
function closingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * `{…}` content: a plain `{name}` reference is returned untouched; an ICU argument
 * (`name, plural|select|selectordinal, key {msg} key {msg}`) keeps its head and keys and has
 * each `{msg}` transformed. Anything else in braces is left exactly as it was.
 */
function transformArgument(inner: string): string {
  const firstComma = inner.indexOf(",");
  if (firstComma === -1) return inner;
  const secondComma = inner.indexOf(",", firstComma + 1);
  const kind = inner.slice(firstComma + 1, secondComma === -1 ? undefined : secondComma).trim();
  if (secondComma === -1 || !/^(plural|select|selectordinal)$/u.test(kind)) return inner;
  let out = inner.slice(0, secondComma + 1);
  let i = secondComma + 1;
  while (i < inner.length) {
    const ch = inner[i] as string;
    if (ch === "{") {
      const end = closingBrace(inner, i);
      if (end === -1) return inner;
      out += `{${transformText(inner.slice(i + 1, end))}}`;
      i = end + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Accents the text outside braces and recurses into ICU sub-messages. Returns the body only. */
function transformText(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i] as string;
    if (ch === "{") {
      const end = closingBrace(s, i);
      if (end === -1) {
        // Unbalanced: leave the rest verbatim rather than guess.
        out += s.slice(i);
        break;
      }
      out += `{${transformArgument(s.slice(i + 1, end))}}`;
      i = end + 1;
    } else {
      out += accent(ch);
      i += 1;
    }
  }
  return out;
}

/** Visible letters outside braces: what the padding is sized from. */
function visibleLength(s: string): number {
  let n = 0;
  let depth = 0;
  for (const ch of s) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) n += 1;
  }
  return n;
}

/**
 * Pseudo-localises one message pattern. Idempotent on its own output only in the sense that
 * the generator always starts from `en`; do not feed it `en-XA` text.
 */
export function pseudoLocalize(s: string): string {
  if (s.length === 0) return s;
  const n = Math.max(1, Math.round(visibleLength(s) * PSEUDO_EXPANSION));
  // Long padding is broken into words so it wraps like prose instead of forcing an overflow.
  const groups: string[] = [];
  for (let left = n; left > 0; left -= PAD_GROUP)
    groups.push(PAD.repeat(Math.min(PAD_GROUP, left)));
  return `${PSEUDO_OPEN}${transformText(s)}${groups.join(" ")}${PSEUDO_CLOSE}`;
}

/**
 * Pseudo-localises a catalogue value of either shape this repo uses: a string, an inlang
 * variant message (`[{ declarations, selectors, match: { "x=one": "…" } }]`, only the `match`
 * patterns change) or a server plural object (`{ one: "…", other: "…" }`).
 */
export function pseudoLocalizeValue(value: unknown): unknown {
  if (typeof value === "string") return pseudoLocalize(value);
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (entry === null || typeof entry !== "object") return entry;
      const e = entry as Record<string, unknown>;
      const match = e["match"];
      if (match === null || typeof match !== "object") return entry;
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(match as Record<string, unknown>)) {
        next[k] = typeof v === "string" ? pseudoLocalize(v) : v;
      }
      return { ...e, match: next };
    });
  }
  if (value !== null && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      next[k] = typeof v === "string" ? pseudoLocalize(v) : v;
    }
    return next;
  }
  return value;
}
