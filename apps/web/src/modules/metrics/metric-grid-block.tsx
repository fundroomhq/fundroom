import { m } from "../../paraglide/messages.js";
import { MetricTile, type MetricTileData } from "./metric-tile.js";

/*
 * The `metric_grid` content block (E2.4 §10). The page stores definition ids; the server
 * hydrates them *after* visibility, and what arrives here is the payload both this renderer
 * and the email renderer read.
 *
 * The quiet rule is the important one: ids this reader may not see are **dropped by the
 * hydrator, not reported**. So there is no "hidden metric" placeholder and no count of what
 * was withheld — a placeholder would tell an investor that a number exists which the founder
 * chose not to show them, which is most of what a per-metric audience is for. An empty grid
 * renders as nothing at all.
 *
 * Shapes are validated rather than trusted, the way every other block renderer here does it:
 * a newer server must never break an older client.
 */

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function readLatest(v: unknown): MetricTileData["latest"] {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const periodKey = str(o["periodKey"]);
  const value = str(o["value"]);
  if (periodKey === null || value === null) return null;
  return { periodKey, periodLabel: str(o["periodLabel"]) ?? periodKey, value };
}

function readPrevious(v: unknown): MetricTileData["previous"] {
  const latest = readLatest(v);
  return latest === null ? null : { periodKey: latest.periodKey, value: latest.value };
}

const UNITS = new Set(["currency", "count", "percent", "ratio", "days", "months"]);
const DIRECTIONS = new Set(["up_good", "down_good", "neutral"]);

/*
 * §10's `periods`: the column each `sparkline` entry belongs to, aligned index for index and
 * oldest first. It is what lets the tile name a period — "Jul 2026" — rather than count
 * backwards from the end of the array, and `latest` cannot stand in for it: `latest` names the
 * period of the latest *value*, which need not be the last column.
 *
 * A malformed entry discards the **whole** array rather than being skipped. Skipping one would
 * slide every later label one column to the left and hang "Aug 2026" over September's figure,
 * and a chart labelled wrongly is worse than a chart labelled by position.
 */
function readPeriods(v: unknown): MetricTileData["periods"] {
  if (!Array.isArray(v)) return [];
  const periods: { key: string; label: string }[] = [];
  for (const entry of v) {
    if (typeof entry !== "object" || entry === null) return [];
    const o = entry as Record<string, unknown>;
    const key = str(o["key"]);
    if (key === null) return [];
    periods.push({ key, label: str(o["label"]) ?? key });
  }
  return periods;
}

function readTile(v: unknown): MetricTileData | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = str(o["id"]);
  const name = str(o["name"]);
  const unit = str(o["unit"]);
  if (id === null || name === null || unit === null || !UNITS.has(unit)) return null;
  const direction = str(o["direction"]);
  return {
    id,
    key: str(o["key"]) ?? id,
    name,
    unit: unit as MetricTileData["unit"],
    currency: str(o["currency"]),
    decimals: typeof o["decimals"] === "number" ? o["decimals"] : 0,
    direction:
      direction !== null && DIRECTIONS.has(direction)
        ? (direction as MetricTileData["direction"])
        : "neutral",
    latest: readLatest(o["latest"]),
    previous: readPrevious(o["previous"]),
    // A `null` in the sparkline is a period with no point. It stays null: §7 forbids drawing
    // a gap as a zero, and this is the line where that rule would be easiest to break.
    sparkline: Array.isArray(o["sparkline"])
      ? o["sparkline"].map((x) => (typeof x === "string" ? x : null))
      : [],
    periods: readPeriods(o["periods"]),
  };
}

export interface MetricGridPayload {
  readonly columns: number;
  readonly metrics: readonly MetricTileData[];
}

export function readMetricGrid(hydrated: unknown): MetricGridPayload | null {
  if (typeof hydrated !== "object" || hydrated === null) return null;
  const o = hydrated as Record<string, unknown>;
  if (!Array.isArray(o["metrics"])) return null;
  const columns = typeof o["columns"] === "number" ? Math.min(4, Math.max(1, o["columns"])) : 3;
  const metrics = o["metrics"].flatMap((x) => {
    const tile = readTile(x);
    return tile === null ? [] : [tile];
  });
  return { columns, metrics };
}

const COLUMN_CLASS: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 lg:grid-cols-4",
};

export function MetricGridBlock({ hydrated }: { hydrated: unknown }) {
  const payload = readMetricGrid(hydrated);
  if (payload === null || payload.metrics.length === 0) return null;
  return (
    <ul
      aria-label={m.metrics_block_label()}
      className={`grid list-none gap-4 ${COLUMN_CLASS[payload.columns] ?? COLUMN_CLASS[3]}`}
    >
      {payload.metrics.map((tile) => (
        <li key={tile.id}>
          <MetricTile tile={tile} />
        </li>
      ))}
    </ul>
  );
}
