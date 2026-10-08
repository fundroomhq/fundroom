import type { ChartSpec } from "./types.js";

/**
 * `describedBy` (E2.4 contract §7): the sentence a screen reader announces and the `alt` text
 * on the PNG in an update email.
 *
 * The rule it enforces is that **a chart is never the only place a number exists**. An image in
 * an email is blocked by default in most clients (and §D5 forbids the per-recipient URL that
 * would let us notice), so if the figures only live in the pixels, a reader with images off
 * gets a placeholder box where the quarter's revenue should be. The text is English by design:
 * the contract freezes it as a sentence here rather than as a bag of parts the caller
 * translates, because the sentence structure ("rising to", "unchanged at") carries the meaning.
 */

const KIND_WORD: Record<ChartSpec["kind"], string> = {
  line: "Line chart",
  bar: "Bar chart",
  "stacked-bar": "Stacked bar chart",
};

function columnLabel(spec: ChartSpec, x: number): string {
  return spec.xLabels[x] ?? `column ${x + 1}`;
}

function changeClause(first: number, last: number): string {
  if (first === last) return "";
  const dir = last > first ? "up" : "down";
  if (first === 0) return ` (${dir})`;
  const pct = Math.abs(((last - first) / Math.abs(first)) * 100);
  // Below 0.5% the rounded figure is "0%", which reads as a contradiction next to "up".
  if (pct < 0.5) return ` (${dir} slightly)`;
  return ` (${dir} ${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%)`;
}

export function describeChart(spec: ChartSpec, columns: number): string {
  const fmt = spec.yTickFormat;
  const parts: string[] = [];
  if (spec.title !== undefined && spec.title.trim() !== "") parts.push(`${spec.title.trim()}.`);

  const drawn = spec.series.filter((s) => s.points.some((p) => p.y !== null));
  if (columns === 0 || drawn.length === 0) {
    parts.push(`${KIND_WORD[spec.kind]} with no data.`);
    return parts.join(" ");
  }

  const from = columnLabel(spec, 0);
  const to = columnLabel(spec, columns - 1);
  parts.push(
    columns === 1
      ? `${KIND_WORD[spec.kind]} for ${from}.`
      : `${KIND_WORD[spec.kind]} covering ${from} to ${to}, ${columns} periods.`,
  );

  for (const series of spec.series) {
    const shown = [...series.points]
      .filter((p): p is { x: number; y: number } => p.y !== null)
      .sort((a, b) => a.x - b.x);
    const head = shown[0];
    const tail = shown[shown.length - 1];
    if (head === undefined || tail === undefined) {
      parts.push(`${series.label}: no data.`);
      continue;
    }
    if (shown.length === 1 || head.x === tail.x) {
      parts.push(`${series.label}: ${fmt(head.y)} in ${columnLabel(spec, head.x)}.`);
    } else if (head.y === tail.y) {
      parts.push(
        `${series.label}: unchanged at ${fmt(head.y)} from ${columnLabel(spec, head.x)} to ${columnLabel(spec, tail.x)}.`,
      );
    } else {
      const verb = tail.y > head.y ? "rising to" : "falling to";
      parts.push(
        `${series.label}: ${fmt(head.y)} in ${columnLabel(spec, head.x)}, ${verb} ${fmt(tail.y)} in ${columnLabel(spec, tail.x)}${changeClause(head.y, tail.y)}.`,
      );
    }
    // Gaps are part of the meaning, so they are spoken. A reader who is told "3 periods have no
    // value" knows the flat stretch is missing data, not a flat business.
    const gaps = series.points.filter((p) => p.y === null).length;
    if (gaps > 0) {
      parts.push(
        `${gaps} ${gaps === 1 ? "period has" : "periods have"} no value for ${series.label}.`,
      );
    }
  }
  return parts.join(" ");
}
