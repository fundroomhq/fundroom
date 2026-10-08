import { randomUUID } from "node:crypto";
import { ai } from "@fundroom/contracts";
import type { PageDoc } from "@fundroom/module-content";
import type { JsonObject } from "@fundroom/ports";
import { validatePostDoc } from "../model.js";

/*
 * `finish` for `update_draft` (E3.12 §10): the model's JSON becomes a `PageDoc` the editor can
 * load, or a refusal. The model is not trusted to have followed the schema, the limits or the
 * "no HTML" rule, so every one of them is enforced here; the result is then checked by the same
 * `validatePostDoc` a staff save goes through — a suggestion that could not be saved as a draft
 * is not a suggestion.
 */

export const MAX_SECTIONS = 10;
export const MAX_TITLE_CHARS = 200;
export const MAX_HEADING_CHARS = 120;
export const MAX_SECTION_MARKDOWN = 6000;
export const MAX_KPI_IDS = 12;
const KEY_MAX = 40;
/** modules/content `SECTION_KEY_RE` (not exported); `validatePostDoc` re-checks it. */
const SECTION_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
export const DEFAULT_TITLE = "Investor update";
export const METRICS_SECTION_TITLE = "Key metrics";
const METRIC_HEADING_RE = /kpi|metric|number/iu;

export interface DraftSources {
  readonly kpiDefinitionIds: readonly string[];
  readonly lastUpdate: {
    readonly postId: string;
    readonly title: string;
    readonly sentAt: string;
  } | null;
}

export type DraftOutcome =
  | { readonly kind: "result"; readonly result: JsonObject }
  | { readonly kind: "refused"; readonly code: "invalid_output" | "empty_output" };

/**
 * Removes raw HTML: comments, then anything shaped like a tag (`<b>`, `</div>`, `<img …>`,
 * `<script>`; the text between a pair of tags stays as text). A Markdown autolink
 * `<https://…>` keeps its URL. A lone `<` that does not open a tag (`a < b`, `<5%`) is left alone.
 * Repeated to a fixed point (R2-L4): removing one tag must not assemble another
 * (`<scr<script>ipt>` → `<script>` after one pass).
 */
export function stripHtml(text: string): string {
  let out = text;
  for (let i = 0; i < MAX_STRIP_PASSES; i++) {
    const next = stripOnce(out);
    if (next === out) return out;
    out = next;
  }
  // Still changing after that many passes: nothing that looks like a tag opener survives.
  return out.replace(/<(?=[/!a-z])/giu, "");
}

const MAX_STRIP_PASSES = 16;

function stripOnce(text: string): string {
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, "")
    .replace(/<((?:https?|mailto):[^\s<>]+)>/giu, "$1")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/giu, "")
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?$/iu, "");
}

/** The inline link form the renderer understands (`@fundroom/markdown` parse.ts). */
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/gu;

/**
 * R2-L6: a Markdown link whose URL is not in the prompt material (the notes, the last update,
 * the KPI lines) becomes its plain text — the model does not get to add a destination nobody
 * gave it (`[Wire here](https://evil.example/pay)`).
 */
export function unlinkUnknown(markdown: string, material: string): string {
  return markdown.replace(LINK_RE, (whole, text: string, url: string) =>
    material.includes(url) ? whole : text,
  );
}

/**
 * A figure in prose: an optional explicit sign, currency sign, digits with thousands separators,
 * decimals, a `%` or magnitude suffix (`k`, `M`, `bn`, `million` …) and an optional currency
 * code. Not preceded by a letter, digit or `.`, so `Q3`, `H1`, `v2` and `2026-09`'s `-` are not
 * figures or signs.
 */
const NUMBER_RE =
  /(?<![\p{L}\p{N}_.])([+\-\u2011\u2012\u2013\u2014\u2212](?=[$€£¥\d]))?([$€£¥])?\s?(\d(?:[\d,]*\d)?(?:\.\d+)?)(?:\s?(%|k|K|m|M|mm|MM|b|B|bn|million|billion|thousand)(?![\p{L}\p{N}]))?(?:\s?(USD|EUR|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK)\b)?/gu;
const MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
};
/** Relative tolerance for large or fractional values: "42k" matches 41,950; "4.9%" not 5.0%. */
const NUMBER_TOLERANCE = 0.005;
/** Integers below this (counts, years) must match exactly: "2,030" is not "2026". */
const EXACT_BELOW = 10_000;
export const MAX_UNVERIFIED_NUMBERS = 50;

type UnitClass = "percent" | "currency" | "plain";

interface Figure {
  readonly token: string;
  readonly value: number;
  /** -1 / +1 for an explicit sign, 0 when none was written. */
  readonly sign: -1 | 0 | 1;
  readonly unit: UnitClass;
}

function figuresIn(text: string, lineUnit?: UnitClass): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const base = Number((m[3] ?? "").replaceAll(",", ""));
    if (!Number.isFinite(base)) continue;
    const suffix = (m[4] ?? "").toLowerCase();
    const value = base * (MULTIPLIERS[suffix] ?? 1);
    const own: UnitClass | null =
      suffix === "%" ? "percent" : m[2] !== undefined || m[5] !== undefined ? "currency" : null;
    const year = own === null && Number.isInteger(value) && value >= 1900 && value <= 2100;
    out.push({
      token: m[0].trim(),
      value,
      sign: m[1] === undefined ? 0 : m[1] === "+" ? 1 : -1,
      unit: own ?? (year ? "plain" : (lineUnit ?? "plain")),
    });
  }
  return out;
}

/**
 * The KPI block's figures, each with its metric's unit class: a value on the line
 * `- MRR (USD): Sep 2026 42000.00; …` is currency, one on `- Churn (%): …` a percentage, a
 * `change +5.0%` a percentage with its sign, and the period labels' years plain.
 */
function kpiFigures(kpis: string): Figure[] {
  const out: Figure[] = [];
  for (const line of kpis.split("\n")) {
    const heads = [...line.matchAll(/\(([^()]*)\):\s/gu)];
    const head = heads.at(-1);
    if (head === undefined || head.index === undefined) {
      out.push(...figuresIn(line));
      continue;
    }
    const unit = (head[1] ?? "").trim();
    const cls: UnitClass =
      unit === "%" ? "percent" : /^(?:[A-Z]{3}|currency)$/u.test(unit) ? "currency" : "plain";
    out.push(...figuresIn(line.slice(head.index + head[0].length), cls));
  }
  return out;
}

function sameFigure(a: Figure, b: Figure): boolean {
  if (a.unit !== b.unit && (a.unit === "percent" || b.unit === "percent")) return false;
  if (a.sign !== 0 && b.sign !== 0 && a.sign !== b.sign) return false;
  const bothSmallInts =
    Number.isInteger(a.value) &&
    Number.isInteger(b.value) &&
    Math.abs(a.value) < EXACT_BELOW &&
    Math.abs(b.value) < EXACT_BELOW;
  if (bothSmallInts) return a.value === b.value;
  return (
    Math.abs(a.value - b.value) <= NUMBER_TOLERANCE * Math.max(Math.abs(a.value), Math.abs(b.value))
  );
}

/** Capitalised month names only: `may` in "45 may grow" is not a month (RR3-L5). */
const MONTH =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const YEAR = "(?:19\\d{2}|20\\d{2}|2100)";
const MM = "(?:0?[1-9]|1[0-2])";
const DD = "(?:0?[1-9]|[12]\\d|3[01])";
const DAY = "(?:[1-9]|[12]\\d|3[01])(?:st|nd|rd|th)?";
/** Nothing may follow a date token that would make it (part of) a figure: `%`, a digit, a unit. */
const END = "(?![\\p{L}\\p{N}%'])";
/** A "Month D" date ends the phrase: end of text, a comma, a year, or sentence punctuation. */
const DAY_END = `(?=\\s*$|,|\\s+${YEAR}(?![\\p{L}\\p{N}%])|[.;:)!?](?:\\s|$))`;
/**
 * Dates and periods are one non-numeric token each (FIX2b), and ONLY the token itself (RR3-L5):
 * ISO `2026-09-30` / `2026-09` (valid month/day), `09/30/2026`, `30.09.2026`, `Q3`, `Q3 2026`,
 * `Q3'26`, `H1`, `FY25`, `FY2026`, `Sept 30`, `Sept 30, 2026`, `30 Sept 2026`, `Sep 2026`.
 * A figure next to one stays a figure: "Q3 35%", "H1 17%", "June 40%", "March 12 customers".
 */
