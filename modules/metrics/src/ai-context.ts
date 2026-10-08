import type { TenantContext } from "@fundroom/db";
import type { AiContextProvider, ModuleServices } from "@fundroom/module-kit";
import { parseFixed } from "./decimal.js";
import { createMetricGridHydrator, type MetricGridTile } from "./hydrator.js";
import { DefinitionRepo } from "./repos/metrics-repo.js";

/*
 * The `kpis` AI context provider (E3.12 §10): the numbers an `update_draft` may quote, as text.
 * modules/updates asks for it through `services.registry.aiContextProviders` — the two modules
 * never import each other — and only while this module is enabled for the workspace.
 *
 * Only definitions whose audience is `all` are offered (R2-H2): a draft's prose is read by the
 * update's whole audience, so a `staff_only` or group-only number must never be material. Their
 * values come from the same hydrator a `metric_grid` block renders through, under the caller's
 * tenant context (the request's own workspace) — the latest and previous period's values,
 * formatted with the definition's own decimals.
 * The change is derived from those two strings, so every number in the text is either a stored
 * value or arithmetic on two of them.
 */

export const KPI_CONTEXT_KEY = "kpis";
/** Definitions offered to the model (and ids a draft's metric grid may carry). */
export const KPI_CONTEXT_MAX_DEFINITIONS = 12;
/** Definitions looked at to find twelve with data: the hydrator's own per-block cap. */
const KPI_CONTEXT_CANDIDATES = 24;

/** One line of plain text: newlines and control characters in a staff-typed name become spaces. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it strips.
const CONTROL_RE = /[\u0000-\u001f\u007f]+/gu;
const flat = (v: string): string => v.replace(CONTROL_RE, " ").replace(/\s+/gu, " ").trim();

function unitOf(tile: MetricGridTile): string {
  if (tile.unit === "currency") return tile.currency ?? "currency";
  if (tile.unit === "percent") return "%";
  return tile.unit;
}

/** `(latest - previous) / |previous|` as a signed percentage with one decimal, or null. */
export function changePercent(latest: string, previous: string): string | null {
  const l = parseFixed(latest);
  const p = parseFixed(previous);
  if (l === undefined || p === undefined || p === 0n) return null;
  const abs = p < 0n ? -p : p;
  // Tenths of a percent, rounded half away from zero.
  const scaled = (l - p) * 2000n;
  const tenths = (scaled >= 0n ? scaled + abs : scaled - abs) / (2n * abs);
  const sign = tenths > 0n ? "+" : tenths < 0n ? "-" : "";
  const t = tenths < 0n ? -tenths : tenths;
  return `${sign}${t / 10n}.${t % 10n}%`;
}

/** The text line for one tile, or null when it has no value yet. */
export function kpiLine(tile: MetricGridTile): string | null {
  if (tile.latest === null) return null;
  const parts = [`${tile.latest.periodLabel} ${tile.latest.value}`];
  if (tile.previous !== null) {
    const label = tile.periods.find((p) => p.key === tile.previous?.periodKey)?.label;
    parts.push(`previous${label ? ` (${label})` : ""} ${tile.previous.value}`);
    const change = changePercent(tile.latest.value, tile.previous.value);
    if (change !== null) parts.push(`change ${change}`);
  }
  return `- ${flat(tile.name)} (${unitOf(tile)}): ${parts.join("; ")}`;
}

/** Lines while they fit in `maxChars`; the ids are those of the lines that made it in. */
export function kpiText(
  tiles: readonly MetricGridTile[],
  maxChars: number,
): { text: string; definitionIds: string[] } | null {
  const lines: string[] = [];
  const ids: string[] = [];
  let used = 0;
  for (const tile of tiles) {
    if (ids.length >= KPI_CONTEXT_MAX_DEFINITIONS) break;
    const line = kpiLine(tile);
    if (line === null) continue;
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    lines.push(line);
    ids.push(tile.id);
    used += cost;
  }
  return lines.length === 0 ? null : { text: lines.join("\n"), definitionIds: ids };
}

export function createKpisContextProvider(services: ModuleServices): AiContextProvider {
  return {
    key: KPI_CONTEXT_KEY,
    async provide(ctx: TenantContext, opts: { readonly maxChars: number }) {
      const ids = await services.db.withTenant(ctx, async (tx) =>
        (await new DefinitionRepo(ctx, tx).list())
          // R2-H2: only numbers published to every investor. `staff_only` (the default: "a
          // number nobody has chosen to publish is not published") and group-restricted
          // metrics never reach the model — its prose goes to the draft's whole audience.
          .filter((d) => d.audience.kind === "all")
          .slice(0, KPI_CONTEXT_CANDIDATES)
          .map((d) => d.id),
      );
      if (ids.length === 0) return null;
      // Its own transaction (the hydrator opens one); never nested in the read above.
      const hydrated = (await createMetricGridHydrator(services).hydrate(
        { definitionIds: ids },
        { tenant: ctx, viewer: { kind: "staff", groupIds: [] }, facts: {} },
      )) as unknown as { metrics: readonly MetricGridTile[] };
      return kpiText(hydrated.metrics, opts.maxChars);
    },
  };
}