const DATE_RES: readonly RegExp[] = [
  new RegExp(`(?<![\\p{L}\\p{N}.])${YEAR}-${MM}(?:-${DD})?${END}`, "gu"),
  new RegExp(`(?<![\\p{L}\\p{N}.])${DD}[/.]${DD}[/.](?:\\d{2}|${YEAR})${END}`, "gu"),
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:Q[1-4]|H[12]|FY)(?:\\s${YEAR}|'\\d{2}|\\d{2}|${YEAR})?${END}`,
    "gu",
  ),
  new RegExp(`(?<![\\p{L}\\p{N}])${MONTH}\\s+${DAY}(?:,?\\s+${YEAR}${END}|${DAY_END})`, "gu"),
  new RegExp(`(?<![\\p{L}\\p{N}.])${DAY}\\s+${MONTH}(?:,?\\s+${YEAR})?${END}`, "gu"),
  new RegExp(`(?<![\\p{L}\\p{N}])${MONTH}\\s+${YEAR}${END}`, "gu"),
];

/** Replaces every date/period token with a space, so none of its digits reads as a figure. */
export function withoutDates(text: string): string {
  return DATE_RES.reduce((t, re) => t.replace(re, " "), text);
}

/** The text between `<tag>` and `</tag>` in the user prompt (the tags cannot occur in material). */
export function taggedBlock(prompt: string, tag: string): string {
  const open = prompt.indexOf(`<${tag}>`);
  const close = prompt.indexOf(`</${tag}>`);
  return open === -1 || close < open ? "" : prompt.slice(open + tag.length + 2, close);
}

export interface NumberCheck {
  /** In neither the KPI lines, the notes nor the last update. */
  readonly unverified: string[];
  /** Only in the last update — numbers the prompt calls old, presented as current. */
  readonly fromLastUpdate: string[];
}

/**
 * R2-L5 / RR2-L5: figures in the draft checked against the CURRENT material only (the KPI
 * lines and the notes), by value, unit class (a percentage is never a count or an amount) and
 * explicit sign (`+22.2%` is not `-22.2%`); integers under 10 000 exactly. A figure found only
 * in the last update is reported separately: the prompt tells the model those numbers are old.
 * Ordered-list markers are not figures. Reported, not removed: staff decide.
 */
export function checkNumbers(draftText: string, prompt: string): NumberCheck {
  const current = [
    ...kpiFigures(taggedBlock(prompt, "kpis")),
    ...figuresIn(taggedBlock(prompt, "notes")),
  ];
  const previous = figuresIn(taggedBlock(prompt, "last_update"));
  const unverified: string[] = [];
  const fromLastUpdate: string[] = [];
  const seen = new Set<string>();
  const prose = withoutDates(draftText.replace(/^\s*\d+[.)]\s/gmu, ""));
  for (const f of figuresIn(prose)) {
    if (seen.has(f.token)) continue;
    seen.add(f.token);
    if (current.some((c) => sameFigure(f, c))) continue;
    const list = previous.some((c) => sameFigure(f, c)) ? fromLastUpdate : unverified;
    if (list.length < MAX_UNVERIFIED_NUMBERS) list.push(f.token.slice(0, 40));
  }
  return { unverified, fromLastUpdate };
}

const clean = (v: unknown): string =>
  typeof v === "string" ? stripHtml(v.replaceAll("\u0000", "")).trim() : "";

const cut = (v: string, max: number): string =>
  v.length <= max ? v : `${v.slice(0, max - 1).trimEnd()}…`;

/** Collapses a heading to one line (a newline in a title is the model misbehaving). */
const oneLine = (v: string): string => v.replace(/\s+/gu, " ").trim();

/** A section key from a heading: `SECTION_KEY_RE`, unique within the document. */
export function sectionKey(heading: string, taken: Set<string>, index: number): string {
  let base = heading
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, KEY_MAX - 4)
    .replace(/-+$/u, "");
  if (!SECTION_KEY_RE.test(base)) base = `section-${index + 1}`;
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

const blockId = (prefix: string): string => `${prefix}-${randomUUID()}`;

const richText = (text: string) => ({
  id: blockId("ai-text"),
  type: "rich_text",
  schemaVersion: 1,
  data: { format: "markdown", text },
});

const textOf = (block: unknown): string => {
  const data = (block as { type?: unknown; data?: { text?: unknown } }).data;
  return typeof data?.text === "string" ? data.text : "";
};

/** Turns the model's parsed JSON into the stored `update_draft` result. */
export function buildDraftResult(
  json: unknown,
  sources: DraftSources,
  /** What the model was given (the user prompt): links and figures are checked against it. */
  material = "",
): DraftOutcome {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { kind: "refused", code: "invalid_output" };
  }
  const raw = json as { title?: unknown; sections?: unknown };
  if (!Array.isArray(raw.sections)) return { kind: "refused", code: "invalid_output" };

  const title = cut(oneLine(clean(raw.title)), MAX_TITLE_CHARS) || DEFAULT_TITLE;
  const taken = new Set<string>();
  const sections: { key: string; title: string | null; blocks: unknown[] }[] = [];
  for (const entry of raw.sections) {
    if (sections.length >= MAX_SECTIONS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { heading?: unknown; markdown?: unknown };
    const markdown = cut(unlinkUnknown(clean(e.markdown), material), MAX_SECTION_MARKDOWN);
    if (markdown.length === 0) continue;
    const heading = cut(oneLine(clean(e.heading)), MAX_HEADING_CHARS);
    sections.push({
      key: sectionKey(heading, taken, sections.length),
      title: heading.length > 0 ? heading : null,
      blocks: [richText(markdown)],
    });
  }
  if (sections.length === 0) return { kind: "refused", code: "empty_output" };

  const kpiDefinitionIds = [...new Set(sources.kpiDefinitionIds)].slice(0, MAX_KPI_IDS);
  if (kpiDefinitionIds.length > 0) {
    const grid = {
      id: blockId("ai-kpis"),
      type: "metric_grid",
      schemaVersion: 1,
      data: { definitionIds: kpiDefinitionIds, columns: 3 },
    };
    const target = sections.find((s) => s.title !== null && METRIC_HEADING_RE.test(s.title));
    if (target !== undefined) target.blocks.push(grid);
    else {
      sections.splice(Math.min(1, sections.length), 0, {
        key: sectionKey(METRICS_SECTION_TITLE, taken, sections.length),
        title: METRICS_SECTION_TITLE,
        blocks: [grid],
      });
    }
  }

  let doc: PageDoc;
  try {
    doc = validatePostDoc({ sections });
  } catch {
    return { kind: "refused", code: "invalid_output" };
  }
  const numbers = checkNumbers(
    [title, ...sections.flatMap((s) => [s.title ?? "", ...s.blocks.map(textOf)])].join("\n"),
    material,
  );
  const result = ai.AiUpdateDraftResultSchema.safeParse({
    kind: "update_draft",
    title,
    doc,
    kpiDefinitionIds,
    sources: { kpis: kpiDefinitionIds.length > 0, lastUpdate: sources.lastUpdate },
    unverifiedNumbers: numbers.unverified,
    numbersFromLastUpdate: numbers.fromLastUpdate,
  });
  if (!result.success) return { kind: "refused", code: "invalid_output" };
  return { kind: "result", result: result.data as unknown as JsonObject };
}
